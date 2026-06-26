/**
 * Unit tests for PUT /admin/desired-state declarative reconciliation.
 */

import request from 'supertest';
import express, { Express } from 'express';
import { createAdminRouter, AdminAPIConfig, RegistryPeerSink } from './admin-api';
import type { Logger } from 'pino';
import type { RoutingTable } from '../routing/routing-table';
import type { BTPClientManager } from '../btp/btp-client-manager';
import type { RoutingTableEntry } from '@toon-protocol/shared';
import type { PeerRelation } from '../config/types';

describe('Admin API — PUT /admin/desired-state', () => {
  let app: Express;
  let mockRoutingTable: jest.Mocked<RoutingTable>;
  let mockBTPClientManager: jest.Mocked<BTPClientManager>;
  let registryStore: jest.Mocked<RegistryPeerSink>;
  let routes: RoutingTableEntry[];
  let peerIds: string[];
  let relationByPeer: Map<string, PeerRelation>;

  const selfRoute: RoutingTableEntry = { prefix: 'g.connector', nextHop: 'test-node', priority: 0 };

  beforeEach(async () => {
    // In-memory route/peer state so the reconcile's read-then-mutate is realistic.
    routes = [selfRoute];
    peerIds = [];
    relationByPeer = new Map();

    mockRoutingTable = {
      addRoute: jest.fn((prefix: string, nextHop: string, priority = 0) => {
        routes = routes.filter((r) => r.prefix !== prefix);
        routes.push({ prefix, nextHop, priority });
      }),
      removeRoute: jest.fn((prefix: string) => {
        routes = routes.filter((r) => r.prefix !== prefix);
      }),
      getAllRoutes: jest.fn(() => routes.map((r) => ({ ...r }))),
    } as unknown as jest.Mocked<RoutingTable>;

    mockBTPClientManager = {
      addPeer: jest.fn(async (peer: { id: string }) => {
        peerIds.push(peer.id);
      }),
      removePeer: jest.fn(async (id: string) => {
        peerIds = peerIds.filter((p) => p !== id);
      }),
      getPeerIds: jest.fn(() => [...peerIds]),
      getPeerStatus: jest.fn(() => new Map()),
      isConnected: jest.fn().mockReturnValue(true),
      getPeerTransport: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<BTPClientManager>;

    const mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
    } as unknown as jest.Mocked<Logger>;

    registryStore = { savePeer: jest.fn(), deletePeer: jest.fn() };

    const config: AdminAPIConfig = {
      routingTable: mockRoutingTable,
      btpClientManager: mockBTPClientManager,
      logger: mockLogger,
      nodeId: 'test-node',
      registryStore,
      setPeerRelation: (id, rel) => relationByPeer.set(id, rel),
      getPeerRelation: (id) => relationByPeer.get(id),
    };

    app = express();
    app.use('/admin', await createAdminRouter(config));
  });

  it('adds desired peers + their auto-derived child routes', async () => {
    const res = await request(app)
      .put('/admin/desired-state')
      .send({
        peers: [{ id: 'relay', url: 'ws://relay:3000', authToken: 't', relation: 'child' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.peers.added).toEqual(['relay']);
    expect(mockRoutingTable.addRoute).toHaveBeenCalledWith('g.connector.relay', 'relay', 0);
    expect(registryStore.savePeer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'relay', source: 'runtime' })
    );
  });

  it('removes peers and their routes not in the desired set', async () => {
    // Seed an existing peer 'swap' with a route.
    peerIds = ['swap'];
    routes = [selfRoute, { prefix: 'g.connector.swap', nextHop: 'swap', priority: 0 }];

    const res = await request(app)
      .put('/admin/desired-state')
      .send({
        peers: [{ id: 'relay', url: 'ws://relay:3000', authToken: 't', relation: 'child' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.peers.removed).toEqual(['swap']);
    expect(mockBTPClientManager.removePeer).toHaveBeenCalledWith('swap');
    expect(registryStore.deletePeer).toHaveBeenCalledWith('swap');
    // swap's route gone, relay's route present, self route preserved.
    const prefixes = routes.map((r) => r.prefix).sort();
    expect(prefixes).toEqual(['g.connector', 'g.connector.relay']);
  });

  it("never removes the connector's own local routes", async () => {
    await request(app).put('/admin/desired-state').send({ peers: [], routes: [] });
    expect(routes.some((r) => r.prefix === 'g.connector')).toBe(true);
    expect(mockRoutingTable.removeRoute).not.toHaveBeenCalledWith('g.connector');
  });

  it('rejects atomically (400, no mutation) when a child route escapes the subtree', async () => {
    const res = await request(app)
      .put('/admin/desired-state')
      .send({
        peers: [
          {
            id: 'relay',
            url: 'ws://relay:3000',
            authToken: 't',
            relation: 'child',
            routes: [{ prefix: 'g.other.relay' }],
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("must be under the connector's own address");
    expect(mockBTPClientManager.addPeer).not.toHaveBeenCalled();
    expect(mockRoutingTable.addRoute).not.toHaveBeenCalled();
  });

  it('is idempotent: re-PUT of the same state adds/removes nothing new', async () => {
    const body = {
      peers: [{ id: 'relay', url: 'ws://relay:3000', authToken: 't', relation: 'child' as const }],
    };
    await request(app).put('/admin/desired-state').send(body);
    const res = await request(app).put('/admin/desired-state').send(body);

    expect(res.status).toBe(200);
    expect(res.body.peers.added).toEqual([]);
    expect(res.body.peers.removed).toEqual([]);
    expect(res.body.routes.removed).toEqual([]);
  });
});
