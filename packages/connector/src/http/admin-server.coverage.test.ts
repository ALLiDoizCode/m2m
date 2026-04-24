/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */

/**
 * Branch Coverage Tests for AdminServer
 *
 * Covers all conditional branches in admin-server.ts:
 * - start() success and error paths (EADDRINUSE, generic errors, exceptions)
 * - stop() when server not running, success, and close-error paths
 * - _initApp() with optional config combinations (apiKey, allowedIPs, trustProxy)
 * - Port and host fallback defaults (?? operators)
 * - Health endpoint /health handler behavior
 * - isRunning() and getPort() getters
 * - Double-start behavior
 *
 * @module http/admin-server.coverage.test
 */

jest.mock('../utils/optional-require');
jest.mock('../utils/logger');
jest.mock('./admin-api', () => ({
  createAdminRouter: jest.fn().mockResolvedValue(jest.fn()),
}));

import { AdminServer } from './admin-server';
import { requireOptional } from '../utils/optional-require';
import { createAdminRouter } from './admin-api';
import type { Logger } from '../utils/logger';

describe('AdminServer branch coverage', () => {
  let mockExpressApp: any;
  let mockServer: any;
  let mockRouter: any;
  let mockLogger: jest.Mocked<Logger>;
  let healthHandler: ((req: any, res: any) => void) | undefined;

  const createMockLogger = (): jest.Mocked<Logger> =>
    ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
      fatal: jest.fn(),
      trace: jest.fn(),
      level: 'info',
    }) as unknown as jest.Mocked<Logger>;

  const buildMockExpress = () => {
    mockRouter = jest.fn();
    mockServer = {
      on: jest.fn(),
      listening: true,
      close: jest.fn().mockImplementation((cb: (err?: Error) => void) => {
        if (cb) cb();
      }),
    };
    mockExpressApp = {
      use: jest.fn(),
      get: jest.fn().mockImplementation((path: string, handler: any) => {
        if (path === '/health') {
          healthHandler = handler;
        }
      }),
      listen: jest.fn().mockImplementation((_port: any, _host: any, cb: any) => {
        if (cb) cb();
        return mockServer;
      }),
    };
    return { default: jest.fn().mockReturnValue(mockExpressApp) };
  };

  const createAdminServer = (configOverrides: Record<string, unknown> = {}) => {
    return new AdminServer({
      routingTable: {} as any,
      btpClientManager: {} as any,
      nodeId: 'test-node',
      config: {
        enabled: true,
        ...configOverrides,
      },
      logger: mockLogger,
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    healthHandler = undefined;
    mockLogger = createMockLogger();
    const mockExpress = buildMockExpress();
    (requireOptional as jest.Mock).mockResolvedValue(mockExpress);
    (createAdminRouter as jest.Mock).mockResolvedValue(mockRouter);
  });

  afterEach(async () => {
    // Ensure any started servers are cleaned up
    jest.clearAllMocks();
  });

  /* ───────────────────────────────────────────────────────────
     getPort() defaults
     ─────────────────────────────────────────────────────────── */
  describe('getPort()', () => {
    it('should return configured port when explicitly set', () => {
      const server = createAdminServer({ port: 9000 });
      expect(server.getPort()).toBe(9000);
    });

    it('should fall back to 8081 when port is undefined', () => {
      const server = createAdminServer({});
      expect(server.getPort()).toBe(8081);
    });
  });

  /* ───────────────────────────────────────────────────────────
     isRunning()
     ─────────────────────────────────────────────────────────── */
  describe('isRunning()', () => {
    it('should return false before start()', () => {
      const server = createAdminServer({});
      expect(server.isRunning()).toBe(false);
    });

    it('should return true after successful start()', async () => {
      const server = createAdminServer({});
      await server.start();
      expect(server.isRunning()).toBe(true);
    });

    it('should return false after stop()', async () => {
      const server = createAdminServer({});
      await server.start();
      await server.stop();
      expect(server.isRunning()).toBe(false);
    });

    it('should return false when server exists but not listening', async () => {
      const server = createAdminServer({});
      await server.start();
      mockServer.listening = false;
      expect(server.isRunning()).toBe(false);
    });
  });

  /* ───────────────────────────────────────────────────────────
     start() success path
     ─────────────────────────────────────────────────────────── */
  describe('start() — success path', () => {
    it('should resolve when server starts successfully', async () => {
      const server = createAdminServer({});
      await expect(server.start()).resolves.toBeUndefined();
    });

    it('should call express.listen with port and host defaults', async () => {
      const server = createAdminServer({});
      await server.start();
      expect(mockExpressApp.listen).toHaveBeenCalledWith(8081, '0.0.0.0', expect.any(Function));
    });

    it('should call express.listen with explicit port and host', async () => {
      const server = createAdminServer({ port: 7777, host: '127.0.0.1' });
      await server.start();
      expect(mockExpressApp.listen).toHaveBeenCalledWith(7777, '127.0.0.1', expect.any(Function));
    });

    it('should register /admin router and /health endpoint', async () => {
      const server = createAdminServer({});
      await server.start();
      expect(mockExpressApp.use).toHaveBeenCalledWith('/admin', mockRouter);
      expect(mockExpressApp.get).toHaveBeenCalledWith('/health', expect.any(Function));
    });

    it('should log started event with endpoint list', async () => {
      const server = createAdminServer({ port: 8081 });
      await server.start();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'admin_server_started',
          port: 8081,
          host: '0.0.0.0',
        }),
        expect.stringContaining('Admin API server started')
      );
    });

    it('should attach error listener to server', async () => {
      const server = createAdminServer({});
      await server.start();
      expect(mockServer.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should warn when no auth and binding to non-loopback host', async () => {
      const server = createAdminServer({ host: '0.0.0.0' });
      await server.start();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'admin_api_no_auth',
          host: '0.0.0.0',
        }),
        expect.stringContaining('WITHOUT authentication')
      );
    });

    it('should NOT warn when binding to loopback host without auth', async () => {
      const server = createAdminServer({ host: '127.0.0.1' });
      await server.start();
      const warnCalls = (mockLogger.warn as jest.Mock).mock.calls;
      const noAuthWarning = warnCalls.find((call) => call[0]?.event === 'admin_api_no_auth');
      expect(noAuthWarning).toBeUndefined();
    });

    it('should NOT warn when apiKey is set and binding to non-loopback', async () => {
      const server = createAdminServer({ host: '0.0.0.0', apiKey: 'secret' });
      await server.start();
      const warnCalls = (mockLogger.warn as jest.Mock).mock.calls;
      const noAuthWarning = warnCalls.find((call) => call[0]?.event === 'admin_api_no_auth');
      expect(noAuthWarning).toBeUndefined();
    });

    it('should NOT warn when allowedIPs is set and binding to non-loopback', async () => {
      const server = createAdminServer({ host: '0.0.0.0', allowedIPs: ['10.0.0.0/8'] });
      await server.start();
      const warnCalls = (mockLogger.warn as jest.Mock).mock.calls;
      const noAuthWarning = warnCalls.find((call) => call[0]?.event === 'admin_api_no_auth');
      expect(noAuthWarning).toBeUndefined();
    });
  });

  /* ───────────────────────────────────────────────────────────
     start() — double-start behavior
     ─────────────────────────────────────────────────────────── */
  describe('start() — double-start', () => {
    it('should overwrite _server when start() is called twice', async () => {
      const server = createAdminServer({});
      await server.start();
      // Reset mocks to capture second invocation
      mockExpressApp.listen.mockClear();
      const secondMockServer = { ...mockServer, on: jest.fn(), listening: true };
      mockExpressApp.listen.mockImplementation((_port: any, _host: any, cb: any) => {
        if (cb) cb();
        return secondMockServer;
      });

      await server.start();
      expect(mockExpressApp.listen).toHaveBeenCalledTimes(1);
      expect(server.isRunning()).toBe(true);
    });
  });

  /* ───────────────────────────────────────────────────────────
     start() — error handling branches
     ─────────────────────────────────────────────────────────── */
  describe('start() — error handling', () => {
    it('should reject with EADDRINUSE error message', async () => {
      // Defer listen callback so the error event fires before resolution
      mockExpressApp.listen.mockImplementation((_port: any, _host: any, _cb: any) => {
        // Do NOT call cb immediately — start() should stay pending until error
        return mockServer;
      });

      const server = createAdminServer({ port: 8081 });
      const startPromise = server.start();

      // Allow microtasks to flush so .on('error', ...) is registered
      await new Promise((resolve) => setImmediate(resolve));

      const errorHandler = mockServer.on.mock.calls.find((call: any[]) => call[0] === 'error')?.[1];
      expect(errorHandler).toBeDefined();

      const err = Object.assign(new Error('port in use'), { code: 'EADDRINUSE' });
      errorHandler(err);

      await expect(startPromise).rejects.toThrow('Admin API port 8081 is already in use');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'admin_server_start_failed',
          port: 8081,
        }),
        expect.stringContaining('already in use')
      );
    });

    it('should reject with generic error on server error event', async () => {
      mockExpressApp.listen.mockImplementation((_port: any, _host: any, _cb: any) => {
        return mockServer;
      });

      const server = createAdminServer({});
      const startPromise = server.start();

      await new Promise((resolve) => setImmediate(resolve));

      const errorHandler = mockServer.on.mock.calls.find((call: any[]) => call[0] === 'error')?.[1];
      expect(typeof errorHandler).toBe('function');

      const err = new Error('something broke');
      errorHandler(err);

      await expect(startPromise).rejects.toThrow('something broke');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'admin_server_error',
        }),
        'Admin server error'
      );
    });

    it('should reject when app.listen throws synchronously with Error', async () => {
      const server = createAdminServer({});
      const thrownError = new Error('listen explosion');
      mockExpressApp.listen.mockImplementation(() => {
        throw thrownError;
      });

      await expect(server.start()).rejects.toThrow('listen explosion');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'admin_server_start_exception',
          error: 'listen explosion',
        }),
        'Failed to start admin server'
      );
    });

    it('should reject when app.listen throws a non-Error value', async () => {
      const server = createAdminServer({});
      mockExpressApp.listen.mockImplementation(() => {
        throw 'string-throw';
      });

      await expect(server.start()).rejects.toBe('string-throw');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'admin_server_start_exception',
          error: 'Unknown error',
        }),
        'Failed to start admin server'
      );
    });
  });

  /* ───────────────────────────────────────────────────────────
     stop() branches
     ─────────────────────────────────────────────────────────── */
  describe('stop()', () => {
    it('should resolve immediately when server is not running', async () => {
      const server = createAdminServer({});
      await expect(server.stop()).resolves.toBeUndefined();
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'admin_server_stopped' }),
        expect.anything()
      );
    });

    it('should stop successfully and null out _server', async () => {
      const server = createAdminServer({});
      await server.start();
      expect(server.isRunning()).toBe(true);

      mockServer.close.mockImplementation((cb: (err?: Error) => void) => {
        cb();
      });

      await server.stop();
      expect(server.isRunning()).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'admin_server_stopped' }),
        'Admin API server stopped'
      );
    });

    it('should reject when close emits an error', async () => {
      const server = createAdminServer({});
      await server.start();

      const closeError = new Error('close failed');
      mockServer.close.mockImplementation((cb: (err?: Error) => void) => {
        cb(closeError);
      });

      await expect(server.stop()).rejects.toThrow('close failed');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'admin_server_stop_failed',
          error: 'close failed',
        }),
        'Failed to stop admin server'
      );
    });
  });

  /* ───────────────────────────────────────────────────────────
     _initApp() optional dependency branches
     ─────────────────────────────────────────────────────────── */
  describe('_initApp() — optional config branches', () => {
    it('should pass undefined apiKey and allowedIPs when not configured', async () => {
      const server = createAdminServer({});
      await server.start();
      expect(createAdminRouter).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: undefined,
          allowedIPs: undefined,
          trustProxy: undefined,
        })
      );
    });

    it('should pass apiKey when configured', async () => {
      const server = createAdminServer({ apiKey: 'my-secret-key' });
      await server.start();
      expect(createAdminRouter).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'my-secret-key' })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'admin_server_initialized',
          apiKeyConfigured: true,
        }),
        expect.anything()
      );
    });

    it('should pass allowedIPs when configured', async () => {
      const server = createAdminServer({ allowedIPs: ['192.168.1.0/24'] });
      await server.start();
      expect(createAdminRouter).toHaveBeenCalledWith(
        expect.objectContaining({ allowedIPs: ['192.168.1.0/24'] })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'admin_server_initialized',
          ipAllowlistConfigured: true,
        }),
        expect.anything()
      );
    });

    it('should pass trustProxy when configured true', async () => {
      const server = createAdminServer({ trustProxy: true });
      await server.start();
      expect(createAdminRouter).toHaveBeenCalledWith(expect.objectContaining({ trustProxy: true }));
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'admin_server_initialized',
          trustProxy: true,
        }),
        expect.anything()
      );
    });

    it('should pass trustProxy false and log false when explicitly false', async () => {
      const server = createAdminServer({ trustProxy: false });
      await server.start();
      expect(createAdminRouter).toHaveBeenCalledWith(
        expect.objectContaining({ trustProxy: false })
      );
      const initLog = (mockLogger.info as jest.Mock).mock.calls.find(
        (call) => call[0]?.event === 'admin_server_initialized'
      );
      expect(initLog?.[0].trustProxy).toBe(false);
    });

    it('should log ipAllowlistConfigured false when allowedIPs is empty array', async () => {
      const server = createAdminServer({ allowedIPs: [] });
      await server.start();
      const initLog = (mockLogger.info as jest.Mock).mock.calls.find(
        (call) => call[0]?.event === 'admin_server_initialized'
      );
      expect(initLog?.[0].ipAllowlistConfigured).toBe(false);
    });

    it('should log ipAllowlistConfigured false when allowedIPs is undefined', async () => {
      const server = createAdminServer({});
      await server.start();
      const initLog = (mockLogger.info as jest.Mock).mock.calls.find(
        (call) => call[0]?.event === 'admin_server_initialized'
      );
      expect(initLog?.[0].ipAllowlistConfigured).toBe(false);
    });

    it('should forward optional settlement dependencies to createAdminRouter', async () => {
      const mockSettlementPeers = new Map();
      const mockChannelManager = { name: 'ChannelManager' } as any;
      const mockPaymentChannelSDK = { name: 'PaymentChannelSDK' } as any;
      const mockAccountManager = { name: 'AccountManager' } as any;
      const mockSettlementMonitor = { name: 'SettlementMonitor' } as any;
      const mockClaimReceiver = { name: 'ClaimReceiver' } as any;
      const mockSentClaimsQueries = { name: 'SentClaimsQueries' } as any;
      const mockPacketSender = jest.fn();
      const mockIsReady = jest.fn();
      const mockMetricsRegistry = { name: 'MetricsRegistry' } as any;
      const mockResolveTokenMetadata = jest.fn();

      const server = new AdminServer({
        routingTable: {} as any,
        btpClientManager: {} as any,
        nodeId: 'test-node',
        config: { enabled: true },
        logger: mockLogger,
        settlementPeers: mockSettlementPeers,
        channelManager: mockChannelManager,
        paymentChannelSDK: mockPaymentChannelSDK,
        accountManager: mockAccountManager,
        settlementMonitor: mockSettlementMonitor,
        claimReceiver: mockClaimReceiver,
        sentClaimsQueries: mockSentClaimsQueries as any,
        defaultSettlementTokenId: 'token-123',
        packetSender: mockPacketSender,
        isReady: mockIsReady,
        metricsRegistry: mockMetricsRegistry,
        resolveTokenMetadata: mockResolveTokenMetadata,
        connectorFeePercentage: 0.5,
      });

      await server.start();
      expect(createAdminRouter).toHaveBeenCalledWith(
        expect.objectContaining({
          settlementPeers: mockSettlementPeers,
          channelManager: mockChannelManager,
          paymentChannelSDK: mockPaymentChannelSDK,
          accountManager: mockAccountManager,
          settlementMonitor: mockSettlementMonitor,
          claimReceiver: mockClaimReceiver,
          sentClaimsQueries: mockSentClaimsQueries,
          defaultSettlementTokenId: 'token-123',
          packetSender: mockPacketSender,
          isReady: mockIsReady,
          metricsRegistry: mockMetricsRegistry,
          resolveTokenMetadata: mockResolveTokenMetadata,
          connectorFeePercentage: 0.5,
        })
      );
    });
  });

  /* ───────────────────────────────────────────────────────────
     /health endpoint handler
     ─────────────────────────────────────────────────────────── */
  describe('GET /health handler', () => {
    it('should respond with JSON containing nodeId and timestamp', async () => {
      const server = createAdminServer({ nodeId: 'test-node' });
      await server.start();
      expect(healthHandler).toBeDefined();

      const res = {
        json: jest.fn(),
      };
      healthHandler!({} as any, res as any);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'healthy',
          service: 'admin-api',
          nodeId: 'test-node',
          timestamp: expect.any(String),
        })
      );
      const callArg = res.json.mock.calls[0][0];
      expect(new Date(callArg.timestamp).getTime()).not.toBeNaN();
    });
  });

  /* ───────────────────────────────────────────────────────────
     requireOptional failure branch (defensive)
     ─────────────────────────────────────────────────────────── */
  describe('requireOptional failure', () => {
    it('should bubble up when express is not available', async () => {
      (requireOptional as jest.Mock).mockRejectedValue(
        new Error('express is required for HTTP admin/health APIs')
      );
      const server = createAdminServer({});
      await expect(server.start()).rejects.toThrow(
        'express is required for HTTP admin/health APIs'
      );
    });
  });
});
