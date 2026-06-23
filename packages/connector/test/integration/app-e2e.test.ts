/**
 * App-behind-connector E2E (Docker compose) — issue #221
 *
 * The "hello-world" of deploying an app behind the connector locally. One
 * compose profile (`app`) brings up:
 *
 *   anvil + faucet  (EVM devnet)
 *   connector       (standalone connector / paid reverse proxy; image connector:standalone-e2e)
 *   app             (the oblivious app, a relay — env-overridable RELAY_IMAGE)
 *
 *   host ─curl/h402Fetch─▶ POST /ilp (3000) ─▶ connector ─▶ HttpProxyHandler
 *                                                             ▼
 *                                              upstream http://app:3100
 *                                                             ▼
 *                                                          app (relay)
 *
 * What this asserts:
 *   - AC1: the connector + anvil + faucet come up (compose up + health waits).
 *   - AC2 (negative-path, ALWAYS run): the app's paid-write store port is NOT
 *     reachable from the host (TCP-level failure, reusing the allowlist
 *     unreachable-port idiom), and an UNPAID `POST /ilp` to the connector is
 *     REJECTED (F-class) by the inbound claim gate.
 *   - AC3 (full paid round-trip): SKIPPED with a clear console message unless a
 *     real `RELAY_IMAGE` is supplied — the decoupled relay image does not exist
 *     in this repo yet (separate "decouple relay" work, not yet published).
 *
 * Gate: APP_E2E=1
 *
 * Why no app in the default compose-up: the default `RELAY_IMAGE`
 * (ghcr.io/toon-protocol/relay:oblivious) is not published, so a `--wait` on the
 * `app` service would hang/fail. We therefore bring up ONLY
 * `connector anvil faucet` here and start `app` only when a real image is
 * supplied via `RELAY_IMAGE` (which also unlocks the AC3 round-trip).
 *
 * @packageDocumentation
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as net from 'net';
import * as path from 'path';
import { serializePacket, PacketType, type ILPPreparePacket } from '@toon-protocol/shared';
import { PaidRoundTripClient, type ProbeStep } from './paid-roundtrip-client';

const execFileAsync = promisify(execFile);

const RUN = process.env.APP_E2E === '1';
const describeApp = RUN ? describe : describe.skip;

// A real relay image unlocks the AC3 paid round-trip. The default points at the
// not-yet-published GHCR image; presence of an explicit override (any value
// other than the default) means an operator has wired a real relay.
const DEFAULT_RELAY_IMAGE = 'ghcr.io/toon-protocol/relay:oblivious';
const RELAY_IMAGE = process.env.RELAY_IMAGE;
const HAVE_REAL_RELAY = Boolean(RELAY_IMAGE && RELAY_IMAGE !== DEFAULT_RELAY_IMAGE);

jest.setTimeout(300_000);

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PROFILE = 'app';
const PROFILE_ARGS = ['compose', '--profile', PROFILE];

// Published to the host (127.0.0.1) by the compose profile.
const CONNECTOR_ILP_URL = 'http://127.0.0.1:3000/ilp'; // POST /ilp edge
const CONNECTOR_HEALTH_URL = 'http://127.0.0.1:8080/health';
const ANVIL_RPC_URL = 'http://127.0.0.1:8545';
const FAUCET_HEALTH_URL = 'http://127.0.0.1:3500/health';

// NOT published — only the connector dials it over the compose network. The
// host must NOT be able to reach it (this is AC2's posture). Per relay#24 the
// oblivious-mode store port is 3100 (`TOON_BLS_PORT`, `POST /write`); the free-read
// Nostr WS port 7100 (`TOON_RELAY_PORT`) IS published.
const RELAY_WRITE_PORT = 3100;
const RELAY_WS_READ_PORT = 7100;

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
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for: ${description} (${timeoutMs}ms)`);
}

/** Probe a TCP port on the host. Resolves true if a connection is established. */
function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/** Build a literal HTTP/1.1 request envelope (the #216 wire format). */
function buildHttpEnvelope(
  method: string,
  target: string,
  headers: Array<[string, string]>,
  body: string
): Buffer {
  const CRLF = '\r\n';
  const head = [`${method} ${target} HTTP/1.1`, ...headers.map(([n, v]) => `${n}: ${v}`)].join(
    CRLF
  );
  return Buffer.concat([Buffer.from(head + CRLF + CRLF, 'latin1'), Buffer.from(body)]);
}

function buildPreparePacket(destination: string, amount: bigint, data: Buffer): ILPPreparePacket {
  return {
    type: PacketType.PREPARE,
    destination,
    amount,
    expiresAt: new Date(Date.now() + 60_000),
    data,
  };
}

