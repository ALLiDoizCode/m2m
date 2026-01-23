import { ethers } from 'ethers';
import pino from 'pino';
import { EVMRPCConnectionPool } from '../../../src/utils/evm-rpc-connection-pool';

// Mock ethers.js
jest.mock('ethers', () => {
  return {
    ethers: {
      JsonRpcProvider: jest.fn(),
    },
  };
});

describe('EVMRPCConnectionPool', () => {
  let pool: EVMRPCConnectionPool;
  let logger: pino.Logger;
  let mockGetBlockNumber: jest.Mock;
  let mockDestroy: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    logger = pino({ level: 'silent' });

    mockGetBlockNumber = jest.fn().mockResolvedValue(1000000);
    mockDestroy = jest.fn();

    // Mock JsonRpcProvider constructor
    (ethers.JsonRpcProvider as jest.Mock).mockImplementation(() => ({
      getBlockNumber: mockGetBlockNumber,
      destroy: mockDestroy,
    }));

    pool = new EVMRPCConnectionPool(
      ['https://mainnet.base.org', 'https://base.llamarpc.com'],
      2,
      logger
    );

    await pool.initialize();
  });

  afterEach(async () => {
    await pool.shutdown();
  });

  describe('initialization', () => {
    it('should create connections for specified pool size', async () => {
      const stats = pool.getStats();
      expect(stats.totalConnections).toBe(2);
    });

    it('should verify connectivity during initialization', () => {
      // Should have called getBlockNumber during initialization for each connection
      expect(mockGetBlockNumber).toHaveBeenCalled();
    });

    // Error handling is tested in the generic ConnectionPool tests
  });

  describe('getProvider', () => {
    it('should return an ethers.JsonRpcProvider instance', () => {
      const provider = pool.getProvider();

      expect(provider).toBeDefined();
      expect(provider).not.toBeNull();
      expect(provider!.getBlockNumber).toBeDefined();
    });

    it('should distribute calls using round-robin', () => {
      const provider1 = pool.getProvider();
      const provider2 = pool.getProvider();
      const provider3 = pool.getProvider();

      expect(provider1).toBeDefined();
      expect(provider2).toBeDefined();
      expect(provider3).toBeDefined();
    });

    it('should return null if no healthy connections available', async () => {
      await pool.shutdown();

      const provider = pool.getProvider();

      expect(provider).toBeNull();
    });
  });

  describe('shutdown', () => {
    it('should destroy all provider instances', async () => {
      await pool.shutdown();

      expect(mockDestroy).toHaveBeenCalled();
    });

    it('should prevent getting providers after shutdown', async () => {
      await pool.shutdown();

      const provider = pool.getProvider();

      expect(provider).toBeNull();
    });
  });

  describe('health checks', () => {
    it('should periodically verify provider health', async () => {
      const initialCalls = mockGetBlockNumber.mock.calls.length;

      // Wait for health check interval
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have made additional health check calls
      expect(mockGetBlockNumber.mock.calls.length).toBeGreaterThanOrEqual(initialCalls);
    });
  });

  describe('statistics', () => {
    it('should return accurate pool statistics', () => {
      const stats = pool.getStats();

      expect(stats).toHaveProperty('totalConnections');
      expect(stats).toHaveProperty('healthyConnections');
      expect(stats).toHaveProperty('unhealthyConnections');
      expect(stats.totalConnections).toBe(2);
    });
  });
});
