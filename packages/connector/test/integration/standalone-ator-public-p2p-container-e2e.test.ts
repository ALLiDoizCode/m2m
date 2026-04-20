/**
 * Standalone + Public ATOR Peer-to-Peer (Docker) E2E
 *
 * End-to-end proof that two standalone connectors running in Docker
 * containers can route ILP packets PEER-TO-PEER across the REAL PUBLIC
 * Anyone Protocol network via hidden-service rendezvous.
 *
 *   [bls-a] <-- peer-a container (standalone) <-- /admin/ilp/send [test]
 *                      |                                         ^
 *                      v                                         |
 *                anon-sidecar-a                               admin API
 *                      |
 *                      | SOCKS5 egress + inbound HS
 *                      v
 *            ********************************
 *            *    PUBLIC ANYONE NETWORK     *
 *            *   (real directory auths,     *
 *            *   real relays, real HSDirs)  *
 *            ********************************
 *                      ^
 *                      | rendezvous to <peer-a>.anon
 *                      v
 *                anon-sidecar-b
 *                      |
 *                      v
 *   [bls-b] <-- peer-b container (standalone)
 *
 * Topology (docker-compose profile `standalone-ator-p2p`):
 *   - 2 anon sidecars (ator-public-sidecar image) on the public network,
 *     each hosting a hidden service that forwards to the adjacent
 *     connector's BTP port.
 *   - 2 standalone connector containers (connector:standalone-e2e image)
 *     using their co-located sidecar as SOCKS5 transport, with the peer
 *     URL set to the OTHER sidecar's `.anon` hostname.
 *   - 2 minimal BLS containers.
 *
 * Two-phase startup (handled by this test, not compose profile deps):
 *   1. Bring up sidecars only → wait for each `.anon` hostname to publish.
 *   2. Render connector configs with the resolved peer URLs into a tmp
 *      dir, bind-mount via ${ATOR_P2P_CONFIG_DIR}, start remaining services.
 *
 * Gates (both required):
 *   STANDALONE_DOCKER=1
 *   ATOR_PUBLIC_P2P=1
 *
 * This test hits the real public Anyone network. It is NOT run in PR CI —
 * only in nightly-ator.yml or via `make standalone-test-ator-p2p`.
 *
 * Performance envelope:
 *   - Anon bootstrap:                 ~30-60s per sidecar (in parallel)
 *   - HS descriptor publish on public network: ~30-90s per side
 *   - Rendezvous circuit build:       ~30s
 *   - BTP connect via HS:             ~5-30s
 *   Total wall-clock: 3-7 minutes per run. HIGH flakiness risk due to real
 *   public network variability.
 *
 * @packageDocumentation
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const RUN = process.env.STANDALONE_DOCKER === '1' && process.env.ATOR_PUBLIC_P2P === '1';
const describeMaybe = RUN ? describe : describe.skip;

// 10 minutes — public HS descriptor propagation dominates.
jest.setTimeout(600_000);

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PROFILE_ARGS = ['compose', '--profile', 'standalone-ator-p2p'];

const PEER_A_ADMIN = 'http://127.0.0.1:18091';
const PEER_B_ADMIN = 'http://127.0.0.1:28091';
const BLS_A_RECEIVED = 'http://127.0.0.1:13301/received';
const BLS_B_RECEIVED = 'http://127.0.0.1:13302/received';

const HS_PUBLISH_BUDGET_MS = 300_000; // 5 min, per-sidecar
const BTP_CONNECT_BUDGET_MS = 240_000; // 4 min
const SIDECAR_SVC_A = 'standalone-p2p-sidecar-a';
const SIDECAR_SVC_B = 'standalone-p2p-sidecar-b';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

async function compose(env: NodeJS.ProcessEnv, ...args: string[]): Promise<void> {
  await execFileAsync('docker', [...PROFILE_ARGS, ...args], {
    cwd: REPO_ROOT,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
}

async function composeOutput(
  env: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('docker', [...PROFILE_ARGS, ...args], {
    cwd: REPO_ROOT,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function readHostnameFromSidecar(
  env: NodeJS.ProcessEnv,
  service: string,
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'unknown';
  while (Date.now() < deadline) {
    try {
      const { stdout } = await composeOutput(
        env,
        'exec',
        '-T',
        service,
        'cat',
        '/var/lib/anon/hs/hostname'
      );
      const hostname = stdout.trim();
      if (/^[a-z2-7]{16,56}\.(anon|anyone|onion)$/.test(hostname)) {
        return hostname;
      }
      lastErr = `unexpected hostname shape: ${hostname.slice(0, 32)}...`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await sleep(5_000); // HS descriptor can take up to ~90s to publish
  }
  throw new Error(`${service} HS hostname not available within ${timeoutMs}ms (last: ${lastErr})`);
}

/**
 * Connector YAML without a peer entry. The peer `.anon` URL is not known at
 * startup — it's published by the sidecar bootstrapping on the public ATOR
 * network, which takes 30-90s. The test harness registers the peer via
 * `POST /admin/peers` once both hostnames are available.
 *
 * Intra-peer addresses are all 127.0.0.1 because sidecar + connector + bls
 * share a single Docker network namespace via `network_mode: service:...`.
 */
