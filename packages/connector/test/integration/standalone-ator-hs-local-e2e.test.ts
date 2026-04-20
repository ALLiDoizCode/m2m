/**
 * Standalone Mode + ATOR Hidden Service (Local Testnet) E2E
 *
 * Proves the three orthogonal axes — **standalone mode**, **managed anon
 * client**, and **hidden-service rendezvous** — compose correctly end-to-end.
 *
 *   [BLS1] <-- peer1 (standalone, managed anon, hosts HS) <-- .anon circuit --
 *                                                                             \
 *    make ator-up testnet (dirauths + relays + hs1)                            \
 *                                                                               \
 *   [BLS2(unused)] <-- peer2 (standalone, socks5 via hs1) -- admin /ilp/send <--[test]
 *
 * The embedded equivalent is `transport-ator-hidden-service.test.ts`. This
 * test slices off the one scenario that demonstrates deployment-mode parity:
 * an ILP packet submitted via peer2's `/admin/ilp/send` traverses the
 * hidden-service rendezvous (peer2 → ATOR circuit → peer1's `.anon`) and is
 * delivered to peer1's BLS via standalone local-delivery HTTP.
 *
 * Prerequisites:
 *   make ator-up     # brings up the 3 DirAuth + 4 relay + 1 HS testnet
 *   ATOR_NIGHTLY=1 STANDALONE_ATOR_LOCAL=1 \
 *     npx jest test/integration/standalone-ator-hs-local-e2e.test.ts
 *
 * Budget: HS descriptor publishing on the local testnet is fast (seconds),
 * but managed-client bootstrap + circuit build is 30-60s per side. Total
 * wall-clock: ~2-4 minutes per run.
 *
 * @packageDocumentation
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import http from 'http';
import express, { Request, Response } from 'express';
import { SocksClient } from 'socks';
import { ConnectorNode } from '../../src/core/connector-node';
import { createLogger } from '../../src/utils/logger';
import type { ConnectorConfig } from '../../src/config/types';

const execRaw = promisify(execCb);
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// NETWORK TOPOLOGY BLOCKER (this test is SKIPPED by default):
//
// Phase 3a — DirAuthority rewrite ✅ SOLVED:
//   DirAuthority lines inside `make ator-up` reference internal bridge IPs
//   (192.168.117.x:9030) unreachable from the host. `readTestnetDirAuthLines`
//   below rewrites each line to `127.0.0.1:<host-mapped-dirport>` using
//   docker-compose's published port mappings. After this rewrite peer1's
//   host-side managed anon successfully joins the testnet and publishes its
//   HS (confirmed: HS hostname file materializes, anon logs "Bootstrapped
//   100% Done" against testnet DirAuths).
//
// Phase 3b — relay descriptor IPs ❌ STILL BLOCKED:
//   Once on the testnet, peer1 fetches relay descriptors from the DirAuths.
//   Those descriptors advertise each relay's ORPort at its *internal* bridge
//   IP (192.168.117.x:9001) — unreachable from the host. peer1 cannot build
//   the circuits it needs to establish HS introduction points, so while the
//   HS hostname appears locally, no HSDir ever receives a valid descriptor,
//   and hs1's rendezvous attempts return `HostUnreachable` indefinitely.
//   Solving this requires either:
//     (a) rewriting published relay descriptors so advertised addresses are
//         127.0.0.1:<mapped-port> — non-trivial because descriptors are
//         signed by the relay's identity key and cached in each DirAuth;
//     (b) running peer1 INSIDE the ator_net bridge network so it can reach
//         relays at their native internal IPs — effectively the Phase 4
//         (Docker-internal) topology.
//
// Phase 4 uses PUBLIC ATOR where all relays have real public IPs, so it
// sidesteps this blocker entirely. Phase 3 stays scaffolded behind a
// double gate (ATOR_NIGHTLY=1 AND STANDALONE_ATOR_LOCAL=1) until someone
// invests in path (a) above.
const RUN = process.env.ATOR_NIGHTLY === '1' && process.env.STANDALONE_ATOR_LOCAL === '1';
const describeAtor = RUN ? describe : describe.skip;

jest.setTimeout(300_000);

const HS_PUBLISH_BUDGET_MS = 120_000;
const BTP_CONNECT_BUDGET_MS = 120_000;

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

interface TestBls {
  received: Array<{ destination: string; amount: string }>;
  stop(): Promise<void>;
}

async function startBls(port: number): Promise<TestBls> {
  const app = express();
  app.use(express.json());
  const received: TestBls['received'] = [];
  app.post('/handle-packet', (req: Request, res: Response) => {
    const body = req.body as { destination: string; amount: string };
    received.push({ destination: body.destination, amount: body.amount });
    res.json({ accept: true });
  });
  app.get('/health', (_req, res) => res.json({ status: 'healthy' }));
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return {
    received,
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForFile(filePath: string, timeoutMs: number, label: string): Promise<string> {
  const start = Date.now();
  let delay = 500;
  while (Date.now() - start < timeoutMs) {
    try {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (content.length > 0) return content;
    } catch {
      /* not yet */
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 3000);
  }
  throw new Error(`${label} not available at ${filePath} within ${timeoutMs}ms`);
}

