---
stepsCompleted:
  [
    'step-01-preflight-and-context',
    'step-02-generation-mode',
    'step-03-test-strategy',
    'step-04-generate-tests',
    'step-04c-aggregate',
    'step-05-validate-and-complete',
  ]
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-03-25'
workflowType: 'testarch-atdd'
inputDocuments:
  - '_bmad-output/implementation-artifacts/story-32-6.md'
  - 'packages/connector/src/settlement/claim-receiver.ts'
  - 'packages/connector/src/settlement/claim-receiver.test.ts'
  - 'packages/connector/src/settlement/provider/payment-channel-provider.ts'
  - 'packages/connector/src/settlement/provider/chain-provider-registry.ts'
  - 'packages/connector/src/core/connector-node.ts'
  - '_bmad/tea/testarch/knowledge/data-factories.md'
  - '_bmad/tea/testarch/knowledge/test-quality.md'
  - '_bmad/tea/testarch/knowledge/test-levels-framework.md'
  - '_bmad/tea/testarch/knowledge/test-healing-patterns.md'
  - '_bmad/tea/testarch/knowledge/test-priorities-matrix.md'
---

# ATDD Checklist - Epic 32, Story 32.6: Refactor ClaimReceiver for Multi-Chain Verification

**Date:** 2026-03-25
**Author:** Jonathan
**Primary Test Level:** Unit

---

## Story Summary

Refactor ClaimReceiver to dispatch claim verification to the correct PaymentChannelProvider via ChainProviderRegistry based on the blockchain discriminator field, replacing direct PaymentChannelSDK dependencies.

**As a** settlement service developer
**I want** ClaimReceiver to dispatch claim verification to the correct PaymentChannelProvider via ChainProviderRegistry
**So that** claim verification works for any supported blockchain without hardcoded PaymentChannelSDK dependencies

---

## Acceptance Criteria

1. **AC1**: EVM claims verified via EVM provider (registry lookup + provider.verifyBalanceProof)
2. **AC2**: Unknown blockchain type rejected with 'No provider registered for blockchain: {type}' error
3. **AC3**: Dynamic channel verification delegates to provider.getChannelState for on-chain state check
4. **AC4**: Backward compatibility -- existing claim-receiver.test.ts passes with updated mock setup
5. **AC5**: ClaimReceiver constructor no longer imports/references PaymentChannelSDK directly

---

## Test Strategy

### Test Level Selection

| AC  | Test Scenario                                                                          | Level | Priority | Red Phase Failure Reason                                       |
| --- | -------------------------------------------------------------------------------------- | ----- | -------- | -------------------------------------------------------------- |
| AC1 | EVM claim verified via provider.verifyBalanceProof (known channel)                     | Unit  | P0       | ClaimReceiver still uses PaymentChannelSDK, not provider       |
| AC1 | CLAIM_RECEIVED event emitted after successful verification                             | Unit  | P0       | Constructor signature mismatch                                 |
| AC2 | Unknown blockchain type rejected with error message                                    | Unit  | P0       | No NO_PROVIDER_REGISTERED error constant, no registry dispatch |
| AC2 | Claim persisted with verified=false when provider not found                            | Unit  | P0       | No registry-based dispatch logic                               |
| AC3 | Dynamic verification delegates to provider.getChannelState                             | Unit  | P1       | Still calls SDK.getChannelStateByNetwork                       |
| AC3 | Dynamic verification: channel non-existent results in rejection                        | Unit  | P1       | Still uses SDK method                                          |
| AC3 | Dynamic verification: channel not opened results in rejection                          | Unit  | P1       | Still uses SDK method                                          |
| AC3 | Dynamic verification: signer not in participants results in rejection                  | Unit  | P1       | Still uses SDK method                                          |
| AC3 | Dynamic verification: signature via provider.verifyBalanceProof                        | Unit  | P1       | Still calls SDK.verifyBalanceProofWithDomain                   |
| AC4 | Existing valid EVM claim verified and stored verified=true                             | Unit  | P0       | Constructor takes registry, not SDK                            |
| AC4 | Invalid signature stored verified=false                                                | Unit  | P0       | Constructor mismatch                                           |
| AC4 | Nonce monotonicity check rejects non-increasing nonce                                  | Unit  | P0       | Constructor mismatch                                           |
| AC4 | Idempotent duplicate message handling                                                  | Unit  | P0       | Constructor mismatch                                           |
| AC5 | ClaimReceiver constructor accepts ChainProviderRegistry                                | Unit  | P1       | Constructor still expects PaymentChannelSDK                    |
| AC1 | Provider.verifyBalanceProof receives VerifyBalanceProofParams (object, string amounts) | Unit  | P0       | Still passes positional args with bigint                       |