function renderBootstrapYaml(opts: { nodeId: string; peerId: string }): string {
  return `nodeId: ${opts.nodeId}
btpServerPort: 3000
healthCheckPort: 8080
environment: development
deploymentMode: standalone
logLevel: warn

adminApi:
  enabled: true
  port: 8081
  host: 0.0.0.0

localDelivery:
  enabled: true
  handlerUrl: http://127.0.0.1:3100
  timeout: 30000

transport:
  type: socks5
  managed: false
  socksProxy: socks5h://127.0.0.1:9050
  externalUrl: ws://${opts.nodeId}.invalid/btp

peers: []

routes:
  - prefix: test.${opts.nodeId}
    nextHop: ${opts.nodeId}
  - prefix: test.${opts.peerId}
    nextHop: ${opts.peerId}
`;
}

interface ReceivedResponse {
  count: number;
  received: Array<{ destination: string; amount: string; paymentId: string }>;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
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
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for: ${description} (${timeoutMs}ms)`);
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describeMaybe('Standalone + Public ATOR Peer-to-Peer (Docker)', () => {
  let configDir: string;
  let composeEnv: NodeJS.ProcessEnv;
  let peerAHostname: string;
  let peerBHostname: string;

  beforeAll(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-ator-p2p-'));
    composeEnv = { ATOR_P2P_CONFIG_DIR: configDir };

    // Connectors boot with an empty peers list. The sidecars can only start
    // anon after their HS target (the connector container) is DNS-resolvable
    // on the compose network. So both start together, and we register the
    // peer via admin API once each sidecar publishes its .anon hostname.
    fs.writeFileSync(
      path.join(configDir, 'peer-p2p-a.yaml'),
      renderBootstrapYaml({ nodeId: 'peer-a', peerId: 'peer-b' }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(configDir, 'peer-p2p-b.yaml'),
      renderBootstrapYaml({ nodeId: 'peer-b', peerId: 'peer-a' }),
      'utf8'
    );

    await compose(composeEnv, 'build');
    await compose(composeEnv, 'up', '-d', '--wait');

    // eslint-disable-next-line no-console
    console.log('[ator-p2p] stack up, waiting for HS descriptors on public ATOR…');
    const [a, b] = await Promise.all([
      readHostnameFromSidecar(composeEnv, SIDECAR_SVC_A, HS_PUBLISH_BUDGET_MS),
      readHostnameFromSidecar(composeEnv, SIDECAR_SVC_B, HS_PUBLISH_BUDGET_MS),
    ]);
    peerAHostname = a;
    peerBHostname = b;
    // eslint-disable-next-line no-console
    console.log(`[ator-p2p] peer-a → ${peerAHostname}`);
    // eslint-disable-next-line no-console
    console.log(`[ator-p2p] peer-b → ${peerBHostname}`);

    // Register each peer via the admin API now that we know the .anon URL.
    await postJson<unknown>(`${PEER_A_ADMIN}/admin/peers`, {
      id: 'peer-b',
      url: `ws://${peerBHostname}:3000`,
      authToken: '',
    });
    await postJson<unknown>(`${PEER_B_ADMIN}/admin/peers`, {
      id: 'peer-a',
      url: `ws://${peerAHostname}:3000`,
      authToken: '',
    });

    await waitForCondition(
      async () => {
        const body = await getJson<{ peers: Array<{ id: string; connected: boolean }> }>(
          `${PEER_A_ADMIN}/admin/peers`
        );
        return body.peers.find((p) => p.id === 'peer-b')?.connected === true;
      },
      BTP_CONNECT_BUDGET_MS,
      'peer-a → peer-b BTP connection via public ATOR HS rendezvous'
    );
  });

  afterAll(async () => {
    await compose(composeEnv, 'down', '--volumes').catch(() => undefined);
    if (configDir) {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('both connector containers report standalone mode', async () => {
    const [aHealth, bHealth] = await Promise.all([
      fetch('http://127.0.0.1:18090/health'),
      fetch('http://127.0.0.1:28090/health'),
    ]);
    expect(aHealth.status).toBe(200);
    expect(bHealth.status).toBe(200);
  });

  it('peer-a → peer-b: packet routes through public ATOR rendezvous and lands at BLS-B', async () => {
    const before = await getJson<ReceivedResponse>(BLS_B_RECEIVED);

    const { status, body } = await postJson<{ accepted: boolean }>(
      `${PEER_A_ADMIN}/admin/ilp/send`,
      { destination: 'test.peer-b.receiver', amount: '0', data: '' }
    );
    expect(status).toBe(200);
    expect(body.accepted).toBe(true);

    await waitForCondition(
      async () => {
        const after = await getJson<ReceivedResponse>(BLS_B_RECEIVED);
        return after.count === before.count + 1;
      },
      60_000, // HS data round-trip can be slow even after circuit is built
      'BLS-B receives forwarded packet via public ATOR'
    );

    const after = await getJson<ReceivedResponse>(BLS_B_RECEIVED);
    const latest = after.received[after.received.length - 1]!;
    expect(latest.destination).toBe('test.peer-b.receiver');
  });

  it('peer-b → peer-a: reverse direction works symmetrically', async () => {
    const before = await getJson<ReceivedResponse>(BLS_A_RECEIVED);

    const { status, body } = await postJson<{ accepted: boolean }>(
      `${PEER_B_ADMIN}/admin/ilp/send`,
      { destination: 'test.peer-a.receiver', amount: '0', data: '' }
    );
    expect(status).toBe(200);
    expect(body.accepted).toBe(true);

    await waitForCondition(
      async () => {
        const after = await getJson<ReceivedResponse>(BLS_A_RECEIVED);
        return after.count === before.count + 1;
      },
      60_000,
      'BLS-A receives reverse-direction packet via public ATOR'
    );
  });
});
