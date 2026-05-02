---
stepsCompleted: [1, 2, 3, 4, 5, 6]
inputDocuments:
  - epic-39-toon-local-delivery-pipeline.md
  - research/connector-directives-ilp-as-tcp-2026-05-01.md
workflowType: 'test-design'
research_topic: 'Test design for Epic 39 — TOON Local Delivery Pipeline'
date: '2026-05-01'
---

# Test Design: Epic 39 — TOON Local Delivery Pipeline

**Date:** 2026-05-01
**Author:** Jonathan (with BMAD multi-agent roundtable)
**Status:** Draft
**Source epic:** `epic-39-toon-local-delivery-pipeline.md`
**Authoritative spec:** `connector-directives-ilp-as-tcp-2026-05-01.md`

---

## Executive Summary

Epic 39 implements the connector-directives spec. The test surface is dominated by two correctness landmines flagged in the directives: (1) the SQLite write-lock-across-HTTP failure mode (resolved by three-phase commit; must be guarded by a wall-clock test), and (2) per-pubkey nonce concurrency (resolved by Phase 1 transactions; must be guarded by a real-Promise.all test). Beyond those, the surface is large but mechanical: schema, hot-reload, idempotency, pricing arithmetic, accept_from authorization, terminology cleanup, and the binary acceptance test.

The single binary acceptance test (Story 39.12: unmodified strfry as an app, end-to-end ILP PREPARE → FULFILL with EVM settlement) is the load-bearing test. Every other test exists to prevent regressions in pieces that test rolls up. Per `CLAUDE.md`: no mocks; tests run against real chain containers.

---

## 1. Key Risks and Mitigating Tests

### Risk Matrix

| Risk ID | Risk | Likelihood | Severity | Mitigating tests |
|---|---|---|---|---|
| R-01 | SQLite global write lock starvation under load (single-transaction wrapping HTTP) | Medium without three-phase | Catastrophic | Story 39.5 + 39.13 wall-clock concurrency test |
| R-02 | Per-pubkey nonce race: legitimate retry of N rejected because N+1 landed first | Medium | High | Story 39.13 concurrent.spec.ts with Promise.all |
| R-03 | Hot-reload race: rate change mid-flight changes outcome of in-flight packet | Medium | High | Story 39.13 hot-reload.spec.ts; entry-time snapshot enforcement |
| R-04 | Idempotent replay returns full body causing data leak across retries | Low (default empty body) | High | Story 39.13 replay.spec.ts asserts empty body |
| R-05 | Schnorr verify accepts malformed event due to permissive parser | Low | High | Story 39.4 negative-path matrix |
| R-06 | Pricing computed on id-preimage instead of full event JSON | High (was almost shipped) | Medium | Story 39.7 byte-count assertion test |
| R-07 | `accept_from` allowlist bypassed via case-sensitivity / whitespace | Low | High | Story 39.10 auth.spec.ts edge cases |
| R-08 | v2 envelope mismatch (denormalised nonce/pubkey) accepted silently | Low | High | Story 39.9 envelope-validation test |
| R-09 | In-flight rows orphaned forever after connector crash | Medium | Medium | Story 39.13 crash-recovery.spec.ts |
| R-10 | TTL pruner deletes still-needed rows under clock skew | Low | Low | Story 39.6 TTL test with virtual clock |
| R-11 | strict zod schema accepts unknown fields silently (regression to parsed-but-unused) | Medium during dev | Medium | Story 39.2 strict-mode test |
| R-12 | BLS terminology rename breaks API contract for downstream consumers | Low | High | Story 39.15 — package names NOT renamed (out of scope per spec); only prose / comments / non-API identifiers |

### Risk Detail: Top 5

**R-01 (SQLite write-lock starvation).** Directives Override 1 mandates three-phase commit explicitly because the obvious single-transaction wrapping holds the SQLite write lock during the HTTP POST (~30s default timeout). Under load, this serializes every other write in the connector. The mitigating test (`nonce-store.concurrency.spec.ts`) measures wall-clock time across 50 concurrent PREPAREs from 5 distinct pubkeys; if total runtime approaches `50 × post_time` instead of `~slowest_post_time + 100ms`, the lock model regressed to global. This is a wall-clock test, which is normally flake-prone; in this case the flake mode IS the regression. Run 50 iterations to flush noise.

