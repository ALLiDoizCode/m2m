# Fleet release and health

How a merge becomes a running devnet box, what stops a bad one, and how you find out when
something is down.

Decision record: [ADR 0041](../adr/0041-a-moving-tag-carries-the-fleets-committed-config-or-it-does-not-move.md).
Epic: toon-meta#403.

---

## The shape of it

Every TOON-owned container on both devnet boxes follows a **moving image tag**, and a label-scoped
`containrrr/watchtower:1.7.1` on each box (`--label-enable --interval 60 --cleanup`,
`DOCKER_API_VERSION=1.44`) recreates the container within ~60s of that tag's digest changing. Only
containers carrying `com.centurylinklabs.watchtower.enable=true` are ever touched — `nginx` and
`certbot` never are.

| Box            | Service          | Image                                 | Tag moves when                       |
| -------------- | ---------------- | ------------------------------------- | ------------------------------------ |
| relay          | `connector-rust` | `ghcr.io/toon-protocol/connector`     | **`promote-to-fleet` is dispatched** |
| relay          | `announce`       | `ghcr.io/toon-protocol/connector`     | **`promote-to-fleet` is dispatched** |
| relay          | `relay`          | `ghcr.io/toon-protocol/relay:release` | green merge to `relay` main          |
| relay          | `swap-node`      | `ghcr.io/toon-protocol/swap:release`  | green merge to `swap` main           |
| store (`ario`) | `connector-rust` | `ghcr.io/toon-protocol/connector`     | **`promote-to-fleet` is dispatched** |
| store (`ario`) | `announce`       | `ghcr.io/toon-protocol/connector`     | **`promote-to-fleet` is dispatched** |
| store (`ario`) | `store`          | `ghcr.io/toon-protocol/store:release` | green merge to `store` main          |

Watchtower does **no** health gating. It pulls, recreates, and considers itself done. Whether the
process then stayed up, or served anything, is not a question it asks — which is why the rest of
this document exists.

---

## The connector is promoted, not auto-deployed

`swap`, `store` and `relay` are auto-on-green: a green merge reaches the live box in about a minute.
toon-meta#403 accepted that trade-off explicitly, for devnet.

The connector is not, and never was meant to be. `connector-rust` is the client edge on **both**
boxes — every paid write on the devnet enters through it — and `announce` runs the same image, so
one bad digest takes the whole money path dark on two machines at once. toon-meta#403's own comments
held it out of the auto-update set twice and settled the split as _"Connector = supervised promotion
tag; swap/store/relay = auto-on-green"_.

That design was recorded and then not implemented: connector#990 shipped a `:rust-release` tag that
moved on every green main, no `promote-to-fleet` workflow was ever written, and both boxes were
repointed to follow the tag anyway. The gap is closed now:

- `publish-connector-rust-image.yml` publishes **candidates** — `rust-sha-<short>` (immutable) and
  `rust-main` (floating). It no longer touches `rust-release`.
- `promote-to-fleet.yml` moves `:rust-release`, and only it.

### Promoting a build

```sh
gh workflow run promote-to-fleet.yml \
  -f tag=rust-sha-1204220 \
  -f reason="claim-state fix, verified on the relay"
```

It refuses unless all of the following hold, and says which one failed:

1. The tag is an immutable `rust-sha-<7 hex>` — a floating tag may never be promoted, because
   promoting `rust-main` is auto-on-green wearing a hat.
2. Its commit exists here and is an ancestor of `origin/main`.
3. Its commit is a **descendant** of the currently promoted build, so a promotion cannot silently
   roll the fleet backwards. Override with `-f allow_rollback=true` when a rollback is what you
   mean.
4. The candidate image **boots both boxes' committed `connector-rust.toml`** (ADR 0041). Key
   material is substituted — it is never committed — but nothing semantic is: no prefix, no route,
   no peer, no price, no field name.

Then it retags (`docker buildx imagetools create` — a retag of the validated manifest, never a
rebuild), and calls `fleet-health.yml` after a 180s settle to prove both boxes came back. If they
did not, the run is red and an alert issue is already open.

### Rolling the connector back

Same workflow, previous tag:

```sh
gh workflow run promote-to-fleet.yml -f tag=rust-sha-415531a -f allow_rollback=true \
  -f reason="rolling back <what broke>"
```

Every build ever published keeps its immutable tag, so there is always something to name.

---

## Rolling an auto-on-green service back

`swap`, `store` and `relay` are not promoted, so a rollback is a retag done by hand. Move the
moving tag back onto a known-good immutable tag and let Watchtower pick it up:

```sh
docker buildx imagetools create \
  -t ghcr.io/toon-protocol/swap:release \
     ghcr.io/toon-protocol/swap:sha-785b117
```

Within ~60s Watchtower recreates the container. To force it immediately instead:

```sh
gh workflow run fleet-ops.yml -f box=relay -f operation=deploy -f service=swap-node -f apply=true
```

Note the ordering trap that `fleet-ops.yml` documents at length and that applies here too: a
bind-mounted config is **not** reloaded by `up -d`, and if the rollback target predates a field the
box's committed config now sets, the config must be rolled back too — image first, config second.

---

## What stops a config-breaking change

