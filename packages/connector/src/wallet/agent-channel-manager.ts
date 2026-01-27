/**
 * Agent Channel Manager
 * Story 11.6: Payment Channel Integration for Agent Wallets
 *
 * Integrates agent wallets (Stories 11.2-11.5) with payment channels (Epic 8, Epic 9).
 * Enables AI agents to open/manage payment channels for micropayment execution.
 */

import type { AgentWalletDerivation, AgentWallet } from './agent-wallet-derivation';
import type { AgentWalletLifecycle } from './agent-wallet-lifecycle';
import type { PaymentChannelSDK } from '../settlement/payment-channel-sdk';
import type { XRPChannelSDK } from '../settlement/xrp-channel-sdk';
import type { TelemetryEmitter } from '../telemetry/telemetry-emitter';
import type { BalanceProof } from '@m2m/shared';
import type { XRPClaim } from '../settlement/types';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import { AGENT_CHANNELS_TABLE_SCHEMA, AGENT_CHANNELS_INDEXES } from './wallet-db-schema';

const logger = pino({ name: 'agent-channel-manager' });

/**
 * Agent Channel Interface
 * Tracks payment channel metadata for AI agents
 */
export interface AgentChannel {
  agentId: string; // Unique agent identifier
  channelId: string; // On-chain channel ID (EVM: bytes32, XRP: channel_id)
  chain: 'evm' | 'xrp'; // Blockchain network
  peerId: string; // Peer agent identifier
  token: string; // Token symbol (EVM: USDC/DAI, XRP: XRP)
  openedAt: number; // Unix timestamp (channel opened)
  lastActivityAt?: number; // Unix timestamp (last payment)
  closedAt?: number; // Unix timestamp (channel closed)
}

/**
 * Channel Manager Configuration
 */
export interface ChannelManagerConfig {
  minChannelBalance: bigint; // Minimum channel balance before rebalancing
  maxChannelBalance: bigint; // Maximum channel deposit on rebalance
  rebalanceEnabled: boolean; // Enable automatic channel rebalancing
}

/**
 * Channel Open Parameters
 */
export interface ChannelOpenParams {
  agentId: string; // Agent opening channel
  peerId: string; // Peer agent identifier
  chain: 'evm' | 'xrp'; // Blockchain network
  token: string; // Token to deposit
  amount: bigint; // Initial deposit amount
}

/**
 * Channel Payment Parameters
 */
export interface ChannelPaymentParams {
  agentId: string; // Agent sending payment
  channelId: string; // Channel ID
  amount: bigint; // Payment amount
}

/**
 * Agent Channel Manager Class
 * Orchestrates wallet lifecycle verification, wallet signing, and channel operations
 */
export class AgentChannelManager {
  private walletDerivation: AgentWalletDerivation;
  private evmChannelSDK: PaymentChannelSDK;
  private xrpChannelSDK: XRPChannelSDK;
  private lifecycleManager: AgentWalletLifecycle;
  private telemetryEmitter: TelemetryEmitter;
  private config: ChannelManagerConfig;
  private db: Database.Database;
  private agentChannels: Map<string, AgentChannel[]>; // agentId → channels

  /**
   * Default configuration
   */
  private static readonly DEFAULT_CONFIG: ChannelManagerConfig = {
    minChannelBalance: 1000000000000000000n, // 1 ETH / 1 token
    maxChannelBalance: 10000000000000000000n, // 10 ETH / 10 tokens
    rebalanceEnabled: true,
  };

