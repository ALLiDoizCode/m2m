# Connector Team Reply: ILP-as-TCP Local Delivery Pipeline

**Date:** 2026-05-01
**From:** Connector team
**Re:** `connector-handoff-ilp-as-tcp-2026-05-01.md` (TOON / Townhouse handoff)
**Status:** Premise partially stale — scope is smaller than the spec implies; eight design gaps need decisions before we cut code

---

## TL;DR for the Townhouse team

We read the handoff carefully and grepped the connector codebase against your four open questions. Three of your spec's premises are stale, and the actual scope is smaller than the doc implies:

1. `LocalDeliveryClient` already exists in the connector (`src/core/local-delivery-client.ts`) and is already wired into the packet handler. It already POSTs a "no-ILP-knowledge-required" envelope to BLS. We are **extending** this class, not creating a new `local-delivery.ts`.
2. `SettlementMonitor` already lives in the connector (`src/settlement/settlement-monitor.ts`) and is already event-driven off `ClaimReceiver`. The "move from SDK to connector" migration the spec describes appears to be already done. Either the SDK is re-exporting our copy, or there are two implementations that have drifted.
3. `@noble/curves` is already a connector dep (`package.json:88`) and `secp256k1.schnorr` is already used in `src/settlement/privacy/nip59-claim-wrapper.ts`. No new crypto dep.

Given that, the *actual* delta is much smaller — but there are eight design questions buried in the spec that we cannot resolve unilaterally. They are listed in §4. We need answers before we scope sprints.

---

## 1. Direct answers to your four open questions

### Q1 — Where exactly does local delivery happen today?

`packages/connector/src/core/local-delivery-client.ts`. It is constructed and held by `PacketHandler` (`src/core/packet-handler.ts:133, :262`), which calls `LocalDeliveryClient.deliver()` when an ILP packet terminates at this connector. There is also a function-handler bypass (`setPacketHandler()` in `connector-node.ts:280`) used when the connector runs embedded — that path skips HTTP and calls a JS function directly.

The call-site you described as "where the connector resolves an ILP address to a local HTTP peer" is `PacketHandler.deliver()` (HTTP path) and the embedded handler path. Both need the new verify/nonce/price stages.

**Implication for the spec:** the new pipeline is not a separate file inserted at a single call-site. It is two new pre-stages added to the existing `LocalDeliveryClient.deliver()` (and the embedded equivalent), or a new wrapper class composed in front of it. Recommendation: extend the existing class — it already handles timeout, expiry-before-call, reject-code mapping, and response validation, all of which we want to keep.

### Q2 — Crypto library

Already in `packages/connector/package.json`:
- `@noble/curves@^1.9.0` (line 88) — has `secp256k1.schnorr.verify()`
- `@noble/hashes@^1.8.0` (line 89)
- `@noble/ciphers@^1.3.0` (line 87)

`secp256k1` is imported in `src/settlement/privacy/nip59-claim-wrapper.ts:23` and tests. Nostr Schnorr verify reuses these. **No new dep.**

### Q3 — Per-peer balance and nonce storage

The connector uses **two** stores:

- **TigerBeetle** (`src/settlement/tigerbeetle-client.ts`) for the cumulative-balance ledger. Transfer-shaped, not key/value-shaped — `last_nonce` does not fit naturally here.
- **SQLite** (`src/settlement/claim-receiver-db-schema.ts`, surfaced via `ClaimReceiver` in `src/settlement/claim-receiver.ts`) for per-claim metadata, including the existing claim nonce. `claim-receiver.ts:548, :734, :899` already implement `if (claim.nonce <= latestClaim.nonce) reject` for **BTP claim nonces**.

**Important distinction the spec does not draw:** there are now **two** nonces in play.

| Nonce | Layer | Where validated today |
|---|---|---|
| BTP claim nonce | Peer-to-peer claim ordering | `ClaimReceiver` (already monotonic per peer) |
| TOON event/claim nonce | Per-sender-pubkey delivery ordering | **Does not exist yet** — this is the new one |

Adding `last_nonce_per_pubkey` belongs in the SQLite side as a new table (or a new column on an existing per-sender table — TBD when we look at the schema). It must not be conflated with the BTP claim nonce; they live at different layers and could legitimately disagree.

### Q4 — Existing settlement timer/threshold mechanism

Yes — and the spec's premise that `SettlementMonitor` lives in the SDK is wrong (or out of date).

- `src/settlement/settlement-monitor.ts` exists in the connector.
- It is **event-driven**, not polling: subscribes to `ClaimReceiver` `CLAIM_RECEIVED` events and emits `SETTLEMENT_REQUIRED` when cumulative amounts cross thresholds.
- It is wired in `connector-node.ts:1096` and feeds `SettlementExecutor` (`src/settlement/settlement-executor.ts`), which already calls `claimFromChannel()` against the appropriate chain provider (EVM, Solana, Mina).
- It is exported from the connector public surface at `src/lib.ts:46`.

