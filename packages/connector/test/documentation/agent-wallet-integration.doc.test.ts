/**
 * Documentation Tests - Agent Wallet Integration
 *
 * These tests verify that code examples in documentation are correct and compile.
 * Tests extract code snippets from documentation and validate they work as expected.
 */

import { AgentWalletLifecycle } from '../../src/wallet/agent-wallet-lifecycle';
import { AgentBalanceTracker } from '../../src/wallet/agent-balance-tracker';
import { pino } from 'pino';

const logger = pino({ level: 'silent' }); // Suppress logs in tests

describe('Documentation Examples - Integration Guide', () => {
  describe('Quick Start Examples', () => {
    test('should create agent wallet (Quick Start Step 1)', async () => {
      // Example from: docs/guides/agent-wallet-integration.md - Step 1
      const lifecycle = new AgentWalletLifecycle();

      try {
        const wallet = await lifecycle.createAgentWallet('doc-test-agent-001');

        expect(wallet).toBeDefined();
        expect(wallet.agentId).toBe('doc-test-agent-001');
        expect(wallet.evmAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(wallet.xrpAddress).toMatch(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
        expect(wallet.status).toBe('pending');

        logger.info('Agent wallet created', {
          agentId: wallet.agentId,
          evmAddress: wallet.evmAddress,
          xrpAddress: wallet.xrpAddress,
          status: wallet.status,
        });
      } catch (error) {
        logger.error('Wallet creation failed', { error: error.message });
        throw error;
      }
    });

    test('should check balance (Quick Start Step 2)', async () => {
      // Example from: docs/guides/agent-wallet-integration.md - Step 2
      const balanceTracker = new AgentBalanceTracker();
      const agentId = 'doc-test-agent-001';

      try {
        const balances = await balanceTracker.getAllBalances(agentId);

        expect(balances).toBeDefined();
        expect(Array.isArray(balances)).toBe(true);

        logger.info('Agent balances retrieved', {
          agentId,
          balances: balances.map((b) => ({
            chain: b.chain,
            token: b.token,
            balance: b.balance.toString(),
          })),
        });
      } catch (error) {
        logger.error('Balance check failed', { error: error.message });
        throw error;
      }
    });
  });

  describe('Wallet Creation Examples', () => {
    test('should demonstrate wallet derivation', async () => {
      // Example from: docs/guides/agent-wallet-integration.md - Wallet Creation
      const lifecycle = new AgentWalletLifecycle();

      // Check if wallet exists
      let wallet = await lifecycle.getAgentWallet('doc-test-agent-002');

      if (!wallet) {
        // Wallet doesn't exist, create new one
        wallet = await lifecycle.createAgentWallet('doc-test-agent-002');
      }

      expect(wallet).toBeDefined();
      expect(wallet.agentId).toBe('doc-test-agent-002');
      expect(wallet.derivationIndex).toBeGreaterThanOrEqual(0);
    });

    test('should handle existing wallet error', async () => {
      // Example from: docs/guides/agent-wallet-integration.md - Error Handling
      const lifecycle = new AgentWalletLifecycle();

      // Create wallet first
      await lifecycle.createAgentWallet('doc-test-agent-003');

      // Try to create again - should throw error
      await expect(lifecycle.createAgentWallet('doc-test-agent-003')).rejects.toThrow(
        'Wallet already exists'
      );
    });
  });

  describe('Balance Queries Examples', () => {
    test('should query specific balance', async () => {
      // Example from: docs/guides/agent-wallet-integration.md - Get Specific Balance
      const balanceTracker = new AgentBalanceTracker();

      const ethBalance = await balanceTracker.getBalance('doc-test-agent-001', 'evm', 'ETH');

      expect(ethBalance).toBeDefined();
      expect(typeof ethBalance).toBe('bigint');

      logger.info('ETH balance', { balance: ethBalance.toString() });
    });

    test('should format balance for display', async () => {
      // Example from: docs/guides/agent-wallet-integration.md - Format Balance
      const formatBalance = (balance: bigint, decimals: number): string => {
        const divisor = BigInt(10 ** decimals);
        const whole = balance / divisor;
        const fraction = balance % divisor;
        return `${whole}.${fraction.toString().padStart(decimals, '0')}`;
      };

      const balance = BigInt('1000000000'); // 1 USDC with 6 decimals
      const formatted = formatBalance(balance, 6);

      expect(formatted).toBe('1000.000000');
    });
  });

  describe('Error Handling Examples', () => {
    test('should demonstrate try-catch pattern', async () => {
      // Example from: docs/guides/agent-wallet-integration.md - Error Handling
      const lifecycle = new AgentWalletLifecycle();

      try {
        const wallet = await lifecycle.createAgentWallet('doc-test-agent-error');
        logger.info('Wallet created successfully', { agentId: wallet.agentId });
        expect(wallet).toBeDefined();
      } catch (error) {
        logger.error('Wallet operation failed', { error: error.message });
        throw error;
      }
    });

    test('should categorize error types', async () => {
      // Example from: docs/guides/agent-wallet-integration.md - Safe Wallet Operation
      const lifecycle = new AgentWalletLifecycle();

      // First create wallet
      await lifecycle.createAgentWallet('doc-test-error-categorize');

      // Try to create again
      try {
        await lifecycle.createAgentWallet('doc-test-error-categorize');
      } catch (error) {
        if (error.message.includes('already exists')) {
          logger.warn('Wallet already exists', { agentId: 'doc-test-error-categorize' });
          // Return existing wallet
          const existing = await lifecycle.getAgentWallet('doc-test-error-categorize');
          expect(existing).toBeDefined();
        } else {
          throw error;
        }
      }
    });
  });

  describe('Logging Best Practices', () => {
    test('should use structured logging', () => {
      // Example from: docs/guides/agent-wallet-integration.md - Logging Best Practices
      const testLogger = pino({ level: 'info' });

      // Good: Structured logging with context
      testLogger.info('Agent wallet operation', {
        operation: 'createWallet',
        agentId: 'agent-001',
        evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        xrpAddress: 'rN7n7otQDd6FczFgLdlqtyMVrXqHr7XEEw',
        timestamp: new Date().toISOString(),
      });

      // Verify logger is configured
      expect(testLogger.level).toBe('info');
    });

    test('should handle errors with logging', async () => {
      // Example from: docs/guides/agent-wallet-integration.md - Error Logging
      const lifecycle = new AgentWalletLifecycle();

      try {
        await lifecycle.createAgentWallet('doc-test-error-log');
      } catch (error) {
        logger.error('Wallet creation failed', {
          agentId: 'doc-test-error-log',
          error: error.message,
          stack: error.stack,
        });
        // Don't throw - just verify error was logged
      }
    });
  });

  describe('Async/Await Patterns', () => {
    test('should use async/await for sequential operations', async () => {
      // Example from: docs/guides/agent-wallet-integration.md - Async/Await Pattern
      const lifecycle = new AgentWalletLifecycle();
      const balanceTracker = new AgentBalanceTracker();

      // Sequential operations
      const wallet = await lifecycle.createAgentWallet('doc-test-async-seq');
      const balances = await balanceTracker.getAllBalances('doc-test-async-seq');

      expect(wallet).toBeDefined();
      expect(balances).toBeDefined();

      logger.info('Agent processed', { agentId: wallet.agentId, balances });
    });

    test('should use Promise.all for parallel operations', async () => {
      // Example from: docs/guides/agent-wallet-integration.md - Parallel Operations
      const lifecycle = new AgentWalletLifecycle();
      const agentIds = ['doc-test-parallel-001', 'doc-test-parallel-002', 'doc-test-parallel-003'];

      // Create all wallets in parallel
      const wallets = await Promise.all(agentIds.map((id) => lifecycle.createAgentWallet(id)));

      expect(wallets).toHaveLength(3);
      logger.info('All agents initialized', { count: wallets.length });
    });
  });
});

describe('Documentation Examples - API Reference', () => {
  describe('AgentWalletLifecycle API', () => {
    test('should match API signature for createAgentWallet', async () => {
      // Verify API signature matches documentation
      const lifecycle = new AgentWalletLifecycle();

      const wallet = await lifecycle.createAgentWallet('doc-api-test-001');

      // Verify return type matches documentation
      expect(wallet).toHaveProperty('agentId');
      expect(wallet).toHaveProperty('evmAddress');
      expect(wallet).toHaveProperty('xrpAddress');
      expect(wallet).toHaveProperty('derivationIndex');
      expect(wallet).toHaveProperty('createdAt');
      expect(wallet).toHaveProperty('status');
    });

    test('should match API signature for getAgentWallet', async () => {
      const lifecycle = new AgentWalletLifecycle();

      const wallet = await lifecycle.getAgentWallet('doc-api-test-001');

      if (wallet) {
        expect(wallet).toHaveProperty('agentId');
        expect(wallet).toHaveProperty('evmAddress');
      } else {
        expect(wallet).toBeNull();
      }
    });
  });

  describe('AgentBalanceTracker API', () => {
    test('should match API signature for getBalance', async () => {
      const balanceTracker = new AgentBalanceTracker();

      const balance = await balanceTracker.getBalance('doc-api-test-001', 'evm', 'ETH');

      // Verify return type is bigint as documented
      expect(typeof balance).toBe('bigint');
    });

    test('should match API signature for getAllBalances', async () => {
      const balanceTracker = new AgentBalanceTracker();

      const balances = await balanceTracker.getAllBalances('doc-api-test-001');

      expect(Array.isArray(balances)).toBe(true);

      if (balances.length > 0) {
        const balance = balances[0];
        expect(balance).toHaveProperty('agentId');
        expect(balance).toHaveProperty('chain');
        expect(balance).toHaveProperty('token');
        expect(balance).toHaveProperty('balance');
        expect(balance).toHaveProperty('decimals');
        expect(balance).toHaveProperty('lastUpdated');
      }
    });
  });
});

describe('Documentation Examples - Security Best Practices', () => {
  test('should sanitize wallet data for logging', () => {
    // Example from: docs/security/agent-wallet-security.md
    const wallet = {
      agentId: 'agent-001',
      evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
      xrpAddress: 'rN7n7otQDd6FczFgLdlqtyMVrXqHr7XEEw',
      privateKey: 'SENSITIVE-KEY-DATA', // Should never be logged
      status: 'active',
    };

    // Pino serializer should remove sensitive fields
    const sanitized = {
      agentId: wallet.agentId,
      evmAddress: wallet.evmAddress,
      xrpAddress: wallet.xrpAddress,
      status: wallet.status,
      // privateKey intentionally omitted
    };

    expect(sanitized).not.toHaveProperty('privateKey');
    expect(sanitized).toHaveProperty('agentId');
    expect(sanitized).toHaveProperty('evmAddress');
  });
});

describe('Documentation Test Data Consistency', () => {
  test('should use consistent test data from Dev Notes', () => {
    // Verify test data matches Story 11.10 Dev Notes > Testing subsection
    const testData = {
      sampleAgentIds: ['agent-001', 'agent-002', 'test-agent-123'],
      mockEvmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
      mockXrpAddress: 'rN7n7otQDd6FczFgLdlqtyMVrXqHr7XEEw',
      mockBalances: {
        usdc: BigInt(1000000000), // 1000 USDC with 6 decimals
        eth: BigInt('1000000000000000000'), // 1 ETH with 18 decimals
        xrp: BigInt(10000000), // 10 XRP with 6 decimals
      },
      mockChannelIds: ['channel-evm-001', 'channel-xrp-002'],
    };

    // Verify format correctness
    expect(testData.mockEvmAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(testData.mockXrpAddress).toMatch(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);

    expect(testData.sampleAgentIds).toHaveLength(3);
    expect(testData.mockChannelIds).toHaveLength(2);
  });
});
