---
stepsCompleted:
  - risk-assessment
  - strategy-per-story
  - cross-story-integration
  - regression-analysis
  - test-data-requirements
lastSaved: '2026-03-24'
revision: v1
epicRef: epic-32-chain-abstraction-layer.md
inputDocuments:
  - _bmad-output/planning-artifacts/epic-32-chain-abstraction-layer.md
  - _bmad-output/planning-artifacts/architecture.md
  - _bmad-output/project-context.md
  - _bmad-output/test-artifacts/test-design-epic-multihop-e2e.md
---

# Test Design: Epic 32 — Chain Abstraction Layer & EVM Provider Migration

**Date:** 2026-03-24
**Author:** Jonathan (generated with Claude)
**Status:** Draft v1

---

## Executive Summary

**Scope:** Risk-based test plan for Epic 32, covering 8 stories (32.1--32.8) that introduce a pluggable `PaymentChannelProvider` interface, `ChainProviderRegistry`, EVM provider migration, and refactoring of all core settlement services to be chain-agnostic.

**Epic Type:** Brownfield refactor. All existing EVM settlement functionality must remain fully operational throughout migration. This is the dominant constraint shaping the test strategy.

**Architecture Constraint:** Unit tests use mocks for chain providers. Integration tests (Story 32.8) use mock providers for fast deterministic coverage of the abstraction layer. The existing multi-hop E2E tests (separate from this epic) continue to use real Anvil for full-stack validation.

**Risk Summary:**

- Total risks identified: 12
- Critical (score >= 8): 3
- High (score 5--7): 5
- Medium (score 3--4): 3
- Low (score 1--2): 1

**Coverage Summary:**

- Unit test scenarios: 52
- Integration test scenarios: 12
- Regression scenarios: 8
- Estimated effort: 8--12 dev days

---

## 1. Key Risks and Mitigating Tests

### Risk Matrix

| ID   | Risk                                                             | Likelihood | Impact   | Score | Category    | Mitigating Tests                |
| ---- | ---------------------------------------------------------------- | ---------- | -------- | ----- | ----------- | ------------------------------- |
| R-01 | EVM settlement regression during refactor                        | Medium     | Critical | 9     | REGRESSION  | T-REG-01 through T-REG-08       |
| R-02 | Interface design too narrow for future chains (Solana/Mina)      | Medium     | High     | 8     | DESIGN      | T-32.1-04, T-32.1-05            |
| R-03 | Constructor signature changes break dependent services           | High       | High     | 8     | INTEGRATION | T-32.4-04, T-32.5-04, T-32.6-04 |
| R-04 | Claim serialization format changes break wire compatibility      | Medium     | High     | 7     | COMPAT      | T-REG-03, T-32.8-03             |
| R-05 | Registry lookup returns wrong provider for peer                  | Medium     | High     | 7     | LOGIC       | T-32.2-01 through T-32.2-05     |
| R-06 | Config backward compatibility broken (no chainProviders section) | Medium     | Medium   | 6     | CONFIG      | T-32.7-03, T-32.7-05            |
| R-07 | Event subscription leak on provider swap/shutdown                | Medium     | Medium   | 6     | RESOURCE    | T-32.3-05, T-32.5-02            |
| R-08 | Unknown blockchain type not rejected at claim receive            | Low        | High     | 5     | SECURITY    | T-32.6-02                       |
| R-09 | Provider factory error during startup crashes connector          | Medium     | Medium   | 5     | STARTUP     | T-32.2-06                       |
| R-10 | DB recovery (recoverFromDb) breaks with new provider layer       | Low        | High     | 4     | DATA        | T-32.4-05                       |
| R-11 | Performance regression from abstraction layer indirection        | Low        | Low      | 2     | PERF        | T-32.8-05 (advisory)            |
| R-12 | Stub types (Solana/Mina) cause compilation errors in downstream  | Low        | Low      | 2     | BUILD       | T-32.1-05                       |

### Risk Detail: Top 3

**R-01: EVM Settlement Regression** (Score 9)
The entire epic is a brownfield refactor. Every story that changes a constructor signature or call delegation path risks breaking EVM settlement. Mitigation: every story has a backward-compatibility acceptance test, and Story 32.8 adds explicit regression coverage comparing claim bytes and settlement outcomes to pre-refactor baselines.

