# Story 37.7: Outbound `claimsSentTotal` via `sent_claims` Wiring

Status: review
Filed: 2026-04-22
Origin: Story 37.4 deferred-work D3.

## Story

As the Townhouse dashboard,
I want `/admin/earnings.json` to populate `claimsSentTotal` with the cumulative amount the connector has claimed to have paid each peer (from the `sent_claims` table),
so that the dashboard can show the full bidirectional earnings picture — "Mill has been paid X from us" + "Mill has paid Y to us."

**Epic:** 37.
**Priority:** P1 (Townhouse can ship with inbound-only today; this unblocks the full ticker in 21.11).
**Estimated effort:** 2 points (~half day: mostly wiring + tests; the table already exists).

**Dependency:** Story 37.5 (D1 fix) should ship first so `creditBalance` / `debitBalance` semantics are consistent when any new consumer reads them.

## Context

Story 37.4 hard-codes `claimsSentTotal = "0"` and omits outbound rows from `recentClaims`. The data exists — `ClaimSender` (`claim-sender.ts`) persists every outbound claim to a `sent_claims` table with the same shape as `received_claims`. It's just not reachable from the admin API today.

## Acceptance Criteria

### AC 1: `claimsSentTotal` reflects `sent_claims` cumulative per channel, per asset

```gherkin
Scenario: Outbound claim totals appear on the earnings endpoint
  Given the connector has sent 3 claims to peer 'swap-01' on channel 0xchan-swap:
    cumulative 100_000, then 250_000, then 400_000 on nonce 1, 2, 3
  When GET /admin/earnings.json is requested
  Then peers[peerId='swap-01'].byAsset[assetCode='USDC'].claimsSentTotal == '400000'
  And netBalance == claimsSentTotal − claimsReceivedTotal
```

### AC 2: `recentClaims` includes outbound direction entries

```gherkin
Scenario: Outbound claims appear in the recentClaims ticker
  Given claims have been both sent to and received from 'swap-01'
  When GET /admin/earnings.json is requested
  Then recentClaims contains entries with direction='outbound' alongside direction='inbound'
  And each outbound entry's amount is the per-claim delta (cumulative − prior)
  And the ring buffer ordering remains newest-first across both directions
```

### AC 3: `ClaimReceiver` / `ClaimSender` separation preserved

A new interface or thin wrapper exposes outbound query methods (`getCumulativeOutboundByAsset(peerId)`, `getRecentSentClaims(limit)`) without coupling `ClaimReceiver` to `ClaimSender`. Prefer adding methods to `ClaimSender` and injecting it into `AdminAPIConfig` separately.

### AC 4: Idle peer with outbound-only activity surfaces correctly

```gherkin
Scenario: A peer that has only been paid (never sent claims to us) appears with claimsSentTotal > 0
  Given peer 'solo-payout' has received 3 outbound claims but never sent any
  When GET /admin/earnings.json is requested
  Then solo-payout appears in peers[]
  And byAsset[0].claimsSentTotal > 0
  And byAsset[0].claimsReceivedTotal == '0'
```

### AC 5: No regression on 37.4 tests

The 20 existing tests in `admin-api-earnings-json.test.ts` continue to pass. New tests cover the outbound paths.

## Tasks / Subtasks

> **Decision during implementation:** `ClaimSender` is deprecated (Epic 31 superseded it with `PerPacketClaimService`) and not instantiated in production paths. Rather than adding methods to deprecated code or further bloating `PerPacketClaimService` (which owns the writer path), created a new standalone `SentClaimsQueries` class that takes the shared `sent_claims` DB and logger. Cleaner separation, zero coupling to the writer.

