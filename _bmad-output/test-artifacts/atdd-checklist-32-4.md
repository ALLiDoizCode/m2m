---
stepsCompleted:
  - 'step-01-preflight-and-context'
  - 'step-02-generation-mode'
  - 'step-03-test-strategy'
  - 'step-04c-aggregate'
  - 'step-05-validate-and-complete'
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-03-24'
workflowType: 'testarch-atdd'
inputDocuments:
  - '_bmad-output/implementation-artifacts/story-32-4.md'
  - 'packages/connector/src/settlement/per-packet-claim-service.ts'
  - 'packages/connector/src/settlement/per-packet-claim-service.test.ts'
  - 'packages/connector/src/settlement/provider/evm-payment-channel-provider.ts'
  - 'packages/connector/src/settlement/provider/payment-channel-provider.ts'
  - 'packages/connector/src/settlement/provider/chain-provider-registry.ts'
  - 'packages/connector/src/btp/btp-claim-types.ts'
  - 'packages/connector/src/settlement/channel-manager.ts'
---

# ATDD Checklist - Epic 32, Story 32.4: Refactor PerPacketClaimService for Multi-Chain

**Date:** 2026-03-24
**Author:** Jonathan
**Primary Test Level:** Unit
**Detected Stack:** Backend (TypeScript/Node.js, Jest)

---

## Story Summary

Refactor `PerPacketClaimService` to delegate balance proof signing to the chain-appropriate `PaymentChannelProvider` via the `ChainProviderRegistry`, removing hardcoded EVM dependencies from the core settlement service.

**As a** settlement service developer
**I want** `PerPacketClaimService` to delegate balance proof signing to the chain-appropriate `PaymentChannelProvider` via the `ChainProviderRegistry`
**So that** claim generation works for any supported blockchain without hardcoded EVM dependencies in the core settlement service

---

## Acceptance Criteria

1. **AC1**: Claim generation delegates to provider for signing via `provider.signBalanceProof()` with params object and string amounts
2. **AC2**: Claim message type (blockchain discriminator) is determined by the peer's chain provider
3. **AC3**: Self-describing claim format includes blockchain discriminator (`blockchain`, `chainId`, `tokenNetworkAddress`, `tokenAddress`)
4. **AC4**: Backward compatibility with existing claim generation (identical EVM claim structure and content)
5. **AC5**: No provider found for peer results in null return (same behavior as current "no channel" case)

---

## Failing Tests Created (RED Phase)

### Unit Tests (14 tests)

**File:** `packages/connector/test/acceptance/story-32-4-multi-chain-claim-service.test.ts` (~770 lines)

- **Test:** `[P0] [T-32.4-01] should delegate signing to provider.signBalanceProof with params object and string amounts`
  - **Status:** RED - Skipped (constructor signature not yet changed to accept ChainProviderRegistry)
  - **Verifies:** AC1 - Provider delegation with BalanceProofParams object and string amount conversion

- **Test:** `[P0] [T-32.4-06] should cache channel context with provider reference`
  - **Status:** RED - Skipped (constructor not yet refactored)
  - **Verifies:** AC1 - Channel context caching works with provider reference in ChannelClaimContext

- **Test:** `[P0] [T-32.4-02] should set blockchain discriminator matching peer's provider.chainType`
  - **Status:** RED - Skipped (blockchain field not yet set from provider.chainType)
  - **Verifies:** AC2 - Claim blockchain field matches the provider's chainType

- **Test:** `[P0] [T-32.4-03] should include blockchain, chainId, tokenNetworkAddress, tokenAddress in EVM claim`
  - **Status:** RED - Skipped (getSigningContext() not yet implemented)
  - **Verifies:** AC3 - Self-describing claim format with all EVM-specific fields

- **Test:** `[P0] [T-32.4-05] should preserve nonce increment and cumulative amount accumulation`
  - **Status:** RED - Skipped (constructor not yet refactored)
  - **Verifies:** AC4 - Nonce and cumulative tracking behavior unchanged

- **Test:** `[P0] should produce identical EVM claim structure with version, protocol, and required fields`
  - **Status:** RED - Skipped (constructor not yet refactored)
  - **Verifies:** AC4 - EVM claim JSON structure is backward compatible

- **Test:** `[P1] [T-32.4-08] should reset channel state (type-agnostic behavior preserved)`
  - **Status:** RED - Skipped (constructor not yet refactored)
  - **Verifies:** AC4 - resetChannel works with widened types

