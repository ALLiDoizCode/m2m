import { EventEmitter } from 'events';
import type { Logger } from 'pino';
import { PaymentChannelSDK } from './payment-channel-sdk';
import { SettlementExecutor } from './settlement-executor';
import type { AdminChannelStatus } from './types';
import type { ChainProviderRegistry } from './provider/chain-provider-registry';

/**
 * ChannelManager configuration
 */
export interface ChannelManagerConfig {
  nodeId: string; // Our connector node ID
  defaultSettlementTimeout: number; // Default challenge period (e.g., 86400 = 24h)
  initialDepositMultiplier: number; // Channel initial deposit = threshold × multiplier (default: 10)
  idleChannelThreshold: number; // Close channel after this many seconds idle (default: 86400 = 24h)
  minDepositThreshold: number; // Add funds when deposit < threshold × multiplier × minDepositThreshold (default: 0.5)
  idleCheckInterval: number; // How often to check for idle channels (default: 3600 = 1h)
  tokenAddressMap: Map<string, string>; // tokenId → ERC20 contract address mapping
  peerIdToAddressMap: Map<string, string>; // peerId → Ethereum address mapping
  registryAddress: string; // TokenNetworkRegistry contract address
  rpcUrl: string; // Base L2 RPC URL
  privateKey: string; // Connector wallet private key
}

/**
 * Channel metadata for lifecycle tracking
 */
export interface ChannelMetadata {
  channelId: string; // bytes32 channel identifier
  peerId: string; // Peer connector ID (e.g., "connector-b")
  tokenId: string; // Token identifier (e.g., "M2M", "USDC")
  tokenAddress: string; // ERC20 token contract address
  chain: string; // Chain identifier (e.g., "evm:base:8453")
  createdAt: Date; // When channel was opened
  lastActivityAt: Date; // Last settlement or balance update
  status: AdminChannelStatus;
}

/**
 * Optional overrides for channel open operations via Admin API
 */
export interface ChannelOpenOptions {
  initialDeposit?: bigint; // Override default deposit
  settlementTimeout?: number; // Override default timeout
  chain?: string; // Chain identifier (e.g., 'solana:devnet'). Load-bearing: selects the
  // ChainProviderRegistry provider that opens the channel (non-EVM chains route to their
  // own provider). Falls back to peerIdToChainMap; unset / 'evm:*' keeps the EVM SDK path.
  peerAddress?: string; // Peer's blockchain address for channel opening
}

/**
 * ChannelManager orchestrates full payment channel lifecycles:
 * - Opens channels on-demand when settlements needed
 * - Tracks channel activity and detects idle channels
 * - Automatically closes idle channels to reclaim deposits
 * - Handles cooperative and unilateral closure flows
 */
export class ChannelManager extends EventEmitter {
  private readonly config: ChannelManagerConfig;
  private readonly paymentChannelSDK: PaymentChannelSDK;
  private readonly settlementExecutor: SettlementExecutor;
  private readonly logger: Logger;
  private readonly channelMetadata: Map<string, ChannelMetadata>; // channelId → metadata
  private readonly peerChannelIndex: Map<string, Map<string, string>>; // peerId → (tokenId → channelId)
  // Optional multi-chain wiring (issue #86). When present, a peer whose effective
  // chain is non-EVM has its channel opened via the registry's chain provider
  // instead of the EVM PaymentChannelSDK.
  private readonly chainProviderRegistry?: ChainProviderRegistry;
  private readonly peerIdToChainMap?: Map<string, string>; // peerId → chainId (e.g., 'solana:devnet')
  private idleCheckTimer?: NodeJS.Timeout;

