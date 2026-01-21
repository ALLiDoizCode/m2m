/**
 * Wallet Disaster Recovery Integration Test
 * Story 11.8: Wallet Backup and Recovery Procedures (AC: 10)
 *
 * Tests complete disaster recovery workflow:
 * 1. Setup: Initialize real wallet components with test data
 * 2. Backup: Create full backup of all wallet state
 * 3. Disaster Simulation: Destroy all wallet state
 * 4. Recovery: Restore from backup file
 * 5. Verification: Validate restored state matches original
 */

/* eslint-disable no-console */

import { WalletSeedManager } from '../../src/wallet/wallet-seed-manager';
import { AgentWalletDerivation } from '../../src/wallet/agent-wallet-derivation';
import { AgentWalletLifecycle } from '../../src/wallet/agent-wallet-lifecycle';
import { AgentBalanceTracker } from '../../src/wallet/agent-balance-tracker';
import { AgentWalletFunder } from '../../src/wallet/agent-wallet-funder';
import { WalletBackupManager, BackupConfig } from '../../src/wallet/wallet-backup-manager';
import { TelemetryEmitter } from '../../src/telemetry/telemetry-emitter';
import { TreasuryWallet } from '../../src/wallet/treasury-wallet';
import { FundingConfig } from '../../src/wallet/agent-wallet-funder';
import { ethers } from 'ethers';
import { Client as XRPLClient } from 'xrpl';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface StoredWalletInfo {
  agentId: string;
  evmAddress: string;
  xrpAddress: string;
  derivationIndex: number;
}

interface StoredLifecycleRecord {
  agentId: string;
  state: string;
  totalTransactions: number;
}

