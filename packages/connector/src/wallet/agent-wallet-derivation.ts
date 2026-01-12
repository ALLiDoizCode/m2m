/**
 * Agent Wallet Derivation
 * Story 11.2: Agent Wallet Derivation and Address Generation
 *
 * Derives unique EVM and XRP wallets for each agent from the master seed
 * using BIP-44 derivation paths. Supports up to 2^31 agent wallets.
 */

import { HDKey } from 'ethereum-cryptography/hdkey';
import { Wallet as EVMWallet } from 'ethers';
import { Wallet as XRPLWallet } from 'xrpl';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import { WalletSeedManager } from './wallet-seed-manager';
import { AGENT_WALLETS_TABLE_SCHEMA, AGENT_WALLETS_INDEXES } from './wallet-db-schema';

const logger = pino({ name: 'agent-wallet-derivation' });

/**
 * Agent Wallet Interface
 * Contains public addresses only - no private keys stored
 */
export interface AgentWallet {
  agentId: string; // Unique agent identifier
  derivationIndex: number; // BIP-44 derivation index (0 to 2^31-1)
  evmAddress: string; // Ethereum/Base L2 address (42 chars, 0x-prefixed)
  xrpAddress: string; // XRP Ledger address (r + 25-34 chars)
  createdAt: number; // Unix timestamp
  metadata?: Record<string, unknown>; // Optional application-specific data
}

/**
 * Custom error for wallet not found
 */