So the migration described in §Settlement Migration of your handoff — "build `toon-settlement.ts`, deprecate `SettlementMonitor` in the SDK" — is mostly a relabeling exercise. The watcher exists. What may not exist is the per-node configuration shape from `toon.json` (`threshold_msats`, `interval_seconds`). The connector currently configures thresholds via `SettlementThresholdConfig` (default + per-peer + per-token). Wiring `toon.json` thresholds in is a config-loader change, not a settlement-engine rewrite.

**Action item for Townhouse:** confirm whether the SDK's `SettlementMonitor` is (a) a re-export of ours, (b) a fork that has drifted, or (c) something we have not seen. If (b), the SDK fork should be deleted, not deprecated.

---

## 2. Where your spec is stale or imprecise

### 2a. "New file `connector/src/local-delivery.ts`"
Already exists as `local-delivery-client.ts` (and `core/packet-handler.ts` orchestrates it). The new code is two stages prepended to the existing pipeline:

- `verifyToonEvent()` — Schnorr verify + per-pubkey nonce check
- `enforcePricing()` — read `toon.json` rate, compute required msats from packet size or per-job, reject F04 if underpaid

Both go *before* the existing `deliver()` HTTP call. The HTTP call itself is mostly the same — different envelope (see 2c).

### 2b. "POST raw Nostr event JSON + X-TOON-* headers"
Conflicts with the existing `LocalDeliveryClient` envelope, which sends a `PaymentRequest` JSON (defined in `core/payment-handler.ts`). This is a **breaking change** to every existing BLS deployment, not an extension. Two options:

1. **Bump the envelope to v2.** Add a config flag `localDelivery.envelope: 'payment-request' | 'toon-event'`. v2 sends the Nostr event + headers as you described. Existing BLSes keep working on v1.
2. **Single envelope.** Replace `PaymentRequest` with the headers-plus-event shape across the board. Simpler long-term, painful migration.

We recommend (1) for the rollout, (2) once Townhouse is the only consumer.

### 2c. HTTP→ILP error mapping (your Step 5 table)
The spec collapses HTTP 4xx → F99. This is too coarse:

- 429 (rate limit) is *temporary* — should map to T00, not F99
- 408 (request timeout) is *temporary* — should map to T03
- 503 is already T01 in the existing `mapRejectCode()`; we should keep parity

We will land the existing connector mapper's behavior, not the table in your spec. If you want different mapping, push back and we'll codify it.

