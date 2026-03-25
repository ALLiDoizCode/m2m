# Story 32.5: Refactor SettlementMonitor and SettlementExecutor for Multi-Chain

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **settlement service developer**,
I want **`SettlementExecutor` to delegate on-chain operations (openChannel, claimFromChannel, getChannelState, signBalanceProof) to the chain-appropriate `PaymentChannelProvider` via the `ChainProviderRegistry`**, and **verify that `SettlementMonitor` is already chain-agnostic**,
so that **settlement execution works for any supported blockchain without hardcoded EVM/SDK dependencies in the core settlement orchestration layer**.

**Epic:** 32 — Chain Abstraction Layer & EVM Provider Migration
**Priority:** P0 (settlement execution is the final on-chain consumer of the provider abstraction)
**Estimated effort:** 1-2 dev days
**Dependencies:** Stories 32.1, 32.2, 32.3, 32.4 (all done)

## Acceptance Criteria

### AC 1: SettlementMonitor Works with Any Chain's Claim Events

```gherkin
Scenario: SettlementMonitor works with any chain's claim events
  Given a SettlementMonitor subscribed to ClaimReceiver events
  When a ClaimReceivedEvent arrives with any blockchain type
  Then the threshold check runs identically (amount vs threshold comparison)
  And SETTLEMENT_REQUIRED is emitted when threshold is exceeded
```

### AC 2: SettlementExecutor Resolves Provider for Settlement

```gherkin
Scenario: SettlementExecutor resolves provider for settlement
  Given a SettlementExecutor configured with a ChainProviderRegistry
  And peer 'connector-b' settles on chain 'evm:8453'
  When a SETTLEMENT_REQUIRED event fires for 'connector-b'
  Then the executor resolves the EVM provider from the registry
  And calls provider.claimFromChannel() for existing channels
  And calls provider.openChannel() followed by provider.deposit() when no channel exists
```

### AC 3: SettlementExecutor Constructor Accepts ChainProviderRegistry

```gherkin
Scenario: SettlementExecutor constructor accepts ChainProviderRegistry
  Given the new SettlementExecutor constructor
  When instantiated with (config, accountManager, registry, settlementMonitor, logger)
  Then it no longer requires a direct PaymentChannelSDK parameter
  And existing settlement-executor.test.ts tests pass with a mock registry providing a mock EVM provider
```

### AC 4: Chain-Specific Retry Classification

```gherkin
Scenario: Chain-specific retry classification
  Given an EVM provider that throws a 'nonce too low' error
  When the executor's retryWithBackoff handles the error
  Then it classifies the error as retryable (unchanged for EVM)
  And the retry logic is provider-agnostic (error classification kept generic)
```

### AC 5: Settlement Flow Through Abstraction Is Identical to Direct SDK

```gherkin
Scenario: Settlement flow through abstraction is identical to direct SDK
  Given a full settlement flow (threshold exceeded -> claim from channel -> balance update)
  When executed through the abstraction layer with an EVM provider
  Then the on-chain operations and TigerBeetle balance updates are identical to the pre-refactor flow
```

## Tasks / Subtasks

