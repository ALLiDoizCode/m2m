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
  - '_bmad-output/implementation-artifacts/story-32-3.md'
  - 'packages/connector/src/settlement/provider/payment-channel-provider.ts'
  - 'packages/connector/src/settlement/provider/chain-provider-registry.ts'
  - 'packages/connector/src/settlement/payment-channel-sdk.ts'
  - 'packages/shared/src/types/payment-channel.ts'
  - '_bmad/tea/testarch/knowledge/test-quality.md'
  - '_bmad/tea/testarch/knowledge/data-factories.md'
  - '_bmad/tea/testarch/knowledge/test-levels-framework.md'
---

# ATDD Checklist - Epic 32, Story 32.3: Migrate EVM Settlement to EVMPaymentChannelProvider

**Date:** 2026-03-24
**Author:** Jonathan
**Primary Test Level:** Unit

---

## Story Summary

Wrap the existing `PaymentChannelSDK` in a new `EVMPaymentChannelProvider` class that implements the chain-agnostic `PaymentChannelProvider` interface. This enables all EVM settlement operations to be accessed through the abstraction layer without changing SDK behavior.

**As a** settlement service developer
**I want** an `EVMPaymentChannelProvider` class that implements the `PaymentChannelProvider` interface by delegating to the existing `PaymentChannelSDK`
**So that** all EVM settlement operations are accessible through the chain-agnostic abstraction layer without changing behavior

---

## Acceptance Criteria

1. **AC 1:** EVMPaymentChannelProvider implements PaymentChannelProvider; chainType returns 'evm'; chainId returns configured string
2. **AC 2:** openChannel delegates to PaymentChannelSDK with tokenAddress and zero initialDeposit
3. **AC 3:** signBalanceProof delegates with string-to-bigint conversion
4. **AC 4:** verifyBalanceProof constructs BalanceProof and delegates
5. **AC 5:** subscribeToEvents wraps SDK event listeners, unsubscribe removes them
6. **AC 6:** getChannelState translates EVM ChannelState to ProviderChannelState (deposit = myDeposit + theirDeposit)
7. **AC 7:** claimFromChannel, closeChannel, settleChannel, deposit delegate correctly (void -> TxResult placeholder)
8. **AC 8:** Existing PaymentChannelSDK tests pass without modification

---

## Failing Tests Created (RED Phase)

### Unit Tests (21 tests)

**File:** `packages/connector/src/settlement/provider/evm-payment-channel-provider.test.ts` (480+ lines)

- **Test:** EVMPaymentChannelProvider type compliance (T-32.3-01)
  - **Status:** RED - `describe.skip` (class not implemented yet)
  - **Verifies:** Implements all 9 methods + 2 properties of PaymentChannelProvider

- **Test:** chainType returns 'evm' (T-32.3-02)
  - **Status:** RED - `describe.skip`
  - **Verifies:** `chainType === 'evm'`

- **Test:** chainId returns configured chain ID (T-32.3-02)
  - **Status:** RED - `describe.skip`
  - **Verifies:** `chainId === 'evm:8453'`

- **Test:** openChannel delegates with tokenAddress and 0n initialDeposit (T-32.3-03)
  - **Status:** RED - `describe.skip`
  - **Verifies:** SDK.openChannel called with `(participant, tokenAddress, timeout, 0n)`

- **Test:** signBalanceProof delegates converting string amounts to bigint (T-32.3-04)
  - **Status:** RED - `describe.skip`
  - **Verifies:** SDK.signBalanceProof called with destructured params and BigInt amounts

- **Test:** verifyBalanceProof constructs BalanceProof from params (T-32.3-05, 2 tests)
  - **Status:** RED - `describe.skip`
  - **Verifies:** SDK.verifyBalanceProof called with BalanceProof object; returns true/false

- **Test:** subscribeToEvents returns ProviderEventSubscription (T-32.3-06, 4 tests)
  - **Status:** RED - `describe.skip`
  - **Verifies:** Returns unsubscribe handle; registers all 4 SDK event types; forwards matching events; filters non-matching channelIds

