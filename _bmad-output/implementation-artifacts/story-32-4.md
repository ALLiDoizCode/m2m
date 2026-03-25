# Story 32.4: Refactor PerPacketClaimService for Multi-Chain

Status: done

## Story

As a **settlement service developer**,
I want **`PerPacketClaimService` to delegate balance proof signing to the chain-appropriate `PaymentChannelProvider` via the `ChainProviderRegistry`**,
so that **claim generation works for any supported blockchain without hardcoded EVM dependencies in the core settlement service**.

**Epic:** 32 — Chain Abstraction Layer & EVM Provider Migration
**Priority:** P0 (first consumer of the provider abstraction; validates the 32.1-32.3 interface design)
**Estimated effort:** 1-2 dev days
**Dependencies:** Stories 32.1, 32.2, 32.3 (all done)

## Acceptance Criteria

### AC 1: Claim Generation Delegates to Provider for Signing

```gherkin
Scenario: Claim generation delegates to provider for signing
  Given a PerPacketClaimService configured with a ChainProviderRegistry
  And peer 'connector-b' is configured to settle on chain 'evm:8453'
  When generateClaimForPacket('connector-b', 'M2M', 1000n) is called
  Then the service resolves the EVM provider from the registry using the channel's chain metadata
  And calls provider.signBalanceProof({ channelId, nonce, transferredAmount, lockedAmount, locksRoot })
  And returns a PerPacketClaimResult with the signed claim
```

### AC 2: Claim Message Type Determined by Peer's Chain

```gherkin
Scenario: Claim message type determined by peer's chain
  Given peer 'connector-b' is configured for 'evm'
  And peer 'connector-c' is configured for 'solana' (future)
  When generateClaimForPacket is called for 'connector-b'
  Then the resulting claim has blockchain: 'evm'
  When generateClaimForPacket is called for 'connector-c'
  Then the resulting claim has blockchain: 'solana'
```

### AC 3: Self-Describing Claim Format Includes Blockchain Discriminator

```gherkin
Scenario: Self-describing claim format includes blockchain discriminator
  Given a generated claim for an EVM peer
  When the claim is serialized to JSON
  Then it contains a 'blockchain' field with value 'evm'
  And it contains chainId, tokenNetworkAddress, tokenAddress fields (unchanged from current behavior)
```

### AC 4: Backward Compatibility with Existing Claim Generation

```gherkin
Scenario: Backward compatibility with existing claim generation
  Given the existing per-packet-claim-service.test.ts test suite
  When tests are executed with an EVM provider registered in the registry
  Then all existing tests pass (claims are identical in structure and content)
```

### AC 5: No Provider Found for Peer Results in Null Return

```gherkin
Scenario: No provider found for peer results in null return
  Given a peer 'unknown-peer' with no configured chain provider
  When generateClaimForPacket('unknown-peer', 'M2M', 1000n) is called
  Then null is returned (same behavior as current "no channel" case)
```

## Tasks / Subtasks

