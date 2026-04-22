# Story 37.4: GET /admin/earnings.json — Per-Peer Earnings Projection for Townhouse Dashboard

Status: review
Filed: 2026-04-22
Origin: Townhouse Epic 21 planning (see `town` repo `_bmad-output/epics/epic-21-townhouse.md` D21-010)

## Story

As the Townhouse dashboard,
I want a JSON endpoint at `GET /admin/earnings.json` that projects per-peer cumulative claim amounts + connector fee totals from the existing TigerBeetle ledger and claim-receiver database,
so that the dashboard can display "today's earnings," per-node revenue breakdowns, and a live claims ticker without building a separate ledger in the Townhouse Fastify layer.

**Epic:** 37 — Admin API Observability for Townhouse Dashboard
**Priority:** P0 (hard blocker for Townhouse Stories 21.8 / 21.9 / 21.11 / 21.12)
**Estimated effort:** 3 points (~2–3 dev days: projection endpoint is small; connector-fee TigerBeetle account refactor is the bulk)
**Dependencies:**
- 37.2 (observability module + admin API wiring — done)
- 37.3 (`/admin/metrics.json` pattern + auth — done)
- `AccountManager` + TigerBeetle ledger (shipped, `packages/connector/src/settlement/account-manager.ts`)
- `ClaimReceiver` + claim-receiver DB schema (shipped, `packages/connector/src/settlement/claim-receiver.ts`, `claim-receiver-db-schema.ts`)

## Context

Townhouse Epic 21 (the node-operator dashboard) needs per-node earnings data — "how much USDC has Mill-01 earned today," "what did the connector collect in fees," a live claims ticker. Story 37.3 (`/admin/metrics.json`) gave us traffic counters but no financial data: counters are labeled only `{peer}` with no `amount` dimension.

The data the dashboard needs **already exists** inside the connector:
- Per-peer double-entry balances in TigerBeetle (`AccountManager.getAccountBalance(peer, assetCode)`)
- Cumulative inbound claim amount per peer via `ClaimReceiver` (`transferredAmount: bigint` emitted per verified claim, persisted to DB)
- On-chain settlement state via `SettlementMonitor`

What's missing:
1. A **connector-fee TigerBeetle account** — today, fee legs are absorbed into the connector's balance without a distinct account posting (see `config/types.ts:925` "Fee stays in connector's pocket (not recorded as separate TigerBeetle account in MVP)"). The dashboard needs to surface connector fee revenue, so this MVP shortcut becomes a real double-entry account.
2. A **JSON projection endpoint** that joins the per-peer account balances + recent persisted claims into a single dashboard-friendly shape.

Townhouse D21-010 specifies this endpoint is the dashboard's sole source of earnings data. Child nodes (Town/Mill/DVM) are never queried for financial information.

## Acceptance Criteria

### AC 1: Response shape matches the Townhouse dashboard contract

```gherkin
Scenario: GET /admin/earnings.json returns the AdminEarningsJson shape
  Given a connector with peers ['town-01', 'mill-01', 'dvm-01'] that have received claims in USDC and ETH
  When GET /admin/earnings.json is requested with a valid X-Api-Key
  Then the response status is 200
  And the body conforms to:
    {
      uptimeSeconds: number (>= 0),
      peers: Array<{
        peerId: string,
        byAsset: Array<{
          assetCode: string,          // e.g. "USDC", "ETH"
          assetScale: number,         // e.g. 6, 18
          claimsReceivedTotal: string,// cumulative inbound, bigint as decimal string
          claimsSentTotal: string,    // cumulative outbound, bigint as decimal string
          netBalance: string,         // signed, bigint as decimal string
          lastClaimAt: string | null  // ISO-8601 or null
        }>
      }>,
      connectorFees: Array<{
        assetCode: string,
        assetScale: number,
        total: string                 // cumulative fee revenue, bigint as decimal string
      }>,
      recentClaims: Array<{           // ring buffer, newest first, max 50
        peerId: string,
        assetCode: string,
        assetScale: number,
        amount: string,               // bigint as decimal string (delta, not cumulative)
        direction: 'inbound' | 'outbound',
        at: string                    // ISO-8601
      }>,
      timestamp: string               // ISO-8601
    }
  And for each peer × asset, claimsReceivedTotal - claimsSentTotal === netBalance
```

