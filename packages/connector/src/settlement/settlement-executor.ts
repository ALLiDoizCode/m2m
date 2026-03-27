/**
 * Settlement Executor - Automated On-Chain Settlement via Payment Channels
 *
 * This module implements the SettlementExecutor class which bridges Epic 6's
 * TigerBeetle accounting system with chain-agnostic payment channel providers via ChainProviderRegistry (Epic 32).
 *
 * **Functionality:**
 * - Listens to SETTLEMENT_REQUIRED events from SettlementMonitor (Epic 6 Story 6.6)
 * - Opens new payment channels when no channel exists for a peer
 * - Signs balance proofs and executes cooperative settlements via existing channels
 * - Updates TigerBeetle accounts after successful on-chain settlement
 * - Handles settlement failures with retry logic
 *
 * **Integration Points:**
 * - SettlementMonitor: Receives SETTLEMENT_REQUIRED events (Epic 6 Story 6.6)
 * - ChainProviderRegistry: Resolves chain-specific PaymentChannelProvider (Epic 32)
 * - PaymentChannelProvider: Executes blockchain operations via chain-agnostic interface
 * - AccountManager: Updates TigerBeetle balances (Epic 6 Story 6.4)
 *
 * Source: Epic 32 Story 32.5 - Refactor SettlementExecutor for Multi-Chain
 *
 * @module settlement/settlement-executor
 */

import EventEmitter from 'events';
import { Logger } from 'pino';
import { SettlementState, SettlementTriggerEvent } from '../config/types';
import { AccountManager } from './account-manager';
import { SettlementMonitor } from './settlement-monitor';
import type { PerPacketClaimService } from './per-packet-claim-service';
import { isEVMClaim } from '../btp/btp-claim-types';
import type { ChainProviderRegistry } from './provider/chain-provider-registry';
import type {
  PaymentChannelProvider,
  BalanceProofParams,
} from './provider/payment-channel-provider';
import type { ChannelManager } from './channel-manager';

/**
 * Configuration interface for SettlementExecutor
 *
 * @interface SettlementExecutorConfig
 * @property nodeId - Our connector node ID
 * @property defaultSettlementTimeout - Default challenge period for new channels (seconds, e.g., 86400 = 24h)
 * @property initialDepositMultiplier - Channel initial deposit = threshold × multiplier (default: 10)
 * @property minDepositThreshold - Add funds when deposit < threshold × multiplier × minDepositThreshold (default: 0.5)
 * @property maxRetries - Maximum retry attempts for transient failures (default: 3)
 * @property retryDelayMs - Initial retry delay in milliseconds (default: 5000ms)
 * @property tokenAddressMap - Maps tokenId (e.g., "M2M", "USDC") to ERC20 contract address
 * @property peerIdToAddressMap - Maps peerId (e.g., "connector-b") to Ethereum address
 * @property peerIdToChainMap - Maps peerId to chain identifier (e.g., "evm:anvil:31337")
 */
export interface SettlementExecutorConfig {
  nodeId: string;
  defaultSettlementTimeout: number;
  initialDepositMultiplier: number;
  minDepositThreshold: number;
  maxRetries: number;
  retryDelayMs: number;
  tokenAddressMap: Map<string, string>;
  peerIdToAddressMap: Map<string, string>;
  peerIdToChainMap: Map<string, string>;
}

/**
 * SettlementExecutor Class
 *
 * Executes automated on-chain settlements via payment channels when
 * TigerBeetle balances exceed configured thresholds.
 *
 * **Settlement Flow:**
 * 1. Receive SETTLEMENT_REQUIRED event from SettlementMonitor
 * 2. Mark settlement as IN_PROGRESS in SettlementMonitor
 * 3. Check if payment channel exists for peer
 * 4a. If no channel: Open new channel with initial deposit
 * 4b. If channel exists: Generate balance proof and cooperative settle
 * 5. Update TigerBeetle accounts after on-chain confirmation
 * 6. Mark settlement as COMPLETED in SettlementMonitor
 * 7. Log settlement outcome
 *
 * **Error Handling:**
 * - Transient errors (network failures, gas spikes): Retry with exponential backoff
 * - Permanent errors (insufficient funds, channel closed): Log error, halt
 * - Settlement failures leave state as IN_PROGRESS for manual intervention
 *
 * @class SettlementExecutor
 * @extends EventEmitter
 */
