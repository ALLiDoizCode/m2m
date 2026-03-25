# Story 32.2: Create Chain Provider Registry

Status: done

## Story

As a **settlement service developer**,
I want a **`ChainProviderRegistry` that manages provider instances by chain identifier with dynamic registration and peer-based lookup**,
so that **any settlement service can resolve the correct chain provider for a given peer without hardcoding provider references**.

**Epic:** 32 — Chain Abstraction Layer & EVM Provider Migration
**Priority:** P0 (dependency for stories 32.3-32.8)
**Estimated effort:** 1-2 dev days

## Acceptance Criteria

### AC 1: Register and Retrieve Provider by Chain Type + Chain ID

```gherkin
Scenario: Register and retrieve a provider by chain type
  Given a ChainProviderRegistry instance
  When I register an EVMPaymentChannelProvider with chainType 'evm' and chainId 'evm:8453'
  Then registry.getProvider('evm', 'evm:8453') returns the registered provider
  And registry.getProvider('solana', 'solana:mainnet') returns undefined
```

### AC 2: Register Multiple Providers for Different Chains

```gherkin
Scenario: Register multiple providers for different chains
  Given a ChainProviderRegistry instance
  When I register an EVM provider with chainId 'evm:8453'
  And I register a second EVM provider with chainId 'evm:84532'
  Then registry.getProvider('evm', 'evm:8453') returns the first provider
  And registry.getProvider('evm', 'evm:84532') returns the second provider
  And registry.getAllProviders() returns both providers
```

### AC 3: Duplicate Registration Throws

```gherkin
Scenario: Register duplicate provider throws
  Given a ChainProviderRegistry instance with an EVM provider registered for 'evm:8453'
  When I attempt to register another provider for 'evm:8453'
  Then a ChainProviderAlreadyRegisteredError is thrown
```

### AC 4: Lookup Provider by Peer Configuration

```gherkin
Scenario: Lookup provider by peer configuration
  Given a ChainProviderRegistry with an EVM provider for 'evm:8453'
  And a peer configured with chainType 'evm' and chainId 'evm:8453'
  When I call registry.getProviderForPeer(peerConfig)
  Then the EVM provider is returned
```

### AC 5: Peer with Unregistered or Missing Chain Returns Undefined

```gherkin
Scenario: Peer references unregistered chain
  Given a ChainProviderRegistry with an EVM provider for 'evm:8453'
  And a peer configured with chain 'solana:devnet'
  When I call registry.getProviderForPeer(peerConfig)
  Then undefined is returned

Scenario: Peer has no chain field (legacy peer)
  Given a ChainProviderRegistry with an EVM provider for 'evm:8453'
  And a peer configured without a chain field (chain is undefined)
  When I call registry.getProviderForPeer(peerConfig)
  Then undefined is returned
```

### AC 6: Configuration-Driven Initialization

```gherkin
Scenario: Configuration-driven initialization
  Given a ConnectorConfig with settlement providers configured
  When ChainProviderRegistry.fromConfig(config) is called
  Then providers are instantiated and registered for each configured chain
  And the registry is ready for lookups

Scenario: Factory missing for chain type throws descriptive error
  Given a ProviderConfig array with chainType 'solana'
  And no factory registered for 'solana'
  When ChainProviderRegistry.fromConfig(config) is called
  Then a descriptive error is thrown indicating no factory for 'solana'
```

### AC 7: Deregistration and Cleanup

```gherkin
Scenario: Deregistration removes provider and is idempotent
  Given a ChainProviderRegistry with an EVM provider for 'evm:8453'
  When I call registry.deregister('evm:8453')
  Then registry.getProvider('evm', 'evm:8453') returns undefined
  And calling registry.deregister('evm:8453') again does not throw
```

### AC 8: Barrel Export

```gherkin
Scenario: Provider module is importable from barrel export
  Given the file `packages/connector/src/settlement/provider/index.ts` exists
  When a consumer imports from the provider barrel
  Then PaymentChannelProvider, ChainProviderRegistry, and all supporting types are accessible
```

## Tasks / Subtasks

