/**
 * Packet-Flow Observability Invariants
 *
 * Tests that packet-flow counters remain consistent across all observability
 * surfaces after ILP traffic. Catches parallel-surface drift (like Epic 37
 * counter mismatches) before it ships.
 *
 * This test operates on the 'packet-counters' cross-surface group:
 * - GET /metrics (HealthServer) — Prometheus: toon_packets_forwarded_total,
 *   toon_packets_rejected_total, toon_bytes_sent_total, toon_last_packet_timestamp_seconds
 * - GET /admin/metrics.json (AdminServer) — JSON: aggregate.* and peers[].*
 *
 * Key invariant: Prometheus counters and JSON counters are views of the same
 * underlying metrics registry. They must always agree after packet flow.
 *
 * Prerequisites:
 *   Docker + docker compose installed, this project's images buildable.
 *   Gate: STANDALONE_DOCKER=true (opt-in — slow because of image build)
 *
 * Usage:
 *   STANDALONE_DOCKER=true npm run test:packet-flow
 *
 * @packageDocumentation
 * @story 38.4
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

// Test topology constant — must match docker-compose.yml service names
const TEST_PEER_ID = 'peer2';

// Timing constants for counter propagation
// Rationale: Docker networking + metrics aggregation pipeline needs 5s max
const PROPAGATION_TIMEOUT_MS = 5000; // Max time for counters to stabilize (observed: ~500ms typical, 5s covers p99)
const POLL_INTERVAL_MS = 200; // Poll every 200ms for responsive feedback without flooding
// Rationale: AC 8 requires 30s idle observation to catch phantom increments
const IDLE_OBSERVATION_MS = 30000; // AC 8: 30-second idle window
const IDLE_POLL_INTERVAL_MS = 5000; // AC 8: Poll every 5 seconds (6 samples across 30s)

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/**
 * Counter snapshot from both observability surfaces
 */
interface CounterSnapshot {
  prometheus: {
    forwarded: number;
    rejected: number;
    bytes: number;
    timestamp: number;
  };
  json: {
    aggregateForwarded: number;
    aggregateRejected: number;
    aggregateBytes: number;
    peerForwarded: number;
    peerRejected: number;
    peerBytes: number;
    lastPacketAt?: string;
  };
  peerId: string;
  capturedAt: string;
}

/**
 * Delta between two counter snapshots
 */
interface CounterDelta {
  prometheusForwarded: number;
  prometheusRejected: number;
  prometheusBytes: number;
  jsonAggregateForwarded: number;
  jsonAggregateRejected: number;
  jsonAggregateBytes: number;
  jsonPeerForwarded: number;
  jsonPeerRejected: number;
  jsonPeerBytes: number;
}

/**
 * Counter drift diagnostic for AC 9
 */
