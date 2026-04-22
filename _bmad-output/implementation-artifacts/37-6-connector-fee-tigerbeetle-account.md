# Story 37.6: Dedicated `ConnectorFee` TigerBeetle Account with Proper Cross-Peer Double-Entry

Status: ready-for-dev
Filed: 2026-04-22
Origin: Story 37.4 deferred-work D2 — originally scoped as 37.4 Part A, descoped after analysis.

## Story

As a connector operator,
I want every packet-forward's fee leg recorded in a dedicated `ConnectorFee[assetCode]` TigerBeetle account via a proper cross-peer double-entry,
so that `/admin/earnings.json` reports exact fee revenue (not an approximation) and `sum(peer netBalances) + connectorFees === 0` holds as a testable ledger invariant.

**Epic:** 37 (accounting concern; see thematic note below).
**Priority:** P1 (Townhouse can ship against the approximation today; exactness unlocks operator-level financial reporting).
**Estimated effort:** 3 points (~1–1.5 dev days: the ledger change is small; the test fallout is significant).

**Prerequisite:** Story 37.5 (D1 fix) must ship first. Changing transfer semantics on top of the current broken balance sign would compound the confusion.

## Context

Story 37.4 ships `connectorFees` as `sum(inbound claim totals per asset) × configured_feePct`. This is accurate to within the config's fee rate but:

- Cannot reflect per-peer fee overrides if those are ever introduced.
- Doesn't survive restart deterministically if the fee percentage is changed between boots.
- Doesn't give operators a fee-specific TB ledger to audit against.
- Requires the invariant `sum(peer netBalances) + connectorFees === 0` to be computed in-memory, not checked against the ledger.

The root cause is that today's `recordPacketTransfers` posts two transfers that are **self-balancing within each peer's own account pair** (see `// Temporary balancing (MVP)` comments at `account-manager.ts:586,603`):

```ts
// Transfer 1: fromPeer.debitAccount ← credits=amount, debits=amount on same pair
// Transfer 2: toPeer.debitAccount  ← same self-balancing shape with outgoing amount
```

The docstring `debit_account_id: fromPeerAccounts.debitAccountId, // Increase receivable` describes an intent that isn't realised by the transfer shape.

## Acceptance Criteria

### AC 1: New `ConnectorFeeAccount` per asset

```gherkin
Scenario: ConnectorFee accounts are created idempotently per asset
  Given an AccountManager configured with nodeId='connector-a'
  When ensureConnectorFeeAccount('USDC') is called twice
  Then exactly one account is created in TigerBeetle with a deterministic ID
  And the account code is AccountLedgerCodes.ACCOUNT_CODE_CONNECTOR_FEE (new constant)
```

### AC 2: `recordPacketTransfers` posts three transfers with a balanced double-entry

```gherkin
Scenario: A packet forward posts incoming + outgoing + fee legs that sum to zero
  Given peers alice and bob, assetCode='USDC', fee_rate=1%
  When a packet of 1_000_000 is forwarded from alice to bob (outgoing=990_000, fee=10_000)
  Then exactly three transfers are posted atomically
  And alice.debitBalance increases by 1_000_000 (alice owes us more)
  And bob.creditBalance increases by 990_000 (we owe bob more)
  And ConnectorFee[USDC].balance increases by 10_000
  And the sum (alice.netBalance + bob.netBalance + connectorFee) == 0
```

### AC 3: `AccountManager.getConnectorFeeTotals()` enumerates all fee accounts

Returns `Array<{ assetCode, assetScale, total: bigint }>` — replacing the approximation in `/admin/earnings.json`. The endpoint must switch to this source when available and fall back to the approximation only if the fee subsystem is not enabled.

### AC 4: Double-entry invariant holds under settlement drains

```gherkin
Scenario: Settlement reduces peer balance without touching fees
  Given a fee of 10_000 has been posted to ConnectorFee[USDC]
  When recordSettlement(alice, 'USDC', 500_000) is called
  Then alice.debitBalance reduces by 500_000
  And ConnectorFee[USDC].balance is unchanged at 10_000
  And sum(peer netBalances) + connectorFees continues to equal the invariant (modulo the settled amount)
```

