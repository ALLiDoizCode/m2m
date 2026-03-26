# Story 33.5: Implement SolanaPaymentChannelProvider

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **connector operator**,
I want **a Solana implementation of the `PaymentChannelProvider` interface**,
so that **the connector can settle with peers over Solana using the chain-abstraction layer from Epic 32**.

**Epic:** 33 -- Solana Payment Channel Provider
**Priority:** P0 (blocks Stories 33.6, 33.7)
**Estimated effort:** 2-3 dev days
**Dependencies:** Story 33.4 (done), Epic 32 (done)

## Acceptance Criteria

### AC 1: Interface Implementation -- Type-Correct

```gherkin
Scenario: SolanaPaymentChannelProvider implements PaymentChannelProvider interface
  Given the PaymentChannelProvider interface from Epic 32
  When SolanaPaymentChannelProvider is instantiated with Solana RPC config and program ID
  Then all interface methods are implemented and type-check correctly
  And chainType equals 'solana'
  And chainId follows the 'solana:<cluster>' namespace format
```

### AC 2: openChannel Delegation

```gherkin
Scenario: openChannel delegates to SolanaPaymentChannelSDK
  Given a SolanaPaymentChannelProvider instance
  When openChannel() is called via the provider interface with a participant address and settlement timeout
  Then the call is delegated to SolanaPaymentChannelSDK.openChannel()
  And the result is returned in the provider's canonical OpenChannelResult format (channelId = PDA, txHash)
```

### AC 3: deposit Delegation

```gherkin
Scenario: deposit delegates to SolanaPaymentChannelSDK
  Given a SolanaPaymentChannelProvider instance
  When deposit() is called with a channelId (PDA) and amount (string)
  Then the amount is converted to bigint and delegated to SolanaPaymentChannelSDK.deposit()
  And a TxResult is returned
```

### AC 4: claimFromChannel Delegation

```gherkin
Scenario: claimFromChannel delegates to SolanaPaymentChannelSDK
  Given a SolanaPaymentChannelProvider instance
  When claimFromChannel() is called with channelId, balanceProof, and signature
  Then the nonce and transferredAmount are extracted from balanceProof
  And delegated to SolanaPaymentChannelSDK.claimFromChannel()
  And a TxResult is returned
```

### AC 5: closeChannel and settleChannel Delegation

```gherkin
Scenario: closeChannel and settleChannel delegate to SDK
  Given a SolanaPaymentChannelProvider instance
  When closeChannel() or settleChannel() is called with a channelId (PDA)
  Then the call is delegated to the corresponding SDK method
  And a TxResult is returned
```

### AC 6: signBalanceProof via Ed25519

```gherkin
Scenario: signBalanceProof produces Ed25519 signature
  Given a SolanaPaymentChannelProvider instance
  When signBalanceProof() is called with BalanceProofParams
  Then the channelId (PDA), nonce, and transferredAmount are extracted
  And SolanaPaymentChannelSDK.signBalanceProof() is called
  And the returned signature is base64-encoded
```

### AC 7: verifyBalanceProof via Ed25519

```gherkin
Scenario: verifyBalanceProof checks Ed25519 signature
  Given a SolanaPaymentChannelProvider instance
  When verifyBalanceProof() is called with VerifyBalanceProofParams
  Then the balance proof message is reconstructed (channelPDA || nonce || transferredAmount)
  And the Ed25519 signature is verified against the signer's public key
  And true/false is returned
```

### AC 8: getChannelState Maps to ProviderChannelState

```gherkin
Scenario: getChannelState returns chain-agnostic state
  Given a SolanaPaymentChannelProvider with an active channel
  When getChannelState() is called with a channel PDA
  Then SolanaPaymentChannelSDK.getChannelState() is called
  And the SolanaChannelState is mapped to ProviderChannelState:
    channelId = PDA, status = state, participants = [participantA, participantB], deposit = depositA + depositB
```

### AC 9: subscribeToEvents Maps Account Changes to ProviderEvents

```gherkin
Scenario: subscribeToEvents emits ProviderEvent on channel state changes
  Given a SolanaPaymentChannelProvider with an active channel subscription
  When the channel account data changes on-chain (e.g., a claim is submitted)
  Then the provider emits a ProviderEvent compatible with SettlementMonitor
  And the event type reflects the state transition (channel_claimed, channel_closed, etc.)
```

### AC 10: Error Mapping -- Program Errors to Provider Errors

```gherkin
Scenario: Solana program errors are mapped to provider-level errors
  Given a Solana program error (e.g., NonceNotMonotonic from SolanaChannelError)
  When the error propagates through the provider
  Then it is wrapped in a descriptive Error with chain context (chainId, channelId)
  And the original SolanaChannelError details are preserved
```

### AC 11: Factory Function for ChainProviderRegistry

```gherkin
Scenario: createSolanaProviderFactory produces providers from config
  Given a SolanaProviderConfig with rpcUrl, programId, and keyId
  When createSolanaProviderFactory() is called and the factory is invoked
  Then a SolanaPaymentChannelProvider is returned
  And it is registered in ChainProviderRegistry with chainId 'solana:<cluster>'
```

## Tasks / Subtasks