- [x] Task 1: Create `ChainProviderRegistry` class (AC: 1, 2, 3, 7)
  - [x] 1.1 Create `packages/connector/src/settlement/provider/chain-provider-registry.ts`
  - [x] 1.2 Implement internal `Map<string, PaymentChannelProvider>` storage keyed by the provider's `chainId` property (e.g., `'evm:8453'`) — the chainId already contains the chain type namespace
  - [x] 1.3 Implement `register(provider: PaymentChannelProvider): void` — reads `chainType` and `chainId` from the provider, throws `ChainProviderAlreadyRegisteredError` on duplicate key
  - [x] 1.4 Implement `getProvider(chainType: BlockchainType, chainId: string): PaymentChannelProvider | undefined`
  - [x] 1.5 Implement `getAllProviders(): PaymentChannelProvider[]`
  - [x] 1.6 Implement `deregister(chainId: string): void` — idempotent removal
  - [x] 1.7 Define and export `ChainProviderAlreadyRegisteredError` (extends `Error`)
- [x] Task 2: Implement peer-based lookup (AC: 4, 5)
  - [x] 2.1 Define `RegistryPeerConfig` interface with `chain?: string` field (the `${chainType}:${chainId}` reference string)
  - [x] 2.2 Implement `getProviderForPeer(peerConfig: RegistryPeerConfig): PaymentChannelProvider | undefined` — looks up by `peerConfig.chain`
- [x] Task 3: Implement configuration-driven factory (AC: 6)
  - [x] 3.1 Define `ChainProviderFactory` type: `(config: ProviderConfig) => PaymentChannelProvider`
  - [x] 3.2 Implement `static fromConfig(providerConfigs: ProviderConfig[], factories: Map<BlockchainType, ChainProviderFactory>): ChainProviderRegistry`
  - [x] 3.3 Factory throws descriptive error if no factory registered for a given `chainType`
- [x] Task 4: Create barrel export (AC: 8)
  - [x] 4.1 Create `packages/connector/src/settlement/provider/index.ts` re-exporting all types from `payment-channel-provider.ts` and `chain-provider-registry.ts`
- [x] Task 5: Create test file (AC: 1-8, all scenarios)
  - [x] 5.1 Create `packages/connector/src/settlement/provider/chain-provider-registry.test.ts`
  - [x] 5.2 Tests for register and getProvider (T-32.2-01)
  - [x] 5.3 Tests for multiple providers (T-32.2-02)
  - [x] 5.4 Tests for duplicate registration error (T-32.2-03)
  - [x] 5.5 Tests for getProvider returning undefined (T-32.2-04)
  - [x] 5.6 Tests for getProviderForPeer (T-32.2-05)
  - [x] 5.7 Tests for fromConfig factory (T-32.2-06)
  - [x] 5.8 Tests for getAllProviders (T-32.2-07)
  - [x] 5.9 Tests for deregister idempotent (T-32.2-08)
  - [x] 5.10 Tests for getProviderForPeer with unregistered chain (T-32.2-09)
  - [x] 5.11 Tests for getProviderForPeer with undefined chain field (T-32.2-10)
  - [x] 5.12 Tests for fromConfig with missing factory throws error (T-32.2-11)
- [x] Task 6: Regression verification (all ACs)
  - [x] 6.1 Run `npm run typecheck` — must pass
  - [x] 6.2 Run `npm run lint` — must pass
  - [x] 6.3 Run full test suite — all existing tests must pass unchanged

## Dev Notes

### Internal Storage Key Format

The registry uses `Map<string, PaymentChannelProvider>` internally. The key is the provider's `chainId` property (e.g., `'evm:8453'`), which already includes the chain type namespace. The `getProvider(chainType, chainId)` method validates that the retrieved provider's `chainType` matches the requested type as a safety check.

### `ChainProviderAlreadyRegisteredError`

```typescript
export class ChainProviderAlreadyRegisteredError extends Error {
  constructor(chainId: string) {
    super(`Provider already registered for chain: ${chainId}`);
    this.name = 'ChainProviderAlreadyRegisteredError';
  }
}
```

### `RegistryPeerConfig` Interface

The `getProviderForPeer` method accepts a minimal peer config interface to avoid coupling the registry to the full `PeerConfig` type from `settlement/types.ts` or `config/types.ts`. This interface is intentionally narrow:

```typescript
export interface RegistryPeerConfig {
  peerId: string; // included for future logging/diagnostics; not used in lookup logic
  chain?: string; // e.g., 'evm:8453' — references a registered provider's chainId
}
```

The lookup logic uses ONLY `peerConfig.chain` as the map key. The `peerId` field is included for structural compatibility with `PeerConfig` (Story 32.7 will extend `PeerConfig` to include `chain`), and for future logging/error messages. When `chain` is `undefined`, `getProviderForPeer` returns `undefined` immediately — this supports backward compatibility where legacy peers have no explicit chain assignment.

### `fromConfig` Factory Pattern