export class SettlementExecutor extends EventEmitter {
  private readonly config: SettlementExecutorConfig;
  private readonly accountManager: AccountManager;
  private readonly chainProviderRegistry: ChainProviderRegistry;
  private readonly settlementMonitor: SettlementMonitor;
  private readonly logger: Logger;
  private readonly boundHandleSettlement: (event: SettlementTriggerEvent) => void;
  private perPacketClaimService: PerPacketClaimService | null = null;
  private channelManager: ChannelManager | null = null;

  /**
   * Settlement chain serializes all on-chain operations to prevent nonce collisions.
   * Each settlement is chained onto this promise so they execute sequentially.
   */
  private settlementChain: Promise<void> = Promise.resolve();

  /**
   * Flag to reject new settlements during shutdown.
   * Set to true in stop() before awaiting in-flight settlements.
   */
  private stopping = false;

  /**
   * Constructor
   *
   * Initializes the settlement executor with required dependencies.
   * Binds event handler ONCE in constructor to enable proper cleanup.
   *
   * @param config - Settlement executor configuration
   * @param accountManager - TigerBeetle account manager
   * @param chainProviderRegistry - Chain provider registry for resolving blockchain providers
   * @param settlementMonitor - Settlement threshold monitor
   * @param logger - Pino logger instance
   */
  constructor(
    config: SettlementExecutorConfig,
    accountManager: AccountManager,
    chainProviderRegistry: ChainProviderRegistry,
    settlementMonitor: SettlementMonitor,
    logger: Logger
  ) {
    super();
    this.config = config;
    this.accountManager = accountManager;
    this.chainProviderRegistry = chainProviderRegistry;
    this.settlementMonitor = settlementMonitor;

    // Create child logger with component context
    this.logger = logger.child({ component: 'settlement-executor' });

    // CRITICAL: Bind event handler ONCE in constructor for proper cleanup
    // Source: docs/architecture/test-strategy-and-standards.md Anti-Pattern 1
    this.boundHandleSettlement = this.handleSettlement.bind(this);

    this.logger.info(
      {
        nodeId: config.nodeId,
        defaultSettlementTimeout: config.defaultSettlementTimeout,
      },
      'Settlement executor initialized'
    );
  }

  /**
   * Set PerPacketClaimService for using latest per-packet claims in on-chain settlement
   * @param service - PerPacketClaimService instance
   */
  setPerPacketClaimService(service: PerPacketClaimService): void {
    this.perPacketClaimService = service;
    this.logger.info('PerPacketClaimService set for on-chain settlement');
  }

  /**
   * Set ChannelManager for chain-agnostic channel lookup
   * @param channelManager - ChannelManager instance
   */
  setChannelManager(channelManager: ChannelManager): void {
    this.channelManager = channelManager;
    this.logger.info('ChannelManager set for channel lookup');
  }

  /**
   * Start listening for settlement events
   *
   * Registers event listener for SETTLEMENT_REQUIRED events from SettlementMonitor.
   * Uses stored bound handler reference for proper cleanup in stop().
   *
   * Source: docs/architecture/test-strategy-and-standards.md Anti-Pattern 1
   */
  start(): void {
    this.stopping = false;
    this.settlementChain = Promise.resolve();
    this.settlementMonitor.on('SETTLEMENT_REQUIRED', this.boundHandleSettlement);
    this.logger.info('Settlement executor started');
  }

