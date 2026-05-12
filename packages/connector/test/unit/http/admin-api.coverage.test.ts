/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */

/**
 * Branch Coverage Tests for Admin API (admin-api.ts)
 *
 * Fills branch-coverage gaps in the 2,287-line admin-api.ts file.
 * Targets: error/catch blocks, missing-dependency 503s, validation edge
 * cases, helper-function branches, and ternary/nullish paths that are
 * exercised by existing integration tests but not by unit tests.
 *
 * Run:
 *   npx jest packages/connector/test/unit/http/admin-api.coverage.test.ts
 */

import request from 'supertest';
import express, { Express } from 'express';
import {
  createAdminRouter,
  AdminAPIConfig,
  validateDepositRequest,
  validateSettlementConfig,
  validateOpenChannelRequest,
} from '../../../src/http/admin-api';
import type { AdminSettlementConfig } from '../../../src/settlement/types';
import type { RoutingTable } from '../../../src/routing/routing-table';
import type { BTPClientManager } from '../../../src/btp/btp-client-manager';
import type { ChannelManager, ChannelMetadata } from '../../../src/settlement/channel-manager';
import type { PaymentChannelSDK } from '../../../src/settlement/payment-channel-sdk';
import type { AccountManager } from '../../../src/settlement/account-manager';
import type { SettlementMonitor } from '../../../src/settlement/settlement-monitor';
import type { ClaimReceiver } from '../../../src/settlement/claim-receiver';
import type { SentClaimsQueries } from '../../../src/settlement/sent-claims-queries';
import { IlpMetricsRegistry } from '../../../src/observability/metrics-registry';
import type { PeerConfig as SettlementPeerConfig } from '../../../src/settlement/types';
import type { Logger } from 'pino';

// ───────────────────────────────────────────────────────────────────────────
// Shared mock factories
// ───────────────────────────────────────────────────────────────────────────

function createMockLogger(): Logger {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
    fatal: jest.fn(),
    trace: jest.fn(),
    level: 'info',
  } as unknown as Logger;
}

function createMockRoutingTable(): jest.Mocked<RoutingTable> {
  return {
    addRoute: jest.fn(),
    removeRoute: jest.fn(),
    getAllRoutes: jest.fn().mockReturnValue([]),
    lookup: jest.fn(),
    removeRoutesForPeer: jest.fn(),
  } as unknown as jest.Mocked<RoutingTable>;
}

function createMockBTPClientManager(): jest.Mocked<BTPClientManager> {
  return {
    addPeer: jest.fn().mockResolvedValue(undefined),
    removePeer: jest.fn().mockResolvedValue(undefined),
    getPeerIds: jest.fn().mockReturnValue([]),
    getPeerStatus: jest.fn().mockReturnValue(new Map()),
    isConnected: jest.fn().mockReturnValue(false),
    getConnectedPeers: jest.fn().mockReturnValue([]),
    getClientForPeer: jest.fn(),
    // Per-peer transport selection: additive mock for new accessor used
    // by GET /admin/peers + the re-reg POST response payload.
    getPeerTransport: jest.fn().mockReturnValue(undefined),
  } as unknown as jest.Mocked<BTPClientManager>;
}

function createMockChannelManager(): jest.Mocked<ChannelManager> {
  return {
    ensureChannelExists: jest.fn().mockResolvedValue('0xchannel123'),
    getAllChannels: jest.fn().mockReturnValue([]),
    getChannelById: jest.fn().mockReturnValue(null),
    getChannelForPeer: jest.fn().mockReturnValue(null),
    markChannelActivity: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    on: jest.fn(),
    emit: jest.fn(),
  } as unknown as jest.Mocked<ChannelManager>;
}

function createMockPaymentChannelSDK(): jest.Mocked<PaymentChannelSDK> {
  return {
    openChannel: jest.fn(),
    getChannelState: jest.fn(),
    getMyChannels: jest.fn(),
    signBalanceProof: jest.fn().mockResolvedValue('0x' + 'ab'.repeat(65)),
    closeChannel: jest.fn().mockResolvedValue(undefined),
    settleChannel: jest.fn(),
    deposit: jest.fn().mockResolvedValue(undefined),
    removeAllListeners: jest.fn(),
  } as unknown as jest.Mocked<PaymentChannelSDK>;
}

function createMockAccountManager(): jest.Mocked<AccountManager> {
  return {
    getAccountBalance: jest.fn().mockResolvedValue({
      debitBalance: 0n,
      creditBalance: 0n,
      netBalance: 0n,
    }),
    getPeerVolumeTotals: jest.fn().mockResolvedValue(new Map()),
  } as unknown as jest.Mocked<AccountManager>;
}

function createMockSettlementMonitor(): jest.Mocked<SettlementMonitor> {
  return {
    getAllSettlementStates: jest.fn().mockReturnValue(new Map()),
  } as unknown as jest.Mocked<SettlementMonitor>;
}

