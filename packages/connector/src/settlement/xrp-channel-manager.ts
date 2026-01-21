/**
 * Payment Channel Manager
 *
 * Manages XRP payment channel lifecycle: creation, funding, state tracking.
 * Wraps XRPLClient for channel-specific operations.
 *
 * Implementation: packages/connector/src/settlement/xrp-channel-manager.ts
 */
import { XRPLClient } from './xrpl-client';
import { ClaimSigner } from './xrp-claim-signer';
import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';

/**
 * XRP Payment Channel State
 *
 * Tracks the complete state of an XRP Ledger payment channel.
 * Synchronized with on-ledger state via XRPLClient.getLedgerEntry().
 */
export interface XRPChannelState {
  /**
   * Channel identifier (transaction hash from PaymentChannelCreate)
   * Format: 64-character hex string (256-bit hash)
   */
  channelId: string;

  /**
   * Source account (channel sender, us)
   * Format: XRP Ledger r-address (e.g., "rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW")
   */
  account: string;

  /**
   * Destination account (channel recipient, peer)
   * Format: XRP Ledger r-address
   */
  destination: string;

  /**
   * Total XRP deposited in channel (immutable after creation unless funded)
   * Format: String in drops (1 XRP = 1,000,000 drops)
   * Example: "1000000000" = 1,000 XRP
   */
  amount: string;

  /**
   * XRP already paid out via claims (cumulative)
   * Format: String in drops
   * Updated when peer submits PaymentChannelClaim transaction
   */
  balance: string;

  /**
   * Settlement delay in seconds
   * Minimum: 3600 seconds (1 hour) for production
   * Purpose: Delay between close initiation and finalization (dispute period)
   */
  settleDelay: number;

  /**
   * ed25519 public key for claim signature verification
   * Format: 66-character hex-encoded public key (prefix ED + 64 hex chars)
   * Used by peer to verify off-chain claim signatures
   */
  publicKey: string;

  /**
   * Optional: Channel auto-expiration timestamp
   * Format: Ripple epoch timestamp (seconds since 2000-01-01 00:00:00 UTC)
   * If set, channel automatically closes after this time
   */
  cancelAfter?: number;

  /**
   * Optional: Close request timestamp
   * Format: Ripple epoch timestamp
   * Set when close initiated, finalized after settleDelay seconds
   */
  expiration?: number;

  /**
   * Channel lifecycle status
   */
  status: 'open' | 'closing' | 'closed';
}

/**
 * Payment Channel Manager Interface
 */
export interface IPaymentChannelManager {
  /**
   * Create new payment channel
   *
   * Submits PaymentChannelCreate transaction to XRPL.
   * Generates ed25519 keypair for claim signing.
   * Stores channel metadata in local database.
   *
   * @param destination - Peer's XRP Ledger address (r-address)
   * @param amount - Total XRP in channel (drops as string)
   * @param settleDelay - Settlement delay in seconds (minimum 3600 for production)
   * @returns Channel ID (transaction hash)
   * @throws XRPLError with code INSUFFICIENT_FUNDS if balance too low
   * @throws XRPLError with code TRANSACTION_FAILED if submission fails
   */
  createChannel(destination: string, amount: string, settleDelay: number): Promise<string>;

  /**
   * Fund existing channel with additional XRP
   *
   * Submits PaymentChannelFund transaction to add more XRP.
   * Updates local channel state with new amount.
   *
   * @param channelId - Channel ID (transaction hash)
   * @param additionalAmount - XRP to add (drops as string)
   * @throws XRPLError with code CHANNEL_NOT_FOUND if channel doesn't exist
   * @throws XRPLError with code INSUFFICIENT_FUNDS if balance too low
   */
  fundChannel(channelId: string, additionalAmount: string): Promise<void>;

  /**
   * Get channel state from ledger
   *
   * Queries XRPL for current channel state.
   * Synchronizes local database with on-ledger state.
   *
   * @param channelId - Channel ID
   * @returns Current channel state
   * @throws XRPLError with code CHANNEL_NOT_FOUND if channel doesn't exist
   */
  getChannelState(channelId: string): Promise<XRPChannelState>;

