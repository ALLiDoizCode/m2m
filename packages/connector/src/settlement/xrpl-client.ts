import {
  Client,
  Wallet,
  TxResponse,
  AccountInfoRequest,
  AccountInfoResponse,
  LedgerEntryRequest,
  LedgerEntryResponse,
  verifyPaymentChannelClaim,
} from 'xrpl';
import type { Transaction } from 'xrpl';
import { Logger } from 'pino';

/**
 * XRPL Client Configuration
 *
 * Loaded from environment variables at connector startup.
 * Supports local rippled (development) and XRPL mainnet (production).
 */
export interface XRPLClientConfig {
  /**
   * WebSocket URL for rippled connection
   * - Local development: ws://localhost:6006 (Epic 7 rippled service)
   * - XRPL Testnet: wss://s.altnet.rippletest.net:51233
   * - XRPL Mainnet: wss://xrplcluster.com or wss://s1.ripple.com
   */
  wssUrl: string;

  /**
   * XRP Ledger account secret (private key)
   * - Format: 29-character base58-encoded seed (e.g., "sEdVT7rWU...")
   * - MUST be stored in environment variable (XRPL_ACCOUNT_SECRET)
   * - NEVER hardcode in source code
   */
  accountSecret: string;

  /**
   * XRP Ledger account address (public)
   * - Format: r-address (e.g., "rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW")
   * - Derived from accountSecret, but stored for validation
   */
  accountAddress: string;

  /**
   * Connection timeout in milliseconds
   * Default: 10000ms (10 seconds)
   */
  connectionTimeoutMs?: number;

  /**
   * Automatic reconnection enabled
   * Default: true
   */
  autoReconnect?: boolean;

  /**
   * Maximum reconnection attempts before giving up
   * Default: 5
   */
  maxReconnectAttempts?: number;
}

/**
 * Application-level XRPL error types
 *
 * Maps rippled RPC error codes to domain-specific errors for consistent handling.
 */
export enum XRPLErrorCode {
  // Connection errors
  CONNECTION_FAILED = 'XRPL_CONNECTION_FAILED',
  CONNECTION_TIMEOUT = 'XRPL_CONNECTION_TIMEOUT',
  DISCONNECTED = 'XRPL_DISCONNECTED',

  // Account errors
  ACCOUNT_NOT_FOUND = 'XRPL_ACCOUNT_NOT_FOUND',
  INSUFFICIENT_FUNDS = 'XRPL_INSUFFICIENT_FUNDS',
  ACCOUNT_RESERVE_NOT_MET = 'XRPL_ACCOUNT_RESERVE_NOT_MET',

  // Transaction errors
  TRANSACTION_FAILED = 'XRPL_TRANSACTION_FAILED',
  INVALID_TRANSACTION = 'XRPL_INVALID_TRANSACTION',
  TRANSACTION_TIMEOUT = 'XRPL_TRANSACTION_TIMEOUT',

  // Channel errors
  CHANNEL_NOT_FOUND = 'XRPL_CHANNEL_NOT_FOUND',
  INVALID_CHANNEL_SIGNATURE = 'XRPL_INVALID_CHANNEL_SIGNATURE',
  CHANNEL_AMOUNT_EXCEEDED = 'XRPL_CHANNEL_AMOUNT_EXCEEDED',

  // General errors
  UNKNOWN_ERROR = 'XRPL_UNKNOWN_ERROR',
}

/**
 * XRPL Error Class
 */
export class XRPLError extends Error {
  constructor(
    public readonly code: XRPLErrorCode,
    message: string,
    public readonly originalError?: Error | unknown
  ) {
    super(message);
    this.name = 'XRPLError';
  }
}

/**
 * XRPL Client
 *
 * TypeScript client for interacting with XRP Ledger via rippled WebSocket API.
 * Wraps xrpl.js library with application-specific error handling and logging.
 */
export interface IXRPLClient {
  /**
   * Initialize connection to rippled
   */
  connect(): Promise<void>;

  /**
   * Disconnect from rippled
   */
  disconnect(): Promise<void>;

  /**
   * Get account information
   */
  getAccountInfo(address: string): Promise<{
    balance: string;
    sequence: number;
    ownerCount: number;
  }>;

  /**
   * Submit signed transaction to ledger
   *
   * @param transaction - Transaction object (will be autofilled by xrpl.js)
   */
  submitAndWait(transaction: Record<string, unknown>): Promise<{
    hash: string;
    ledgerIndex: number;
    result: Record<string, unknown>;
  }>;

  /**
   * Query ledger entry by ID
   */
  getLedgerEntry(entryId: string): Promise<LedgerEntryResponse['result']['node']>;

  /**
   * Check connection status
   */
  isConnected(): boolean;

