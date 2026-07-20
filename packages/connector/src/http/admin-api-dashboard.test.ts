/**
 * Unit tests for Admin API GET /admin/dashboard.
 *
 * The dashboard is a static, self-contained HTML page served from inside the
 * admin router. It takes no dependencies on connector state, so these tests only
 * assert that it is served correctly and that it inherits the router's auth.
 *
 * @module http/admin-api-dashboard.test
 */

import request from 'supertest';
import express, { Express } from 'express';
import { createAdminRouter, AdminAPIConfig } from './admin-api';
import type { RoutingTable } from '../routing/routing-table';
import type { BTPClientManager } from '../btp/btp-client-manager';

describe('Admin API GET /admin/dashboard', () => {
  let mockRoutingTable: jest.Mocked<RoutingTable>;
  let mockBTPClientManager: jest.Mocked<BTPClientManager>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockLogger: any;

  const createApp = async (configOverrides?: Partial<AdminAPIConfig>): Promise<Express> => {
    const config: AdminAPIConfig = {
      routingTable: mockRoutingTable,
      btpClientManager: mockBTPClientManager,
      logger: mockLogger,
      nodeId: 'test-node',
      ...configOverrides,
    };
    const router = await createAdminRouter(config);
    const app = express();
    app.use('/admin', router);
    return app;
  };

  beforeEach(() => {
    mockRoutingTable = {
      addRoute: jest.fn(),
      getAllRoutes: jest.fn().mockReturnValue([]),
    } as unknown as jest.Mocked<RoutingTable>;
    mockBTPClientManager = {
      getPeerIds: jest.fn().mockReturnValue([]),
      getPeerStatus: jest.fn().mockReturnValue(new Map()),
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
  });

  it('serves the dashboard HTML with a 200 and text/html content type', async () => {
    const app = await createApp();
    const res = await request(app).get('/admin/dashboard');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<!doctype html>');
    expect(res.text).toContain('operator dashboard');
    // Same-origin polling targets must be present so the page finds its data.
    expect(res.text).toContain("apiFetch('./metrics.json')");
    expect(res.text).toContain("apiFetch('./earnings.json')");
    // Honesty labels must not be silently dropped.
    expect(res.text).toContain('estimated');
    expect(res.text).toContain('session-local');
  });

  it('is not cached', async () => {
    const app = await createApp();
    const res = await request(app).get('/admin/dashboard');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('inherits admin API-key auth (401 without key when a key is configured)', async () => {
    const app = await createApp({ apiKey: 'secret-key' });
    const noKey = await request(app).get('/admin/dashboard');
    expect(noKey.status).toBe(401);
    const withKey = await request(app).get('/admin/dashboard').set('X-Api-Key', 'secret-key');
    expect(withKey.status).toBe(200);
  });
});
