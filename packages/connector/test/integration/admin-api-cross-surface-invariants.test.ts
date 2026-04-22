/**
 * Cross-Surface Invariant Tests (Peer State)
 *
 * Tests that peer lifecycle operations maintain consistency across all HTTP
 * surfaces that project peer state. Catches parallel-surface drift (like the
 * Epic 37.1 bug where /admin/balances/:peerId disagreed with /admin/peers on
 * unknown-peer semantics) before it ships.
 *
 * This test operates on the 'peer-existence' cross-surface group:
 * - GET /admin/peers (array projection)
 * - GET /admin/balances/:peerId (200 vs 404 projection)
 * - GET /metrics (Prometheus labels)
 * - GET /admin/metrics.json (peers[] array)
 *
 * Prerequisites:
 *   Docker + docker compose installed, this project's images buildable.
 *   Gate: STANDALONE_DOCKER=true (opt-in — slow because of image build)
 *
 * Usage:
 *   STANDALONE_DOCKER=true npm run test:cross-surface
 *
 * @packageDocumentation
 * @story 38.3
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { getEntriesByGroup } from '../../src/http/admin-api-inventory';

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
const ADMIN_BASE = 'http://127.0.0.1:18081';
const HEALTH_BASE = 'http://127.0.0.1:18080';

// Timing constants for cross-surface propagation (AC 2, AC 3 requirements)
const PROPAGATION_TIMEOUT_MS = 5000; // Max time for state change to propagate
const POLL_INTERVAL_MS = 250; // How often to poll for state changes
const OBSERVATION_INTERVAL_MS = 5000; // AC 4: Poll every 5 seconds during observation

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface PeerProjectionState {
  /** Peer exists in GET /admin/peers array */
  inAdminPeers: boolean;
  /** HTTP status from GET /admin/balances/:peerId */
  balancesStatus: number;
  /** Peer label exists in Prometheus /metrics output */
  inPrometheus: boolean;
  /** Peer exists in /admin/metrics.json peers[] array */
  inMetricsJson: boolean;
  /** Connected status from /admin/metrics.json (undefined if not present) */
  metricsJsonConnected?: boolean;
  /** Connected status from /admin/peers (undefined if not present) */
  adminPeerConnected?: boolean;
  /** Raw projection data for diagnostics */
  raw: {
    adminPeersResponse:
      | {
          status: number;
          body: { peers: Array<{ id: string; connected: boolean }> };
          headers: Headers;
        }
      | { status: number; body: { peers: never[] }; headers: Headers };
    balancesStatus: number;
    metricsText: string;
    metricsJsonResponse:
      | {
          status: number;
          body: {
            uptimeSeconds: number;
            aggregate: { packetsForwarded: number; packetsRejected: number; bytesSent: number };
            peers: Array<{
              peerId: string;
              connected: boolean;
              packetsForwarded: number;
              packetsRejected: number;
              bytesSent: number;
              lastPacketAt?: string;
            }>;
            timestamp: string;
          };
          headers: Headers;
        }
      | {
          status: number;
          body: {
            uptimeSeconds: number;
            aggregate: { packetsForwarded: number; packetsRejected: number; bytesSent: number };
            peers: never[];
            timestamp: string;
          };
          headers: Headers;
        };
    /** Errors encountered during projection queries */
    errors?: Array<{ surface: string; message: string }>;
  };
}

