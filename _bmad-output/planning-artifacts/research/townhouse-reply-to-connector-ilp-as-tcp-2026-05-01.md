# Townhouse Reply to Connector Team: ILP-as-TCP Local Delivery Pipeline

**Date:** 2026-05-01
**From:** TOON Protocol / Townhouse team
**Re:** `connector-reply-ilp-as-tcp-2026-05-01.md`
**Status:** All 8 design gaps resolved + 3 additional decisions. Ready for ticket scoping.

---

## TL;DR

Mea culpa first: the original handoff doc had three stale premises. You caught all of them.

1. **`LocalDeliveryClient` already exists** — `packages/connector/src/core/local-delivery-client.ts` is the right extension point. We extend it with two pre-stages, not create a parallel class. Apologies for the noise.
2. **`SettlementMonitor` already lives in the connector** — `src/settlement/settlement-monitor.ts`, event-driven off `ClaimReceiver`, wired in `connector-node.ts:1096`, feeding `SettlementExecutor`. The "migrate from SDK" plan was wrong.
3. **`@noble/curves` is already a dep** — confirmed at `package.json:88`. No new dep.

Plus a fact you asked about:

**The SDK has no `SettlementMonitor`.** Verified via `grep -rn "SettlementMonitor\|class.*Monitor" packages/sdk/src` returning zero results. The SDK's `settlement/` directory is `buildSettlementTx()` (Story 12.6 — mill-side settlement transaction *building* from accumulated claims). Different concern, different layer. **There is no fork to clean up, no re-export, no deprecation work.** Your `SettlementMonitor` is canonical and stays put.

Given that, the actual delta is exactly what your §4 revised scope describes. The eight design gaps are answered below. We add three things to the spec that were not in the original handoff.

---

## 1. Resolution of the Eight Design Gaps (§3)

### Gap 1 — `toon.json` hot-reload during in-flight packets

**Decision: snapshot at packet entry. Confirm your lean.**

Reasoning: if a sender pays for what they were quoted, the connector cannot move the goalposts mid-flight. Determinism wins.

**Implementation:**
- `LocalDeliveryClient.deliver()` (or `sendData()`) calls `const cfg = this.config.snapshot()` once at PREPARE-receipt entry
- `cfg` is a frozen object passed through the rest of the pipeline as a parameter
- No deeper code reads `this.config.*` — all reads go through the snapshot
- Hot reload swaps the underlying config atomically; in-flight packets keep their snapshot

**New file:** `packages/connector/src/config/toon-config-provider.ts` — wraps `fs.watch()` on `toon.json`, exposes `snapshot(): Readonly<ToonConfig>`. Atomic swap on reload.

**Test:** `local-delivery-client.hot-reload.spec.ts` — start a PREPARE, mid-flight bump `pricing.rate` from 1 to 100 via test injection, assert the in-flight packet uses rate=1 and the next packet uses rate=100.

---

### Gap 2 — `pubkey` field semantics: split into two distinct fields

**Decision: `pubkey` is the node's identity. Sender authorization is a separate field. Add `accept_from` allowlist to v1.**

The original spec conflated two concerns. The split:

```json
{
  "node": {
    "pubkey": "npub1...",
    "accept_from": ["npub1...", "npub1..."]
  }
}
```

- `pubkey` — the node's own Nostr pubkey. Used for: TownHub registry advertisement (kind:30400 events), NIP-58 badge attribution, routing endpoint key, signing outbound async result events (kind:6xxx, kind:23197). Required field.
- `accept_from` — optional allowlist of sender pubkeys this node will accept payments from. Absent or empty array → accept any sender (open mode, current behavior). Present → connector rejects packets from senders not in the list with `F00_BAD_REQUEST` and `message: "sender not authorized"`.

**Why ship `accept_from` in v1, not v2:** the use cases are real and immediate (private relays, paid newsletters, friends-and-family deployments, mill nodes that only accept routing from known peers). The cost is a few lines of zod schema + one set membership check before the pricing gate. Operators who don't need it just omit the field. Cost of deferring: operators hand-roll middleware, we inherit divergence.