**R-02: Interface Too Narrow** (Score 8)
If `PaymentChannelProvider` does not accommodate Solana program accounts or Mina zk-SNARK proof patterns, Epics 33/34 will require interface-breaking changes. Mitigation: Story 32.1 includes stub types for Solana and Mina that must compile. Type-level tests validate the discriminated union extends correctly.

**R-03: Constructor Signature Breakage** (Score 8)
Stories 32.4--32.6 change constructor parameters from `PaymentChannelSDK` to `ChainProviderRegistry`. All callers (ConnectorNode startup, test files) must be updated simultaneously. Mitigation: each story includes a "backward compatibility" test verifying existing test suites pass, plus integration tests in 32.8 wiring all services together.

---

## 2. Test Strategy Per Story

### Story 32.1: Define PaymentChannelProvider Interface

**Test Level:** Unit (type-level, compilation checks)
**Risk Focus:** R-02 (interface extensibility), R-12 (stub compilation)

| ID        | Scenario                                                                                                  | Type              | Priority |
| --------- | --------------------------------------------------------------------------------------------------------- | ----------------- | -------- |
| T-32.1-01 | PaymentChannelProvider interface requires all 9 methods + chainType + chainId                             | Unit (type check) | P0       |
| T-32.1-02 | ProviderChannelState is chain-agnostic (channelId, status, participants, deposit)                         | Unit (type check) | P0       |
| T-32.1-03 | EVMClaimMessage remains backward compatible — isEVMClaim() narrows correctly                              | Unit              | P0       |
| T-32.1-04 | BlockchainType extends to 'evm' \| 'solana' \| 'mina' — discriminated union compiles                      | Unit (type check) | P0       |
| T-32.1-05 | SolanaClaimMessage and MinaClaimMessage stubs compile with placeholder fields                             | Unit (type check) | P1       |
| T-32.1-06 | ProviderConfig discriminated union with EVMProviderConfig, SolanaProviderConfig, MinaProviderConfig stubs | Unit (type check) | P1       |
| T-32.1-07 | BTPClaimMessage union type accepts all three claim message subtypes                                       | Unit              | P1       |
| T-32.1-08 | validateClaimMessage() accepts EVM claims unchanged                                                       | Unit              | P0       |

**Approach:** These are primarily compile-time assertions. Use TypeScript's `Expect<Equal<>>` pattern or simple instantiation tests that verify the types compile. Runtime tests for `isEVMClaim()` and `validateClaimMessage()` verify existing behavior is preserved.

**Test File:** `packages/connector/src/settlement/provider/payment-channel-provider.test.ts`

---

### Story 32.2: Create Chain Provider Registry

**Test Level:** Unit
**Risk Focus:** R-05 (wrong provider lookup), R-09 (factory errors)

| ID        | Scenario                                                                     | Type | Priority |
| --------- | ---------------------------------------------------------------------------- | ---- | -------- |
| T-32.2-01 | Register and retrieve provider by chainType + chainId                        | Unit | P0       |
| T-32.2-02 | Register multiple providers for different chains/chainIds                    | Unit | P0       |
| T-32.2-03 | Duplicate registration throws ChainProviderAlreadyRegisteredError            | Unit | P0       |
| T-32.2-04 | getProvider returns undefined for unregistered chain                         | Unit | P0       |
| T-32.2-05 | getProviderForPeer resolves correct provider from peer config                | Unit | P0       |
| T-32.2-06 | fromConfig factory creates providers from ConnectorConfig                    | Unit | P1       |
| T-32.2-07 | getAllProviders returns all registered providers                             | Unit | P1       |
| T-32.2-08 | Deregistration removes provider and is idempotent                            | Unit | P1       |
| T-32.2-09 | getProviderForPeer returns undefined when peer references unregistered chain | Unit | P1       |

**Approach:** Standard Jest unit tests with mock `PaymentChannelProvider` objects. The mock provider needs only `chainType` and `chainId` properties plus jest.fn() stubs for interface methods.

**Test File:** `packages/connector/src/settlement/provider/chain-provider-registry.test.ts`

---

