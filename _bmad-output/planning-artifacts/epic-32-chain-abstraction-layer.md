# Epic 32: Chain Abstraction Layer & EVM Provider Migration

## Epic Overview

**Goal:** Create a pluggable chain-provider architecture that abstracts settlement operations behind a common interface, then migrate the existing EVM settlement code to be the first provider implementation. After this epic, adding new chains (Solana, Mina, etc.) requires only implementing the provider interface — no core settlement logic changes.

**Type:** Brownfield refactor — all existing EVM settlement functionality must remain fully operational throughout migration.

**Scope:** Settlement layer only (`/packages/connector/src/settlement/`, `/packages/connector/src/btp/btp-claim-types.ts`, `/packages/connector/src/config/types.ts`). No changes to ILP packet handling, routing, BTP transport, or TigerBeetle accounting primitives.

---

## Current Architecture

The settlement layer is tightly coupled to EVM/Base L2:

- `PaymentChannelSDK` wraps ethers.js directly — constructor takes `Provider`, `KeyManager`, `registryAddress`
- `PerPacketClaimService` constructs `EVMClaimMessage` objects and calls `PaymentChannelSDK.signBalanceProof()` directly
- `ClaimReceiver` hardcodes `isEVMClaim()` dispatch and calls `PaymentChannelSDK.verifyBalanceProof()` / `verifyBalanceProofWithDomain()`
- `SettlementExecutor` calls `PaymentChannelSDK.openChannel()`, `claimFromChannel()`, `getChannelState()` directly
- `ChannelManager` takes `PaymentChannelSDK` as constructor dependency
- `eip712-helper.ts` provides EVM-specific domain separator and balance proof types
- `btp-claim-types.ts` defines `BlockchainType = 'evm'` (literal union with single member) and `BTPClaimMessage = EVMClaimMessage`
- `PeerConfig` in `settlement/types.ts` has EVM-specific fields (`evmAddress`, `tokenAddress`, `tokenNetworkAddress`, `chainId`)
- `ConnectorConfig` has `settlementInfra?: SettlementInfraConfig` with EVM-specific fields

## Target Architecture

```
┌─────────────────────────────────────────────────────┐
│              Core Settlement Services                │
│  PerPacketClaimService  ClaimReceiver                │
│  SettlementMonitor      SettlementExecutor           │
│  ChannelManager         AccountManager               │
│                                                      │
│  All chain-agnostic — delegate to providers via      │
│  PaymentChannelProvider interface                     │
└──────────────────────┬──────────────────────────────┘
                       │ PaymentChannelProvider
         ┌─────────────┼─────────────┐
         │             │             │
  ┌──────▼──────┐ ┌────▼────┐ ┌─────▼─────┐
  │ EVM Provider│ │ Solana  │ │   Mina    │
  │ (Epic 32)   │ │ (later) │ │  (later)  │
  └─────────────┘ └─────────┘ └───────────┘

  ChainProviderRegistry manages lookup by chain ID
```

---

## Stories

### Story 32.1: Define PaymentChannelProvider Interface

**Description:** Define the `PaymentChannelProvider` TypeScript interface that all chain providers must implement. Define chain-agnostic base types and chain-specific claim message types. This is the foundational contract for the entire abstraction layer.

**Files to create/modify:**

- NEW: `packages/connector/src/settlement/provider/payment-channel-provider.ts`
- MODIFY: `packages/connector/src/btp/btp-claim-types.ts` (extend `BlockchainType`, add `SolanaClaimMessage`, `MinaClaimMessage` stubs, widen `BTPClaimMessage` union)

**Acceptance Criteria:**

