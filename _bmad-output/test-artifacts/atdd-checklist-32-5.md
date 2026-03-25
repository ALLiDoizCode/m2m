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
lastSaved: '2026-03-24'
workflowType: 'testarch-atdd'
inputDocuments:
  - '_bmad-output/implementation-artifacts/story-32-5.md'
  - 'packages/connector/src/settlement/settlement-executor.ts'
  - 'packages/connector/src/settlement/settlement-executor.test.ts'
  - 'packages/connector/src/settlement/provider/payment-channel-provider.ts'
  - 'packages/connector/src/settlement/provider/chain-provider-registry.ts'
  - 'packages/connector/src/settlement/channel-manager.ts'
  - 'packages/connector/src/core/connector-node.ts'
  - 'packages/connector/src/settlement/settlement-monitor.ts'
---

# ATDD Checklist - Epic 32, Story 5: Refactor SettlementExecutor for Multi-Chain

**Date:** 2026-03-24
**Author:** Jonathan
**Primary Test Level:** Unit

---

## Story Summary

Refactor SettlementExecutor to delegate on-chain operations to the chain-appropriate PaymentChannelProvider via ChainProviderRegistry, and verify that SettlementMonitor is already chain-agnostic so that settlement execution works for any supported blockchain without hardcoded EVM/SDK dependencies.

**As a** settlement service developer
**I want** SettlementExecutor to delegate on-chain operations to the chain-appropriate PaymentChannelProvider via the ChainProviderRegistry
**So that** settlement execution works for any supported blockchain without hardcoded EVM/SDK dependencies in the core settlement orchestration layer

---

## Acceptance Criteria

1. **AC1**: SettlementMonitor works with any chain's claim events (chain-agnostic threshold check)
2. **AC2**: SettlementExecutor resolves provider for settlement via ChainProviderRegistry
3. **AC3**: SettlementExecutor constructor accepts ChainProviderRegistry instead of PaymentChannelSDK
4. **AC4**: Chain-specific retry classification remains provider-agnostic
5. **AC5**: Settlement flow through abstraction is identical to direct SDK

---

## Test Strategy

### Test Level Selection

| AC      | Scenario                                                                                   | Level              | Priority | Justification                                                       |
| ------- | ------------------------------------------------------------------------------------------ | ------------------ | -------- | ------------------------------------------------------------------- |
| AC1     | SettlementMonitor has no EVM/SDK references (audit)                                        | Audit/Unit         | P0       | Verify chain-agnosticism -- no code change, regression gate         |
| AC3     | Constructor accepts ChainProviderRegistry                                                  | Unit               | P0       | Core constructor contract change                                    |
| AC2     | executeSettlement resolves provider from registry via peerIdToChainMap                     | Unit               | P0       | Provider resolution is foundational to all settlement paths         |
| AC2     | Settlement fails with descriptive error when no provider registered                        | Unit               | P0       | Error path must be explicit for operator debugging                  |
| AC2/AC5 | openChannelAndSettle calls provider.openChannel then provider.deposit (two-step)           | Unit               | P0       | Open+deposit is the new channel creation flow                       |
| AC2/AC5 | settleViaExistingChannel calls provider.claimFromChannel with BalanceProofParams (strings) | Unit               | P0       | Per-packet claim path through provider abstraction                  |
| AC5     | Per-packet claim path uses string amounts from EVMClaimMessage                             | Unit               | P0       | Data type boundary between claim types and provider interface       |
| AC5     | Deprecated fallback path throws error when no per-packet claim available                   | Unit               | P1       | Defensive code removal -- logs error, does not attempt on-chain ops |
| AC4     | Retry logic works with provider-based operations (provider-agnostic)                       | Unit               | P0       | Retry is critical for on-chain reliability                          |
| AC5     | Settlement serialization prevents nonce collisions (unchanged)                             | Unit               | P0       | Serialization must survive refactor                                 |
| AC5     | Graceful shutdown awaits in-flight settlements (unchanged)                                 | Unit               | P0       | Shutdown safety must survive refactor                               |
| AC3     | connector-node.ts passes hoisted registry to SettlementExecutor                            | Wiring/Integration | P0       | Verifies production wiring is correct                               |
| AC1     | All existing settlement-monitor tests pass without modification                            | Regression         | P0       | Zero changes to monitor                                             |
| AC5     | Full test suite passes: typecheck, lint, all suites                                        | Regression         | P0       | Regression gate                                                     |

