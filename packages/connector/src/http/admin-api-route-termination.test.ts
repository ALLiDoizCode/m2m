/**
 * Tests for issue #218 — runtime route-termination config via the admin API.
 *
 * Exercises a REAL express admin router against a REAL RoutingTable and a REAL
 * RouteTerminationRegistry (the seam #216's HttpProxyHandler resolves against),
 * with supertest driving HTTP. Only the BTPClientManager is a thin in-memory
 * peer-list stand-in (it owns WS sockets we don't exercise here); every
 * component under test — config validation, registry reconciliation, the
 * desired-state diff — is the production implementation.
 *
 * Covers:
 *  - PUT /admin/desired-state with a terminated route → registry resolves it.
 *  - Invalid body (bad price / unknown chain) → atomic 400, registry unchanged.
 *  - Reconciliation: seed route A, PUT only B → A removed, B present, local
 *    self-routes preserved; idempotent on re-PUT.
 *  - POST /admin/routes with termination → registry + match() round-trip.
 *
 * @module http/admin-api-route-termination.test
 */

import request from 'supertest';
import express, { Express } from 'express';
import { createAdminRouter, AdminAPIConfig } from './admin-api';
import { RoutingTable } from '../routing/routing-table';
import { RouteTerminationRegistry } from '../core/route-upstream-registry';
import type { Logger } from 'pino';
import type { BTPClientManager } from '../btp/btp-client-manager';
import type { RouteTermination } from '../config/types';

