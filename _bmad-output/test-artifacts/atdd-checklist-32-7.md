---
stepsCompleted:
  - 'step-01-preflight-and-context'
  - 'step-02-generation-mode'
  - 'step-03-test-strategy'
  - 'step-04-generate-tests'
  - 'step-05-validate-and-complete'
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-03-25'
workflowType: 'testarch-atdd'
inputDocuments:
  - '_bmad-output/implementation-artifacts/story-32-7.md'
  - 'packages/connector/src/config/types.ts'
  - 'packages/connector/src/settlement/types.ts'
  - 'packages/connector/src/settlement/provider/payment-channel-provider.ts'
  - 'packages/connector/src/settlement/provider/chain-provider-registry.ts'
  - 'packages/connector/src/core/connector-node.ts'
---

# ATDD Checklist - Epic 32, Story 32.7: Update Configuration Schema

**Date:** 2026-03-25
**Author:** Jonathan
**Primary Test Level:** Unit

---

## Story Summary

This story adds multi-chain provider configuration support to the connector, allowing operators to configure multiple blockchain providers via a `chainProviders` YAML section and assign peers to specific chains via a `chain` field. Legacy `settlementInfra`-only configs continue to work with a deprecation warning.

**As a** connector operator
**I want** the connector configuration schema to support multi-chain provider configuration with per-peer chain selection while maintaining backward compatibility
**So that** deploying multi-chain settlement requires only configuration changes, not code modifications

---

## Acceptance Criteria

1. **AC 1**: Multi-chain provider configuration - `chainProviders` section accepts array of provider configs with per-chain-type validation
2. **AC 2**: Per-peer chain selection - `PeerConfig.chain` field references a registered provider's chainId
3. **AC 3**: Backward compatibility - Legacy configs without `chainProviders` auto-create EVM provider from `settlementInfra`
4. **AC 4**: PeerConfig settlement preference updated - `settlementPreference` extended with 'solana', 'mina' values
5. **AC 5**: Validation rejects unknown chain types
6. **AC 6**: Validation rejects duplicate chain IDs
7. **AC 7**: Validation rejects peer referencing unregistered chain

---

## Failing Tests Created (RED Phase)

### Unit Tests (22 tests)

**File:** `packages/connector/src/config/chain-provider-config.test.ts` (410 lines)

- **Test:** T-32.7-01a: should accept an array of valid EVM provider configurations
  - **Status:** RED - `it.skip()` (chainProviders field not yet on ConnectorConfig)
  - **Verifies:** AC 1 - chainProviders accepts valid EVM provider array

- **Test:** T-32.7-01b: should accept mixed chain type provider configurations
  - **Status:** RED - `it.skip()` (chainProviders field not yet on ConnectorConfig)
  - **Verifies:** AC 1 - chainProviders accepts EVM, Solana, Mina mix

- **Test:** T-32.7-02a: should accept a peer with a chain field referencing a registered provider
  - **Status:** RED - `it.skip()` (chain field not yet on PeerConfig, validateChainProviders not exported)
  - **Verifies:** AC 2 - peer.chain references valid chainProviders entry

- **Test:** T-32.7-02b: should accept a peer without a chain field (defaults to legacy behavior)
  - **Status:** RED - `it.skip()` (chain field not yet on PeerConfig)
  - **Verifies:** AC 2 - absent chain field defaults to legacy behavior

- **Test:** T-32.7-03: should accept legacy config with no chainProviders (only settlementInfra)
  - **Status:** RED - `it.skip()` (validateChainProviders not yet exported)
  - **Verifies:** AC 3 - backward compatibility with legacy configs

- **Test:** T-32.7-04: should throw error for unknown chainType in chainProviders
  - **Status:** RED - `it.skip()` (validateChainProviders not yet exported)
  - **Verifies:** AC 5 - rejects unknown chain types with correct error message

- **Test:** T-32.7-05a: should throw error when peer references a chain not in chainProviders
  - **Status:** RED - `it.skip()` (validateChainProviders not yet exported)
  - **Verifies:** AC 7 - rejects peer referencing unregistered chain

- **Test:** T-32.7-05b: should not throw when peer has no chain field and legacy settlementInfra is present
  - **Status:** RED - `it.skip()` (validateChainProviders not yet exported)
  - **Verifies:** AC 7 - legacy peers without chain field are valid

- **Test:** T-32.7-06: should log deprecation warning when settlementInfra is used without chainProviders
  - **Status:** RED - `it.skip()` (validateChainProviders not yet exported)
  - **Verifies:** AC 3 - deprecation warning for legacy path

