/**
 * Agent Wallet Lifecycle Management
 * Story 11.5: Agent Wallet Lifecycle Management
 *
 * Orchestrates wallet lifecycle across Stories 11.2 (Wallet Derivation),
 * 11.3 (Balance Tracking), and 11.4 (Automated Funding).
 *
 * Lifecycle states: PENDING → ACTIVE → SUSPENDED → ARCHIVED
 * Features:
 * - Automated wallet creation with funding
 * - State machine transitions with validation
 * - Activity tracking (transaction count, volume)
 * - Policy-driven archival for inactive wallets
 * - Telemetry integration for monitoring
 */

import pino from 'pino';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { AgentWalletDerivation, AgentWallet } from './agent-wallet-derivation';
import { AgentWalletFunder } from './agent-wallet-funder';
import { AgentBalanceTracker } from './agent-balance-tracker';
import { TelemetryEmitter } from '../telemetry/telemetry-emitter';
import {
  WALLET_LIFECYCLE_TABLE_SCHEMA,
  WALLET_LIFECYCLE_INDEXES,
  WALLET_ARCHIVES_TABLE_SCHEMA,
  WALLET_ARCHIVES_INDEXES,
} from './wallet-db-schema';

const logger = pino({ name: 'agent-wallet-lifecycle' });

/**
 * Wallet State Enum
 * Defines the lifecycle states for agent wallets
 */
export enum WalletState {
  PENDING = 'pending', // Wallet created, awaiting funding
  ACTIVE = 'active', // Wallet funded, can transact
  SUSPENDED = 'suspended', // Transactions blocked, under review
  ARCHIVED = 'archived', // Final state, exported and removed
}

/**
 * Wallet Lifecycle Record Interface
 * Tracks lifecycle state and activity for an agent wallet
 */
export interface WalletLifecycleRecord {
  agentId: string; // Unique agent identifier
  state: WalletState; // Current lifecycle state
  createdAt: number; // Unix timestamp (wallet created)
  activatedAt?: number; // Unix timestamp (wallet activated)
  suspendedAt?: number; // Unix timestamp (wallet suspended)
  archivedAt?: number; // Unix timestamp (wallet archived)
  lastActivity?: number; // Unix timestamp (last transaction)
  totalTransactions: number; // Total transaction count
  totalVolume: Record<string, bigint>; // Token → total volume (bigint)
  suspensionReason?: string; // Reason for suspension (if applicable)
}

/**
 * Wallet Archive Interface
 * Stores final state of archived wallets for audit trail
 */
export interface WalletArchive {
  agentId: string; // Unique agent identifier
  wallet: AgentWallet; // Final wallet state (from Story 11.2)
  balances: Record<string, bigint>; // Final balances (chain:token → balance)
  lifecycleRecord: WalletLifecycleRecord; // Final lifecycle record
  archivedAt: number; // Unix timestamp (archived)
}

/**
 * Lifecycle Configuration Interface
 * Configures lifecycle manager behavior
 */
export interface LifecycleConfig {
  inactivityDays: number; // Days of inactivity before auto-archive (default: 90)
  autoArchive: boolean; // Enable/disable auto-archival (default: true)
}

/**
 * Default lifecycle configuration
 */
const DEFAULT_CONFIG: LifecycleConfig = {
  inactivityDays: 90,
  autoArchive: true,
};

/**
 * Agent Wallet Lifecycle Manager
 * Manages complete lifecycle of agent wallets from creation to archival
 */
export class AgentWalletLifecycle {
  private walletDerivation: AgentWalletDerivation;
  private walletFunder: AgentWalletFunder;
  private balanceTracker: AgentBalanceTracker;
  private telemetryEmitter: TelemetryEmitter;
  private config: LifecycleConfig;
  private lifecycleRecords: Map<string, WalletLifecycleRecord>;
  private db: Database.Database;
  private cleanupIntervalId?: NodeJS.Timeout;

