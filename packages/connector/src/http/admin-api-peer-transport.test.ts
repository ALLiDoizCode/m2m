/**
 * Unit tests for per-peer transport selection in the Admin API
 * (per-peer-transport tech spec, Task 9a / AC-1, AC-2, AC-4, AC-6, AC-10).
 *
 * Real Express app via `createAdminRouter`, real `BTPClientManager`,
 * real `RoutingTable`, real local WS echo server. **No mocks** (AC-7) —
 * lives in a NEW file to avoid contaminating the legacy
 * `admin-api-peers.test.ts` mocked harness (Task 9b deferred cleanup).
 */

import http from 'http';
import { AddressInfo } from 'net';
import express, { Express } from 'express';
import request from 'supertest';
import pino from 'pino';
import { WebSocketServer } from 'ws';

import { createAdminRouter, AdminAPIConfig } from './admin-api';
import { RoutingTable } from '../routing/routing-table';
import { BTPClientManager } from '../btp/btp-client-manager';
import type { Logger } from '../utils/logger';

function silentLogger(): Logger {
  return pino({ level: 'silent' }) as unknown as Logger;
}

/**
 * Spin up a tiny WebSocket server on an ephemeral port. Accepts the
 * connection and replies to anything with a no-op so BTPClient's auth
 * handshake doesn't hang — the test doesn't care about auth, only that
 * `addPeer` settles quickly without throwing.
 */
async function startBareWsServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (ws) => {
    // Accept silently. BTPClient will fail auth-timeout (5s) but that path
    // logs a warning and does not throw — the admin POST handler still
    // returns 201 and the peer remains in the BTPClientManager registry.
    ws.on('error', () => {
      /* swallow */
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => httpServer.close(() => resolve()));
      }),
  };
}

interface Harness {
  app: Express;
  manager: BTPClientManager;
}

function buildHarness(transportType: 'direct' | 'socks5'): Promise<Harness> {
  const logger = silentLogger();
  const routingTable = new RoutingTable(undefined, {
    info: () => {},
    error: () => {},
  });
  const manager = new BTPClientManager('test-node', logger);

  const adminConfig: AdminAPIConfig = {
    routingTable,
    btpClientManager: manager,
    logger,
    nodeId: 'test-node',
    transportType,
  };

  const app = express();
  return createAdminRouter(adminConfig).then((router) => {
    app.use('/admin', router);
    return { app, manager };
  });
}