  /**
   * Get all channels for peer
   *
   * @param peerAddress - Peer's XRP Ledger address
   * @returns Array of channel IDs
   */
  getChannelsForPeer(peerAddress: string): Promise<string[]>;

  /**
   * Submit claim to redeem XRP from channel
   *
   * Wrapper around XRPLClient.submitClaim() with database state updates.
   * Submits PaymentChannelClaim transaction to XRPL.
   * Updates local channel balance after successful submission.
   *
   * @param channelId - Channel ID (64-char hex)
   * @param amount - XRP drops to claim (string for bigint)
   * @param signature - Claim signature (128 hex chars)
   * @param publicKey - Public key for verification (66 hex chars)
   * @returns Transaction result
   * @throws XRPLError if claim invalid or submission fails
   */
  submitClaim(
    channelId: string,
    amount: string,
    signature: string,
    publicKey: string
  ): Promise<{
    hash: string;
    ledgerIndex: number;
    result: Record<string, unknown>;
  }>;

  /**
   * Close payment channel cooperatively
   *
   * Wrapper around XRPLClient.closeChannel() with database state updates.
   * Initiates channel closure. Channel enters "closing" state.
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
}

/**
 * PaymentChannelManager Implementation
 */
export class PaymentChannelManager implements IPaymentChannelManager {
  private readonly xrplClient: XRPLClient;
  private readonly claimSigner: ClaimSigner;
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(xrplClient: XRPLClient, db: Database, logger: Logger) {
    this.xrplClient = xrplClient;
    this.db = db;
    this.logger = logger;

    // Initialize ClaimSigner with optional seed from environment
    const claimSignerSeed = process.env.XRPL_CLAIM_SIGNER_SEED;
    this.claimSigner = new ClaimSigner(db, logger, claimSignerSeed);

    this.logger.info(
      { publicKey: this.claimSigner.getPublicKey() },
      'ClaimSigner initialized for payment channel claims'
    );
  }

