/**
 * EVM Payment Channel Provider
 *
 * Implements the chain-agnostic `PaymentChannelProvider` interface by delegating
 * to the existing `PaymentChannelSDK`. All EVM-specific parameter adaptation
 * (token addresses, bigint conversions, event mapping) is handled here.
 *
 * Epic 32 Story 32.3: Migrate EVM Settlement to EVMPaymentChannelProvider
 *
 * @module evm-payment-channel-provider
 */

import type { ChannelState } from '@toon-protocol/shared';
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
import type { PaymentChannelSDK } from '../payment-channel-sdk';

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
    // Truncate the echoed value to avoid information disclosure in error messages
    const sanitized = value.length > 32 ? `${value.slice(0, 32)}...` : value;
    throw new Error(`Invalid ${fieldName}: expected a numeric string, received "${sanitized}"`);
  }
}

// ---------------------------------------------------------------------------
// EVM Payment Channel Provider
// ---------------------------------------------------------------------------

/**
 * EVM-specific implementation of the `PaymentChannelProvider` interface.
 *
 * Composes a `PaymentChannelSDK` instance via delegation (not inheritance).
 * Each method adapts provider-level parameters (string amounts, no token address)
 * to SDK-level parameters (bigint amounts, explicit token address).
 */
export class EVMPaymentChannelProvider implements PaymentChannelProvider {
  /** @inheritdoc */
  readonly chainType: BlockchainType = 'evm';

  /** @inheritdoc */
  readonly chainId: string;

  /**
   * Create a new EVMPaymentChannelProvider.
   *
   * @param sdk - The underlying EVM PaymentChannelSDK instance
   * @param chainId - Namespaced chain identifier (e.g., `'evm:8453'`)
   * @param tokenAddress - ERC20 token address for all channel operations
   * @param logger - Logger instance for diagnostic output
   */
  constructor(
    private readonly _sdk: PaymentChannelSDK,
    chainId: string,
    private readonly _tokenAddress: string,
    private readonly _logger: Logger
  ) {
    if (!chainId) {
      throw new Error('EVMPaymentChannelProvider: chainId must not be empty');
    }
    if (!_tokenAddress) {
      throw new Error('EVMPaymentChannelProvider: tokenAddress must not be empty');
    }
    this.chainId = chainId;
  }

  /**
   * Open a new payment channel between two participants.
   *
   * Delegates to `PaymentChannelSDK.openChannel()` with the configured
   * `tokenAddress` and zero initial deposit.
   *
   * @param participant - Address of the counterparty
   * @param settlementTimeout - Timeout period in seconds
   * @returns Channel identifier and transaction hash
   */
  async openChannel(participant: string, settlementTimeout: number): Promise<OpenChannelResult> {
    this._logger.info('EVMPaymentChannelProvider: opening channel', {
      participant,
      settlementTimeout,
      chainId: this.chainId,
    });

    const result = await this._sdk.openChannel(
      participant,
      this._tokenAddress,
      settlementTimeout,
      0n
    );

    return { channelId: result.channelId, txHash: result.txHash };
  }

  /**
   * Deposit funds into an existing channel.
   *
   * Converts the string `amount` to `bigint` and delegates to the SDK.
   *
   * @param channelId - Target channel identifier
   * @param amount - Amount to deposit (string for bigint precision)
   * @returns Transaction hash (placeholder — SDK returns void)
   */
  async deposit(channelId: string, amount: string): Promise<TxResult> {
    this._logger.info('EVMPaymentChannelProvider: depositing', {
      channelId,
      amount,
      chainId: this.chainId,
    });

    await this._sdk.deposit(channelId, this._tokenAddress, safeBigInt(amount, 'deposit amount'));

    // PaymentChannelSDK methods return void — transaction hash is not yet
    // propagated from the underlying ethers.js ContractTransactionResponse.
    // Tracked as tech debt: SDK should return tx receipt with hash.
    return { txHash: '' };
  }

