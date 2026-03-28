---
stepsCompleted:
  - step-01-preflight-and-context
  - step-02-generation-mode
  - step-03-test-strategy
  - step-04-generate-tests
  - step-05-validate-and-complete
lastStep: step-05-validate-and-complete
lastSaved: '2026-03-27'
workflowType: testarch-atdd
inputDocuments:
  - _bmad-output/implementation-artifacts/34-5-implement-mina-payment-channel-provider.md
  - _bmad-output/planning-artifacts/test-design-epic-34.md
  - _bmad-output/project-context.md
  - packages/connector/src/settlement/provider/solana-payment-channel-provider.ts
  - packages/connector/src/settlement/provider/solana-payment-channel-provider.test.ts
  - packages/connector/src/settlement/provider/payment-channel-provider.ts
  - packages/connector/src/settlement/provider/chain-provider-registry.ts
  - packages/connector/src/settlement/provider/index.ts
  - packages/connector/jest.config.js
---

# ATDD Checklist - Epic 34, Story 34.5: Implement MinaPaymentChannelProvider

**Date:** 2026-03-27
**Author:** Jonathan
**Primary Test Level:** Unit (mocked SDK)

---

## Story Summary

Implement a Mina Protocol implementation of the `PaymentChannelProvider` interface that enables the connector to settle with peers over Mina using the chain-abstraction layer from Epic 32, with zk-SNARK private balance proofs.

**As a** connector operator
**I want** a Mina Protocol implementation of the `PaymentChannelProvider` interface
**So that** the connector can settle with peers over Mina using the chain-abstraction layer from Epic 32, with zk-SNARK private balance proofs

---

## Generation Mode

**Mode:** AI Generation (backend stack -- no browser recording needed)
**Rationale:** This is a pure TypeScript backend story with clear acceptance criteria, standard delegation/adapter patterns, and a direct reference implementation (SolanaPaymentChannelProvider).

---

## Acceptance Criteria

1. **AC 1:** Interface Implementation -- MinaPaymentChannelProvider implements PaymentChannelProvider, chainType='mina', chainId='mina:<network>'
2. **AC 2:** openChannel delegates to MinaPaymentChannelSDK, returns OpenChannelResult
3. **AC 3:** deposit delegates to SDK, converts string amount to bigint
4. **AC 4:** claimFromChannel delegates to SDK, async proof generation non-blocking
5. **AC 5:** signBalanceProof delegates to SDK for Poseidon commitment
6. **AC 6:** verifyBalanceProof validates zk-SNARK proof via SDK
7. **AC 7:** closeChannel and settleChannel delegate correctly
8. **AC 8:** getChannelState translates Mina state to ProviderChannelState
9. **AC 9:** subscribeToEvents emits ProviderEvent objects, unsubscribe cleans up
10. **AC 10:** Pre-compile zkApp circuit during initialization
11. **AC 11:** ChainProviderRegistry integration (register, getProviderForPeer)
12. **AC 12:** Error mapping -- SDK errors wrapped with provider context
13. **AC 13:** Self-describing claim fields via getMinaContext()

---

## Test Strategy

### Test Level Selection

**Primary level:** Unit tests with mocked `MinaPaymentChannelSDK` (backend stack, no browser tests)

All 17 test scenarios are unit-level tests that verify delegation patterns, type correctness, state translation, error wrapping, and registry integration. The SDK is fully mocked -- no o1js imports in the connector package.

### AC-to-Test Mapping

| AC | Test IDs | Level | Priority | Scenario |
|----|----------|-------|----------|----------|
| AC 1 | T-34.5-01, T-34.5-02 | Unit | P0 | Interface implementation type check; chainType/chainId properties |
| AC 2 | T-34.5-03 | Unit | P0 | openChannel delegates to SDK, returns provider format |
| AC 3 | T-34.5-15 | Unit | P1 | deposit delegates, string-to-bigint conversion |
| AC 4 | T-34.5-06, T-34.5-08 | Unit | P0 | claimFromChannel delegates; proof generation async non-blocking |
| AC 5 | T-34.5-04 | Unit | P0 | signBalanceProof delegates to SDK |
| AC 6 | T-34.5-05 | Unit | P0 | verifyBalanceProof validates proof |
| AC 7 | T-34.5-15 | Unit | P1 | closeChannel, settleChannel delegate correctly |
| AC 8 | T-34.5-07 | Unit | P1 | getChannelState translates Mina state |
| AC 9 | T-34.5-11, T-34.5-12 | Unit | P1 | subscribeToEvents emits events; unsubscribe cleans up |
| AC 10 | T-34.5-16 | Unit | P0 | Pre-compile circuit during init |
| AC 11 | T-34.5-13, T-34.5-14 | Unit | P0 | Registry integration; getProviderForPeer resolves |
| AC 12 | T-34.5-17 | Unit | P0 | SDK errors mapped to provider-level errors |
| AC 13 | (getMinaContext) | Unit | P1 | getMinaContext returns zkAppAddress, tokenId, network, signerAddress |