```gherkin
Scenario: PaymentChannelProvider interface covers all settlement operations
  Given a new file `payment-channel-provider.ts` exists
  When a TypeScript consumer imports `PaymentChannelProvider`
  Then the interface requires implementations for:
    | Method               | Returns                              |
    | openChannel          | Promise<{ channelId, txHash }>       |
    | deposit              | Promise<{ txHash }>                  |
    | claimFromChannel     | Promise<{ txHash }>                  |
    | closeChannel         | Promise<{ txHash }>                  |
    | settleChannel        | Promise<{ txHash }>                  |
    | signBalanceProof     | Promise<string> (signature)          |
    | verifyBalanceProof   | Promise<boolean>                     |
    | getChannelState      | Promise<ProviderChannelState>        |
    | subscribeToEvents    | ProviderEventSubscription            |
  And the interface includes a readonly `chainType` property of type `BlockchainType`
  And the interface includes a readonly `chainId` property of type `string`

Scenario: Base ClaimMessage type is chain-agnostic
  Given `BaseClaimMessage` already exists in `btp-claim-types.ts`
  When `BlockchainType` is extended to `'evm' | 'solana' | 'mina'`
  Then `EVMClaimMessage` extends `BaseClaimMessage` with `blockchain: 'evm'` (unchanged)
  And `SolanaClaimMessage` extends `BaseClaimMessage` with `blockchain: 'solana'` and stub fields `programId`, `channelAccount`, `signature`
  And `MinaClaimMessage` extends `BaseClaimMessage` with `blockchain: 'mina'` and stub fields `zkAppAddress`, `proof`
  And `BTPClaimMessage` is a discriminated union of all three types

Scenario: ProviderConfig is chain-polymorphic
  Given `ProviderConfig` is defined in `payment-channel-provider.ts`
  When a consumer creates a config
  Then the config has a `chainType` discriminator field of type `BlockchainType`
  And EVM-specific config fields (rpcUrl, registryAddress, privateKey/keyManager) are nested under an `EVMProviderConfig` subtype
  And Solana/Mina config subtypes are defined as stubs with placeholder fields

Scenario: Existing EVMClaimMessage remains backward compatible
  Given existing tests import `EVMClaimMessage` from `btp-claim-types.ts`
  When the types are extended
  Then all existing EVM claim type assertions compile without changes
  And `isEVMClaim()` type guard continues to narrow correctly
  And `validateClaimMessage()` accepts EVM claims as before
```

**Technical Notes:**

- `ProviderChannelState` should be chain-agnostic: `{ channelId: string, status: 'opened' | 'closed' | 'settled', participants: string[], deposit: bigint }`
- `ProviderEventSubscription` returns `{ unsubscribe: () => void }` plus event emitter for `'channelOpened' | 'channelClosed' | 'channelSettled' | 'channelClaimed'`
- Solana and Mina claim types are stubs only — just enough to compile and document the extension point
- Do NOT introduce runtime dependencies on Solana or Mina SDKs

---

### Story 32.2: Create Chain Provider Registry

**Description:** Create a `ChainProviderRegistry` that manages provider instances by chain identifier, supports dynamic registration, and provides lookup for settlement services.

**Files to create/modify:**

- NEW: `packages/connector/src/settlement/provider/chain-provider-registry.ts`
- NEW: `packages/connector/src/settlement/provider/index.ts` (barrel export)

**Acceptance Criteria:**

```gherkin
Scenario: Register and retrieve a provider by chain type
  Given a ChainProviderRegistry instance
  When I register an EVMPaymentChannelProvider with chainType 'evm' and chainId 'evm:8453'
  Then registry.getProvider('evm', 'evm:8453') returns the registered provider
  And registry.getProvider('solana', 'solana:mainnet') returns undefined

Scenario: Register multiple providers for different chains
  Given a ChainProviderRegistry instance
  When I register an EVM provider with chainId 'evm:8453'
  And I register a second EVM provider with chainId 'evm:84532'
  Then registry.getProvider('evm', 'evm:8453') returns the first provider
  And registry.getProvider('evm', 'evm:84532') returns the second provider
  And registry.getAllProviders() returns both providers

Scenario: Register duplicate provider throws
  Given a ChainProviderRegistry instance with an EVM provider registered for 'evm:8453'
  When I attempt to register another provider for 'evm:8453'
  Then a ChainProviderAlreadyRegisteredError is thrown

Scenario: Lookup provider by peer configuration
  Given a ChainProviderRegistry with an EVM provider for 'evm:8453'
  And a peer configured with chainType 'evm' and chainId 'evm:8453'
  When I call registry.getProviderForPeer(peerConfig)
  Then the EVM provider is returned

Scenario: Configuration-driven initialization
  Given a ConnectorConfig with settlement providers configured
  When ChainProviderRegistry.fromConfig(config) is called
  Then providers are instantiated and registered for each configured chain
  And the registry is ready for lookups
```

