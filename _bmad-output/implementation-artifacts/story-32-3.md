# Story 32.3: Migrate EVM Settlement to EVMPaymentChannelProvider

Status: done

## Story

As a **settlement service developer**,
I want an **`EVMPaymentChannelProvider` class that implements the `PaymentChannelProvider` interface by delegating to the existing `PaymentChannelSDK`**,
so that **all EVM settlement operations are accessible through the chain-agnostic abstraction layer without changing behavior**.

**Epic:** 32 — Chain Abstraction Layer & EVM Provider Migration
**Priority:** P0 (enables stories 32.4-32.8; largest refactor story in the epic)
**Estimated effort:** 2-3 dev days

## Acceptance Criteria

### AC 1: EVMPaymentChannelProvider Implements PaymentChannelProvider

```gherkin
Scenario: EVMPaymentChannelProvider implements PaymentChannelProvider
  Given EVMPaymentChannelProvider is defined
  When TypeScript compiles the file
  Then it implements all methods of PaymentChannelProvider without errors
  And chainType returns 'evm'
  And chainId returns the configured EVM chain ID as a string (e.g., 'evm:8453')
```

### AC 2: openChannel Delegates to PaymentChannelSDK

```gherkin
Scenario: openChannel delegates to PaymentChannelSDK
  Given an EVMPaymentChannelProvider wrapping PaymentChannelSDK
  When openChannel(peerAddress, settlementTimeout) is called
  Then it calls PaymentChannelSDK.openChannel() with the same parameters plus the configured tokenAddress and zero initialDeposit
  And returns { channelId, txHash } in the provider-standard OpenChannelResult format
```

### AC 3: signBalanceProof Produces EIP-712 Signatures

```gherkin
Scenario: signBalanceProof produces EIP-712 signatures
  Given an EVMPaymentChannelProvider
  When signBalanceProof({ channelId, nonce, transferredAmount, lockedAmount, locksRoot }) is called
  Then it delegates to PaymentChannelSDK.signBalanceProof() converting string amounts to bigint
  And returns the hex-encoded EIP-712 signature string
```

### AC 4: verifyBalanceProof Validates EIP-712 Signatures

```gherkin
Scenario: verifyBalanceProof validates EIP-712 signatures
  Given an EVMPaymentChannelProvider
  When verifyBalanceProof({ channelId, nonce, transferredAmount, lockedAmount, locksRoot, signature, signerAddress }) is called
  Then it constructs a BalanceProof object and delegates to PaymentChannelSDK.verifyBalanceProof()
  And returns true for valid signatures, false for invalid
```

### AC 5: subscribeToEvents Wraps SDK Event Listeners

```gherkin
Scenario: subscribeToEvents wraps PaymentChannelSDK event listeners
  Given an EVMPaymentChannelProvider
  When subscribeToEvents(channelId, callback) is called
  Then it returns a ProviderEventSubscription
  And on-chain SDK events (ChannelOpened, ChannelClosed, ChannelSettled, ChannelCooperativeSettled) are mapped to ProviderEvent objects and forwarded through the callback
  And calling unsubscribe() removes the underlying SDK listeners
```

### AC 6: getChannelState Translates EVM ChannelState to ProviderChannelState

```gherkin
Scenario: getChannelState translates EVM ChannelState to ProviderChannelState
  Given an EVMPaymentChannelProvider
  When getChannelState(channelId) is called
  Then it delegates to PaymentChannelSDK.getChannelState() with the configured tokenAddress
  And translates the EVM-specific ChannelState (myDeposit, theirDeposit, participants, status) to ProviderChannelState
  And deposit = myDeposit + theirDeposit (total channel deposit)
```

### AC 7: claimFromChannel, closeChannel, settleChannel, deposit Delegate Correctly

```gherkin
Scenario: claimFromChannel delegates correctly
  Given an EVMPaymentChannelProvider
  When claimFromChannel(channelId, balanceProof, signature) is called
  Then it constructs a BalanceProof object from BalanceProofParams (converting string amounts to bigint)
  And delegates to PaymentChannelSDK.claimFromChannel() with the configured tokenAddress
  And returns { txHash } (note: SDK returns void, provider returns TxResult — use placeholder tx hash)

Scenario: closeChannel delegates correctly
  Given an EVMPaymentChannelProvider
  When closeChannel(channelId) is called
  Then it delegates to PaymentChannelSDK.closeChannel() with the configured tokenAddress
  And returns { txHash } (placeholder)

Scenario: settleChannel delegates correctly
  Given an EVMPaymentChannelProvider
  When settleChannel(channelId) is called
  Then it delegates to PaymentChannelSDK.settleChannel() with the configured tokenAddress
  And returns { txHash } (placeholder)

Scenario: deposit delegates correctly
  Given an EVMPaymentChannelProvider
  When deposit(channelId, amount) is called
  Then it delegates to PaymentChannelSDK.deposit() with the configured tokenAddress and amount converted to bigint
  And returns { txHash } (placeholder)
```