### Strategy Rationale

- **All Unit tests**: This is a pure backend refactoring story. ClaimReceiver is a service class with injected dependencies. All behavior can be verified through unit tests with mock dependencies (mock registry, mock provider, mock DB).
- **No Integration/E2E tests**: No database schema changes, no API surface changes, no UI components involved. The wiring change in connector-node.ts is verified by typecheck, not by runtime integration tests.
- **P0 for core verification path**: Claim verification is a critical settlement path -- all inbound claims must be verified before consumption.
- **P1 for dynamic verification**: Dynamic channel verification is important but secondary to the core known-channel verification path.

---

## Failing Tests Created (RED Phase)

### Unit Tests (23 tests)

**File:** `packages/connector/src/settlement/claim-receiver.atdd.test.ts` (530 lines)

**AC5: Constructor accepts ChainProviderRegistry**

- **Test:** `[P1] should accept ChainProviderRegistry instead of PaymentChannelSDK`
  - **Status:** RED - Constructor still expects PaymentChannelSDK parameter
  - **Verifies:** AC5 - ClaimReceiver no longer depends on PaymentChannelSDK

- **Test:** `[P1] should accept registry with channelManager and peerIdToAddressMap`
  - **Status:** RED - Constructor signature mismatch
  - **Verifies:** AC5 - Full constructor parameter set works with registry

**AC1: EVM claims verified via provider**

- **Test:** `[P0] should verify valid EVM claim via provider.verifyBalanceProof and store verified=true`
  - **Status:** RED - Still uses PaymentChannelSDK.verifyBalanceProof
  - **Verifies:** AC1 - Provider delegation for known channel verification

- **Test:** `[P0] should emit CLAIM_RECEIVED event after successful provider verification`
  - **Status:** RED - Constructor mismatch
  - **Verifies:** AC1 - Event emission unchanged after refactoring

- **Test:** `[P0] should persist claim with verified=false when provider rejects signature`
  - **Status:** RED - Constructor mismatch
  - **Verifies:** AC1 - Failed verification persistence

- **Test:** `[P0] should NOT emit CLAIM_RECEIVED event when provider rejects signature`
  - **Status:** RED - Constructor mismatch
  - **Verifies:** AC1 - No event on failure

- **Test:** `[P0] should use VerifyBalanceProofParams with string amounts (not bigint)`
  - **Status:** RED - Still uses bigint conversion and positional args
  - **Verifies:** AC1 - Provider interface uses string amounts in single object

**AC2: Unknown blockchain type rejected**

- **Test:** `[P0] should reject claim with unregistered blockchain type`
  - **Status:** RED - No registry-based dispatch logic
  - **Verifies:** AC2 - Claims rejected when no provider registered

- **Test:** `[P0] should include blockchain name in rejection error message`
  - **Status:** RED - ERRORS.NO_PROVIDER_REGISTERED constant not yet added
  - **Verifies:** AC2 - Error constant exists with correct prefix

**AC4: Nonce monotonicity**

- **Test:** `[P0] should reject EVM claim with non-increasing nonce`
  - **Status:** RED - Constructor mismatch
  - **Verifies:** AC4 - Nonce check unchanged, chain-agnostic

**AC3: Dynamic channel verification via provider**

- **Test:** `[P1] should delegate on-chain state check to provider.getChannelState`
  - **Status:** RED - Still calls SDK.getChannelStateByNetwork
  - **Verifies:** AC3 - Provider delegation for on-chain state

- **Test:** `[P1] should reject when provider.getChannelState throws (channel non-existent)`
  - **Status:** RED - Still uses SDK method
  - **Verifies:** AC3 - Channel non-existence handling via provider

- **Test:** `[P1] should reject when channel status is not opened`
  - **Status:** RED - Still uses numeric state comparison
  - **Verifies:** AC3 - String status comparison ('opened')

- **Test:** `[P1] should reject when signer is not in participants array`
  - **Status:** RED - Still uses participant1/participant2 comparison
  - **Verifies:** AC3 - Participants array check

- **Test:** `[P1] should use provider.verifyBalanceProof for dynamic verification`
  - **Status:** RED - Still calls SDK.verifyBalanceProofWithDomain
  - **Verifies:** AC3 - Provider handles domain internally

- **Test:** `[P1] should register external channel on successful dynamic verification`
  - **Status:** RED - Constructor mismatch
  - **Verifies:** AC3 - Channel registration after verification