  /**
   * Stop listening for settlement events and await in-flight settlements
   *
   * 1. Sets stopping flag to reject new settlement events
   * 2. Unregisters event listener to prevent future events
   * 3. Awaits the settlement chain to drain all in-flight operations
   *
   * This ensures no settlement is left partially completed on shutdown,
   * preventing on-chain/off-chain balance mismatches.
   *
   * Source: docs/architecture/test-strategy-and-standards.md Anti-Pattern 1
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.settlementMonitor.off('SETTLEMENT_REQUIRED', this.boundHandleSettlement);

    // Await all in-flight settlements to complete before returning
    await this.settlementChain;
    this.logger.info('Settlement executor stopped (all in-flight settlements drained)');
  }

  /**
   * Handle settlement event
   *
   * Enqueues the settlement onto the serial settlement chain.
   * This ensures all on-chain transactions from the same wallet execute
   * sequentially, preventing nonce collisions on L2/mainnet.
   *
   * Events received after stop() is called are silently dropped.
   *
   * @param event - Settlement trigger event from SettlementMonitor
   * @private
   */
  private handleSettlement(event: SettlementTriggerEvent): void {
    if (this.stopping) {
      this.logger.warn(
        { peerId: event.peerId, tokenId: event.tokenId },
        'Settlement event ignored during shutdown'
      );
      return;
    }

    // Chain this settlement onto the queue — serializes all on-chain operations
    // to prevent nonce collisions from concurrent EVM transactions.
    this.settlementChain = this.settlementChain.then(() => this._processSettlement(event));
  }

  /**
   * Process a single settlement event
   *
   * Inner implementation that handles state transitions, execution,
   * and error handling for a single settlement.
   *
   * **State Transitions:**
   * 1. Mark settlement IN_PROGRESS immediately
   * 2. Execute settlement (open channel or cooperative settle)
   * 3. On success: Mark settlement COMPLETED
   * 4. On error: Log error, leave state IN_PROGRESS
   *
   * Source: Epic 6 Story 6.6 Settlement Monitor state machine
   *
   * @param event - Settlement trigger event from SettlementMonitor
   * @private
   */
  private async _processSettlement(event: SettlementTriggerEvent): Promise<void> {
    this.logger.info(
      {
        peerId: event.peerId,
        tokenId: event.tokenId,
        currentBalance: event.currentBalance.toString(),
        threshold: event.threshold.toString(),
        exceedsBy: event.exceedsBy.toString(),
      },
      'Settlement event received'
    );

    // Mark settlement IN_PROGRESS immediately
    // Source: Epic 6 Story 6.6 SettlementMonitor.markSettlementInProgress
    this.settlementMonitor.markSettlementInProgress(event.peerId, event.tokenId);
    this.logger.info(
      { peerId: event.peerId, tokenId: event.tokenId },
      'Marked settlement in progress'
    );

    try {
      // Execute settlement logic
      await this.executeSettlement(event);

      // Mark settlement COMPLETED after success
      this.settlementMonitor.markSettlementCompleted(event.peerId, event.tokenId);
      this.logger.info(
        { peerId: event.peerId, tokenId: event.tokenId },
        'Settlement completed, state reset to IDLE'
      );
    } catch (error) {
      // Log error but do NOT call markSettlementCompleted
      // State remains IN_PROGRESS for manual intervention
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      this.logger.error(
        {
          errorMessage,
          errorStack,
          errorType: error?.constructor?.name,
          peerId: event.peerId,
          tokenId: event.tokenId,
        },
        'Settlement failed'
      );
    }
  }