### Story 32.3: Migrate EVM Settlement to EVMPaymentChannelProvider

**Test Level:** Unit + integration
**Risk Focus:** R-01 (regression), R-07 (event leaks)

| ID        | Scenario                                                                                    | Type              | Priority |
| --------- | ------------------------------------------------------------------------------------------- | ----------------- | -------- |
| T-32.3-01 | EVMPaymentChannelProvider implements PaymentChannelProvider (TypeScript compiles)           | Unit (type check) | P0       |
| T-32.3-02 | chainType returns 'evm', chainId returns configured chain ID string                         | Unit              | P0       |
| T-32.3-03 | openChannel delegates to PaymentChannelSDK.openChannel and returns provider-standard format | Unit              | P0       |
| T-32.3-04 | signBalanceProof delegates to PaymentChannelSDK.signBalanceProof                            | Unit              | P0       |
| T-32.3-05 | verifyBalanceProof delegates to PaymentChannelSDK.verifyBalanceProof                        | Unit              | P0       |
| T-32.3-06 | subscribeToEvents returns ProviderEventSubscription, forwards SDK events                    | Unit              | P1       |
| T-32.3-07 | unsubscribe() removes underlying SDK event listeners                                        | Unit              | P1       |
| T-32.3-08 | getChannelState translates EVM ChannelState to ProviderChannelState                         | Unit              | P1       |
| T-32.3-09 | claimFromChannel delegates correctly                                                        | Unit              | P0       |
| T-32.3-10 | closeChannel and settleChannel delegate correctly                                           | Unit              | P1       |
| T-32.3-11 | deposit delegates correctly                                                                 | Unit              | P1       |
| T-32.3-12 | Existing payment-channel-sdk.test.ts passes without modification                            | Regression        | P0       |

**Approach:** Unit tests mock the underlying `PaymentChannelSDK` and verify delegation. The regression test (T-32.3-12) is a gate: the existing `payment-channel-sdk.test.ts` file must pass with zero changes.

**Test File:** `packages/connector/src/settlement/provider/evm-payment-channel-provider.test.ts`

---

### Story 32.4: Refactor PerPacketClaimService for Multi-Chain

**Test Level:** Unit
**Risk Focus:** R-01 (regression), R-03 (constructor change), R-10 (DB recovery)

| ID        | Scenario                                                                                      | Type       | Priority |
| --------- | --------------------------------------------------------------------------------------------- | ---------- | -------- |
| T-32.4-01 | Claim generation resolves EVM provider from registry and calls signBalanceProof               | Unit       | P0       |
| T-32.4-02 | Claim message contains correct blockchain discriminator ('evm')                               | Unit       | P0       |
| T-32.4-03 | No provider found for peer returns null                                                       | Unit       | P0       |
| T-32.4-04 | Existing per-packet-claim-service.test.ts passes with mock registry adapter                   | Regression | P0       |
| T-32.4-05 | recoverFromDb restores claim state with provider reference                                    | Unit       | P1       |
| T-32.4-06 | ChannelClaimContext cache stores resolved provider to avoid repeated lookups                  | Unit       | P1       |
| T-32.4-07 | Multi-chain claim generation: EVM peer gets EVM claim, Solana peer gets Solana claim (future) | Unit       | P2       |

**Approach:** Create a mock `ChainProviderRegistry` that returns a mock EVM provider. The existing test file should continue to pass by wrapping the mock SDK in a mock registry.

**Test File:** Modify existing `per-packet-claim-service.test.ts` (update constructor, add new scenarios)

---

### Story 32.5: Refactor SettlementMonitor and SettlementExecutor for Multi-Chain

**Test Level:** Unit
**Risk Focus:** R-01 (regression), R-03 (constructor change), R-07 (event leaks)

