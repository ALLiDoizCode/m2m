/**
 * Agent Balance Tracker
 * Story 11.3: Agent Wallet Balance Tracking and Monitoring
 *
 * Real-time balance tracking for agent wallets across EVM (Base L2) and XRP blockchains.
 * Polls blockchain RPCs every 30 seconds, caches balances in memory, and persists to database.
 */

import { ethers } from 'ethers';
import { Client as XRPLClient } from 'xrpl';
import Database from 'better-sqlite3';
import pino from 'pino';
import { AgentWalletDerivation, AgentWallet } from './agent-wallet-derivation';
import { AGENT_BALANCES_TABLE_SCHEMA, AGENT_BALANCES_INDEXES } from './wallet-db-schema';
import { TelemetryEmitter } from '../telemetry/telemetry-emitter';

const logger = pino({ name: 'agent-balance-tracker' });

/**
 * Agent Balance Interface
 * Represents a balance snapshot for an agent on a specific chain/token
 */
export interface AgentBalance {
  agentId: string; // Agent identifier
  chain: 'evm' | 'xrp'; // Blockchain identifier
  token: string; // Token identifier ('ETH', '0xUSDC', 'XRP', etc.)
  balance: bigint; // Balance in smallest unit (wei for ETH, drops for XRP)
  lastUpdated: number; // Unix timestamp of last balance fetch
}

/**
 * Balance Tracker Configuration
 */
export interface BalanceTrackerConfig {
  pollingInterval: number; // Milliseconds between balance polls (default 30000 = 30s)
  erc20Tokens: string[]; // Array of ERC20 token contract addresses to track
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: BalanceTrackerConfig = {
  pollingInterval: 30000, // 30 seconds
  erc20Tokens: [], // No ERC20 tokens by default
};

/**
 * Agent Balance Tracker Class
 * Monitors agent wallet balances across EVM and XRP blockchains
 */
export class AgentBalanceTracker {
  private walletDerivation: AgentWalletDerivation;
  private evmProvider: ethers.Provider;
  private xrplClient: XRPLClient;
  private telemetryEmitter: TelemetryEmitter;
  private config: BalanceTrackerConfig;
  private balanceCache: Map<string, AgentBalance>;
  private pollingIntervalId?: NodeJS.Timeout;
  private db: Database.Database;

  // ERC20 ABI for balanceOf function
  private static readonly ERC20_BALANCE_ABI = [
    'function balanceOf(address account) view returns (uint256)',
  ];

  constructor(
    walletDerivation: AgentWalletDerivation,
    evmProvider: ethers.Provider,
    xrplClient: XRPLClient,
    telemetryEmitter: TelemetryEmitter,
    config?: Partial<BalanceTrackerConfig>,
    dbPath?: string
  ) {
    this.walletDerivation = walletDerivation;
    this.evmProvider = evmProvider;
    this.xrplClient = xrplClient;
    this.telemetryEmitter = telemetryEmitter;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.balanceCache = new Map<string, AgentBalance>();

    // Initialize database (use same database file as AgentWalletDerivation)
    const finalDbPath = dbPath ?? this.walletDerivation['db'].name; // Access database path from walletDerivation
    this.db = new Database(finalDbPath);

    // Create balance tables and indexes
    this.db.exec(AGENT_BALANCES_TABLE_SCHEMA);
    AGENT_BALANCES_INDEXES.forEach((indexSql) => {
      this.db.exec(indexSql);
    });

    logger.info('AgentBalanceTracker initialized', {
      pollingInterval: this.config.pollingInterval,
      erc20TokensCount: this.config.erc20Tokens.length,
      dbPath: finalDbPath,
    });

    // Start periodic polling
    this.startPolling();
  }

  /**
   * Get balance for specific agent/chain/token
   * Checks cache first, fetches fresh balance if cache miss or stale
   * @param agentId Agent identifier
   * @param chain Blockchain ('evm' or 'xrp')
   * @param token Token identifier ('ETH', ERC20 address, or 'XRP')
   * @returns Balance as bigint (wei for ETH, drops for XRP)
   */
  async getBalance(agentId: string, chain: 'evm' | 'xrp', token: string): Promise<bigint> {
    const cacheKey = `${agentId}-${chain}-${token}`;
    const cached = this.balanceCache.get(cacheKey);

    // Return cached balance if within polling interval
    if (cached && Date.now() - cached.lastUpdated < this.config.pollingInterval) {
      logger.debug('Cache hit for balance', { agentId, chain, token });
      return cached.balance;
    }

    // Fetch fresh balance
    logger.debug('Cache miss or stale, fetching fresh balance', {
      agentId,
      chain,
      token,
    });
    const balance = await this.fetchBalance(agentId, chain, token);

    // Update cache
    const agentBalance: AgentBalance = {
      agentId,
      chain,
      token,
      balance,
      lastUpdated: Date.now(),
    };
    this.balanceCache.set(cacheKey, agentBalance);

    return balance;
  }