  /**
   * Execute settlement logic
   *
   * Main settlement execution flow:
   * 1. Get token address from tokenId
   * 2. Find existing payment channel for peer
   * 3. If no channel: Open new channel and deposit
   * 4. If channel exists: Sign balance proof and cooperative settle
   * 5. Update TigerBeetle accounts
   *
   * @param event - Settlement trigger event
   * @private
   */
  private async executeSettlement(event: SettlementTriggerEvent): Promise<void> {
    const { peerId, tokenId, currentBalance } = event;

    this.logger.info(
      { peerId, tokenId, currentBalance: currentBalance.toString() },
      'Executing settlement'
    );

    // Resolve the chain provider for this peer
    const chain = this.config.peerIdToChainMap.get(peerId);
    if (!chain) {
      throw new Error(`No chain configured for peer: ${peerId}`);
    }
    const provider = this.chainProviderRegistry.getProviderForPeer({ peerId, chain });
    if (!provider) {
      throw new Error(`No provider registered for chain: ${chain} (peer: ${peerId})`);
    }

    // Get token address from configuration
    const tokenAddress = this.config.tokenAddressMap.get(tokenId);
    if (!tokenAddress) {
      this.logger.error(
        { tokenId, availableTokens: Array.from(this.config.tokenAddressMap.keys()) },
        'Token address not found'
      );
      throw new Error(`Token address not found for tokenId: ${tokenId}`);
    }

    this.logger.debug({ tokenId, tokenAddress, chain }, 'Token address resolved');

    // Find existing channel for peer
    this.logger.debug({ peerId, tokenId }, 'Searching for existing channel');
    const channelId = await this.findChannelForPeer(peerId, tokenId);

    if (!channelId) {
      // No existing channel: Open new channel and deposit
      this.logger.info(
        { peerId, tokenId, tokenAddress },
        'No existing channel found, opening new channel'
      );
      await this.openChannelAndSettle(peerId, tokenId, tokenAddress, currentBalance, provider);
    } else {
      // Existing channel: Sign balance proof and cooperative settle
      this.logger.info({ peerId, tokenId, channelId }, 'Using existing channel for settlement');
      await this.settleViaExistingChannel(channelId, peerId, tokenId, currentBalance, provider);
    }
  }

  /**
   * Find existing payment channel for peer
   *
   * Uses ChannelManager's peer-channel index for chain-agnostic channel lookup,
   * then verifies on-chain status via the provider.
   *
   * @param peerId - Peer connector ID
   * @param tokenId - Token identifier
   * @returns channelId if found, null otherwise
   * @private
   */
  private async findChannelForPeer(peerId: string, tokenId: string): Promise<string | null> {
    try {
      if (!this.channelManager) {
        this.logger.warn({ peerId }, 'ChannelManager not set, cannot look up channels');
        return null;
      }

      const metadata = this.channelManager.getChannelForPeer(peerId, tokenId);
      if (!metadata) {
        return null;
      }

      // Trust ChannelManager's local state for channel lookup.
      // On-chain verification is deferred to the settlement operation itself.
      // ChannelManager normalizes all statuses to AdminChannelStatus ('open', 'closed', etc.)
      if (metadata.status === 'open') {
        return metadata.channelId;
      }

      return null;
    } catch (error) {
      this.logger.error({ error, peerId, tokenId }, 'Failed to find channel for peer');
      return null; // Treat as no channel exists
    }
  }

  /**
   * Open new channel and deposit initial funds
   *
   * Opens a new payment channel (zero deposit) then deposits initial funds
   * as a separate operation. Uses the chain-agnostic provider interface.
   *
   * After channel open + deposit, updates TigerBeetle to reduce creditBalance.
   *
   * @param peerId - Peer connector ID
   * @param tokenId - Token identifier
   * @param tokenAddress - ERC20 token contract address
   * @param amount - Amount to deposit (current balance from event)
   * @param provider - Resolved chain provider
   * @returns channelId of newly opened channel
   * @private
   */
  private async openChannelAndSettle(
    peerId: string,
    tokenId: string,
    tokenAddress: string,
    amount: bigint,
    provider: PaymentChannelProvider
  ): Promise<string> {
    // Calculate initial deposit
    const initialDeposit = amount * BigInt(this.config.initialDepositMultiplier);

    // Get peer address
    const peerAddress = this.config.peerIdToAddressMap.get(peerId);
    if (!peerAddress) {
      throw new Error(`Peer address not found for peerId: ${peerId}`);
    }

    this.logger.info(
      {
        peerId,
        tokenId,
        tokenAddress,
        peerAddress,
        initialDeposit: initialDeposit.toString(),
      },
      'Opening new payment channel'
    );

    // Step 1: Open channel (zero deposit via provider)
    const { channelId, txHash } = await this.retryWithBackoff(
      async () => await provider.openChannel(peerAddress, this.config.defaultSettlementTimeout),
      'openChannel',
      this.config.maxRetries
    );

    this.logger.info(
      {
        channelId,
        peerId,
        tokenId,
        txHash,
      },
      'Channel opened, depositing initial funds'
    );

    // Step 2: Deposit initial funds separately
    await this.retryWithBackoff(
      async () => await provider.deposit(channelId, initialDeposit.toString()),
      'deposit',
      this.config.maxRetries
    );

    this.logger.info(
      {
        channelId,
        peerId,
        tokenId,
        initialDeposit: initialDeposit.toString(),
      },
      'Channel funded for settlement'
    );

    // Update TigerBeetle: Record settlement to reduce creditBalance
    // We deposited funds into channel, so peer's debt to us decreases
    await this.accountManager.recordSettlement(peerId, tokenId, amount);

    this.logger.info(
      { peerId, tokenId, amount: amount.toString() },
      'TigerBeetle balance updated after channel deposit'
    );

    // Emit CHANNEL_ACTIVITY event for ChannelManager
    this.emit('CHANNEL_ACTIVITY', { channelId });

    return channelId;
  }