  constructor(
    config: ChannelManagerConfig,
    paymentChannelSDK: PaymentChannelSDK,
    settlementExecutor: SettlementExecutor,
    logger: Logger,
    chainProviderRegistry?: ChainProviderRegistry,
    peerIdToChainMap?: Map<string, string>
  ) {
    super();
    this.config = config;
    this.paymentChannelSDK = paymentChannelSDK;
    this.settlementExecutor = settlementExecutor;
    this.chainProviderRegistry = chainProviderRegistry;
    this.peerIdToChainMap = peerIdToChainMap;
    this.channelMetadata = new Map<string, ChannelMetadata>();
    this.peerChannelIndex = new Map<string, Map<string, string>>();
    this.idleCheckTimer = undefined;

    // Create child logger
    this.logger = logger.child({ component: 'channel-manager' });
    this.logger.info({ nodeId: config.nodeId }, 'Channel manager initialized');

    // Listen for settlement activity to update channel activity timestamps
    this.settlementExecutor.on('CHANNEL_ACTIVITY', ({ channelId }: { channelId: string }) => {
      // Note: markChannelActivity is now async but we don't await here
      // to avoid blocking the event loop. Errors are handled internally.
      void this.markChannelActivity(channelId);
    });
  }

  /**
   * Start idle channel monitoring
   */
  start(): void {
    this.idleCheckTimer = setInterval(
      () => this.checkIdleChannels(),
      this.config.idleCheckInterval * 1000
    );
    this.logger.info(
      { idleCheckInterval: this.config.idleCheckInterval },
      'Channel manager started'
    );
  }

