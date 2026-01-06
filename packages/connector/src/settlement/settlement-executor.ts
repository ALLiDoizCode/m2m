// Settlement Executor - Integrates Payment Channel SDK with Settlement Monitor
// Epic 8 Story 8.8 - Settlement Engine Integration with Payment Channels

import { PaymentChannelSDK } from './payment-channel-sdk.js';
import { ChannelState, BalanceProof } from './payment-channel-types.js';
import {
  SettlementExecutorConfig,
  InsufficientGasError,
  ChannelDisputeError,
} from './settlement-executor-types.js';
import { AccountManager } from './account-manager.js';
import { SettlementMonitor } from './settlement-monitor.js';
import { SettlementTriggerEvent } from '../config/types.js';
import { Logger } from '../utils/logger.js';
import { TelemetryEmitter } from '../telemetry/telemetry-emitter.js';
import { TelemetryEvent } from '@m2m/shared';

/**
 * SettlementExecutor
 *
 * Automatically executes payment channel settlements when TigerBeetle balances exceed thresholds.
 * Listens to SettlementMonitor SETTLEMENT_REQUIRED events, manages payment channels via SDK,
 * signs balance proofs, and updates TigerBeetle accounts after settlement.
 *
 * Integration Points:
 * - SettlementMonitor (Epic 6): Receives settlement trigger events
 * - PaymentChannelSDK (Story 8.7): Manages blockchain payment channels
 * - AccountManager (Epic 6): Updates TigerBeetle accounts after settlement
 * - TelemetryEmitter: Emits settlement lifecycle events for dashboard
 *
 * Flow:
 * 1. SettlementMonitor emits SETTLEMENT_REQUIRED event
 * 2. SettlementExecutor finds or opens payment channel for peer
 * 3. Signs balance proof with new transferred amount
 * 4. Updates TigerBeetle accounts to zero out settled balance
 * 5. Emits telemetry for dashboard visualization
 */
export class SettlementExecutor {
  private readonly config: SettlementExecutorConfig;
  private readonly accountManager: AccountManager;
  private readonly settlementMonitor: SettlementMonitor;
  private readonly logger: Logger;
  private readonly telemetryEmitter?: TelemetryEmitter;
  private readonly sdk: PaymentChannelSDK;

  /** Mapping of peerId to channelId for channel discovery */
  private readonly peerChannelMap: Map<string, string> = new Map();

  /** Active settlements to prevent duplicate triggers for same peer */
  private readonly activeSettlements: Map<string, Promise<void>> = new Map();

  /** Completed settlements tracking for idempotency (settlementId → completed) */
  private readonly completedSettlements: Set<string> = new Set();

  /** Signed balance proofs storage (MVP: in-memory, future: persistent DB) */
  private readonly signedProofs: Map<
    string,
    Array<{ balanceProof: BalanceProof; signature: string }>
  > = new Map();

  /**
   * Create SettlementExecutor instance
   *
   * @param config - Settlement executor configuration
   * @param accountManager - TigerBeetle account manager (Epic 6)
   * @param settlementMonitor - Settlement monitor (Epic 6)
   * @param logger - Pino logger instance
   * @param telemetryEmitter - Optional telemetry emitter for dashboard
   */
  constructor(
    config: SettlementExecutorConfig,
    accountManager: AccountManager,
    settlementMonitor: SettlementMonitor,
    logger: Logger,
    telemetryEmitter?: TelemetryEmitter
  ) {
    this.config = config;
    this.accountManager = accountManager;
    this.settlementMonitor = settlementMonitor;
    this.logger = logger;
    this.telemetryEmitter = telemetryEmitter;

    // Initialize Payment Channel SDK
    this.sdk = new PaymentChannelSDK(config.paymentChannelSDKConfig);
  }

  /**
   * Start settlement executor
   * Registers settlement event listener and starts SDK event polling
   */
  start(): void {
    // Register listener for settlement triggers from SettlementMonitor
    this.settlementMonitor.on('SETTLEMENT_REQUIRED', this.handleSettlement.bind(this));

    // Start SDK event polling for blockchain events
    this.sdk.startEventPolling();

    this.logger.info('SettlementExecutor started, listening for settlement triggers');
  }

  /**
   * Stop settlement executor
   * Unregisters listener and stops SDK event polling
   */
  stop(): void {
    // Unregister listener
    this.settlementMonitor.off('SETTLEMENT_REQUIRED', this.handleSettlement.bind(this));

    // Stop SDK event polling
    this.sdk.stopEventPolling();

    this.logger.info('SettlementExecutor stopped');
  }

