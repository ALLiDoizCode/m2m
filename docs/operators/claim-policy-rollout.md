# Rolling out the peer claim policy: order, the transition setting, and the 3-box fleet

Operator runbook for [issue #883](https://github.com/toon-protocol/connector/issues/883) (part of
[toon-meta#316](https://github.com/toon-protocol/toon-meta/issues/316), child B6 of the claim
policy umbrella [#868](https://github.com/toon-protocol/connector/issues/868)). This is the
migration [ADR 0031](../adr/0031-a-peer-prepare-arrives-with-its-covering-claim-or-it-is-greeted.md)
deferred: _"what happens to a live peering whose counterparty still sends claimless packets."_

**This document is the plan. Running it is a human step, not this ticket's** — no live-box
action is taken by landing this PR (issue #883's own acceptance criterion).

## What #868's claim policy actually changed, and why rollout order matters

Three children of #868 are already merged to `main`, in one binary going forward — they do not
ship as separate releases an operator could sequence independently:

- **B2** ([#880](https://github.com/toon-protocol/connector/issues/880), PR #913): the _receive_
  side. A peer PREPARE to a route this connector terminates and prices, carrying no claim that
  covers that price, is refused (`F06_UNEXPECTED_PAYMENT` + the client edge's own x402 greeting)
  instead of being admitted.
- **B3** ([#881](https://github.com/toon-protocol/connector/issues/881), PR #914): the _send_
  side. `forward_via_peer_route` now covers every packet it forwards on a peer route
  proactively, before sending — not only after a peer has already greeted it once.
- **B5** ([#882](https://github.com/toon-protocol/connector/issues/882), PR #916): the exposure/
  ceiling machinery the credit window needed is removed outright, not kept as a residual bound.

**Because B2 and B3 live in the same binary, "upgrade this box" upgrades both halves at once.**
A box that upgrades starts refusing claimless inbound peer PREPAREs (B2) at the exact moment it
starts covering its own outbound ones (B3). That is fine for the sending half in isolation — a
box that covers every packet it forwards never causes a counterparty pain it wouldn't have caused
before. It is **not** fine for the receiving half in isolation: the moment one box in a peering
upgrades, it refuses every claimless packet its counterparty is still sending, and if that
counterparty has not yet upgraded (and so cannot yet cover), every packet that peering was
carrying dies. **Senders must be safe to cover before receivers start refusing whoever hasn't
covered yet** — and because the two halves cannot be deployed as two separate binaries, "senders
first" cannot mean "ship B3 in one release, B2 in the next." It has to mean something else: an
operator upgrades a box's binary (so its send side starts covering — always safe) while
**suppressing** that same box's new receive-side refusal until every counterparty peering it has
is confirmed covering too. That suppression is the transition setting below, and it is the actual
mechanism by which this rollout achieves "senders first, receivers second" given B2 and B3 do not
separate.

## The transition setting: `claim_enforcement`

A new, **per-peering**, **temporary** config field on `[[peers]]`
(`connector_config::peer::ClaimEnforcement`, `crates/connector-config/src/peer.rs`):

```toml
[[peers]]
id = "apex-store"
# ...
claim_enforcement = "observe"   # default, if omitted: "enforce"
```

- **`"enforce"` (the default — omit the field for it).** An uncovered peer PREPARE is refused
  exactly as B2 shipped: `F06_UNEXPECTED_PAYMENT` plus the x402 greeting, never delivered to the
  app. This is the **permanent** behaviour every peering must end the rollout in.
- **`"observe"`.** An uncovered peer PREPARE is **admitted**, exactly as it was before B2, but
  logged at the same level and with the same fields a refusal would carry
  (`peer_id`, `destination`, `price`, `advanced`, `shortfall`, `claim_ack`) —
  `crates/connector-peer-btp/src/price_gate.rs::payment_required`. An operator watching this
  box's logs sees every admission that would have been a refusal under `"enforce"`, without
  actually refusing anything, before flipping the switch.
- A mistyped value (anything other than the two spellings above) is refused **at config load**,
  by name (`ConfigError::InvalidClaimEnforcement`) — the same convention `peer_expose` uses. A
  typo that meant `"observe"` must never silently read as the strictest behaviour there is and go
  unnoticed on a receiver that never actually observed.
- **Scope: one peering, not the node.** There is no node-wide switch. A box mid-rollout can have
  `apex-store` on `"observe"` and `apex-relay` on `"enforce"` at the same time — the two peerings
  migrate independently, on whichever schedule their own counterparty's readiness allows. Shared
  between both carriages a peering can ride (`connector_peer_btp::ClaimEnforcementPolicy`,
  wired once in `connector-client-edge/src/peer.rs::PeerCarriages::from_config`), so a peering is
  never `observe` on BTP and `enforce` on HTTP depending on which carriage a packet happened to
  arrive on.
- **Dated for removal.** This field, `ClaimEnforcement::Observe`, and the config surface that
  selects it should be deleted once every `[[peers]]` row across the fleet reads `"enforce"` (in
  practice: once no committed or bind-mounted config sets `"observe"` anymore) and the Gates below
  have held for a soak window — the same removed-field-trap convention `ceiling`/
  `flush_interval_ms` now use (`ConfigError::PeerCeilingRemoved`,
  `crates/connector-config/src/peer.rs::resolve_peers`). Target: no later than
  [toon-meta#316](https://github.com/toon-protocol/toon-meta/issues/316) closing, or
  **2026-11-01**, whichever is first. File the removal as its own issue when the last `"observe"`
  is flipped to `"enforce"`, referencing this document.

## Current risk, honestly stated

None of the fleet's three peerings carry **live, real-channel** peer traffic today:

- **apex↔store** (`apex-store`): the real peer channel `0x0bfd0b88…` has zero deposit on the
  store side, so a claim against it fails `InsufficientHeadroom`
  (`crates/connector-runtime/src/outbound_client.rs:165` for the error, `:444-450` for the
  headroom check that raises it) and the store box pays box 1 **as a client**
  instead — a client-edge claim, not a peer one. The committed `[[peer_channels]]` row is a
  documented placeholder (`0xdead…`, `docs/operators/peer-channel-migration.md`, issue #822),
  pending that migration.
- **apex↔relay** (`apex-relay`): issue #821 opened and funded a real channel
  (on-chain `channel_id 0x62c81d83…`), applied directly to both boxes' **live, untracked**
  config as part of #820's cutover — this repo's own copy still shows the placeholder, since a
  peering's live facts are never committed (`infra/linode-node/connector-rust.toml`'s own
  comment). Whether that real channel is currently carrying priced, forwarded traffic (as opposed
  to being open and idle) is not verifiable from this repo — check it live before assuming either
  way (Gates, below).

So flipping B2's refusal on today, before this runbook's Order below, has a **small** live blast
radius on the apex-store leg (no real channel to refuse a claim against) and an **unverified**
one on apex-relay (a real channel may or may not be carrying traffic). Treat every step below as
though live traffic exists — the runbook must be correct once #822 lands regardless of what is
true on the day it merges.

## Prerequisite: a published image containing #880/#881/#882/#883

`.github/workflows/publish-connector-rust-image.yml` publishes `rust-sha-<short-sha>` on a push to
`main` that touches `crates/**`, `Cargo.toml`/`Cargo.lock`, the Dockerfile or the workflow itself —
content-pinned, immutable. (A docs-only merge cuts no tag; this PR touches `crates/**`, so it
does.) B2/B3/B5 are already on `main`
(commits `1823b4fb`, `568b9e4f`, `6439562c`); once this issue's own PR (adding
`claim_enforcement`) merges too, the **next** `rust-sha-<sha>` tag published after that merge is
the one this runbook rolls. Note it down before starting Order below — do not assume the fleet's
committed pin of record is it.

**The committed pin of record and the live pin are two different things, and both matter here:**
`crates/connector-bin/tests/devnet_configs_load.rs::EXPECTED_CONNECTOR_TAG` was `rust-sha-440eab7`
when this paragraph was written — what the _repo's_ five compose files declared at the time — and
it predated B2/B3/B5 (issue numbers #880/#881/#882 postdate #859, the PR that set it). Issue #948
has since bumped it to `rust-sha-415531a`, for an unrelated reason (carrying #912's `notice_*`
announce fields) — check the constant's own doc comment for the current value and provenance
rather than trusting this literal; do not assume a newer pin's mere existence means B2/B3/B5's own
tag has been noted per this section's own instruction above. **The live boxes are running an
older tag still** (`rust-sha-33f10e2` per this issue's own text) — nothing on any box
auto-deploys, so neither tag is what Order step 1 below actually checks; the box's live tag is.
Bumping `EXPECTED_CONNECTOR_TAG` and the five `image:` pins to the new tag is a **separate, later**
repo change (once the new tag exists and this rollout's Gates hold) — not performed by this
document, which only prepares the plan.

## Who does what

| Step                                               |     Repo-side (PR, reviewable)     |  Human-only (SSH, live config, restart)   |
| -------------------------------------------------- | :--------------------------------: | :---------------------------------------: |
| 0. Cut and note the rollout tag                    | ✅ (automatic, on this PR's merge) |            notes the tag down             |
| 1. Verify live state per box                       |                                    |    ✅ SSH, `docker inspect`, log grep     |
| 2. Config dry-run (positive + negative)            |     ✅ recipe below, this doc      |          ✅ runs it, on each box          |
| 3. Roll the new binary, `observe` on every peering |   ✅ config diff shape, this doc   |   ✅ edits live TOML, restarts, per box   |
| 4. Watch for admissions                            |                                    |         ✅ log grep, soak window          |
| 5. Flip to `enforce`, per peering                  |                                    | ✅ edits live TOML, restarts, per peering |
| 6. Confirm positive evidence                       |                                    |        ✅ curl/log checks, per box        |
| 7. Rollback (if needed)                            |                                    |          ✅ revert edit, restart          |

Every live step needs SSH and a bind-mounted config this environment does not have — the same
posture `relay-box-bringup.md`, `peer-channel-migration.md` and every other infra-touching
runbook in this repo records.

## Preconditions

- A `rust-sha-<sha>` tag exists containing this issue's `claim_enforcement` field (Prerequisite,
  above).
- SSH access to all three boxes: box 1 / `g.toon` (`104.237.150.177`), store (`45.79.173.113`),
  relay (`97.107.134.182`).
- Each box's live, bind-mounted `connector-rust.toml` is backed up before any edit in this
  runbook — `peer-channel-migration.md`'s own convention:
  `connector-rust.toml.bak-pre-claim-policy-rollout-<UTC-timestamp>`.
- `docker compose restart connector-rust` is understood as the reload path on every box —
  **`docker compose up -d` is a no-op against a bind-mounted config file** and reports success
  while changing nothing (the same trap every prior bring-up runbook in this directory names).

## The config dry-run recipe

Before editing any box's **live, running** config, prove a candidate edit loads cleanly against
the exact image that box will run — without touching that box's live process, its state, or the
chain. Run on the box itself (or any host with the same `/app/data` key material available), next
to the candidate `connector-rust.toml`:

```bash
# 1. A scratch state dir -- never the box's real one. A dry run must not
#    touch the live claim journal.
SCRATCH_STATE=$(mktemp -d)

# 2. A throwaway peering secret -- resolve() only checks the secret_file is
#    non-empty and readable, never that it matches the counterparty's real
#    bytes, so this proves the config SHAPE loads without needing the real
#    shared secret in a second place.
echo "dry-run-only-not-a-real-secret" > /tmp/dry-run-peer.secret

# 2b. Key material is mounted FILE BY FILE, exactly as every box's own
#     compose overlay declares it -- there is no `data/` DIRECTORY on any
#     box to mount. Verified against the running containers on both
#     surviving boxes (2026-08-10):
#
#       relay box  signer-rust.key, settlement-rust.key,
#                  settlement-solana-rust.key, announce.key
#                  (no peering secret -- it declares no [[peers]])
#       store box  signer-rust.key, settlement-rust.key,
#                  settlement-solana-rust.key, apex-store.secret
#
#     Mounting a non-existent `./data` instead would have Docker create an
#     empty root-owned directory, and Config::load would then abort with
#     SignerKeyFileNotFound("/app/data/signer.key") -- long before the
#     settlement RPC this recipe is trying to reach. That failure looks
#     exactly like the "not ready to bind-mount" case below, so it would
#     send you chasing a config problem that does not exist.
#
#     Set the extras for the box you are on; leave empty if it has neither.
BOX_EXTRA_MOUNTS=(
  # relay box:
  #   -v "$(pwd)/announce.key:/app/data/announce.key:ro"
  # store box (and any box with a [[peers]] row -- the secret is per-peering,
  # so a box peering as `apex-relay` names apex-relay.secret instead):
  #   -v /tmp/dry-run-peer.secret:/app/data/apex-store.secret:ro
)

# 3. Run the RUNNING image, offline. Real signer/settlement keys mounted
#    read-only (the connect step reads them even though it can't finish);
#    the candidate TOML read-only; the scratch state dir the only writable
#    mount; no network at all.
docker run --rm --network none \
  -v "$(pwd)/connector-rust.toml:/app/config/connector.toml:ro" \
  -v "$(pwd)/signer-rust.key:/app/data/signer.key:ro" \
  -v "$(pwd)/settlement-rust.key:/app/data/settlement.key:ro" \
  -v "$(pwd)/settlement-solana-rust.key:/app/data/settlement-solana.key:ro" \
  "${BOX_EXTRA_MOUNTS[@]}" \
  -v "$SCRATCH_STATE:/app/state" \
  ghcr.io/toon-protocol/connector:rust-sha-<the-rollout-tag>
```

**Expected result: it fails, and it must fail at exactly one place.** `Config::load` is
synchronous and runs first — every `deny_unknown_fields` check, every removed-field trap
(`PeerCeilingRemoved`/`PeerFlushIntervalRemoved`), every `InvalidClaimEnforcement`, every
`PeerSecretFileNotFound`/`PeerCredentialMissing`, all of it, resolves before any network call is
made. Only _after_ the config is fully valid does the process try to build the settlement
backend, which calls `EvmSettlementBackend::connect` — reads the chain id over `rpc_url`
(`crates/connector-settlement-evm/src/lib.rs::connect`, wired from
`crates/connector-cli/src/runtime.rs::build_evm_settlement_backend`). With `--network none` that
call cannot resolve or connect and the process exits 1 with a connection error — proving
everything else about the candidate config (TOML shape, every key file, every secret file, every
`[[peers]]`/`[[peer_channels]]` row) loaded and validated cleanly, without ever reaching the chain
or the box's live claim journal.

If it exits with anything else — a config error naming a field, a missing/unreadable key file, a
panic — the candidate config is not ready to bind-mount; fix what it named and re-run.

### The negative control

Prove the recipe itself actually exercises validation, not just "the container starts and does
something": add a bogus top-level key the same run would otherwise accept.

```bash
cp connector-rust.toml /tmp/negative-control.toml
printf '\nthis_key_does_not_exist = true\n' >> /tmp/negative-control.toml

docker run --rm --network none \
  -v /tmp/negative-control.toml:/app/config/connector.toml:ro \
  -v "$(pwd)/signer-rust.key:/app/data/signer.key:ro" \
  -v "$(pwd)/settlement-rust.key:/app/data/settlement.key:ro" \
  -v "$(pwd)/settlement-solana-rust.key:/app/data/settlement-solana.key:ro" \
  "${BOX_EXTRA_MOUNTS[@]}" \
  -v "$SCRATCH_STATE:/app/state" \
  ghcr.io/toon-protocol/connector:rust-sha-<the-rollout-tag>
```

**Expected result:** exits 1 immediately with a `toml`/`serde` error naming `this_key_does_not_exist`
as an unknown field (`deny_unknown_fields`) — never the RPC-connect failure the positive recipe
above ends at. If the negative control instead runs as far as the RPC step, `deny_unknown_fields`
is not doing its job on this build and the positive recipe above proves nothing; stop and find out
why before trusting it on any box.

## Order

1. **Verify live state per box, before anything else.** SSH to each box; read the running
   container's actual image tag (`docker inspect --format '{{.Config.Image}}' connector-rust` or
   equivalent), not the repo's committed pin — Prerequisite above explains why they can disagree.
   Confirm which `[[peers]]` rows are live-edited on each box already (this repo's copies carry
   placeholders for a reason — Current risk, above) and note their real `channel_id`s.

2. **Config dry-run, both the positive recipe and the negative control, on each box** before
   touching its live file. This is read-only against the live process — it runs a second,
   offline, `--network none` container beside the running one and touches nothing it depends on.

3. **Roll the new binary to every box, with every peering set to `claim_enforcement = "observe"`.**
   This is the actual "senders first" step: every box's send side (B3) starts covering
   immediately on upgrade — safe unconditionally — while every box's receive side (B2) is held
   open (admitting exactly as before B2 shipped) until step 5 confirms it is safe to close.
   Per box: back up the live `connector-rust.toml` (Preconditions), add
   `claim_enforcement = "observe"` under every `[[peers]]` row, `docker compose restart
connector-rust`. Order across boxes does not matter here — `"observe"` never refuses, so no
   box's upgrade can break a not-yet-upgraded counterparty's traffic.

4. **Watch for admissions.** Per peering, grep each box's logs for
   `peer PREPARE admitted without a covering claim (claim_enforcement = observe`
   (`price_gate.rs`'s own message) over a soak window long enough to see genuine traffic on that
   peering — for a low-traffic devnet peering, this may be days, not hours; do not shortcut this
   for a peering `Current risk` above could not verify is idle. Zero admissions over the soak
   window is the signal this peering is safe to flip; any admission is a real claimless packet
   this peering's counterparty is still sending and it is not yet safe.

5. **Flip each peering to `claim_enforcement = "enforce"` (or remove the field — same effect)
   individually, only once its own soak window in step 4 shows zero admissions.** This is
   deliberately per-peering, not per-box or fleet-wide: `apex-store` and `apex-relay` on box 1 may
   clear step 4 on different schedules, and there is no reason to hold the one that is ready
   waiting on the one that is not. Restart the box after editing.

6. **Confirm the Gates below hold**, per peering just flipped.

7. **Once every peering across the fleet is confirmed `enforce`** (or has the field omitted) **and
   the removal-target conditions above are met, delete the `claim_enforcement` config surface**
   in a follow-up issue/PR referencing this document.

## Gates — per peering, after Order step 5

Never "no errors in the log" — a credential naming an unconfigured peer id produces **no refusal
event at all**, by design (`crates/connector-peer-auth/src/decision.rs`'s own doc: _"An
unconfigured peer id produces no refusal to carry one"_) — silence is not evidence of anything.
Check for these positive signals instead:

- **(a) A 101 upgrade (BTP) or a 200 (HTTP), not a connection failure.** The peering's transport
  itself is healthy post-restart — a BTP session completes its websocket handshake
  (`Upgrade: websocket`, `101 Switching Protocols`) or an HTTP peer request round-trips 200
  (`peer-carriage-spec.md` §6.2: status is always 200 regardless of packet verdict) —
  before checking anything about claims.
- **(b) A claim-ack.** A claim sent on this peering is acknowledged: `claim-ack` protocolData
  (BTP) or the `Toon-Claim-Ack` header (HTTP) rides the response, `{"result":"accepted", ...}`
  for a genuine claim. This is `judge_claim`'s verdict, independent of the packet's own outcome
  (§6.2) — check it explicitly, not as a side effect of a fulfil.
- **(c) A forwarded packet actually fulfils.** A real packet routed over this peering completes
  end to end: charged at the originating client edge, carries a peer claim, is fulfilled, and
  this peering's claim watermark advances (`peer-claims.log` on the state volume records
  `outbound_claim_signed`/an accepted inbound claim naming this peering's `channel_id`). This is
  the one check that actually proves B2's refusal is not silently starving a peering that still
  has real traffic to carry — (a) and (b) can both hold on a peering nothing routes over.
- **(d) No `F06_UNEXPECTED_PAYMENT` refusal fires against this peering's own legitimate traffic
  post-flip.** If one does, the soak window in Order step 4 was not long enough, or this
  peering's counterparty regressed — revert this one peering to `"observe"` (Rollback, below)
  and re-open the soak window rather than debugging live under active refusals.

If (a)-(c) all hold and (d) holds for a further soak window at least as long as step 4's, this
peering's migration is complete.

## Rollback

**Per peering, at any point before it is confirmed at Gate (d): set `claim_enforcement =
"observe"` on that one row and restart the box.** This is a single-line edit, reversible in
seconds, and it never requires touching the peering's counterparty — `"observe"` on this box's
own receive side is entirely a local decision. Traffic that was being refused resumes immediately
(admitted, and logged, exactly as during the soak window), so this is the "stop the outage" lever,
not a slow fix.

**Rolling back the binary itself (Order step 3) is a separate, coarser lever** — only needed if
something _other_ than the claim-policy refusal is wrong with the new tag. `docker compose
restart` against the previous known-good `image:` tag, per box, same as any other image rollback
this fleet does; nothing in this rollout changes that path.

**There is no point of no return in this runbook.** Unlike `peer-channel-migration.md` (which
closes an on-chain channel partway through and cannot undo that), every step here is a config
edit and a restart — reversible for as long as the field exists. The removal in Order step 7 is
the only step that is not reversible by a config edit alone; do not perform it until every
peering has held Gate (d) for its full soak window.