### 2d. "Settlement: deprecate `SettlementMonitor` in the SDK as a stub"
If our reading is right (the SDK re-exports the connector's monitor), there is no stub work — just clean up the re-export and document the new home. If the SDK has a real fork, we need it before we can answer the deprecation question.

---

## 3. Eight design gaps surfaced during review

These are all *the spec is silent on this, and the answer materially changes the implementation.* We need decisions, not guesses.

1. **`toon.json` hot-reload during in-flight packets.** Spec says "hot reload via `fs.watch`." If the rate drops mid-packet, does the in-flight packet use old or new rate? Old rate (snapshot at packet entry) is the only sane answer for determinism, but we want this written down.
2. **`pubkey` field — delivery filter or sender authorization?** Spec says `pubkey` is "optional — if absent, connector delivers all packets to this node for the declared kinds." This conflates *which node receives the packet* (routing) with *which senders are authorized* (auth). If `pubkey` is absent, are we accepting events signed by *any* pubkey? That is a permissive default we should not ship without a flag.
3. **Two-nonce conflict resolution.** Per Q3 above: the BTP claim nonce and the TOON event nonce are independent. If they disagree (e.g., BTP nonce 7 carries TOON event nonce 12, then BTP nonce 8 carries TOON event nonce 10), what wins? Reject? Drop the BTP packet? The spec does not say.
4. **Concurrent packets from the same sender.** Two ILP PREPARE packets from sender X with TOON nonces N and N+1 arrive within microseconds. Does the nonce store update atomically? If N+1 lands first and sets `last_nonce = N+1`, the legitimate retry of N is rejected. We need to either order-by-arrival (lock per pubkey) or buffer-and-reorder (more complex). The spec assumes atomic single-thread; we are not single-thread.
5. **Pricing rate units.** `rate_msats_per_kb` with `ceil(payload_bytes / 1024)`: is `payload_bytes` the Nostr event JSON byte count, the ILP packet `data` field length, or the unencoded event content? Each gives a different answer.
6. **Per-node vs per-pubkey rate.** `toon.json` declares one rate per node. What if a node wants tiered pricing (e.g., kind 1 cheaper than kind 5094)? The spec says nothing. Fine for v1, but flag it before we hard-code single-rate.
7. **Settlement chain selection.** A node declares `settlement.threshold_msats` but not which chain. The connector supports EVM/Solana/Mina settlements. How does the connector pick the chain for this node's settlements? Is it inferred from the channel the sender opened, declared in `toon.json`, or operator-policy?
8. **Idempotency of `handler_url` POST.** The spec maps HTTP 5xx → ILP T00 (retryable). If the node processed the request and crashed before responding, the connector retries, and the node processes again. Is the node responsible for idempotency keyed on `X-TOON-Nonce`, or does the connector dedupe? Spec is silent. (For an unmodified `strfry` — which is the acceptance test — the node has *no* dedupe logic, so the connector must dedupe.)

---

## 4. Revised scope (connector-side)

Given what already exists, the actual work is:

| File | Status | Change |
|---|---|---|
| `src/core/local-delivery-client.ts` | exists | Add pre-stages: Schnorr verify, per-pubkey nonce, pricing gate. New `envelope: 'toon-event'` mode. |
| `src/core/packet-handler.ts` | exists | No change needed if we extend the client; one method swap if we wrap. |
| `src/toon/toon-config-loader.ts` | new | Reads/watches `toon.json` per registered node; in-memory cache; hot reload. |
| `src/toon/toon-event-verifier.ts` | new | Schnorr verify + nonce check, isolated for unit testing. Reuses `@noble/curves`. |
| `src/toon/payment-headers.ts` | new | Builds `X-TOON-*` headers from packet + claim. Trivial. |
| `src/settlement/claim-receiver-db-schema.ts` | exists | Add table or column for `last_event_nonce_per_pubkey`. |
| `src/settlement/settlement-monitor.ts` | exists | No engine change. Add config plumbing for per-node `toon.json` thresholds. |

**Sequencing (revised):**
1. Resolve §3 gaps — block on Townhouse answers
2. `toon-config-loader` + `toon-event-verifier` + `payment-headers` (independent, parallel)
3. Schema migration for per-pubkey nonce
4. Extend `LocalDeliveryClient` with v2 envelope and the new pre-stages, behind a config flag
5. Acceptance test: unmodified `strfry` container, end-to-end with a real Anvil/Solana/Mina settlement

We expect this to land in 2-3 sprints once §3 is unblocked. Without §3 answers, sprint 1 produces shelfware.

---

## 5. Test strategy notes (test-architect read)

Per `CLAUDE.md` this codebase forbids mocks in tests. The new pipeline must be tested against real chain containers (`make infra-up`). Required test coverage before merge:

- Negative-path: malformed Nostr event, invalid Schnorr signature, replayed nonce, future nonce skip, pricing under by 1 msat, pricing exact, oversized payload
- Concurrency: two PREPAREs from the same pubkey with adjacent nonces, both arriving inside the same event-loop tick
- Hot reload: `toon.json` rate change while a packet is in flight (gap §3.1)
- Acceptance: unmodified `strfry` container as the BLS, end-to-end ILP PREPARE → FULFILL with real settlement crossing the threshold, fired by `SettlementMonitor`

The acceptance test is the single test that validates the entire redesign. It should run in nightly HTTP-surface CI from sprint 1.

---

## 6. Asks of the Townhouse team

- Resolve §3 gaps (the eight design questions). We can pair on this in a 30-minute call; doc replies are also fine.
- Confirm the SDK's `SettlementMonitor` situation (re-export, fork, or unknown).
- Confirm envelope migration strategy (option 1 vs option 2 in §2b).
- Confirm whether tiered per-kind pricing is in-scope for v1 or deferred (§3.6).

Once we have these we can write the implementation tickets and commit to a delivery date.

---

## Appendix: file references used in this reply

- `packages/connector/src/core/local-delivery-client.ts` — existing local delivery HTTP client
- `packages/connector/src/core/packet-handler.ts:30, :133, :262` — orchestrates LocalDeliveryClient
- `packages/connector/src/core/connector-node.ts:280, :1096` — embedded handler bypass; SettlementMonitor wiring
- `packages/connector/src/settlement/settlement-monitor.ts` — event-driven settlement watcher (already in connector)
- `packages/connector/src/settlement/claim-receiver.ts:548, :734, :899` — existing BTP claim nonce monotonicity
- `packages/connector/src/settlement/claim-receiver-db-schema.ts` — SQLite per-claim metadata schema
- `packages/connector/src/settlement/privacy/nip59-claim-wrapper.ts:23` — existing `secp256k1` import path
- `packages/connector/package.json:87-89` — existing `@noble/*` deps
- `packages/connector/src/lib.ts:15-17, :42-46` — public-surface exports (note `LocalDeliveryClient` is internal-only)