- **Test:** `[P1] should resolve provider using claim chainId for dynamic verification`
  - **Status:** RED - No registry lookup logic
  - **Verifies:** AC3 - Provider resolved via evm:${chainId} key

**AC4: Backward compatibility**

- **Test:** `[P0] should handle known channel with pre-registered metadata`
  - **Status:** RED - Constructor mismatch
  - **Verifies:** AC4 - Known channel path uses provider (no getChannelState)

- **Test:** `[P0] should handle duplicate message IDs gracefully (idempotency)`
  - **Status:** RED - Constructor mismatch
  - **Verifies:** AC4 - Idempotency unchanged

- **Test:** `[P0] should handle invalid JSON parsing gracefully`
  - **Status:** RED - Constructor mismatch
  - **Verifies:** AC4 - Error handling unchanged

**peerIdToAddressMap handling**

- **Test:** `[P1] should register peer address from self-describing claim`
  - **Status:** RED - Constructor mismatch
  - **Verifies:** AC1/AC3 - Peer address registration unchanged

- **Test:** `[P1] should NOT overwrite existing peer address`
  - **Status:** RED - Constructor mismatch
  - **Verifies:** AC1/AC3 - Existing entries preserved

**getLatestVerifiedClaim**

- **Test:** `[P0] should return latest verified claim`
  - **Status:** RED - Constructor mismatch
  - **Verifies:** AC4 - Query method unchanged

---

## Mock Requirements

### ChainProviderRegistry Mock

**Type:** `jest.Mocked<Pick<ChainProviderRegistry, 'getProvider' | 'getProviderForPeer' | 'getAllProviders'>>`

**Methods:**

- `getProvider(chainType, chainId)` - Returns mock provider when chainId matches 'evm:31337'
- `getProviderForPeer(peerConfig)` - Returns mock provider
- `getAllProviders()` - Returns array with mock provider

### PaymentChannelProvider Mock

**Type:** `jest.Mocked<PaymentChannelProvider>`

**Methods:**

- `verifyBalanceProof(params: VerifyBalanceProofParams)` - Returns true/false
- `getChannelState(channelId)` - Returns ProviderChannelState
- `chainType: 'evm'`, `chainId: 'evm:31337'`

---

## Implementation Checklist

### Test: Constructor accepts ChainProviderRegistry (AC5)

**File:** `packages/connector/src/settlement/claim-receiver.ts`

**Tasks to make this test pass:**

- [ ] Replace `evmChannelSDK: PaymentChannelSDK` constructor param with `chainProviderRegistry: ChainProviderRegistry`
- [ ] Add import for `ChainProviderRegistry`
- [ ] Add import for `PaymentChannelProvider`, `VerifyBalanceProofParams`
- [ ] Remove `PaymentChannelSDK` import
- [ ] Run test: `npx jest packages/connector/src/settlement/claim-receiver.atdd.test.ts -t "Constructor"`

### Test: EVM claims verified via provider (AC1)

**File:** `packages/connector/src/settlement/claim-receiver.ts`

**Tasks to make this test pass:**

- [ ] Resolve provider from registry based on claim blockchain type and chain key
- [ ] Replace `evmChannelSDK.verifyBalanceProof(balanceProof, sig, addr)` with `provider.verifyBalanceProof(params)`
- [ ] Use VerifyBalanceProofParams object with string amounts (no bigint conversion)
- [ ] Run test: `npx jest packages/connector/src/settlement/claim-receiver.atdd.test.ts -t "AC1"`

### Test: Unknown blockchain rejected (AC2)

**File:** `packages/connector/src/settlement/claim-receiver.ts`

**Tasks to make this test pass:**

- [ ] Add `NO_PROVIDER_REGISTERED` to ERRORS constant
- [ ] Add provider lookup logic in handleClaimMessage
- [ ] Reject with error when no provider found for claim's blockchain type
- [ ] Persist claim with verified=false on rejection
- [ ] Run test: `npx jest packages/connector/src/settlement/claim-receiver.atdd.test.ts -t "AC2"`

### Test: Dynamic verification via provider (AC3)

**File:** `packages/connector/src/settlement/claim-receiver.ts`

**Tasks to make this test pass:**

- [ ] Replace `evmChannelSDK.getChannelStateByNetwork()` with `provider.getChannelState()`
- [ ] Map `ProviderChannelState.status` string check ('opened') instead of numeric state
- [ ] Map `ProviderChannelState.participants` array check instead of participant1/participant2
- [ ] Replace `evmChannelSDK.verifyBalanceProofWithDomain()` with `provider.verifyBalanceProof()`
- [ ] Construct chain key from claim: `evm:${claim.chainId}` for provider lookup
- [ ] Run test: `npx jest packages/connector/src/settlement/claim-receiver.atdd.test.ts -t "AC3"`