**R-02 (Nonce race).** Two PREPAREs from the same pubkey with consecutive nonces N and N+1 arriving microseconds apart. If N+1's Phase 1 transaction commits first, the legitimate retry of N is rejected. Resolution per directives: different nonces from the same pubkey may be in-flight in parallel; same-nonce concurrency coalesces onto the existing in-flight POST. Test: 10 concurrent PREPAREs with mixed nonces `[5,5,5,6,6,7,7,7,7,8]` from same pubkey via real `Promise.all`; assert exactly one accept per distinct nonce; same-nonce duplicates coalesce to one POST.

**R-03 (Hot-reload race).** Operator changes pricing rate from 1 msat/KB to 100 msat/KB while a PREPARE is mid-flight. The in-flight packet must be priced against the rate at packet-entry time, not the new rate. Resolution: `toon-config-provider.snapshot()` returns a frozen snapshot at PREPARE entry; pipeline reads from snapshot only. Test injects a mid-flight rate change between Phase 1 and Phase 2; asserts in-flight packet uses old rate; next packet uses new rate.

**R-06 (Pricing unit drift).** Townhouse's reply originally proposed `payload_bytes = canonicalize(NIP-01 id preimage)` which is ~136 bytes shorter than the full event JSON the connector actually transmits. Directives Override 5 mandates full event JSON byte length. Test: empty event payload → minimum applied; 1024-byte content × rate 1000 → exactly 1_000_000 msats; multibyte UTF-8 (emoji-laden content) counts bytes not codepoints; assert byte count exceeds id-preimage byte count by `len(sig) + len(id) + JSON-overhead`.

**R-09 (Crash recovery).** Connector crashes between Phase 1 (in_flight row inserted) and Phase 3 (committed). On restart, the in_flight row is older than `max_in_flight_seconds` and must be reaped. If the same pubkey then sends nonce N+1, Phase 1 must clear the orphaned in_flight row first or the new PREPARE rejects. Test: insert in_flight row with `started_at = now - max_in_flight_seconds - 5`; restart connector; assert sweeper clears it; subsequent PREPARE from same pubkey succeeds.

---

## 2. Test Strategy Per Story

### Story 39.1: Migration + schema

**Test type:** Migration unit test.
**Coverage:**
- Migration runs cleanly on fresh DB.
- Migration runs cleanly on DB that already contains other tables (existing claim-receiver schema).
- Down-migration drops table cleanly; re-running up-migration succeeds.
- Indexes created: query plan for `WHERE status = 'in_flight' AND started_at < ?` uses the index.

### Story 39.2: zod schema

**Test type:** Unit.
**Coverage:**
- Valid v1 `toon.json` → parses.
- Missing required field → fails with specific path.
- `byKind` field present → fails with clear error pointing to v2-only.
- Other unknown fields under `pricing` → fail.
- Bigint-as-string regex enforced (rejects scientific notation, decimals, negatives).
- `accept_from` empty array vs absent vs populated — all valid; semantics differ.

### Story 39.3: toon-config-provider

**Test type:** Integration with real fs.watch.
**Coverage:**
- `provider.snapshot()` returns frozen object (any mutation throws).
- File change → reload triggers; new snapshot reflects change.
- Invalid file content on reload → rejected; prior valid config retained; alert metric fires.
- Multiple nodes (multiple toon.json paths) tracked independently.
- fs.watch fallback to polling on platforms where fs.watch is unreliable (test runs on Linux + macOS; documents Windows fallback).

### Story 39.4: toon-event-verifier

**Test type:** Unit (pure function, no I/O).
**Coverage:**
- Valid event → ok.
- Wrong signature → `bad_signature`.
- Mismatched id (event.id != computed sha256 of canonical preimage) → `id_mismatch`.
- Wrong pubkey (signature valid for different key) → `bad_signature` or `pubkey_mismatch`.
- Malformed event (missing fields, wrong types) → `malformed_event`.
- Reuses `secp256k1.schnorr` from `@noble/curves` (verified by import path test).

### Story 39.5: nonce-store three-phase commit

**Test type:** Integration with real better-sqlite3.
**Coverage:**
- Phase 1 reserve: new pubkey → row inserted with `status='in_flight'`, `in_flight_nonce`, `in_flight_payload_hash`, `started_at`.
- Phase 1 reserve: existing pubkey, new nonce > last_committed → reservation succeeds.
- Phase 1 reserve: nonce < last_committed → `reject` outcome.
- Phase 1 reserve: nonce == last_committed, payload_hash matches → `cached` outcome with cached response.
- Phase 1 reserve: nonce == last_committed, payload_hash differs → `reject`.
- Phase 1 reserve: same nonce already in_flight, payload_hash matches → coalesce (return promise that resolves when existing in-flight commits).
- Phase 3 commit: updates row to `status='committed'`, advances `last_committed_nonce`, sets `last_response_status` and `last_response_body_hash`.
- Phase 1 + Phase 3 are SHORT (assert with virtual clock that each transaction completes in <10ms wall-clock).

