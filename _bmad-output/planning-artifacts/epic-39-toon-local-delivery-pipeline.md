# Epic 39: TOON Local Delivery Pipeline

**Date:** 2026-05-01
**Author:** Jonathan (with BMAD multi-agent roundtable)
**Status:** Draft
**Dependencies:** None hard-blocking. Composes with Epic 38 (v2 envelope ships under RFC 9421). Soft dep on Epic 40 (passkey-derived Nostr key for Schnorr verify).
**Type:** Greenfield + brownfield extension
**North-star tier served:** T1 (mechanical) — the directives doc materialised
**Spec source:** `connector-directives-ilp-as-tcp-2026-05-01.md` (authoritative; this epic implements it)

---

## Executive Summary

Implement the `connector-directives-ilp-as-tcp-2026-05-01.md` spec as code. Move Schnorr verify, per-pubkey nonce monotonicity, idempotency, and pricing enforcement into the connector's existing `LocalDeliveryClient`. The result: any HTTP service plus a `toon.json` becomes a paid TOON node. The acceptance test — unmodified `strfry` storing Nostr events via ILP with zero SDK imports — is the single binary indicator that this epic shipped.

### Why now

The spec is settled (round-trip with Townhouse closed; directives doc is authoritative). What's needed is execution.

### What's being built

- New `local_delivery_nonces` SQLite table for per-pubkey monotonicity + idempotent replay.
- `toon-config-provider` with `fs.watch` + atomic `snapshot()` API (resolves directives Gap 1).
- Strict zod schema for `toon.json` (no parsed-but-unused fields per directives Override 4).
- TOON event verifier (Schnorr verify, isolated for unit testing; reuses `@noble/curves`).
- Three-phase commit nonce store (Phase 1 reserve under lock → Phase 2 HTTP off-lock → Phase 3 commit under lock; resolves directives Override 1).
- Pricing module (full event JSON byte length per directives Override 5; single-rate v1).
- `LocalDeliveryClient` extension with `accept_from` allowlist, dedup-aware nonce check, pricing gate, and `envelope: 'toon-event'` mode behind config flag.
- Embedded handler bypass (`setPacketHandler`) gets the same pre-stages — pipeline is the contract regardless of transport.
- Admin API extension: `GET /admin/api/nodes/:pubkey/channels` for chain inference (resolves directives Override 7).

### What's NOT being built

- v1→v2 envelope auto-migration; v1 stays default until telemetry ≥ 90% v2 adoption.
- `byKind` tiered pricing (reserved for v2 per directives Override 4).
- Reference app implementation (Townhouse owns).
- RFC 9421 signing of the v2 envelope (Epic 38 owns).

### Terminology note

This epic deprecates the legacy term **"BLS"** (Business Logic Server) in favour of **"app"** / **"handler"** — see Story 39.15. New prose in this doc uses the new terms. References to "BLS" remain in upstream artifacts (the directives doc, the original handoff) as historical record; future docs adopt the new terms.

---

## Architecture

### Pipeline (three-phase commit)

```
ILP PREPARE arrives
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ Phase 1 (under SQLite lock, microseconds)                │
│   1. accept_from allowlist check                          │
│   2. Schnorr verify (toon-event-verifier)                 │
│   3. Nonce store: lookup last committed; reserve nonce   │
│      with status='in_flight'; check idempotent replay     │
│   4. Pricing gate (computeCost vs packet.amount)          │
└───────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ Phase 2 (NO LOCK)                                         │
│   HTTP POST to handler_url with v2 envelope               │
│   (or v1 PaymentRequest if envelope flag = legacy)        │
└───────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ Phase 3 (under SQLite lock, microseconds)                 │
│   Update row: status='committed', last_committed_nonce,   │
│   response_status, response_body_hash, committed_at       │
└───────────────────────────────────────────────────────────┘
        │
        ▼
ILP FULFILL or REJECT (per directives §1 Override 2 — empty
body on idempotent replay)
```

### Storage schema (per directives Override 2)