### Test: Backward compatibility (AC4)

**File:** `packages/connector/src/settlement/claim-receiver.ts`, `packages/connector/src/settlement/claim-receiver.test.ts`

**Tasks to make this test pass:**

- [ ] Update existing test mocks to use registry + provider pattern
- [ ] Verify all existing behavioral assertions pass
- [ ] Run test: `npx jest packages/connector/src/settlement/claim-receiver.test.ts`

### Test: connector-node.ts wiring (AC5)

**File:** `packages/connector/src/core/connector-node.ts`

**Tasks to make this test pass:**

- [ ] Replace `this._paymentChannelSDK` with `chainRegistry` in ClaimReceiver construction (~line 900)
- [ ] Run test: `npm run typecheck`

---

## Running Tests

```bash
# Run all ATDD failing tests for this story
npx jest packages/connector/src/settlement/claim-receiver.atdd.test.ts --no-coverage

# Run existing claim-receiver tests (regression)
npx jest packages/connector/src/settlement/claim-receiver.test.ts --no-coverage

# Run both test files together
npx jest packages/connector/src/settlement/claim-receiver --no-coverage

# Run with verbose output
npx jest packages/connector/src/settlement/claim-receiver.atdd.test.ts --no-coverage --verbose

# Run typecheck
npm run typecheck

# Run full test suite
npm test
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

**TEA Agent Responsibilities:**

- All 23 ATDD tests written and skipped (failing)
- Mock factories created (createMockProvider, createMockRegistry)
- Implementation checklist created
- Existing 24 tests verified passing (no regression)

**Verification:**

- All 23 tests skip as expected (red phase confirmed)
- Failure reason: Constructor expects PaymentChannelSDK, tests pass ChainProviderRegistry
- Tests fail due to missing implementation, not test bugs

---

### GREEN Phase (DEV Team - Next Steps)

**DEV Agent Responsibilities:**

1. Refactor ClaimReceiver constructor (Task 1 from story)
2. Remove `it.skip` from ATDD tests one group at a time
3. Implement minimal code to make each test group pass
4. Update existing test file mocks (Task 6 from story)
5. Update connector-node.ts wiring (Task 7 from story)
6. Run full test suite to verify no regressions

---

### REFACTOR Phase (DEV Team - After All Tests Pass)

1. Verify all 23 ATDD tests + 24 existing tests pass
2. Remove the `createReceiverWithRegistry` helper (use direct constructor)
3. Run `npm run typecheck` and `npm run lint`
4. Run full test suite

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `npx jest packages/connector/src/settlement/claim-receiver.atdd.test.ts --no-coverage`

**Results:**

```
Test Suites: 1 skipped, 0 of 1 total
Tests:       23 skipped, 23 total
Snapshots:   0 total
Time:        1.148 s
```

**Summary:**

- Total tests: 23
- Passing: 0 (expected)
- Skipped: 23 (expected - red phase)
- Status: RED phase verified

### Existing Tests (Regression Check)

**Command:** `npx jest packages/connector/src/settlement/claim-receiver.test.ts --no-coverage`

**Results:**

```
Test Suites: 1 passed, 1 total
Tests:       24 passed, 24 total
```

- No regressions introduced by ATDD test file

---

## Knowledge Base References Applied

- **data-factories.md** - Factory patterns for mock provider and registry creation with overrides
- **test-quality.md** - Deterministic, isolated tests with explicit assertions
- **test-levels-framework.md** - Unit test level selection for pure backend refactoring
- **test-healing-patterns.md** - Consulted for common failure pattern prevention
- **test-priorities-matrix.md** - P0/P1 priority assignment based on settlement criticality

---

## Notes

- The `createReceiverWithRegistry` helper uses `as any` cast during RED phase to bypass the PaymentChannelSDK type mismatch. After refactoring, this helper should be updated to use the real `ChainProviderRegistry` type (or removed entirely).
- The `ERRORS.NO_PROVIDER_REGISTERED` constant does not exist yet -- it must be added as part of Task 2.1 in the story.
- Tests use `it.skip()` (Jest equivalent of `test.skip()`) to mark them as intentionally pending.
- The existing `claim-receiver.test.ts` file (24 tests) will need its mocks updated as part of Task 6, but the ATDD tests provide the target API specification.

---

**Generated by BMad TEA Agent** - 2026-03-25