### Additional Edge Case / Negative Tests

| Test ID | Scenario | Level | Priority |
|---------|----------|-------|----------|
| T-34.5-09 | Archive node unavailability handled gracefully | Unit | P1 |
| T-34.5-10 | Concurrent claims manage nonces correctly | Unit | P1 |
| (EVM fields) | _warnIfEVMFields logs warning for lockedAmount/locksRoot | Unit | P1 |
| (constructor) | Constructor validation -- empty chainId, missing SDK | Unit | P0 |
| (safeBigInt) | Invalid amount string throws descriptive error | Unit | P1 |
| (factory) | createMinaProviderFactory validates chainType, creates provider | Unit | P0 |
| (factory-reject) | Factory rejects non-mina config | Unit | P1 |

### Red Phase Design

All tests will fail before implementation because:
- `MinaPaymentChannelProvider` class does not exist yet
- `createMinaProviderFactory` function does not exist yet
- Import of the module will fail (file not created)

Tests are written against the expected public API, importing from the not-yet-created `mina-payment-channel-provider.ts` file.

---

## Failing Tests Created (RED Phase)

### Unit Tests (45 tests)

**File:** `packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts` (1038 lines)

- **Test:** interface implementation (T-34.5-01) -- should implement PaymentChannelProvider interface
  - **Status:** RED - Cannot find module './mina-payment-channel-provider'
  - **Verifies:** All interface methods exist and type-check

- **Test:** chainType equals mina (T-34.5-02)
  - **Status:** RED - Module not found
  - **Verifies:** chainType='mina', chainId='mina:devnet'

- **Test:** openChannel delegates to SDK (T-34.5-03)
  - **Status:** RED - Module not found
  - **Verifies:** SDK delegation, OpenChannelResult format, logging

- **Test:** signBalanceProof delegates to SDK (T-34.5-04)
  - **Status:** RED - Module not found
  - **Verifies:** Poseidon commitment generation, EVM field warnings

- **Test:** verifyBalanceProof validates proof (T-34.5-05)
  - **Status:** RED - Module not found
  - **Verifies:** Returns true for valid, false for invalid proofs

- **Test:** claimFromChannel delegation (T-34.5-06)
  - **Status:** RED - Module not found
  - **Verifies:** SDK delegation, async proof generation, EVM field warnings

- **Test:** getChannelState translation (T-34.5-07)
  - **Status:** RED - Module not found
  - **Verifies:** Mina states OPEN/CLOSING/SETTLED mapped to opened/closed/settled

- **Test:** async proof generation non-blocking (T-34.5-08)
  - **Status:** RED - Module not found
  - **Verifies:** claimFromChannel returns Promise, does not block other operations

- **Test:** archive node unavailability (T-34.5-09)
  - **Status:** RED - Module not found
  - **Verifies:** Network errors wrapped with provider context

- **Test:** concurrent claims (T-34.5-10)
  - **Status:** RED - Module not found
  - **Verifies:** Multiple concurrent claims resolve without nonce conflicts

- **Test:** subscribeToEvents emits events (T-34.5-11)
  - **Status:** RED - Module not found
  - **Verifies:** channel_opened, channel_deposited, channel_claimed, channel_closed, channel_settled

- **Test:** unsubscribe cleans up (T-34.5-12)
  - **Status:** RED - Module not found
  - **Verifies:** SDK subscription cleaned up, no events after unsubscribe

- **Test:** ChainProviderRegistry integration (T-34.5-13)
  - **Status:** RED - Module not found
  - **Verifies:** Provider registerable and retrievable by chainId

- **Test:** getProviderForPeer resolves Mina (T-34.5-14)
  - **Status:** RED - Module not found
  - **Verifies:** Registry resolves Mina provider for Mina-configured peers

