/**
 * Standalone Mode Container E2E Integration Test
 *
 * Complements the in-process standalone-smoke-e2e test by exercising the
 * target production topology: the connector runs inside a Docker container
 * built from the repo Dockerfile, peers with another containerized connector
 * over the compose network, and forwards packets to a containerized BLS.
 *
 * What this proves that the in-process test cannot:
 *   - Dockerfile + image entrypoint work (CONFIG_FILE, main.ts, WORKDIR, user)
 *   - YAML config loading in production mode
 *   - BTP WebSocket connectivity across Docker network DNS
 *   - Admin API + local delivery HTTP across container boundaries
 *   - Process isolation between connector and BLS
 *
 *   [bls1 container] <-- /handle-packet -- [peer1 container]
 *                                                ^
 *                                              BTP (compose net)
 *                                                v
 *   [test] -- /admin/ilp/send (127.0.0.1:18081) --> [peer1]
 *                                                v
 *                                              BTP
 *                                                v
 *   [bls2 container] <-- /handle-packet -- [peer2 container]
 *
 * Prerequisites:
 *   Docker + docker compose installed, this project's images buildable.
 *   Gate: STANDALONE_DOCKER=true (opt-in — slow because of image build)
 *
 * Usage:
 *   STANDALONE_DOCKER=true npm run test:standalone-docker
 *
 * @packageDocumentation
 */

