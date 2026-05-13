# Connector Team Directives: ILP-as-TCP Local Delivery Pipeline (FINAL)

**Date:** 2026-05-01
**From:** Connector team
**Re:** `townhouse-reply-to-connector-ilp-as-tcp-2026-05-01.md`
**Status:** Authoritative. Supersedes the prior round-trip on every conflict. Townhouse implements `toon.json` schema and app-side behavior; connector owns pipeline architecture.

> **Terminology update (added 2026-05-01 retroactively):** This document uses the legacy term "BLS" (Business Logic Server) throughout. As of Epic 39 / Story 39.15, that term is **deprecated** in favour of **"app"** (conceptual) or **"handler"** (technical, matching `handler_url`). The technical content of this document is unchanged; readers should mentally substitute "app" / "handler" wherever "BLS" appears. This document is preserved as the historical record of the directives round-trip with Townhouse and is not rewritten.

---

## Scope of authority

The connector owns the local-delivery pipeline, the storage schema, the lock model, the dedup behavior, and the on-the-wire envelope between connector and BLS. Townhouse owns `toon.json` semantics, BLS behavior, and the TownHub registry. Where the prior reply asserted architecture inside the connector that we disagree with, this document overrides it.

Push back **only on factual errors** in this doc (file paths, missing references, misquoted behavior). Architectural decisions are settled.

---

## 1. Overrides to the Townhouse reply

### Override 1 — Gap 4 / Gap 8: NO single transaction wrapping the HTTP POST

**Townhouse's proposal:** wrap `[nonce check + nonce write + claim apply + payload deliver attempt]` in a single `db.transaction(() => { ... })` using better-sqlite3 sync API.

**Rejected.** The driver is `better-sqlite3@^11.8.1` (`packages/connector/package.json:94`). It is **synchronous and single-writer**. `BEGIN IMMEDIATE` holds a write lock on the *entire* database file for the duration of the transaction. Holding that lock across a 30-second HTTP POST (`local-delivery-client.ts:33` `DEFAULT_TIMEOUT`) serializes every other write in the connector — every other sender's nonce check, every claim receipt, every settlement state update, every wallet audit log entry. That is not per-pubkey contention; it is global write starvation.

**Mandated design — three-phase commit:**

**Phase 1 (under lock, microseconds):**
```
BEGIN IMMEDIATE
  row = SELECT * FROM local_delivery_nonces WHERE pubkey = ?
  if event.nonce < row.last_committed_nonce:        -> REJECT F00 "nonce replay"
  if event.nonce == row.last_committed_nonce:
    if payload_hash == row.last_payload_hash:        -> return cached (Phase 3 already done)
    else:                                            -> REJECT F00 "nonce reused with different payload"
  if exists row with status='in_flight' AND nonce == event.nonce:
    if payload_hash matches:                          -> coalesce (await existing in-flight; do not duplicate POST)
    else:                                            -> REJECT F00 "nonce reused with different payload"
  INSERT/UPDATE row SET status='in_flight', nonce=event.nonce, payload_hash=?, started_at=now()
COMMIT
```

**Phase 2 (no lock):** HTTP POST to `handler_url`. Lock released.

**Phase 3 (under lock, microseconds):**
```
BEGIN IMMEDIATE
  UPDATE row SET status='committed', last_committed_nonce=?, response_status=?, response_body_hash=?, committed_at=now()
COMMIT
```

**Crash recovery:** rows with `status='in_flight' AND started_at < now() - max_in_flight_seconds` are reaped on connector restart and on lazy lookup by same pubkey. `max_in_flight_seconds` defaults to 60.

**Concurrency semantics (settled):** different nonces from the same pubkey **may** be in-flight in parallel. Same-nonce concurrency is the only thing serialized — and it serializes by coalescing onto the existing in-flight POST, not by waiting on a separate one. Strict per-pubkey delivery ordering is **not** a guarantee. Senders that need it can serialize at their end.