- **Test:** T-32.7-07a: should accept "solana" as a valid settlementPreference
  - **Status:** RED - `it.skip()` (settlementPreference union not yet extended)
  - **Verifies:** AC 4 - 'solana' added to settlementPreference

- **Test:** T-32.7-07b: should accept "mina" as a valid settlementPreference
  - **Status:** RED - `it.skip()` (settlementPreference union not yet extended)
  - **Verifies:** AC 4 - 'mina' added to settlementPreference

- **Test:** T-32.7-07c: should still accept existing values: evm, any, both
  - **Status:** RED - `it.skip()` (verifies backward compatibility of existing values)
  - **Verifies:** AC 4 - existing values unchanged

- **Test:** T-32.7-08: should throw error when chainProviders contains duplicate chainId values
  - **Status:** RED - `it.skip()` (validateChainProviders not yet exported)
  - **Verifies:** AC 6 - rejects duplicate chainId

- **Test:** T-32.7-09a: should throw error when EVM config is missing registryAddress
  - **Status:** RED - `it.skip()` (validateChainProviders not yet exported)
  - **Verifies:** AC 1 - EVM required field validation

- **Test:** T-32.7-09b: should throw error when EVM config is missing keyId
  - **Status:** RED - `it.skip()` (validateChainProviders not yet exported)
  - **Verifies:** AC 1 - EVM required field validation

- **Test:** T-32.7-09c: should throw error when EVM config is missing rpcUrl
  - **Status:** RED - `it.skip()` (validateChainProviders not yet exported)
  - **Verifies:** AC 1 - EVM required field validation

- **Test:** T-32.7-09d: should throw error when Solana config is missing programId
  - **Status:** RED - `it.skip()` (validateChainProviders not yet exported)
  - **Verifies:** AC 1 - Solana required field validation

- **Test:** T-32.7-09e: should throw error when Mina config is missing zkAppAddress
  - **Status:** RED - `it.skip()` (validateChainProviders not yet exported)
  - **Verifies:** AC 1 - Mina required field validation

- **Test:** T-32.7-10a: should export ChainProviderConfigEntry type from config/types
  - **Status:** RED - `it.skip()` (ChainProviderConfigEntry not yet defined)
  - **Verifies:** AC 1 - type export exists

- **Test:** T-32.7-10b: should compile ChainProviderConfigEntry with EVMProviderConfig subtype
  - **Status:** RED - `it.skip()` (ChainProviderConfigEntry not yet defined)
  - **Verifies:** AC 1 - EVM subtype compile check

- **Test:** T-32.7-10c: should compile ChainProviderConfigEntry with SolanaProviderConfig subtype
  - **Status:** RED - `it.skip()` (ChainProviderConfigEntry not yet defined)
  - **Verifies:** AC 1 - Solana subtype compile check

- **Test:** T-32.7-10d: should compile ChainProviderConfigEntry with MinaProviderConfig subtype
  - **Status:** RED - `it.skip()` (ChainProviderConfigEntry not yet defined)
  - **Verifies:** AC 1 - Mina subtype compile check

---

## Data Factories Created

N/A - This story tests configuration types and validation functions. Config objects are constructed inline as plain objects. No external entity factories needed.

---

## Fixtures Created

N/A - Unit tests for configuration validation do not require test fixtures with setup/teardown. A `baseConfig` helper object is defined inline in the test file.

---

## Mock Requirements

### Logger Mock

**Type:** In-memory Jest mock object

**Shape:**

```typescript
const mockLogger = {
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
};
```

**Used by:** T-32.7-06 (deprecation warning test)

**Notes:** The `validateChainProviders` function must accept an optional logger parameter to enable testing of deprecation warnings.

---

## Required data-testid Attributes

N/A - This story is backend-only (configuration types and validation). No UI components are involved.

---

## Implementation Checklist

### Test: T-32.7-01 (chainProviders accepts valid provider configs)

**File:** `packages/connector/src/config/chain-provider-config.test.ts`

**Tasks to make this test pass:**