| ID        | Scenario                                                                            | Type       | Priority |
| --------- | ----------------------------------------------------------------------------------- | ---------- | -------- |
| T-32.5-01 | SettlementMonitor handles ClaimReceivedEvent regardless of blockchain type          | Unit       | P0       |
| T-32.5-02 | SettlementMonitor threshold check is chain-agnostic (no EVM-specific references)    | Unit       | P0       |
| T-32.5-03 | SettlementExecutor resolves provider from registry for settlement                   | Unit       | P0       |
| T-32.5-04 | SettlementExecutor constructor accepts ChainProviderRegistry (no PaymentChannelSDK) | Unit       | P0       |
| T-32.5-05 | SettlementExecutor calls provider.claimFromChannel for existing channels            | Unit       | P0       |
| T-32.5-06 | SettlementExecutor calls provider.openChannel when no channel exists                | Unit       | P1       |
| T-32.5-07 | Retry logic remains provider-agnostic (isRetryableError handles generic errors)     | Unit       | P1       |
| T-32.5-08 | Existing settlement-monitor.test.ts passes without modification                     | Regression | P0       |
| T-32.5-09 | Existing settlement-executor.test.ts passes with mock registry adapter              | Regression | P0       |
| T-32.5-10 | Settlement flow through abstraction produces identical TigerBeetle balance updates  | Unit       | P1       |

**Approach:** SettlementMonitor should need minimal test changes (it is already chain-agnostic). SettlementExecutor tests need constructor updates. Mock registry wrapping a mock provider that mirrors the current mock SDK behavior.

**Test Files:** Modify existing `settlement-monitor.test.ts` and `settlement-executor.test.ts`

---

### Story 32.6: Refactor ClaimReceiver for Multi-Chain Verification

**Test Level:** Unit
**Risk Focus:** R-01 (regression), R-03 (constructor change), R-08 (unknown blockchain)

| ID        | Scenario                                                                    | Type                | Priority |
| --------- | --------------------------------------------------------------------------- | ------------------- | -------- |
| T-32.6-01 | EVM claims verified via EVM provider.verifyBalanceProof                     | Unit                | P0       |
| T-32.6-02 | Unknown blockchain type rejected with 'No provider registered' error        | Unit                | P0       |
| T-32.6-03 | Dynamic channel verification delegates to provider for on-chain state check | Unit                | P1       |
| T-32.6-04 | Existing claim-receiver.test.ts passes with mock registry adapter           | Regression          | P0       |
| T-32.6-05 | Nonce monotonicity checking remains chain-agnostic                          | Unit                | P0       |
| T-32.6-06 | ClaimReceiver constructor no longer imports PaymentChannelSDK directly      | Unit (import check) | P1       |
| T-32.6-07 | Claim persisted with verified: false when provider rejects signature        | Unit                | P1       |

**Approach:** Replace mock `PaymentChannelSDK` with mock registry returning a mock provider that exposes `verifyBalanceProof`. The existing `claim-receiver.test.ts` must pass by adapting the mock setup.

**Test File:** Modify existing `claim-receiver.test.ts`

---

### Story 32.7: Update Configuration Schema

**Test Level:** Unit
**Risk Focus:** R-06 (config backward compatibility)

| ID        | Scenario                                                                          | Type | Priority |
| --------- | --------------------------------------------------------------------------------- | ---- | -------- |
| T-32.7-01 | chainProviders section accepts array of provider configs                          | Unit | P0       |
| T-32.7-02 | Per-peer chain field references registered provider chainId                       | Unit | P0       |
| T-32.7-03 | Legacy config (no chainProviders, only settlementInfra) auto-creates EVM provider | Unit | P0       |
| T-32.7-04 | Validation rejects unknown chainType                                              | Unit | P0       |
| T-32.7-05 | Validation rejects peer referencing unregistered chain                            | Unit | P1       |
| T-32.7-06 | Deprecation warning logged when legacy settlementInfra is used                    | Unit | P1       |
| T-32.7-07 | PeerConfig.settlementPreference accepts chain-specific values                     | Unit | P2       |

**Approach:** Zod schema validation tests. Provide valid and invalid YAML-equivalent config objects, assert Zod parse results.

**Test File:** `packages/connector/src/config/types.test.ts` (extend existing) or new `config-chain-providers.test.ts`

---

### Story 32.8: Integration Tests — EVM Provider via Chain Abstraction

**Test Level:** Integration
**Risk Focus:** R-01 (full-stack regression), R-04 (wire format)

