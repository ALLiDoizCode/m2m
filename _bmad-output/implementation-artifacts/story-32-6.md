# Story 32.6: Refactor ClaimReceiver for Multi-Chain Verification

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **settlement service developer**,
I want **`ClaimReceiver` to dispatch claim verification to the correct `PaymentChannelProvider` via the `ChainProviderRegistry` based on the `blockchain` discriminator field in incoming claims**,
so that **claim verification works for any supported blockchain without hardcoded `PaymentChannelSDK` dependencies in the claim receiving layer**.

**Epic:** 32 — Chain Abstraction Layer & EVM Provider Migration
**Priority:** P0 (claim verification is a critical settlement path — all inbound claims must be verified before being consumed by SettlementMonitor/SettlementExecutor)
**Estimated effort:** 1-2 dev days
**Dependencies:** Stories 32.1, 32.2, 32.3, 32.5 (all done). Note: 32.4 (PerPacketClaimService) is a sibling story, not a dependency — 32.6 does not consume any 32.4 outputs. 32.5 is a dependency because it hoists `chainRegistry` in connector-node.ts which 32.6's wiring depends on.

## Acceptance Criteria

### AC 1: EVM Claims Verified via EVM Provider

```gherkin
Scenario: EVM claims verified via EVM provider
  Given a ClaimReceiver configured with a ChainProviderRegistry
  When an incoming BTP message contains a claim with blockchain: 'evm'
  Then the receiver resolves the EVM provider from the registry
  And calls provider.verifyBalanceProof() for signature validation
  And the claim is persisted and CLAIM_RECEIVED event emitted (unchanged)
```

### AC 2: Unknown Blockchain Type Is Rejected

```gherkin
Scenario: Unknown blockchain type is rejected
  Given a ClaimReceiver configured with a ChainProviderRegistry
  When an incoming claim has blockchain: 'solana' but no Solana provider is registered
  Then the claim is rejected with error 'No provider registered for blockchain: solana'
  And the claim is persisted with verified: false
```

### AC 3: Dynamic Channel Verification Uses Provider

```gherkin
Scenario: Dynamic channel verification uses provider
  Given an unknown channelId arrives in an EVM claim with self-describing fields
  When the receiver processes the claim
  Then it resolves the EVM provider from the registry using claim.chainId
  And delegates on-chain channel state verification to the provider
  And registers the external channel in ChannelManager on success (unchanged)
```

### AC 4: Backward Compatibility with Existing EVM Claims

```gherkin
Scenario: Backward compatibility with existing EVM claims
  Given the existing claim-receiver.test.ts test suite
  When tests are executed with an EVM provider registered in the registry
  Then all existing tests pass with updated mock setup
```

### AC 5: ClaimReceiver No Longer Depends on PaymentChannelSDK Directly

```gherkin
Scenario: ClaimReceiver no longer depends on PaymentChannelSDK directly
  Given the refactored ClaimReceiver constructor
  When instantiated
  Then it accepts (db, chainProviderRegistry, logger, channelManager, peerIdToAddressMap)
  And does not import or reference PaymentChannelSDK directly
```

## Tasks / Subtasks