The `fromConfig` static method accepts an array of `ProviderConfig` objects and a map of factory functions. This defers actual provider construction to per-chain factory functions (e.g., the EVM factory will be added in Story 32.3). For this story, the factory is tested with mock factories only.

```typescript
export type ChainProviderFactory = (config: ProviderConfig) => PaymentChannelProvider;

static fromConfig(
  providerConfigs: ProviderConfig[],
  factories: Map<BlockchainType, ChainProviderFactory>,
): ChainProviderRegistry
```

**Critical: `ProviderConfig` does not contain a `chainId` field.** The `chainId` (e.g., `'evm:8453'`) is a runtime property on the `PaymentChannelProvider` interface, NOT on `ProviderConfig`. The factory function is responsible for constructing a provider that has the correct `chainId` set (derived from config fields like `rpcUrl` or hardcoded per deployment). In tests, mock factories return mock providers with pre-set `chainId` values.

The `fromConfig` method iterates `providerConfigs`, looks up the factory by `config.chainType`, calls `factory(config)` to get a provider, then calls `this.register(provider)`. If no factory exists for a `chainType`, throw: `No factory registered for chain type: ${config.chainType}`.

This pattern allows:

- Each chain to define its own provider construction logic
- Testing with mock factories without real chain SDK dependencies
- Dynamic registration of new chain factories at startup

### Thread Safety

Node.js is single-threaded, so no mutex or lock needed. However, `deregister()` should be idempotent (no-throw on missing key) for graceful shutdown scenarios where multiple shutdown hooks may call deregister.

### Import Paths

The registry file (`chain-provider-registry.ts`) needs these imports:

- `import type { BlockchainType } from '../../btp/btp-claim-types';`
- `import type { PaymentChannelProvider, ProviderConfig } from './payment-channel-provider';`

