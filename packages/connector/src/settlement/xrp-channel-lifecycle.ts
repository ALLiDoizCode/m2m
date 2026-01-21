/**
 * XRP Channel Lifecycle Manager
 *
 * Manages automatic XRP payment channel lifecycle:
 * - Opens channels when first XRP settlement needed for peer
 * - Funds channels when balance falls below threshold
 * - Closes channels when idle for configured duration
 * - Handles expiration-based closures (CancelAfter)
 *
 * @module settlement/xrp-channel-lifecycle
 */

import type { Logger } from 'pino';
import type { XRPChannelSDK } from './xrp-channel-sdk';

/**
 * XRP Channel Lifecycle Configuration
 *
 * Configures automatic XRP payment channel lifecycle management:
 * - Channel opening: When to create new channels, initial amount
 * - Channel funding: When to add funds to existing channels
 * - Channel closure: Idle detection and expiration-based closure
 */
export interface XRPChannelLifecycleConfig {
  /** Enable automatic XRP channel lifecycle management */
  enabled: boolean;

  /** Initial channel amount in XRP drops (1 XRP = 1,000,000 drops) */
  initialChannelAmount: string;

  /** Default settlement delay in seconds (minimum 1 hour for production) */
  defaultSettleDelay: number;

  /** Idle channel threshold in seconds (close channel after no claims for X hours) */
  idleChannelThreshold: number;

  /** Minimum balance threshold (0.0 - 1.0). Fund channel when remaining balance < threshold * amount */
  minBalanceThreshold: number;

  /** Optional: Auto-expire channels after this many seconds (CancelAfter field) */
  cancelAfter?: number;

  /** Peer ID for channel management (used for telemetry and logging) */
  peerId?: string;
}

/**
 * XRP Channel Tracking State
 *
 * Internal state structure for tracking XRP channels per peer.
 * Used by XRPChannelLifecycleManager to monitor channel activity and trigger lifecycle events.
 */
export interface XRPChannelTrackingState {
  /** Channel ID (64-character hex string, transaction hash) */
  channelId: string;

  /** Peer ID associated with this channel */
  peerId: string;

  /** XRP Ledger destination address (r-address) */
  destination: string;

  /** Total XRP amount in channel (drops) */
  amount: string;

  /** Current channel balance (XRP claimed so far, in drops) */
  balance: string;

  /** Settlement delay in seconds */
  settleDelay: number;

  /** Channel status */
  status: 'open' | 'closing' | 'closed';

  /** Timestamp of last claim activity (milliseconds since epoch) */
  lastActivityAt: number;

  /** Optional: CancelAfter timestamp (channel auto-expires after this time) */
  cancelAfter?: number;
}

/**
 * XRP Channel Lifecycle Manager
 *
 * Manages automatic XRP payment channel lifecycle:
 * - Opens channels when first XRP settlement needed for peer
 * - Funds channels when balance falls below threshold
 * - Closes channels when idle for configured duration
 * - Handles expiration-based closures (CancelAfter)
 */
export class XRPChannelLifecycleManager {
  private channels: Map<string, XRPChannelTrackingState>; // Key: peerId
  private idleCheckTimer: NodeJS.Timeout | null = null;

  /**
   * Constructor
   *
   * @param config - XRP channel lifecycle configuration
   * @param xrpChannelSDK - XRP Channel SDK instance for channel operations
   * @param logger - Pino logger instance
   */
  constructor(
    private config: XRPChannelLifecycleConfig,
    private xrpChannelSDK: XRPChannelSDK,
    private logger: Logger
  ) {
    this.channels = new Map();
  }

  /**
   * Start lifecycle manager
   *
   * Begins periodic idle channel detection and expiration checks.
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.info('XRP channel lifecycle manager disabled');
      return;
    }

    // Start periodic idle channel check (every 1 hour)
    this.idleCheckTimer = setInterval(async () => {
      await this.detectIdleChannels();
      await this.detectExpiringChannels();
    }, 3600000); // 1 hour in milliseconds

    this.logger.info('XRP channel lifecycle manager started');
  }

  /**
   * Stop lifecycle manager
   *
   * Clears idle check timer and releases resources.
   */
  stop(): void {
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }

    this.logger.info('XRP channel lifecycle manager stopped');
  }

  /**
   * Get or create XRP channel for peer (AC: 2, 3)
   *
   * Finds existing open XRP channel for peer, or creates new channel if needed.
   * This method should be called by UnifiedSettlementExecutor when XRP settlement required.
   *
   * @param peerId - Peer ID
   * @param destination - XRP Ledger destination address (r-address)
   * @returns Channel ID (64-char hex string)
   */
  async getOrCreateChannel(peerId: string, destination: string): Promise<string> {
    // Check if channel already exists for peer
    const existingChannel = this.channels.get(peerId);

    if (existingChannel && existingChannel.status === 'open') {
      this.logger.debug(
        { peerId, channelId: existingChannel.channelId },
        'Using existing XRP channel'
      );
      return existingChannel.channelId;
    }

    // Create new channel (AC: 3)
    this.logger.info(
      { peerId, destination, amount: this.config.initialChannelAmount },
      'Creating new XRP channel'
    );

    const channelId = await this.xrpChannelSDK.openChannel(
      destination,
      this.config.initialChannelAmount,
      this.config.defaultSettleDelay,
      peerId // Pass peerId for telemetry
    );

    // Track channel state (AC: 2)
    this.channels.set(peerId, {
      channelId,
      peerId,
      destination,
      amount: this.config.initialChannelAmount,
      balance: '0', // No claims yet
      settleDelay: this.config.defaultSettleDelay,
      status: 'open',
      lastActivityAt: Date.now(),
      cancelAfter: this.config.cancelAfter
        ? Math.floor(Date.now() / 1000) + this.config.cancelAfter
        : undefined,
    });

    this.logger.info({ peerId, channelId }, 'XRP channel created and tracked');
    return channelId;
  }

  /**
   * Update channel activity timestamp (AC: 2, 6)
   *
   * Called after successful claim submission to update last activity timestamp.
   * Prevents channel from being detected as idle.
   *
   * @param peerId - Peer ID
   * @param claimAmount - Amount claimed (drops)
   */
  updateChannelActivity(peerId: string, claimAmount: string): void {
    const channel = this.channels.get(peerId);
    if (!channel) {
      this.logger.warn({ peerId }, 'Cannot update activity: channel not found');
      return;
    }

    // Update balance and activity timestamp
    channel.balance = claimAmount; // Cumulative claim amount
    channel.lastActivityAt = Date.now();

    this.logger.debug(
      { peerId, channelId: channel.channelId, claimAmount },
      'XRP channel activity updated'
    );
  }

  /**
   * Check if channel needs funding (AC: 5)
   *
   * Returns true if channel remaining balance < minBalanceThreshold * amount
   *
   * @param peerId - Peer ID
   * @returns True if channel needs funding
   */
  needsFunding(peerId: string): boolean {
    const channel = this.channels.get(peerId);
    if (!channel || channel.status !== 'open') {
      return false;
    }

    const amount = BigInt(channel.amount);
    const balance = BigInt(channel.balance);
    const remainingBalance = amount - balance;
    const threshold = (amount * BigInt(Math.floor(this.config.minBalanceThreshold * 100))) / 100n;

    return remainingBalance < threshold;
  }

  /**
   * Fund XRP channel with additional amount (AC: 5)
   *
   * Adds more XRP to existing channel when balance falls below threshold.
   *
   * @param peerId - Peer ID
   * @param additionalAmount - XRP drops to add to channel
   */
  async fundChannel(peerId: string, additionalAmount: string): Promise<void> {
    const channel = this.channels.get(peerId);
    if (!channel) {
      throw new Error(`Cannot fund channel: peer ${peerId} not found`);
    }

    if (channel.status !== 'open') {
      throw new Error(
        `Cannot fund channel: channel ${channel.channelId} status is ${channel.status}`
      );
    }

    this.logger.info(
      { peerId, channelId: channel.channelId, additionalAmount },
      'Funding XRP channel'
    );

    // Fund channel via SDK (emits telemetry)
    await this.xrpChannelSDK.fundChannel(channel.channelId, additionalAmount);

    // Update tracked amount
    const currentAmount = BigInt(channel.amount);
    const newAmount = currentAmount + BigInt(additionalAmount);
    channel.amount = newAmount.toString();

    this.logger.info(
      { peerId, channelId: channel.channelId, newAmount: channel.amount },
      'XRP channel funded'
    );
  }

  /**
   * Close XRP channel (AC: 7, 8)
   *
   * Closes XRP channel cooperatively via SDK.
   * Updates tracked status to 'closing'.
   *
   * @param peerId - Peer ID
   * @param reason - Closure reason ('idle' | 'expiration' | 'manual')
   */
  async closeChannel(peerId: string, reason: 'idle' | 'expiration' | 'manual'): Promise<void> {
    const channel = this.channels.get(peerId);
    if (!channel) {
      this.logger.warn({ peerId }, 'Cannot close channel: not found');
      return;
    }

    if (channel.status !== 'open') {
      this.logger.warn({ peerId, status: channel.status }, 'Cannot close channel: not open');
      return;
    }

    this.logger.info({ peerId, channelId: channel.channelId, reason }, 'Closing XRP channel');

    // Close channel via SDK (emits XRP_CHANNEL_CLOSED telemetry)
    await this.xrpChannelSDK.closeChannel(channel.channelId, peerId);

    // Update tracked status
    channel.status = 'closing';

    this.logger.info(
      { peerId, channelId: channel.channelId },
      'XRP channel closed (settling after delay)'
    );
  }

  /**
   * Get channel state for peer (AC: 2)
   *
   * Returns tracked channel state for peer, or null if no channel exists.
   *
   * @param peerId - Peer ID
   * @returns XRPChannelTrackingState or null
   */
  getChannelForPeer(peerId: string): XRPChannelTrackingState | null {
    return this.channels.get(peerId) ?? null;
  }

  /**
   * Detect idle channels (AC: 6, 7)
   *
   * Periodic check for channels with no activity for idleChannelThreshold seconds.
   * Automatically closes idle channels cooperatively.
   */
  private async detectIdleChannels(): Promise<void> {
    const now = Date.now();
    const idleThreshold = this.config.idleChannelThreshold * 1000; // Convert to milliseconds

    for (const [peerId, channel] of this.channels.entries()) {
      if (channel.status !== 'open') {
        continue; // Skip non-open channels
      }

      const idleTime = now - channel.lastActivityAt;

      if (idleTime > idleThreshold) {
        this.logger.info(
          { peerId, channelId: channel.channelId, idleTimeHours: idleTime / 3600000 },
          'Detected idle XRP channel, closing'
        );

        // Close idle channel (AC: 7)
        await this.closeChannel(peerId, 'idle');
      }
    }
  }

  /**
   * Detect expiration-based closures (AC: 8)
   *
   * Checks if channel has CancelAfter timestamp and closes channel before expiration.
   */
  private async detectExpiringChannels(): Promise<void> {
    const now = Math.floor(Date.now() / 1000); // Current time in seconds
    const expirationBuffer = 3600; // Close 1 hour before expiration

    for (const [peerId, channel] of this.channels.entries()) {
      if (channel.status !== 'open' || !channel.cancelAfter) {
        continue;
      }

      const timeUntilExpiration = channel.cancelAfter - now;

      if (timeUntilExpiration <= expirationBuffer) {
        this.logger.info(
          { peerId, channelId: channel.channelId, expiresIn: timeUntilExpiration },
          'XRP channel expiring soon, closing'
        );

        // Close expiring channel (AC: 8)
        await this.closeChannel(peerId, 'expiration');
      }
    }
  }
}