- [x] Task 1: Refactor ClaimReceiver constructor to use ChainProviderRegistry (AC: #5)
  - [x] 1.1 Replace `evmChannelSDK: PaymentChannelSDK` constructor parameter with `chainProviderRegistry: ChainProviderRegistry`
  - [x] 1.2 Store registry as `private readonly chainProviderRegistry: ChainProviderRegistry`
  - [x] 1.3 Remove `PaymentChannelSDK` import from `claim-receiver.ts`
  - [x] 1.4 Add import: `import type { ChainProviderRegistry } from './provider/chain-provider-registry';`
  - [x] 1.5 Add import: `import type { PaymentChannelProvider, VerifyBalanceProofParams, ProviderChannelState } from './provider/payment-channel-provider';`
  - [x] 1.6 Update JSDoc on class and constructor to reference ChainProviderRegistry instead of PaymentChannelSDK

- [x] Task 2: Refactor `handleClaimMessage` to dispatch by blockchain type (AC: #1, #2)
  - [x] 2.1 Add a new error constant to the `ERRORS` object: `NO_PROVIDER_REGISTERED: 'No provider registered for blockchain:'` (the blockchain name is appended at runtime)
  - [x] 2.2 After `validateClaimMessage()`, resolve the provider from the registry based on `claimMessage.blockchain`. For EVM claims, construct the chain identifier from the claim's `chainId` field if present (e.g., `evm:${claim.chainId}`), or look up via a known channel's chain metadata from `channelManager`
  - [x] 2.3 If the claim is EVM and the channel is known (via `channelManager.getChannelById`), use the known channel's `chain` field (e.g., `'evm:31337'`) to resolve the provider from the registry
  - [x] 2.4 If the claim is EVM and the channel is unknown (dynamic verification), construct the chain key from self-describing `chainId` field: `evm:${claim.chainId}` and resolve the provider
  - [x] 2.5 If no provider is found for the claim's blockchain type, reject with error `No provider registered for blockchain: ${blockchain}` and persist the claim with `verified: false`. Use the `ERRORS.NO_PROVIDER_REGISTERED` constant as the prefix
  - [x] 2.6 Replace the current `if (!isEVMClaim(claimMessage)) { throw }` with generic provider lookup. The `isEVMClaim()` guard moves into the provider-specific verification logic

- [x] Task 3: Refactor `verifyEVMClaim` into generic `verifyClaim` (AC: #1, #3)
  - [x] 3.1 Rename `verifyEVMClaim` to `verifyClaim` and add `provider: PaymentChannelProvider` parameter
  - [x] 3.2 **Known channel path:** Replace `this.evmChannelSDK.verifyBalanceProof(balanceProof, claim.signature, claim.signerAddress)` with `provider.verifyBalanceProof(params)` where `params` is a `VerifyBalanceProofParams` object: `{ channelId, nonce, transferredAmount: claim.transferredAmount, lockedAmount: claim.lockedAmount, locksRoot: claim.locksRoot, signature: claim.signature, signerAddress: claim.signerAddress }`. Note: provider uses string amounts (already strings in `EVMClaimMessage`), not bigint conversion
  - [x] 3.3 **Unknown channel path — on-chain state check:** Replace `this.evmChannelSDK.getChannelStateByNetwork(claim.channelId, claim.tokenNetworkAddress)` with `provider.getChannelState(claim.channelId)`. Adapt the result mapping: `ProviderChannelState.status` returns `'opened'|'closed'|'settled'` (not numeric state), and `ProviderChannelState.participants` is a `string[]`
  - [x] 3.4 **Unknown channel path — existence check:** Replace `!channelState.exists` with a try/catch around `provider.getChannelState()` — if the provider throws (channel not found on-chain), treat as non-existent. Alternatively, check if the returned state indicates non-existence (provider-specific)
  - [x] 3.5 **Unknown channel path — opened check:** Replace `channelState.state !== 1` with `providerState.status !== 'opened'`
  - [x] 3.6 **Unknown channel path — participant check:** Replace `participant1`/`participant2` comparison with `providerState.participants.some(p => p.toLowerCase() === signerLower)`
  - [x] 3.7 **Unknown channel path — signature verification:** Replace `this.evmChannelSDK.verifyBalanceProofWithDomain(balanceProof, signature, signerAddress, chainId, tokenNetworkAddress)` with `provider.verifyBalanceProof(params)`. The provider's `verifyBalanceProof` internally handles domain context (chainId, tokenNetworkAddress) — the EVM provider wraps `PaymentChannelSDK.verifyBalanceProof()` which uses the locally configured domain. NOTE: This means the verification uses the local provider's domain, not the claim's self-describing domain. See Dev Notes for the implications and mitigation
  - [x] 3.8 **Nonce monotonicity:** Keep nonce checking logic unchanged — it is already chain-agnostic. Use `claim.blockchain` instead of hardcoded `'evm'` in `getLatestVerifiedClaim` call
  - [x] 3.9 Remove the bigint conversion of `transferredAmount` and `lockedAmount` for the balance proof — the provider's `verifyBalanceProof` accepts `VerifyBalanceProofParams` with string amounts

- [x] Task 4: Update `_persistReceivedClaim` for multi-chain (AC: #1)
  - [x] 4.1 The existing implementation already handles `channelId` extraction via `isEVMClaim(claim)`. For future chains, the `channelId` extraction will need to be chain-aware. For now, keep the existing logic — it correctly handles EVM claims and defaults to `''` for unknown chains

- [x] Task 5: Update CLAIM_RECEIVED event emission for multi-chain (AC: #1)
  - [x] 5.1 Replace the `if (isEVMClaim(claimMessage))` guard around CLAIM_RECEIVED emission with a generic approach: any claim type that has a `channelId` and `transferredAmount` should emit the event
  - [x] 5.2 Since `BTPClaimMessage` is a discriminated union, and only EVM claims currently have `channelId`/`transferredAmount` at runtime, use `isEVMClaim()` to extract these fields. For future chains, add similar type guards. The event emission block stays structurally similar but is conceptually chain-agnostic

- [x] Task 6: Update test file `claim-receiver.test.ts` (AC: #4, #5)
  - [x] 6.1 Replace `mockPaymentChannelSDK` with a mock `ChainProviderRegistry` + mock `PaymentChannelProvider`
  - [x] 6.2 Create `createMockProvider()` factory: mock EVM provider with `verifyBalanceProof`, `getChannelState`, `chainType: 'evm'`, `chainId: 'evm:31337'`
  - [x] 6.3 Create `createMockRegistry(provider)` factory: mock registry where `getProvider('evm', 'evm:31337')` returns mock provider
  - [x] 6.4 Update `ClaimReceiver` constructor calls: replace `mockPaymentChannelSDK` with `mockRegistry`
  - [x] 6.5 Update assertion patterns: `expect(mockProvider.verifyBalanceProof)` instead of `expect(mockPaymentChannelSDK.verifyBalanceProof)`
  - [x] 6.6 Update `verifyBalanceProof` assertions: provider uses `VerifyBalanceProofParams` (single object with string amounts), not positional args with bigint
  - [x] 6.7 **Dynamic verification tests:** Replace `mockPaymentChannelSDK.getChannelStateByNetwork` assertions with `mockProvider.getChannelState` assertions. Adapt expected return values from `{ exists, state, participant1, participant2, settlementTimeout }` to `ProviderChannelState` format `{ channelId, status, participants, deposit }`
  - [x] 6.8 **Dynamic verification tests:** Replace `mockPaymentChannelSDK.verifyBalanceProofWithDomain` assertions with `mockProvider.verifyBalanceProof` assertions. The provider's `verifyBalanceProof` handles domain context internally — callers just pass `VerifyBalanceProofParams`
  - [x] 6.9 Add new test: claim with unregistered blockchain type is rejected with `No provider registered for blockchain: solana`
  - [x] 6.10 Add new test: claim with registered provider returns provider-verified result
  - [x] 6.11 Update `peerIdToAddressMap` tests to use mock registry
  - [x] 6.12 Verify all existing behavioral assertions (verified/unverified storage, nonce monotonicity, idempotency, error handling) pass with new mock setup

- [x] Task 7: Update `connector-node.ts` wiring (AC: #5)
  - [x] 7.1 In the ClaimReceiver construction block (~line 900), replace `this._paymentChannelSDK` with `chainRegistry` (the shared `ChainProviderRegistry` instance hoisted in Story 32.5)
  - [x] 7.2 Change the guard `if (this._paymentChannelSDK)` to check for the existence of `chainRegistry` instead (or keep both — `chainRegistry` is always available when `_paymentChannelSDK` is available since it wraps the SDK)
  - [x] 7.3 Update the constructor call: `new ClaimReceiver(receivedClaimDb, chainRegistry, this._logger, ...)`
  - [x] 7.4 Ensure `chainRegistry` is in scope at the ClaimReceiver construction point. Since Story 32.5 hoisted it before the SettlementExecutor block, it should be accessible in the same scope as the ClaimReceiver block. Verify the variable scope — `chainRegistry` is declared in the same `try` block that contains the ClaimReceiver wiring

- [x] Task 8: Regression verification (AC: #4)
  - [x] 8.1 Run `npm run typecheck` — must pass
  - [x] 8.2 Run `npm run lint` — must pass
  - [x] 8.3 Run full test suite — all existing tests must pass

## Dev Notes

### Key Architectural Decisions

**ClaimReceiver's primary change:** Replace `PaymentChannelSDK` with `ChainProviderRegistry`. The receiver resolves the appropriate provider based on the incoming claim's `blockchain` type and delegates all verification to that provider.

**The `verifyEVMClaim` method becomes `verifyClaim`.** It no longer has EVM-specific logic — all chain-specific verification is delegated to the provider's `verifyBalanceProof()` and `getChannelState()` methods.

### TypeScript Narrowing Caveat: `validateClaimMessage`

The current `validateClaimMessage()` has return type `asserts msg is EVMClaimMessage` (in `btp-claim-types.ts` line 295). After calling `validateClaimMessage(claimMessage)`, TypeScript narrows the type to `EVMClaimMessage`, not the broader `BTPClaimMessage` union. This is acceptable for now because only EVM claims pass validation (Solana/Mina throw "not yet supported"). However, when future chains are added:

1. The assertion return type must be widened to `asserts msg is BTPClaimMessage`
2. Callers (including `handleClaimMessage`) must use type guards (`isEVMClaim()`, `isSolanaClaim()`, etc.) to narrow after validation
3. The `verifyClaim` method should accept `BTPClaimMessage` and use type guards internally for chain-specific field access (e.g., `channelId` on EVM claims)

For this story, the narrowing to `EVMClaimMessage` after `validateClaimMessage()` is fine because the provider dispatch still uses the `blockchain` discriminator field, and `isEVMClaim()` guards are used for EVM-specific field access within `verifyClaim`.

### CRITICAL: Provider Interface vs SDK Method Signatures for Verification

The `PaymentChannelProvider` interface has different verification methods than `PaymentChannelSDK`:

| Operation                      | PaymentChannelSDK                                                                                      | PaymentChannelProvider                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `verifyBalanceProof`           | `(BalanceProof, signature, signerAddress)` positional, bigint amounts                                  | `(VerifyBalanceProofParams)` single object, string amounts                                        |
| `verifyBalanceProofWithDomain` | `(BalanceProof, signature, signerAddress, chainId, tokenNetworkAddress)`                               | **NOT on interface** — domain handled internally by provider                                      |
| `getChannelStateByNetwork`     | `(channelId, tokenNetworkAddress) -> { exists, state, participant1, participant2, settlementTimeout }` | `getChannelState(channelId) -> ProviderChannelState { channelId, status, participants, deposit }` |

### Dynamic Verification: `verifyBalanceProofWithDomain` Replacement

The current dynamic verification path (unknown channel) uses `verifyBalanceProofWithDomain()` with explicit domain parameters from the claim's self-describing fields. The provider interface's `verifyBalanceProof()` does NOT accept domain parameters — the EVM provider internally uses its configured domain.

**Implication:** For the known channel path, this is identical behavior (both use the local domain). For the unknown channel path, the current code constructs a domain from the claim's `chainId` and `tokenNetworkAddress`, which allows verifying claims from different chains/networks. With the provider interface, verification uses the provider's own domain.

**Mitigation:** This is acceptable for the single-chain MVP. In a multi-chain deployment, the correct provider is looked up by `evm:${claim.chainId}`, so the provider's internal domain matches the claim's domain. The key is that we look up the provider by the chain info from the claim's self-describing fields, not by a hardcoded chain ID.

**Provider lookup strategy for dynamic verification:**

1. Construct chain key from claim: `${claim.blockchain}:${claim.chainId}` (e.g., `evm:31337`)
2. Look up provider: `chainProviderRegistry.getProvider(claim.blockchain, chainKey)`
3. If found, use that provider's `verifyBalanceProof()` and `getChannelState()`
4. If not found, reject the claim

### Dynamic Verification: `getChannelStateByNetwork` Replacement

The `getChannelStateByNetwork()` SDK method returns a detailed on-chain state with `exists`, `state` (number), `participant1`, `participant2`, `settlementTimeout`. The provider interface's `getChannelState()` returns `ProviderChannelState` with `channelId`, `status` (string enum), `participants` (string[]), `deposit` (bigint).

**Mapping:**

- `exists` check → wrap `provider.getChannelState()` in try/catch; if it throws, channel doesn't exist
- `state === 1` (opened) → `providerState.status === 'opened'`
- `participant1`/`participant2` comparison → `providerState.participants.some(p => p.toLowerCase() === signerLower)`
- `settlementTimeout` → not needed for verification (only used for display)

**IMPORTANT:** The SDK's `getChannelStateByNetwork` takes a `tokenNetworkAddress` parameter. The provider's `getChannelState` does NOT — it uses the provider's internally configured token address. This means dynamic verification of channels on different token networks within the same chain would not work with the provider interface. This is acceptable for the MVP (single token network per chain).

### Provider Lookup for Known vs Unknown Channels

**Known channel path (channelManager has the channel):**

- Get channel metadata: `channelManager.getChannelById(channelId)` returns `ChannelMetadata` with `chain` field (e.g., `'evm:31337'`)
- Look up provider: `chainProviderRegistry.getProvider(claim.blockchain, metadata.chain)`
- Or simply use the registry's internal Map directly by chain key

**Unknown channel path (dynamic verification):**

- Construct chain key from claim's self-describing fields: `${claim.blockchain}:${claim.chainId}`
- Look up provider: `chainProviderRegistry.getProvider(claim.blockchain, chainKey)`
- If no provider found, cannot verify — reject the claim

**Fallback when no chain info is available:**
If the claim has `blockchain: 'evm'` but no `chainId` (legacy claim on known channel), and `channelManager` finds the channel with a `chain` field, use that. If `channelManager` doesn't find the channel and no `chainId` is in the claim, we can't determine which provider to use. In this case:

- Try the first (or only) registered EVM provider via `getAllProviders().find(p => p.chainType === 'evm')`
- Or require self-describing fields for unknown channels (current behavior)

### connector-node.ts Scope

The `chainRegistry` variable is declared at line 742 inside the same `try` block that contains the ClaimReceiver wiring at line 900. It is in scope. The guard `if (this._paymentChannelSDK)` at line 889 can remain — if the SDK doesn't exist, the registry also doesn't exist (they're created together).

### Testing Standards

- Test files co-located: `claim-receiver.test.ts` next to source
- Existing test uses inline mock construction (not `jest.mock()` at file top for SDK)
- Mock objects created with `jest.fn()` stubs and cast via `as unknown as jest.Mocked<Type>`
- ILP amounts use BigInt notation: `BigInt('1000000000000000000')`
- Existing test count: ~20 tests across 4 describe blocks
- `beforeEach` resets mocks with `jest.clearAllMocks()`

### Mock Pattern for Provider-Based Tests

```typescript
const createMockProvider = (): jest.Mocked<PaymentChannelProvider> => ({
  verifyBalanceProof: jest.fn().mockResolvedValue(true),
  getChannelState: jest.fn().mockResolvedValue({
    channelId: '0x' + 'a'.repeat(64),
    status: 'opened' as const,
    participants: ['0x' + 'c'.repeat(40), '0x' + 'd'.repeat(40)],
    deposit: 10000n,
  }),
  openChannel: jest.fn(),
  deposit: jest.fn(),
  claimFromChannel: jest.fn(),
  closeChannel: jest.fn(),
  settleChannel: jest.fn(),
  signBalanceProof: jest.fn(),
  subscribeToEvents: jest.fn(),
  chainType: 'evm' as const,
  chainId: 'evm:31337',
});

const createMockRegistry = (
  provider: jest.Mocked<PaymentChannelProvider>
): jest.Mocked<
  Pick<ChainProviderRegistry, 'getProvider' | 'getProviderForPeer' | 'getAllProviders'>
> => ({
  getProvider: jest.fn().mockImplementation((chainType: string, chainId: string) => {
    if (chainId === 'evm:31337') return provider;
    return undefined;
  }),
  getProviderForPeer: jest.fn().mockReturnValue(provider),
  getAllProviders: jest.fn().mockReturnValue([provider]),
});
```

### Backward Compatibility Requirements

1. **Constructor:** Breaking change — `PaymentChannelSDK` param replaced with `ChainProviderRegistry`. Callers (`connector-node.ts`) must update
2. **Claim verification:** Identical behavior through the abstraction layer — same verified/unverified outcomes for same inputs
3. **CLAIM_RECEIVED event:** Unchanged emission semantics
4. **Database persistence:** Unchanged schema and insert logic
5. **Nonce monotonicity:** Chain-agnostic, unchanged
6. **Dynamic verification:** Same validation steps (existence, opened status, participant check, signature) through provider interface
7. **peerIdToAddressMap:** Still populated from self-describing claims

### References

- [Source: packages/connector/src/settlement/claim-receiver.ts] — current implementation with direct PaymentChannelSDK dependency (481 lines)
- [Source: packages/connector/src/settlement/claim-receiver.test.ts] — existing test suite (~20 tests across 4 describe blocks)
- [Source: packages/connector/src/settlement/provider/payment-channel-provider.ts] — PaymentChannelProvider interface (VerifyBalanceProofParams, ProviderChannelState)
- [Source: packages/connector/src/settlement/provider/chain-provider-registry.ts] — ChainProviderRegistry with getProvider(chainType, chainId)
- [Source: packages/connector/src/settlement/provider/evm-payment-channel-provider.ts] — EVMPaymentChannelProvider (verifyBalanceProof delegates to SDK)
- [Source: packages/connector/src/core/connector-node.ts#L900] — current ClaimReceiver wiring (needs update)
- [Source: packages/connector/src/settlement/payment-channel-sdk.ts#L869] — getChannelStateByNetwork (EVM-specific, replaced by provider.getChannelState)
- [Source: packages/connector/src/settlement/payment-channel-sdk.ts#L916] — verifyBalanceProofWithDomain (EVM-specific, replaced by provider.verifyBalanceProof)
- [Source: _bmad-output/planning-artifacts/epic-32-chain-abstraction-layer.md#Story 32.6] — epic story definition
- [Source: _bmad-output/implementation-artifacts/story-32-5.md] — previous story with refactoring patterns
- [Source: _bmad-output/planning-artifacts/test-design-epic-32.md#Story 32.6] — test design with 7 test scenarios

### Previous Story Intelligence

**From Story 32.5 (SettlementExecutor refactor):**

- Constructor refactoring pattern: replace `PaymentChannelSDK` param with `ChainProviderRegistry`
- Provider resolution via `registry.getProviderForPeer({ peerId, chain })` or `registry.getProvider(chainType, chainId)`
- `connector-node.ts` already has `chainRegistry` hoisted and accessible in the ClaimReceiver scope
- Test mock pattern: create mock `PaymentChannelProvider` and mock `ChainProviderRegistry`
- `VerifyBalanceProofParams` uses string amounts, not bigint

**From Story 32.4 (PerPacketClaimService refactor):**

- `isEVMClaim()` type guard used for narrowing claims to access EVM-specific fields
- `EVMPaymentChannelProvider.getSigningContext()` provides EVM-specific `chainId`/`tokenNetworkAddress`/`signerAddress`
- Registry lookup uses chain string like `'evm:anvil:31337'` or `'evm:31337'`

**Commit patterns established:**

- Commit message format: `feat(32-N): description`
- Scope: story number (e.g., `32-6`)
- Tests included in same commit as implementation

### Git Intelligence

Recent commits (5 total on `epic-32` branch):

1. `bc75498 feat(32-5): refactor SettlementExecutor for multi-chain claim generation`
2. `6cd4621 feat(32-4): refactor PerPacketClaimService for multi-chain claim generation`
3. `d027c19 feat(32-3): implement EVMPaymentChannelProvider with SDK delegation`
4. `ef6c29c feat(32-2): implement ChainProviderRegistry with register/retrieve, peer lookup, and config-driven factory initialization`
5. `5dfc01d feat(32-1): define PaymentChannelProvider interface and extend BlockchainType`

All prior stories are `done`. This is the third consumer refactor (after 32.4 PerPacketClaimService and 32.5 SettlementExecutor).

### Project Structure Notes

- **Primary file to modify:** `packages/connector/src/settlement/claim-receiver.ts`
- **Test file to modify:** `packages/connector/src/settlement/claim-receiver.test.ts`
- **Wiring file to modify:** `packages/connector/src/core/connector-node.ts`
- **Do NOT modify:** `packages/connector/src/settlement/provider/payment-channel-provider.ts`
- **Do NOT modify:** `packages/connector/src/settlement/provider/chain-provider-registry.ts`
- **Do NOT modify:** `packages/connector/src/settlement/provider/evm-payment-channel-provider.ts`

## Preconditions

- Story 32.1 is done (PaymentChannelProvider interface defined)
- Story 32.2 is done (ChainProviderRegistry implemented)
- Story 32.3 is done (EVMPaymentChannelProvider implemented)
- Story 32.5 is done (SettlementExecutor refactored, chainRegistry hoisted in connector-node.ts)
- Story 32.4 is done (PerPacketClaimService refactored) — not a direct dependency but completed on the branch
- Branch `epic-32` exists with Stories 32.1-32.5 commits
- All existing tests passing (85 suites, 2032 tests per Story 32.5 completion)

## Out of Scope

- Changes to `PaymentChannelProvider` interface (stays chain-agnostic)
- Changes to `ChainProviderRegistry` (stays as-is)
- Changes to `EVMPaymentChannelProvider` (stays as-is)
- Changes to `SettlementExecutor` or `PerPacketClaimService` (already refactored)
- Changes to `validateClaimMessage()` assertion return type in `btp-claim-types.ts` (currently narrows to `EVMClaimMessage`; widening to `BTPClaimMessage` deferred until a non-EVM chain passes validation)
- Configuration schema changes (Story 32.7)
- Integration tests wiring all services together (Story 32.8)
- Solana/Mina claim verification (only EVM is implemented; abstraction enables future chains)
- Multi-token-network support within a single chain (single token network per chain for MVP)

## Test Plan

| Test ID   | Scenario                                                                                          | Type       | Priority |
| --------- | ------------------------------------------------------------------------------------------------- | ---------- | -------- |
| T-32.6-01 | EVM claims verified via provider.verifyBalanceProof (known channel path)                          | Unit       | P0       |
| T-32.6-02 | Unknown blockchain type rejected with 'No provider registered' error                              | Unit       | P0       |
| T-32.6-03 | Dynamic channel verification delegates to provider.getChannelState for on-chain state check       | Unit       | P1       |
| T-32.6-04 | Existing claim-receiver.test.ts passes with mock registry adapter                                 | Regression | P0       |
| T-32.6-05 | Nonce monotonicity checking remains chain-agnostic                                                | Unit       | P0       |
| T-32.6-06 | ClaimReceiver constructor no longer imports PaymentChannelSDK directly                            | Unit       | P1       |
| T-32.6-07 | Claim persisted with verified: false when provider rejects signature                              | Unit       | P1       |
| T-32.6-08 | Dynamic verification: channel non-existent (provider.getChannelState throws) results in rejection | Unit       | P1       |
| T-32.6-09 | Dynamic verification: channel not in 'opened' status results in rejection                         | Unit       | P1       |
| T-32.6-10 | Dynamic verification: signer not in participants results in rejection                             | Unit       | P1       |
| T-32.6-11 | Known channel uses provider.verifyBalanceProof (not domain-specific method)                       | Unit       | P0       |
| T-32.6-12 | CLAIM_RECEIVED event emitted after successful verification (unchanged)                            | Unit       | P0       |
| T-32.6-13 | connector-node.ts passes chainRegistry to ClaimReceiver instead of PaymentChannelSDK              | Wiring     | P0       |
| T-32.6-14 | Full test suite passes: typecheck, lint, all test suites                                          | Regression | P0       |

### Regression Gate

- All existing tests must pass with updated mock setup in claim-receiver assertions
- Settlement-executor and per-packet-claim-service tests remain unchanged
- `npm run typecheck` must pass (tsc --noEmit)
- `npm run lint` must pass
- Full test suite: all test suites pass

---

## Dev Agent Record

- **Agent Model Used:** Claude Opus 4.6 (1M context)
- **Completion Notes List:**
  - Task 1: Replaced `PaymentChannelSDK` constructor param with `ChainProviderRegistry`, removed SDK import, added provider interface imports, updated JSDoc
  - Task 2: Added `NO_PROVIDER_REGISTERED` error constant, implemented `resolveProvider()` method with known channel (channelManager chain metadata), unknown channel (self-describing chainId), and fallback (first matching provider) lookup strategies; replaced hardcoded `isEVMClaim` guard with generic provider dispatch
  - Task 3: Renamed `verifyEVMClaim` to `verifyClaim` with `provider` parameter; replaced SDK positional calls with `VerifyBalanceProofParams` objects using string amounts; replaced `getChannelStateByNetwork` with `provider.getChannelState` using `ProviderChannelState` format; replaced `verifyBalanceProofWithDomain` with `provider.verifyBalanceProof`; changed nonce check to use `claim.blockchain` instead of hardcoded `'evm'`
  - Task 4: Kept existing `_persistReceivedClaim` logic unchanged (already chain-aware via `isEVMClaim`)
  - Task 5: Kept `isEVMClaim()` guard for CLAIM_RECEIVED event emission (structurally chain-agnostic, only EVM has channelId at runtime)
  - Task 6: Replaced all `mockPaymentChannelSDK` with `createMockProvider()` + `createMockRegistry()` factories; updated all assertions from SDK positional args to provider `VerifyBalanceProofParams` objects; updated dynamic verification from `getChannelStateByNetwork`/`verifyBalanceProofWithDomain` to `getChannelState`/`verifyBalanceProof`; added test for unregistered blockchain type; all 25 tests pass
  - Task 7: Updated `connector-node.ts` to pass `chainRegistry` to ClaimReceiver instead of `this._paymentChannelSDK`; kept `if (this._paymentChannelSDK)` guard (chainRegistry always exists when SDK exists)
  - Task 8: TypeScript typecheck passes, lint passes, full test suite passes (81 suites, 1872 tests)
- **File List:**
  - `packages/connector/src/settlement/claim-receiver.ts` (modified)
  - `packages/connector/src/settlement/claim-receiver.test.ts` (modified)
  - `packages/connector/src/core/connector-node.ts` (modified)
  - `_bmad-output/implementation-artifacts/story-32-6.md` (modified)
- **Change Log:**
  - 2026-03-25: Refactored ClaimReceiver to use ChainProviderRegistry instead of PaymentChannelSDK. Constructor accepts registry, provider resolution dispatches by blockchain type with known/unknown channel strategies, verification delegates to provider interface. All 25 claim-receiver tests pass with mock registry/provider. connector-node.ts wiring updated. Full regression suite green.

## Code Review Record

### Review Pass #1

- **Date:** 2026-03-25
- **Reviewer Model:** Claude Opus 4.6 (1M context)
- **Issue Counts:** 0 critical, 0 high, 1 medium, 1 low
- **Issues Found & Fixed:**
  - **Medium:** Hardcoded `'evm'` string in `resolveProvider` chain key construction instead of using `claim.blockchain`. Fixed to use `${claim.blockchain}:${claim.chainId}`.
  - **Low:** Redundant `isEVMClaim()` runtime guards removed since TypeScript already guarantees the parameter type.
- **Outcome:** All issues resolved. Code approved.

### Review Pass #2

- **Date:** 2026-03-25
- **Reviewer Model:** Claude Opus 4.6 (1M context)
- **Issue Counts:** 0 critical, 0 high, 1 medium, 1 low
- **Issues Found & Fixed:**
  - **Medium:** Duplicated `VerifyBalanceProofParams` construction in `verifyClaim` — identical 8-line object literal appeared in both the known-channel and unknown-channel verification paths. Extracted to `buildVerifyParams()` private helper method to eliminate DRY violation and reduce maintenance risk.
  - **Low:** Hardcoded EVM-specific error string `'Invalid EIP-712 signature'` used twice in the chain-agnostic `verifyClaim` method. Added `INVALID_SIGNATURE: 'Invalid balance proof signature'` to the `ERRORS` constant object and replaced both occurrences, making the error message chain-agnostic and consistent with other error constants.
- **Outcome:** All issues resolved. 32/32 tests pass. Typecheck and lint clean. Code approved.

### Review Pass #3

- **Date:** 2026-03-25
- **Reviewer Model:** Claude Opus 4.6 (1M context)
- **Issue Counts:** 0 critical, 0 high, 0 medium, 1 low
- **Issues Found & Fixed:**
  - **Low:** Misplaced JSDoc comment relocated to correct position above `_persistReceivedClaim`.
- **Outcome:** All issues resolved. Code approved.