### AC 8: Existing PaymentChannelSDK Tests Pass Without Modification

```gherkin
Scenario: Existing PaymentChannelSDK tests pass without modification
  Given the existing payment-channel-sdk.test.ts test suite
  When tests are executed after the refactor
  Then all tests pass with zero modifications
```

## Tasks / Subtasks

- [x] Task 1: Create `EVMPaymentChannelProvider` class (AC: 1, 2, 3, 4, 6, 7)
  - [x] 1.1 Create `packages/connector/src/settlement/provider/evm-payment-channel-provider.ts`
  - [x] 1.2 Define class implementing `PaymentChannelProvider` with `readonly chainType: 'evm'` and `readonly chainId: string`
  - [x] 1.3 Constructor accepts `PaymentChannelSDK`, `chainId` string (e.g., `'evm:8453'`), `tokenAddress` string, and `Logger`
  - [x] 1.4 Implement `openChannel(participant, settlementTimeout)` — delegates to `sdk.openChannel(participant, tokenAddress, settlementTimeout, 0n)`
  - [x] 1.5 Implement `deposit(channelId, amount)` — delegates to `sdk.deposit(channelId, tokenAddress, BigInt(amount))`
  - [x] 1.6 Implement `claimFromChannel(channelId, balanceProof, signature)` — converts `BalanceProofParams` to `BalanceProof` (string amounts to bigint), delegates to `sdk.claimFromChannel(channelId, tokenAddress, balanceProof, signature)`
  - [x] 1.7 Implement `closeChannel(channelId)` — delegates to `sdk.closeChannel(channelId, tokenAddress)`
  - [x] 1.8 Implement `settleChannel(channelId)` — delegates to `sdk.settleChannel(channelId, tokenAddress)`
  - [x] 1.9 Implement `signBalanceProof(params)` — delegates to `sdk.signBalanceProof(params.channelId, params.nonce, BigInt(params.transferredAmount), BigInt(params.lockedAmount), params.locksRoot)`
  - [x] 1.10 Implement `verifyBalanceProof(params)` — constructs `BalanceProof` from params, delegates to `sdk.verifyBalanceProof(balanceProof, params.signature, params.signerAddress)`
  - [x] 1.11 Implement `getChannelState(channelId)` — delegates to `sdk.getChannelState(channelId, tokenAddress)`, translates `ChannelState` to `ProviderChannelState`
- [x] Task 2: Implement event subscription (AC: 5)
  - [x] 2.1 Implement `subscribeToEvents(channelId, callback)` — creates SDK event listeners for all event types that filter by channelId, maps them to `ProviderEvent` objects, and calls the callback
  - [x] 2.2 Return `ProviderEventSubscription` with `unsubscribe()` that removes all registered SDK listeners
  - [x] 2.3 Track active subscriptions internally for cleanup
- [x] Task 3: Create `createEVMProviderFactory` helper function (AC: 1)
  - [x] 3.1 Export `createEVMProviderFactory(sdk, logger): ChainProviderFactory` from `evm-payment-channel-provider.ts`
  - [x] 3.2 Factory validates `config.chainType === 'evm'` and throws for non-EVM configs
  - [x] 3.3 Note: Factory uses placeholder `chainId` and `tokenAddress` derivation — full wiring deferred to Story 32.7/32.8
- [x] Task 4: Update barrel export (AC: 1)
  - [x] 4.1 Add `EVMPaymentChannelProvider` and `createEVMProviderFactory` to `packages/connector/src/settlement/provider/index.ts`