**File:** `packages/connector/src/config/toon-config-schema.ts` (new, zod).
**Validation site:** `local-delivery-client.ts` before nonce check.
**Test:** `local-delivery-client.auth.spec.ts` — three cases: (a) absent allowlist accepts any sender, (b) allowlist + sender-in-list accepts, (c) allowlist + sender-not-in-list rejects with F00 + correct message.

---

### Gap 3 — Two-nonce conflict resolution

**Decision: BTP claim nonce and TOON event nonce are independent. They never need to agree. Validate both, reject on either failure, no cross-layer reconciliation.**

Reasoning: the two nonces measure different things.
- **BTP claim nonce** orders peer-to-peer *payments* on a channel (per-channel monotonic, owned by `ClaimReceiver`).
- **TOON event nonce** orders *publications from a sender* (per-sender-pubkey monotonic, new).

They will desynchronize in normal operation — a sender can publish events 5, 6, 7 across two different BTP claim batches in any order the connector batches them. Conflating them creates artificial coupling that breaks legitimate batching.

**Implementation:**
- BTP claim nonce: validated by `ClaimReceiver` (existing, unchanged).
- TOON event nonce: validated by the new pre-stage in `LocalDeliveryClient` against a per-pubkey monotonicity check (see Gap 4 for atomicity, Gap 8 for storage).
- Both checks happen independently. Packet succeeds only if both pass. Either rejection is final — no fallback, no retry across layers.

**Storage decision (resolves your concern about `claim-receiver-db-schema.ts` not fitting):** the per-pubkey TOON nonce store is a NEW concern with different lifecycle, different pruning rules, and different ownership from `ClaimReceiver`. It belongs in a new file:

- New file: `packages/connector/src/local-delivery/local-delivery-db-schema.ts`
- New table: `local_delivery_nonces` (see Gap 8 for full schema)
- Owned by `LocalDeliveryClient`, not `ClaimReceiver`

**Test:** `local-delivery-client.nonce.spec.ts` — (a) TOON nonce replay rejected before BTP claim nonce inspected; (b) fresh TOON nonce + stale BTP claim → rejected from `ClaimReceiver` layer; (c) both fresh → accept, both stores updated atomically (see Gap 4).

---

### Gap 4 — Concurrent packets from the same sender

**Decision: serialize per-pubkey via SQLite `BEGIN IMMEDIATE` transaction. Senders are responsible for monotonic nonce assignment; the connector enforces, it does not repair.**

Buffer-and-reorder is wrong: it adds latency, creates head-of-line blocking, and never terminates if N is lost in transit. Your "lock per pubkey" lean is correct.

The "N+1 lands first" case the team flagged is **not a bug**. If N+1 was actually sent before N from the same sender, the sender's local clock-or-counter is broken. Senders are responsible for monotonic nonce assignment on their side. The connector's job is to enforce the invariant, not to repair sender-side races.

**Implementation:**
- Wrap `[nonce check + nonce write + claim apply + payload deliver attempt]` in a single `db.transaction(() => { ... })` (better-sqlite3 sync API, no async footgun within the transaction)
- Per-pubkey contention is bounded by per-sender throughput, which is rate-limited upstream
- If contention shows up under load, add a bounded queue per pubkey — but ship the lock first and measure

**Test:** `local-delivery-client.concurrent.spec.ts` — fire 10 PREPAREs from same pubkey with nonces `[5,5,5,6,6,7,7,7,7,8]` via real `Promise.all` (not fake timers), assert exactly one each of nonce=5,6,7,8 succeeds, the rest get F00. Run 50 iterations to flush flakiness.

---

### Gap 5 — Pricing rate units

**Decision: `payload_bytes` = byte length of the canonical NIP-01 JSON serialization of the Nostr event.**

Specifically: `Buffer.byteLength(canonicalize(event), 'utf8')`, where `canonicalize` is the same NIP-01 serialization (`[0, pubkey, created_at, kind, tags, content]`) every Nostr relay uses for `id` calculation.

Why this and not the alternatives:
- **(a) canonical event JSON ✓** — deterministic, verifiable by sender locally before paying, byte-exact verifiable by connector, tied to what the node actually stores/serves
- (b) ILP packet `data` field (base64-encoded) — base64 inflates by 33%, an artifact of ILP framing not content cost; senders can't easily compute it pre-payment
- (c) event content field only — ignores tags, sig, structural overhead the relay actually pays storage for