- **Test:** delegation methods (T-34.5-15)
  - **Status:** RED - Module not found
  - **Verifies:** deposit, closeChannel, settleChannel delegate correctly; invalid amount error

- **Test:** zkApp pre-compilation (T-34.5-16)
  - **Status:** RED - Module not found
  - **Verifies:** compileContract called during init; compilation errors handled

- **Test:** error mapping (T-34.5-17)
  - **Status:** RED - Module not found
  - **Verifies:** SDK errors wrapped with chainId, method, channelId; cause preserved

- **Test:** constructor validation (additional)
  - **Status:** RED - Module not found
  - **Verifies:** Empty chainId and zkAppAddress throw

- **Test:** getMinaContext (AC 13)
  - **Status:** RED - Module not found
  - **Verifies:** Returns zkAppAddress, tokenId, network, signerAddress

- **Test:** createMinaProviderFactory (additional)
  - **Status:** RED - Module not found
  - **Verifies:** Factory creation, non-mina rejection, config-driven creation, registry integration

- **Test:** EVM field warnings (additional)
  - **Status:** RED - Module not found
  - **Verifies:** No warning for zero lockedAmount/empty locksRoot

---

## Data Factories Created

N/A -- This story uses inline mock factories defined in the test file:

- `createMockLogger()` -- Mock Pino logger with silent level
- `createMockSDK()` -- Mock MinaPaymentChannelSDK with all methods as jest.fn()
- `createSampleMinaChannelState(overrides?)` -- Mina channel state with overridable fields

---

## Fixtures Created

N/A -- No separate fixture files needed. All test infrastructure is self-contained in the test file, following the co-located test pattern established by `solana-payment-channel-provider.test.ts`.

---

## Mock Requirements

### MinaPaymentChannelSDK Mock

**Type:** In-file mock object (no separate mock file)

**Methods mocked:**
- `openChannel` -- Returns `{ zkAppAddress, txHash }`
- `deposit` -- Returns `{ txHash }`
- `claimFromChannel` -- Returns `{ txHash }` (can simulate slow proof generation)
- `closeChannel` -- Returns `{ txHash }`
- `settleChannel` -- Returns `{ txHash }`
- `getChannelState` -- Returns `MockMinaChannelState`
- `getChannelEvents` -- Returns event array
- `signBalanceProof` -- Returns serialized proof string
- `verifyBalanceProof` -- Returns boolean
- `compileContract` -- Returns void (resolves immediately)
- `subscribeToChannel` -- Returns `{ unsubscribe }` and captures callback

**Notes:** The real MinaPaymentChannelSDK (Story 34.4) must be completed before tests can move to GREEN phase. No o1js imports in test file.

---

## Required data-testid Attributes

N/A -- This is a backend-only story with no UI components.

---

## Implementation Checklist

### Test: Interface implementation (T-34.5-01, T-34.5-02)

**File:** `packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Create `packages/connector/src/settlement/provider/mina-payment-channel-provider.ts`
- [ ] Implement `class MinaPaymentChannelProvider implements PaymentChannelProvider`
- [ ] Set `readonly chainType: BlockchainType = 'mina'`
- [ ] Set `readonly chainId: string` from constructor
- [ ] Constructor accepts: `MinaPaymentChannelSDK`, `chainId`, `zkAppAddress`, `signerKey`, `logger`, optional `{ tokenId, network }`
- [ ] Run test: `npx jest packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts -t "interface implementation"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: openChannel delegation (T-34.5-03)

**File:** `packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Implement `openChannel(participant, settlementTimeout)` method
- [ ] Delegate to `MinaPaymentChannelSDK.openChannel()`
- [ ] Return `{ channelId: zkAppAddress, txHash }` in `OpenChannelResult` format
- [ ] Log the open channel event with Pino structured logging
- [ ] Run test: `npx jest packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts -t "openChannel"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: signBalanceProof and verifyBalanceProof (T-34.5-04, T-34.5-05)

**File:** `packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Implement `signBalanceProof(params)` -- delegate to SDK for Poseidon commitment
- [ ] Implement `verifyBalanceProof(params)` -- verify via SDK, return boolean
- [ ] Implement `_warnIfEVMFields()` -- warn about lockedAmount/locksRoot
- [ ] Run test: `npx jest packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts -t "signBalanceProof|verifyBalanceProof"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: claimFromChannel and async proof (T-34.5-06, T-34.5-08)

