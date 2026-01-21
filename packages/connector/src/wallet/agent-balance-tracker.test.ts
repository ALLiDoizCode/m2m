/**
 * Agent Balance Tracker Tests
 * Story 11.3: Agent Wallet Balance Tracking and Monitoring
 *
 * Tests balance queries, caching, change detection, database persistence,
 * and periodic polling across EVM and XRP blockchains.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import Database from 'better-sqlite3';
import { AgentBalanceTracker } from './agent-balance-tracker';
import { AgentWalletDerivation, AgentWallet } from './agent-wallet-derivation';
import { TelemetryEmitter } from '../telemetry/telemetry-emitter';
import { ethers } from 'ethers';
import { Client as XRPLClient, AccountInfoResponse } from 'xrpl';
import * as path from 'path';
import * as fs from 'fs';

// Test agent wallets
const TEST_AGENT_1: AgentWallet = {
  agentId: 'agent-001',
  derivationIndex: 0,
  evmAddress: '0x1234567890123456789012345678901234567890',
  xrpAddress: 'rN7n7otQDd6FczFgLdhmKRAXMTp1RX1L3F',
  createdAt: Date.now(),
};

const TEST_AGENT_2: AgentWallet = {
  agentId: 'agent-002',
  derivationIndex: 1,
  evmAddress: '0x2234567890123456789012345678901234567890',
  xrpAddress: 'rN7n7otQDd6FczFgLdhmKRAXMTp1RX1L3G',
  createdAt: Date.now(),
};

const TEST_AGENT_3: AgentWallet = {
  agentId: 'agent-003',
  derivationIndex: 2,
  evmAddress: '0x3234567890123456789012345678901234567890',
  xrpAddress: 'rN7n7otQDd6FczFgLdhmKRAXMTp1RX1L3H',
  createdAt: Date.now(),
};

describe('AgentBalanceTracker', () => {
  let tracker: AgentBalanceTracker;
  let mockWalletDerivation: jest.Mocked<AgentWalletDerivation>;
  let mockEvmProvider: jest.Mocked<ethers.Provider>;
  let mockXrplClient: jest.Mocked<XRPLClient>;
  let mockTelemetryEmitter: jest.Mocked<TelemetryEmitter>;
  let testDbPath: string;

  beforeEach(() => {
    // Generate unique database path for test isolation
    testDbPath = path.join(
      process.cwd(),
      'data',
      'wallet',
      `test-balance-${Math.random().toString(36).substring(7)}.db`
    );

    // Create test database directory
    const dbDir = path.dirname(testDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Mock AgentWalletDerivation
    mockWalletDerivation = {
      getAgentWallet: jest.fn(),
      getAllWallets: jest.fn(),
      close: jest.fn(),
    } as unknown as jest.Mocked<AgentWalletDerivation>;

    // Mock EVM Provider
    mockEvmProvider = {
      getBalance: jest.fn(),
    } as unknown as jest.Mocked<ethers.Provider>;

    // Mock XRPL Client
    mockXrplClient = {
      request: jest.fn(),
    } as unknown as jest.Mocked<XRPLClient>;

    // Mock TelemetryEmitter
    mockTelemetryEmitter = {
      emit: jest.fn(),
    } as unknown as jest.Mocked<TelemetryEmitter>;
  });

  afterEach(() => {
    if (tracker) {
      tracker.stop();
    }

    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('getBalance - ETH', () => {
    it('should fetch ETH balance from blockchain (fresh fetch)', async () => {
      mockWalletDerivation.getAgentWallet.mockResolvedValue(TEST_AGENT_1);
      mockEvmProvider.getBalance.mockResolvedValue(1000000000000000000n); // 1 ETH in wei

      tracker = new AgentBalanceTracker(
        mockWalletDerivation,
        mockEvmProvider,
        mockXrplClient,
        mockTelemetryEmitter,
        { pollingInterval: 60000, erc20Tokens: [] },
        testDbPath
      );

      const balance = await tracker.getBalance('agent-001', 'evm', 'ETH');

      expect(balance).toBe(1000000000000000000n);
      expect(mockEvmProvider.getBalance).toHaveBeenCalledWith(TEST_AGENT_1.evmAddress);
    });

    it('should return cached balance if within polling interval (cache hit)', async () => {
      mockWalletDerivation.getAgentWallet.mockResolvedValue(TEST_AGENT_1);
      mockEvmProvider.getBalance.mockResolvedValue(1000000000000000000n);

      tracker = new AgentBalanceTracker(
        mockWalletDerivation,
        mockEvmProvider,
        mockXrplClient,
        mockTelemetryEmitter,
        { pollingInterval: 60000, erc20Tokens: [] },
        testDbPath
      );

      // First fetch (populates cache)
      await tracker.getBalance('agent-001', 'evm', 'ETH');

      // Second fetch (should hit cache)
      mockEvmProvider.getBalance.mockClear();
      const cachedBalance = await tracker.getBalance('agent-001', 'evm', 'ETH');

      expect(cachedBalance).toBe(1000000000000000000n);
      expect(mockEvmProvider.getBalance).not.toHaveBeenCalled();
    });
  });

  describe('getBalance - ERC20', () => {
    it('should fetch ERC20 token balance using balanceOf', async () => {
      const tokenAddress = '0xUSDC0000000000000000000000000000000000';
      mockWalletDerivation.getAgentWallet.mockResolvedValue(TEST_AGENT_1);

      // Mock ethers.Contract balanceOf
      const mockContract = {
        balanceOf: jest.fn().mockResolvedValue(1000000n), // 1 USDC (6 decimals)
      };
      jest.spyOn(ethers, 'Contract').mockReturnValue(mockContract as unknown as ethers.Contract);

      tracker = new AgentBalanceTracker(
        mockWalletDerivation,
        mockEvmProvider,
        mockXrplClient,
        mockTelemetryEmitter,
        { pollingInterval: 60000, erc20Tokens: [tokenAddress] },
        testDbPath
      );

      const balance = await tracker.getBalance('agent-001', 'evm', tokenAddress);

      expect(balance).toBe(1000000n);
      expect(mockContract.balanceOf).toHaveBeenCalledWith(TEST_AGENT_1.evmAddress);
    });
  });

  describe('getBalance - XRP', () => {
    it('should fetch XRP balance from account_info (drops)', async () => {
      mockWalletDerivation.getAgentWallet.mockResolvedValue(TEST_AGENT_1);
      mockXrplClient.request.mockResolvedValue({
        id: 1,
        type: 'response',
        result: {
          account_data: {
            Balance: '10000000', // 10 XRP in drops (1 XRP = 1,000,000 drops)
          },
        },
      } as AccountInfoResponse);

      tracker = new AgentBalanceTracker(
        mockWalletDerivation,
        mockEvmProvider,
        mockXrplClient,
        mockTelemetryEmitter,
        { pollingInterval: 60000, erc20Tokens: [] },
        testDbPath
      );

      const balance = await tracker.getBalance('agent-001', 'xrp', 'XRP');

      expect(balance).toBe(10000000n);
      expect(mockXrplClient.request).toHaveBeenCalledWith({
        command: 'account_info',
        account: TEST_AGENT_1.xrpAddress,
        ledger_index: 'validated',
      });
    });
  });

  describe('getAllBalances', () => {
    it('should fetch all balances (ETH, ERC20, XRP)', async () => {
      const tokenAddress = '0xUSDC0000000000000000000000000000000000';
      mockWalletDerivation.getAgentWallet.mockResolvedValue(TEST_AGENT_1);
      mockEvmProvider.getBalance.mockResolvedValue(1000000000000000000n); // 1 ETH

      // Mock ERC20 contract
      const mockContract = {
        balanceOf: jest.fn().mockResolvedValue(1000000n), // 1 USDC
      };
      jest.spyOn(ethers, 'Contract').mockReturnValue(mockContract as unknown as ethers.Contract);

      mockXrplClient.request.mockResolvedValue({
        id: 1,
        type: 'response',
        result: {
          account_data: {
            Balance: '10000000', // 10 XRP
          },
        },
      } as any);

      tracker = new AgentBalanceTracker(
        mockWalletDerivation,
        mockEvmProvider,
        mockXrplClient,
        mockTelemetryEmitter,
        { pollingInterval: 60000, erc20Tokens: [tokenAddress] },
        testDbPath
      );

      const balances = await tracker.getAllBalances('agent-001');

      expect(balances).toHaveLength(3);
      expect(balances[0]).toMatchObject({
        agentId: 'agent-001',
        chain: 'evm',
        token: 'ETH',
        balance: 1000000000000000000n,
      });
      expect(balances[1]).toMatchObject({
        agentId: 'agent-001',
        chain: 'evm',
        token: tokenAddress,
        balance: 1000000n,
      });
      expect(balances[2]).toMatchObject({
        agentId: 'agent-001',
        chain: 'xrp',
        token: 'XRP',
        balance: 10000000n,
      });
    });

    it('should return empty array for non-existent agent', async () => {
      mockWalletDerivation.getAgentWallet.mockResolvedValue(null);

      tracker = new AgentBalanceTracker(
        mockWalletDerivation,
        mockEvmProvider,
        mockXrplClient,
        mockTelemetryEmitter,
        { pollingInterval: 60000, erc20Tokens: [] },
        testDbPath
      );

      const balances = await tracker.getAllBalances('agent-999');

      expect(balances).toEqual([]);
    });
  });

  describe('getBalance - Error Handling', () => {
    it('should throw error for non-existent agent', async () => {
      mockWalletDerivation.getAgentWallet.mockResolvedValue(null);

      tracker = new AgentBalanceTracker(
        mockWalletDerivation,
        mockEvmProvider,
        mockXrplClient,
        mockTelemetryEmitter,
        { pollingInterval: 60000, erc20Tokens: [] },
        testDbPath
      );

      await expect(tracker.getBalance('agent-999', 'evm', 'ETH')).rejects.toThrow(
        'No wallet for agent agent-999'
      );
    });
  });

  describe('Balance Change Detection', () => {
    it('should emit AGENT_BALANCE_CHANGED event when balance changes', async () => {
      mockWalletDerivation.getAgentWallet.mockResolvedValue(TEST_AGENT_1);
      mockEvmProvider.getBalance
        .mockResolvedValueOnce(1000n) // First fetch
        .mockResolvedValueOnce(2000n); // Second fetch (changed)

      tracker = new AgentBalanceTracker(
        mockWalletDerivation,
        mockEvmProvider,
        mockXrplClient,
        mockTelemetryEmitter,
        { pollingInterval: 100, erc20Tokens: [] }, // Short interval to force refetch
        testDbPath
      );

      // First fetch (populate cache)
      await tracker.getBalance('agent-001', 'evm', 'ETH');

      // Wait for cache to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Second fetch (balance changed)
      await tracker.getBalance('agent-001', 'evm', 'ETH');

      expect(mockTelemetryEmitter.emit).toHaveBeenCalledWith({
        type: 'AGENT_BALANCE_CHANGED',
        agentId: 'agent-001',
        chain: 'evm',
        token: 'ETH',
        oldBalance: '1000',
        newBalance: '2000',
        change: '1000',
        timestamp: expect.any(String),
      });
    });

    it('should not emit event when balance unchanged', async () => {
      mockWalletDerivation.getAgentWallet.mockResolvedValue(TEST_AGENT_1);
      mockEvmProvider.getBalance.mockResolvedValue(1000n); // Same balance both times

      tracker = new AgentBalanceTracker(
        mockWalletDerivation,
        mockEvmProvider,
        mockXrplClient,
        mockTelemetryEmitter,
        { pollingInterval: 100, erc20Tokens: [] },
        testDbPath
      );

      // First fetch
      await tracker.getBalance('agent-001', 'evm', 'ETH');

      // Wait for cache to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      mockTelemetryEmitter.emit.mockClear();

      // Second fetch (balance unchanged)
      await tracker.getBalance('agent-001', 'evm', 'ETH');

      expect(mockTelemetryEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('pollAllBalances', () => {
    it('should poll balances for all agents', async () => {
      mockWalletDerivation.getAllWallets.mockReturnValue([
        TEST_AGENT_1,
        TEST_AGENT_2,
        TEST_AGENT_3,
      ]);
      mockWalletDerivation.getAgentWallet
        .mockResolvedValueOnce(TEST_AGENT_1)
        .mockResolvedValueOnce(TEST_AGENT_1) // ETH for agent-001
        .mockResolvedValueOnce(TEST_AGENT_1) // XRP for agent-001
        .mockResolvedValueOnce(TEST_AGENT_2)
        .mockResolvedValueOnce(TEST_AGENT_2)
        .mockResolvedValueOnce(TEST_AGENT_2)
        .mockResolvedValueOnce(TEST_AGENT_3)
        .mockResolvedValueOnce(TEST_AGENT_3)
        .mockResolvedValueOnce(TEST_AGENT_3);

      mockEvmProvider.getBalance.mockResolvedValue(1000n);
      mockXrplClient.request.mockResolvedValue({
        id: 1,
        type: 'response',
        result: { account_data: { Balance: '10000000' } },
      } as any);

      tracker = new AgentBalanceTracker(
        mockWalletDerivation,
        mockEvmProvider,
        mockXrplClient,
        mockTelemetryEmitter,
        { pollingInterval: 60000, erc20Tokens: [] },
        testDbPath
      );

      // Trigger poll manually
      await tracker['pollAllBalances']();

      // Verify getAllWallets called
      expect(mockWalletDerivation.getAllWallets).toHaveBeenCalled();

      // Verify balances fetched for all 3 agents (ETH + XRP = 2 queries per agent)
      expect(mockEvmProvider.getBalance).toHaveBeenCalledTimes(3);
      expect(mockXrplClient.request).toHaveBeenCalledTimes(3);
    });

    it('should continue polling despite individual balance fetch failure', async () => {
      mockWalletDerivation.getAllWallets.mockReturnValue([
        TEST_AGENT_1,
        TEST_AGENT_2,
        TEST_AGENT_3,
      ]);

      // agent-001: getAllBalances check + ETH fetch + XRP fetch = 3 calls
      mockWalletDerivation.getAgentWallet
        .mockResolvedValueOnce(TEST_AGENT_1) // getAllBalances initial check
        .mockResolvedValueOnce(TEST_AGENT_1) // ETH fetchBalance
        .mockResolvedValueOnce(TEST_AGENT_1) // XRP fetchBalance
        // agent-002: getAllBalances check fails
        .mockResolvedValueOnce(null) // getAllBalances returns [] immediately
        // agent-003: getAllBalances check + ETH fetch + XRP fetch = 3 calls
        .mockResolvedValueOnce(TEST_AGENT_3) // getAllBalances initial check
        .mockResolvedValueOnce(TEST_AGENT_3) // ETH fetchBalance
        .mockResolvedValueOnce(TEST_AGENT_3); // XRP fetchBalance

      mockEvmProvider.getBalance.mockResolvedValue(1000n);
      mockXrplClient.request.mockResolvedValue({
        id: 1,
        type: 'response',
        result: { account_data: { Balance: '10000000' } },
      } as any);

      tracker = new AgentBalanceTracker(
        mockWalletDerivation,
        mockEvmProvider,
        mockXrplClient,
        mockTelemetryEmitter,
        { pollingInterval: 60000, erc20Tokens: [] },
        testDbPath
      );

      // Trigger poll manually
      await tracker['pollAllBalances']();

      // Verify polling continued for agent-003 despite agent-002 failure
      expect(mockWalletDerivation.getAllWallets).toHaveBeenCalled();
      expect(mockEvmProvider.getBalance).toHaveBeenCalledTimes(2); // Called for agent-001 and agent-003
    });
  });

  describe('Database Persistence', () => {
    it('should persist balance to database', async () => {
      mockWalletDerivation.getAgentWallet.mockResolvedValue(TEST_AGENT_1);
      mockEvmProvider.getBalance.mockResolvedValue(1000000000000000000n);

      tracker = new AgentBalanceTracker(
        mockWalletDerivation,
        mockEvmProvider,
        mockXrplClient,
        mockTelemetryEmitter,
        { pollingInterval: 60000, erc20Tokens: [] },
        testDbPath
      );

      await tracker.getBalance('agent-001', 'evm', 'ETH');

      // Wait for async database write
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Query database directly to verify persistence
      const db = new Database(testDbPath);
      const row = db
        .prepare('SELECT * FROM agent_balances WHERE agent_id = ? AND chain = ? AND token = ?')
        .get('agent-001', 'evm', 'ETH') as
        | { agent_id: string; chain: string; token: string; balance: string; timestamp: number }
        | undefined;

      expect(row).toBeDefined();
      expect(row!.agent_id).toBe('agent-001');
      expect(row!.chain).toBe('evm');
      expect(row!.token).toBe('ETH');
      expect(row!.balance).toBe('1000000000000000000'); // Stored as string
      expect(row!.timestamp).toBeGreaterThan(0);

      db.close();
    });
  });

  describe('getBalanceHistory', () => {
    it('should retrieve balance history within time range', async () => {
      mockWalletDerivation.getAgentWallet.mockResolvedValue(TEST_AGENT_1);
      mockEvmProvider.getBalance.mockResolvedValue(1000n);

      tracker = new AgentBalanceTracker(
        mockWalletDerivation,
        mockEvmProvider,
        mockXrplClient,
        mockTelemetryEmitter,
        { pollingInterval: 60000, erc20Tokens: [] },
        testDbPath
      );

      // Insert test balance records at different times
      const db = new Database(testDbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_balances (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL,
          chain TEXT NOT NULL,
          token TEXT NOT NULL,
          balance TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        )
      `);

      const now = Date.now();
      db.prepare(
        'INSERT INTO agent_balances (agent_id, chain, token, balance, timestamp) VALUES (?, ?, ?, ?, ?)'
      ).run('agent-001', 'evm', 'ETH', '1000', now - 3000);
      db.prepare(
        'INSERT INTO agent_balances (agent_id, chain, token, balance, timestamp) VALUES (?, ?, ?, ?, ?)'
      ).run('agent-001', 'evm', 'ETH', '2000', now - 2000);
      db.prepare(
        'INSERT INTO agent_balances (agent_id, chain, token, balance, timestamp) VALUES (?, ?, ?, ?, ?)'
      ).run('agent-001', 'evm', 'ETH', '3000', now - 1000);
      db.close();

      // Query balance history
      const history = tracker.getBalanceHistory('agent-001', 'evm', 'ETH', now - 3500, now);

      expect(history).toHaveLength(3);
      expect(history[0]?.balance).toBe(1000n);
      expect(history[1]?.balance).toBe(2000n);
      expect(history[2]?.balance).toBe(3000n);
    });
  });

  describe('TigerBeetle Reconciliation', () => {
    it('should log stub message for TigerBeetle reconciliation', async () => {
      tracker = new AgentBalanceTracker(
        mockWalletDerivation,
        mockEvmProvider,
        mockXrplClient,
        mockTelemetryEmitter,
        { pollingInterval: 60000, erc20Tokens: [] },
        testDbPath
      );

      // Should not throw error
      await expect(tracker.reconcileWithTigerBeetle('agent-001')).resolves.toBeUndefined();
    });
  });

  describe('Polling Control', () => {
    it('should stop periodic polling when stop() called', async () => {
      mockWalletDerivation.getAllWallets.mockReturnValue([]);

      tracker = new AgentBalanceTracker(
        mockWalletDerivation,
        mockEvmProvider,
        mockXrplClient,
        mockTelemetryEmitter,
        { pollingInterval: 100, erc20Tokens: [] }, // Fast polling for test
        testDbPath
      );

      // Stop polling
      tracker.stop();

      // Wait for a poll cycle
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify no polling occurred
      expect(mockWalletDerivation.getAllWallets).not.toHaveBeenCalled();
    });
  });
});