| ID        | Scenario                                                                                                     | Type                 | Priority |
| --------- | ------------------------------------------------------------------------------------------------------------ | -------------------- | -------- |
| T-32.8-01 | Full settlement flow: claim signed, verified, threshold detected, claimFromChannel executed, balance updated | Integration          | P0       |
| T-32.8-02 | Provider registration and lookup: getProvider, getProviderForPeer, getAllProviders                           | Integration          | P0       |
| T-32.8-03 | Claim JSON structure is byte-for-byte identical to pre-refactor claims                                       | Integration          | P0       |
| T-32.8-04 | EIP-712 signatures identical for same inputs through abstraction                                             | Integration          | P0       |
| T-32.8-05 | No measurable performance regression from abstraction (advisory)                                             | Integration          | P2       |
| T-32.8-06 | SettlementExecutor opens channel through provider when no channel exists                                     | Integration          | P1       |
| T-32.8-07 | SettlementExecutor claims from existing channel through provider                                             | Integration          | P1       |
| T-32.8-08 | Config-driven registry initialization wires all services correctly                                           | Integration          | P1       |
| T-32.8-09 | Graceful shutdown: registry deregisters providers, event subscriptions cleaned                               | Integration          | P1       |
| T-32.8-10 | Multi-provider registry: EVM + mock Solana provider coexist, correct routing                                 | Integration          | P2       |
| T-32.8-11 | Error propagation: provider failure surfaces correctly through settlement services                           | Integration          | P1       |
| T-32.8-12 | No direct PaymentChannelSDK imports in core settlement services (import audit)                               | Integration (static) | P0       |

**Approach:** Wire real service classes with mock providers (not real Anvil). The mock EVM provider returns deterministic signatures and channel states. Validate that the full claim-sign-verify-settle cycle works through the abstraction. T-32.8-03 compares serialized claim JSON against saved fixture files from pre-refactor.

**Test Files:**

- `packages/connector/src/settlement/provider/evm-payment-channel-provider.test.ts`
- `packages/connector/src/settlement/provider/chain-provider-registry.test.ts`
- `packages/connector/src/settlement/provider/integration.test.ts`

---

## 3. Cross-Story Integration Points

The following integration seams span multiple stories and need explicit test coverage:

### 3.1 Provider Interface to Registry (32.1 + 32.2)

**Seam:** `PaymentChannelProvider` instances are stored and retrieved by `ChainProviderRegistry`.
**Risk:** Interface changes in 32.1 not reflected in registry generic constraints.
**Test:** T-32.2-01 through T-32.2-05 use mock providers implementing the interface.

### 3.2 EVM Provider to Registry to Settlement Services (32.3 + 32.2 + 32.4/32.5/32.6)

**Seam:** `EVMPaymentChannelProvider` is registered in `ChainProviderRegistry`, then looked up by `PerPacketClaimService`, `SettlementExecutor`, and `ClaimReceiver`.
**Risk:** Provider lookup key mismatch (e.g., `'evm:8453'` vs `'evm:31337'`).
**Test:** T-32.8-01 (full flow), T-32.8-02 (lookup), T-32.8-08 (config-driven wiring).

### 3.3 Claim Serialization Across Services (32.4 + 32.6)

**Seam:** `PerPacketClaimService` generates claims, `ClaimReceiver` verifies them. The `blockchain` discriminator must be consistent.
**Risk:** Sender serializes `blockchain: 'evm'` but receiver dispatch expects different casing or format.
**Test:** T-32.8-03 (byte-for-byte claim JSON), T-32.8-04 (signature compatibility).

### 3.4 Config to Registry to Services (32.7 + 32.2 + 32.4/32.5/32.6)

**Seam:** `ConnectorConfig.chainProviders` drives `ChainProviderRegistry.fromConfig()` which creates providers consumed by all services.
**Risk:** Config schema mismatch with registry factory expectations.
**Test:** T-32.7-01 through T-32.7-03, T-32.8-08.

### 3.5 Legacy Config Fallback (32.7 + 32.2 + 32.3)

**Seam:** When no `chainProviders` section exists, `settlementInfra` fields must auto-create an EVM provider.
**Risk:** Auto-creation fails silently, leaving registry empty.
**Test:** T-32.7-03 (config fallback), T-32.8-08 (end-to-end wiring with legacy config).