  /**
   * Settle via existing payment channel
   *
   * Claims transferred funds from the channel using the sender's latest
   * per-packet signed balance proof. The channel remains open after claiming —
   * the sender can continue sending packets and funding the channel.
   *
   * @param channelId - Payment channel ID
   * @param peerId - Peer connector ID
   * @param tokenId - Token identifier
   * @param amount - Amount to settle
   * @param provider - Resolved chain provider
   * @private
   */
  private async settleViaExistingChannel(
    channelId: string,
    peerId: string,
    tokenId: string,
    amount: bigint,
    provider: PaymentChannelProvider
  ): Promise<void> {
    const latestClaim = this.perPacketClaimService?.getLatestClaim(channelId);
    if (!latestClaim || !isEVMClaim(latestClaim)) {
      this.logger.error(
        { channelId, peerId },
        'No per-packet claim available for settlement — cannot compute balance proof without chain-specific state'
      );
      throw new Error(`No per-packet claim available for channel ${channelId}`);
    }

    // Per-packet claims already accumulated the correct cumulative state
    // Use string amounts directly from EVMClaimMessage for provider call
    const balanceProofParams: BalanceProofParams = {
      channelId,
      nonce: latestClaim.nonce,
      transferredAmount: latestClaim.transferredAmount,
      lockedAmount: latestClaim.lockedAmount,
      locksRoot: latestClaim.locksRoot,
    };
    const claimSignature = latestClaim.signature;

    this.logger.info(
      {
        channelId,
        nonce: latestClaim.nonce,
        transferred: latestClaim.transferredAmount,
      },
      'Using latest per-packet claim for on-chain settlement (claimFromChannel)'
    );

    // Claim from channel — transfers delta tokens to us, channel stays open
    await this.retryWithBackoff(
      async () => await provider.claimFromChannel(channelId, balanceProofParams, claimSignature),
      'claimFromChannel',
      this.config.maxRetries
    );

    this.logger.info(
      { channelId, amount: amount.toString() },
      'Claim from channel completed — channel remains open'
    );

    // Update TigerBeetle after successful on-chain claim
    await this.accountManager.recordSettlement(peerId, tokenId, amount);

    // Reset per-packet claim tracking after successful claim
    if (this.perPacketClaimService) {
      this.perPacketClaimService.resetChannel(channelId);
    }

    this.logger.info(
      { peerId, tokenId, amount: amount.toString() },
      'Accounting balance updated after claim'
    );

    // Emit CHANNEL_ACTIVITY event for ChannelManager
    this.emit('CHANNEL_ACTIVITY', { channelId });
  }