Follow the `import type` convention for type-only imports (enforced by the project's strict TypeScript config).

### Existing Code Context (Do NOT Modify)

- `packages/connector/src/settlement/provider/payment-channel-provider.ts` — Created in Story 32.1. Defines `PaymentChannelProvider` interface, `ProviderConfig` union, `BlockchainType`, and all supporting types. The registry consumes these types.
- `packages/connector/src/settlement/channel-manager.ts` — Has `getChannelForPeer(peerId, tokenId)` returning `ChannelMetadata`. The `ChannelMetadata` interface already contains `channelId`, `peerId`, `tokenId`. Story 32.7 will add the chain mapping to peer config.

### Project Structure Notes

- New files: `chain-provider-registry.ts` and `index.ts` in `packages/connector/src/settlement/provider/`
- Follows existing project conventions: named exports only, no default exports, `import type` for type-only imports
- Coding standards: strict mode (no `any`), JSDoc all public types and methods, explicit return types, Prettier (single quotes, trailing commas, 100 char width)

### References

- [Source: `_bmad-output/planning-artifacts/epic-32-chain-abstraction-layer.md` — Story 32.2 section]
- [Source: `_bmad-output/planning-artifacts/test-design-epic-32.md` — Story 32.2 test strategy]
- [Source: `packages/connector/src/settlement/provider/payment-channel-provider.ts` — provider interface and ProviderConfig types]
- [Source: `packages/connector/src/settlement/channel-manager.ts` — ChannelMetadata, getChannelForPeer]

## Preconditions

- Story 32.1 is done (PaymentChannelProvider interface defined)
- Branch `epic-32` exists with Story 32.1 commit
- All existing tests passing (2009+ tests)

## Out of Scope

- EVM provider implementation (Story 32.3)
- Changes to settlement services (Stories 32.4-32.6)
- Configuration schema changes (Story 32.7)
- Integration tests (Story 32.8)
- Runtime Solana/Mina SDK dependencies
- Changes to `ConnectorConfig` or `PeerConfig` types

## Test Plan

Reference: [Source: `_bmad-output/planning-artifacts/test-design-epic-32.md` — Story 32.2]

| Test ID   | Scenario                                                                     | Priority |
| --------- | ---------------------------------------------------------------------------- | -------- |
| T-32.2-01 | Register and retrieve provider by chainType + chainId                        | P0       |
| T-32.2-02 | Register multiple providers for different chains/chainIds                    | P0       |
| T-32.2-03 | Duplicate registration throws ChainProviderAlreadyRegisteredError            | P0       |
| T-32.2-04 | getProvider returns undefined for unregistered chain                         | P0       |
| T-32.2-05 | getProviderForPeer resolves correct provider from peer config                | P0       |
| T-32.2-06 | fromConfig factory creates providers from ProviderConfig array               | P1       |
| T-32.2-07 | getAllProviders returns all registered providers                             | P1       |
| T-32.2-08 | Deregistration removes provider and is idempotent                            | P1       |
| T-32.2-09 | getProviderForPeer returns undefined when peer references unregistered chain | P1       |
| T-32.2-10 | getProviderForPeer returns undefined when peer chain field is undefined      | P1       |
| T-32.2-11 | fromConfig throws descriptive error when no factory for chainType            | P1       |

### Test Approach

- Standard Jest unit tests with mock `PaymentChannelProvider` objects
- No real chain SDK dependencies in tests
- Define a `createMockProvider` helper in the test file:

```typescript
function createMockProvider(chainType: BlockchainType, chainId: string): PaymentChannelProvider {
  return {
    chainType,
    chainId,
    openChannel: jest.fn(),
    deposit: jest.fn(),
    claimFromChannel: jest.fn(),
    closeChannel: jest.fn(),
    settleChannel: jest.fn(),
    signBalanceProof: jest.fn(),
    verifyBalanceProof: jest.fn(),
    getChannelState: jest.fn(),
    subscribeToEvents: jest.fn(),
  } as PaymentChannelProvider;
}
```

- Import `BlockchainType` from `../../btp/btp-claim-types` (same pattern as Story 32.1 test file)
- Import `PaymentChannelProvider`, `ProviderConfig` from `./payment-channel-provider`

### Regression Gate

- All existing tests must pass with zero modifications
- `npm run typecheck` must pass (tsc --noEmit)
- `npm run lint` must pass

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

No debug issues encountered — all implementation was already in place from a prior session.

### Completion Notes List

- Task 1: `ChainProviderRegistry` class implemented in `chain-provider-registry.ts` with `register()`, `getProvider()`, `getAllProviders()`, `deregister()` methods and `ChainProviderAlreadyRegisteredError` custom error class. Internal storage uses `Map<string, PaymentChannelProvider>` keyed by `chainId`.
- Task 2: Peer-based lookup implemented via `getProviderForPeer(peerConfig: RegistryPeerConfig)` method. `RegistryPeerConfig` interface defined with `peerId` and optional `chain` field. Returns `undefined` for missing/undefined chain fields (legacy peer support).
- Task 3: Configuration-driven factory implemented via `static fromConfig(providerConfigs, factories)`. Throws descriptive error when no factory is registered for a given `chainType`.
- Task 4: Barrel export created in `index.ts` re-exporting all public types from both `payment-channel-provider.ts` and `chain-provider-registry.ts`.
- Task 5: 22 unit tests created covering all 11 test IDs (T-32.2-01 through T-32.2-11) plus barrel export test. All tests pass.
- Task 6: Regression verification passed — `tsc --noEmit` clean, `eslint` clean, full test suite passes (80 suites, 1803 tests passed, 3 suites skipped as pre-existing).

### File List

- `packages/connector/src/settlement/provider/chain-provider-registry.ts` — created
- `packages/connector/src/settlement/provider/chain-provider-registry.test.ts` — created
- `packages/connector/src/settlement/provider/index.ts` — created

### Change Log

| Date       | Summary                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-03-24 | Verified Story 32.2 implementation: ChainProviderRegistry class, tests (22/22 pass), barrel export, regression gate (typecheck, lint, full suite all green). |

## Code Review Record

### Review Pass #1

| Field            | Value                               |
| ---------------- | ----------------------------------- |
| **Date**         | 2026-03-24                          |
| **Reviewer**     | Claude Opus 4.6 (1M context)        |
| **Issues Found** | 0 critical, 0 high, 0 medium, 1 low |
| **Outcome**      | Success                             |

**Low-severity issues:**

1. **Prettier formatting** — Minor formatting inconsistency detected. No functional impact.

### Review Pass #2

| Field            | Value                               |
| ---------------- | ----------------------------------- |
| **Date**         | 2026-03-24                          |
| **Reviewer**     | Claude Opus 4.6 (1M context)        |
| **Issues Found** | 0 critical, 0 high, 0 medium, 0 low |
| **Outcome**      | Success                             |

**Notes:** Clean pass. No issues found across any severity level. No files changed.

### Review Pass #3

| Field            | Value                               |
| ---------------- | ----------------------------------- |
| **Date**         | 2026-03-24                          |
| **Reviewer**     | Claude Opus 4.6 (1M context)        |
| **Issues Found** | 0 critical, 0 high, 0 medium, 0 low |
| **Outcome**      | Success                             |

**Notes:** Final review pass. OWASP Top 10 review and Semgrep scan both clean. No issues found. No files changed.