describe('Admin API per-peer transport (per-peer-transport tech spec, Task 9a)', () => {
  let wsServer: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    wsServer = await startBareWsServer();
  });

  afterAll(async () => {
    await wsServer.close();
  });

  /**
   * Helper: register a peer and remove the per-POST 1s connection-status
   * delay's effect on suite runtime by not awaiting it where unnecessary.
   * (The 1s delay is fixed in the handler — Story 20.4 — and we accept it.)
   */

  describe('Case 1 — direct override on socks5-global connector', () => {
    it("POST /peers with transport: 'direct' returns 201 and GET /peers lists transport: 'direct'", async () => {
      const { app, manager } = await buildHarness('socks5');
      const res = await request(app).post('/admin/peers').send({
        id: 'peer-direct-on-socks5',
        url: wsServer.url,
        authToken: '',
        transport: 'direct',
      });
      expect(res.status).toBe(201);
      expect(res.body.peer).toMatchObject({
        id: 'peer-direct-on-socks5',
        transport: 'direct',
      });

      const list = await request(app).get('/admin/peers');
      expect(list.status).toBe(200);
      const entry = list.body.peers.find((p: { id: string }) => p.id === 'peer-direct-on-socks5');
      expect(entry).toBeDefined();
      expect(entry.transport).toBe('direct');

      // Cleanup — disconnect BTPClient so the test process exits cleanly.
      await manager.removePeer('peer-direct-on-socks5');
    }, 15000);
  });

  describe('Case 2 — socks5 peer on socks5-global connector', () => {
    it("POST /peers with transport: 'socks5' returns 201 and GET /peers lists transport: 'socks5'", async () => {
      const { app, manager } = await buildHarness('socks5');
      const res = await request(app).post('/admin/peers').send({
        id: 'peer-socks5-on-socks5',
        url: wsServer.url,
        authToken: '',
        transport: 'socks5',
      });
      expect(res.status).toBe(201);
      expect(res.body.peer.transport).toBe('socks5');

      const list = await request(app).get('/admin/peers');
      const entry = list.body.peers.find((p: { id: string }) => p.id === 'peer-socks5-on-socks5');
      expect(entry.transport).toBe('socks5');

      await manager.removePeer('peer-socks5-on-socks5');
    }, 15000);
  });

  describe('Case 3 — 400 on socks5 peer when connector is direct-global (AC-4)', () => {
    it("POST /peers with transport: 'socks5' on a direct-global connector returns 400 and does NOT list the peer", async () => {
      const { app } = await buildHarness('direct');
      const res = await request(app).post('/admin/peers').send({
        id: 'peer-rejected',
        url: wsServer.url,
        authToken: '',
        transport: 'socks5',
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'Bad request',
        message: "transport: 'socks5' requires connector-level transport.type 'socks5'",
      });

      const list = await request(app).get('/admin/peers');
      const entry = list.body.peers.find((p: { id: string }) => p.id === 'peer-rejected');
      expect(entry).toBeUndefined();
    });
  });

  describe('Case 4 — invalid transport enum value', () => {
    it("POST /peers with transport: 'invalid' returns 400 with the enum-validation message", async () => {
      const { app } = await buildHarness('socks5');
      const res = await request(app).post('/admin/peers').send({
        id: 'peer-invalid',
        url: wsServer.url,
        authToken: '',
        transport: 'invalid',
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'Bad request',
        message: "Invalid transport: must be 'direct' or 'socks5' (got 'invalid')",
      });
    });
  });

  describe('Case 5 — backwards-compat regression guard (AC-6)', () => {
    it('POST /peers without a transport field on either global type returns 201', async () => {
      const directH = await buildHarness('direct');
      const r1 = await request(directH.app).post('/admin/peers').send({
        id: 'peer-noxport-direct',
        url: wsServer.url,
        authToken: '',
      });
      expect(r1.status).toBe(201);
      // Inheriting peers have no per-peer override — surface is `undefined`.
      expect(r1.body.peer.transport).toBeUndefined();
      await directH.manager.removePeer('peer-noxport-direct');

      const socksH = await buildHarness('socks5');
      const r2 = await request(socksH.app).post('/admin/peers').send({
        id: 'peer-noxport-socks5',
        url: wsServer.url,
        authToken: '',
      });
      expect(r2.status).toBe(201);
      expect(r2.body.peer.transport).toBeUndefined();
      await socksH.manager.removePeer('peer-noxport-socks5');
    }, 30000);
  });

  describe('Case 6 — idempotent re-registration echoes the LIVE transport (AC-10, F10)', () => {
    it("first POST with transport: 'direct' on socks5-global; second POST with transport: 'socks5' returns 200 and the response echoes 'direct'", async () => {
      const { app, manager } = await buildHarness('socks5');

      const first = await request(app).post('/admin/peers').send({
        id: 'peer-rereg',
        url: wsServer.url,
        authToken: '',
        transport: 'direct',
      });
      expect(first.status).toBe(201);
      expect(first.body.peer.transport).toBe('direct');

      const second = await request(app).post('/admin/peers').send({
        id: 'peer-rereg',
        url: wsServer.url,
        authToken: '',
        transport: 'socks5',
      });
      // Re-registration: 200, not 201; transport echoes LIVE value, not the
      // requested one — re-registration cannot change a peer's live transport.
      expect(second.status).toBe(200);
      expect(second.body.updated).toBe(true);
      expect(second.body.peer.transport).toBe('direct');
      // BTPClientManager confirms the live transport stayed 'direct'.
      expect(manager.getPeerTransport('peer-rereg')).toBe('direct');

      await manager.removePeer('peer-rereg');
    }, 15000);
  });

  describe('Case 7 — PUT /peers/:peerId does NOT accept transport (Decision 9)', () => {
    it("PUT body { transport: 'socks5' } returns 200 and leaves the peer transport unchanged", async () => {
      const { app, manager } = await buildHarness('socks5');

      // Seed a peer with explicit transport: 'direct'.
      const seed = await request(app).post('/admin/peers').send({
        id: 'peer-put-target',
        url: wsServer.url,
        authToken: '',
        transport: 'direct',
      });
      expect(seed.status).toBe(201);

      const put = await request(app)
        .put('/admin/peers/peer-put-target')
        .send({ transport: 'socks5' });
      // PUT destructures { settlement?, routes? } only — unknown fields are
      // silently ignored by Express's req.body parsing. The handler returns
      // its normal 200 response shape (no transport mutation).
      expect(put.status).toBe(200);

      // Live transport must still be 'direct'.
      expect(manager.getPeerTransport('peer-put-target')).toBe('direct');
      const list = await request(app).get('/admin/peers');
      const entry = list.body.peers.find((p: { id: string }) => p.id === 'peer-put-target');
      expect(entry.transport).toBe('direct');

      await manager.removePeer('peer-put-target');
    }, 15000);
  });
});
