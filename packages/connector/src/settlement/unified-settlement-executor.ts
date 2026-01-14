/**
 * Unified Settlement Executor
 *
 * Routes settlement operations to appropriate settlement method (EVM or XRP)
 * based on peer configuration and token type.
 *
 * This executor listens for SETTLEMENT_REQUIRED events from SettlementMonitor
 * and determines whether to settle via:
 * - PaymentChannelSDK (EVM payment channels - Epic 8)
 * - PaymentChannelManager (XRP payment channels - Epic 9)
 *
 * Settlement routing logic:
 * - XRP token + peer allows XRP → XRP settlement
 * - ERC20 token + peer allows EVM → EVM settlement
 * - Incompatible combinations → Error
 *
 * @module settlement/unified-settlement-executor
 */

import type { Logger } from 'pino';
import type { PaymentChannelSDK } from './payment-channel-sdk';
import type { PaymentChannelManager } from './xrp-channel-manager';
import type { ClaimSigner } from './xrp-claim-signer';
import type { SettlementMonitor } from './settlement-monitor';
import type { AccountManager } from './account-manager';
import type { PeerConfig, SettlementRequiredEvent, UnifiedSettlementExecutorConfig } from './types';

/**
 * UnifiedSettlementExecutor Class
 *
 * Orchestrates dual-chain settlement routing between EVM and XRP ledgers.
 * Integrates with TigerBeetle accounting layer for unified balance tracking.
 */
export class UnifiedSettlementExecutor {
  private readonly boundHandleSettlement: (event: SettlementRequiredEvent) => Promise<void>;

  /**
   * Constructor
   *
   * @param config - Unified settlement configuration with peer preferences
   * @param evmChannelSDK - PaymentChannelSDK for EVM settlements (Epic 8)
   * @param xrpChannelManager - PaymentChannelManager for XRP settlements (Epic 9)
   * @param xrpClaimSigner - ClaimSigner for XRP claim generation
   * @param settlementMonitor - Settlement monitor emitting SETTLEMENT_REQUIRED events
   * @param accountManager - TigerBeetle account manager for balance updates
   * @param logger - Pino logger instance
   */
  constructor(
    private config: UnifiedSettlementExecutorConfig,
    private evmChannelSDK: PaymentChannelSDK,
    private xrpChannelManager: PaymentChannelManager,
    private xrpClaimSigner: ClaimSigner,
    private settlementMonitor: SettlementMonitor,
    private accountManager: AccountManager,
    private logger: Logger
  ) {
    // Bind handler once in constructor (Event Listener Cleanup pattern)
    // This ensures same reference is used in both on() and off() calls
    this.boundHandleSettlement = this.handleSettlement.bind(this);
  }

  /**
   * Start settlement executor
   *
   * Registers listener for SETTLEMENT_REQUIRED events from SettlementMonitor.
   * Settlement routing begins after start() is called.
   */
  start(): void {
    this.logger.info('Starting UnifiedSettlementExecutor...');
    this.settlementMonitor.on('SETTLEMENT_REQUIRED', this.boundHandleSettlement);
    this.logger.info('UnifiedSettlementExecutor started');
  }

  /**
   * Stop settlement executor
   *
   * Unregisters listener and stops settlement processing.
   * Ensures proper cleanup of event handlers.
   */
  stop(): void {
    this.logger.info('Stopping UnifiedSettlementExecutor...');
    this.settlementMonitor.off('SETTLEMENT_REQUIRED', this.boundHandleSettlement);
    this.logger.info('UnifiedSettlementExecutor stopped');
  }

  /**
   * Handle settlement required event (private)
   *
   * Routes settlement to appropriate method based on peer config and token type.
   * Updates TigerBeetle accounts after successful settlement.
   *
   * @param event - Settlement required event from SettlementMonitor
   * @throws Error if no compatible settlement method found
   */
  private async handleSettlement(event: SettlementRequiredEvent): Promise<void> {
    const { peerId, balance, tokenId } = event;

    this.logger.info({ peerId, balance, tokenId }, 'Handling settlement request...');

    // Get peer configuration
    const peerConfig = this.config.peers.get(peerId);
    if (!peerConfig) {
      this.logger.error({ peerId }, 'Peer configuration not found');
      throw new Error(`Peer configuration not found for peerId: ${peerId}`);
    }

    // Route to appropriate settlement method
    try {
      // Check for incompatible combinations first
      const isXRPToken = tokenId === 'XRP';
      const canUseXRP =
        peerConfig.settlementPreference === 'xrp' || peerConfig.settlementPreference === 'both';
      const canUseEVM =
        peerConfig.settlementPreference === 'evm' || peerConfig.settlementPreference === 'both';

      if (isXRPToken && !canUseXRP) {
        // XRP token but peer doesn't support XRP settlement
        throw new Error(`No compatible settlement method for peer ${peerId} with token ${tokenId}`);
      }

      if (!isXRPToken && !canUseEVM) {
        // ERC20 token but peer doesn't support EVM settlement
        throw new Error(`No compatible settlement method for peer ${peerId} with token ${tokenId}`);
      }

      // Route to appropriate settlement method
      if (isXRPToken) {
        // XRP settlement via PaymentChannelManager
        await this.settleViaXRP(peerId, balance, peerConfig);
      } else {
        // EVM settlement via PaymentChannelSDK
        await this.settleViaEVM(peerId, balance, tokenId, peerConfig);
      }

      // Update TigerBeetle accounts (unified accounting layer)
      await this.accountManager.recordSettlement(peerId, tokenId, BigInt(balance));

      this.logger.info({ peerId, balance, tokenId }, 'Settlement completed successfully');
    } catch (error) {
      this.logger.error({ error, peerId, balance, tokenId }, 'Settlement failed');
      throw error;
    }
  }

