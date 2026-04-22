# Story 37.9: Denormalize `nonce` and `token_address` Columns on `received_claims` (Nice-to-Have)

Status: backlog
Filed: 2026-04-22
Origin: Story 37.4 deferred-work D5.

## Story

As an operator running a connector with thousands of channels per peer,
I want `ClaimReceiver.getCumulativeInboundByAsset()` to resolve latest-nonce-per-channel in pure SQL (indexed),
so that `/admin/earnings.json` stays well under its 200ms p95 budget at scale.

**Epic:** 37.
**Priority:** P3 (nice-to-have; current JSON-parse path is fine at today's peer volumes).
**Estimated effort:** 1 point (~2–3h incl. migration).

## Context

`received_claims` stores claim payload as a JSON blob in `claim_data TEXT`. 37.4's `getCumulativeInboundByAsset()` scans all verified rows for a peer, parses each JSON payload in JS, and reduces to latest-nonce-per-channel. At today's expected volumes (< 100 channels, < 1_000 claims per peer) this is microseconds. At 10_000 claims × 10 peers it becomes the dominant cost in the endpoint.

## Acceptance Criteria

### AC 1: Migration-safe schema additions

```gherkin
Scenario: New columns added without breaking existing rows
  Given an existing received-claims SQLite DB from v<37.9>
  When the connector boots on v>=37.9
  Then ALTER TABLE adds nullable columns nonce INTEGER and token_address TEXT
  And existing rows have those columns populated via a one-time backfill that parses claim_data
  And new rows are inserted with the columns populated directly by ClaimReceiver._persistReceivedClaim
```

### AC 2: Index on `(peer_id, channel_id, nonce DESC)`

New index supports the SQL rewrite without full-scan.

### AC 3: `getCumulativeInboundByAsset` rewritten as pure SQL

```gherkin
Scenario: Cumulative inbound is computed via indexed GROUP BY
  Given 10_000 claims persisted for peer 'scale-peer' across 100 channels
  When getCumulativeInboundByAsset('scale-peer') is called
  Then the p95 query time is < 50ms on a cold SQLite connection
  And results match the pre-rewrite JSON-parse implementation bit-for-bit
```

### AC 4: No behaviour change for consumers

`/admin/earnings.json` output is byte-identical (modulo timing) for equivalent fixture data. 37.4 and 37.7 tests continue to pass.

## Tasks / Subtasks

- [ ] T1. Update `claim-receiver-db-schema.ts` to add nullable columns + new index.
- [ ] T2. Add a one-time backfill migration that scans pre-existing rows, parses `claim_data`, populates `nonce` + `token_address`. Runs on boot; idempotent (checks if backfill is needed).
- [ ] T3. Update `ClaimReceiver._persistReceivedClaim` to populate the new columns from the claim at insert time.
- [ ] T4. Rewrite `getCumulativeInboundByAsset` and `getRecentClaims` as pure SQL. Keep the JSON-parse fallback for any row where `token_address IS NULL` (pre-migration drift).
- [ ] T5. Benchmark against 10_000 fixture claims to validate AC 3. Add the benchmark as a documented-but-opt-in test (skip by default; gate behind env var).
- [ ] T6. Full suite green.

## Dev Notes

- Backfill-on-boot is safer than migration scripts operators must run manually — the connector already owns its DB file.
- The JSON-parse fallback protects against any operator who downgrades past 37.9 and back; new rows always have the columns.
- Index selection: `(peer_id, channel_id, nonce DESC)` supports the latest-nonce-per-channel reduction; `(peer_id, received_at DESC)` would help `getRecentClaims` but the existing `idx_received_claims_peer` partially covers it.

## Links

- Origin: `_bmad-output/implementation-artifacts/37-4-admin-earnings-json-endpoint.md` follow-up D5.
- Current JSON-parse path: `claim-receiver.ts` `getCumulativeInboundByAsset`.

## Change Log

| Date | Change |
|------|--------|
| 2026-04-22 | Story promoted from 37.4 D5. Status: backlog (nice-to-have, not blocking). |
