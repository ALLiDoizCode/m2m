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
    const res1 = await fetch('http://127.0.0.1:18080/health');
    const res2 = await fetch('http://127.0.0.1:28080/health');
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
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