- [x] Task 1: Create SolanaPaymentChannelProvider class (AC: 1)
  - [x] 1.1 Create `packages/connector/src/settlement/provider/solana-payment-channel-provider.ts`
  - [x] 1.2 Create `packages/connector/src/settlement/provider/solana-payment-channel-provider.test.ts`
  - [x] 1.3 Implement class skeleton with `chainType: 'solana'` and `chainId: 'solana:<cluster>'`
  - [x] 1.4 Constructor takes `SolanaPaymentChannelSDK`, `chainId`, `tokenMint`, `signer` (`KeyPairSigner` from `@solana/kit`), and `Logger`

- [x] Task 2: Implement channel lifecycle methods (AC: 2, 3, 5)
  - [x] 2.1 Implement `openChannel(participant, settlementTimeout)` -- pass `_signer` as payer, `_signer.address` as participantA, `participant` as participantB, `_tokenMint`, `BigInt(settlementTimeout)` to SDK; map result to `OpenChannelResult`
  - [x] 2.2 Implement `deposit(channelId, amount)` -- derive depositor's associated token account from `_signer.address` + `_tokenMint` via `findAssociatedTokenPda`; convert string amount to bigint via `safeBigInt()`; pass `_signer` as depositor to SDK
  - [x] 2.3 Implement `closeChannel(channelId)` -- pass `_signer` as closer to SDK
  - [x] 2.4 Implement `settleChannel(channelId)` -- fetch channel state first to get participantA/B addresses; derive both participants' ATAs from `_tokenMint`; pass `_signer` as caller, `_signer.address` as rentRecipient to SDK
  - [x] 2.5 Implement private `_deriveATA(owner: string)` helper to avoid duplication in deposit/settle
  - [x] 2.6 Write unit tests for each lifecycle method

- [x] Task 3: Implement claim methods (AC: 4, 6, 7)
  - [x] 3.1 Implement `claimFromChannel(channelId, balanceProof, signature)` -- pass `_signer` as claimer, extract nonce as `BigInt(balanceProof.nonce)`, convert transferredAmount via `safeBigInt()`, decode base64 signature to `Uint8Array` via `Buffer.from(sig, 'base64')`, delegate to SDK
  - [x] 3.2 Implement `signBalanceProof(params)` -- call `SolanaPaymentChannelSDK.signBalanceProof(channelId, BigInt(nonce), safeBigInt(transferredAmount), this._signer.keyPair)`, return `Buffer.from(resultBytes).toString('base64')`
  - [x] 3.3 Implement `verifyBalanceProof(params)` -- call `SolanaPaymentChannelSDK._buildBalanceProofMessage()` to get 48-byte message, decode base58 signerAddress to pubkey bytes, verify Ed25519 signature using `@solana/kit` `verifySignature()` or `crypto.subtle.verify()`
  - [x] 3.4 Write unit tests for claim methods (mock `SolanaPaymentChannelSDK.signBalanceProof` static method)

- [x] Task 4: Implement state query and event subscription (AC: 8, 9)
  - [x] 4.1 Implement `getChannelState(channelId)` -- delegate to SDK, map `SolanaChannelState` to `ProviderChannelState`
  - [x] 4.2 Implement `subscribeToEvents(channelId, callback)` -- wrap SDK.subscribeToChannel(), diff previous/current state to determine event type, emit `ProviderEvent`
  - [x] 4.3 Write unit tests for state mapping and event emission

- [x] Task 5: Implement error mapping and factory function (AC: 10, 11)
  - [x] 5.1 Implement error wrapping: catch `SolanaChannelError` from SDK calls, wrap with provider context
  - [x] 5.2 Implement `createSolanaProviderFactory(logger, signer, tokenMint)` function compatible with `ChainProviderFactory` type -- signer and tokenMint are closure params since `SolanaProviderConfig` lacks these fields
  - [x] 5.3 Write unit tests for error mapping and factory function

- [x] Task 6: Update barrel exports (AC: 1)
  - [x] 6.1 Add `SolanaPaymentChannelProvider` and `createSolanaProviderFactory` to `provider/index.ts`

- [x] Task 7: Regression gate
  - [x] 7.1 Run `npm test` in `packages/connector` -- all existing tests pass
  - [x] 7.2 Run `npx tsc --noEmit` -- TypeScript compiles with no errors
  - [x] 7.3 No changes to existing source files other than `provider/index.ts` barrel export

## Dev Notes

### This Provider Wraps the SDK -- Follow the EVM Pattern Exactly

The `SolanaPaymentChannelProvider` wraps `SolanaPaymentChannelSDK` (Story 33.4) to implement the `PaymentChannelProvider` interface (Epic 32). The pattern is identical to how `EVMPaymentChannelProvider` wraps `PaymentChannelSDK`. Study `evm-payment-channel-provider.ts` closely -- it is your reference implementation.

### File to Create

| File | Purpose |
|------|---------|
| `packages/connector/src/settlement/provider/solana-payment-channel-provider.ts` | Provider class + factory function |
| `packages/connector/src/settlement/provider/solana-payment-channel-provider.test.ts` | Unit tests |

### File to Modify

| File | Change |
|------|--------|
| `packages/connector/src/settlement/provider/index.ts` | Add barrel exports for `SolanaPaymentChannelProvider` and `createSolanaProviderFactory` |

### Files NOT to Modify