**Implementation:**
- New file: `packages/connector/src/local-delivery/pricing.ts`
- Function: `computeCost(event: NostrEvent, cfg: ToonConfig): bigint`
- Cost: `BigInt(Math.ceil(payloadBytes / 1024)) * BigInt(rate_msats_per_kb)` clamped to `>= minimum`
- Single call site in `local-delivery-client.ts`

**Spec language:** "The pricing unit `payload_bytes` is the UTF-8 byte length of the canonical NIP-01 serialization of the Nostr event. Senders MUST compute this value identically to verify rate quotes before payment. Connectors MUST verify the value byte-exactly during pricing gate evaluation."

**Test:** `pricing.spec.ts` — table-driven: empty event → `minimum`, 1KB content × rate=1000 → 1_000_000, multibyte UTF-8 (emoji) counts bytes not codepoints, canonical serialization matches the event's `id` derivation.

---

### Gap 6 — Per-kind tiered pricing

**Decision: ship single-rate v1, reserve `byKind` schema for v2. Validate strictly in v1 (reject unknown top-level fields), accept `byKind` as parsed-but-unused.**

Schema:
```json
{
  "pricing": {
    "default": { "rate": "1000", "minimum": "0" },
    "byKind": { "1": { "rate": "500" }, "5300": { "rate": "10000" } }
  }
}
```

v1 behavior:
- Validator parses both `default` and `byKind`
- `lookupRate(kind, cfg)` returns `cfg.pricing.default` always — `byKind` is ignored
- Spec sentence: "Future versions may use per-kind rate overrides; v1 implementations MUST parse `byKind` but MUST use `default` for all kinds."

v2 change is one line in `lookupRate`: `byKind[kind] ?? default`. v1 deployments stay valid; no breaking migration.

**Test:** `pricing.spec.ts` v1 asserts `byKind` ignored. Add `pricing.v2.spec.ts.skip` queued so the v2 behavior is documented before it ships.

---

### Gap 7 — Settlement chain selection

**Decision: not a `toon.json` concern. Strike from the spec. Settlement chain is inferred from the channel — already handled by `SettlementCoordinator`.**

The chain is determined by the channel the sender opened. Each ILP packet carries claims on a specific chain (EVM, Solana, Mina). The settlement is on whatever chain the channel lives on. This is already correct in your `SettlementCoordinator`.

**Spec edit:** strike "settlement chain in `toon.json`" entirely. Reference `packages/connector/src/settlement/settlement-coordinator.ts` for the canonical behavior. No new code, no new test.

**Optional v2 future field** (do not ship in v1): `settlement.preferred_chain_order: ["solana", "evm", "mina"]` — for operators with multi-chain channels who want preference logic. Defer until an operator asks.

---

### Gap 8 — Idempotency on retry

**Decision: dedup via TOON event nonce + payload hash, stored in `local_delivery_nonces`. Cached response replay on exact match.**

For unmodified `strfry` (the acceptance test), there's an additional safety net: **strfry's own event-id rejection**. Nostr relays reject duplicate event IDs by NIP-01. Duplicate POSTs return 200 OK on the second attempt because the event already exists. So even if the connector's dedup misses, the relay's content-addressed storage catches it.

But we want the connector dedup as the authoritative layer because it covers non-relay nodes (DVM, mill) too.

**Schema (extends `local_delivery_nonces` from Gap 3):**
```sql
CREATE TABLE local_delivery_nonces (
  pubkey TEXT PRIMARY KEY,
  last_nonce INTEGER NOT NULL,
  last_payload_hash BLOB,
  last_response_code INTEGER,
  last_response_body BLOB,
  updated_at INTEGER NOT NULL
);
```

**Algorithm (inside the per-pubkey transaction):**
1. `BEGIN IMMEDIATE`
2. Look up `last_nonce_per_pubkey[pubkey]`
3. If `nonce == last_nonce` AND payload hash matches stored hash → return cached `(last_response_code, last_response_body)` (idempotent replay, no SettlementExecutor call)
4. If `nonce == last_nonce` AND payload hash differs → reject `F00 "nonce reused with different payload"`
5. If `nonce > last_nonce` → process, on success update all five fields (nonce, hash, response code, response body, updated_at)
6. If `nonce < last_nonce` → reject `F00 "nonce replay"`

