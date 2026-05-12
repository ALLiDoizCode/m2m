/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */

/**
 * Branch coverage tests for ConnectorNode – Part 3
 * Covers remaining hard branches in connector-node.ts:
 *   1. Managed transport anonFactory branches (cachedFactory, prewarmError, require() fallbacks)
 *   2. SOCKS5 hostname file branches (empty, invalid, valid, throw with retry)
 *   3. Transport rollback catch (stop() throws during start() rollback)
 *   4. Admin API packetSender callback (delegates to node.sendPacket)
 *
 * @packageDocumentation
 */

import { ConnectorNode } from '../../src/core/connector-node';
import { ConnectorConfig } from '../../src/config/types';
import { RoutingTable } from '../../src/routing/routing-table';
import { BTPClientManager } from '../../src/btp/btp-client-manager';
import { BTPServer } from '../../src/btp/btp-server';
import { PacketHandler } from '../../src/core/packet-handler';
import { Logger } from '../../src/utils/logger';
import { RoutingTableEntry, PacketType } from '@toon-protocol/shared';
import { ConfigLoader } from '../../src/config/config-loader';
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
      lookup: jest.fn(),
    },
  };
});

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

const AdminServerMock = jest.requireMock('../../src/http/admin-server').AdminServer as jest.Mock;

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

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ConnectorNode coverage part 3', () => {
  let connectorNode: ConnectorNode;
  let mockLogger: jest.Mocked<Logger>;
  let mockRoutingTable: jest.Mocked<RoutingTable>;
  let mockBTPClientManager: jest.Mocked<BTPClientManager>;
  let mockBTPServer: jest.Mocked<BTPServer>;
  let mockPacketHandler: jest.Mocked<PacketHandler>;
  let mockHealthServer: jest.Mocked<HealthServer>;
  let lastAdminServerArgs: any;
  const testConfigPath = '/test/config.yaml';

  beforeEach(() => {
    jest.clearAllMocks();

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

    (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(createTestConfig());
    (ConfigLoader.validateConfig as jest.Mock).mockImplementation((c: ConnectorConfig) => c);

    mockRoutingTable = {
      lookup: jest.fn(),
      getAllRoutes: jest.fn().mockReturnValue([]),
      addRoute: jest.fn(),
      removeRoute: jest.fn(),
    } as unknown as jest.Mocked<RoutingTable>;

    mockBTPClientManager = {
      addPeer: jest.fn().mockResolvedValue(undefined),
      removePeer: jest.fn().mockResolvedValue(undefined),
      sendToPeer: jest.fn(),
      getPeerStatus: jest.fn().mockReturnValue(new Map()),
      getPeerIds: jest.fn().mockReturnValue([]),
      isConnected: jest.fn().mockReturnValue(true),
      getConnectedPeerCount: jest.fn().mockReturnValue(0),
      getTotalPeerCount: jest.fn().mockReturnValue(0),
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

    // Reset fs/dns mocks
    (fsPromises.readFile as jest.Mock).mockReset();
    (dnsPromises.lookup as jest.Mock).mockReset();

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

    // Default requireOptional resolves common optional deps
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

    // Capture AdminServer constructor args and provide a mock instance
    lastAdminServerArgs = undefined;
    AdminServerMock.mockImplementation((args: any) => {
      lastAdminServerArgs = args;
      return {
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
      };
    });
  });

  afterEach(async () => {
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
  // 1. Managed transport anonFactory branches
  // ═══════════════════════════════════════════════════════════════════════════
  describe('managed transport anonFactory branches', () => {
    const getAnonFactory = () => {
      const managedOpts = transportSpies.managedCtorSpy.mock.calls[0][0];
      return managedOpts.anonFactory;
    };

    it('uses cachedFactory when pre-warm succeeds', async () => {
      const factoryFn = jest.fn().mockReturnValue({ mockAnon: true });
      const createDefaultAnonFactoryMock = jest.requireMock('../../src/transport')
        .createDefaultAnonFactory as jest.Mock;
      createDefaultAnonFactoryMock.mockResolvedValue(factoryFn);

      const managedConfig = createTestConfig({
        transport: {
          type: 'socks5',
          socksProxy: 'socks5h://127.0.0.1:9050',
          externalUrl: 'wss://abc123.anon/btp',
          managed: true,
          managedOptions: {
            hiddenServiceDir: '/tmp/hs',
            hiddenServicePort: 443,
          },
        },
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(managedConfig);

      const node = new ConnectorNode(testConfigPath, mockLogger);
      (node as any)._createTransportProvider(managedConfig.transport);

      // Wait for pre-warm microtask to resolve and populate cachedFactory
      await Promise.resolve();
      await Promise.resolve();

      const anonFactory = getAnonFactory();
      const result = anonFactory({} as any);

      expect(factoryFn).toHaveBeenCalled();
      expect(result).toEqual({ mockAnon: true });
    });

    it('re-throws MODULE_NOT_FOUND prewarmError', async () => {
      const err = Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' });
      const createDefaultAnonFactoryMock = jest.requireMock('../../src/transport')
        .createDefaultAnonFactory as jest.Mock;
      createDefaultAnonFactoryMock.mockRejectedValue(err);

      const managedConfig = createTestConfig({
        transport: {
          type: 'socks5',
          socksProxy: 'socks5h://127.0.0.1:9050',
          externalUrl: 'wss://abc123.anon/btp',
          managed: true,
          managedOptions: {
            hiddenServiceDir: '/tmp/hs',
            hiddenServicePort: 443,
          },
        },
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(managedConfig);

      const node = new ConnectorNode(testConfigPath, mockLogger);
      (node as any)._createTransportProvider(managedConfig.transport);

      await Promise.resolve();
      await Promise.resolve();

      const anonFactory = getAnonFactory();
      expect(() => anonFactory({} as any)).toThrow(
        expect.objectContaining({ code: 'MODULE_NOT_FOUND' })
      );
    });

    it('wraps generic prewarmError', async () => {
      const err = new Error('generic prewarm');
      const createDefaultAnonFactoryMock = jest.requireMock('../../src/transport')
        .createDefaultAnonFactory as jest.Mock;
      createDefaultAnonFactoryMock.mockRejectedValue(err);

      const managedConfig = createTestConfig({
        transport: {
          type: 'socks5',
          socksProxy: 'socks5h://127.0.0.1:9050',
          externalUrl: 'wss://abc123.anon/btp',
          managed: true,
          managedOptions: {
            hiddenServiceDir: '/tmp/hs',
            hiddenServicePort: 443,
          },
        },
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(managedConfig);

      const node = new ConnectorNode(testConfigPath, mockLogger);
      (node as any)._createTransportProvider(managedConfig.transport);

      await Promise.resolve();
      await Promise.resolve();

      const anonFactory = getAnonFactory();
      expect(() => anonFactory({} as any)).toThrow(
        /Failed to load optional dependency "@anyone-protocol\/anyone-client"/
      );
    });

    describe('require() branches when pre-warm is still in flight', () => {
      beforeEach(() => {
        jest.resetModules();
        const createDefaultAnonFactoryMock = jest.requireMock('../../src/transport')
          .createDefaultAnonFactory as jest.Mock;
        createDefaultAnonFactoryMock.mockReturnValue(new Promise(() => {}));
      });

      it('require() success with Anon export', async () => {
        jest.doMock(
          '@anyone-protocol/anyone-client',
          () => ({ Anon: jest.fn().mockReturnValue({ anonInstance: true }) }),
          { virtual: true }
        );

        const managedConfig = createTestConfig({
          transport: {
            type: 'socks5',
            socksProxy: 'socks5h://127.0.0.1:9050',
            externalUrl: 'wss://abc123.anon/btp',
            managed: true,
            managedOptions: {
              hiddenServiceDir: '/tmp/hs',
              hiddenServicePort: 443,
            },
          },
        });
        (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(managedConfig);

        const node = new ConnectorNode(testConfigPath, mockLogger);
        (node as any)._createTransportProvider(managedConfig.transport);

        const anonFactory = getAnonFactory();
        const result = anonFactory({} as any);
        expect(result).toEqual({ anonInstance: true });
      });

      it('require() success but AnonCtor is not a function', async () => {
        jest.doMock('@anyone-protocol/anyone-client', () => ({ default: 'not-a-function' }), {
          virtual: true,
        });

        const managedConfig = createTestConfig({
          transport: {
            type: 'socks5',
            socksProxy: 'socks5h://127.0.0.1:9050',
            externalUrl: 'wss://abc123.anon/btp',
            managed: true,
            managedOptions: {
              hiddenServiceDir: '/tmp/hs',
              hiddenServicePort: 443,
            },
          },
        });
        (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(managedConfig);

        const node = new ConnectorNode(testConfigPath, mockLogger);
        (node as any)._createTransportProvider(managedConfig.transport);

        const anonFactory = getAnonFactory();
        expect(() => anonFactory({} as any)).toThrow('did not export an `Anon` constructor');
      });

      it('require() throws MODULE_NOT_FOUND', async () => {
        jest.doMock(
          '@anyone-protocol/anyone-client',
          () => {
            throw Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' });
          },
          { virtual: true }
        );

        const managedConfig = createTestConfig({
          transport: {
            type: 'socks5',
            socksProxy: 'socks5h://127.0.0.1:9050',
            externalUrl: 'wss://abc123.anon/btp',
            managed: true,
            managedOptions: {
              hiddenServiceDir: '/tmp/hs',
              hiddenServicePort: 443,
            },
          },
        });
        (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(managedConfig);

        const node = new ConnectorNode(testConfigPath, mockLogger);
        (node as any)._createTransportProvider(managedConfig.transport);

        const anonFactory = getAnonFactory();
        expect(() => anonFactory({} as any)).toThrow(
          expect.objectContaining({ code: 'MODULE_NOT_FOUND' })
        );
      });

      it('require() throws ERR_REQUIRE_ESM', async () => {
        jest.doMock(
          '@anyone-protocol/anyone-client',
          () => {
            throw Object.assign(new Error('ESM only'), { code: 'ERR_REQUIRE_ESM' });
          },
          { virtual: true }
        );

        const managedConfig = createTestConfig({
          transport: {
            type: 'socks5',
            socksProxy: 'socks5h://127.0.0.1:9050',
            externalUrl: 'wss://abc123.anon/btp',
            managed: true,
            managedOptions: {
              hiddenServiceDir: '/tmp/hs',
              hiddenServicePort: 443,
            },
          },
        });
        (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(managedConfig);

        const node = new ConnectorNode(testConfigPath, mockLogger);
        (node as any)._createTransportProvider(managedConfig.transport);

        const anonFactory = getAnonFactory();
        expect(() => anonFactory({} as any)).toThrow(/ESM-only package/);
      });

      it('require() throws generic error', async () => {
        jest.doMock(
          '@anyone-protocol/anyone-client',
          () => {
            throw new Error('boom');
          },
          { virtual: true }
        );

        const managedConfig = createTestConfig({
          transport: {
            type: 'socks5',
            socksProxy: 'socks5h://127.0.0.1:9050',
            externalUrl: 'wss://abc123.anon/btp',
            managed: true,
            managedOptions: {
              hiddenServiceDir: '/tmp/hs',
              hiddenServicePort: 443,
            },
          },
        });
        (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(managedConfig);

        const node = new ConnectorNode(testConfigPath, mockLogger);
        (node as any)._createTransportProvider(managedConfig.transport);

        const anonFactory = getAnonFactory();
        expect(() => anonFactory({} as any)).toThrow(
          /Failed to load optional dependency "@anyone-protocol\/anyone-client"/
        );
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. SOCKS5 hostname file branches
  // ═══════════════════════════════════════════════════════════════════════════
  describe('SOCKS5 hostname file branches', () => {
    it('retries on empty and invalid hostname, then succeeds on valid', async () => {
      const readFileMock = fsPromises.readFile as jest.Mock;
      readFileMock
        .mockResolvedValueOnce('') // empty
        .mockResolvedValueOnce('invalid\n') // invalid format
        .mockResolvedValueOnce('abcdefghijklmnop.anon\n'); // valid

      const managedConfig = createTestConfig({
        transport: {
          type: 'socks5',
          socksProxy: 'socks5h://127.0.0.1:9050',
          externalUrl: 'auto',
          managed: true,
          managedOptions: {
            hiddenServiceDir: '/tmp/hs',
            hiddenServicePort: 443,
            startupTimeoutMs: 5000,
          },
        },
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(managedConfig);

      const node = new ConnectorNode(testConfigPath, mockLogger);
      const provider = (node as any)._createTransportProvider(managedConfig.transport);
      const resolveFn = provider.options.resolveExternalUrlOnStart;

      const result = await resolveFn();
      expect(result).toBe('wss://abcdefghijklmnop.anon/btp');
    });

    it('retries when readFile throws until deadline exceeded', async () => {
      const readFileMock = fsPromises.readFile as jest.Mock;
      readFileMock.mockRejectedValue(new Error('ENOENT'));

      const managedConfig = createTestConfig({
        transport: {
          type: 'socks5',
          socksProxy: 'socks5h://127.0.0.1:9050',
          externalUrl: 'auto',
          managed: true,
          managedOptions: {
            hiddenServiceDir: '/tmp/hs',
            hiddenServicePort: 443,
            startupTimeoutMs: 500,
          },
        },
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(managedConfig);

      const node = new ConnectorNode(testConfigPath, mockLogger);
      const provider = (node as any)._createTransportProvider(managedConfig.transport);
      const resolveFn = provider.options.resolveExternalUrlOnStart;

      await expect(resolveFn()).rejects.toThrow(/did not become readable within 500ms/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Transport rollback catch
  // ═══════════════════════════════════════════════════════════════════════════
  describe('transport rollback catch', () => {
    it('logs transport_rollback_stop_failed when provider.stop() throws during rollback', async () => {
      transportSpies.directStopSpy.mockRejectedValue(new Error('stop failed'));

      const config = createTestConfig({
        transport: { type: 'direct' },
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(config);

      mockBTPServer.start.mockRejectedValue(new Error('BTP server failed'));

      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      await expect(connectorNode.start()).rejects.toThrow('BTP server failed');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'transport_rollback_stop_failed' }),
        expect.any(String)
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. Admin API packetSender callback
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Admin API packetSender callback', () => {
    it('delegates packetSender to node.sendPacket', async () => {
      const config = createTestConfig({
        adminApi: { enabled: true },
        transport: { type: 'direct' },
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(config);

      mockPacketHandler.handlePreparePacket.mockResolvedValue({
        type: PacketType.FULFILL,
        fulfillment: Buffer.alloc(32),
        data: Buffer.alloc(0),
      } as any);

      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      const sendPacketSpy = jest.spyOn(connectorNode, 'sendPacket').mockResolvedValue({
        type: PacketType.FULFILL,
        fulfillment: Buffer.alloc(32),
        data: Buffer.alloc(0),
      } as any);

      await connectorNode.start();

      expect(AdminServerMock).toHaveBeenCalled();
      expect(lastAdminServerArgs).toBeDefined();
      expect(lastAdminServerArgs.packetSender).toBeInstanceOf(Function);

      const params = {
        destination: 'test.destination',
        amount: 100n,
        expiresAt: new Date(Date.now() + 60000),
        data: Buffer.from('test-data'),
      };
      await lastAdminServerArgs.packetSender(params);

      expect(sendPacketSpy).toHaveBeenCalledWith(expect.objectContaining(params));

      sendPacketSpy.mockRestore();
    });
  });
});