```sql
CREATE TABLE local_delivery_nonces (
  pubkey                    TEXT NOT NULL,
  last_committed_nonce      INTEGER NOT NULL DEFAULT -1,
  last_payload_hash         BLOB(32),
  last_response_status      INTEGER,
  last_response_body_hash   BLOB(32),
  status                    TEXT NOT NULL CHECK (status IN ('idle','in_flight','committed')),
  in_flight_nonce           INTEGER,
  in_flight_payload_hash    BLOB(32),
  started_at                INTEGER,
  committed_at              INTEGER,
  PRIMARY KEY (pubkey)
);
```

TTL: `committed_at < now() - dedupTtlSeconds` (default 300, range 60–3600). In-flight reap: `started_at < now() - max_in_flight_seconds` (default 60).

### Module layout

```
packages/connector/src/
├── core/
│   └── local-delivery-client.ts            (modified: pre-stages + v2 envelope)
├── config/
│   ├── toon-config-provider.ts             (NEW)
│   └── toon-config-schema.ts               (NEW — strict zod)
├── local-delivery/
│   ├── nonce-store.ts                      (NEW — three-phase commit)
│   ├── nonce-store-pruner.ts               (NEW — 60s sweep)
│   ├── pricing.ts                          (NEW — computeCost)
│   ├── toon-event-verifier.ts              (NEW — Schnorr verify)
│   └── payment-headers.ts                  (NEW — X-TOON-* builder)
├── db/schema/
│   └── local-delivery-nonces.sql           (NEW migration)
└── admin/
    └── nodes-api.ts                        (modified: /channels endpoint)
```

---

## Stories

### Story 39.1: SQLite migration + `local_delivery_nonces` schema

**Goal.** Land the new table + indexes via existing migration tooling.

**AC.**
- AC1: Migration file at `packages/connector/src/db/schema/local-delivery-nonces.sql` with the exact schema from directives Override 2.
- AC2: Index on `(status, started_at)` for in-flight reaper; on `(committed_at)` for TTL pruner.
- AC3: Migration runs cleanly on fresh DB and on existing DB.
- AC4: Down-migration provided (drop table).

**Files.** `packages/connector/src/db/schema/local-delivery-nonces.sql`, migration runner test.

---

### Story 39.2: `toon-config-schema.ts` strict zod schema

**Goal.** Define the v1 `toon.json` schema. Strict mode rejects unknown fields under `pricing` (no parsed-but-unused `byKind`).

**AC.**
- AC1: Schema covers `version: "2"`, `node.pubkey`, `node.accept_from?` (optional allowlist), `pricing.default.{rate_msats_per_kb, minimum_msats}`, `kinds`, `settlement.{threshold_msats, interval_seconds}`, `localDelivery.envelope?`.
- AC2: `.strict()` on `pricing` block rejects `byKind` and any other unknown key with clear error message.
- AC3: Bigint-as-string with regex validation for all msat fields.
- AC4: zod schema exported as both runtime validator and TypeScript type.

**Files.** `packages/connector/src/config/toon-config-schema.ts`, `.test.ts`.

---

### Story 39.3: `toon-config-provider.ts` with fs.watch + snapshot

**Goal.** Watch `toon.json` files for hot reload; expose atomic snapshot per packet entry.

**AC.**
- AC1: `provider.snapshot()` returns a `Readonly<ToonConfig>` — frozen, never references the live config.
- AC2: `fs.watch` (or polling fallback when fs.watch unavailable) reloads on file change.
- AC3: Reload validates with the strict zod schema; invalid configs are rejected with the prior valid config retained + alert.
- AC4: Per-node config keyed by ILP address; multiple nodes supported.
- AC5: Hot-reload race: in-flight packets keep their entry-time snapshot (resolves directives Gap 1).

**Files.** `packages/connector/src/config/toon-config-provider.ts`, `.test.ts`.

---

### Story 39.4: `toon-event-verifier.ts` Schnorr verify

**Goal.** Isolated Schnorr verify module for the new pre-stage. Reuses `@noble/curves` already in the codebase.