  /**
   * Submit a balance proof to claim funds from a channel.
   *
   * Converts `BalanceProofParams` (string amounts) to `BalanceProof` (bigint amounts)
   * and delegates to the SDK.
   *
   * @param channelId - Target channel identifier
   * @param balanceProof - The balance proof parameters
   * @param signature - Signed balance proof
   * @returns Transaction hash (placeholder — SDK returns void)
   */
  async claimFromChannel(
    channelId: string,
    balanceProof: BalanceProofParams,
    signature: string
  ): Promise<TxResult> {
    this._logger.info('EVMPaymentChannelProvider: redeeming via updateBalance', {
      channelId,
      nonce: balanceProof.nonce,
      chainId: this.chainId,
    });

    // v2 redeem (connector#329 Phase 4b): submit the cumulative balance proof to
    // RollingSwapChannel.updateBalance at the self-describing verifyingContract.
    // recipient + verifyingContract are bound into the signed digest and REQUIRED.
    if (!balanceProof.recipient || !balanceProof.verifyingContract) {
      throw new Error(
        'EVM v2 updateBalance requires recipient and verifyingContract on the balance proof'
      );
    }

    await this._sdk.updateBalance(
      balanceProof.verifyingContract,
      channelId,
      safeBigInt(balanceProof.transferredAmount, 'cumulativeAmount'),
      balanceProof.nonce,
      balanceProof.recipient,
      signature
    );

    // PaymentChannelSDK methods return void — transaction hash is not yet
    // propagated from the underlying ethers.js ContractTransactionResponse.
    // Tracked as tech debt: SDK should return tx receipt with hash.
    return { txHash: '' };
  }

  /**
   * Initiate channel closure.
   *
   * @param channelId - Channel to close
   * @returns Transaction hash (placeholder — SDK returns void)
   */
  async closeChannel(channelId: string): Promise<TxResult> {
    this._logger.info('EVMPaymentChannelProvider: closing channel', {
      channelId,
      chainId: this.chainId,
    });

    await this._sdk.closeChannel(channelId, this._tokenAddress);

    // PaymentChannelSDK methods return void — transaction hash is not yet
    // propagated from the underlying ethers.js ContractTransactionResponse.
    // Tracked as tech debt: SDK should return tx receipt with hash.
    return { txHash: '' };
  }

  /**
   * Settle a closed channel after the challenge period expires.
   *
   * @param channelId - Channel to settle
   * @returns Transaction hash (placeholder — SDK returns void)
   */
  async settleChannel(channelId: string): Promise<TxResult> {
    this._logger.info('EVMPaymentChannelProvider: settling channel', {
      channelId,
      chainId: this.chainId,
    });

    await this._sdk.settleChannel(channelId, this._tokenAddress);

    // PaymentChannelSDK methods return void — transaction hash is not yet
    // propagated from the underlying ethers.js ContractTransactionResponse.
    // Tracked as tech debt: SDK should return tx receipt with hash.
    return { txHash: '' };
  }

  /**
   * Sign a balance proof off-chain without submitting a transaction.
   *
   * Destructures `BalanceProofParams` and converts string amounts to `bigint`
   * before delegating to the SDK.
   *
   * @param params - Balance proof parameters to sign
   * @returns Hex-encoded EIP-712 signature string
   */
  async signBalanceProof(params: BalanceProofParams): Promise<string> {
    this._logger.debug('EVMPaymentChannelProvider: signing v2 balance proof', {
      channelId: params.channelId,
      nonce: params.nonce,
      chainId: this.chainId,
    });

    // v2 (connector#329 Phase 4b): recipient + chainId + verifyingContract are
    // REQUIRED digest inputs. `transferredAmount` carries the cumulative amount.
    if (params.recipient === undefined || params.verifyingContract === undefined) {
      throw new Error(
        'EVM v2 signBalanceProof requires recipient and verifyingContract on the params'
      );
    }
    if (params.chainId === undefined) {
      throw new Error('EVM v2 signBalanceProof requires chainId on the params');
    }

    return this._sdk.signBalanceProof(
      params.channelId,
      params.nonce,
      safeBigInt(params.transferredAmount, 'cumulativeAmount'),
      params.recipient,
      params.chainId,
      params.verifyingContract
    );
  }

