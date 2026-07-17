/**
 * Unit tests for the discovered-vs-peered admin surface (toon-meta#153):
 * GET /admin/discovered-nodes and the funded-channel cap gate on
 * POST /admin/peers. Follows the admin-api-peers.test.ts fixture pattern
 * (supertest against a router built with hand-wired deps).
 *
 * @module http/admin-api-discovered-nodes.test
 */

import request from 'supertest';
import express, { Express } from 'express';
import { createAdminRouter, AdminAPIConfig } from './admin-api';
import type { DiscoveredNode } from '../discovery/discovered-node-registry';
import type { Logger } from 'pino';
import type { RoutingTable } from '../routing/routing-table';
import type { BTPClientManager } from '../btp/btp-client-manager';

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);

function makeNode(overrides: Partial<DiscoveredNode> = {}): DiscoveredNode {
  return {
    pubkey: PK_A,
    ilpAddress: 'g.alpha',
    ilpAddresses: ['g.alpha'],
    btpEndpoint: 'wss://alpha.example:443',
    assetCode: 'USDC',
    assetScale: 6,
    firstSeenAt: 1_800_000_000,
    lastSeenAt: 1_800_000_060,
    funded: false,
    ...overrides,
  };
}

describe('Admin API — discovered-vs-peered surface (toon-meta#153)', () => {
  let mockRoutingTable: jest.Mocked<RoutingTable>;
  let mockBTPClientManager: jest.Mocked<BTPClientManager>;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    mockRoutingTable = {
      addRoute: jest.fn(),
      removeRoute: jest.fn(),
      getAllRoutes: jest.fn().mockReturnValue([]),
      lookup: jest.fn(),
    } as unknown as jest.Mocked<RoutingTable>;

    mockBTPClientManager = {
      addPeer: jest.fn().mockResolvedValue(undefined),
      removePeer: jest.fn().mockResolvedValue(undefined),
      getPeerIds: jest.fn().mockReturnValue([]),
      getPeerStatus: jest.fn().mockReturnValue(new Map()),
      isConnected: jest.fn().mockReturnValue(false),
      getPeerTransport: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<BTPClientManager>;

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
      fatal: jest.fn(),
      trace: jest.fn(),
      level: 'info',
    } as unknown as jest.Mocked<Logger>;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  async function makeApp(extra: Partial<AdminAPIConfig> = {}): Promise<Express> {
    const config: AdminAPIConfig = {
      routingTable: mockRoutingTable,
      btpClientManager: mockBTPClientManager,
      logger: mockLogger,
      nodeId: 'test-node',
      ...extra,
    };
    const app = express();
    app.use('/admin', await createAdminRouter(config));
    return app;
  }

  describe('GET /admin/discovered-nodes', () => {
    it('lists the discovered set with counts and per-entry funded flags', async () => {
      const nodes = [
        makeNode({ pubkey: PK_A, ilpAddress: 'g.alpha', funded: true }),
        makeNode({
          pubkey: PK_B,
          ilpAddress: 'g.beta',
          btpEndpoint: 'wss://beta.example:443',
          supportedChains: ['evm:31337'],
          settlementAddresses: { 'evm:31337': '0x' + '1'.repeat(40) },
          expiresAt: 1_800_000_600,
        }),
      ];
      const app = await makeApp({ getDiscoveredNodes: () => nodes });

      const res = await request(app).get('/admin/discovered-nodes');

      expect(res.status).toBe(200);
      expect(res.body.nodeId).toBe('test-node');
      expect(res.body.discoveredCount).toBe(2);
      expect(res.body.fundedCount).toBe(1);
      expect(res.body.nodes).toHaveLength(2);
      // A discovered-but-unfunded entry carries everything POST /admin/peers
      // needs for promotion: btpEndpoint (the url) + settlement hints.
      expect(res.body.nodes[1]).toMatchObject({
        pubkey: PK_B,
        ilpAddress: 'g.beta',
        btpEndpoint: 'wss://beta.example:443',
        supportedChains: ['evm:31337'],
        settlementAddresses: { 'evm:31337': '0x' + '1'.repeat(40) },
        funded: false,
      });
    });

    it('returns an empty list when no discovered-node reader is wired (route learning disabled)', async () => {
      const app = await makeApp();
      const res = await request(app).get('/admin/discovered-nodes');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        nodeId: 'test-node',
        discoveredCount: 0,
        fundedCount: 0,
        nodes: [],
      });
    });

    it('surfaces a reader failure as HTTP 500', async () => {
      const app = await makeApp({
        getDiscoveredNodes: () => {
          throw new Error('registry exploded');
        },
      });
      const res = await request(app).get('/admin/discovered-nodes');
      expect(res.status).toBe(500);
      expect(res.body.message).toBe('registry exploded');
    });
  });

  describe('POST /admin/peers — funded-channel cap gate', () => {
    const capMessage =
      "Funded-channel cap reached: 2/2 funded channels in use (peeringPolicy.maxFundedChannels). Registering 'peer-c' with settlement config would open another funded channel — remove a funded peer first (DELETE /admin/peers/:peerId) or raise the cap. Discovered nodes stay reachable through learned multi-hop routes without a funded channel.";

    const settledRequest = {
      id: 'peer-c',
      url: 'ws://peer-c:3000',
      authToken: 'token-c',
      settlement: {
        preference: 'evm' as const,
        evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
        chainId: 8453,
      },
    };

    it('rejects a settlement-bearing registration with 409 when the cap gate refuses, before any mutation', async () => {
      const checkFundedChannelCap = jest.fn().mockReturnValue(capMessage);
      const app = await makeApp({ checkFundedChannelCap, settlementPeers: new Map() });

      const res = await request(app).post('/admin/peers').send(settledRequest);

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'Conflict', message: capMessage });
      expect(checkFundedChannelCap).toHaveBeenCalledWith('peer-c');
      expect(mockBTPClientManager.addPeer).not.toHaveBeenCalled();
      expect(mockRoutingTable.addRoute).not.toHaveBeenCalled();
    });

    it('admits a settlement-bearing registration when the cap gate allows', async () => {
      const checkFundedChannelCap = jest.fn().mockReturnValue(null);
      const app = await makeApp({ checkFundedChannelCap, settlementPeers: new Map() });

      const res = await request(app).post('/admin/peers').send(settledRequest);

      expect(res.status).toBe(201);
      expect(mockBTPClientManager.addPeer).toHaveBeenCalledTimes(1);
    });

    it('never consults the cap gate for a route-only (unfunded) registration', async () => {
      const checkFundedChannelCap = jest.fn().mockReturnValue(capMessage);
      const app = await makeApp({ checkFundedChannelCap });

      const res = await request(app)
        .post('/admin/peers')
        .send({ id: 'peer-c', url: 'ws://peer-c:3000', authToken: 'token-c' });

      expect(res.status).toBe(201);
      expect(checkFundedChannelCap).not.toHaveBeenCalled();
    });
  });
});