  async createChannel(destination: string, amount: string, settleDelay: number): Promise<string> {
    this.logger.info({ destination, amount, settleDelay }, 'Creating XRP payment channel...');

    // Validate inputs
    if (!destination.startsWith('r')) {
      throw new Error('Invalid destination address format (must be r-address)');
    }

    if (BigInt(amount) <= BigInt(0)) {
      throw new Error('Amount must be positive');
    }

    if (settleDelay < 3600) {
      this.logger.warn(
        { settleDelay },
        'SettleDelay below 1 hour (3600s) not recommended for production'
      );
    }

    // Generate ed25519 keypair for claim signing
    const publicKey = this.claimSigner.getPublicKey();

    // Construct PaymentChannelCreate transaction
    const tx = {
      TransactionType: 'PaymentChannelCreate',
      Account: this.xrplClient['wallet'].address,
      Destination: destination,
      Amount: amount,
      SettleDelay: settleDelay,
      PublicKey: publicKey,
    };

    // Submit transaction and wait for confirmation
    const result = await this.xrplClient.submitAndWait(tx);
    const channelId = result.hash;

    this.logger.info({ channelId, destination, amount }, 'XRP payment channel created');

    // Query ledger to validate channel exists
    const channelState = await this.getChannelState(channelId);

    // Store channel metadata in local database
    this.db
      .prepare(
        `
        INSERT INTO xrp_channels (
          channel_id, account, destination, amount, balance,
          settle_delay, public_key, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        channelId,
        channelState.account,
        channelState.destination,
        channelState.amount,
        channelState.balance,
        channelState.settleDelay,
        channelState.publicKey,
        channelState.status,
        Date.now()
      );

    this.logger.info({ channelId }, 'Channel metadata stored in database');

    return channelId;
  }

  async fundChannel(channelId: string, additionalAmount: string): Promise<void> {
    this.logger.info({ channelId, additionalAmount }, 'Funding XRP payment channel...');

    // Validate channel exists on-ledger
    const currentState = await this.getChannelState(channelId);

    if (currentState.status !== 'open') {
      throw new Error(`Cannot fund channel in status: ${currentState.status} (must be open)`);
    }

    // Construct PaymentChannelFund transaction
    const tx = {
      TransactionType: 'PaymentChannelFund',
      Account: this.xrplClient['wallet'].address,
      Channel: channelId,
      Amount: additionalAmount,
    };

    // Submit transaction and wait for confirmation
    await this.xrplClient.submitAndWait(tx);

    // Update local database with new amount
    const newAmount = (BigInt(currentState.amount) + BigInt(additionalAmount)).toString();

    this.db
      .prepare('UPDATE xrp_channels SET amount = ? WHERE channel_id = ?')
      .run(newAmount, channelId);

    this.logger.info({ channelId, newAmount }, 'XRP payment channel funded successfully');
  }

  async getChannelState(channelId: string): Promise<XRPChannelState> {
    try {
      // Query ledger for channel entry
      const ledgerEntry = await this.xrplClient.getLedgerEntry(channelId);

      // Cast to unknown first, then to Record<string, unknown> for safe property access
      const entry = ledgerEntry as unknown as Record<string, unknown>;

      // Parse ledger entry into XRPChannelState
      const channelState: XRPChannelState = {
        channelId: channelId,
        account: entry.Account as string,
        destination: entry.Destination as string,
        amount: entry.Amount as string,
        balance: (entry.Balance as string) || '0',
        settleDelay: entry.SettleDelay as number,
        publicKey: entry.PublicKey as string,
        cancelAfter: entry.CancelAfter as number | undefined,
        expiration: entry.Expiration as number | undefined,
        status: this.determineChannelStatus(entry),
      };

      return channelState;
    } catch (error) {
      this.logger.error({ error, channelId }, 'Failed to get channel state');
      throw error;
    }
  }

  async getChannelsForPeer(peerAddress: string): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT channel_id FROM xrp_channels WHERE destination = ?')
      .all(peerAddress) as { channel_id: string }[];

    return rows.map((row) => row.channel_id);
  }

  async submitClaim(
    channelId: string,
    amount: string,
    signature: string,
    publicKey: string
  ): Promise<{
    hash: string;
    ledgerIndex: number;
    result: Record<string, unknown>;
  }> {
    this.logger.info({ channelId, amount }, 'Submitting claim via PaymentChannelManager...');

    // Submit claim to ledger
    const result = await this.xrplClient.submitClaim(channelId, amount, signature, publicKey);

    // Update channel balance in database
    await this.updateChannelBalance(channelId, amount);

    this.logger.info({ channelId, amount }, 'Claim submitted and database updated');

    return result;
  }

  async closeChannel(channelId: string): Promise<{
    hash: string;
    ledgerIndex: number;
    result: Record<string, unknown>;
  }> {
    this.logger.info({ channelId }, 'Closing channel via PaymentChannelManager...');

    // Submit channel close transaction
    const result = await this.xrplClient.closeChannel(channelId);

    // Update channel status in database
    this.db
      .prepare('UPDATE xrp_channels SET status = ?, updated_at = ? WHERE channel_id = ?')
      .run('closing', Date.now(), channelId);

    this.logger.info({ channelId }, 'Channel closure initiated and database updated');

    return result;
  }

  private async updateChannelBalance(channelId: string, claimedAmount: string): Promise<void> {
    this.db
      .prepare('UPDATE xrp_channels SET balance = ?, updated_at = ? WHERE channel_id = ?')
      .run(claimedAmount, Date.now(), channelId);

    this.logger.info({ channelId, balance: claimedAmount }, 'Channel balance updated in database');
  }

  private determineChannelStatus(
    ledgerEntry: Record<string, unknown>
  ): 'open' | 'closing' | 'closed' {
    if (ledgerEntry.Expiration) {
      const now = Math.floor(Date.now() / 1000);
      const rippleEpoch = 946684800; // 2000-01-01 00:00:00 UTC
      const expirationUnix = (ledgerEntry.Expiration as number) + rippleEpoch;

      if (now < expirationUnix + (ledgerEntry.SettleDelay as number)) {
        return 'closing';
      } else {
        return 'closed';
      }
    }

    return 'open';
  }
}
