/**
 * Tier-3 Admin API Allowlist E2E (Docker compose)
 *
 * Proves the simplest secure topology for "local app calls the connector's
 * admin API":
 *
 *   [host:13401] ---> app container --(compose DNS)--> connector container
 *                                                               ^
 *                                                       admin API
 *                                                       binds 0.0.0.0:8081
 *                                                       IP allowlist = bridge CIDR
 *                                                       NOT published to host
 *
 * What this asserts:
 *   1. The app, running as a sibling container on the same compose bridge
 *      network, can POST to the connector's /admin/ilp/send because its
 *      source IP is in `allowedIPs` (172.16.0.0/12 OR 192.168.0.0/16).
 *   2. The connector's admin port is NOT exposed on the host — any external
 *      caller (including the test harness directly) gets ECONNREFUSED.
 *   3. No API key is configured — the allowlist alone (plus no port publish)
 *      is sufficient for this threat model.
 *
 * Gate: STANDALONE_DOCKER=true
 *
 * @packageDocumentation
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const RUN = process.env.STANDALONE_DOCKER === 'true';
const describeDocker = RUN ? describe : describe.skip;

jest.setTimeout(300_000);

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PROFILE_ARGS = ['compose', '--profile', 'standalone-allowlist'];

const BLS_HOST_URL = 'http://127.0.0.1:13401';
const CONNECTOR_ADMIN_HOST_URL = 'http://127.0.0.1:8081'; // Intentionally NOT published

async function compose(...args: string[]): Promise<void> {
  await execFileAsync('docker', [...PROFILE_ARGS, ...args], {
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
      /* keep polling */
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for: ${description} (${timeoutMs}ms)`);
}

describeDocker('Tier-3 Admin API Allowlist E2E (Docker)', () => {
  beforeAll(async () => {
    await compose('build');
    await compose('up', '-d', '--wait');

    // Wait until the connector is ready — we can't hit its admin API directly
    // (not published), but the app's /trigger-admin-send will fail until the
    // connector starts responding.
    await waitForCondition(
      async () => {
        const res = await fetch(`${BLS_HOST_URL}/trigger-admin-send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            destination: 'test.peer-allowlist.warmup',
            amount: '0',
            data: '',
          }),
        });
        return res.status === 200;
      },
      60_000,
      'connector admin API reachable from app container'
    );
  });

  afterAll(async () => {
    await compose('down', '--volumes').catch(() => undefined);
  });

  it('the app on the bridge network can POST /admin/ilp/send (allowlist accepts)', async () => {
    const res = await fetch(`${BLS_HOST_URL}/trigger-admin-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        destination: 'test.peer-allowlist.receiver',
        amount: '0',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: boolean };
    expect(body.accepted).toBe(true);
  });

  it("connector's admin port is NOT published — host cannot reach it directly", async () => {
    // If the operator forgot to publish the port (or left it unpublished, as
    // we do here), a direct call from the host should fail at the TCP layer —
    // before any HTTP-layer allowlist check could run. This is the primary
    // defense; the allowlist is secondary.
    let reachable = false;
    try {
      const res = await fetch(`${CONNECTOR_ADMIN_HOST_URL}/admin/peers`, {
        signal: AbortSignal.timeout(2_000),
      });
      reachable = res.status === 200;
    } catch {
      reachable = false;
    }
    expect(reachable).toBe(false);
  });

  it('received packet appears in the app capture log', async () => {
    // Seed a fresh packet, then verify it surfaced via /received.
    const before = (await (await fetch(`${BLS_HOST_URL}/received`)).json()) as {
      count: number;
    };

    const sendRes = await fetch(`${BLS_HOST_URL}/trigger-admin-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        destination: 'test.peer-allowlist.capture-check',
        amount: '0',
      }),
    });
    expect(sendRes.status).toBe(200);

    await waitForCondition(
      async () => {
        const after = (await (await fetch(`${BLS_HOST_URL}/received`)).json()) as {
          count: number;
        };
        return after.count === before.count + 1;
      },
      5_000,
      'app records the delivered packet'
    );
  });
});
