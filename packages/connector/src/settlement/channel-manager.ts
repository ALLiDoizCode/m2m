/**
 * ChannelManager orchestrates automatic payment channel lifecycle management
 * Handles channel opening, deposit monitoring, idle detection, and closure
 */

import { Logger } from 'pino';
import { ChannelManagerConfig, ChannelInfo } from './channel-manager-types.js';
import { SettlementExecutor } from './settlement-executor.js';
import { PaymentChannelSDK } from './payment-channel-sdk.js';
import { TelemetryEmitter } from '../telemetry/telemetry-emitter.js';

/**
 * ChannelManager class
 * Manages payment channel lifecycle: opening, monitoring, and closing channels
 */
export class ChannelManager {
  private readonly config: ChannelManagerConfig;
  // @ts-expect-error - Reserved for future integration with SettlementExecutor
  private readonly settlementExecutor: SettlementExecutor;
  private readonly sdk: PaymentChannelSDK;
  private readonly logger: Logger;
  private readonly telemetryEmitter?: TelemetryEmitter;

  /** Map of channelId → ChannelInfo for all tracked channels */
  private readonly channelRegistry: Map<string, ChannelInfo> = new Map();

  /** Map of peerId → Set of channelIds for peer-based channel lookup */
  private readonly peerChannelIndex: Map<string, Set<string>> = new Map();

  /** Deposit monitoring interval timer */
  private depositMonitorInterval?: NodeJS.Timeout;

  /** Idle channel detection interval timer */
  private idleDetectionInterval?: NodeJS.Timeout;

  /**
   * Creates a ChannelManager instance
   * @param config - ChannelManager configuration
   * @param settlementExecutor - SettlementExecutor for settlement coordination
   * @param sdk - PaymentChannelSDK for blockchain operations
   * @param logger - Pino logger instance
   * @param telemetryEmitter - Optional telemetry emitter for dashboard events
   */
  constructor(
    config: ChannelManagerConfig,
    settlementExecutor: SettlementExecutor,
    sdk: PaymentChannelSDK,
    logger: Logger,
    telemetryEmitter?: TelemetryEmitter
  ) {
    this.config = config;
    this.settlementExecutor = settlementExecutor;
    this.sdk = sdk;
    this.logger = logger.child({ component: 'ChannelManager' });
    this.telemetryEmitter = telemetryEmitter;

    this.logger.info(
      {
        enabled: config.enabled,
        initialDepositMultiplier: config.initialDepositMultiplier,
        idleChannelThresholdMs: config.idleChannelThresholdMs,
        closeIdleChannels: config.closeIdleChannels,
      },
      'ChannelManager initialized'
    );
  }

  /**
   * Start channel monitoring intervals
   */
  start(): void {
    if (!this.config.enabled) {
      this.logger.info('ChannelManager disabled, skipping start');
      return;
    }

    this.logger.info('Starting ChannelManager monitoring');

    // Sync existing channels from blockchain
    this.syncChannelsFromBlockchain().catch((error) => {
      this.logger.error({ error }, 'Failed to sync channels from blockchain on startup');
    });

    // Start deposit monitoring interval
    const depositInterval = this.config.depositMonitoringIntervalMs || 300000; // Default 5 minutes
    this.depositMonitorInterval = setInterval(() => {
      this.monitorDepositLevels().catch((error) => {
        this.logger.error({ error }, 'Deposit monitoring cycle failed');
      });
    }, depositInterval);

    // Start idle channel detection interval
    const idleCheckInterval = this.config.idleChannelThresholdMs / 4; // Check every 1/4 of threshold
    this.idleDetectionInterval = setInterval(() => {
      this.checkIdleChannels().catch((error) => {
        this.logger.error({ error }, 'Idle channel detection cycle failed');
      });
    }, idleCheckInterval);

    this.logger.info(
      {
        depositMonitoringIntervalMs: depositInterval,
        idleDetectionIntervalMs: idleCheckInterval,
      },
      'ChannelManager monitoring started'
    );
  }