**File:** `packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Implement `claimFromChannel(channelId, balanceProof, signature)` -- delegate to SDK
- [ ] Ensure method returns Promise that resolves asynchronously (non-blocking)
- [ ] Call `_warnIfEVMFields()` before delegation
- [ ] Run test: `npx jest packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts -t "claimFromChannel|async proof"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: getChannelState translation (T-34.5-07)

**File:** `packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Implement `getChannelState(channelId)` -- delegate to SDK
- [ ] Implement `_toProviderChannelState()` helper -- map Mina states: 1->opened, 2->closed, 3->settled
- [ ] Map participants and depositTotal to ProviderChannelState
- [ ] Run test: `npx jest packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts -t "getChannelState"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: subscribeToEvents and unsubscribe (T-34.5-11, T-34.5-12)

**File:** `packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Implement `subscribeToEvents(channelId, callback)` -- delegate to SDK polling
- [ ] Implement `_diffState()` -- diff previous/current state to determine event type
- [ ] Handle state transitions: opened, deposited, claimed, closed, settled
- [ ] Return `{ unsubscribe }` handle; stop emitting after unsubscribe
- [ ] Run test: `npx jest packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts -t "subscribeToEvents|unsubscribe"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 1 hour

---

### Test: Registry integration (T-34.5-13, T-34.5-14)

**File:** `packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Ensure MinaPaymentChannelProvider has correct `chainType` and `chainId` for registry
- [ ] No changes to ChainProviderRegistry needed (it is chain-agnostic)
- [ ] Run test: `npx jest packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts -t "ChainProviderRegistry|getProviderForPeer"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 0.25 hours

---

### Test: Delegation methods (T-34.5-15)

**File:** `packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Implement `deposit(channelId, amount)` -- convert string to bigint via `safeBigInt()`
- [ ] Implement `closeChannel(channelId)` -- delegate to SDK
- [ ] Implement `settleChannel(channelId)` -- delegate to SDK
- [ ] Implement `safeBigInt()` helper -- descriptive errors for invalid amounts
- [ ] Run test: `npx jest packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts -t "delegation methods"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: zkApp pre-compilation (T-34.5-16)

**File:** `packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Call `sdk.compileContract()` during provider initialization (constructor or static factory)
- [ ] Handle compilation errors gracefully with logging
- [ ] Run test: `npx jest packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts -t "pre-compilation"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 0.25 hours

---

### Test: Error mapping (T-34.5-17)

**File:** `packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Implement `_wrapError()` -- wrap SDK errors with chainId, method, channelId
- [ ] Preserve original error as `cause`
- [ ] Apply `_wrapError()` in all delegation methods' catch blocks
- [ ] Run test: `npx jest packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts -t "error mapping"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 0.25 hours

---

### Test: Constructor, getMinaContext, factory (additional)

**File:** `packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Constructor validates chainId and zkAppAddress are not empty
- [ ] Implement `getMinaContext()` -- returns { zkAppAddress, tokenId, network, signerAddress }
- [ ] Implement `createMinaProviderFactory(logger, signerKey)` -- validates chainType, creates SDK
- [ ] Expand `MinaProviderConfig` with `keyId`, `tokenId`, `network` fields
- [ ] Update barrel exports in `packages/connector/src/settlement/provider/index.ts`
- [ ] Run test: `npx jest packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts -t "constructor|getMinaContext|factory"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 1 hour

---

## Running Tests