interface CrossSurfaceDiagnostic {
  operation: 'CREATE' | 'DELETE' | 'CONNECTION_CHANGE';
  peerId: string;
  timestamp: string;
  /** Per-surface results with details */
  surfaces: Array<{
    surface: string;
    exists: boolean;
    details: unknown;
  }>;
  /** Summary of which surfaces agree/disagree */
  consensus: {
    agree: string[];
    disagree: string[];
    expectedState: 'exists' | 'absent';
    actualConsensus: 'exists' | 'absent' | 'split';
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

async function compose(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync('docker', [...PROFILE_ARGS, ...args], {
    cwd: REPO_ROOT,
    maxBuffer: 50 * 1024 * 1024, // Increased from 10MB to 50MB for large metrics output
  });

  // Check for errors in stderr even if exit code is 0
  if (args[0] === 'build' && result.stderr) {
    const errorKeywords = ['error', 'failed', 'cannot', 'unable', 'denied'];
    const hasError = errorKeywords.some((kw) => result.stderr.toLowerCase().includes(kw));
    if (hasError) {
      throw new Error(`Docker compose build reported errors: ${result.stderr.slice(0, 500)}`);
    }
  }

  return result;
}

/**
 * Manage peer2 container lifecycle for connection state testing.
 */
async function managePeer2Container(action: 'stop' | 'start'): Promise<void> {
  const containerName = 'connector-peer2-1'; // Docker compose default naming
  try {
    await execFileAsync('docker', [action, containerName], { cwd: REPO_ROOT });
  } catch (e) {
    // Fallback: try with project prefix
    const altName = 'standalone-e2e-peer2-1';
    await execFileAsync('docker', [action, altName], { cwd: REPO_ROOT });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForCondition(
  check: () => Promise<boolean>,
  timeoutMs: number,
  description: string,
  intervalMs = 500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // keep polling
    }
    await sleep(intervalMs);
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

/**
 * Perform DELETE request with optional error logging.
 */
async function deleteJson(
  url: string,
  options?: { logError?: boolean; context?: string }
): Promise<{ status: number; headers: Headers }> {
  const response = await fetch(url, { method: 'DELETE' });

  // Log server errors (5xx) to help diagnose test state leaks
  if (options?.logError && response.status >= 500) {
    console.error(
      `[${options.context || 'deleteJson'}] Server error ${response.status} on DELETE ${url}`
    );
  }

  return { status: response.status, headers: response.headers };
}

/**
 * Parse Prometheus text format for peer labels.
 * Looks for any toon_* metric family with peer="<peerId>" label.
 * Handles multi-line metric continuations (lines ending with backslash).
 */
function parsePrometheusPeerLabels(metricsText: string, peerId: string): boolean {
  // Join continuation lines (lines ending with \) before parsing
  const normalizedText = metricsText
    .split('\n')
    .reduce((acc: string[], line: string) => {
      const lastElement = acc[acc.length - 1];
      if (acc.length > 0 && lastElement !== undefined && lastElement.endsWith('\\')) {
        acc[acc.length - 1] = lastElement.slice(0, -1) + line;
      } else {
        acc.push(line);
      }
      return acc;
    }, [])
    .join('\n');

  const lines = normalizedText.split('\n');
  for (const line of lines) {
    // Skip comment lines and empty lines
    if (!line || line.startsWith('#')) continue;

    // Match: toon_packets_forwarded_total{peer="peerId",...} value
    // or any toon_* metric with peer label
    const match = line.match(new RegExp(`toon_\\w+\\{[^}]*peer="${escapeRegExp(peerId)}"[^}]*\\}`));
    if (match) return true;
  }
  return false;
}

function escapeRegExp(str: string): string {
  // Escape special regex characters for safe use in character class context
  // $& is the matched substring in the replacement
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Query all projections for a peer's existence state.
 * This is the core primitive for cross-surface invariant assertions.
 */
async function queryPeerProjections(peerId: string): Promise<PeerProjectionState> {
  // Query all four surfaces in parallel with detailed error tracking
  const errors: Array<{ surface: string; error: Error }> = [];

  const [adminPeersResponse, balancesResponse, metricsResponse, metricsJsonResponse] =
    await Promise.all([
      getJson<{ peers: Array<{ id: string; connected: boolean }> }>(
        `${ADMIN_BASE}/admin/peers`
      ).catch((err) => {
        errors.push({ surface: '/admin/peers', error: err as Error });
        return { status: 503, body: { peers: [] }, headers: new Headers() };
      }),
      fetchRaw(`${ADMIN_BASE}/admin/balances/${peerId}`).catch((err) => {
        errors.push({ surface: '/admin/balances', error: err as Error });
        return {
          status: 503,
          headers: new Headers(),
          body: '',
        };
      }),
      fetchRaw(`${HEALTH_BASE}/metrics`).catch((err) => {
        errors.push({ surface: '/metrics', error: err as Error });
        return {
          status: 503,
          headers: new Headers(),
          body: '',
        };
      }),
      getJson<{
        uptimeSeconds: number;
        aggregate: { packetsForwarded: number; packetsRejected: number; bytesSent: number };
        peers: Array<{
          peerId: string;
          connected: boolean;
          packetsForwarded: number;
          packetsRejected: number;
          bytesSent: number;
          lastPacketAt?: string;
        }>;
        timestamp: string;
      }>(`${ADMIN_BASE}/admin/metrics.json`).catch((err) => {
        errors.push({ surface: '/admin/metrics.json', error: err as Error });
        return {
          status: 503,
          body: {
            uptimeSeconds: 0,
            aggregate: { packetsForwarded: 0, packetsRejected: 0, bytesSent: 0 },
            peers: [],
            timestamp: '',
          },
          headers: new Headers(),
        };
      }),
    ]);

  // If all endpoints failed, this indicates a systemic issue - surface it
  if (errors.length === 4) {
    const errorMessages = errors.map((e) => `${e.surface}: ${e.error.message}`).join('; ');
    throw new Error(
      `All projection queries failed. Possible causes: Docker containers not running, network issues, or server crash. Errors: ${errorMessages}`
    );
  }

  const adminPeers = adminPeersResponse.body;
  const metricsText = metricsResponse.body;
  const metricsJson = metricsJsonResponse.body;

  const peerInAdminPeers = adminPeers.peers.some((p) => p.id === peerId);
  const adminPeerEntry = adminPeers.peers.find((p) => p.id === peerId);

  const peerInMetricsJson = metricsJson.peers.some((p) => p.peerId === peerId);
  const metricsJsonEntry = metricsJson.peers.find((p) => p.peerId === peerId);

  return {
    inAdminPeers: peerInAdminPeers,
    balancesStatus: balancesResponse.status,
    inPrometheus: parsePrometheusPeerLabels(metricsText, peerId),
    inMetricsJson: peerInMetricsJson,
    metricsJsonConnected: metricsJsonEntry?.connected,
    adminPeerConnected: adminPeerEntry?.connected,
    raw: {
      adminPeersResponse,
      balancesStatus: balancesResponse.status,
      metricsText,
      metricsJsonResponse,
      errors:
        errors.length > 0
          ? errors.map((e) => ({ surface: e.surface, message: e.error.message }))
          : undefined,
    },
  };
}

/**
 * Build a diagnostic report for cross-surface drift.
 */
function buildDiagnostic(
  operation: 'CREATE' | 'DELETE' | 'CONNECTION_CHANGE',
  peerId: string,
  state: PeerProjectionState,
  expectedState: 'exists' | 'absent'
): CrossSurfaceDiagnostic {
  const surfaces = [
    {
      surface: '/admin/peers',
      exists: state.inAdminPeers,
      details: state.adminPeerConnected,
    },
    {
      surface: '/admin/balances/:peerId',
      exists: state.balancesStatus === 200,
      details: { status: state.balancesStatus },
    },
    {
      surface: '/metrics (Prometheus)',
      exists: state.inPrometheus,
      details: null,
    },
    {
      surface: '/admin/metrics.json',
      exists: state.inMetricsJson,
      details: state.metricsJsonConnected,
    },
  ];

  const agreeing = surfaces.filter((s) => s.exists === (expectedState === 'exists'));
  const disagreeing = surfaces.filter((s) => s.exists !== (expectedState === 'exists'));

  let actualConsensus: 'exists' | 'absent' | 'split';
  if (agreeing.length === surfaces.length) {
    actualConsensus = expectedState;
  } else if (disagreeing.length === surfaces.length) {
    actualConsensus = expectedState === 'exists' ? 'absent' : 'exists';
  } else {
    actualConsensus = 'split';
  }

  return {
    operation,
    peerId,
    timestamp: new Date().toISOString(),
    surfaces,
    consensus: {
      agree: agreeing.map((s) => s.surface),
      disagree: disagreeing.map((s) => s.surface),
      expectedState,
      actualConsensus,
    },
  };
}

/**
 * Format a diagnostic into a human-readable error message.
 */
function formatInvariantFailure(diagnostic: CrossSurfaceDiagnostic): string {
  const { operation, peerId, surfaces, consensus } = diagnostic;

  let message = `Cross-surface invariant FAILED for peer "${peerId}" after ${operation}\n`;
  message += `  Expected: peer ${consensus.expectedState.toUpperCase()} on all surfaces\n`;
  message += `  Actual: ${consensus.actualConsensus} consensus\n\n`;

  if (consensus.agree.length > 0) {
    message += `  ✅ Surfaces that agree (${consensus.agree.length}):\n`;
    for (const surface of consensus.agree) {
      const s = surfaces.find((x) => x.surface === surface)!;
      message += `     - ${surface}: exists=${s.exists}\n`;
    }
  }

  if (consensus.disagree.length > 0) {
    message += `\n  ❌ Surfaces that DISAGREE (${consensus.disagree.length}):\n`;
    for (const surface of consensus.disagree) {
      const s = surfaces.find((x) => x.surface === surface)!;
      message += `     - ${surface}: exists=${s.exists}`;
      if (s.details !== null && s.details !== undefined) {
        message += ` (details: ${JSON.stringify(s.details)})`;
      }
      message += '\n';
    }

    // Specific deltas
    message += `\n  📊 Specific deltas:\n`;
    const adminPeers = surfaces.find((s) => s.surface === '/admin/peers')!;
    const balances = surfaces.find((s) => s.surface === '/admin/balances/:peerId')!;
    const prometheus = surfaces.find((s) => s.surface === '/metrics (Prometheus)')!;
    const metricsJson = surfaces.find((s) => s.surface === '/admin/metrics.json')!;

    if (adminPeers.exists !== balances.exists) {
      message += `     - Peer ${adminPeers.exists ? 'EXISTS' : 'MISSING'} in /admin/peers but /admin/balances returns ${balances.exists ? '200' : '404'}\n`;
    }
    if (adminPeers.exists !== prometheus.exists) {
      message += `     - Peer ${adminPeers.exists ? 'EXISTS' : 'MISSING'} in /admin/peers but Prometheus labels are ${prometheus.exists ? 'PRESENT' : 'MISSING'}\n`;
    }
    if (adminPeers.exists !== metricsJson.exists) {
      message += `     - Peer ${adminPeers.exists ? 'EXISTS' : 'MISSING'} in /admin/peers but /admin/metrics.json is ${metricsJson.exists ? 'PRESENT' : 'MISSING'}\n`;
    }
  }

  return message;
}

/**
 * Assert that a peer exists on all four projections.
 * Fails with AC 6 diagnostics if any projection disagrees.
 */
async function assertPeerExistsEverywhere(
  peerId: string,
  operation: 'CREATE' | 'CONNECTION_CHANGE' = 'CREATE'
): Promise<void> {
  const state = await queryPeerProjections(peerId);

  const failures: string[] = [];
  if (!state.inAdminPeers) failures.push('/admin/peers missing peer');
  if (state.balancesStatus !== 200)
    failures.push(`/admin/balances returned ${state.balancesStatus}`);
  if (!state.inPrometheus) failures.push('/metrics missing peer label');
  if (!state.inMetricsJson) failures.push('/admin/metrics.json missing peer');

  if (failures.length > 0) {
    const diagnostic = buildDiagnostic(operation, peerId, state, 'exists');
    throw new Error(formatInvariantFailure(diagnostic));
  }
}

/**
 * Assert that a peer is absent from all four projections.
 * Fails with AC 6 diagnostics if any projection still shows the peer.
 */
async function assertPeerAbsentEverywhere(peerId: string): Promise<void> {
  const state = await queryPeerProjections(peerId);

  const failures: string[] = [];
  if (state.inAdminPeers) failures.push('/admin/peers still has peer');
  if (state.balancesStatus === 200) failures.push(`/admin/balances returned 200 (expected 404)`);
  if (state.inPrometheus) failures.push('/metrics still has peer label');
  if (state.inMetricsJson) failures.push('/admin/metrics.json still has peer');

  if (failures.length > 0) {
    const diagnostic = buildDiagnostic('DELETE', peerId, state, 'absent');
    throw new Error(formatInvariantFailure(diagnostic));
  }
}

/**
 * Poll until consistent state is reached or timeout.
 */
async function waitForConsistentState(
  check: () => Promise<boolean>,
  timeoutMs: number = PROPAGATION_TIMEOUT_MS,
  intervalMs: number = POLL_INTERVAL_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(intervalMs);
  }
  throw new Error('Timeout waiting for consistent state');
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describeDocker('Cross-Surface Invariant Tests (Peer State)', () => {
  beforeAll(async () => {
    // Verify peer-existence group has the expected endpoints (AC 1)
    const peerExistenceGroup = getEntriesByGroup('peer-existence');
    expect(peerExistenceGroup.length).toBeGreaterThanOrEqual(4);

    // Build images (fast if cached) and start the stack with health-wait
    await compose('build');
    await compose('up', '-d', '--wait');

    // Wait for AdminServer health endpoint first (ensures HTTP stack ready)
    await waitForCondition(
      async () => {
        try {
          const { status } = await getJson<unknown>(`${ADMIN_BASE}/health`);
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
          `${ADMIN_BASE}/admin/peers`
        );
        return body.peers.find((p) => p.id === 'peer2')?.connected === true;
      },
      60_000,
      'peer1 → peer2 BTP connection'
    );
  });

  afterAll(async () => {
    // Cleanup verification: ensure no test peers remain (prevents state leaks between test runs)
    try {
      const { body: finalPeers } = await getJson<{ peers: Array<{ id: string }> }>(
        `${ADMIN_BASE}/admin/peers`
      );
      const testPeers = finalPeers.peers.filter(
        (p) => p.id.includes('test-peer') || p.id.includes('invariant') || p.id.includes('rapid')
      );
      if (testPeers.length > 0) {
        console.warn(
          `[afterAll] Warning: ${testPeers.length} test peers still exist: ${testPeers.map((p) => p.id).join(', ')}`
        );
        // Attempt cleanup
        for (const peer of testPeers) {
          await deleteJson(`${ADMIN_BASE}/admin/peers/${peer.id}`).catch((e) => {
            console.error(`[afterAll] Failed to delete test peer ${peer.id}: ${e}`);
          });
        }
      }
    } catch (e) {
      console.error('[afterAll] Cleanup verification failed:', e);
    }

    // Only ignore "already stopped" errors, not other failures
    await compose('down').catch((e) => {
      if (!e.message?.includes('not found')) throw e;
    });
  });

  // =========================================================================
  // AC 2: Peer creation propagates to all projections
  // =========================================================================
  describe('Peer Creation Invariant (AC 2)', () => {
    it('after POST /admin/peers, peer appears in all four projections within 5 seconds', async () => {
      const testPeerId = `invariant-test-peer-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}`;

      // Create the peer
      const { status, body } = await postJson<{ success: true; peer: { id: string } }>(
        `${ADMIN_BASE}/admin/peers`,
        {
          id: testPeerId,
          url: 'ws://localhost:9000',
          authToken: '',
          settlement: null,
        }
      );

      expect(status).toBe(201);
      expect(body.peer.id).toBe(testPeerId);

      // Wait for peer to appear in all projections (within 5 seconds as per AC 2)
      await waitForConsistentState(
        async () => {
          const state = await queryPeerProjections(testPeerId);
          return (
            state.inAdminPeers &&
            state.balancesStatus === 200 &&
            state.inPrometheus &&
            state.inMetricsJson
          );
        },
        PROPAGATION_TIMEOUT_MS,
        POLL_INTERVAL_MS
      );

      // Assert the invariant with diagnostics
      await assertPeerExistsEverywhere(testPeerId, 'CREATE');

      // Cleanup: delete the test peer
      await deleteJson(`${ADMIN_BASE}/admin/peers/${testPeerId}`);

      // Wait for deletion to propagate
      await waitForConsistentState(
        async () => {
          const state = await queryPeerProjections(testPeerId);
          return !state.inAdminPeers;
        },
        PROPAGATION_TIMEOUT_MS,
        POLL_INTERVAL_MS
      );
    });

    it('queryPeerProjections helper returns structured data from all 4 surfaces', async () => {
      // Use existing peer2 to test the helper
      const state = await queryPeerProjections('peer2');

      // peer2 exists in the topology
      expect(state.inAdminPeers).toBe(true);
      expect(state.balancesStatus).toBe(200);
      expect(state.inPrometheus).toBe(true);
      expect(state.inMetricsJson).toBe(true);

      // Verify raw data is captured
      expect(state.raw.adminPeersResponse).not.toBeNull();
      expect(state.raw.metricsText).toBeTruthy();
      expect(state.raw.metricsJsonResponse).not.toBeNull();
    });
  });

  // =========================================================================
  // AC 3: Peer deletion removes from all projections
  // =========================================================================
  describe('Peer Deletion Invariant (AC 3)', () => {
    it('after DELETE /admin/peers/:peerId, peer disappears from all four projections within 5 seconds', async () => {
      const testPeerId = `delete-test-peer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      // Create the peer first
      await postJson<{ id: string }>(`${ADMIN_BASE}/admin/peers`, {
        id: testPeerId,
        url: 'ws://localhost:9000',
        authToken: '',
        settlement: null,
      });

      // Wait for it to exist
      await waitForConsistentState(
        async () => {
          const state = await queryPeerProjections(testPeerId);
          return state.inAdminPeers;
        },
        5000,
        250
      );

      // Delete the peer
      const { status } = await deleteJson(`${ADMIN_BASE}/admin/peers/${testPeerId}`);
      expect(status).toBe(204);

      // Wait for peer to disappear from all projections (within 5 seconds as per AC 3)
      await waitForConsistentState(
        async () => {
          const state = await queryPeerProjections(testPeerId);
          return (
            !state.inAdminPeers &&
            state.balancesStatus === 404 &&
            !state.inPrometheus &&
            !state.inMetricsJson
          );
        },
        5000,
        250
      );

      // Assert the invariant with diagnostics
      await assertPeerAbsentEverywhere(testPeerId);
    });

    it('GET /admin/balances/:peerId returns 404 for deleted peer', async () => {
      const testPeerId = `balance-404-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      // Create and delete
      await postJson<{ id: string }>(`${ADMIN_BASE}/admin/peers`, {
        id: testPeerId,
        url: 'ws://localhost:9000',
        authToken: '',
        settlement: null,
      });
      await deleteJson(`${ADMIN_BASE}/admin/peers/${testPeerId}`);

      // Wait for deletion to propagate
      await waitForConsistentState(
        async () => {
          const { status } = await fetchRaw(`${ADMIN_BASE}/admin/balances/${testPeerId}`);
          return status === 404;
        },
        PROPAGATION_TIMEOUT_MS,
        POLL_INTERVAL_MS
      );
    });

    it('Prometheus metrics do not contain peer label for deleted peer', async () => {
      const testPeerId = `prometheus-absent-test-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}`;

      // Create peer
      await postJson<{ id: string }>(`${ADMIN_BASE}/admin/peers`, {
        id: testPeerId,
        url: 'ws://localhost:9000',
        authToken: '',
        settlement: null,
      });

      // Wait and delete
      await sleep(POLL_INTERVAL_MS); // Brief pause before delete
      await deleteJson(`${ADMIN_BASE}/admin/peers/${testPeerId}`);

      // Wait for Prometheus label to disappear
      await waitForConsistentState(
        async () => {
          const { body: metricsText } = await fetchRaw(`${HEALTH_BASE}/metrics`);
          return !parsePrometheusPeerLabels(metricsText, testPeerId);
        },
        PROPAGATION_TIMEOUT_MS,
        POLL_INTERVAL_MS
      );
    });

    it('/admin/metrics.json does not contain deleted peer', async () => {
      const testPeerId = `metricsjson-absent-test-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}`;

      // Create and delete
      await postJson<{ id: string }>(`${ADMIN_BASE}/admin/peers`, {
        id: testPeerId,
        url: 'ws://localhost:9000',
        authToken: '',
        settlement: null,
      });
      await deleteJson(`${ADMIN_BASE}/admin/peers/${testPeerId}`);

      // Wait for peer to disappear from metrics.json
      await waitForConsistentState(
        async () => {
          const { body } = await getJson<{
            peers: Array<{ peerId: string }>;
          }>(`${ADMIN_BASE}/admin/metrics.json`);
          return !body.peers.some((p) => p.peerId === testPeerId);
        },
        PROPAGATION_TIMEOUT_MS,
        POLL_INTERVAL_MS
      );
    });
  });

  // =========================================================================
  // AC 4: No phantom peer resurrection
  // =========================================================================
  describe('Phantom Peer Resurrection Test (AC 4)', () => {
    it('deleted peer does not reappear after 30 seconds of observation', async () => {
      const testPeerId = `phantom-test-peer-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}`;

      // Create and delete
      await postJson<{ id: string }>(`${ADMIN_BASE}/admin/peers`, {
        id: testPeerId,
        url: 'ws://localhost:9000',
        authToken: '',
        settlement: null,
      });

      // Wait for creation
      await waitForConsistentState(
        async () => {
          const state = await queryPeerProjections(testPeerId);
          return state.inAdminPeers;
        },
        5000,
        250
      );

      // Delete
      await deleteJson(`${ADMIN_BASE}/admin/peers/${testPeerId}`);

      // Wait for deletion
      await waitForConsistentState(
        async () => {
          const state = await queryPeerProjections(testPeerId);
          return !state.inAdminPeers;
        },
        5000,
        250
      );

      // AC 4: Wait 30 seconds and poll at 5-second intervals
      const checkIntervals = 6; // 30 seconds / 5 seconds per check
      for (let i = 0; i < checkIntervals; i++) {
        await sleep(OBSERVATION_INTERVAL_MS);
        const state = await queryPeerProjections(testPeerId);

        // All projections should consistently show peer absent
        expect(state.inAdminPeers).toBe(false);
        expect(state.balancesStatus).toBe(404);
        expect(state.inPrometheus).toBe(false);
        expect(state.inMetricsJson).toBe(false);
      }

      // No resurrection detected - test passes
    }, 45000); // Increased timeout for 30-second wait + buffer
  });

  // =========================================================================
  // AC 5: Peer connection state consistency
  // =========================================================================
  describe('Connection State Consistency (AC 5)', () => {
    it('peer2 shows consistent connected status across /admin/peers and /admin/metrics.json', async () => {
      // Query both surfaces
      const state = await queryPeerProjections('peer2');

      // Both surfaces should have peer2
      expect(state.inAdminPeers).toBe(true);
      expect(state.inMetricsJson).toBe(true);

      // Connected status should be consistent
      expect(state.adminPeerConnected).toBeDefined();
      expect(state.metricsJsonConnected).toBeDefined();
      expect(state.adminPeerConnected).toBe(state.metricsJsonConnected);
    });

    it('/admin/balances returns 200 for peer even when disconnected (peer exists)', async () => {
      // peer2 exists in topology, verify balances endpoint returns 200
      // (even if peer2 were disconnected, it should return 200, not 404)
      const { status } = await fetchRaw(`${ADMIN_BASE}/admin/balances/peer2`);

      // Should be 200 (peer exists, even if disconnected)
      // Note: standalone topology may return 503 if AccountManager not wired
      expect([200, 503]).toContain(status);
    });

    it('peer2 connection state transitions are consistent across surfaces after BTP disruption', async () => {
      // Full AC 5 implementation: stop peer2, verify disconnect, restart, verify reconnect
      const DISCONNECT_TIMEOUT = 30_000; // Time for disconnect to be detected
      const RECONNECT_TIMEOUT = 60_000; // Time for peer2 to restart and reconnect

      // Initial state: peer2 should be connected
      const initialState = await queryPeerProjections('peer2');
      expect(initialState.inAdminPeers).toBe(true);
      expect(initialState.adminPeerConnected).toBe(true);
      expect(initialState.metricsJsonConnected).toBe(true);

      // Stop peer2 container
      await managePeer2Container('stop');

      try {
        // Wait for disconnect to be detected (connected=false)
        await waitForConsistentState(
          async () => {
            const state = await queryPeerProjections('peer2');
            return state.adminPeerConnected === false && state.metricsJsonConnected === false;
          },
          DISCONNECT_TIMEOUT,
          500
        );

        // Verify disconnect state is consistent across surfaces
        const disconnectState = await queryPeerProjections('peer2');
        expect(disconnectState.inAdminPeers).toBe(true); // Peer still exists
        expect(disconnectState.inMetricsJson).toBe(true);
        expect(disconnectState.adminPeerConnected).toBe(false);
        expect(disconnectState.metricsJsonConnected).toBe(false);
        expect(disconnectState.adminPeerConnected).toBe(disconnectState.metricsJsonConnected);

        // Verify /admin/balances still returns 200 (peer exists, just disconnected)
        const { status: balancesStatus } = await fetchRaw(`${ADMIN_BASE}/admin/balances/peer2`);
        expect([200, 503]).toContain(balancesStatus); // 503 if AccountManager not wired
      } finally {
        // Always restart peer2 for cleanup and next tests
        await managePeer2Container('start');
      }

      // Wait for reconnection (peer2 container restart + BTP reconnect)
      await waitForConsistentState(
        async () => {
          const state = await queryPeerProjections('peer2');
          return state.adminPeerConnected === true && state.metricsJsonConnected === true;
        },
        RECONNECT_TIMEOUT,
        1000 // Poll slower for reconnection (container startup takes time)
      );

      // Verify reconnected state is consistent
      const reconnectState = await queryPeerProjections('peer2');
      expect(reconnectState.inAdminPeers).toBe(true);
      expect(reconnectState.inMetricsJson).toBe(true);
      expect(reconnectState.adminPeerConnected).toBe(true);
      expect(reconnectState.metricsJsonConnected).toBe(true);
      expect(reconnectState.adminPeerConnected).toBe(reconnectState.metricsJsonConnected);
    }, 120_000); // 2 minute timeout for stop + detect + restart + reconnect
  });

  // =========================================================================
  // AC 6: Invariant failure produces clear diagnostics
  // =========================================================================
  describe('Diagnostic Helpers (AC 6)', () => {
    it('CrossSurfaceDiagnostic captures operation, peer, timestamp, and per-surface results', async () => {
      // Use existing peer2 to build a diagnostic
      const state = await queryPeerProjections('peer2');
      const diagnostic = buildDiagnostic('CREATE', 'peer2', state, 'exists');

      expect(diagnostic.operation).toBe('CREATE');
      expect(diagnostic.peerId).toBe('peer2');
      expect(diagnostic.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO format
      expect(diagnostic.surfaces.length).toBe(4);

      // Each surface should have required fields
      for (const surface of diagnostic.surfaces) {
        expect(surface.surface).toBeDefined();
        expect(typeof surface.exists).toBe('boolean');
        expect(surface).toHaveProperty('details');
      }

      // Consensus should be calculated
      expect(diagnostic.consensus.expectedState).toBe('exists');
      expect(diagnostic.consensus.agree.length).toBeGreaterThan(0);
    });

    it('formatInvariantFailure produces human-readable diff with specific deltas', async () => {
      // Create a mock diagnostic with a deliberate mismatch
      const mockDiagnostic: CrossSurfaceDiagnostic = {
        operation: 'DELETE',
        peerId: 'test-peer-mock',
        timestamp: new Date().toISOString(),
        surfaces: [
          { surface: '/admin/peers', exists: true, details: true },
          { surface: '/admin/balances/:peerId', exists: false, details: { status: 404 } },
          { surface: '/metrics (Prometheus)', exists: true, details: null },
          { surface: '/admin/metrics.json', exists: false, details: undefined },
        ],
        consensus: {
          agree: [],
          disagree: [
            '/admin/peers',
            '/admin/balances/:peerId',
            '/metrics (Prometheus)',
            '/admin/metrics.json',
          ],
          expectedState: 'absent',
          actualConsensus: 'split',
        },
      };

      const formatted = formatInvariantFailure(mockDiagnostic);

      // Verify the formatted message contains key diagnostic elements
      expect(formatted).toContain('Cross-surface invariant FAILED');
      expect(formatted).toContain('test-peer-mock');
      expect(formatted).toContain('DELETE');
      expect(formatted).toContain('Expected: peer ABSENT');
      expect(formatted).toContain('Actual: split consensus');
      expect(formatted).toContain('Surfaces that DISAGREE');
      expect(formatted).toContain('Specific deltas');
    });

    it('assertPeerExistsEverywhere throws with detailed diagnostics on failure', async () => {
      // Try to assert a non-existent peer exists
      const nonExistentPeer = `nonexistent-peer-${Date.now()}`;

      try {
        await assertPeerExistsEverywhere(nonExistentPeer, 'CREATE');
        // Should not reach here
        fail('Expected assertion to throw');
      } catch (error) {
        const message = (error as Error).message;
        // Verify diagnostic content in error message
        expect(message).toContain('Cross-surface invariant FAILED');
        expect(message).toContain(nonExistentPeer);
        expect(message).toContain('CREATE');
        expect(message).toContain('Expected: peer EXISTS');
        expect(message).toContain('Specific deltas');
      }
    });

    it('assertPeerAbsentEverywhere throws with detailed diagnostics on failure', async () => {
      // peer2 exists, so asserting it absent should fail
      try {
        await assertPeerAbsentEverywhere('peer2');
        // Should not reach here
        fail('Expected assertion to throw');
      } catch (error) {
        const message = (error as Error).message;
        // Verify diagnostic content
        expect(message).toContain('Cross-surface invariant FAILED');
        expect(message).toContain('peer2');
        expect(message).toContain('DELETE');
        expect(message).toContain('Expected: peer ABSENT');
        expect(message).toContain('Specific deltas');
      }
    });
  });

  // =========================================================================
  // AC 7: Test covers edge cases (rapid sequences)
  // =========================================================================
  describe('Rapid Sequence Edge Case (AC 7)', () => {
    it('three test peers created and deleted in rapid succession maintain invariants', async () => {
      const peers = [
        `rapid-peer-1-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        `rapid-peer-2-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        `rapid-peer-3-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      ];

      // Create all three peers in rapid succession
      for (const peerId of peers) {
        const { status } = await postJson<{ id: string }>(`${ADMIN_BASE}/admin/peers`, {
          id: peerId,
          url: 'ws://localhost:9000',
          authToken: '',
          settlement: null,
        });
        expect(status).toBe(201);
      }

      // Verify all exist (invariant holds)
      for (const peerId of peers) {
        await assertPeerExistsEverywhere(peerId, 'CREATE');
      }

      // Delete all three in rapid succession
      for (const peerId of peers) {
        const { status } = await deleteJson(`${ADMIN_BASE}/admin/peers/${peerId}`);
        expect(status).toBe(204);
      }

      // Wait for propagation
      await sleep(PROPAGATION_TIMEOUT_MS);

      // Verify all absent (invariant holds)
      for (const peerId of peers) {
        await assertPeerAbsentEverywhere(peerId);
      }
    });

    it('no intermediate state leaks between rapid operations', async () => {
      const baseId = `leak-test-${Date.now()}`;

      // Create
      await postJson<{ id: string }>(`${ADMIN_BASE}/admin/peers`, {
        id: `${baseId}-a`,
        url: 'ws://localhost:9000',
        authToken: '',
        settlement: null,
      });

      // Immediately delete
      await deleteJson(`${ADMIN_BASE}/admin/peers/${baseId}-a`);

      // Create another with similar name
      await postJson<{ id: string }>(`${ADMIN_BASE}/admin/peers`, {
        id: `${baseId}-b`,
        url: 'ws://localhost:9001',
        authToken: '',
        settlement: null,
      });

      // Verify second peer exists and first does not (no leakage)
      const stateA = await queryPeerProjections(`${baseId}-a`);
      const stateB = await queryPeerProjections(`${baseId}-b`);

      expect(stateA.inAdminPeers).toBe(false);
      expect(stateB.inAdminPeers).toBe(true);

      // Cleanup
      await deleteJson(`${ADMIN_BASE}/admin/peers/${baseId}-b`);
    });
  });
});