  /**
   * Get all balances for an agent (ETH, configured ERC20 tokens, XRP)
   * @param agentId Agent identifier
   * @returns Array of AgentBalance objects
   */
  async getAllBalances(agentId: string): Promise<AgentBalance[]> {
    const wallet = await this.walletDerivation.getAgentWallet(agentId);
    if (!wallet) {
      logger.warn('Wallet not found for agent', { agentId });
      return [];
    }

    const balances: AgentBalance[] = [];

    try {
      // Fetch ETH balance
      const ethBalance = await this.getBalance(agentId, 'evm', 'ETH');
      balances.push({
        agentId,
        chain: 'evm',
        token: 'ETH',
        balance: ethBalance,
        lastUpdated: Date.now(),
      });
    } catch (error) {
      logger.error('Failed to fetch ETH balance', { agentId, error });
    }

    // Fetch ERC20 token balances
    for (const tokenAddress of this.config.erc20Tokens) {
      try {
        const tokenBalance = await this.getBalance(agentId, 'evm', tokenAddress);
        balances.push({
          agentId,
          chain: 'evm',
          token: tokenAddress,
          balance: tokenBalance,
          lastUpdated: Date.now(),
        });
      } catch (error) {
        logger.error('Failed to fetch ERC20 balance', {
          agentId,
          tokenAddress,
          error,
        });
      }
    }

    // Fetch XRP balance
    try {
      const xrpBalance = await this.getBalance(agentId, 'xrp', 'XRP');
      balances.push({
        agentId,
        chain: 'xrp',
        token: 'XRP',
        balance: xrpBalance,
        lastUpdated: Date.now(),
      });
    } catch (error) {
      logger.error('Failed to fetch XRP balance', { agentId, error });
    }

    return balances;
  }