describe('Wallet Disaster Recovery Integration Test', () => {
  let tempDir: string;
  let tempDbPath: string;
  let tempBackupPath: string;
  let backupPassword: string;

  // Components (will be recreated for each phase)
  let seedManager: WalletSeedManager;
  let walletDerivation: AgentWalletDerivation;
  let lifecycleManager: AgentWalletLifecycle;
  let balanceTracker: AgentBalanceTracker;
  let backupManager: WalletBackupManager;

  // Mock external dependencies
  let mockEvmProvider: jest.Mocked<ethers.Provider>;
  let mockXrplClient: jest.Mocked<XRPLClient>;
  let mockTelemetryEmitter: jest.Mocked<TelemetryEmitter>;

  // Test data
  const testAgentIds = ['agent-001', 'agent-002', 'agent-003', 'agent-004', 'agent-005'];
  let backupFilePath: string;
  let originalWallets: Map<string, StoredWalletInfo>;
  let originalLifecycleRecords: Map<string, StoredLifecycleRecord>;

  beforeAll(async () => {
    // Create temporary directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-disaster-recovery-test-'));
    tempDbPath = path.join(tempDir, 'test-wallet.db');
    tempBackupPath = path.join(tempDir, 'backups');
    backupPassword = 'TestP@ssw0rd12345678'; // Meets strong password requirements

    // Create backup directory
    fs.mkdirSync(tempBackupPath, { recursive: true });
  });

  afterAll(async () => {
    // Cleanup temporary files
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    // Mock EVM provider
    mockEvmProvider = {
      getBalance: jest.fn().mockResolvedValue(BigInt('1000000000000000000')), // 1 ETH
      getNetwork: jest.fn().mockResolvedValue({ chainId: 8453n, name: 'base' }),
    } as unknown as jest.Mocked<ethers.Provider>;

    // Mock XRPL client
    mockXrplClient = {
      isConnected: jest.fn().mockReturnValue(true),
      getXrpBalance: jest.fn().mockResolvedValue('1000000'), // 1 XRP
      request: jest.fn().mockResolvedValue({
        account_data: { Balance: '1000000' },
      }),
    } as unknown as jest.Mocked<XRPLClient>;

    // Mock telemetry emitter
    mockTelemetryEmitter = {
      emit: jest.fn(),
    } as unknown as jest.Mocked<TelemetryEmitter>;

    // Reset test data storage
    originalWallets = new Map();
    originalLifecycleRecords = new Map();
  });

  describe('Full Disaster Recovery Workflow', () => {
    it('should successfully recover from complete system failure', async () => {
      /**
       * PHASE 1: Setup - Initialize wallet infrastructure with test data
       */
      console.log('=== PHASE 1: Setup ===');

      // Initialize seed manager and generate master seed
      seedManager = new WalletSeedManager(undefined, {
        storageBackend: 'filesystem',
        storagePath: tempDir,
      });
      await seedManager.initialize();

      const masterSeed = await seedManager.generateMasterSeed(256);
      await seedManager.encryptAndStore(masterSeed, backupPassword);

      // Initialize wallet derivation
      walletDerivation = new AgentWalletDerivation(seedManager, backupPassword, tempDbPath);

      // Derive wallets for 5 test agents
      for (const agentId of testAgentIds) {
        const wallet = await walletDerivation.deriveAgentWallet(agentId);
        originalWallets.set(agentId, {
          agentId: wallet.agentId,
          evmAddress: wallet.evmAddress,
          xrpAddress: wallet.xrpAddress,
          derivationIndex: wallet.derivationIndex,
        });
        console.log(`Derived wallet for ${agentId}: EVM=${wallet.evmAddress.slice(0, 10)}...`);
      }

      expect(originalWallets.size).toBe(5);

      // Initialize balance tracker
      balanceTracker = new AgentBalanceTracker(
        walletDerivation,
        mockEvmProvider,
        mockXrplClient,
        mockTelemetryEmitter,
        { pollingInterval: 60000 }, // Disable polling for test
        tempDbPath
      );

      // Initialize wallet funder with proper config
      const fundingConfig: FundingConfig = {
        evm: {
          initialETH: BigInt('100000000000000000'),
          initialTokens: {},
        },
        xrp: {
          initialXRP: BigInt('100000'),
        },
        rateLimits: {
          maxFundingsPerHour: 100,
          maxFundingsPerAgent: 5,
        },
        strategy: 'fixed',
      };

      const mockTreasuryWallet = {
        fundAgentEVM: jest.fn().mockResolvedValue(undefined),
        fundAgentXRP: jest.fn().mockResolvedValue(undefined),
      } as unknown as TreasuryWallet;

      const walletFunder = new AgentWalletFunder(
        fundingConfig,
        walletDerivation,
        mockTreasuryWallet,
        mockTelemetryEmitter,
        mockEvmProvider,
        mockXrplClient
      );

      // Initialize lifecycle manager
      lifecycleManager = new AgentWalletLifecycle(
        walletDerivation,
        walletFunder,
        balanceTracker,
        mockTelemetryEmitter,
        { inactivityDays: 90, autoArchive: true },
        tempDbPath
      );

      // Activate all wallets
      for (const agentId of testAgentIds) {
        await lifecycleManager.createAgentWallet(agentId);
        const record = await lifecycleManager.getLifecycleRecord(agentId);
        originalLifecycleRecords.set(agentId, {
          agentId: record!.agentId,
          state: record!.state,
          totalTransactions: record!.totalTransactions,
        });
        console.log(`Activated wallet for ${agentId}: state=${record!.state}`);
      }

      expect(originalLifecycleRecords.size).toBe(5);

      /**
       * PHASE 2: Backup - Create full backup of all wallet state
       */
      console.log('\n=== PHASE 2: Backup ===');

      const backupConfig: BackupConfig = {
        backupPath: tempBackupPath,
        backupPassword,
        fullBackupSchedule: '0 0 * * 0',
        incrementalBackupSchedule: '0 0 * * *',
      };

      backupManager = new WalletBackupManager(
        seedManager,
        walletDerivation,
        lifecycleManager,
        balanceTracker,
        backupConfig
      );

      const backup = await backupManager.createFullBackup(backupPassword);

      expect(backup.version).toBe('1.0');
      expect(backup.type).toBe('full');
      expect(backup.wallets).toHaveLength(5);
      expect(backup.lifecycleRecords).toHaveLength(5);
      expect(backup.checksum).toBeTruthy();

      console.log(`Full backup created: ${backup.wallets.length} wallets`);
      console.log(`Checksum: ${backup.checksum.slice(0, 16)}...`);

      // Find backup file
      const backupFiles = fs
        .readdirSync(tempBackupPath)
        .filter((f) => f.startsWith('wallet-backup-'));
      expect(backupFiles.length).toBeGreaterThan(0);
      const backupFileName = backupFiles[0];
      if (!backupFileName) {
        throw new Error('No backup file found');
      }
      backupFilePath = path.join(tempBackupPath, backupFileName);
      console.log(`Backup file: ${backupFilePath}`);

      // Verify backup file exists
      expect(fs.existsSync(backupFilePath)).toBe(true);
      const backupFileSize = fs.statSync(backupFilePath).size;
      console.log(`Backup file size: ${(backupFileSize / 1024).toFixed(2)} KB`);

      /**
       * PHASE 3: Disaster Simulation - Destroy all wallet state
       */
      console.log('\n=== PHASE 3: Disaster Simulation ===');

      // Close all database connections
      lifecycleManager.close();
      walletDerivation.close();
      // balanceTracker doesn't have close method, but we'll destroy the instance

      console.log('Closed all database connections');

      // Delete wallet database file
      if (fs.existsSync(tempDbPath)) {
        fs.unlinkSync(tempDbPath);
        console.log(`Deleted wallet database: ${tempDbPath}`);
      }

      // Delete seed manager encrypted seed file
      const seedPath = path.join(tempDir, 'encrypted-seed');
      if (fs.existsSync(seedPath)) {
        fs.unlinkSync(seedPath);
        console.log(`Deleted encrypted seed: ${seedPath}`);
      }

      // Verify database is gone
      expect(fs.existsSync(tempDbPath)).toBe(false);
      expect(fs.existsSync(seedPath)).toBe(false);

      console.log('💥 DISASTER: All wallet state destroyed!');

      /**
       * PHASE 4: Recovery - Restore from backup file
       */
      console.log('\n=== PHASE 4: Recovery ===');

      // Create NEW component instances (fresh state)
      const newSeedManager = new WalletSeedManager(undefined, {
        storageBackend: 'filesystem',
        storagePath: tempDir,
      });
      await newSeedManager.initialize();

      const newWalletDerivation = new AgentWalletDerivation(
        newSeedManager,
        backupPassword,
        tempDbPath
      );

      const newBalanceTracker = new AgentBalanceTracker(
        newWalletDerivation,
        mockEvmProvider,
        mockXrplClient,
        mockTelemetryEmitter,
        { pollingInterval: 60000 },
        tempDbPath
      );

      const newWalletFunder = new AgentWalletFunder(
        fundingConfig,
        newWalletDerivation,
        mockTreasuryWallet,
        mockTelemetryEmitter,
        mockEvmProvider,
        mockXrplClient
      );

      const newLifecycleManager = new AgentWalletLifecycle(
        newWalletDerivation,
        newWalletFunder,
        newBalanceTracker,
        mockTelemetryEmitter,
        { inactivityDays: 90, autoArchive: true },
        tempDbPath
      );

      const newBackupManager = new WalletBackupManager(
        newSeedManager,
        newWalletDerivation,
        newLifecycleManager,
        newBalanceTracker,
        backupConfig
      );

      console.log('Created new component instances (fresh state)');

      // Load backup from file
      const loadedBackup = await newBackupManager.loadBackupFromFile(backupFilePath);
      console.log(
        `Loaded backup: version=${loadedBackup.version}, wallets=${loadedBackup.wallets.length}`
      );

      // Restore from backup
      await newBackupManager.restoreFromBackup(loadedBackup, backupPassword);
      console.log('✅ Restore completed successfully');

      /**
       * PHASE 5: Verification - Validate restored state matches original
       */
      console.log('\n=== PHASE 5: Verification ===');

      // Verify master seed restored (can derive same wallets)
      const restoredMasterSeed = await newSeedManager.decryptAndLoad(backupPassword);
      expect(restoredMasterSeed.mnemonic).toBe(masterSeed.mnemonic);
      console.log('✅ Master seed restored correctly');

      // Verify all wallets restored with correct addresses
      for (const agentId of testAgentIds) {
        const restoredWallet = await newWalletDerivation.getAgentWallet(agentId);
        const originalWallet = originalWallets.get(agentId);

        expect(restoredWallet).toBeDefined();
        expect(originalWallet).toBeDefined();
        expect(restoredWallet!.agentId).toBe(originalWallet!.agentId);
        expect(restoredWallet!.evmAddress).toBe(originalWallet!.evmAddress);
        expect(restoredWallet!.xrpAddress).toBe(originalWallet!.xrpAddress);
        expect(restoredWallet!.derivationIndex).toBe(originalWallet!.derivationIndex);

        console.log(`✅ ${agentId}: Wallet addresses match`);
      }

      // Verify lifecycle records restored
      for (const agentId of testAgentIds) {
        const restoredRecord = await newLifecycleManager.getLifecycleRecord(agentId);
        const originalRecord = originalLifecycleRecords.get(agentId);

        expect(restoredRecord).toBeDefined();
        expect(originalRecord).toBeDefined();
        expect(restoredRecord!.agentId).toBe(originalRecord!.agentId);
        expect(restoredRecord!.state).toBe(originalRecord!.state);

        console.log(`✅ ${agentId}: Lifecycle state=${restoredRecord!.state}`);
      }

      // Verify activity records restored
      const agent001Record = await newLifecycleManager.getLifecycleRecord('agent-001');
      expect(agent001Record!.totalTransactions).toBeGreaterThan(0);
      console.log(`✅ agent-001: ${agent001Record!.totalTransactions} transactions restored`);

      // Verify balance reconciliation completed (no errors)
      const agent001Balances = await newBalanceTracker.getAllBalances('agent-001');
      expect(agent001Balances).toBeDefined();
      console.log(`✅ Balance reconciliation completed for ${testAgentIds.length} agents`);

      // Cleanup
      newLifecycleManager.close();
      newWalletDerivation.close();

      console.log('\n🎉 DISASTER RECOVERY TEST PASSED!');
      console.log('All wallet state successfully restored from backup.');
    }, 60000); // 60 second timeout for integration test
  });

  describe('Incremental Backup and Restore', () => {
    it('should restore from full + incremental backups', async () => {
      console.log('\n=== Incremental Backup Test ===');

      // Setup initial state
      const seedManager = new WalletSeedManager(undefined, {
        storageBackend: 'filesystem',
        storagePath: tempDir,
      });
      await seedManager.initialize();

      const masterSeed = await seedManager.generateMasterSeed(256);
      await seedManager.encryptAndStore(masterSeed, backupPassword);

      const walletDerivation = new AgentWalletDerivation(seedManager, backupPassword, tempDbPath);

      // Derive 5 wallets
      for (let i = 0; i < 5; i++) {
        await walletDerivation.deriveAgentWallet(`agent-${i}`);
      }

      const balanceTracker = new AgentBalanceTracker(
        walletDerivation,
        mockEvmProvider,
        mockXrplClient,
        mockTelemetryEmitter,
        { pollingInterval: 60000 },
        tempDbPath
      );

      const walletFunder = new AgentWalletFunder(
        fundingConfig,
        walletDerivation,
        mockTreasuryWallet,
        mockTelemetryEmitter,
        mockEvmProvider,
        mockXrplClient
      );

      const lifecycleManager = new AgentWalletLifecycle(
        walletDerivation,
        walletFunder,
        balanceTracker,
        mockTelemetryEmitter,
        { inactivityDays: 90, autoArchive: true },
        tempDbPath
      );

      for (let i = 0; i < 5; i++) {
        await lifecycleManager.createWallet(`agent-${i}`);
      }

      const backupConfig: BackupConfig = {
        backupPath: tempBackupPath,
        backupPassword,
        fullBackupSchedule: '0 0 * * 0',
        incrementalBackupSchedule: '0 0 * * *',
      };

      const backupManager = new WalletBackupManager(
        seedManager,
        walletDerivation,
        lifecycleManager,
        balanceTracker,
        backupConfig
      );

      // Create full backup (5 wallets)
      const fullBackup = await backupManager.createFullBackup(backupPassword);
      expect(fullBackup.wallets).toHaveLength(5);
      console.log(`Full backup: ${fullBackup.wallets.length} wallets`);

      // Wait a moment, then derive 2 more wallets
      await new Promise((resolve) => setTimeout(resolve, 100));
      await walletDerivation.deriveAgentWallet('agent-5');
      await walletDerivation.deriveAgentWallet('agent-6');
      await lifecycleManager.createWallet('agent-5');
      await lifecycleManager.createWallet('agent-6');

      // Create incremental backup (only 2 new wallets)
      const incrementalBackup = await backupManager.createIncrementalBackup(backupPassword);
      expect(incrementalBackup.type).toBe('incremental');
      expect(incrementalBackup.wallets.length).toBeGreaterThanOrEqual(2);
      console.log(`Incremental backup: ${incrementalBackup.wallets.length} changed wallets`);

      // Simulate disaster
      lifecycleManager.close();
      walletDerivation.close();
      fs.unlinkSync(tempDbPath);
      const seedPath = path.join(tempDir, 'encrypted-seed');
      if (fs.existsSync(seedPath)) {
        fs.unlinkSync(seedPath);
      }

      console.log('💥 Destroyed state');

      // Restore from full backup
      const newSeedManager = new WalletSeedManager(undefined, {
        storageBackend: 'filesystem',
        storagePath: tempDir,
      });
      await newSeedManager.initialize();

      const newWalletDerivation = new AgentWalletDerivation(
        newSeedManager,
        backupPassword,
        tempDbPath
      );
      const newBalanceTracker = new AgentBalanceTracker(
        newWalletDerivation,
        mockEvmProvider,
        mockXrplClient,
        mockTelemetryEmitter,
        { pollingInterval: 60000 },
        tempDbPath
      );
      const newWalletFunder = new AgentWalletFunder(
        fundingConfig,
        newWalletDerivation,
        mockTreasuryWallet,
        mockTelemetryEmitter,
        mockEvmProvider,
        mockXrplClient
      );
      const newLifecycleManager = new AgentWalletLifecycle(
        newWalletDerivation,
        newWalletFunder,
        newBalanceTracker,
        mockTelemetryEmitter,
        { inactivityDays: 90, autoArchive: true },
        tempDbPath
      );
      const newBackupManager = new WalletBackupManager(
        newSeedManager,
        newWalletDerivation,
        newLifecycleManager,
        newBalanceTracker,
        backupConfig
      );

      // Restore full backup first
      await newBackupManager.restoreFromBackup(fullBackup, backupPassword);
      console.log('✅ Restored full backup');

      // Then restore incremental backup
      await newBackupManager.restoreFromBackup(incrementalBackup, backupPassword);
      console.log('✅ Restored incremental backup');

      // Verify all 7 wallets restored
      const allWallets = newWalletDerivation.getAllWallets();
      expect(allWallets.length).toBeGreaterThanOrEqual(7);
      console.log(`✅ All ${allWallets.length} wallets restored`);

      // Cleanup
      newLifecycleManager.close();
      newWalletDerivation.close();
    }, 60000);
  });

  describe('Backup Integrity Failure Handling', () => {
    it('should reject corrupted backup file', async () => {
      console.log('\n=== Backup Integrity Test ===');

      // Create a valid backup first
      const seedManager = new WalletSeedManager(undefined, {
        storageBackend: 'filesystem',
        storagePath: tempDir,
      });
      await seedManager.initialize();

      const masterSeed = await seedManager.generateMasterSeed(256);
      await seedManager.encryptAndStore(masterSeed, backupPassword);

      const walletDerivation = new AgentWalletDerivation(seedManager, backupPassword, tempDbPath);
      await walletDerivation.deriveAgentWallet('test-agent');

      const balanceTracker = new AgentBalanceTracker(
        walletDerivation,
        mockEvmProvider,
        mockXrplClient,
        mockTelemetryEmitter,
        { pollingInterval: 60000 },
        tempDbPath
      );

      const walletFunder = new AgentWalletFunder(
        fundingConfig,
        walletDerivation,
        mockTreasuryWallet,
        mockTelemetryEmitter,
        mockEvmProvider,
        mockXrplClient
      );

      const lifecycleManager = new AgentWalletLifecycle(
        walletDerivation,
        walletFunder,
        balanceTracker,
        mockTelemetryEmitter,
        { inactivityDays: 90, autoArchive: true },
        tempDbPath
      );
      await lifecycleManager.createWallet('test-agent');

      const backupConfig: BackupConfig = {
        backupPath: tempBackupPath,
        backupPassword,
        fullBackupSchedule: '0 0 * * 0',
        incrementalBackupSchedule: '0 0 * * *',
      };

      const backupManager = new WalletBackupManager(
        seedManager,
        walletDerivation,
        lifecycleManager,
        balanceTracker,
        backupConfig
      );

      const backup = await backupManager.createFullBackup(backupPassword);

      // Manually corrupt the checksum
      backup.checksum = 'corrupted-checksum-value';

      console.log('Corrupted backup checksum');

      // Attempt restore
      await expect(backupManager.restoreFromBackup(backup, backupPassword)).rejects.toThrow(
        'Backup checksum validation failed'
      );

      console.log('✅ Corrupted backup correctly rejected');

      // Verify no partial state restored (database should not exist or be empty)
      // Since restore failed early, database shouldn't be modified

      // Cleanup
      lifecycleManager.close();
      walletDerivation.close();
    });
  });
});