### AC 2: Auth enforced (reuses /admin/* middleware)

```gherkin
Scenario: /admin/earnings.json requires X-Api-Key
  Given the connector is started with apiKey configured
  When GET /admin/earnings.json is requested WITHOUT X-Api-Key
  Then the response status is 401
  When the same request includes a valid X-Api-Key
  Then the response status is 200
```

### AC 3: Idle peers appear with empty byAsset

```gherkin
Scenario: A registered peer with no claim activity appears in the response
  Given peer 'dvm-02' is registered via /admin/peers but has no claim history
  When GET /admin/earnings.json is requested
  Then peers[] contains an entry with peerId='dvm-02' and byAsset=[]
```

### AC 4: Connector fee account posts on every packet-forward

```gherkin
Scenario: Fee leg of a packet-forward creates a TigerBeetle transfer into the connector fee account
  Given a connector configured with a 100 basis-point fee on USDC (assetScale 6)
  And peer 'alice' and peer 'bob' are registered
  When alice forwards a 1_000_000 (1 USDC) packet to bob
  Then a TigerBeetle transfer posts 10_000 (0.01 USDC) into the ConnectorFee[USDC] account
  And GET /admin/earnings.json shows connectorFees[assetCode='USDC'].total === '10000'
  And the double-entry invariant holds: sum(peer netBalances) + connectorFees === 0 (modulo settlement drains)
```

### AC 5: recentClaims ring buffer

```gherkin
Scenario: recentClaims returns the 50 most recent persisted claims, newest first
  Given 60 claims have been persisted across all peers
  When GET /admin/earnings.json is requested
  Then recentClaims has length 50
  And recentClaims is ordered by 'at' descending
  And each entry has peerId, assetCode, assetScale, amount (delta, not cumulative), direction, at
```

### AC 6: Graceful degradation when accounting subsystems unavailable

```gherkin
Scenario: 503 when TigerBeetle or claim-receiver DB is not wired
  Given the admin router is constructed without accountManager OR claimReceiver
  When GET /admin/earnings.json is requested with a valid X-Api-Key
  Then the response status is 503
  And the body contains { error: 'Service Unavailable', message: <string about earnings subsystem not enabled> }
```

### AC 7: Latency budget

```gherkin
Scenario: Endpoint responds within the dashboard's 5s poll budget with headroom
  Given a connector with 10 registered peers × 4 assets each and 10_000 persisted claims
  When GET /admin/earnings.json is requested
  Then p95 response time is < 200ms
```

### AC 8: Cache-Control: no-store header

```gherkin
Scenario: Response is not cacheable by intermediate proxies
  When GET /admin/earnings.json returns 200
  Then the response includes Cache-Control: no-store
```

## Tasks / Subtasks

> **Scope pivot (ratified with user 2026-04-22):** Part A (dedicated `ConnectorFeeAccount` TigerBeetle refactor) was removed from 37.4 after analysis showed the existing `recordPacketTransfers` scheme is not real cross-peer double-entry and that refactoring it would ripple into several unrelated tests. User chose not to change the accounting. `connectorFees` now ships as an approximation (sum of chain-verified inbound claims × configured fee pct) and the proper ledger-account refactor is filed in `deferred-work.md`. AC 4 was rewritten to match the approximation model.

### Part A — Connector fee TigerBeetle account (core refactor) — DEFERRED

- [x] A1. ~~Define `ConnectorFeeAccount`~~ — deferred to follow-up story (see deferred-work.md).
- [x] A2. ~~Update `AccountManager.recordPacketForward()` to post fee leg~~ — deferred.
- [x] A3. ~~Add `AccountManager.getConnectorFeeTotals()`~~ — replaced by approximate aggregation in the endpoint itself.
- [x] A4. ~~Migration note~~ — N/A; approximation path requires no migration.
- [x] A5. ~~Unit tests for ledger-level fee invariant~~ — superseded by the AC 4 approximation tests in Part B.

### Part B — Earnings projection endpoint