- `payment-channel-provider.ts` -- interface is complete, do NOT change it
- `chain-provider-registry.ts` -- registry is chain-agnostic, do NOT change it
- `evm-payment-channel-provider.ts` -- EVM provider is done, do NOT change it
- `solana-payment-channel-sdk.ts` -- SDK is done (Story 33.4), do NOT change it
- `btp-claim-types.ts` -- claim types are done, do NOT change it (Story 33.6 scope)

### Provider Class Signature

```typescript
import type { Logger } from '../../../utils/logger';
import type { BlockchainType } from '../../../btp/btp-claim-types';
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
  ProviderConfig,
} from './payment-channel-provider';
import type { ChainProviderFactory } from './chain-provider-registry';
import type { SolanaPaymentChannelSDK, SolanaChannelState } from '../solana-payment-channel-sdk';
import type { KeyPairSigner } from '@solana/kit';

export class SolanaPaymentChannelProvider implements PaymentChannelProvider {
  readonly chainType: BlockchainType = 'solana';
  readonly chainId: string;

  constructor(
    private readonly _sdk: SolanaPaymentChannelSDK,
    chainId: string,                              // e.g., 'solana:devnet'
    private readonly _tokenMint: string,          // base58 SPL token mint
    private readonly _signer: KeyPairSigner,      // Ed25519 keypair — has .address (TransactionSigner) AND .keyPair (CryptoKeyPair for signBalanceProof)
    private readonly _logger: Logger,
  ) {
    // Validate inputs, set chainId
  }

  // ... implement all PaymentChannelProvider methods
}

export function createSolanaProviderFactory(
  logger: Logger,
  signer: KeyPairSigner,       // pre-built for now, key management deferred to 33.8
  tokenMint: string,           // SPL token mint address
): ChainProviderFactory {
  return (config: ProviderConfig): PaymentChannelProvider => {
    if (config.chainType !== 'solana') {
      throw new Error(`Solana factory received non-Solana config: ${config.chainType}`);
    }
    // Note: SDK auto-derives wsUrl from rpcUrl (http->ws). config.wsUrl is ignored for now.
    // Supporting custom wsUrl requires SDK constructor change (deferred).
    const sdk = new SolanaPaymentChannelSDK(config.rpcUrl, config.programId, logger);
    const cluster = config.cluster ?? 'devnet';
    const chainId = `solana:${cluster}`;
    return new SolanaPaymentChannelProvider(sdk, chainId, tokenMint, signer, logger);
  };
}
```

### Critical: BalanceProofParams Field Mapping

The `PaymentChannelProvider` interface uses EVM-flavored `BalanceProofParams` with fields `lockedAmount` and `locksRoot` that do NOT exist in Solana's model. Handle these as follows:

| BalanceProofParams field | Solana mapping |
|--------------------------|----------------|
| `channelId` | PDA address (base58 string) -- pass directly to SDK as `channelPDA` |
| `nonce` | Pass directly to SDK (monotonically increasing) |
| `transferredAmount` | Convert from string to bigint via `safeBigInt()` |
| `lockedAmount` | **IGNORE** -- Solana channels do not have locked amounts. Log a warning if non-zero. |
| `locksRoot` | **IGNORE** -- Solana channels do not have locks. Log a warning if non-zero/non-empty. |

### Critical: Signature Encoding Convention

- **Provider interface** (`signBalanceProof` returns `string`, `claimFromChannel` accepts `string`): Use **base64** encoding for Ed25519 signatures
- **SDK** (`SolanaPaymentChannelSDK.signBalanceProof` returns `Uint8Array`, `claimFromChannel` accepts `Uint8Array`): Raw bytes
- The provider must convert between base64 strings (provider layer) and Uint8Array (SDK layer) using `Buffer.from(sig, 'base64')` and `Buffer.from(sigBytes).toString('base64')`

### Critical: verifyBalanceProof Implementation

The SDK does NOT have a `verifyBalanceProof` method -- verification happens on-chain via the Ed25519 precompile. Implement off-chain verification in the provider:

1. Reconstruct the 48-byte balance proof message using `SolanaPaymentChannelSDK._buildBalanceProofMessage(channelId, BigInt(nonce), safeBigInt(transferredAmount))` -- the underscore prefix suggests internal intent but it is static and accessible
2. Decode the base64 signature string to `Uint8Array`
3. Decode the `signerAddress` (base58 pubkey) to 32-byte `Uint8Array` using `getAddressEncoder().encode(address(signerAddress))`
4. Verify using Node.js `crypto.subtle.verify('Ed25519', publicCryptoKey, signatureBytes, messageBytes)`:
   - Import the 32-byte pubkey as a CryptoKey: `crypto.subtle.importKey('raw', pubkeyBytes, 'Ed25519', true, ['verify'])`
   - Call `crypto.subtle.verify('Ed25519', key, signature, message)`