  /**
   * Submit claim to redeem XRP from payment channel
   *
   * Validates claim signature before submission.
   * Handles partial claims (redeem some XRP) and final claims (close channel).
   *
   * @param channelId - Channel ID (64-char hex)
   * @param amount - XRP drops to claim (string for bigint)
   * @param signature - Claim signature from channel source (128 hex chars)
   * @param publicKey - ed25519 public key for verification (66 hex chars)
   * @param closeAfterClaim - Optional: Close channel after claim (default: false)
   * @returns Transaction result with hash and ledger index
   * @throws XRPLError if claim invalid or submission fails
   */
  submitClaim(
    channelId: string,
    amount: string,
    signature: string,
    publicKey: string,
    closeAfterClaim?: boolean
  ): Promise<{
    hash: string;
    ledgerIndex: number;
    result: Record<string, unknown>;
  }>;

  /**
   * Close payment channel cooperatively
   *
   * Initiates channel closure. Channel enters "closing" state for SettleDelay period.
   * Can be called by source or destination.
   *
   * @param channelId - Channel ID (64-char hex)
   * @returns Transaction result
   * @throws XRPLError if closure fails
   */
  closeChannel(channelId: string): Promise<{
    hash: string;
    ledgerIndex: number;
    result: Record<string, unknown>;
  }>;

  /**
   * Cancel pending channel closure
   *
   * Aborts closure during settlement delay period.
   * Returns channel to "open" state.
   *
   * @param channelId - Channel ID (64-char hex)
   * @returns Transaction result
   * @throws XRPLError if cancellation fails
   */
  cancelChannelClose(channelId: string): Promise<{
    hash: string;
    ledgerIndex: number;
    result: Record<string, unknown>;
  }>;
}

/**
 * XRPLClient Implementation using xrpl.js
 */
export class XRPLClient implements IXRPLClient {
  private client: Client;
  private wallet: Wallet;
  private readonly logger: Logger;
  private readonly config: XRPLClientConfig;
  private reconnectAttempts: number = 0;

  constructor(config: XRPLClientConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    // Initialize xrpl.js client
    this.client = new Client(config.wssUrl, {
      timeout: config.connectionTimeoutMs ?? 10000,
    });

    // Initialize wallet from secret
    this.wallet = Wallet.fromSeed(config.accountSecret);

    // Validate address matches derived wallet
    if (this.wallet.address !== config.accountAddress) {
      throw new Error(
        `Account address mismatch: expected ${config.accountAddress}, got ${this.wallet.address}`
      );
    }

    // Register event listeners
    this.client.on('error', this.handleError.bind(this));
    this.client.on('disconnected', this.handleDisconnect.bind(this));
  }

  async connect(): Promise<void> {
    try {
      this.logger.info({ wssUrl: this.config.wssUrl }, 'Connecting to rippled...');
      await this.client.connect();
      this.logger.info({ address: this.wallet.address }, 'Connected to rippled');

      // Validate account exists on ledger
      const accountInfo = await this.getAccountInfo(this.wallet.address);
      this.logger.info(
        { address: this.wallet.address, balance: accountInfo.balance },
        'XRPL account validated'
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown connection error';
      this.logger.error({ error, wssUrl: this.config.wssUrl }, 'Failed to connect to rippled');
      throw new XRPLError(
        XRPLErrorCode.CONNECTION_FAILED,
        `Failed to connect to rippled: ${errorMessage}`,
        error
      );
    }
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
    this.logger.info('Disconnected from rippled');
  }

  async getAccountInfo(address: string): Promise<{
    balance: string;
    sequence: number;
    ownerCount: number;
  }> {
    try {
      const request: AccountInfoRequest = {
        command: 'account_info',
        account: address,
        ledger_index: 'validated',
      };
      const response = (await this.client.request(request)) as AccountInfoResponse;

      return {
        balance: response.result.account_data.Balance,
        sequence: response.result.account_data.Sequence,
        ownerCount: response.result.account_data.OwnerCount,
      };
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        'data' in error &&
        typeof (error as { data?: { error?: string } }).data === 'object' &&
        (error as { data: { error?: string } }).data?.error === 'actNotFound'
      ) {
        throw new XRPLError(
          XRPLErrorCode.ACCOUNT_NOT_FOUND,
          `Account not found: ${address}`,
          error
        );
      }
      throw this.mapError(error);
    }
  }