  /**
   * Verify an off-chain balance proof signature.
   *
   * Constructs a `BalanceProof` object from the params and delegates to the SDK.
   *
   * @param params - Parameters including the signature to verify
   * @returns `true` if the signature is valid, `false` otherwise
   */
  async verifyBalanceProof(params: VerifyBalanceProofParams): Promise<boolean> {
    this._logger.debug('EVMPaymentChannelProvider: verifying v2 balance proof', {
      channelId: params.channelId,
      nonce: params.nonce,
      chainId: this.chainId,
    });

    // v2 verify (connector#329 Phase 4b): rebuild the v2 EIP-712 digest from the
    // self-describing params and recover the signer. recipient/chainId/
    // verifyingContract are REQUIRED — a missing one fails closed.
    if (
      params.recipient === undefined ||
      params.chainId === undefined ||
      params.verifyingContract === undefined
    ) {
      this._logger.warn('EVMPaymentChannelProvider: v2 verify missing required domain fields', {
        channelId: params.channelId,
        hasRecipient: params.recipient !== undefined,
        hasChainId: params.chainId !== undefined,
        hasVerifyingContract: params.verifyingContract !== undefined,
      });
      return false;
    }

    return this._sdk.verifyBalanceProofV2(
      {
        channelId: params.channelId,
        cumulativeAmount: params.transferredAmount,
        nonce: params.nonce,
        recipient: params.recipient,
        chainId: params.chainId,
        verifyingContract: params.verifyingContract,
      },
      params.signature,
      params.signerAddress
    );
  }

  /**
   * Query the current on-chain state of a channel.
   *
   * Delegates to the SDK and translates the EVM-specific `ChannelState` to the
   * chain-agnostic `ProviderChannelState`. Total deposit = myDeposit + theirDeposit.
   *
   * @param channelId - Channel to query
   * @returns Chain-agnostic channel state
   */
  async getChannelState(channelId: string): Promise<ProviderChannelState> {
    const state = await this._sdk.getChannelState(channelId, this._tokenAddress);

    return this.toProviderChannelState(state);
  }

  /**
   * Subscribe to on-chain events for a specific channel.
   *
   * Registers SDK event listeners for all supported event types, filters by
   * `channelId`, and forwards matching events through the unified callback.
   *
   * The SDK's `onChannel*` methods are async (they resolve TokenNetwork contracts
   * internally). The returned subscription is valid immediately; event callbacks
   * begin firing once the async setup completes.
   *
   * @param channelId - Channel to watch
   * @param callback - Function invoked when an event occurs
   * @returns Subscription handle with an `unsubscribe()` method
   */
  subscribeToEvents(channelId: string, callback: ProviderEventCallback): ProviderEventSubscription {
    this._logger.debug('EVMPaymentChannelProvider: subscribing to events', {
      channelId,
      chainId: this.chainId,
    });

    let unsubscribed = false;

    const forwardEvent = (
      type: ProviderEventType,
      eventChannelId: string,
      data?: Record<string, unknown>
    ): void => {
      if (unsubscribed) return;
      if (eventChannelId !== channelId) return;

      const event: ProviderEvent = {
        type,
        channelId: eventChannelId,
        data,
      };
      callback(event);
    };

    // Register SDK event listeners (async — fire-and-forget setup).
    // Errors during registration are logged rather than silently swallowed.
    const onRegError = (eventName: string, err: unknown): void => {
      this._logger.warn('EVMPaymentChannelProvider: event registration failed', {
        eventName,
        channelId,
        chainId: this.chainId,
        error: err instanceof Error ? err.message : String(err),
      });
    };

    void this._sdk
      .onChannelOpened(this._tokenAddress, (evt) => {
        forwardEvent('channel_opened', evt.channelId, {
          participant1: evt.participant1,
          participant2: evt.participant2,
          settlementTimeout: evt.settlementTimeout,
        });
      })
      .catch((err: unknown) => onRegError('ChannelOpened', err));

    void this._sdk
      .onChannelClosed(this._tokenAddress, (evt) => {
        forwardEvent('channel_closed', evt.channelId, {
          closingParticipant: evt.closingParticipant,
        });
      })
      .catch((err: unknown) => onRegError('ChannelClosed', err));

    void this._sdk
      .onChannelSettled(this._tokenAddress, (evt) => {
        forwardEvent('channel_settled', evt.channelId, {
          participant1Amount: evt.participant1Amount.toString(),
          participant2Amount: evt.participant2Amount.toString(),
        });
      })
      .catch((err: unknown) => onRegError('ChannelSettled', err));

    void this._sdk
      .onChannelCooperativeSettled(this._tokenAddress, (evt) => {
        forwardEvent('channel_settled', evt.channelId, {
          participant1Amount: evt.participant1Amount.toString(),
          participant2Amount: evt.participant2Amount.toString(),
          cooperative: true,
        });
      })
      .catch((err: unknown) => onRegError('ChannelCooperativeSettled', err));

    return {
      unsubscribe: (): void => {
        unsubscribed = true;
        this._sdk.removeAllListeners();
        this._logger.debug('EVMPaymentChannelProvider: unsubscribed from events', {
          channelId,
          chainId: this.chainId,
        });
      },
    };
  }

