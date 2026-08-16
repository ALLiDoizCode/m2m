# A moving tag carries the fleet's committed config, or it does not move

**Scope:** deployment law for this fleet — not protocol. See the [ADR index](README.md).

An image tag that a box follows unattended may only move to a build that still accepts the
**committed** config that box bind-mounts. A change that makes a previously valid config invalid —
a new required key, a renamed field, a narrowed type — is a **breaking deploy**, and a breaking
deploy may not ride an automatic tag move. It must either be made backward-compatible (the new key
defaults, and only becomes required once every box's committed config sets it), or it must be
carried by a promotion that lands the config first.

The rule binds at one specific moment: the **tag move**, not the merge and not the recreate. A
merge is too early — nothing is deployed yet and the config may legitimately be updated in the same
window. A recreate is too late — the container is already crash-looping. The tag move is the only
point where the candidate image and the fleet's committed config are both available to the same
machine at the same time, which is why every gate this record requires lives there.

## Context

### What it cost to not have this rule

On 2026-08-16, [swap#134](https://github.com/toon-protocol/swap/pull/134) added a required
`chainProviders[].tokenNetworkAddress`. Its own PR body was explicit about the consequence:

> `/root/connector/infra/linode-relay/swap.config.json` on the relay box needs one added key
> **before** the new image boots, or the maker will refuse to start with `INVALID_CONFIG`.

No reviewer weighed in, the PR merged green, `swap:release` moved, the relay box's label-scoped
Watchtower recreated `swap-node` within ~60s, and the maker crash-looped on
`[INVALID_CONFIG] chainProviders[0].tokenNetworkAddress MUST be a non-empty string`. It stayed down
until a human happened to look and hand-edited the bind-mounted file. Nothing alerted, because
nothing was watching.

Every ingredient of that outage is structural rather than accidental:

- **The config is not in the image.** `infra/linode-relay/swap.config.json` is bind-mounted at
  `/app/config/swap.config.json`. No image build ever sees it, so no image build can validate
  against it, and no amount of CI in the app's own repo can catch the mismatch.
- **The tag move is the deploy.** Watchtower polls every 60s and recreates on a new digest. There
  is no approval, no ordering, and no rollback.
- **Refusing loudly is correct and does not help by itself.** swap#134 deliberately chose
  `INVALID_CONFIG` over a silent default, and it was right to: a maker that booted while announcing
  the wrong contract would break every client instead of itself. A loud refusal is the right
  behaviour for a misconfigured process; it is not a substitute for not shipping the
  misconfiguration.

### Why "make it default, not required" is not the whole answer

The obvious fix — never add a required key — is a real mitigation and it is the first branch of
this record's rule. But it cannot be the only one, for two reasons.

It is unenforceable from here. The keys are added in `swap`, `store` and `relay`, three repositories
this one does not gate. A rule that only exists as advice in a repo the author is not reading is not
a rule.

And it is sometimes wrong. swap#134's own reasoning stands: some settings have no safe default,
and defaulting `tokenNetworkAddress` to `channelAddress` would have produced a maker that boots and
then hands every client an address that reverts. "Fail loudly on a missing setting" is the right
call often enough that a blanket ban on required keys would trade a visible outage for an invisible
one.

So the enforceable half has to be a check on the config the fleet actually has, run at the moment
the tag moves — which is available regardless of which repo the schema change came from, because
the config lives here.

### Why the check belongs at the tag move, in the repo that moves the tag

The committed box config is public and the images are public, so booting one against the other is a
few seconds of a runner's time and needs no credential and no box. That makes the check cheap
enough to put directly in the publishing repo's own existing green-main gate, ahead of the tag move
rather than beside it:

- `swap`'s `publish-swap-image.yml` builds and pushes the immutable `sha-` tag, then boots that
  exact image against this repo's committed `infra/linode-relay/swap.config.json`, and only then
  moves `:release`. A schema change that the fleet's config cannot satisfy leaves `:release` where
  it was, and the box keeps running the previous build. The author finds out on their own PR, which
  is the only place they can act on it.
- `connector`'s `promote-to-fleet.yml` does the same against both boxes' `connector-rust.toml`
  before it moves `:rust-release`.

The publishing repo needs no credentials for this — only a checkout of this repo's committed
`infra/` directory, which is public.

### The connector is held to a stricter form of the same rule

[toon-meta#403](https://github.com/toon-protocol/toon-meta/issues/403) accepted, explicitly and for
devnet, that "a bad-but-green merge can reach production with no human gate — the `:release`-only-on-green
tag is the gate". This record does not reverse that for `swap`, `store` or `relay`.

It does not extend it to the connector, and neither did that epic: its own comments held
`connector-rust` out of the auto-update set twice, and its later comment settled the split as
"Connector = supervised promotion tag; swap/store/relay = auto-on-green". The reasons are specific
rather than general. `connector-rust` is the client edge on **both** boxes and `announce` is the
same image, so one bad digest takes the entire devnet's paid-write path dark on two machines at
once. And `RawConfig`/`RawAnnounceConfig` are `deny_unknown_fields`, so the binary and the box's
hand-tuned TOML are a matched pair in both directions — a field added on either side is a
refuse-to-start on the other. `fleet-ops.yml` already encodes the only safe ordering for that pair
(deploy the pin, then apply the config); an unattended pull has no ordering at all.

So `:rust-release` moves only by `promote-to-fleet.yml`, and `publish-connector-rust-image.yml` no
longer moves it on green main. This corrects a live contradiction rather than introducing a
constraint: the promotion-tag design was already the record in toon-meta#403 and connector#989, and
the auto-on-green tag that shipped in connector#990 was never reconciled with it.

### Detection is part of the rule, because prevention is not total

None of the above prevents a bad image that is _config-compatible_ and simply broken, and the owner
has accepted that risk for devnet. The rule therefore also requires that a service following a
moving tag be **probed after it moves**, by something that distinguishes three states a bare
`docker ps` cannot: restarting, running-but-not-serving, and serving-but-unreachable-through-nginx.
The third is not hypothetical — connector#972 recorded it in the same words this record uses:

> Recreating the connector container changes its Docker network IP, and the long-lived `nginx`
> container caches the old one. The store edge answered `502 connect() failed (111: Connection
refused)` until nginx was restarted. A pin bump is not complete until the edge is re-probed — the
> container being `Up` is not sufficient evidence.

`.github/workflows/fleet-health.yml` is that probe, and its alert is a labelled issue rather than a
red tick, because the failure mode being fixed is precisely that nobody was looking.

## Decision

1. A tag that a box follows unattended moves only after the candidate image has been shown to
   accept every committed config that a box bind-mounts into a container running that image.
2. A config key added by an app is optional-with-default unless the app can show that no safe
   default exists. If no safe default exists, the key's introduction is a breaking deploy: the
   committed box config is updated and applied **first**, and the tag moves after.
3. The connector image does not follow rule 1 by checking — it is not auto-deployed at all.
   `:rust-release` moves only by an explicit `promote-to-fleet` dispatch, which performs the same
   check plus an on-main, no-rollback provenance check.
4. Every service following a moving tag is health-probed on a schedule and after every promotion,
   and a failure opens a `needs:human` issue.

## Consequences

**A schema change now fails in the repo that made it.** A `swap` author adding a required key sees
their own publish job refuse to move `:release`, naming this repo's file and the missing key. That
is a better place to learn it than a crash-loop on someone else's box.

**The fleet can be left behind deliberately.** If the gate refuses, `:release` stays put and the box
keeps serving the previous build. That is the intended outcome and not an incident: the fix is to
land the config here (`fleet-ops.yml` `config-apply`) and re-run the publish, in that order.

**Committed box config becomes load-bearing, and drifting it is now a build failure.** These files
were previously skeletons that a human diverged from on the box. They are now an input to another
repo's CI, so a box hand-edit that is never committed will make the gate validate the wrong thing.
That is a real new obligation and it is the point: the on-box config being unreviewable is what made
this class of outage invisible.

The first run of the gate proved the obligation was already being missed, three times over in one
file. Booting the committed `infra/linode-relay/swap.config.json` against `swap:release` found (a)
the missing `tokenNetworkAddress` from the outage above, still absent because the fix had only ever
been applied to the box; (b) `blsPort: 8080`, which passes `validateConfig` and then dies
`EADDRINUSE` because the maker already binds its own health server there — the live box runs `8090`
and the correction was never committed; and (c) that the config file is not the whole service, since
the boot only succeeds with the `SWAP_AUTOGEN_IDENTITY=1` the compose overlay supplies. Any redeploy
from the committed tree would have reproduced two outages. This is the strongest available argument
for the rule: **config validity is not bootability, and only actually starting the image proves the
second.**

**The connector deploys more slowly, on purpose.** A green merge no longer reaches the boxes. It
reaches GHCR as `rust-sha-*`, and a human promotes it. The deploy itself is still automatic — the
boxes' Watchtower recreates within ~60s of the retag — so what is added is the choice of build, not
the labour of deploying it.

**A false red is possible and is bounded.** Booting a real config against a real image touches real
settlement RPCs, and ADR 0009 makes an unreachable chain a refuse-to-start. Both gates therefore
classify: only a config-shape error (`unknown field`, `missing field`, `INVALID_CONFIG`) refuses the
tag move; any other failure is a warning that does not block. A gate that cried wolf on a flaky RPC
would be routed around within a week.