  /**
   * Handle settlement trigger event from SettlementMonitor
   * Entry point for settlement execution flow
   *
   * @param event - Settlement trigger event from Epic 6 SettlementMonitor
   */
  private async handleSettlement(event: SettlementTriggerEvent): Promise<void> {
    const { peerId, tokenId, currentBalance } = event;
    const balance = currentBalance; // Amount peer owes us (accounts receivable)

    this.logger.info({ peerId, tokenId, balance }, 'Settlement triggered by monitor');
    this.emitTelemetry('SETTLEMENT_PENDING', { peerId, balance: balance.toString() });

    // Check if settlement already active for this peer
    if (this.activeSettlements.has(peerId)) {
      this.logger.warn({ peerId }, 'Settlement already in progress for peer, skipping');
      return;
    }

    // Execute settlement with retry logic
    const settlementPromise = this.retrySettlement(
      () => this.executeSettlement(peerId, balance),
      peerId
    );

    // Track active settlement
    this.activeSettlements.set(peerId, settlementPromise);

    try {
      await settlementPromise;
    } catch (error) {
      this.logger.error(
        { peerId, error: error instanceof Error ? error.message : String(error) },
        'Settlement failed after all retries'
      );
      this.emitTelemetry('SETTLEMENT_FAILED', {
        peerId,
        balance: balance.toString(),
        reason: error instanceof Error ? error.name : 'unknown',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Remove from active settlements
      this.activeSettlements.delete(peerId);
    }
  }

  /**
   * Execute settlement for a peer
   * Routes to appropriate handler based on channel existence
   *
   * @param peerId - Peer ID to settle with
   * @param balance - Settlement amount (from TigerBeetle credit balance)
   */
  private async executeSettlement(peerId: string, balance: bigint): Promise<void> {
    const settlementStartTime = Date.now();

    // Find existing channel for peer
    const channelId = await this.findChannelForPeer(peerId, this.config.settlementTokenAddress);

    let finalChannelId: string;

    if (!channelId) {
      // No existing channel, open new one
      await this.openChannelAndSettle(peerId, balance);
      finalChannelId = this.peerChannelMap.get(peerId)!;
    } else {
      // Use existing channel
      await this.settleViaExistingChannel(channelId, balance);
      finalChannelId = channelId;
    }

    // Update TigerBeetle accounts after settlement
    await this.updateTigerBeetleAccounts(peerId, balance);

    // Emit success telemetry
    const duration = Date.now() - settlementStartTime;
    this.emitTelemetry('SETTLEMENT_COMPLETED', {
      peerId,
      channelId: finalChannelId,
      balance: balance.toString(),
      duration,
    });

    this.logger.info(
      { peerId, channelId: finalChannelId, balance, duration },
      'Settlement completed successfully'
    );
  }

  /**
   * Find existing payment channel for peer
   *
   * @param peerId - Peer ID
   * @param tokenAddress - Token address for channel
   * @returns Channel ID if found and active, null otherwise
   */
  private async findChannelForPeer(peerId: string, _tokenAddress: string): Promise<string | null> {
    // Check in-memory cache
    const cachedChannelId = this.peerChannelMap.get(peerId);

    if (!cachedChannelId) {
      return null;
    }

    // Verify channel still active
    const channelState = await this.sdk.getChannelState(cachedChannelId);

    if (channelState.status === 'opened') {
      return cachedChannelId;
    }

    // Channel closed or settled, remove from cache
    this.peerChannelMap.delete(peerId);
    return null;
  }

  /**
   * Open new payment channel and execute initial settlement
   *
   * @param peerId - Peer ID
   * @param balance - Settlement amount
   */
  private async openChannelAndSettle(peerId: string, balance: bigint): Promise<void> {
    // Resolve peer Ethereum address
    const peerAddress = this.resolvePeerAddress(peerId);

    // Calculate initial deposit (must cover settlement amount)
    let initialDeposit = this.config.defaultInitialDeposit;
    if (balance > initialDeposit) {
      // Use 2x balance for buffer
      initialDeposit = balance * 2n;
    }

    this.logger.info(
      { peerId, peerAddress, initialDeposit },
      'Opening payment channel for settlement'
    );

    // Open payment channel
    const channelId = await this.sdk.openChannel(
      peerAddress,
      this.config.settlementTokenAddress,
      this.config.defaultSettlementTimeout,
      initialDeposit
    );

    this.logger.info({ peerId, channelId, initialDeposit }, 'Payment channel opened');
    this.emitTelemetry('CHANNEL_OPENED', {
      peerId,
      channelId,
      balance: initialDeposit.toString(),
    });

    // Cache channel mapping
    this.peerChannelMap.set(peerId, channelId);

    // Sign initial balance proof (nonce=1 for first proof)
    const signature = await this.sdk.signBalanceProof(channelId, 1, balance);

    // Store signed proof (MVP: in-memory storage)
    this.storeSignedProof(channelId, {
      balanceProof: {
        channelId,
        nonce: 1,
        transferredAmount: balance,
        lockedAmount: 0n,
        locksRoot: '0x' + '0'.repeat(64),
      },
      signature,
    });

    this.logger.info(
      { channelId, nonce: 1, balance },
      'Initial balance proof signed for new channel'
    );
  }

  /**
   * Settle via existing payment channel
   * Signs new balance proof with incremented nonce
   *
   * @param channelId - Existing channel ID
   * @param amount - Settlement amount to add
   */
  private async settleViaExistingChannel(channelId: string, amount: bigint): Promise<void> {
    // Get current channel state
    const channelState = await this.sdk.getChannelState(channelId);

    // Verify channel is opened
    if (channelState.status !== 'opened') {
      throw new ChannelDisputeError(
        channelId,
        `Channel status is ${channelState.status}, expected 'opened'`
      );
    }

    // Calculate new balance proof values
    const newNonce = channelState.myNonce + 1;
    const newTransferred = channelState.myTransferred + amount;

    // Validate transferred amount doesn't exceed deposit
    if (newTransferred > channelState.myDeposit) {
      // Need to deposit more funds first
      await this.handleInsufficientDeposit(channelId, newTransferred, channelState.myDeposit);
      // Retry after deposit (state updated)
      return this.settleViaExistingChannel(channelId, amount);
    }

    // Validate balance proof fields
    this.validateBalanceProof(newNonce, newTransferred, channelState);

    // Sign balance proof
    const signature = await this.sdk.signBalanceProof(channelId, newNonce, newTransferred);

    this.logger.info(
      { channelId, newNonce, newTransferred, amount },
      'Balance proof signed for settlement'
    );

    // Store signed proof
    this.storeSignedProof(channelId, {
      balanceProof: {
        channelId,
        nonce: newNonce,
        transferredAmount: newTransferred,
        lockedAmount: 0n,
        locksRoot: '0x' + '0'.repeat(64),
      },
      signature,
    });

    // Log ready for cooperative settlement (MVP: off-chain only)
    this.logger.info(
      {
        channelId,
        signature,
        balanceProof: { channelId, newNonce, newTransferred },
      },
      'Balance proof ready for cooperative settlement (off-chain only for MVP)'
    );
  }

  /**
   * Handle insufficient channel deposit
   * Deposits additional funds to cover settlement
   *
   * @param channelId - Channel ID
   * @param requiredAmount - Required transferred amount
   * @param currentDeposit - Current deposit
   */
  private async handleInsufficientDeposit(
    channelId: string,
    requiredAmount: bigint,
    currentDeposit: bigint
  ): Promise<void> {
    // Calculate additional deposit needed (with 20% buffer)
    const additionalDeposit = ((requiredAmount - currentDeposit) * 120n) / 100n;

    this.logger.info(
      { channelId, additionalDeposit, requiredAmount, currentDeposit },
      'Adding funds to channel before settlement'
    );

    // Deposit additional funds
    await this.sdk.deposit(channelId, additionalDeposit);

    this.logger.info({ channelId, additionalDeposit }, 'Successfully deposited additional funds');
  }

  /**
   * Validate balance proof fields before signing
   *
   * @param newNonce - New nonce value
   * @param newTransferred - New transferred amount
   * @param channelState - Current channel state
   */
  private validateBalanceProof(
    newNonce: number,
    newTransferred: bigint,
    channelState: ChannelState
  ): void {
    // Nonce must increase monotonically
    if (newNonce <= channelState.myNonce) {
      throw new Error(
        `Invalid nonce: ${newNonce} must be greater than current ${channelState.myNonce}`
      );
    }

    // Transferred amount must not decrease
    if (newTransferred < channelState.myTransferred) {
      throw new Error(
        `Invalid transferred amount: ${newTransferred} less than current ${channelState.myTransferred}`
      );
    }

    // Transferred amount must not exceed deposit (with small tolerance)
    const tolerance = 1000n; // Small buffer for precision
    if (newTransferred > channelState.myDeposit + tolerance) {
      throw new Error(
        `Transferred amount ${newTransferred} exceeds deposit ${channelState.myDeposit}`
      );
    }
  }

  /**
   * Store signed balance proof (MVP: in-memory, future: persistent DB)
   *
   * @param channelId - Channel ID
   * @param signedProof - Signed balance proof
   */
  private storeSignedProof(
    channelId: string,
    signedProof: {
      balanceProof: BalanceProof;
      signature: string;
    }
  ): void {
    if (!this.signedProofs.has(channelId)) {
      this.signedProofs.set(channelId, []);
    }
    this.signedProofs.get(channelId)!.push(signedProof);
  }

  /**
   * Update TigerBeetle accounts after settlement
   * Records settlement to zero out owed balance
   *
   * @param peerId - Peer ID
   * @param settledAmount - Amount settled on blockchain
   */
  private async updateTigerBeetleAccounts(peerId: string, settledAmount: bigint): Promise<void> {
    // For MVP: hardcode tokenId = 'ILP' (single currency)
    const tokenId = 'ILP';

    // Generate settlement ID for idempotency
    const channelId = this.peerChannelMap.get(peerId) || 'unknown';
    const settlementId = `${peerId}-${channelId}-${Date.now()}`;

    // Check if already completed
    if (this.completedSettlements.has(settlementId)) {
      this.logger.info(
        { settlementId },
        'Settlement already completed, skipping TigerBeetle update'
      );
      return;
    }

    try {
      // Record settlement in AccountManager
      await this.accountManager.recordSettlement(peerId, tokenId, settledAmount);

      this.logger.info(
        { peerId, tokenId, settledAmount },
        'TigerBeetle accounts updated after settlement'
      );

      // Emit telemetry
      this.emitTelemetry('ACCOUNTS_UPDATED', {
        peerId,
        settledAmount: settledAmount.toString(),
      });

      // Mark as completed
      this.completedSettlements.add(settlementId);
    } catch (error) {
      this.logger.error(
        { peerId, settledAmount, error: error instanceof Error ? error.message : String(error) },
        'Failed to update TigerBeetle accounts'
      );
      throw error; // Re-throw as this is critical
    }
  }

  /**
   * Retry settlement execution with exponential backoff
   *
   * @param fn - Settlement function to retry
   * @param peerId - Peer ID for logging
   */
  private async retrySettlement(fn: () => Promise<void>, peerId: string): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
      try {
        await fn();
        return; // Success
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check for non-retryable errors
        if (error instanceof InsufficientGasError) {
          this.logger.error(
            { peerId, error: lastError.message },
            'Settlement failed: insufficient gas. Fund wallet and retry manually.'
          );
          this.emitTelemetry('SETTLEMENT_FAILED', {
            peerId,
            reason: 'insufficient_gas',
            error: lastError.message,
          });
          throw error; // Don't retry
        }

        // Handle channel dispute (open new channel and retry)
        if (error instanceof ChannelDisputeError) {
          this.logger.warn(
            { peerId, channelId: error.channelId, error: lastError.message },
            'Channel dispute detected, opening new channel'
          );
          this.peerChannelMap.delete(peerId); // Remove from cache
          this.emitTelemetry('CHANNEL_DISPUTED', {
            peerId,
            channelId: error.channelId,
            error: lastError.message,
          });
          // Continue to retry (will open new channel)
        }

        // Check if max retries reached
        if (attempt === this.config.retryAttempts) {
          throw lastError; // Max retries exceeded
        }

        // Calculate delay with exponential backoff
        const delayMs = this.config.retryDelayMs * Math.pow(2, attempt - 1);

        this.logger.warn(
          { peerId, attempt, error: lastError.message, delayMs },
          'Settlement attempt failed, retrying...'
        );

        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError || new Error('Settlement failed with unknown error');
  }

  /**
   * Resolve peer Ethereum address from peerId
   *
   * @param peerId - Peer ID
   * @returns Ethereum address for peer
   * @throws Error if peer address not found in config
   */
  private resolvePeerAddress(peerId: string): string {
    const address = this.config.peerAddressMap[peerId];

    if (!address) {
      throw new Error(`Peer address not found for ${peerId}. Check peerAddressMap configuration.`);
    }

    return address;
  }

  /**
   * Emit telemetry event for settlement lifecycle
   * Non-blocking: failures don't affect settlement execution
   *
   * @param type - Telemetry event type
   * @param data - Event data
   */
  private emitTelemetry(type: string, data: object): void {
    if (!this.telemetryEmitter) {
      return;
    }

    try {
      const event = {
        type,
        timestamp: Date.now(),
        nodeId: this.config.nodeId || 'unknown',
        ...data,
      };

      this.telemetryEmitter.emit(event as TelemetryEvent);
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to emit telemetry'
      );
    }
  }
}