export class WalletNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Wallet not found for agent: ${agentId}`);
    this.name = 'WalletNotFoundError';
  }
}

/**
 * Custom error for max wallets reached
 */
export class MaxWalletsReachedError extends Error {
  constructor() {
    super('Maximum wallet derivation limit reached (2^31 wallets). Cannot derive more wallets.');
    this.name = 'MaxWalletsReachedError';
  }
}

/**
 * Agent Wallet Derivation Class
 * Derives and manages agent wallets from HD master seed
 */
export class AgentWalletDerivation {
  private seedManager: WalletSeedManager;
  private password: string;
  private walletCache: Map<string, AgentWallet>;
  private indexToAgentId: Map<number, string>;
  private db: Database.Database;

  // BIP-44 derivation paths
  // Ethereum/Base L2: m/44'/60'/1'/0/{index}
  // XRP Ledger: m/44'/144'/1'/0/{index}
  private static readonly EVM_PATH_PREFIX = "m/44'/60'/1'/0";
  private static readonly XRP_PATH_PREFIX = "m/44'/144'/1'/0";

  // Maximum derivation index (2^31 - 1) per BIP-44 hardened key limit
  private static readonly MAX_DERIVATION_INDEX = Math.pow(2, 31) - 1;

  // Warning threshold at 80% capacity
  private static readonly WARNING_THRESHOLD = Math.floor(
    AgentWalletDerivation.MAX_DERIVATION_INDEX * 0.8
  );

  constructor(seedManager: WalletSeedManager, password: string, dbPath?: string) {
    this.seedManager = seedManager;
    this.password = password;
    this.walletCache = new Map();
    this.indexToAgentId = new Map();

    // Initialize database
    const finalDbPath = dbPath ?? path.join(process.cwd(), 'data', 'wallet', 'agent-wallets.db');
    const dbDir = path.dirname(finalDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(finalDbPath);

    // Create schema
    this.db.exec(AGENT_WALLETS_TABLE_SCHEMA);
    AGENT_WALLETS_INDEXES.forEach((index) => this.db.exec(index));

    // Load existing wallets into cache
    this.loadAllWalletsIntoCache();

    logger.info({ walletCount: this.walletCache.size }, 'AgentWalletDerivation initialized');
  }

  /**
   * Load all existing wallets from database into cache
   */
  private loadAllWalletsIntoCache(): void {
    const stmt = this.db.prepare('SELECT * FROM agent_wallets');
    const rows = stmt.all() as Array<{
      agent_id: string;
      derivation_index: number;
      evm_address: string;
      xrp_address: string;
      created_at: number;
      metadata: string | null;
    }>;

    for (const row of rows) {
      const wallet: AgentWallet = {
        agentId: row.agent_id,
        derivationIndex: row.derivation_index,
        evmAddress: row.evm_address,
        xrpAddress: row.xrp_address,
        createdAt: row.created_at,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      };
      this.walletCache.set(wallet.agentId, wallet);
      this.indexToAgentId.set(wallet.derivationIndex, wallet.agentId);
    }
  }

  /**
   * Get next available derivation index
   * Validates index < 2^31 (BIP-44 hardened key limit)
   */
  private getNextIndex(): number {
    if (this.indexToAgentId.size === 0) {
      return 0;
    }

    const maxIndex = Math.max(...this.indexToAgentId.keys());
    const nextIndex = maxIndex + 1;

    // Warn at 80% capacity
    if (nextIndex >= AgentWalletDerivation.WARNING_THRESHOLD) {
      logger.warn(
        { nextIndex, maxIndex: AgentWalletDerivation.MAX_DERIVATION_INDEX },
        'Approaching maximum wallet derivation limit (80% capacity)'
      );
    }

    // Validate bounds
    if (nextIndex > AgentWalletDerivation.MAX_DERIVATION_INDEX) {
      throw new MaxWalletsReachedError();
    }

    return nextIndex;
  }

  /**
   * Derive agent wallet from master seed
   * Generates both EVM and XRP addresses from same derivation index
   */
  async deriveAgentWallet(agentId: string): Promise<AgentWallet> {
    // Check cache first
    const cached = this.walletCache.get(agentId);
    if (cached) {
      logger.debug({ agentId }, 'Wallet found in cache');
      return cached;
    }

    try {
      // Get next derivation index and immediately reserve it for this agent
      const derivationIndex = this.getNextIndex();
      this.indexToAgentId.set(derivationIndex, agentId);

      // Load master seed
      const masterSeedData = await this.seedManager.decryptAndLoad(this.password);
      const masterSeed = new Uint8Array(masterSeedData.seed);

      // Derive EVM wallet (m/44'/60'/1'/0/{index})
      const evmPath = `${AgentWalletDerivation.EVM_PATH_PREFIX}/${derivationIndex}`;
      const evmHDKey = HDKey.fromMasterSeed(masterSeed).derive(evmPath);
      if (!evmHDKey.privateKey) {
        throw new Error(`Failed to derive EVM private key for path: ${evmPath}`);
      }
      const evmWallet = new EVMWallet('0x' + Buffer.from(evmHDKey.privateKey).toString('hex'));
      const evmAddress = evmWallet.address;

      // Derive XRP wallet (m/44'/144'/1'/0/{index})
      const xrpPath = `${AgentWalletDerivation.XRP_PATH_PREFIX}/${derivationIndex}`;
      const xrpHDKey = HDKey.fromMasterSeed(masterSeed).derive(xrpPath);
      if (!xrpHDKey.privateKey) {
        throw new Error(`Failed to derive XRP private key for path: ${xrpPath}`);
      }
      // Use fromEntropy for consistency with Story 11.1
      const xrpWallet = XRPLWallet.fromEntropy(Buffer.from(xrpHDKey.privateKey));
      const xrpAddress = xrpWallet.address;

      // Create AgentWallet object (no private keys)
      const agentWallet: AgentWallet = {
        agentId,
        derivationIndex,
        evmAddress,
        xrpAddress,
        createdAt: Date.now(),
      };

      // Cache wallet (index already reserved above)
      this.walletCache.set(agentId, agentWallet);

      // Persist to database
      await this.persistWalletMetadata(agentWallet);

      logger.info(
        {
          agentId,
          derivationIndex,
          evmAddress,
          xrpAddress,
        },
        'Agent wallet derived successfully'
      );

      return agentWallet;
    } catch (error) {
      logger.error({ agentId, error }, 'Failed to derive agent wallet');
      throw error;
    }
  }

  /**
   * Get existing agent wallet by ID
   * Checks cache first, then database
   */
  async getAgentWallet(agentId: string): Promise<AgentWallet | null> {
    // Check cache first
    const cached = this.walletCache.get(agentId);
    if (cached) {
      return cached;
    }

    // Load from database
    const wallet = await this.loadWalletMetadata(agentId);
    if (wallet) {
      // Update cache
      this.walletCache.set(agentId, wallet);
      this.indexToAgentId.set(wallet.derivationIndex, agentId);
    }

    return wallet;
  }

  /**
   * Get all cached wallets
   * Used by balance tracking (Story 11.3)
   */
  getAllWallets(): AgentWallet[] {
    return Array.from(this.walletCache.values());
  }

  /**
   * Get agent signer for transaction signing
   * Derives private key on-demand (not cached)
   */
  async getAgentSigner(agentId: string, chain: 'evm' | 'xrp'): Promise<EVMWallet | XRPLWallet> {
    // Get wallet metadata
    const wallet = await this.getAgentWallet(agentId);
    if (!wallet) {
      throw new WalletNotFoundError(agentId);
    }

    try {
      // Load master seed
      const masterSeedData = await this.seedManager.decryptAndLoad(this.password);
      const masterSeed = new Uint8Array(masterSeedData.seed);

      if (chain === 'evm') {
        // Derive EVM signer
        const evmPath = `${AgentWalletDerivation.EVM_PATH_PREFIX}/${wallet.derivationIndex}`;
        const evmHDKey = HDKey.fromMasterSeed(masterSeed).derive(evmPath);
        if (!evmHDKey.privateKey) {
          throw new Error(`Failed to derive EVM private key for agent: ${agentId}`);
        }
        const evmWallet = new EVMWallet('0x' + Buffer.from(evmHDKey.privateKey).toString('hex'));
        return evmWallet;
      } else {
        // Derive XRP signer
        const xrpPath = `${AgentWalletDerivation.XRP_PATH_PREFIX}/${wallet.derivationIndex}`;
        const xrpHDKey = HDKey.fromMasterSeed(masterSeed).derive(xrpPath);
        if (!xrpHDKey.privateKey) {
          throw new Error(`Failed to derive XRP private key for agent: ${agentId}`);
        }
        const xrpWallet = XRPLWallet.fromEntropy(Buffer.from(xrpHDKey.privateKey));
        return xrpWallet;
      }
    } catch (error) {
      logger.error({ agentId, chain, error }, 'Failed to get agent signer');
      throw error;
    }
  }

  /**
   * Batch derive wallets for multiple agents
   * Uses parallel derivation for performance
   */
  async batchDeriveWallets(agentIds: string[]): Promise<AgentWallet[]> {
    const startTime = Date.now();
    logger.info({ batchSize: agentIds.length }, 'Starting batch wallet derivation');

    try {
      const wallets = await Promise.all(agentIds.map((agentId) => this.deriveAgentWallet(agentId)));

      const duration = Date.now() - startTime;
      logger.info(
        {
          batchSize: agentIds.length,
          duration,
          avgPerWallet: duration / agentIds.length,
        },
        'Batch wallet derivation completed'
      );

      return wallets;
    } catch (error) {
      logger.error({ error, batchSize: agentIds.length }, 'Batch derivation failed');
      throw error;
    }
  }

  /**
   * Get wallet by EVM address (reverse lookup)
   */
  async getWalletByEvmAddress(evmAddress: string): Promise<AgentWallet | null> {
    const stmt = this.db.prepare('SELECT * FROM agent_wallets WHERE evm_address = ?');
    const row = stmt.get(evmAddress) as
      | {
          agent_id: string;
          derivation_index: number;
          evm_address: string;
          xrp_address: string;
          created_at: number;
          metadata: string | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    const wallet: AgentWallet = {
      agentId: row.agent_id,
      derivationIndex: row.derivation_index,
      evmAddress: row.evm_address,
      xrpAddress: row.xrp_address,
      createdAt: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };

    // Update cache
    this.walletCache.set(wallet.agentId, wallet);
    this.indexToAgentId.set(wallet.derivationIndex, wallet.agentId);

    return wallet;
  }

  /**
   * Get wallet by XRP address (reverse lookup)
   */
  async getWalletByXrpAddress(xrpAddress: string): Promise<AgentWallet | null> {
    const stmt = this.db.prepare('SELECT * FROM agent_wallets WHERE xrp_address = ?');
    const row = stmt.get(xrpAddress) as
      | {
          agent_id: string;
          derivation_index: number;
          evm_address: string;
          xrp_address: string;
          created_at: number;
          metadata: string | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    const wallet: AgentWallet = {
      agentId: row.agent_id,
      derivationIndex: row.derivation_index,
      evmAddress: row.evm_address,
      xrpAddress: row.xrp_address,
      createdAt: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };

    // Update cache
    this.walletCache.set(wallet.agentId, wallet);
    this.indexToAgentId.set(wallet.derivationIndex, wallet.agentId);

    return wallet;
  }

  /**
   * Persist wallet metadata to database
   */
  private async persistWalletMetadata(wallet: AgentWallet): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO agent_wallets (agent_id, derivation_index, evm_address, xrp_address, created_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        wallet.agentId,
        wallet.derivationIndex,
        wallet.evmAddress,
        wallet.xrpAddress,
        wallet.createdAt,
        wallet.metadata ? JSON.stringify(wallet.metadata) : null
      );
    } catch (error: unknown) {
      // Handle unique constraint violations
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'SQLITE_CONSTRAINT'
      ) {
        logger.warn({ agentId: wallet.agentId }, 'Wallet already exists in database');
      } else {
        throw error;
      }
    }
  }

  /**
   * Load wallet metadata from database
   */
  private async loadWalletMetadata(agentId: string): Promise<AgentWallet | null> {
    const stmt = this.db.prepare('SELECT * FROM agent_wallets WHERE agent_id = ?');
    const row = stmt.get(agentId) as
      | {
          agent_id: string;
          derivation_index: number;
          evm_address: string;
          xrp_address: string;
          created_at: number;
          metadata: string | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      agentId: row.agent_id,
      derivationIndex: row.derivation_index,
      evmAddress: row.evm_address,
      xrpAddress: row.xrp_address,
      createdAt: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  /**
   * Close database connection
   * Must be called during connector shutdown
   */
  close(): void {
    this.db.close();
    logger.info('AgentWalletDerivation closed');
  }
}