- **Test:** `[P0] [T-32.4-04] should return null when no provider is registered for the peer's chain`
  - **Status:** RED - Skipped (registry lookup not yet implemented in buildChannelContext)
  - **Verifies:** AC5 - Null return when no provider found

- **Test:** `[P0] [T-32.4-11] should return chainId, tokenNetworkAddress, signerAddress from SDK`
  - **Status:** RED - Skipped (getSigningContext() not yet added to EVMPaymentChannelProvider)
  - **Verifies:** AC1/AC3 - EVMPaymentChannelProvider.getSigningContext() returns SDK values

- **Test:** `[P1] [T-32.4-07] should recover claims without blockchain=evm filter`
  - **Status:** RED - Skipped (recoverFromDb still has WHERE blockchain='evm')
  - **Verifies:** AC4 - recoverFromDb widened for multi-chain

- **Test:** `[P1] [T-32.4-09] should return null when buildChannelContext fails`
  - **Status:** RED - Skipped (constructor not yet refactored)
  - **Verifies:** Error handling - buildChannelContext failure returns null

- **Test:** `[P1] [T-32.4-10] should propagate signBalanceProof errors from provider`
  - **Status:** RED - Skipped (signing not yet delegated to provider)
  - **Verifies:** Error handling - signBalanceProof failure propagates

- **Test:** `[P0] should return BTPClaimMessage type from getLatestClaim (not EVMClaimMessage)`
  - **Status:** RED - Skipped (return type not yet widened)
  - **Verifies:** Type widening - getLatestClaim returns BTPClaimMessage

- **Test:** `[P0] should use BTPClaimMessage type for PerPacketClaimResult.claimMessage`
  - **Status:** RED - Skipped (PerPacketClaimResult type not yet widened)
  - **Verifies:** Type widening - PerPacketClaimResult.claimMessage is BTPClaimMessage

---

## Data Factories Created

N/A - Tests use inline mock factories following the existing test pattern in the codebase (`createMockLogger`, `createMockSDK`, `createMockChannelManager`, `createMockDb`).

---

## Fixtures Created

N/A - Backend unit tests use Jest mocks. No Playwright fixtures needed.

---

## Mock Requirements

### ChainProviderRegistry Mock

**Pattern:** Inline object with `getProviderForPeer` method

- Returns `EVMPaymentChannelProvider` instance when `peerConfig.chain === 'evm:anvil:31337'`
- Returns `undefined` for unknown chains
- Cast as `unknown as ChainProviderRegistry`

### EVMPaymentChannelProvider (Real instance with mocked SDK)

**Pattern:** Real `EVMPaymentChannelProvider` constructed with mocked `PaymentChannelSDK`

- `signBalanceProof` returns `'0xmocksignature'`
- `getSigningContext()` returns `{ chainId: 31337, tokenNetworkAddress, signerAddress }`
- Supports `instanceof EVMPaymentChannelProvider` checks in production code

**Notes:** Using real provider instances (not plain mocks) is critical because `buildChannelContext` uses `instanceof EVMPaymentChannelProvider` to detect EVM providers and call `getSigningContext()`.

---

## Required data-testid Attributes

N/A - Backend-only story, no UI components.

---

## Implementation Checklist

### Test: T-32.4-11 - getSigningContext() on EVMPaymentChannelProvider

**File:** `packages/connector/src/settlement/provider/evm-payment-channel-provider.ts`

**Tasks to make this test pass:**

- [ ] Add `getSigningContext()` public method to `EVMPaymentChannelProvider`
- [ ] Implement with `Promise.all([this._sdk.getChainId(), this._sdk.getTokenNetworkAddress(this._tokenAddress), this._sdk.getSignerAddress()])`
- [ ] Return `{ chainId, tokenNetworkAddress, signerAddress }`
- [ ] Run test: `npx jest --testPathIgnorePatterns='/node_modules/' --testPathPattern='story-32-4' --no-coverage -t 'T-32.4-11'`

**Estimated Effort:** 0.5 hours

---

### Test: T-32.4-01 - Delegate signing to provider

**File:** `packages/connector/src/settlement/per-packet-claim-service.ts`

**Tasks to make this test pass:**

