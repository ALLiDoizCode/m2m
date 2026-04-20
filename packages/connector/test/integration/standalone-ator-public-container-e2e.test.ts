/**
 * Standalone Mode + Public ATOR Container E2E
 *
 * Highest-fidelity test in the standalone-mode suite: the connector runs
 * inside a Docker container (built from the repo Dockerfile) with
 * `deploymentMode: 'standalone'` AND `transport.type: 'socks5'` pointing at
 * a REAL public Anyone Protocol proxy on the live Anyone network.
 *
 * What this proves:
 *   - Connector image boots cleanly with the full production config shape
 *     (standalone + SOCKS5 + live public proxy URL)
 *   - SocksTransportProvider's startup probe actually reaches a public Anyone
 *     exit node (not a local testnet, not a mock)
 *   - `/health` reports `transport: { type: 'socks5', healthy: true }`
 *   - Standalone admin API + local delivery HTTP continue to function with
 *     SOCKS5 egress configured
 *
 * What this does NOT attempt:
 *   - Peer-to-peer ILP routing through the public ATOR network. That requires
 *     hidden services (.anon addresses) on both sides — out of scope here.
 *   - On-chain settlement (no chainProviders configured).
 *
 * Gates: STANDALONE_DOCKER=true AND ATOR_PUBLIC=1
 * CI: runs under nightly-ator.yml only (public infra is too flaky for PR CI).
 *
 * @packageDocumentation
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

// ────────────────────────────────────────────────────────────────────────────
// Gate + timings
// ────────────────────────────────────────────────────────────────────────────

const RUN = process.env.STANDALONE_DOCKER === 'true' && process.env.ATOR_PUBLIC === '1';
const describeMaybe = RUN ? describe : describe.skip;

jest.setTimeout(300_000);

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PROFILE_ARGS = ['compose', '--profile', 'standalone-ator-public'];

const PEER_ADMIN = 'http://127.0.0.1:18083';
const PEER_HEALTH = 'http://127.0.0.1:18082';
const BLS_RECEIVED = 'http://127.0.0.1:13103/received';

/**
 * Public Anyone Protocol proxies maintained by the Anyone team.
 * Source: https://docs.anyone.io/connect/public-proxies
 * Kept in sync with multi-hop-ator-public-e2e.test.ts.
 */
const PUBLIC_ANYONE_PROXIES = [
  { host: '5.78.181.0', port: 9052, label: 'Oregon' },
  { host: '157.90.113.23', port: 9052, label: 'Nürnberg' },
  { host: '57.128.249.250', port: 9052, label: 'Warsaw' },
];

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

interface ProbeResult {
  host: string;
  port: number;
  label: string;
}

async function probePublicProxies(): Promise<ProbeResult | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { SocksClient } = require('socks') as typeof import('socks');
  for (const proxy of PUBLIC_ANYONE_PROXIES) {
    try {
      const { socket } = await SocksClient.createConnection({
        proxy: { host: proxy.host, port: proxy.port, type: 5 },
        command: 'connect',
        destination: { host: 'api.ipify.org', port: 80 },
        timeout: 10_000,
      });
      socket.destroy();
      return proxy;
    } catch {
      continue;
    }
  }
  return null;
}

function renderPeerYaml(proxy: ProbeResult): string {
  return `nodeId: atorpeer
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
  handlerUrl: http://standalone-ator-bls:3100
  timeout: 5000

transport:
  type: socks5
  socksProxy: socks5h://${proxy.host}:${proxy.port}
  externalUrl: ws://placeholder
  managed: false

peers: []

routes:
  - prefix: test.atorpeer
    nextHop: atorpeer
`;
}

async function compose(env: NodeJS.ProcessEnv, ...args: string[]): Promise<void> {
  await execFileAsync('docker', [...PROFILE_ARGS, ...args], {
    cwd: REPO_ROOT,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, ...env },
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
    await sleep(500);
  }
  throw new Error(`Timed out waiting for: ${description} (${timeoutMs}ms)`);
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

describeMaybe('Standalone + Public ATOR Container E2E', () => {
  let configDir: string;
  let composeEnv: NodeJS.ProcessEnv;
  let selectedProxy: ProbeResult;

  beforeAll(async () => {
    const probed = await probePublicProxies();
    if (!probed) {
      throw new Error(
        'No public Anyone proxy reachable from this host — cannot run test. ' +
          'Check https://docs.anyone.io/connect/public-proxies'
      );
    }
    selectedProxy = probed;

    // Write peer config into a tmp dir that compose will bind-mount into the
    // container. Tmp dir is per-run so parallel runs/machines don't collide.
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-ator-'));
    fs.writeFileSync(path.join(configDir, 'peer-ator.yaml'), renderPeerYaml(selectedProxy), 'utf8');
    composeEnv = { ATOR_CONFIG_DIR: configDir };

    // eslint-disable-next-line no-console
    console.log(
      `[ATOR public] selected proxy ${selectedProxy.label} ${selectedProxy.host}:${selectedProxy.port}`
    );

    await compose(composeEnv, 'build');
    await compose(composeEnv, 'up', '-d', '--wait');
  });

  afterAll(async () => {
    await compose(composeEnv, 'down').catch(() => undefined);
    if (configDir) {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('container reports healthy with transport.type = socks5', async () => {
    await waitForCondition(
      async () => {
        const res = await fetch(`${PEER_HEALTH}/health`);
        if (!res.ok) return false;
        const body = (await res.json()) as { transport?: { type: string; healthy: boolean } };
        return body.transport?.type === 'socks5' && body.transport.healthy === true;
      },
      60_000,
      'connector reports transport=socks5 + healthy=true after public proxy probe'
    );

    const health = await getJson<{ transport: { type: string; healthy: boolean } }>(
      `${PEER_HEALTH}/health`
    );
    expect(health.transport.type).toBe('socks5');
    expect(health.transport.healthy).toBe(true);
  });

  it('admin API is reachable on standalone connector with ATOR transport', async () => {
    const peers = await getJson<{ nodeId: string; peers: unknown[] }>(`${PEER_ADMIN}/admin/peers`);
    expect(peers.nodeId).toBe('atorpeer');
    expect(Array.isArray(peers.peers)).toBe(true);
  });

  it('local delivery still works: self-routed zero-amount packet reaches BLS', async () => {
    const before = await getJson<{ count: number }>(BLS_RECEIVED);

    const { status, body } = await postJson<{ accepted: boolean }>(`${PEER_ADMIN}/admin/ilp/send`, {
      destination: 'test.atorpeer.receiver',
      amount: '0',
      data: '',
    });
    expect(status).toBe(200);
    expect(body.accepted).toBe(true);

    await waitForCondition(
      async () => {
        const after = await getJson<{ count: number }>(BLS_RECEIVED);
        return after.count === before.count + 1;
      },
      5_000,
      'BLS receives self-routed packet while SOCKS5 transport is active'
    );
  });
});
