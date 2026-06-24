/**
 * Unit tests for relation↔route admission validation, child auto-route, and
 * registry write-through on the admin HTTP surface (POST/DELETE /admin/peers,
 * POST /admin/routes).
 *
 * Mirrors the harness style of admin-api-peers.test.ts.
 */

import request from 'supertest';
import express, { Express } from 'express';
import { createAdminRouter, AdminAPIConfig, RegistryPeerSink } from './admin-api';
import type { Logger } from 'pino';
import type { RoutingTable } from '../routing/routing-table';
import type { BTPClientManager } from '../btp/btp-client-manager';
import type { PeerRelation } from '../config/types';

describe('Admin API — relation/route admission + persistence', () => {
  let app: Express;
  let mockRoutingTable: jest.Mocked<RoutingTable>;
  let mockBTPClientManager: jest.Mocked<BTPClientManager>;
  let mockLogger: jest.Mocked<Logger>;
  let registryStore: jest.Mocked<RegistryPeerSink>;
  let relationByPeer: Map<string, PeerRelation>;

  // The connector's own address: a route that terminates locally (nextHop === nodeId).
  const selfRoute = { prefix: 'g.connector', nextHop: 'test-node', priority: 0 };

  beforeEach(async () => {
    relationByPeer = new Map();
    mockRoutingTable = {
      addRoute: jest.fn(),
      removeRoute: jest.fn(),
      getAllRoutes: jest.fn().mockReturnValue([selfRoute]),
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

    registryStore = {
      savePeer: jest.fn(),
      deletePeer: jest.fn(),
    };

    const config: AdminAPIConfig = {
      routingTable: mockRoutingTable,
      btpClientManager: mockBTPClientManager,
      logger: mockLogger,
      nodeId: 'test-node',
      registryStore,
      setPeerRelation: (peerId, relation) => relationByPeer.set(peerId, relation),
      getPeerRelation: (peerId) => relationByPeer.get(peerId),
    };

    app = express();
    app.use('/admin', await createAdminRouter(config));
  });

  afterEach(() => jest.clearAllMocks());

  it('rejects a child peer whose route is not under the connector address (400)', async () => {
    const res = await request(app)
      .post('/admin/peers')
      .send({
        id: 'town',
        url: 'ws://town:3000',
        authToken: 't',
        relation: 'child',
        routes: [{ prefix: 'g.other.town' }],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("must be under the connector's own address");
    expect(mockBTPClientManager.addPeer).not.toHaveBeenCalled();
  });

  it('auto-derives <self>.<peerId> for a child peer registered without a route', async () => {
    const res = await request(app)
      .post('/admin/peers')
      .send({ id: 'town', url: 'ws://town:3000', authToken: 't', relation: 'child' });

    expect(res.status).toBe(201);
    expect(mockRoutingTable.addRoute).toHaveBeenCalledWith('g.connector.town', 'town', 0);
    expect(res.body.routes).toContain('g.connector.town');
  });

  it('accepts a child peer whose route is under the connector address', async () => {
    const res = await request(app)
      .post('/admin/peers')
      .send({
        id: 'town',
        url: 'ws://town:3000',
        authToken: 't',
        relation: 'child',
        routes: [{ prefix: 'g.connector.town' }],
      });

    expect(res.status).toBe(201);
    expect(mockRoutingTable.addRoute).toHaveBeenCalledWith('g.connector.town', 'town', 0);
  });

  it('writes the peer through to the registry store on registration', async () => {
    await request(app)
      .post('/admin/peers')
      .send({ id: 'town', url: 'ws://town:3000', authToken: 't', relation: 'child' });

    expect(registryStore.savePeer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'town', relation: 'child', source: 'runtime' })
    );
  });

  it('deletes the peer from the registry store on removal', async () => {
    mockBTPClientManager.getPeerIds.mockReturnValue(['town']);
    await request(app).delete('/admin/peers/town');
    expect(registryStore.deletePeer).toHaveBeenCalledWith('town');
  });

  it('rejects POST /admin/routes when the nextHop child route escapes the subtree (400)', async () => {
    relationByPeer.set('town', 'child');
    const res = await request(app)
      .post('/admin/routes')
      .send({ prefix: 'g.other.town', nextHop: 'town' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("must be under the connector's own address");
    expect(mockRoutingTable.addRoute).not.toHaveBeenCalled();
  });

  it('allows POST /admin/routes for a peer-relation nextHop (no subtree constraint)', async () => {
    relationByPeer.set('lateral', 'peer');
    const res = await request(app)
      .post('/admin/routes')
      .send({ prefix: 'g.somewhere.else', nextHop: 'lateral' });

    expect(res.status).toBe(201);
    expect(mockRoutingTable.addRoute).toHaveBeenCalledWith('g.somewhere.else', 'lateral', 0);
  });
});