- [x] T1a. Created `packages/connector/src/settlement/sent-claims-queries.ts` with `SentClaimsQueries` class exposing `getCumulativeOutboundByAsset(peerId)` and `getRecentSentClaims(limit)`. Both mirror the inbound helpers added to `ClaimReceiver` in 37.4.
- [x] T2. Threaded `sentClaimsQueries?: SentClaimsQueries` through `AdminAPIConfig` → `AdminServer` → `ConnectorNode`. Construction site: alongside `PerPacketClaimService` wiring in `connector-node.ts` (after the `claimDb` is opened + schema applied).
- [x] T3. Updated `GET /admin/earnings.json`:
  - `claimsSentTotal` populated from `getCumulativeOutboundByAsset`.
  - `netBalance = claimsSentTotal − claimsReceivedTotal` (signed: positive = we owe peer; negative = peer owes us).
  - Merged outbound asset keys so outbound-only peers surface.
  - Interleaved outbound entries in `recentClaims` by timestamp; deltas computed per `(blockchain, channel, direction)`.
  - Graceful fallback to 37.4 behaviour (inbound-only, `claimsSentTotal = "0"`) when `sentClaimsQueries` is not provided.
- [x] T4. 37.4 tests unchanged — fallback path produces their expected values. 20/20 still green.
- [x] T5. New test file `packages/connector/src/http/admin-api-earnings-json-outbound.test.ts` with 7 tests: AC 1 (claimsSentTotal populated), AC 2 (bidirectional ticker + outbound deltas), AC 3 (fallback when queries omitted), AC 4 (outbound-only peer), plus inbound-only preservation and connectorFees inbound-only invariant.
- [x] T6. Lint + prettier clean; 1236/1249 tests passing (13 skipped, pre-existing).

## File List

### Modified

- `packages/connector/src/http/admin-api.ts` — new `sentClaimsQueries` config field, bidirectional byAsset + recentClaims logic.
- `packages/connector/src/http/admin-server.ts` — plumb `sentClaimsQueries`.
- `packages/connector/src/core/connector-node.ts` — construct `SentClaimsQueries` alongside `PerPacketClaimService`, pass to `AdminServer`.

### Added

- `packages/connector/src/settlement/sent-claims-queries.ts` — standalone query helper class.
- `packages/connector/src/http/admin-api-earnings-json-outbound.test.ts` — 7 tests covering AC 1–5 + edge cases.

### Deleted

_None._

## Dev Agent Record

### Completion Notes

- Clean separation of read/write surfaces: the new `SentClaimsQueries` module keeps the admin API from pulling in either writer's transport or lifecycle dependencies.
- Graceful fallback preserved: 37.4's 20 tests pass unchanged; the new 7 tests exercise the bidirectional path.
- Full settlement + http suite: 1236/1249 passing (13 pre-existing skips). ESLint + Prettier clean.

## Superseded Tasks

- [x] ~~T1. Add to `ClaimSender`~~ (see decision above).


## Dev Notes

- `sent_claims` already has the `peer_id` / `blockchain` / `claim_data` / `sent_at` shape needed — no schema change required.
- Determining whether to return `assetCode` from outbound claims requires looking at `claim_data.tokenAddress` (EVM), `programId` (Solana), `tokenId` (Mina). Same resolver as inbound; reuse `ConnectorNode._tokenMetadataCache`.
- If `ClaimSender` is not wired (embedded mode without outbound claims), fall through to `claimsSentTotal = '0'` so the endpoint doesn't 503 on partial configuration.

## Links

- Origin: `_bmad-output/implementation-artifacts/37-4-admin-earnings-json-endpoint.md` follow-up D3.
- `claim-sender-db-schema.ts` — existing `sent_claims` table definition.
- `claim-sender.ts` — existing sender class; add query helpers here.

## Change Log

| Date | Change |
|------|--------|
| 2026-04-22 | Story promoted from 37.4 D3. Status: ready-for-dev. |
| 2026-04-22 | Implemented. New `SentClaimsQueries` module; `/admin/earnings.json` now bidirectional; 7 new tests, 27/27 across 37.4 + 37.7. Status → review. |