- **Test:** unsubscribe cleanup (T-32.3-07)
  - **Status:** RED - `describe.skip`
  - **Verifies:** sdk.removeAllListeners called on unsubscribe

- **Test:** getChannelState translation (T-32.3-08, 2 tests)
  - **Status:** RED - `describe.skip`
  - **Verifies:** Translates ChannelState to ProviderChannelState; deposit = myDeposit + theirDeposit

- **Test:** claimFromChannel delegation (T-32.3-09)
  - **Status:** RED - `describe.skip`
  - **Verifies:** BalanceProofParams converted to BalanceProof (bigint); SDK called with tokenAddress

- **Test:** closeChannel and settleChannel delegation (T-32.3-10, 2 tests)
  - **Status:** RED - `describe.skip`
  - **Verifies:** SDK methods called with channelId and tokenAddress; TxResult returned

- **Test:** deposit delegation (T-32.3-11)
  - **Status:** RED - `describe.skip`
  - **Verifies:** String amount converted to bigint; SDK.deposit called with tokenAddress

- **Test:** createEVMProviderFactory (T-32.3-13, 3 tests)
  - **Status:** RED - `describe.skip`
  - **Verifies:** Returns ChainProviderFactory; creates provider for EVM config; throws for non-EVM config

---

## Data Factories Created

N/A - This story uses simple constants and mock SDK stubs. No external data factories needed since all test data is deterministic (channel IDs, addresses, amounts).

---

## Fixtures Created

N/A - Tests use inline `createMockSDK()` and `createMockLogger()` helper functions co-located in the test file, following the existing pattern from `chain-provider-registry.test.ts`.

---

## Mock Requirements

### PaymentChannelSDK Mock

All 13 SDK methods are mocked with `jest.fn()`:

- `openChannel`, `deposit`, `claimFromChannel`, `closeChannel`, `settleChannel`
- `signBalanceProof`, `verifyBalanceProof`, `getChannelState`
- `onChannelOpened`, `onChannelClosed`, `onChannelSettled`, `onChannelCooperativeSettled`
- `removeAllListeners`

Cast as `PaymentChannelSDK` via `Pick<>` type since the provider only accesses these methods.

### Logger Mock

Minimal mock with `jest.fn()` stubs for `info`, `warn`, `error`, `debug`, `trace`, `fatal`, `child`. Level set to `'silent'`.

---

## Required data-testid Attributes

N/A - This is a backend-only unit test story with no UI components.

---

## Implementation Checklist

### Test: Type compliance (T-32.3-01)

**File:** `packages/connector/src/settlement/provider/evm-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Create `packages/connector/src/settlement/provider/evm-payment-channel-provider.ts`
- [ ] Define `EVMPaymentChannelProvider` class implementing `PaymentChannelProvider`
- [ ] Constructor accepts `PaymentChannelSDK`, `chainId`, `tokenAddress`, `Logger`
- [ ] Set `readonly chainType: BlockchainType = 'evm'` and `readonly chainId: string`
- [ ] Stub all 9 interface methods
- [ ] Run test: `npx jest evm-payment-channel-provider.test.ts -t "type compliance"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: chainType and chainId (T-32.3-02)

**Tasks to make this test pass:**

- [ ] Ensure constructor sets `chainId` from parameter
- [ ] Ensure `chainType` is `'evm'`
- [ ] Run test: `npx jest evm-payment-channel-provider.test.ts -t "chainType"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.25 hours

---

### Test: openChannel delegation (T-32.3-03)

**Tasks to make this test pass:**

- [ ] Implement `openChannel(participant, settlementTimeout)` method
- [ ] Delegate to `sdk.openChannel(participant, tokenAddress, settlementTimeout, 0n)`
- [ ] Return `{ channelId, txHash }` from SDK result
- [ ] Run test: `npx jest evm-payment-channel-provider.test.ts -t "openChannel"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.25 hours

---

### Test: signBalanceProof delegation (T-32.3-04)