### Story 39.6: nonce-store-pruner

**Test type:** Integration with virtual clock + real better-sqlite3.
**Coverage:**
- Sweep every 60s on the connector's existing scheduler.
- Reaps `status='in_flight' AND started_at < now - max_in_flight_seconds`.
- Prunes `committed_at < now - dedupTtlSeconds`.
- Lazy reap on lookup: stale in_flight cleared in Phase 1 of subsequent same-pubkey reservation.
- Crash recovery: connector restart triggers immediate sweep before serving traffic.

### Story 39.7: pricing.computeCost

**Test type:** Unit (pure).
**Coverage (table-driven):**

| Event byte length | Rate | Min | Expected cost |
|---|---|---|---|
| 0 (empty event after JSON.stringify) | any | 100 | 100 |
| 512 | 1000 msats/KB | 0 | 1000 (ceil(512/1024) = 1) |
| 1024 | 1000 | 0 | 1000 |
| 1025 | 1000 | 0 | 2000 |
| 4096 | 500 | 100 | 2000 (4 KB * 500) |
| Multibyte UTF-8 ("hello 🌍" = 11 bytes) | 1000 | 0 | 1000 (ceil(11/1024) = 1) |
| Long emoji string (1024 emoji × 4 bytes = 4096) | 1000 | 0 | 4000 |

Plus: byte count of `JSON.stringify(canonicalEvent)` strictly exceeds byte count of NIP-01 id-preimage (R-06 regression guard).

### Story 39.8: payment-headers

**Test type:** Unit (pure).
**Coverage:**
- All five headers built correctly from packet + claim.
- ASCII-only (no encoding issues for non-ASCII pubkey hex — pubkeys are always hex so this is trivially true).
- Nonce as decimal string; pubkey as hex (no 0x prefix).

### Story 39.9: v2 envelope mode

**Test type:** Integration with reference app stub.
**Coverage:**
- `envelope: 'payment-request'` → existing v1 PaymentRequest body emitted.
- `envelope: 'toon-event'` → v2 envelope `{ version: 2, event, claim, nonce, pubkey }` emitted.
- v2 envelope: denormalised `nonce` MUST equal `event.nonce` (extracted from event tags); mismatch → reject pre-POST.
- v2 envelope: denormalised `pubkey` MUST equal `event.pubkey`; mismatch → reject.

### Story 39.10: Pre-stages wired into LocalDeliveryClient

**Test type:** Integration (real connector + reference app stub).
**Coverage:**
- Pipeline order: snapshot → accept_from → Schnorr verify → Phase 1 → pricing → Phase 2 → Phase 3 → response mapping.
- Each stage's failure short-circuits with correct ILP error code (F00, F04, F99 per directives Override 6).
- Embedded handler bypass (`setPacketHandler`) wraps the same pre-stages.
- HTTP error mapping via `payment-handler.ts:mapRejectCode` (NOT `error-mapping.ts` — directives Override 6 path correction).
- accept_from edge cases: case sensitivity (pubkeys lowercase hex; mixed-case rejected), whitespace, empty array (open mode), populated.

### Story 39.11: Admin API channels endpoint

**Test type:** Integration with real settlement coordinator.
**Coverage:**
- `GET /admin/api/nodes/:pubkey/channels` returns channel set.
- 404 on unknown pubkey (matches Epic 37 contract).
- Channel data includes chain, channelId, status, balance, lastSettlementAt.
- Auth: `X-Api-Key` (or RFC 9421 once Epic 38 lands; test path covers both).

### Story 39.12: acceptance.strfry.spec.ts (load-bearing test)

**Test type:** Full-stack acceptance (real strfry, real Anvil, real connector).
**Coverage:**
- Boots `strfry/strfry:latest` container with no patches; mounts `toon.json` via volume.
- Connector configured with `localDelivery.envelope: 'toon-event'`; routes to strfry.
- Sends ILP PREPARE from second connector with signed Nostr event (kind 1).
- Asserts: connector verifies Schnorr, prices, dedups, delivers; strfry returns 200; connector returns ILP FULFILL.
- Asserts: strfry stored the event (queryable via REQ subscription).
- Asserts: claim threshold crosses; SettlementMonitor fires; `claimFromChannel()` succeeds against Anvil; balances reconcile.
- **Asserts: zero SDK imports** in strfry container (verified via static analysis of container image).
- Test runs in nightly HTTP-surface CI; stop-the-line policy applies.