**TTL:** prune entries where `updated_at < now() - 24h` via background job. 24 hours covers any reasonable retry window; longer is unnecessary state.

**Test:** `idempotency.spec.ts` — (a) same packet twice → both return success, second is cached read (assert no `SettlementExecutor.execute` call on second attempt); (b) same nonce different payload → F00; (c) cache pruned after 24h via fake-timer test.

**Pricing-gate ledger keyed on event id:** as a second line of defense against double-billing on retry. Same event id arriving twice settles once. Cheap; the existing TigerBeetle ledger likely supports this with a unique constraint.

---

## 2. Decisions on §2b and §2c

### Envelope migration (§2b) — confirm option (1)

Bump to v2 behind a config flag. Existing BLSes keep working through the migration. Flip default once telemetry shows >90% adoption.

**Config field:**
```json
{ "localDelivery": { "envelope": "payment-request" } }
```

Enum: `'payment-request' | 'toon-event'`. Default `'payment-request'` for v1 (back-compat). Flip to `'toon-event'` in v2.

**v2 envelope shape (exact):**
```typescript
type ToonEventEnvelope = {
  version: 2;
  event: NostrEvent;          // canonical NIP-01 event, signed
  claim: BtpClaim;            // unchanged from v1
  nonce: number;              // = parseInt(event.tags.find(t => t[0] === 'nonce')?.[1])
  pubkey: string;             // = event.pubkey
};
```

`nonce` and `pubkey` are denormalized so the connector doesn't have to parse the event before the dedup check. **They MUST equal the values inside `event`** — validator rejects mismatches with `F00 "envelope/event mismatch"`.

**Test:** `envelope.spec.ts` — round-trip both versions, mismatch detection, schema validation.

### HTTP error mapping (§2c) — confirm: keep your existing `mapRejectCode()`

You're right; the handoff's table was a sketch. Your mapper has been in production with observed behavior. We adopt yours verbatim.

**Spec language to add:** "Error mapping is defined by `packages/connector/src/core/error-mapping.ts:mapRejectCode()`. This document does not duplicate the table. Any change to the mapping is a connector PR, not a spec PR."

One source of truth. Don't fork.

---

## 3. Revised File Breakdown (Townhouse-Side Confirmation)

Confirming your §4 scope with our additions:

| File | Status | Purpose |
|---|---|---|
| `src/core/local-delivery-client.ts` | **modified** | Add pre-stages: snapshot config, sender auth check (`accept_from`), Schnorr verify, per-pubkey nonce + idempotency, pricing gate. Wrap in per-pubkey SQLite transaction. New `envelope: 'toon-event'` mode behind config flag. |
| `src/core/packet-handler.ts` | unchanged | Keeps existing call into `LocalDeliveryClient.deliver()`. |
| `src/core/connector-node.ts:280, :1096` | unchanged | Embedded handler bypass keeps current shape; `SettlementMonitor` wiring unchanged. |
| `src/core/error-mapping.ts:mapRejectCode` | unchanged | Spec references this; no fork. |
| `src/config/toon-config-provider.ts` | **new** | `fs.watch()` wrapper; `snapshot()` API for atomic config reads. |
| `src/config/toon-config-schema.ts` | **new** | zod schema for `toon.json`. Includes `node.pubkey`, `node.accept_from`, `pricing.default`, `pricing.byKind` (parsed-but-unused in v1), `localDelivery.envelope`. |
| `src/local-delivery/pricing.ts` | **new** | `computeCost(event, cfg)`, `lookupRate(kind, cfg)`. v1 returns `pricing.default` for all kinds. |
| `src/local-delivery/toon-event-verifier.ts` | **new** | Schnorr verify + nonce check, isolated for unit testing. Reuses `@noble/curves`. |
| `src/local-delivery/payment-headers.ts` | **new** | Builds `X-TOON-*` headers from packet + claim. Trivial. |
| `src/local-delivery/local-delivery-db-schema.ts` | **new** | `local_delivery_nonces` table definition (separate from `claim-receiver-db-schema.ts`). |
| `src/db/migrations/NNN-local-delivery-nonces.sql` | **new** | Migration. |
| `src/settlement/settlement-monitor.ts` | unchanged | No engine change. Add config plumbing for per-node `toon.json` thresholds via `toon-config-provider`. |
| `src/settlement/settlement-coordinator.ts` | unchanged in v1 | Optional `preferredChainOrder` plumbing in v2. |

