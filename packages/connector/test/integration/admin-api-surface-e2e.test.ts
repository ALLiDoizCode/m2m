/**
 * Admin API Surface E2E Test — Every Inventoried Endpoint
 *
 * Tests every HTTP endpoint from the ADMIN_API_INVENTORY manifest against the
 * real Docker-built connector image. This enforces AG2: "every endpoint has at
 * least one real-process integration test". Parallel-surface drift cannot ship
 * undetected because the coverage tracker asserts all 24 inventory entries are
 * exercised.
 *
 * Prerequisites:
 *   Docker + docker compose installed, this project's images buildable.
 *   Gate: STANDALONE_DOCKER=true (opt-in — slow because of image build)
 *
 * Usage:
 *   STANDALONE_DOCKER=true npm run test:admin-surface
 *
 * Test strategy:
 *   - Import ADMIN_API_INVENTORY and iterate programmatically (AC 5)
 *   - Track coverage with a Set of entry keys; assert empty at end
 *   - Test response shape, not deep value equality (brittle at runtime)
 *   - Document 503 responses for endpoints requiring settlement infra
 *   - Auth tests: standalone topology has no apiKey; documented gap for 38.6
 *
 * @packageDocumentation
 * @story 38.2
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import {
  ADMIN_API_INVENTORY,
  type InventoryEntry,
  type ServerName,
} from '../../src/http/admin-api-inventory';

const execFileAsync = promisify(execFile);

// ────────────────────────────────────────────────────────────────────────────
// Gate + timings
// ────────────────────────────────────────────────────────────────────────────

const RUN_DOCKER = process.env.STANDALONE_DOCKER === 'true';
const describeDocker = RUN_DOCKER ? describe : describe.skip;

jest.setTimeout(300_000);

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PROFILE_ARGS = ['compose', '--profile', 'standalone-e2e'];

// Base URLs for peer1 (mapped from docker-compose.yml)
const BASE_URL: Record<ServerName, string> = {
  AdminServer: 'http://127.0.0.1:18081',
  HealthServer: 'http://127.0.0.1:18080',
};

// Coverage tracker for AC 5: manifest-driven test structure
const testedEntries = new Set<string>();
function entryKey(e: InventoryEntry): string {
  return `${e.server}::${e.method}::${e.mountPrefix}${e.path}`;
}
function markTested(e: InventoryEntry): void {
  testedEntries.add(entryKey(e));
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

async function compose(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('docker', [...PROFILE_ARGS, ...args], {
    cwd: REPO_ROOT,
    maxBuffer: 10 * 1024 * 1024,
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForCondition(
  check: () => Promise<boolean>,
  timeoutMs: number,
  description: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // keep polling
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for: ${description} (${timeoutMs}ms)`);
}

async function fetchRaw(
  url: string,
  options?: RequestInit
): Promise<{ status: number; headers: Headers; body: string }> {
  const response = await fetch(url, options);
  const body = await response.text();
  return { status: response.status, headers: response.headers, body };
}

async function getJson<T>(url: string): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await fetch(url);
  const body = (await response.json()) as T;
  return { status: response.status, body, headers: response.headers };
}

async function postJson<T>(
  url: string,
  body: unknown
): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const responseBody = (await response.json()) as T;
  return { status: response.status, body: responseBody, headers: response.headers };
}

async function putJson<T>(
  url: string,
  body: unknown
): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const responseBody = (await response.json()) as T;
  return { status: response.status, body: responseBody, headers: response.headers };
}

async function deleteJson(url: string): Promise<{ status: number; headers: Headers }> {
  const response = await fetch(url, { method: 'DELETE' });
  return { status: response.status, headers: response.headers };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describeDocker('Admin API Surface E2E (every inventoried endpoint)', () => {
  beforeAll(async () => {
    // Build images (fast if cached) and start the stack with health-wait
    await compose('build');
    await compose('up', '-d', '--wait');

    // Wait for AdminServer health endpoint first (ensures HTTP stack ready)
    await waitForCondition(
      async () => {
        try {
          const { status } = await getJson<unknown>(`${BASE_URL.AdminServer}/health`);
          return status === 200;
        } catch {
          return false;
        }
      },
      30_000,
      'AdminServer health endpoint'
    );

    // Wait for BTP peer connectivity before running tests
    await waitForCondition(
      async () => {
        const { body } = await getJson<{ peers: Array<{ id: string; connected: boolean }> }>(
          `${BASE_URL.AdminServer}/admin/peers`
        );
        return body.peers.find((p) => p.id === 'peer2')?.connected === true;
      },
      60_000,
      'peer1 → peer2 BTP connection'
    );
  });

  afterAll(async () => {
    // Only ignore "already stopped" errors, not other failures
    await compose('down').catch((e) => {
      if (!e.message?.includes('not found')) throw e;
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Coverage assertion (AC 5): all inventory entries must be tested
  // ──────────────────────────────────────────────────────────────────────────
  afterAll(() => {
    const allKeys = new Set(ADMIN_API_INVENTORY.map(entryKey));
    const untested = [...allKeys].filter((k) => !testedEntries.has(k));
    if (untested.length > 0) {
      throw new Error(`Untested inventory entries:\n${untested.join('\n')}`);
    }
  });

  // =========================================================================
  // AdminServer /admin/* endpoints
  // =========================================================================

  describe('AdminServer /admin/peers endpoints', () => {
    it('GET /admin/peers returns 200 with peers array (peer2 present)', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) => e.server === 'AdminServer' && e.path === '/peers' && e.method === 'GET'
      )!;
      markTested(entry);

      const { status, body } = await getJson<{
        peers: Array<{ id: string; connected: boolean }>;
      }>(`${BASE_URL.AdminServer}/admin/peers`);

      expect(status).toBe(200);
      expect(body).toHaveProperty('peers');
      expect(Array.isArray(body.peers)).toBe(true);
      const peer2 = body.peers.find((p) => p.id === 'peer2');
      expect(peer2).toBeDefined();
      expect(peer2).toHaveProperty('connected');
      expect(typeof peer2!.connected).toBe('boolean');
    });

    describe('Peer lifecycle (POST + PUT + DELETE)', () => {
      const testPeerId = `surface-test-peer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      afterAll(async () => {
        // Cleanup: ignore 404 if already deleted, but throw on other errors
        await fetch(`${BASE_URL.AdminServer}/admin/peers/${testPeerId}`, {
          method: 'DELETE',
        }).catch((e) => {
          if (e.status !== 404) throw e;
        });
      });

      it('POST /admin/peers creates peer (201)', async () => {
        const entry = ADMIN_API_INVENTORY.find(
          (e) => e.server === 'AdminServer' && e.path === '/peers' && e.method === 'POST'
        )!;
        markTested(entry);

        const { status, body } = await postJson<{
          success: true;
          peer: { id: string; connected: boolean };
        }>(`${BASE_URL.AdminServer}/admin/peers`, {
          id: testPeerId,
          url: 'ws://localhost:9000',
          authToken: '',
          settlement: null,
        });

        expect(status).toBe(201);
        expect(body).toHaveProperty('peer');
        expect(body.peer).toHaveProperty('id');
        expect(typeof body.peer.id).toBe('string');
      });

      it('PUT /admin/peers/:peerId updates peer (200)', async () => {
        const entry = ADMIN_API_INVENTORY.find(
          (e) => e.server === 'AdminServer' && e.path === '/peers/:peerId' && e.method === 'PUT'
        )!;
        markTested(entry);

        const { status, body } = await putJson<{ success: true; peerId: string; updated: true }>(
          `${BASE_URL.AdminServer}/admin/peers/${testPeerId}`,
          { url: 'ws://localhost:9001' }
        );

        expect(status).toBe(200);
        expect(body).toHaveProperty('peerId');
        expect(body.peerId).toBe(testPeerId);
        expect(body).toHaveProperty('updated');
        expect(body.updated).toBe(true);
      });

      it('DELETE /admin/peers/:peerId removes peer (200)', async () => {
        const entry = ADMIN_API_INVENTORY.find(
          (e) => e.server === 'AdminServer' && e.path === '/peers/:peerId' && e.method === 'DELETE'
        )!;
        markTested(entry);

        const { status } = await deleteJson(`${BASE_URL.AdminServer}/admin/peers/${testPeerId}`);
        // API returns 200 with JSON body, not 204 (documented behavior)
        expect(status).toBe(200);
      });
    });
  });

  describe('AdminServer /admin/desired-state endpoint', () => {
    it('PUT /admin/desired-state reconciles to the running state (200, no-op)', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) => e.server === 'AdminServer' && e.path === '/desired-state' && e.method === 'PUT'
      )!;
      markTested(entry);

      // Echo the canonical peer1 fixture (peer2 + its `test.peer2` route) so the
      // declarative reconciliation is an idempotent no-op that preserves the
      // running peer1↔peer2 topology. The local `test.peer1` route (nextHop ===
      // nodeId) is always preserved by the handler and need not be listed.
      const { status, body } = await putJson<{
        peers: { added: string[]; removed: string[]; total: number };
        routes: { desired: string[]; removed: string[] };
      }>(`${BASE_URL.AdminServer}/admin/desired-state`, {
        peers: [{ id: 'peer2', url: 'ws://standalone-peer2:3000', authToken: '' }],
        routes: [{ prefix: 'test.peer2', nextHop: 'peer2' }],
      });

      expect(status).toBe(200);
      expect(body).toHaveProperty('peers');
      expect(body).toHaveProperty('routes');
      expect(body.peers.total).toBe(1);
      // Idempotent: peer2 was already present, so nothing is added or removed.
      expect(body.peers.removed).toEqual([]);
    });
  });

  describe('AdminServer /admin/routes endpoints', () => {
    it('GET /admin/routes returns 200 with routes array', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) => e.server === 'AdminServer' && e.path === '/routes' && e.method === 'GET'
      )!;
      markTested(entry);

      const { status, body } = await getJson<{
        routes: Array<{ prefix: string; nextHop: string; priority: number }>;
      }>(`${BASE_URL.AdminServer}/admin/routes`);

      expect(status).toBe(200);
      expect(body).toHaveProperty('routes');
      expect(Array.isArray(body.routes)).toBe(true);
    });

    describe('Route lifecycle (POST + DELETE)', () => {
      const testRoutePrefix = 'test.surface.route';

      afterAll(async () => {
        await fetch(`${BASE_URL.AdminServer}/admin/routes/${testRoutePrefix}`, {
          method: 'DELETE',
        }).catch(() => undefined);
      });

      it('POST /admin/routes creates route (201)', async () => {
        const entry = ADMIN_API_INVENTORY.find(
          (e) => e.server === 'AdminServer' && e.path === '/routes' && e.method === 'POST'
        )!;
        markTested(entry);

        const { status, body } = await postJson<{
          success: true;
          route: { prefix: string; nextHop: string; priority: number };
        }>(`${BASE_URL.AdminServer}/admin/routes`, {
          prefix: testRoutePrefix,
          nextHop: 'peer2',
          priority: 100,
        });

        expect(status).toBe(201);
        expect(body).toHaveProperty('route');
        expect(body.route).toHaveProperty('prefix');
        expect(body.route).toHaveProperty('nextHop');
        expect(body.route).toHaveProperty('priority');
      });

      it('DELETE /admin/routes/:prefix removes route (200)', async () => {
        const entry = ADMIN_API_INVENTORY.find(
          (e) =>
            e.server === 'AdminServer' && e.path === '/routes/:prefix(*)' && e.method === 'DELETE'
        )!;
        markTested(entry);

        const { status } = await deleteJson(
          `${BASE_URL.AdminServer}/admin/routes/${testRoutePrefix}`
        );
        // API returns 200 with JSON body, not 204 (documented behavior)
        expect(status).toBe(200);
      });
    });
  });

  describe('AdminServer /admin/balances endpoints', () => {
    it('GET /admin/balances/:peerId returns 200 for real peer (peer2)', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) => e.server === 'AdminServer' && e.path === '/balances/:peerId' && e.method === 'GET'
      )!;
      markTested(entry);

      const { status, body } = await getJson<{
        peerId: string;
        balances?: unknown[];
        error?: string;
      }>(`${BASE_URL.AdminServer}/admin/balances/peer2`);

      // Standalone topology: may return 200 with stub or 503 if AccountManager not wired
      // The inventory says successStatus is 200, but 503 is a documented failure mode
      expect([200, 503]).toContain(status);
      if (status === 200) {
        expect(body).toHaveProperty('peerId');
        expect(body.peerId).toBe('peer2');
        // balances may be present or not depending on wiring
        if (body.balances) {
          expect(Array.isArray(body.balances)).toBe(true);
        }
      }
    });

    it('GET /admin/balances/:peerId returns 404 or 503 for non-existent peer', async () => {
      const { status } = await getJson<unknown>(
        `${BASE_URL.AdminServer}/admin/balances/non-existent-peer-xyz123`
      );
      // Returns 503 in standalone mode (AccountManager not wired), 404 if wired but peer missing
      expect([404, 503]).toContain(status);
    });
  });

  describe('AdminServer /admin/ilp/send endpoint', () => {
    it('POST /admin/ilp/send returns 200 for valid request', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) => e.server === 'AdminServer' && e.path === '/ilp/send' && e.method === 'POST'
      )!;
      markTested(entry);

      const { status, body } = await postJson<{
        fulfillment?: string;
        rejection?: unknown;
      }>(`${BASE_URL.AdminServer}/admin/ilp/send`, {
        destination: 'test.peer2.receiver',
        amount: '0',
        data: '',
      });

      expect(status).toBe(200);
      // Response has either fulfillment (success) or rejection (error) or accepted flag
      const hasFulfillment = 'fulfillment' in body;
      const hasRejection = 'rejection' in body;
      const hasAccepted = 'accepted' in body;
      expect(hasFulfillment || hasRejection || hasAccepted).toBe(true);
    });
  });

  describe('AdminServer /admin/metrics.json endpoint', () => {
    it('GET /admin/metrics.json returns 200 with expected shape and no-store header', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) => e.server === 'AdminServer' && e.path === '/metrics.json' && e.method === 'GET'
      )!;
      markTested(entry);

      const { status, body, headers } = await getJson<{
        uptimeSeconds: number;
        aggregate: { packetsForwarded: number; packetsRejected: number; bytesSent: number };
        peers: Array<{ peerId: string; connected: boolean }>;
        timestamp: string;
      }>(`${BASE_URL.AdminServer}/admin/metrics.json`);

      expect(status).toBe(200);
      expect(typeof body.uptimeSeconds).toBe('number');
      expect(body).toHaveProperty('aggregate');
      expect(typeof body.aggregate.packetsForwarded).toBe('number');
      expect(typeof body.aggregate.packetsRejected).toBe('number');
      expect(typeof body.aggregate.bytesSent).toBe('number');
      expect(body).toHaveProperty('peers');
      expect(Array.isArray(body.peers)).toBe(true);
      expect(body).toHaveProperty('timestamp');
      expect(typeof body.timestamp).toBe('string');

      // Verify Cache-Control: no-store header (case-insensitive)
      const cacheControl = headers.get('cache-control') || headers.get('Cache-Control');
      expect(cacheControl?.toLowerCase()).toBe('no-store');
    });
  });

  describe('AdminServer /admin/earnings.json endpoint', () => {
    it('GET /admin/earnings.json returns 503 in standalone mode (AccountManager/ClaimReceiver not wired)', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) => e.server === 'AdminServer' && e.path === '/earnings.json' && e.method === 'GET'
      )!;
      markTested(entry);

      const { status, body } = await getJson<{
        error: string;
        message: string;
      }>(`${BASE_URL.AdminServer}/admin/earnings.json`);

      expect(status).toBe(503);
      expect(body.error).toBe('Service Unavailable');
      expect(body.message).toContain('Earnings subsystem not enabled');
    });
  });

  describe('AdminServer /admin/channels endpoints (503 expected — no ChannelManager)', () => {
    it('GET /admin/channels returns 503 (ChannelManager not configured)', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) => e.server === 'AdminServer' && e.path === '/channels' && e.method === 'GET'
      )!;
      markTested(entry);

      const { status } = await getJson<unknown>(`${BASE_URL.AdminServer}/admin/channels`);
      // Standalone topology: no ChannelManager configured — must return 503
      expect(status).toBe(503);
    });

    it('POST /admin/channels returns 503 (ChannelManager not configured)', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) => e.server === 'AdminServer' && e.path === '/channels' && e.method === 'POST'
      )!;
      markTested(entry);

      const { status } = await postJson<unknown>(`${BASE_URL.AdminServer}/admin/channels`, {
        peerId: 'peer2',
        initialDeposit: '1000',
      });
      // Standalone topology: no ChannelManager configured — must return 503
      expect(status).toBe(503);
    });

    it('GET /admin/channels/:channelId returns 503 (ChannelManager not configured)', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) => e.server === 'AdminServer' && e.path === '/channels/:channelId' && e.method === 'GET'
      )!;
      markTested(entry);

      const { status } = await getJson<unknown>(
        `${BASE_URL.AdminServer}/admin/channels/test-channel-123`
      );
      // Standalone topology: no ChannelManager configured — must return 503
      expect(status).toBe(503);
    });

    it('GET /admin/channels/:channelId/claims returns 503 (ChannelManager not configured)', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) =>
          e.server === 'AdminServer' &&
          e.path === '/channels/:channelId/claims' &&
          e.method === 'GET'
      )!;
      markTested(entry);

      const { status } = await getJson<unknown>(
        `${BASE_URL.AdminServer}/admin/channels/test-channel-123/claims`
      );
      // Standalone topology: no ChannelManager configured — must return 503
      expect(status).toBe(503);
    });

    it('POST /admin/channels/:channelId/deposit returns 503 (ChannelManager not configured)', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) =>
          e.server === 'AdminServer' &&
          e.path === '/channels/:channelId/deposit' &&
          e.method === 'POST'
      )!;
      markTested(entry);

      const { status } = await postJson<unknown>(
        `${BASE_URL.AdminServer}/admin/channels/test-channel-123/deposit`,
        { amount: '1000' }
      );
      // Standalone topology: no ChannelManager configured — must return 503
      expect(status).toBe(503);
    });

    it('POST /admin/channels/:channelId/close returns 503 (ChannelManager not configured)', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) =>
          e.server === 'AdminServer' &&
          e.path === '/channels/:channelId/close' &&
          e.method === 'POST'
      )!;
      markTested(entry);

      const { status } = await postJson<unknown>(
        `${BASE_URL.AdminServer}/admin/channels/test-channel-123/close`,
        {}
      );
      // Standalone topology: no ChannelManager configured — must return 503
      expect(status).toBe(503);
    });
  });

  describe('AdminServer /admin/settlement/states endpoint', () => {
    it('GET /admin/settlement/states returns 200 or 503', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) => e.server === 'AdminServer' && e.path === '/settlement/states' && e.method === 'GET'
      )!;
      markTested(entry);

      const { status, body } = await getJson<
        Array<{ peerId: string; state: string; pendingClaims: number }> | { error: string }
      >(`${BASE_URL.AdminServer}/admin/settlement/states`);

      // Standalone topology: SettlementMonitor not configured — 503 expected
      expect([200, 503]).toContain(status);
      if (status === 200) {
        expect(Array.isArray(body)).toBe(true);
      }
    });
  });

  describe('AdminServer root /health endpoint (port 8081)', () => {
    it('GET /health returns 200 with admin-api service shape', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) => e.server === 'AdminServer' && e.path === '/health' && e.method === 'GET'
      )!;
      markTested(entry);

      const { status, body } = await getJson<{
        status: string;
        service: string;
        nodeId: string;
        timestamp: string;
      }>(`${BASE_URL.AdminServer}/health`);

      expect(status).toBe(200);
      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('service');
      expect(body.service).toBe('admin-api');
      expect(body).toHaveProperty('nodeId');
      expect(body).toHaveProperty('timestamp');
    });
  });

  // =========================================================================
  // HealthServer endpoints (port 8080)
  // =========================================================================

  describe('HealthServer /metrics endpoint', () => {
    it('GET /metrics returns 200 with Prometheus text/plain format', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) => e.server === 'HealthServer' && e.path === '/metrics' && e.method === 'GET'
      )!;
      markTested(entry);

      const { status, headers, body } = await fetchRaw(`${BASE_URL.HealthServer}/metrics`);

      expect(status).toBe(200);
      const contentType = headers.get('content-type') || '';
      expect(contentType).toContain('text/plain');
      // Assert body contains toon_ prefix for Prometheus families
      expect(body).toContain('toon_');
      // Assert HELP and TYPE comments present
      expect(body).toContain('# HELP');
      expect(body).toContain('# TYPE');
    });
  });

  describe('HealthServer /health endpoints', () => {
    it('GET /health returns 200 with status field', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) => e.server === 'HealthServer' && e.path === '/health' && e.method === 'GET'
      )!;
      markTested(entry);

      const { status, body } = await getJson<{ status: string }>(`${BASE_URL.HealthServer}/health`);

      expect([200, 503]).toContain(status);
      expect(body).toHaveProperty('status');
    });

    it('GET /health/live returns 200 with status: alive', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) => e.server === 'HealthServer' && e.path === '/health/live' && e.method === 'GET'
      )!;
      markTested(entry);

      const { status, body } = await getJson<{ status: string; timestamp: string }>(
        `${BASE_URL.HealthServer}/health/live`
      );

      expect(status).toBe(200);
      expect(body).toHaveProperty('status');
      expect(body.status).toBe('alive');
      expect(body).toHaveProperty('timestamp');
    });

    it('GET /health/ready returns 200 or 503 with status field', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) => e.server === 'HealthServer' && e.path === '/health/ready' && e.method === 'GET'
      )!;
      markTested(entry);

      const { status, body } = await getJson<{ status: string; dependencies?: unknown }>(
        `${BASE_URL.HealthServer}/health/ready`
      );

      expect([200, 503]).toContain(status);
      expect(body).toHaveProperty('status');
    });
  });

  describe('HealthServer /settlement endpoints (503 expected — no settlement infra)', () => {
    it('POST /settlement/execute returns 404 (settlement not configured in standalone)', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) =>
          e.server === 'HealthServer' && e.path === '/settlement/execute' && e.method === 'POST'
      )!;
      markTested(entry);

      // Settlement router is not mounted in standalone topology, expect raw 404
      const response = await fetch(`${BASE_URL.HealthServer}/settlement/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: 'peer2' }),
      });
      expect(response.status).toBe(404);
    });

    it('GET /settlement/status/:peerId returns 404 (settlement not configured in standalone)', async () => {
      const entry = ADMIN_API_INVENTORY.find(
        (e) =>
          e.server === 'HealthServer' &&
          e.path === '/settlement/status/:peerId' &&
          e.method === 'GET'
      )!;
      markTested(entry);

      // Settlement router is not mounted in standalone topology, expect raw 404
      const response = await fetch(`${BASE_URL.HealthServer}/settlement/status/peer2`);
      expect(response.status).toBe(404);
    });
  });

  // =========================================================================
  // Auth enforcement tests (AC 3)
  // =========================================================================
  describe('Auth enforcement (AC 3)', () => {
    it('verifies standalone topology lacks apiKey (requests without X-Api-Key succeed)', async () => {
      // The standalone-e2e topology does NOT configure apiKey.
      // This test verifies that behavior, documenting the gap for 38.6 backfill.
      const entry = ADMIN_API_INVENTORY.find(
        (e) => e.server === 'AdminServer' && e.authModel === 'X-Api-Key'
      );
      expect(entry).toBeDefined();

      // Verify: request without X-Api-Key succeeds (no auth enforced)
      const { status } = await getJson<unknown>(`${BASE_URL.AdminServer}/admin/peers`);
      expect(status).toBe(200);

      // Full auth enforcement testing is in:
      // packages/connector/test/integration/standalone-admin-allowlist-e2e.test.ts
    });
  });
});
