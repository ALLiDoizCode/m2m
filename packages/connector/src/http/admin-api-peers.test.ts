/**
 * Unit Tests for Admin API Peer Registration Endpoints (Story 20.4)
 *
 * Tests idempotent POST /admin/peers (create, update, merge) and
 * PUT /admin/peers/:peerId (partial update, 404 handling).
 *
 * @module http/admin-api-peers.test
 */

import request from 'supertest';
import express, { Express } from 'express';
import { createAdminRouter, AdminAPIConfig } from './admin-api';
import type { PeerConfig as SettlementPeerConfig } from '../settlement/types';
import type { Logger } from 'pino';
import type { RoutingTable } from '../routing/routing-table';
import type { BTPClientManager } from '../btp/btp-client-manager';

describe('Admin API Peer Endpoints (Story 20.4)', () => {
  let app: Express;
  let mockRoutingTable: jest.Mocked<RoutingTable>;
  let mockBTPClientManager: jest.Mocked<BTPClientManager>;
  let mockLogger: jest.Mocked<Logger>;
  let settlementPeers: Map<string, SettlementPeerConfig>;

  const validPeerRequest = {
    id: 'peer-a',
    url: 'ws://peer-a:3000',
    authToken: 'token-a',
  };

  const validSettlement = {
    preference: 'evm' as const,
    evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
    chainId: 8453,
  };

  beforeEach(async () => {
    settlementPeers = new Map();

    mockRoutingTable = {
      addRoute: jest.fn(),
      removeRoute: jest.fn(),
      getAllRoutes: jest.fn().mockReturnValue([]),
      lookup: jest.fn(),
      removeRoutesForPeer: jest.fn(),
    } as unknown as jest.Mocked<RoutingTable>;

    mockBTPClientManager = {
      addPeer: jest.fn().mockResolvedValue(undefined),
      removePeer: jest.fn().mockResolvedValue(undefined),
      getPeerIds: jest.fn().mockReturnValue([]),
      getPeerStatus: jest.fn().mockReturnValue(new Map()),
      isConnected: jest.fn().mockReturnValue(false),
      getConnectedPeers: jest.fn().mockReturnValue([]),
      getClientForPeer: jest.fn(),
      // Per-peer transport selection: additive mock for the new accessor
      // used by GET /admin/peers + the re-reg POST response payload.
      getPeerTransport: jest.fn().mockReturnValue(undefined),
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

    const config: AdminAPIConfig = {
      routingTable: mockRoutingTable,
      btpClientManager: mockBTPClientManager,
      logger: mockLogger,
      nodeId: 'test-node',
      settlementPeers,
    };

    app = express();
    app.use('/admin', await createAdminRouter(config));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /admin/peers — Idempotent Registration', () => {
    it('should create new peer and return 201 with created: true', async () => {
      const res = await request(app).post('/admin/peers').send(validPeerRequest);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.created).toBe(true);
      expect(res.body.peer.id).toBe('peer-a');
      expect(mockBTPClientManager.addPeer).toHaveBeenCalledTimes(1);
    });

    it('should return 200 with updated: true on re-registration', async () => {
      // First call creates the peer
      mockBTPClientManager.getPeerIds.mockReturnValue([]);
      await request(app).post('/admin/peers').send(validPeerRequest);

      // Second call — peer already exists
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer-a']);
      const res = await request(app).post('/admin/peers').send(validPeerRequest);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.updated).toBe(true);
      expect(res.body.peer.id).toBe('peer-a');
    });

    it('should merge settlement config on re-registration (new fields overwrite, omitted preserved)', async () => {
      // First registration with initial settlement
      mockBTPClientManager.getPeerIds.mockReturnValue([]);
      await request(app)
        .post('/admin/peers')
        .send({
          ...validPeerRequest,
          settlement: {
            preference: 'evm',
            evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
            chainId: 8453,
            initialDeposit: '1000000',
          },
        });

      // Verify initial config stored
      const initialConfig = settlementPeers.get('peer-a');
      expect(initialConfig?.evmAddress).toBe('0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28');
      expect(initialConfig?.chainId).toBe(8453);
      expect(initialConfig?.initialDeposit).toBe('1000000');

      // Re-register with updated settlement — only update tokenAddress, preserve chainId/initialDeposit
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer-a']);
      const res = await request(app)
        .post('/admin/peers')
        .send({
          ...validPeerRequest,
          settlement: {
            preference: 'evm',
            evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
            tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          },
        });

      expect(res.status).toBe(200);

      // Verify merged config
      const mergedConfig = settlementPeers.get('peer-a');
      expect(mergedConfig?.evmAddress).toBe('0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28');
      expect(mergedConfig?.tokenAddress).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
      // Preserved from initial registration
      expect(mergedConfig?.chainId).toBe(8453);
      expect(mergedConfig?.initialDeposit).toBe('1000000');
    });

    it('should add new routes on re-registration without removing existing', async () => {
      // First registration with route
      mockBTPClientManager.getPeerIds.mockReturnValue([]);
      await request(app)
        .post('/admin/peers')
        .send({
          ...validPeerRequest,
          routes: [{ prefix: 'g.connector.alice', priority: 10 }],
        });

      expect(mockRoutingTable.addRoute).toHaveBeenCalledWith('g.connector.alice', 'peer-a', 10);
      mockRoutingTable.addRoute.mockClear();

      // Re-register with additional route
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer-a']);
      const res = await request(app)
        .post('/admin/peers')
        .send({
          ...validPeerRequest,
          routes: [{ prefix: 'g.connector.bob', priority: 5 }],
        });

      expect(res.status).toBe(200);
      // New route added
      expect(mockRoutingTable.addRoute).toHaveBeenCalledWith('g.connector.bob', 'peer-a', 5);
      // removeRoute never called — existing routes preserved
      expect(mockRoutingTable.removeRoute).not.toHaveBeenCalled();
    });

    it('should not update BTP connection on re-registration', async () => {
      // First registration
      mockBTPClientManager.getPeerIds.mockReturnValue([]);
      await request(app).post('/admin/peers').send(validPeerRequest);
      expect(mockBTPClientManager.addPeer).toHaveBeenCalledTimes(1);

      mockBTPClientManager.addPeer.mockClear();

      // Re-registration — BTP addPeer should NOT be called again
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer-a']);
      const res = await request(app).post('/admin/peers').send(validPeerRequest);

      expect(res.status).toBe(200);
      expect(mockBTPClientManager.addPeer).not.toHaveBeenCalled();
    });
  });

  describe('PUT /admin/peers/:peerId', () => {
    it('should update settlement config and return 200', async () => {
      // Peer must exist
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer-a']);

      const res = await request(app)
        .put('/admin/peers/peer-a')
        .send({ settlement: validSettlement });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.peerId).toBe('peer-a');
      expect(res.body.updated).toBe(true);

      // Verify settlement stored
      const config = settlementPeers.get('peer-a');
      expect(config?.evmAddress).toBe('0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28');
      expect(config?.settlementPreference).toBe('evm');
    });

    it('should return 404 for unknown peerId', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue([]);

      const res = await request(app)
        .put('/admin/peers/unknown-peer')
        .send({ settlement: validSettlement });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not found');
      expect(res.body.message).toBe('Peer not found');
    });

    it('should accept partial update (routes only)', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer-a']);

      const res = await request(app)
        .put('/admin/peers/peer-a')
        .send({
          routes: [{ prefix: 'g.connector.charlie', priority: 3 }],
        });

      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(true);
      expect(mockRoutingTable.addRoute).toHaveBeenCalledWith('g.connector.charlie', 'peer-a', 3);
    });

    it('should accept partial update (settlement only)', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer-a']);

      const res = await request(app)
        .put('/admin/peers/peer-a')
        .send({ settlement: validSettlement });

      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(true);
      expect(mockRoutingTable.addRoute).not.toHaveBeenCalled();

      const config = settlementPeers.get('peer-a');
      expect(config?.evmAddress).toBe('0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28');
    });

    it('should merge settlement into existing config on PUT', async () => {
      mockBTPClientManager.getPeerIds.mockReturnValue(['peer-a']);

      // Set existing config
      settlementPeers.set('peer-a', {
        peerId: 'peer-a',
        address: 'g.peer-a',
        settlementPreference: 'evm',
        settlementTokens: ['EVM'],
        evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
        chainId: 8453,
        initialDeposit: '500000',
      });

      // Update with new tokenAddress — should preserve chainId/initialDeposit
      const res = await request(app)
        .put('/admin/peers/peer-a')
        .send({
          settlement: {
            preference: 'evm',
            evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
            tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          },
        });

      expect(res.status).toBe(200);

      const config = settlementPeers.get('peer-a');
      expect(config?.tokenAddress).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
      expect(config?.chainId).toBe(8453);
      expect(config?.initialDeposit).toBe('500000');
    });
  });

  // Issue #76: POST /admin/peers forwards a peer's ILP relation to the
  // forwarding path via the setPeerRelation hook so a 'child' next hop skips
  // the mandatory per-packet settlement claim.
  describe('POST /admin/peers — relation propagation (issue #76)', () => {
    let setPeerRelation: jest.Mock;
    let relApp: Express;

    beforeEach(async () => {
      setPeerRelation = jest.fn();
      const config: AdminAPIConfig = {
        routingTable: mockRoutingTable,
        btpClientManager: mockBTPClientManager,
        logger: mockLogger,
        nodeId: 'test-node',
        settlementPeers,
        setPeerRelation,
      };
      relApp = express();
      relApp.use('/admin', await createAdminRouter(config));
    });

    it("propagates an explicit relation 'child' to the hook and echoes it", async () => {
      const res = await request(relApp)
        .post('/admin/peers')
        .send({ ...validPeerRequest, relation: 'child' });

      expect(res.status).toBe(201);
      expect(res.body.peer.relation).toBe('child');
      expect(setPeerRelation).toHaveBeenCalledWith('peer-a', 'child');
    });

    it("defaults an omitted relation to 'peer' when calling the hook", async () => {
      const res = await request(relApp).post('/admin/peers').send(validPeerRequest);

      expect(res.status).toBe(201);
      expect(setPeerRelation).toHaveBeenCalledWith('peer-a', 'peer');
    });

    it('rejects an invalid relation with 400 and does not call the hook', async () => {
      const res = await request(relApp)
        .post('/admin/peers')
        .send({ ...validPeerRequest, relation: 'sibling' });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe(
        "Invalid relation: must be 'parent', 'peer', or 'child' (got 'sibling')"
      );
      expect(setPeerRelation).not.toHaveBeenCalled();
      expect(mockBTPClientManager.addPeer).not.toHaveBeenCalled();
    });
  });
});
