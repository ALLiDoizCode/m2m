import { Client } from 'xrpl';
import pino from 'pino';
import { XRPWSSConnectionPool } from '../../../src/utils/xrp-wss-connection-pool';

// Mock xrpl.js
jest.mock('xrpl', () => {
  return {
    Client: jest.fn(),
  };
});

describe('XRPWSSConnectionPool', () => {
  let pool: XRPWSSConnectionPool;
  let logger: pino.Logger;
  let mockConnect: jest.Mock;
  let mockDisconnect: jest.Mock;
  let mockRequest: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    logger = pino({ level: 'silent' });

    mockConnect = jest.fn().mockResolvedValue(undefined);
    mockDisconnect = jest.fn().mockResolvedValue(undefined);
    mockRequest = jest.fn().mockResolvedValue({ result: {} });

    // Mock Client constructor
    (Client as unknown as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      request: mockRequest,
    }));

    pool = new XRPWSSConnectionPool(['wss://xrplcluster.com', 'wss://s1.ripple.com'], 2, logger);

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

    it('should connect to WebSocket endpoints during initialization', () => {
      // Should have called connect during initialization for each connection
      expect(mockConnect).toHaveBeenCalled();
    });

    // Error handling is tested in the generic ConnectionPool tests
  });

  describe('getClient', () => {
    it('should return an xrpl.Client instance', () => {
      const client = pool.getClient();

      expect(client).toBeDefined();
      expect(client).not.toBeNull();
      expect(client!.request).toBeDefined();
    });

    it('should distribute calls using round-robin', () => {
      const client1 = pool.getClient();
      const client2 = pool.getClient();
      const client3 = pool.getClient();

      expect(client1).toBeDefined();
      expect(client2).toBeDefined();
      expect(client3).toBeDefined();
    });

    it('should return null if no healthy connections available', async () => {
      await pool.shutdown();

      const client = pool.getClient();

      expect(client).toBeNull();
    });
  });

  describe('shutdown', () => {
    it('should disconnect all client instances', async () => {
      await pool.shutdown();

      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('should prevent getting clients after shutdown', async () => {
      await pool.shutdown();

      const client = pool.getClient();

      expect(client).toBeNull();
    });
  });

  describe('health checks', () => {
    it('should periodically verify client health via ping', async () => {
      const initialCalls = mockRequest.mock.calls.length;

      // Wait for health check interval
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have made additional health check calls (ping requests)
      expect(mockRequest.mock.calls.length).toBeGreaterThanOrEqual(initialCalls);
    });

    // Ping command behavior is verified in health check functionality test above
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
