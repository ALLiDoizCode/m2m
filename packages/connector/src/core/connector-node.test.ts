/**
 * Unit tests for ConnectorNode
 * @packageDocumentation
 */

import { ConnectorNode } from './connector-node';
import { ConnectorConfig } from '../config/types';
import { RoutingTable } from '../routing/routing-table';
import { BTPClientManager } from '../btp/btp-client-manager';
import { BTPServer } from '../btp/btp-server';
import { PacketHandler } from './packet-handler';
import { Logger } from '../utils/logger';
import {
  RoutingTableEntry,
  PacketType,
  ILPErrorCode,
  ILPFulfillPacket,
  ILPRejectPacket,
} from '@toon-protocol/shared';
import {
  ConfigLoader,
  ConnectorNotStartedError,
  InvalidExecutionConditionError,
} from '../config/config-loader';
import { HealthServer } from '../http/health-server';
import { sha256 } from '@noble/hashes/sha2';

// Mock all dependencies
jest.mock('../routing/routing-table');
jest.mock('../btp/btp-client-manager');
jest.mock('../btp/btp-server');
jest.mock('./packet-handler');
jest.mock('../config/config-loader', () => {
  const actual = jest.requireActual('../config/config-loader');
  return {
    ...actual,
    ConfigLoader: {
      loadConfig: jest.fn(),
      validateConfig: jest.fn(),
    },
  };
});
jest.mock('../http/health-server');
jest.mock('../http/admin-api', () => ({
  validateSettlementConfig: jest.fn().mockReturnValue(null),
}));

// Story 35.4: mock the transport barrel so start/stop lifecycle + agent
// plumbing can be inspected without real network I/O.
jest.mock('../transport', () => {
  const directStartSpy = jest.fn().mockResolvedValue(undefined);
  const directStopSpy = jest.fn().mockResolvedValue(undefined);
  const directHealthSpy = jest.fn().mockResolvedValue(true);
  const directCreateAgentSpy = jest.fn().mockReturnValue(undefined);
  const socksStartSpy = jest.fn().mockResolvedValue(undefined);
  const socksStopSpy = jest.fn().mockResolvedValue(undefined);
  const socksHealthSpy = jest.fn().mockResolvedValue(true);
  const socksCreateAgentSpy = jest.fn().mockReturnValue({ __socks: true });

  class DirectTransportProvider {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(public externalUrl: string) {}
    start = directStartSpy;
    stop = directStopSpy;
    healthCheck = directHealthSpy;
    createAgent = directCreateAgentSpy;
    getExternalUrl(): string {
      return this.externalUrl;
    }
  }
  const socksCtorSpy = jest.fn();
  class SocksTransportProvider {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(public options: any) {
      // Story 35.6 T-35.6-INT-06 (AC 11): a spy on the constructor itself
      // lets the regression anchor assert "SocksTransportProvider
      // constructor is never called" literally, matching the AC wording.
      socksCtorSpy(options);
    }
    start = socksStartSpy;
    stop = socksStopSpy;
    healthCheck = socksHealthSpy;
    createAgent = socksCreateAgentSpy;
    getExternalUrl(): string {
      return this.options.externalUrl;
    }
  }
  const managedStartSpy = jest.fn().mockResolvedValue(undefined);
  const managedStopSpy = jest.fn().mockResolvedValue(undefined);
  const managedHealthSpy = jest.fn().mockResolvedValue(true);
  const managedCtorSpy = jest.fn();
  class ManagedAnonClient {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(public opts: any) {
      managedCtorSpy(opts);
    }
    start = managedStartSpy;
    stop = managedStopSpy;
    healthCheck = managedHealthSpy;
    isRunning(): boolean {
      return true;
    }
  }
  // Mock returns a rejected promise with a non-MODULE_NOT_FOUND code so the
  // connector-node factory stays in its "wait for prewarm" branch without
  // changing test expectations. Tests that actually need the prewarm to
  // resolve should stub this per-test.
  const createDefaultAnonFactory = jest.fn(() =>
    Promise.reject(
      Object.assign(new Error('mocked: factory not wired in unit test'), { code: 'MOCKED_TEST' })
    )
  );
  return {
    DirectTransportProvider,
    SocksTransportProvider,
    ManagedAnonClient,
    createDefaultAnonFactory,
    __spies: {
      directStartSpy,
      directStopSpy,
      directHealthSpy,
      directCreateAgentSpy,
      socksStartSpy,
      socksStopSpy,
      socksHealthSpy,
      socksCreateAgentSpy,
      socksCtorSpy,
      managedStartSpy,
      managedStopSpy,
      managedHealthSpy,
      managedCtorSpy,
    },
  };
});

/**
 * Mock logger for testing
 */
const createMockLogger = (): jest.Mocked<Logger> =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    trace: jest.fn(),
    silent: jest.fn(),
    level: 'info',
    child: jest.fn().mockReturnThis(),
  }) as unknown as jest.Mocked<Logger>;

/**
 * Create test connector configuration
 */
const createTestConfig = (overrides?: Partial<ConnectorConfig>): ConnectorConfig => {
  const testPeer = {
    id: 'peerA',
    // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
    url: 'ws://connector-a:3000',
    authToken: 'secret-a',
  };

  const testRoute: RoutingTableEntry = {
    prefix: 'g.peerA',
    nextHop: 'peerA',
  };

  return {
    nodeId: 'connector-test',
    btpServerPort: 3000,
    environment: 'development',
    peers: [testPeer],
    routes: [testRoute],
    ...overrides,
  };
};

