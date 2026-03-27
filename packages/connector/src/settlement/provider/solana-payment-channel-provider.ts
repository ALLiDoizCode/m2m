/**
 * Solana Payment Channel Provider
 *
 * Implements the chain-agnostic `PaymentChannelProvider` interface by delegating
 * to `SolanaPaymentChannelSDK`. All Solana-specific parameter adaptation
 * (ATA derivation, Ed25519 signing, bigint conversions, event state-diffing)
 * is handled here.
 *
 * Epic 33 Story 33.5: Implement SolanaPaymentChannelProvider
 *
 * @module solana-payment-channel-provider
 */

import * as crypto from 'crypto';
import { address, getAddressEncoder } from '@solana/kit';
import type { KeyPairSigner } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
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
  ProviderConfig,
} from './payment-channel-provider';
import type { ChainProviderFactory } from './chain-provider-registry';
import { SolanaPaymentChannelSDK, SolanaChannelError } from '../solana-payment-channel-sdk';
import type { SolanaChannelState } from '../solana-payment-channel-sdk';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Standard SPL Token program address */
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely convert a string amount to `bigint`, throwing a descriptive error
 * instead of a raw `SyntaxError` if the value is not a valid integer string.
 *
 * @param value - The string representation of a bigint
 * @param fieldName - Human-readable field name for error messages
 * @returns The parsed bigint
 * @throws {Error} If the value cannot be parsed as a bigint
 */
function safeBigInt(value: string, fieldName: string): bigint {
  try {
    return BigInt(value);
  } catch {
    const sanitized = value.length > 32 ? `${value.slice(0, 32)}...` : value;
    throw new Error(`Invalid ${fieldName}: expected a numeric string, received "${sanitized}"`);
  }
}

// ---------------------------------------------------------------------------
// Solana Payment Channel Provider
// ---------------------------------------------------------------------------

/**
 * Solana-specific implementation of the `PaymentChannelProvider` interface.
 *
 * Composes a `SolanaPaymentChannelSDK` instance via delegation (not inheritance).
 * Each method adapts provider-level parameters (string amounts, base64 signatures)
 * to SDK-level parameters (bigint amounts, Uint8Array signatures).
 *
 * @remarks
 * - Uses Ed25519 signatures (not EIP-712)
 * - Channel IDs are PDAs (program-derived addresses in base58)
 * - Associated Token Accounts are derived for deposit/settle operations
 * - Event subscription uses account change polling with state-diffing
 */
export class SolanaPaymentChannelProvider implements PaymentChannelProvider {
  /** @inheritdoc */
  readonly chainType: BlockchainType = 'solana';

  /** @inheritdoc */
  readonly chainId: string;

  /**
   * Create a new SolanaPaymentChannelProvider.
   *
   * @param _sdk - The underlying SolanaPaymentChannelSDK instance
   * @param chainId - Namespaced chain identifier (e.g., `'solana:devnet'`)
   * @param _tokenMint - SPL token mint address (base58)
   * @param _signer - Ed25519 keypair signer from `@solana/kit`
   * @param _programId - Payment channel program ID (base58)
   * @param _logger - Logger instance for diagnostic output
   */
  constructor(
    private readonly _sdk: SolanaPaymentChannelSDK,
    chainId: string,
    private readonly _tokenMint: string,
    private readonly _signer: KeyPairSigner,
    private readonly _programId: string,
    private readonly _logger: Logger
  ) {
    if (!chainId) {
      throw new Error('SolanaPaymentChannelProvider: chainId must not be empty');
    }
    if (!_tokenMint) {
      throw new Error('SolanaPaymentChannelProvider: tokenMint must not be empty');
    }
    if (!_programId) {
      throw new Error('SolanaPaymentChannelProvider: programId must not be empty');
    }
    this.chainId = chainId;
  }

  // -------------------------------------------------------------------------
  // Channel Lifecycle Methods
  // -------------------------------------------------------------------------

  /**
   * Open a new payment channel between two participants.
   *
   * Delegates to `SolanaPaymentChannelSDK.openChannel()` with the signer as
   * payer and participantA, the given participant as participantB.
   *
   * @param participant - Base58 address of the counterparty
   * @param settlementTimeout - Challenge duration in seconds
   * @returns Channel PDA identifier and transaction signature
   */
  async openChannel(participant: string, settlementTimeout: number): Promise<OpenChannelResult> {
    this._logger.info(
      { event: 'open_channel', participant, settlementTimeout, chainId: this.chainId },
      'Opening Solana payment channel'
    );

    try {
      const result = await this._sdk.openChannel(
        this._signer,
        this._signer.address as string,
        participant,
        this._tokenMint,
        BigInt(settlementTimeout)
      );

      return { channelId: result.channelPDA, txHash: result.txSignature };
    } catch (err: unknown) {
      throw this._wrapError(err, 'openChannel', 'new');
    }
  }

