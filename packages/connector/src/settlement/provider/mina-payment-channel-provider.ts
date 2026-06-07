/**
 * Mina Payment Channel Provider
 *
 * Implements the chain-agnostic `PaymentChannelProvider` interface by delegating
 * to `MinaPaymentChannelSDK`. All Mina-specific parameter adaptation
 * (Poseidon commitments, zk-SNARK proof verification, state translation,
 * polling-based event subscription) is handled here.
 *
 * Epic 34 Story 34.5: Implement MinaPaymentChannelProvider
 *
 * @module mina-payment-channel-provider
 */

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
import { MinaPaymentChannelSDK, MinaChannelError } from '../mina-payment-channel-sdk';
import type { MinaChannelState } from '../mina-payment-channel-sdk';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Mina channel state enum values from the zkApp contract */
const MINA_CHANNEL_STATE = {
  UNINITIALIZED: 0,
  OPEN: 1,
  CLOSING: 2,
  SETTLED: 3,
} as const;

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
// Options for optional constructor parameters
// ---------------------------------------------------------------------------

/** Optional parameters for MinaPaymentChannelProvider construction. */
export interface MinaProviderOptions {
  /** Mina token ID (native MINA or custom fungible token) */
  tokenId?: string;
  /** Mina network name (e.g., 'devnet', 'mainnet') -- overrides chainId extraction */
  network?: string;
}

// ---------------------------------------------------------------------------
// Mina Payment Channel Provider
// ---------------------------------------------------------------------------

/**
 * Mina-specific implementation of the `PaymentChannelProvider` interface.
 *
 * Composes a `MinaPaymentChannelSDK` instance via delegation (not inheritance).
 * Each method adapts provider-level parameters (string amounts, generic balance proofs)
 * to SDK-level parameters (bigint amounts, Poseidon commitments, zk-SNARK proofs).
 *
 * @remarks
 * - Uses Poseidon commitments (not EIP-712 or Ed25519)
 * - Channel IDs are zkApp addresses (base58-encoded public keys)
 * - Event subscription uses interval-based polling with state-diffing
 * - Proof generation (30-120s) runs asynchronously without blocking the event loop
 * - zkApp circuit is pre-compiled during construction
 */
export class MinaPaymentChannelProvider implements PaymentChannelProvider {
  /** @inheritdoc */
  readonly chainType: BlockchainType = 'mina';

  /** @inheritdoc */
  readonly chainId: string;

  /** Resolved token ID */
  private readonly _tokenId: string;

  /** Resolved network name */
  private readonly _network: string;

  /** Cached signer public key (derived from private key, populated lazily) */
  private _signerPublicKey: string | null = null;

  /**
   * Create a new MinaPaymentChannelProvider.
   *
   * @param _sdk - The underlying MinaPaymentChannelSDK instance
   * @param chainId - Namespaced chain identifier (e.g., `'mina:devnet'`)
   * @param _zkAppAddress - zkApp address for the payment channel contract (base58)
   * @param signerKey - Private key or key identifier for signing operations (validated, not stored)
   * @param _logger - Logger instance for diagnostic output
   * @param options - Optional parameters (tokenId, network)
   */
  constructor(
    private readonly _sdk: MinaPaymentChannelSDK,
    chainId: string,
    private readonly _zkAppAddress: string,
    signerKey: string,
    private readonly _logger: Logger,
    options?: MinaProviderOptions
  ) {
    if (!chainId) {
      throw new Error('MinaPaymentChannelProvider: chainId must not be empty');
    }
    if (!_zkAppAddress) {
      throw new Error('MinaPaymentChannelProvider: zkAppAddress must not be empty');
    }
    if (!signerKey) {
      throw new Error('MinaPaymentChannelProvider: signerKey must not be empty');
    }
    this.chainId = chainId;
    this._tokenId = options?.tokenId ?? 'MINA';
    this._network = options?.network ?? chainId.split(':')[1] ?? 'devnet';

    // Pre-compile the zkApp circuit during construction.
    // Fire-and-forget: compilation runs in the background.
    // Errors are logged but do not prevent construction.
    void this._preCompile();
  }

  // -------------------------------------------------------------------------
  // Pre-compilation
  // -------------------------------------------------------------------------