  // Valid state transitions
  private static readonly VALID_TRANSITIONS: Map<WalletState, WalletState[]> = new Map([
    [WalletState.PENDING, [WalletState.ACTIVE]],
    [WalletState.ACTIVE, [WalletState.SUSPENDED, WalletState.ARCHIVED]],
    [WalletState.SUSPENDED, [WalletState.ACTIVE, WalletState.ARCHIVED]],
    [WalletState.ARCHIVED, []], // Archived is final state
  ]);

  constructor(
    walletDerivation: AgentWalletDerivation,
    walletFunder: AgentWalletFunder,
    balanceTracker: AgentBalanceTracker,
    telemetryEmitter: TelemetryEmitter,
    config?: Partial<LifecycleConfig>,
    dbPath?: string
  ) {
    this.walletDerivation = walletDerivation;
    this.walletFunder = walletFunder;
    this.balanceTracker = balanceTracker;
    this.telemetryEmitter = telemetryEmitter;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.lifecycleRecords = new Map();

    // Initialize database (use same database as AgentWalletDerivation)
    const finalDbPath = dbPath ?? path.join(process.cwd(), 'data', 'wallet', 'agent-wallets.db');
    const dbDir = path.dirname(finalDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(finalDbPath);

    // Initialize database schema
    this.db.exec(WALLET_LIFECYCLE_TABLE_SCHEMA);
    WALLET_LIFECYCLE_INDEXES.forEach((index) => this.db.exec(index));
    this.db.exec(WALLET_ARCHIVES_TABLE_SCHEMA);
    WALLET_ARCHIVES_INDEXES.forEach((index) => this.db.exec(index));

    // Load existing lifecycle records from database
    this.loadAllLifecycleRecordsIntoCache();

    // Start periodic cleanup if auto-archive enabled
    if (this.config.autoArchive) {
      this.cleanupIntervalId = setInterval(() => {
        this.archiveInactiveWallets().catch((error) => {
          logger.error({ error }, 'Failed to archive inactive wallets');
        });
      }, 86400000); // Run daily (24 hours)
    }

    logger.info(
      {
        lifecycleRecordCount: this.lifecycleRecords.size,
        inactivityDays: this.config.inactivityDays,
        autoArchive: this.config.autoArchive,
      },
      'AgentWalletLifecycle initialized'
    );
  }

  /**
   * Load all existing lifecycle records from database into cache
   * Called during initialization to restore state
   * Only loads non-archived wallets
   * @private
   */
  private loadAllLifecycleRecordsIntoCache(): void {
    try {
      const stmt = this.db.prepare("SELECT * FROM wallet_lifecycle WHERE state != 'archived'");
      const rows = stmt.all() as Array<{
        agent_id: string;
        state: string;
        created_at: number;
        activated_at: number | null;
        suspended_at: number | null;
        archived_at: number | null;
        last_activity: number | null;
        total_transactions: number;
        total_volume: string | null;
        suspension_reason: string | null;
      }>;

      for (const row of rows) {
        // Deserialize total volume
        let totalVolume: Record<string, bigint> = {};
        if (row.total_volume) {
          const parsed = JSON.parse(row.total_volume);
          totalVolume = Object.fromEntries(
            Object.entries(parsed).map(([token, value]) => [token, BigInt(value as string)])
          );
        }

        const record: WalletLifecycleRecord = {
          agentId: row.agent_id,
          state: row.state as WalletState,
          createdAt: row.created_at,
          activatedAt: row.activated_at ?? undefined,
          suspendedAt: row.suspended_at ?? undefined,
          archivedAt: row.archived_at ?? undefined,
          lastActivity: row.last_activity ?? undefined,
          totalTransactions: row.total_transactions,
          totalVolume,
          suspensionReason: row.suspension_reason ?? undefined,
        };

        this.lifecycleRecords.set(record.agentId, record);
      }

      logger.debug(
        { recordCount: this.lifecycleRecords.size },
        'Lifecycle records loaded from database'
      );
    } catch (error) {
      logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to load lifecycle records from database'
      );
    }
  }