**AC.**
- AC1: `verifyToonEvent(event: NostrEvent): Result` — returns ok or specific failure.
- AC2: Failure modes distinguished: `malformed_event`, `bad_signature`, `id_mismatch`, `pubkey_mismatch`.
- AC3: Verifier is pure (no I/O, no time dependency); fully unit-testable.
- AC4: Reuses `secp256k1.schnorr.verify` import path from `nip59-claim-wrapper.ts`.

**Files.** `packages/connector/src/local-delivery/toon-event-verifier.ts`, `.test.ts`.

---

### Story 39.5: `nonce-store.ts` three-phase commit

**Goal.** Phase 1 reserve + Phase 3 commit transactions. Phase 2 happens in `LocalDeliveryClient`.

**AC.**
- AC1: `phase1Reserve(pubkey, nonce, payloadHash)` inside `BEGIN IMMEDIATE`; returns `{ outcome: 'reserved' | 'cached' | 'reject', cachedResponse? }`.
- AC2: Idempotent replay: if `(nonce == last_committed_nonce && payload_hash matches)`, returns `{ outcome: 'cached', cachedResponse: { status, emptyBody: true } }`.
- AC3: Coalescing: if `status == 'in_flight' && nonce == in_flight_nonce && payload_hash matches`, awaits the existing in-flight (single-process; cross-process coalescing deferred).
- AC4: `phase3Commit(pubkey, status, responseStatus, responseBodyHash)` inside `BEGIN IMMEDIATE`.
- AC5: All transactions are sync via better-sqlite3 sync API; never holds a write lock during HTTP I/O.

**Files.** `packages/connector/src/local-delivery/nonce-store.ts`, `.test.ts`.

---

### Story 39.6: `nonce-store-pruner.ts` 60-second sweep

**Goal.** Background pruner: in-flight reap + dedup TTL.

**AC.**
- AC1: Runs every 60s on connector's existing scheduler.
- AC2: Reaps `status='in_flight' AND started_at < now() - max_in_flight_seconds`.
- AC3: Prunes `committed_at < now() - dedupTtlSeconds`.
- AC4: Lazy reap on lookup: if a pubkey's row is in_flight past deadline, the next phase1 call clears it.
- AC5: Crash recovery: connector restart triggers an immediate sweep before serving traffic.

**Files.** `packages/connector/src/local-delivery/nonce-store-pruner.ts`, `.test.ts`.

---

### Story 39.7: `pricing.ts` computeCost

**Goal.** Single-rate v1 pricing. Full event JSON byte length per directives Override 5.

**AC.**
- AC1: `computeCost(event: NostrEvent, cfg: ToonConfig): bigint`.
- AC2: `payload_bytes = Buffer.byteLength(JSON.stringify(canonicalEventObject), 'utf8')` where canonicalEventObject has fields ordered `id, pubkey, created_at, kind, tags, content, sig`.
- AC3: Cost = `BigInt(Math.ceil(payloadBytes / 1024)) * BigInt(cfg.pricing.default.rate_msats_per_kb)` clamped to `>= cfg.pricing.default.minimum_msats`.
- AC4: Multibyte UTF-8 (e.g., emoji) counts bytes not codepoints.

**Files.** `packages/connector/src/local-delivery/pricing.ts`, `.test.ts`.

---

### Story 39.8: `payment-headers.ts` X-TOON-* builder

**Goal.** Build `X-TOON-*` HTTP headers from packet + claim. Trivial isolated module.

**AC.**
- AC1: Headers built: `X-TOON-Amount`, `X-TOON-Sender`, `X-TOON-Pubkey`, `X-TOON-Nonce`, `X-TOON-Kind`.
- AC2: Header values use ASCII-only encoding; pubkey is hex-encoded; nonce is decimal string.
- AC3: Pure function (no I/O); fully unit-testable.

**Files.** `packages/connector/src/local-delivery/payment-headers.ts`, `.test.ts`.

---

### Story 39.9: `LocalDeliveryClient` v2 envelope mode