### 3.6 Event Subscription Lifecycle (32.3 + 32.5)

**Seam:** `EVMPaymentChannelProvider.subscribeToEvents()` creates subscriptions that `SettlementExecutor` or `SettlementMonitor` consume. On shutdown, subscriptions must be cleaned.
**Risk:** Subscription leak causes memory growth or stale event handlers.
**Test:** T-32.3-06, T-32.3-07, T-32.8-09.

---

## 4. Regression Risks

All existing EVM settlement must keep working identically throughout migration. The following regression tests form a mandatory gate for each story.

### Regression Test Suite

| ID       | Scenario                                                           | Pre-Condition                              | Assertion           | Story Gate |
| -------- | ------------------------------------------------------------------ | ------------------------------------------ | ------------------- | ---------- |
| T-REG-01 | payment-channel-sdk.test.ts passes unmodified                      | Existing test file untouched               | All tests green     | 32.3       |
| T-REG-02 | per-packet-claim-service.test.ts passes (with constructor adapter) | Mock SDK wrapped in mock registry          | All tests green     | 32.4       |
| T-REG-03 | Claim JSON serialization unchanged                                 | Save pre-refactor claim fixture            | Byte-for-byte match | 32.4, 32.8 |
| T-REG-04 | claim-receiver.test.ts passes (with constructor adapter)           | Mock SDK wrapped in mock registry          | All tests green     | 32.6       |
| T-REG-05 | settlement-executor.test.ts passes (with constructor adapter)      | Mock SDK wrapped in mock registry          | All tests green     | 32.5       |
| T-REG-06 | settlement-monitor.test.ts passes unmodified                       | No changes needed (already chain-agnostic) | All tests green     | 32.5       |
| T-REG-07 | EIP-712 signature generation unchanged                             | Same inputs produce same signature         | Hex comparison      | 32.3, 32.8 |
| T-REG-08 | Admin API settlement endpoints return identical responses          | Pre-refactor snapshot                      | JSON comparison     | 32.8       |

### Regression Strategy

1. **Before starting Epic 32:** Capture claim JSON fixtures and EIP-712 signature fixtures from current code. Store in `packages/connector/src/settlement/provider/__fixtures__/`.
2. **Per-story gate:** Each story's PR must pass all existing test files listed above (modified only for constructor signature changes via adapter pattern).
3. **Final gate (32.8):** Integration tests compare outputs against fixtures to detect serialization drift.

### Existing Test Files Affected by Constructor Changes

| Test File                          | Current Constructor Deps | New Constructor Deps         | Adaptation                     |
| ---------------------------------- | ------------------------ | ---------------------------- | ------------------------------ |
| `per-packet-claim-service.test.ts` | `PaymentChannelSDK`      | `ChainProviderRegistry`      | Wrap mock SDK in mock registry |
| `claim-receiver.test.ts`           | `PaymentChannelSDK`      | `ChainProviderRegistry`      | Wrap mock SDK in mock registry |
| `settlement-executor.test.ts`      | `PaymentChannelSDK`      | `ChainProviderRegistry`      | Wrap mock SDK in mock registry |
| `settlement-monitor.test.ts`       | None (already agnostic)  | None                         | No changes expected            |
| `payment-channel-sdk.test.ts`      | Direct SDK               | Direct SDK (unchanged)       | No changes                     |
| `channel-manager.test.ts`          | `PaymentChannelSDK`      | Evaluate if needs registry   | May need adapter               |
| `settlement-coordinator.test.ts`   | Composes services        | Updated service constructors | Update wiring                  |

---

## 5. Test Data Requirements

### 5.1 Mock Provider Fixtures

**Mock EVM Provider** — used across all stories:

