/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */

/**
 * Branch coverage tests for ConnectorNode
 * Targets uncovered branches in connector-node.ts to push toward 100% branch coverage.
 *
 * @packageDocumentation
 */

import { ConnectorNode } from '../../src/core/connector-node';
import { ConnectorConfig, SettlementConfig } from '../../src/config/types';
import { AdminSettlementConfig } from '../../src/settlement/types';
import { RoutingTable } from '../../src/routing/routing-table';
import { BTPClientManager } from '../../src/btp/btp-client-manager';
import { BTPServer } from '../../src/btp/btp-server';
import { PacketHandler } from '../../src/core/packet-handler';
import { Logger } from '../../src/utils/logger';
import { RoutingTableEntry, PacketType, ILPErrorCode } from '@toon-protocol/shared';
import { ConfigLoader } from '../../src/config/config-loader';
import { HealthServer } from '../../src/http/health-server';
import { requireOptional } from '../../src/utils/optional-require';

// ─────────────────────────────────────────────────────────────────────────────
// Mock all dependencies (same pattern as connector-node.test.ts)
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
  ChainProviderRegistry: jest.fn().mockImplementation(() => {
    const providers: unknown[] = [];
    return {
      register: jest.fn((provider: unknown) => {
        providers.push(provider);
      }),
      getAllProviders: jest.fn(() => providers),
    };
  }),
}));
jest.mock('../../src/settlement/provider/evm-payment-channel-provider', () => ({
  EVMPaymentChannelProvider: jest.fn().mockImplementation((_sdk: unknown, chainId: string) => ({
    chainType: 'evm',
    chainId,
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

describe('ConnectorNode branch coverage', () => {
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
      setIlpHttpHandler: jest.fn(),
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
      getPeerRelation: jest.fn().mockReturnValue(undefined),
      setHttpEgress: jest.fn(),
      setPeerProtocol: jest.fn(),
      getPeerProtocol: jest.fn().mockReturnValue(undefined),
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
      if (pkg === 'libsql') {
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
  // Constructor local-delivery env-var branches
  // ═══════════════════════════════════════════════════════════════════════════
  describe('constructor localDelivery env-var branches', () => {
    it('enables local delivery via env var LOCAL_DELIVERY_ENABLED=true', () => {
      process.env.LOCAL_DELIVERY_ENABLED = 'true';
      const minimal = createTestConfig({ localDelivery: undefined });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(minimal);

      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      expect(mockPacketHandler.setLocalDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true })
      );
    });

    it('uses env var fallbacks for handlerUrl, timeout, authToken, perHopNotification', () => {
      process.env.LOCAL_DELIVERY_ENABLED = 'true';
      process.env.LOCAL_DELIVERY_URL = 'http://bls-env:8080';
      process.env.LOCAL_DELIVERY_TIMEOUT = '15000';
      process.env.LOCAL_DELIVERY_AUTH_TOKEN = 'env-token';
      process.env.LOCAL_DELIVERY_PER_HOP_NOTIFICATION = 'true';

      const minimal = createTestConfig({ localDelivery: undefined });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(minimal);

      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      expect(mockPacketHandler.setLocalDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          handlerUrl: 'http://bls-env:8080',
          timeout: 15000,
          authToken: 'env-token',
          perHopNotification: true,
        })
      );
    });

    it('uses config values over env vars when both present', () => {
      process.env.LOCAL_DELIVERY_ENABLED = 'true';
      process.env.LOCAL_DELIVERY_URL = 'http://env-fallback';
      process.env.LOCAL_DELIVERY_TIMEOUT = '99999';
      process.env.LOCAL_DELIVERY_AUTH_TOKEN = 'env-fallback';
      process.env.LOCAL_DELIVERY_PER_HOP_NOTIFICATION = 'true';

      const cfg = createTestConfig({
        localDelivery: {
          enabled: true,
          handlerUrl: 'http://config-wins:9000',
          timeout: 5000,
          authToken: 'config-token',
          perHopNotification: false,
        },
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(cfg);

      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      expect(mockPacketHandler.setLocalDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          handlerUrl: 'http://config-wins:9000',
          timeout: 5000,
          authToken: 'config-token',
          perHopNotification: false,
        })
      );
    });

    it('defaults timeout to 30000 when neither config nor env set', () => {
      process.env.LOCAL_DELIVERY_ENABLED = 'true';
      const minimal = createTestConfig({ localDelivery: { enabled: true } });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(minimal);

      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      expect(mockPacketHandler.setLocalDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 30000 })
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // start() — admin API env-var fallback branches
  // ═══════════════════════════════════════════════════════════════════════════
  describe('start() admin API env-var fallback branches', () => {
    it('enables admin API via ADMIN_API_ENABLED env var and uses env fallbacks', async () => {
      process.env.ADMIN_API_ENABLED = 'true';
      process.env.ADMIN_API_PORT = '9090';
      process.env.ADMIN_API_HOST = '127.0.0.1';
      process.env.ADMIN_API_KEY = 'env-api-key';

      const cfg = createTestConfig({ adminApi: undefined });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(cfg);
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      await connectorNode.start();

      const infoCalls = (mockLogger.info as jest.Mock).mock.calls;
      const adminStarted = infoCalls.find(
        (call) => (call[0] as Record<string, unknown>)?.event === 'admin_server_started'
      );
      expect(adminStarted).toBeDefined();
      expect((adminStarted![0] as Record<string, unknown>).port).toBe(9090);
      expect((adminStarted![0] as Record<string, unknown>).host).toBe('127.0.0.1');
      expect((adminStarted![0] as Record<string, unknown>).apiKeyConfigured).toBe(true);
    });

    it('logs debug when admin API is disabled', async () => {
      const cfg = createTestConfig({ adminApi: { enabled: false } });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(cfg);
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      await connectorNode.start();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'admin_api_disabled' }),
        expect.any(String)
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // start() — payment channels disabled else branch
  // ═══════════════════════════════════════════════════════════════════════════
  describe('start() payment channels disabled else branch', () => {
    it('logs info when payment channel config is incomplete', async () => {
      const cfg = createTestConfig({
        chainProviders: [
          {
            chainType: 'evm',
            chainId: 'evm:31337',
            rpcUrl: 'http://localhost:8545',
            // missing registryAddress, tokenAddress, keyId
          } as any,
        ],
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(cfg);
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      await connectorNode.start();

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'payment_channels_disabled' }),
        expect.any(String)
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // start() — legacy settlement env var detection branch
  // ═══════════════════════════════════════════════════════════════════════════
  describe('start() legacy settlement env var detection', () => {
    it('logs warning when legacy settlement env vars are detected', async () => {
      process.env.BASE_L2_RPC_URL = 'http://old';
      process.env.SETTLEMENT_ENABLED = 'true';

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
      (requireOptional as jest.Mock).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return {
            ethers: {
              JsonRpcProvider: jest.fn().mockReturnValue({}),
            },
          };
        }
        throw new Error(`${pkg} not available`);
      });

      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      await connectorNode.start();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'legacy_env_vars_detected',
          vars: expect.arrayContaining(['BASE_L2_RPC_URL', 'SETTLEMENT_ENABLED']),
        }),
        expect.any(String)
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // start() — token symbol resolution branches
  // ═══════════════════════════════════════════════════════════════════════════
  describe('start() token symbol resolution branches', () => {
    it('uses resolved symbol when getTokenSymbol returns a non-empty string', async () => {
      const mockPaymentChannelSDK = {
        getTokenSymbol: jest.fn().mockResolvedValue('TST'),
        removeAllListeners: jest.fn(),
      };
      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        throw new Error(`${pkg} not available`);
      });
      jest
        .mocked(jest.requireMock('../../src/settlement/payment-channel-sdk').PaymentChannelSDK)
        .mockImplementation(() => mockPaymentChannelSDK);

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

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'token_symbol_resolved',
          symbol: 'TST',
        }),
        expect.any(String)
      );
      expect(connectorNode.defaultSettlementTokenId).toBe('TST');
    });

    it('falls back to M2M when getTokenSymbol returns empty string', async () => {
      const mockPaymentChannelSDK = {
        getTokenSymbol: jest.fn().mockResolvedValue(''),
        removeAllListeners: jest.fn(),
      };
      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        throw new Error(`${pkg} not available`);
      });
      jest
        .mocked(jest.requireMock('../../src/settlement/payment-channel-sdk').PaymentChannelSDK)
        .mockImplementation(() => mockPaymentChannelSDK);

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

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'token_symbol_empty' }),
        expect.any(String)
      );
      expect(connectorNode.defaultSettlementTokenId).toBe('M2M');
    });

    it('falls back to M2M when getTokenSymbol throws', async () => {
      const mockPaymentChannelSDK = {
        getTokenSymbol: jest.fn().mockRejectedValue(new Error('RPC down')),
        removeAllListeners: jest.fn(),
      };
      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        throw new Error(`${pkg} not available`);
      });
      jest
        .mocked(jest.requireMock('../../src/settlement/payment-channel-sdk').PaymentChannelSDK)
        .mockImplementation(() => mockPaymentChannelSDK);

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

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'token_symbol_resolution_failed' }),
        expect.any(String)
      );
      expect(connectorNode.defaultSettlementTokenId).toBe('M2M');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // start() — multi-chain SDK initialization branches
  // ═══════════════════════════════════════════════════════════════════════════
  describe('start() multi-chain SDK initialization', () => {
    it('initializes additional chain SDKs when base and arbitrum are enabled', async () => {
      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        throw new Error(`${pkg} not available`);
      });

      const PaymentChannelSDKMock = jest.requireMock('../../src/settlement/payment-channel-sdk')
        .PaymentChannelSDK as jest.Mock;
      PaymentChannelSDKMock.mockImplementation(() => ({
        getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
        removeAllListeners: jest.fn(),
      }));

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
        blockchain: {
          base: {
            enabled: true,
            chainId: 8453,
            rpcUrl: 'http://base-rpc',
            registryAddress: '0xBase',
          },
          arbitrum: {
            enabled: true,
            chainId: 42161,
            rpcUrl: 'http://arb-rpc',
            registryAddress: '0xArb',
            privateKey: '0xdeadbeef-arb',
          },
        },
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(cfg);
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      await connectorNode.start();

      // Primary (base chainId=8453) + arbitrum (42161). Base is skipped because its chainId
      // matches the primary chainId extracted from blockchain.base.chainId.
      expect(PaymentChannelSDKMock).toHaveBeenCalledTimes(2);
    });

    it('skips duplicate chain IDs in multi-chain init', async () => {
      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        throw new Error(`${pkg} not available`);
      });

      const PaymentChannelSDKMock = jest.requireMock('../../src/settlement/payment-channel-sdk')
        .PaymentChannelSDK as jest.Mock;
      PaymentChannelSDKMock.mockImplementation(() => ({
        getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
        removeAllListeners: jest.fn(),
      }));

      // Use same chainId for base as primary to trigger skip
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
        blockchain: {
          base: { enabled: true, chainId: 31337, rpcUrl: 'http://base-rpc' },
        },
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(cfg);
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      await connectorNode.start();

      // Primary SDK + skipped duplicate = only 1 call
      expect(PaymentChannelSDKMock).toHaveBeenCalledTimes(1);
    });

    it('creates per-chain KeyManager when private key differs', async () => {
      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        throw new Error(`${pkg} not available`);
      });

      const PaymentChannelSDKMock = jest.requireMock('../../src/settlement/payment-channel-sdk')
        .PaymentChannelSDK as jest.Mock;
      PaymentChannelSDKMock.mockImplementation(() => ({
        getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
        removeAllListeners: jest.fn(),
      }));

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
        blockchain: {
          base: { enabled: true, chainId: 8453, rpcUrl: 'http://base-rpc' },
          arbitrum: {
            enabled: true,
            chainId: 42161,
            rpcUrl: 'http://arb-rpc',
            registryAddress: '0xArb',
            privateKey: '0xdeadbeef-arb',
          },
        },
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(cfg);
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      await connectorNode.start();

      // Arbitrum SDK should have been created with a distinct private key,
      // proving the per-chain KeyManager branch was hit.
      expect(connectorNode.getPaymentChannelSDKForChain(42161)).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // start() — peer EVM address env-var fallback loop
  // ═══════════════════════════════════════════════════════════════════════════
  describe('start() peer EVM address env-var fallback loop', () => {
    it('loads peer EVM addresses from PEER{N}_EVM_ADDRESS env vars', async () => {
      process.env.PEER1_EVM_ADDRESS = '0xPeer1Addr';
      process.env.PEER3_EVM_ADDRESS = '0xPeer3Addr';

      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        throw new Error(`${pkg} not available`);
      });
      jest
        .mocked(jest.requireMock('../../src/settlement/payment-channel-sdk').PaymentChannelSDK)
        .mockImplementation(() => ({
          getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
          removeAllListeners: jest.fn(),
        }));

      const cfg = createTestConfig({
        peers: [
          { id: 'peer1', url: 'ws://p1:3000', authToken: 't1' },
          { id: 'peer2', url: 'ws://p2:3000', authToken: 't2' },
          { id: 'peer3', url: 'ws://p3:3000', authToken: 't3' },
        ],
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

      // peer1 from env, peer2 not found, peer3 from env
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ peerId: 'peer1', address: '0xPeer1Addr' }),
        expect.any(String)
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ peerId: 'peer3', address: '0xPeer3Addr' }),
        expect.any(String)
      );
    });

    it('prefers config evmAddress over env var fallback', async () => {
      process.env.PEER1_EVM_ADDRESS = '0xEnvAddr';

      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        throw new Error(`${pkg} not available`);
      });
      jest
        .mocked(jest.requireMock('../../src/settlement/payment-channel-sdk').PaymentChannelSDK)
        .mockImplementation(() => ({
          getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
          removeAllListeners: jest.fn(),
        }));

      const cfg = createTestConfig({
        peers: [{ id: 'peer1', url: 'ws://p1:3000', authToken: 't1', evmAddress: '0xConfigAddr' }],
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

      // Should log config address, not env address
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ peerId: 'peer1', address: '0xConfigAddr' }),
        expect.any(String)
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // start() — TigerBeetle DNS resolution branches
  // ═══════════════════════════════════════════════════════════════════════════
  describe('start() TigerBeetle DNS resolution branches', () => {
    it('resolves hostname to IP for TigerBeetle replica', async () => {
      (dnsPromises.lookup as jest.Mock).mockResolvedValue({ address: '192.168.1.100', family: 4 });

      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        throw new Error(`${pkg} not available`);
      });
      jest
        .mocked(jest.requireMock('../../src/settlement/payment-channel-sdk').PaymentChannelSDK)
        .mockImplementation(() => ({
          getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
          removeAllListeners: jest.fn(),
        }));

      const TigerBeetleClientMock = jest.requireMock('../../src/settlement/tigerbeetle-client')
        .TigerBeetleClient as jest.Mock;
      TigerBeetleClientMock.mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
      }));

      process.env.TIGERBEETLE_CLUSTER_ID = '0';
      process.env.TIGERBEETLE_REPLICAS = 'tigerbeetle.local:3000';

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

      expect(dnsPromises.lookup).toHaveBeenCalledWith('tigerbeetle.local');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ hostname: 'tigerbeetle.local', ip: '192.168.1.100' }),
        expect.any(String)
      );
    });

    it('uses address as-is when already an IP for TigerBeetle', async () => {
      const TigerBeetleClientMock = jest.requireMock('../../src/settlement/tigerbeetle-client')
        .TigerBeetleClient as jest.Mock;
      TigerBeetleClientMock.mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
      }));

      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        throw new Error(`${pkg} not available`);
      });
      jest
        .mocked(jest.requireMock('../../src/settlement/payment-channel-sdk').PaymentChannelSDK)
        .mockImplementation(() => ({
          getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
          removeAllListeners: jest.fn(),
        }));

      process.env.TIGERBEETLE_CLUSTER_ID = '0';
      process.env.TIGERBEETLE_REPLICAS = '10.0.0.1:3000,10.0.0.2:3000';

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

      // DNS lookup should NOT be called for IP addresses
      expect(dnsPromises.lookup).not.toHaveBeenCalled();
      expect(TigerBeetleClientMock).toHaveBeenCalledWith(
        expect.objectContaining({
          replicaAddresses: expect.arrayContaining(['10.0.0.1:3000', '10.0.0.2:3000']),
        }),
        expect.anything()
      );
    });

    it('falls back to original address when DNS resolution fails', async () => {
      (dnsPromises.lookup as jest.Mock).mockRejectedValue(new Error('DNS failure'));

      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        throw new Error(`${pkg} not available`);
      });
      jest
        .mocked(jest.requireMock('../../src/settlement/payment-channel-sdk').PaymentChannelSDK)
        .mockImplementation(() => ({
          getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
          removeAllListeners: jest.fn(),
        }));

      const TigerBeetleClientMock = jest.requireMock('../../src/settlement/tigerbeetle-client')
        .TigerBeetleClient as jest.Mock;
      TigerBeetleClientMock.mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
      }));

      process.env.TIGERBEETLE_CLUSTER_ID = '0';
      process.env.TIGERBEETLE_REPLICAS = 'badhost.local:3000';

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

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ hostname: 'badhost.local' }),
        expect.any(String)
      );
    });

    it('falls back to in-memory ledger when TigerBeetle initialization fails', async () => {
      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        throw new Error(`${pkg} not available`);
      });
      jest
        .mocked(jest.requireMock('../../src/settlement/payment-channel-sdk').PaymentChannelSDK)
        .mockImplementation(() => ({
          getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
          removeAllListeners: jest.fn(),
        }));

      const TigerBeetleClientMock = jest.requireMock('../../src/settlement/tigerbeetle-client')
        .TigerBeetleClient as jest.Mock;
      TigerBeetleClientMock.mockImplementation(() => ({
        initialize: jest.fn().mockRejectedValue(new Error('TB connect failed')),
        close: jest.fn().mockResolvedValue(undefined),
      }));

      const InMemoryLedgerClientMock = jest.requireMock(
        '../../src/settlement/in-memory-ledger-client'
      ).InMemoryLedgerClient as jest.Mock;
      InMemoryLedgerClientMock.mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
      }));

      process.env.TIGERBEETLE_CLUSTER_ID = '0';
      process.env.TIGERBEETLE_REPLICAS = 'localhost:3000';

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

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'tigerbeetle_init_failed' }),
        expect.any(String)
      );
    });

    it('uses in-memory ledger when TigerBeetle env vars are not set', async () => {
      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        throw new Error(`${pkg} not available`);
      });
      jest
        .mocked(jest.requireMock('../../src/settlement/payment-channel-sdk').PaymentChannelSDK)
        .mockImplementation(() => ({
          getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
          removeAllListeners: jest.fn(),
        }));

      const InMemoryLedgerClientMock = jest.requireMock(
        '../../src/settlement/in-memory-ledger-client'
      ).InMemoryLedgerClient as jest.Mock;
      InMemoryLedgerClientMock.mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
      }));

      // Ensure TB env vars are NOT set
      delete process.env.TIGERBEETLE_CLUSTER_ID;
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

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'tigerbeetle_not_configured' }),
        expect.any(String)
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // start() — NIP-59 setup branches
  // ═══════════════════════════════════════════════════════════════════════════
  describe('start() NIP-59 setup branches', () => {
    it('enables NIP-59 and logs when nip59Enabled=true', async () => {
      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        throw new Error(`${pkg} not available`);
      });
      jest
        .mocked(jest.requireMock('../../src/settlement/payment-channel-sdk').PaymentChannelSDK)
        .mockImplementation(() => ({
          getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
          removeAllListeners: jest.fn(),
        }));

      const cfg = createTestConfig({
        nip59: { enabled: true },
        peers: [
          {
            id: 'peerA',
            url: 'ws://p1:3000',
            authToken: 't1',
            nip59PublicKey: 'abcdef1234567890',
          },
        ],
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

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'nip59_enabled', peerCount: 1 }),
        expect.any(String)
      );
    });

    it('does not log NIP-59 info when disabled', async () => {
      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        throw new Error(`${pkg} not available`);
      });
      jest
        .mocked(jest.requireMock('../../src/settlement/payment-channel-sdk').PaymentChannelSDK)
        .mockImplementation(() => ({
          getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
          removeAllListeners: jest.fn(),
        }));

      const cfg = createTestConfig({
        nip59: { enabled: false },
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

      const nip59Logs = (mockLogger.info as jest.Mock).mock.calls.filter(
        (call) => (call[0] as Record<string, unknown>)?.event === 'nip59_enabled'
      );
      expect(nip59Logs.length).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // start() — peer channel creation branches (connected/disconnected)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('start() peer channel creation branches', () => {
    it('skips disconnected peers during channel creation', async () => {
      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        throw new Error(`${pkg} not available`);
      });
      jest
        .mocked(jest.requireMock('../../src/settlement/payment-channel-sdk').PaymentChannelSDK)
        .mockImplementation(() => ({
          getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
          removeAllListeners: jest.fn(),
        }));

      const mockChannelManager = {
        ensureChannelExists: jest.fn().mockResolvedValue('0xchannel'),
        stop: jest.fn(),
      };
      jest
        .mocked(jest.requireMock('../../src/settlement/channel-manager').ChannelManager)
        .mockImplementation(() => mockChannelManager);

      mockBTPClientManager.getPeerStatus.mockReturnValue(
        new Map([
          ['peerA', true],
          ['peerB', false],
        ])
      );
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA', 'peerB']);

      const cfg = createTestConfig({
        peers: [
          { id: 'peerA', url: 'ws://p1:3000', authToken: 't1' },
          { id: 'peerB', url: 'ws://p2:3000', authToken: 't2' },
        ],
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

      // Only peerA is connected, so ensureChannelExists should be called once
      expect(mockChannelManager.ensureChannelExists).toHaveBeenCalledTimes(1);
      expect(mockChannelManager.ensureChannelExists).toHaveBeenCalledWith(
        'peerA',
        expect.any(String),
        undefined
      );
    });

    it('passes peerConfig.chain when creating channels if peer has chain config', async () => {
      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        throw new Error(`${pkg} not available`);
      });
      jest
        .mocked(jest.requireMock('../../src/settlement/payment-channel-sdk').PaymentChannelSDK)
        .mockImplementation(() => ({
          getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
          removeAllListeners: jest.fn(),
        }));

      const mockChannelManager = {
        ensureChannelExists: jest.fn().mockResolvedValue('0xchannel'),
        stop: jest.fn(),
      };
      jest
        .mocked(jest.requireMock('../../src/settlement/channel-manager').ChannelManager)
        .mockImplementation(() => mockChannelManager);

      const cfg = createTestConfig({
        peers: [{ id: 'peerA', url: 'ws://p1:3000', authToken: 't1', chain: 'evm:base:8453' }],
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

      expect(mockChannelManager.ensureChannelExists).toHaveBeenCalledWith(
        'peerA',
        expect.any(String),
        expect.objectContaining({ chain: 'evm:base:8453' })
      );
    });

    it('logs warning when channel creation fails for a peer', async () => {
      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        throw new Error(`${pkg} not available`);
      });
      jest
        .mocked(jest.requireMock('../../src/settlement/payment-channel-sdk').PaymentChannelSDK)
        .mockImplementation(() => ({
          getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
          removeAllListeners: jest.fn(),
        }));

      const mockChannelManager = {
        ensureChannelExists: jest.fn().mockRejectedValue(new Error('gas too low')),
        stop: jest.fn(),
      };
      jest
        .mocked(jest.requireMock('../../src/settlement/channel-manager').ChannelManager)
        .mockImplementation(() => mockChannelManager);

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

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'payment_channel_creation_failed',
          peerId: 'peerA',
        }),
        expect.any(String)
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // stop() — chain SDKs cleanup, paymentChannelSDK cleanup, inMemoryLedger
  // ═══════════════════════════════════════════════════════════════════════════
  describe('stop() cleanup branches for settlement components', () => {
    it('cleans up chain SDKs and primary paymentChannelSDK on stop', async () => {
      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        throw new Error(`${pkg} not available`);
      });
      jest
        .mocked(jest.requireMock('../../src/settlement/payment-channel-sdk').PaymentChannelSDK)
        .mockImplementation(() => ({
          getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
          removeAllListeners: jest.fn(),
        }));

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
        blockchain: {
          base: { enabled: true, chainId: 8453, rpcUrl: 'http://base-rpc' },
        },
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(cfg);
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      await connectorNode.start();
      await connectorNode.stop();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'chain_sdk_stopped' }),
        expect.any(String)
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'payment_channel_sdk_stopped' }),
        expect.any(String)
      );
    });

    it('closes inMemoryLedgerClient on stop when present', async () => {
      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        throw new Error(`${pkg} not available`);
      });
      jest
        .mocked(jest.requireMock('../../src/settlement/payment-channel-sdk').PaymentChannelSDK)
        .mockImplementation(() => ({
          getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
          removeAllListeners: jest.fn(),
        }));

      const mockInMemoryLedger = {
        initialize: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
      };
      jest
        .mocked(
          jest.requireMock('../../src/settlement/in-memory-ledger-client').InMemoryLedgerClient
        )
        .mockImplementation(() => mockInMemoryLedger);

      // Ensure TB is not configured so in-memory path is taken
      delete process.env.TIGERBEETLE_CLUSTER_ID;
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
      await connectorNode.stop();

      expect(mockInMemoryLedger.close).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'in_memory_ledger_closed' }),
        expect.any(String)
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // _createInMemoryAccountManager branches
  // ═══════════════════════════════════════════════════════════════════════════
  describe('_createInMemoryAccountManager branches', () => {
    it('falls back to fresh client when snapshot restore fails', async () => {
      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        if (pkg === 'libsql') {
          return { default: jest.fn() };
        }
        throw new Error(`${pkg} not available`);
      });
      jest
        .mocked(jest.requireMock('../../src/settlement/payment-channel-sdk').PaymentChannelSDK)
        .mockImplementation(() => ({
          getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
          removeAllListeners: jest.fn(),
        }));

      const InMemoryLedgerClientMock = jest.requireMock(
        '../../src/settlement/in-memory-ledger-client'
      ).InMemoryLedgerClient as jest.Mock;

      let initCallCount = 0;
      InMemoryLedgerClientMock.mockImplementation(() => ({
        initialize: jest.fn().mockImplementation(async () => {
          initCallCount++;
          if (initCallCount === 1) {
            throw new Error('corrupt snapshot');
          }
        }),
        close: jest.fn().mockResolvedValue(undefined),
      }));

      delete process.env.TIGERBEETLE_CLUSTER_ID;
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

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'in_memory_ledger_snapshot_restore_failed' }),
        expect.any(String)
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'in_memory_ledger_fresh_start' }),
        expect.any(String)
      );
    });

    it('throws when even fresh in-memory ledger initialization fails', async () => {
      jest.mocked(requireOptional).mockImplementation(async (pkg: string) => {
        if (pkg === 'ethers') {
          return { ethers: { JsonRpcProvider: jest.fn().mockReturnValue({}) } };
        }
        if (pkg === 'libsql') {
          return { default: jest.fn() };
        }
        throw new Error(`${pkg} not available`);
      });
      jest
        .mocked(jest.requireMock('../../src/settlement/payment-channel-sdk').PaymentChannelSDK)
        .mockImplementation(() => ({
          getTokenSymbol: jest.fn().mockResolvedValue('M2M'),
          removeAllListeners: jest.fn(),
        }));

      const InMemoryLedgerClientMock = jest.requireMock(
        '../../src/settlement/in-memory-ledger-client'
      ).InMemoryLedgerClient as jest.Mock;
      InMemoryLedgerClientMock.mockImplementation(() => ({
        initialize: jest.fn().mockRejectedValue(new Error('disk full')),
        close: jest.fn().mockResolvedValue(undefined),
      }));

      delete process.env.TIGERBEETLE_CLUSTER_ID;
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

      // The outer settlement try/catch catches the error and continues
      await connectorNode.start();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'in_memory_ledger_fresh_init_failed' }),
        expect.any(String)
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // registerPeer branches — settlement validation & route prefix missing
  // ═══════════════════════════════════════════════════════════════════════════
  describe('registerPeer branches', () => {
    beforeEach(async () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      jest.clearAllMocks();
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', true]]));
      mockBTPClientManager.isConnected.mockReturnValue(true);
      await connectorNode.start();
      jest.clearAllMocks();
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', true]]));
      mockBTPClientManager.isConnected.mockReturnValue(true);
    });

    it('throws when settlement config is invalid', async () => {
      const { validateSettlementConfig } = jest.requireMock('../../src/http/admin-api');
      validateSettlementConfig.mockReturnValue('Invalid settlement config');

      await expect(
        connectorNode.registerPeer({
          id: 'peerB',
          url: 'ws://peer-b:3000',
          authToken: 'token',
          settlement: { preference: 'invalid' } as any,
        })
      ).rejects.toThrow('Invalid settlement config');
    });

    it('throws when route prefix is missing', async () => {
      await expect(
        connectorNode.registerPeer({
          id: 'peerB',
          url: 'ws://peer-b:3000',
          authToken: 'token',
          routes: [{ prefix: '' }],
        })
      ).rejects.toThrow('Invalid route: missing prefix');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // addRoute — unknown nextHop warning branch
  // ═══════════════════════════════════════════════════════════════════════════
  describe('addRoute warning branch', () => {
    it('logs warning when nextHop peer is unknown', () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      mockBTPClientManager.getPeerIds.mockReturnValue([]); // no peers known

      connectorNode.addRoute({ prefix: 'g.test', nextHop: 'unknown-peer', priority: 0 });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'route_nextHop_unknown',
          prefix: 'g.test',
          nextHop: 'unknown-peer',
        }),
        expect.any(String)
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // _applySettlementConfig branches
  // ═══════════════════════════════════════════════════════════════════════════
  describe('_applySettlementConfig branches', () => {
    it('uses empty ilpAddress when no routes provided', async () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      jest.clearAllMocks();
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', true]]));
      await connectorNode.start();
      jest.clearAllMocks();
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);

      // Access private method directly
      const apply = (connectorNode as any)._applySettlementConfig.bind(connectorNode);

      apply('peerA', { preference: 'evm' } as AdminSettlementConfig, undefined, false);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'settlement_config_added' }),
        expect.any(String)
      );
    });

    it('uses EVM settlement token when tokenAddress is absent but evmAddress is present', async () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      jest.clearAllMocks();
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', true]]));
      await connectorNode.start();
      jest.clearAllMocks();

      const apply = (connectorNode as any)._applySettlementConfig.bind(connectorNode);
      apply(
        'peerA',
        { preference: 'evm', evmAddress: '0x123' } as AdminSettlementConfig,
        [{ prefix: 'g.peerA' }],
        false
      );

      // The settlement config should have been stored; verify via listPeers
      const peers = connectorNode.listPeers();
      const peerA = peers.find((p) => p.id === 'peerA');
      expect(peerA).toBeDefined();
    });

    it('merges settlement config on update when existing config exists', async () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      jest.clearAllMocks();
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', true]]));
      await connectorNode.start();
      jest.clearAllMocks();

      const apply = (connectorNode as any)._applySettlementConfig.bind(connectorNode);
      apply(
        'peerA',
        { preference: 'evm', evmAddress: '0xOld' } as AdminSettlementConfig,
        [{ prefix: 'g.peerA' }],
        false
      );
      jest.clearAllMocks();

      apply(
        'peerA',
        { preference: 'any', tokenAddress: '0xToken' } as AdminSettlementConfig,
        [{ prefix: 'g.peerA' }],
        true
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'settlement_config_merged' }),
        expect.any(String)
      );

      const peers = connectorNode.listPeers();
      const peerA = peers.find((p) => p.id === 'peerA');
      expect(peerA?.settlement?.preference).toBe('any');
      expect(peerA?.settlement?.tokenAddress).toBe('0xToken');
      expect(peerA?.settlement?.evmAddress).toBe('0xOld');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getPaymentChannelSDKForChain — missing chain returns null
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getPaymentChannelSDKForChain', () => {
    it('returns null when chain SDK is not initialized', () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      expect(connectorNode.getPaymentChannelSDKForChain(99999)).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // sendPacket — catch branch with non-Error thrown value
  // ═══════════════════════════════════════════════════════════════════════════
  describe('sendPacket catch branch', () => {
    it('returns T00 reject when handlePreparePacket throws a non-Error value', async () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      await connectorNode.start();
      jest.clearAllMocks();

      mockPacketHandler.handlePreparePacket.mockImplementation(() => {
        throw 'string-throw'; // non-Error
      });

      const result = await connectorNode.sendPacket({
        destination: 'g.peerA.alice',
        amount: 1000n,
        expiresAt: new Date(Date.now() + 30000),
      });

      expect(result.type).toBe(PacketType.REJECT);
      expect((result as any).code).toBe(ILPErrorCode.T00_INTERNAL_ERROR);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'send_packet_error',
          destination: 'g.peerA.alice',
          error: 'string-throw',
        }),
        expect.any(String)
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // start() — AccountManager wiring into PacketHandler branch
  // ═══════════════════════════════════════════════════════════════════════════
  describe('start() AccountManager wiring branch', () => {
    it('wires settlement into PacketHandler when accountManager is created', async () => {
      // Use the default requireOptional (which already handles ethers & libsql)

      delete process.env.TIGERBEETLE_CLUSTER_ID;
      delete process.env.TIGERBEETLE_REPLICAS;

      const cfg = createTestConfig({
        settlement: {
          connectorFeePercentage: 0.5,
          enableSettlement: true,
          tigerBeetleClusterId: 0,
          tigerBeetleReplicas: [],
        } as SettlementConfig,
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

      // Defensive: verify accountManager was created before asserting on setSettlement
      expect((connectorNode as any)._accountManager).toBeDefined();
      expect(mockPacketHandler.setSettlement).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          connectorFeePercentage: 0.5,
          enableSettlement: true,
        }),
        'M2M'
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // start() — peer connection failure branch (Promise.allSettled rejected)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('start() peer connection failure branch', () => {
    it('logs warning when some peer connections fail', async () => {
      mockBTPClientManager.addPeer.mockImplementation(async (peer: { id: string }) => {
        if (peer.id === 'peerB') {
          throw new Error('connection refused');
        }
      });

      const cfg = createTestConfig({
        peers: [
          { id: 'peerA', url: 'ws://p1:3000', authToken: 't1' },
          { id: 'peerB', url: 'ws://p2:3000', authToken: 't2' },
        ],
      });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(cfg);
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      await connectorNode.start();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'peer_connection_failures',
          failedCount: 1,
          totalPeers: 2,
        }),
        expect.any(String)
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // removePeer — settlement config removal log branch
  // ═══════════════════════════════════════════════════════════════════════════
  describe('removePeer settlement config removal log branch', () => {
    it('logs settlement_config_removed when settlement config existed', async () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      jest.clearAllMocks();
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', true]]));
      await connectorNode.start();
      jest.clearAllMocks();
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockBTPClientManager.isConnected.mockReturnValue(true);

      // Manually inject settlement config
      (connectorNode as any)._settlementPeers.set('peerA', {
        peerId: 'peerA',
        settlementPreference: 'sender',
      });

      await connectorNode.removePeer('peerA');

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'settlement_config_removed' }),
        expect.any(String)
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getHealthStatus — version from package.json
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getHealthStatus version', () => {
    it('includes version from mocked package.json', () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      const health = connectorNode.getHealthStatus();
      expect(health.version).toBe('3.2.0-test');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // _updateHealthStatus — existing status same as new (no log)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('_updateHealthStatus idempotent branch', () => {
    it('does not log health_status_changed when status is unchanged', async () => {
      const cfg = createTestConfig({ peers: [] });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(cfg);
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      await connectorNode.start();
      jest.clearAllMocks();

      // Manually call _updateHealthStatus; with no peers it should be healthy
      // but already healthy, so no status change log
      (connectorNode as any)._updateHealthStatus();

      const changeLogs = (mockLogger.info as jest.Mock).mock.calls.filter(
        (call) => (call[0] as Record<string, unknown>)?.event === 'health_status_changed'
      );
      expect(changeLogs.length).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // openChannel — peerAddress fallback from settlementPeers
  // ═══════════════════════════════════════════════════════════════════════════
  describe('openChannel peerAddress fallback', () => {
    it('uses evmAddress from settlementPeers when peerAddress param is absent', async () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      jest.clearAllMocks();
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', true]]));
      await connectorNode.start();
      jest.clearAllMocks();
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);

      const mockChannelManager = {
        getChannelForPeer: jest.fn().mockReturnValue(null),
        ensureChannelExists: jest.fn().mockResolvedValue('0xchan'),
        getChannelById: jest.fn().mockReturnValue({
          channelId: '0xchan',
          status: 'open',
          chain: 'evm:base:8453',
        }),
      };
      (connectorNode as any)._channelManager = mockChannelManager;
      (connectorNode as any)._settlementPeers.set('peerA', {
        evmAddress: '0xSettlementPeerAddr',
      });

      await connectorNode.openChannel({
        peerId: 'peerA',
        chain: 'evm:base:8453',
        peerAddress: '',
      });

      expect(mockChannelManager.ensureChannelExists).toHaveBeenCalledWith(
        'peerA',
        'AGENT',
        expect.objectContaining({ peerAddress: '0xSettlementPeerAddr' })
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // listPeers — peer with settlement config
  // ═══════════════════════════════════════════════════════════════════════════
  describe('listPeers settlement info', () => {
    it('includes settlement info when _settlementPeers has entry', () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      (connectorNode as any)._settlementPeers.set('peerA', {
        settlementPreference: 'sender',
        evmAddress: '0xabc',
        tokenAddress: '0xtok',
        chainId: 'evm:1',
      });
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', true]]));
      mockRoutingTable.getAllRoutes.mockReturnValue([]);

      const peers = connectorNode.listPeers();
      expect(peers[0]?.settlement).toEqual({
        preference: 'sender',
        evmAddress: '0xabc',
        tokenAddress: '0xtok',
        chainId: 'evm:1',
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // removePeer — removeRoutes=false branch already covered; here test removal
  // when routes exist but removeRoutes is true (default)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('removePeer route removal', () => {
    it('removes no routes when none match the peer', async () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      jest.clearAllMocks();
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      await connectorNode.start();
      jest.clearAllMocks();
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockRoutingTable.getAllRoutes.mockReturnValue([
        { prefix: 'g.other', nextHop: 'otherPeer', priority: 0 },
      ]);

      const result = await connectorNode.removePeer('peerA', true);

      expect(mockRoutingTable.removeRoute).not.toHaveBeenCalled();
      expect(result.removedRoutes).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // registerPeer — isUpdate=true (re-registration) does not call addPeer
  // ═══════════════════════════════════════════════════════════════════════════
  describe('registerPeer re-registration route-only update', () => {
    it('adds routes on re-registration without calling addPeer', async () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      jest.clearAllMocks();
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peerA', true]]));
      await connectorNode.start();
      jest.clearAllMocks();
      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockBTPClientManager.isConnected.mockReturnValue(true);
      mockRoutingTable.getAllRoutes.mockReturnValue([
        { prefix: 'g.peerA', nextHop: 'peerA', priority: 0 },
      ]);

      const result = await connectorNode.registerPeer({
        id: 'peerA',
        url: 'ws://new-url:3000',
        authToken: 'new-token',
        routes: [{ prefix: 'g.peerA.extra', priority: 5 }],
      });

      expect(mockBTPClientManager.addPeer).not.toHaveBeenCalled();
      expect(mockRoutingTable.addRoute).toHaveBeenCalledWith('g.peerA.extra', 'peerA', 5);
      expect(result.id).toBe('peerA');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Admin API start with apiKey undefined branch
  // ═══════════════════════════════════════════════════════════════════════════
  describe('admin API apiKeyConfigured false branch', () => {
    it('reports apiKeyConfigured=false when admin API has no key', async () => {
      const cfg = createTestConfig({ adminApi: { enabled: true, port: 8081 } });
      (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(cfg);
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);

      await connectorNode.start();

      const infoCalls = (mockLogger.info as jest.Mock).mock.calls;
      const adminStarted = infoCalls.find(
        (call) => (call[0] as Record<string, unknown>)?.event === 'admin_server_started'
      );
      expect(adminStarted).toBeDefined();
      expect((adminStarted![0] as Record<string, unknown>).apiKeyConfigured).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // _updateHealthStatus — BTP server not started branch
  // ═══════════════════════════════════════════════════════════════════════════
  describe('_updateHealthStatus BTP not started branch', () => {
    it('does not re-log starting when already starting', () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      // _btpServerStarted is false, _healthStatus is already 'starting'
      (connectorNode as any)._updateHealthStatus();

      const changeLogs = (mockLogger.info as jest.Mock).mock.calls.filter(
        (call) => (call[0] as Record<string, unknown>)?.event === 'health_status_changed'
      );
      expect(changeLogs.length).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getHealthStatus — _transportProviderReady false branch (transport absent)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getHealthStatus transport absent branch', () => {
    it('does not include transport block before start', () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      const health = connectorNode.getHealthStatus();
      expect(health.transport).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // stop() — error during BTP server stop() or health server stop()
  // Covered by main stop catch, but ensure the catch branch is hit
  // ═══════════════════════════════════════════════════════════════════════════
  describe('stop() error catch branch', () => {
    it('logs and re-throws error from stop()', async () => {
      connectorNode = new ConnectorNode(testConfigPath, mockLogger);
      await connectorNode.start();
      jest.clearAllMocks();

      mockBTPClientManager.getPeerIds.mockReturnValue(['peerA']);
      mockBTPClientManager.removePeer.mockResolvedValue(undefined);
      mockBTPServer.stop.mockRejectedValue(new Error('btp fatal'));

      await expect(connectorNode.stop()).rejects.toThrow('btp fatal');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'connector_stop_failed' }),
        expect.any(String)
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // constructor — non-ConfigurationError catch branch re-throws
  // ═══════════════════════════════════════════════════════════════════════════
  describe('constructor non-ConfigurationError catch', () => {
    it('re-throws non-ConfigurationError errors without logging', () => {
      (ConfigLoader.loadConfig as jest.Mock).mockImplementation(() => {
        throw new TypeError('Unexpected type');
      });

      expect(() => new ConnectorNode(testConfigPath, mockLogger)).toThrow('Unexpected type');
      // Should NOT log config_load_failed for non-ConfigurationError
      const errorLogs = (mockLogger.error as jest.Mock).mock.calls.filter(
        (call) => (call[0] as Record<string, unknown>)?.event === 'config_load_failed'
      );
      expect(errorLogs.length).toBe(0);
    });
  });
});