  /**
   * Stop channel monitoring intervals
   */
  stop(): void {
    this.logger.info('Stopping ChannelManager monitoring');

    if (this.depositMonitorInterval) {
      clearInterval(this.depositMonitorInterval);
      this.depositMonitorInterval = undefined;
    }

    if (this.idleDetectionInterval) {
      clearInterval(this.idleDetectionInterval);
      this.idleDetectionInterval = undefined;
    }

    this.logger.info('ChannelManager monitoring stopped');
  }

  /**
   * Track a channel in the registry
   * @param channelId - Channel identifier
   * @param peerId - Peer identifier
   * @param tokenAddress - ERC20 token address
   * @param initialDeposit - Initial deposit amount
   */
  trackChannel(
    channelId: string,
    peerId: string,
    tokenAddress: string,
    initialDeposit: bigint
  ): void {
    const channelInfo: ChannelInfo = {
      channelId,
      peerId,
      tokenAddress,
      status: 'active',
      openedAt: Date.now(),
      lastActivityAt: Date.now(),
      initialDeposit,
      currentDeposit: initialDeposit,
    };

    this.channelRegistry.set(channelId, channelInfo);

    // Update peer channel index
    if (!this.peerChannelIndex.has(peerId)) {
      this.peerChannelIndex.set(peerId, new Set());
    }
    this.peerChannelIndex.get(peerId)!.add(channelId);

    this.logger.info(
      {
        peerId,
        channelId,
        tokenAddress,
        initialDeposit: initialDeposit.toString(),
      },
      'Channel registered for tracking'
    );
  }

  /**
   * Update channel activity timestamp
   * @param channelId - Channel identifier
   */
  updateChannelActivity(channelId: string): void {
    const channelInfo = this.channelRegistry.get(channelId);
    if (channelInfo) {
      channelInfo.lastActivityAt = Date.now();
    }
  }

  /**
   * Get channel information
   * @param channelId - Channel identifier
   * @returns ChannelInfo or undefined if not tracked
   */
  getChannelInfo(channelId: string): ChannelInfo | undefined {
    return this.channelRegistry.get(channelId);
  }

  /**
   * Get all channels for a peer
   * @param peerId - Peer identifier
   * @returns Array of ChannelInfo for the peer
   */
  getChannelsForPeer(peerId: string): ChannelInfo[] {
    const channelIds = this.peerChannelIndex.get(peerId) || new Set();
    return Array.from(channelIds)
      .map((id) => this.channelRegistry.get(id)!)
      .filter((info) => info !== undefined);
  }

  /**
   * Get all tracked channels
   * @returns Array of all ChannelInfo
   */
  getAllChannels(): ChannelInfo[] {
    return Array.from(this.channelRegistry.values());
  }

  /**
   * Check if channel should be opened for peer
   * @param peerId - Peer identifier
   * @param tokenAddress - ERC20 token address
   * @returns True if new channel should be opened
   */
  shouldOpenChannel(peerId: string, tokenAddress: string): boolean {
    const channels = this.getChannelsForPeer(peerId).filter(
      (c) => c.tokenAddress === tokenAddress && c.status === 'active'
    );

    const hasActiveChannel = channels.length > 0;
    const decision = !hasActiveChannel;

    this.logger.info(
      {
        peerId,
        tokenAddress,
        existingActiveChannels: channels.length,
        decision: decision ? 'open' : 'reuse',
      },
      'Channel opening decision'
    );

    return decision;
  }

  /**
   * Open a channel for a peer
   * @param peerId - Peer identifier
   * @param tokenAddress - ERC20 token address
   * @param initialDeposit - Initial deposit amount
   * @returns Channel identifier
   */
  async openChannelForPeer(
    peerId: string,
    tokenAddress: string,
    initialDeposit: bigint
  ): Promise<string> {
    // Check if channel already exists
    if (!this.shouldOpenChannel(peerId, tokenAddress)) {
      const existingChannels = this.getChannelsForPeer(peerId).filter(
        (c) => c.tokenAddress === tokenAddress && c.status === 'active'
      );
      return existingChannels[0]?.channelId || '';
    }

    this.logger.info(
      {
        peerId,
        tokenAddress,
        initialDeposit: initialDeposit.toString(),
      },
      'Opening new channel for peer'
    );

    try {
      // This is a placeholder - actual implementation would coordinate with SettlementExecutor
      // For now, we define the method signature for future integration
      throw new Error(
        'openChannelForPeer not yet implemented - use SettlementExecutor integration'
      );
    } catch (error) {
      this.logger.error(
        {
          error,
          peerId,
          tokenAddress,
        },
        'Failed to open channel for peer'
      );
      throw error;
    }
  }