  /**
   * Pre-compile the zkApp proof circuit.
   * Called during construction to avoid compilation delay on first claim.
   */
  private async _preCompile(): Promise<void> {
    try {
      await this._sdk.compileContract();
      this._logger.info(
        { event: 'zkapp_compiled', chainId: this.chainId, zkAppAddress: this._zkAppAddress },
        'Mina zkApp circuit pre-compiled successfully'
      );
    } catch (err: unknown) {
      this._logger.error(
        {
          event: 'zkapp_compile_error',
          chainId: this.chainId,
          zkAppAddress: this._zkAppAddress,
          error: err instanceof Error ? err.message : String(err),
        },
        'Failed to pre-compile Mina zkApp circuit'
      );
    }
  }

  // -------------------------------------------------------------------------
  // Channel Lifecycle Methods
  // -------------------------------------------------------------------------

  /**
   * Open a new payment channel between two participants.
   *
   * Delegates to `MinaPaymentChannelSDK.openChannel()` with the signer as
   * participantA and the given participant as participantB.
   *
   * @param participant - Base58 address of the counterparty
   * @param settlementTimeout - Challenge duration in slots
   * @returns Channel identifier (zkApp address) and transaction hash
   */
  async openChannel(participant: string, settlementTimeout: number): Promise<OpenChannelResult> {
    this._logger.info(
      { event: 'open_channel', participant, settlementTimeout, chainId: this.chainId },
      'Opening Mina payment channel'
    );

    try {
      // Derive the signer's public key from the private key via the SDK.
      // The provider must NOT pass the raw private key as participantA.
      const signerPublicKey = await this._ensureSignerPublicKey();
      const result = await this._sdk.openChannel(
        signerPublicKey,
        participant,
        settlementTimeout,
        this._tokenId
      );

      return { channelId: result.zkAppAddress, txHash: result.txHash };
    } catch (err: unknown) {
      throw this._wrapError(err, 'openChannel', 'new');
    }
  }

  /**
   * Deposit funds into an existing channel.
   *
   * Converts the string amount to bigint and delegates to the SDK.
   *
   * @param channelId - zkApp address (base58)
   * @param amount - Amount to deposit (string for bigint precision)
   * @returns Transaction hash
   */
  async deposit(channelId: string, amount: string): Promise<TxResult> {
    this._logger.info(
      { event: 'deposit', channelId, amount, chainId: this.chainId },
      'Depositing into Mina payment channel'
    );

    try {
      const result = await this._sdk.deposit(channelId, safeBigInt(amount, 'deposit amount'));
      return { txHash: result.txHash };
    } catch (err: unknown) {
      throw this._wrapError(err, 'deposit', channelId);
    }
  }

  /**
   * Submit a balance proof to claim funds from a channel.
   *
   * Extracts nonce and transferredAmount from the balance proof, delegates to
   * the SDK for zk-SNARK proof generation and on-chain claim submission.
   * Proof generation runs asynchronously without blocking the event loop.
   *
   * @remarks
   * Dual-party authorization is threaded through to the SDK: `signature` is
   * participant A's signature, `balanceProof.signatureB` is participant B's,
   * and `balanceProof.balanceB` / `balanceProof.salt` populate the Poseidon
   * balance commitment. For bidirectional settlement (e.g. Mill swaps) callers
   * MUST supply a distinct `signatureB`, a real `balanceB`, and a non-zero
   * `salt`. When `signatureB` is omitted the provider falls back to a
   * single-signature (unidirectional) claim and logs a warning — a true
   * two-party claim with two participant keys rejects a duplicated signature
   * on-chain.
   *
   * @param channelId - zkApp address (base58)
   * @param balanceProof - The balance proof parameters (including Mina-only
   *   `balanceB`, `salt`, and `signatureB` for dual-party authorization)
   * @param signature - Participant A's serialized signature
   * @returns Transaction hash
   */
  async claimFromChannel(
    channelId: string,
    balanceProof: BalanceProofParams,
    signature: string
  ): Promise<TxResult> {
    this._logger.info(
      { event: 'claim_from_channel', channelId, nonce: balanceProof.nonce, chainId: this.chainId },
      'Claiming from Mina payment channel'
    );

    this._warnIfEVMFields(balanceProof);

    try {
      // `transferredAmount` is participant A's balance; `balanceB` / `salt`
      // complete the Poseidon balance commitment for the bidirectional case.
      const balanceA = safeBigInt(balanceProof.transferredAmount, 'transferredAmount');
      const balanceB =
        balanceProof.balanceB !== undefined ? safeBigInt(balanceProof.balanceB, 'balanceB') : 0n;
      const salt = balanceProof.salt !== undefined ? safeBigInt(balanceProof.salt, 'salt') : 0n;
      const nonce = safeBigInt(String(balanceProof.nonce), 'nonce');

      // Dual-party authorization: `signature` is participant A's signature.
      // For bidirectional settlement the caller must supply participant B's
      // signature via `balanceProof.signatureB`. If omitted we fall back to a
      // single-signature unidirectional claim and warn — a real two-party
      // claim with two distinct participant keys rejects a duplicated signature.
      const signatureA = signature;
      const signatureB = balanceProof.signatureB;
      if (signatureB === undefined) {
        this._logger.warn(
          { event: 'claim_from_channel_single_signature', channelId, chainId: this.chainId },
          'No participant B signature provided (balanceProof.signatureB); falling back to a ' +
            'single-signature unidirectional claim. Supply signatureB for bidirectional settlement.'
        );
      }

      // Resolve participant pubkeys for channels not opened by this SDK instance
      // (inbound/externally-opened, Issue #114, Bug A). The two participants are
      // this connector's own signer and the claim's counterparty
      // (`balanceProof.signerPublicKey`). The SDK assigns A/B by matching the
      // on-chain channelHash. When the counterparty pubkey is unavailable we omit
      // the override and let the SDK fall back to its participant cache.
      const counterpartyPublicKey = balanceProof.signerPublicKey;
      let participantKeys: { participant1: string; participant2: string } | undefined;
      if (counterpartyPublicKey) {
        const ownPublicKey = await this._ensureSignerPublicKey();
        participantKeys = { participant1: ownPublicKey, participant2: counterpartyPublicKey };
      }

      const result = await this._sdk.claimFromChannel(
        channelId,
        balanceA,
        balanceB,
        salt,
        nonce,
        signatureA,
        signatureB ?? signatureA,
        participantKeys
      );

      return { txHash: result.txHash };
    } catch (err: unknown) {
      throw this._wrapError(err, 'claimFromChannel', channelId);
    }
  }