/**
 * Read DirAuthority lines from the running testnet and rewrite them so the
 * host-side managed anon joins the SAME network as hs1 (not public ATOR).
 *
 * The DirAuthority lines inside the containers reference the bridge network
 * IPs `192.168.117.x:9030` — those IPs are unreachable from the host process.
 * docker-compose publishes each DirAuth ORPort + DIRPort on `127.0.0.1`, so we
 * rewrite each line to point at the host-mapped ports instead:
 *
 *   input : DirAuthority dirauth1 orport=9001 v3ident=... 192.168.117.4:9030 <rsa-fp>
 *   output: DirAuthority dirauth1 orport=19001 v3ident=... 127.0.0.1:19030 <rsa-fp>
 *
 * Without this rewrite the host-side anon cannot reach the DirAuth DIR ports,
 * silently falls back to PUBLIC ATOR, and peer2 (dialing via hs1 which lives
 * on the local testnet) fails to resolve the `.anon` address.
 */
async function readTestnetDirAuthLines(): Promise<string> {
  const { stdout } = await execRaw(
    "docker compose exec -T dirauth1 grep '^DirAuthority' /etc/anon/torrc",
    { cwd: REPO_ROOT }
  );

  // Build a nickname -> {orport, dirport} map from docker port mappings.
  // The DirAuth line nicknames are authoritative (we key off them) because
  // the internal-IP assignment inside 192.168.117.x is not stable across
  // runs — docker assigns container IPs in startup order.
  const nicknames = ['dirauth1', 'dirauth2', 'dirauth3'];
  const portMap: Record<string, { orport: number; dirport: number }> = {};
  for (const nick of nicknames) {
    const [orRes, dirRes] = await Promise.all([
      execRaw(`docker compose port ${nick} 9001`, { cwd: REPO_ROOT }),
      execRaw(`docker compose port ${nick} 9030`, { cwd: REPO_ROOT }),
    ]);
    const or = orRes.stdout.trim().match(/:(\d+)$/);
    const dir = dirRes.stdout.trim().match(/:(\d+)$/);
    if (!or || !dir) {
      throw new Error(`Could not parse host-mapped ports for ${nick}`);
    }
    portMap[nick] = { orport: Number(or[1]), dirport: Number(dir[1]) };
  }

  const rewritten = stdout
    .trim()
    .split('\n')
    .map((line) => {
      // DirAuthority <nick> orport=<N> [v3ident=<HEX>] <ip>:<port> <rsa-fp>
      const m = line.match(
        /^(DirAuthority\s+)(\S+)(\s+orport=)(\d+)(\s+(?:v3ident=\S+\s+)?)(\S+:\d+)(\s+\S+)\s*$/
      );
      if (!m) {
        throw new Error(`Unexpected DirAuthority line shape: ${line}`);
      }
      const prefix = m[1]!;
      const nick = m[2]!;
      const orportPrefix = m[3]!;
      const midSection = m[5]!;
      const rsaSuffix = m[7]!;
      const ports = portMap[nick];
      if (!ports) {
        throw new Error(`No host port mapping for DirAuth nickname ${nick}`);
      }
      return (
        prefix +
        nick +
        orportPrefix +
        ports.orport +
        midSection +
        `127.0.0.1:${ports.dirport}` +
        rsaSuffix
      );
    })
    .join('\n');
  return rewritten;
}