const evmTermination: RouteTermination = {
  upstream: 'http://127.0.0.1:8080',
  price: '1000',
  chains: ['evm', 'solana', 'mina'],
  ilpAddress: 'g.node.greet',
  settlementAddresses: { evm: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28' },
};

describe('issue #218 — runtime route termination (admin API)', () => {
  let app: Express;
  let routingTable: RoutingTable;
  let registry: RouteTerminationRegistry;
  let peerIds: string[];

  const nodeId = 'test-node';
  const selfPrefix = 'g.node';

  const makeLogger = (): Logger =>
    ({
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
      child() {
        return this;
      },
    }) as unknown as Logger;

  // Minimal in-memory BTP peer registry — not the unit under test.
  const makeBtp = (): BTPClientManager =>
    ({
      addPeer: async (peer: { id: string }) => {
        peerIds.push(peer.id);
      },
      removePeer: async (id: string) => {
        peerIds = peerIds.filter((p) => p !== id);
      },
      getPeerIds: () => [...peerIds],
      getPeerStatus: () => new Map(),
      isConnected: () => true,
      getPeerTransport: () => undefined,
    }) as unknown as BTPClientManager;

  beforeEach(async () => {
    peerIds = [];
    // Real routing table seeded with the connector's own local self-route.
    routingTable = new RoutingTable(
      [{ prefix: selfPrefix, nextHop: nodeId, priority: 0 }],
      makeLogger()
    );
    registry = new RouteTerminationRegistry();

    const config: AdminAPIConfig = {
      routingTable,
      btpClientManager: makeBtp(),
      logger: makeLogger(),
      nodeId,
      routeTerminationRegistry: registry,
    };
    app = express();
    app.use('/admin', await createAdminRouter(config));
  });

  it('PUT desired-state with a terminated route → registry resolves it', async () => {
    const res = await request(app)
      .put('/admin/desired-state')
      .send({ routes: [{ prefix: 'g.node.greet', nextHop: nodeId, ...evmTermination }] });

    expect(res.status).toBe(200);
    expect(registry.size).toBe(1);
    const matched = registry.match('g.node.greet.v1');
    expect(matched?.upstream).toBe('http://127.0.0.1:8080');
    expect(matched?.price).toBe('1000');
    expect(matched?.chains).toEqual(['evm', 'solana', 'mina']);
    // resolveUpstream is the #216 seam.
    expect(
      registry.resolveUpstream({
        destination: 'g.node.greet.v1',
        amount: '1',
        expiresAt: new Date().toISOString(),
        data: '',
        sourcePeer: 'payer',
      })
    ).toBe('http://127.0.0.1:8080');
  });

  it('rejects atomically (400, registry untouched) on an invalid price', async () => {
    const res = await request(app)
      .put('/admin/desired-state')
      .send({
        routes: [{ prefix: 'g.node.greet', nextHop: nodeId, ...evmTermination, price: 'NaN' }],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/price must be a non-negative integer string/);
    expect(registry.size).toBe(0);
    // No route mutation either (atomic).
    expect(
      routingTable
        .getAllRoutes()
        .map((r) => r.prefix)
        .sort()
    ).toEqual([selfPrefix]);
  });

  it('rejects atomically on an unknown chain', async () => {
    const res = await request(app)
      .put('/admin/desired-state')
      .send({
        routes: [
          {
            prefix: 'g.node.greet',
            nextHop: nodeId,
            ...evmTermination,
            chains: ['evm', 'doge'] as unknown as RouteTermination['chains'],
          },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/unknown termination chain/);
    expect(registry.size).toBe(0);
  });

  it('reconciles: seed A, PUT only B → A removed, B present, self-route preserved', async () => {
    // Seed terminated route A both in the routing table and registry.
    routingTable.addRoute('g.node.a' as never, nodeId, 0);
    registry.set('g.node.a', { ...evmTermination, ilpAddress: 'g.node.a' });
    expect(registry.size).toBe(1);

    const res = await request(app)
      .put('/admin/desired-state')
      .send({
        routes: [
          { prefix: 'g.node.b', nextHop: nodeId, ...evmTermination, ilpAddress: 'g.node.b' },
        ],
      });

    expect(res.status).toBe(200);
    // A removed from the registry, B present.
    expect(registry.lookup('g.node.a')).toBeUndefined();
    expect(registry.lookup('g.node.b')?.ilpAddress).toBe('g.node.b');
    expect(registry.size).toBe(1);
    // The connector's own local self-route is preserved in the routing table.
    expect(routingTable.getAllRoutes().some((r) => r.prefix === selfPrefix)).toBe(true);
  });

  it('is idempotent on a re-PUT of the same terminated route', async () => {
    const body = { routes: [{ prefix: 'g.node.greet', nextHop: nodeId, ...evmTermination }] };
    await request(app).put('/admin/desired-state').send(body);
    const res = await request(app).put('/admin/desired-state').send(body);
    expect(res.status).toBe(200);
    expect(registry.size).toBe(1);
    expect(registry.lookup('g.node.greet')?.upstream).toBe('http://127.0.0.1:8080');
  });

  it('a re-PUT dropping termination flips the route back to plain forwarding', async () => {
    await request(app)
      .put('/admin/desired-state')
      .send({ routes: [{ prefix: 'g.node.greet', nextHop: nodeId, ...evmTermination }] });
    expect(registry.size).toBe(1);
    // Re-PUT the same prefix without termination fields.
    const res = await request(app)
      .put('/admin/desired-state')
      .send({ routes: [{ prefix: 'g.node.greet', nextHop: nodeId }] });
    expect(res.status).toBe(200);
    expect(registry.lookup('g.node.greet')).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('POST /admin/routes with termination → registry match() round-trip', async () => {
    const res = await request(app)
      .post('/admin/routes')
      .send({ prefix: 'g.node.greet', nextHop: nodeId, ...evmTermination });
    expect(res.status).toBe(201);
    expect(registry.match('g.node.greet.v9')?.upstream).toBe('http://127.0.0.1:8080');
  });

  it('POST /admin/routes rejects invalid termination with 400 (registry untouched)', async () => {
    const res = await request(app)
      .post('/admin/routes')
      .send({ prefix: 'g.node.greet', nextHop: nodeId, ...evmTermination, upstream: 'ftp://nope' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/upstream must be an http\(s\) URL/);
    expect(registry.size).toBe(0);
  });
});