  // ---------------------------------------------------------------------------
  // EVM-Specific Public Methods
  // ---------------------------------------------------------------------------

  /**
   * Get the EVM-specific signing context needed for constructing self-describing
   * v2 claim messages (chainId, verifyingContract, signerAddress).
   *
   * `verifyingContract` is the deployed RollingSwapChannel address bound into the
   * v2 EIP-712 signing domain (connector#329 Phase 4b) — it replaces the v1
   * `tokenNetworkAddress`. It is resolved from the SDK's configured settlement
   * contract for this token.
   *
   * This method is NOT part of the `PaymentChannelProvider` interface — it is an
   * EVM-specific concrete method. Callers should use `instanceof EVMPaymentChannelProvider`
   * to narrow the type before calling.
   *
   * @returns Signing context with chainId (number), verifyingContract (hex), and signerAddress (hex)
   */
  async getSigningContext(): Promise<{
    chainId: number;
    verifyingContract: string;
    signerAddress: string;
  }> {
    const [chainId, verifyingContract, signerAddress] = await Promise.all([
      this._sdk.getChainId(),
      this._sdk.getTokenNetworkAddress(this._tokenAddress),
      this._sdk.getSignerAddress(),
    ]);
    return { chainId, verifyingContract, signerAddress };
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Translate EVM-specific `ChannelState` to chain-agnostic `ProviderChannelState`.
   * Total deposit is the sum of both participants' deposits.
   */
  private toProviderChannelState(state: ChannelState): ProviderChannelState {
    return {
      channelId: state.channelId,
      status: state.status,
      participants: [...state.participants],
      deposit: state.myDeposit + state.theirDeposit,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory Function
// ---------------------------------------------------------------------------

/**
 * Create a `ChainProviderFactory` for EVM providers.
 *
 * The returned factory validates that the incoming config has `chainType === 'evm'`
 * and constructs an `EVMPaymentChannelProvider` with placeholder `chainId` and
 * `tokenAddress` derivation. Full wiring is deferred to Story 32.7/32.8.
 *
 * @param sdk - The underlying EVM PaymentChannelSDK instance
 * @param logger - Logger instance
 * @returns A factory function compatible with `ChainProviderRegistry.fromConfig()`
 */
export function createEVMProviderFactory(
  sdk: PaymentChannelSDK,
  logger: Logger
): ChainProviderFactory {
  return (config: ProviderConfig): PaymentChannelProvider => {
    if (config.chainType !== 'evm') {
      throw new Error(`EVM factory received non-EVM config: ${config.chainType}`);
    }

    // Placeholder derivation — actual values depend on Story 32.7 config schema
    // Validate keyId contains only safe characters (alphanumeric, hyphens, underscores)
    if (!/^[\w-]+$/.test(config.keyId)) {
      throw new Error(
        'EVM factory received invalid keyId: expected alphanumeric string with hyphens/underscores'
      );
    }
    const chainId = `evm:${config.keyId}`;
    const tokenAddress = config.registryAddress;

    return new EVMPaymentChannelProvider(sdk, chainId, tokenAddress, logger);
  };
}