**Technical Notes:**

- Internal storage: `Map<string, PaymentChannelProvider>` keyed by `${chainType}:${chainId}`
- `getProviderForPeer()` accepts a peer config object and resolves the correct provider
- `fromConfig()` is a static factory — defers actual provider construction to per-chain factory functions
- Thread-safe registration is not needed (single-threaded Node.js) but idempotent deregistration should be supported for graceful shutdown

---

### Story 32.3: Migrate EVM Settlement to EVMPaymentChannelProvider

**Description:** Refactor the existing `PaymentChannelSDK` and `eip712-helper.ts` into an `EVMPaymentChannelProvider` class that implements the `PaymentChannelProvider` interface. This is the largest story — it moves all EVM-specific logic behind the abstraction without changing behavior.

**Files to create/modify:**

- NEW: `packages/connector/src/settlement/provider/evm-payment-channel-provider.ts`
- MODIFY: `packages/connector/src/settlement/payment-channel-sdk.ts` (retain as internal implementation detail of EVM provider, or inline — team's choice)
- MODIFY: `packages/connector/src/settlement/eip712-helper.ts` (move into EVM provider directory or keep as utility)

**Acceptance Criteria:**

```gherkin
Scenario: EVMPaymentChannelProvider implements PaymentChannelProvider
  Given EVMPaymentChannelProvider is defined
  When TypeScript compiles the file
  Then it implements all methods of PaymentChannelProvider without errors
  And chainType returns 'evm'
  And chainId returns the configured EVM chain ID as a string (e.g., 'evm:8453')

Scenario: openChannel delegates to PaymentChannelSDK
  Given an EVMPaymentChannelProvider wrapping PaymentChannelSDK
  When openChannel(peerAddress, tokenAddress, settlementTimeout, deposit) is called
  Then it calls PaymentChannelSDK.openChannel() with the same parameters
  And returns { channelId, txHash } in the provider-standard format

Scenario: signBalanceProof produces EIP-712 signatures
  Given an EVMPaymentChannelProvider
  When signBalanceProof(channelId, nonce, transferredAmount, lockedAmount, locksRoot) is called
  Then it delegates to PaymentChannelSDK.signBalanceProof()
  And returns the hex-encoded EIP-712 signature string

Scenario: verifyBalanceProof validates EIP-712 signatures
  Given an EVMPaymentChannelProvider
  When verifyBalanceProof(balanceProof, signature, signerAddress) is called
  Then it delegates to PaymentChannelSDK.verifyBalanceProof()
  And returns true for valid signatures, false for invalid

Scenario: subscribeToEvents wraps PaymentChannelSDK event listeners
  Given an EVMPaymentChannelProvider
  When subscribeToEvents(channelId) is called
  Then it returns a ProviderEventSubscription
  And 'channelClaimed' events from the SDK are forwarded through the subscription
  And calling unsubscribe() removes the underlying SDK listeners

Scenario: Existing PaymentChannelSDK tests pass without modification
  Given the existing payment-channel-sdk.test.ts test suite
  When tests are executed after the refactor
  Then all tests pass with zero modifications
```

**Technical Notes:**

- `EVMPaymentChannelProvider` composes `PaymentChannelSDK` internally (delegation, not inheritance)
- `eip712-helper.ts` stays as a utility — it is small and already well-scoped
- The provider translates between the generic `ProviderChannelState` and the EVM-specific `ChannelState` from `@toon-protocol/shared`
- Consider moving to `packages/connector/src/settlement/provider/evm/` subdirectory for organization

---

### Story 32.4: Refactor PerPacketClaimService for Multi-Chain

**Description:** Make `PerPacketClaimService` chain-agnostic by replacing direct `PaymentChannelSDK` calls with delegation to the appropriate `PaymentChannelProvider` resolved from the registry.

**Files to modify:**

- `packages/connector/src/settlement/per-packet-claim-service.ts`

**Acceptance Criteria:**

```gherkin
Scenario: Claim generation delegates to provider for signing
  Given a PerPacketClaimService configured with a ChainProviderRegistry
  And peer 'connector-b' is configured to settle on chain 'evm:8453'
  When generateClaimForPacket('connector-b', 'M2M', 1000n) is called
  Then the service resolves the EVM provider from the registry
  And calls provider.signBalanceProof() instead of PaymentChannelSDK.signBalanceProof() directly
  And returns a PerPacketClaimResult with the signed claim

Scenario: Claim message type determined by peer's chain
  Given peer 'connector-b' is configured for 'evm'
  And peer 'connector-c' is configured for 'solana' (future)
  When generateClaimForPacket is called for 'connector-b'
  Then the resulting claim has blockchain: 'evm'
  When generateClaimForPacket is called for 'connector-c'
  Then the resulting claim has blockchain: 'solana'

Scenario: Self-describing claim format includes blockchain discriminator
  Given a generated claim for an EVM peer
  When the claim is serialized to JSON
  Then it contains a 'blockchain' field with value 'evm'
  And it contains chainId, tokenNetworkAddress, tokenAddress fields (unchanged from current behavior)

Scenario: Backward compatibility with existing claim generation
  Given the existing per-packet-claim-service.test.ts test suite
  When tests are executed with an EVM provider registered in the registry
  Then all existing tests pass (claims are identical in structure and content)

Scenario: No provider found for peer results in null return
  Given a peer 'unknown-peer' with no configured chain provider
  When generateClaimForPacket('unknown-peer', 'M2M', 1000n) is called
  Then null is returned (same behavior as current "no channel" case)
```

**Technical Notes:**

- Constructor signature changes from `(paymentChannelSDK, channelManager, db, logger, nodeId)` to `(chainProviderRegistry, channelManager, db, logger, nodeId)`
- The `ChannelClaimContext` cache should include the resolved provider reference to avoid repeated registry lookups
- Peer-to-chain mapping comes from `ChannelManager.getChannelForPeer()` which already stores a `chain` field in `ChannelMetadata`
- DB recovery (`recoverFromDb`) continues to work — the `blockchain` field is already stored per claim

---

### Story 32.5: Refactor SettlementMonitor and SettlementExecutor for Multi-Chain

**Description:** Make `SettlementMonitor` and `SettlementExecutor` chain-agnostic. The monitor already works via events and needs minimal changes. The executor must delegate on-chain operations to the correct provider.

**Files to modify:**

- `packages/connector/src/settlement/settlement-monitor.ts`
- `packages/connector/src/settlement/settlement-executor.ts`

**Acceptance Criteria:**

```gherkin
Scenario: SettlementMonitor works with any chain's claim events
  Given a SettlementMonitor subscribed to ClaimReceiver events
  When a ClaimReceivedEvent arrives with any blockchain type
  Then the threshold check runs identically (amount vs threshold comparison)
  And SETTLEMENT_REQUIRED is emitted when threshold is exceeded

Scenario: SettlementExecutor resolves provider for settlement
  Given a SettlementExecutor configured with a ChainProviderRegistry
  And peer 'connector-b' settles on chain 'evm:8453'
  When a SETTLEMENT_REQUIRED event fires for 'connector-b'
  Then the executor resolves the EVM provider from the registry
  And calls provider.claimFromChannel() for existing channels
  And calls provider.openChannel() when no channel exists

Scenario: SettlementExecutor constructor accepts ChainProviderRegistry
  Given the new SettlementExecutor constructor
  When instantiated with (config, accountManager, registry, settlementMonitor, logger)
  Then it no longer requires a direct PaymentChannelSDK parameter
  And existing settlement-executor.test.ts tests pass with a mock registry providing a mock EVM provider

Scenario: Chain-specific retry classification
  Given an EVM provider that throws a 'nonce too low' error
  When the executor's retryWithBackoff handles the error
  Then it classifies the error as retryable (unchanged for EVM)
  And the retry logic is provider-agnostic (error classification delegated to provider or kept generic)

Scenario: Settlement flow through abstraction is identical to direct SDK
  Given a full settlement flow (threshold exceeded → claim from channel → balance update)
  When executed through the abstraction layer with an EVM provider
  Then the on-chain operations and TigerBeetle balance updates are identical to the pre-refactor flow
```

**Technical Notes:**

- `SettlementMonitor` changes are minimal — it already works with chain-agnostic `ClaimReceivedEvent` (peerId, channelId, cumulativeAmount). No structural changes needed beyond verifying compatibility.
- `SettlementExecutor` has the most significant change: replace `paymentChannelSDK` constructor param with `ChainProviderRegistry`
- `findChannelForPeer()` should use `ChannelManager` metadata (which already stores chain info) rather than querying the provider directly
- `retryWithBackoff` stays generic — the retry classification (`isRetryableError`) can remain in the executor since retry semantics are similar across chains (network errors, nonce errors)

---

### Story 32.6: Refactor ClaimReceiver for Multi-Chain Verification

**Description:** Make `ClaimReceiver` dispatch claim verification to the correct provider based on the `blockchain` discriminator field in incoming claims.

**Files to modify:**

- `packages/connector/src/settlement/claim-receiver.ts`

**Acceptance Criteria:**

```gherkin
Scenario: EVM claims verified via EVM provider
  Given a ClaimReceiver configured with a ChainProviderRegistry
  When an incoming BTP message contains a claim with blockchain: 'evm'
  Then the receiver resolves the EVM provider from the registry
  And calls provider.verifyBalanceProof() for signature validation
  And the claim is persisted and CLAIM_RECEIVED event emitted (unchanged)

Scenario: Unknown blockchain type is rejected
  Given a ClaimReceiver configured with a ChainProviderRegistry
  When an incoming claim has blockchain: 'solana' but no Solana provider is registered
  Then the claim is rejected with error 'No provider registered for blockchain: solana'
  And the claim is persisted with verified: false

Scenario: Dynamic channel verification uses provider
  Given an unknown channelId arrives in an EVM claim with self-describing fields
  When the receiver processes the claim
  Then it resolves the EVM provider from the registry using claim.chainId
  And delegates on-chain channel state verification to the provider
  And registers the external channel in ChannelManager on success (unchanged)

Scenario: Backward compatibility with existing EVM claims
  Given the existing claim-receiver.test.ts test suite
  When tests are executed with an EVM provider registered in the registry
  Then all existing tests pass without modification

Scenario: ClaimReceiver no longer depends on PaymentChannelSDK directly
  Given the refactored ClaimReceiver constructor
  When instantiated
  Then it accepts (db, chainProviderRegistry, logger, channelManager, peerIdToAddressMap)
  And does not import or reference PaymentChannelSDK directly
```

**Technical Notes:**

- The `verifyEVMClaim()` private method becomes a generic `verifyClaim()` that dispatches based on `claim.blockchain`
- For EVM: existing verification logic (on-chain state check + EIP-712 signature) moves into the provider or is called through the provider interface
- `verifyBalanceProofWithDomain()` is an EVM-specific method — the provider interface's `verifyBalanceProof()` should accept the domain context internally
- Nonce monotonicity checking remains in `ClaimReceiver` (it is chain-agnostic logic)

---

### Story 32.7: Update Configuration Schema

**Description:** Extend `ConnectorConfig` and related types to support multi-chain provider configuration with per-peer chain selection while maintaining backward compatibility.

**Files to modify:**

- `packages/connector/src/config/types.ts`
- `packages/connector/src/settlement/types.ts`

**Acceptance Criteria:**

```gherkin
Scenario: Multi-chain provider configuration
  Given a ConnectorConfig YAML
  When a 'chainProviders' section is present
  Then it accepts an array of provider configurations:
    | chainType | chainId    | config fields                        |
    | evm       | evm:8453   | rpcUrl, registryAddress, keyId        |
    | solana    | solana:mainnet | rpcUrl, programId (future stub)  |
  And each provider config is validated per its chain type

Scenario: Per-peer chain selection
  Given a PeerConfig in ConnectorConfig
  When a 'chain' field is specified (e.g., 'evm:8453')
  Then the peer's settlement operations use the matching chain provider
  And the 'chain' field references a registered provider's chainId

Scenario: Backward compatibility with EVM-only configuration
  Given an existing YAML config with no 'chainProviders' section
  And existing 'settlementInfra' with EVM fields (rpcUrl, registryAddress, privateKey)
  When the connector loads the config
  Then an EVM provider is auto-created from the legacy 'settlementInfra' fields
  And all peers without explicit 'chain' field default to this auto-created EVM provider

Scenario: PeerConfig settlement preference updated
  Given PeerConfig in settlement/types.ts
  When the 'settlementPreference' field is evaluated
  Then 'evm' maps to the registered EVM provider
  And 'any' considers all registered providers
  And new chain-specific values ('solana', 'mina') are accepted

Scenario: Validation rejects unknown chain types
  Given a ConnectorConfig with chainProviders including chainType: 'unknown'
  When config validation runs
  Then an error is thrown: 'Unknown chain type: unknown'
```

**Technical Notes:**

- The `chainProviders` field is optional in `ConnectorConfig` — when absent, fall back to `settlementInfra` for EVM
- `SettlementInfraConfig` stays as-is for backward compatibility; deprecation warning logged when used
- `PeerConfig.chain?: string` is the new field linking peers to providers (e.g., `'evm:8453'`)
- EVM-specific fields on `PeerConfig` (`evmAddress`, `tokenAddress`, etc.) remain for backward compatibility but are logically scoped to EVM peers
- Config validation should reject if a peer references a chain that has no matching provider config

---

### Story 32.8: Integration Tests — EVM Provider via Chain Abstraction

**Description:** End-to-end tests proving the EVM settlement flow works identically through the new abstraction layer. Regression coverage for all existing settlement scenarios.

**Files to create/modify:**

- NEW: `packages/connector/src/settlement/provider/evm-payment-channel-provider.test.ts`
- NEW: `packages/connector/src/settlement/provider/chain-provider-registry.test.ts`
- NEW: `packages/connector/src/settlement/provider/integration.test.ts`
- MODIFY: Existing test files may need mock updates for new constructor signatures

**Acceptance Criteria:**

```gherkin
Scenario: Full settlement flow through abstraction layer
  Given a ChainProviderRegistry with a mock EVM provider
  And a PerPacketClaimService, ClaimReceiver, SettlementMonitor, SettlementExecutor wired through the registry
  When a packet is forwarded (triggering claim generation)
  And the claim is received by the counterparty (triggering verification)
  And the threshold is exceeded (triggering settlement)
  Then the full flow completes: claim signed → claim verified → threshold detected → claimFromChannel executed → balance updated
  And all operations were routed through the EVM provider via the registry

Scenario: Provider registration and lookup
  Given a ChainProviderRegistry
  When an EVM provider is registered
  Then getProvider('evm', 'evm:8453') returns it
  And getProviderForPeer(peerWithEvmChain) returns it
  And getAllProviders() includes it

Scenario: Regression — existing EVM claim flow unchanged
  Given the existing settlement test fixtures
  When claims are generated via PerPacketClaimService through the abstraction
  Then the claim JSON structure is byte-for-byte identical to pre-refactor claims
  And EIP-712 signatures are identical for the same inputs

Scenario: Regression — settlement executor opens channel through provider
  Given a SettlementExecutor with a ChainProviderRegistry
  And no existing channel for peer
  When SETTLEMENT_REQUIRED fires
  Then provider.openChannel() is called (not PaymentChannelSDK.openChannel() directly)
  And the channel is registered in ChannelManager
  And TigerBeetle balance is updated

Scenario: Regression — settlement executor claims from existing channel through provider
  Given an existing channel registered in ChannelManager
  When SETTLEMENT_REQUIRED fires
  Then provider.claimFromChannel() is called with the latest per-packet claim
  And TigerBeetle balance is updated
  And per-packet claim tracking is reset
```

**Technical Notes:**

- Integration tests should use mock providers (not real blockchain connections) to keep tests fast and deterministic
- The "byte-for-byte identical" claim assertion ensures no serialization regressions during refactor
- Existing unit tests in `*.test.ts` files should continue to pass — this story adds integration coverage, not replacement
- Test fixtures should demonstrate that the abstraction introduces no observable behavioral change

---

## Dependency Graph

```
Story 32.1 (Interface + Types)
    │
    ├── Story 32.2 (Registry)
    │       │
    │       ├── Story 32.3 (EVM Provider)
    │       │       │
    │       │       ├── Story 32.4 (PerPacketClaimService refactor)
    │       │       ├── Story 32.5 (Monitor + Executor refactor)
    │       │       ├── Story 32.6 (ClaimReceiver refactor)
    │       │       └── Story 32.7 (Config schema)
    │       │               │
    │       │               └── Story 32.8 (Integration tests)
    │       │
    │       └── (32.4–32.7 can proceed in parallel after 32.3)
```

- **32.1** must be completed first (defines all interfaces)
- **32.2** depends on 32.1 (registry uses provider interface)
- **32.3** depends on 32.1 and 32.2 (EVM provider implements interface, registers in registry)
- **32.4, 32.5, 32.6, 32.7** depend on 32.3 and can proceed in parallel
- **32.8** depends on all prior stories

---

## Risks and Mitigations

| Risk                                                       | Likelihood | Impact | Mitigation                                                                                                                                                                       |
| ---------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regression in EVM settlement during refactor               | Medium     | High   | All existing tests must pass after each story. Story 32.8 adds explicit regression coverage. Feature flag to swap between old and new code paths during transition.              |
| Interface design does not accommodate Solana/Mina patterns | Medium     | Medium | Review Solana program and Mina zkApp patterns before finalizing interface in 32.1. Include stub types for both chains to validate extensibility.                                 |
| Constructor signature changes break dependent code         | High       | Medium | Each refactored service accepts both old (direct SDK) and new (registry) constructors during transition, or use adapter pattern. Remove old constructors only after 32.8 passes. |
| Performance regression from additional abstraction layer   | Low        | Low    | The abstraction adds one method call indirection — no async overhead. Benchmark claim generation before and after.                                                               |
| Configuration migration complexity                         | Medium     | Medium | Backward compatibility: existing configs without `chainProviders` auto-create EVM provider from `settlementInfra`. No breaking config changes.                                   |

---

## Compatibility Requirements

1. **API Backward Compatibility:** All existing settlement APIs (Admin API endpoints for channels, claims, balances) must return identical responses.
2. **Wire Format Compatibility:** `EVMClaimMessage` JSON serialization must not change. New `blockchain` discriminator values are additive only.
3. **Configuration Compatibility:** Existing YAML configs without `chainProviders` must work without modification via automatic EVM provider creation from `settlementInfra`.
4. **Database Compatibility:** `sent_claims` and `received_claims` tables already store `blockchain` field — no schema migration needed.
5. **Test Compatibility:** All existing test files must pass without modification (mocks may need adapter wrappers).

---

## Definition of Done

- [ ] `PaymentChannelProvider` interface is defined and documented with JSDoc
- [ ] `ChainProviderRegistry` supports register, lookup, and configuration-driven initialization
- [ ] `EVMPaymentChannelProvider` implements full interface, delegating to existing `PaymentChannelSDK`
- [ ] `PerPacketClaimService` generates claims through provider abstraction
- [ ] `ClaimReceiver` verifies claims through provider abstraction
- [ ] `SettlementExecutor` executes settlements through provider abstraction
- [ ] `SettlementMonitor` is verified chain-agnostic (no EVM-specific references)
- [ ] `ConnectorConfig` supports `chainProviders` with backward-compatible fallback
- [ ] All existing unit tests pass without modification
- [ ] Integration tests verify full EVM settlement flow through abstraction layer
- [ ] No direct `PaymentChannelSDK` imports remain in core settlement services (only in EVM provider)
- [ ] Solana and Mina claim types compile as stubs (extension point validated)
- [ ] Zero runtime dependencies added for Solana or Mina (stubs are types-only)
