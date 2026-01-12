/**
 * Agent Wallet Derivation Tests
 * Story 11.2: Agent Wallet Derivation and Address Generation
 *
 * Tests wallet derivation, caching, database persistence, and security
 */

import Database from 'better-sqlite3';
import { AgentWalletDerivation, WalletNotFoundError } from './agent-wallet-derivation';
import { WalletSeedManager, MasterSeed } from './wallet-seed-manager';
import * as bip39 from 'bip39';
import * as path from 'path';
import * as fs from 'fs';

// Test mnemonic from Story 11.1 (deterministic test vector)
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PASSWORD = 'TestPass123!@#$%^&*()'; // Strong password for tests

// Helper function to create master seed from test mnemonic
async function createTestMasterSeed(): Promise<MasterSeed> {
  const seed = await bip39.mnemonicToSeed(TEST_MNEMONIC);
  return {
    mnemonic: TEST_MNEMONIC,
    seed: Buffer.from(seed),
    createdAt: Date.now(),
  };
}

describe('AgentWalletDerivation', () => {
  let seedManager: WalletSeedManager;
  let derivation: AgentWalletDerivation;
  let testDbPath: string;

  beforeEach(async () => {
    // Generate unique database path for each test
    testDbPath = path.join(
      process.cwd(),
      'data',
      'wallet',
      `test-${Math.random().toString(36).substring(7)}.db`
    );

    // Create seed manager and initialize
    seedManager = new WalletSeedManager(undefined, {
      storageBackend: 'filesystem',
      storagePath: path.join(process.cwd(), 'data', 'wallet', 'test'),
    });
    await seedManager.initialize();

    // Generate and store test master seed
    const masterSeed = await createTestMasterSeed();
    await seedManager.encryptAndStore(masterSeed, TEST_PASSWORD);

    // Initialize derivation with unique database path for test isolation
    derivation = new AgentWalletDerivation(seedManager, TEST_PASSWORD, testDbPath);
  });

  afterEach(() => {
    derivation.close();

    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('deriveAgentWallet', () => {
    it('should derive first agent wallet with index 0', async () => {
      const wallet = await derivation.deriveAgentWallet('agent-001');

      expect(wallet).toBeDefined();
      expect(wallet.agentId).toBe('agent-001');
      expect(wallet.derivationIndex).toBe(0);
      expect(wallet.evmAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(wallet.xrpAddress).toMatch(/^r[a-zA-Z0-9]{24,34}$/);
      expect(wallet.createdAt).toBeGreaterThan(0);
    });

    it('should derive multiple wallets with incremental indexes', async () => {
      const wallet1 = await derivation.deriveAgentWallet('agent-001');
      const wallet2 = await derivation.deriveAgentWallet('agent-002');
      const wallet3 = await derivation.deriveAgentWallet('agent-003');

      expect(wallet1.derivationIndex).toBe(0);
      expect(wallet2.derivationIndex).toBe(1);
      expect(wallet3.derivationIndex).toBe(2);

      // Verify all addresses are unique
      const evmAddresses = [wallet1.evmAddress, wallet2.evmAddress, wallet3.evmAddress];
      const xrpAddresses = [wallet1.xrpAddress, wallet2.xrpAddress, wallet3.xrpAddress];

      expect(new Set(evmAddresses).size).toBe(3);
      expect(new Set(xrpAddresses).size).toBe(3);
    });

    it('should return cached wallet if already derived', async () => {
      const wallet1 = await derivation.deriveAgentWallet('agent-001');
      const wallet2 = await derivation.deriveAgentWallet('agent-001');

      expect(wallet1).toEqual(wallet2);
      expect(wallet1.derivationIndex).toBe(wallet2.derivationIndex);
    });

    it('should produce deterministic addresses (AC 9)', async () => {
      // Create first derivation instance with unique DB path
      const testDb1 = path.join(process.cwd(), 'data', 'wallet', 'test-determ-1.db');
      const derivation1 = new AgentWalletDerivation(seedManager, TEST_PASSWORD, testDb1);
      const wallet1 = await derivation1.deriveAgentWallet('agent-determ-test');

      // Create second derivation instance with same seed but separate DB
      const seedManager2 = new WalletSeedManager(undefined, {
        storageBackend: 'filesystem',
        storagePath: path.join(process.cwd(), 'data', 'wallet', 'test2'),
      });
      await seedManager2.initialize();
      const masterSeed2 = await createTestMasterSeed();
      await seedManager2.encryptAndStore(masterSeed2, TEST_PASSWORD);

      const testDb2 = path.join(process.cwd(), 'data', 'wallet', 'test-determ-2.db');
      const derivation2 = new AgentWalletDerivation(seedManager2, TEST_PASSWORD, testDb2);
      const wallet2 = await derivation2.deriveAgentWallet('agent-determ-test');

      // Addresses should match exactly
      expect(wallet1.evmAddress).toBe(wallet2.evmAddress);
      expect(wallet1.xrpAddress).toBe(wallet2.xrpAddress);

      derivation1.close();
      derivation2.close();

      // Clean up test databases
      if (fs.existsSync(testDb1)) fs.unlinkSync(testDb1);
      if (fs.existsSync(testDb2)) fs.unlinkSync(testDb2);
    });
  });

  describe('getAgentWallet', () => {
    it('should retrieve existing wallet from cache', async () => {
      const wallet1 = await derivation.deriveAgentWallet('agent-001');
      const wallet2 = await derivation.getAgentWallet('agent-001');

      expect(wallet2).toBeDefined();
      expect(wallet2).toEqual(wallet1);
    });

    it('should return null for non-existent wallet', async () => {
      const wallet = await derivation.getAgentWallet('agent-999');
      expect(wallet).toBeNull();
    });
  });

  describe('getAllWallets', () => {
    it('should return all cached wallets', async () => {
      await derivation.deriveAgentWallet('agent-001');
      await derivation.deriveAgentWallet('agent-002');
      await derivation.deriveAgentWallet('agent-003');

      const allWallets = derivation.getAllWallets();
      expect(allWallets).toHaveLength(3);
      expect(allWallets.map((w) => w.agentId).sort()).toEqual([
        'agent-001',
        'agent-002',
        'agent-003',
      ]);
    });
  });

  describe('batchDeriveWallets', () => {
    it('should derive multiple wallets in batch', async () => {
      const agentIds = ['agent-batch-001', 'agent-batch-002', 'agent-batch-003'];
      const wallets = await derivation.batchDeriveWallets(agentIds);

      expect(wallets).toHaveLength(3);
      expect(wallets[0]!.agentId).toBe('agent-batch-001');
      expect(wallets[1]!.agentId).toBe('agent-batch-002');
      expect(wallets[2]!.agentId).toBe('agent-batch-003');

      // Verify all addresses unique
      const evmAddresses = wallets.map((w) => w.evmAddress);
      const xrpAddresses = wallets.map((w) => w.xrpAddress);

      expect(new Set(evmAddresses).size).toBe(3);
      expect(new Set(xrpAddresses).size).toBe(3);
    });
  });

  describe('getAgentSigner', () => {
    it('should get EVM signer for transaction signing', async () => {
      const wallet = await derivation.deriveAgentWallet('agent-001');
      const signer = await derivation.getAgentSigner('agent-001', 'evm');

      expect(signer).toBeDefined();
      expect(signer.address).toBe(wallet.evmAddress);

      // Verify signer can sign messages (only for EVM wallet)
      if ('signMessage' in signer) {
        const signature = await signer.signMessage('test');
        expect(signature).toMatch(/^0x[a-fA-F0-9]{130}$/);
      }
    });

    it('should get XRP signer for transaction signing', async () => {
      const wallet = await derivation.deriveAgentWallet('agent-001');
      const signer = await derivation.getAgentSigner('agent-001', 'xrp');

      expect(signer).toBeDefined();
      expect(signer.address).toBe(wallet.xrpAddress);

      // XRP Wallet has specific properties
      if ('publicKey' in signer) {
        expect(signer.publicKey).toBeDefined();
        expect(signer.privateKey).toBeDefined();
      }
    });

    it('should throw WalletNotFoundError for non-existent wallet', async () => {
      await expect(derivation.getAgentSigner('agent-999', 'evm')).rejects.toThrow(
        WalletNotFoundError
      );
    });
  });

  describe('getWalletByEvmAddress', () => {
    it('should find wallet by EVM address', async () => {
      const wallet = await derivation.deriveAgentWallet('agent-001');
      const found = await derivation.getWalletByEvmAddress(wallet.evmAddress);

      expect(found).toBeDefined();
      expect(found?.agentId).toBe('agent-001');
      expect(found?.evmAddress).toBe(wallet.evmAddress);
    });

    it('should return null for non-existent EVM address', async () => {
      const found = await derivation.getWalletByEvmAddress(
        '0x0000000000000000000000000000000000000000'
      );
      expect(found).toBeNull();
    });
  });

  describe('getWalletByXrpAddress', () => {
    it('should find wallet by XRP address', async () => {
      const wallet = await derivation.deriveAgentWallet('agent-001');
      const found = await derivation.getWalletByXrpAddress(wallet.xrpAddress);

      expect(found).toBeDefined();
      expect(found?.agentId).toBe('agent-001');
      expect(found?.xrpAddress).toBe(wallet.xrpAddress);
    });

    it('should return null for non-existent XRP address', async () => {
      const found = await derivation.getWalletByXrpAddress('rN7n7otQDd6FczFgLdlqtyMVrn3NnrcVcY');
      expect(found).toBeNull();
    });
  });

  describe('derivation index management', () => {
    it('should prevent index collisions (AC 6)', async () => {
      const wallet1 = await derivation.deriveAgentWallet('agent-001');
      const wallet2 = await derivation.deriveAgentWallet('agent-002');
      const wallet3 = await derivation.deriveAgentWallet('agent-003');

      // All indexes should be unique
      const indexes = [wallet1.derivationIndex, wallet2.derivationIndex, wallet3.derivationIndex];
      expect(new Set(indexes).size).toBe(3);

      // Indexes should be sequential
      expect(indexes.sort((a, b) => a - b)).toEqual([0, 1, 2]);
    });

    it('should validate derivation index bounds (AC 4)', () => {
      // Test that MAX_DERIVATION_INDEX is 2^31 - 1
      const maxIndex = Math.pow(2, 31) - 1;
      expect(
        (AgentWalletDerivation as unknown as { MAX_DERIVATION_INDEX: number }).MAX_DERIVATION_INDEX
      ).toBe(maxIndex);
    });
  });

  describe('security - no private keys in storage', () => {
    it('should not expose private keys in AgentWallet object', async () => {
      const wallet = await derivation.deriveAgentWallet('agent-001');

      // Wallet object should not contain any private key properties
      expect(wallet).not.toHaveProperty('privateKey');
      expect(wallet).not.toHaveProperty('evmPrivateKey');
      expect(wallet).not.toHaveProperty('xrpPrivateKey');

      // Verify only public data
      expect(wallet).toHaveProperty('agentId');
      expect(wallet).toHaveProperty('evmAddress');
      expect(wallet).toHaveProperty('xrpAddress');
      expect(wallet).toHaveProperty('derivationIndex');
      expect(wallet).toHaveProperty('createdAt');
    });
  });

  describe('database persistence', () => {
    it('should persist wallet metadata to database', async () => {
      // Derive wallet - should automatically persist
      const wallet = await derivation.deriveAgentWallet('agent-persist-test');

      // Access the internal database to verify persistence
      const db = (derivation as unknown as { db: Database.Database }).db;
      const row = db
        .prepare('SELECT * FROM agent_wallets WHERE agent_id = ?')
        .get('agent-persist-test') as
        | { agent_id: string; evm_address: string; xrp_address: string }
        | undefined;

      expect(row).toBeDefined();
      expect(row!.agent_id).toBe('agent-persist-test');
      expect(row!.evm_address).toBe(wallet.evmAddress);
      expect(row!.xrp_address).toBe(wallet.xrpAddress);

      // Verify no private keys in database
      const rowString = JSON.stringify(row);
      expect(rowString).not.toContain('privateKey');
      expect(rowString).not.toContain('seed');
      expect(rowString).not.toContain('mnemonic');
    });

    it('should load wallet from database after cache clear', async () => {
      const wallet = await derivation.deriveAgentWallet('agent-001');

      // Clear cache manually
      (
        derivation as unknown as {
          walletCache: Map<string, unknown>;
          indexToAgentId: Map<number, string>;
        }
      ).walletCache.clear();
      (
        derivation as unknown as {
          walletCache: Map<string, unknown>;
          indexToAgentId: Map<number, string>;
        }
      ).indexToAgentId.clear();

      // Should still be able to load from database
      const loaded = await derivation.getAgentWallet('agent-001');
      expect(loaded).toBeDefined();
      expect(loaded?.evmAddress).toBe(wallet.evmAddress);
      expect(loaded?.xrpAddress).toBe(wallet.xrpAddress);
    });
  });
});