  /**
   * Deposit funds into an existing channel.
   *
   * Derives the depositor's associated token account from the signer address
   * and token mint, then delegates to the SDK.
   *
   * @param channelId - Channel PDA (base58)
   * @param amount - Amount to deposit (string for bigint precision)
   * @returns Transaction signature
   */
  async deposit(channelId: string, amount: string): Promise<TxResult> {
    this._logger.info(
      { event: 'deposit', channelId, amount, chainId: this.chainId },
      'Depositing into Solana payment channel'
    );

    try {
      const depositorATA = await this._deriveATA(this._signer.address as string);
      const result = await this._sdk.deposit(
        this._signer,
        channelId,
        depositorATA,
        safeBigInt(amount, 'deposit amount')
      );

      return { txHash: result.txSignature };
    } catch (err: unknown) {
      throw this._wrapError(err, 'deposit', channelId);
    }
  }

  /**
   * Submit a balance proof to claim funds from a channel.
   *
   * Extracts nonce and transferredAmount from the balance proof, decodes the
   * base64 signature to Uint8Array, and delegates to the SDK.
   *
   * @param channelId - Channel PDA (base58)
   * @param balanceProof - The balance proof parameters
   * @param signature - Base64-encoded Ed25519 signature
   * @returns Transaction signature
   */
  async claimFromChannel(
    channelId: string,
    balanceProof: BalanceProofParams,
    signature: string
  ): Promise<TxResult> {
    this._logger.info(
      { event: 'claim_from_channel', channelId, nonce: balanceProof.nonce, chainId: this.chainId },
      'Claiming from Solana payment channel'
    );

    this._warnIfEVMFields(balanceProof);

    try {
      const signatureBytes = new Uint8Array(Buffer.from(signature, 'base64'));
      const result = await this._sdk.claimFromChannel(
        this._signer,
        channelId,
        BigInt(balanceProof.nonce),
        safeBigInt(balanceProof.transferredAmount, 'transferredAmount'),
        signatureBytes
      );

      return { txHash: result.txSignature };
    } catch (err: unknown) {
      throw this._wrapError(err, 'claimFromChannel', channelId);
    }
  }

  /**
   * Initiate channel closure.
   *
   * @param channelId - Channel PDA to close
   * @returns Transaction signature
   */
  async closeChannel(channelId: string): Promise<TxResult> {
    this._logger.info(
      { event: 'close_channel', channelId, chainId: this.chainId },
      'Closing Solana payment channel'
    );

    try {
      const result = await this._sdk.closeChannel(this._signer, channelId);
      return { txHash: result.txSignature };
    } catch (err: unknown) {
      throw this._wrapError(err, 'closeChannel', channelId);
    }
  }

  /**
   * Settle a closed channel after the challenge period expires.
   *
   * Fetches channel state to determine both participants, derives their
   * associated token accounts, and delegates to the SDK.
   *
   * @param channelId - Channel PDA to settle
   * @returns Transaction signature
   */
  async settleChannel(channelId: string): Promise<TxResult> {
    this._logger.info(
      { event: 'settle_channel', channelId, chainId: this.chainId },
      'Settling Solana payment channel'
    );

    try {
      const state = await this._sdk.getChannelState(channelId);
      const participantAToken = await this._deriveATA(state.participantA);
      const participantBToken = await this._deriveATA(state.participantB);

      const result = await this._sdk.settleChannel(
        this._signer,
        channelId,
        participantAToken,
        participantBToken,
        this._signer.address as string
      );

      return { txHash: result.txSignature };
    } catch (err: unknown) {
      throw this._wrapError(err, 'settleChannel', channelId);
    }
  }

  // -------------------------------------------------------------------------
  // Balance Proof Methods
  // -------------------------------------------------------------------------

  /**
   * Sign a balance proof off-chain using Ed25519.
   *
   * Delegates to `SolanaPaymentChannelSDK.signBalanceProof()` static method
   * with the signer's `keyPair`. Returns the signature as a base64 string.
   *
   * @param params - Balance proof parameters to sign
   * @returns Base64-encoded Ed25519 signature string
   */
  async signBalanceProof(params: BalanceProofParams): Promise<string> {
    this._logger.debug(
      {
        event: 'sign_balance_proof',
        channelId: params.channelId,
        nonce: params.nonce,
        chainId: this.chainId,
      },
      'Signing Solana balance proof'
    );

    this._warnIfEVMFields(params);

    const signatureBytes = await SolanaPaymentChannelSDK.signBalanceProof(
      params.channelId,
      BigInt(params.nonce),
      safeBigInt(params.transferredAmount, 'transferredAmount'),
      this._signer.keyPair
    );

    return Buffer.from(signatureBytes).toString('base64');
  }