This is the failure that motivated all of the above. On 2026-08-16 swap#134 added a **required**
`chainProviders[].tokenNetworkAddress`. It merged green, `swap:release` moved, Watchtower recreated
`swap-node`, and the maker crash-looped on `INVALID_CONFIG` — because the box's bind-mounted
`swap.config.json` is not in the image and nobody had added the key. It was down until a human
happened to look.

The rule (ADR 0041) is enforced in three places, deliberately layered:

| Where                                                      | Catches                                                              | When          |
| ---------------------------------------------------------- | -------------------------------------------------------------------- | ------------- |
| `swap`'s `publish-swap-image.yml`, before `:release` moves | a new required key, **in the PR that adds it** — the tag stays put   | pre-deploy    |
| `promote-to-fleet.yml`, before `:rust-release` moves       | the same, for the connector image against both boxes' TOML           | pre-deploy    |
| `fleet-health.yml`'s `config-compat` job                   | a mismatch that got in anyway, or a bad edit to the committed config | ≤15 min, cron |

The first two are the gate. The third is the backstop, and it is also what runs on a connector PR
that edits `infra/linode-relay/swap.config.json`.

**If you are adding a config key to an app that runs on this fleet:** give it a default. If it
genuinely has no safe default (swap#134's did not — defaulting it would have made the maker announce
a contract that reverts for every client), then it is a **breaking deploy**: land the key in the
committed box config here first, apply it with `fleet-ops.yml`, and only then merge the app change.

---

## Health checks and alerts

`.github/workflows/fleet-health.yml` runs every 15 minutes, after every promotion, and on demand.
It is strictly read-only on the boxes.

It does **not** take a hardcoded service list. It discovers "every container carrying the Watchtower
enable label" — precisely the set that can change without a human. A labelled service with no probe
defined is a **failure**, not a skip: opting a service into auto-redeploy without saying how to tell
whether it is serving is the omission the file exists to refuse.

Three things are checked, because each catches what the others cannot:

1. **Container state, sampled twice.** A crash-loop shows as `Up 3 seconds` on any single look; a
   rising `RestartCount` across the probe is the giveaway.
2. **A real serving probe.** `Up` is not evidence.
3. **The public edge, from the runner.** This is the one that catches connector#993's stale-nginx
   upstream: a recreate changes the container's Docker network IP, and an nginx that resolved the
   old one 502s to the world while loopback on the box looks perfect. Only an off-box request
   crosses nginx.

### The probes, and why these

| Service           | Probe                                      | Why                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connector-rust`  | `GET 127.0.0.1:4000/ilp/identity` → 200    | The Rust connector has no `/health` — `/health`, `/healthz`, `/status`, `/` all 404, and `/metrics` is 404 on relay but 401 on store. `/ilp/identity` 200s only once the process is serving **and** has read its signer key. `fleet-ops.yml` already uses it. |
| `swap-node`       | `GET 127.0.0.1:8080/health` → 200          | `blsPort`, loopback-published. No public swap health surface exists.                                                                                                                                                                                          |
| `relay`, `store`  | container `HEALTHCHECK` verdict            | These two define one; reading Docker's verdict beats restating their probe here.                                                                                                                                                                              |
| `announce`        | `[announce] OK` in the last 15 min of logs | A loop publisher: no port, no healthcheck. Its printed verdict is the only honest signal. 15 min covers ~3 of its 240s iterations, so one slow publish is not an alert.                                                                                       |
| relay public edge | `proxy.relay…/ilp/identity` → 200          | crosses nginx                                                                                                                                                                                                                                                 |
| relay public edge | `relay-ws…/` → **426**                     | 426 Upgrade Required is the honest liveness signal for a WebSocket-only endpoint. A 200 there would mean something _other_ than the relay is answering.                                                                                                       |
| store public edge | `proxy.ario…/ilp/identity` → 200           | crosses nginx                                                                                                                                                                                                                                                 |

### How you find out

A failing run opens — or comments on — a single rolling issue in this repo:

> **`[fleet-health] devnet fleet is unhealthy`**, labelled `needs:human` + `bug`

`needs:human` is the org's existing human-queue label (toon-meta#347), so the alert lands in a queue
that is already swept rather than inventing a channel of its own. Opening an issue also notifies
everyone watching the repo, which a failed scheduled run does not do reliably — GitHub mails only
the cron's last editor.

The issue carries the full probe table and the rollback commands. **A later green run comments the
recovery and closes it**, so the issue's open/closed state _is_ the fleet's current verdict; you
never have to work out whether an old alert is still live. One issue, not one per failing run: a
fleet that stays down for an hour would otherwise open four.

### Known gap, not alerted on

`dvm.devnet.toonprotocol.dev` — the store app's public name — currently fails its TLS handshake.
DNS resolves to the store box and nginx routes the name correctly, but the box serves a certificate
whose only `subjectAltName` is `proxy.ario.devnet.toonprotocol.dev`; it was never reissued to cover
`dvm`. The store app therefore has no working public URL, and its health is observable only on-box.

It is deliberately **not** a fleet-health probe: it would alert forever on a pre-existing certificate
gap rather than on a deploy, which is how a monitor gets ignored. Fixing the certificate is separate
work.