  async submitAndWait(transaction: Record<string, unknown>): Promise<{
    hash: string;
    ledgerIndex: number;
    result: Record<string, unknown>;
  }> {
    try {
      this.logger.info({ transaction }, 'Submitting transaction to XRPL...');

      // Autofill transaction (sequence, fee, lastLedgerSequence)
      const prepared = await this.client.autofill(transaction as unknown as Transaction);

      // Sign transaction with wallet
      const signed = this.wallet.sign(prepared);

      // Submit and wait for validation
      const result = (await this.client.submitAndWait(signed.tx_blob)) as TxResponse;

      this.logger.info(
        { hash: result.result.hash, ledgerIndex: result.result.ledger_index },
        'Transaction confirmed on XRPL'
      );

      return {
        hash: result.result.hash as string,
        ledgerIndex: (result.result.ledger_index as number) ?? 0,
        result: result.result as unknown as Record<string, unknown>,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Transaction failed';
      this.logger.error({ error, transaction }, 'Transaction submission failed');
      throw new XRPLError(
        XRPLErrorCode.TRANSACTION_FAILED,
        `Transaction failed: ${errorMessage}`,
        error
      );
    }
  }

  async getLedgerEntry(entryId: string): Promise<LedgerEntryResponse['result']['node']> {
    try {
      const request: LedgerEntryRequest = {
        command: 'ledger_entry',
        payment_channel: entryId,
        ledger_index: 'validated',
      };
      const response = (await this.client.request(request)) as LedgerEntryResponse;

      return response.result.node;
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        'data' in error &&
        typeof (error as { data?: { error?: string } }).data === 'object' &&
        (error as { data: { error?: string } }).data?.error === 'entryNotFound'
      ) {
        throw new XRPLError(
          XRPLErrorCode.CHANNEL_NOT_FOUND,
          `Payment channel not found: ${entryId}`,
          error
        );
      }
      throw this.mapError(error);
    }
  }

  async submitClaim(
    channelId: string,
    amount: string,
    signature: string,
    publicKey: string,
    closeAfterClaim: boolean = false
  ): Promise<{
    hash: string;
    ledgerIndex: number;
    result: Record<string, unknown>;
  }> {
    this.logger.info({ channelId, amount, closeAfterClaim }, 'Submitting claim to XRP Ledger...');

    // Validate input parameters
    if (!channelId || !/^[0-9A-Fa-f]{64}$/.test(channelId)) {
      throw new XRPLError(
        XRPLErrorCode.INVALID_TRANSACTION,
        'Invalid channelId: must be 64-character hex string'
      );
    }

    if (!signature || !/^[0-9A-Fa-f]{128}$/.test(signature)) {
      throw new XRPLError(
        XRPLErrorCode.INVALID_CHANNEL_SIGNATURE,
        'Invalid signature: must be 128-character hex string'
      );
    }

    if (!publicKey || !/^ED[0-9A-Fa-f]{64}$/i.test(publicKey)) {
      throw new XRPLError(
        XRPLErrorCode.INVALID_TRANSACTION,
        'Invalid public key: must be 66-character hex with ED prefix'
      );
    }

    if (!amount || BigInt(amount) <= 0) {
      throw new XRPLError(
        XRPLErrorCode.INVALID_TRANSACTION,
        'Invalid amount: must be positive numeric string'
      );
    }

    // Verify claim signature before submission
    this.logger.info({ channelId, amount, signature }, 'Verifying claim signature...');

    try {
      const isValid = verifyPaymentChannelClaim(channelId, amount, signature, publicKey);

      if (!isValid) {
        throw new XRPLError(
          XRPLErrorCode.INVALID_CHANNEL_SIGNATURE,
          'Claim signature verification failed'
        );
      }

      this.logger.info({ channelId }, 'Claim signature verified successfully');
    } catch (error) {
      if (error instanceof XRPLError) {
        throw error;
      }
      this.logger.error({ error, channelId }, 'Signature verification error');
      throw new XRPLError(
        XRPLErrorCode.INVALID_CHANNEL_SIGNATURE,
        'Failed to verify claim signature',
        error
      );
    }

    // Construct PaymentChannelClaim transaction
    const flags = closeAfterClaim ? 0x00010000 : 0; // tfClose flag

    const claimTx: Record<string, unknown> = {
      TransactionType: 'PaymentChannelClaim',
      Account: this.wallet.address,
      Channel: channelId,
      Amount: amount,
      Signature: signature,
      PublicKey: publicKey,
      Flags: flags,
    };

    this.logger.info({ transaction: claimTx }, 'Submitting PaymentChannelClaim transaction...');

    try {
      // Submit transaction and wait for validation
      const result = await this.submitAndWait(claimTx);

      this.logger.info(
        { hash: result.hash, ledgerIndex: result.ledgerIndex },
        'Claim submitted successfully'
      );

      return result;
    } catch (error) {
      this.logger.error({ error, channelId }, 'Claim submission failed');
      throw new XRPLError(
        XRPLErrorCode.TRANSACTION_FAILED,
        'Failed to submit claim to ledger',
        error
      );
    }
  }