  /**
   * Create new AgentChannelManager instance
   *
   * @param walletDerivation - Agent wallet derivation service
   * @param evmChannelSDK - EVM payment channel SDK (Epic 8)
   * @param xrpChannelSDK - XRP payment channel SDK (Epic 9)
   * @param lifecycleManager - Agent wallet lifecycle manager
   * @param telemetryEmitter - Telemetry emitter for events
   * @param config - Channel manager configuration
   * @param dbPath - Optional database path (defaults to ./data/wallet/agent-wallets.db)
   */
  constructor(
    walletDerivation: AgentWalletDerivation,
    evmChannelSDK: PaymentChannelSDK,
    xrpChannelSDK: XRPChannelSDK,
    lifecycleManager: AgentWalletLifecycle,
    telemetryEmitter: TelemetryEmitter,
    config?: Partial<ChannelManagerConfig>,
    dbPath?: string
  ) {
    this.walletDerivation = walletDerivation;
    this.evmChannelSDK = evmChannelSDK;
    this.xrpChannelSDK = xrpChannelSDK;
    this.lifecycleManager = lifecycleManager;
    this.telemetryEmitter = telemetryEmitter;
    this.config = { ...AgentChannelManager.DEFAULT_CONFIG, ...config };
    this.agentChannels = new Map();

    // Initialize database
    const finalDbPath = dbPath ?? path.join(process.cwd(), 'data', 'wallet', 'agent-wallets.db');
    const dbDir = path.dirname(finalDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(finalDbPath);

    // Create channel schema
    this.db.exec(AGENT_CHANNELS_TABLE_SCHEMA);
    AGENT_CHANNELS_INDEXES.forEach((index) => this.db.exec(index));

    // Load existing channels into cache
    this.loadChannelsIntoCache();

    logger.info('AgentChannelManager initialized');
  }

  /**
   * Load all non-closed channels from database into cache
   * Called during constructor to restore state on restart
   */
  private loadChannelsIntoCache(): void {
    const stmt = this.db.prepare('SELECT * FROM agent_channels WHERE closed_at IS NULL');
    const rows = stmt.all() as Array<{
      agent_id: string;
      channel_id: string;
      chain: string;
      peer_id: string;
      token: string;
      opened_at: number;
      last_activity_at: number | null;
      closed_at: number | null;
    }>;

    for (const row of rows) {
      const channel: AgentChannel = {
        agentId: row.agent_id,
        channelId: row.channel_id,
        chain: row.chain as 'evm' | 'xrp',
        peerId: row.peer_id,
        token: row.token,
        openedAt: row.opened_at,
        lastActivityAt: row.last_activity_at ?? undefined,
        closedAt: row.closed_at ?? undefined,
      };

      if (!this.agentChannels.has(channel.agentId)) {
        this.agentChannels.set(channel.agentId, []);
      }
      this.agentChannels.get(channel.agentId)!.push(channel);
    }

    logger.info({ channelCount: rows.length }, 'Loaded channels into cache');
  }

  /**
   * Open payment channel for agent
   *
   * Verifies wallet is ACTIVE via lifecycleManager.
   * Opens channel on-chain (EVM or XRP based on params.chain).
   * Tracks channel in database and cache.
   * Records wallet activity.
   * Emits AGENT_CHANNEL_OPENED telemetry event.
   *
   * @param params - Channel open parameters
   * @returns Channel ID
   * @throws Error if wallet not active or channel open fails
   */
  async openChannel(params: ChannelOpenParams): Promise<string> {
    logger.info(
      {
        agentId: params.agentId,
        peerId: params.peerId,
        chain: params.chain,
        token: params.token,
        amount: params.amount.toString(),
      },
      'Opening channel for agent'
    );

    // Verify agent wallet is active
    const lifecycle = await this.lifecycleManager.getLifecycleRecord(params.agentId);
    if (lifecycle.state !== 'active') {
      throw new Error(`Agent wallet not active: ${lifecycle.state}`);
    }

    // Get peer wallet address
    const peerWallet = await this.getPeerWallet(params.peerId);
    if (!peerWallet) {
      throw new Error(`Peer wallet not found: ${params.peerId}`);
    }

    let channelId: string;

    // Open channel on appropriate chain
    if (params.chain === 'evm') {
      // Get agent signer for EVM (required for SDK but not directly used here)
      await this.walletDerivation.getAgentSigner(params.agentId, 'evm');

      // Open EVM channel via PaymentChannelSDK
      // Settlement timeout: 3600 seconds (1 hour) per Epic 8 standards
      channelId = await this.evmChannelSDK.openChannel(
        peerWallet.evmAddress,
        params.token,
        3600,
        params.amount
      );
    } else if (params.chain === 'xrp') {
      // Get agent signer for XRP (required for SDK but not directly used here)
      await this.walletDerivation.getAgentSigner(params.agentId, 'xrp');

      // Open XRP channel via XRPChannelSDK
      // Settlement delay: 3600 seconds (1 hour) per Epic 9 standards
      channelId = await this.xrpChannelSDK.openChannel(
        peerWallet.xrpAddress,
        params.amount.toString(),
        3600,
        params.peerId
      );
    } else {
      throw new Error(`Unsupported chain: ${params.chain}`);
    }

    // Track channel in database and cache
    await this.trackAgentChannel(
      params.agentId,
      channelId,
      params.chain,
      params.peerId,
      params.token
    );

    // Record wallet activity
    await this.lifecycleManager.recordTransaction(params.agentId, params.token, params.amount);

    // Emit telemetry event
    try {
      this.telemetryEmitter.emit({
        type: 'AGENT_CHANNEL_OPENED',
        timestamp: Date.now(),
        nodeId: process.env.NODE_ID || 'unknown',
        agentId: params.agentId,
        channelId,
        chain: params.chain,
        peerId: params.peerId,
        amount: params.amount.toString(),
      });
    } catch (error) {
      // Non-blocking telemetry errors
      logger.error({ error }, 'Failed to emit AGENT_CHANNEL_OPENED telemetry');
    }

    logger.info(
      {
        agentId: params.agentId,
        channelId,
        chain: params.chain,
        peerId: params.peerId,
      },
      'Agent channel opened'
    );

    return channelId;
  }

  /**
   * Send payment through existing channel
   *
   * Signs balance proof (EVM) or claim (XRP) using wallet derivation signer.
   * Sends balance proof/claim to peer off-chain (placeholder for MVP).
   * Records wallet activity.
   * Updates channel last activity timestamp.
   * Emits AGENT_CHANNEL_PAYMENT_SENT telemetry event.
   * Triggers rebalancing check asynchronously if balance falls below threshold.
   *
   * @param params - Channel payment parameters
   * @throws Error if channel not found
   */
  async sendPayment(params: ChannelPaymentParams): Promise<void> {
    logger.info(
      {
        agentId: params.agentId,
        channelId: params.channelId,
        amount: params.amount.toString(),
      },
      'Sending payment through channel'
    );

    // Get agent channel
    const channel = await this.getAgentChannel(params.agentId, params.channelId);
    if (!channel) {
      throw new Error('Channel not found');
    }

    // Get agent signer (required for SDK but not directly used here)
    await this.walletDerivation.getAgentSigner(params.agentId, channel.chain);

    // Send payment based on chain
    if (channel.chain === 'evm') {
      // Get current channel state
      const currentState = await this.evmChannelSDK.getChannelState(
        params.channelId,
        channel.token
      );

      // Calculate new nonce and transferred amount
      const newNonce = currentState.myNonce + 1;
      const newTransferred = currentState.myTransferred + params.amount;

      // Sign balance proof (store result for off-chain transmission)
      await this.evmChannelSDK.signBalanceProof(params.channelId, newNonce, newTransferred);

      // Send balance proof to peer off-chain (placeholder)
      await this.sendBalanceProofToPeer(channel.peerId, {
        channelId: params.channelId,
        nonce: newNonce,
        transferredAmount: newTransferred,
        lockedAmount: 0n,
        locksRoot: '0x' + '0'.repeat(64),
      });
    } else if (channel.chain === 'xrp') {
      // Get current channel state
      const currentState = await this.xrpChannelSDK.getChannelState(params.channelId);

      // Calculate new amount
      const newAmount = BigInt(currentState.balance) + params.amount;

      // Sign claim
      const claim = await this.xrpChannelSDK.signClaim(params.channelId, newAmount.toString());

      // Send claim to peer off-chain (placeholder)
      await this.sendClaimToPeer(channel.peerId, claim);
    }

    // Record wallet activity
    await this.lifecycleManager.recordTransaction(params.agentId, channel.token, params.amount);

    // Update channel last activity
    channel.lastActivityAt = Date.now();
    await this.updateChannelActivity(params.channelId);

    // Emit telemetry event
    try {
      this.telemetryEmitter.emit({
        type: 'AGENT_CHANNEL_PAYMENT_SENT',
        timestamp: Date.now(),
        nodeId: process.env.NODE_ID || 'unknown',
        agentId: params.agentId,
        packetType: 'prepare',
        from: params.agentId,
        to: channel.peerId,
        channelId: params.channelId,
        amount: params.amount.toString(),
        destination: `g.agent.${channel.peerId}`,
      });
    } catch (error) {
      // Non-blocking telemetry errors
      logger.error({ error }, 'Failed to emit AGENT_CHANNEL_PAYMENT_SENT telemetry');
    }

    logger.info(
      {
        agentId: params.agentId,
        channelId: params.channelId,
        amount: params.amount.toString(),
      },
      'Agent channel payment sent'
    );

    // Trigger rebalancing asynchronously (non-blocking)
    setImmediate(() => {
      this.checkChannelRebalancing(params.agentId).catch((error) => {
        logger.error({ error, agentId: params.agentId }, 'Channel rebalancing failed');
      });
    });
  }

  /**
   * Close payment channel
   *
   * Closes channel on-chain (EVM or XRP).
   * Marks channel as closed in database.
   * Removes channel from active tracking.
   * Emits AGENT_CHANNEL_CLOSED telemetry event.
   *
   * @param agentId - Agent identifier
   * @param channelId - Channel ID
   * @throws Error if channel not found
   */
  async closeChannel(agentId: string, channelId: string): Promise<void> {
    logger.info({ agentId, channelId }, 'Closing agent channel');

    // Get agent channel
    const channel = await this.getAgentChannel(agentId, channelId);
    if (!channel) {
      throw new Error('Channel not found');
    }

    // Get agent signer (required for SDK but not directly used here)
    await this.walletDerivation.getAgentSigner(agentId, channel.chain);

    // Close channel on appropriate chain
    if (channel.chain === 'evm') {
      // Close EVM channel (requires token address, channel ID, and balance proof parameters)
      // Using empty balance proof as this is cooperative close
      await this.evmChannelSDK.closeChannel(
        channel.token,
        channelId,
        {
          channelId,
          nonce: 0,
          transferredAmount: 0n,
          lockedAmount: 0n,
          locksRoot: '0x' + '0'.repeat(64),
        },
        '0x' // Empty signature for cooperative close
      );
    } else if (channel.chain === 'xrp') {
      await this.xrpChannelSDK.closeChannel(channelId);
    }

    // Mark channel as closed in database
    channel.closedAt = Date.now();
    await this.updateChannelClosed(channelId);

    // Remove from active tracking (in-memory map)
    const channels = this.agentChannels.get(agentId);
    if (channels) {
      const index = channels.findIndex((c) => c.channelId === channelId);
      if (index !== -1) {
        channels.splice(index, 1);
      }
    }

    // Emit telemetry event
    try {
      this.telemetryEmitter.emit({
        type: 'AGENT_CHANNEL_CLOSED',
        timestamp: Date.now(),
        nodeId: process.env.NODE_ID || 'unknown',
        agentId,
        channelId,
        chain: channel.chain,
      });
    } catch (error) {
      // Non-blocking telemetry errors
      logger.error({ error }, 'Failed to emit AGENT_CHANNEL_CLOSED telemetry');
    }

    logger.info({ agentId, channelId, chain: channel.chain }, 'Agent channel closed');
  }

  /**
   * Get all active (non-closed) channels for agent
   *
   * Queries in-memory cache first, falls back to database.
   * Used by Story 11.7 dashboard to display agent channel state.
   *
   * @param agentId - Agent identifier
   * @returns Array of agent channels
   */
  async getAgentChannels(agentId: string): Promise<AgentChannel[]> {
    // Check in-memory cache first
    const cachedChannels = this.agentChannels.get(agentId);
    if (cachedChannels) {
      return cachedChannels;
    }

    // Query database if not in cache
    const stmt = this.db.prepare(
      'SELECT * FROM agent_channels WHERE agent_id = ? AND closed_at IS NULL'
    );
    const rows = stmt.all(agentId) as Array<{
      agent_id: string;
      channel_id: string;
      chain: string;
      peer_id: string;
      token: string;
      opened_at: number;
      last_activity_at: number | null;
      closed_at: number | null;
    }>;

    return rows.map((row) => ({
      agentId: row.agent_id,
      channelId: row.channel_id,
      chain: row.chain as 'evm' | 'xrp',
      peerId: row.peer_id,
      token: row.token,
      openedAt: row.opened_at,
      lastActivityAt: row.last_activity_at ?? undefined,
      closedAt: row.closed_at ?? undefined,
    }));
  }

  /**
   * Check channel rebalancing for agent
   *
   * Checks all agent channels for low balance (< minChannelBalance).
   * Closes depleted channels and opens new channels with maxChannelBalance.
   * Only runs if config.rebalanceEnabled = true.
   *
   * @param agentId - Agent identifier
   */
  async checkChannelRebalancing(agentId: string): Promise<void> {
    if (!this.config.rebalanceEnabled) {
      return;
    }

    logger.info({ agentId }, 'Checking channel rebalancing');

    // Get all active channels for agent
    const channels = await this.getAgentChannels(agentId);

    for (const channel of channels) {
      try {
        // Get current channel balance
        const balance = await this.getChannelBalance(
          channel.channelId,
          channel.chain,
          channel.token
        );

        // Check if balance fell below threshold
        if (balance < this.config.minChannelBalance) {
          logger.info(
            {
              agentId,
              channelId: channel.channelId,
              balance: balance.toString(),
              threshold: this.config.minChannelBalance.toString(),
            },
            'Channel balance below threshold, rebalancing'
          );

          // Close depleted channel
          await this.closeChannel(agentId, channel.channelId);

          // Open new channel with max balance
          const newChannelId = await this.openChannel({
            agentId,
            peerId: channel.peerId,
            chain: channel.chain,
            token: channel.token,
            amount: this.config.maxChannelBalance,
          });

          logger.info(
            {
              agentId,
              oldChannelId: channel.channelId,
              newChannelId,
            },
            'Channel rebalanced'
          );
        }
      } catch (error) {
        logger.error(
          { error, agentId, channelId: channel.channelId },
          'Failed to rebalance channel'
        );
      }
    }
  }

  /**
   * Track agent channel in database and cache
   *
   * @param agentId - Agent identifier
   * @param channelId - Channel ID
   * @param chain - Blockchain network
   * @param peerId - Peer agent identifier
   * @param token - Token symbol
   */
  private async trackAgentChannel(
    agentId: string,
    channelId: string,
    chain: 'evm' | 'xrp',
    peerId: string,
    token: string
  ): Promise<void> {
    const channel: AgentChannel = {
      agentId,
      channelId,
      chain,
      peerId,
      token,
      openedAt: Date.now(),
    };

    // Insert into database
    const stmt = this.db.prepare(
      'INSERT INTO agent_channels (agent_id, channel_id, chain, peer_id, token, opened_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    stmt.run(agentId, channelId, chain, peerId, token, channel.openedAt);

    // Add to in-memory cache
    if (!this.agentChannels.has(agentId)) {
      this.agentChannels.set(agentId, []);
    }
    this.agentChannels.get(agentId)!.push(channel);
  }

  /**
   * Get agent channel from cache or database
   *
   * @param agentId - Agent identifier
   * @param channelId - Channel ID
   * @returns Agent channel or null if not found
   */
  private async getAgentChannel(agentId: string, channelId: string): Promise<AgentChannel | null> {
    // Check in-memory cache first
    const channels = this.agentChannels.get(agentId);
    if (channels) {
      const channel = channels.find((c) => c.channelId === channelId);
      if (channel) {
        return channel;
      }
    }

    // Query database if not in cache
    const stmt = this.db.prepare(
      'SELECT * FROM agent_channels WHERE agent_id = ? AND channel_id = ?'
    );
    const row = stmt.get(agentId, channelId) as
      | {
          agent_id: string;
          channel_id: string;
          chain: string;
          peer_id: string;
          token: string;
          opened_at: number;
          last_activity_at: number | null;
          closed_at: number | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      agentId: row.agent_id,
      channelId: row.channel_id,
      chain: row.chain as 'evm' | 'xrp',
      peerId: row.peer_id,
      token: row.token,
      openedAt: row.opened_at,
      lastActivityAt: row.last_activity_at ?? undefined,
      closedAt: row.closed_at ?? undefined,
    };
  }

  /**
   * Update channel last activity timestamp
   *
   * @param channelId - Channel ID
   */
  private async updateChannelActivity(channelId: string): Promise<void> {
    const stmt = this.db.prepare(
      'UPDATE agent_channels SET last_activity_at = ? WHERE channel_id = ?'
    );
    stmt.run(Date.now(), channelId);

    // Update in-memory cache
    for (const channels of this.agentChannels.values()) {
      const channel = channels.find((c) => c.channelId === channelId);
      if (channel) {
        channel.lastActivityAt = Date.now();
        break;
      }
    }
  }

  /**
   * Mark channel as closed in database
   *
   * @param channelId - Channel ID
   */
  private async updateChannelClosed(channelId: string): Promise<void> {
    const stmt = this.db.prepare('UPDATE agent_channels SET closed_at = ? WHERE channel_id = ?');
    stmt.run(Date.now(), channelId);
  }

  /**
   * Get peer wallet addresses
   *
   * Assumes peers are also agents with wallets (peer-to-peer agent economy).
   *
   * @param peerId - Peer agent identifier
   * @returns Peer agent wallet
   */
  private async getPeerWallet(peerId: string): Promise<AgentWallet | null> {
    return await this.walletDerivation.getAgentWallet(peerId);
  }

  /**
   * Get channel balance for rebalancing logic
   *
   * @param channelId - Channel ID
   * @param chain - Blockchain network
   * @returns Remaining balance in channel
   */
  private async getChannelBalance(
    channelId: string,
    chain: 'evm' | 'xrp',
    token: string
  ): Promise<bigint> {
    if (chain === 'evm') {
      // Get EVM channel state
      const state = await this.evmChannelSDK.getChannelState(channelId, token);
      // Return remaining balance
      return state.myDeposit - state.myTransferred;
    } else if (chain === 'xrp') {
      // Get XRP channel state
      const state = await this.xrpChannelSDK.getChannelState(channelId);
      // Return remaining balance
      return BigInt(state.amount) - BigInt(state.balance);
    }

    throw new Error(`Unsupported chain: ${chain}`);
  }

  /**
   * Send balance proof to peer off-chain (placeholder for MVP)
   *
   * Future Enhancement: Integrate with Epic 7 BTP Protocol for actual transmission.
   *
   * @param peerId - Peer agent identifier
   * @param balanceProof - Balance proof
   */
  private async sendBalanceProofToPeer(peerId: string, balanceProof: BalanceProof): Promise<void> {
    // Placeholder: log balance proof (MVP)
    logger.info({ peerId, balanceProof }, 'Sending balance proof to peer (placeholder)');

    // Future: Use Epic 7 BTP Protocol for off-chain message passing
  }

  /**
   * Send claim to peer off-chain (placeholder for MVP)
   *
   * Future Enhancement: Integrate with Epic 7 BTP Protocol for actual transmission.
   *
   * @param peerId - Peer agent identifier
   * @param claim - XRP claim
   */
  private async sendClaimToPeer(peerId: string, claim: XRPClaim): Promise<void> {
    // Placeholder: log claim (MVP)
    logger.info({ peerId, claim }, 'Sending XRP claim to peer (placeholder)');

    // Future: Use Epic 7 BTP Protocol for off-chain message passing
  }
}