  /**
   * Calculate initial deposit based on settlement threshold
   * @param peerId - Peer identifier
   * @param tokenId - Token identifier
   * @param currentBalance - Current balance requiring settlement
   * @returns Calculated initial deposit amount
   */
  calculateInitialDeposit(peerId: string, tokenId: string, currentBalance: bigint): bigint {
    const threshold = this.getSettlementThreshold(tokenId);
    const multiplier = this.getDepositMultiplier(tokenId);

    let calculatedDeposit = threshold * BigInt(multiplier);

    // Ensure deposit covers current balance
    if (calculatedDeposit < currentBalance) {
      calculatedDeposit = currentBalance;
    }

    // Cap at maximum (100x threshold) to limit locked funds
    const maxDeposit = threshold * 100n;
    if (calculatedDeposit > maxDeposit) {
      calculatedDeposit = maxDeposit;
    }

    this.logger.info(
      {
        peerId,
        tokenId,
        threshold: threshold.toString(),
        multiplier,
        currentBalance: currentBalance.toString(),
        calculatedDeposit: calculatedDeposit.toString(),
      },
      'Initial deposit calculated'
    );

    // Emit telemetry
    this.emitTelemetry('INITIAL_DEPOSIT_CALCULATED', {
      peerId,
      tokenId,
      threshold: threshold.toString(),
      multiplier,
      calculatedDeposit: calculatedDeposit.toString(),
    });

    return calculatedDeposit;
  }

  /**
   * Monitor deposit levels for all active channels
   * @private
   */
  private async monitorDepositLevels(): Promise<void> {
    const activeChannels = this.getAllChannels().filter((c) => c.status === 'active');

    for (const channelInfo of activeChannels) {
      try {
        const state = await this.sdk.getChannelState(channelInfo.channelId);

        // Update current deposit from blockchain
        const currentDeposit = state.myDeposit;
        channelInfo.currentDeposit = currentDeposit;

        // Check if below threshold
        const threshold = BigInt(
          this.config.minDepositThreshold * Number(channelInfo.initialDeposit)
        );

        if (currentDeposit < threshold) {
          this.logger.warn(
            {
              channelId: channelInfo.channelId,
              peerId: channelInfo.peerId,
              currentDeposit: currentDeposit.toString(),
              threshold: threshold.toString(),
              initialDeposit: channelInfo.initialDeposit.toString(),
            },
            'Channel deposit below threshold, initiating top-up'
          );

          // Check if critically low (10%)
          const criticalThreshold = channelInfo.initialDeposit / 10n;
          if (currentDeposit < criticalThreshold) {
            this.emitTelemetry('CHANNEL_DEPOSIT_CRITICAL', {
              channelId: channelInfo.channelId,
              peerId: channelInfo.peerId,
              currentDeposit: currentDeposit.toString(),
              criticalThreshold: criticalThreshold.toString(),
            });
          }

          await this.topUpChannel(channelInfo.channelId, channelInfo);
        }
      } catch (error) {
        this.logger.error(
          {
            error,
            channelId: channelInfo.channelId,
            peerId: channelInfo.peerId,
          },
          'Failed to monitor deposit level for channel'
        );
        // Continue with other channels
      }
    }
  }