  /**
   * Initiate channel closure with final balances.
   *
   * @param channelId - zkApp address to close
   * @param finalBalanceA - Final balance for participant A (optional, defaults to 0n)
   * @param finalBalanceB - Final balance for participant B (optional, defaults to 0n)
   * @param salt - Salt for balance commitment (optional, defaults to 0n)
   * @param nonce - Close nonce (optional, defaults to 0n)
   * @param signatureA - Signature from participant A (optional)
   * @param signatureB - Signature from participant B (optional)
   * @returns Transaction hash
   */
  async closeChannel(
    channelId: string,
    finalBalanceA?: bigint,
    finalBalanceB?: bigint,
    salt?: bigint,
    nonce?: bigint,
    signatureA?: string,
    signatureB?: string
  ): Promise<TxResult> {
    this._logger.info(
      { event: 'close_channel', channelId, chainId: this.chainId },
      'Closing Mina payment channel'
    );

    try {
      const result = await this._sdk.closeChannel(
        channelId,
        finalBalanceA ?? 0n,
        finalBalanceB ?? 0n,
        salt ?? 0n,
        nonce ?? 0n,
        signatureA ?? '{"r":"0","s":"0"}',
        signatureB ?? '{"r":"0","s":"0"}'
      );
      return { txHash: result.txHash };
    } catch (err: unknown) {
      throw this._wrapError(err, 'closeChannel', channelId);
    }
  }

  /**
   * Settle a closed channel after the challenge period expires.
   *
   * @param channelId - zkApp address to settle
   * @param balanceA - Revealed balance for participant A (optional, defaults to 0n)
   * @param balanceB - Revealed balance for participant B (optional, defaults to 0n)
   * @param salt - Salt used in the balance commitment (optional, defaults to 0n)
   * @param participantA - Base58 public key of participant A (optional)
   * @param participantB - Base58 public key of participant B (optional)
   * @param nonce - Channel nonce (optional, defaults to 0n)
   * @returns Transaction hash
   */
  async settleChannel(
    channelId: string,
    balanceA?: bigint,
    balanceB?: bigint,
    salt?: bigint,
    participantA?: string,
    participantB?: string,
    nonce?: bigint
  ): Promise<TxResult> {
    this._logger.info(
      { event: 'settle_channel', channelId, chainId: this.chainId },
      'Settling Mina payment channel'
    );

    try {
      const result = await this._sdk.settleChannel(
        channelId,
        balanceA ?? 0n,
        balanceB ?? 0n,
        salt ?? 0n,
        participantA ?? '',
        participantB ?? '',
        nonce ?? 0n
      );
      return { txHash: result.txHash };
    } catch (err: unknown) {
      throw this._wrapError(err, 'settleChannel', channelId);
    }
  }