- [x] Task 1: Add `getSigningContext()` to `EVMPaymentChannelProvider` (AC: #1, #3)
  - [x]1.1 Add public method `getSigningContext(): Promise<{ chainId: number; tokenNetworkAddress: string; signerAddress: string }>` to `EVMPaymentChannelProvider` in `evm-payment-channel-provider.ts`
  - [x]1.2 Implementation delegates to `this._sdk.getChainId()`, `this._sdk.getTokenNetworkAddress(this._tokenAddress)`, `this._sdk.getSignerAddress()` via `Promise.all`
  - [x]1.3 Add unit test for `getSigningContext()` in `evm-payment-channel-provider.test.ts`
  - [x]1.4 Do NOT modify the `PaymentChannelProvider` interface — this is an EVM-specific concrete method
- [x] Task 2: Refactor constructor signature (AC: #1, #4)
  - [x]2.1 Change constructor param from `paymentChannelSDK: PaymentChannelSDK` to `chainProviderRegistry: ChainProviderRegistry`
  - [x]2.2 Store registry as `private readonly _registry: ChainProviderRegistry`
  - [x]2.3 Remove `PaymentChannelSDK` import from per-packet-claim-service.ts
- [x] Task 3: Refactor `ChannelClaimContext` to include provider reference (AC: #1, #2)
  - [x]3.1 Add `provider: PaymentChannelProvider` field to `ChannelClaimContext` interface
  - [x]3.2 Add `blockchain: BlockchainType` field to `ChannelClaimContext` for claim construction
  - [x]3.3 Keep `chainId`, `tokenNetworkAddress`, `tokenAddress`, `signerAddress` as optional fields for EVM claim construction — these are populated only when `provider.chainType === 'evm'`
- [x] Task 4: Refactor `buildChannelContext` to use registry (AC: #1, #5)
  - [x]4.1 After getting `ChannelMetadata` from `channelManager`, extract `metadata.chain` field
  - [x]4.2 Use `this._registry.getProviderForPeer({ peerId, chain: metadata.chain })` to resolve provider (public API)
  - [x]4.3 Return null if no provider found (matches existing "no channel" null behavior)
  - [x]4.4 For EVM providers: check `provider instanceof EVMPaymentChannelProvider`, call `provider.getSigningContext()` to get chainId/tokenNetworkAddress/signerAddress
  - [x]4.5 For non-EVM providers: set blockchain from `provider.chainType`, leave EVM-specific fields undefined
  - [x]4.6 Preserve the existing `channelManager.ensureChannelExists()` on-demand creation flow before the registry lookup
- [x] Task 5: Refactor `generateClaimForPacket` to use provider for signing (AC: #1, #2, #3)
  - [x]5.1 Call `ctx.provider.signBalanceProof({ channelId, nonce, transferredAmount: newCumulative.toString(), lockedAmount: '0', locksRoot })` instead of `paymentChannelSDK.signBalanceProof()`
  - [x]5.2 Use `ctx.blockchain` to set the claim's `blockchain` discriminator field
  - [x]5.3 Keep EVMClaimMessage construction for EVM chains (backward compatible) — guard with `if (ctx.blockchain === 'evm')`
  - [x]5.4 For future chains, the claim message type should be determined by the blockchain discriminator
- [x] Task 6: Widen return types for multi-chain support (AC: #2, #3)
  - [x]6.1 Change `latestClaim` map type from `Map<string, EVMClaimMessage>` to `Map<string, BTPClaimMessage>`
  - [x]6.2 Change `getLatestClaim` return type from `EVMClaimMessage | null` to `BTPClaimMessage | null`
  - [x]6.3 Change `PerPacketClaimResult.claimMessage` type from `EVMClaimMessage` to `BTPClaimMessage`
  - [x]6.4 Change `persistClaim` parameter type from `EVMClaimMessage` to `BTPClaimMessage` — the method serializes to JSON, so this is safe for all claim types
  - [x]6.5 Update `recoverFromDb`: remove the `WHERE blockchain = 'evm'` filter, use `isEVMClaim()` type guard from `btp-claim-types.ts` when parsing recovered claims, cast via discriminator for proper typing
  - [x]6.6 Ensure `resetChannel` method needs no changes (it operates on channelId keys only, type-agnostic)
- [x] Task 7: Update test file (AC: #4, #5)
  - [x]7.1 Replace `mockSDK` in tests with a mock `ChainProviderRegistry` containing a mock EVM provider
  - [x]7.2 Create mock EVM provider with `signBalanceProof` returning `'0xmocksignature'` and `getSigningContext()` returning `{ chainId: 31337, tokenNetworkAddress: '0xTokenNetworkAddress1234567890abcdef', signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' }`
  - [x]7.3 Mock registry's `getProviderForPeer` to return the mock EVM provider for known peers
  - [x]7.4 **CRITICAL**: Align `ChannelMetadata.chain` values in mocks with the provider's `chainId` — use the same string (e.g., `'evm:anvil:31337'`) for both `metadata.chain` and the registered provider's `chainId`
  - [x]7.5 Add `jest.clearAllMocks()` in `beforeEach`
  - [x]7.6 Verify all existing test assertions still pass (claim structure unchanged)
  - [x]7.7 Add new test: claim for peer with no provider returns null
  - [x]7.8 Add new test: claim blockchain discriminator matches peer's chain type
  - [x]7.9 Add new test: recoverFromDb handles claims without `blockchain = 'evm'` filter
- [x] Task 8: Regression verification (AC: #4)
  - [x]8.1 Run `npm run typecheck` — must pass
  - [x]8.2 Run `npm run lint` — must pass
  - [x]8.3 Run full test suite — all existing tests must pass unchanged

## Dev Notes

### Key Architectural Decisions

**Delegation pattern:** `PerPacketClaimService` currently calls `PaymentChannelSDK.signBalanceProof(channelId, nonce, cumulative, 0n, locksRoot)` with positional args. The provider interface uses `signBalanceProof(params: BalanceProofParams)` with a params object where amounts are **strings** (not bigint). You must convert `newCumulative.toString()` before calling the provider.

**Provider interface method signature** (from `payment-channel-provider.ts`):

```typescript
signBalanceProof(params: BalanceProofParams): Promise<string>;

interface BalanceProofParams {
  channelId: string;
  nonce: number;
  transferredAmount: string;  // string, not bigint
  lockedAmount: string;       // string, not bigint
  locksRoot: string;
}
```

### CRITICAL: Chain ID Format Alignment

`ChannelMetadata.chain` (e.g., `'evm:anvil:31337'`) must match the `provider.chainId` registered in the registry. The registry's `getProviderForPeer({ peerId, chain })` does a direct `Map.get(chain)` lookup. If the `ChannelMetadata.chain` value does not exactly match the `provider.chainId`, the lookup returns `undefined` silently.

**In test mocks:** Use the SAME chain string for both `ChannelMetadata.chain` and the mock provider's `chainId`. The existing test mocks use `'evm:anvil:31337'` for metadata — register the mock provider with `chainId: 'evm:anvil:31337'` to match.

**In production:** The `ChannelManager` sets `metadata.chain` during channel creation. The provider's `chainId` is set at construction. These must be configured consistently. This alignment is fully resolved in Story 32.7/32.8 config wiring.

### EVM-Specific Context via getSigningContext()

The `PaymentChannelProvider` interface does NOT expose `getChainId()`, `getTokenNetworkAddress()`, or `getSignerAddress()` — those are EVM SDK internals. However, `EVMClaimMessage` construction requires `chainId` (number), `tokenNetworkAddress` (hex string), and `signerAddress` (hex string).

**Solution:** Add a concrete `getSigningContext()` method to `EVMPaymentChannelProvider` (NOT to the interface). In `buildChannelContext`, use `provider instanceof EVMPaymentChannelProvider` to detect EVM providers and call `getSigningContext()`.

```typescript
// Add to EVMPaymentChannelProvider (evm-payment-channel-provider.ts)
async getSigningContext(): Promise<{ chainId: number; tokenNetworkAddress: string; signerAddress: string }> {
  const [chainId, tokenNetworkAddress, signerAddress] = await Promise.all([
    this._sdk.getChainId(),
    this._sdk.getTokenNetworkAddress(this._tokenAddress),
    this._sdk.getSignerAddress(),
  ]);
  return { chainId, tokenNetworkAddress, signerAddress };
}
```

**In buildChannelContext:**

```typescript
let evmContext: { chainId: number; tokenNetworkAddress: string; signerAddress: string } | undefined;
if (provider instanceof EVMPaymentChannelProvider) {
  evmContext = await provider.getSigningContext();
}
return {
  channelId: metadata.channelId,
  provider,
  blockchain: provider.chainType,
  tokenAddress: metadata.tokenAddress,
  ...(evmContext && {
    chainId: evmContext.chainId,
    tokenNetworkAddress: evmContext.tokenNetworkAddress,
    signerAddress: evmContext.signerAddress,
  }),
};
```

### On-Demand Channel Creation Flow

The current `buildChannelContext` has an on-demand channel creation flow: if `channelManager.getChannelForPeer()` returns null, it calls `channelManager.ensureChannelExists()` and retries. **Preserve this flow unchanged** — add the registry lookup AFTER the channel metadata is successfully obtained.

### ChannelClaimContext Refactored Interface

```typescript
interface ChannelClaimContext {
  channelId: string;
  provider: PaymentChannelProvider;
  blockchain: BlockchainType;
  tokenAddress: string;
  // EVM-specific fields (populated only when blockchain === 'evm')
  chainId?: number;
  tokenNetworkAddress?: string;
  signerAddress?: string;
}
```

### recoverFromDb Refactor

Current code filters `WHERE blockchain = 'evm'`. Widen to recover all blockchain types:

```typescript
// Before: WHERE blockchain = 'evm'
// After: Remove the filter, recover all claims
const rows = this.db
  .prepare(
    `
  SELECT claim_data FROM sent_claims
  ORDER BY sent_at DESC
`
  )
  .all() as Array<{ claim_data: string }>;

// Parse and type-check using discriminator
for (const row of rows) {
  const claim = JSON.parse(row.claim_data) as BTPClaimMessage;
  if (isEVMClaim(claim)) {
    // EVMClaimMessage-specific recovery
  }
  // For all types: recover nonce/cumulative from common fields if present
}
```

**Note:** Only `EVMClaimMessage` currently has `channelId`, `nonce`, `transferredAmount` fields needed for state recovery. For Solana/Mina claims, the recovery fields will differ. For now, use `isEVMClaim()` to narrow and recover EVM claims. Non-EVM claims can be stored in `latestClaim` but nonce/cumulative recovery is EVM-specific until future chain implementations define their state model.

### persistClaim Type Widening

The `persistClaim(peerId, claim)` method parameter is currently typed `EVMClaimMessage`. Change to `BTPClaimMessage`. The method body uses `claim.messageId`, `claim.blockchain`, and `JSON.stringify(claim)` — all fields exist on `BaseClaimMessage`, so this is safe.

### File Locations

- **Primary file to modify:** `packages/connector/src/settlement/per-packet-claim-service.ts`
- **Test file to modify:** `packages/connector/src/settlement/per-packet-claim-service.test.ts`
- **Minor addition:** `packages/connector/src/settlement/provider/evm-payment-channel-provider.ts` (add `getSigningContext()`)
- **Test addition:** `packages/connector/src/settlement/provider/evm-payment-channel-provider.test.ts` (add test for `getSigningContext()`)
- **Do NOT modify:** `packages/connector/src/settlement/provider/payment-channel-provider.ts` (interface stays clean)
- **Do NOT modify:** `packages/connector/src/btp/btp-claim-types.ts` (types already support multi-chain)

### Import Changes

Remove:

```typescript
import type { PaymentChannelSDK } from './payment-channel-sdk';
```

Add:

```typescript
import type { ChainProviderRegistry } from './provider/chain-provider-registry';
import type { PaymentChannelProvider } from './provider/payment-channel-provider';
import type { BlockchainType } from '../btp/btp-claim-types';
import { type BTPClaimMessage, isEVMClaim, EVMClaimMessage } from '../btp/btp-claim-types';
import { EVMPaymentChannelProvider } from './provider/evm-payment-channel-provider';
```

**Note:** `EVMPaymentChannelProvider` is a value import (needed for `instanceof`). `isEVMClaim` is a value import (type guard function). Use `import type` for all type-only imports.

### Testing Standards

- Test files co-located: `per-packet-claim-service.test.ts` next to source
- Existing test mock pattern uses inline factory functions (`createMockLogger`, `createMockSDK`, `createMockChannelManager`, `createMockDb`)
- `jest.clearAllMocks()` in `beforeEach`
- Type-safe partial mocks with `as unknown as jest.Mocked<Type>`
- ILP amounts use BigInt notation: `1000n`
- Existing test count: 17 tests in 5 describe blocks

### Mock Pattern for Registry

```typescript
const createMockEVMProvider = (): jest.Mocked<
  Pick<
    EVMPaymentChannelProvider,
    'signBalanceProof' | 'chainType' | 'chainId' | 'getSigningContext'
  >
> => ({
  signBalanceProof: jest.fn().mockResolvedValue('0xmocksignature'),
  chainType: 'evm',
  chainId: 'evm:anvil:31337', // Must match ChannelMetadata.chain in mock
  getSigningContext: jest.fn().mockResolvedValue({
    chainId: 31337,
    tokenNetworkAddress: '0xTokenNetworkAddress1234567890abcdef',
    signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
  }),
});

const createMockRegistry = (
  provider: ReturnType<typeof createMockEVMProvider>
): jest.Mocked<Pick<ChainProviderRegistry, 'getProviderForPeer'>> => ({
  getProviderForPeer: jest
    .fn()
    .mockImplementation((peerConfig: { peerId: string; chain?: string }) => {
      if (peerConfig.chain === 'evm:anvil:31337') return provider;
      return undefined;
    }),
});
```

**CRITICAL for instanceof check:** The mock provider must be created as an instance of `EVMPaymentChannelProvider` or the `instanceof` check in `buildChannelContext` will fail. Either:

1. Use a real `EVMPaymentChannelProvider` with a mocked SDK (preferred for accuracy), OR
2. Mock the `instanceof` check by making the mock prototype chain include `EVMPaymentChannelProvider`

Option 1 is cleaner — create a real `EVMPaymentChannelProvider` with a fully mocked `PaymentChannelSDK`, then spy on its methods.

### Backward Compatibility Requirements

1. **Claim JSON structure unchanged:** EVM claims must produce identical JSON output (same fields, same values)
2. **DB schema unchanged:** `sent_claims` table uses same columns (`message_id`, `peer_id`, `blockchain`, `claim_data`, `sent_at`)
3. **DB recovery widened:** `recoverFromDb()` removes `blockchain = 'evm'` filter to recover ALL blockchain types
4. **BTP protocol data format unchanged:** Same `protocolName`, `contentType`, serialization
5. **`getLatestClaim` consumers:** `SettlementExecutor` calls `getLatestClaim(channelId)` — return type widens from `EVMClaimMessage` to `BTPClaimMessage`. Downstream callers in Story 32.5 will need type narrowing via `isEVMClaim()`

### Project Structure Notes

- File stays at existing location: `packages/connector/src/settlement/per-packet-claim-service.ts`
- Import path for provider module: `./provider/chain-provider-registry` and `./provider/payment-channel-provider`
- Barrel export in `provider/index.ts` already exports all needed types
- No new files needed (only modifications to existing files)

### Previous Story Intelligence

**From Story 32.3 (EVMPaymentChannelProvider):**

- The `EVMPaymentChannelProvider` uses composition over inheritance (wraps `PaymentChannelSDK`)
- String-to-bigint conversion handled by `safeBigInt()` helper
- `BalanceProofParams` uses string amounts (not bigint) — remember to convert with `.toString()`
- Provider's `signBalanceProof` takes a `BalanceProofParams` object, NOT positional args
- The `_sdk` field is `private readonly` — `getSigningContext()` method provides controlled access
- The `_tokenAddress` field is `private readonly` — also accessed via `getSigningContext()` internally
- Factory pattern `createEVMProviderFactory` exists for config-driven instantiation
- Constructor validates `chainId` and `tokenAddress` are non-empty strings

**Commit patterns established:**

- Commit message format: `feat(32-N): description`
- Scope: story number (e.g., `32-4`)
- Tests included in same commit as implementation

### Git Intelligence

Recent commits show the pattern of implementing provider interface (32.1), registry (32.2), and EVM provider (32.3) sequentially. All three are `done` status. This is the first consumer refactor — validates the abstraction design.

### References

- [Source: packages/connector/src/settlement/per-packet-claim-service.ts] — current implementation with direct PaymentChannelSDK dependency (333 lines)
- [Source: packages/connector/src/settlement/per-packet-claim-service.test.ts] — existing test suite (17 tests in 5 describe blocks)
- [Source: packages/connector/src/settlement/provider/payment-channel-provider.ts] — PaymentChannelProvider interface and BalanceProofParams type
- [Source: packages/connector/src/settlement/provider/chain-provider-registry.ts] — ChainProviderRegistry with getProviderForPeer(RegistryPeerConfig) and RegistryPeerConfig type
- [Source: packages/connector/src/settlement/provider/evm-payment-channel-provider.ts] — EVMPaymentChannelProvider implementation (432 lines)
- [Source: packages/connector/src/settlement/channel-manager.ts] — ChannelMetadata interface with `chain: string` field (e.g., "evm:base:8453"), ChannelManager.getChannelForPeer() and ensureChannelExists()
- [Source: packages/connector/src/btp/btp-claim-types.ts] — BlockchainType, EVMClaimMessage, BTPClaimMessage, isEVMClaim() type guard
- [Source: packages/connector/src/settlement/provider/index.ts] — barrel export (already exports all provider types)
- [Source: _bmad-output/planning-artifacts/epic-32-chain-abstraction-layer.md#Story 32.4] — epic story definition

## Preconditions

- Story 32.1 is done (PaymentChannelProvider interface defined)
- Story 32.2 is done (ChainProviderRegistry implemented)
- Story 32.3 is done (EVMPaymentChannelProvider implemented)
- Branch `epic-32` exists with Stories 32.1, 32.2, and 32.3 commits
- All existing tests passing

## Out of Scope

- Changes to `PaymentChannelProvider` interface (it stays chain-agnostic)
- Changes to `btp-claim-types.ts` (types already support multi-chain)
- Changes to `ChannelManager` (channel metadata stays as-is)
- Refactoring `SettlementExecutor` or `SettlementMonitor` (Story 32.5)
- Refactoring `ClaimReceiver` (Story 32.6)
- Configuration schema changes (Story 32.7)
- Integration tests wiring all services together (Story 32.8)
- Solana/Mina claim message construction (only EVM claims are constructed; other chains are typed but not implemented)

## Test Plan

Reference: [Source: `_bmad-output/planning-artifacts/test-design-epic-32.md` — Story 32.4]

| Test ID   | Scenario                                                                                       | Type       | Priority |
| --------- | ---------------------------------------------------------------------------------------------- | ---------- | -------- |
| T-32.4-01 | generateClaimForPacket delegates signing to provider.signBalanceProof (params object, strings) | Unit       | P0       |
| T-32.4-02 | Claim blockchain discriminator matches peer's provider.chainType                               | Unit       | P0       |
| T-32.4-03 | EVM claim includes chainId, tokenNetworkAddress, tokenAddress, signerAddress (backward compat) | Unit       | P0       |
| T-32.4-04 | Claim for peer with no registered provider returns null                                        | Unit       | P0       |
| T-32.4-05 | Nonce increments and cumulative amounts accumulate (existing behavior preserved)               | Unit       | P0       |
| T-32.4-06 | Channel context caching works with provider reference                                          | Unit       | P1       |
| T-32.4-07 | recoverFromDb recovers claims without blockchain='evm' filter                                  | Unit       | P1       |
| T-32.4-08 | resetChannel clears state (type-agnostic, existing behavior)                                   | Unit       | P1       |
| T-32.4-09 | Error handling: buildChannelContext failure returns null                                       | Unit       | P1       |
| T-32.4-10 | Error handling: signBalanceProof failure propagates                                            | Unit       | P1       |
| T-32.4-11 | getSigningContext() on EVMPaymentChannelProvider returns SDK values                            | Unit       | P0       |
| T-32.4-12 | Existing tests pass with zero modifications to test assertions (only mock setup changes)       | Regression | P0       |
| T-32.4-13 | Full test suite passes: typecheck, lint, all test suites                                       | Regression | P0       |

### Regression Gate

- All existing tests must pass with zero modifications to assertions
- `npm run typecheck` must pass (tsc --noEmit)
- `npm run lint` must pass
- Full test suite: all test suites pass

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context) — claude-opus-4-6[1m]

### Debug Log References

N/A

### Completion Notes List

- **Task 1**: Added `getSigningContext()` public method to `EVMPaymentChannelProvider` that delegates to SDK's `getChainId()`, `getTokenNetworkAddress()`, and `getSignerAddress()` via `Promise.all`. Added unit tests (T-32.4-11) in the EVM provider test file.
- **Task 2**: Refactored `PerPacketClaimService` constructor from `paymentChannelSDK: PaymentChannelSDK` to `_registry: ChainProviderRegistry`. Removed `PaymentChannelSDK` import.
- **Task 3**: Refactored `ChannelClaimContext` interface to include `provider: PaymentChannelProvider`, `blockchain: BlockchainType`, and optional EVM-specific fields (`chainId`, `tokenNetworkAddress`, `signerAddress`).
- **Task 4**: Refactored `buildChannelContext` to resolve provider via `this._registry.getProviderForPeer()` using channel metadata's `chain` field. Returns null if no provider found. Uses `instanceof EVMPaymentChannelProvider` to call `getSigningContext()` for EVM providers.
- **Task 5**: Refactored `generateClaimForPacket` to call `ctx.provider.signBalanceProof()` with a `BalanceProofParams` object (string amounts). Claim construction uses `ctx.blockchain` discriminator to guard EVM-specific claim construction.
- **Task 6**: Widened return types — `latestClaim` map, `getLatestClaim`, `PerPacketClaimResult.claimMessage`, and `persistClaim` all use `BTPClaimMessage` instead of `EVMClaimMessage`. `recoverFromDb` removed `WHERE blockchain = 'evm'` filter and uses `isEVMClaim()` type guard.
- **Task 7**: Updated test file — replaced `mockSDK` with real `EVMPaymentChannelProvider` wrapping a mocked SDK + mock `ChainProviderRegistry`. Added `jest.clearAllMocks()`. Added 3 new tests: no-provider returns null (T-32.4-04), blockchain discriminator matches chain type (T-32.4-02), recoverFromDb handles all blockchain types (T-32.4-07). All 21 tests pass.
- **Task 8**: TypeScript typecheck passes, lint passes, full test suite passes (81 suites, 1854 tests).
- **Additional**: Updated `connector-node.ts` to create a `ChainProviderRegistry` wrapping the existing `PaymentChannelSDK` in an `EVMPaymentChannelProvider` for backward compatibility. Updated `settlement-executor.ts` to use `isEVMClaim()` type guard when accessing EVM-specific fields from `getLatestClaim()`. Added `blockchain: 'evm'` to settlement-executor test mock.

### File List

- `packages/connector/src/settlement/per-packet-claim-service.ts` — modified (refactored constructor, types, signing delegation, DB recovery)
- `packages/connector/src/settlement/per-packet-claim-service.test.ts` — modified (new mock pattern, 3 new tests, 21 total)
- `packages/connector/src/settlement/provider/evm-payment-channel-provider.ts` — modified (added `getSigningContext()` method)
- `packages/connector/src/settlement/provider/evm-payment-channel-provider.test.ts` — modified (added `getSigningContext` tests, extended mock SDK type)
- `packages/connector/src/settlement/settlement-executor.ts` — modified (added `isEVMClaim` import and type guard around `getLatestClaim` usage)
- `packages/connector/src/settlement/settlement-executor.test.ts` — modified (added `blockchain: 'evm'` to mock claim)
- `packages/connector/src/core/connector-node.ts` — modified (creates `ChainProviderRegistry` + `EVMPaymentChannelProvider` for `PerPacketClaimService` constructor)
- `_bmad-output/implementation-artifacts/story-32-4.md` — modified (status, tasks, dev agent record)

### Change Log

| Date       | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-03-24 | Story 32.4 implementation: Refactored PerPacketClaimService to delegate signing to chain-appropriate PaymentChannelProvider via ChainProviderRegistry, replacing direct PaymentChannelSDK dependency. Added getSigningContext() to EVMPaymentChannelProvider. Widened claim types to BTPClaimMessage for multi-chain support. Updated connector-node.ts bridge and settlement-executor.ts type narrowing. All 81 test suites (1854 tests) pass, typecheck clean, lint clean. |

## Code Review Record

### Review Pass #1

- **Date:** 2026-03-24
- **Reviewer model:** Claude Opus 4.6 (1M context)
- **Issues found:**
  - Critical: 0
  - High: 0
  - Medium: 1 — Replaced non-null assertion with runtime guard in `per-packet-claim-service.ts`
  - Low: 1 — Fixed misleading comment in `recoverFromDb` in `per-packet-claim-service.ts`
- **Files changed:** `packages/connector/src/settlement/per-packet-claim-service.ts` (2 fixes applied)
- **Outcome:** Pass — all issues resolved, no follow-up actions required

### Review Pass #2

- **Date:** 2026-03-24
- **Reviewer model:** Claude Opus 4.6 (1M context)
- **Issues found:**
  - Critical: 0
  - High: 0
  - Medium: 0
  - Low: 0
- **Files changed:** None
- **Outcome:** Pass — implementation is clean, no issues found

### Review Pass #3

- **Date:** 2026-03-24
- **Reviewer model:** Claude Opus 4.6 (1M context) — claude-opus-4-6[1m]
- **Scope:** Full code review + Semgrep security scan + OWASP Top 10 analysis
- **Security scan:** Semgrep v1.153.0 — 10 files scanned, 3 pre-existing findings (insecure WebSocket in connector-node.ts lines 1497/1524/1525 — not Story 32.4 changes, CWE-319)
- **Issues found:**
  - Critical: 0
  - High: 0
  - Medium: 1 — `recoverFromDb` query lacked LIMIT clause; unbounded `SELECT` on `sent_claims` table could cause excessive memory usage and slow startup as the table grows (one row per packet). Fixed by adding `LIMIT 1000`.
  - Low: 1 — Missing structural validation of parsed JSON in `recoverFromDb`; `JSON.parse` result cast to `BTPClaimMessage` without checking that `channelId`, `nonce`, and `transferredAmount` fields actually exist. If `claim_data` is valid JSON but missing these fields, `undefined` values would be stored in nonce/cumulative maps. Fixed by adding runtime type checks before recovery.
- **OWASP Top 10 analysis:**
  - A03:2021 Injection: SQL uses parameterized queries (prepared statements with `?` placeholders) — no injection risk
  - A01:2021 Broken Access Control: No authorization bypasses found; provider lookup requires matching chain metadata
  - A02:2021 Cryptographic Failures: Signing delegated to SDK; no key material handled in this layer
  - A04:2021 Insecure Design: Provider resolution via registry is well-designed; null returns handled gracefully
  - A05:2021 Security Misconfiguration: No hardcoded secrets; test mocks use placeholder values
  - A08:2021 Software and Data Integrity: `JSON.parse` in `recoverFromDb` is wrapped in try/catch; now also validates structure
  - No authentication/authorization flaws found in the Story 32.4 changes
- **Files changed:** `packages/connector/src/settlement/per-packet-claim-service.ts` (2 fixes applied)
- **Regression:** All 85 test suites pass (2018 tests), typecheck clean, lint clean
- **Outcome:** Pass — all issues resolved, no follow-up actions required