```typescript
const createMockEVMProvider = (): jest.Mocked<PaymentChannelProvider> => ({
  chainType: 'evm' as const,
  chainId: 'evm:8453',
  openChannel: jest.fn().mockResolvedValue({ channelId: '0xchannel1', txHash: '0xtx1' }),
  deposit: jest.fn().mockResolvedValue({ txHash: '0xtx2' }),
  claimFromChannel: jest.fn().mockResolvedValue({ txHash: '0xtx3' }),
  closeChannel: jest.fn().mockResolvedValue({ txHash: '0xtx4' }),
  settleChannel: jest.fn().mockResolvedValue({ txHash: '0xtx5' }),
  signBalanceProof: jest.fn().mockResolvedValue('0xmocksignature'),
  verifyBalanceProof: jest.fn().mockResolvedValue(true),
  getChannelState: jest.fn().mockResolvedValue({
    channelId: '0xchannel1',
    status: 'opened',
    participants: ['0xAlice', '0xBob'],
    deposit: 1000000n,
  }),
  subscribeToEvents: jest.fn().mockReturnValue({
    unsubscribe: jest.fn(),
    on: jest.fn(),
  }),
});
```

**Mock Solana Provider** (stub for multi-chain tests in 32.8):

```typescript
const createMockSolanaProvider = (): jest.Mocked<PaymentChannelProvider> => ({
  chainType: 'solana' as const,
  chainId: 'solana:devnet',
  // ... same methods, different return values
});
```

### 5.2 Claim Message Fixtures

Pre-refactor claim JSON to be captured and stored:

```typescript
// __fixtures__/evm-claim-pre-refactor.json
{
  "blockchain": "evm",
  "channelId": "0x...",
  "nonce": "1",
  "transferredAmount": "1000000",
  "lockedAmount": "0",
  "locksRoot": "0x000...000",
  "chainId": 8453,
  "tokenNetworkAddress": "0xTokenNetwork...",
  "tokenAddress": "0xToken...",
  "signature": "0x..."
}
```

### 5.3 Configuration Fixtures

**Legacy config (backward compatibility test):**

```yaml
settlementInfra:
  rpcUrl: 'http://localhost:8545'
  registryAddress: '0xRegistry...'
  privateKey: '0xPrivateKey...'
```

**New multi-chain config:**

```yaml
chainProviders:
  - chainType: evm
    chainId: 'evm:8453'
    rpcUrl: 'http://localhost:8545'
    registryAddress: '0xRegistry...'
    keyId: 'evm-signer-1'
  - chainType: solana
    chainId: 'solana:devnet'
    rpcUrl: 'https://api.devnet.solana.com'
    programId: 'ProgramId...'
```

**Per-peer chain selection:**

```yaml
peers:
  - id: connector-b
    chain: 'evm:8453'
    evmAddress: '0xPeerB...'
  - id: connector-c
    chain: 'solana:devnet'
```

### 5.4 Mock Factory Utilities

Add to existing `packages/connector/src/test-utils/mock-factories.ts`:

```typescript
export function createMockChainProviderRegistry(
  providers?: Map<string, PaymentChannelProvider>
): jest.Mocked<ChainProviderRegistry>;

export function createMockPaymentChannelProvider(
  overrides?: Partial<PaymentChannelProvider>
): jest.Mocked<PaymentChannelProvider>;
```

### 5.5 Test Data Constants

```typescript
// Standard test chain IDs
const TEST_EVM_CHAIN_ID = 'evm:8453';
const TEST_EVM_CHAIN_ID_TESTNET = 'evm:84532';
const TEST_SOLANA_CHAIN_ID = 'solana:devnet';
const TEST_MINA_CHAIN_ID = 'mina:devnet';

// Standard test addresses
const TEST_EVM_ADDRESS_A = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1';
const TEST_EVM_ADDRESS_B = '0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199';
const TEST_TOKEN_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const TEST_TOKEN_NETWORK_ADDRESS = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const TEST_CHANNEL_ID = '0xabc123...';

// Standard test amounts (BigInt)
const TEST_TRANSFER_AMOUNT = 1000000n;
const TEST_DEPOSIT_AMOUNT = 10000000n;
```

---

## 6. Test Execution Strategy

### 6.1 Story Execution Order (follows dependency graph)

```
Phase 1: 32.1 (Interface) — type-level tests only
Phase 2: 32.2 (Registry) — unit tests
Phase 3: 32.3 (EVM Provider) — unit tests + regression gate (payment-channel-sdk.test.ts)
Phase 4: 32.4, 32.5, 32.6, 32.7 (parallel) — unit tests + regression gates
Phase 5: 32.8 (Integration) — integration tests + full regression suite
```

### 6.2 CI Gate per Story PR