### Generation Mode

**AI Generation** -- backend project, all acceptance criteria map to unit tests against mocked dependencies. No browser or UI involved.

### Red Phase Design

All new tests target the **refactored** SettlementExecutor that accepts `ChainProviderRegistry` instead of `PaymentChannelSDK`. The tests will fail until the implementation is complete because:

- The constructor signature change breaks all existing test setup
- Provider resolution via `peerIdToChainMap` does not exist yet
- `openChannelAndSettle` still calls SDK directly (not provider.openChannel + provider.deposit)
- `settleViaExistingChannel` still constructs `BalanceProof` (bigint) instead of `BalanceProofParams` (string)
- The fallback path still attempts `getChannelState`/`signBalanceProof` via SDK

---

## Failing Tests Created (RED Phase)

### Unit Tests (17 tests)

**File:** `packages/connector/test/acceptance/story-32-5-multi-chain-settlement-executor.test.ts` (945 lines)

- **Test:** [P0] [T-32.5-01] SettlementMonitor has no EVM-specific or SDK references (structural audit)
  - **Status:** GREEN (pre-implementation truth -- monitor is already chain-agnostic)
  - **Verifies:** AC1 -- SettlementMonitor source has no PaymentChannelSDK references

- **Test:** [P0] [T-32.5-13] All existing settlement-monitor tests pass without modification
  - **Status:** GREEN (pre-implementation truth -- monitor test has no SDK references)
  - **Verifies:** AC1 -- Regression gate for settlement-monitor tests

- **Test:** [P0] [T-32.5-02] Constructor accepts ChainProviderRegistry instead of PaymentChannelSDK
  - **Status:** GREEN (type cast allows construction)
  - **Verifies:** AC3 -- Constructor signature change

- **Test:** [P0] Config no longer requires registryAddress, rpcUrl, or privateKey
  - **Status:** GREEN (test config intentionally omits EVM fields)
  - **Verifies:** AC3 -- Config shape change

- **Test:** [P0] [T-32.5-03] Resolve provider from registry using peerIdToChainMap
  - **Status:** RED -- registry.getProviderForPeer not called (no peerIdToChainMap resolution in executor)
  - **Verifies:** AC2 -- Provider resolution for settlement