- [ ] Add `ChainProviderConfigEntry` type to `config/types.ts`: `ProviderConfig & { chainId: string }`
- [ ] Import `ProviderConfig` from `settlement/provider/payment-channel-provider`
- [ ] Add optional `chainProviders?: ChainProviderConfigEntry[]` field to `ConnectorConfig`
- [ ] Add JSDoc with YAML example for single-chain and multi-chain configs
- [ ] Remove `it.skip()` from T-32.7-01 tests
- [ ] Run test: `npx jest packages/connector/src/config/chain-provider-config.test.ts -t "T-32.7-01"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: T-32.7-02 (per-peer chain field)

**File:** `packages/connector/src/config/chain-provider-config.test.ts`

**Tasks to make this test pass:**

- [ ] Add optional `chain?: string` field to `PeerConfig` in `config/types.ts`
- [ ] Add JSDoc: "Chain reference linking peer to a registered provider's chainId"
- [ ] Export `validateChainProviders` function from `config/types.ts`
- [ ] Implement validation: peer.chain must reference a chainId in chainProviders
- [ ] Remove `it.skip()` from T-32.7-02 tests
- [ ] Run test: `npx jest packages/connector/src/config/chain-provider-config.test.ts -t "T-32.7-02"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: T-32.7-03 (legacy backward compatibility)

**File:** `packages/connector/src/config/chain-provider-config.test.ts`

**Tasks to make this test pass:**

- [ ] In `validateChainProviders`, handle case where `chainProviders` is absent
- [ ] Accept legacy `settlementInfra`-only config as valid
- [ ] Remove `it.skip()` from T-32.7-03 test
- [ ] Run test: `npx jest packages/connector/src/config/chain-provider-config.test.ts -t "T-32.7-03"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.25 hours

---

### Test: T-32.7-04 (rejects unknown chainType)

**File:** `packages/connector/src/config/chain-provider-config.test.ts`

**Tasks to make this test pass:**

- [ ] In `validateChainProviders`, validate each entry's chainType is a known BlockchainType
- [ ] Throw `Error('Unknown chain type: ${chainType}')` for unknown types
- [ ] Remove `it.skip()` from T-32.7-04 test
- [ ] Run test: `npx jest packages/connector/src/config/chain-provider-config.test.ts -t "T-32.7-04"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.25 hours

---

### Test: T-32.7-05 (rejects unregistered chain reference)

**File:** `packages/connector/src/config/chain-provider-config.test.ts`

**Tasks to make this test pass:**

- [ ] In `validateChainProviders`, validate each peer's `chain` references a valid chainId
- [ ] Allow peers without `chain` field when `settlementInfra` is present
- [ ] Throw descriptive error for unregistered chain references
- [ ] Remove `it.skip()` from T-32.7-05 tests
- [ ] Run test: `npx jest packages/connector/src/config/chain-provider-config.test.ts -t "T-32.7-05"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: T-32.7-06 (deprecation warning)

**File:** `packages/connector/src/config/chain-provider-config.test.ts`

**Tasks to make this test pass:**

- [ ] Add optional `logger` parameter to `validateChainProviders`
- [ ] Log `logger.warn({ event: 'config_deprecation' }, 'settlementInfra is deprecated...')` when settlementInfra used without chainProviders
- [ ] Remove `it.skip()` from T-32.7-06 test
- [ ] Run test: `npx jest packages/connector/src/config/chain-provider-config.test.ts -t "T-32.7-06"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.25 hours

---

### Test: T-32.7-07 (settlementPreference chain-specific values)

**File:** `packages/connector/src/config/chain-provider-config.test.ts`

**Tasks to make this test pass:**

- [ ] Extend `settlementPreference` union in `settlement/types.ts` from `'evm' | 'any' | 'both'` to `'evm' | 'solana' | 'mina' | 'any' | 'both'`
- [ ] Update JSDoc to document chain-specific values
- [ ] Keep `'both'` as deprecated alias for `'any'`
- [ ] Remove `it.skip()` from T-32.7-07 tests
- [ ] Run test: `npx jest packages/connector/src/config/chain-provider-config.test.ts -t "T-32.7-07"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.25 hours

---

### Test: T-32.7-08 (duplicate chainId rejected)

**File:** `packages/connector/src/config/chain-provider-config.test.ts`

**Tasks to make this test pass:**

- [ ] In `validateChainProviders`, check for duplicate `chainId` values
- [ ] Throw `Error('Duplicate chainId: ${chainId}')` for duplicates
- [ ] Remove `it.skip()` from T-32.7-08 test
- [ ] Run test: `npx jest packages/connector/src/config/chain-provider-config.test.ts -t "T-32.7-08"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.25 hours

---

### Test: T-32.7-09 (EVM config required field validation)

**File:** `packages/connector/src/config/chain-provider-config.test.ts`

**Tasks to make this test pass:**

- [ ] In `validateChainProviders`, validate per-chain required fields:
  - EVM: `rpcUrl`, `registryAddress`, `keyId`
  - Solana: `rpcUrl`, `programId`
  - Mina: `graphqlUrl`, `zkAppAddress`