describeApp('App-behind-connector E2E (Docker)', () => {
  beforeAll(async () => {
    // The default RELAY_IMAGE is not published, so bring up only the services we
    // can actually start. `app` joins only when a real image is supplied.
    await compose('build', 'connector');
    const upServices = HAVE_REAL_RELAY
      ? ['up', '-d', '--wait', 'anvil', 'faucet', 'connector', 'app']
      : ['up', '-d', '--wait', 'anvil', 'faucet', 'connector'];
    await compose(...upServices);

    // AC1 — wait for anvil (eth_chainId), faucet /health, connector /health.
    await waitForCondition(
      async () => {
        const res = await fetch(ANVIL_RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
          signal: AbortSignal.timeout(2_000),
        });
        return res.ok;
      },
      120_000,
      'anvil eth_chainId responds'
    );

    await waitForCondition(
      async () => {
        const res = await fetch(FAUCET_HEALTH_URL, { signal: AbortSignal.timeout(2_000) });
        return res.ok;
      },
      120_000,
      'faucet /health responds'
    );

    await waitForCondition(
      async () => {
        const res = await fetch(CONNECTOR_HEALTH_URL, { signal: AbortSignal.timeout(2_000) });
        return res.ok;
      },
      120_000,
      'connector /health responds'
    );
  });

  afterAll(async () => {
    await compose('down', '--volumes').catch(() => undefined);
  });

  it('AC1: the connector edge (POST /ilp) is up and the admin API is NOT published', async () => {
    // /ilp is published on 3000; the admin API (8081) is deliberately not.
    expect(await tcpReachable('127.0.0.1', 3000, 2_000)).toBe(true);
    expect(await tcpReachable('127.0.0.1', 8081, 2_000)).toBe(false);
  });

  it("AC2: the relay's paid-write port is NOT reachable from the host", async () => {
    // The relay's write/store port is never published — only the connector
    // dials it over the compose network by service name. A direct host probe
    // must fail at the TCP layer. (Mirrors the allowlist unreachable-port
    // assertion.) This holds whether or not the relay container is running.
    const reachable = await tcpReachable('127.0.0.1', RELAY_WRITE_PORT, 2_000);
    expect(reachable).toBe(false);
  });

  it('AC2: an UNPAID POST /ilp to the connector is REJECTED (claim gate)', async () => {
    // A PREPARE addressed to the terminated route, carrying a valid HTTP
    // envelope but NO payment-channel claim header, must be rejected by the
    // inbound claim gate BEFORE it ever reaches the relay. The ILP-over-HTTP
    // edge returns 200 + a serialized ILP REJECT for an ILP-level outcome.
    const envelope = buildHttpEnvelope(
      'POST',
      '/store',
      [
        ['Host', 'relay'],
        ['Content-Type', 'application/json'],
      ],
      JSON.stringify({ note: 'unpaid write attempt' })
    );
    const prepare = buildPreparePacket('g.connector.relay.store', 1000n, envelope);
    const body = serializePacket(prepare);

    const res = await fetch(CONNECTOR_ILP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      // No `ILP-Payment-Channel-Claim` header — this is the unpaid attempt.
      body,
      signal: AbortSignal.timeout(10_000),
    });

    // The edge answers an ILP-level outcome as 200 + serialized REJECT; a
    // transport-level refusal (e.g. 4xx) is also acceptable proof the write did
    // NOT succeed. What matters: the write was NOT accepted/fulfilled.
    if (res.status === 200) {
      const buf = Buffer.from(await res.arrayBuffer());
      // First byte of an ILP packet is the type tag. A FULFILL would mean the
      // unpaid write slipped through — that must NOT happen.
      expect(buf.length).toBeGreaterThan(0);
      expect(buf[0]).not.toBe(PacketType.FULFILL);
      expect(buf[0]).toBe(PacketType.REJECT);
    } else {
      // Any non-2xx is also a valid "not accepted" outcome.
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC3 — full paid round-trip (FULFILL + relay stored). Gated on a real relay.
  // ──────────────────────────────────────────────────────────────────────────
  (HAVE_REAL_RELAY ? it : it.skip)(
    'AC3: a paid POST /ilp round-trips → FULFILL and the relay stores the write',
    async () => {
      // The full paid round-trip lives in the SHARED `PaidRoundTripClient` so the
      // exact same code path runs here (localhost compose) and in the #222 CI
      // acceptance probe (remote public box). Pointed at the published compose
      // ports: connector /ilp 3000, anvil 8545, faucet 3500, relay free-read WS
      // 7100 (RELAY_WS_READ_PORT). relay#24 store contract: POST /write, body
      // `{event}`; EVENT[2] is a TOON-encoded string (substring id match).
      const client = new PaidRoundTripClient({
        connectorIlpUrl: CONNECTOR_ILP_URL,
        evmRpcUrl: ANVIL_RPC_URL,
        faucetUrl: 'http://127.0.0.1:3500',
        relayWsUrl: `ws://127.0.0.1:${RELAY_WS_READ_PORT}`,
      });
      try {
        await client.start();
        const steps = await client.runPaidRoundTrip();
        for (const step of steps as ProbeStep[]) {
          expect({ name: step.name, ok: step.ok, detail: step.detail }).toMatchObject({ ok: true });
        }
      } finally {
        await client.stop();
      }
    }
  );

  it('AC3 gate: reports skip status for the paid round-trip', () => {
    if (!HAVE_REAL_RELAY) {
      // Explicit, non-silent skip notice (no silent pass) per issue #221.
      // eslint-disable-next-line no-console
      console.log(
        '[app-e2e] SKIPPING AC3 paid-write round-trip: no real RELAY_IMAGE ' +
          `supplied (RELAY_IMAGE=${RELAY_IMAGE ?? '<unset>'}, default ${DEFAULT_RELAY_IMAGE} ` +
          'is not published). The connector + AC2 negative-path assertions still ran. ' +
          'Set RELAY_IMAGE=<real relay> to exercise the full paid round-trip.'
      );
    }
    expect(true).toBe(true);
  });
});
