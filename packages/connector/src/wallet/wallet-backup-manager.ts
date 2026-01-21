/**
 * Wallet Backup Manager
 * Story 11.8: Wallet Backup and Recovery Procedures
 *
 * Comprehensive backup and recovery infrastructure for agent wallets.
 * Creates full and incremental backups with encrypted master seed, wallet metadata,
 * lifecycle records, and balance snapshots. Supports multi-destination storage
 * (local filesystem + S3) with automated scheduling.
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import pino from 'pino';
import cron from 'node-cron';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { WalletSeedManager, BackupData } from './wallet-seed-manager';
import { AgentWalletDerivation, AgentWallet } from './agent-wallet-derivation';
import { AgentWalletLifecycle, WalletLifecycleRecord } from './agent-wallet-lifecycle';
import { AgentBalanceTracker, AgentBalance } from './agent-balance-tracker';

const logger = pino({ name: 'wallet-backup-manager' });

/**
 * Wallet Backup Interface
 * Complete backup snapshot with integrity validation
 */
export interface WalletBackup {
  version: string; // Backup format version (e.g., '1.0')
  timestamp: number; // Unix timestamp when backup created
  type: 'full' | 'incremental'; // Backup type
  encryptedMasterSeed: string; // Encrypted master seed from Story 11.1
  wallets: AgentWallet[]; // Agent wallet metadata from Story 11.2
  lifecycleRecords: WalletLifecycleRecord[]; // Lifecycle state from Story 11.5
  balanceSnapshots: Record<string, AgentBalance[]>; // Balance history from Story 11.3 (agentId → balances)
  checksum: string; // SHA-256 checksum for integrity validation
}

/**
 * Backup Configuration Interface
 * Configures backup destinations, scheduling, and security
 */
export interface BackupConfig {
  backupPath: string; // Local filesystem backup directory (default: './backups')
  s3Bucket?: string; // Optional S3 bucket for cloud backup
  s3Region?: string; // S3 region (e.g., 'us-east-1')
  s3AccessKeyId?: string; // S3 access key ID
  s3SecretAccessKey?: string; // S3 secret access key
  backupPassword: string; // Password for encrypting master seed
  fullBackupSchedule: string; // Cron expression for full backups (default: '0 0 * * 0' - weekly)
  incrementalBackupSchedule: string; // Cron expression for incremental backups (default: '0 0 * * *' - daily)
}

/**
 * Backup Metadata Interface
 * Tracks backup history and metadata
 */
export interface BackupMetadata {
  backupId: string; // Backup filename (unique identifier)
  timestamp: number; // Unix timestamp when backup created
  type: 'full' | 'incremental'; // Backup type
  walletCount: number; // Number of wallets in backup
  fileSize: number; // Backup file size in bytes
  checksum: string; // SHA-256 checksum for integrity validation
}

/**
 * Wallet Backup Manager
 * Orchestrates backup and recovery operations for agent wallets
 */
export class WalletBackupManager {
  private seedManager: WalletSeedManager;
  private walletDerivation: AgentWalletDerivation;
  private lifecycleManager: AgentWalletLifecycle;
  private balanceTracker: AgentBalanceTracker;
  private config: BackupConfig;
  private backupHistory: BackupMetadata[];

  constructor(
    seedManager: WalletSeedManager,
    walletDerivation: AgentWalletDerivation,
    lifecycleManager: AgentWalletLifecycle,
    balanceTracker: AgentBalanceTracker,
    config: BackupConfig
  ) {
    this.seedManager = seedManager;
    this.walletDerivation = walletDerivation;
    this.lifecycleManager = lifecycleManager;
    this.balanceTracker = balanceTracker;
    this.config = config;
    this.backupHistory = [];

    logger.info('WalletBackupManager initialized', {
      backupPath: this.config.backupPath,
      s3Enabled: !!this.config.s3Bucket,
      fullBackupSchedule: this.config.fullBackupSchedule,
      incrementalBackupSchedule: this.config.incrementalBackupSchedule,
    });

    // Schedule automated backups
    this.scheduleBackups();
  }