Each story PR must pass:

1. `npm run lint` (ESLint + Prettier)
2. `npm run typecheck` (tsc --noEmit)
3. `npm test` (all unit tests, including unmodified existing tests)
4. Story-specific regression tests identified in section 4

### 6.3 Coverage Targets

Per project conventions:

- Branches: 60%
- Functions: 75%
- Lines: 70%
- Statements: 70%

New files in `settlement/provider/` should aim for:

- Lines: 85%+ (new code should have higher coverage)
- Branches: 75%+

### 6.4 Test Timeout Configuration

- Unit tests: 30s default (project convention)
- Integration tests (32.8): 60s
- No Anvil/real blockchain in this epic's tests (mock providers only for 32.8)

---

## 7. Traceability Matrix

| Story | Acceptance Criteria               | Test IDs                    | Risk IDs   |
| ----- | --------------------------------- | --------------------------- | ---------- |
| 32.1  | Interface covers all operations   | T-32.1-01, T-32.1-02        | R-02       |
| 32.1  | Base ClaimMessage chain-agnostic  | T-32.1-03, T-32.1-04        | R-02, R-12 |
| 32.1  | ProviderConfig chain-polymorphic  | T-32.1-06                   | R-02       |
| 32.1  | EVMClaimMessage backward compat   | T-32.1-03, T-32.1-08        | R-01, R-04 |
| 32.2  | Register and retrieve provider    | T-32.2-01, T-32.2-02        | R-05       |
| 32.2  | Duplicate registration throws     | T-32.2-03                   | R-05       |
| 32.2  | Lookup by peer config             | T-32.2-05                   | R-05       |
| 32.2  | Config-driven initialization      | T-32.2-06                   | R-09       |
| 32.3  | Implements PaymentChannelProvider | T-32.3-01                   | R-01       |
| 32.3  | Delegates to PaymentChannelSDK    | T-32.3-03 through T-32.3-11 | R-01       |
| 32.3  | Existing SDK tests pass           | T-REG-01                    | R-01       |
| 32.4  | Claim via provider abstraction    | T-32.4-01, T-32.4-02        | R-01, R-03 |
| 32.4  | No provider returns null          | T-32.4-03                   | R-05       |
| 32.4  | Backward compatibility            | T-REG-02                    | R-01, R-03 |
| 32.5  | Monitor chain-agnostic            | T-32.5-01, T-32.5-02        | R-01       |
| 32.5  | Executor uses registry            | T-32.5-03, T-32.5-04        | R-01, R-03 |
| 32.5  | Backward compatibility            | T-REG-05, T-REG-06          | R-01       |
| 32.6  | EVM claims via provider           | T-32.6-01                   | R-01       |
| 32.6  | Unknown blockchain rejected       | T-32.6-02                   | R-08       |
| 32.6  | Backward compatibility            | T-REG-04                    | R-01, R-03 |
| 32.7  | Multi-chain config                | T-32.7-01, T-32.7-02        | R-06       |
| 32.7  | Legacy config fallback            | T-32.7-03                   | R-06       |
| 32.7  | Validation rejects unknown        | T-32.7-04, T-32.7-05        | R-06       |
| 32.8  | Full settlement flow              | T-32.8-01                   | R-01       |
| 32.8  | Claim byte-for-byte identical     | T-32.8-03                   | R-04       |
| 32.8  | No direct SDK imports             | T-32.8-12                   | R-01       |

---

## 8. Open Questions

1. **Adapter vs. break:** Should Stories 32.4--32.6 support dual constructors (old + new) during transition, or break the old signature immediately? The test plan assumes immediate break with test mock updates.

2. **Fixture capture timing:** Pre-refactor claim fixtures should be captured before Story 32.3 begins. Is there a script or test that generates canonical claim JSON today?

3. **ChannelManager dependency:** `ChannelManager` currently takes `PaymentChannelSDK` — does it also need refactoring to use the registry, or does it remain EVM-specific? If refactored, `channel-manager.test.ts` joins the regression gate.

4. **Settlement Coordinator:** `settlement-coordinator.test.ts` composes multiple services. Verify whether its constructor changes require a dedicated test update or if it is covered by the individual service tests.