**Tasks to make this test pass:**

- [ ] Implement `signBalanceProof(params)` method
- [ ] Destructure params, convert `transferredAmount` and `lockedAmount` to `BigInt`
- [ ] Delegate to `sdk.signBalanceProof(channelId, nonce, bigintTransferred, bigintLocked, locksRoot)`
- [ ] Return hex signature string
- [ ] Run test: `npx jest evm-payment-channel-provider.test.ts -t "signBalanceProof"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.25 hours

---

### Test: verifyBalanceProof delegation (T-32.3-05)

**Tasks to make this test pass:**

- [ ] Implement `verifyBalanceProof(params)` method
- [ ] Create `toSdkBalanceProof()` helper to convert BalanceProofParams to BalanceProof
- [ ] Delegate to `sdk.verifyBalanceProof(balanceProof, signature, signerAddress)`
- [ ] Return boolean result
- [ ] Run test: `npx jest evm-payment-channel-provider.test.ts -t "verifyBalanceProof"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.25 hours

---

### Test: subscribeToEvents (T-32.3-06, T-32.3-07)

**Tasks to make this test pass:**

- [ ] Implement `subscribeToEvents(channelId, callback)` method
- [ ] Register SDK listeners for all 4 event types (ChannelOpened, Closed, Settled, CooperativeSettled)
- [ ] Map SDK events to ProviderEvent objects (e.g., `ChannelOpened` -> `channel_opened`)
- [ ] Filter events by `channelId` before forwarding
- [ ] Return `ProviderEventSubscription` with `unsubscribe()` that calls `sdk.removeAllListeners()`
- [ ] Run test: `npx jest evm-payment-channel-provider.test.ts -t "subscribeToEvents|unsubscribe"`
- [ ] Test passes (green phase)

**Estimated Effort:** 1 hour

---

### Test: getChannelState translation (T-32.3-08)

**Tasks to make this test pass:**

- [ ] Implement `getChannelState(channelId)` method
- [ ] Delegate to `sdk.getChannelState(channelId, tokenAddress)`
- [ ] Create `toProviderChannelState()` helper to translate ChannelState
- [ ] Compute `deposit = myDeposit + theirDeposit`
- [ ] Copy `participants` array
- [ ] Run test: `npx jest evm-payment-channel-provider.test.ts -t "getChannelState"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: claimFromChannel, closeChannel, settleChannel, deposit (T-32.3-09, T-32.3-10, T-32.3-11)

**Tasks to make this test pass:**

- [ ] Implement `claimFromChannel(channelId, balanceProof, signature)` - convert BalanceProofParams, delegate with tokenAddress
- [ ] Implement `closeChannel(channelId)` - delegate with tokenAddress
- [ ] Implement `settleChannel(channelId)` - delegate with tokenAddress
- [ ] Implement `deposit(channelId, amount)` - convert string to BigInt, delegate with tokenAddress
- [ ] Return `{ txHash: 'evm-tx-pending' }` placeholder for void SDK methods
- [ ] Run test: `npx jest evm-payment-channel-provider.test.ts -t "claimFromChannel|closeChannel|settleChannel|deposit"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: createEVMProviderFactory (T-32.3-13)

**Tasks to make this test pass:**

- [ ] Export `createEVMProviderFactory(sdk, logger): ChainProviderFactory`
- [ ] Factory validates `config.chainType === 'evm'`
- [ ] Factory throws for non-EVM configs
- [ ] Factory creates `EVMPaymentChannelProvider` from config
- [ ] Run test: `npx jest evm-payment-channel-provider.test.ts -t "createEVMProviderFactory"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.25 hours

---

### Task: Update barrel export

- [ ] Add `EVMPaymentChannelProvider` and `createEVMProviderFactory` to `packages/connector/src/settlement/provider/index.ts`
- [ ] Run `npm run typecheck` to verify
- [ ] Run `npm run lint` to verify

**Estimated Effort:** 0.1 hours

---

### Task: Regression verification (T-32.3-12)

- [ ] Run `npx jest packages/connector/src/settlement/payment-channel-sdk.test.ts` -- all 33 tests pass
- [ ] Run `npm run typecheck` -- must pass
- [ ] Run `npm run lint` -- must pass
- [ ] Run full test suite -- all existing tests pass unchanged

**Estimated Effort:** 0.25 hours

---

## Running Tests

```bash
# Run all failing tests for this story (all skipped in RED phase)
npx jest packages/connector/src/settlement/provider/evm-payment-channel-provider.test.ts --no-coverage

