/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */

/**
 * Branch coverage tests for ConnectorNode – Part 2
 * Targets additional uncovered branches in connector-node.ts.
 *
 * @packageDocumentation
 */

import { ConnectorNode } from '../../src/core/connector-node';
import { ConnectorConfig } from '../../src/config/types';
import { ConfigLoader } from '../../src/config/config-loader';
import { RoutingTable } from '../../src/routing/routing-table';
import { BTPClientManager } from '../../src/btp/btp-client-manager';
import { BTPServer } from '../../src/btp/btp-server';
import { PacketHandler } from '../../src/core/packet-handler';
import { Logger } from '../../src/utils/logger';
import { RoutingTableEntry } from '@toon-protocol/shared';
import { HealthServer } from '../../src/http/health-server';
import { requireOptional } from '../../src/utils/optional-require';

// ─────────────────────────────────────────────────────────────────────────────
// Mock all dependencies (same pattern as connector-node.coverage.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('../../src/routing/routing-table');
jest.mock('../../src/btp/btp-client-manager');
jest.mock('../../src/btp/btp-server');
jest.mock('../../src/core/packet-handler');
jest.mock('../../src/config/config-loader', () => {
  const actual = jest.requireActual('../../src/config/config-loader');
  return {
    ...actual,
    ConfigLoader: {
      loadConfig: jest.fn(),
      validateConfig: jest.fn(),
    },
  };
});
jest.mock('../../src/http/health-server');
jest.mock('../../src/http/admin-api', () => ({
  validateSettlementConfig: jest.fn().mockReturnValue(null),
}));
jest.mock('../../src/http/admin-server');
jest.mock('../../src/settlement/payment-channel-sdk', () => ({
  PaymentChannelSDK: jest.fn().mockImplementation(() => ({
    getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
    removeAllListeners: jest.fn(),
  })),
}));
jest.mock('../../src/settlement/channel-manager', () => ({
  ChannelManager: jest.fn().mockImplementation(() => ({
    stop: jest.fn(),
    ensureChannelExists: jest.fn(),
    getChannelForPeer: jest.fn(),
    getChannelById: jest.fn(),
  })),
}));
jest.mock('../../src/settlement/settlement-executor', () => ({
  SettlementExecutor: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    stop: jest.fn(),
    setChannelManager: jest.fn(),
    setPerPacketClaimService: jest.fn(),
    setClaimReceiver: jest.fn(),
  })),
}));
jest.mock('../../src/settlement/account-manager', () => ({
  AccountManager: jest.fn().mockImplementation(() => ({
    getAccountBalance: jest.fn(),
  })),
}));
jest.mock('../../src/settlement/settlement-monitor', () => ({
  SettlementMonitor: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    stop: jest.fn(),
    setClaimReceiver: jest.fn(),
  })),
}));
jest.mock('../../src/settlement/per-packet-claim-service', () => ({
  PerPacketClaimService: jest.fn().mockImplementation(() => ({
    generateClaimForPacket: jest.fn(),
  })),
}));
jest.mock('../../src/btp/inbound-claim-validator', () => ({
  InboundClaimValidator: jest.fn().mockImplementation(() => ({
    validate: jest.fn(),
  })),
}));
jest.mock('../../src/settlement/claim-receiver', () => ({
  ClaimReceiver: jest.fn().mockImplementation(() => ({
    registerWithBTPServer: jest.fn(),
  })),
}));
jest.mock('../../src/settlement/provider/chain-provider-registry', () => ({
  ChainProviderRegistry: jest.fn().mockImplementation(() => ({
    register: jest.fn(),
  })),
}));
jest.mock('../../src/settlement/provider/evm-payment-channel-provider', () => ({
  EVMPaymentChannelProvider: jest.fn().mockImplementation(() => ({
    // no-op
  })),
}));
jest.mock('../../src/settlement/privacy/nip59-claim-wrapper', () => ({
  NIP59ClaimWrapper: jest.fn().mockImplementation(() => ({
    enabled: false,
  })),
}));
jest.mock('../../src/security/key-manager');
jest.mock('../../src/settlement/tigerbeetle-client');
jest.mock('../../src/settlement/in-memory-ledger-client');
jest.mock('../../src/utils/optional-require');
jest.mock('../../src/observability/metrics-registry');
jest.mock('../../package.json', () => ({ version: '3.2.0-test' }));
jest.mock('../../src/config/types', () => {
  const actual = jest.requireActual('../../src/config/types');
  return {
    ...actual,
    validateChainProviders: jest.fn(),
  };
});

