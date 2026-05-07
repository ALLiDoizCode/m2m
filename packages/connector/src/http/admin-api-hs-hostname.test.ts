/**
 * Unit tests for `GET /admin/hs-hostname` (Story 38.1).
 *
 * Tests the route handler in isolation against a fake `ManagedAnonClient`
 * surface — the watcher logic itself is exercised in
 * `managed-anon-client.hostname.test.ts`.
 *
 * Coverage:
 *   - AC 1: 200 with `{ hostname, publishedAt }` after publish
 *   - AC 2: 200 with `{ hostname: null, publishedAt: null }` during bootstrap
 *   - AC 3: 503 `{ error: 'anon-disabled' }` when not configured (both sub-cases)
 *   - AC 5: snapshot is stable across repeated calls
 *   - Cache-Control / Retry-After headers
 *
 * @module http/admin-api-hs-hostname.test
 */

import request from 'supertest';
import express, { Express } from 'express';
import { createAdminRouter, AdminAPIConfig } from './admin-api';
import type { Logger } from 'pino';
import type { RoutingTable } from '../routing/routing-table';
import type { BTPClientManager } from '../btp/btp-client-manager';
import type { ManagedAnonClient } from '../transport/managed-anon-client';

interface FakeManagedAnonClientOptions {
  hiddenServiceConfigured: boolean;
  hostname: string | null;
  publishedAt: string | null;
}

function fakeManagedAnonClient(opts: FakeManagedAnonClientOptions): ManagedAnonClient {
  return {
    isHiddenServiceConfigured: () => opts.hiddenServiceConfigured,
    getHostnameSnapshot: () => ({
      hostname: opts.hostname,
      publishedAt: opts.publishedAt,
    }),
  } as unknown as ManagedAnonClient;
}

describe('Admin API GET /admin/hs-hostname (Story 38.1)', () => {
  let mockRoutingTable: jest.Mocked<RoutingTable>;
  let mockBTPClientManager: jest.Mocked<BTPClientManager>;
  let mockLogger: jest.Mocked<Logger>;

  const buildApp = async (overrides?: Partial<AdminAPIConfig>): Promise<Express> => {
    const config: AdminAPIConfig = {
      routingTable: mockRoutingTable,
      btpClientManager: mockBTPClientManager,
      logger: mockLogger,
      nodeId: 'test-node',
      ...overrides,
    };
    const router = await createAdminRouter(config);
    const app = express();
    app.use('/admin', router);
    return app;
  };

  beforeEach(() => {
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

  // --- AC 1: published hostname ---

  describe('AC 1: returns 200 with hostname after publish', () => {
    it('returns the cached hostname and publishedAt from the managed client', async () => {
      const publishedAt = '2026-05-07T18:23:14.000Z';
      const hostname = 'eag2qnhil4vpvfo2eu3qtqj3rzzkrzbmboivwwbbgzr4svfvjigoxpad.anyone';
      const app = await buildApp({
        managedAnonClient: fakeManagedAnonClient({
          hiddenServiceConfigured: true,
          hostname,
          publishedAt,
        }),
      });

      const res = await request(app).get('/admin/hs-hostname').expect(200);

      expect(res.body).toEqual({ hostname, publishedAt });
      // No `ready` field — dropped per the issue thread Q1 resolution.
      expect(res.body).not.toHaveProperty('ready');
    });

    it('sets Cache-Control: no-store and does NOT set Retry-After when published', async () => {
      const app = await buildApp({
        managedAnonClient: fakeManagedAnonClient({
          hiddenServiceConfigured: true,
          hostname: 'abc.anyone',
          publishedAt: '2026-05-07T18:23:14.000Z',
        }),
      });

      const res = await request(app).get('/admin/hs-hostname').expect(200);

      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['retry-after']).toBeUndefined();
    });
  });

  // --- AC 2: bootstrap window ---

  describe('AC 2: returns 200 with nulls during the bootstrap window', () => {
    it('returns { hostname: null, publishedAt: null } when not yet published', async () => {
      const app = await buildApp({
        managedAnonClient: fakeManagedAnonClient({
          hiddenServiceConfigured: true,
          hostname: null,
          publishedAt: null,
        }),
      });

      const res = await request(app).get('/admin/hs-hostname').expect(200);

      expect(res.body).toEqual({ hostname: null, publishedAt: null });
    });

    it('sets Retry-After: 3 on the bootstrap-window response', async () => {
      const app = await buildApp({
        managedAnonClient: fakeManagedAnonClient({
          hiddenServiceConfigured: true,
          hostname: null,
          publishedAt: null,
        }),
      });

      const res = await request(app).get('/admin/hs-hostname').expect(200);

      expect(res.headers['retry-after']).toBe('3');
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  // --- AC 3: anon-disabled (both sub-cases) ---

  describe('AC 3: returns 503 anon-disabled when not configured', () => {
    it('returns 503 with { error: "anon-disabled" } when no ManagedAnonClient is provided', async () => {
      const app = await buildApp(); // no managedAnonClient

      const res = await request(app).get('/admin/hs-hostname').expect(503);

      expect(res.body).toEqual({ error: 'anon-disabled' });
    });

    it('returns 503 anon-disabled when ManagedAnonClient exists but no hidden service is configured', async () => {
      const app = await buildApp({
        managedAnonClient: fakeManagedAnonClient({
          hiddenServiceConfigured: false,
          hostname: null,
          publishedAt: null,
        }),
      });

      const res = await request(app).get('/admin/hs-hostname').expect(503);

      expect(res.body).toEqual({ error: 'anon-disabled' });
    });

    it('sets Cache-Control: no-store on the 503 response', async () => {
      const app = await buildApp(); // no managedAnonClient

      const res = await request(app).get('/admin/hs-hostname').expect(503);

      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  // --- AC 5: stability ---

  describe('AC 5: snapshot is stable across repeated requests', () => {
    it('returns the same hostname/publishedAt across multiple calls', async () => {
      const publishedAt = '2026-05-07T18:23:14.000Z';
      const hostname = 'stable.anyone';
      const app = await buildApp({
        managedAnonClient: fakeManagedAnonClient({
          hiddenServiceConfigured: true,
          hostname,
          publishedAt,
        }),
      });

      const first = await request(app).get('/admin/hs-hostname').expect(200);
      const second = await request(app).get('/admin/hs-hostname').expect(200);
      const third = await request(app).get('/admin/hs-hostname').expect(200);

      expect(first.body).toEqual({ hostname, publishedAt });
      expect(second.body).toEqual(first.body);
      expect(third.body).toEqual(first.body);
    });
  });

  // --- Sanity: response is JSON ---

  describe('content type', () => {
    it('returns application/json for the 200 response', async () => {
      const app = await buildApp({
        managedAnonClient: fakeManagedAnonClient({
          hiddenServiceConfigured: true,
          hostname: 'abc.anyone',
          publishedAt: '2026-05-07T18:23:14.000Z',
        }),
      });

      const res = await request(app).get('/admin/hs-hostname').expect(200);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
    });

    it('returns application/json for the 503 response', async () => {
      const app = await buildApp(); // no managedAnonClient

      const res = await request(app).get('/admin/hs-hostname').expect(503);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
    });
  });
});