/**
 * ============================================================================
 * INVENTORY COVERAGE MATRIX — Story 38.6 Backfill
 * ============================================================================
 *
 * This file is the ORIGINAL container E2E test (v0 topology with two connectors
 * peered over BTP). Story 38.6 adds assertions to complete HTTP-surface coverage
 * alignment with docs/admin-api-inventory.md (23 endpoints).
 *
 * COVERAGE BY THIS FILE (standalone-container-e2e.test.ts):
 * ─────────────────────────────────────────────────────────────────────────────
 * Health Endpoints (unauthenticated):
 *   • GET /health              (HealthServer peer1:18080, peer2:28080)
 *   • GET /health/live         (HealthServer peer1:18080, peer2:28080)
 *   • GET /health/ready        (HealthServer peer1:18080, peer2:28080)
 *   • GET /health              (AdminServer peer1:18081, peer2:28081)
 *
 * Metrics Endpoints:
 *   • GET /metrics             (HealthServer peer1:18080) — Prometheus format
 *
 * Admin API Endpoints (with X-Api-Key):
 *   • GET /admin/peers         (used in beforeAll to verify BTP peering)
 *   • POST /admin/ilp/send     (packet forwarding test)
 *
 * COVERAGE BY OTHER EPIC 38 TEST FILES (cross-references):
 * ─────────────────────────────────────────────────────────────────────────────
 * admin-api-surface-e2e.test.ts (Story 38.2):
 *   • All AdminServer CRUD endpoints (peers, routes, channels, balances)
 *   • All HealthServer /health variants (comprehensive)
 *   • GET /admin/metrics.json
 *   • GET /admin/settlement/states
 *
 * admin-api-cross-surface-invariants.test.ts (Story 38.3):
 *   • Cross-surface peer state consistency (peer-existence invariant group)
 *   • Channel state invariants across endpoints (channel-state group)
 *
 * admin-api-packet-flow-invariants.test.ts (Story 38.4):
 *   • Packet-flow counter consistency (packet-counters invariant group)
 *   • /metrics ↔ /admin/metrics.json counter alignment
 *
 * NOT COVERED IN THIS TOPOLOGY (documented rationale):
 * ─────────────────────────────────────────────────────────────────────────────
 * • POST /settlement/execute — requires settlement auth token configuration
 * • GET /settlement/status/:peerId — requires active settlement flow
 * • Full channel lifecycle tests — require on-chain settlement infra (EVM/Solana/Mina)
 *
 * These require special topology not available in the standalone-e2e Docker
 * profile (no settlement infrastructure, no auth token setup).
 *
 * COMBINED COVERAGE VERIFICATION:
 * ─────────────────────────────────────────────────────────────────────────────
 * Together, the four test files provide 100% coverage of all feasible endpoints
 * in the 23-endpoint inventory. This satisfies AG2 (every endpoint has at least
 * one real-process integration test) for Epic 38.
 *
 * References:
 *   • Inventory doc: docs/admin-api-inventory.md
 *   • Inventory manifest: packages/connector/src/http/admin-api-inventory.ts
 *   • Story 38.6 spec: _bmad-output/implementation-artifacts/38-6-backfill-*.md
 * ============================================================================
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFileAsync = promisify(execFile);

// ────────────────────────────────────────────────────────────────────────────
// Gate + timings
// ────────────────────────────────────────────────────────────────────────────

const RUN_DOCKER = process.env.STANDALONE_DOCKER === 'true';
const describeDocker = RUN_DOCKER ? describe : describe.skip;

// Full run: up to ~90s for compose up --wait on a cold cache + assertions.
jest.setTimeout(300_000);

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PROFILE_ARGS = ['compose', '--profile', 'standalone-e2e'];

const PEER1_ADMIN = 'http://127.0.0.1:18081';
const PEER2_ADMIN = 'http://127.0.0.1:28081';
const PEER1_HEALTH = 'http://127.0.0.1:18080';
const PEER2_HEALTH = 'http://127.0.0.1:28080';
const BLS1_RECEIVED = 'http://127.0.0.1:13101/received';
const BLS2_RECEIVED = 'http://127.0.0.1:13102/received';

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

interface ReceivedResponse {
  count: number;
  received: Array<{ destination: string; amount: string; paymentId: string }>;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

async function getText(url: string): Promise<{ text: string; contentType: string | null }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}`);
  }
  const text = await response.text();
  return { text, contentType: response.headers.get('content-type') };
}

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describeDocker('Standalone Mode Container E2E (Docker compose)', () => {
  beforeAll(async () => {
    // Build images (fast if cached) and start the whole stack with health-wait.
    await compose('build');
    await compose('up', '-d', '--wait');

    // Wait until each connector reports its BTP peer connected via its admin API.
    await waitForCondition(
      async () => {
        const peers = await getJson<{ peers: Array<{ id: string; connected: boolean }> }>(
          `${PEER1_ADMIN}/admin/peers`
        );
        return peers.peers.find((p) => p.id === 'peer2')?.connected === true;
      },
      60_000,
      'peer1 → peer2 BTP connection'
    );
    await waitForCondition(
      async () => {
        const peers = await getJson<{ peers: Array<{ id: string; connected: boolean }> }>(
          `${PEER2_ADMIN}/admin/peers`
        );
        return peers.peers.find((p) => p.id === 'peer1')?.connected === true;
      },
      60_000,
      'peer2 → peer1 BTP connection'
    );
  });

  afterAll(async () => {
    await compose('down').catch(() => undefined);
  });

  it('both connector containers report standalone mode via /health', async () => {
    const res1 = await fetch(`${PEER1_HEALTH}/health`);
    const res2 = await fetch(`${PEER2_HEALTH}/health`);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Verify response body shape (AC 1 extended)
    const body1 = (await res1.json()) as { status: string; mode?: string; timestamp?: string };
    const body2 = (await res2.json()) as { status: string; mode?: string; timestamp?: string };
    expect(body1.status).toBe('healthy');
    expect(body2.status).toBe('healthy');
    if (body1.mode) expect(body1.mode).toBe('standalone');
    if (body2.mode) expect(body2.mode).toBe('standalone');
  });

  it('HealthServer /health/live and /health/ready return 200 (AC 1)', async () => {
    // HealthServer /health/live (liveness probes) — always 200 unless crashed
    const live1 = await fetch(`${PEER1_HEALTH}/health/live`);
    const live2 = await fetch(`${PEER2_HEALTH}/health/live`);
    expect(live1.status).toBe(200);
    expect(live2.status).toBe(200);

    const liveBody1 = (await live1.json()) as { status: string; timestamp?: string };
    const liveBody2 = (await live2.json()) as { status: string; timestamp?: string };
    expect(liveBody1.status).toBe('alive');
    expect(liveBody2.status).toBe('alive');

    // HealthServer /health/ready (readiness probes) — 200 when dependencies ready
    const ready1 = await fetch(`${PEER1_HEALTH}/health/ready`);
    const ready2 = await fetch(`${PEER2_HEALTH}/health/ready`);
    expect(ready1.status).toBe(200);
    expect(ready2.status).toBe(200);

    const readyBody1 = (await ready1.json()) as { status: string; peersConnected?: number };
    const readyBody2 = (await ready2.json()) as { status: string; peersConnected?: number };
    expect(readyBody1.status).toBe('ready');
    expect(readyBody2.status).toBe('ready');
    // peersConnected should be 1 (each peer has 1 BTP connection in this topology)
    if (readyBody1.peersConnected !== undefined) {
      expect(readyBody1.peersConnected).toBeGreaterThanOrEqual(1);
    }
    if (readyBody2.peersConnected !== undefined) {
      expect(readyBody2.peersConnected).toBeGreaterThanOrEqual(1);
    }
  });

  it('AdminServer /health returns 200 on both peers (AC 1)', async () => {
    // AdminServer has its own /health at root (NOT /admin/health)
    const adminHealth1 = await fetch(`${PEER1_ADMIN}/health`);
    const adminHealth2 = await fetch(`${PEER2_ADMIN}/health`);
    expect(adminHealth1.status).toBe(200);
    expect(adminHealth2.status).toBe(200);

    const body1 = (await adminHealth1.json()) as {
      status: string;
      service?: string;
      nodeId?: string;
      timestamp?: string;
    };
    const body2 = (await adminHealth2.json()) as {
      status: string;
      service?: string;
      nodeId?: string;
      timestamp?: string;
    };
    expect(body1.status).toBe('healthy');
    expect(body2.status).toBe('healthy');
    if (body1.service) expect(body1.service).toBe('admin-api');
    if (body2.service) expect(body2.service).toBe('admin-api');
  });

  it('Prometheus /metrics endpoint returns valid metrics (AC 2)', async () => {
    // GET /metrics on HealthServer returns Prometheus exposition format
    const { text, contentType } = await getText(`${PEER1_HEALTH}/metrics`);

    // Verify Prometheus text format
    expect(contentType).toContain('text/plain');

    // Verify presence of at least one toon_ prefixed metric
    expect(text).toContain('toon_');

    // Verify specific metric families mentioned in inventory
    expect(text).toContain('toon_packets_forwarded_total');
    expect(text).toContain('toon_packets_rejected_total');

    // Verify Prometheus exposition format (TYPE and HELP lines)
    expect(text).toContain('# TYPE');
    expect(text).toContain('# HELP');
  });

  it('POST /admin/ilp/send → BTP → container BLS /handle-packet fulfills', async () => {
    const before = await getJson<ReceivedResponse>(BLS2_RECEIVED);
    const { status, body } = await postJson<{ accepted: boolean }>(
      `${PEER1_ADMIN}/admin/ilp/send`,
      { destination: 'test.peer2.receiver', amount: '0', data: '' }
    );
    expect(status).toBe(200);
    expect(body.accepted).toBe(true);

    // Poll — HTTP forwarding between containers is fast but not instantaneous.
    await waitForCondition(
      async () => {
        const after = await getJson<ReceivedResponse>(BLS2_RECEIVED);
        return after.count === before.count + 1;
      },
      5_000,
      'BLS2 receives forwarded packet'
    );

    const after = await getJson<ReceivedResponse>(BLS2_RECEIVED);
    const latest = after.received[after.received.length - 1]!;
    expect(latest.destination).toBe('test.peer2.receiver');
    expect(latest.amount).toBe('0');
  });

  it('reverse direction peer2 → peer1 also works (symmetric topology)', async () => {
    const before = await getJson<ReceivedResponse>(BLS1_RECEIVED);
    const { status, body } = await postJson<{ accepted: boolean }>(
      `${PEER2_ADMIN}/admin/ilp/send`,
      { destination: 'test.peer1.receiver', amount: '0', data: '' }
    );
    expect(status).toBe(200);
    expect(body.accepted).toBe(true);

    await waitForCondition(
      async () => {
        const after = await getJson<ReceivedResponse>(BLS1_RECEIVED);
        return after.count === before.count + 1;
      },
      5_000,
      'BLS1 receives forwarded packet'
    );
  });
});