**Goal.** Add the v2 envelope mode behind a config flag. v1 (PaymentRequest) remains default.

**AC.**
- AC1: Config flag `localDelivery.envelope: 'payment-request' | 'toon-event'`; default `'payment-request'`.
- AC2: v2 envelope shape per Townhouse reply §2b: `{ version: 2, event, claim, nonce, pubkey }`.
- AC3: v2 mode: `nonce` and `pubkey` denormalized fields MUST equal values inside `event`; mismatch rejects with F00 "envelope/event mismatch".
- AC4: v1 mode unchanged; existing apps work without modification.

**Files.** Edit `packages/connector/src/core/local-delivery-client.ts`; new envelope test.

**Dependencies.** Stories 39.2 (config schema for envelope flag).

---

### Story 39.10: Wire pre-stages into LocalDeliveryClient

**Goal.** Insert `accept_from` check + Schnorr verify + nonce store Phase 1 + pricing gate + Phase 2 (existing HTTP) + Phase 3 commit into `LocalDeliveryClient.deliver()`.

**AC.**
- AC1: Pipeline order: snapshot config → accept_from → Schnorr verify → Phase 1 nonce reserve → pricing gate → Phase 2 HTTP → Phase 3 commit.
- AC2: Each stage returns its specific ILP error code on failure (F00, F04, F99 per directives Override 6).
- AC3: HTTP error mapping uses existing `mapRejectCode` in `payment-handler.ts` (NOT a new `error-mapping.ts`; directives Override 6 corrects the path).
- AC4: Embedded handler bypass (`setPacketHandler`) wraps the same pre-stages.

**Files.** Edit `packages/connector/src/core/local-delivery-client.ts`, `packages/connector/src/core/connector-node.ts`.

**Dependencies.** Stories 39.3, 39.4, 39.5, 39.7, 39.8, 39.9.

---

### Story 39.11: Admin API — `GET /admin/api/nodes/:pubkey/channels`

**Goal.** Return the chain set settling against a node, derived from `SettlementCoordinator` state. Resolves directives Override 7 operator-UX cliff.