// Mock fs and dns for transport auto-URL resolver branches
jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  return {
    ...actualFs,
    promises: {
      ...actualFs.promises,
      readFile: jest.fn(),
    },
  };
});

jest.mock('dns', () => {
  const actualDns = jest.requireActual('dns');
  return {
    ...actualDns,
    promises: {
      ...actualDns,
      lookup: jest.fn(),
    },
  };
});

// Story 35.4: mock the transport barrel
jest.mock('../../src/transport', () => {
  const directStartSpy = jest.fn().mockResolvedValue(undefined);
  const directStopSpy = jest.fn().mockResolvedValue(undefined);
  const directHealthSpy = jest.fn().mockResolvedValue(true);
  const directCreateAgentSpy = jest.fn().mockReturnValue(undefined);
  const socksStartSpy = jest.fn().mockResolvedValue(undefined);
  const socksStopSpy = jest.fn().mockResolvedValue(undefined);
  const socksHealthSpy = jest.fn().mockResolvedValue(true);
  const socksCreateAgentSpy = jest.fn().mockReturnValue({ __socks: true });

  class DirectTransportProvider {
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
    constructor(public options: any) {
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

import { promises as fsPromises } from 'fs';
import { promises as dnsPromises } from 'dns';

const transportModule = jest.requireMock('../../src/transport') as {
  __spies: {
    directStartSpy: jest.Mock;
    directStopSpy: jest.Mock;
    directHealthSpy: jest.Mock;
    directCreateAgentSpy: jest.Mock;
    socksStartSpy: jest.Mock;
    socksStopSpy: jest.Mock;
    socksHealthSpy: jest.Mock;
    socksCreateAgentSpy: jest.Mock;
    socksCtorSpy: jest.Mock;
    managedStartSpy: jest.Mock;
    managedStopSpy: jest.Mock;
    managedHealthSpy: jest.Mock;
    managedCtorSpy: jest.Mock;
  };
};
const transportSpies = transportModule.__spies;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

const createTestConfig = (overrides?: Partial<ConnectorConfig>): ConnectorConfig => {
  const testPeer = {
    id: 'peerA',
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

describe('ConnectorNode branch coverage — part 2', () => {
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

    // Reset auto-mocked / overridden class constructors so one test's overrides don't leak
    const PaymentChannelSDKMock = jest.requireMock('../../src/settlement/payment-channel-sdk')
      .PaymentChannelSDK as jest.Mock;
    PaymentChannelSDKMock.mockImplementation(() => ({
      getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
      removeAllListeners: jest.fn(),
    }));

    const InMemoryLedgerClientMock = jest.requireMock(
      '../../src/settlement/in-memory-ledger-client'
    ).InMemoryLedgerClient as jest.Mock;
    InMemoryLedgerClientMock.mockImplementation(() => ({
      initialize: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      snapshot: jest.fn().mockResolvedValue(undefined),
    }));

    const TigerBeetleClientMock = jest.requireMock('../../src/settlement/tigerbeetle-client')
      .TigerBeetleClient as jest.Mock;
    TigerBeetleClientMock.mockImplementation(() => ({
      initialize: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    }));

    mockLogger = createMockLogger();
    config = createTestConfig();

    (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(config);
    (ConfigLoader.validateConfig as jest.Mock).mockImplementation((c: ConnectorConfig) => c);

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
      setAgentFactory: jest.fn(),
      getPeerTransport: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<BTPClientManager>;

    mockBTPServer = {
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      setInboundClaimValidator: jest.fn(),
    } as unknown as jest.Mocked<BTPServer>;

    mockPacketHandler = {
      processPrepare: jest.fn(),
      setBTPServer: jest.fn(),
      setLocalDeliveryHandler: jest.fn(),
      setLocalDelivery: jest.fn(),
      handlePreparePacket: jest.fn(),
      setIlpMetrics: jest.fn(),
      setPerPacketClaimService: jest.fn(),
      setSettlement: jest.fn(),
      setPeerRelation: jest.fn(),
    } as unknown as jest.Mocked<PacketHandler>;

    mockHealthServer = {
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<HealthServer>;

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

    // Reset transport spies
    Object.values(transportSpies).forEach((s) => s.mockClear());
    transportSpies.directStartSpy.mockResolvedValue(undefined);
    transportSpies.directStopSpy.mockResolvedValue(undefined);
    transportSpies.directHealthSpy.mockResolvedValue(true);
    transportSpies.directCreateAgentSpy.mockReturnValue(undefined);
    transportSpies.socksStartSpy.mockResolvedValue(undefined);
    transportSpies.socksStopSpy.mockResolvedValue(undefined);
    transportSpies.socksHealthSpy.mockResolvedValue(true);
    transportSpies.socksCreateAgentSpy.mockReturnValue({ __socks: true });
    transportSpies.managedStartSpy.mockResolvedValue(undefined);
    transportSpies.managedStopSpy.mockResolvedValue(undefined);
    transportSpies.managedHealthSpy.mockResolvedValue(true);

    // Reset fs/dns mocks so previous test implementations don't leak
    (fsPromises.readFile as jest.Mock).mockReset();
    (dnsPromises.lookup as jest.Mock).mockReset();

    // Default requireOptional resolves common optional deps so tests don't need to repeat this
    (requireOptional as jest.Mock).mockImplementation(async (pkg: string) => {
      if (pkg === 'ethers') {
        return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
      }
      if (pkg === 'better-sqlite3') {
        return {
          default: jest.fn().mockImplementation(() => ({
            exec: jest.fn(),
            prepare: jest.fn().mockReturnValue({ get: jest.fn(), run: jest.fn(), all: jest.fn() }),
            close: jest.fn(),
          })),
        };
      }
      throw new Error(`${pkg} not available`);
    });

    // Reset env vars
    delete process.env.LOCAL_DELIVERY_ENABLED;
    delete process.env.LOCAL_DELIVERY_URL;
    delete process.env.LOCAL_DELIVERY_TIMEOUT;
    delete process.env.LOCAL_DELIVERY_AUTH_TOKEN;
    delete process.env.LOCAL_DELIVERY_PER_HOP_NOTIFICATION;
    delete process.env.ADMIN_API_ENABLED;
    delete process.env.ADMIN_API_PORT;
    delete process.env.ADMIN_API_HOST;
    delete process.env.ADMIN_API_KEY;
    delete process.env.BASE_L2_RPC_URL;
    delete process.env.SETTLEMENT_ENABLED;
    delete process.env.TOKEN_NETWORK_REGISTRY;
    delete process.env.M2M_TOKEN_ADDRESS;
    delete process.env.TREASURY_EVM_PRIVATE_KEY;
    delete process.env.TIGERBEETLE_CLUSTER_ID;
    delete process.env.TIGERBEETLE_REPLICAS;
    for (let i = 1; i <= 10; i++) {
      delete process.env[`PEER${i}_EVM_ADDRESS`];
    }
  });

  afterEach(async () => {
    // Stop connector if running to prevent background timers leaking into next test
    if (connectorNode) {
      try {
        await connectorNode.stop();
      } catch {
        /* ignore */
      }
    }
    // Restore env vars
    delete process.env.LOCAL_DELIVERY_ENABLED;
    delete process.env.LOCAL_DELIVERY_URL;
    delete process.env.LOCAL_DELIVERY_TIMEOUT;
    delete process.env.LOCAL_DELIVERY_AUTH_TOKEN;
    delete process.env.LOCAL_DELIVERY_PER_HOP_NOTIFICATION;
    delete process.env.ADMIN_API_ENABLED;
    delete process.env.ADMIN_API_PORT;
    delete process.env.ADMIN_API_HOST;
    delete process.env.ADMIN_API_KEY;
    delete process.env.BASE_L2_RPC_URL;
    delete process.env.SETTLEMENT_ENABLED;
    delete process.env.TOKEN_NETWORK_REGISTRY;
    delete process.env.M2M_TOKEN_ADDRESS;
    delete process.env.TREASURY_EVM_PRIVATE_KEY;
    delete process.env.TIGERBEETLE_CLUSTER_ID;
    delete process.env.TIGERBEETLE_REPLICAS;
    for (let i = 1; i <= 10; i++) {
      delete process.env[`PEER${i}_EVM_ADDRESS`];
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Getters
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Getters', () => {
    it('returns internal instances for routingTable and btpClientManager, null for optional SDKs', async () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      await connectorNode.start();

      expect(connectorNode.routingTable).toBe(mockRoutingTable);
      expect(connectorNode.btpClientManager).toBe(mockBTPClientManager);
      expect(connectorNode.paymentChannelSDK).toBeNull();
      expect(connectorNode.channelManager).toBeNull();
      expect(connectorNode.accountManager).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. Validation guards in registerPeer
  // ═══════════════════════════════════════════════════════════════════════════
  describe('registerPeer validation guards', () => {
    beforeEach(async () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      await connectorNode.start();
    });

    it('throws when id is missing', async () => {
      await expect(
        connectorNode.registerPeer({ id: undefined as any, url: 'ws://test', authToken: 'tok' })
      ).rejects.toThrow('Missing or invalid peer id');
    });

    it('throws when url is missing', async () => {
      await expect(
        connectorNode.registerPeer({ id: 'peer1', url: undefined as any, authToken: 'tok' })
      ).rejects.toThrow('Missing or invalid peer url');
    });

    it('throws when authToken is missing', async () => {
      await expect(
        connectorNode.registerPeer({ id: 'peer1', url: 'ws://test' } as any)
      ).rejects.toThrow('authToken must be a string (can be empty for no auth)');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. registerPeer with settlement
  // ═══════════════════════════════════════════════════════════════════════════
  describe('registerPeer with settlement', () => {
    beforeEach(async () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      await connectorNode.start();
    });

    it('applies settlement config when provided', async () => {
      const result = await connectorNode.registerPeer({
        id: 'peerB',
        url: 'ws://peerB:3000',
        authToken: 'secret-b',
        settlement: {
          preference: 'evm',
          evmAddress: '0x1234567890123456789012345678901234567890',
        } as any,
      });
      expect(result.settlement).toBeDefined();
      expect(result.settlement!.evmAddress).toBe('0x1234567890123456789012345678901234567890');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. registerPeer with existing settlement config
  // ═══════════════════════════════════════════════════════════════════════════
  describe('registerPeer update with existing settlement', () => {
    beforeEach(async () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      await connectorNode.start();

      // First registration (initial)
      mockBTPClientManager.getPeerIds.mockReturnValue([]);
      await connectorNode.registerPeer({
        id: 'peerB',
        url: 'ws://peerB:3000',
        authToken: 'secret-b',
        settlement: {
          preference: 'evm',
          evmAddress: '0x1111111111111111111111111111111111111111',
        } as any,
      });

      // Second call will be treated as update
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerB']);
    });

    it('returns settlement info on re-registration', async () => {
      const result = await connectorNode.registerPeer({
        id: 'peerB',
        url: 'ws://peerB:3000',
        authToken: 'secret-b',
        settlement: {
          preference: 'evm',
          evmAddress: '0x2222222222222222222222222222222222222222',
        } as any,
      });
      expect(result.settlement).toBeDefined();
      expect(result.settlement!.evmAddress).toBe('0x2222222222222222222222222222222222222222');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. openChannel missing peerAddress
  // ═══════════════════════════════════════════════════════════════════════════
  describe('openChannel missing peerAddress', () => {
    beforeEach(async () => {
      const cfg = createTestConfig({
        chainProviders: [
          {
            chainType: 'evm',
            chainId: 'evm:31337',
            rpcUrl: 'http://localhost:8545',
            registryAddress: '0x1234567890123456789012345678901234567890',
            keyId: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
            tokenAddress: '0x1234567890123456789012345678901234567890',
          },
        ],
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(cfg);
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      await connectorNode.start();
    });

    it('throws when peerAddress is missing and peer has no EVM address', async () => {
      // Register peer without settlement (no EVM address)
      mockBTPClientManager.getPeerIds.mockReturnValue([]);
      await connectorNode.registerPeer({
        id: 'peer1',
        url: 'ws://peer1:3000',
        authToken: 'tok',
      });
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);

      await expect(connectorNode.openChannel({ peerId: 'peer1' } as any)).rejects.toThrow(
        'Peer EVM address must be provided in params or peer registration'
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. _applySettlementConfig update with no existing config
  // ═══════════════════════════════════════════════════════════════════════════
  describe('_applySettlementConfig update with no existing config', () => {
    it('adds config directly when isUpdate=true but no existing config', () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      (connectorNode as any)._applySettlementConfig(
        'peerX',
        { preference: 'evm', evmAddress: '0x9999999999999999999999999999999999999999' },
        undefined,
        true
      );

      const peerConfig = (connectorNode as any)._settlementPeers.get('peerX');
      expect(peerConfig).toBeDefined();
      expect(peerConfig.evmAddress).toBe('0x9999999999999999999999999999999999999999');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'settlement_config_merged' }),
        expect.stringContaining('Merged settlement config')
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. _updateHealthStatus when not starting and btp not started
  // ═══════════════════════════════════════════════════════════════════════════
  describe('_updateHealthStatus when BTP server not started', () => {
    beforeEach(async () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      await connectorNode.start();
    });

    it('sets health status to starting when BTP server is stopped and status was not starting', () => {
      (connectorNode as any)._btpServerStarted = false;
      (connectorNode as any)._healthStatus = 'healthy';
      (connectorNode as any)._updateHealthStatus();

      expect((connectorNode as any)._healthStatus).toBe('starting');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. Transport health check catch
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Transport health check catch', () => {
    beforeEach(async () => {
      jest.useFakeTimers();
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      await connectorNode.start();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('sets _lastTransportHealthy to false when healthCheck rejects', async () => {
      transportSpies.directHealthSpy.mockRejectedValue(new Error('health check failed'));
      jest.advanceTimersByTime((connectorNode as any)._transportHealthIntervalMs);
      await Promise.resolve();
      await Promise.resolve();
      expect((connectorNode as any)._lastTransportHealthy).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. ClaimReceiver initialization catch
  // ═══════════════════════════════════════════════════════════════════════════
  describe('ClaimReceiver initialization catch', () => {
    beforeEach(async () => {
      (requireOptional as jest.Mock).mockImplementation(async (pkg: string, purpose?: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        if (pkg === 'better-sqlite3' && purpose === 'claim receiver persistence') {
          const err = new Error('MODULE_NOT_FOUND') as any;
          err.code = 'MODULE_NOT_FOUND';
          throw err;
        }
        if (pkg === 'better-sqlite3') {
          return {
            default: jest.fn().mockImplementation(() => ({
              exec: jest.fn(),
              prepare: jest
                .fn()
                .mockReturnValue({ get: jest.fn(), run: jest.fn(), all: jest.fn() }),
              close: jest.fn(),
            })),
          };
        }
        throw new Error(`${pkg} not available`);
      });

      const cfg = createTestConfig({
        chainProviders: [
          {
            chainType: 'evm',
            chainId: 'evm:31337',
            rpcUrl: 'http://localhost:8545',
            registryAddress: '0x1234567890123456789012345678901234567890',
            keyId: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
            tokenAddress: '0x1234567890123456789012345678901234567890',
          },
        ],
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(cfg);
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      await connectorNode.start();
    });

    it('logs error when ClaimReceiver fails to initialize', () => {
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'claim_receiver_init_failed' }),
        expect.stringContaining('Failed to initialize ClaimReceiver')
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. TigerBeetle absence
  // ═══════════════════════════════════════════════════════════════════════════
  describe('TigerBeetle absence', () => {
    beforeEach(async () => {
      delete process.env.TIGERBEETLE_REPLICAS;

      const cfg = createTestConfig({
        chainProviders: [
          {
            chainType: 'evm',
            chainId: 'evm:31337',
            rpcUrl: 'http://localhost:8545',
            registryAddress: '0x1234567890123456789012345678901234567890',
            keyId: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
            tokenAddress: '0x1234567890123456789012345678901234567890',
          },
        ],
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(cfg);
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      await connectorNode.start();
    });

    it('passes empty tigerBeetleReplicas when env var is absent', () => {
      const setSettlementCalls = (mockPacketHandler.setSettlement as jest.Mock).mock.calls;
      expect(setSettlementCalls.length).toBeGreaterThan(0);
      const settlementConfig = setSettlementCalls[0][1] as Record<string, unknown>;
      expect(settlementConfig.tigerBeetleReplicas).toEqual([]);
    });
  });
});