**File:** `packages/connector/src/local-delivery/nonce-store.ts` owns Phase 1 and Phase 3 transactions. `LocalDeliveryClient` owns Phase 2.

**Test (mandatory):** `nonce-store.concurrency.spec.ts` — fire 50 PREPAREs across 5 distinct pubkeys with mixed nonces via real `Promise.all`. Assert no test takes longer than `(slowest_individual_post + 100ms)`. If wall-clock approaches `N * post_time`, the lock model regressed and the test fails.

---

### Override 2 — Gap 8: NO unbounded response body in dedup table

**Townhouse's proposal:** `last_response_body BLOB` stored on every committed row.

**Rejected.** A DVM returning a 5MB inference result fills this row 5MB deep per sender. The dedup table becomes a content-addressed store of every successful response, which is not its job.

**Mandated schema:**
```sql
CREATE TABLE local_delivery_nonces (
  pubkey                    TEXT NOT NULL,
  last_committed_nonce      INTEGER NOT NULL DEFAULT -1,
  last_payload_hash         BLOB(32),
  last_response_status      INTEGER,        -- HTTP status code only
  last_response_body_hash   BLOB(32),       -- sha256 of response body, for verification on replay
  status                    TEXT NOT NULL CHECK (status IN ('idle','in_flight','committed')),
  in_flight_nonce           INTEGER,
  in_flight_payload_hash    BLOB(32),
  started_at                INTEGER,
  committed_at              INTEGER,
  PRIMARY KEY (pubkey)
);
```

**Idempotent replay returns:** `(last_response_status, "")` — empty body. The connector does not cache or replay the body itself. Idempotent retries get the same ILP fulfill/reject outcome they got the first time, but the data field is empty on replay. Callers that need the original body must re-issue with a fresh nonce.

**Rationale:** ILP correctness is preserved (FULFILL ↔ FULFILL, REJECT ↔ REJECT, error code preserved). What is *not* preserved is response payload echoing on retry — and that is intentional. Most BLSes are deterministic given `(nonce, payload)`, so the sender can compute it themselves; the rest are paying for non-deterministic work and re-issuing is correct.

---

### Override 3 — Gap 8: NO 24-hour TTL

**Townhouse's proposal:** prune rows where `updated_at < now() - 24h`.

**Rejected.** ILP packets carry `expiresAt`; typical values are seconds to a few minutes. A 24-hour dedup window is two-to-four orders of magnitude longer than the actual retry distribution and bloats the table for no benefit.

**Mandated TTL:** `committed_at < now() - 300 seconds` (5 minutes). Configurable via `localDelivery.dedupTtlSeconds`, default 300, valid range `[60, 3600]`. Rows with `status='in_flight' AND started_at < now() - max_in_flight_seconds` are reaped independently regardless of `dedupTtlSeconds`.

**Pruner:** runs every 60 seconds via `setInterval` on the connector's existing scheduler. No new scheduling primitive.

**Test:** `nonce-store.ttl.spec.ts` — fake-timer test asserts row pruned after `dedupTtlSeconds` and not before.

---

### Override 4 — Gap 6: NO parsed-but-unused `byKind`

**Townhouse's proposal:** parse `byKind` in v1 schema but always return `default` from `lookupRate`.

**Rejected.** Parsed-but-ignored fields rot. Operators set `byKind` rates in v1 production deployments, observe that pricing matches `default`, file bug reports three releases later when v2 finally implements the lookup and rates change.

**Mandated for v1:** `byKind` is **not in the v1 schema**. The zod schema rejects unknown top-level fields under `pricing` with a clear error pointing to single-rate-only-in-v1. v2 adds `byKind` to the schema **and** the lookup in the same release.

**Schema (v1, exact):**
```typescript
const PricingV1 = z.object({
  default: z.object({
    rate_msats_per_kb: z.string().regex(/^\d+$/),  // bigint-as-string
    minimum_msats: z.string().regex(/^\d+$/).default("0"),
  }),
}).strict();  // <- rejects unknown fields
```