**AC.**
- AC1: Endpoint returns `{ pubkey, channels: [{ chain, channelId, status, balance, lastSettlementAt }] }`.
- AC2: 404 on unknown pubkey (matches Epic 37's 39.1 contract).
- AC3: Auth: same `X-Api-Key` (or RFC 9421 once Epic 38 lands).
- AC4: Operator docs explain the endpoint as the answer to "which chain does my node settle on?"

**Files.** Edit `packages/connector/src/admin/nodes-api.ts`; doc update in `docs/operators/`.

**Dependencies.** None (`SettlementCoordinator` exists).

---

### Story 39.12: `acceptance.strfry.spec.ts` — the single binary test

**Goal.** Unmodified `strfry` container, `toon.json`, zero SDK imports → ILP PREPARE → FULFILL with EVM settlement crossing threshold via `SettlementMonitor`.

**AC.**
- AC1: Test boots a `strfry/strfry:latest` container with no patches.
- AC2: `toon.json` mounted via volume; declares pubkey, accept_from, pricing, kinds=[1,3,7], settlement threshold.
- AC3: Test connector configured with `localDelivery.envelope: 'toon-event'`; routes to the strfry node.
- AC4: ILP PREPARE sent from a second connector with a signed Nostr event of kind 1; verifies + pays + delivers; asserts strfry stored the event (queryable via REQ).
- AC5: Settlement watcher fires on threshold crossing; on-chain `claimFromChannel()` succeeds against an Anvil EVM container.
- AC6: Test runs in nightly HTTP-surface CI from sprint 1; stop-the-line policy applies.

**Files.** `packages/connector/test/integration/acceptance.strfry.spec.ts`; nightly workflow extension.

**Dependencies.** All prior stories in this epic.

---

### Story 39.13: Concurrency, hot-reload, idempotency, crash-recovery test suite

**Goal.** Mandatory test directives from directives §4.

**AC.**
- AC1: `nonce-store.concurrency.spec.ts` — 50 PREPAREs across 5 pubkeys complete in `~slowest_post_time + 100ms`. Lock-model regression test.
- AC2: `nonce-store.replay.spec.ts` — exact-replay returns cached `(status, empty body)`; different-payload-same-nonce → F00.
- AC3: `nonce-store.ttl.spec.ts` — fake-timer test for TTL pruning; in-flight reaping.
- AC4: `nonce-store.crash-recovery.spec.ts` — in-flight rows past deadline cleaned on restart.
- AC5: `local-delivery-client.hot-reload.spec.ts` — mid-flight rate change uses entry-time snapshot.
- AC6: `local-delivery-client.auth.spec.ts` — `accept_from` absent / empty / present-allow / present-deny.

**Files.** Per AC; in `packages/connector/test/integration/`.

---

### Story 39.14: Operator documentation update

**Goal.** Document the new pipeline, `toon.json` schema, envelope migration path, and operator UX (channel introspection).

**AC.**
- AC1: New doc `docs/operators/toon-local-delivery.md` covering full lifecycle.
- AC2: `toon.json` reference matches `toon-config-schema.ts` exactly (single source of truth).
- AC3: Envelope migration guide: when to flip the flag, how to verify app readiness.
- AC4: Reference `acceptance.strfry.spec.ts` as the canonical example deployment.

**Files.** `docs/operators/toon-local-delivery.md`, `docs/operators/toon-json-reference.md`.

---

### Story 39.16: v1↔v2 envelope mixed-bilateral test + flip-default protocol (this epic's slice)

**Goal.** Test that v1 and v2 envelopes coexist correctly across mixed bilateral pairs; wire the envelope flag into Epic 43's migration telemetry; document the flip-default decision protocol for this flag.

**Acceptance criteria.**
- AC1: Test `local-delivery-client.envelope-mixed.spec.ts`: connector A on `envelope: 'toon-event'` POSTs to app B that supports v1 only → reject with documented error code (no silent corruption).
- AC2: Test: connector A on `envelope: 'payment-request'` (default) POSTs to app B that supports v2 only → reject with documented error code.
- AC3: Test: connector A on `envelope: 'toon-event'` POSTs to app B supporting v2 → succeed.
- AC4: Test: connector A on `envelope: 'payment-request'` POSTs to app B supporting v1 (existing behaviour) → succeed.
- AC5: Migration counter `connector.migration.flag.localDelivery_envelope.{accept,reject,error}` per Epic 43 Story 43.1.
- AC6: Decision protocol entry in `docs/operators/migration-decision-protocol.md` for envelope flag (Epic 43 Story 43.1 owns the doc).
- AC7: Cross-version compat matrix entries (Epic 43 Story 43.2) cover envelope combinations.
- AC8: Rollback procedure documented (Epic 43 Story 43.5).

**Files.** `packages/connector/test/integration/local-delivery-client.envelope-mixed.spec.ts`; instrumentation hook in `local-delivery-client.ts`.

**Dependencies.** Stories 39.9, 39.10. Epic 43 Stories 43.1, 43.2, 43.5.

---

### Story 39.15: Deprecate "BLS" terminology across code, docs, and config

**Goal.** Rename "BLS" → "app" / "handler" across the codebase. The legacy term originated when the local delivery handler had to import the TOON SDK and do ILP-aware work — that role no longer exists post-Epic-39. New prose, new code, new identifiers use "app" or "handler" per context. Existing occurrences are migration debt cleared by this story.

**Naming rule.**
- **"app"** — conceptual / user-facing. The operator's HTTP application. Examples: "the app returns 200/4xx", "any HTTP service is a TOON node app", "app crash recovery".
- **"handler"** — technical / wire-level. The HTTP endpoint that receives the v2 envelope POST. Matches the existing `handler_url` field in `toon.json`. Examples: "the handler endpoint", "POST to the handler", "handler verifier middleware".
- **"BLS"** — deprecated. Removed from all new prose, docs, code, comments, and commit messages.

**AC.**
- AC1: All comments, JSDoc, and prose-level references in `packages/connector/src/**/*.ts` updated. Where renaming is non-breaking, identifiers (class/method/type names) are also updated. Example: comment in `local-delivery-client.ts:4–7` ("no ILP knowledge required on the BLS side") becomes "no ILP knowledge required on the app side."
- AC2: All operator-facing docs in `docs/` updated. `docs/ator-transport.md` references to "BLS /handle-packet endpoint" become "app /handle-packet endpoint" (or the handler endpoint name as it actually appears in code).
- AC3: Config schema field names containing "BLS" — none currently exist; if any are introduced in Stories 39.1–39.14, they MUST use the new terms from the start.
- AC4: `CLAUDE.md` terminology block updated (already done as part of Story 39.15 planning; this AC verifies it stayed updated).
- AC5: User-facing error messages: any string containing "BLS" updated to "app" or "handler" per context.
- AC6: Git history / commit messages: new commits do not introduce "BLS"; existing commit history is not rewritten.
- AC7: Search audit: `rg -i "\bBLS\b" packages/connector/src docs CLAUDE.md` returns only (a) historical artifacts in `_bmad-output/planning-artifacts/research/` (immutable historical record from the directives round-trip), (b) explicit deprecation notices.
- AC8: Automated CI lint step: PRs introducing new "BLS" usage outside the allowlist fail CI.

**Files.**
- Touches every file under `packages/connector/src/**/*.ts` that contains "BLS" — ~20–30 files based on existing `local-delivery-client.ts` precedent.
- `docs/ator-transport.md`, `docs/operators/*`.
- New: `scripts/lint-no-bls.sh` (regex CI step) + workflow integration.

**Dependencies.** None hard-blocking. Best done after Stories 39.1–39.14 land so the rename covers all new code added by this epic in one sweep. Can run in parallel with low risk.

**Out of scope.**
- Renaming public-API package names (e.g., `@toon-protocol/bls-rfc9421-middleware` proposed in Epic 38 Story 38.11). Package names are part of the public contract; if introduced after this story lands they should use new terms from the start. Epic 38 Story 38.11 prose/AC updated separately to use the new package name.
- Historical research artifacts in `_bmad-output/planning-artifacts/research/`. Those are immutable record of the directives round-trip with Townhouse. Their "BLS" usage stays as-is.

---

## Risks

All material risks already enumerated in `connector-directives-ilp-as-tcp-2026-05-01.md` §1 Overrides. Highlights:

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| SQLite global write lock starvation under load | Medium (without three-phase) | Catastrophic | Three-phase commit (directives Override 1); concurrency test enforces |
| Idempotency cache bloat from large response bodies | Medium | Medium | Empty-body replay (directives Override 2); hash-only storage |
| 24h TTL bloat | High (in original Townhouse design) | Low | 5-minute TTL default (directives Override 3) |
| `byKind` parsed-but-unused rot | Medium | Medium | Strict zod rejects unknown fields (directives Override 4) |
| Pricing-on-id-preimage mismatch | Low | Medium | Pricing on full event JSON (directives Override 5) |

---

## Definition of Done

- All 14 stories shipped with tests green.
- Acceptance test (`acceptance.strfry.spec.ts`) green in nightly HTTP-surface CI.
- Concurrency test demonstrates no global write lock.
- v2 envelope behind config flag; v1 still default; both work bilaterally.
- Operator docs cover lifecycle, schema, migration, channel introspection.
- Townhouse confirms reference app works end-to-end against the v2 envelope.

## Estimated Total Effort

16 stories. Estimate range: 2–3 sprints (4–6 weeks at 2-week cadence) for a single dedicated engineer; 1.5–2 sprints with two engineers. Story 39.15 (terminology deprecation) is mechanical and low-risk; Story 39.16 (mixed-bilateral test) is a thin slice over Epic 43; both parallelisable.

## Test design

Separate doc `test-design-epic-39.md` (TBD — created when this epic enters delivery; directives §4 supplies most content).