### Story 39.13: Concurrency / hot-reload / idempotency / crash-recovery

Already detailed in R-01 through R-10 above. Six dedicated test files; each with the named ACs from the epic.

### Story 39.14: Operator docs

**Test type:** Documentation review + external dry-run.
**Coverage:**
- `docs/operators/toon-local-delivery.md` covers full lifecycle.
- `docs/operators/toon-json-reference.md` matches `toon-config-schema.ts` exactly (single source of truth — automated check via JSON Schema export comparison).
- Envelope migration guide validates against Epic 43 Story 43.4 unified playbook.
- External dry-run: at least one operator (not on the team) follows docs cold, deploys a working node.

### Story 39.15: Terminology rename

**Test type:** CI lint + manual review.
**Coverage:**
- `rg -i "\bBLS\b" packages/connector/src docs CLAUDE.md` returns only allowlisted historical/deprecation contexts.
- CI lint fails new PRs that introduce `BLS` outside allowlist.
- Existing public API package names NOT renamed (out of scope per epic).
- Code identifiers renamed where non-breaking; load-bearing public API surface preserved.

### Story 39.16: v1↔v2 mixed-bilateral test

**Test type:** Integration with two connectors + two app variants.
**Coverage:**
- Connector A on `'toon-event'` → app B supporting v1 only → reject with documented error code.
- Connector A on `'payment-request'` → app B supporting v2 only → reject with documented error code.
- Both v2 → succeed.
- Both v1 → succeed (existing baseline; regression guard).
- Migration counter `connector.migration.flag.localDelivery_envelope.{accept,reject,error}` incremented per Epic 43 Story 43.1.

---

## 3. Cross-Story Integration Tests

| Test | Asserts | Stories covered |
|---|---|---|
| `acceptance.strfry.spec.ts` | The single binary acceptance test (R-01 through R-09 covered indirectly). | 39.12 (umbrella) |
| `pipeline-order.spec.ts` | Pre-stages execute in mandated order; failures at each stage short-circuit correctly. | 39.10, 39.4, 39.5, 39.7 |
| `embedded-bypass.spec.ts` | `setPacketHandler` path applies same pre-stages as HTTP path. | 39.10 |
| `concurrency-suite.spec.ts` | Concurrency, hot-reload, replay, crash-recovery in one umbrella test file. | 39.13 |

---

## 4. Regression Analysis

| Existing surface | Regression risk | Mitigation |
|---|---|---|
| Existing `LocalDeliveryClient.deliver()` v1 path | Medium (modified file) | v1 path retained; existing tests stay green; new tests added alongside |
| Existing `ClaimReceiver` BTP nonce monotonicity | None (orthogonal) | BTP nonce store untouched; new TOON event nonce store is separate table |
| Existing `payment-handler.ts:mapRejectCode` | None (consumed unchanged) | Existing error-mapping tests stay green; new pipeline consumes existing function |
| Existing TigerBeetle ledger | None (orthogonal) | New SQLite table only; TigerBeetle untouched |
| Embedded mode (`setPacketHandler`) | Medium during pipeline wire | Story 39.10 explicitly tests embedded path with new pre-stages |

### Regression Test Matrix

- All existing Epic 32–38 test suites stay green (no edits to their fixtures).
- Coverage threshold: no decrease in line/branch coverage on any pre-existing module touched by this epic.
- Acceptance test runs nightly; alert + stop-the-line on red.

---

## 5. Test Data Requirements

- Real Nostr event fixtures (signed by test keys).
- `toon.json` test fixtures: minimal v1 schema; with/without accept_from; various pricing combinations.
- strfry/strfry container (Docker image; pinned tag).
- Anvil EVM container (existing in `make infra-up`).
- Multiple test pubkeys (sender / app / unauthorized sender for accept_from negative).
- RFC 8785 JCS test vectors (already required by Epic 38; reused).

---

## 6. Test Environment and Infrastructure

### Dependencies (Test-Only)

- strfry container (new in `docker-compose.test.yml`).
- `@noble/curves` v2.x: already a runtime dep.
- better-sqlite3 v11.x: already a runtime dep.

### CI Pipeline Integration

- New nightly target: `acceptance-strfry` runs Story 39.12 against real strfry + Anvil; ~5 minutes wall-clock.
- New unit target: `npm run test:local-delivery` runs Stories 39.4, 39.5 (with real SQLite), 39.7, 39.8 in <60s.
- New integration target: `npm run test:local-delivery-integration` requires `make infra-up`; runs Stories 39.9–39.13 in <10 minutes.