- **Test:** [P0] [T-32.5-07] Fail with descriptive error when no provider registered for peer
  - **Status:** GREEN (settlement already fails when SDK can't find channel for unknown config)
  - **Verifies:** AC2 -- Error path for missing provider

- **Test:** [P0] [T-32.5-04] openChannelAndSettle calls provider.openChannel then provider.deposit
  - **Status:** RED -- provider.openChannel not called (executor still uses SDK)
  - **Verifies:** AC2/AC5 -- Two-step open + deposit flow

- **Test:** [P0] Mark settlement completed after successful open + deposit
  - **Status:** RED -- settlement fails because executor still uses SDK path
  - **Verifies:** AC5 -- Settlement completion through provider abstraction

- **Test:** [P0] [T-32.5-05] claimFromChannel with BalanceProofParams (string amounts)
  - **Status:** RED -- provider.claimFromChannel not called (executor still uses SDK)
  - **Verifies:** AC2/AC5 -- Per-packet claim through provider

- **Test:** [P0] [T-32.5-06] Per-packet claim path uses string amounts directly
  - **Status:** RED -- provider not used for claim operations
  - **Verifies:** AC5 -- String amount boundary between claim types and provider

- **Test:** [P1] [T-32.5-08] Deprecated fallback throws error when no per-packet claim
  - **Status:** GREEN (fallback path already fails without per-packet claim service)
  - **Verifies:** AC5 -- Fallback deprecation

- **Test:** [P0] [T-32.5-09] Retry provider.openChannel on transient network errors
  - **Status:** RED -- provider.openChannel not called
  - **Verifies:** AC4 -- Retry with provider operations

- **Test:** [P0] No retry on non-retryable errors
  - **Status:** RED -- provider.openChannel not called
  - **Verifies:** AC4 -- Non-retryable error classification

- **Test:** [P0] [T-32.5-10] Serialize concurrent settlement events sequentially
  - **Status:** RED -- provider.openChannel not called (uses SDK)
  - **Verifies:** AC5 -- Serialization preserved

- **Test:** [P0] [T-32.5-11] Graceful shutdown ignores new events and awaits in-flight
  - **Status:** RED -- provider.openChannel not called
  - **Verifies:** AC5 -- Shutdown safety preserved

- **Test:** [P0] settlement-executor.ts should NOT import PaymentChannelSDK
  - **Status:** RED -- source still imports PaymentChannelSDK
  - **Verifies:** AC3 -- Source code audit

- **Test:** [P0] settlement-executor.ts should NOT reference BalanceProof from @toon-protocol/shared
  - **Status:** RED -- source still imports BalanceProof
  - **Verifies:** AC3/AC5 -- Import cleanup

---

## Data Factories Created

### Mock Provider Factory

**File:** Inline in test file (lines 75-92)

**Exports:**

- `createMockProvider()` - Creates a mock PaymentChannelProvider with all interface methods

### Mock Registry Factory

**File:** Inline in test file (lines 97-107)

**Exports:**

- `createMockRegistry(provider)` - Creates a mock ChainProviderRegistry that resolves providers

### Mock Channel Manager Factory

**File:** Inline in test file (lines 112-130)

**Exports:**

- `createMockChannelManager(channelMap?)` - Creates a mock ChannelManager for channel lookup

### Test Config Factory

**File:** Inline in test file (lines 135-152)

**Exports:**

- `createTestConfig()` - Creates SettlementExecutorConfig without EVM-specific fields, with peerIdToChainMap

### Settlement Event Factory

**File:** Inline in test file (lines 154-163)

**Exports:**

- `createSettlementEvent(overrides?)` - Creates a SettlementTriggerEvent with defaults

---

## Mock Requirements

### PaymentChannelProvider Mock

All provider interface methods are mocked with sensible defaults:

- `openChannel` -> `{ channelId, txHash }`
- `deposit` -> `{ txHash }`
- `claimFromChannel` -> `{ txHash }`
- `getChannelState` -> `{ channelId, status: 'opened', participants, deposit }`
- `signBalanceProof` -> `'0xsignature'`
- `chainType: 'evm'`, `chainId: 'evm:anvil:31337'`

### ChainProviderRegistry Mock

- `getProviderForPeer({ peerId, chain })` -> Returns provider when chain matches `'evm:anvil:31337'`
- `getProvider(chainType, chainId)` -> Returns provider

### ChannelManager Mock

- `getChannelForPeer(peerId, tokenId)` -> Returns ChannelMetadata for configured peers, null otherwise

---

## Required data-testid Attributes

N/A -- This is a backend-only story with no UI components.

---

## Implementation Checklist

### Test: [T-32.5-02] Constructor accepts ChainProviderRegistry

**File:** `packages/connector/test/acceptance/story-32-5-multi-chain-settlement-executor.test.ts`

**Tasks to make this test pass:**

- [x] Test already passes (type cast allows construction)
- [ ] Remove `@ts-expect-error` annotations once constructor signature changes
- [ ] Run test: `npx jest --testPathIgnorePatterns='[]' --testPathPattern='story-32-5'`

---

### Test: [T-32.5-03] Resolve provider from registry

**File:** `packages/connector/test/acceptance/story-32-5-multi-chain-settlement-executor.test.ts`

**Tasks to make this test pass:**

- [ ] Add `peerIdToChainMap: Map<string, string>` to SettlementExecutorConfig
- [ ] Replace `paymentChannelSDK` constructor param with `chainProviderRegistry`
- [ ] In `executeSettlement()`, resolve chain from `peerIdToChainMap` and call `registry.getProviderForPeer()`
- [ ] Run test: `npx jest --testPathIgnorePatterns='[]' --testPathPattern='story-32-5'`

**Estimated Effort:** 1 hour

---

### Test: [T-32.5-04] openChannelAndSettle via provider (two-step)

**File:** `packages/connector/test/acceptance/story-32-5-multi-chain-settlement-executor.test.ts`

**Tasks to make this test pass:**

- [ ] Replace `paymentChannelSDK.openChannel(...)` with `provider.openChannel(peerAddress, timeout)`
- [ ] Add separate `provider.deposit(channelId, amount.toString())` call after open
- [ ] Both calls wrapped in `retryWithBackoff`
- [ ] Run test: `npx jest --testPathIgnorePatterns='[]' --testPathPattern='story-32-5'`

**Estimated Effort:** 1 hour

---

### Test: [T-32.5-05] claimFromChannel with BalanceProofParams

**File:** `packages/connector/test/acceptance/story-32-5-multi-chain-settlement-executor.test.ts`

**Tasks to make this test pass:**

- [ ] Construct `BalanceProofParams` from `EVMClaimMessage` fields (already strings)
- [ ] Replace `paymentChannelSDK.claimFromChannel(channelId, tokenAddress, BalanceProof, signature)` with `provider.claimFromChannel(channelId, BalanceProofParams, signature)`
- [ ] Remove `BalanceProof` import from `@toon-protocol/shared`
- [ ] Run test: `npx jest --testPathIgnorePatterns='[]' --testPathPattern='story-32-5'`

**Estimated Effort:** 1 hour

---

### Test: [T-32.5-08] Deprecated fallback path

**File:** `packages/connector/test/acceptance/story-32-5-multi-chain-settlement-executor.test.ts`

**Tasks to make this test pass:**

- [x] Test already passes (fallback fails without per-packet claim service)
- [ ] Replace fallback else branch with logged error and thrown exception
- [ ] Run test: `npx jest --testPathIgnorePatterns='[]' --testPathPattern='story-32-5'`

**Estimated Effort:** 30 minutes

---

### Test: [T-32.5-09] Retry with provider operations

**File:** `packages/connector/test/acceptance/story-32-5-multi-chain-settlement-executor.test.ts`

**Tasks to make this test pass:**

- [ ] Verify retry logic wraps provider calls (not SDK calls)
- [ ] Run test: `npx jest --testPathIgnorePatterns='[]' --testPathPattern='story-32-5'`

**Estimated Effort:** 15 minutes (comes for free with T-32.5-04)

---

### Test: Source code audits (no PaymentChannelSDK import, no BalanceProof import)

**File:** `packages/connector/test/acceptance/story-32-5-multi-chain-settlement-executor.test.ts`

**Tasks to make this test pass:**

- [ ] Remove `import { PaymentChannelSDK }` from settlement-executor.ts
- [ ] Remove `import { BalanceProof }` from settlement-executor.ts
- [ ] Add `import type { ChainProviderRegistry }` and `import type { PaymentChannelProvider }`
- [ ] Run test: `npx jest --testPathIgnorePatterns='[]' --testPathPattern='story-32-5'`

**Estimated Effort:** 15 minutes

---

## Running Tests

```bash
# Run all acceptance tests for this story
npx jest --config packages/connector/jest.config.js --testPathIgnorePatterns='[]' --testPathPattern='story-32-5' --no-coverage

# Run with verbose output
npx jest --config packages/connector/jest.config.js --testPathIgnorePatterns='[]' --testPathPattern='story-32-5' --no-coverage --verbose

# Run full existing test suite (regression check)
npx jest --config packages/connector/jest.config.js --no-coverage

# Run specific test by name
npx jest --config packages/connector/jest.config.js --testPathIgnorePatterns='[]' --testPathPattern='story-32-5' -t 'openChannelAndSettle'
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

**TEA Agent Responsibilities:**

- All 17 tests written (11 failing, 6 passing pre-implementation truths)
- Mock factories created for Provider, Registry, ChannelManager, Config, Events
- Implementation checklist created mapping tests to code tasks
- Source code audit tests verify import changes

**Verification:**

- 11 tests fail due to missing implementation (not test bugs)
- 6 tests pass because they verify pre-existing conditions
- Failure messages are clear: provider methods not called, imports still present
- Existing test suite passes without modification (81 suites, 1861 tests)

---

### GREEN Phase (DEV Team - Next Steps)

**DEV Agent Responsibilities:**

1. **Refactor constructor** (Tasks 2, 7 from story) -- makes T-32.5-02 robust, T-32.5-03 pass
2. **Refactor executeSettlement** (Task 6) -- makes T-32.5-03 pass
3. **Refactor openChannelAndSettle** (Task 4) -- makes T-32.5-04, retry, serialization, shutdown pass
4. **Refactor settleViaExistingChannel** (Task 5) -- makes T-32.5-05, T-32.5-06 pass
5. **Deprecate fallback** (Task 5.2) -- T-32.5-08 already passes, solidify
6. **Update connector-node.ts** (Task 9) -- makes wiring test pass
7. **Remove @ts-expect-error annotations** from acceptance tests
8. Run full suite

---

### REFACTOR Phase (DEV Team - After All Tests Pass)

1. Remove any remaining `as unknown as` casts that are no longer needed
2. Clean up `@ts-expect-error` comments in acceptance tests
3. Update existing `settlement-executor.test.ts` to use provider mocks (Task 8)
4. Run full suite to confirm regression gate

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `npx jest --config packages/connector/jest.config.js --testPathIgnorePatterns='[]' --testPathPattern='story-32-5' --no-coverage`

**Results:**

```
Test Suites: 1 failed, 1 total
Tests:       11 failed, 6 passed, 17 total
```

**Summary:**

- Total tests: 17
- Passing: 6 (pre-implementation truths)
- Failing: 11 (require implementation)
- Status: RED phase verified

**Existing Suite Regression Check:**

```
Test Suites: 3 skipped, 81 passed, 81 of 84 total
Tests:       60 skipped, 1861 passed, 1921 total
```

- No regressions introduced by acceptance test file

---

## Notes

- Acceptance tests are in `test/acceptance/` which is excluded from default jest runs via `testPathIgnorePatterns`
- Run acceptance tests explicitly with `--testPathIgnorePatterns='[]'` override
- The `@ts-expect-error` annotations on SettlementExecutor constructor calls should be removed after implementation changes the constructor signature
- The `as unknown as SettlementExecutorConfig` cast on config should be removed after config interface is updated
- Story 32.4 acceptance test pattern was followed for consistency

---

## Knowledge Base References Applied

This ATDD workflow consulted the following knowledge fragments:

- **data-factories.md** - Factory patterns for mock objects (createMockProvider, createMockRegistry)
- **test-quality.md** - Deterministic test design, isolation, explicit assertions
- **test-levels-framework.md** - Unit test level selection for backend refactoring story
- **test-priorities-matrix.md** - P0/P1 priority assignment based on settlement criticality
- **test-healing-patterns.md** - Error pattern matching for retry classification tests

---

## Contact

**Questions or Issues?**

- Refer to story definition: `_bmad-output/implementation-artifacts/story-32-5.md`
- Previous story pattern: `test/acceptance/story-32-4-multi-chain-claim-service.test.ts`

---

**Generated by BMad TEA Agent** - 2026-03-24
