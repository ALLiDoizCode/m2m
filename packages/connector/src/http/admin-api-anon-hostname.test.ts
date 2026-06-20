/**
 * Unit tests for `GET /admin/anon-hostname` (Story 151).
 *
 * Tests the route handler in isolation against a fake `ManagedAnonClient`
 * surface. Key behaviours under test:
 *   - AC 1: 200 with full `anonHostname` when log level is debug or trace
 *   - AC 2: 200 with `anonHostname: "<redacted-anon>"` at info log level
 *   - AC 3: 200 with `anonHostname: null` during the bootstrap window
 *   - AC 4: 503 `{ error: 'anon-disabled' }` when not configured
 *   - Cache-Control / Retry-After headers
 *
 * @module http/admin-api-anon-hostname.test
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

describe('Admin API GET /admin/anon-hostname (Story 151)', () => {
  let mockRoutingTable: jest.Mocked<RoutingTable>;
  let mockBTPClientManager: jest.Mocked<BTPClientManager>;
  let mockLogger: jest.Mocked<Logger>;

  const buildApp = async (
    overrides?: Partial<AdminAPIConfig>,
    logLevel = 'info'
  ): Promise<Express> => {
    const logger = {
      ...mockLogger,
      level: logLevel,
    } as unknown as jest.Mocked<Logger>;
    const config: AdminAPIConfig = {
      routingTable: mockRoutingTable,
      btpClientManager: mockBTPClientManager,
      logger,
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

  // --- AC 1: debug and trace levels return full hostname ---

  describe('AC 1: returns full anonHostname at debug or trace log level', () => {
    it('returns the real hostname when log level is debug', async () => {
      const publishedAt = '2026-06-20T10:00:00.000Z';
      const hostname = 'eag2qnhil4vpvfo2eu3qtqj3rzzkrzbmboivwwbbgzr4svfvjigoxpad.anon';
      const app = await buildApp(
        {
          managedAnonClient: fakeManagedAnonClient({
            hiddenServiceConfigured: true,
            hostname,
            publishedAt,
          }),
        },
        'debug'
      );

      const res = await request(app).get('/admin/anon-hostname').expect(200);

      expect(res.body).toEqual({ anonHostname: hostname, publishedAt });
    });

    it('returns the real hostname when log level is trace', async () => {
      const publishedAt = '2026-06-20T10:00:00.000Z';
      const hostname = 'eag2qnhil4vpvfo2eu3qtqj3rzzkrzbmboivwwbbgzr4svfvjigoxpad.anon';
      const app = await buildApp(
        {
          managedAnonClient: fakeManagedAnonClient({
            hiddenServiceConfigured: true,
            hostname,
            publishedAt,
          }),
        },
        'trace'
      );

      const res = await request(app).get('/admin/anon-hostname').expect(200);

      expect(res.body).toEqual({ anonHostname: hostname, publishedAt });
    });
  });

  // --- AC 2: info level redacts hostname ---

  describe('AC 2: redacts anonHostname at info log level', () => {
    it('returns "<redacted-anon>" when log level is info', async () => {
      const publishedAt = '2026-06-20T10:00:00.000Z';
      const hostname = 'eag2qnhil4vpvfo2eu3qtqj3rzzkrzbmboivwwbbgzr4svfvjigoxpad.anon';
      const app = await buildApp(
        {
          managedAnonClient: fakeManagedAnonClient({
            hiddenServiceConfigured: true,
            hostname,
            publishedAt,
          }),
        },
        'info'
      );

      const res = await request(app).get('/admin/anon-hostname').expect(200);

      expect(res.body).toEqual({ anonHostname: '<redacted-anon>', publishedAt });
    });

    it('redacts at warn level', async () => {
      const publishedAt = '2026-06-20T10:00:00.000Z';
      const hostname = 'abc.anon';
      const app = await buildApp(
        {
          managedAnonClient: fakeManagedAnonClient({
            hiddenServiceConfigured: true,
            hostname,
            publishedAt,
          }),
        },
        'warn'
      );

      const res = await request(app).get('/admin/anon-hostname').expect(200);

      expect(res.body.anonHostname).toBe('<redacted-anon>');
    });

    it('redacts at error level', async () => {
      const publishedAt = '2026-06-20T10:00:00.000Z';
      const hostname = 'abc.anon';
      const app = await buildApp(
        {
          managedAnonClient: fakeManagedAnonClient({
            hiddenServiceConfigured: true,
            hostname,
            publishedAt,
          }),
        },
        'error'
      );

      const res = await request(app).get('/admin/anon-hostname').expect(200);

      expect(res.body.anonHostname).toBe('<redacted-anon>');
    });
  });

  // --- AC 3: bootstrap window ---

  describe('AC 3: returns null anonHostname during bootstrap window', () => {
    it('returns { anonHostname: null, publishedAt: null } when not yet published', async () => {
      const app = await buildApp({
        managedAnonClient: fakeManagedAnonClient({
          hiddenServiceConfigured: true,
          hostname: null,
          publishedAt: null,
        }),
      });

      const res = await request(app).get('/admin/anon-hostname').expect(200);

      expect(res.body).toEqual({ anonHostname: null, publishedAt: null });
    });

    it('does not redact null — returns null regardless of log level', async () => {
      const app = await buildApp(
        {
          managedAnonClient: fakeManagedAnonClient({
            hiddenServiceConfigured: true,
            hostname: null,
            publishedAt: null,
          }),
        },
        'info'
      );

      const res = await request(app).get('/admin/anon-hostname').expect(200);

      expect(res.body.anonHostname).toBeNull();
    });

    it('sets Retry-After: 3 and Cache-Control: no-store during bootstrap', async () => {
      const app = await buildApp({
        managedAnonClient: fakeManagedAnonClient({
          hiddenServiceConfigured: true,
          hostname: null,
          publishedAt: null,
        }),
      });

      const res = await request(app).get('/admin/anon-hostname').expect(200);

      expect(res.headers['retry-after']).toBe('3');
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  // --- AC 4: anon-disabled ---

  describe('AC 4: returns 503 anon-disabled when not configured', () => {
    it('returns 503 with { error: "anon-disabled" } when no ManagedAnonClient provided', async () => {
      const app = await buildApp();

      const res = await request(app).get('/admin/anon-hostname').expect(503);

      expect(res.body).toEqual({ error: 'anon-disabled' });
    });

    it('returns 503 when ManagedAnonClient exists but no hidden service configured', async () => {
      const app = await buildApp({
        managedAnonClient: fakeManagedAnonClient({
          hiddenServiceConfigured: false,
          hostname: null,
          publishedAt: null,
        }),
      });

      const res = await request(app).get('/admin/anon-hostname').expect(503);

      expect(res.body).toEqual({ error: 'anon-disabled' });
    });

    it('sets Cache-Control: no-store on the 503 response', async () => {
      const app = await buildApp();

      const res = await request(app).get('/admin/anon-hostname').expect(503);

      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  // --- Cache-Control on success ---

  describe('headers on published response', () => {
    it('sets Cache-Control: no-store and no Retry-After when published', async () => {
      const app = await buildApp({
        managedAnonClient: fakeManagedAnonClient({
          hiddenServiceConfigured: true,
          hostname: 'abc.anon',
          publishedAt: '2026-06-20T10:00:00.000Z',
        }),
      });

      const res = await request(app).get('/admin/anon-hostname').expect(200);

      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['retry-after']).toBeUndefined();
    });

    it('returns application/json', async () => {
      const app = await buildApp({
        managedAnonClient: fakeManagedAnonClient({
          hiddenServiceConfigured: true,
          hostname: 'abc.anon',
          publishedAt: '2026-06-20T10:00:00.000Z',
        }),
      });

      const res = await request(app).get('/admin/anon-hostname').expect(200);

      expect(res.headers['content-type']).toMatch(/^application\/json/);
    });
  });
});