- [ ] Change constructor param from `paymentChannelSDK: PaymentChannelSDK` to `chainProviderRegistry: ChainProviderRegistry`
- [ ] Store as `private readonly _registry: ChainProviderRegistry`
- [ ] Remove `PaymentChannelSDK` import
- [ ] Add imports for `ChainProviderRegistry`, `PaymentChannelProvider`, `BlockchainType`, `BTPClaimMessage`, `isEVMClaim`, `EVMPaymentChannelProvider`
- [ ] Add `provider: PaymentChannelProvider` and `blockchain: BlockchainType` to `ChannelClaimContext`
- [ ] Refactor `buildChannelContext` to use `this._registry.getProviderForPeer()`
- [ ] For EVM providers: use `instanceof EVMPaymentChannelProvider` + `getSigningContext()`
- [ ] Refactor `generateClaimForPacket` to call `ctx.provider.signBalanceProof({ channelId, nonce, transferredAmount: newCumulative.toString(), lockedAmount: '0', locksRoot })`
- [ ] Run test: `npx jest --testPathIgnorePatterns='/node_modules/' --testPathPattern='story-32-4' --no-coverage -t 'T-32.4-01'`

**Estimated Effort:** 2 hours

---

### Test: T-32.4-02 - Blockchain discriminator matches chain type

**File:** `packages/connector/src/settlement/per-packet-claim-service.ts`

**Tasks to make this test pass:**

- [ ] Use `ctx.blockchain` (from `provider.chainType`) to set claim's `blockchain` field
- [ ] Guard EVM claim construction with `if (ctx.blockchain === 'evm')`
- [ ] Run test: `npx jest --testPathIgnorePatterns='/node_modules/' --testPathPattern='story-32-4' --no-coverage -t 'T-32.4-02'`

**Estimated Effort:** 0.5 hours

---

### Test: T-32.4-03 - Self-describing claim format

**File:** `packages/connector/src/settlement/per-packet-claim-service.ts`

**Tasks to make this test pass:**

- [ ] Populate `chainId`, `tokenNetworkAddress`, `signerAddress` from `getSigningContext()` for EVM claims
- [ ] Include in serialized claim JSON
- [ ] Run test: `npx jest --testPathIgnorePatterns='/node_modules/' --testPathPattern='story-32-4' --no-coverage -t 'T-32.4-03'`

**Estimated Effort:** 0.5 hours

---

### Test: T-32.4-04 - No provider returns null

**File:** `packages/connector/src/settlement/per-packet-claim-service.ts`

**Tasks to make this test pass:**

- [ ] In `buildChannelContext`, return null if `this._registry.getProviderForPeer()` returns undefined
- [ ] Run test: `npx jest --testPathIgnorePatterns='/node_modules/' --testPathPattern='story-32-4' --no-coverage -t 'T-32.4-04'`

**Estimated Effort:** 0.25 hours

---

### Test: T-32.4-05 - Nonce/cumulative backward compatibility

**File:** `packages/connector/src/settlement/per-packet-claim-service.ts`

**Tasks to make this test pass:**

- [ ] Preserve existing nonce increment and cumulative tracking logic
- [ ] Run test: `npx jest --testPathIgnorePatterns='/node_modules/' --testPathPattern='story-32-4' --no-coverage -t 'T-32.4-05'`

**Estimated Effort:** 0 hours (preserved from existing implementation)

---

### Test: T-32.4-07 - recoverFromDb without blockchain filter

**File:** `packages/connector/src/settlement/per-packet-claim-service.ts`

**Tasks to make this test pass:**

- [ ] Remove `WHERE blockchain = 'evm'` from recoverFromDb SQL query
- [ ] Use `isEVMClaim()` type guard when parsing recovered claims
- [ ] Change `latestClaim` map type to `Map<string, BTPClaimMessage>`
- [ ] Run test: `npx jest --testPathIgnorePatterns='/node_modules/' --testPathPattern='story-32-4' --no-coverage -t 'T-32.4-07'`

**Estimated Effort:** 0.5 hours

---

### Type Widening Tests (BTPClaimMessage)

**File:** `packages/connector/src/settlement/per-packet-claim-service.ts`

**Tasks to make these tests pass:**

- [ ] Change `getLatestClaim` return type from `EVMClaimMessage | null` to `BTPClaimMessage | null`
- [ ] Change `PerPacketClaimResult.claimMessage` type from `EVMClaimMessage` to `BTPClaimMessage`
- [ ] Change `persistClaim` parameter type from `EVMClaimMessage` to `BTPClaimMessage`
- [ ] Run tests: `npx jest --testPathIgnorePatterns='/node_modules/' --testPathPattern='story-32-4' --no-coverage`