### AC 5: Existing consumers updated without behaviour change

- `checkCreditLimit` (post-37.5 form) continues to evaluate correctly with the new transfer shape.
- `settlement-api.ts` / `settlement-executor.ts` settlement paths continue to drain balances correctly.
- `/admin/earnings.json` `connectorFees` reflects the true ledger totals; approximation tests in 37.4 are updated to assert `total === ledger_total` rather than `sum(inbound) × feePct`.

### AC 6: Migration-safe (greenfield-only)

```gherkin
Scenario: No existing ConnectorFee account is required on boot
  Given a connector previously running v<37.5> with no ConnectorFee accounts
  When the connector boots on v>=37.6
  Then ConnectorFee accounts are created lazily on first packet-forward per asset
  And historical fee revenue before the upgrade is documented as not retroactively counted
```

### AC 7: No regression in full suite

`npx jest` green; the expected rewrites in `account-manager.test.ts` and `packet-handler-settlement.test.ts` are in scope.

## Tasks / Subtasks

- [ ] T1. Add `ACCOUNT_CODE_CONNECTOR_FEE = 300` (or next free) to `AccountLedgerCodes`.
- [ ] T2. Add `generateConnectorFeeAccountId(nodeId, assetCode): bigint` in `account-id-generator.ts` — deterministic, separate from peer account IDs.
- [ ] T3. Add `AccountManager.ensureConnectorFeeAccount(assetCode)` + `getConnectorFeeTotals()`.
- [ ] T4. Rewrite `recordPacketTransfers` to post three transfers:
  - `debit=fromPeer.debitAccount, credit=<clearing-or-fee-account>, amount=incoming` (peer owes us more)
  - `debit=<clearing-or-fee-account>, credit=toPeer.creditAccount, amount=outgoing` (we owe peer more)
  - `debit=<clearing-or-fee-account>, credit=ConnectorFee[asset], amount=fee`
  - Actual shape TBD during implementation — the key constraints are (a) each transfer's `debit+credit` balances at the TB level, (b) the summed deltas across all touched accounts is zero, (c) post-change `debitBalance`/`creditBalance` semantics match the docstrings.
- [ ] T5. Update `packet-handler.ts` to pass the `assetCode` + `fee` amount to `recordPacketTransfers` (may already be in scope).
- [ ] T6. Update `/admin/earnings.json` to consume `getConnectorFeeTotals()` directly when available; keep the approximation path as a fallback gated on `accountManager.isConnectorFeeSubsystemEnabled()`.
- [ ] T7. Rewrite affected tests:
  - `account-manager.test.ts` — transfer-shape assertions.
  - `packet-handler-settlement.test.ts` — expects 3 transfers now, not 2.
  - `admin-api-earnings-json.test.ts` — switch `connectorFees` assertions from approximation to ledger-exact.
- [ ] T8. Write new tests:
  - Double-entry invariant property test: after N random forwards + M random settlements, `sum(peer netBalances) + connectorFees === 0` always holds.
  - Idempotent fee-account creation on concurrent packet flow.
- [ ] T9. `make lint`, `npm run format:check`, full suite.

## Dev Notes

- Ledger-migration stance: greenfield-only. Historical fee revenue before the upgrade boundary is documented as not retroactively counted. No TB state mutation on boot.
- This story intentionally lands `isConnectorFeeSubsystemEnabled()` as a runtime flag so that a rollback to the approximation path stays one line of config away.
- Property-based invariant test gives confidence the refactor doesn't reintroduce the "Temporary balancing" trap.

## Links

- Origin: `_bmad-output/implementation-artifacts/37-4-admin-earnings-json-endpoint.md` Part A (deferred).
- Deferred-work entry: `deferred-work.md` D2.
- Related: Story 37.5 (must ship first).

## Change Log

| Date | Change |
|------|--------|
| 2026-04-22 | Story promoted from 37.4 D2 (originally 37.4 Part A). Status: ready-for-dev. |