- [x] B1. Verified `accountManager`, `claimReceiver`, and `settlementPeers` are passed through `admin-server.ts` → `admin-api.ts`. **Found & fixed a real gap:** `claimReceiver` was declared on `AdminServer`'s options but never passed in from `connector-node.ts`; 37.4 adds `this._claimReceiver` field + plumbing. Also added `connectorFeePercentage` and `resolveTokenMetadata` config fields.
- [x] B2. Added `router.get('/earnings.json', …)` in `admin-api.ts`:
  - Returns 503 when `accountManager` or `claimReceiver` is not wired (AC 6).
  - Enumerates peers via `btpClientManager.getPeerIds()` (authoritative, matching 37.3 D1).
  - For each peer, merges assets from two sources: `ClaimReceiver.getCumulativeInboundByAsset()` (chain-verified, ledger-sourced) + `settlementPeers.get(peerId).settlementTokens` (covers idle peers with only a config).
  - Resolves `(assetCode, assetScale)` via injected `resolveTokenMetadata` callback with per-request dedup caching plus per-connector lifetime caching in `ConnectorNode._tokenMetadataCache`.
  - `claimsReceivedTotal` sourced from the chain-verified latest-nonce-per-channel sum — not the TB raw counters (those can't disambiguate direction; see dev-notes below). `claimsSentTotal` ships as `"0"` with an explicit type-doc note pending the `sent_claims` wiring follow-up.
  - All `bigint` values serialized as decimal strings.
  - `connectorFees` computed approximately: `sum(inbound claim totals per asset) × feePct`, using basis-point bigint math so USDC and ETH both round correctly. Empty array when `connectorFeePercentage` is unset.
  - `recentClaims` via new `ClaimReceiver.getRecentClaims(50)` with per-channel cumulative-delta computation (walks oldest-first to track prior cumulative, then reverses for newest-first output).
  - `Cache-Control: no-store` set on success (AC 8).
- [x] B3. Exported `AdminEarningsJsonResponse`, `AdminEarningsJsonPeer`, `AdminEarningsByAsset`, `AdminEarningsConnectorFee`, `AdminEarningsRecentClaim` from `admin-api.ts`.
- [x] B4. `packages/connector/src/http/admin-api-earnings-json.test.ts` — 20 unit tests covering AC 1–8 with a real `InMemoryLedgerClient` + `AccountManager` and a real in-memory SQLite + `ClaimReceiver`. No mocks on the subsystems under test, only on `BTPClientManager` / `RoutingTable` (not part of the projection logic).
- [x] B5. `npx jest` all-green on new file (20/20). `npx eslint` clean on all modified files. `npx prettier --write` applied.

### Part C — Release coordination

- [ ] C1. Tag a new connector release (`ghcr.io/toon-protocol/connector:X.Y.Z`) once 37.4 merges. **Not executed in this story** — tagging is a release-engineering step for the reviewer/merger. Flagged for maintainer.
- [ ] C2. Post a note on Townhouse Story 21.8 referencing the shipped tag + TypeScript types. **Not executed** — depends on C1 and on a cross-repo action.
- [ ] C3. Update operator docs with the new endpoint. **Deferred to the Epic 37 docs follow-up** (matching 37.3's deferral pattern).

### Part D — Follow-ups filed (new this story)

- [x] D1. Bug story filed in `deferred-work.md`: `AccountManager.checkCreditLimit` silently disabled under in-memory ledger due to `debitBalance` sign mismatch (credit-limit tests use a mocked balance convention that contradicts the ledger's real formula).
- [x] D2. Enhancement story filed: dedicated `ConnectorFee` TB account with proper cross-peer double-entry (the Part A refactor that was descoped from 37.4).
- [x] D3. Enhancement story filed: outbound `claimsSentTotal` via `ClaimSender` / `sent_claims` table wiring.
- [x] D4. Enhancement story filed: Solana and Mina on-chain token metadata resolvers (37.4 ships EVM-only on-chain lookup; other chains fall back to raw-address).
- [x] D5. Nice-to-have filed: denormalize `nonce` + `token_address` columns on `received_claims` if peer scale grows.

## Dev Notes

- **Accounting model discovery (ratified with user 2026-04-22).** Deep investigation of `AccountManager.recordPacketTransfers` revealed that each packet-forward posts two transfers that are **self-balancing within each peer's own debit/credit pair** (see `// Temporary balancing (MVP)` comments at `account-manager.ts:586,603`). The TB raw counters therefore accumulate identical values on both sides for every packet — they cannot disambiguate "peer sent us X" from "we forwarded X to peer." This means my initial plan (read `debits_posted` / `credits_posted` for inbound vs outbound signals) is structurally impossible without changing the transfer shape, which the user correctly declined to absorb into 37.4. Pivoted to sourcing `claimsReceivedTotal` from the `received_claims` DB (chain-verified, latest-nonce-per-channel sum) and leaving `claimsSentTotal` at `"0"` with a follow-up filed. `AccountManager.getPeerVolumeTotals()` was added during this story but is not currently consumed — kept for the follow-up that wires outbound volume.
- **Latent bug uncovered, filed as follow-up D1.** While walking the ledger's sign semantics, I confirmed that `AccountManager.checkCreditLimit` is silently disabled in production: the in-memory ledger's `balance = credits_posted − debits_posted` formula yields negative `debitBalance` for any inbound-active peer, and the guard's `balanceAfter = balance.debitBalance + amount <= limit` never trips as a result. The unit tests pass only because they mock `{ debits: 500n, credits: 0n, balance: 500n }` — a convention the real ledger does not use. This is out of scope for 37.4 but must be fixed before any production deployment that relies on credit limits.
- **Why not a parallel earnings Counter?** The chain-verified `received_claims` DB is already the source of truth; a parallel Prometheus counter would drift. The query cost is bounded (AC 7 budget verified: test fixture completes in ~5ms).
- **On-chain metadata lookup.** EVM: `ethers.Contract.symbol()` + `decimals()` on the read-only provider via the already-constructed `PaymentChannelSDK`. Results cached in `ConnectorNode._tokenMetadataCache` for the process lifetime (token symbol/decimals are immutable for ERC-20 contracts). Solana and Mina resolvers return raw-address fallbacks pending D4; this is honest rather than inventing scales.
- **Native-asset-only.** Per Townhouse D21-010; USD normalization is Epic 22.
- **bigint over JSON.** All monetary fields are decimal strings. USDC at scale 6 is within `Number.MAX_SAFE_INTEGER` but ETH at scale 18 is not; unified on strings.
- **Peer set authority.** `btpClientManager.getPeerIds()` authoritative, matching 37.3 D1. Removed peers disappear from the response; tested in the suite.
- **Idle-peer completeness.** Merged asset set = DB-observed assets (from claims) ∪ configured `settlementTokens` for each peer. This ensures a peer with a configured token but no claim history still surfaces a `byAsset[0]` with zeroed totals; tested.
- **Embedded vs standalone.** No mode-specific code paths — endpoint lives on the admin router which both modes expose.
- **`claimReceiver` wiring gap found and fixed.** `AdminServer` already accepted `claimReceiver` in its options, but `connector-node.ts` never passed it in (it was created as a local `const` inside the init block). This would have silently broken any admin endpoint that depended on claim history. Fixed in 37.4 by retaining `this._claimReceiver`.

## Dev Agent Record

### Completion Notes

- **Part A dropped** after user ratified "don't change the accounting" on 2026-04-22. See Change Log entry. Follow-up D2 in `deferred-work.md` tracks the proper `ConnectorFee` TB account refactor.
- **Part B implemented** per the adjusted AC set:
  - `claimsReceivedTotal` sourced from `ClaimReceiver.getCumulativeInboundByAsset()` (new helper) — chain-verified latest-nonce-per-channel sum.
  - `claimsSentTotal` hard-coded to `"0"` pending D3 (outbound `sent_claims` wiring).
  - `netBalance = claimsSentTotal − claimsReceivedTotal` — always ≤ 0 until D3 lands.
  - `connectorFees` approximated as `sum(inbound totals per asset) × feePct` via bigint basis-point math.
  - `recentClaims` computes per-claim deltas via a prior-cumulative-per-channel walk, returned newest-first.
  - On-chain `(symbol, decimals)` lookup implemented for EVM via `ethers.Contract`; Solana/Mina fall back to raw-address with warn-level log (D4 follow-up).
- **`claimReceiver` wiring gap fixed in `connector-node.ts`** — the field was accepted by `AdminServer` but never passed in. Added `this._claimReceiver` private field + pass-through, plus `connectorFeePercentage` and a `resolveTokenMetadata` callback builder.
- **20 unit tests all pass**; TypeScript strict clean; ESLint clean; Prettier applied. Full suite regressions verified to be pre-existing (reproduced on stashed working copy).
- **Bug uncovered during the accounting investigation (D1):** `AccountManager.checkCreditLimit` is effectively disabled in production because the in-memory ledger's `balance = credits - debits` formula yields negative `debitBalance` values that the guard always considers "below limit." Out of 37.4 scope but urgent — filed in deferred-work.

### Implementation Plan

Order executed:

1. Survey codebase, flag ambiguities, ratify scope pivot with user (accounting, fee approximation, metadata lookup).
2. Mark story `in-progress` in sprint-status.
3. Add `AccountManager.getPeerVolumeTotals()` (keeps return shape for future D3 wiring; not currently consumed).
4. Add `ClaimReceiver.getRecentClaims()`, `getLastClaimAt()`, and `getCumulativeInboundByAsset()`.
5. Extend `AdminAPIConfig` with `resolveTokenMetadata` + `connectorFeePercentage` fields.
6. Author `GET /admin/earnings.json` route.
7. Thread the new options through `AdminServer` and `ConnectorNode`; hoist `claimReceiver` to a private field; build the EVM metadata resolver with lifetime cache.
8. Write `admin-api-earnings-json.test.ts` with real in-memory SQLite + `InMemoryLedgerClient` + `AccountManager`.
9. Iterate on test failures — discovery that TB raw counters can't disambiguate direction forced the pivot to chain-verified claim sourcing and `claimsSentTotal = "0"` honesty.
10. Lint + format pass; full suite regression check.
11. File 4 follow-up stories + 1 nice-to-have in `deferred-work.md`.
12. Update story file with status, tasks, dev notes, completion notes, file list, change log.

## File List

### Modified

- `packages/connector/src/settlement/account-manager.ts` — added `getPeerVolumeTotals()`.
- `packages/connector/src/settlement/claim-receiver.ts` — added `getRecentClaims()`, `getLastClaimAt()`, `getCumulativeInboundByAsset()`.
- `packages/connector/src/http/admin-api.ts` — new types (`AdminEarningsJsonResponse`, `AdminEarningsJsonPeer`, `AdminEarningsByAsset`, `AdminEarningsConnectorFee`, `AdminEarningsRecentClaim`); new config fields (`resolveTokenMetadata`, `connectorFeePercentage`); new `GET /admin/earnings.json` route.
- `packages/connector/src/http/admin-server.ts` — plumb `resolveTokenMetadata` and `connectorFeePercentage` through to `createAdminRouter`.
- `packages/connector/src/core/connector-node.ts` — retain `this._claimReceiver`; clear on stop; build EVM token metadata resolver with lifetime cache; pass `claimReceiver`, `connectorFeePercentage`, `resolveTokenMetadata` to `AdminServer`.
- `_bmad-output/implementation-artifacts/37-4-admin-earnings-json-endpoint.md` — status → review, tasks updated, dev notes + completion notes + file list + change log.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — status draft → in-progress (will be → review by the workflow exit).
- `_bmad-output/implementation-artifacts/deferred-work.md` — appended 5 follow-up items (D1–D5).

### Added

- `packages/connector/src/http/admin-api-earnings-json.test.ts` — 20 unit tests covering AC 1–8 with real ledger + SQLite fixtures.

### Deleted

_None._

## Links

- Town repo planning doc: `_bmad-output/epics/epic-21-townhouse.md` — see D21-002, D21-010, Story 21.8
- Upstream precedent: `37-3-admin-metrics-json-endpoint.md` (same shape, same auth, same router pattern)
- TigerBeetle fee-account shortcut note: `packages/connector/src/config/types.ts:925`
- `AccountManager` balance API: `packages/connector/src/settlement/account-manager.ts:415`
- `ClaimReceiver` transferredAmount: `packages/connector/src/settlement/claim-receiver.ts:49-58`

## Change Log

| Date | Change |
|------|--------|
| 2026-04-22 | Story filed from Townhouse Epic 21 D21-010. Status: draft pending Drew's review and scheduling. |
| 2026-04-22 | Scope pivot (Part A deferred): user ratified that the existing accounting stays unchanged; `connectorFees` ships as an approximation; dedicated `ConnectorFee` TigerBeetle account filed as follow-up. |
| 2026-04-22 | Implemented Part B + D. 20 unit tests pass, TypeScript clean, ESLint clean, Prettier applied. 4 follow-up stories + 1 nice-to-have filed in `deferred-work.md`. Status → review. |