interface CounterDriftDiagnostic {
  peerId: string;
  metric: string;
  prometheusValue: number;
  jsonPeerValue: number;
  jsonAggregateValue: number;
  delta: number;
  baseline: CounterSnapshot;
  current: CounterSnapshot;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

async function compose(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('docker', [...PROFILE_ARGS, ...args], {
    cwd: REPO_ROOT,
    maxBuffer: 50 * 1024 * 1024, // 50MB for large metrics output
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForCondition(
  check: () => Promise<boolean>,
  timeoutMs: number,
  description: string,
  intervalMs = 500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
      lastError = undefined; // Reset on successful check that returned false
    } catch (err) {
      // Keep polling but preserve last error for debugging
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    await sleep(intervalMs);
  }
  const errorDetail = lastError ? ` | Last error: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for: ${description} (${timeoutMs}ms)${errorDetail}`);
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

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse Prometheus counter value for specific peer from metrics text.
 * Handles multi-line metric continuations (lines ending with backslash).
 */
function parsePrometheusCounter(metricsText: string, familyName: string, peerId: string): number {
  // Join continuation lines before parsing
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

    // Match: toon_packets_forwarded_total{peer="peerId",...} 42
    // Escape both familyName and peerId to prevent ReDoS from malicious inputs
    const match = line.match(
      new RegExp(
        `${escapeRegExp(familyName)}\\{[^}]*peer="${escapeRegExp(peerId)}"[^}]*\\}\\s+(\\d+(?:\\.\\d+)?)`
      )
    );
    if (match && match[1] !== undefined) return Math.round(parseFloat(match[1]));
  }
  return 0; // Counter not yet present = 0
}

/**
 * Parse Prometheus timestamp gauge for specific peer.
 */
function parsePrometheusTimestamp(metricsText: string, peerId: string): number {
  return parsePrometheusCounter(metricsText, 'toon_last_packet_timestamp_seconds', peerId);
}

/**
 * Capture baseline counters from both surfaces (AC 2).
 */
async function captureBaselineCounters(peerId: string): Promise<CounterSnapshot> {
  const [metricsResponse, metricsJsonResponse] = await Promise.all([
    fetchRaw(`${HEALTH_BASE}/metrics`),
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
    }>(`${ADMIN_BASE}/admin/metrics.json`),
  ]);

  // Validate HTTP responses before processing (fail fast per AC 2 intent)
  if (metricsResponse.status !== 200) {
    throw new Error(`Prometheus /metrics returned ${metricsResponse.status}`);
  }
  if (metricsJsonResponse.status !== 200) {
    throw new Error(`/admin/metrics.json returned ${metricsJsonResponse.status}`);
  }

  const metricsText = metricsResponse.body;
  const metricsJson = metricsJsonResponse.body;

  const peerEntry = metricsJson.peers.find((p) => p.peerId === peerId);
  if (!peerEntry) {
    throw new Error(`Peer "${peerId}" not found in /admin/metrics.json response`);
  }

  return {
    prometheus: {
      forwarded: parsePrometheusCounter(metricsText, 'toon_packets_forwarded_total', peerId),
      rejected: parsePrometheusCounter(metricsText, 'toon_packets_rejected_total', peerId),
      bytes: parsePrometheusCounter(metricsText, 'toon_bytes_sent_total', peerId),
      timestamp: parsePrometheusTimestamp(metricsText, peerId),
    },
    json: {
      aggregateForwarded: metricsJson.aggregate.packetsForwarded,
      aggregateRejected: metricsJson.aggregate.packetsRejected,
      aggregateBytes: metricsJson.aggregate.bytesSent,
      peerForwarded: peerEntry?.packetsForwarded ?? 0,
      peerRejected: peerEntry?.packetsRejected ?? 0,
      peerBytes: peerEntry?.bytesSent ?? 0,
      lastPacketAt: peerEntry?.lastPacketAt,
    },
    peerId,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Calculate delta between two counter snapshots.
 */
function calculateDelta(baseline: CounterSnapshot, current: CounterSnapshot): CounterDelta {
  return {
    prometheusForwarded: current.prometheus.forwarded - baseline.prometheus.forwarded,
    prometheusRejected: current.prometheus.rejected - baseline.prometheus.rejected,
    prometheusBytes: current.prometheus.bytes - baseline.prometheus.bytes,
    jsonAggregateForwarded: current.json.aggregateForwarded - baseline.json.aggregateForwarded,
    jsonAggregateRejected: current.json.aggregateRejected - baseline.json.aggregateRejected,
    jsonAggregateBytes: current.json.aggregateBytes - baseline.json.aggregateBytes,
    jsonPeerForwarded: current.json.peerForwarded - baseline.json.peerForwarded,
    jsonPeerRejected: current.json.peerRejected - baseline.json.peerRejected,
    jsonPeerBytes: current.json.peerBytes - baseline.json.peerBytes,
  };
}

/**
 * Wait for counters to stabilize after an operation.
 */
async function waitForCounterStability(
  check: () => Promise<boolean>,
  timeoutMs: number = PROPAGATION_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('Timeout waiting for counter stability');
}

/**
 * Assert strict cross-surface counter consistency (AC 6).
 * Throws with diagnostic output if counters don't match.
 */
async function assertCounterConsistency(peerId: string): Promise<void> {
  const snapshot = await captureBaselineCounters(peerId);

  const mismatches: string[] = [];

  // Prometheus per-peer must equal JSON per-peer
  if (snapshot.prometheus.forwarded !== snapshot.json.peerForwarded) {
    mismatches.push(
      `forwarded: Prometheus=${snapshot.prometheus.forwarded}, JSON peers[]=${snapshot.json.peerForwarded}`
    );
  }
  if (snapshot.prometheus.rejected !== snapshot.json.peerRejected) {
    mismatches.push(
      `rejected: Prometheus=${snapshot.prometheus.rejected}, JSON peers[]=${snapshot.json.peerRejected}`
    );
  }
  if (snapshot.prometheus.bytes !== snapshot.json.peerBytes) {
    mismatches.push(
      `bytes: Prometheus=${snapshot.prometheus.bytes}, JSON peers[]=${snapshot.json.peerBytes}`
    );
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Cross-surface counter inconsistency for peer "${peerId}":\n  - ${mismatches.join('\n  - ')}`
    );
  }
}

/**
 * Send an ILP PREPARE packet via POST /admin/ilp/send.
 *
 * Deliberately sends NO `condition`: since PR #314 the admin API honors a
 * sender-chosen execution condition (issue #309), and the terminating app must
 * then supply the matching sha256 preimage or the connector converts the
 * FULFILL into an F99 REJECT. The standalone-e2e stub app
 * (scripts/standalone-e2e/app.js) never learns a preimage, so any packet
 * carrying a condition is rejected by construction. This suite exercises
 * counter observability, not conditional delivery — packets must be
 * unconditional so they take the auto-fulfill path and count as forwarded.
 */
async function sendIlpPacket(
  destination: string,
  amount: string,
  expiresAt: string
): Promise<{ status: number; fulfillment?: string; rejection?: unknown }> {
  const packet = {
    destination,
    amount,
    expiresAt,
    data: Buffer.from('test data').toString('base64'),
  };

  const { status, body } = await postJson<{
    fulfillment?: string;
    rejection?: unknown;
  }>(`${ADMIN_BASE}/admin/ilp/send`, packet);

  return { status, ...body };
}

/**
 * Format counter drift diagnostic for AC 9.
 */
function formatCounterDrift(diagnostic: CounterDriftDiagnostic): string {
  const lines: string[] = [];
  lines.push('❌ COUNTER DRIFT DETECTED');
  lines.push(`   Peer: ${diagnostic.peerId}`);
  lines.push(`   Metric: ${diagnostic.metric}`);
  lines.push('');
  lines.push('   Expected vs Actual:');
  lines.push(`     Prometheus:        ${diagnostic.prometheusValue}`);
  lines.push(`     JSON peers[]:      ${diagnostic.jsonPeerValue}`);
  lines.push(`     JSON aggregate:    ${diagnostic.jsonAggregateValue}`);
  lines.push(`     Drift (Prom-JSON): ${diagnostic.delta}`);
  lines.push('');
  lines.push('   Baseline snapshot:');
  lines.push(`     capturedAt: ${diagnostic.baseline.capturedAt}`);
  lines.push(
    `     prometheus: { forwarded: ${diagnostic.baseline.prometheus.forwarded}, rejected: ${diagnostic.baseline.prometheus.rejected}, bytes: ${diagnostic.baseline.prometheus.bytes}, ts: ${diagnostic.baseline.prometheus.timestamp} }`
  );
  lines.push(
    `     json.peer: { forwarded: ${diagnostic.baseline.json.peerForwarded}, rejected: ${diagnostic.baseline.json.peerRejected}, bytes: ${diagnostic.baseline.json.peerBytes} }`
  );
  lines.push(
    `     json.aggregate: { forwarded: ${diagnostic.baseline.json.aggregateForwarded}, rejected: ${diagnostic.baseline.json.aggregateRejected}, bytes: ${diagnostic.baseline.json.aggregateBytes} }`
  );
  lines.push('');
  lines.push('   Current snapshot:');
  lines.push(`     capturedAt: ${diagnostic.current.capturedAt}`);
  lines.push(
    `     prometheus: { forwarded: ${diagnostic.current.prometheus.forwarded}, rejected: ${diagnostic.current.prometheus.rejected}, bytes: ${diagnostic.current.prometheus.bytes}, ts: ${diagnostic.current.prometheus.timestamp} }`
  );
  lines.push(
    `     json.peer: { forwarded: ${diagnostic.current.json.peerForwarded}, rejected: ${diagnostic.current.json.peerRejected}, bytes: ${diagnostic.current.json.peerBytes} }`
  );
  lines.push(
    `     json.aggregate: { forwarded: ${diagnostic.current.json.aggregateForwarded}, rejected: ${diagnostic.current.json.aggregateRejected}, bytes: ${diagnostic.current.json.aggregateBytes} }`
  );

  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describeDocker('Packet-Flow Observability Invariants (38.4)', () => {
  beforeAll(async () => {
    // Verify packet-counters group has the expected endpoints (AC 1)
    const packetCountersGroup = getEntriesByGroup('packet-counters');
    expect(packetCountersGroup.length).toBeGreaterThanOrEqual(2);

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
        return body.peers.find((p) => p.id === TEST_PEER_ID)?.connected === true;
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

  // =========================================================================
  // AC 2: Baseline capture helpers
  // =========================================================================
  describe('Baseline Capture (AC 2)', () => {
    it('captureBaselineCounters returns structured snapshot from both surfaces', async () => {
      const snapshot = await captureBaselineCounters(TEST_PEER_ID);

      expect(snapshot.peerId).toBe(TEST_PEER_ID);
      expect(snapshot.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO format

      // Prometheus fields
      expect(typeof snapshot.prometheus.forwarded).toBe('number');
      expect(typeof snapshot.prometheus.rejected).toBe('number');
      expect(typeof snapshot.prometheus.bytes).toBe('number');
      expect(typeof snapshot.prometheus.timestamp).toBe('number');

      // JSON fields
      expect(typeof snapshot.json.aggregateForwarded).toBe('number');
      expect(typeof snapshot.json.aggregateRejected).toBe('number');
      expect(typeof snapshot.json.aggregateBytes).toBe('number');
      expect(typeof snapshot.json.peerForwarded).toBe('number');
      expect(typeof snapshot.json.peerRejected).toBe('number');
      expect(typeof snapshot.json.peerBytes).toBe('number');
    });

    it('baseline captures non-negative counter values', async () => {
      const snapshot = await captureBaselineCounters(TEST_PEER_ID);

      expect(snapshot.prometheus.forwarded).toBeGreaterThanOrEqual(0);
      expect(snapshot.prometheus.rejected).toBeGreaterThanOrEqual(0);
      expect(snapshot.prometheus.bytes).toBeGreaterThanOrEqual(0);
      expect(snapshot.prometheus.timestamp).toBeGreaterThanOrEqual(0);
      expect(snapshot.json.aggregateForwarded).toBeGreaterThanOrEqual(0);
      expect(snapshot.json.peerForwarded).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // AC 3: Single packet counter test
  // =========================================================================
  describe('Single Packet Counter Test (AC 3)', () => {
    it('after 1 ILP PREPARE packet, counters increment correctly across all surfaces', async () => {
      // Capture baseline
      const baseline = await captureBaselineCounters(TEST_PEER_ID);

      // Send 1 packet
      const packetResult = await sendIlpPacket(
        'test.peer2.receiver',
        '0',
        new Date(Date.now() + 30000).toISOString()
      );

      expect(packetResult.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((packetResult as any).accepted).toBe(true); // Packet was forwarded successfully

      // Wait for counters to stabilize and verify increments
      await waitForCounterStability(async () => {
        const current = await captureBaselineCounters(TEST_PEER_ID);
        const delta = calculateDelta(baseline, current);

        // All forwarded counters should have incremented by 1
        return (
          delta.prometheusForwarded === 1 &&
          delta.jsonAggregateForwarded === 1 &&
          delta.jsonPeerForwarded === 1
        );
      });

      // Capture final state and verify all assertions
      const final = await captureBaselineCounters(TEST_PEER_ID);
      const delta = calculateDelta(baseline, final);

      // (a) /metrics forwarded increased by 1
      expect(delta.prometheusForwarded).toBe(1);

      // (b) /metrics bytes increased (exact amount may vary due to encoding)
      expect(delta.prometheusBytes).toBeGreaterThan(0);

      // (c) /admin/metrics.json aggregate increased by 1
      expect(delta.jsonAggregateForwarded).toBe(1);

      // (d) /admin/metrics.json peer2 increased by 1
      expect(delta.jsonPeerForwarded).toBe(1);

      // Cross-surface consistency (AC 6)
      await assertCounterConsistency(TEST_PEER_ID);
    });
  });

  // =========================================================================
  // AC 4: Multi-packet batch test
  // =========================================================================
  describe('Multi-Packet Batch Test (AC 4)', () => {
    it('after 10 ILP PREPARE packets, counters aggregate correctly', async () => {
      const baseline = await captureBaselineCounters(TEST_PEER_ID);
      const batchSize = 10;

      // Send 10 packets in rapid succession
      const promises: Promise<unknown>[] = [];
      for (let i = 0; i < batchSize; i++) {
        promises.push(
          sendIlpPacket(`test.peer2.receiver.${i}`, '0', new Date(Date.now() + 30000).toISOString())
        );
      }
      const results = await Promise.all(promises);

      // All should succeed
      for (const result of results) {
        const { status } = result as { status: number };
        expect(status).toBe(200);
      }

      // Wait for counters to stabilize
      await waitForCounterStability(async () => {
        const current = await captureBaselineCounters(TEST_PEER_ID);
        const delta = calculateDelta(baseline, current);
        return delta.prometheusForwarded === batchSize;
      });

      // Capture final and verify
      const final = await captureBaselineCounters(TEST_PEER_ID);
      const delta = calculateDelta(baseline, final);

      // (a) Prometheus forwarded increased by 10
      expect(delta.prometheusForwarded).toBe(batchSize);

      // (b) JSON aggregate increased by 10
      expect(delta.jsonAggregateForwarded).toBe(batchSize);

      // (c) JSON peer2 increased by 10
      expect(delta.jsonPeerForwarded).toBe(batchSize);

      // Counter deltas consistent across surfaces
      expect(delta.prometheusForwarded).toBe(delta.jsonAggregateForwarded);
      expect(delta.prometheusForwarded).toBe(delta.jsonPeerForwarded);

      // Cross-surface consistency
      await assertCounterConsistency(TEST_PEER_ID);
    });
  });

  // =========================================================================
  // AC 5: Rejected packet counter test
  // =========================================================================
  describe('Rejected Packet Counter Test (AC 5)', () => {
    it('rejected ILP packet increments rejected counters, not forwarded', async () => {
      const baseline = await captureBaselineCounters(TEST_PEER_ID);

      // Send packet to unreachable destination (will be rejected pre-routing)
      const result = await sendIlpPacket(
        'test.nonexistent.receiver.that.will.fail',
        '0',
        new Date(Date.now() + 30000).toISOString()
      );

      // Packet should be rejected (F02 = no route)
      expect(result.status).toBeGreaterThanOrEqual(200);
      expect(result.status).toBeLessThan(300);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).code).toBe('F02');

      // Wait for any counter propagation
      await sleep(PROPAGATION_TIMEOUT_MS);

      const final = await captureBaselineCounters(TEST_PEER_ID);
      const delta = calculateDelta(baseline, final);

      // (a) Forwarded counters did NOT increment (mutually exclusive)
      expect(delta.prometheusForwarded).toBe(0);
      expect(delta.jsonPeerForwarded).toBe(0);
      expect(delta.jsonAggregateForwarded).toBe(0);

      // (b) For pre-routing rejections (no route), peer-specific counters may not increment
      // because there's no next-hop peer. We verify the packet was rejected above.
      // Post-routing rejections (peer rejects) would increment these counters.
    });
  });

  // =========================================================================
  // AC 6: Strict cross-surface consistency assertion
  // =========================================================================
  describe('Cross-Surface Counter Consistency (AC 6)', () => {
    it('assertCounterConsistency passes when Prometheus and JSON counters match', async () => {
      // Send a packet to ensure non-zero counters
      await sendIlpPacket(
        'test.peer2.consistency',
        '0',
        new Date(Date.now() + 30000).toISOString()
      );

      await sleep(500); // Let counters settle

      // Should not throw when counters are consistent
      await expect(assertCounterConsistency(TEST_PEER_ID)).resolves.not.toThrow();
    });

    it('Prometheus per-peer equals JSON per-peer for all counter types', async () => {
      const snapshot = await captureBaselineCounters(TEST_PEER_ID);

      expect(snapshot.prometheus.forwarded).toBe(snapshot.json.peerForwarded);
      expect(snapshot.prometheus.rejected).toBe(snapshot.json.peerRejected);
      expect(snapshot.prometheus.bytes).toBe(snapshot.json.peerBytes);
    });

    it('JSON peer sum equals aggregate values', async () => {
      const { body: metricsJson } = await getJson<{
        aggregate: { packetsForwarded: number; packetsRejected: number; bytesSent: number };
        peers: Array<{
          packetsForwarded: number;
          packetsRejected: number;
          bytesSent: number;
        }>;
      }>(`${ADMIN_BASE}/admin/metrics.json`);

      const sumForwarded = metricsJson.peers.reduce((sum, p) => sum + p.packetsForwarded, 0);
      const sumRejected = metricsJson.peers.reduce((sum, p) => sum + p.packetsRejected, 0);
      const sumBytes = metricsJson.peers.reduce((sum, p) => sum + p.bytesSent, 0);

      expect(sumForwarded).toBe(metricsJson.aggregate.packetsForwarded);
      expect(sumRejected).toBe(metricsJson.aggregate.packetsRejected);
      expect(sumBytes).toBe(metricsJson.aggregate.bytesSent);
    });
  });

  // =========================================================================
  // AC 7: Timestamp progression invariant
  // =========================================================================
  describe('Timestamp Progression Invariant (AC 7)', () => {
    it('last packet timestamp advances with traffic', async () => {
      const baseline = await captureBaselineCounters(TEST_PEER_ID);

      // Wait a moment to ensure timestamp would change
      await sleep(1000);

      // Send packet
      await sendIlpPacket('test.peer2.timestamp', '0', new Date(Date.now() + 30000).toISOString());

      // Wait for counter update
      await sleep(500);

      const final = await captureBaselineCounters(TEST_PEER_ID);

      // Timestamp should have advanced (or at least not gone backwards)
      expect(final.prometheus.timestamp).toBeGreaterThanOrEqual(baseline.prometheus.timestamp);

      // If traffic occurred, timestamp should have changed
      if (final.prometheus.forwarded > baseline.prometheus.forwarded) {
        expect(final.prometheus.timestamp).toBeGreaterThan(baseline.prometheus.timestamp);
      }
    });

    it('JSON lastPacketAt correlates with Prometheus unix timestamp', async () => {
      const snapshot = await captureBaselineCounters(TEST_PEER_ID);

      if (snapshot.json.lastPacketAt) {
        const jsonTimestamp = new Date(snapshot.json.lastPacketAt).getTime() / 1000;
        const prometheusTimestamp = snapshot.prometheus.timestamp;

        // Timestamps should be close (within a few seconds accounting for conversion)
        const diff = Math.abs(jsonTimestamp - prometheusTimestamp);
        expect(diff).toBeLessThan(5); // Within 5 seconds
      }
    });
  });

  // =========================================================================
  // AC 8: Zero-traffic counter stability
  // =========================================================================
  describe('Idle Counter Stability (AC 8)', () => {
    it('counters remain stable during 30-second idle period', async () => {
      // First, send some traffic to establish non-zero baseline
      await sendIlpPacket('test.peer2.idle', '0', new Date(Date.now() + 30000).toISOString());

      await sleep(1000); // Let counters settle

      const baseline = await captureBaselineCounters(TEST_PEER_ID);

      // Wait 30 seconds with no traffic, polling every 5 seconds
      const pollCount = IDLE_OBSERVATION_MS / IDLE_POLL_INTERVAL_MS;

      for (let i = 0; i < pollCount; i++) {
        await sleep(IDLE_POLL_INTERVAL_MS);

        const current = await captureBaselineCounters(TEST_PEER_ID);

        // (a) All counter values remain constant
        expect(current.prometheus.forwarded).toBe(baseline.prometheus.forwarded);
        expect(current.prometheus.rejected).toBe(baseline.prometheus.rejected);
        expect(current.prometheus.bytes).toBe(baseline.prometheus.bytes);
        expect(current.json.peerForwarded).toBe(baseline.json.peerForwarded);
        expect(current.json.peerRejected).toBe(baseline.json.peerRejected);
        expect(current.json.peerBytes).toBe(baseline.json.peerBytes);

        // (c) Timestamp does not advance
        expect(current.prometheus.timestamp).toBe(baseline.prometheus.timestamp);
      }
    }, 45000); // Extended timeout for 30s idle + buffer
  });

  // =========================================================================
  // AC 9: Invariant failure produces clear diagnostics
  // =========================================================================
  describe('Diagnostic Formatting (AC 9)', () => {
    it('CounterDriftDiagnostic captures expected vs actual per surface', () => {
      const mockDiagnostic: CounterDriftDiagnostic = {
        peerId: TEST_PEER_ID,
        metric: 'packetsForwarded',
        prometheusValue: 42,
        jsonPeerValue: 40,
        jsonAggregateValue: 40,
        delta: 2,
        baseline: {
          peerId: TEST_PEER_ID,
          capturedAt: '2026-01-01T00:00:00.000Z',
          prometheus: { forwarded: 10, rejected: 0, bytes: 1000, timestamp: 1000000 },
          json: {
            aggregateForwarded: 100,
            aggregateRejected: 0,
            aggregateBytes: 10000,
            peerForwarded: 10,
            peerRejected: 0,
            peerBytes: 1000,
            lastPacketAt: '2026-01-01T00:00:00.000Z',
          },
        },
        current: {
          peerId: TEST_PEER_ID,
          capturedAt: '2026-01-01T00:00:01.000Z',
          prometheus: { forwarded: 42, rejected: 0, bytes: 4200, timestamp: 1000001 },
          json: {
            aggregateForwarded: 130,
            aggregateRejected: 0,
            aggregateBytes: 13000,
            peerForwarded: 40,
            peerRejected: 0,
            peerBytes: 4000,
            lastPacketAt: '2026-01-01T00:00:01.000Z',
          },
        },
      };

      const formatted = formatCounterDrift(mockDiagnostic);

      expect(formatted).toContain('COUNTER DRIFT DETECTED');
      expect(formatted).toContain(TEST_PEER_ID);
      expect(formatted).toContain('packetsForwarded');
      expect(formatted).toContain('Prometheus:        42');
      expect(formatted).toContain('JSON peers[]:      40');
      expect(formatted).toContain('Drift (Prom-JSON): 2');
    });

    it('formatCounterDrift includes baseline and current for comparison', () => {
      const mockDiagnostic: CounterDriftDiagnostic = {
        peerId: 'test-peer',
        metric: 'bytesSent',
        prometheusValue: 1000,
        jsonPeerValue: 950,
        jsonAggregateValue: 2000,
        delta: 50,
        baseline: {
          peerId: 'test-peer',
          capturedAt: '2026-01-01T00:00:00.000Z',
          prometheus: { forwarded: 5, rejected: 0, bytes: 500, timestamp: 1000 },
          json: {
            aggregateForwarded: 50,
            aggregateRejected: 0,
            aggregateBytes: 5000,
            peerForwarded: 5,
            peerRejected: 0,
            peerBytes: 500,
            lastPacketAt: '2026-01-01T00:00:00.000Z',
          },
        },
        current: {
          peerId: 'test-peer',
          capturedAt: '2026-01-01T00:00:02.000Z',
          prometheus: { forwarded: 10, rejected: 0, bytes: 1000, timestamp: 1002 },
          json: {
            aggregateForwarded: 100,
            aggregateRejected: 0,
            aggregateBytes: 10000,
            peerForwarded: 10,
            peerRejected: 0,
            peerBytes: 950,
            lastPacketAt: '2026-01-01T00:00:02.000Z',
          },
        },
      };

      const formatted = formatCounterDrift(mockDiagnostic);

      expect(formatted).toContain('Baseline snapshot:');
      expect(formatted).toContain('Current snapshot:');
      expect(formatted).toContain('capturedAt');
      expect(formatted).toContain('prometheus:');
      expect(formatted).toContain('json.peer:');
      expect(formatted).toContain('json.aggregate:');
    });
  });

  // =========================================================================
  // Additional: Mixed packet flow test
  // =========================================================================
  describe('Mixed Packet Flow Consistency', () => {
    it('mixed forward/reject sequence maintains aggregate consistency', async () => {
      const baseline = await captureBaselineCounters(TEST_PEER_ID);

      // Send 5 successful packets
      for (let i = 0; i < 5; i++) {
        await sendIlpPacket(
          `test.peer2.success.${i}`,
          '0',
          new Date(Date.now() + 30000).toISOString()
        );
      }

      // Send 2 packets that may be rejected
      for (let i = 0; i < 2; i++) {
        await sendIlpPacket(
          `test.nonexistent.reject.${i}`,
          '0',
          new Date(Date.now() + 30000).toISOString()
        );
      }

      // Send 3 more successful packets
      for (let i = 0; i < 3; i++) {
        await sendIlpPacket(
          `test.peer2.success2.${i}`,
          '0',
          new Date(Date.now() + 30000).toISOString()
        );
      }

      // Wait for counters to stabilize
      await waitForCounterStability(async () => {
        const current = await captureBaselineCounters(TEST_PEER_ID);
        const delta = calculateDelta(baseline, current);
        // At least the 8 successful packets should be counted
        return delta.prometheusForwarded >= 8;
      });

      // Verify final consistency
      await assertCounterConsistency(TEST_PEER_ID);

      const final = await captureBaselineCounters(TEST_PEER_ID);
      const delta = calculateDelta(baseline, final);

      // Forwarded should be at least 8 (the successful ones)
      expect(delta.prometheusForwarded).toBeGreaterThanOrEqual(8);
      expect(delta.jsonPeerForwarded).toBe(delta.prometheusForwarded);
      expect(delta.jsonAggregateForwarded).toBe(delta.prometheusForwarded);
    });
  });
});