  /**
   * Top up a channel's deposit
   * @private
   */
  private async topUpChannel(channelId: string, channelInfo: ChannelInfo): Promise<void> {
    const topUpAmount = channelInfo.initialDeposit - channelInfo.currentDeposit;

    this.logger.info(
      {
        channelId,
        peerId: channelInfo.peerId,
        topUpAmount: topUpAmount.toString(),
        currentDeposit: channelInfo.currentDeposit.toString(),
        targetDeposit: channelInfo.initialDeposit.toString(),
      },
      'Topping up channel deposit'
    );

    try {
      await this.sdk.deposit(channelId, topUpAmount);

      // Update current deposit
      channelInfo.currentDeposit += topUpAmount;

      this.logger.info(
        {
          channelId,
          peerId: channelInfo.peerId,
          topUpAmount: topUpAmount.toString(),
          newDeposit: channelInfo.currentDeposit.toString(),
        },
        'Channel deposit topped up'
      );

      this.emitTelemetry('CHANNEL_DEPOSIT_TOPPED_UP', {
        channelId,
        peerId: channelInfo.peerId,
        topUpAmount: topUpAmount.toString(),
        newDeposit: channelInfo.currentDeposit.toString(),
      });
    } catch (error) {
      this.logger.error(
        {
          error,
          channelId,
          peerId: channelInfo.peerId,
          topUpAmount: topUpAmount.toString(),
        },
        'Failed to top up channel deposit'
      );

      // Check for insufficient wallet balance
      if (error instanceof Error && error.message.includes('insufficient')) {
        this.logger.error(
          {
            channelId,
            peerId: channelInfo.peerId,
          },
          'CRITICAL: Insufficient wallet balance for channel top-up - operator intervention required'
        );

        this.emitTelemetry('CHANNEL_TOPUP_INSUFFICIENT_BALANCE', {
          channelId,
          peerId: channelInfo.peerId,
          requiredAmount: topUpAmount.toString(),
        });
      }

      throw error;
    }
  }

  /**
   * Detect idle channels
   * @private
   */
  private async detectIdleChannels(): Promise<ChannelInfo[]> {
    const now = Date.now();
    const idleChannels: ChannelInfo[] = [];

    for (const channelInfo of this.getAllChannels()) {
      if (channelInfo.status !== 'active') {
        continue;
      }

      const idleDuration = now - channelInfo.lastActivityAt;

      if (idleDuration > this.config.idleChannelThresholdMs) {
        this.logger.info(
          {
            channelId: channelInfo.channelId,
            peerId: channelInfo.peerId,
            lastActivityAt: channelInfo.lastActivityAt,
            idleDuration,
            threshold: this.config.idleChannelThresholdMs,
          },
          'Idle channel detected'
        );

        this.emitTelemetry('CHANNEL_IDLE_DETECTED', {
          channelId: channelInfo.channelId,
          peerId: channelInfo.peerId,
          idleDuration,
        });

        idleChannels.push(channelInfo);
      }
    }

    return idleChannels;
  }

  /**
   * Check for idle channels and close them
   * @private
   */
  private async checkIdleChannels(): Promise<void> {
    if (!this.config.closeIdleChannels) {
      return;
    }

    const idleChannels = await this.detectIdleChannels();

    for (const channelInfo of idleChannels) {
      try {
        await this.closeIdleChannel(channelInfo);
      } catch (error) {
        this.logger.error(
          {
            error,
            channelId: channelInfo.channelId,
            peerId: channelInfo.peerId,
          },
          'Failed to close idle channel'
        );
        // Continue with other channels
      }
    }
  }

  /**
   * Close an idle channel
   * @private
   */
  private async closeIdleChannel(channelInfo: ChannelInfo): Promise<void> {
    // Validate channel is actually idle
    const idleDuration = Date.now() - channelInfo.lastActivityAt;
    if (idleDuration <= this.config.idleChannelThresholdMs) {
      this.logger.warn(
        {
          channelId: channelInfo.channelId,
          idleDuration,
          threshold: this.config.idleChannelThresholdMs,
        },
        'Channel no longer idle, skipping closure'
      );
      return;
    }

    this.logger.info(
      {
        channelId: channelInfo.channelId,
        peerId: channelInfo.peerId,
        idleDuration,
      },
      'Closing idle channel'
    );

    // Update status
    channelInfo.status = 'closing';

    // Attempt cooperative closure
    const cooperativeSuccess = await this.attemptCooperativeClose(channelInfo);

    if (!cooperativeSuccess) {
      // Fallback to unilateral close
      this.logger.info(
        {
          channelId: channelInfo.channelId,
          reason: 'cooperative_failed',
        },
        'Falling back to unilateral close'
      );
      await this.handleDisputedClosure(channelInfo);
    }
  }