describe('ConnectorNode', () => {
  let connectorNode: ConnectorNode;
  let mockLogger: jest.Mocked<Logger>;
  let mockRoutingTable: jest.Mocked<RoutingTable>;
  let mockBTPClientManager: jest.Mocked<BTPClientManager>;
  let mockBTPServer: jest.Mocked<BTPServer>;
  let mockPacketHandler: jest.Mocked<PacketHandler>;
  let mockHealthServer: jest.Mocked<HealthServer>;
  let config: ConnectorConfig;
  const testConfigPath = '/test/config.yaml';

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    config = createTestConfig();

    // Mock ConfigLoader to return our test config
    (ConfigLoader.loadConfig as jest.Mock) = jest.fn().mockReturnValue(config);

    // Create mocked instances
    mockRoutingTable = {
      lookup: jest.fn(),
      getAllRoutes: jest.fn().mockReturnValue(config.routes),
      addRoute: jest.fn(),
      removeRoute: jest.fn(),
    } as unknown as jest.Mocked<RoutingTable>;

    mockBTPClientManager = {
      addPeer: jest.fn().mockResolvedValue(undefined),
      removePeer: jest.fn().mockResolvedValue(undefined),
      sendToPeer: jest.fn(),
      getPeerStatus: jest.fn().mockReturnValue(new Map([['peerA', true]])),
      getPeerIds: jest.fn().mockReturnValue(['peerA']),
      isConnected: jest.fn().mockReturnValue(true),
      getConnectedPeerCount: jest.fn().mockReturnValue(1),
      getTotalPeerCount: jest.fn().mockReturnValue(1),
      getConnectionHealth: jest.fn().mockReturnValue(100),
      setPacketHandler: jest.fn(),
      // Story 35.4: additive mock method for transport agent factory wiring
      setAgentFactory: jest.fn(),
      // Health-status race fix: additive mock for the connection-state-change
      // callback the connector registers to re-evaluate /health on peer
      // connect/disconnect after startup.
      setConnectionStateChangeCallback: jest.fn(),
      // Per-peer transport selection: additive mock for the new accessor
      // used by registerPeer's re-reg log + listPeers's PeerInfo surface.
      getPeerTransport: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<BTPClientManager>;

    mockBTPServer = {
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      setIlpHttpHandler: jest.fn(),
      setInboundClaimValidator: jest.fn(),
    } as unknown as jest.Mocked<BTPServer>;

    mockPacketHandler = {
      processPrepare: jest.fn(),
      setBTPServer: jest.fn(),
      setLocalDeliveryHandler: jest.fn(),
      setLocalDelivery: jest.fn(),
      handlePreparePacket: jest.fn(),
      // Story 37.2: ILP observability metrics
      setIlpMetrics: jest.fn(),
      // Issue #76: relationship-aware settlement gate
      setPeerRelation: jest.fn(),
      // Relation↔route admission validation reads a peer's relation; undefined
      // (treated as 'peer') keeps these mock-based route tests unconstrained.
      getPeerRelation: jest.fn().mockReturnValue(undefined),
      // Epic 38, Story 38.1: ILP-over-HTTP egress wiring + per-peer protocol.
      setHttpEgress: jest.fn(),
      setPeerProtocol: jest.fn(),
      getPeerProtocol: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<PacketHandler>;

    mockHealthServer = {
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<HealthServer>;

    // Configure mocks to return our mocked instances
    (RoutingTable as jest.MockedClass<typeof RoutingTable>).mockImplementation(
      () => mockRoutingTable
    );
    (BTPClientManager as jest.MockedClass<typeof BTPClientManager>).mockImplementation(
      () => mockBTPClientManager
    );
    (BTPServer as jest.MockedClass<typeof BTPServer>).mockImplementation(() => mockBTPServer);
    (PacketHandler as jest.MockedClass<typeof PacketHandler>).mockImplementation(
      () => mockPacketHandler
    );
    (HealthServer as jest.MockedClass<typeof HealthServer>).mockImplementation(
      () => mockHealthServer
    );
  });

  describe('Constructor', () => {
    it('should create ConnectorNode with all components', () => {
      // Arrange & Act
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      // Assert
      expect(connectorNode).toBeDefined();
      expect(connectorNode).toBeInstanceOf(ConnectorNode);
      expect(ConfigLoader.loadConfig).toHaveBeenCalledWith(testConfigPath);
      expect(mockLogger.child).toHaveBeenCalledWith({
        component: 'ConnectorNode',
        nodeId: 'connector-test',
      });
    });

    it('should initialize RoutingTable with config routes', () => {
      // Arrange & Act
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      // Assert
      expect(RoutingTable).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ prefix: 'g.peerA', nextHop: 'peerA' })]),
        expect.anything() // child logger
      );
    });

    it('should initialize BTPClientManager with logger', () => {
      // Arrange & Act
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      // Assert
      expect(BTPClientManager).toHaveBeenCalledWith(config.nodeId, expect.anything());
    });

    it('should initialize PacketHandler with dependencies', () => {
      // Arrange & Act
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      // Assert
      expect(PacketHandler).toHaveBeenCalledWith(
        mockRoutingTable,
        mockBTPClientManager,
        config.nodeId,
        expect.anything() // child logger
      );
    });

    it('should initialize BTPServer with PacketHandler', () => {
      // Arrange & Act
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      // Assert
      expect(BTPServer).toHaveBeenCalledWith(
        expect.anything(), // child logger
        mockPacketHandler
      );
    });

    it('should initialize HealthServer with logger and provider', () => {
      // Arrange & Act
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      // Assert
      // Story 37.2: HealthServer now receives config with metricsMiddleware
      expect(HealthServer).toHaveBeenCalledWith(
        expect.anything(), // child logger
        connectorNode, // ConnectorNode implements HealthStatusProvider
        expect.objectContaining({
          metricsMiddleware: expect.any(Function),
        })
      );
    });

    it('should log config_loaded and connector_initialized events', () => {
      // Arrange & Act
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      // Assert
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'config_loaded',
          filePath: testConfigPath,
          nodeId: 'connector-test',
        }),
        expect.any(String)
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'connector_initialized',
          nodeId: 'connector-test',
          peersCount: 1,
          routesCount: 1,
        }),
        expect.any(String)
      );
    });
  });

  describe('start()', () => {
    beforeEach(() => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      jest.clearAllMocks(); // Clear constructor logs
    });

    it('should start BTP server first, then health server, then clients', async () => {
      // Arrange
      const startOrder: string[] = [];
      mockBTPServer.start.mockImplementation(async () => {
        startOrder.push('btp-server');
      });
      mockHealthServer.start.mockImplementation(async () => {
        startOrder.push('health-server');
      });
      mockBTPClientManager.addPeer.mockImplementation(async () => {
        startOrder.push('client');
      });

      // Act
      await connectorNode.start();

      // Assert
      expect(startOrder[0]).toBe('btp-server');
      expect(startOrder[1]).toBe('health-server');
      expect(startOrder[2]).toBe('client');
      expect(mockBTPServer.start).toHaveBeenCalledWith(3000);
      expect(mockHealthServer.start).toHaveBeenCalledWith(8080);
    });

    it('should connect all BTP clients in parallel', async () => {
      // Arrange
      const configWithMultiplePeers = createTestConfig({
        peers: [
          {
            id: 'peerA',
            // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
            url: 'ws://connector-a:3000',
            authToken: 'secret-a',
          },
          {
            id: 'peerB',
            // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
            url: 'ws://connector-b:3001',
            authToken: 'secret-b',
          },
        ],
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(configWithMultiplePeers);
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      jest.clearAllMocks();

      // Act
      await connectorNode.start();

      // Assert
      expect(mockBTPClientManager.addPeer).toHaveBeenCalledTimes(2);
      expect(mockBTPClientManager.addPeer).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'peerA' })
      );
      expect(mockBTPClientManager.addPeer).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'peerB' })
      );
    });

    it('should log connector_starting, btp_server_started, health_server_started, and connector_ready events', async () => {
      // Arrange & Act
      await connectorNode.start();

      // Assert
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'connector_starting',
          nodeId: 'connector-test',
        }),
        expect.any(String)
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'btp_server_started',
          port: 3000,
        }),
        expect.any(String)
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'health_server_started',
          port: 8080,
        }),
        expect.any(String)
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'connector_ready',
          nodeId: 'connector-test',
          connectedPeers: 1,
          totalPeers: 1,
        }),
        expect.any(String)
      );
    });

    it('should set status to healthy on successful start with all peers connected', async () => {
      // Arrange & Act
      await connectorNode.start();
      const healthStatus = connectorNode.getHealthStatus();

      // Assert
      expect(healthStatus.status).toBe('healthy');
    });

    it('should log error and set status to unhealthy on start failure', async () => {
      // Arrange
      const testError = new Error('BTP server start failed');
      mockBTPServer.start.mockRejectedValue(testError);

      // Act & Assert
      await expect(connectorNode.start()).rejects.toThrow('BTP server start failed');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'connector_start_failed',
          nodeId: 'connector-test',
          error: 'BTP server start failed',
        }),
        expect.any(String)
      );

      const healthStatus = connectorNode.getHealthStatus();
      expect(healthStatus.status).toBe('unhealthy');
    });
  });

  describe('health-status race — post-startup peer connect/disconnect', () => {
    // Regression coverage for the one-shot health-status race: before the fix
    // _updateHealthStatus() ran exactly once near the end of start(), so if a
    // peer's BTP handshake completed AFTER that snapshot the /health status
    // froze at "unhealthy" forever even though the peer was up and routing.
    // The fix re-evaluates health on every peer connect/disconnect (via a
    // BTPClientManager callback) and on a periodic backstop timer.

    it('registers a connection-state-change callback on the BTP client manager', () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      expect(mockBTPClientManager.setConnectionStateChangeCallback).toHaveBeenCalledWith(
        expect.any(Function)
      );
    });

    it('flips /health from unhealthy to healthy when a peer connects AFTER the startup snapshot', async () => {
      // Arrange: at the instant start() takes its one-shot snapshot, NO peers
      // are connected (mirrors the real bug: BTP handshake still in flight).
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', false]]));
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      // Capture the callback the connector registered during construction.
      const registerCall = mockBTPClientManager.setConnectionStateChangeCallback.mock.calls[0]!;
      const onConnectionStateChange = registerCall[0] as () => void;

      await connectorNode.start();

      // The boot snapshot saw 0/1 peers connected → unhealthy (the frozen state).
      expect(connectorNode.getHealthStatus().status).toBe('unhealthy');

      // Act: the peer finishes connecting a few seconds later. The BTP client
      // manager would fire the registered callback on the 'connected' event.
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', true]]));
      onConnectionStateChange();

      // Assert: /health has transitioned to healthy without a restart.
      expect(connectorNode.getHealthStatus().status).toBe('healthy');
    });

    it('flips /health back to unhealthy when peers drop below threshold post-startup', async () => {
      // Arrange: healthy at startup (peer connected).
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', true]]));
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      const onConnectionStateChange = mockBTPClientManager.setConnectionStateChangeCallback.mock
        .calls[0]![0] as () => void;

      await connectorNode.start();
      expect(connectorNode.getHealthStatus().status).toBe('healthy');

      // Act: the peer drops.
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', false]]));
      onConnectionStateChange();

      // Assert.
      expect(connectorNode.getHealthStatus().status).toBe('unhealthy');
    });

    it('periodic backstop timer re-evaluates health after startup', async () => {
      jest.useFakeTimers();
      try {
        // Peer not connected at the startup snapshot → unhealthy.
        mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', false]]));
        connectorNode = new ConnectorNode(testConfigPath, mockLogger, {
          healthStatusIntervalMs: 1000,
        });

        await connectorNode.start();
        expect(connectorNode.getHealthStatus().status).toBe('unhealthy');

        // Peer connects, but simulate the event being missed — only the timer
        // drives the re-evaluation here.
        mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', true]]));
        jest.advanceTimersByTime(1000);

        expect(connectorNode.getHealthStatus().status).toBe('healthy');
      } finally {
        jest.useRealTimers();
      }
    });

    it('clears the periodic health timer on stop (no leaked interval)', async () => {
      jest.useFakeTimers();
      try {
        const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
        mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', true]]));
        connectorNode = new ConnectorNode(testConfigPath, mockLogger, {
          healthStatusIntervalMs: 1000,
        });
        await connectorNode.start();

        mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
        mockBTPClientManager.removePeer.mockResolvedValue(undefined);
        mockHealthServer.stop.mockResolvedValue(undefined);
        mockBTPServer.stop.mockResolvedValue(undefined);

        await connectorNode.stop();

        // The health-status interval handle must have been cleared.
        expect(clearIntervalSpy).toHaveBeenCalled();
        clearIntervalSpy.mockRestore();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('stop()', () => {
    beforeEach(async () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      jest.clearAllMocks();
      await connectorNode.start();
      jest.clearAllMocks();
      // Re-apply default mock return values after clearing
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', true]]));
      mockBTPClientManager.removePeer.mockResolvedValue(undefined);
      mockHealthServer.stop.mockResolvedValue(undefined);
      mockBTPServer.stop.mockResolvedValue(undefined);
    });

    it('should disconnect all BTP clients', async () => {
      // Arrange
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA', 'peerB']);

      // Act
      await connectorNode.stop();

      // Assert
      expect(mockBTPClientManager.removePeer).toHaveBeenCalledTimes(2);
      expect(mockBTPClientManager.removePeer).toHaveBeenCalledWith('peerA');
      expect(mockBTPClientManager.removePeer).toHaveBeenCalledWith('peerB');
    });

    it('should stop health server and BTP server after disconnecting clients', async () => {
      // Arrange
      const stopOrder: string[] = [];
      mockBTPClientManager.removePeer.mockImplementation(async () => {
        stopOrder.push('client');
      });
      mockHealthServer.stop.mockImplementation(async () => {
        stopOrder.push('health-server');
      });
      mockBTPServer.stop.mockImplementation(async () => {
        stopOrder.push('btp-server');
      });

      // Act
      await connectorNode.stop();

      // Assert
      expect(stopOrder[0]).toBe('client');
      expect(stopOrder).toContain('health-server');
      expect(stopOrder).toContain('btp-server');
      expect(mockHealthServer.stop).toHaveBeenCalledTimes(1);
      expect(mockBTPServer.stop).toHaveBeenCalledTimes(1);
    });

    it('should log connector_stopping and connector_stopped events', async () => {
      // Arrange & Act
      await connectorNode.stop();

      // Assert
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'connector_stopping',
          nodeId: 'connector-test',
        }),
        expect.any(String)
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'connector_stopped',
          nodeId: 'connector-test',
        }),
        expect.any(String)
      );
    });

    it('should reset status to starting after successful stop', async () => {
      // Arrange — connector already started in beforeEach

      // Act
      await connectorNode.stop();
      const healthStatus = connectorNode.getHealthStatus();

      // Assert
      expect(healthStatus.status).toBe('starting');
      expect(healthStatus.peersConnected).toBe(1); // BTPClientManager mock still returns 1
    });

    it('should log error on stop failure', async () => {
      // Arrange
      const testError = new Error('Failed to disconnect peer');
      mockBTPClientManager.removePeer.mockRejectedValue(testError);

      // Act & Assert
      await expect(connectorNode.stop()).rejects.toThrow('Failed to disconnect peer');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'connector_stop_failed',
          nodeId: 'connector-test',
          error: 'Failed to disconnect peer',
        }),
        expect.any(String)
      );
    });
  });

  describe('getHealthStatus() - Task 8: Health Integration Tests', () => {
    beforeEach(() => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      jest.clearAllMocks();
    });

    it('Test 1: ConnectorNode implements HealthStatusProvider interface', () => {
      // Arrange & Act
      const healthStatus = connectorNode.getHealthStatus();

      // Assert - should return HealthStatus object with all required fields
      expect(healthStatus).toBeDefined();
      expect(healthStatus).toHaveProperty('status');
      expect(healthStatus).toHaveProperty('uptime');
      expect(healthStatus).toHaveProperty('peersConnected');
      expect(healthStatus).toHaveProperty('totalPeers');
      expect(healthStatus).toHaveProperty('timestamp');
      expect(healthStatus).toHaveProperty('nodeId');
      expect(healthStatus).toHaveProperty('version');

      // Verify types
      expect(typeof healthStatus.status).toBe('string');
      expect(typeof healthStatus.uptime).toBe('number');
      expect(typeof healthStatus.peersConnected).toBe('number');
      expect(typeof healthStatus.totalPeers).toBe('number');
      expect(typeof healthStatus.timestamp).toBe('string');
      expect(typeof healthStatus.nodeId).toBe('string');
      expect(typeof healthStatus.version).toBe('string');
    });

    it('Test 2: Health status is "starting" during initialization', () => {
      // Arrange & Act - before start() is called
      const healthStatus = connectorNode.getHealthStatus();

      // Assert
      expect(healthStatus.status).toBe('starting');
      expect(healthStatus.nodeId).toBe('connector-test');
    });

    it('Test 3: Health status is "healthy" when all peers connected (100%)', async () => {
      // Arrange
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', true]]));

      // Act
      await connectorNode.start();
      const healthStatus = connectorNode.getHealthStatus();

      // Assert
      expect(healthStatus.status).toBe('healthy');
      expect(healthStatus.peersConnected).toBe(1);
      expect(healthStatus.totalPeers).toBe(1);
    });

    it('Test 4: Health status is "unhealthy" when <50% peers connected', async () => {
      // Arrange - Configure 4 peers, only 1 connected (25%)
      const configWithManyPeers = createTestConfig({
        peers: [
          // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
          { id: 'peer1', url: 'ws://p1:3000', authToken: 'token1' },
          // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
          { id: 'peer2', url: 'ws://p2:3000', authToken: 'token2' },
          // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
          { id: 'peer3', url: 'ws://p3:3000', authToken: 'token3' },
          // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
          { id: 'peer4', url: 'ws://p4:3000', authToken: 'token4' },
        ],
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(configWithManyPeers);
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      // Mock only 1 out of 4 peers connected
      mockBTPClientManager.getPeerStatus.mockReturnValue(
        new Map([
          ['peer1', true],
          ['peer2', false],
          ['peer3', false],
          ['peer4', false],
        ])
      );

      // Act
      jest.clearAllMocks();
      await connectorNode.start();
      const healthStatus = connectorNode.getHealthStatus();

      // Assert
      expect(healthStatus.status).toBe('unhealthy');
      expect(healthStatus.peersConnected).toBe(1);
      expect(healthStatus.totalPeers).toBe(4);
    });

    it('Test 5: Uptime increases over time', async () => {
      // Arrange
      await connectorNode.start();

      // Act - Get initial uptime
      const healthStatus1 = connectorNode.getHealthStatus();
      const uptime1 = healthStatus1.uptime;

      // Wait 1100ms (just over 1 second to ensure uptime counter increases)
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Get uptime again
      const healthStatus2 = connectorNode.getHealthStatus();
      const uptime2 = healthStatus2.uptime;

      // Assert - uptime is in seconds, so should increase by at least 1
      expect(uptime2).toBeGreaterThan(uptime1);
      expect(uptime2 - uptime1).toBeGreaterThanOrEqual(1);
    });

    it('Test 6: Health server starts and stops with ConnectorNode', async () => {
      // Arrange & Act - Start
      await connectorNode.start();

      // Assert - Health server should have been started
      expect(mockHealthServer.start).toHaveBeenCalledTimes(1);
      expect(mockHealthServer.start).toHaveBeenCalledWith(8080);

      // Act - Stop
      await connectorNode.stop();

      // Assert - Health server should have been stopped
      expect(mockHealthServer.stop).toHaveBeenCalledTimes(1);
    });

    it('Test 7: Health status changes logged at INFO level', async () => {
      // Arrange - Start with peers disconnected (<50%)
      const configWith2Peers = createTestConfig({
        peers: [
          // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
          { id: 'peer1', url: 'ws://p1:3000', authToken: 'token1' },
          // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
          { id: 'peer2', url: 'ws://p2:3000', authToken: 'token2' },
        ],
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(configWith2Peers);
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      // Mock only 1 out of 2 peers connected (50% - should be healthy at boundary)
      mockBTPClientManager.getPeerStatus.mockReturnValue(
        new Map([
          ['peer1', true],
          ['peer2', false],
        ])
      );
      jest.clearAllMocks();

      // Act - Start connector (should trigger health status change from 'starting' to 'unhealthy')
      await connectorNode.start();

      // Assert - Should log health_status_changed event at INFO level
      const healthStatusChangedLogs = (mockLogger.info as jest.Mock).mock.calls.filter(
        (call) => call[0]?.event === 'health_status_changed'
      );

      expect(healthStatusChangedLogs.length).toBeGreaterThan(0);
    });

    it('Test 8: Health status "healthy" when no peers configured (standalone mode)', async () => {
      // Arrange - Configure connector with no peers
      const configNoPeers = createTestConfig({
        peers: [],
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(configNoPeers);
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map());
      jest.clearAllMocks();

      // Act
      await connectorNode.start();
      const healthStatus = connectorNode.getHealthStatus();

      // Assert - Standalone mode should be healthy
      expect(healthStatus.status).toBe('healthy');
      expect(healthStatus.peersConnected).toBe(0);
      expect(healthStatus.totalPeers).toBe(0);
    });

    it('Test 9: Health status includes nodeId and version from package.json', () => {
      // Arrange & Act
      const healthStatus = connectorNode.getHealthStatus();

      // Assert
      expect(healthStatus.nodeId).toBe('connector-test');
      expect(healthStatus.version).toBeDefined();
      expect(typeof healthStatus.version).toBe('string');
    });

    it('Test 10: Timestamp is valid ISO 8601 format', () => {
      // Arrange & Act
      const healthStatus = connectorNode.getHealthStatus();

      // Assert
      expect(healthStatus.timestamp).toBeDefined();
      expect(() => new Date(healthStatus.timestamp)).not.toThrow();

      const timestamp = new Date(healthStatus.timestamp);
      expect(timestamp.toISOString()).toBe(healthStatus.timestamp);
    });
  });

  describe('Object-based Construction', () => {
    it('should initialize successfully with a valid ConnectorConfig object', () => {
      // Arrange
      (ConfigLoader.validateConfig as jest.Mock) = jest.fn().mockReturnValue(config);

      // Act
      connectorNode = new ConnectorNode(config, mockLogger);

      // Assert
      expect(connectorNode).toBeDefined();
      expect(connectorNode).toBeInstanceOf(ConnectorNode);
      expect(ConfigLoader.validateConfig).toHaveBeenCalledWith(config);
      expect(ConfigLoader.loadConfig).not.toHaveBeenCalled();
    });

    it('should call ConfigLoader.loadConfig when constructed with a string path', () => {
      // Arrange & Act
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      // Assert
      expect(ConfigLoader.loadConfig).toHaveBeenCalledWith(testConfigPath);
    });

    it('should throw ConfigurationError for invalid config object missing nodeId', () => {
      // Arrange - use the same ConfigurationError that ConnectorNode imports (mocked module)
      const { ConfigurationError } = jest.requireActual('../config/config-loader');
      (ConfigLoader.validateConfig as jest.Mock) = jest.fn().mockImplementation(() => {
        throw new ConfigurationError('Missing required field: nodeId');
      });
      const invalidConfig = { btpServerPort: 3000, peers: [], routes: [] };

      // Act & Assert
      expect(
        () => new ConnectorNode(invalidConfig as unknown as ConnectorConfig, mockLogger)
      ).toThrow('Missing required field: nodeId');
    });

    it('should throw ConfigurationError for invalid config object missing peers', () => {
      // Arrange
      const { ConfigurationError: RealConfigError } = jest.requireActual('../config/config-loader');
      (ConfigLoader.validateConfig as jest.Mock) = jest.fn().mockImplementation(() => {
        throw new RealConfigError('Missing required field: peers');
      });
      const invalidConfig = { nodeId: 'test', btpServerPort: 3000, routes: [] };

      // Act & Assert
      expect(
        () => new ConnectorNode(invalidConfig as unknown as ConnectorConfig, mockLogger)
      ).toThrow('Missing required field: peers');
    });

    it('should throw ConfigurationError for invalid port range in config object', () => {
      // Arrange
      const { ConfigurationError: RealConfigError } = jest.requireActual('../config/config-loader');
      (ConfigLoader.validateConfig as jest.Mock) = jest.fn().mockImplementation(() => {
        throw new RealConfigError('BTP server port must be between 1-65535, got: 99999');
      });
      const invalidConfig = {
        nodeId: 'test',
        btpServerPort: 99999,
        peers: [],
        routes: [],
      };

      // Act & Assert
      expect(
        () => new ConnectorNode(invalidConfig as unknown as ConnectorConfig, mockLogger)
      ).toThrow('BTP server port must be between 1-65535');
    });

    it('should log source as "object" when constructed with config object', () => {
      // Arrange
      (ConfigLoader.validateConfig as jest.Mock) = jest.fn().mockReturnValue(config);

      // Act
      connectorNode = new ConnectorNode(config, mockLogger);

      // Assert
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'config_loaded',
          source: 'object',
          nodeId: 'connector-test',
        }),
        expect.any(String)
      );
    });
  });

  describe('setLocalDeliveryHandler()', () => {
    beforeEach(() => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      jest.clearAllMocks();
    });

    it('should set the handler and propagate to PacketHandler', () => {
      // Arrange
      const handler = jest.fn().mockResolvedValue({ fulfill: { data: '' } });

      // Act
      connectorNode.setLocalDeliveryHandler(handler);

      // Assert
      expect(mockPacketHandler.setLocalDeliveryHandler).toHaveBeenCalledWith(handler);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'local_delivery_handler_set',
          hasHandler: true,
        }),
        'Local delivery function handler registered'
      );
    });

    it('should be callable before start()', () => {
      // Arrange
      const handler = jest.fn().mockResolvedValue({ fulfill: { data: '' } });

      // Act - call before start()
      connectorNode.setLocalDeliveryHandler(handler);

      // Assert - no errors, handler propagated
      expect(mockPacketHandler.setLocalDeliveryHandler).toHaveBeenCalledWith(handler);
    });

    it('should be callable after construction (handler propagated to PacketHandler)', async () => {
      // Arrange
      const handler = jest.fn().mockResolvedValue({ fulfill: { data: '' } });
      await connectorNode.start();
      jest.clearAllMocks();

      // Act
      connectorNode.setLocalDeliveryHandler(handler);

      // Assert
      expect(mockPacketHandler.setLocalDeliveryHandler).toHaveBeenCalledWith(handler);
    });

    it('should clear the handler when called with null (reverts to HTTP fallback)', () => {
      // Arrange
      const handler = jest.fn().mockResolvedValue({ fulfill: { data: '' } });
      connectorNode.setLocalDeliveryHandler(handler);
      jest.clearAllMocks();

      // Act
      connectorNode.setLocalDeliveryHandler(null);

      // Assert
      expect(mockPacketHandler.setLocalDeliveryHandler).toHaveBeenCalledWith(null);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'local_delivery_handler_set',
          hasHandler: false,
        }),
        'Local delivery function handler cleared'
      );
    });
  });

  describe('setPacketHandler()', () => {
    beforeEach(() => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      jest.clearAllMocks();
    });

    it('should wrap handler and propagate to PacketHandler', () => {
      // Arrange
      const handler = jest.fn().mockResolvedValue({ accept: true });

      // Act
      connectorNode.setPacketHandler(handler);

      // Assert — should have called setLocalDeliveryHandler with a function (the adapter)
      expect(mockPacketHandler.setLocalDeliveryHandler).toHaveBeenCalledWith(expect.any(Function));
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'packet_handler_set',
          hasHandler: true,
        }),
        'Packet handler registered'
      );
    });

    it('should clear the handler when called with null', () => {
      // Arrange — set a handler first
      connectorNode.setPacketHandler(jest.fn().mockResolvedValue({ accept: true }));
      jest.clearAllMocks();

      // Act
      connectorNode.setPacketHandler(null);

      // Assert
      expect(mockPacketHandler.setLocalDeliveryHandler).toHaveBeenCalledWith(null);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'packet_handler_set',
          hasHandler: false,
        }),
        'Packet handler cleared'
      );
    });

    it('should be callable before start()', () => {
      // Arrange
      const handler = jest.fn().mockResolvedValue({ accept: true });

      // Act — call before start()
      connectorNode.setPacketHandler(handler);

      // Assert — no errors, adapter propagated
      expect(mockPacketHandler.setLocalDeliveryHandler).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should overwrite previous setLocalDeliveryHandler (last writer wins)', () => {
      // Arrange — set a raw local delivery handler first
      const rawHandler = jest.fn().mockResolvedValue({ fulfill: { data: '' } });
      connectorNode.setLocalDeliveryHandler(rawHandler);
      jest.clearAllMocks();

      // Act — now set a payment handler, should overwrite
      connectorNode.setPacketHandler(jest.fn().mockResolvedValue({ accept: true }));

      // Assert — setLocalDeliveryHandler called with new adapter (not the raw handler)
      expect(mockPacketHandler.setLocalDeliveryHandler).toHaveBeenCalledTimes(1);
      const calledWith = mockPacketHandler.setLocalDeliveryHandler.mock.calls[0]![0];
      expect(calledWith).not.toBe(rawHandler);
      expect(typeof calledWith).toBe('function');
    });
  });

  describe('sendPacket()', () => {
    const validParams = {
      destination: 'g.peerA.alice',
      amount: 1000n,
      expiresAt: new Date(Date.now() + 30000),
    };

    const createMockFulfill = (): ILPFulfillPacket => ({
      type: PacketType.FULFILL as const,
      data: Buffer.alloc(0),
    });

    const createMockReject = (code = ILPErrorCode.F02_UNREACHABLE): ILPRejectPacket => ({
      type: PacketType.REJECT as const,
      code,
      triggeredBy: 'connector-test',
      message: 'No route found',
      data: Buffer.alloc(0),
    });

    beforeEach(() => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      jest.clearAllMocks();
    });

    it('should route packet through PacketHandler.handlePreparePacket()', async () => {
      // Arrange
      await connectorNode.start();
      jest.clearAllMocks();
      mockPacketHandler.handlePreparePacket.mockResolvedValue(createMockFulfill());

      // Act
      await connectorNode.sendPacket(validParams);

      // Assert
      expect(mockPacketHandler.handlePreparePacket).toHaveBeenCalledWith(
        expect.objectContaining({
          type: PacketType.PREPARE,
          destination: validParams.destination,
          amount: validParams.amount,
          expiresAt: validParams.expiresAt,
        }),
        'connector-test' // nodeId as fromPeerId
      );
    });

    it('should return Fulfill on successful routing', async () => {
      // Arrange
      await connectorNode.start();
      jest.clearAllMocks();
      const mockFulfill = createMockFulfill();
      mockPacketHandler.handlePreparePacket.mockResolvedValue(mockFulfill);

      // Act
      const result = await connectorNode.sendPacket(validParams);

      // Assert
      expect(result).toBe(mockFulfill);
    });

    it('should return Reject on routing failure (no route)', async () => {
      // Arrange
      await connectorNode.start();
      jest.clearAllMocks();
      const mockReject = createMockReject();
      mockPacketHandler.handlePreparePacket.mockResolvedValue(mockReject);

      // Act
      const result = await connectorNode.sendPacket(validParams);

      // Assert
      expect(result).toBe(mockReject);
      expect(result.type).toBe(PacketType.REJECT);
    });

    it('should throw ConnectorNotStartedError before start()', async () => {
      // Arrange - do NOT call start()

      // Act & Assert
      await expect(connectorNode.sendPacket(validParams)).rejects.toThrow(ConnectorNotStartedError);
      await expect(connectorNode.sendPacket(validParams)).rejects.toThrow(
        'Connector is not started. Call start() before sendPacket().'
      );
    });

    it('should throw ConnectorNotStartedError after stop()', async () => {
      // Arrange
      await connectorNode.start();
      await connectorNode.stop();

      // Act & Assert
      await expect(connectorNode.sendPacket(validParams)).rejects.toThrow(ConnectorNotStartedError);
    });

    it('should construct ILPPreparePacket with correct fields', async () => {
      // Arrange
      await connectorNode.start();
      jest.clearAllMocks();
      mockPacketHandler.handlePreparePacket.mockResolvedValue(createMockFulfill());

      // Act - send without optional data
      await connectorNode.sendPacket(validParams);

      // Assert
      const calls = mockPacketHandler.handlePreparePacket.mock.calls;
      expect(calls.length).toBe(1);
      const packet = calls[0]![0];
      expect(packet.type).toBe(PacketType.PREPARE);
      expect(packet.destination).toBe(validParams.destination);
      expect(packet.amount).toBe(validParams.amount);
      expect(packet.expiresAt).toBe(validParams.expiresAt);
      expect(packet.data).toEqual(Buffer.alloc(0)); // default when not provided
    });

    it('should forward custom data payload', async () => {
      // Arrange
      await connectorNode.start();
      jest.clearAllMocks();
      mockPacketHandler.handlePreparePacket.mockResolvedValue(createMockFulfill());
      const customData = Buffer.from('test-payload');

      // Act
      await connectorNode.sendPacket({ ...validParams, data: customData });

      // Assert
      const calls = mockPacketHandler.handlePreparePacket.mock.calls;
      expect(calls.length).toBe(1);
      const packet = calls[0]![0];
      expect(packet.data).toEqual(Buffer.from('test-payload'));
    });

    describe('executionCondition (issue #309/PR #310 egress symmetry)', () => {
      // Sender-minted preimage/condition pair (spec R1: C = sha256(P)).
      const preimage = new Uint8Array(32).fill(0x42);
      const condition = new Uint8Array(sha256(preimage));

      beforeEach(async () => {
        await connectorNode.start();
        jest.clearAllMocks();
        mockPacketHandler.handlePreparePacket.mockResolvedValue(createMockFulfill());
      });

      it('should ride the PREPARE verbatim when supplied as Uint8Array', async () => {
        await connectorNode.sendPacket({ ...validParams, executionCondition: condition });

        const packet = mockPacketHandler.handlePreparePacket.mock.calls[0]![0];
        expect(packet.executionCondition).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(packet.executionCondition!)).toEqual(Buffer.from(condition));
      });

      it('should decode a base64 string condition to the same 32 bytes', async () => {
        await connectorNode.sendPacket({
          ...validParams,
          executionCondition: Buffer.from(condition).toString('base64'),
        });

        const packet = mockPacketHandler.handlePreparePacket.mock.calls[0]![0];
        expect(Buffer.from(packet.executionCondition!)).toEqual(Buffer.from(condition));
      });

      it('should omit executionCondition from the packet when absent (legacy path unchanged)', async () => {
        await connectorNode.sendPacket(validParams);

        const packet = mockPacketHandler.handlePreparePacket.mock.calls[0]![0];
        expect('executionCondition' in packet).toBe(false);
      });

      it('should surface the FULFILL fulfillment preimage to the caller', async () => {
        mockPacketHandler.handlePreparePacket.mockResolvedValue({
          type: PacketType.FULFILL as const,
          fulfillment: preimage,
          data: Buffer.alloc(0),
        });

        const result = await connectorNode.sendPacket({
          ...validParams,
          executionCondition: condition,
        });

        expect(result.type).toBe(PacketType.FULFILL);
        const fulfillment = (result as ILPFulfillPacket).fulfillment!;
        expect(Buffer.from(fulfillment)).toEqual(Buffer.from(preimage));
        // Caller-side verification contract: sha256(fulfillment) === condition.
        expect(Buffer.from(sha256(new Uint8Array(fulfillment)))).toEqual(Buffer.from(condition));
      });

      it.each([
        ['a 31-byte Uint8Array', new Uint8Array(31).fill(1), /exactly 32 bytes, got 31/],
        ['a 33-byte Uint8Array', new Uint8Array(33).fill(1), /exactly 32 bytes, got 33/],
        ['an invalid base64 string', 'not-valid-base64!!!', /must be valid base64/],
        [
          'a base64 string decoding to 16 bytes',
          Buffer.alloc(16, 7).toString('base64'),
          /exactly 32 bytes, got 16/,
        ],
        ['an all-zero Uint8Array', new Uint8Array(32), /must not be all-zero/],
        ['an all-zero base64 string', Buffer.alloc(32).toString('base64'), /must not be all-zero/],
      ] as Array<[string, Uint8Array | string, RegExp]>)(
        'should throw InvalidExecutionConditionError for %s without sending',
        async (_label, badCondition, messagePattern) => {
          await expect(
            connectorNode.sendPacket({ ...validParams, executionCondition: badCondition })
          ).rejects.toThrow(InvalidExecutionConditionError);
          await expect(
            connectorNode.sendPacket({ ...validParams, executionCondition: badCondition })
          ).rejects.toThrow(messagePattern);
          expect(mockPacketHandler.handlePreparePacket).not.toHaveBeenCalled();
        }
      );

      it('should log hasExecutionCondition on send', async () => {
        await connectorNode.sendPacket({ ...validParams, executionCondition: condition });

        expect(mockLogger.info).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'send_packet', hasExecutionCondition: true }),
          'Sending packet via public API'
        );
      });
    });

    it('should return T00 Reject on unexpected handlePreparePacket error', async () => {
      // Arrange
      await connectorNode.start();
      jest.clearAllMocks();
      mockPacketHandler.handlePreparePacket.mockRejectedValue(new Error('something broke'));

      // Act
      const result = await connectorNode.sendPacket(validParams);

      // Assert
      expect(result.type).toBe(PacketType.REJECT);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).code).toBe(ILPErrorCode.T00_INTERNAL_ERROR);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).triggeredBy).toBe('connector-test');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'send_packet_error',
          destination: validParams.destination,
        }),
        expect.any(String)
      );
    });

    it('should log send_packet event', async () => {
      // Arrange
      await connectorNode.start();
      jest.clearAllMocks();
      mockPacketHandler.handlePreparePacket.mockResolvedValue(createMockFulfill());

      // Act
      await connectorNode.sendPacket(validParams);

      // Assert
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'send_packet',
          destination: validParams.destination,
          amount: validParams.amount.toString(),
        }),
        'Sending packet via public API'
      );
    });
  });

  describe('getRoutingTable()', () => {
    beforeEach(() => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
    });

    it('should return routing table entries', () => {
      // Arrange
      const expectedRoutes: RoutingTableEntry[] = [
        { prefix: 'g.peerA', nextHop: 'peerA' },
        { prefix: 'g.peerB', nextHop: 'peerB' },
      ];
      mockRoutingTable.getAllRoutes.mockReturnValue(expectedRoutes);

      // Act
      const routes = connectorNode.getRoutingTable();

      // Assert
      expect(routes).toEqual(expectedRoutes);
      expect(mockRoutingTable.getAllRoutes).toHaveBeenCalledTimes(1);
    });
  });

  describe('admin operations', () => {
    beforeEach(async () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      jest.clearAllMocks();
      // Re-apply mocks after clearAllMocks
      mockRoutingTable.getAllRoutes.mockReturnValue([
        { prefix: 'g.peerA', nextHop: 'peerA', priority: 0 },
      ]);
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', true]]));
      mockBTPClientManager.isConnected.mockReturnValue(true);
      // Start connector to enable lifecycle checks
      await connectorNode.start();
      jest.clearAllMocks();
      // Re-apply mocks after second clearAllMocks
      mockRoutingTable.getAllRoutes.mockReturnValue([
        { prefix: 'g.peerA', nextHop: 'peerA', priority: 0 },
      ]);
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', true]]));
      mockBTPClientManager.isConnected.mockReturnValue(true);
    });

    // ── registerPeer() ──

    it('registerPeer() adds a new peer via BTPClientManager', async () => {
      // Arrange
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']); // peerB not in list yet
      mockBTPClientManager.isConnected.mockReturnValue(false);
      mockRoutingTable.getAllRoutes.mockReturnValue([]);

      // Act
      const result = await connectorNode.registerPeer({
        id: 'peerB',
        // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
        url: 'ws://peer-b:3000',
        authToken: 'token-b',
      });

      // Assert
      expect(mockBTPClientManager.addPeer).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'peerB',
          // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
          url: 'ws://peer-b:3000',
          authToken: 'token-b',
          connected: false,
        })
      );
      expect(result.id).toBe('peerB');
    });

    it('registerPeer() adds routes for new peer', async () => {
      // Arrange
      mockBTPClientManager.getPeerIds.mockReturnValue([]); // new peer
      mockBTPClientManager.isConnected.mockReturnValue(false);
      mockRoutingTable.getAllRoutes.mockReturnValue([]);

      // Act
      await connectorNode.registerPeer({
        id: 'peerB',
        // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
        url: 'ws://peer-b:3000',
        authToken: 'token-b',
        routes: [{ prefix: 'g.peerB', priority: 10 }, { prefix: 'g.peerB.sub' }],
      });

      // Assert
      expect(mockRoutingTable.addRoute).toHaveBeenCalledTimes(2);
      expect(mockRoutingTable.addRoute).toHaveBeenCalledWith('g.peerB', 'peerB', 10);
      expect(mockRoutingTable.addRoute).toHaveBeenCalledWith('g.peerB.sub', 'peerB', 0);
    });

    it('registerPeer() propagates relation to the packet handler and echoes it (issue #76)', async () => {
      // Arrange
      mockBTPClientManager.getPeerIds.mockReturnValue([]); // new peer
      mockBTPClientManager.isConnected.mockReturnValue(false);
      mockRoutingTable.getAllRoutes.mockReturnValue([]);

      // Act
      const result = await connectorNode.registerPeer({
        id: 'swap',
        // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
        url: 'ws://swap:3000',
        authToken: 'token-swap',
        relation: 'child',
      });

      // Assert
      expect(mockPacketHandler.setPeerRelation).toHaveBeenCalledWith('swap', 'child');
      expect(result.relation).toBe('child');
    });

    it("registerPeer() defaults an omitted relation to 'peer' (issue #76)", async () => {
      // Arrange
      mockBTPClientManager.getPeerIds.mockReturnValue([]);
      mockBTPClientManager.isConnected.mockReturnValue(false);
      mockRoutingTable.getAllRoutes.mockReturnValue([]);

      // Act
      await connectorNode.registerPeer({
        id: 'peerB',
        // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
        url: 'ws://peer-b:3000',
        authToken: 'token-b',
      });

      // Assert
      expect(mockPacketHandler.setPeerRelation).toHaveBeenCalledWith('peerB', 'peer');
    });

    it('registerPeer() rejects an invalid relation (issue #76)', async () => {
      // Act & Assert
      await expect(
        connectorNode.registerPeer({
          id: 'peerB',
          // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
          url: 'ws://peer-b:3000',
          authToken: 'token-b',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          relation: 'sibling' as any,
        })
      ).rejects.toThrow(/Invalid relation: must be 'parent', 'peer', or 'child' \(got 'sibling'\)/);
    });

    // ── toon-meta#153: config child bindings + apex self-prefix ──

    it('registerPeer() rejects a relation contradicting a config child binding (toon-meta#153)', async () => {
      // Arrange: config binds 'store-box' as the child 'store' under the apex.
      const childCfg = createTestConfig({
        apex: 'g.self',
        children: [{ name: 'store', peerId: 'store-box' }],
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(childCfg);
      const node = new ConnectorNode(testConfigPath, mockLogger);
      await node.start();
      mockBTPClientManager.getPeerIds.mockReturnValue([]);
      mockRoutingTable.getAllRoutes.mockReturnValue([]);

      // Act & Assert: a non-child relation contradicts the config binding.
      await expect(
        node.registerPeer({
          id: 'store-box',
          // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
          url: 'ws://store-box:3000',
          authToken: 't',
          relation: 'peer',
        })
      ).rejects.toThrow(/bound as child 'store' in config; relation must be 'child'/);
    });

    it('registerPeer() skips the auto child route for a config-bound child peer (toon-meta#153)', async () => {
      // Arrange: the expanded route `g.self.store` already binds this peer at
      // config load — no `<self>.<peerId>` auto-route should be re-derived.
      const childCfg = createTestConfig({
        apex: 'g.self',
        children: [{ name: 'store', peerId: 'store-box' }],
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(childCfg);
      const node = new ConnectorNode(testConfigPath, mockLogger);
      await node.start();
      mockBTPClientManager.getPeerIds.mockReturnValue([]);
      mockRoutingTable.getAllRoutes.mockReturnValue([]);
      mockRoutingTable.addRoute.mockClear();

      // Act
      await node.registerPeer({
        id: 'store-box',
        // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
        url: 'ws://store-box:3000',
        authToken: 't',
        relation: 'child',
      });

      // Assert
      expect(mockRoutingTable.addRoute).not.toHaveBeenCalled();
      expect(mockPacketHandler.setPeerRelation).toHaveBeenCalledWith('store-box', 'child');
    });

    it('registerPeer() counts the config apex as a self-prefix for child admission (toon-meta#153)', async () => {
      // Arrange: NO local routes at all — the explicit apex alone anchors the
      // child subtree, so the auto route `<apex>.<peerId>` can be derived.
      const apexCfg = createTestConfig({ apex: 'g.self' });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(apexCfg);
      const node = new ConnectorNode(testConfigPath, mockLogger);
      await node.start();
      mockBTPClientManager.getPeerIds.mockReturnValue([]);
      mockRoutingTable.getAllRoutes.mockReturnValue([]);
      mockRoutingTable.addRoute.mockClear();

      // Act
      await node.registerPeer({
        id: 'kid',
        // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
        url: 'ws://kid:3000',
        authToken: 't',
        relation: 'child',
      });

      // Assert
      expect(mockRoutingTable.addRoute).toHaveBeenCalledWith('g.self.kid', 'kid', 0);
    });

    it('registerPeer() throws ConnectorNotStartedError before start()', async () => {
      // Arrange - create fresh connector, do NOT start
      const freshConnector = new ConnectorNode(testConfigPath, mockLogger);

      // Act & Assert
      await expect(
        freshConnector.registerPeer({
          id: 'peerB',
          // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
          url: 'ws://peer-b:3000',
          authToken: 'token-b',
        })
      ).rejects.toThrow(ConnectorNotStartedError);
    });

    it('registerPeer() validates URL format', async () => {
      // Act & Assert
      await expect(
        connectorNode.registerPeer({
          id: 'peerB',
          url: 'http://invalid',
          authToken: 'token',
        })
        // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
      ).rejects.toThrow('URL must start with ws:// or wss://');
    });

    it('registerPeer() handles re-registration (idempotent)', async () => {
      // Arrange - peerA already exists
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockRoutingTable.getAllRoutes.mockReturnValue([
        { prefix: 'g.peerA', nextHop: 'peerA', priority: 0 },
      ]);

      // Act
      const result = await connectorNode.registerPeer({
        id: 'peerA',
        // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
        url: 'ws://connector-a:3000',
        authToken: 'secret-a',
        routes: [{ prefix: 'g.peerA.new' }],
      });

      // Assert - addPeer NOT called (re-registration)
      expect(mockBTPClientManager.addPeer).not.toHaveBeenCalled();
      // But routes ARE added
      expect(mockRoutingTable.addRoute).toHaveBeenCalledWith('g.peerA.new', 'peerA', 0);
      expect(result.id).toBe('peerA');
    });

    it('registerPeer() validates ILP address prefix in routes', async () => {
      // Arrange
      mockBTPClientManager.getPeerIds.mockReturnValue([]);

      // Act & Assert
      await expect(
        connectorNode.registerPeer({
          id: 'peerB',
          // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
          url: 'ws://peer-b:3000',
          authToken: 'token',
          routes: [{ prefix: 'INVALID PREFIX!!!' }],
        })
      ).rejects.toThrow('Invalid ILP address prefix: INVALID PREFIX!!!');
    });

    // ── toon-meta#153: peeringPolicy.maxFundedChannels (discovered-vs-peered) ──

    describe('peeringPolicy.maxFundedChannels', () => {
      const settlement = {
        preference: 'evm' as const,
        evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
        chainId: 8453,
      };

      /** A started node whose config caps funded channels at `max`. */
      async function makeCappedNode(max: number): Promise<ConnectorNode> {
        const cappedConfig = createTestConfig({
          peers: [],
          routes: [],
          peeringPolicy: { maxFundedChannels: max },
        });
        (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(cappedConfig);
        const node = new ConnectorNode(testConfigPath, mockLogger);
        await node.start();
        mockBTPClientManager.getPeerIds.mockReturnValue([]);
        mockRoutingTable.getAllRoutes.mockReturnValue([]);
        return node;
      }

      it('rejects a settlement-bearing registration beyond the cap, before any mutation', async () => {
        const node = await makeCappedNode(1);

        // First funded channel fits (0/1 in use).
        await node.registerPeer({
          id: 'funded-1',
          // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
          url: 'ws://funded-1:3000',
          authToken: 't1',
          settlement,
        });

        // funded-1 is now live; a second funded channel would exceed the cap.
        mockBTPClientManager.getPeerIds.mockReturnValue(['funded-1']);
        mockBTPClientManager.addPeer.mockClear();
        await expect(
          node.registerPeer({
            id: 'funded-2',
            // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
            url: 'ws://funded-2:3000',
            authToken: 't2',
            settlement,
          })
        ).rejects.toThrow(/Funded-channel cap reached: 1\/1 funded channels in use/);
        expect(mockBTPClientManager.addPeer).not.toHaveBeenCalled();
      });

      it('never caps a route-only (no settlement) registration — discovery/routing stays free', async () => {
        const node = await makeCappedNode(1);
        await node.registerPeer({
          id: 'funded-1',
          // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
          url: 'ws://funded-1:3000',
          authToken: 't1',
          settlement,
        });
        mockBTPClientManager.getPeerIds.mockReturnValue(['funded-1']);

        // At the cap, an UNFUNDED link is still admitted.
        const result = await node.registerPeer({
          id: 'route-only',
          // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
          url: 'ws://route-only:3000',
          authToken: 't3',
        });
        expect(result.id).toBe('route-only');
      });

      it('re-registering an already-funded peer at the cap does not consume a new slot', async () => {
        const node = await makeCappedNode(1);
        await node.registerPeer({
          id: 'funded-1',
          // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
          url: 'ws://funded-1:3000',
          authToken: 't1',
          settlement,
        });
        mockBTPClientManager.getPeerIds.mockReturnValue(['funded-1']);

        // Settlement-config merge on the SAME peer is admitted at the cap.
        const result = await node.registerPeer({
          id: 'funded-1',
          // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
          url: 'ws://funded-1:3000',
          authToken: 't1',
          settlement: { ...settlement, chainId: 42161 },
        });
        expect(result.id).toBe('funded-1');
      });

      it('removePeer() frees a funded slot', async () => {
        const node = await makeCappedNode(1);
        await node.registerPeer({
          id: 'funded-1',
          // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
          url: 'ws://funded-1:3000',
          authToken: 't1',
          settlement,
        });
        mockBTPClientManager.getPeerIds.mockReturnValue(['funded-1']);

        await node.removePeer('funded-1');

        // Slot freed — the next funded registration is admitted.
        mockBTPClientManager.getPeerIds.mockReturnValue([]);
        const result = await node.registerPeer({
          id: 'funded-2',
          // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
          url: 'ws://funded-2:3000',
          authToken: 't2',
          settlement,
        });
        expect(result.id).toBe('funded-2');
      });

      it('leaves settlement-bearing registrations unlimited when no peeringPolicy is configured', async () => {
        // Default createTestConfig carries no peeringPolicy block.
        mockBTPClientManager.getPeerIds.mockReturnValue([]);
        mockRoutingTable.getAllRoutes.mockReturnValue([]);
        for (const id of ['f1', 'f2', 'f3']) {
          const result = await connectorNode.registerPeer({
            id,
            // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
            url: `ws://${id}:3000`,
            authToken: 't',
            settlement,
          });
          expect(result.id).toBe(id);
        }
      });
    });

    // ── toon-meta#153: getDiscoveredNodes() (discovered-vs-peered) ──

    it('getDiscoveredNodes() returns an empty list when route learning is disabled (no ingest feed)', () => {
      expect(connectorNode.getDiscoveredNodes()).toEqual([]);
    });

    // ── removePeer() ──

    it('removePeer() disconnects and removes a peer, returns RemovePeerResult', async () => {
      // Arrange
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockRoutingTable.getAllRoutes.mockReturnValue([
        { prefix: 'g.peerA', nextHop: 'peerA', priority: 0 },
      ]);

      // Act
      const result = await connectorNode.removePeer('peerA');

      // Assert
      expect(mockBTPClientManager.removePeer).toHaveBeenCalledWith('peerA');
      expect(result.peerId).toBe('peerA');
      expect(result.removedRoutes).toContain('g.peerA');
    });

    it('removePeer() removes associated routes when removeRoutes=true and returns prefixes', async () => {
      // Arrange
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockRoutingTable.getAllRoutes.mockReturnValue([
        { prefix: 'g.peerA', nextHop: 'peerA', priority: 0 },
        { prefix: 'g.peerA.sub', nextHop: 'peerA', priority: 0 },
        { prefix: 'g.other', nextHop: 'otherPeer', priority: 0 },
      ]);

      // Act
      const result = await connectorNode.removePeer('peerA', true);

      // Assert
      expect(mockRoutingTable.removeRoute).toHaveBeenCalledTimes(2);
      expect(mockRoutingTable.removeRoute).toHaveBeenCalledWith('g.peerA');
      expect(mockRoutingTable.removeRoute).toHaveBeenCalledWith('g.peerA.sub');
      expect(result.removedRoutes).toEqual(['g.peerA', 'g.peerA.sub']);
    });

    it('removePeer() returns empty removedRoutes when removeRoutes=false', async () => {
      // Arrange
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);

      // Act
      const result = await connectorNode.removePeer('peerA', false);

      // Assert
      expect(mockRoutingTable.removeRoute).not.toHaveBeenCalled();
      expect(result.removedRoutes).toEqual([]);
    });

    it('removePeer() throws Error for non-existent peer', async () => {
      // Arrange
      mockBTPClientManager.getPeerIds.mockReturnValue([]);

      // Act & Assert
      await expect(connectorNode.removePeer('unknown')).rejects.toThrow('Peer not found: unknown');
    });

    it('removePeer() throws ConnectorNotStartedError before start()', async () => {
      // Arrange
      const freshConnector = new ConnectorNode(testConfigPath, mockLogger);

      // Act & Assert
      await expect(freshConnector.removePeer('peerA')).rejects.toThrow(ConnectorNotStartedError);
    });

    // ── listPeers() ──

    it('listPeers() returns all peers with connection status', () => {
      // Arrange
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA', 'peerB']);
      mockBTPClientManager.getPeerStatus.mockReturnValue(
        new Map([
          ['peerA', true],
          ['peerB', false],
        ])
      );
      mockRoutingTable.getAllRoutes.mockReturnValue([
        { prefix: 'g.peerA', nextHop: 'peerA', priority: 0 },
        { prefix: 'g.peerB', nextHop: 'peerB', priority: 0 },
        { prefix: 'g.peerB.sub', nextHop: 'peerB', priority: 5 },
      ]);

      // Act
      const peers = connectorNode.listPeers();

      // Assert
      expect(peers).toHaveLength(2);

      const peerA = peers.find((p) => p.id === 'peerA');
      expect(peerA).toBeDefined();
      expect(peerA!.connected).toBe(true);
      expect(peerA!.ilpAddresses).toEqual(['g.peerA']);
      expect(peerA!.routeCount).toBe(1);

      const peerB = peers.find((p) => p.id === 'peerB');
      expect(peerB).toBeDefined();
      expect(peerB!.connected).toBe(false);
      expect(peerB!.ilpAddresses).toEqual(['g.peerB', 'g.peerB.sub']);
      expect(peerB!.routeCount).toBe(2);
    });

    // ── getBalance() ──

    it('getBalance() returns balance from AccountManager', async () => {
      // Arrange - access private _accountManager and set mock
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connectorNode as any)._accountManager = {
        getAccountBalance: jest.fn().mockResolvedValue({
          debitBalance: 100n,
          creditBalance: 200n,
          netBalance: -100n,
        }),
      };

      // Act
      const result = await connectorNode.getBalance('peerA', 'M2M');

      // Assert
      expect(result.peerId).toBe('peerA');
      expect(result.balances).toHaveLength(1);
      expect(result.balances[0]).toEqual({
        tokenId: 'M2M',
        debitBalance: '100',
        creditBalance: '200',
        netBalance: '-100',
      });
    });

    it('getBalance() throws when account management not enabled', async () => {
      // Arrange - ensure _accountManager is null (default)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connectorNode as any)._accountManager = null;

      // Act & Assert
      await expect(connectorNode.getBalance('peerA')).rejects.toThrow(
        'Account management not enabled'
      );
    });

    // ── listRoutes() ──

    it('listRoutes() returns all routes from routing table', () => {
      // Arrange
      mockRoutingTable.getAllRoutes.mockReturnValue([
        { prefix: 'g.peerA', nextHop: 'peerA', priority: 0 },
        { prefix: 'g.peerB', nextHop: 'peerB', priority: 5 },
      ]);

      // Act
      const routes = connectorNode.listRoutes();

      // Assert
      expect(routes).toEqual([
        { prefix: 'g.peerA', nextHop: 'peerA', priority: 0 },
        { prefix: 'g.peerB', nextHop: 'peerB', priority: 5 },
      ]);
    });

    // ── addRoute() ──

    it('addRoute() adds route to routing table', () => {
      // Act
      connectorNode.addRoute({ prefix: 'g.test', nextHop: 'peerA', priority: 10 });

      // Assert
      expect(mockRoutingTable.addRoute).toHaveBeenCalledWith('g.test', 'peerA', 10);
    });

    it('addRoute() validates ILP address format', () => {
      // Act & Assert
      expect(() =>
        connectorNode.addRoute({ prefix: 'INVALID!!!', nextHop: 'peerA', priority: 0 })
      ).toThrow('Invalid ILP address prefix: INVALID!!!');
    });

    it('addRoute() validates nextHop is not empty', () => {
      // Act & Assert
      expect(() => connectorNode.addRoute({ prefix: 'g.test', nextHop: '', priority: 0 })).toThrow(
        'Missing or invalid nextHop'
      );
    });

    // ── removeRoute() ──

    it('removeRoute() removes route from routing table', () => {
      // Arrange
      mockRoutingTable.getAllRoutes.mockReturnValue([
        { prefix: 'g.peerA', nextHop: 'peerA', priority: 0 },
      ]);

      // Act
      connectorNode.removeRoute('g.peerA');

      // Assert
      expect(mockRoutingTable.removeRoute).toHaveBeenCalledWith('g.peerA');
    });

    it('removeRoute() throws Error for non-existent route', () => {
      // Arrange
      mockRoutingTable.getAllRoutes.mockReturnValue([]);

      // Act & Assert
      expect(() => connectorNode.removeRoute('g.nonexistent')).toThrow(
        'Route not found: g.nonexistent'
      );
    });
  });

  describe('openChannel()', () => {
    beforeEach(async () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      jest.clearAllMocks();
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', true]]));
      await connectorNode.start();
      jest.clearAllMocks();
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
    });

    it('throws ConnectorNotStartedError if not started', async () => {
      const freshConnector = new ConnectorNode(testConfigPath, mockLogger);
      await expect(
        freshConnector.openChannel({
          peerId: 'peerA',
          chain: 'evm:base:8453',
          peerAddress: '0x' + 'ab'.repeat(20),
        })
      ).rejects.toThrow(ConnectorNotStartedError);
    });

    it('throws if settlement infrastructure not enabled (_channelManager is null)', async () => {
      // _channelManager is null by default (no settlement env vars set)
      await expect(
        connectorNode.openChannel({
          peerId: 'peerA',
          chain: 'evm:base:8453',
          peerAddress: '0x' + 'ab'.repeat(20),
        })
      ).rejects.toThrow(
        'No EVM chain provider configured -- openChannel requires a chainProviders entry with chainType: "evm"'
      );
    });

    it('throws if peer not registered', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connectorNode as any)._channelManager = {
        getChannelForPeer: jest.fn(),
        ensureChannelExists: jest.fn(),
        getChannelById: jest.fn(),
      };
      mockBTPClientManager.getPeerIds.mockReturnValue([]); // no peers

      await expect(
        connectorNode.openChannel({
          peerId: 'unknown-peer',
          chain: 'evm:base:8453',
          peerAddress: '0x' + 'ab'.repeat(20),
        })
      ).rejects.toThrow("Peer 'unknown-peer' must be registered before opening channels");
    });

    it('throws if active channel already exists for peer+token', async () => {
      const mockChannelManager = {
        getChannelForPeer: jest.fn().mockReturnValue({ status: 'open' }),
        ensureChannelExists: jest.fn(),
        getChannelById: jest.fn(),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connectorNode as any)._channelManager = mockChannelManager;

      await expect(
        connectorNode.openChannel({
          peerId: 'peerA',
          chain: 'evm:base:8453',
          peerAddress: '0x' + 'ab'.repeat(20),
        })
      ).rejects.toThrow('Channel already exists for peer peerA with token AGENT');
    });

    it('calls channelManager.ensureChannelExists() with correct params and returns result', async () => {
      const mockChannelManager = {
        getChannelForPeer: jest.fn().mockReturnValue(null),
        ensureChannelExists: jest.fn().mockResolvedValue('0xchannel123'),
        getChannelById: jest.fn().mockReturnValue({
          channelId: '0xchannel123',
          status: 'open',
          chain: 'evm:base:8453',
        }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connectorNode as any)._channelManager = mockChannelManager;

      const result = await connectorNode.openChannel({
        peerId: 'peerA',
        chain: 'evm:base:8453',
        peerAddress: '0x' + 'ab'.repeat(20),
        initialDeposit: '5000',
        settlementTimeout: 3600,
        token: 'M2M',
      });

      expect(mockChannelManager.ensureChannelExists).toHaveBeenCalledWith('peerA', 'M2M', {
        initialDeposit: 5000n,
        settlementTimeout: 3600,
        chain: 'evm:base:8453',
        peerAddress: '0x' + 'ab'.repeat(20),
      });
      expect(result).toEqual({ channelId: '0xchannel123', status: 'open' });
    });

    it('uses default tokenId AGENT when token not provided', async () => {
      const mockChannelManager = {
        getChannelForPeer: jest.fn().mockReturnValue(null),
        ensureChannelExists: jest.fn().mockResolvedValue('0xchannel456'),
        getChannelById: jest.fn().mockReturnValue({
          channelId: '0xchannel456',
          status: 'open',
          chain: 'evm:base:8453',
        }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connectorNode as any)._channelManager = mockChannelManager;

      await connectorNode.openChannel({
        peerId: 'peerA',
        chain: 'evm:base:8453',
        peerAddress: '0x' + 'ab'.repeat(20),
      });

      expect(mockChannelManager.ensureChannelExists).toHaveBeenCalledWith(
        'peerA',
        'AGENT',
        expect.objectContaining({ initialDeposit: 0n })
      );
    });

    it('uses default initialDeposit 0 when not provided', async () => {
      const mockChannelManager = {
        getChannelForPeer: jest.fn().mockReturnValue(null),
        ensureChannelExists: jest.fn().mockResolvedValue('0xchannel789'),
        getChannelById: jest.fn().mockReturnValue({
          channelId: '0xchannel789',
          status: 'opening',
          chain: 'evm:base:8453',
        }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connectorNode as any)._channelManager = mockChannelManager;

      await connectorNode.openChannel({
        peerId: 'peerA',
        chain: 'evm:base:8453',
        peerAddress: '0x' + 'ab'.repeat(20),
      });

      expect(mockChannelManager.ensureChannelExists).toHaveBeenCalledWith(
        'peerA',
        'AGENT',
        expect.objectContaining({ initialDeposit: 0n })
      );
    });
  });

  describe('getChannelState()', () => {
    beforeEach(async () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      jest.clearAllMocks();
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', true]]));
      await connectorNode.start();
      jest.clearAllMocks();
    });

    it('throws ConnectorNotStartedError if not started', async () => {
      const freshConnector = new ConnectorNode(testConfigPath, mockLogger);
      await expect(freshConnector.getChannelState('0xchannel123')).rejects.toThrow(
        ConnectorNotStartedError
      );
    });

    it('throws if settlement infrastructure not enabled', async () => {
      // _channelManager is null by default
      await expect(connectorNode.getChannelState('0xchannel123')).rejects.toThrow(
        'No EVM chain provider configured -- openChannel requires a chainProviders entry with chainType: "evm"'
      );
    });

    it('throws if channel not found', async () => {
      const mockChannelManager = {
        getChannelById: jest.fn().mockReturnValue(null),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connectorNode as any)._channelManager = mockChannelManager;

      await expect(connectorNode.getChannelState('0xnonexistent')).rejects.toThrow(
        'Channel not found: 0xnonexistent'
      );
    });

    it('returns { channelId, status, chain } from channel metadata', async () => {
      const mockChannelManager = {
        getChannelById: jest.fn().mockReturnValue({
          channelId: '0xchannel123',
          status: 'active', // will be normalized to 'open'
          chain: 'evm:base:8453',
          peerId: 'peerA',
          tokenId: 'AGENT',
        }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connectorNode as any)._channelManager = mockChannelManager;

      const result = await connectorNode.getChannelState('0xchannel123');

      expect(result).toEqual({
        channelId: '0xchannel123',
        status: 'open',
        chain: 'evm:base:8453',
      });
    });
  });

  describe('Lifecycle — reentrant and idempotent', () => {
    beforeEach(() => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      jest.clearAllMocks();
    });

    it('stop() is idempotent — calling stop() twice does not throw', async () => {
      // Arrange
      await connectorNode.start();
      jest.clearAllMocks();

      // Act — stop twice in sequence
      await connectorNode.stop();
      await connectorNode.stop();

      // Assert — no error thrown, second call is a no-op
    });

    it('stop() on never-started connector does not throw', async () => {
      // Act & Assert — stop without start, should return without error
      await expect(connectorNode.stop()).resolves.toBeUndefined();
    });

    it('start() → stop() → start() lifecycle works (reentrant)', async () => {
      // Arrange & Act — full lifecycle cycle
      await connectorNode.start();
      await connectorNode.stop();
      await connectorNode.start();

      // Assert — healthy after second start
      const healthStatus = connectorNode.getHealthStatus();
      expect(healthStatus.status).toBe('healthy');
    });

    it('start() throws on BTP server failure and sets health to unhealthy', async () => {
      // Arrange
      const testError = new Error('BTP server start failed');
      mockBTPServer.start.mockRejectedValue(testError);

      // Act & Assert
      await expect(connectorNode.start()).rejects.toThrow('BTP server start failed');
      const healthStatus = connectorNode.getHealthStatus();
      expect(healthStatus.status).toBe('unhealthy');
    });

    it('stop() shuts down SettlementMonitor when active', async () => {
      // Arrange
      await connectorNode.start();
      jest.clearAllMocks();

      const mockSettlementMonitor = {
        stop: jest.fn().mockResolvedValue(undefined),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connectorNode as any)._settlementMonitor = mockSettlementMonitor;

      // Act
      await connectorNode.stop();

      // Assert
      expect(mockSettlementMonitor.stop).toHaveBeenCalledTimes(1);
    });

    it('stop() shuts down SettlementExecutor when active', async () => {
      // Arrange
      await connectorNode.start();
      jest.clearAllMocks();

      const mockSettlementExecutor = {
        stop: jest.fn(),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connectorNode as any)._settlementExecutor = mockSettlementExecutor;

      // Act
      await connectorNode.stop();

      // Assert
      expect(mockSettlementExecutor.stop).toHaveBeenCalledTimes(1);
    });

    it('stop() closes TigerBeetle client when connected', async () => {
      // Arrange
      await connectorNode.start();
      jest.clearAllMocks();

      const mockTigerBeetleClient = {
        close: jest.fn().mockResolvedValue(undefined),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connectorNode as any)._tigerBeetleClient = mockTigerBeetleClient;

      // Act
      await connectorNode.stop();

      // Assert
      expect(mockTigerBeetleClient.close).toHaveBeenCalledTimes(1);
    });

    it('stop() shuts down SettlementExecutor before ChannelManager', async () => {
      // Arrange
      await connectorNode.start();
      jest.clearAllMocks();

      const callOrder: string[] = [];
      const mockSettlementExecutor = {
        stop: jest.fn(() => callOrder.push('settlementExecutor')),
      };
      const mockChannelManager = {
        stop: jest.fn(() => callOrder.push('channelManager')),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connectorNode as any)._settlementExecutor = mockSettlementExecutor;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connectorNode as any)._channelManager = mockChannelManager;

      // Act
      await connectorNode.stop();

      // Assert — executor must be stopped before channel manager
      expect(callOrder.indexOf('settlementExecutor')).toBeLessThan(
        callOrder.indexOf('channelManager')
      );
    });
  });

  describe('Deployment Mode Helpers', () => {
    beforeEach(() => {
      // Mock validateConfig to return the config (needed when constructing with config object)
      (ConfigLoader.validateConfig as jest.Mock) = jest
        .fn()
        .mockImplementation((cfg: ConnectorConfig) => cfg);
    });

    describe('getDeploymentMode()', () => {
      it('should return explicit deploymentMode when set to embedded', () => {
        // Arrange
        const config = createTestConfig({ deploymentMode: 'embedded' });
        const node = new ConnectorNode(config, mockLogger);

        // Act
        const mode = node.getDeploymentMode();

        // Assert
        expect(mode).toBe('embedded');
      });

      it('should return explicit deploymentMode when set to standalone', () => {
        // Arrange
        const config = createTestConfig({ deploymentMode: 'standalone' });
        const node = new ConnectorNode(config, mockLogger);

        // Act
        const mode = node.getDeploymentMode();

        // Assert
        expect(mode).toBe('standalone');
      });

      it('should infer standalone when localDelivery.enabled=true and adminApi.enabled=true', () => {
        // Arrange
        const config = createTestConfig({
          localDelivery: { enabled: true, handlerUrl: 'http://app:8080' },
          adminApi: { enabled: true, port: 8081 },
        });
        const node = new ConnectorNode(config, mockLogger);

        // Act
        const mode = node.getDeploymentMode();

        // Assert
        expect(mode).toBe('standalone');
      });

      it('should infer embedded when localDelivery.enabled=false and adminApi.enabled=false', () => {
        // Arrange
        const config = createTestConfig({
          localDelivery: { enabled: false },
          adminApi: { enabled: false },
        });
        const node = new ConnectorNode(config, mockLogger);

        // Act
        const mode = node.getDeploymentMode();

        // Assert
        expect(mode).toBe('embedded');
      });

      it('should infer embedded when localDelivery and adminApi are not configured', () => {
        // Arrange
        const config = createTestConfig({});
        const node = new ConnectorNode(config, mockLogger);

        // Act
        const mode = node.getDeploymentMode();

        // Assert
        expect(mode).toBe('embedded');
      });

      it('should default to embedded for hybrid config (adminApi.enabled=true, localDelivery.enabled=false)', () => {
        // Arrange
        const config = createTestConfig({
          localDelivery: { enabled: false },
          adminApi: { enabled: true, port: 8081 },
        });
        const node = new ConnectorNode(config, mockLogger);

        // Act
        const mode = node.getDeploymentMode();

        // Assert
        expect(mode).toBe('embedded'); // Defaults to embedded for unusual configs
      });

      it('should default to embedded for hybrid config (adminApi.enabled=false, localDelivery.enabled=true)', () => {
        // Arrange
        const config = createTestConfig({
          localDelivery: { enabled: true, handlerUrl: 'http://app:8080' },
          adminApi: { enabled: false },
        });
        const node = new ConnectorNode(config, mockLogger);

        // Act
        const mode = node.getDeploymentMode();

        // Assert
        expect(mode).toBe('embedded'); // Defaults to embedded for unusual configs
      });

      it('should prefer explicit deploymentMode over inferred mode', () => {
        // Arrange - explicit embedded but flags suggest standalone
        const config = createTestConfig({
          deploymentMode: 'embedded',
          localDelivery: { enabled: true, handlerUrl: 'http://app:8080' },
          adminApi: { enabled: true, port: 8081 },
        });
        const node = new ConnectorNode(config, mockLogger);

        // Act
        const mode = node.getDeploymentMode();

        // Assert
        expect(mode).toBe('embedded'); // Explicit mode wins (validation will catch the conflict)
      });
    });

    describe('isEmbedded()', () => {
      it('should return true when deploymentMode is embedded', () => {
        // Arrange
        const config = createTestConfig({ deploymentMode: 'embedded' });
        const node = new ConnectorNode(config, mockLogger);

        // Act & Assert
        expect(node.isEmbedded()).toBe(true);
        expect(node.isStandalone()).toBe(false);
      });

      it('should return true when mode is inferred as embedded', () => {
        // Arrange
        const config = createTestConfig({
          localDelivery: { enabled: false },
          adminApi: { enabled: false },
        });
        const node = new ConnectorNode(config, mockLogger);

        // Act & Assert
        expect(node.isEmbedded()).toBe(true);
        expect(node.isStandalone()).toBe(false);
      });

      it('should return false when deploymentMode is standalone', () => {
        // Arrange
        const config = createTestConfig({ deploymentMode: 'standalone' });
        const node = new ConnectorNode(config, mockLogger);

        // Act & Assert
        expect(node.isEmbedded()).toBe(false);
      });
    });

    describe('isStandalone()', () => {
      it('should return true when deploymentMode is standalone', () => {
        // Arrange
        const config = createTestConfig({ deploymentMode: 'standalone' });
        const node = new ConnectorNode(config, mockLogger);

        // Act & Assert
        expect(node.isStandalone()).toBe(true);
        expect(node.isEmbedded()).toBe(false);
      });

      it('should return true when mode is inferred as standalone', () => {
        // Arrange
        const config = createTestConfig({
          localDelivery: { enabled: true, handlerUrl: 'http://app:8080' },
          adminApi: { enabled: true, port: 8081 },
        });
        const node = new ConnectorNode(config, mockLogger);

        // Act & Assert
        expect(node.isStandalone()).toBe(true);
        expect(node.isEmbedded()).toBe(false);
      });

      it('should return false when deploymentMode is embedded', () => {
        // Arrange
        const config = createTestConfig({ deploymentMode: 'embedded' });
        const node = new ConnectorNode(config, mockLogger);

        // Act & Assert
        expect(node.isStandalone()).toBe(false);
      });
    });
  });
});