async function readHs1Port(): Promise<number> {
  const { stdout } = await execRaw('docker compose port hs1 9050', { cwd: REPO_ROOT });
  const match = stdout.trim().match(/:(\d+)$/);
  if (!match) throw new Error('Could not parse hs1 SOCKS port');
  return Number(match[1]);
}

/**
 * Probe reachability of `<anonHostname>:<port>` through `hs1`'s SOCKS5 listener.
 *
 * This does NOT send any application bytes — it just drives a SOCKS5 CONNECT
 * and closes. It succeeds iff (a) peer1 has published its HS descriptor to the
 * testnet HSDirs, (b) hs1 can fetch that descriptor, and (c) hs1 can build a
 * rendezvous circuit to peer1's intro points. If any of those fail, hs1 replies
 * with a non-zero SOCKS5 reply (commonly `Failure` while the descriptor is
 * missing, then `HostUnreachable` once it's fetched but intro points fail).
 */
async function probeHiddenServiceViaHs1(
  hs1SocksPort: number,
  anonHostname: string,
  port: number,
  perAttemptTimeoutMs: number
): Promise<{ ok: boolean; err?: string }> {
  try {
    const { socket } = await SocksClient.createConnection({
      proxy: { host: '127.0.0.1', port: hs1SocksPort, type: 5 },
      command: 'connect',
      destination: { host: anonHostname, port },
      timeout: perAttemptTimeoutMs,
    });
    (socket as net.Socket).destroy();
    return { ok: true };
  } catch (err) {
    return { ok: false, err: (err as Error)?.message ?? String(err) };
  }
}

/**
 * Poll peer1's `.anon:<btpPort>` through hs1's SOCKS5 proxy until it's
 * reachable, or throw when the overall budget elapses. This is strictly
 * stricter than waiting for the hostname file (which appears as soon as the
 * HS key is generated, long before the descriptor is published).
 */