  /**
   * Verify an off-chain Ed25519 balance proof signature.
   *
   * Reconstructs the 48-byte balance proof message, decodes the signer's
   * base58 public key, and verifies the signature using Node.js `crypto.subtle`.
   *
   * @param params - Parameters including the signature and signer address to verify
   * @returns `true` if the signature is valid, `false` otherwise
   */
  async verifyBalanceProof(params: VerifyBalanceProofParams): Promise<boolean> {
    this._logger.debug(
      {
        event: 'verify_balance_proof',
        channelId: params.channelId,
        nonce: params.nonce,
        signerAddress: params.signerAddress,
        chainId: this.chainId,
      },
      'Verifying Solana balance proof'
    );

    this._warnIfEVMFields(params);

    try {
      // 1. Reconstruct the 48-byte balance proof message
      const message = SolanaPaymentChannelSDK._buildBalanceProofMessage(
        params.channelId,
        BigInt(params.nonce),
        safeBigInt(params.transferredAmount, 'transferredAmount')
      );

      // 2. Decode the base64 signature
      const signatureBytes = new Uint8Array(Buffer.from(params.signature, 'base64'));

      // 3. Decode the base58 signer address to 32-byte public key
      const encoder = getAddressEncoder();
      const pubkeyBytes = new Uint8Array(encoder.encode(address(params.signerAddress)));

      // 4. Import the public key and verify using Node.js crypto.subtle
      const publicKey = await crypto.subtle.importKey('raw', pubkeyBytes, 'Ed25519', true, [
        'verify',
      ]);

      return await crypto.subtle.verify('Ed25519', publicKey, signatureBytes, message);
    } catch {
      // Any verification error (bad encoding, invalid key, etc.) returns false
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // State Query and Event Subscription
  // -------------------------------------------------------------------------

  /**
   * Query the current on-chain state of a channel.
   *
   * Delegates to the SDK and translates `SolanaChannelState` to the
   * chain-agnostic `ProviderChannelState`.
   *
   * @param channelId - Channel PDA to query
   * @returns Chain-agnostic channel state
   */
  async getChannelState(channelId: string): Promise<ProviderChannelState> {
    try {
      const state = await this._sdk.getChannelState(channelId);
      return this._toProviderChannelState(channelId, state);
    } catch (err: unknown) {
      throw this._wrapError(err, 'getChannelState', channelId);
    }
  }

  /**
   * Subscribe to on-chain events for a specific channel.
   *
   * Wraps `SolanaPaymentChannelSDK.subscribeToChannel()` and diffs previous
   * and current state to determine the event type. Emits `ProviderEvent`
   * compatible with the settlement monitor.
   *
   * @param channelId - Channel PDA to watch
   * @param callback - Function invoked when an event occurs
   * @returns Subscription handle with an `unsubscribe()` method
   */
  subscribeToEvents(channelId: string, callback: ProviderEventCallback): ProviderEventSubscription {
    this._logger.debug(
      { event: 'subscribe_events', channelId, chainId: this.chainId },
      'Subscribing to Solana channel events'
    );

    let previousState: SolanaChannelState | undefined;
    let unsubscribed = false;

    const subscription = this._sdk.subscribeToChannel(
      channelId,
      (currentState: SolanaChannelState): void => {
        if (unsubscribed) return;

        const eventType = this._diffState(previousState, currentState);
        previousState = currentState;

        if (eventType) {
          const event: ProviderEvent = {
            type: eventType,
            channelId,
            data: {
              state: currentState.state,
              depositA: currentState.depositA.toString(),
              depositB: currentState.depositB.toString(),
              transferredAmountA: currentState.transferredAmountA.toString(),
              transferredAmountB: currentState.transferredAmountB.toString(),
            },
          };
          callback(event);
        }
      }
    );

    return {
      unsubscribe: (): void => {
        unsubscribed = true;
        subscription.unsubscribe();
        this._logger.debug(
          { event: 'unsubscribe_events', channelId, chainId: this.chainId },
          'Unsubscribed from Solana channel events'
        );
      },
    };
  }

  // -------------------------------------------------------------------------
  // Solana-Specific Public Methods
  // -------------------------------------------------------------------------

  /**
   * Get Solana-specific context for claim message construction.
   *
   * This method is NOT part of the `PaymentChannelProvider` interface -- it is a
   * Solana-specific concrete method. Callers should use `instanceof SolanaPaymentChannelProvider`
   * to narrow the type before calling.
   *
   * @returns Solana context with programId, tokenMint, cluster, and signerAddress
   */
  getSolanaContext(): {
    programId: string;
    tokenMint: string;
    cluster: string;
    signerAddress: string;
  } {
    // Extract cluster from chainId (e.g., 'solana:devnet' -> 'devnet')
    const cluster = this.chainId.split(':')[1] ?? 'devnet';
    return {
      programId: this._programId,
      tokenMint: this._tokenMint,
      cluster,
      signerAddress: this._signer.address as string,
    };
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  /**
   * Derive an associated token account address for a given owner.
   *
   * @param owner - Base58 wallet address
   * @returns Base58 ATA address string
   */
  private async _deriveATA(owner: string): Promise<string> {
    const [ata] = await findAssociatedTokenPda({
      owner: address(owner),
      mint: address(this._tokenMint),
      tokenProgram: address(TOKEN_PROGRAM),
    });
    return ata as string;
  }

  /**
   * Map `SolanaChannelState` to chain-agnostic `ProviderChannelState`.
   */
  private _toProviderChannelState(pda: string, state: SolanaChannelState): ProviderChannelState {
    return {
      channelId: pda,
      status: state.state,
      participants: [state.participantA, state.participantB],
      deposit: state.depositA + state.depositB,
    };
  }

  /**
   * Diff previous and current `SolanaChannelState` to determine the event type.
   *
   * @returns The event type, or `undefined` if this is the initial state (no previous)
   */
  private _diffState(
    previous: SolanaChannelState | undefined,
    current: SolanaChannelState
  ): ProviderEventType | undefined {
    // First callback: no diff possible, store state silently
    if (!previous) {
      return undefined;
    }

    // Check state transitions first (most significant)
    if (previous.state !== 'settled' && current.state === 'settled') {
      return 'channel_settled';
    }
    if (previous.state !== 'closed' && current.state === 'closed') {
      return 'channel_closed';
    }

    // Check transferred amounts (claims)
    if (
      current.transferredAmountA > previous.transferredAmountA ||
      current.transferredAmountB > previous.transferredAmountB
    ) {
      return 'channel_claimed';
    }

    // Check deposits
    if (current.depositA > previous.depositA || current.depositB > previous.depositB) {
      return 'channel_deposited';
    }

    return undefined;
  }

  /**
   * Wrap SDK errors with provider context.
   * Catches `SolanaChannelError` and wraps with chain/channel info.
   */
  private _wrapError(err: unknown, method: string, channelId: string): Error {
    if (err instanceof SolanaChannelError) {
      return new Error(
        `SolanaPaymentChannelProvider [${this.chainId}] ${method} channel ${channelId}: ` +
          `${err.errorName} (code ${err.code}): ${err.message}`,
        { cause: err }
      );
    }
    if (err instanceof Error) {
      return err;
    }
    return new Error(String(err));
  }

  /**
   * Log warnings for EVM-specific fields that Solana ignores.
   */
  private _warnIfEVMFields(params: Pick<BalanceProofParams, 'lockedAmount' | 'locksRoot'>): void {
    if (params.lockedAmount && params.lockedAmount !== '0') {
      this._logger.warn(
        {
          event: 'ignored_field',
          field: 'lockedAmount',
          value: params.lockedAmount,
          chainId: this.chainId,
        },
        'lockedAmount is not supported on Solana channels and will be ignored'
      );
    }
    if (params.locksRoot && params.locksRoot !== '' && params.locksRoot !== '0x') {
      this._logger.warn(
        {
          event: 'ignored_field',
          field: 'locksRoot',
          value: params.locksRoot,
          chainId: this.chainId,
        },
        'locksRoot is not supported on Solana channels and will be ignored'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Factory Function
// ---------------------------------------------------------------------------

/**
 * Create a `ChainProviderFactory` for Solana providers.
 *
 * The returned factory validates that the incoming config has `chainType === 'solana'`
 * and constructs a `SolanaPaymentChannelProvider`. The `signer` and `tokenMint` are
 * provided as closure parameters since `SolanaProviderConfig` does not include them.
 *
 * @param logger - Logger instance
 * @param signer - Pre-built Ed25519 keypair signer (key management deferred to 33.8)
 * @param tokenMint - SPL token mint address (base58)
 * @returns A factory function compatible with `ChainProviderRegistry.fromConfig()`
 */
export function createSolanaProviderFactory(
  logger: Logger,
  signer: KeyPairSigner,
  tokenMint: string
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
    return new SolanaPaymentChannelProvider(
      sdk,
      chainId,
      tokenMint,
      signer,
      config.programId,
      logger
    );
  };
}
