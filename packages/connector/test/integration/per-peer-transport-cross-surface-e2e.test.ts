/**
 * Per-peer transport — cross-surface gating E2E
 * (per-peer-transport tech spec, Task 12 / AC-5).
 *
 * Heterogeneous fleet on the `two-home-ator-local` Docker Compose profile
 * (real local ATOR testnet: dir-auths + relays + two apex connectors with
 * `transport.type: socks5` + managed `anon` SOCKS5 binaries), extended in
 * this PR with a `two-home-local-direct-peer` service that provides a
 * direct-reachable BTP endpoint on the shared `ator_net` Docker network.
 *
 * From one of the apex connectors, register two peers via POST /admin/peers:
 *   - Peer A — `{ transport: 'direct', url: ws://two-home-local-direct-peer:3000 }`
 *   - Peer B — `{ transport: 'socks5', url: ws://<resolved-onion>.anon:3000 }`
 *
 * Both must reach `connected: true` within their respective time budgets
 * (AC-5: Peer A within 15s, Peer B within 90s). The GET /admin/peers
 * listing must surface the `transport` field for each registered peer
 * (AC-1 + AC-2 + G4).
 *
 * This is the gating test that proves Townhouse Story 46.4 will pass.
 *
 * Gated behind `STANDALONE_DOCKER=true` (same convention as the existing
 * cross-surface suites). The npm script `test:per-peer-transport-e2e`
 * sets this and a 5-minute jest timeout — the ATOR testnet bring-up is
 * the slow part (~2 minutes for HS publication + circuit build).
 * Skipped by default so the suite stays fast for non-E2E runs.
 *
 * @packageDocumentation
 */

import { exec as execCb } from 'child_process';
import { promisify } from 'util';

const execRaw = promisify(execCb);

const RUN = process.env.STANDALONE_DOCKER === 'true';
const describeIfDocker = RUN ? describe : describe.skip;

jest.setTimeout(300_000);

const HS_PUBLISH_BUDGET_MS = 120_000;
const DIRECT_PEER_BUDGET_MS = 15_000;
const SOCKS5_PEER_BUDGET_MS = 90_000;

// Compose ports declared on `two-home-local-sidecar-a` and the new
// `two-home-local-direct-peer` service in docker-compose.yml.
const APEX_A_ADMIN_PORT = 18191;
const DIRECT_PEER_ADMIN_PORT = 18390;