5. Return `true` if valid, `false` otherwise
6. Wrap in try-catch: return `false` on any verification error (don't throw)

Note: `@solana/kit` v3's `verifySignature()` is not directly importable in all builds. Using Node.js native `crypto.subtle` (available since Node 18+) avoids adding `tweetnacl` as a dependency. The project already uses `import * as crypto from 'crypto'` in the SDK file.

### Critical: subscribeToEvents State Diffing

The SDK's `subscribeToChannel(channelPDA, callback)` fires the callback with the new `SolanaChannelState` on every account change. The provider must diff the previous and current state to determine the event type:

| State transition | ProviderEventType |
|-----------------|-------------------|
| `transferredAmountA` or `transferredAmountB` increased | `'channel_claimed'` |
| `depositA` or `depositB` increased | `'channel_deposited'` |
| state changed to `'closed'` | `'channel_closed'` |
| state changed to `'settled'` | `'channel_settled'` |

Store the previous `SolanaChannelState` per channel subscription and compare fields on each callback.

### Critical: SDK Method Signature Mismatches -- Provider Must Adapt

The `PaymentChannelProvider` interface has simple method signatures, but the Solana SDK methods take additional parameters. The provider MUST bridge these gaps:

**`openChannel(participant, settlementTimeout)` -> SDK `openChannel(payer, participantA, participantB, tokenMint, challengeDuration)`:**
1. Pass `this._signer` as `payer`
2. Use `this._signer.address` (base58 string) as `participantA`
3. Use the `participant` argument as `participantB`
4. Use `this._tokenMint` as `tokenMint`
5. Convert `settlementTimeout` (number) to `BigInt(settlementTimeout)` for `challengeDuration`
6. Map result: `{ channelId: result.channelPDA, txHash: result.txSignature }`

**`deposit(channelId, amount)` -> SDK `deposit(depositor, channelPDA, depositorTokenAccount, amount)`:**
1. Pass `this._signer` as `depositor`
2. Pass `channelId` as `channelPDA`
3. **Derive the depositor's associated token account** from `this._signer.address` and `this._tokenMint` using `@solana-program/token`'s `findAssociatedTokenPda()` or manual PDA derivation
4. Convert string `amount` to bigint via `safeBigInt()`
5. Map result: `{ txHash: result.txSignature }`

**`closeChannel(channelId)` -> SDK `closeChannel(closer, channelPDA)`:**
1. Pass `this._signer` as `closer`
2. Map result: `{ txHash: result.txSignature }`

**`settleChannel(channelId)` -> SDK `settleChannel(caller, channelPDA, participantAToken, participantBToken, rentRecipient)`:**
1. Pass `this._signer` as `caller`
2. Must fetch channel state first to get `participantA` and `participantB` addresses
3. Derive associated token accounts for both participants using `this._tokenMint`
4. Use `this._signer.address` as `rentRecipient` (reclaim rent to provider operator)
5. Map result: `{ txHash: result.txSignature }`

**`claimFromChannel(channelId, balanceProof, signature)` -> SDK `claimFromChannel(claimer, channelPDA, nonce, transferredAmount, signature)`:**
1. Pass `this._signer` as `claimer`
2. Extract `nonce` from `balanceProof.nonce` as `BigInt(balanceProof.nonce)`
3. Convert `balanceProof.transferredAmount` via `safeBigInt()`
4. Decode base64 `signature` string to `Uint8Array` via `Buffer.from(signature, 'base64')`
5. Map result: `{ txHash: result.txSignature }`

**`signBalanceProof(params)` -> SDK static `SolanaPaymentChannelSDK.signBalanceProof(channelPDA, nonce, transferredAmount, keypair)`:**
1. Pass `params.channelId` as `channelPDA`
2. Convert `params.nonce` to `BigInt(params.nonce)`
3. Convert `params.transferredAmount` via `safeBigInt()`
4. Pass `this._signer.keyPair` as `keypair` (the `Ed25519KeyPair`)
5. Return `Buffer.from(resultBytes).toString('base64')`

### Critical: getChannelState Mapping

Map `SolanaChannelState` to `ProviderChannelState`:

```typescript
private _toProviderChannelState(pda: string, state: SolanaChannelState): ProviderChannelState {
  return {
    channelId: pda,
    status: state.state,  // 'opened' | 'closed' | 'settled' -- already matches
    participants: [state.participantA, state.participantB],
    deposit: state.depositA + state.depositB,
  };
}
```

### Error Mapping Pattern

Catch `SolanaChannelError` from SDK calls and wrap with provider context:

```typescript
try {
  return await this._sdk.someMethod(...);
} catch (err: unknown) {
  if (err instanceof SolanaChannelError) {
    throw new Error(
      `SolanaPaymentChannelProvider [${this.chainId}] channel ${channelId}: ` +
      `${err.errorName} (code ${err.code}): ${err.message}`
    );
  }
  throw err;
}
```

Import `SolanaChannelError` from `../solana-payment-channel-sdk`.

### Critical: KeyPairSigner Type (NOT TransactionSigner)

The SDK transaction methods require a `TransactionSigner` (from `@solana/kit`) as the first argument. However, `SolanaPaymentChannelSDK.signBalanceProof()` is a static method that requires an `Ed25519KeyPair` (with `.publicKey` and `.privateKey`). The `KeyPairSigner` type from `@solana/kit` satisfies BOTH requirements:

- `KeyPairSigner` implements `TransactionSigner` (has `.address` for transaction signing)
- `KeyPairSigner` has `.keyPair: CryptoKeyPair` which is the `Ed25519KeyPair` needed by `signBalanceProof()`

The provider constructor MUST accept `KeyPairSigner` (not plain `TransactionSigner`) so it can:
1. Pass `this._signer` directly to SDK transaction methods (openChannel, deposit, etc.) as the payer/signer
2. Pass `this._signer.keyPair` to `SolanaPaymentChannelSDK.signBalanceProof()` for balance proof signing
3. Read `this._signer.address` (base58 string) as the provider's own participant address

Import: `import type { KeyPairSigner } from '@solana/kit';`

For the initial implementation, the factory can accept a pre-built `KeyPairSigner` -- full key management integration is deferred to Story 33.8.

### Solana-Specific Public Method: getSolanaContext()

Following the EVM pattern (`getSigningContext()`), add a Solana-specific method not on the interface:

```typescript
getSolanaContext(): { programId: string; tokenMint: string; cluster: string; signerAddress: string } {
  // Return Solana-specific context for claim message construction (Story 33.6)
}
```

Callers should use `instanceof SolanaPaymentChannelProvider` to narrow the type before calling.

### Critical: Associated Token Account Derivation

The SDK `deposit()` and `settleChannel()` methods require associated token account (ATA) addresses. The provider must derive these. Use the standard ATA PDA derivation:

```typescript
import { findAssociatedTokenPda } from '@solana-program/token';
import { address } from '@solana/kit';

// Derive ATA for a given owner and token mint
const [ata] = await findAssociatedTokenPda({
  owner: address(ownerAddress),
  mint: address(this._tokenMint),
  tokenProgram: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
});
```

Note: `@solana-program/token` ^0.6.0 is already in `packages/connector/package.json` (added in Story 33.4). If `findAssociatedTokenPda` is not available in the installed version, use manual PDA derivation with seeds `[ownerBytes, TOKEN_PROGRAM, mintBytes]` and the `ASSOCIATED_TOKEN_PROGRAM` address (`ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`).

### Critical: Pino Logger Format

The EVM provider uses the WRONG logger format (`logger.info('message', {fields})` -- message first). The Solana SDK uses the CORRECT format per project standards. The Solana provider MUST use the correct format:

```typescript
// CORRECT (fields first, message second)
this._logger.info({ event: 'open_channel', channelId, chainId: this.chainId }, 'Opening channel');

// WRONG -- do NOT copy the EVM provider's logger call style
this._logger.info('Opening channel', { channelId });
```

### safeBigInt Helper

Copy the `safeBigInt()` helper pattern from `evm-payment-channel-provider.ts`:

```typescript
function safeBigInt(value: string, fieldName: string): bigint {
  try {
    return BigInt(value);
  } catch {
    const sanitized = value.length > 32 ? `${value.slice(0, 32)}...` : value;
    throw new Error(`Invalid ${fieldName}: expected a numeric string, received "${sanitized}"`);
  }
}
```

### SolanaProviderConfig Reference

Already defined in `payment-channel-provider.ts`:

```typescript
export interface SolanaProviderConfig {
  chainType: 'solana';
  rpcUrl: string;
  wsUrl?: string;
  programId: string;
  keyId: string;
  cluster?: string;
}
```

**Known gap:** `SolanaProviderConfig` does NOT include a `tokenMint` field, but the provider needs one. This mirrors the EVM pattern where `EVMProviderConfig` lacks `tokenAddress` and the factory derives it from `registryAddress`. For the Solana factory:

- Use `config.programId` to identify the program -- the `tokenMint` must be supplied separately
- For now, the factory can accept `tokenMint` as a closure parameter alongside the pre-built signer (similar to how the EVM factory accepts a pre-built `sdk`)
- Adding `tokenMint` to `SolanaProviderConfig` is deferred (Story 33.8 scope) since we must NOT modify `payment-channel-provider.ts`

Factory signature should be:

```typescript
export function createSolanaProviderFactory(
  logger: Logger,
  signer: KeyPairSigner,       // pre-built for now, key management deferred to 33.8
  tokenMint: string,           // SPL token mint address
): ChainProviderFactory { ... }
```

### Testing Strategy

**All tests are unit tests with mocked SDK.** No real Solana RPC or on-chain interaction needed.

Mock `SolanaPaymentChannelSDK` with `jest.fn()` implementations for all methods. Mock `KeyPairSigner` as `{ address: 'SomeBase58Address' as Address, keyPair: { publicKey: mockPubKey, privateKey: mockPrivKey } }`. Use `pino({ level: 'silent' })` for the mock logger. Mock `findAssociatedTokenPda` from `@solana-program/token` to return deterministic ATA addresses.

**Test categories:**

1. **Constructor validation** -- empty chainId, empty tokenMint
2. **Lifecycle delegation** -- each method calls the correct SDK method with converted params
3. **Claim methods** -- signBalanceProof produces base64, verifyBalanceProof returns boolean, claimFromChannel decodes base64 to Uint8Array
4. **State mapping** -- SolanaChannelState mapped to ProviderChannelState correctly
5. **Event subscription** -- state diffing produces correct ProviderEventType
6. **Error mapping** -- SolanaChannelError wrapped with provider context
7. **Factory function** -- validates config.chainType, creates provider

### Project Structure Notes

- Provider file location: `packages/connector/src/settlement/provider/solana-payment-channel-provider.ts`
- This follows the existing pattern where `evm-payment-channel-provider.ts` lives in the same `provider/` directory
- The barrel export in `provider/index.ts` must be updated to include the new exports

### Previous Story Intelligence

**From Story 33.4 (most recent):**
- `SolanaPaymentChannelSDK` class at `packages/connector/src/settlement/solana-payment-channel-sdk.ts`
- Static methods: `deriveChannelPDA()`, `deriveVaultPDA()`, `signBalanceProof()`, `_buildBalanceProofMessage()`
- Instance methods with FULL signatures:
  - `openChannel(payer: TransactionSigner, participantA: string, participantB: string, tokenMint: string, challengeDuration: bigint): Promise<{ channelPDA: string; txSignature: string }>`
  - `deposit(depositor: TransactionSigner, channelPDA: string, depositorTokenAccount: string, amount: bigint): Promise<{ txSignature: string }>`
  - `claimFromChannel(claimer: TransactionSigner, channelPDA: string, nonce: bigint, transferredAmount: bigint, signature: Uint8Array): Promise<{ txSignature: string }>`
  - `closeChannel(closer: TransactionSigner, channelPDA: string): Promise<{ txSignature: string }>`
  - `settleChannel(caller: TransactionSigner, channelPDA: string, participantAToken: string, participantBToken: string, rentRecipient: string): Promise<{ txSignature: string }>`
  - `forceCloseExpired(caller: TransactionSigner, channelPDA: string, participantAToken: string, participantBToken: string, rentRecipient: string): Promise<{ txSignature: string }>`
  - `getChannelState(channelPDA: string): Promise<SolanaChannelState>`
  - `subscribeToChannel(channelPDA: string, callback: (state: SolanaChannelState) => void): { unsubscribe: () => void }`
- `SolanaChannelState` interface with fields: `participantA`, `participantB`, `tokenMint`, `depositA`, `depositB`, `transferredAmountA`, `transferredAmountB`, `nonceA`, `nonceB`, `challengeDuration`, `state`, `closeTimestamp`, `bump`
- `SolanaChannelError` class with `code: number` and `errorName: string` properties
- Dependencies already in package.json: `@solana/kit` ^3.0.3, `@solana-program/token` ^0.6.0 (both needed -- `@solana/kit` for `KeyPairSigner`/`address`/`getAddressEncoder`, `@solana-program/token` for `findAssociatedTokenPda`)
- SDK constructor: `new SolanaPaymentChannelSDK(rpcUrl, programId, logger)`
- Key types from `@solana/kit`: `Address`, `TransactionSigner`, `CryptoKeyPair`
- `signBalanceProof()` is a static method: `SolanaPaymentChannelSDK.signBalanceProof(channelPDA, nonce, transferredAmount, keypair: Ed25519KeyPair)` -- the `Ed25519KeyPair` is a local interface with `{ publicKey: unknown; privateKey: unknown }`, compatible with `KeyPairSigner.keyPair` (`CryptoKeyPair`)
- 41 unit tests passing, 10 integration tests skipped (deferred to Story 33.7)
- Review found and fixed: wrong system program address, wrong signer roles, crypto import style, `any` casts replaced with `unknown`

**From Story 33.4 Code Review:**
- All `eslint-disable` comments for `@typescript-eslint/no-explicit-any` in `_sendTransaction` are justified due to `@solana/kit` v3 branded type system
- Input validation guards on all public functions (byte array lengths, numeric ranges)
- All 6 well-known Solana program addresses verified correct

### Git Intelligence

- Branch: `epic-33` (current)
- Most recent commit: `e68f0187 feat(33-4): SolanaPaymentChannelSDK -- TypeScript integration`
- Commit convention: `feat(33-5): <description>`
- Story 33.4 created new files only -- no existing source files modified

### Cross-Story Dependencies

- **Story 33.6** (next) will add Solana claim construction/verification paths to `claim-sender.ts` and `claim-receiver.ts` -- will call `SolanaPaymentChannelProvider.getSolanaContext()` via `instanceof` check
- **Story 33.7** will add E2E integration tests exercising the full lifecycle through the provider
- This provider mirrors `EVMPaymentChannelProvider` -- follow its patterns exactly

### Coding Standards Reminders

- **Named exports only** -- no default exports
- **`import type` for type-only imports**
- **Pino logger** -- `logger.info({ event: 'event_name', key: value }, 'message')`
- **No `any` type** -- use `unknown` and type narrowing
- **No `console.log`** -- use Pino logger
- **Unused params prefixed `_`**
- **Strict null checks** -- handle `| undefined` from `noUncheckedIndexedAccess`
- **Custom errors** -- set `this.name`, call `Error.captureStackTrace`
- **File naming** -- kebab-case: `solana-payment-channel-provider.ts`
- **BigInt for amounts** -- use `bigint` type, provider interface uses string amounts, SDK uses bigint
- **Jest test patterns** -- `jest.clearAllMocks()` in `beforeEach`, `pino({ level: 'silent' })` for mock logger
- **JSDoc on public APIs** -- `@remarks`, `@param`, `@returns` tags
- **Barrel exports** -- explicit `export type` separation from runtime exports

### References

- [Source: packages/connector/src/settlement/provider/payment-channel-provider.ts -- PaymentChannelProvider interface, ProviderChannelState, all param/result types, SolanaProviderConfig]
- [Source: packages/connector/src/settlement/provider/evm-payment-channel-provider.ts -- reference implementation pattern, safeBigInt helper, event subscription pattern, factory function]
- [Source: packages/connector/src/settlement/provider/chain-provider-registry.ts -- ChainProviderFactory type, registration API]
- [Source: packages/connector/src/settlement/provider/index.ts -- barrel export pattern]
- [Source: packages/connector/src/settlement/solana-payment-channel-sdk.ts -- SDK class, SolanaChannelState, SolanaChannelError, static methods]
- [Source: packages/connector/src/btp/btp-claim-types.ts -- BlockchainType, SolanaClaimMessage (already defined)]
- [Source: _bmad-output/planning-artifacts/epic-33-solana-payment-channel-provider.md#Story 33.5]
- [Source: _bmad-output/project-context.md -- coding standards, testing rules, chain abstraction patterns]

## Preconditions

- Story 33.4 is complete -- `SolanaPaymentChannelSDK` exists and all 41 unit tests pass
- Epic 32 is complete -- `PaymentChannelProvider` interface, `ChainProviderRegistry`, `EVMPaymentChannelProvider` all working
- Branch `epic-33` with commit `e68f0187`
- `@solana/kit` ^3.0.3 already in `packages/connector/package.json` (added in Story 33.4)

## Out of Scope

- Solana claim message construction/verification in BTP layer (Story 33.6)
- E2E integration tests with real Solana validator (Story 33.7)
- Full key management integration in factory function (Story 33.8)
- Modifying the `PaymentChannelProvider` interface
- Modifying the `SolanaPaymentChannelSDK`
- Token-2022 support (deferred)

## Test Plan

| Test ID | Scenario | Type | Priority | File |
|---------|----------|------|----------|------|
| T-33.5-01 | Constructor validates non-empty chainId and tokenMint | Unit | P0 | solana-payment-channel-provider.test.ts |
| T-33.5-02 | chainType is 'solana', chainId matches constructor arg | Unit | P0 | solana-payment-channel-provider.test.ts |
| T-33.5-03 | openChannel delegates to SDK with correct params and returns OpenChannelResult | Unit | P0 | solana-payment-channel-provider.test.ts |
| T-33.5-04 | deposit converts string amount to bigint and delegates to SDK | Unit | P0 | solana-payment-channel-provider.test.ts |
| T-33.5-05 | claimFromChannel decodes base64 signature, extracts nonce/amount, delegates to SDK | Unit | P0 | solana-payment-channel-provider.test.ts |
| T-33.5-06 | closeChannel delegates to SDK | Unit | P1 | solana-payment-channel-provider.test.ts |
| T-33.5-07 | settleChannel delegates to SDK | Unit | P1 | solana-payment-channel-provider.test.ts |
| T-33.5-08 | signBalanceProof calls SDK static method, returns base64 signature | Unit | P0 | solana-payment-channel-provider.test.ts |
| T-33.5-09 | verifyBalanceProof reconstructs message and verifies Ed25519 signature | Unit | P0 | solana-payment-channel-provider.test.ts |
| T-33.5-10 | getChannelState maps SolanaChannelState to ProviderChannelState correctly | Unit | P0 | solana-payment-channel-provider.test.ts |
| T-33.5-11 | subscribeToEvents detects claim (transferredAmount increase) and emits channel_claimed | Unit | P1 | solana-payment-channel-provider.test.ts |
| T-33.5-12 | subscribeToEvents detects deposit and emits channel_deposited | Unit | P1 | solana-payment-channel-provider.test.ts |
| T-33.5-13 | subscribeToEvents detects close and emits channel_closed | Unit | P1 | solana-payment-channel-provider.test.ts |
| T-33.5-14 | subscribeToEvents detects settle and emits channel_settled | Unit | P1 | solana-payment-channel-provider.test.ts |
| T-33.5-15 | SolanaChannelError mapped to descriptive provider Error with context | Unit | P0 | solana-payment-channel-provider.test.ts |
| T-33.5-16 | createSolanaProviderFactory rejects non-solana config | Unit | P0 | solana-payment-channel-provider.test.ts |
| T-33.5-17 | createSolanaProviderFactory returns SolanaPaymentChannelProvider from valid config (accepts signer + tokenMint as closure params) | Unit | P0 | solana-payment-channel-provider.test.ts |
| T-33.5-18 | lockedAmount and locksRoot are safely ignored with warning log | Unit | P1 | solana-payment-channel-provider.test.ts |
| T-33.5-19 | getSolanaContext returns programId, tokenMint, cluster, signerAddress | Unit | P1 | solana-payment-channel-provider.test.ts |
| T-33.5-20 | deposit derives correct associated token account for depositor | Unit | P0 | solana-payment-channel-provider.test.ts |
| T-33.5-21 | settleChannel fetches state and derives ATAs for both participants | Unit | P0 | solana-payment-channel-provider.test.ts |
| T-33.5-22 | signBalanceProof passes _signer.keyPair (not _signer) to SDK static method | Unit | P0 | solana-payment-channel-provider.test.ts |

### Regression Gate

- `npm test` in `packages/connector` -- all existing tests pass
- `npx tsc --noEmit` -- TypeScript compiles with no errors
- Only `provider/index.ts` modified among existing files (barrel export addition)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context) -- claude-opus-4-6[1m]

### Debug Log References

None required.

### Completion Notes List

- **Task 1 (class skeleton):** Created `SolanaPaymentChannelProvider` class implementing `PaymentChannelProvider` interface with `chainType: 'solana'`, `chainId: 'solana:<cluster>'`, constructor accepting SDK, chainId, tokenMint, signer (KeyPairSigner), programId, and logger. Added validation for empty chainId and tokenMint.
- **Task 2 (lifecycle methods):** Implemented `openChannel`, `deposit`, `closeChannel`, `settleChannel` with full SDK delegation. Added `_deriveATA()` private helper using `findAssociatedTokenPda` from `@solana-program/token`. `settleChannel` fetches channel state to derive both participants' ATAs.
- **Task 3 (claim methods):** Implemented `claimFromChannel` (base64 decode to Uint8Array), `signBalanceProof` (SDK static method with `_signer.keyPair`, returns base64), `verifyBalanceProof` (reconstructs 48-byte message via SDK static method, verifies Ed25519 via `crypto.subtle`). Added `_warnIfEVMFields()` for lockedAmount/locksRoot warnings.
- **Task 4 (state query & events):** Implemented `getChannelState` with `_toProviderChannelState()` mapping. Implemented `subscribeToEvents` with `_diffState()` for state-diffing (detects claim, deposit, close, settle transitions).
- **Task 5 (error mapping & factory):** Implemented `_wrapError()` for `SolanaChannelError` wrapping with provider context. Implemented `createSolanaProviderFactory()` with closure params for signer and tokenMint.
- **Task 6 (barrel exports):** Updated `provider/index.ts` to export `SolanaPaymentChannelProvider` and `createSolanaProviderFactory`.
- **Task 7 (regression gate):** All 2055 tests pass (86 suites), `tsc --noEmit` clean, only `index.ts` modified among existing files.
- **Additional:** Added `_programId` constructor parameter since SDK's `_programId` is private; needed for `getSolanaContext()`. Added `getSolanaContext()` Solana-specific method per story spec.

### File List

- `packages/connector/src/settlement/provider/solana-payment-channel-provider.ts` -- **created** -- Provider class + factory function (480 lines)
- `packages/connector/src/settlement/provider/solana-payment-channel-provider.test.ts` -- **modified** (replaced red-phase stubs) -- 29 unit tests covering all ACs
- `packages/connector/src/settlement/provider/index.ts` -- **modified** -- Added barrel exports for SolanaPaymentChannelProvider and createSolanaProviderFactory

### Change Log

| Date | Change |
|------|--------|
| 2026-03-26 | Story 33.5 implemented: SolanaPaymentChannelProvider wrapping SolanaPaymentChannelSDK via PaymentChannelProvider interface. 29 tests passing, full regression green (2055 tests). |
| 2026-03-26 | Code review #1 fixes applied: added programId validation in constructor, added EVM field warning in verifyBalanceProof, added tests covering both gaps. 49 tests total. |
| 2026-03-26 | Code review #2 fixes applied: restored cause chain in error wrapping, fixed ESLint no-var-requires violation, fixed Prettier formatting. 49 tests still pass. |

## Code Review Record

### Review Pass #1

- **Date:** 2026-03-26
- **Reviewer model:** Claude Opus 4.6 (1M context) -- claude-opus-4-6[1m]
- **Issue counts:** 0 critical, 0 high, 1 medium, 2 low
- **Issues found:**
  - **Medium:** Missing `programId` validation in constructor -- constructor did not validate that `programId` was non-empty.
  - **Low:** `verifyBalanceProof` did not call `_warnIfEVMFields()` to warn about ignored EVM-specific fields (`lockedAmount`, `locksRoot`).
  - **Low:** Tests did not cover the above two gaps.
- **Fixes applied:** All 3 issues fixed in same session. Added programId validation guard, added EVM field warning call in `verifyBalanceProof`, added tests for both. Test count increased from 29 to 49.
- **Outcome:** Pass -- all issues resolved, no follow-up actions required.

### Review Pass #2

- **Date:** 2026-03-26
- **Reviewer model:** Claude Opus 4.6 (1M context) -- claude-opus-4-6[1m]
- **Issue counts:** 0 critical, 0 high, 2 medium, 1 low
- **Issues found:**
  - **Medium:** Error wrapping lost cause chain -- wrapped errors did not preserve the original error as the `cause` property, breaking debuggability.
  - **Medium:** ESLint `no-var-requires` violation -- a `require()` call violated the project's ESLint rules.
  - **Low:** Prettier formatting -- minor formatting inconsistency caught by Prettier.
- **Fixes applied:** All 3 issues fixed in same session. 49 tests still pass.
- **Outcome:** Pass -- all issues resolved, no follow-up actions required.

### Review Pass #3

- **Date:** 2026-03-26
- **Reviewer model:** Claude Opus 4.6 (1M context) -- claude-opus-4-6[1m]
- **Issue counts:** 0 critical, 0 high, 0 medium, 0 low
- **Issues found:** None. Semgrep scan clean. OWASP review clean. All 49 tests pass.
- **Fixes applied:** None required -- no files modified.
- **Outcome:** Pass (final) -- code approved, story complete.
