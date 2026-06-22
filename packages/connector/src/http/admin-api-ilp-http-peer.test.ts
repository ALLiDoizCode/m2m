/**
 * Admin API registration for ILP-over-HTTP peers (Epic 38, Story 38.1).
 *
 * Real Express app via `createAdminRouter`, real `BTPClientManager`, real
 * `HttpPeerClientManager`, real `RoutingTable`, and a real `node:http` ILP
 * receiver fixture. No mocks.
 */

import express, { Express } from 'express';
import request from 'supertest';
import pino from 'pino';

import { createAdminRouter, AdminAPIConfig } from './admin-api';
import { RoutingTable } from '../routing/routing-table';
import { BTPClientManager } from '../btp/btp-client-manager';
import { HttpPeerClientManager } from '../transport/http-peer-transport';
import { DirectTransportProvider } from '../transport/direct-transport-provider';
import { HttpPeerTestServer } from '../../test/fixtures/http-peer-test-server';
import type { Logger } from '../utils/logger';

const silentLogger = (): Logger => pino({ level: 'silent' }) as unknown as Logger;

interface Harness {
  app: Express;
  btp: BTPClientManager;
  http: HttpPeerClientManager;
  protocols: Map<string, 'btp' | 'ilp-http'>;
}

const buildHarness = async (withHttpEgress = true): Promise<Harness> => {
  const logger = silentLogger();
  const routingTable = new RoutingTable(undefined, { info: () => {}, error: () => {} });
  const btp = new BTPClientManager('test-node', logger);
  const httpMgr = new HttpPeerClientManager(
    'test-node',
    logger,
    new DirectTransportProvider('ws://localhost:9999')
  );
  const protocols = new Map<string, 'btp' | 'ilp-http'>();

  const adminConfig: AdminAPIConfig = {
    routingTable,
    btpClientManager: btp,
    logger,
    nodeId: 'test-node',
    httpPeerEgress: withHttpEgress ? httpMgr : undefined,
    setPeerProtocol: withHttpEgress ? (id, p) => protocols.set(id, p) : undefined,
  };

  const app = express();
  const router = await createAdminRouter(adminConfig);
  app.use('/admin', router);
  return { app, btp, http: httpMgr, protocols };
};

describe('Admin API — ILP-over-HTTP peer registration (Epic 38)', () => {
  let server: HttpPeerTestServer;

  beforeEach(async () => {
    server = new HttpPeerTestServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('registers an ilp-http peer with the HTTP egress (not BTP)', async () => {
    const h = await buildHarness();
    const res = await request(h.app)
      .post('/admin/peers')
      .send({ id: 'hp', authToken: 'tok', peerProtocol: 'ilp-http', httpUrl: server.url });

    expect(res.status).toBeLessThan(300);
    expect(h.http.getPeerIds()).toContain('hp');
    expect(h.btp.getPeerIds()).not.toContain('hp');
    expect(h.protocols.get('hp')).toBe('ilp-http');
  });

  it('rejects an ilp-http peer with no httpUrl (400)', async () => {
    const h = await buildHarness();
    const res = await request(h.app)
      .post('/admin/peers')
      .send({ id: 'hp', authToken: 'tok', peerProtocol: 'ilp-http' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/requires httpUrl/);
  });

  it('rejects an invalid peerProtocol (400)', async () => {
    const h = await buildHarness();
    const res = await request(h.app)
      .post('/admin/peers')
      .send({ id: 'hp', url: 'ws://h:1', authToken: 'tok', peerProtocol: 'grpc' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid peerProtocol/);
  });

  it('rejects ilp-http when no HTTP egress is wired (400)', async () => {
    const h = await buildHarness(false);
    const res = await request(h.app)
      .post('/admin/peers')
      .send({ id: 'hp', authToken: 'tok', peerProtocol: 'ilp-http', httpUrl: server.url });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not available/);
  });

  it('a default (btp) peer still requires ws:// — unchanged', async () => {
    const h = await buildHarness();
    const res = await request(h.app)
      .post('/admin/peers')
      .send({ id: 'btppeer', url: 'http://wrong:1', authToken: 'tok' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/ws:\/\//);
  });
});