- [x] Task 5: Create test file (AC: 1-8, all scenarios)
  - [x] 5.1 Create `packages/connector/src/settlement/provider/evm-payment-channel-provider.test.ts`
  - [x] 5.2 Create mock `PaymentChannelSDK` with jest.fn() stubs for all methods used by the provider
  - [x] 5.3 Tests for type compliance — TypeScript compiles (T-32.3-01)
  - [x] 5.4 Tests for chainType and chainId (T-32.3-02)
  - [x] 5.5 Tests for openChannel delegation (T-32.3-03)
  - [x] 5.6 Tests for signBalanceProof delegation (T-32.3-04)
  - [x] 5.7 Tests for verifyBalanceProof delegation (T-32.3-05)
  - [x] 5.8 Tests for subscribeToEvents forwarding (T-32.3-06)
  - [x] 5.9 Tests for unsubscribe cleanup (T-32.3-07)
  - [x] 5.10 Tests for getChannelState translation (T-32.3-08)
  - [x] 5.11 Tests for claimFromChannel delegation (T-32.3-09)
  - [x] 5.12 Tests for closeChannel and settleChannel delegation (T-32.3-10)
  - [x] 5.13 Tests for deposit delegation (T-32.3-11)
  - [x] 5.14 Tests for createEVMProviderFactory (T-32.3-13)
- [x] Task 6: Regression verification (AC: 8)
  - [x] 6.1 Run `npm run typecheck` — must pass
  - [x] 6.2 Run `npm run lint` — must pass
  - [x] 6.3 Run full test suite — all existing tests must pass unchanged (T-32.3-12)

## Dev Notes

### Delegation Pattern — Composition, Not Inheritance

`EVMPaymentChannelProvider` composes `PaymentChannelSDK` via its constructor (delegation). It does NOT extend `PaymentChannelSDK`. The SDK instance is stored as a private field and all interface methods delegate to it with parameter adaptation.

```typescript
export class EVMPaymentChannelProvider implements PaymentChannelProvider {
  readonly chainType: BlockchainType = 'evm';
  readonly chainId: string;

  constructor(
    private readonly sdk: PaymentChannelSDK,
    chainId: string,
    private readonly tokenAddress: string,
    private readonly logger: Logger
  ) {
    this.chainId = chainId;
  }
  // ...methods delegate to this.sdk
}
```

### Critical: Parameter Adaptation Between Interfaces

The `PaymentChannelProvider` interface uses different parameter types than `PaymentChannelSDK`. The provider must adapt:

| Provider Interface                                                         | SDK Method                                                                                           | Key Differences                                                                                                 |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `openChannel(participant, settlementTimeout)`                              | `sdk.openChannel(participant2, tokenAddress, settlementTimeout, initialDeposit)`                     | Provider adds `tokenAddress` and `0n` for initialDeposit                                                        |
| `deposit(channelId, amount: string)`                                       | `sdk.deposit(channelId, tokenAddress, amount: bigint)`                                               | Provider adds `tokenAddress`, converts `string` to `bigint`                                                     |
| `claimFromChannel(channelId, balanceProof: BalanceProofParams, signature)` | `sdk.claimFromChannel(channelId, tokenAddress, balanceProof: BalanceProof, signature)`               | Provider converts `BalanceProofParams` (string amounts) to `BalanceProof` (bigint amounts), adds `tokenAddress` |
| `closeChannel(channelId)`                                                  | `sdk.closeChannel(channelId, tokenAddress)`                                                          | Provider adds `tokenAddress`                                                                                    |
| `settleChannel(channelId)`                                                 | `sdk.settleChannel(channelId, tokenAddress)`                                                         | Provider adds `tokenAddress`                                                                                    |
| `signBalanceProof(params: BalanceProofParams)`                             | `sdk.signBalanceProof(channelId, nonce, transferredAmount: bigint, lockedAmount: bigint, locksRoot)` | Provider destructures params, converts string amounts to bigint                                                 |
| `verifyBalanceProof(params: VerifyBalanceProofParams)`                     | `sdk.verifyBalanceProof(balanceProof: BalanceProof, signature, expectedSigner)`                      | Provider constructs `BalanceProof` object from params, reorders arguments                                       |
| `getChannelState(channelId)`                                               | `sdk.getChannelState(channelId, tokenAddress)`                                                       | Provider adds `tokenAddress`, translates return type                                                            |

### Critical: BalanceProofParams to BalanceProof Conversion

The provider's `BalanceProofParams` uses `string` for amounts (chain-agnostic), while the SDK's `BalanceProof` (from `@toon-protocol/shared`) uses `bigint`. The conversion helper:

```typescript
private toSdkBalanceProof(params: BalanceProofParams): BalanceProof {
  return {
    channelId: params.channelId,
    nonce: params.nonce,
    transferredAmount: BigInt(params.transferredAmount),
    lockedAmount: BigInt(params.lockedAmount),
    locksRoot: params.locksRoot,
  };
}
```

### Critical: ChannelState to ProviderChannelState Translation

`ChannelState` (from `@toon-protocol/shared`) is EVM-specific with many fields. `ProviderChannelState` is chain-agnostic with only 4 fields:

```typescript
private toProviderChannelState(state: ChannelState): ProviderChannelState {
  return {
    channelId: state.channelId,
    status: state.status, // Same type: 'opened' | 'closed' | 'settled'
    participants: [...state.participants],
    deposit: state.myDeposit + state.theirDeposit, // Total deposit
  };
}
```

### Critical: SDK Methods Return `void` for Mutations

Several SDK methods (`deposit`, `closeChannel`, `settleChannel`, `claimFromChannel`) return `Promise<void>` while the provider interface requires `Promise<TxResult>`. Since the SDK does not expose the transaction hash for these operations (it logs them internally but doesn't return them), use a placeholder approach:

**Option A (recommended):** Return `{ txHash: 'evm-tx-pending' }` as a placeholder. This is acceptable because:

- The existing settlement services do not currently use the tx hash from these operations
- Story 32.5 (SettlementExecutor refactor) will not depend on the tx hash
- A follow-up enhancement can thread the tx hash through when SDK methods are updated

**Option B:** Modify SDK methods to return tx hashes. This is OUT OF SCOPE for this story — the SDK must remain unchanged to pass T-32.3-12.

### Event Subscription Implementation

The `subscribeToEvents` method must bridge the SDK's per-event-type listener pattern to the provider's unified callback pattern. The SDK provides:

- `sdk.onChannelOpened(tokenAddress, callback)` — `ChannelOpenedEvent`
- `sdk.onChannelClosed(tokenAddress, callback)` — `ChannelClosedEvent`
- `sdk.onChannelSettled(tokenAddress, callback)` — `ChannelSettledEvent`
- `sdk.onChannelCooperativeSettled(tokenAddress, callback)` — `ChannelCooperativeSettledEvent`

The provider maps these to `ProviderEvent` with `type: ProviderEventType` and filters by `channelId`.

**Important:** The SDK's `onChannel*` methods register listeners for ALL channels on a given token network. The provider must filter events by `channelId` before forwarding. The `ChannelClaimed` event from the TokenNetwork ABI is NOT exposed via SDK helper methods — it would need a raw listener. For this story, focus on the events the SDK already exposes. `channel_claimed` and `channel_deposited` events can be implemented in a follow-up if needed.

For `unsubscribe()`, call `sdk.removeAllListeners()`. This is a coarse approach but matches how the SDK manages listeners. A more granular approach can be added if needed.

**Important: Async Mismatch.** The provider interface declares `subscribeToEvents()` as returning `ProviderEventSubscription` (synchronous), but the SDK's `onChannel*` methods are `async` (they call `getTokenNetworkContract` internally). The implementation should call the async SDK methods and store the resulting promises internally. The returned `ProviderEventSubscription` is valid immediately — event callbacks will begin firing once the async setup completes. This is acceptable because the subscriber only cares about receiving events going forward, not about the exact moment registration completes.

### Critical: EVMProviderConfig Lacks tokenAddress Field

The current `EVMProviderConfig` (from Story 32.1) has fields: `chainType`, `rpcUrl`, `registryAddress`, `keyId`. It does **not** have a `tokenAddress` field. The `EVMPaymentChannelProvider` constructor requires `tokenAddress` because the SDK needs it for every operation. For this story, `tokenAddress` is passed directly to the constructor in tests. Story 32.7 will extend `EVMProviderConfig` to include `tokenAddress` and wire it through the factory. Do **not** modify `EVMProviderConfig` in this story.

### tokenAddress Constructor Parameter

The `EVMPaymentChannelProvider` needs a `tokenAddress` because the SDK methods require it for every operation (to resolve the correct `TokenNetwork` contract). In the current architecture, a single connector operates with one token per peer relationship, so the provider is configured with the token it manages.

The `tokenAddress` comes from `EVMProviderConfig` at construction time (wired in `fromConfig` — Story 32.2 registered the factory pattern, and this story provides the EVM factory implementation).

### EVM Factory Function for ChainProviderRegistry

This story should also provide the factory function that `ChainProviderRegistry.fromConfig()` can use to instantiate EVM providers:

```typescript
export function createEVMProviderFactory(
  sdk: PaymentChannelSDK,
  logger: Logger
): ChainProviderFactory {
  return (config: ProviderConfig): PaymentChannelProvider => {
    if (config.chainType !== 'evm') {
      throw new Error(`EVM factory received non-EVM config: ${config.chainType}`);
    }
    // chainId derived from config — e.g., 'evm:8453'
    // tokenAddress from EVMProviderConfig (to be extended in Story 32.7)
    // For now, the factory is tested with mock configs
    // chainId placeholder — actual derivation depends on Story 32.7 config schema
    const chainId = `evm:${config.keyId}`;
    // tokenAddress placeholder — EVMProviderConfig will gain a tokenAddress field in Story 32.7
    const tokenAddress = config.registryAddress; // PLACEHOLDER — NOT semantically correct
    return new EVMPaymentChannelProvider(sdk, chainId, tokenAddress, logger);
  };
}
```

**Note:** The factory above is illustrative with intentional placeholders. The actual `chainId` and `tokenAddress` derivation depends on Story 32.7 config schema (which will add a `tokenAddress` field to `EVMProviderConfig`). For this story, the factory is tested with explicit constructor calls and mock configs. The full factory wiring happens in Story 32.7/32.8. The `config.registryAddress` usage for `tokenAddress` is a placeholder — these are semantically different values (registry vs. token network contract).

### Import Paths

```typescript
// evm-payment-channel-provider.ts
import type { BalanceProof, ChannelState } from '@toon-protocol/shared';
import type { Logger } from '../../utils/logger';
import type { BlockchainType } from '../../btp/btp-claim-types';
import type {
  PaymentChannelProvider,
  ProviderChannelState,
  ProviderEventCallback,
  ProviderEventSubscription,
  ProviderEvent,
  ProviderEventType,
  OpenChannelResult,
  TxResult,
  BalanceProofParams,
  VerifyBalanceProofParams,
} from './payment-channel-provider';
import { PaymentChannelSDK } from '../payment-channel-sdk';
```

Use `import type` for all type-only imports. The `PaymentChannelSDK` import is a value import (needed for `instanceof` / construction).

### Existing Code Context (Do NOT Modify)

- `packages/connector/src/settlement/payment-channel-sdk.ts` — The EVM SDK being wrapped. 1190 lines. Do NOT modify this file. Key methods: `openChannel`, `deposit`, `claimFromChannel`, `closeChannel`, `settleChannel`, `signBalanceProof`, `verifyBalanceProof`, `getChannelState`, `onChannelOpened/Closed/Settled/CooperativeSettled`, `removeAllListeners`.
- `packages/connector/src/settlement/payment-channel-sdk.test.ts` — Existing test suite. Must pass with zero modifications after this story.
- `packages/connector/src/settlement/eip712-helper.ts` — EIP-712 utilities (`getDomainSeparator`, `getBalanceProofTypes`). Stays as-is; used internally by the SDK, not directly by the provider.
- `packages/connector/src/settlement/provider/payment-channel-provider.ts` — The interface this class implements (Story 32.1).
- `packages/connector/src/settlement/provider/chain-provider-registry.ts` — Registry that will hold EVM provider instances (Story 32.2).
- `packages/connector/src/settlement/provider/index.ts` — Barrel export to update with new class.

### Project Structure Notes

- New file: `evm-payment-channel-provider.ts` in `packages/connector/src/settlement/provider/`
- The epic plan suggested an `evm/` subdirectory but existing stories (32.1, 32.2) placed files flat in `provider/`. Follow the established pattern: flat in `provider/`.
- Coding standards: strict mode (no `any`), JSDoc all public types and methods, explicit return types, `import type` for type-only imports, Prettier (single quotes, trailing commas, 100 char width, 2-space indent)
- Named exports only, no default exports

### Previous Story Intelligence

**Story 32.1 learnings:**

- Created the `PaymentChannelProvider` interface, `BalanceProofParams`, `VerifyBalanceProofParams`, `ProviderChannelState`, `ProviderEventSubscription`, `OpenChannelResult`, `TxResult` types — all in `payment-channel-provider.ts`
- All amounts in provider interface use `string` (not `bigint`) for cross-chain compatibility
- Event types: `channel_opened | channel_closed | channel_settled | channel_deposited | channel_claimed`
- 26 tests in `payment-channel-provider.test.ts`

**Story 32.2 learnings:**

- `ChainProviderRegistry` uses `Map<string, PaymentChannelProvider>` keyed by `chainId`
- `register(provider)` reads `chainType` and `chainId` from the provider instance
- `fromConfig()` accepts `ProviderConfig[]` and `Map<BlockchainType, ChainProviderFactory>`
- `ChainProviderFactory` type: `(config: ProviderConfig) => PaymentChannelProvider`
- 22 tests in `chain-provider-registry.test.ts`

**Git commit patterns:**

- Commit prefix: `feat(32-N): description`
- Branch: `epic-32`

### References

- [Source: `_bmad-output/planning-artifacts/epic-32-chain-abstraction-layer.md` — Story 32.3 section]
- [Source: `_bmad-output/planning-artifacts/test-design-epic-32.md` — Story 32.3 test strategy, T-32.3-01 through T-32.3-13]
- [Source: `packages/connector/src/settlement/payment-channel-sdk.ts` — EVM SDK methods to delegate to]
- [Source: `packages/connector/src/settlement/eip712-helper.ts` — EIP-712 helper (stays internal to SDK)]
- [Source: `packages/connector/src/settlement/provider/payment-channel-provider.ts` — interface to implement]
- [Source: `packages/connector/src/settlement/provider/chain-provider-registry.ts` — registry and factory types]
- [Source: `packages/shared/src/types/payment-channel.ts` — ChannelState, BalanceProof, ChannelStatus types]
- [Source: `docs/architecture/coding-standards.md` — project coding conventions]

## Preconditions

- Story 32.1 is done (PaymentChannelProvider interface defined)
- Story 32.2 is done (ChainProviderRegistry implemented)
- Branch `epic-32` exists with Stories 32.1 and 32.2 commits
- All existing tests passing

## Out of Scope

- Changes to `PaymentChannelSDK` (it is wrapped, not modified)
- Changes to `eip712-helper.ts`
- Refactoring settlement services to use the provider (Stories 32.4-32.6)
- Configuration schema changes (Story 32.7)
- Integration tests wiring all services together (Story 32.8)
- Runtime Solana/Mina SDK dependencies
- Granular event subscription per channelId (SDK registers per-token, provider filters)

## Test Plan

Reference: [Source: `_bmad-output/planning-artifacts/test-design-epic-32.md` — Story 32.3]

| Test ID   | Scenario                                                                                    | Type              | Priority |
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
| T-32.3-13 | createEVMProviderFactory returns provider for EVM config, throws for non-EVM config         | Unit              | P1       |

### Test Approach

- Create `evm-payment-channel-provider.test.ts` in `packages/connector/src/settlement/provider/`
- Mock `PaymentChannelSDK` using jest.fn() stubs for all delegated methods
- Verify each provider method calls the correct SDK method with correctly adapted parameters
- Verify return values are translated correctly (e.g., `ChannelState` to `ProviderChannelState`)
- Use `pino({ level: 'silent' })` for mock logger

### Mock PaymentChannelSDK Pattern

```typescript
function createMockSDK(): jest.Mocked<
  Pick<
    PaymentChannelSDK,
    | 'openChannel'
    | 'deposit'
    | 'claimFromChannel'
    | 'closeChannel'
    | 'settleChannel'
    | 'signBalanceProof'
    | 'verifyBalanceProof'
    | 'getChannelState'
    | 'onChannelOpened'
    | 'onChannelClosed'
    | 'onChannelSettled'
    | 'onChannelCooperativeSettled'
    | 'removeAllListeners'
  >
> {
  return {
    openChannel: jest.fn(),
    deposit: jest.fn(),
    claimFromChannel: jest.fn(),
    closeChannel: jest.fn(),
    settleChannel: jest.fn(),
    signBalanceProof: jest.fn(),
    verifyBalanceProof: jest.fn(),
    getChannelState: jest.fn(),
    onChannelOpened: jest.fn(),
    onChannelClosed: jest.fn(),
    onChannelSettled: jest.fn(),
    onChannelCooperativeSettled: jest.fn(),
    removeAllListeners: jest.fn(),
  };
}
```

Cast the mock as `PaymentChannelSDK` when constructing `EVMPaymentChannelProvider` since the provider only accesses these methods.

### Regression Gate

- All existing tests must pass with zero modifications
- `npm run typecheck` must pass (tsc --noEmit)
- `npm run lint` must pass

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context) — claude-opus-4-6[1m]