  // -------------------------------------------------------------------------
  // Balance Proof Methods
  // -------------------------------------------------------------------------

  /**
   * Sign a balance proof off-chain using Poseidon commitment.
   *
   * Delegates to `MinaPaymentChannelSDK.signBalanceProof()` for Poseidon
   * commitment generation. Returns the serialized proof/commitment as a string.
   *
   * @remarks
   * `params.balanceB` and `params.salt` are threaded through to the SDK to
   * build the Poseidon commitment `hash([balanceA, balanceB, salt])`, where
   * `params.transferredAmount` is participant A's balance. They default to
   * `0n` (unidirectional, unsalted) when omitted; provide real values for
   * bidirectional settlement and commitment privacy.
   *
   * @param params - Balance proof parameters to sign (including Mina-only
   *   `balanceB` and `salt`)
   * @returns Serialized Poseidon commitment + proof string
   */
  async signBalanceProof(params: BalanceProofParams): Promise<string> {
    this._logger.debug(
      {
        event: 'sign_balance_proof',
        channelId: params.channelId,
        nonce: params.nonce,
        chainId: this.chainId,
      },
      'Signing Mina balance proof'
    );

    this._warnIfEVMFields(params);

    try {
      const balanceA = safeBigInt(params.transferredAmount, 'transferredAmount');
      const balanceB = params.balanceB !== undefined ? safeBigInt(params.balanceB, 'balanceB') : 0n;
      const salt = params.salt !== undefined ? safeBigInt(params.salt, 'salt') : 0n;
      const nonce = safeBigInt(String(params.nonce), 'nonce');
      return await this._sdk.signBalanceProof(params.channelId, balanceA, balanceB, salt, nonce);
    } catch (err: unknown) {
      throw this._wrapError(err, 'signBalanceProof', params.channelId);
    }
  }