async function waitForHiddenServiceReachable(
  hs1SocksPort: number,
  anonHostname: string,
  port: number,
  overallBudgetMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + overallBudgetMs;
  let lastErr = 'unknown';
  while (Date.now() < deadline) {
    // Per-attempt timeout is capped so a slow SOCKS reply doesn't blow the
    // whole budget in one go. 10s is enough for a rendezvous on the local
    // testnet once the descriptor is live.
    const r = await probeHiddenServiceViaHs1(hs1SocksPort, anonHostname, port, 10_000);
    if (r.ok) return;
    lastErr = r.err ?? 'unknown';
    await sleep(2000);
  }
  throw new Error(
    `${label} did not become reachable via hs1 within ${overallBudgetMs}ms ` +
      `(last SOCKS5 error: ${lastErr})`
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describeAtor('Standalone + ATOR Hidden Service (local testnet)', () => {
  let peer1: ConnectorNode;
  let peer2: ConnectorNode;
  let bls1: TestBls;
  let bls2: TestBls;
  let peer1TempDir: string;
  let peer2AdminPort: number;

  beforeAll(async () => {
    // Belt-and-suspenders: kill any orphan anon processes from a previous
    // test run. The @anyone-protocol SDK refuses to start if ANY other
    // process with "anon" in its cmdline exists (it uses a naive
    // `ps aux | grep anon | grep -v grep` check), so one stray orphan
    // poisons the entire test run with "An Anon process is already running".
    // Keep retrying until the orphan count is zero because pkill is async
    // with respect to the kernel reaping the zombie.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await execRaw('pkill -9 -x anon', { cwd: REPO_ROOT });
      } catch {
        /* pkill returns non-zero when nothing matches — that's fine */
      }
      await sleep(500);
      try {
        await execRaw('pgrep -x anon', { cwd: REPO_ROOT });
        // pgrep exit 0 → at least one anon still alive → loop
      } catch {
        break; // pgrep exit 1 → no anon processes left
      }
    }

    const base = 50_000 + Math.floor(Math.random() * 5_000);
    const peer1BtpPort = base;
    const peer1AdminPort = base + 1;
    const peer1HealthPort = base + 2;
    const peer1BlsPort = base + 3;
    const peer2BtpPort = base + 4;
    peer2AdminPort = base + 5;
    const peer2HealthPort = base + 6;
    const peer2BlsPort = base + 7;
    const peer1ManagedSocksPort = base + 8;

    bls1 = await startBls(peer1BlsPort);
    bls2 = await startBls(peer2BlsPort);

    const hs1Port = await readHs1Port();
    const testnetDirAuthLines = await readTestnetDirAuthLines();

    // Pre-write anonrc for peer1's managed client so it (a) joins the LOCAL
    // testnet instead of bootstrapping against public ATOR, and (b) configures
    // the hidden service pointing at peer1's BTP port. ManagedAnonClient only
    // writes its default anonrc if no file exists at this path, so our
    // pre-written file wins.
    //
    // HS lines must be included here because v1.1.x of the SDK's
    // `createAnonConfigFile` ignores `opts.hiddenServiceDir`/
    // `opts.hiddenServicePort` — only the anonrc contents control HS setup.
    peer1TempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-ator-hs-'));
    const peer1DataDir = path.join(peer1TempDir, 'data');
    fs.mkdirSync(peer1DataDir, { recursive: true });
    // Pre-write the terms-agreement file INSIDE our isolated DataDirectory.
    // The SDK's Process.start() path falls back to `${cwd}/terms-agreement` if
    // it doesn't find one, but we want to be explicit and keep all per-run
    // state under peer1TempDir so successive runs don't share stale consensus.
    fs.writeFileSync(path.join(peer1DataDir, 'terms-agreement'), 'agreed', 'utf8');
    const anonrc =
      `AgreeToTerms 1\n` +
      `TestingTorNetwork 1\n` +
      `AssumeReachable 1\n` +
      // The local testnet has ALL relays on a single /24 bridge
      // (192.168.117.0/24) with only 4 non-authority relays. Default
      // path-selection refuses to build circuits because the same-/16
      // subnet restriction excludes every candidate. Disable it so HS
      // rendezvous / descriptor-upload circuits can actually be built.
      `EnforceDistinctSubnets 0\n` +
      // Force a fresh, isolated data directory per run so the managed anon
      // never inherits a stale (public-network) consensus from a previous run.
      `DataDirectory ${peer1DataDir}\n` +
      // We're a pure client — never advertise an OR port or serve as a relay.
      `ClientOnly 1\n` +
      `SocksPort ${peer1ManagedSocksPort}\n` +
      `HiddenServiceDir ${peer1TempDir}\n` +
      `HiddenServicePort ${peer1BtpPort} 127.0.0.1:${peer1BtpPort}\n` +
      `${testnetDirAuthLines}\n`;
    fs.writeFileSync(path.join(peer1TempDir, 'anonrc'), anonrc, 'utf8');

    // peer1: standalone, managed anon, hosts HS at BTP port
    const peer1Config: ConnectorConfig = {
      nodeId: 'peer1',
      btpServerPort: peer1BtpPort,
      healthCheckPort: peer1HealthPort,
      // DEBUG flips ManagedAnonClient's displayLog=true so the anon binary's
      // notice-level log lines stream through to jest's stdout. That's
      // invaluable for diagnosing HS-publish failures on the local testnet.
      logLevel: (process.env.STANDALONE_ATOR_DEBUG === '1' ? 'debug' : 'warn') as 'debug' | 'warn',
      environment: 'development',
      deploymentMode: 'standalone',
      adminApi: { enabled: true, port: peer1AdminPort, host: '127.0.0.1' },
      localDelivery: {
        enabled: true,
        handlerUrl: `http://127.0.0.1:${peer1BlsPort}`,
      },
      peers: [],
      routes: [{ prefix: 'test.peer1', nextHop: 'peer1' }],
      transport: {
        type: 'socks5',
        managed: true,
        socksProxy: `socks5h://127.0.0.1:${peer1ManagedSocksPort}`,
        externalUrl: 'auto',
        managedOptions: {
          hiddenServiceDir: peer1TempDir,
          hiddenServicePort: peer1BtpPort,
          // Budget covers both managed anon bootstrap AND HS descriptor
          // publishing. The hostname-file resolver inside
          // SocksTransportProvider reuses this value, so it needs to exceed
          // 60s to tolerate slow HS publishing on the local testnet.
          startupTimeoutMs: HS_PUBLISH_BUDGET_MS,
        },
      },
    };

    peer1 = new ConnectorNode(peer1Config, createLogger('peer1', peer1Config.logLevel));
    await peer1.start();

    // Wait for peer1's managed anon to write the hostname file. Note that the
    // hostname file is written when the HS key is generated — that happens
    // BEFORE descriptor publication. We need a stricter readiness probe below.
    const hostname = await waitForFile(
      path.join(peer1TempDir, 'hostname'),
      HS_PUBLISH_BUDGET_MS,
      'peer1 HS hostname'
    );
    expect(hostname).toMatch(/^[a-z2-7]{16,56}\.(anon|anyone|onion)$/);

    // Now block until peer1's HS descriptor is actually published and
    // rendezvous-reachable from hs1. Without this probe the test races the
    // descriptor upload and peer2 starts dialing a hostname hs1 has never
    // heard of — which manifests as endless SOCKS5 `HostUnreachable` replies
    // from hs1.
    await waitForHiddenServiceReachable(
      hs1Port,
      hostname,
      peer1BtpPort,
      HS_PUBLISH_BUDGET_MS,
      `peer1 HS ${hostname}:${peer1BtpPort}`
    );

    // peer2: standalone, socks5 via hs1 (local testnet exit), peer URL is peer1's .anon
    const peer2Config: ConnectorConfig = {
      nodeId: 'peer2',
      btpServerPort: peer2BtpPort,
      healthCheckPort: peer2HealthPort,
      logLevel: 'warn',
      environment: 'development',
      deploymentMode: 'standalone',
      adminApi: { enabled: true, port: peer2AdminPort, host: '127.0.0.1' },
      localDelivery: {
        enabled: true,
        handlerUrl: `http://127.0.0.1:${peer2BlsPort}`,
      },
      peers: [
        {
          id: 'peer1',
          url: `ws://${hostname}:${peer1BtpPort}`,
          authToken: '',
        },
      ],
      routes: [
        { prefix: 'test.peer2', nextHop: 'peer2' },
        { prefix: 'test.peer1', nextHop: 'peer1' },
      ],
      transport: {
        type: 'socks5',
        managed: false,
        socksProxy: `socks5h://127.0.0.1:${hs1Port}`,
        externalUrl: 'ws://peer2.invalid/btp', // not used — peer2 has no inbound
      },
    };

    peer2 = new ConnectorNode(peer2Config, createLogger('peer2', 'warn'));
    await peer2.start();

    // Wait for BTP connection from peer2 to peer1 via .anon circuit
    const deadline = Date.now() + BTP_CONNECT_BUDGET_MS;
    let connected = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${peer2AdminPort}/admin/peers`);
        if (res.ok) {
          const body = (await res.json()) as { peers: Array<{ id: string; connected: boolean }> };
          if (body.peers.find((p) => p.id === 'peer1')?.connected === true) {
            connected = true;
            break;
          }
        }
      } catch {
        /* keep polling */
      }
      await sleep(1000);
    }
    if (!connected) {
      throw new Error(
        `peer2 → peer1 BTP connection via HS did not establish within ${BTP_CONNECT_BUDGET_MS}ms`
      );
    }
  });

  afterAll(async () => {
    await peer2?.stop().catch(() => undefined);
    await peer1?.stop().catch(() => undefined);
    await bls1?.stop().catch(() => undefined);
    await bls2?.stop().catch(() => undefined);
    if (peer1TempDir) {
      fs.rmSync(peer1TempDir, { recursive: true, force: true });
    }
  });

  it('packet routes peer2 → .anon → peer1 → BLS1', async () => {
    const before = bls1.received.length;
    const res = await fetch(`http://127.0.0.1:${peer2AdminPort}/admin/ilp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destination: 'test.peer1.receiver', amount: '0', data: '' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: boolean };
    expect(body.accepted).toBe(true);
    expect(bls1.received.length).toBe(before + 1);
    expect(bls1.received[before]!.destination).toBe('test.peer1.receiver');
  });
});