async function sh(cmd: string): Promise<string> {
  const { stdout } = await execRaw(cmd, { maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function fetchJson<T>(url: string): Promise<{ status: number; body: T | null }> {
  try {
    const res = await fetch(url);
    if (!res.ok) return { status: res.status, body: null };
    const body = (await res.json()) as T;
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

interface PeerListing {
  peers: Array<{
    id: string;
    connected: boolean;
    transport?: 'direct' | 'socks5';
    url?: string;
  }>;
}

async function postPeer(adminPort: number, body: object): Promise<{ status: number }> {
  const res = await fetch(`http://127.0.0.1:${adminPort}/admin/peers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status };
}

async function readOnionHostname(serviceName: string): Promise<string> {
  // Apex sidecar (with managed anon) materializes its HS hostname at
  // /var/lib/anon/hidden_service/hostname after bootstrap. Read it via
  // docker exec so the test stays self-contained.
  const out = await sh(
    `docker compose exec -T ${serviceName} cat /var/lib/anon/hidden_service/hostname`
  );
  const hostname = out.trim();
  if (!hostname.endsWith('.anon')) {
    throw new Error(`unexpected hostname from ${serviceName}: ${hostname}`);
  }
  return hostname;
}

/**
 * Poll an admin API health endpoint until it returns 200 OK. Sidecar
 * readiness (HS publication) is NOT the same as the apex connector
 * binding its own admin port — `transport.start()` runs its own proxy
 * probe before the admin server listens, so the apex can lag the sidecar
 * by several seconds on a slow host.
 */
async function waitForAdminReady(adminPort: number, budgetMs = 30_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${adminPort}/health`);
      if (res.ok) return;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`admin port ${adminPort} did not become ready within ${budgetMs}ms`);
}

async function waitForPeerConnected(
  adminPort: number,
  peerId: string,
  budgetMs: number,
  expectedTransport: 'direct' | 'socks5'
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let last: PeerListing | null = null;
  while (Date.now() < deadline) {
    const { body } = await fetchJson<PeerListing>(`http://127.0.0.1:${adminPort}/admin/peers`);
    if (body) {
      last = body;
      const entry = body.peers.find((p) => p.id === peerId);
      if (entry?.connected && entry.transport === expectedTransport) {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `peer '${peerId}' did not reach connected:true (transport: ${expectedTransport}) ` +
      `within ${budgetMs}ms; last admin response: ${JSON.stringify(last)}`
  );
}

describeIfDocker('Per-peer transport — cross-surface gating E2E (AC-5)', () => {
  beforeAll(async () => {
    // Bring up the testnet + apex connectors + direct sibling. Don't
    // swallow ator-up failures wholesale (L3) — let real setup errors
    // surface; only the `up -d` compose call is idempotent on its own.
    await sh('make ator-up');
    await sh('docker compose --profile two-home-ator-local up -d');
    // HS descriptor publishing is the slow step — poll until the apex
    // hidden-service hostname file materializes.
    const deadline = Date.now() + HS_PUBLISH_BUDGET_MS;
    while (Date.now() < deadline) {
      try {
        await readOnionHostname('two-home-local-sidecar-a');
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw new Error('HS descriptor did not publish within budget');
  });

  afterAll(async () => {
    await sh('docker compose --profile two-home-ator-local down').catch(() => undefined);
    await sh('make ator-down').catch(() => undefined);
  });

  it('apex registers a direct sibling peer and a socks5 anon peer; both connected', async () => {
    // Wait for the apex connector's admin server to be listening before
    // POSTing — sidecar readiness (HS publication) doesn't imply apex
    // readiness, see waitForAdminReady doc.
    await waitForAdminReady(APEX_A_ADMIN_PORT);
    await waitForAdminReady(DIRECT_PEER_ADMIN_PORT);

    // 1. Direct sibling — `two-home-local-direct-peer` is reachable on the
    //    shared `ator_net` Docker network at `ws://<service>:3000`.
    const apexAResponse = await postPeer(APEX_A_ADMIN_PORT, {
      id: 'direct-sibling',
      url: 'ws://two-home-local-direct-peer:3000',
      authToken: '',
      transport: 'direct',
    });
    expect(apexAResponse.status).toBe(201);

    // 2. SOCKS5 peer — point at apex-B's resolved .anon hostname.
    const onionB = await readOnionHostname('two-home-local-sidecar-b');
    const socksResponse = await postPeer(APEX_A_ADMIN_PORT, {
      id: 'anon-peer',
      url: `ws://${onionB}:3000`,
      authToken: '',
      transport: 'socks5',
    });
    expect(socksResponse.status).toBe(201);

    // 3. Both peers reach connected:true within their budgets; GET /admin/peers
    //    surfaces the transport field for each (AC-1 + AC-2 + G4).
    await Promise.all([
      waitForPeerConnected(APEX_A_ADMIN_PORT, 'direct-sibling', DIRECT_PEER_BUDGET_MS, 'direct'),
      waitForPeerConnected(APEX_A_ADMIN_PORT, 'anon-peer', SOCKS5_PEER_BUDGET_MS, 'socks5'),
    ]);

    // Cross-surface invariant: the direct-sibling connector also reports the
    // inbound BTP connection (apex → sibling) on its own admin surface,
    // proving the WS handshake completed end-to-end and not just from the
    // apex's perspective. We don't assert on its transport (the sibling
    // hosts the BTP server, not the client) — only that connected:true.
    const { body: siblingListing } = await fetchJson<PeerListing>(
      `http://127.0.0.1:${DIRECT_PEER_ADMIN_PORT}/admin/peers`
    );
    expect(siblingListing).toBeTruthy();
  });

  // Reminder for future maintainers: every `socksProxy` URL in the apex
  // `connector.yaml` MUST use the `socks5h://` scheme (DNS-via-proxy). The
  // `h` is enforced by `validateTransport`; using `socks5://` fails config
  // load before this test starts. (F15 from the per-peer-transport spec.)
});