```bash
# Run all failing tests for this story
npx jest --config packages/connector/jest.config.js packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts --no-coverage

# Run specific test by pattern
npx jest --config packages/connector/jest.config.js packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts -t "openChannel" --no-coverage

# Run with verbose output
npx jest --config packages/connector/jest.config.js packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts --verbose --no-coverage

# Run with coverage
npx jest --config packages/connector/jest.config.js packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts

# Run all provider tests (regression check)
npx jest --config packages/connector/jest.config.js packages/connector/src/settlement/provider/ --no-coverage
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

**TEA Agent Responsibilities:**

- All 45 tests written with `it.skip()` and failing (module not found)
- Mock SDK factory created with all required methods
- Mock Mina channel state factory with overrides support
- Implementation checklist created with per-test tasks
- Test file follows existing Solana provider test patterns exactly

**Verification:**

```
Test Suites: 1 failed, 1 total
Tests:       0 total (all skipped, module not found)
Error: TS2307: Cannot find module './mina-payment-channel-provider'
```

- Tests fail due to missing implementation module, not test bugs
- Failure message is clear: module does not exist yet

---

### GREEN Phase (DEV Team - Next Steps)

**DEV Agent Responsibilities:**

1. **Implement Story 34.4 first** (MinaPaymentChannelSDK) if not yet done
2. **Create** `mina-payment-channel-provider.ts` with class skeleton
3. **Remove `it.skip()`** from one test group at a time
4. **Implement minimal code** to make that test pass
5. **Run test** to verify green
6. **Move to next test group** and repeat
7. **Update barrel exports** in `index.ts`
8. **Expand MinaProviderConfig** in `payment-channel-provider.ts`

**Recommended order:**
1. Constructor + chainType/chainId (T-34.5-01, T-34.5-02)
2. Error mapping (T-34.5-17) -- needed by all other methods
3. Delegation methods (T-34.5-03, T-34.5-15) -- openChannel, deposit, close, settle
4. Balance proof methods (T-34.5-04, T-34.5-05)
5. claimFromChannel + async (T-34.5-06, T-34.5-08)
6. getChannelState (T-34.5-07)
7. subscribeToEvents (T-34.5-11, T-34.5-12)
8. zkApp pre-compilation (T-34.5-16)
9. getMinaContext (AC 13)
10. Factory function + registry integration (T-34.5-13, T-34.5-14)

---

### REFACTOR Phase (DEV Team - After All Tests Pass)

1. Verify all 45 tests pass (green phase complete)
2. Review code for patterns consistent with SolanaPaymentChannelProvider
3. Ensure no duplicate logic -- extract shared helpers if needed
4. Run full regression: `make test`
5. Clean build: `npm run build --workspace=packages/shared && npm run build --workspace=packages/connector`

---

## Next Steps

1. **Implement Story 34.4** (MinaPaymentChannelSDK) if not yet done -- this story depends on it
2. **Run failing tests** to confirm RED phase: `npx jest --config packages/connector/jest.config.js packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts --no-coverage`
3. **Begin implementation** using implementation checklist as guide
4. **Work one test group at a time** (red -> green for each)
5. **Run regression** after all tests pass: `make test`
6. **When all tests pass**, refactor code for quality
7. **Commit** with: `feat(34-5): Implement MinaPaymentChannelProvider`

---

## Knowledge Base References Applied

- **test-quality.md** -- Given-When-Then format, one assertion per test, determinism, isolation
- **data-factories.md** -- Factory patterns with overrides support (createSampleMinaChannelState)
- **test-levels-framework.md** -- Test level selection (unit with mocked SDK for backend)
- **test-priorities-matrix.md** -- P0/P1 priority assignment based on risk

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `npx jest --config packages/connector/jest.config.js packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts --no-coverage`

**Results:**

```
FAIL connector packages/connector/src/settlement/provider/mina-payment-channel-provider.test.ts
  Test suite failed to run
    TS2307: Cannot find module './mina-payment-channel-provider' or its corresponding type declarations.

Test Suites: 1 failed, 1 total
Tests:       0 total
Time:        1.289 s
```

**Summary:**

- Total tests: 45 (all `it.skip()`)
- Passing: 0 (expected)
- Failing: 1 suite (module not found -- expected)
- Status: RED phase verified

**Regression Check:**

```
Solana provider tests: 49 passed, 49 total -- no regression
```

---

## Notes

- Story 34.4 (MinaPaymentChannelSDK) MUST be completed before moving to GREEN phase -- the provider wraps the SDK
- The test file is 1038 lines, following the ~1180-line Solana provider test pattern
- All tests use `it.skip()` for clean RED phase -- remove skip one at a time during GREEN phase
- The mock SDK interface matches the expected Story 34.4 API surface
- No o1js imports in the test file -- all Mina-specific logic abstracted behind SDK mock
- `MinaProviderConfig` expansion (keyId, tokenId, network) uses `as ProviderConfig` cast in factory tests to avoid compilation errors before the type is expanded

---

**Generated by BMad TEA Agent** - 2026-03-27