  /**
   * Verify an off-chain balance proof / zk-SNARK proof.
   *
   * Delegates to `MinaPaymentChannelSDK.verifyBalanceProof()` for proof
   * verification and commitment consistency checking.
   *
   * @remarks
   * Parameter mapping from the EVM-centric `VerifyBalanceProofParams` to Mina SDK
   * (Story 34.4 finalization, Issue #98):
   * - The SDK's `balanceCommitment` argument is the channel's actual on-chain Poseidon
   *   commitment, read here via `getChannelState`. Mina uses Poseidon commitments, not
   *   signer-based verification, so `params.signerAddress` (the zkApp address) must NOT be
   *   passed -- doing so deterministically fails the commitment check because the proof's
   *   real Poseidon commitment can never equal the zkApp address string.
   * - `params.signature` is passed as the `proof` (serialized zk-SNARK proof)
   * - `params.transferredAmount` is NOT passed to the SDK (the Poseidon commitment encodes
   *   balances internally; the SDK verifies the proof's commitment against the on-chain one)
   *
   * @param params - Parameters including the signature/proof to verify
   * @returns `true` if the proof is valid, `false` otherwise
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
      'Verifying Mina balance proof'
    );

    this._warnIfEVMFields(params);

    try {
      // Read the channel's actual on-chain Poseidon balance commitment so the SDK can
      // compare the proof's commitment against it (Story 34.4 / Issue #98). Passing the
      // zkApp address (params.signerAddress) here would always fail the commitment check.
      const onChainState = await this._sdk.getChannelState(params.channelId);
      const nonce = safeBigInt(String(params.nonce), 'nonce');
      return await this._sdk.verifyBalanceProof(
        params.channelId,
        onChainState.balanceCommitment,
        params.signature,
        nonce,
        // Bind verification to the on-chain channelHash (Issue #114, Bug B). The
        // SDK still accepts the legacy message format as a transitional fallback.
        onChainState.channelHash
      );
    } catch (err: unknown) {
      // Verification errors return false but are logged for diagnostics.
      // This avoids masking programming errors (TypeError, RangeError) silently.
      this._logger.warn(
        {
          event: 'verify_balance_proof_error',
          channelId: params.channelId,
          nonce: params.nonce,
          chainId: this.chainId,
          error: err instanceof Error ? err.message : String(err),
        },
        'Balance proof verification failed with error'
      );
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // State Query and Event Subscription
  // -------------------------------------------------------------------------

  /**
   * Query the current on-chain state of a channel.
   *
   * Delegates to the SDK and translates `MinaChannelState` to the
   * chain-agnostic `ProviderChannelState`.
   *
   * @param channelId - zkApp address to query
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
   * Uses polling-based state monitoring via `MinaPaymentChannelSDK.subscribeToChannel()`.
   * Diffs previous and current state to determine the event type. Emits `ProviderEvent`
   * compatible with the settlement monitor.
   *
   * @param channelId - zkApp address to watch
   * @param callback - Function invoked when an event occurs
   * @returns Subscription handle with an `unsubscribe()` method
   */
  subscribeToEvents(channelId: string, callback: ProviderEventCallback): ProviderEventSubscription {
    this._logger.debug(
      { event: 'subscribe_events', channelId, chainId: this.chainId },
      'Subscribing to Mina channel events'
    );

    let previousState: MinaChannelState | undefined;
    let unsubscribed = false;

    const subscription = this._sdk.subscribeToChannel(
      channelId,
      (currentState: MinaChannelState): void => {
        if (unsubscribed) return;

        const eventType = this._diffState(previousState, currentState);
        previousState = currentState;

        if (eventType) {
          const event: ProviderEvent = {
            type: eventType,
            channelId,
            data: {
              channelState: currentState.channelState,
              depositTotal: currentState.depositTotal.toString(),
              nonceField: currentState.nonceField.toString(),
              balanceCommitment: currentState.balanceCommitment,
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
          'Unsubscribed from Mina channel events'
        );
      },
    };
  }

  // -------------------------------------------------------------------------
  // Mina-Specific Public Methods
  // -------------------------------------------------------------------------

  /**
   * Get Mina-specific context for claim message construction.
   *
   * This method is NOT part of the `PaymentChannelProvider` interface -- it is a
   * Mina-specific concrete method. Callers should use `instanceof MinaPaymentChannelProvider`
   * to narrow the type before calling.
   *
   * @remarks
   * `signerAddress` returns the zkApp address as a safe public identifier.
   * The actual private signing key is never exposed through this method.
   * When Story 34.4 finalizes the SDK, the SDK should provide a method to
   * derive the public key from the signer key and this should return that instead.
   *
   * @returns Mina context with zkAppAddress, tokenId, network, and signerAddress
   */
  async getMinaContext(): Promise<{
    zkAppAddress: string;
    tokenId: string;
    network: string;
    signerAddress: string;
  }> {
    // Derive the signer's public key from the private key via the SDK.
    // SECURITY: The signer private key is stored in the SDK, not this provider.
    const signerPublicKey = await this._ensureSignerPublicKey();
    return {
      zkAppAddress: this._zkAppAddress,
      tokenId: this._tokenId,
      network: this._network,
      signerAddress: signerPublicKey,
    };
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  /**
   * Lazily derive and cache the signer's public key from the private key.
   * Uses the SDK's `getSignerPublicKey()` method which calls o1js internally.
   */
  private async _ensureSignerPublicKey(): Promise<string> {
    if (!this._signerPublicKey) {
      this._signerPublicKey = await this._sdk.getSignerPublicKey();
    }
    return this._signerPublicKey;
  }

  /**
   * Map `MinaChannelState` to chain-agnostic `ProviderChannelState`.
   *
   * Translates Mina channel state enum values to the provider status string:
   * - 1 (OPEN) -> 'opened'
   * - 2 (CLOSING) -> 'closed'
   * - 3 (SETTLED) -> 'settled'
   */
  private _toProviderChannelState(
    channelId: string,
    state: MinaChannelState
  ): ProviderChannelState {
    let status: 'opened' | 'closed' | 'settled';

    switch (state.channelState) {
      case MINA_CHANNEL_STATE.OPEN:
        status = 'opened';
        break;
      case MINA_CHANNEL_STATE.CLOSING:
        status = 'closed';
        break;
      case MINA_CHANNEL_STATE.SETTLED:
        status = 'settled';
        break;
      default:
        // UNINITIALIZED or unknown -- default to opened with warning.
        // Per spec, UNINITIALIZED means the channel doesn't exist yet, but the
        // ProviderChannelState type doesn't have an 'uninitialized' status.
        this._logger.warn(
          {
            event: 'unexpected_channel_state',
            channelId,
            channelState: state.channelState,
            chainId: this.chainId,
          },
          `Unexpected Mina channel state ${state.channelState}, defaulting to 'opened'`
        );
        status = 'opened';
        break;
    }

    return {
      channelId,
      status,
      participants: [state.participantA, state.participantB],
      deposit: state.depositTotal,
    };
  }

  /**
   * Diff previous and current `MinaChannelState` to determine the event type.
   *
   * @returns The event type, or `undefined` if this is the initial state (no previous)
   */
  private _diffState(
    previous: MinaChannelState | undefined,
    current: MinaChannelState
  ): ProviderEventType | undefined {
    // First callback: no diff possible, store state silently
    if (!previous) {
      return undefined;
    }

    // Check state transitions first (most significant)
    if (
      previous.channelState !== MINA_CHANNEL_STATE.SETTLED &&
      current.channelState === MINA_CHANNEL_STATE.SETTLED
    ) {
      return 'channel_settled';
    }
    if (
      previous.channelState !== MINA_CHANNEL_STATE.CLOSING &&
      current.channelState === MINA_CHANNEL_STATE.CLOSING
    ) {
      return 'channel_closed';
    }
    if (
      previous.channelState === MINA_CHANNEL_STATE.UNINITIALIZED &&
      current.channelState === MINA_CHANNEL_STATE.OPEN
    ) {
      return 'channel_opened';
    }

    // Warn on unexpected value decreases (possible reorg or data inconsistency)
    if (current.nonceField < previous.nonceField) {
      this._logger.warn(
        {
          event: 'state_rollback_detected',
          field: 'nonceField',
          previous: previous.nonceField.toString(),
          current: current.nonceField.toString(),
          chainId: this.chainId,
        },
        'Nonce decreased between polls -- possible chain reorg'
      );
    }
    if (current.depositTotal < previous.depositTotal) {
      this._logger.warn(
        {
          event: 'state_rollback_detected',
          field: 'depositTotal',
          previous: previous.depositTotal.toString(),
          current: current.depositTotal.toString(),
          chainId: this.chainId,
        },
        'Deposit decreased between polls -- possible chain reorg'
      );
    }

    // Check nonce increase (claims)
    if (current.nonceField > previous.nonceField) {
      return 'channel_claimed';
    }

    // Check deposit increase
    if (current.depositTotal > previous.depositTotal) {
      return 'channel_deposited';
    }

    return undefined;
  }

  /**
   * Wrap SDK errors with provider context.
   * Preserves the original error as `cause`.
   */
  private _wrapError(err: unknown, method: string, channelId: string): Error {
    if (err instanceof MinaChannelError) {
      return new Error(
        `MinaPaymentChannelProvider [${this.chainId}] ${method} channel ${channelId}: ` +
          `${err.errorName} (code ${err.code}): ${err.message}`,
        { cause: err }
      );
    }
    if (err instanceof Error) {
      return new Error(
        `MinaPaymentChannelProvider [${this.chainId}] ${method} channel ${channelId}: ${err.message}`,
        { cause: err }
      );
    }
    return new Error(
      `MinaPaymentChannelProvider [${this.chainId}] ${method} channel ${channelId}: ${String(err)}`,
      { cause: err }
    );
  }

  /**
   * Log warnings for EVM-specific fields that Mina ignores.
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
        'lockedAmount is not supported on Mina channels and will be ignored'
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
        'locksRoot is not supported on Mina channels and will be ignored'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Factory Function
// ---------------------------------------------------------------------------

/**
 * Create a `ChainProviderFactory` for Mina providers.
 *
 * The returned factory validates that the incoming config has `chainType === 'mina'`
 * and constructs a `MinaPaymentChannelProvider`. The `signerKey` is provided as a
 * closure parameter (key management is external).
 *
 * @param logger - Logger instance
 * @param signerKey - Mina private key or key identifier for signing operations
 * @returns A factory function compatible with `ChainProviderRegistry.fromConfig()`
 */
export function createMinaProviderFactory(logger: Logger, signerKey: string): ChainProviderFactory {
  if (!signerKey) {
    throw new Error('createMinaProviderFactory: signerKey must not be empty');
  }
  return (config: ProviderConfig): PaymentChannelProvider => {
    if (config.chainType !== 'mina') {
      throw new Error(`Mina factory received non-Mina config: ${config.chainType}`);
    }
    const sdk = new MinaPaymentChannelSDK(
      config.graphqlUrl,
      config.zkAppAddress,
      logger,
      signerKey
    );
    const network = config.network ?? 'devnet';
    const chainId = `mina:${network}`;
    return new MinaPaymentChannelProvider(sdk, chainId, config.zkAppAddress, signerKey, logger, {
      tokenId: config.tokenId,
      network,
    });
  };
}