  /**
   * Transition wallet to new state
   * Validates state transition, updates record, persists to database, emits telemetry
   * @param agentId - Agent identifier
   * @param newState - New lifecycle state
   * @private
   */
  private async transitionState(agentId: string, newState: WalletState): Promise<void> {
    const record = this.lifecycleRecords.get(agentId);
    if (!record) {
      logger.warn({ agentId, newState }, 'Cannot transition state: lifecycle record not found');
      return;
    }

    const oldState = record.state;

    // Validate state transition
    const validTransitions = AgentWalletLifecycle.VALID_TRANSITIONS.get(oldState);
    if (!validTransitions || !validTransitions.includes(newState)) {
      throw new Error(`Invalid state transition for agent ${agentId}: ${oldState} → ${newState}`);
    }

    // Update state
    record.state = newState;

    // Update state-specific timestamps
    switch (newState) {
      case WalletState.ACTIVE:
        if (oldState === WalletState.PENDING) {
          record.activatedAt = Date.now();
        } else if (oldState === WalletState.SUSPENDED) {
          // Reactivation - clear suspension fields
          record.suspendedAt = undefined;
          record.suspensionReason = undefined;
        }
        break;
      case WalletState.SUSPENDED:
        record.suspendedAt = Date.now();
        break;
      case WalletState.ARCHIVED:
        record.archivedAt = Date.now();
        break;
    }

    // Persist to database (will be implemented in Task 7)
    await this.persistLifecycleRecord(record);

    // Emit telemetry event
    this.emitStateChange(agentId, oldState, newState);

    logger.info({ agentId, oldState, newState }, 'Wallet state transitioned');
  }