  /**
   * Retry operation with exponential backoff
   *
   * Retries transient failures with exponential backoff delay.
   * Throws immediately on non-retryable errors.
   *
   * Retry delays: 5s, 10s, 20s (configurable via retryDelayMs)
   *
   * @param operation - Async operation to retry
   * @param operationName - Name for logging
   * @param maxRetries - Maximum retry attempts
   * @returns Result of operation
   * @throws Error if all retries exhausted or non-retryable error
   * @private
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxRetries: number
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if error is retryable
        if (!this.isRetryableError(lastError)) {
          this.logger.error({ error: lastError, operationName }, 'Non-retryable error, aborting');
          throw lastError;
        }

        if (attempt < maxRetries) {
          const delayMs = this.config.retryDelayMs * 2 ** (attempt - 1);
          this.logger.warn(
            { attempt, maxRetries, operationName, delayMs, error: lastError.message },
            'Retrying settlement operation'
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    this.logger.error({ operationName, maxRetries }, 'Max retries exhausted');
    throw lastError;
  }

  /**
   * Check if error is retryable
   *
   * Determines if an error is transient and should be retried.
   *
   * **Retryable errors:**
   * - Network timeouts
   * - Gas price too high
   * - Nonce too low (transaction pending)
   *
   * **Non-retryable errors:**
   * - Insufficient funds
   * - Channel closed
   * - Invalid signature
   * - ChallengeNotExpiredError (settlement timing)
   *
   * @param error - Error to check
   * @returns true if retryable, false otherwise
   * @private
   */
  private isRetryableError(error: Error): boolean {
    const errorMessage = error.message.toLowerCase();

    // Retryable errors
    if (
      errorMessage.includes('timeout') ||
      errorMessage.includes('network') ||
      errorMessage.includes('gas price') ||
      errorMessage.includes('nonce too low') ||
      errorMessage.includes('replacement') || // Transaction replacement errors
      errorMessage.includes('already known') || // Transaction already in mempool
      errorMessage.includes('nonce has already been used') // Nonce conflict
    ) {
      return true;
    }

    // Non-retryable errors
    if (
      errorMessage.includes('insufficient funds') ||
      errorMessage.includes('channel closed') ||
      errorMessage.includes('invalid signature') ||
      errorMessage.includes('challenge not expired') ||
      error.constructor.name === 'ChallengeNotExpiredError'
    ) {
      return false;
    }

    // Default: Treat unknown errors as non-retryable for safety
    return false;
  }

  /**
   * Register or update a peer's chain mapping at runtime.
   *
   * Supports mixed EVM+Solana deployments where peers may be discovered
   * dynamically via self-describing claims or peer discovery service.
   * Existing mappings are overwritten if chainId changes (e.g., peer migrates chains).
   *
   * @param peerId - Peer connector ID
   * @param chainId - Chain identifier (e.g., 'evm:8453', 'solana:mainnet-beta')
   */
  registerPeerChain(peerId: string, chainId: string): void {
    const existingChain = this.config.peerIdToChainMap.get(peerId);
    this.config.peerIdToChainMap.set(peerId, chainId);

    if (existingChain && existingChain !== chainId) {
      this.logger.info(
        { event: 'peer_chain_updated', peerId, oldChain: existingChain, newChain: chainId },
        'Peer chain mapping updated'
      );
    } else if (!existingChain) {
      this.logger.info(
        { event: 'peer_chain_registered', peerId, chainId },
        'Peer chain mapping registered'
      );
    }
  }

  /**
   * Register or update a peer's settlement address at runtime.
   *
   * @param peerId - Peer connector ID
   * @param address - On-chain address for this peer (format depends on chain)
   */
  registerPeerAddress(peerId: string, address: string): void {
    if (!this.config.peerIdToAddressMap.has(peerId)) {
      this.config.peerIdToAddressMap.set(peerId, address);
      this.logger.info(
        { event: 'peer_address_registered', peerId },
        'Peer settlement address registered'
      );
    }
  }

  /**
   * Get settlement state for peer-token pair
   *
   * Queries the SettlementMonitor for current settlement state.
   * Useful for debugging and monitoring.
   *
   * @param peerId - Peer connector ID
   * @param tokenId - Token identifier
   * @returns Current settlement state
   */
  getSettlementState(peerId: string, tokenId: string): SettlementState {
    return this.settlementMonitor.getSettlementState(peerId, tokenId);
  }
}