# Run specific test group
npx jest evm-payment-channel-provider.test.ts -t "openChannel" --no-coverage

# Run with verbose output
npx jest evm-payment-channel-provider.test.ts --verbose --no-coverage

# Run regression tests (SDK)
npx jest packages/connector/src/settlement/payment-channel-sdk.test.ts --no-coverage

# Run all provider tests
npx jest packages/connector/src/settlement/provider/ --no-coverage
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

**TEA Agent Responsibilities:**

- All 21 tests written and skipped (`describe.skip`)
- Mock SDK and Logger helpers created
- Test IDs mapped to story acceptance criteria (T-32.3-01 through T-32.3-13)
- Implementation checklist created

**Verification:**

- All tests skip as expected (21 skipped, 0 passed, 0 failed)
- Existing tests unaffected (59 provider tests pass, 33 SDK tests pass)
- Test file compiles without errors

---

### GREEN Phase (DEV Team - Next Steps)

**DEV Agent Responsibilities:**

1. **Create** `evm-payment-channel-provider.ts` with class skeleton
2. **Remove** `describe.skip` one group at a time
3. **Implement** minimal code to make each test group pass
4. **Run tests** after each implementation step
5. **Update** barrel export in `index.ts`
6. **Verify** regression gate (SDK tests, typecheck, lint)

**Key Principles:**

- One test group at a time (don't try to fix all at once)
- Minimal implementation (delegate to SDK, don't over-engineer)
- Run tests frequently (immediate feedback)
- Use implementation checklist as roadmap

---

### REFACTOR Phase (DEV Team - After All Tests Pass)

**DEV Agent Responsibilities:**

1. Verify all 21 tests pass (green phase complete)
2. Review code for quality (JSDoc, import type, explicit return types)
3. Ensure tests still pass after each refactor
4. Run typecheck and lint

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `npx jest packages/connector/src/settlement/provider/evm-payment-channel-provider.test.ts --no-coverage`

**Results:**

```
Test Suites: 1 skipped, 0 of 1 total
Tests:       21 skipped, 21 total
Snapshots:   0 total
Time:        1.006 s
```

**Summary:**

- Total tests: 21
- Passing: 0 (expected)
- Skipped: 21 (expected - RED phase)
- Status: RED phase verified

### Regression Verification

**Existing provider tests:** 59 passed (payment-channel-provider.test.ts + chain-provider-registry.test.ts)
**Existing SDK tests:** 33 passed (payment-channel-sdk.test.ts)

---

## Notes

- All tests use `describe.skip` (Jest equivalent of Playwright's `test.skip()`) for the TDD red phase
- The mock SDK uses `jest.Mocked<Pick<PaymentChannelSDK, ...>>` to type-safely mock only the methods the provider uses
- Event subscription tests use `setImmediate` to allow async SDK registration to settle before triggering callbacks
- SDK methods returning `void` (deposit, closeChannel, settleChannel, claimFromChannel) require placeholder `TxResult` return values
- The `createEVMProviderFactory` uses placeholder `chainId` and `tokenAddress` derivation -- full wiring deferred to Story 32.7/32.8

---

## Knowledge Base References Applied

- **test-quality.md** - Deterministic tests, isolation, explicit assertions, no hard waits
- **data-factories.md** - Factory pattern for mock SDK and logger creation
- **test-levels-framework.md** - Unit test level selection for pure delegation logic (no DB, no API, no UI)

---

**Generated by BMad TEA Agent** - 2026-03-24