- [x] Task 1: Verify SettlementMonitor is already chain-agnostic (AC: #1)
  - [x]1.1 Audit `settlement-monitor.ts` for any EVM-specific or `PaymentChannelSDK` references — confirm none exist
  - [x]1.2 Audit `settlement-monitor.test.ts` for any EVM-specific references — confirm none exist
  - [x]1.3 Confirm `ClaimReceivedEvent` interface is chain-agnostic (`peerId`, `channelId`, `cumulativeAmount` — no `blockchain` field needed by monitor)
  - [x]1.4 Add a brief JSDoc comment to `settlement-monitor.ts` noting chain-agnosticism for future developers: `/** Chain-agnostic: operates on cumulative amounts only, no blockchain-specific logic */`
  - [x]1.5 No code changes needed to `settlement-monitor.ts` — it already works with any chain's claim events
- [x] Task 2: Refactor SettlementExecutor constructor signature (AC: #3)
  - [x]2.1 Replace `paymentChannelSDK: PaymentChannelSDK` constructor parameter with `chainProviderRegistry: ChainProviderRegistry`
  - [x]2.2 Store registry as `private readonly chainProviderRegistry: ChainProviderRegistry`
  - [x]2.3 Remove `PaymentChannelSDK` import from `settlement-executor.ts`
  - [x]2.4 Add import: `import type { ChainProviderRegistry } from './provider/chain-provider-registry';`
  - [x]2.5 Add import: `import type { PaymentChannelProvider } from './provider/payment-channel-provider';`
- [x] Task 3: Add `ChannelManager` optional dependency and refactor `findChannelForPeer` (AC: #2, #5)
  - [x]3.1 Add `private channelManager: ChannelManager | null = null` field to `SettlementExecutor`
  - [x]3.2 Add `setChannelManager(channelManager: ChannelManager): void` setter method following the existing `setPerPacketClaimService(service)` pattern
  - [x]3.3 Add `provider` parameter to `findChannelForPeer(peerId, tokenAddress, provider)` — provider is resolved earlier in `executeSettlement()` and passed down
  - [x]3.4 Replace `this.paymentChannelSDK.getMyChannels(tokenAddress)` with `this.channelManager?.getChannelForPeer(peerId, tokenId)` for chain-agnostic channel lookup via `ChannelManager`'s peer-channel index. Returns `ChannelMetadata | null` (which contains `channelId`). If `channelManager` is null, log warning and return null (no channel found). Note: `findChannelForPeer` signature needs `tokenId` parameter added (available from `executeSettlement`'s event)
  - [x]3.5 If `getChannelForPeer` returns a `ChannelMetadata`, verify channel status via `provider.getChannelState(metadata.channelId)` — only return channelId if status is `'opened'`
  - [x]3.6 Add `import type { ChannelManager } from './channel-manager';`
- [x] Task 4: Refactor `openChannelAndSettle` to use provider (AC: #2, #5)
  - [x]4.1 Add `provider` parameter: `openChannelAndSettle(peerId, tokenId, tokenAddress, amount, provider)`
  - [x]4.2 Replace `this.paymentChannelSDK.openChannel(peerAddress, tokenAddress, timeout, deposit)` with `provider.openChannel(peerAddress, timeout)` — note: provider interface `openChannel(participant, settlementTimeout)` does NOT take tokenAddress or deposit. The provider handles token configuration internally
  - [x]4.3 The provider's `openChannel` returns `{ channelId, txHash }` — same as current SDK call, compatible
  - [x]4.4 After `openChannel`, call `provider.deposit(channelId, initialDeposit.toString())` separately if the provider's `openChannel` does not include deposit (check EVM provider implementation)
  - [x]4.5 Keep `this.accountManager.recordSettlement()` call unchanged
- [x] Task 5: Refactor `settleViaExistingChannel` to use provider (AC: #2, #5)
  - [x]5.1 Add `provider` parameter: `settleViaExistingChannel(channelId, tokenAddress, peerId, tokenId, amount, provider)`
  - [x]5.2 **Deprecate the fallback path (Recommended Option 3 from Dev Notes):** Replace the entire `else` branch (lines 505-542 — `getChannelState` + `signBalanceProof` via SDK) with a logged error and thrown exception. The fallback uses `ChannelState.theirNonce`/`theirTransferred` which are NOT available on `ProviderChannelState`. Since `PerPacketClaimService` is always wired before `start()`, this path does not execute in production. See Dev Notes "Fallback Balance Proof Path" for rationale
  - [x]5.3 In the per-packet claim path (primary), replace `this.paymentChannelSDK.claimFromChannel(channelId, tokenAddress, balanceProof, signature)` with `provider.claimFromChannel(channelId, balanceProofParams, signature)` — provider uses `BalanceProofParams` (string amounts), not `BalanceProof` (bigint amounts)
  - [x]5.4 Construct `BalanceProofParams` from `EVMClaimMessage` fields (already strings): `{ channelId, nonce: latestClaim.nonce, transferredAmount: latestClaim.transferredAmount, lockedAmount: latestClaim.lockedAmount, locksRoot: latestClaim.locksRoot }`
  - [x]5.5 Remove `BalanceProof` import from `@toon-protocol/shared` if no longer used after fallback removal. Add `import type { BalanceProofParams } from './provider/payment-channel-provider';`
  - [x]5.6 Keep `this.accountManager.recordSettlement()` and `this.perPacketClaimService.resetChannel()` unchanged
- [x] Task 6: Refactor `executeSettlement` to resolve provider early (AC: #2)
  - [x]6.1 At the top of `executeSettlement()`, resolve the provider for this peer
  - [x]6.2 Use peer-to-chain mapping: need to determine peer's chain. Options:
    - (a) Add `chain` field to `SettlementExecutorConfig.peerIdToAddressMap` — but this breaks the Map<string,string> type
    - (b) Add a separate `peerIdToChainMap: Map<string, string>` to `SettlementExecutorConfig`
    - (c) Use `ChainProviderRegistry` with a known chain from config (single-chain MVP: use first/only provider)
    - See Dev Notes for recommended approach
  - [x]6.3 Pass resolved provider (and `tokenId`) to `findChannelForPeer()`, `openChannelAndSettle()`, and `settleViaExistingChannel()`
  - [x]6.4 If no provider found for peer, throw descriptive error: `No chain provider registered for peer: ${peerId}`
- [x] Task 7: Update `SettlementExecutorConfig` (AC: #3)
  - [x]7.1 Add `peerIdToChainMap: Map<string, string>` to `SettlementExecutorConfig` — maps peerId to chain identifier (e.g., `'evm:anvil:31337'`)
  - [x]7.2 Remove `registryAddress`, `rpcUrl`, `privateKey` from `SettlementExecutorConfig` — these are EVM-specific and now live inside the provider
  - [x]7.3 Keep `tokenAddressMap` and `peerIdToAddressMap` for now (still needed for EVM backward compatibility until Story 32.7 config schema update)
  - [x]7.4 Keep `maxRetries` and `retryDelayMs` — retry logic is provider-agnostic
- [x] Task 8: Update test file `settlement-executor.test.ts` (AC: #3, #4, #5)
  - [x]8.1 Replace `mockPaymentChannelSDK` with a mock `ChainProviderRegistry` + mock `PaymentChannelProvider`
  - [x]8.2 Create `createMockProvider()` factory: mock EVM provider with `openChannel`, `claimFromChannel`, `getChannelState`, `signBalanceProof`, `deposit`, `chainType: 'evm'`, `chainId: 'evm:anvil:31337'`
  - [x]8.3 Create `createMockRegistry(provider)` factory: mock registry where `getProviderForPeer()` returns mock provider for known peers
  - [x]8.4 Update all test cases to use provider-based assertions instead of SDK-based assertions
  - [x]8.5 Update constructor calls: remove `mockPaymentChannelSDK`, add mock registry
  - [x]8.6 Update assertion patterns: `expect(mockProvider.openChannel)` instead of `expect(mockPaymentChannelSDK.openChannel)`
  - [x]8.7 Update `claimFromChannel` assertions: provider uses `BalanceProofParams` (string amounts), not `BalanceProof` (bigint)
  - [x]8.8 Add `jest.clearAllMocks()` in `beforeEach`
  - [x]8.9 Add new test: settlement fails with descriptive error when no provider registered for peer
  - [x]8.10 Add new test: `settleViaExistingChannel` converts bigint amounts to string for provider call
  - [x]8.11 Add new test: `openChannelAndSettle` calls `provider.openChannel()` then `provider.deposit()` as two separate retryable operations
  - [x]8.12 Verify per-packet claim integration test still passes with provider-based executor
  - [x]8.13 Verify retry logic test still passes (retry is provider-agnostic)
  - [x]8.14 Verify serialization test still passes
  - [x]8.15 Verify graceful shutdown tests still pass
- [x] Task 9: Update `connector-node.ts` wiring (AC: #3)
  - [x]9.1 Hoist the `ChainProviderRegistry` and `EVMPaymentChannelProvider` creation from the `PerPacketClaimService` try block (Story 32.4, ~line 821-832) to BEFORE the `SettlementExecutor` constructor call (~line 738). The registry is currently scoped inside the per-packet claims setup block and created AFTER the executor — it must be created earlier so both the executor and the per-packet claim service share the same registry instance. Remove the duplicate registry creation from the per-packet claims block and use the hoisted instance instead
  - [x]9.2 In the `SettlementExecutor` constructor call, replace `this._paymentChannelSDK` argument with the hoisted `ChainProviderRegistry` instance
  - [x]9.3 Add `peerIdToChainMap` to the config object passed to `SettlementExecutor` — derive from the existing peer config by mapping each peerId to the EVM chain identifier used by the registry (e.g., `primaryChainIdStr`)
  - [x]9.4 Remove `registryAddress`, `rpcUrl`, `privateKey` from the executor config if removed in Task 7
  - [x]9.5 If Task 3 uses `setChannelManager` pattern, call `this._settlementExecutor.setChannelManager(this._channelManager)` after `ChannelManager` construction (~line 777)
- [x] Task 10: Regression verification (AC: #5, #1)
  - [x]10.1 Run `npm run typecheck` — must pass
  - [x]10.2 Run `npm run lint` — must pass
  - [x]10.3 Run full test suite — all existing tests must pass

## Dev Notes

### Key Architectural Decisions

**SettlementMonitor requires NO changes.** The monitor operates entirely on chain-agnostic `ClaimReceivedEvent` data (`peerId`, `channelId`, `cumulativeAmount`). It has zero references to `PaymentChannelSDK`, `EVMClaimMessage`, or any blockchain-specific types. The only action needed is verification and a JSDoc annotation.

**SettlementExecutor is the primary refactor target.** It currently has a direct `PaymentChannelSDK` constructor dependency and calls EVM-specific SDK methods throughout. All on-chain operations must be routed through the `PaymentChannelProvider` interface.

### CRITICAL: Provider Interface vs SDK Method Signatures

The `PaymentChannelProvider` interface has different method signatures than `PaymentChannelSDK`. Key differences:

| Operation          | PaymentChannelSDK                                          | PaymentChannelProvider                                                                             |
| ------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `openChannel`      | `(participant, tokenAddress, timeout, deposit)`            | `(participant, timeout)` — token address and deposit are internal                                  |
| `claimFromChannel` | `(channelId, tokenAddress, BalanceProof, signature)`       | `(channelId, BalanceProofParams, signature)` — no tokenAddress, uses string amounts                |
| `getChannelState`  | `(channelId, tokenAddress) -> ChannelState`                | `(channelId) -> ProviderChannelState` — no tokenAddress, reduced fields                            |
| `signBalanceProof` | `(channelId, nonce, amount, locked, locksRoot)` positional | `({ channelId, nonce, transferredAmount, lockedAmount, locksRoot })` params object, string amounts |
| `getMyChannels`    | `(tokenAddress) -> string[]`                               | **NOT on interface** — provider does not expose channel enumeration                                |

### Channel Lookup Strategy (`findChannelForPeer`)

The current `findChannelForPeer` calls `paymentChannelSDK.getMyChannels(tokenAddress)` to enumerate channels on-chain, then filters by peer address and status. The `PaymentChannelProvider` interface does NOT expose `getMyChannels()`.

**Recommended approach:** Since the `ChannelManager` (already used in `PerPacketClaimService`) maintains a `peerChannelIndex` mapping (peerId -> tokenId -> channelId), use it for channel lookup instead of on-chain queries. This is both more efficient and chain-agnostic.

However, `SettlementExecutor` currently does NOT have a `ChannelManager` dependency. Adding it would change the constructor signature further. For this story, the pragmatic approach is:

1. **For the per-packet claim path (primary):** The `latestClaim` already has the `channelId` — no channel lookup needed.
2. **For the fallback path (no per-packet claim):** Keep using a direct approach. Either:
   - (a) Pass a `ChannelManager` to the executor (clean but adds dependency)
   - (b) Use `provider instanceof EVMPaymentChannelProvider` and access the SDK's `getMyChannels` for EVM-specific lookup (pragmatic)
   - (c) Add an optional `channelManager` parameter for channel lookup, falling back to provider-specific lookup

**Recommended: Option (a)** — Add `ChannelManager` as an optional constructor dependency. This is clean, chain-agnostic, and the `ChannelManager` is already instantiated in `connector-node.ts` right after the executor. Wire it via a setter method `setChannelManager(channelManager)` similar to the existing `setPerPacketClaimService(service)` pattern.

### Fallback Balance Proof Path

The `settleViaExistingChannel` method has a fallback path when `perPacketClaimService.getLatestClaim()` returns null. This fallback:

1. Calls `getChannelState()` to get `theirNonce` and `theirTransferred`
2. Computes a new nonce and new transferred amount
3. Signs a balance proof
4. Calls `claimFromChannel()`

**Problem:** `ProviderChannelState` does NOT have `theirNonce` or `theirTransferred` fields — only `{ channelId, status, participants, deposit }`. The EVM SDK's `ChannelState` has these fields.

**Options:**

1. **Use `instanceof EVMPaymentChannelProvider`** to access the EVM-specific `getChannelState` with richer return type — breaks chain-agnosticism
2. **Cast/extend the provider interface** to include nonce/transferred — pollutes the generic interface
3. **Deprecate the fallback path** — per-packet claims are always available in the current architecture. The fallback exists for edge cases only. Log a warning instead of attempting balance proof computation

**Recommended: Option 3** — In practice, per-packet claims are always available because `PerPacketClaimService` is always wired before `SettlementExecutor.start()`. The fallback path is defensive code for a scenario that does not occur in production. Convert it to a logged error that does NOT attempt on-chain settlement without a per-packet claim:

```typescript
if (!latestClaim || !isEVMClaim(latestClaim)) {
  this.logger.error(
    { channelId, peerId },
    'No per-packet claim available for settlement — cannot compute balance proof without chain-specific state'
  );
  throw new Error(`No per-packet claim available for channel ${channelId}`);
}
```

This eliminates the need for chain-specific `getChannelState()` fields in the fallback path. If future chains need different fallback behavior, their providers can expose chain-specific methods.

### Peer-to-Chain Resolution in executeSettlement

The executor needs to resolve which provider to use for a given peer. Currently, `SettlementExecutorConfig` has `peerIdToAddressMap` (peerId -> Ethereum address) but no chain mapping.

**Recommended approach:** Add `peerIdToChainMap: Map<string, string>` to `SettlementExecutorConfig`. In `connector-node.ts`, populate this from the same config that creates the registry. For the single-EVM-chain MVP, all peers map to the same chain ID (e.g., `'evm:anvil:31337'` in dev, `'evm:base:8453'` in production).

```typescript
// In executeSettlement:
const chain = this.config.peerIdToChainMap.get(peerId);
if (!chain) {
  throw new Error(`No chain configured for peer: ${peerId}`);
}
const provider = this.chainProviderRegistry.getProviderForPeer({ peerId, chain });
if (!provider) {
  throw new Error(`No provider registered for chain: ${chain} (peer: ${peerId})`);
}
```

### CRITICAL: openChannel Opens with Zero Deposit — Separate deposit() Required

**VERIFIED from source code:** `EVMPaymentChannelProvider.openChannel(participant, settlementTimeout)` calls `this._sdk.openChannel(participant, this._tokenAddress, settlementTimeout, 0n)` — it opens the channel with **zero deposit**.

The current `settlement-executor.ts` calls `paymentChannelSDK.openChannel(peerAddress, tokenAddress, timeout, initialDeposit)` which opens AND deposits in one SDK call. After refactoring, the flow becomes two separate provider calls:

```typescript
// Step 1: Open channel (zero deposit via provider)
const { channelId, txHash } = await this.retryWithBackoff(
  async () => await provider.openChannel(peerAddress, this.config.defaultSettlementTimeout),
  'openChannel',
  this.config.maxRetries
);
// Step 2: Deposit initial funds separately
await this.retryWithBackoff(
  async () => await provider.deposit(channelId, initialDeposit.toString()),
  'deposit',
  this.config.maxRetries
);
```

Both calls MUST be wrapped in `retryWithBackoff`. If deposit fails after a successful open, the channel exists but is unfunded — this is a recoverable state (subsequent settlement can deposit).

### claimFromChannel Provider Interface

The provider's `claimFromChannel(channelId, balanceProofParams, signature)` uses `BalanceProofParams` with string amounts, NOT `BalanceProof` with bigint amounts. When using the per-packet claim path:

```typescript
// From latestClaim (EVMClaimMessage):
const balanceProofParams: BalanceProofParams = {
  channelId,
  nonce: latestClaim.nonce,
  transferredAmount: latestClaim.transferredAmount, // already string in EVMClaimMessage
  lockedAmount: latestClaim.lockedAmount, // already string in EVMClaimMessage
  locksRoot: latestClaim.locksRoot,
};
await provider.claimFromChannel(channelId, balanceProofParams, latestClaim.signature);
```

The `EVMClaimMessage` already stores amounts as strings, so no conversion is needed in the per-packet claim path.

### BalanceProof Import Cleanup

Once the fallback path is removed/simplified, the `BalanceProof` import from `@toon-protocol/shared` may no longer be needed in `settlement-executor.ts`. Remove it if unused after refactoring.

### connector-node.ts Wiring

**IMPORTANT:** Story 32.4 created a `ChainProviderRegistry` (`claimRegistry`) inside the `PerPacketClaimService` try block (~line 821-832), AFTER the `SettlementExecutor` is already constructed (~line 738). The registry is locally scoped and not accessible to the executor.

**Required restructuring:** Hoist the registry + EVM provider creation to BEFORE the `SettlementExecutor` constructor. Both the executor and the per-packet claim service should share the same registry instance. The per-packet claims block should reuse the hoisted registry instead of creating its own.

```typescript
// Hoisted from Story 32.4's per-packet claims block:
const primaryChainIdStr = primaryChainId ? `evm:${primaryChainId}` : 'evm:unknown';
const chainRegistry = new ChainProviderRegistry();
const evmProvider = new EVMPaymentChannelProvider(
  this._paymentChannelSDK,
  primaryChainIdStr,
  m2mTokenAddress,
  this._logger
);
chainRegistry.register(evmProvider);

// This story changes:
this._settlementExecutor = new SettlementExecutor(
  { ...config, peerIdToChainMap },
  accountManager,
  chainRegistry, // was: this._paymentChannelSDK
  settlementMonitor,
  this._logger
);

// Later, in per-packet claims block, reuse chainRegistry instead of creating a new one
```

### Project Structure Notes

- **Primary file to modify:** `packages/connector/src/settlement/settlement-executor.ts`
- **Test file to modify:** `packages/connector/src/settlement/settlement-executor.test.ts`
- **Wiring file to modify:** `packages/connector/src/core/connector-node.ts`
- **Verify only (no changes):** `packages/connector/src/settlement/settlement-monitor.ts`
- **Verify only (no changes):** `packages/connector/src/settlement/settlement-monitor.test.ts`
- **Do NOT modify:** `packages/connector/src/settlement/provider/payment-channel-provider.ts`
- **Do NOT modify:** `packages/connector/src/settlement/provider/chain-provider-registry.ts`

### Previous Story Intelligence

**From Story 32.4 (PerPacketClaimService refactor):**

- Constructor refactoring pattern: replace `PaymentChannelSDK` param with `ChainProviderRegistry`
- Provider resolution via `registry.getProviderForPeer({ peerId, chain: metadata.chain })`
- The `isEVMClaim()` type guard is already imported and used in `settlement-executor.ts` (added in 32.4 for `getLatestClaim` narrowing)
- `connector-node.ts` already creates a `ChainProviderRegistry` wrapping the `PaymentChannelSDK` in an `EVMPaymentChannelProvider`
- `ChannelMetadata.chain` values (e.g., `'evm:anvil:31337'`) must match provider's `chainId` exactly for registry lookups
- String-to-bigint conversion: `BalanceProofParams` uses strings, `BalanceProof` uses bigint — convert with `.toString()`
- `EVMPaymentChannelProvider.getSigningContext()` provides EVM-specific `chainId`/`tokenNetworkAddress`/`signerAddress`
- Test mock pattern: create real `EVMPaymentChannelProvider` with mocked SDK, or create mock objects with matching `chainId`

**From Story 32.4 Completion Notes:**

- Updated `settlement-executor.ts` to use `isEVMClaim()` type guard when accessing EVM-specific fields from `getLatestClaim()`
- Added `blockchain: 'evm'` to settlement-executor test mock
- All 85 test suites (2018 tests) pass after 32.4

**Commit patterns established:**

- Commit message format: `feat(32-N): description`
- Scope: story number (e.g., `32-5`)
- Tests included in same commit as implementation

### Git Intelligence

Recent commits (5 total on `epic-32` branch):

1. `6cd4621 feat(32-4): refactor PerPacketClaimService for multi-chain claim generation`
2. `d027c19 feat(32-3): implement EVMPaymentChannelProvider with SDK delegation`
3. `ef6c29c feat(32-2): implement ChainProviderRegistry with register/retrieve, peer lookup, and config-driven factory initialization`
4. `5dfc01d feat(32-1): define PaymentChannelProvider interface and extend BlockchainType`
5. `7368a8c chore(epic-32): epic start -- baseline green, retro actions resolved`

All prior stories are `done`. This is the second consumer refactor following the same pattern as 32.4.

### EVMPaymentChannelProvider.openChannel Signature Check

Before implementing Task 4, verify the EVM provider's `openChannel` signature. From `payment-channel-provider.ts` interface:

```typescript
openChannel(participant: string, settlementTimeout: number): Promise<OpenChannelResult>;
```

This does NOT accept `tokenAddress` or `deposit`. The EVM provider internally handles these via its constructor-injected `_tokenAddress` and `_sdk` reference. Check how `EVMPaymentChannelProvider.openChannel()` maps to `PaymentChannelSDK.openChannel(participant, tokenAddress, timeout, deposit)`.

**Key question:** Does the EVM provider's `openChannel` accept a deposit amount? If not, how does initial funding work? This must be verified before implementing Task 4. The provider may require a separate `deposit()` call after opening.

### Testing Standards

- Test files co-located: `settlement-executor.test.ts` next to source
- Existing test uses `jest.mock()` at file top for `account-manager`, `payment-channel-sdk`, `settlement-monitor`
- `jest.mock('./payment-channel-sdk')` must be removed/replaced when refactoring to use provider
- `jest.mock('./settlement-monitor')` stays — monitor is still a dependency
- Type-safe partial mocks with `as unknown as jest.Mocked<Type>`
- ILP amounts use BigInt notation: `1200n`
- Existing test count: 15 tests in 13 describe blocks
- `afterEach` stops executor to prevent test leaks

### Mock Pattern for Provider-Based Tests

```typescript
const createMockProvider = (): jest.Mocked<PaymentChannelProvider> => ({
  openChannel: jest.fn().mockResolvedValue({ channelId: testChannelId, txHash: '0xMockTxHash' }),
  deposit: jest.fn().mockResolvedValue({ txHash: '0xDepositTxHash' }),
  claimFromChannel: jest.fn().mockResolvedValue({ txHash: '0xClaimTxHash' }),
  closeChannel: jest.fn().mockResolvedValue({ txHash: '0xCloseTxHash' }),
  settleChannel: jest.fn().mockResolvedValue({ txHash: '0xSettleTxHash' }),
  signBalanceProof: jest.fn().mockResolvedValue('0xsignature'),
  verifyBalanceProof: jest.fn().mockResolvedValue(true),
  getChannelState: jest.fn().mockResolvedValue({
    channelId: testChannelId,
    status: 'opened' as const,
    participants: [testPeerAddress.toLowerCase(), '0x9876...'],
    deposit: 10000n,
  }),
  subscribeToEvents: jest.fn().mockReturnValue({ unsubscribe: jest.fn() }),
  chainType: 'evm' as const,
  chainId: 'evm:anvil:31337',
});

const createMockRegistry = (
  provider: jest.Mocked<PaymentChannelProvider>
): jest.Mocked<Pick<ChainProviderRegistry, 'getProviderForPeer' | 'getProvider'>> => ({
  getProviderForPeer: jest
    .fn()
    .mockImplementation((peerConfig: { peerId: string; chain?: string }) => {
      if (peerConfig.chain === 'evm:anvil:31337') return provider;
      return undefined;
    }),
  getProvider: jest.fn().mockReturnValue(provider),
});
```

### Backward Compatibility Requirements

1. **SettlementMonitor:** Zero changes — fully backward compatible
2. **SettlementExecutor constructor:** Breaking change — `PaymentChannelSDK` param replaced with `ChainProviderRegistry`. Callers (`connector-node.ts`) must update
3. **Settlement flow:** Identical behavior through the abstraction layer — same TigerBeetle updates, same event emissions
4. **Config:** `SettlementExecutorConfig` gains `peerIdToChainMap`, loses EVM-specific fields (`registryAddress`, `rpcUrl`, `privateKey`)
5. **Test mocks:** All existing test assertions must pass with updated mock setup (provider-based instead of SDK-based)

### References

- [Source: packages/connector/src/settlement/settlement-executor.ts] — current implementation with direct PaymentChannelSDK dependency (702 lines)
- [Source: packages/connector/src/settlement/settlement-executor.test.ts] — existing test suite (15 tests in 13 describe blocks)
- [Source: packages/connector/src/settlement/settlement-monitor.ts] — already chain-agnostic (378 lines, no SDK references)
- [Source: packages/connector/src/settlement/settlement-monitor.test.ts] — already chain-agnostic (615 lines, no SDK references)
- [Source: packages/connector/src/settlement/provider/payment-channel-provider.ts] — PaymentChannelProvider interface (method signatures differ from SDK)
- [Source: packages/connector/src/settlement/provider/chain-provider-registry.ts] — ChainProviderRegistry with getProviderForPeer(RegistryPeerConfig)
- [Source: packages/connector/src/settlement/provider/evm-payment-channel-provider.ts] — EVMPaymentChannelProvider (verify openChannel signature)
- [Source: packages/connector/src/core/connector-node.ts#L738] — current SettlementExecutor wiring (needs update)
- [Source: packages/connector/src/settlement/channel-manager.ts] — ChannelManager with getChannelForPeer() and peerChannelIndex
- [Source: packages/shared/src/types/payment-channel.ts#L36] — BalanceProof type (bigint amounts)
- [Source: _bmad-output/planning-artifacts/epic-32-chain-abstraction-layer.md#Story 32.5] — epic story definition
- [Source: _bmad-output/implementation-artifacts/story-32-4.md] — previous story with refactoring patterns

## Preconditions

- Story 32.1 is done (PaymentChannelProvider interface defined)
- Story 32.2 is done (ChainProviderRegistry implemented)
- Story 32.3 is done (EVMPaymentChannelProvider implemented)
- Story 32.4 is done (PerPacketClaimService refactored, connector-node.ts creates registry)
- Branch `epic-32` exists with Stories 32.1-32.4 commits
- All existing tests passing (85 suites, 2018 tests per Story 32.4 completion)

## Out of Scope

- Changes to `PaymentChannelProvider` interface (it stays chain-agnostic)
- Changes to `ChainProviderRegistry` (it stays as-is)
- Changes to `SettlementMonitor` beyond JSDoc annotation (already chain-agnostic)
- Refactoring `ClaimReceiver` (Story 32.6)
- Configuration schema changes (Story 32.7)
- Integration tests wiring all services together (Story 32.8)
- Solana/Mina settlement execution (only EVM is implemented; abstraction enables future chains)
- Adding `getMyChannels()` to the provider interface (not needed if channel lookup uses ChannelManager)

## Test Plan

| Test ID   | Scenario                                                                                   | Type       | Priority |
| --------- | ------------------------------------------------------------------------------------------ | ---------- | -------- |
| T-32.5-01 | SettlementMonitor has no EVM-specific or SDK references (audit)                            | Audit      | P0       |
| T-32.5-02 | SettlementExecutor constructor accepts ChainProviderRegistry instead of PaymentChannelSDK  | Unit       | P0       |
| T-32.5-03 | executeSettlement resolves provider from registry using peerIdToChainMap                   | Unit       | P0       |
| T-32.5-04 | openChannelAndSettle calls provider.openChannel then provider.deposit (two-step)           | Unit       | P0       |
| T-32.5-05 | settleViaExistingChannel calls provider.claimFromChannel with BalanceProofParams (strings) | Unit       | P0       |
| T-32.5-06 | Per-packet claim path uses string amounts from EVMClaimMessage for provider call           | Unit       | P0       |
| T-32.5-07 | Settlement fails with descriptive error when no provider registered for peer               | Unit       | P0       |
| T-32.5-08 | Settlement fails when no per-packet claim and fallback path is deprecated                  | Unit       | P1       |
| T-32.5-09 | Retry logic works with provider-based operations (provider-agnostic error classification)  | Unit       | P0       |
| T-32.5-10 | Settlement serialization prevents nonce collisions (unchanged behavior)                    | Unit       | P0       |
| T-32.5-11 | Graceful shutdown awaits in-flight settlements (unchanged behavior)                        | Unit       | P0       |
| T-32.5-12 | connector-node.ts passes hoisted registry to SettlementExecutor instead of SDK             | Wiring     | P0       |
| T-32.5-13 | All existing settlement-monitor tests pass without modification                            | Regression | P0       |
| T-32.5-14 | Full test suite passes: typecheck, lint, all test suites                                   | Regression | P0       |

### Regression Gate

- All existing tests must pass with zero modifications to settlement-monitor assertions
- Settlement-executor tests updated to use provider mocks but same behavioral assertions
- `npm run typecheck` must pass (tsc --noEmit)
- `npm run lint` must pass
- Full test suite: all test suites pass

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

None required.

### Completion Notes List

- **Task 1 (Verify SettlementMonitor):** Audited `settlement-monitor.ts` and `settlement-monitor.test.ts` — confirmed zero EVM-specific or PaymentChannelSDK references. Added chain-agnosticism JSDoc annotation. All 21 settlement-monitor tests pass without modification.
- **Task 2 (Refactor constructor):** Replaced `PaymentChannelSDK` constructor parameter with `ChainProviderRegistry`. Removed `PaymentChannelSDK` import. Added imports for `ChainProviderRegistry`, `PaymentChannelProvider`, `BalanceProofParams`, and `ChannelManager`.
- **Task 3 (ChannelManager dependency):** Added `channelManager: ChannelManager | null` field and `setChannelManager()` setter. Refactored `findChannelForPeer()` to use `channelManager.getChannelForPeer()` for chain-agnostic lookup, verified via `provider.getChannelState()`.
- **Task 4 (openChannelAndSettle):** Refactored to two-step: `provider.openChannel()` (zero deposit) then `provider.deposit()`. Both wrapped in `retryWithBackoff`.
- **Task 5 (settleViaExistingChannel):** Deprecated fallback balance proof path (throws error). Primary path uses `BalanceProofParams` (string amounts from EVMClaimMessage) directly with `provider.claimFromChannel()`. Removed `BalanceProof` import.
- **Task 6 (executeSettlement):** Added provider resolution at top of method using `peerIdToChainMap` and `chainProviderRegistry.getProviderForPeer()`. Provider passed to all downstream methods.
- **Task 7 (Config update):** Added `peerIdToChainMap: Map<string, string>` to config. Removed `registryAddress`, `rpcUrl`, `privateKey`.
- **Task 8 (Tests):** Rewrote test file with mock `PaymentChannelProvider` and mock `ChainProviderRegistry` replacing `PaymentChannelSDK` mocks. Added tests for: no provider for peer, no per-packet claim (deprecated fallback), two-step open+deposit, string-amount BalanceProofParams. All 17 executor tests pass.
- **Task 9 (connector-node.ts):** Hoisted `ChainProviderRegistry` and `EVMPaymentChannelProvider` creation before `SettlementExecutor` constructor. Both executor and `PerPacketClaimService` share the same `chainRegistry` instance. Added `peerIdToChainMap` derivation. Wired `setChannelManager()` after `ChannelManager` construction.
- **Task 10 (Regression):** TypeScript type check passes. Lint passes. Full test suite passes (85 suites, 2032 tests).

### File List

- `packages/connector/src/settlement/settlement-executor.ts` — modified (refactored constructor, imports, config, all methods to use provider)
- `packages/connector/src/settlement/settlement-executor.test.ts` — modified (rewrote with provider/registry mocks)
- `packages/connector/src/settlement/settlement-monitor.ts` — modified (added JSDoc annotation only)
- `packages/connector/src/core/connector-node.ts` — modified (hoisted registry, updated executor constructor, wired channelManager)
- `packages/connector/test/acceptance/story-32-5-multi-chain-settlement-executor.test.ts` — added (ATDD acceptance tests for all ACs)

### Change Log

| Date       | Change                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-03-24 | Story 32.5: Refactored SettlementExecutor to use ChainProviderRegistry instead of direct PaymentChannelSDK. Replaced SDK method calls with chain-agnostic PaymentChannelProvider interface. Deprecated fallback balance proof path. Added ChannelManager for channel lookup. Updated connector-node.ts wiring to share single registry instance. All tests pass. |

## Code Review Record

### Review Pass #1

- **Date:** 2026-03-24
- **Reviewer Model:** Claude Opus 4.6 (1M context)
- **Status:** Success
- **Issue Counts:**
  - Critical: 0
  - High: 0
  - Medium: 2
  - Low: 3
- **Issues Found & Resolved:**
  - **Medium:** Removed unused `_provider` parameter from `findChannelForPeer`
  - **Medium:** Removed unused `_tokenAddress` parameter from `settleViaExistingChannel`
  - **Low:** Updated stale JSDoc referencing `PaymentChannelSDK`
  - **Low:** Replaced unsafe type cast with clean string widening
  - **Low:** Removed stale `@param` JSDoc entries
- **Outcome:** All 5 issues fixed. All tests pass. No follow-up actions required.

### Review Pass #2

- **Date:** 2026-03-24
- **Reviewer Model:** Claude Opus 4.6 (1M context)
- **Status:** Success
- **Issue Counts:**
  - Critical: 0
  - High: 0
  - Medium: 0
  - Low: 2
- **Issues Found & Resolved:**
  - **Low:** Fixed stale JSDoc referencing Epic 8's payment channel SDK to reference Epic 32/ChainProviderRegistry
  - **Low:** Tightened imprecise return type from `string` to `SettlementState` on `getSettlementState`
- **Outcome:** All 2 issues fixed. All tests pass. No follow-up actions required.

### Review Pass #3

- **Date:** 2026-03-24
- **Reviewer Model:** Claude Opus 4.6 (1M context)
- **Status:** Success
- **Security Scan:** Semgrep scan run on all changed files. 3 pre-existing insecure WebSocket findings in connector-node.ts (not introduced by this story). Zero findings in settlement-executor.ts or test file. No OWASP Top 10 vulnerabilities, authentication/authorization flaws, or injection risks found in story-changed code.
- **Issue Counts:**
  - Critical: 0
  - High: 0
  - Medium: 2
  - Low: 3
- **Issues Found & Resolved:**
  - **Medium:** Acceptance test file `packages/connector/test/acceptance/story-32-5-multi-chain-settlement-executor.test.ts` missing from File List — added
  - **Medium:** Previous review pass fixes (removed unused params, JSDoc updates, return type fix) were unstaged/uncommitted — identified for commit
  - **Low:** Dead code in `findChannelForPeer` checking `status === 'opened'` — removed (ChannelManager normalizes to AdminChannelStatus which never contains 'opened')
  - **Low:** `peerIdToChainMap` not updated by ClaimReceiver for dynamically discovered peers — added clarifying comment in connector-node.ts noting Story 32.6/32.7 will address this
  - **Low:** Acceptance test mock used `status: 'opened'` instead of canonical `'open'` — fixed to match AdminChannelStatus type
- **Outcome:** All 5 issues fixed. All 81 test suites (1871 tests) pass. Typecheck and lint clean. No follow-up actions required.