  /**
   * Stop monitoring and cleanup
   */
  stop(): void {
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = undefined;
    }
    this.logger.info('Channel manager stopped');
  }

  /**
   * Ensure channel exists for peer and token, creating if needed
   */
  async ensureChannelExists(
    peerId: string,
    tokenId: string,
    options?: ChannelOpenOptions
  ): Promise<string> {
    // Check if channel already exists
    const channelId = this.peerChannelIndex.get(peerId)?.get(tokenId);

    if (channelId) {
      // Verify channel is still active
      const metadata = this.channelMetadata.get(channelId);
      if (metadata && metadata.status !== 'closed') {
        this.logger.info({ peerId, tokenId, channelId }, 'Ensured channel exists (existing)');
        return channelId;
      }
    }

    // No active channel found, open new one
    const newChannelId = await this.openChannelForPeer(peerId, tokenId, options);
    this.logger.info({ peerId, tokenId, channelId: newChannelId }, 'Ensured channel exists (new)');
    return newChannelId;
  }

  /**
   * Get channel metadata for peer and token
   */
  getChannelForPeer(peerId: string, tokenId: string): ChannelMetadata | null {
    const channelId = this.peerChannelIndex.get(peerId)?.get(tokenId);
    if (!channelId) {
      return null;
    }
    return this.channelMetadata.get(channelId) ?? null;
  }

  /**
   * Get channel metadata by channel ID
   */
  getChannelById(channelId: string): ChannelMetadata | null {
    return this.channelMetadata.get(channelId) ?? null;
  }

  /**
   * Get all channels for a peer, regardless of the tokenId they are indexed under.
   *
   * The peer→channel index is keyed by tokenId, but a non-EVM external channel is
   * registered under a tokenId derived from its on-chain token/program identifier
   * (e.g. a Solana `programId`) which never matches the EVM-derived settlement
   * tokenId carried on a SettlementMonitor event. SettlementExecutor uses this as a
   * fallback to locate the already-verified channel for the peer instead of
   * wrongly opening a brand-new one (#92).
   *
   * @param peerId - Peer connector ID
   * @returns All channel metadata records for the peer (empty array if none)
   */
  getChannelsForPeer(peerId: string): ChannelMetadata[] {
    const index = this.peerChannelIndex.get(peerId);
    if (!index) {
      return [];
    }
    const channels: ChannelMetadata[] = [];
    for (const channelId of index.values()) {
      const metadata = this.channelMetadata.get(channelId);
      if (metadata) {
        channels.push(metadata);
      }
    }
    return channels;
  }

  /**
   * Register a channel discovered from an incoming self-describing claim.
   * Populates both channelMetadata and peerChannelIndex without opening on-chain.
   * Idempotent: if channelId already exists, returns existing metadata.
   */
  registerExternalChannel(params: {
    channelId: string;
    peerId: string;
    tokenAddress: string;
    tokenNetworkAddress?: string; // EVM-only (optional for Solana)
    chainId?: number; // EVM-only (optional for Solana)
    status: AdminChannelStatus;
    chain?: string; // Full chain string (e.g., 'solana:devnet'); overrides evm:${chainId} derivation
  }): ChannelMetadata {
    // Idempotent: return existing if already registered
    const existing = this.channelMetadata.get(params.channelId);
    if (existing) {
      this.logger.debug(
        { channelId: params.channelId },
        'External channel already registered, returning existing'
      );
      return existing;
    }

    // Resolve tokenId by reverse-lookup from tokenAddressMap
    // Use case-sensitive comparison for non-EVM chains (base58 addresses are case-sensitive)
    const isEVM = params.chain ? params.chain.startsWith('evm') : true;
    let tokenId: string = params.tokenAddress;
    for (const [id, address] of this.config.tokenAddressMap.entries()) {
      if (isEVM) {
        if (address.toLowerCase() === params.tokenAddress.toLowerCase()) {
          tokenId = id;
          break;
        }
      } else {
        // Case-sensitive comparison for Solana and other non-EVM chains
        if (address === params.tokenAddress) {
          tokenId = id;
          break;
        }
      }
    }

    // Determine chain string: use explicit chain param, or derive from chainId for EVM
    const chain = params.chain ?? (params.chainId !== undefined ? `evm:${params.chainId}` : '');

    if (!chain) {
      this.logger.warn(
        { channelId: params.channelId, peerId: params.peerId },
        'External channel registered without chain identifier (neither chain nor chainId provided)'
      );
    }

    const metadata: ChannelMetadata = {
      channelId: params.channelId,
      peerId: params.peerId,
      tokenId,
      tokenAddress: params.tokenAddress,
      chain,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      status: 'open',
    };

    this.channelMetadata.set(params.channelId, metadata);

    if (!this.peerChannelIndex.has(params.peerId)) {
      this.peerChannelIndex.set(params.peerId, new Map<string, string>());
    }
    this.peerChannelIndex.get(params.peerId)!.set(tokenId, params.channelId);

    this.logger.info(
      {
        channelId: params.channelId,
        peerId: params.peerId,
        chain,
      },
      'External channel registered'
    );

    return metadata;
  }

  /**
   * Get all channels
   */
  getAllChannels(): ChannelMetadata[] {
    return Array.from(this.channelMetadata.values());
  }

  /**
   * Mark channel as active (settlement or balance update occurred)
   */
  async markChannelActivity(channelId: string): Promise<void> {
    const metadata = this.channelMetadata.get(channelId);
    if (!metadata) {
      this.logger.warn({ channelId }, 'Cannot mark activity: channel not found');
      return;
    }
    metadata.lastActivityAt = new Date();
    this.logger.debug({ channelId }, 'Channel activity marked');
  }

  /**
   * Open new channel for peer
   * @private
   */
  private async openChannelForPeer(
    peerId: string,
    tokenId: string,
    options?: ChannelOpenOptions
  ): Promise<string> {
    // Effective chain: explicit option wins, else the peer→chain map (issue #86).
    // Load-bearing for provider selection — a non-EVM chain routes to the registry
    // provider instead of the EVM PaymentChannelSDK.
    const chain = options?.chain ?? this.peerIdToChainMap?.get(peerId);
    const isEvmChain = !chain || chain.startsWith('evm');

    // Resolve peer address (shared by both paths). For the EVM path this is the
    // 0x settlement address; for the provider path it is the chain-native
    // (e.g. base58) address already resolved into peerIdToAddressMap/options.
    const peerAddress = options?.peerAddress || this.config.peerIdToAddressMap.get(peerId);
    if (!peerAddress) {
      throw new Error(`Peer address not found for peerId: ${peerId}`);
    }

    this.logger.info(
      { peerId, peerAddress, chain, source: options?.peerAddress ? 'options' : 'config' },
      'Resolved peer address for channel opening'
    );

    // Use overrides if provided, otherwise fall back to defaults
    const settlementTimeout = options?.settlementTimeout ?? this.config.defaultSettlementTimeout;
    let initialDeposit: bigint;
    if (options?.initialDeposit !== undefined) {
      initialDeposit = options.initialDeposit;
    } else {
      // 1 USDC at 6 decimals (EXPECTED_USDC_DECIMALS). USDC is 6-decimal on every
      // chain since #188/#195; the prior 1e18 default deposited 1e12 USDC and
      // reverted on-chain with "Insufficient balance" (broke standalone settlement E2E).
      const defaultInitialDeposit = BigInt(1000000); // 1 USDC (1e6 base units)
      initialDeposit = defaultInitialDeposit * BigInt(this.config.initialDepositMultiplier);
    }

    // -------------------------------------------------------------------------
    // Non-EVM path: open + deposit via the registered chain provider (issue #86).
    // On a dual evm+solana node, tokenAddressMap only carries EVM entries, so we
    // MUST NOT require a map hit here — the provider bakes in its own token mint.
    // -------------------------------------------------------------------------
    if (chain && !isEvmChain && this.chainProviderRegistry) {
      const provider = this.chainProviderRegistry.getProviderForPeer({ peerId, chain });
      if (!provider) {
        throw new Error(`No provider registered for chain ${chain} (peer ${peerId})`);
      }

      // Display/metadata only — never a hard requirement on the provider path.
      const tokenAddressForMeta = this.config.tokenAddressMap.get(tokenId) ?? tokenId;

      // Two-step open then deposit. Only register a funded channel AFTER deposit
      // resolves: if openChannel succeeds but deposit throws, we deliberately let
      // it throw and do NOT index the channel as available (avoids advertising an
      // unfunded channel). The partial on-chain state is logged for operators.
      const { channelId, txHash } = await provider.openChannel(peerAddress, settlementTimeout);
      this.logger.info(
        { channelId, txHash, chain, provider: provider.chainId },
        'Channel opened via chain provider (awaiting deposit)'
      );

      try {
        const depositResult = await provider.deposit(channelId, initialDeposit.toString());
        this.logger.info(
          { channelId, txHash: depositResult.txHash, chain },
          'Channel deposit confirmed via chain provider'
        );
      } catch (error) {
        this.logger.error(
          { channelId, chain, initialDeposit: initialDeposit.toString(), error },
          'Channel opened on-chain but deposit failed — channel NOT registered as funded/available'
        );
        throw error;
      }

      // Deposit succeeded: register metadata + peer index (mirrors the EVM path).
      const metadata: ChannelMetadata = {
        channelId,
        peerId,
        tokenId,
        tokenAddress: tokenAddressForMeta,
        chain,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      };

      this.channelMetadata.set(channelId, metadata);
      if (!this.peerChannelIndex.has(peerId)) {
        this.peerChannelIndex.set(peerId, new Map<string, string>());
      }
      this.peerChannelIndex.get(peerId)!.set(tokenId, channelId);

      this.logger.info(
        { channelId, peerId, tokenId, chain, initialDeposit: initialDeposit.toString() },
        'Channel opened (chain provider)'
      );

      return channelId;
    }

    // -------------------------------------------------------------------------
    // EVM path (unchanged): the ERC20 token address is required from the map.
    // -------------------------------------------------------------------------
    const tokenAddress = this.config.tokenAddressMap.get(tokenId);
    if (!tokenAddress) {
      throw new Error(`Token address not found for tokenId: ${tokenId}`);
    }

    // Open channel on-chain
    const { channelId, txHash } = await this.paymentChannelSDK.openChannel(
      peerAddress,
      tokenAddress,
      settlementTimeout,
      initialDeposit
    );

    this.logger.info('Channel opened with transaction', { channelId, txHash });

    // Create metadata
    const metadata: ChannelMetadata = {
      channelId,
      peerId,
      tokenId,
      tokenAddress,
      chain: options?.chain ?? '',
      createdAt: new Date(),
      lastActivityAt: new Date(),
      status: 'open',
    };

    // Store metadata
    this.channelMetadata.set(channelId, metadata);

    // Update peer channel index
    if (!this.peerChannelIndex.has(peerId)) {
      this.peerChannelIndex.set(peerId, new Map<string, string>());
    }
    this.peerChannelIndex.get(peerId)!.set(tokenId, channelId);

    this.logger.info(
      { channelId, peerId, tokenId, initialDeposit: initialDeposit.toString() },
      'Channel opened'
    );

    return channelId;
  }

  /**
   * Check all channels for idle status
   * @private
   */
  private async checkIdleChannels(): Promise<void> {
    for (const metadata of this.channelMetadata.values()) {
      // Skip if not open
      if (metadata.status !== 'open') {
        continue;
      }

      // Check if idle
      if (!this.isChannelIdle(metadata)) {
        continue;
      }

      this.logger.info(
        { channelId: metadata.channelId, peerId: metadata.peerId },
        'Idle channel detected'
      );

      // Close channel
      await this.closeIdleChannel(metadata.channelId);
    }
  }

  /**
   * Check if channel is idle
   * @private
   */
  private isChannelIdle(metadata: ChannelMetadata): boolean {
    const idleDuration = Date.now() - metadata.lastActivityAt.getTime();
    return idleDuration > this.config.idleChannelThreshold * 1000;
  }

  /**
   * Close idle channel — starts grace period for receiver to submit claims
   * @private
   */
  private async closeIdleChannel(channelId: string): Promise<void> {
    const metadata = this.channelMetadata.get(channelId);
    if (!metadata) {
      this.logger.error({ channelId }, 'Cannot close channel: metadata not found');
      return;
    }

    // Update status to closing
    metadata.status = 'closing';

    try {
      // Close channel — starts grace period for claims
      await this.paymentChannelSDK.closeChannel(channelId, metadata.tokenAddress);

      // Schedule settle after grace period
      this.scheduleChallengeSettle(channelId, this.config.defaultSettlementTimeout);

      this.logger.info(
        {
          channelId,
          peerId: metadata.peerId,
          settlementTimeout: this.config.defaultSettlementTimeout,
        },
        'Channel close initiated, grace period started'
      );
    } catch (error) {
      this.logger.error({ channelId, error }, 'Failed to close channel');
      metadata.status = 'open';
      throw error;
    }
  }

  /**
   * Schedule settlement after challenge period
   * @private
   */
  private scheduleChallengeSettle(channelId: string, settlementTimeout: number): void {
    const settleDelayMs = settlementTimeout * 1000;
    setTimeout(async () => {
      await this.settleAfterChallenge(channelId);
    }, settleDelayMs);
    this.logger.info({ channelId, settlementTimeout }, 'Scheduled settle after challenge period');
  }

  /**
   * Settle channel after challenge period expires
   * @private
   */
  private async settleAfterChallenge(channelId: string): Promise<void> {
    const metadata = this.channelMetadata.get(channelId);
    if (!metadata) {
      this.logger.warn({ channelId }, 'Cannot settle: metadata not found');
      return;
    }

    if (metadata.status !== 'closing') {
      this.logger.warn(
        { channelId, status: metadata.status },
        'Channel not in closing state, skipping settle'
      );
      return;
    }

    try {
      await this.paymentChannelSDK.settleChannel(channelId, metadata.tokenAddress);
      metadata.status = 'closed';

      this.logger.info({ channelId }, 'Channel settled after challenge period');
    } catch (error) {
      this.logger.error({ channelId, error }, 'Failed to settle channel after challenge period');
    }
  }
}