  /**
   * Emit state change telemetry event
   * @param agentId - Agent identifier
   * @param oldState - Previous state (null if newly created)
   * @param newState - New state
   * @private
   */
  private emitStateChange(
    agentId: string,
    oldState: WalletState | null,
    newState: WalletState
  ): void {
    try {
      this.telemetryEmitter.emit({
        type: 'AGENT_WALLET_STATE_CHANGED',
        agentId,
        oldState: oldState,
        newState: newState,
        timestamp: Date.now(),
      });
    } catch (error) {
      // Non-blocking: telemetry errors should not break lifecycle operations
      logger.warn(
        {
          agentId,
          oldState,
          newState,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to emit state change telemetry'
      );
    }
  }

  /**
   * Persist lifecycle record to database
   * @param record - Lifecycle record to persist
   * @private
   */
  private async persistLifecycleRecord(record: WalletLifecycleRecord): Promise<void> {
    try {
      // Serialize total volume (bigint → string)
      const totalVolumeJSON = JSON.stringify(
        Object.fromEntries(
          Object.entries(record.totalVolume).map(([token, value]) => [token, value.toString()])
        )
      );

      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO wallet_lifecycle (
          agent_id, state, created_at, activated_at, suspended_at, archived_at,
          last_activity, total_transactions, total_volume, suspension_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        record.agentId,
        record.state,
        record.createdAt,
        record.activatedAt ?? null,
        record.suspendedAt ?? null,
        record.archivedAt ?? null,
        record.lastActivity ?? null,
        record.totalTransactions,
        totalVolumeJSON,
        record.suspensionReason ?? null
      );

      logger.debug({ agentId: record.agentId, state: record.state }, 'Lifecycle record persisted');
    } catch (error) {
      logger.error(
        {
          agentId: record.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist lifecycle record'
      );
      throw error;
    }
  }

  /**
   * Persist archive to database
   * @param archive - Archive to persist
   * @private
   */
  private async persistArchive(archive: WalletArchive): Promise<void> {
    try {
      // Serialize wallet data
      const walletJSON = JSON.stringify(archive.wallet);

      // Serialize balances (bigint → string)
      const balancesJSON = JSON.stringify(
        Object.fromEntries(
          Object.entries(archive.balances).map(([key, value]) => [key, value.toString()])
        )
      );

      // Serialize lifecycle record (with bigint → string for totalVolume)
      const lifecycleJSON = JSON.stringify({
        ...archive.lifecycleRecord,
        totalVolume: Object.fromEntries(
          Object.entries(archive.lifecycleRecord.totalVolume).map(([token, value]) => [
            token,
            value.toString(),
          ])
        ),
      });

      const stmt = this.db.prepare(`
        INSERT INTO wallet_archives (agent_id, wallet_data, balances, lifecycle_data, archived_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      stmt.run(archive.agentId, walletJSON, balancesJSON, lifecycleJSON, archive.archivedAt);

      logger.debug({ agentId: archive.agentId }, 'Archive persisted');
    } catch (error) {
      logger.error(
        {
          agentId: archive.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist archive'
      );
      throw error;
    }
  }

  /**
   * Archive wallet
   * Exports final state and removes from active tracking
   * Transitions wallet to ARCHIVED state (final state)
   * @param agentId - Agent identifier
   * @returns Archive object
   */
  async archiveWallet(agentId: string): Promise<WalletArchive> {
    const record = this.lifecycleRecords.get(agentId);

    if (!record) {
      throw new Error(`No wallet for agent ${agentId}`);
    }

    // Export final wallet state
    const wallet = await this.walletDerivation.getAgentWallet(agentId);
    if (!wallet) {
      throw new Error(`Wallet not found for agent ${agentId}`);
    }

    // Export final balances
    const balancesArray = await this.balanceTracker.getAllBalances(agentId);
    const balances: Record<string, bigint> = {};
    for (const balance of balancesArray) {
      const key = `${balance.chain}:${balance.token}`;
      balances[key] = balance.balance;
    }

    // Transition to ARCHIVED first
    await this.transitionState(agentId, WalletState.ARCHIVED);

    // Create archive object with ARCHIVED state
    const archive: WalletArchive = {
      agentId,
      wallet,
      balances,
      lifecycleRecord: { ...record }, // Deep copy of record (now in ARCHIVED state)
      archivedAt: Date.now(),
    };

    // Remove from active tracking
    this.lifecycleRecords.delete(agentId);

    // Persist archive to database
    await this.persistArchive(archive);

    logger.info({ agentId }, 'Agent wallet archived');

    return archive;
  }

  /**
   * Get wallet archive
   * Retrieves archived wallet data for audit or recovery
   * @param agentId - Agent identifier
   * @returns Archive object or null if not archived
   */
  async getWalletArchive(agentId: string): Promise<WalletArchive | null> {
    try {
      const stmt = this.db.prepare('SELECT * FROM wallet_archives WHERE agent_id = ?');
      const row = stmt.get(agentId) as
        | {
            agent_id: string;
            wallet_data: string;
            balances: string;
            lifecycle_data: string;
            archived_at: number;
          }
        | undefined;

      if (!row) {
        return null;
      }

      // Deserialize wallet
      const wallet = JSON.parse(row.wallet_data) as AgentWallet;

      // Deserialize balances (string → bigint)
      const balancesParsed = JSON.parse(row.balances);
      const balances: Record<string, bigint> = Object.fromEntries(
        Object.entries(balancesParsed).map(([key, value]) => [key, BigInt(value as string)])
      );

      // Deserialize lifecycle record (string → bigint for totalVolume)
      const lifecycleParsed = JSON.parse(row.lifecycle_data);
      const lifecycleRecord: WalletLifecycleRecord = {
        ...lifecycleParsed,
        state: lifecycleParsed.state as WalletState,
        totalVolume: Object.fromEntries(
          Object.entries(lifecycleParsed.totalVolume).map(([token, value]) => [
            token,
            BigInt(value as string),
          ])
        ),
      };

      return {
        agentId: row.agent_id,
        wallet,
        balances,
        lifecycleRecord,
        archivedAt: row.archived_at,
      };
    } catch (error) {
      logger.error(
        {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to retrieve wallet archive'
      );
      return null;
    }
  }

  /**
   * Archive inactive wallets based on inactivity policy
   * Called periodically (daily) if auto-archive enabled
   * Only archives ACTIVE wallets (SUSPENDED wallets require manual archival)
   * @private
   */
  private async archiveInactiveWallets(): Promise<void> {
    const inactivityThreshold = this.config.inactivityDays * 86400000; // Convert days to milliseconds
    const now = Date.now();

    logger.debug(
      { inactivityDays: this.config.inactivityDays },
      'Starting inactive wallet archival'
    );

    for (const [agentId, record] of this.lifecycleRecords) {
      // Skip non-ACTIVE wallets
      if (record.state !== WalletState.ACTIVE) {
        continue;
      }

      // Calculate last activity timestamp
      const lastActivity = record.lastActivity || record.activatedAt || record.createdAt;

      // Calculate inactive duration
      const inactiveDuration = now - lastActivity;

      // Archive if inactive duration exceeds threshold
      if (inactiveDuration > inactivityThreshold) {
        try {
          const inactiveDays = inactiveDuration / 86400000;
          logger.info(
            { agentId, inactiveDays: inactiveDays.toFixed(1) },
            'Auto-archiving inactive wallet'
          );
          await this.archiveWallet(agentId);
        } catch (error) {
          logger.error(
            {
              agentId,
              error: error instanceof Error ? error.message : String(error),
            },
            'Failed to archive inactive wallet'
          );
        }
      }
    }

    logger.debug('Inactive wallet archival completed');
  }

  /**
   * Create agent wallet and initiate funding
   * Creates wallet in PENDING state, derives addresses, and automatically funds
   * Transitions to ACTIVE after funding confirmation
   * @param agentId - Agent identifier
   * @returns Lifecycle record
   */
  async createAgentWallet(agentId: string): Promise<WalletLifecycleRecord> {
    // Check if wallet already exists
    if (this.lifecycleRecords.has(agentId)) {
      throw new Error(`Wallet already exists for agent ${agentId}`);
    }

    // Derive wallet addresses
    await this.walletDerivation.deriveAgentWallet(agentId);

    // Initialize lifecycle record in PENDING state
    const record: WalletLifecycleRecord = {
      agentId,
      state: WalletState.PENDING,
      createdAt: Date.now(),
      totalTransactions: 0,
      totalVolume: {},
    };

    // Store in map
    this.lifecycleRecords.set(agentId, record);

    // Persist to database
    await this.persistLifecycleRecord(record);

    // Emit state change telemetry (null → PENDING)
    this.emitStateChange(agentId, null, WalletState.PENDING);

    logger.info({ agentId, state: WalletState.PENDING }, 'Agent wallet created');

    // Auto-fund wallet
    await this.fundAndActivate(agentId);

    return record;
  }

  /**
   * Fund wallet and activate on success
   * Orchestrates funding (Story 11.4) and activation flow
   * Non-blocking: wallet stays in PENDING state on funding failure
   * @param agentId - Agent identifier
   * @private
   */
  private async fundAndActivate(agentId: string): Promise<void> {
    const record = this.lifecycleRecords.get(agentId);
    if (!record || record.state !== WalletState.PENDING) {
      return; // Only fund PENDING wallets
    }

    try {
      // Fund wallet via Story 11.4
      await this.walletFunder.fundAgentWallet(agentId);

      // Wait for funding confirmations
      await this.waitForFundingConfirmations(agentId);

      // Transition to ACTIVE
      await this.transitionState(agentId, WalletState.ACTIVE);

      logger.info({ agentId }, 'Agent wallet activated after funding');
    } catch (error) {
      // Non-blocking: log error and keep wallet in PENDING state
      logger.error(
        {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Wallet funding failed, wallet remains in PENDING state'
      );
    }
  }

  /**
   * Wait for funding confirmations
   * Polls balances until non-zero balance detected
   * Simplified MVP: checks for non-zero balance rather than tracking specific transactions
   * @param agentId - Agent identifier
   * @private
   */
  private async waitForFundingConfirmations(agentId: string): Promise<void> {
    const maxAttempts = 12; // 12 attempts * 5 seconds = 60 seconds timeout
    const pollInterval = 5000; // 5 seconds

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Get all balances
        const balances = await this.balanceTracker.getAllBalances(agentId);

        // Check if any balance is non-zero
        const hasFunds = balances.some((balance) => balance.balance > 0n);

        if (hasFunds) {
          logger.info({ agentId, attempt }, 'Funding confirmations detected');
          return;
        }

        // Wait before next attempt
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      } catch (error) {
        logger.warn(
          {
            agentId,
            attempt,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to check funding confirmations'
        );
      }
    }

    // Timeout: no balances detected
    throw new Error(`Funding confirmation timeout for agent ${agentId} (no balances after 60s)`);
  }

  /**
   * Get lifecycle record for agent
   * @param agentId - Agent identifier
   * @returns Lifecycle record
   */
  async getLifecycleRecord(agentId: string): Promise<WalletLifecycleRecord> {
    const record = this.lifecycleRecords.get(agentId);
    if (!record) {
      throw new Error(`No lifecycle record for agent ${agentId}`);
    }
    return record;
  }

  /**
   * Suspend active wallet
   * Transitions wallet from ACTIVE to SUSPENDED state
   * Stores suspension reason for audit trail
   * @param agentId - Agent identifier
   * @param reason - Suspension reason (e.g., "Suspicious activity", "Manual review")
   */
  async suspendWallet(agentId: string, reason: string): Promise<void> {
    const record = this.lifecycleRecords.get(agentId);

    // Validate current state
    if (!record || record.state !== WalletState.ACTIVE) {
      throw new Error(`Cannot suspend wallet in state ${record?.state} for agent ${agentId}`);
    }

    // Store suspension reason
    record.suspensionReason = reason;

    // Transition to SUSPENDED
    await this.transitionState(agentId, WalletState.SUSPENDED);

    // Persist to database
    await this.persistLifecycleRecord(record);

    logger.warn({ agentId, reason }, 'Agent wallet suspended');
  }

  /**
   * Reactivate suspended wallet
   * Transitions wallet from SUSPENDED to ACTIVE state
   * Clears suspension reason
   * @param agentId - Agent identifier
   */
  async reactivateWallet(agentId: string): Promise<void> {
    const record = this.lifecycleRecords.get(agentId);

    // Validate current state
    if (!record || record.state !== WalletState.SUSPENDED) {
      throw new Error(`Cannot reactivate wallet in state ${record?.state} for agent ${agentId}`);
    }

    // Transition to ACTIVE (clears suspension fields in transitionState)
    await this.transitionState(agentId, WalletState.ACTIVE);

    // Persist to database
    await this.persistLifecycleRecord(record);

    logger.info({ agentId }, 'Agent wallet reactivated');
  }

  /**
   * Record transaction activity
   * Updates last activity, transaction count, and total volume
   * Called by Story 11.6 (Payment Channel Integration) after each payment
   * @param agentId - Agent identifier
   * @param token - Token identifier (e.g., 'ETH', ERC20 address, 'XRP')
   * @param amount - Transaction amount (bigint)
   */
  async recordTransaction(agentId: string, token: string, amount: bigint): Promise<void> {
    const record = this.lifecycleRecords.get(agentId);

    // Non-blocking: return if wallet not found (may be archived)
    if (!record) {
      logger.debug({ agentId }, 'Cannot record transaction: wallet not found (may be archived)');
      return;
    }

    // Update last activity
    record.lastActivity = Date.now();

    // Increment transaction count
    record.totalTransactions++;

    // Update total volume
    if (!record.totalVolume[token]) {
      record.totalVolume[token] = 0n;
    }
    record.totalVolume[token] += amount;

    // Persist to database
    await this.persistLifecycleRecord(record);

    logger.debug(
      {
        agentId,
        token,
        amount: amount.toString(),
        totalTransactions: record.totalTransactions,
      },
      'Transaction activity recorded'
    );
  }

  /**
   * Get last activity timestamp for agent
   * @param agentId - Agent identifier
   * @returns Unix timestamp or null if no activity
   */
  async getLastActivity(agentId: string): Promise<number | null> {
    const record = this.lifecycleRecords.get(agentId);
    if (!record) {
      return null;
    }
    return record.lastActivity || record.activatedAt || record.createdAt;
  }

  /**
   * Get total transaction count for agent
   * @param agentId - Agent identifier
   * @returns Transaction count
   */
  async getTotalTransactions(agentId: string): Promise<number> {
    const record = this.lifecycleRecords.get(agentId);
    if (!record) {
      return 0;
    }
    return record.totalTransactions;
  }

  /**
   * Get total volume for specific token
   * @param agentId - Agent identifier
   * @param token - Token identifier
   * @returns Total volume (bigint)
   */
  async getTotalVolume(agentId: string, token: string): Promise<bigint> {
    const record = this.lifecycleRecords.get(agentId);
    if (!record) {
      return 0n;
    }
    return record.totalVolume[token] || 0n;
  }

  /**
   * Get all lifecycle records (for backup)
   * Story 11.8: Backup and Recovery
   * @returns Array of all lifecycle records
   */
  getAllRecords(): WalletLifecycleRecord[] {
    return Array.from(this.lifecycleRecords.values());
  }

  /**
   * Get lifecycle records modified since timestamp (for incremental backup)
   * Story 11.8: Backup and Recovery
   * @param timestamp - Unix timestamp threshold
   * @returns Array of lifecycle records modified since timestamp
   */
  getRecordsModifiedSince(timestamp: number): WalletLifecycleRecord[] {
    const records: WalletLifecycleRecord[] = [];
    for (const record of this.lifecycleRecords.values()) {
      // Check if record was modified after timestamp
      const lastModified = Math.max(
        record.createdAt,
        record.activatedAt || 0,
        record.suspendedAt || 0,
        record.archivedAt || 0,
        record.lastActivity || 0
      );
      if (lastModified >= timestamp) {
        records.push(record);
      }
    }
    return records;
  }

  /**
   * Import lifecycle record from backup (for recovery)
   * Story 11.8: Backup and Recovery
   * @param record - Lifecycle record to import
   */
  async importLifecycleRecord(record: WalletLifecycleRecord): Promise<void> {
    try {
      // Insert or replace record in database
      const totalVolumeJson = JSON.stringify(
        Object.fromEntries(Object.entries(record.totalVolume).map(([k, v]) => [k, v.toString()]))
      );

      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO wallet_lifecycle (
          agent_id, state, created_at, activated_at, suspended_at, archived_at,
          last_activity, total_transactions, total_volume, suspension_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        record.agentId,
        record.state,
        record.createdAt,
        record.activatedAt ?? null,
        record.suspendedAt ?? null,
        record.archivedAt ?? null,
        record.lastActivity ?? null,
        record.totalTransactions,
        totalVolumeJson,
        record.suspensionReason ?? null
      );

      // Update in-memory cache
      this.lifecycleRecords.set(record.agentId, record);

      logger.debug({ agentId: record.agentId }, 'Lifecycle record imported from backup');
    } catch (error) {
      logger.error(
        { agentId: record.agentId, error },
        'Failed to import lifecycle record from backup'
      );
      throw error;
    }
  }

  /**
   * Close database connection and stop periodic cleanup
   * Must be called during connector shutdown
   */
  close(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = undefined;
    }
    this.db.close();
    logger.info('AgentWalletLifecycle closed');
  }
}