**Estimated Effort:** 0.5 hours

---

### Regression: Update existing test file

**File:** `packages/connector/src/settlement/per-packet-claim-service.test.ts`

**Tasks:**

- [ ] Replace `mockSDK` with mock `ChainProviderRegistry` containing mock EVM provider
- [ ] Create mock EVM provider with real `EVMPaymentChannelProvider` instance
- [ ] Mock registry's `getProviderForPeer` to return mock provider for known peers
- [ ] Add `jest.clearAllMocks()` in `beforeEach`
- [ ] Verify all 18 existing test assertions still pass
- [ ] Run: `npx jest --testPathPattern='per-packet-claim-service' --no-coverage`

**Estimated Effort:** 1 hour

---

## Running Tests

```bash
# Run all acceptance tests for this story (skipped in RED phase)
npx jest --config packages/connector/jest.config.js --testPathIgnorePatterns='/node_modules/' --testPathPattern='story-32-4' --no-coverage --verbose

# Run existing unit tests (must continue passing)
npx jest --config packages/connector/jest.config.js --testPathPattern='per-packet-claim-service' --no-coverage --verbose

# Run specific test by name
npx jest --config packages/connector/jest.config.js --testPathIgnorePatterns='/node_modules/' --testPathPattern='story-32-4' --no-coverage -t 'T-32.4-01'

# Run full test suite (regression)
npx jest --config packages/connector/jest.config.js --no-coverage

# Run with typecheck
npm run typecheck
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

**TEA Agent Responsibilities:**

- All 14 acceptance tests written and skipped (RED)
- Mock patterns established (registry + real EVM provider)
- Implementation checklist created
- Existing 18 unit tests verified passing (no regression)

**Verification:**

- All 14 tests skip as expected (RED phase confirmed)
- Tests are designed to pass once implementation is complete
- Tests use real `EVMPaymentChannelProvider` instances for `instanceof` accuracy

---

### GREEN Phase (DEV Team - Next Steps)

**DEV Agent Responsibilities:**

1. **Start with Task 1:** Add `getSigningContext()` to `EVMPaymentChannelProvider` (simplest, enables later tests)
2. **Then Task 2-6:** Refactor `PerPacketClaimService` constructor, context building, signing delegation, type widening
3. **Then Task 7:** Update existing test file to use registry-based construction
4. **Finally:** Remove `it.skip()` from acceptance tests, verify all pass
5. **Regression:** Run full test suite, typecheck, lint

**Key Principles:**

- One task at a time
- Minimal implementation per test
- Run tests frequently
- `instanceof EVMPaymentChannelProvider` check requires real instances (not plain mocks)

---

### REFACTOR Phase (DEV Team - After All Tests Pass)

1. Verify all 14 acceptance + 18 unit tests pass
2. Review for DRY (extract shared mock setup if needed)
3. Ensure `npm run typecheck` and `npm run lint` pass
4. Commit with `feat(32-4): refactor PerPacketClaimService for multi-chain`

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `npx jest --testPathIgnorePatterns='/node_modules/' --testPathPattern='story-32-4' --no-coverage --verbose`

**Results:**

```
Test Suites: 1 skipped, 0 of 1 total
Tests:       14 skipped, 14 total
Snapshots:   0 total
Time:        1.182 s
```

**Summary:**

- Total tests: 14
- Passing: 0 (expected)
- Skipped: 14 (expected - RED phase)
- Status: RED phase verified

### Existing Tests (Regression Check)

**Command:** `npx jest --testPathPattern='per-packet-claim-service' --no-coverage --verbose`

**Results:**

```
Test Suites: 1 passed, 1 total
Tests:       18 passed, 18 total
```

- All 18 existing tests pass unchanged

---

## Notes

- Constructor signature change (`PaymentChannelSDK` to `ChainProviderRegistry`) is the critical breaking change that gates all other tests
- `getSigningContext()` is EVM-specific and NOT on the `PaymentChannelProvider` interface -- use `instanceof` to detect
- Chain ID alignment is critical: `ChannelMetadata.chain` must match `provider.chainId` exactly for registry lookup
- The `as unknown as any` casts in acceptance tests are intentional -- they bypass the pre-implementation type system while `it.skip()` prevents runtime execution

---

**Generated by BMad TEA Agent** - 2026-03-24