  /**
   * Fetch balance from blockchain RPC
   * @param agentId Agent identifier
   * @param chain Blockchain ('evm' or 'xrp')
   * @param token Token identifier
   * @returns Balance as bigint
   * @private
   */
  private async fetchBalance(
    agentId: string,
    chain: 'evm' | 'xrp',
    token: string
  ): Promise<bigint> {
    const wallet = await this.walletDerivation.getAgentWallet(agentId);
    if (!wallet) {
      throw new Error(`No wallet for agent ${agentId}`);
    }

    // Get old balance from cache for change detection
    const cacheKey = `${agentId}-${chain}-${token}`;
    const oldCached = this.balanceCache.get(cacheKey);

    // Fetch new balance
    let balance: bigint;
    if (chain === 'evm') {
      balance = await this.fetchEVMBalance(wallet, token);
    } else {
      balance = await this.fetchXRPBalance(wallet);
    }

    // Detect balance change and emit event
    if (oldCached && oldCached.balance !== balance) {
      this.emitBalanceChange(agentId, chain, token, oldCached.balance, balance);
    }

    // Persist balance to database (non-blocking)
    const agentBalance: AgentBalance = {
      agentId,
      chain,
      token,
      balance,
      lastUpdated: Date.now(),
    };
    this.persistBalance(agentBalance).catch((error) => {
      logger.error('Failed to persist balance to database', {
        agentId,
        chain,
        token,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return balance;
  }

  /**
   * Fetch EVM balance (native ETH or ERC20 token)
   * @param wallet Agent wallet
   * @param token Token identifier ('ETH' or ERC20 contract address)
   * @returns Balance as bigint (wei)
   * @private
   */
  private async fetchEVMBalance(wallet: AgentWallet, token: string): Promise<bigint> {
    if (token === 'ETH') {
      // Fetch native ETH balance
      const balance = await this.evmProvider.getBalance(wallet.evmAddress);
      return balance;
    } else {
      // Fetch ERC20 token balance
      const tokenContract = new ethers.Contract(
        token,
        AgentBalanceTracker.ERC20_BALANCE_ABI,
        this.evmProvider
      );
      if (!tokenContract.balanceOf) {
        throw new Error(`Invalid ERC20 contract at ${token}`);
      }
      const balance = await tokenContract.balanceOf(wallet.evmAddress);
      return balance;
    }
  }

  /**
   * Fetch XRP balance
   * @param wallet Agent wallet
   * @returns Balance as bigint (drops, 1 XRP = 1,000,000 drops)
   * @private
   */
  private async fetchXRPBalance(wallet: AgentWallet): Promise<bigint> {
    const response = await this.xrplClient.request({
      command: 'account_info',
      account: wallet.xrpAddress,
      ledger_index: 'validated',
    });

    // Extract balance in drops from response
    const balanceDrops = response.result.account_data.Balance;
    return BigInt(balanceDrops);
  }

  /**
   * Poll balances for all agents
   * Called periodically via setInterval
   * @private
   */
  private async pollAllBalances(): Promise<void> {
    logger.debug('Starting balance poll for all agents');

    const wallets = this.walletDerivation.getAllWallets();
    logger.debug('Polling balances', { agentCount: wallets.length });

    for (const wallet of wallets) {
      try {
        await this.getAllBalances(wallet.agentId);
      } catch (error) {
        logger.error('Failed to poll balance for agent', {
          agentId: wallet.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.debug('Balance poll completed');
  }

  /**
   * Start periodic balance polling
   * @private
   */
  private startPolling(): void {
    this.pollingIntervalId = setInterval(() => {
      this.pollAllBalances().catch((error) => {
        logger.error('Poll all balances failed', { error });
      });
    }, this.config.pollingInterval);

    logger.info('Balance polling started', {
      interval: this.config.pollingInterval,
    });
  }

  /**
   * Emit balance change telemetry event
   * @param agentId Agent identifier
   * @param chain Blockchain
   * @param token Token identifier
   * @param oldBalance Previous balance
   * @param newBalance New balance
   * @private
   */
  private emitBalanceChange(
    agentId: string,
    chain: string,
    token: string,
    oldBalance: bigint,
    newBalance: bigint
  ): void {
    try {
      const change = newBalance - oldBalance;

      this.telemetryEmitter.emit({
        type: 'AGENT_BALANCE_CHANGED',
        agentId,
        chain,
        token,
        oldBalance: oldBalance.toString(),
        newBalance: newBalance.toString(),
        change: change.toString(),
        timestamp: new Date().toISOString(),
      });

      logger.info('Agent balance changed', {
        agentId,
        chain,
        token,
        oldBalance: oldBalance.toString(),
        newBalance: newBalance.toString(),
        change: change.toString(),
      });
    } catch (error) {
      // Non-blocking: telemetry errors should not break balance tracking
      logger.error('Failed to emit balance change event', {
        agentId,
        chain,
        token,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Persist balance to database
   * @param balance AgentBalance object to persist
   * @private
   */
  private async persistBalance(balance: AgentBalance): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO agent_balances (agent_id, chain, token, balance, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `);

      stmt.run(
        balance.agentId,
        balance.chain,
        balance.token,
        balance.balance.toString(), // Convert bigint to string for storage
        balance.lastUpdated
      );

      logger.debug('Balance persisted to database', {
        agentId: balance.agentId,
        chain: balance.chain,
        token: balance.token,
      });
    } catch (error) {
      // Non-blocking: log error but don't throw
      logger.error('Database persistence failed', {
        agentId: balance.agentId,
        chain: balance.chain,
        token: balance.token,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get balance history for an agent/chain/token within a time range
   * Used by Story 11.7 dashboard for balance charts
   * @param agentId Agent identifier
   * @param chain Blockchain ('evm' or 'xrp')
   * @param token Token identifier
   * @param startTime Start of time range (Unix timestamp)
   * @param endTime End of time range (Unix timestamp)
   * @returns Array of historical AgentBalance objects
   */
  getBalanceHistory(
    agentId: string,
    chain: 'evm' | 'xrp',
    token: string,
    startTime: number,
    endTime: number
  ): AgentBalance[] {
    const stmt = this.db.prepare(`
      SELECT agent_id, chain, token, balance, timestamp
      FROM agent_balances
      WHERE agent_id = ? AND chain = ? AND token = ? AND timestamp BETWEEN ? AND ?
      ORDER BY timestamp ASC
    `);

    const rows = stmt.all(agentId, chain, token, startTime, endTime) as Array<{
      agent_id: string;
      chain: 'evm' | 'xrp';
      token: string;
      balance: string;
      timestamp: number;
    }>;

    return rows.map((row) => ({
      agentId: row.agent_id,
      chain: row.chain,
      token: row.token,
      balance: BigInt(row.balance), // Convert string back to bigint
      lastUpdated: row.timestamp,
    }));
  }

  /**
   * Reconcile agent balance with TigerBeetle off-chain accounting
   * @param agentId Agent identifier
   * @remarks
   * **Integration with TigerBeetle deferred to Story 11.11**
   * This is a stub method for future integration.
   * TigerBeetle is a high-performance distributed financial accounting database.
   * Future integration will cross-check on-chain balances with off-chain TigerBeetle accounts.
   */
  async reconcileWithTigerBeetle(agentId: string): Promise<void> {
    logger.info('TigerBeetle reconciliation pending', {
      agentId,
      story: '11.11',
      note: 'Integration deferred to Story 11.11',
    });
  }

  /**
   * Stop periodic balance polling
   * Should be called during connector shutdown
   */
  stop(): void {
    if (this.pollingIntervalId) {
      clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = undefined;
      logger.info('Balance polling stopped');
    }
  }
}