- [ ] Throw descriptive error for missing required fields
- [ ] Remove `it.skip()` from T-32.7-09 tests
- [ ] Run test: `npx jest packages/connector/src/config/chain-provider-config.test.ts -t "T-32.7-09"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: T-32.7-10 (ChainProviderConfigEntry type compilation)

**File:** `packages/connector/src/config/chain-provider-config.test.ts`

**Tasks to make this test pass:**

- [ ] Verify `ChainProviderConfigEntry` is exported from `config/types.ts`
- [ ] Verify type compiles with all three ProviderConfig subtypes
- [ ] Remove `it.skip()` from T-32.7-10 tests
- [ ] Run test: `npx jest packages/connector/src/config/chain-provider-config.test.ts -t "T-32.7-10"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.25 hours

---

## Running Tests

```bash
# Run all failing tests for this story
npx jest --config packages/connector/jest.config.js packages/connector/src/config/chain-provider-config.test.ts --no-coverage

# Run specific test group
npx jest --config packages/connector/jest.config.js packages/connector/src/config/chain-provider-config.test.ts -t "T-32.7-01" --no-coverage

# Run with verbose output
npx jest --config packages/connector/jest.config.js packages/connector/src/config/chain-provider-config.test.ts --verbose --no-coverage

# Run full test suite (regression check)
npx jest --config packages/connector/jest.config.js --no-coverage
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

**TEA Agent Responsibilities:**

- All 22 tests written and skipped (it.skip)
- Test file compiles without errors
- No data factories needed (config objects inline)
- No fixtures needed (pure unit tests)
- Mock requirements documented (logger mock for T-32.7-06)
- Implementation checklist created

**Verification:**

- All tests run and show as skipped (22 skipped, 0 failed)
- Test suite compiles successfully with ts-jest
- Existing test suite unaffected (80 passed, 5 pre-existing skipped, 1 pre-existing flaky)

---

### GREEN Phase (DEV Team - Next Steps)

**DEV Agent Responsibilities:**

1. **Pick one failing test** from implementation checklist (start with T-32.7-01)
2. **Read the test** to understand expected behavior
3. **Implement minimal code** to make that specific test pass
4. **Run the test** to verify it now passes (green)
5. **Check off the task** in implementation checklist
6. **Move to next test** and repeat

**Recommended order:**

1. T-32.7-10 (type definition - foundational)
2. T-32.7-01 (chainProviders on ConnectorConfig)
3. T-32.7-02 (chain field on PeerConfig)
4. T-32.7-07 (settlementPreference extension)
5. T-32.7-04 (unknown chainType validation)
6. T-32.7-08 (duplicate chainId validation)
7. T-32.7-09 (required field validation)
8. T-32.7-05 (unregistered chain reference validation)
9. T-32.7-03 (legacy backward compatibility)
10. T-32.7-06 (deprecation warning)

---

### REFACTOR Phase (DEV Team - After All Tests Pass)

**DEV Agent Responsibilities:**

1. Verify all tests pass (green phase complete)
2. Review `validateChainProviders` for readability
3. Ensure connector-node.ts integration is clean
4. Run `npm run typecheck` and `npm run lint`
5. Run full test suite for regression

---

## Next Steps

1. **Review this checklist** and the failing test file
2. **Run failing tests** to confirm RED phase: `npx jest --config packages/connector/jest.config.js packages/connector/src/config/chain-provider-config.test.ts --no-coverage`
3. **Begin implementation** using implementation checklist as guide
4. **Work one test at a time** (red -> green for each)
5. **When all tests pass**, refactor code for quality
6. **When refactoring complete**, commit with `feat(32-7): update configuration schema for multi-chain providers`

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `npx jest --config packages/connector/jest.config.js packages/connector/src/config/chain-provider-config.test.ts --no-coverage`

**Results:**

```
Test Suites: 1 skipped, 0 of 1 total
Tests:       22 skipped, 22 total
Snapshots:   0 total
Time:        1.022 s
```

**Summary:**

- Total tests: 22
- Passing: 0 (expected)
- Skipped: 22 (expected - all it.skip)
- Failing: 0 (tests skip cleanly, no compile errors)
- Status: RED phase verified

---

## Notes

- All tests use `Record<string, unknown>` or plain objects instead of `ConnectorConfig` type to avoid compile errors for fields that don't exist yet
- The `validateChainProviders` function is expected to be exported from `config/types.ts` (or a new `config/chain-provider-config.ts` file)
- T-32.7-06 requires `validateChainProviders` to accept an optional logger parameter for testability
- The settlement-api.test.ts ECONNRESET failure is a pre-existing flaky test, not related to this story

---

**Generated by BMad TEA Agent** - 2026-03-25