**Migration to v2:** add `byKind: z.record(...).optional()` and the one-line lookup in the same PR. v1 configs remain valid (no `byKind` key). v2 configs with `byKind` fail v1 validators — desired behavior; operators upgrade connector before authoring v2 configs.

---

### Override 5 — Gap 5: pricing unit is the **transmitted event JSON**, not the id preimage

**Townhouse's proposal:** `payload_bytes = Buffer.byteLength(canonicalize(event), 'utf8')` where `canonicalize` is the NIP-01 serialization `[0, pubkey, created_at, kind, tags, content]`.

**Clarification, not rejection:** that string is the NIP-01 **id preimage**, not the event. The event the connector actually relays to the BLS includes `id` and `sig` (~136 additional bytes). Pricing-on-id-preimage means the connector charges for ~136 bytes less than it transports.

**Mandated:** `payload_bytes = Buffer.byteLength(JSON.stringify(canonicalEventObject), 'utf8')` where `canonicalEventObject` has fields ordered `id, pubkey, created_at, kind, tags, content, sig` and uses `JSON.stringify` with no whitespace. This matches what the connector POSTs to the BLS, byte-for-byte.

**Spec text (mandated verbatim):** "The pricing unit `payload_bytes` is the UTF-8 byte length of `JSON.stringify(event)` where `event` is the canonical-key-order Nostr event object as transmitted to the BLS, with no whitespace. Senders MUST compute this value identically to verify rate quotes before payment. Connectors MUST verify this value byte-exactly during pricing gate evaluation."

**Test:** `pricing.spec.ts` — assert byte count exceeds id preimage byte count by `sig.length + id.length + JSON-overhead-for-two-fields` for any non-empty event.

---

### Override 6 — §2c: error-mapping path is wrong

**Townhouse's spec language:** "Error mapping is defined by `packages/connector/src/core/error-mapping.ts:mapRejectCode()`."

**That file does not exist.** `mapRejectCode` lives in `packages/connector/src/core/payment-handler.ts` (imported in `local-delivery-client.ts:23`). Use the correct path. The principle stands — single source of truth, no fork — but cite real code.

**Mandated spec text:** "Error mapping is defined by `packages/connector/src/core/payment-handler.ts:mapRejectCode()`. This document does not duplicate the table. Any change to the mapping is a connector PR, not a spec PR."

---

### Override 7 — Gap 7: settlement chain is correct as architecture, needs operator-doc note

**Townhouse's proposal:** strike `settlement.chain` from `toon.json`, infer from channel via `SettlementCoordinator`.

**Accepted as architecture.** Verified `packages/connector/src/settlement/settlement-coordinator.ts` exists. Chain is determined by which channel the sender opened; `toon.json` does not need to declare it.

**Added requirement:** the connector exposes a `/admin/api/nodes/:pubkey/channels` endpoint that returns the current set of channels (and therefore chains) settling against this node, so operators can answer "which chain does my node settle on?" without reading channel-open events. Townhouse references this endpoint in operator docs. Implementation is a thin read on `SettlementCoordinator` state.

---

## 2. Confirmed decisions (accepted from the Townhouse reply verbatim)

These the prior reply got right; they are the v1 spec:

- **Gap 1 — `toon.json` snapshot at packet entry.** Frozen config object passed through the pipeline. New file `packages/connector/src/config/toon-config-provider.ts` with `snapshot(): Readonly<ToonConfig>`. ✅
- **Gap 2 — `accept_from` allowlist ships in v1.** `pubkey` is node identity; `accept_from` is sender authorization. Absent/empty → open. Present → enforced before pricing gate. ✅
- **Gap 3 — Two independent nonces, no cross-layer reconciliation.** BTP claim nonce stays with `ClaimReceiver`. TOON event nonce in the new `local_delivery_nonces` table (per Override 1 schema). ✅
- **§2b — v2 envelope behind `localDelivery.envelope` config flag.** Default `'payment-request'` for back-compat; flip to `'toon-event'` once telemetry shows >90% adoption. v2 envelope shape is as Townhouse specified, including denormalized `nonce` and `pubkey` with mismatch validation. ✅
- **SDK `SettlementMonitor`** — confirmed nonexistent (Townhouse's grep verified). No migration, no deprecation. Connector's `SettlementMonitor` is canonical. ✅
- **No new crypto dep** — `@noble/curves@^1.9.0` (`packages/connector/package.json:88`) is reused. ✅

---

## 3. Final file breakdown

| File | Status | Owner | Notes |
|---|---|---|---|
| `src/core/local-delivery-client.ts` | modified | connector | Add pre-stages: snapshot, `accept_from` check, Schnorr verify, dedup-aware nonce check (delegated to `nonce-store.ts`), pricing gate. New `envelope: 'toon-event'` mode behind config flag. |
| `src/core/packet-handler.ts` | unchanged | connector | Continues to call `LocalDeliveryClient.deliver()`. |
| `src/core/payment-handler.ts` | unchanged | connector | `mapRejectCode` stays the single source of truth for HTTP→ILP mapping. |
| `src/local-delivery/nonce-store.ts` | new | connector | Phase 1 + Phase 3 transactions. Owns `local_delivery_nonces`. |
| `src/local-delivery/nonce-store-pruner.ts` | new | connector | 60-second sweep for in-flight reap + dedup TTL. |
| `src/local-delivery/pricing.ts` | new | connector | `computeCost(event, cfg)`. v1 returns `default` rate for all kinds. |
| `src/local-delivery/toon-event-verifier.ts` | new | connector | Schnorr verify only; nonce work is `nonce-store.ts`. Reuses `@noble/curves`. |
| `src/local-delivery/payment-headers.ts` | new | connector | Builds `X-TOON-*` headers. |
| `src/config/toon-config-provider.ts` | new | connector | `fs.watch` wrapper, `snapshot()` API. |
| `src/config/toon-config-schema.ts` | new | connector | Strict zod schema. v1 rejects unknown fields under `pricing`. No `byKind` until v2. |
| `src/db/schema/local-delivery-nonces.sql` | new | connector | Migration per Override 2 schema. |
| `src/admin/nodes-api.ts` | modified | connector | Add `GET /admin/api/nodes/:pubkey/channels` per Override 7. |
| `toon.json` schema reference | n/a | Townhouse | Document the v1 schema for node operators. Match `toon-config-schema.ts` exactly. |
| BLS reference impl | n/a | Townhouse | Write the strfry adapter that reads the v2 envelope. |

Net connector delta: 8 new files, 2 modified.

---

## 4. Test directives (mandatory before merge)

Per `CLAUDE.md`: no mocks; tests run against real chain containers (`make infra-up`).

| Test | Asserts |
|---|---|
| `nonce-store.concurrency.spec.ts` | 50 PREPAREs across 5 pubkeys complete in `~slowest_post_time + 100ms`. Lock model regression test. |
| `nonce-store.replay.spec.ts` | Exact-replay returns cached `(status, empty body)`. Different-payload-same-nonce → F00. |
| `nonce-store.ttl.spec.ts` | Row pruned after `dedupTtlSeconds`, in-flight reaped after `max_in_flight_seconds`. |
| `nonce-store.crash-recovery.spec.ts` | In-flight rows past deadline cleaned on restart and on lazy lookup. |
| `local-delivery-client.hot-reload.spec.ts` | Mid-flight rate change uses the entry-time snapshot. |
| `local-delivery-client.auth.spec.ts` | `accept_from` absent/empty/present-allow/present-deny. |
| `pricing.spec.ts` | Byte count = full event JSON, not id preimage. Multibyte UTF-8 counts bytes not codepoints. |
| `envelope.spec.ts` | v1 round-trips `payment-request`. v2 round-trips `toon-event`. Mismatch between envelope `nonce`/`pubkey` and `event.nonce`/`event.pubkey` → F00. |
| `acceptance.strfry.spec.ts` | Unmodified strfry container + `toon.json` + zero SDK imports → end-to-end ILP PREPARE → FULFILL with EVM settlement crossing threshold via `SettlementMonitor`. **Goes into nightly HTTP-surface CI from sprint 1.** |

The acceptance test is the redesign's only meaningful pass/fail gate. If unmodified strfry doesn't work, nothing else matters.

---

## 5. Sequencing

1. Schema + migration: `local-delivery-nonces.sql`, `toon-config-schema.ts`. Land first; everything else depends on the storage shape and the config types.
2. Parallel: `nonce-store.ts`, `pricing.ts`, `toon-event-verifier.ts`, `payment-headers.ts`, `toon-config-provider.ts`. Independent unit-tested modules.
3. `nonce-store-pruner.ts` plus crash-recovery test.
4. Wire into `local-delivery-client.ts` behind `envelope: 'toon-event'` flag. v1 envelope still default.
5. Acceptance test with unmodified strfry. Nightly CI from this sprint forward.
6. Townhouse: ship reference BLS that consumes v2 envelope. Operator docs covering Override 7 channel-introspection endpoint.

Estimate: 2-3 connector sprints. Townhouse work parallel from sprint 2.

---

## 6. Townhouse action items

- Confirm `toon.json` v1 schema matches `toon-config-schema.ts` exactly. Single source of truth is the connector's schema file; Townhouse docs reference it.
- Implement reference BLS that reads the v2 envelope (`{ version: 2, event, claim, nonce, pubkey }`) — strfry adapter is the canonical example.
- Operator docs: include the `/admin/api/nodes/:pubkey/channels` endpoint as the answer to "which chain does my node settle on?" (Override 7).
- Drop `byKind` from any forward-looking spec language until v2. v1 mentions of `byKind` will fail validation.
- Drop `last_response_body` from any spec language — connector returns empty body on replay (Override 2).

---

## 7. What does NOT change

Stated for emphasis:

- ILP routing, BTP peer protocol, claim validation, multi-chain settlement, connector admin API — all unchanged.
- `SettlementMonitor` — unchanged engine. Only config plumbing for per-node thresholds via `toon-config-provider`.
- `mapRejectCode` — unchanged. HTTP-to-ILP mapping is whatever `payment-handler.ts` does today.
- Embedded handler bypass (`setPacketHandler()` at `connector-node.ts:280`) — gets the same pre-stages as the HTTP path. The pipeline is the contract, not the transport.

---

## 8. Disagreements / pushback window

If Townhouse believes any override is factually wrong (file path, missing dep, misquoted code behavior), reply within 48 hours with the specific citation. Architectural disagreements are out of scope; this is the spec.

If silence past 48 hours, this document is the implementation contract.

---

## Appendix: file references

- `packages/connector/src/core/local-delivery-client.ts` — extension point
- `packages/connector/src/core/local-delivery-client.ts:23` — existing import of `mapRejectCode`
- `packages/connector/src/core/local-delivery-client.ts:33` — `DEFAULT_TIMEOUT = 30000` (the 30 seconds the bad lock would have spanned)
- `packages/connector/src/core/payment-handler.ts` — `mapRejectCode` lives here, not `error-mapping.ts`
- `packages/connector/src/core/packet-handler.ts:30, :133, :262` — orchestration
- `packages/connector/src/core/connector-node.ts:280, :1096` — embedded handler + SettlementMonitor wiring
- `packages/connector/src/settlement/settlement-monitor.ts` — canonical home; SDK has none
- `packages/connector/src/settlement/settlement-coordinator.ts` — chain inference for Override 7
- `packages/connector/src/settlement/claim-receiver.ts:548, :734, :899` — existing BTP nonce monotonicity (separate from TOON event nonce)
- `packages/connector/src/settlement/privacy/nip59-claim-wrapper.ts:23` — existing `secp256k1` import path for Schnorr verify
- `packages/connector/package.json:88` — `@noble/curves@^1.9.0`
- `packages/connector/package.json:94` — `better-sqlite3@^11.8.1` (the sync, single-writer driver)