function createMockClaimReceiver(): jest.Mocked<ClaimReceiver> {
  return {
    getLatestVerifiedClaim: jest.fn().mockResolvedValue(null),
    getCumulativeInboundByAsset: jest.fn().mockResolvedValue(new Map()),
    getRecentClaims: jest.fn().mockResolvedValue([]),
    getAssetsForPeer: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<ClaimReceiver>;
}

// createMockSentClaimsQueries omitted — not needed for current branch targets

// ───────────────────────────────────────────────────────────────────────────
// Suite
// ───────────────────────────────────────────────────────────────────────────

describe('Admin API branch coverage', () => {
  let app: Express;
  let mockRoutingTable: jest.Mocked<RoutingTable>;
  let mockBTPClientManager: jest.Mocked<BTPClientManager>;
  let mockLogger: Logger;
  let settlementPeers: Map<string, SettlementPeerConfig>;

  const buildConfig = (overrides?: Partial<AdminAPIConfig>): AdminAPIConfig => ({
    routingTable: mockRoutingTable,
    btpClientManager: mockBTPClientManager,
    logger: mockLogger,
    nodeId: 'test-node',
    settlementPeers,
    ...overrides,
  });

  const createApp = async (overrides?: Partial<AdminAPIConfig>): Promise<Express> => {
    const router = await createAdminRouter(buildConfig(overrides));
    const e = express();
    e.use('/admin', router);
    return e;
  };

  beforeEach(() => {
    mockRoutingTable = createMockRoutingTable();
    mockBTPClientManager = createMockBTPClientManager();
    mockLogger = createMockLogger();
    settlementPeers = new Map();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // Router-setup branches (auth, allowlist, logging)
  // =========================================================================

  describe('Router setup', () => {
    it('should allow access when no apiKey is configured', async () => {
      const appNoAuth = await createApp({ apiKey: undefined });
      const res = await request(appNoAuth).get('/admin/routes');
      expect(res.status).toBe(200);
    });

    it('should reject when X-Api-Key header is an array (duplicate headers)', async () => {
      const appAuth = await createApp({ apiKey: 'secret' });
      // Sending duplicate headers makes req.headers['x-api-key'] a string[]
      const res = await request(appAuth)
        .get('/admin/routes')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .set('X-Api-Key' as any, ['secret', 'other']);
      expect(res.status).toBe(401);
    });

    it('should not install IP allowlist middleware when allowedIPs is undefined', async () => {
      const appNoAllowlist = await createApp({ allowedIPs: undefined });
      const res = await request(appNoAllowlist).get('/admin/routes');
      expect(res.status).toBe(200);
    });

    it('should skip invalid CIDR entries in allowedIPs instead of crashing', async () => {
      const appBadCidr = await createApp({
        allowedIPs: ['invalid/mask', '127.0.0.1'],
        trustProxy: false,
      });
      const res = await request(appBadCidr).get('/admin/routes');
      expect(res.status).toBe(200);
    });

    it('should normalize IPv4-mapped IPv6 addresses in X-Forwarded-For', async () => {
      const appProxy = await createApp({
        allowedIPs: ['127.0.0.1'],
        trustProxy: true,
      });
      const res = await request(appProxy)
        .get('/admin/routes')
        .set('X-Forwarded-For', '::ffff:127.0.0.1');
      expect(res.status).toBe(200);
    });

    it('should fall through to socket IP when X-Forwarded-For is empty commas', async () => {
      const appProxy = await createApp({
        allowedIPs: ['127.0.0.1'],
        trustProxy: true,
      });
      const res = await request(appProxy).get('/admin/routes').set('X-Forwarded-For', ', ,');
      // Falls back to 127.0.0.1 (supertest default)
      expect(res.status).toBe(200);
    });
  });

  // =========================================================================
  // GET /admin/peers
  // =========================================================================

  describe('GET /admin/peers', () => {
    it('should return 500 when getPeerIds throws', async () => {
      mockBTPClientManager.getPeerIds.mockImplementation(() => {
        throw new Error('boom');
      });
      app = await createApp();
      const res = await request(app).get('/admin/peers');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Internal server error');
    });

    it('should omit settlement field when settlementPeers map is absent', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peer1', true]]));
      app = await createApp({ settlementPeers: undefined });
      const res = await request(app).get('/admin/peers');
      expect(res.status).toBe(200);
      expect(res.body.peers[0].settlement).toBeUndefined();
    });

    it('should omit settlement field when peer has no settlement config', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['peer1', true]]));
      app = await createApp({ settlementPeers: new Map() });
      const res = await request(app).get('/admin/peers');
      expect(res.status).toBe(200);
      expect(res.body.peers[0].settlement).toBeUndefined();
    });
  });

  // =========================================================================
  // POST /admin/peers
  // =========================================================================

  describe('POST /admin/peers', () => {
    it('should return 400 when id is missing', async () => {
      app = await createApp();
      const res = await request(app).post('/admin/peers').send({ url: 'ws://x', authToken: 't' });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('id');
    });

    it('should return 400 when id is not a string', async () => {
      app = await createApp();
      const res = await request(app)
        .post('/admin/peers')
        .send({ id: 123, url: 'ws://x', authToken: 't' });
      expect(res.status).toBe(400);
    });

    it('should return 400 when url is missing', async () => {
      app = await createApp();
      const res = await request(app).post('/admin/peers').send({ id: 'x', authToken: 't' });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('url');
    });

    it('should return 400 when authToken is undefined', async () => {
      app = await createApp();
      const res = await request(app).post('/admin/peers').send({ id: 'x', url: 'ws://x' });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('authToken');
    });

    it('should return 400 when URL does not start with ws:// or wss://', async () => {
      app = await createApp();
      const res = await request(app)
        .post('/admin/peers')
        .send({ id: 'x', url: 'http://x', authToken: 't' });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('ws://');
    });

    it('should return 400 when route prefix is missing', async () => {
      app = await createApp();
      const res = await request(app)
        .post('/admin/peers')
        .send({ id: 'x', url: 'ws://x', authToken: 't', routes: [{ priority: 1 }] });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('prefix');
    });

    it('should return 400 when route prefix is invalid ILP address', async () => {
      app = await createApp();
      const res = await request(app)
        .post('/admin/peers')
        .send({ id: 'x', url: 'ws://x', authToken: 't', routes: [{ prefix: '.invalid' }] });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid ILP address');
    });

    it('should return 400 when settlement config is invalid', async () => {
      app = await createApp();
      const res = await request(app)
        .post('/admin/peers')
        .send({
          id: 'x',
          url: 'ws://x',
          authToken: 't',
          settlement: { preference: 'any' },
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('evmAddress');
    });

    it('should return 500 when addPeer throws', async () => {
      mockBTPClientManager.addPeer.mockRejectedValue(new Error('connect failed'));
      app = await createApp();
      const res = await request(app)
        .post('/admin/peers')
        .send({ id: 'x', url: 'ws://x', authToken: 't' });
      expect(res.status).toBe(500);
    });

    it('should skip settlement storage when settlementPeers is absent', async () => {
      app = await createApp({ settlementPeers: undefined });
      const res = await request(app)
        .post('/admin/peers')
        .send({
          id: 'x',
          url: 'ws://x',
          authToken: 't',
          settlement: {
            preference: 'evm',
            evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
          },
        });
      expect(res.status).toBe(201);
    });

    it('should use EVM fallback settlement token when tokenAddress absent', async () => {
      app = await createApp();
      const res = await request(app)
        .post('/admin/peers')
        .send({
          id: 'x',
          url: 'ws://x',
          authToken: 't',
          settlement: {
            preference: 'evm',
            evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
          },
        });
      expect(res.status).toBe(201);
      const cfg = settlementPeers.get('x');
      expect(cfg?.settlementTokens).toContain('EVM');
    });

    it('should return connected message when new peer connects quickly', async () => {
      mockBTPClientManager.isConnected.mockReturnValue(true);
      app = await createApp();
      const res = await request(app)
        .post('/admin/peers')
        .send({ id: 'x', url: 'ws://x', authToken: 't' });
      expect(res.status).toBe(201);
      expect(res.body.message).toContain('connected');
    });

    it('should return pending message when new peer does not connect', async () => {
      mockBTPClientManager.isConnected.mockReturnValue(false);
      app = await createApp();
      const res = await request(app)
        .post('/admin/peers')
        .send({ id: 'x', url: 'ws://x', authToken: 't' });
      expect(res.status).toBe(201);
      expect(res.body.message).toContain('pending');
    });

    it('should merge settlement config even when existing config is missing (edge case)', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['x']);
      app = await createApp();
      // First registration without settlement
      await request(app).post('/admin/peers').send({ id: 'x', url: 'ws://x', authToken: 't' });
      // Re-register with settlement — existing config missing in settlementPeers because
      // settlementPeers was present but no entry existed
      const res = await request(app)
        .post('/admin/peers')
        .send({
          id: 'x',
          url: 'ws://x',
          authToken: 't',
          settlement: {
            preference: 'evm',
            evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
          },
        });
      expect(res.status).toBe(200);
      expect(settlementPeers.get('x')).toBeDefined();
    });
  });

  // =========================================================================
  // DELETE /admin/peers/:peerId
  // =========================================================================

  describe('DELETE /admin/peers/:peerId', () => {
    it('should return 500 when removePeer throws', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      mockBTPClientManager.removePeer.mockRejectedValue(new Error('disconnect error'));
      app = await createApp();
      const res = await request(app).delete('/admin/peers/peer1');
      expect(res.status).toBe(500);
    });

    it('should not remove routes when removeRoutes=false', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      mockRoutingTable.getAllRoutes.mockReturnValue([
        { prefix: 'g.peer1', nextHop: 'peer1', priority: 0 },
      ]);
      app = await createApp();
      const res = await request(app).delete('/admin/peers/peer1?removeRoutes=false');
      expect(res.status).toBe(200);
      expect(mockRoutingTable.removeRoute).not.toHaveBeenCalled();
      expect(res.body.removedRoutes).toEqual([]);
    });

    it('should silently skip settlement cleanup when peer has no settlement config', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      app = await createApp({ settlementPeers: new Map() });
      const res = await request(app).delete('/admin/peers/peer1');
      expect(res.status).toBe(200);
    });

    it('should return 404 when peer does not exist', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['other']);
      app = await createApp();
      const res = await request(app).delete('/admin/peers/peer1');
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // PUT /admin/peers/:peerId
  // =========================================================================

  describe('PUT /admin/peers/:peerId', () => {
    it('should return 500 when getPeerIds throws', async () => {
      mockBTPClientManager.getPeerIds.mockImplementation(() => {
        throw new Error('btp error');
      });
      app = await createApp();
      const res = await request(app).put('/admin/peers/peer1').send({});
      expect(res.status).toBe(500);
    });

    it('should succeed with empty body (no settlement, no routes)', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      app = await createApp();
      const res = await request(app).put('/admin/peers/peer1').send({});
      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(true);
    });

    it('should skip settlement update when settlementPeers is absent', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      app = await createApp({ settlementPeers: undefined });
      const res = await request(app)
        .put('/admin/peers/peer1')
        .send({
          settlement: {
            preference: 'evm',
            evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
          },
        });
      expect(res.status).toBe(200);
      // settlementPeers undefined in config → no crash, response OK
    });

    it('should return 400 for invalid settlement config on PUT', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      app = await createApp();
      const res = await request(app)
        .put('/admin/peers/peer1')
        .send({ settlement: { preference: 'evm' } });
      expect(res.status).toBe(400);
    });

    it('should return 400 for invalid route prefix on PUT', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      app = await createApp();
      const res = await request(app)
        .put('/admin/peers/peer1')
        .send({ routes: [{ prefix: '.bad' }] });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid ILP address');
    });

    it('should return 400 for route missing prefix on PUT', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      app = await createApp();
      const res = await request(app)
        .put('/admin/peers/peer1')
        .send({ routes: [{ priority: 1 }] });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('missing prefix');
    });
  });

  // =========================================================================
  // GET /admin/routes
  // =========================================================================

  describe('GET /admin/routes', () => {
    it('should return 500 when getAllRoutes throws', async () => {
      mockRoutingTable.getAllRoutes.mockImplementation(() => {
        throw new Error('table corrupt');
      });
      app = await createApp();
      const res = await request(app).get('/admin/routes');
      expect(res.status).toBe(500);
    });

    it('should default priority to 0 when absent', async () => {
      mockRoutingTable.getAllRoutes.mockReturnValue([{ prefix: 'g.a', nextHop: 'peer1' }]);
      app = await createApp();
      const res = await request(app).get('/admin/routes');
      expect(res.status).toBe(200);
      expect(res.body.routes[0].priority).toBe(0);
    });
  });

  // =========================================================================
  // POST /admin/routes
  // =========================================================================

  describe('POST /admin/routes', () => {
    it('should return 400 when prefix is missing', async () => {
      app = await createApp();
      const res = await request(app).post('/admin/routes').send({ nextHop: 'peer1' });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('prefix');
    });

    it('should return 400 when nextHop is missing', async () => {
      app = await createApp();
      const res = await request(app).post('/admin/routes').send({ prefix: 'g.a' });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('nextHop');
    });

    it('should return 400 when prefix is invalid ILP address', async () => {
      app = await createApp();
      const res = await request(app)
        .post('/admin/routes')
        .send({ prefix: '.bad', nextHop: 'peer1' });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid ILP address');
    });

    it('should include warning when nextHop peer does not exist', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['other']);
      app = await createApp();
      const res = await request(app)
        .post('/admin/routes')
        .send({ prefix: 'g.connector.alice', nextHop: 'peer1' });
      expect(res.status).toBe(201);
      expect(res.body.warning).toContain('does not exist');
    });

    it('should return 500 when addRoute throws', async () => {
      mockRoutingTable.addRoute.mockImplementation(() => {
        throw new Error('disk full');
      });
      app = await createApp();
      const res = await request(app)
        .post('/admin/routes')
        .send({ prefix: 'g.connector.alice', nextHop: 'peer1' });
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // DELETE /admin/routes/:prefix
  // =========================================================================

  describe('DELETE /admin/routes/:prefix', () => {
    it('should return 500 when getAllRoutes throws', async () => {
      mockRoutingTable.getAllRoutes.mockImplementation(() => {
        throw new Error('table corrupt');
      });
      app = await createApp();
      const res = await request(app).delete('/admin/routes/g.connector.alice');
      expect(res.status).toBe(500);
    });

    it('should return 404 when route not found', async () => {
      mockRoutingTable.getAllRoutes.mockReturnValue([]);
      app = await createApp();
      const res = await request(app).delete('/admin/routes/g.connector.alice');
      expect(res.status).toBe(404);
    });

    it('should return 400 when prefix parameter is empty', async () => {
      app = await createApp();
      // /admin/routes/  → req.params.prefix becomes '' (falsy)
      const res = await request(app).delete('/admin/routes/');
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Missing prefix');
    });

    it('should remove existing route and return 200', async () => {
      mockRoutingTable.getAllRoutes.mockReturnValue([
        { prefix: 'g.connector.alice', nextHop: 'peer1', priority: 0 },
      ]);
      app = await createApp();
      const res = await request(app).delete('/admin/routes/g.connector.alice');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockRoutingTable.removeRoute).toHaveBeenCalledWith('g.connector.alice');
    });
  });

  // =========================================================================
  // POST /admin/channels
  // =========================================================================

  describe('POST /admin/channels', () => {
    const validEvmBody = {
      peerId: 'peer-b',
      chain: 'evm:base:8453',
      initialDeposit: '1000',
      peerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
    };

    it('should return 503 when channelManager is absent', async () => {
      app = await createApp({ channelManager: undefined });
      const res = await request(app).post('/admin/channels').send(validEvmBody);
      expect(res.status).toBe(503);
      expect(res.body.message).toContain('Settlement infrastructure not enabled');
    });

    it('should return 400 for unsupported blockchain prefix', async () => {
      const mockChannelManager = createMockChannelManager();
      app = await createApp({ channelManager: mockChannelManager });
      const res = await request(app)
        .post('/admin/channels')
        .send({ ...validEvmBody, chain: 'solana:mainnet:0' });
      expect(res.status).toBe(400);
      // validateOpenChannelRequest rejects before chain routing because CHAIN_FORMAT_REGEX only matches evm:
      expect(res.body.message).toContain('Invalid chain format');
    });

    it('should return 404 when peer is not registered', async () => {
      const mockChannelManager = createMockChannelManager();
      mockBTPClientManager.getPeerIds.mockReturnValue(['other']);
      app = await createApp({ channelManager: mockChannelManager });
      const res = await request(app).post('/admin/channels').send(validEvmBody);
      expect(res.status).toBe(404);
    });

    it('should return 400 when peer EVM address is missing and no settlement config exists', async () => {
      const mockChannelManager = createMockChannelManager();
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer-b']);
      app = await createApp({ channelManager: mockChannelManager, settlementPeers: new Map() });
      const res = await request(app)
        .post('/admin/channels')
        .send({ peerId: 'peer-b', chain: 'evm:base:8453', initialDeposit: '1000' });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('EVM address');
    });

    it('should return 400 when peerAddress format is invalid', async () => {
      const mockChannelManager = createMockChannelManager();
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer-b']);
      app = await createApp({ channelManager: mockChannelManager });
      const res = await request(app)
        .post('/admin/channels')
        .send({ ...validEvmBody, peerAddress: '0xbad' });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid EVM address format');
    });

    it('should return 409 when an open channel already exists', async () => {
      const mockChannelManager = createMockChannelManager();
      const existing: ChannelMetadata = {
        channelId: '0xold',
        peerId: 'peer-b',
        tokenId: 'AGENT',
        tokenAddress: '0xA',
        chain: 'evm:base:8453',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      };
      mockChannelManager.getChannelForPeer.mockReturnValue(existing);
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer-b']);
      app = await createApp({ channelManager: mockChannelManager });
      const res = await request(app).post('/admin/channels').send(validEvmBody);
      expect(res.status).toBe(409);
    });

    it('should return 500 when metadata is unavailable after creation', async () => {
      const mockChannelManager = createMockChannelManager();
      mockChannelManager.getChannelById.mockReturnValue(null); // metadata missing
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer-b']);
      app = await createApp({ channelManager: mockChannelManager });
      const res = await request(app).post('/admin/channels').send(validEvmBody);
      expect(res.status).toBe(500);
      expect(res.body.message).toContain('metadata unavailable');
    });

    it('should resolve peerAddress from settlementPeers when request omits it', async () => {
      const mockChannelManager = createMockChannelManager();
      mockChannelManager.getChannelById.mockReturnValue({
        channelId: '0xchannel123',
        peerId: 'peer-b',
        tokenId: 'AGENT',
        tokenAddress: '0xA',
        chain: 'evm:base:8453',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      });
      const sp = new Map<string, SettlementPeerConfig>();
      sp.set('peer-b', {
        peerId: 'peer-b',
        address: '',
        settlementPreference: 'evm',
        settlementTokens: [],
        evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
      });
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer-b']);
      app = await createApp({ channelManager: mockChannelManager, settlementPeers: sp });
      const res = await request(app)
        .post('/admin/channels')
        .send({ peerId: 'peer-b', chain: 'evm:base:8453', initialDeposit: '1000' });
      expect(res.status).toBe(201);
    });
  });

  // =========================================================================
  // GET /admin/channels
  // =========================================================================

  describe('GET /admin/channels', () => {
    it('should return 503 when channelManager is absent', async () => {
      app = await createApp({ channelManager: undefined });
      const res = await request(app).get('/admin/channels');
      expect(res.status).toBe(503);
    });

    it('should return 500 when getAllChannels throws', async () => {
      const mockChannelManager = createMockChannelManager();
      mockChannelManager.getAllChannels.mockImplementation(() => {
        throw new Error('db locked');
      });
      app = await createApp({ channelManager: mockChannelManager });
      const res = await request(app).get('/admin/channels');
      expect(res.status).toBe(500);
    });

    it('should filter by chain', async () => {
      const mockChannelManager = createMockChannelManager();
      mockChannelManager.getAllChannels.mockReturnValue([
        {
          channelId: '0x1',
          peerId: 'p',
          tokenId: 'T',
          tokenAddress: '0xA',
          chain: 'evm:base:8453',
          createdAt: new Date(),
          lastActivityAt: new Date(),
          status: 'open',
        },
        {
          channelId: '0x2',
          peerId: 'p',
          tokenId: 'T',
          tokenAddress: '0xA',
          chain: 'evm:optimism:10',
          createdAt: new Date(),
          lastActivityAt: new Date(),
          status: 'open',
        },
      ]);
      app = await createApp({ channelManager: mockChannelManager });
      const res = await request(app).get('/admin/channels?chain=evm:base:8453');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].channelId).toBe('0x1');
    });

    it('should leave deposit as unknown when paymentChannelSDK query fails', async () => {
      const mockChannelManager = createMockChannelManager();
      const mockPaymentChannelSDK = createMockPaymentChannelSDK();
      mockChannelManager.getAllChannels.mockReturnValue([
        {
          channelId: '0x1',
          peerId: 'p',
          tokenId: 'T',
          tokenAddress: '0xA',
          chain: 'evm:base:8453',
          createdAt: new Date(),
          lastActivityAt: new Date(),
          status: 'open',
        },
      ]);
      mockPaymentChannelSDK.getChannelState.mockRejectedValue(new Error('RPC down'));
      app = await createApp({
        channelManager: mockChannelManager,
        paymentChannelSDK: mockPaymentChannelSDK,
      });
      const res = await request(app).get('/admin/channels');
      expect(res.status).toBe(200);
      expect(res.body[0].deposit).toBe('unknown');
    });

    it('should leave deposit as unknown when paymentChannelSDK is absent', async () => {
      const mockChannelManager = createMockChannelManager();
      mockChannelManager.getAllChannels.mockReturnValue([
        {
          channelId: '0x1',
          peerId: 'p',
          tokenId: 'T',
          tokenAddress: '0xA',
          chain: 'evm:base:8453',
          createdAt: new Date(),
          lastActivityAt: new Date(),
          status: 'open',
        },
      ]);
      app = await createApp({ channelManager: mockChannelManager, paymentChannelSDK: undefined });
      const res = await request(app).get('/admin/channels');
      expect(res.status).toBe(200);
      expect(res.body[0].deposit).toBe('unknown');
    });
  });

  // =========================================================================
  // GET /admin/channels/:channelId
  // =========================================================================

  describe('GET /admin/channels/:channelId', () => {
    it('should return 503 when channelManager is absent', async () => {
      app = await createApp({ channelManager: undefined });
      const res = await request(app).get('/admin/channels/0x1');
      expect(res.status).toBe(503);
    });

    it('should return fallback metadata for non-EVM chain without SDK', async () => {
      const mockChannelManager = createMockChannelManager();
      mockChannelManager.getChannelById.mockReturnValue({
        channelId: '0x1',
        peerId: 'p',
        tokenId: 'T',
        tokenAddress: '0xA',
        chain: 'solana:devnet:0',
        createdAt: new Date('2026-01-01'),
        lastActivityAt: new Date('2026-01-02'),
        status: 'open',
      });
      app = await createApp({ channelManager: mockChannelManager, paymentChannelSDK: undefined });
      const res = await request(app).get('/admin/channels/0x1');
      expect(res.status).toBe(200);
      expect(res.body.deposit).toBe('unknown');
      expect(res.body.chain).toBe('solana:devnet:0');
    });

    it('should return 500 when getChannelById throws', async () => {
      const mockChannelManager = createMockChannelManager();
      mockChannelManager.getChannelById.mockImplementation(() => {
        throw new Error('db error');
      });
      app = await createApp({ channelManager: mockChannelManager });
      const res = await request(app).get('/admin/channels/0x1');
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // POST /admin/channels/:channelId/deposit
  // =========================================================================

  describe('POST /admin/channels/:channelId/deposit', () => {
    const depositBody = { amount: '500' };

    it('should return 503 when channelManager is absent', async () => {
      app = await createApp({ channelManager: undefined });
      const res = await request(app).post('/admin/channels/0x1/deposit').send(depositBody);
      expect(res.status).toBe(503);
    });

    it('should return 404 when channel not found', async () => {
      const mockChannelManager = createMockChannelManager();
      mockChannelManager.getChannelById.mockReturnValue(null);
      app = await createApp({ channelManager: mockChannelManager });
      const res = await request(app).post('/admin/channels/0x1/deposit').send(depositBody);
      expect(res.status).toBe(404);
    });

    it('should return 400 when channel is not open', async () => {
      const mockChannelManager = createMockChannelManager();
      mockChannelManager.getChannelById.mockReturnValue({
        channelId: '0x1',
        peerId: 'p',
        tokenId: 'T',
        tokenAddress: '0xA',
        chain: 'evm:base:8453',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'closing',
      });
      app = await createApp({ channelManager: mockChannelManager });
      const res = await request(app).post('/admin/channels/0x1/deposit').send(depositBody);
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('not in open state');
    });

    it('should return 400 for unsupported blockchain', async () => {
      const mockChannelManager = createMockChannelManager();
      mockChannelManager.getChannelById.mockReturnValue({
        channelId: '0x1',
        peerId: 'p',
        tokenId: 'T',
        tokenAddress: '0xA',
        chain: 'solana:devnet:0',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      });
      app = await createApp({ channelManager: mockChannelManager });
      const res = await request(app).post('/admin/channels/0x1/deposit').send(depositBody);
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Unsupported blockchain');
    });

    it('should return 503 when paymentChannelSDK is absent for EVM deposit', async () => {
      const mockChannelManager = createMockChannelManager();
      mockChannelManager.getChannelById.mockReturnValue({
        channelId: '0x1',
        peerId: 'p',
        tokenId: 'T',
        tokenAddress: '0xA',
        chain: 'evm:base:8453',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      });
      app = await createApp({ channelManager: mockChannelManager, paymentChannelSDK: undefined });
      const res = await request(app).post('/admin/channels/0x1/deposit').send(depositBody);
      expect(res.status).toBe(503);
    });

    it('should return 500 when deposit throws', async () => {
      const mockChannelManager = createMockChannelManager();
      const mockPaymentChannelSDK = createMockPaymentChannelSDK();
      mockChannelManager.getChannelById.mockReturnValue({
        channelId: '0x1',
        peerId: 'p',
        tokenId: 'T',
        tokenAddress: '0xA',
        chain: 'evm:base:8453',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      });
      mockPaymentChannelSDK.deposit.mockRejectedValue(new Error('reverted'));
      app = await createApp({
        channelManager: mockChannelManager,
        paymentChannelSDK: mockPaymentChannelSDK,
      });
      const res = await request(app).post('/admin/channels/0x1/deposit').send(depositBody);
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // POST /admin/channels/:channelId/close
  // =========================================================================

  describe('POST /admin/channels/:channelId/close', () => {
    it('should return 503 when channelManager is absent', async () => {
      app = await createApp({ channelManager: undefined });
      const res = await request(app).post('/admin/channels/0x1/close').send({});
      expect(res.status).toBe(503);
    });

    it('should return 404 when channel not found', async () => {
      const mockChannelManager = createMockChannelManager();
      mockChannelManager.getChannelById.mockReturnValue(null);
      app = await createApp({ channelManager: mockChannelManager });
      const res = await request(app).post('/admin/channels/0x1/close').send({});
      expect(res.status).toBe(404);
    });

    it('should return 400 when channel is not closeable', async () => {
      const mockChannelManager = createMockChannelManager();
      mockChannelManager.getChannelById.mockReturnValue({
        channelId: '0x1',
        peerId: 'p',
        tokenId: 'T',
        tokenAddress: '0xA',
        chain: 'evm:base:8453',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'closed',
      });
      app = await createApp({ channelManager: mockChannelManager });
      const res = await request(app).post('/admin/channels/0x1/close').send({});
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('not in a closeable state');
    });

    it('should return 400 for unsupported blockchain', async () => {
      const mockChannelManager = createMockChannelManager();
      mockChannelManager.getChannelById.mockReturnValue({
        channelId: '0x1',
        peerId: 'p',
        tokenId: 'T',
        tokenAddress: '0xA',
        chain: 'solana:devnet:0',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      });
      app = await createApp({ channelManager: mockChannelManager });
      const res = await request(app).post('/admin/channels/0x1/close').send({});
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Unsupported blockchain');
    });

    it('should return 503 when paymentChannelSDK is absent for EVM close', async () => {
      const mockChannelManager = createMockChannelManager();
      mockChannelManager.getChannelById.mockReturnValue({
        channelId: '0x1',
        peerId: 'p',
        tokenId: 'T',
        tokenAddress: '0xA',
        chain: 'evm:base:8453',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      });
      app = await createApp({ channelManager: mockChannelManager, paymentChannelSDK: undefined });
      const res = await request(app).post('/admin/channels/0x1/close').send({});
      expect(res.status).toBe(503);
    });

    it('should return 500 when closeChannel throws', async () => {
      const mockChannelManager = createMockChannelManager();
      const mockPaymentChannelSDK = createMockPaymentChannelSDK();
      mockChannelManager.getChannelById.mockReturnValue({
        channelId: '0x1',
        peerId: 'p',
        tokenId: 'T',
        tokenAddress: '0xA',
        chain: 'evm:base:8453',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      });
      mockPaymentChannelSDK.closeChannel.mockRejectedValue(new Error('reverted'));
      app = await createApp({
        channelManager: mockChannelManager,
        paymentChannelSDK: mockPaymentChannelSDK,
      });
      const res = await request(app).post('/admin/channels/0x1/close').send({});
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // GET /admin/balances/:peerId
  // =========================================================================

  describe('GET /admin/balances/:peerId', () => {
    it('should return 503 when accountManager is absent', async () => {
      app = await createApp({ accountManager: undefined });
      const res = await request(app).get('/admin/balances/peer1');
      expect(res.status).toBe(503);
    });

    it('should return 404 for unknown peer', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['other']);
      app = await createApp({ accountManager: createMockAccountManager() });
      const res = await request(app).get('/admin/balances/peer1');
      expect(res.status).toBe(404);
    });

    it('should return 500 when getAccountBalance throws', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      const mockAccountManager = createMockAccountManager();
      mockAccountManager.getAccountBalance.mockRejectedValue(new Error('tb down'));
      app = await createApp({ accountManager: mockAccountManager });
      const res = await request(app).get('/admin/balances/peer1');
      expect(res.status).toBe(500);
    });

    it('should use defaultSettlementTokenId when query param absent', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      const mockAccountManager = createMockAccountManager();
      app = await createApp({
        accountManager: mockAccountManager,
        defaultSettlementTokenId: 'CUSTOM',
      });
      await request(app).get('/admin/balances/peer1');
      expect(mockAccountManager.getAccountBalance).toHaveBeenCalledWith('peer1', 'CUSTOM');
    });

    it('should use tokenId from query param when present', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      const mockAccountManager = createMockAccountManager();
      app = await createApp({ accountManager: mockAccountManager });
      await request(app).get('/admin/balances/peer1?tokenId=XYZ');
      expect(mockAccountManager.getAccountBalance).toHaveBeenCalledWith('peer1', 'XYZ');
    });
  });

  // =========================================================================
  // GET /admin/settlement/states
  // =========================================================================

  describe('GET /admin/settlement/states', () => {
    it('should return 503 when settlementMonitor is absent', async () => {
      app = await createApp({ settlementMonitor: undefined });
      const res = await request(app).get('/admin/settlement/states');
      expect(res.status).toBe(503);
    });

    it('should return 500 when getAllSettlementStates throws', async () => {
      const mockSettlementMonitor = createMockSettlementMonitor();
      mockSettlementMonitor.getAllSettlementStates.mockImplementation(() => {
        throw new Error('db error');
      });
      app = await createApp({ settlementMonitor: mockSettlementMonitor });
      const res = await request(app).get('/admin/settlement/states');
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // GET /admin/channels/:channelId/claims
  // =========================================================================

  describe('GET /admin/channels/:channelId/claims', () => {
    it('should return 503 when channelManager is absent', async () => {
      app = await createApp({ channelManager: undefined });
      const res = await request(app).get('/admin/channels/0x1/claims');
      expect(res.status).toBe(503);
    });

    it('should return 503 when claimReceiver is absent', async () => {
      const mockChannelManager = createMockChannelManager();
      app = await createApp({ channelManager: mockChannelManager, claimReceiver: undefined });
      const res = await request(app).get('/admin/channels/0x1/claims');
      expect(res.status).toBe(503);
    });

    it('should return 404 when no claims exist', async () => {
      const mockChannelManager = createMockChannelManager();
      const mockClaimReceiver = createMockClaimReceiver();
      mockChannelManager.getChannelById.mockReturnValue({
        channelId: '0x1',
        peerId: 'p',
        tokenId: 'T',
        tokenAddress: '0xA',
        chain: 'evm:base:8453',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      });
      mockClaimReceiver.getLatestVerifiedClaim.mockResolvedValue(null);
      app = await createApp({
        channelManager: mockChannelManager,
        claimReceiver: mockClaimReceiver,
      });
      const res = await request(app).get('/admin/channels/0x1/claims');
      expect(res.status).toBe(404);
      expect(res.body.message).toContain('No claims found');
    });

    it('should return 500 when getLatestVerifiedClaim throws', async () => {
      const mockChannelManager = createMockChannelManager();
      const mockClaimReceiver = createMockClaimReceiver();
      mockChannelManager.getChannelById.mockReturnValue({
        channelId: '0x1',
        peerId: 'p',
        tokenId: 'T',
        tokenAddress: '0xA',
        chain: 'evm:base:8453',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      });
      mockClaimReceiver.getLatestVerifiedClaim.mockRejectedValue(new Error('db error'));
      app = await createApp({
        channelManager: mockChannelManager,
        claimReceiver: mockClaimReceiver,
      });
      const res = await request(app).get('/admin/channels/0x1/claims');
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // GET /admin/metrics.json
  // =========================================================================

  describe('GET /admin/metrics.json', () => {
    it('should return 503 when metricsRegistry is absent', async () => {
      app = await createApp({ metricsRegistry: undefined });
      const res = await request(app).get('/admin/metrics.json');
      expect(res.status).toBe(503);
    });

    it('should return 200 with zeros for idle peers', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['idle-peer']);
      mockBTPClientManager.getPeerStatus.mockReturnValue(new Map([['idle-peer', false]]));
      const registry = new IlpMetricsRegistry({ collectDefaults: false });
      registry.registerPeer('idle-peer');
      app = await createApp({ metricsRegistry: registry });
      const res = await request(app).get('/admin/metrics.json');
      expect(res.status).toBe(200);
      const peer = res.body.peers.find((p: { peerId: string }) => p.peerId === 'idle-peer');
      expect(peer.packetsForwarded).toBe(0);
      expect(peer.packetsRejected).toBe(0);
      expect(peer.bytesSent).toBe(0);
      expect(peer.lastPacketAt).toBeNull();
    });

    it('should return 500 when snapshotPeers throws', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['p']);
      const registry = new IlpMetricsRegistry({ collectDefaults: false });
      jest.spyOn(registry, 'snapshotPeers').mockRejectedValue(new Error('crash'));
      app = await createApp({ metricsRegistry: registry });
      const res = await request(app).get('/admin/metrics.json');
      expect(res.status).toBe(500);
    });

    it('should set Cache-Control: no-store', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue([]);
      const registry = new IlpMetricsRegistry({ collectDefaults: false });
      app = await createApp({ metricsRegistry: registry });
      const res = await request(app).get('/admin/metrics.json');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  // =========================================================================
  // GET /admin/earnings.json
  // =========================================================================

  describe('GET /admin/earnings.json', () => {
    it('should return 503 when accountManager is absent', async () => {
      app = await createApp({
        accountManager: undefined,
        claimReceiver: createMockClaimReceiver(),
      });
      const res = await request(app).get('/admin/earnings.json');
      expect(res.status).toBe(503);
    });

    it('should return 503 when claimReceiver is absent', async () => {
      app = await createApp({
        accountManager: createMockAccountManager(),
        claimReceiver: undefined,
      });
      const res = await request(app).get('/admin/earnings.json');
      expect(res.status).toBe(503);
    });

    it('should use metadata fallback when resolveTokenMetadata is absent', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      const mockClaimReceiver = createMockClaimReceiver();
      const inbound = new Map();
      inbound.set('evm:0xA', {
        total: 100n,
        lastAt: Date.now(),
        blockchain: 'evm' as const,
        tokenAddress: '0xA',
      });
      mockClaimReceiver.getCumulativeInboundByAsset.mockResolvedValue(inbound);
      app = await createApp({
        accountManager: createMockAccountManager(),
        claimReceiver: mockClaimReceiver,
        resolveTokenMetadata: undefined,
      });
      const res = await request(app).get('/admin/earnings.json');
      expect(res.status).toBe(200);
      expect(res.body.peers[0].byAsset[0].assetCode).toBe('0xA');
      expect(res.body.peers[0].byAsset[0].assetScale).toBe(0);
    });

    it('should use metadata fallback when resolveTokenMetadata throws', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      const mockClaimReceiver = createMockClaimReceiver();
      const inbound = new Map();
      inbound.set('evm:0xA', {
        total: 100n,
        lastAt: Date.now(),
        blockchain: 'evm' as const,
        tokenAddress: '0xA',
      });
      mockClaimReceiver.getCumulativeInboundByAsset.mockResolvedValue(inbound);
      app = await createApp({
        accountManager: createMockAccountManager(),
        claimReceiver: mockClaimReceiver,
        resolveTokenMetadata: async () => {
          throw new Error('RPC fail');
        },
      });
      const res = await request(app).get('/admin/earnings.json');
      expect(res.status).toBe(200);
      expect(res.body.peers[0].byAsset[0].assetCode).toBe('0xA');
    });

    it('should return empty connectorFees when connectorFeePercentage is omitted', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      const mockClaimReceiver = createMockClaimReceiver();
      const inbound = new Map();
      inbound.set('evm:0xA', {
        total: 1000n,
        lastAt: Date.now(),
        blockchain: 'evm' as const,
        tokenAddress: '0xA',
      });
      mockClaimReceiver.getCumulativeInboundByAsset.mockResolvedValue(inbound);
      app = await createApp({
        accountManager: createMockAccountManager(),
        claimReceiver: mockClaimReceiver,
        connectorFeePercentage: undefined,
      });
      const res = await request(app).get('/admin/earnings.json');
      expect(res.status).toBe(200);
      expect(res.body.connectorFees).toEqual([]);
    });

    it('should return empty connectorFees when connectorFeePercentage is zero', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      const mockClaimReceiver = createMockClaimReceiver();
      const inbound = new Map();
      inbound.set('evm:0xA', {
        total: 1000n,
        lastAt: Date.now(),
        blockchain: 'evm' as const,
        tokenAddress: '0xA',
      });
      mockClaimReceiver.getCumulativeInboundByAsset.mockResolvedValue(inbound);
      app = await createApp({
        accountManager: createMockAccountManager(),
        claimReceiver: mockClaimReceiver,
        connectorFeePercentage: 0,
      });
      const res = await request(app).get('/admin/earnings.json');
      expect(res.status).toBe(200);
      expect(res.body.connectorFees).toEqual([]);
    });

    it('should skip connectorFees for assets with zero incoming sum', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      const mockClaimReceiver = createMockClaimReceiver();
      const inbound = new Map();
      inbound.set('evm:0xA', {
        total: 0n,
        lastAt: Date.now(),
        blockchain: 'evm' as const,
        tokenAddress: '0xA',
      });
      mockClaimReceiver.getCumulativeInboundByAsset.mockResolvedValue(inbound);
      app = await createApp({
        accountManager: createMockAccountManager(),
        claimReceiver: mockClaimReceiver,
        connectorFeePercentage: 0.1,
      });
      const res = await request(app).get('/admin/earnings.json');
      expect(res.status).toBe(200);
      expect(res.body.connectorFees).toEqual([]);
    });

    it('should compute connectorFees when feePct > 0 and incomingSum > 0', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      const mockClaimReceiver = createMockClaimReceiver();
      const inbound = new Map();
      inbound.set('evm:0xA', {
        total: 10000n,
        lastAt: Date.now(),
        blockchain: 'evm' as const,
        tokenAddress: '0xA',
      });
      mockClaimReceiver.getCumulativeInboundByAsset.mockResolvedValue(inbound);
      app = await createApp({
        accountManager: createMockAccountManager(),
        claimReceiver: mockClaimReceiver,
        connectorFeePercentage: 0.1,
        resolveTokenMetadata: async () => ({ assetCode: 'TKN', assetScale: 6 }),
      });
      const res = await request(app).get('/admin/earnings.json');
      expect(res.status).toBe(200);
      expect(res.body.connectorFees.length).toBeGreaterThan(0);
      expect(res.body.connectorFees[0].total).toBe('10'); // (10000n * 10n) / 10000n = 10n
    });

    it('should degrade gracefully when sentClaimsQueries is absent', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      const mockClaimReceiver = createMockClaimReceiver();
      mockClaimReceiver.getCumulativeInboundByAsset.mockResolvedValue(new Map());
      mockClaimReceiver.getRecentClaims.mockResolvedValue([]);
      app = await createApp({
        accountManager: createMockAccountManager(),
        claimReceiver: mockClaimReceiver,
        sentClaimsQueries: undefined,
      });
      const res = await request(app).get('/admin/earnings.json');
      expect(res.status).toBe(200);
      expect(res.body.recentClaims).toEqual([]);
    });

    it('should return 500 when sentClaimsQueries.getCumulativeOutboundByAsset throws', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      const mockSentClaimsQueries = {
        getCumulativeOutboundByAsset: jest.fn().mockRejectedValue(new Error('db down')),
        getRecentSentClaims: jest.fn().mockResolvedValue([]),
      };
      app = await createApp({
        accountManager: createMockAccountManager(),
        claimReceiver: createMockClaimReceiver(),
        sentClaimsQueries: mockSentClaimsQueries as unknown as SentClaimsQueries,
      });
      const res = await request(app).get('/admin/earnings.json');
      expect(res.status).toBe(500);
    });

    it('should return 500 when claimReceiver.getCumulativeInboundByAsset throws', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      const mockClaimReceiver = createMockClaimReceiver();
      mockClaimReceiver.getCumulativeInboundByAsset.mockRejectedValue(new Error('db down'));
      app = await createApp({
        accountManager: createMockAccountManager(),
        claimReceiver: mockClaimReceiver,
      });
      const res = await request(app).get('/admin/earnings.json');
      expect(res.status).toBe(500);
    });

    it('should handle malformed EVM claim transferredAmount in extractClaim catch', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      const mockClaimReceiver = createMockClaimReceiver();
      mockClaimReceiver.getCumulativeInboundByAsset.mockResolvedValue(new Map());
      // Provide a recent claim with a non-numeric transferredAmount to hit the BigInt catch
      mockClaimReceiver.getRecentClaims.mockResolvedValue([
        {
          messageId: 'msg-1',
          peerId: 'peer1',
          blockchain: 'evm',
          channelId: '0x1',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          claimData: { transferredAmount: 'not-a-number', tokenAddress: '0xA' } as any,
          receivedAt: Date.now(),
        },
      ]);
      app = await createApp({
        accountManager: createMockAccountManager(),
        claimReceiver: mockClaimReceiver,
      });
      const res = await request(app).get('/admin/earnings.json');
      expect(res.status).toBe(200);
      // amount delta should be 0 because BigInt catch defaults to 0n
      expect(res.body.recentClaims[0].amount).toBe('0');
    });

    it('should handle malformed Solana claim transferredAmount in extractClaim catch', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer1']);
      const mockClaimReceiver = createMockClaimReceiver();
      mockClaimReceiver.getCumulativeInboundByAsset.mockResolvedValue(new Map());
      mockClaimReceiver.getRecentClaims.mockResolvedValue([
        {
          messageId: 'msg-2',
          peerId: 'peer1',
          blockchain: 'solana',
          channelId: '0x1',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          claimData: { transferredAmount: 'bad', programId: 'So1111' } as any,
          receivedAt: Date.now(),
        },
      ]);
      app = await createApp({
        accountManager: createMockAccountManager(),
        claimReceiver: mockClaimReceiver,
      });
      const res = await request(app).get('/admin/earnings.json');
      expect(res.status).toBe(200);
      expect(res.body.recentClaims[0].amount).toBe('0');
    });
  });

  // =========================================================================
  // Validation-function branches
  // =========================================================================

  describe('validateDepositRequest', () => {
    it('should reject undefined amount', () => {
      const r = validateDepositRequest({});
      expect(r.valid).toBe(false);
      expect(r.error).toContain('Missing amount');
    });

    it('should reject null amount', () => {
      const r = validateDepositRequest({ amount: null });
      expect(r.valid).toBe(false);
    });

    it('should reject non-string amount', () => {
      const r = validateDepositRequest({ amount: 123 });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('string');
    });

    it('should reject non-numeric string', () => {
      const r = validateDepositRequest({ amount: 'abc' });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('positive integer');
    });

    it('should reject zero amount', () => {
      const r = validateDepositRequest({ amount: '0' });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('greater than zero');
    });

    it('should accept valid amount', () => {
      const r = validateDepositRequest({ amount: '100' });
      expect(r.valid).toBe(true);
    });
  });

  describe('validateSettlementConfig', () => {
    it('should reject missing preference', () => {
      const r = validateSettlementConfig({} as unknown as AdminSettlementConfig);
      expect(r).toContain('preference');
    });

    it('should reject invalid preference', () => {
      const r = validateSettlementConfig({ preference: 'btc' } as unknown as AdminSettlementConfig);
      expect(r).toContain('preference');
    });

    it('should reject evm preference without evmAddress', () => {
      const r = validateSettlementConfig({ preference: 'evm' } as unknown as AdminSettlementConfig);
      expect(r).toContain('evmAddress required');
    });

    it('should reject any preference without evmAddress', () => {
      const r = validateSettlementConfig({ preference: 'any' } as unknown as AdminSettlementConfig);
      expect(r).toContain('evmAddress required');
    });

    it('should reject invalid evmAddress format', () => {
      const r = validateSettlementConfig({
        preference: 'evm',
        evmAddress: '0xbad',
      } as unknown as AdminSettlementConfig);
      expect(r).toContain('evmAddress must be a valid');
    });

    it('should reject invalid tokenAddress format', () => {
      const r = validateSettlementConfig({
        preference: 'evm',
        evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
        tokenAddress: '0xbad',
      } as unknown as AdminSettlementConfig);
      expect(r).toContain('tokenAddress must be a valid');
    });

    it('should reject invalid tokenNetworkAddress format', () => {
      const r = validateSettlementConfig({
        preference: 'evm',
        evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
        tokenNetworkAddress: '0xbad',
      } as unknown as AdminSettlementConfig);
      expect(r).toContain('tokenNetworkAddress must be a valid');
    });

    it('should reject non-positive chainId', () => {
      const r = validateSettlementConfig({
        preference: 'evm',
        evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
        chainId: 0,
      } as unknown as AdminSettlementConfig);
      expect(r).toContain('chainId must be a positive integer');
    });

    it('should reject non-integer initialDeposit', () => {
      const r = validateSettlementConfig({
        preference: 'evm',
        evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
        initialDeposit: '1.5',
      } as unknown as AdminSettlementConfig);
      expect(r).toContain('initialDeposit must be a non-negative integer string');
    });

    it('should accept valid minimal config', () => {
      const r = validateSettlementConfig({
        preference: 'evm',
        evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
      } as unknown as AdminSettlementConfig);
      expect(r).toBeNull();
    });
  });

  describe('validateOpenChannelRequest', () => {
    it('should reject missing peerId', () => {
      const r = validateOpenChannelRequest({ chain: 'evm:base:8453', initialDeposit: '100' });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('peerId');
    });

    it('should reject missing chain', () => {
      const r = validateOpenChannelRequest({ peerId: 'p', initialDeposit: '100' });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('chain');
    });

    it('should reject invalid chain format (no colons)', () => {
      const r = validateOpenChannelRequest({ peerId: 'p', chain: 'evm', initialDeposit: '100' });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('Invalid chain format');
    });

    it('should reject missing initialDeposit', () => {
      const r = validateOpenChannelRequest({ peerId: 'p', chain: 'evm:base:8453' });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('initialDeposit');
    });

    it('should reject non-string initialDeposit', () => {
      const r = validateOpenChannelRequest({
        peerId: 'p',
        chain: 'evm:base:8453',
        initialDeposit: 100,
      });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('string');
    });

    it('should reject non-numeric initialDeposit', () => {
      const r = validateOpenChannelRequest({
        peerId: 'p',
        chain: 'evm:base:8453',
        initialDeposit: 'abc',
      });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('non-negative integer');
    });

    it('should reject invalid token address', () => {
      const r = validateOpenChannelRequest({
        peerId: 'p',
        chain: 'evm:base:8453',
        initialDeposit: '100',
        token: 'bad',
      });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('token address');
    });

    it('should reject invalid tokenNetwork address', () => {
      const r = validateOpenChannelRequest({
        peerId: 'p',
        chain: 'evm:base:8453',
        initialDeposit: '100',
        tokenNetwork: 'bad',
      });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('tokenNetwork');
    });

    it('should reject non-positive settlementTimeout', () => {
      const r = validateOpenChannelRequest({
        peerId: 'p',
        chain: 'evm:base:8453',
        initialDeposit: '100',
        settlementTimeout: 0,
      });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('settlementTimeout');
    });

    it('should accept valid request', () => {
      const r = validateOpenChannelRequest({
        peerId: 'p',
        chain: 'evm:base:8453',
        initialDeposit: '100',
      });
      expect(r.valid).toBe(true);
    });
  });
});