### Debug Log References

None required.

### Completion Notes List

- **Task 1**: Created `EVMPaymentChannelProvider` class implementing `PaymentChannelProvider` interface via composition/delegation to `PaymentChannelSDK`. All 9 interface methods implemented with parameter adaptation (string-to-bigint conversion, tokenAddress injection, ChannelState-to-ProviderChannelState translation). Private helpers `toSdkBalanceProof()` and `toProviderChannelState()` handle the conversions.
- **Task 2**: Implemented `subscribeToEvents()` bridging SDK per-event-type listeners to the provider's unified callback pattern. Registers async SDK listeners (fire-and-forget), filters events by channelId, maps SDK event types to ProviderEventType. `unsubscribe()` sets a guard flag and calls `sdk.removeAllListeners()`.
- **Task 3**: Created `createEVMProviderFactory()` returning a `ChainProviderFactory` that validates `config.chainType === 'evm'` and instantiates an `EVMPaymentChannelProvider`. Uses placeholder `chainId`/`tokenAddress` derivation per story scope.
- **Task 4**: Updated barrel export `index.ts` to re-export `EVMPaymentChannelProvider` and `createEVMProviderFactory`.
- **Task 5**: Wrote 23 tests covering all test plan IDs T-32.3-01 through T-32.3-13 (excluding T-32.3-12 which is the regression gate). Replaced TDD red-phase skipped tests with green implementations.
- **Task 6**: All regression gates passed — `tsc --noEmit` clean, `npm run lint` clean, 81/81 test suites pass (1830 tests), existing `payment-channel-sdk.test.ts` (33 tests) passes with zero modifications.