  async closeChannel(channelId: string): Promise<{
    hash: string;
    ledgerIndex: number;
    result: Record<string, unknown>;
  }> {
    this.logger.info({ channelId }, 'Closing XRP payment channel...');

    // Validate channelId
    if (!channelId || !/^[0-9A-Fa-f]{64}$/.test(channelId)) {
      throw new XRPLError(
        XRPLErrorCode.INVALID_TRANSACTION,
        'Invalid channelId: must be 64-character hex string'
      );
    }

    const closeTx: Record<string, unknown> = {
      TransactionType: 'PaymentChannelClaim',
      Account: this.wallet.address,
      Channel: channelId,
      Flags: 0x00010000, // tfClose flag
    };

    this.logger.info({ transaction: closeTx }, 'Submitting channel close transaction...');

    try {
      const result = await this.submitAndWait(closeTx);

      this.logger.info(
        { hash: result.hash, ledgerIndex: result.ledgerIndex },
        'Channel closure initiated successfully'
      );

      return result;
    } catch (error) {
      this.logger.error({ error, channelId }, 'Channel closure failed');
      throw new XRPLError(XRPLErrorCode.TRANSACTION_FAILED, 'Failed to close channel', error);
    }
  }

  async cancelChannelClose(channelId: string): Promise<{
    hash: string;
    ledgerIndex: number;
    result: Record<string, unknown>;
  }> {
    this.logger.info({ channelId }, 'Cancelling channel closure...');

    // Validate channelId
    if (!channelId || !/^[0-9A-Fa-f]{64}$/.test(channelId)) {
      throw new XRPLError(
        XRPLErrorCode.INVALID_TRANSACTION,
        'Invalid channelId: must be 64-character hex string'
      );
    }

    const cancelTx: Record<string, unknown> = {
      TransactionType: 'PaymentChannelClaim',
      Account: this.wallet.address,
      Channel: channelId,
      Flags: 0x00020000, // tfRenew flag
    };

    this.logger.info({ transaction: cancelTx }, 'Submitting cancel close transaction...');

    try {
      const result = await this.submitAndWait(cancelTx);

      this.logger.info(
        { hash: result.hash, ledgerIndex: result.ledgerIndex },
        'Channel closure cancelled successfully'
      );

      return result;
    } catch (error) {
      this.logger.error({ error, channelId }, 'Cancel close failed');
      throw new XRPLError(
        XRPLErrorCode.TRANSACTION_FAILED,
        'Failed to cancel channel closure',
        error
      );
    }
  }

  isConnected(): boolean {
    return this.client.isConnected();
  }

  /**
   * Handle WebSocket disconnection
   * Implements automatic reconnection with exponential backoff
   */
  private async handleDisconnect(): Promise<void> {
    if (this.config.autoReconnect === false) {
      this.logger.warn('Disconnected from rippled (auto-reconnect disabled)');
      return;
    }

    if (this.reconnectAttempts >= (this.config.maxReconnectAttempts ?? 5)) {
      this.logger.error('Max reconnection attempts reached, giving up');
      return;
    }

    this.reconnectAttempts++;
    const backoffMs = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

    this.logger.warn(
      { attempt: this.reconnectAttempts, backoffMs },
      'Disconnected from rippled, reconnecting...'
    );

    await new Promise((resolve) => setTimeout(resolve, backoffMs));

    try {
      await this.connect();
      this.reconnectAttempts = 0; // Reset on successful reconnection
    } catch (error) {
      this.logger.error({ error, attempt: this.reconnectAttempts }, 'Reconnection failed');
    }
  }

  /**
   * Handle WebSocket errors
   */
  private handleError(error: unknown): void {
    this.logger.error({ error }, 'XRPL WebSocket error');
  }

  /**
   * Map rippled error codes to application error types
   */
  private mapError(error: unknown): XRPLError {
    if (!error || typeof error !== 'object') {
      return new XRPLError(XRPLErrorCode.UNKNOWN_ERROR, 'Unknown error occurred', error);
    }

    const errorObj = error as { data?: { error?: string }; message?: string };
    const errorCode = errorObj.data?.error;
    const errorMessage = errorObj.message ?? 'Unknown error';

    switch (errorCode) {
      case 'actNotFound':
        return new XRPLError(XRPLErrorCode.ACCOUNT_NOT_FOUND, errorMessage, error);
      case 'tecUNFUNDED_PAYMENT':
      case 'tecINSUFFICIENT_RESERVE':
        return new XRPLError(XRPLErrorCode.INSUFFICIENT_FUNDS, errorMessage, error);
      case 'entryNotFound':
        return new XRPLError(XRPLErrorCode.CHANNEL_NOT_FOUND, errorMessage, error);
      default:
        return new XRPLError(XRPLErrorCode.UNKNOWN_ERROR, errorMessage, error);
    }
  }
}