  /**
   * Calculate SHA-256 checksum for backup integrity validation
   * @param backup - Backup data (checksum field excluded from calculation)
   * @returns Hex-encoded SHA-256 checksum
   */
  private calculateChecksum(backup: WalletBackup): string {
    // Create copy without checksum field to avoid circular dependency
    const backupCopy = { ...backup, checksum: '' };
    const data = JSON.stringify(backupCopy);
    return createHash('sha256').update(data).digest('hex');
  }

  /**
   * Validate backup integrity using checksum
   * @param backup - Backup data to validate
   * @returns true if checksum matches, false if corrupted
   */
  private validateBackup(backup: WalletBackup): boolean {
    const calculatedChecksum = this.calculateChecksum(backup);
    return calculatedChecksum === backup.checksum;
  }

  /**
   * Get most recent backup metadata
   * @returns Last backup metadata or null if no backups exist
   */
  private getLastBackup(): BackupMetadata | undefined {
    if (this.backupHistory.length === 0) {
      return undefined;
    }
    // Sort by timestamp descending and return first
    const sorted = [...this.backupHistory].sort((a, b) => b.timestamp - a.timestamp);
    return sorted[0];
  }

  /**
   * Schedule automated backups using cron
   * Configures full backups (weekly) and incremental backups (daily)
   */
  private scheduleBackups(): void {
    try {
      // Schedule full backup (default: weekly, Sunday midnight)
      cron.schedule(this.config.fullBackupSchedule, async () => {
        try {
          logger.info('Scheduled full backup starting');
          await this.createFullBackup(this.config.backupPassword);
          logger.info('Scheduled full backup completed');
        } catch (error) {
          logger.error({ error }, 'Scheduled full backup failed');
        }
      });

      // Schedule incremental backup (default: daily, midnight)
      cron.schedule(this.config.incrementalBackupSchedule, async () => {
        try {
          logger.info('Scheduled incremental backup starting');
          await this.createIncrementalBackup(this.config.backupPassword);
          logger.info('Scheduled incremental backup completed');
        } catch (error) {
          logger.error({ error }, 'Scheduled incremental backup failed');
        }
      });

      logger.info('Backup schedules configured', {
        fullBackupSchedule: this.config.fullBackupSchedule,
        incrementalBackupSchedule: this.config.incrementalBackupSchedule,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to schedule backups');
      throw error;
    }
  }

  /**
   * Create full backup of all wallet state
   * Task 2: Implement Full Backup Creation (AC: 2, 3, 4)
   * @param password - Password for master seed encryption
   * @returns Backup object with all wallet data
   */
  async createFullBackup(password: string): Promise<WalletBackup> {
    try {
      logger.info('Creating full wallet backup');

      // Export encrypted master seed
      const masterSeed = await this.seedManager.decryptAndLoad(password);
      const encryptedSeedBackup = await this.seedManager.exportBackup(masterSeed, password);

      // Export all agent wallets
      const wallets = this.walletDerivation.getAllWallets();

      // Export lifecycle records
      const lifecycleRecords = this.lifecycleManager.getAllRecords();

      // Export balance snapshots for all wallets
      const balanceSnapshots: Record<string, AgentBalance[]> = {};
      for (const wallet of wallets) {
        balanceSnapshots[wallet.agentId] = await this.balanceTracker.getAllBalances(wallet.agentId);
      }

      // Create backup object
      const backup: WalletBackup = {
        version: '1.0',
        timestamp: Date.now(),
        type: 'full',
        encryptedMasterSeed: encryptedSeedBackup.encryptedSeed,
        wallets,
        lifecycleRecords,
        balanceSnapshots,
        checksum: '',
      };

      // Calculate and set checksum
      backup.checksum = this.calculateChecksum(backup);

      // Save backup
      await this.saveBackup(backup);

      logger.info('Full wallet backup created', {
        walletCount: wallets.length,
        timestamp: backup.timestamp,
      });

      return backup;
    } catch (error) {
      logger.error({ error }, 'Failed to create full backup');
      throw error;
    }
  }

  /**
   * Create incremental backup of changed wallets since last backup
   * Task 3: Implement Incremental Backup Logic (AC: 5)
   * @param password - Password for master seed encryption
   * @returns Backup object with changed wallet data
   */
  async createIncrementalBackup(password: string): Promise<WalletBackup> {
    try {
      logger.info('Creating incremental wallet backup');

      // Get last backup timestamp
      const lastBackup = this.getLastBackup();
      const lastTimestamp = lastBackup?.timestamp ?? 0;

      // Export encrypted master seed (always included)
      const masterSeed = await this.seedManager.decryptAndLoad(password);
      const encryptedSeedBackup = await this.seedManager.exportBackup(masterSeed, password);

      // Export only changed wallets
      const changedWallets = this.walletDerivation.getWalletsModifiedSince(lastTimestamp);

      // Export only changed lifecycle records
      const changedRecords = this.lifecycleManager.getRecordsModifiedSince(lastTimestamp);

      // Export balance snapshots for changed wallets only
      const balanceSnapshots: Record<string, AgentBalance[]> = {};
      for (const wallet of changedWallets) {
        balanceSnapshots[wallet.agentId] = await this.balanceTracker.getAllBalances(wallet.agentId);
      }

      // Create incremental backup object
      const backup: WalletBackup = {
        version: '1.0',
        timestamp: Date.now(),
        type: 'incremental',
        encryptedMasterSeed: encryptedSeedBackup.encryptedSeed,
        wallets: changedWallets,
        lifecycleRecords: changedRecords,
        balanceSnapshots,
        checksum: '',
      };

      // Calculate and set checksum
      backup.checksum = this.calculateChecksum(backup);

      // Save backup
      await this.saveBackup(backup);

      logger.info('Incremental wallet backup created', {
        walletCount: changedWallets.length,
        timestamp: backup.timestamp,
      });

      return backup;
    } catch (error) {
      logger.error({ error }, 'Failed to create incremental backup');
      throw error;
    }
  }

  /**
   * Save backup to local filesystem and optionally S3
   * Task 4: Implement Multi-Destination Backup Storage (AC: 6)
   * @param backup - Backup data to save
   */
  private async saveBackup(backup: WalletBackup): Promise<void> {
    try {
      // Generate filename
      const filename = `wallet-backup-${backup.timestamp}.json`;

      // Create backup directory if not exists
      await fs.mkdir(this.config.backupPath, { recursive: true });

      // Save to local filesystem
      const localPath = `${this.config.backupPath}/${filename}`;
      await fs.writeFile(localPath, JSON.stringify(backup, null, 2));

      // Upload to S3 if configured
      if (this.config.s3Bucket) {
        await this.uploadToS3(filename, backup);
      }

      // Record backup metadata
      const backupSize = JSON.stringify(backup).length;
      this.backupHistory.push({
        backupId: filename,
        timestamp: backup.timestamp,
        type: backup.type,
        walletCount: backup.wallets.length,
        fileSize: backupSize,
        checksum: backup.checksum,
      });

      logger.info('Backup saved', {
        filename,
        destinations: ['local', this.config.s3Bucket ? 's3' : null].filter(Boolean),
      });
    } catch (error) {
      logger.error({ error }, 'Failed to save backup');
      throw error;
    }
  }

  /**
   * Upload backup to S3
   * Task 4: Implement Multi-Destination Backup Storage (AC: 6)
   * @param filename - Backup filename
   * @param backup - Backup data
   */
  private async uploadToS3(filename: string, backup: WalletBackup): Promise<void> {
    try {
      const s3Client = new S3Client({
        region: this.config.s3Region ?? 'us-east-1',
        credentials: {
          accessKeyId: this.config.s3AccessKeyId!,
          secretAccessKey: this.config.s3SecretAccessKey!,
        },
      });

      await s3Client.send(
        new PutObjectCommand({
          Bucket: this.config.s3Bucket,
          Key: filename,
          Body: JSON.stringify(backup),
          ContentType: 'application/json',
        })
      );

      logger.info('Backup uploaded to S3', {
        bucket: this.config.s3Bucket,
        key: filename,
      });
    } catch (error) {
      // Log error but don't fail - local backup still succeeded
      logger.error(
        { error, bucket: this.config.s3Bucket, filename },
        'Failed to upload backup to S3 (local backup still saved)'
      );
    }
  }

  /**
   * Load backup from file
   * @param filename - Backup filename
   * @returns Backup data
   */
  async loadBackupFromFile(filename: string): Promise<WalletBackup> {
    try {
      const data = await fs.readFile(filename, 'utf-8');
      const backup = JSON.parse(data) as WalletBackup;

      // Validate backup structure
      if (!backup.version || !backup.timestamp || !backup.type || !backup.checksum) {
        throw new Error('Invalid backup file structure');
      }

      logger.info('Backup loaded from file', { filename, version: backup.version });
      return backup;
    } catch (error) {
      logger.error({ error, filename }, 'Failed to load backup from file');
      throw error;
    }
  }

  /**
   * Restore wallet state from backup
   * Task 5: Implement Recovery Validation and Restore (AC: 7, 8)
   * @param backupData - Backup data to restore
   * @param password - Password for master seed decryption
   */
  async restoreFromBackup(backupData: WalletBackup, password: string): Promise<void> {
    try {
      logger.warn('Starting wallet restore from backup', {
        timestamp: backupData.timestamp,
        walletCount: backupData.wallets.length,
      });

      // Validate backup integrity (AC: 7)
      if (!this.validateBackup(backupData)) {
        throw new Error('Backup checksum validation failed');
      }

      // Decrypt and restore master seed (AC: 8)
      const mnemonic = await this.decryptSeedFromBackup(backupData.encryptedMasterSeed, password);
      const masterSeed = await this.seedManager.importMasterSeed(mnemonic);
      await this.seedManager.encryptAndStore(masterSeed, password);

      // Restore wallet metadata
      for (const wallet of backupData.wallets) {
        await this.walletDerivation.importWallet(wallet);
      }

      // Restore lifecycle records
      for (const record of backupData.lifecycleRecords) {
        await this.lifecycleManager.importLifecycleRecord(record);
      }

      // Trigger balance reconciliation
      await this.reconcileBalances(backupData.balanceSnapshots);

      logger.info('Wallet restore completed successfully', {
        walletsRestored: backupData.wallets.length,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to restore from backup');
      throw error;
    }
  }

  /**
   * Decrypt master seed from backup
   * @param encryptedSeed - Encrypted seed from backup
   * @param password - Password for decryption
   * @returns Plaintext mnemonic
   */
  private async decryptSeedFromBackup(encryptedSeed: string, password: string): Promise<string> {
    // The encryptedSeed from backup is the same format as stored by WalletSeedManager
    // We can use the restoreFromBackup method from WalletSeedManager
    // which handles decryption and validation internally

    // Create a BackupData object for restoreFromBackup
    const backupData: BackupData = {
      version: '1.0',
      createdAt: Date.now(),
      encryptedSeed,
      backupDate: Date.now(),
      checksum: '', // Checksum will be calculated by WalletSeedManager
    };

    const masterSeed = await this.seedManager.restoreFromBackup(backupData, password);
    return masterSeed.mnemonic;
  }

  /**
   * Reconcile on-chain balances with backed-up snapshots
   * Task 6: Implement Balance Reconciliation (AC: 8)
   * @param snapshots - Balance snapshots from backup
   */
  private async reconcileBalances(snapshots: Record<string, AgentBalance[]>): Promise<void> {
    try {
      logger.info('Reconciling on-chain balances', {
        agentCount: Object.keys(snapshots).length,
      });

      for (const [agentId, expectedBalances] of Object.entries(snapshots)) {
        try {
          // Fetch actual on-chain balances
          const actualBalances = await this.balanceTracker.getAllBalances(agentId);

          // Compare expected vs actual balances
          for (const expected of expectedBalances) {
            const actual = actualBalances.find(
              (b) => b.chain === expected.chain && b.token === expected.token
            );

            if (!actual || actual.balance !== expected.balance) {
              logger.warn('Balance mismatch detected', {
                agentId,
                chain: expected.chain,
                token: expected.token,
                expected: expected.balance.toString(),
                actual: actual?.balance.toString() ?? '0',
              });

              // Emit telemetry event for balance mismatch
              // Note: TelemetryEmitter integration would go here
              // For now, just log the mismatch
            }
          }
        } catch (error) {
          logger.error({ agentId, error }, 'Failed to reconcile balances for agent');
        }
      }

      logger.info('Balance reconciliation completed');
    } catch (error) {
      logger.error({ error }, 'Failed to reconcile balances');
      // Don't throw - reconciliation errors should not fail restore
    }
  }
}