Net: 6 new files, 1 modified file (the main one), 4 unchanged-but-touched-for-config files. Smaller delta than the original handoff implied.

---

## 4. Sequencing (Confirmed)

Per your §4 revised sequencing, with our resolutions:

1. ~~Resolve §3 gaps~~ — **done in this reply**
2. `toon-config-provider` + `toon-config-schema` + `toon-event-verifier` + `payment-headers` + `pricing` (independent, parallel)
3. `local-delivery-db-schema` + migration for per-pubkey nonce + idempotency table
4. Extend `LocalDeliveryClient` with v2 envelope and the new pre-stages, behind `localDelivery.envelope` flag
5. Acceptance test: unmodified `strfry` container + `toon.json` + zero SDK imports → end-to-end ILP PREPARE → FULFILL with real settlement crossing threshold via `SettlementMonitor`

2-3 sprints sounds right.

---

## 5. Test Strategy Acknowledgment

We're aligned on the no-mocks rule per `CLAUDE.md`. The connector codebase tests against real chain containers via `make infra-up`. New pipeline tests must run against the same.

Specifically committing to:
- Negative-path coverage per your §5 list (malformed event, invalid signature, replayed nonce, future-skip, pricing under by 1 msat, pricing exact, oversized payload)
- Concurrency: real `Promise.all` with 50 iterations, not fake timers
- Hot-reload mid-flight per Gap 1 test
- Acceptance test: unmodified `strfry` BLS, end-to-end with real settlement on at least one chain (EVM is sufficient for v1; Solana + Mina parity testing in v2)

The acceptance test should be in nightly HTTP-surface CI from sprint 1, as you proposed.

---

## 6. Open Items for Townhouse to Decide Internally (Two Minor)

These two we flag explicitly; everything else above is decided. You can scope tickets assuming these go forward as written, but Jonathan may push back.

1. **Ship `accept_from` allowlist in v1** (Gap 2) — Winston's recommendation is yes (cheap now, expensive later); the cost is ~10 lines of zod + 1 set membership check. We default this to **yes, ship in v1** unless Jonathan pushes back within the next 24 hours.

2. **Reserve `byKind` pricing schema in v1** (Gap 6) — parsed but unused in v1. Cost is schema validation only. Recommendation is **yes, reserve now** for forward-compat. Default to ship.

If either changes, we'll send a one-line addendum.

---

## 7. Confirmations Back to You

Direct answers to your §6 asks:

| Your ask | Our answer |
|---|---|
| Resolve §3 gaps | Done above |
| SDK `SettlementMonitor` situation | **None exists.** Verified by grep. SDK's `settlement/` is `buildSettlementTx()` (Story 12.6, mill-side). Your `SettlementMonitor` is canonical, no fork, no deprecation. |
| Envelope migration strategy | Option 1 (config flag, dual-mode) |
| Tiered per-kind pricing in v1 | Reserved schema, single-rate runtime. v2 flip is one line. |

---

## 8. Next Steps

You have what you need to scope tickets. We'll:
- Update the original handoff doc to reflect "extend, don't replace" and remove the stale SettlementMonitor migration plan
- Add the `accept_from` and idempotency text to the architecture spec (`toon-ilp-as-tcp-townhub-design-2026-05-01.md`)
- Wait for your ticket breakdown and delivery date estimate

If anything in this reply needs more detail or we got something wrong, push back. Better to argue now than in code review.

---

## Appendix: References

- Connector reply we're answering: `_bmad-output/planning-artifacts/research/connector-reply-ilp-as-tcp-2026-05-01.md`
- Original handoff (now superseded by this reply): `_bmad-output/planning-artifacts/research/connector-handoff-ilp-as-tcp-2026-05-01.md`
- Full architecture spec: `_bmad-output/planning-artifacts/research/toon-ilp-as-tcp-townhub-design-2026-05-01.md`
- SDK SettlementMonitor verification: `grep -rn "SettlementMonitor\|class.*Monitor" packages/sdk/src` → 0 matches confirmed 2026-05-01