  /**
   * Attempt cooperative channel closure
   * @private
   */
  private async attemptCooperativeClose(channelInfo: ChannelInfo): Promise<boolean> {
    // MVP limitation: Cooperative closure not implemented (requires BTP protocol integration)
    this.logger.info(
      {
        channelId: channelInfo.channelId,
        peerId: channelInfo.peerId,
      },
      'Cooperative closure not implemented in MVP, will use unilateral close'
    );

    return false; // Always return false in MVP, triggering unilateral close
  }

  /**
   * Handle disputed closure (unilateral close)
   * @private
   */
  private async handleDisputedClosure(channelInfo: ChannelInfo): Promise<void> {
    this.logger.info(
      {
        channelId: channelInfo.channelId,
        peerId: channelInfo.peerId,
      },
      'Initiating unilateral channel closure'
    );

    try {
      // Close channel unilaterally
      // Note: In production, we would need to get the latest balance proof from SettlementExecutor
      // For now, we'll create a placeholder balance proof
      const placeholderBalanceProof = {
        channelId: channelInfo.channelId,
        nonce: 0,
        transferredAmount: 0n,
        lockedAmount: 0n,
        locksRoot: '0x' + '0'.repeat(64),
      };
      await this.sdk.closeChannel(channelInfo.channelId, placeholderBalanceProof, '0x');

      // Record closure timestamp
      channelInfo.closedAt = Date.now();
      channelInfo.status = 'closing';

      this.logger.info(
        {
          channelId: channelInfo.channelId,
          peerId: channelInfo.peerId,
          closedAt: channelInfo.closedAt,
        },
        'Unilateral channel closure initiated'
      );

      this.emitTelemetry('CHANNEL_CLOSED_IDLE', {
        channelId: channelInfo.channelId,
        peerId: channelInfo.peerId,
        closureType: 'unilateral',
        idleDuration: Date.now() - channelInfo.lastActivityAt,
      });

      this.emitTelemetry('CHANNEL_CLOSURE_DISPUTED', {
        channelId: channelInfo.channelId,
        peerId: channelInfo.peerId,
        reason: 'cooperative_timeout',
      });
    } catch (error) {
      this.logger.error(
        {
          error,
          channelId: channelInfo.channelId,
          peerId: channelInfo.peerId,
        },
        'Failed to initiate unilateral closure'
      );
      throw error;
    }
  }

  /**
   * Sync existing channels from blockchain on startup
   * @private
   */
  private async syncChannelsFromBlockchain(): Promise<void> {
    this.logger.info('Syncing channels from blockchain');
    // Placeholder for future implementation
    // Would query SDK for existing channels and populate channelRegistry
    this.logger.info('Channel sync from blockchain not yet implemented');
  }

  /**
   * Get settlement threshold for a token
   * @private
   */
  private getSettlementThreshold(_tokenId: string): bigint {
    // Placeholder - would read from Epic 6 SettlementMonitor config
    // For now, return default value
    const defaultThreshold = 1000000n; // 1 token with 6 decimals
    return defaultThreshold;
  }

  /**
   * Get deposit multiplier for a token
   * @private
   */
  private getDepositMultiplier(tokenId: string): number {
    // Check for token-specific override
    const tokenOverride = this.config.tokenOverrides?.[tokenId];
    if (tokenOverride?.initialDepositMultiplier !== undefined) {
      return tokenOverride.initialDepositMultiplier;
    }

    // Return default multiplier
    return this.config.initialDepositMultiplier;
  }

  /**
   * Emit telemetry event (non-blocking)
   * @private
   */
  private emitTelemetry(eventType: string, payload: Record<string, unknown>): void {
    if (!this.telemetryEmitter) {
      return;
    }

    try {
      // Emit telemetry with flexible event type
      // Type assertion needed as we're extending the base telemetry types
      this.telemetryEmitter.emit({
        type: eventType as never,
        timestamp: new Date().toISOString(),
        ...payload,
      } as never);
    } catch (error) {
      this.logger.error(
        {
          error,
          eventType,
        },
        'Failed to emit telemetry event'
      );
      // Non-blocking - do not throw
    }
  }
}