### Coverage Thresholds

- `packages/connector/src/local-delivery/**/*.ts`: line ≥ 95%, branch ≥ 90%.
- `packages/connector/src/config/toon-config-*.ts`: line ≥ 95%, branch ≥ 90%.
- `packages/connector/src/core/local-delivery-client.ts` (modified): branch coverage on new pre-stages ≥ 90%.

---

## 7. Test Execution Order

### Recommended Implementation Order

1. **Schema + config:** Stories 39.1, 39.2, 39.3. Foundational; everything reads from these.
2. **Pure modules:** Stories 39.4, 39.7, 39.8. Independent, fully unit-testable.
3. **Storage:** Stories 39.5, 39.6. Real SQLite; concurrency tests guard correctness.
4. **Wiring:** Stories 39.9, 39.10. Compose modules into the pipeline; embedded path covered.
5. **Surface:** Story 39.11 (admin endpoint). Independent; can run in parallel with earlier work.
6. **Acceptance:** Story 39.12. Last; validates the whole epic.
7. **Concurrency suite:** Story 39.13. After 39.10; guards against regressions in the pipeline.
8. **Docs + rename + cross-version:** Stories 39.14, 39.15, 39.16. Run in parallel near the end.

### Test Dependency Graph

```
39.1 (schema) ──┐
39.2 (zod)    ──┼─→ 39.3 (config provider) ──┐
                                              │
39.4 (verifier) ─────────────────────┐        │
39.7 (pricing)  ─────────────────────┤        │
39.8 (headers)  ─────────────────────┤        │
                                     │        │
39.5 (nonce store) ────→ 39.6 (pruner)        │
                                     │        │
                                     ▼        ▼
                              39.9 (envelope) → 39.10 (wire pipeline)
                                                       │
                                                       ▼
                                            39.11 (admin), 39.13 (concurrency)
                                                       │
                                                       ▼
                                              39.12 (acceptance)
                                                       │
                                                       ▼
                                       39.14 (docs), 39.15 (rename), 39.16 (mixed-bilateral)
```

---

## 8. Security Test Focus Areas

### Schnorr Verify Negative Path

- Forged event with valid-looking but wrong signature → reject `bad_signature`.
- Replayed signature on different event content → reject `id_mismatch` (id won't match).
- Event missing required NIP-01 fields → reject `malformed_event`.
- Event with extraneous fields → accept (NIP-01 permits extension); but signature verifies.

### Pricing Bypass Attempts

- Underpaid by 1 msat → reject F04.
- Exactly minimum → accept.
- Tiny event with low rate but high minimum → minimum applied.
- Massive event with low rate → cost computed; reject if amount insufficient.

### accept_from Bypass Attempts

- Mixed-case pubkey in allowlist → comparison normalized to lowercase hex (operator MUST normalize on write; runtime comparison is case-sensitive).
- Whitespace-padded entries → fail validation at zod level (Story 39.2).
- Empty allowlist (`accept_from: []`) → treated as open per spec, NOT closed.

### Idempotent Replay Body Leak

- First request returns response body B (non-empty).
- Idempotent replay of same nonce → response body MUST be empty (directives Override 2).
- Different payload, same nonce → reject; no body leak.

### Crash-Window State Audit

- Crash between Phase 1 and Phase 2 → row in_flight; eventually reaped.
- Crash between Phase 2 (HTTP succeeded) and Phase 3 → row still in_flight; reaped; idempotent retry succeeds via app's own dedup or via TOON's nonce check (whichever fires first).
- Crash after Phase 3 commit → row committed; no impact.

---

## 9. Open Questions for Testing

1. **What's the right stress level for `nonce-store.concurrency.spec.ts`?** Currently spec'd as 50 PREPAREs; production traffic may sustain 5000/s. Recommend: parametrize the test; nightly runs 50; weekly runs 5000.
2. **Should the acceptance test cover Solana + Mina settlement, or is EVM-only sufficient for v1?** Per Epic 42 Story 42.3 — EVM is sufficient for v1 sign-off; Solana + Mina parity tests run weekly. Inherits that decision.
3. **How do we test `fs.watch` on platforms where it's unreliable (Windows)?** Recommend: polling fallback path tested in CI; document Windows operators get polling not fs.watch.
4. **External-dry-run for Story 39.14 docs validation** — who recruits the external operator? Recommend: include in Townhouse coordination playbook.