### File List

- `packages/connector/src/settlement/provider/evm-payment-channel-provider.ts` — created
- `packages/connector/src/settlement/provider/evm-payment-channel-provider.test.ts` — modified (replaced TDD red-phase skipped tests with green implementations)
- `packages/connector/src/settlement/provider/index.ts` — modified (added barrel exports)
- `_bmad-output/implementation-artifacts/story-32-3.md` — modified (status, checkboxes, dev agent record)

### Change Log

| Date       | Summary                                                                                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-03-24 | Story 32.3 implemented: EVMPaymentChannelProvider class wrapping PaymentChannelSDK via delegation, createEVMProviderFactory helper, 23 passing tests, all regression gates green. |

## Code Review Record

### Review Pass #1

| Field        | Value                                          |
| ------------ | ---------------------------------------------- |
| **Date**     | 2026-03-24                                     |
| **Reviewer** | Claude Opus 4.6 (1M context)                   |
| **Status**   | Success                                        |
| **Critical** | 0                                              |
| **High**     | 0                                              |
| **Medium**   | 1 — import type fix                            |
| **Low**      | 1 — missing `jest.clearAllMocks` in test setup |
| **Outcome**  | Both issues fixed during review; no follow-ups |

### Review Pass #2

| Field        | Value                                          |
| ------------ | ---------------------------------------------- |
| **Date**     | 2026-03-24                                     |
| **Reviewer** | Claude Opus 4.6 (1M context)                   |
| **Status**   | Success                                        |
| **Critical** | 0                                              |
| **High**     | 0                                              |
| **Medium**   | 1 — private field underscore prefix naming     |
| **Low**      | 1 — fire-and-forget async error logging        |
| **Outcome**  | Both issues fixed during review; no follow-ups |

### Review Pass #3

| Field        | Value                                                                                  |
| ------------ | -------------------------------------------------------------------------------------- |
| **Date**     | 2026-03-24                                                                             |
| **Reviewer** | Claude Opus 4.6 (1M context) — code review + Semgrep + OWASP audit                     |
| **Status**   | Success                                                                                |
| **Critical** | 0                                                                                      |
| **High**     | 0                                                                                      |
| **Medium**   | 1 — `BigInt()` conversions without input validation (5 call sites)                     |
| **Low**      | 1 — missing constructor validation for `chainId`/`tokenAddress`                        |
| **Outcome**  | Both issues fixed: added `safeBigInt()` helper + constructor guards; 5 new tests added |