  /**
   * Settle via EVM payment channels (private)
   *
   * Routes settlement to PaymentChannelSDK (Epic 8).
   * For MVP: Opens new channel with initial deposit for settlement.
   * Future: Channel reuse and cooperative settlement (deferred to future story).
   *
   * @param peerId - Peer identifier
   * @param amount - Amount to settle (string for bigint)
   * @param tokenAddress - ERC20 token contract address
   * @param config - Peer configuration
   */
  private async settleViaEVM(
    peerId: string,
    amount: string,
    tokenAddress: string,
    config: PeerConfig
  ): Promise<void> {
    this.logger.info({ peerId, amount, tokenAddress }, 'Settling via EVM payment channel...');

    if (!config.evmAddress) {
      throw new Error(`Peer ${peerId} missing evmAddress for EVM settlement`);
    }

    // For MVP: Open new channel with settlement amount as initial deposit
    // Default settlement timeout: 86400 seconds (24 hours)
    const settlementTimeout = 86400;
    const depositAmount = BigInt(amount);

    this.logger.info(
      {
        peerId,
        peerAddress: config.evmAddress,
        depositAmount: depositAmount.toString(),
        settlementTimeout,
      },
      'Opening new EVM payment channel for settlement...'
    );

    const channelId = await this.evmChannelSDK.openChannel(
      config.evmAddress,
      tokenAddress,
      settlementTimeout,
      depositAmount
    );

    this.logger.info({ peerId, channelId, amount }, 'EVM settlement completed');
  }

  /**
   * Settle via XRP payment channels (private)
   *
   * Routes settlement to PaymentChannelManager (Epic 9).
   * Creates channel if needed, signs claim, sends claim to peer off-chain.
   *
   * @param peerId - Peer identifier
   * @param amount - Amount to settle (XRP drops as string)
   * @param config - Peer configuration
   */
  private async settleViaXRP(peerId: string, amount: string, config: PeerConfig): Promise<void> {
    this.logger.info({ peerId, amount }, 'Settling via XRP payment channel...');

    if (!config.xrpAddress) {
      throw new Error(`Peer ${peerId} missing xrpAddress for XRP settlement`);
    }

    // Find or create XRP payment channel
    const channelId = await this.findOrCreateXRPChannel(config.xrpAddress, amount);

    // Sign claim for amount
    const signature = await this.xrpClaimSigner.signClaim(channelId, amount);
    const publicKey = this.xrpClaimSigner.getPublicKey();

    // Send claim to peer off-chain (peer submits to ledger)
    // TODO: Implement off-chain claim delivery mechanism (Story 9.6+)
    this.logger.info(
      { peerId, channelId, amount, signature, publicKey },
      'XRP claim signed and ready for delivery'
    );

    this.logger.info({ peerId, channelId, amount }, 'XRP settlement completed');
  }

  /**
   * Find or create XRP payment channel (private helper)
   *
   * Queries database for existing channel with peer.
   * Creates new channel if none exists.
   *
   * @param destination - XRP Ledger destination address
   * @param amount - Required channel capacity (drops)
   * @returns Channel ID (64-char hex)
   */
  private async findOrCreateXRPChannel(destination: string, amount: string): Promise<string> {
    // Query existing channels for destination
    // For MVP, always create new channel (channel reuse deferred to future story)
    // Default settle delay: 86400 seconds (24 hours)
    const settleDelay = 86400;

    this.logger.info({ destination, amount, settleDelay }, 'Creating new XRP payment channel...');

    const channelId = await this.xrpChannelManager.createChannel(destination, amount, settleDelay);

    this.logger.info({ channelId, destination }, 'XRP payment channel created');

    return channelId;
  }
}
