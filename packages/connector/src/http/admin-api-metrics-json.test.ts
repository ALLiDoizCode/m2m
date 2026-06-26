/**
 * Unit Tests for Admin API /metrics.json Endpoint (Story 37.3)
 *
 * Tests the JSON projection endpoint for ILP observability:
 * - AC 1: Response shape matches the AdminMetricsJsonResponse contract
 * - AC 2: Auth enforced via X-Api-Key
 * - AC 3: Peers appear even with zero activity (idle peers)
 * - AC 4: connected flag reflects BTPClientManager state
 * - AC 5: 503 when metricsRegistry not provided
 * - AC 6: Latency budget (handler completes synchronously)
 *
 * @module http/admin-api-metrics-json.test
 */

import request from 'supertest';
import express, { Express } from 'express';
import { createAdminRouter, AdminAPIConfig } from './admin-api';
import type { RoutingTable } from '../routing/routing-table';
import type { BTPClientManager } from '../btp/btp-client-manager';
import { IlpMetricsRegistry } from '../observability/metrics-registry';

describe('Admin API GET /admin/metrics.json (Story 37.3)', () => {
  let app: Express;
  let mockRoutingTable: jest.Mocked<RoutingTable>;
  let mockBTPClientManager: jest.Mocked<BTPClientManager>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockLogger: any;
  let metricsRegistry: IlpMetricsRegistry;

  const createApp = async (configOverrides?: Partial<AdminAPIConfig>): Promise<Express> => {
    const config: AdminAPIConfig = {
      routingTable: mockRoutingTable,
      btpClientManager: mockBTPClientManager,
      logger: mockLogger,
      nodeId: 'test-node',
      metricsRegistry,
      ...configOverrides,
    };

    const router = await createAdminRouter(config);
    const expressApp = express();
    expressApp.use('/admin', router);
    return expressApp;
  };

  beforeEach(async () => {
    mockRoutingTable = {
      addRoute: jest.fn(),
      removeRoute: jest.fn(),
      getAllRoutes: jest.fn().mockReturnValue([]),
      lookup: jest.fn(),
      removeRoutesForPeer: jest.fn(),
    } as unknown as jest.Mocked<RoutingTable>;

    // AC 4: peerStatus reflects 'town' as connected, 'mill'/'store' as disconnected.
    // Real BTPClientManager.getPeerStatus() always returns an entry for every peer
    // in getPeerIds() — mock must mirror that contract.
    mockBTPClientManager = {
      addPeer: jest.fn().mockResolvedValue(undefined),
      removePeer: jest.fn().mockResolvedValue(undefined),
      getPeerIds: jest.fn().mockReturnValue(['town', 'mill', 'store']),
      getPeerStatus: jest.fn().mockReturnValue(
        new Map([
          ['town', true],
          ['mill', false],
          ['store', false],
        ])
      ),
      isConnected: jest.fn().mockImplementation((peerId: string) => peerId === 'town'),
      getConnectedPeers: jest.fn().mockReturnValue(['town']),
      getClientForPeer: jest.fn(),
    } as unknown as jest.Mocked<BTPClientManager>;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
      fatal: jest.fn(),
      trace: jest.fn(),
      level: 'info',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // Create fresh metrics registry for each test
    metricsRegistry = new IlpMetricsRegistry({ collectDefaults: false });

    // Register peers known in config (Story 37.2) - 'town' and 'store' have activity, 'mill' is idle
    metricsRegistry.registerPeer('town');
    metricsRegistry.registerPeer('mill');
    metricsRegistry.registerPeer('store');
    metricsRegistry.registerPeer('dvm2'); // Extra peer with no activity

    // Record some activity for 'town' peer
    metricsRegistry.recordForwardFulfill('town', 1500); // 1500 bytes sent
    metricsRegistry.recordForwardReject('town', 500);
    metricsRegistry.recordInbound('town', 2000); // 2000 bytes received

    // Record activity for 'store' peer (registerPeer already called above for AC 3)
    metricsRegistry.recordForwardFulfill('store', 3000);

    app = await createApp();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // --- AC 1: Response shape matches the AdminMetricsJsonResponse contract ---

  describe('AC 1: Response shape matches contract', () => {
    it('should return 200 with all required fields', async () => {
      const response = await request(app).get('/admin/metrics.json').expect(200);

      expect(response.body).toHaveProperty('uptimeSeconds');
      expect(response.body).toHaveProperty('aggregate');
      expect(response.body).toHaveProperty('peers');
      expect(response.body).toHaveProperty('timestamp');

      expect(typeof response.body.uptimeSeconds).toBe('number');
      expect(response.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });

    it('should return aggregate that equals sum of peers', async () => {
      const response = await request(app).get('/admin/metrics.json').expect(200);

      const { aggregate, peers } = response.body;

      // AC 1: aggregate.packetsForwarded equals sum(peers[].packetsForwarded)
      const sumForwarded = peers.reduce(
        (sum: number, p: { packetsForwarded: number }) => sum + p.packetsForwarded,
        0
      );
      expect(aggregate.packetsForwarded).toBe(sumForwarded);

      // Same invariant must hold for packetsRejected and bytesSent.
      const sumRejected = peers.reduce(
        (sum: number, p: { packetsRejected: number }) => sum + p.packetsRejected,
        0
      );
      expect(aggregate.packetsRejected).toBe(sumRejected);

      const sumBytes = peers.reduce(
        (sum: number, p: { bytesSent: number }) => sum + p.bytesSent,
        0
      );
      expect(aggregate.bytesSent).toBe(sumBytes);
    });

    it('should include all fields for each peer', async () => {
      const response = await request(app).get('/admin/metrics.json').expect(200);

      // Verify 'town' has correct structure
      const townPeer = response.body.peers.find((p: { peerId: string }) => p.peerId === 'town');
      expect(townPeer).toMatchObject({
        peerId: 'town',
        connected: true,
        packetsForwarded: 1,
        packetsRejected: 1,
        bytesSent: 2000,
        lastPacketAt: expect.any(String),
      });
    });
  });

  // --- AC 2: Auth enforced ---

  describe('AC 2: Auth enforced', () => {
    it('should reject request without X-Api-Key when apiKey is configured', async () => {
      const appWithAuth = await createApp({ apiKey: 'secret-key' });

      const response = await request(appWithAuth).get('/admin/metrics.json').expect(401);

      expect(response.body.error).toBe('Unauthorized');
    });

    it('should accept request with valid X-Api-Key', async () => {
      const appWithAuth = await createApp({ apiKey: 'secret-key' });

      const response = await request(appWithAuth)
        .get('/admin/metrics.json')
        .set('X-Api-Key', 'secret-key')
        .expect(200);

      expect(response.body).toHaveProperty('peers');
    });

    it('should reject invalid X-Api-Key', async () => {
      const appWithAuth = await createApp({ apiKey: 'secret-key' });

      const response = await request(appWithAuth)
        .get('/admin/metrics.json')
        .set('X-Api-Key', 'wrong-key')
        .expect(401);

      expect(response.body.error).toBe('Unauthorized');
    });
  });

  // --- AC 3: Peers appear even with zero activity ---

  describe('AC 3: Idle peers appear in peers array', () => {
    it('should expose full idle-peer contract (zeros + null lastPacketAt) for mill', async () => {
      // 'mill' is in getPeerIds but has no activity — must appear with zeros,
      // connected=false, and lastPacketAt=null.
      const response = await request(app).get('/admin/metrics.json').expect(200);

      const millPeer = response.body.peers.find((p: { peerId: string }) => p.peerId === 'mill');
      expect(millPeer).toMatchObject({
        peerId: 'mill',
        connected: false,
        packetsForwarded: 0,
        packetsRejected: 0,
        bytesSent: 0,
        lastPacketAt: null, // AC 3: null when never seen
      });
    });
  });

  // --- D1 from code review: snapshot-only peers must NOT appear ---

  describe('D1: btpClientManager.getPeerIds() is the authoritative peer set', () => {
    it('should NOT include a peer that exists only in the metrics registry (removed peer)', async () => {
      // 'dvm2' is primed in the registry (registerPeer + activity) but NOT present
      // in mockBTPClientManager.getPeerIds(). This simulates a peer that was
      // removed via /admin/peers — its counter labels linger in prom-client but
      // the JSON response must drop it.
      metricsRegistry.registerPeer('dvm2');
      metricsRegistry.recordForwardFulfill('dvm2', 999);

      const response = await request(app).get('/admin/metrics.json').expect(200);

      const dvm2Peer = response.body.peers.find((p: { peerId: string }) => p.peerId === 'dvm2');
      expect(dvm2Peer).toBeUndefined();

      // Response peer list must match getPeerIds() exactly (sorted).
      const peerIds = response.body.peers.map((p: { peerId: string }) => p.peerId);
      expect(peerIds).toEqual(['mill', 'store', 'town']);
    });
  });

  // --- AC 4: connected flag reflects BTPClientManager state ---

  describe('AC 4: connected flag reflects live connection state', () => {
    it('should reflect connected=true for town peer', async () => {
      const response = await request(app).get('/admin/metrics.json').expect(200);

      const townPeer = response.body.peers.find((p: { peerId: string }) => p.peerId === 'town');
      expect(townPeer.connected).toBe(true);
    });

    it('should reflect connected=false for mill peer', async () => {
      const response = await request(app).get('/admin/metrics.json').expect(200);

      const millPeer = response.body.peers.find((p: { peerId: string }) => p.peerId === 'mill');
      expect(millPeer.connected).toBe(false);
    });
  });

  // --- AC 5: 503 when observability not wired ---

  describe('AC 5: Graceful degradation when metrics registry unavailable', () => {
    it('should return 503 when metricsRegistry is not provided', async () => {
      const appNoMetrics = express();
      const config: AdminAPIConfig = {
        routingTable: mockRoutingTable,
        btpClientManager: mockBTPClientManager,
        logger: mockLogger,
        nodeId: 'test-node',
        // metricsRegistry is undefined (not provided)
      };

      const router = await createAdminRouter(config);
      appNoMetrics.use('/admin', router);

      const response = await request(appNoMetrics).get('/admin/metrics.json').expect(503);

      expect(response.body.error).toBe('Service Unavailable');
      expect(response.body.message).toBe('Metrics not enabled');
    });
  });

  // --- AC 6: Latency budget ---

  describe('AC 6: Latency budget', () => {
    it('should respond within 100ms for 10 registered peers', async () => {
      // Create registry with 10 peers
      const largeMetricsRegistry = new IlpMetricsRegistry({ collectDefaults: false });
      for (let i = 0; i < 10; i++) {
        largeMetricsRegistry.registerPeer(`peer-${i}`);
        largeMetricsRegistry.recordForwardFulfill(`peer-${i}`, 100);
      }

      const largeApp = express();
      const config: AdminAPIConfig = {
        routingTable: mockRoutingTable,
        btpClientManager: mockBTPClientManager,
        logger: mockLogger,
        nodeId: 'test-node',
        metricsRegistry: largeMetricsRegistry,
      };

      const router = await createAdminRouter(config);
      largeApp.use('/admin', router);

      const start = Date.now();
      await request(largeApp).get('/admin/metrics.json').expect(200);
      const latency = Date.now() - start;

      // AC 6: p95 response time < 100ms
      expect(latency).toBeLessThan(100);
    });
  });

  // --- lastPacketAt timestamp format ---

  describe('lastPacketAt timestamp format', () => {
    it('should be ISO-8601 string for peer with activity', async () => {
      const response = await request(app).get('/admin/metrics.json').expect(200);

      const townPeer = response.body.peers.find((p: { peerId: string }) => p.peerId === 'town');
      expect(townPeer.lastPacketAt).toBeDefined();
      expect(townPeer.lastPacketAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should be null for peer with no activity', async () => {
      const response = await request(app).get('/admin/metrics.json').expect(200);

      const millPeer = response.body.peers.find((p: { peerId: string }) => p.peerId === 'mill');
      expect(millPeer.lastPacketAt).toBeNull();
    });
  });
});
