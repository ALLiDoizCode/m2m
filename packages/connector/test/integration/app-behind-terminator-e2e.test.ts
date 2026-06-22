/**
 * App-behind-terminator E2E (Docker compose) — issue #221
 *
 * The "hello-world" of deploying an app behind the connector locally. One
 * compose profile (`app-behind-terminator`) brings up:
 *
 *   anvil + faucet  (EVM devnet)
 *   terminator      (standalone connector-as-terminator; image connector:standalone-e2e)
 *   relay           (the oblivious app — ghcr.io/toon-protocol/relay:latest)
 *
 *   host ─curl/h402Fetch─▶ POST /ilp (3000) ─▶ terminator ─▶ HttpProxyHandler
 *                                                              ▼
 *                                              upstream http://relay:3100
 *                                                              ▼
 *                                                         relay (app)
 *
 * What this asserts:
 *   - AC1: the terminator + anvil + faucet + relay come up (compose up + health waits).
 *   - AC2 (negative-path): the relay's paid-write store port is NOT reachable
 *     from the host (TCP-level failure, reusing the allowlist unreachable-port
 *     idiom), and an UNPAID `POST /ilp` to the terminator is REJECTED (F-class)
 *     by the inbound claim gate.
 *   - AC3 (full paid round-trip): a signed payment-channel claim rides the
 *     `POST /ilp` edge; the terminator validates payment and reverse-proxies the
 *     inner `POST /write` to the oblivious relay; the response deserializes to an
 *     ILP FULFILL whose proxied body echoes `eventId === event.id`; and the
 *     stored event is read back over the FREE Nostr WS (port 7100).
 *
 * Gate: APP_BEHIND_TERMINATOR=1 (the published relay:latest is real, so AC3 runs
 * by default; `RELAY_IMAGE` may still be overridden to pin a `sha-…` tag).
 *
 * @packageDocumentation
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as net from 'net';
import * as path from 'path';
import Database from 'libsql';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import {
  serializePacket,
  deserializePacket,
  PacketType,
  type ILPPreparePacket,
} from '@toon-protocol/shared';
import { ConnectorNode } from '../../src/core/connector-node';
import { createLogger } from '../../src/utils/logger';
import type { ConnectorConfig } from '../../src/config/types';
import { PerPacketClaimService } from '../../src/settlement/per-packet-claim-service';
import {
  SENT_CLAIMS_TABLE_SCHEMA,
  SENT_CLAIMS_INDEXES,
} from '../../src/settlement/claim-sender-db-schema';
import {
  ANVIL_CHAIN_ID,
  ANVIL_RPC_URL as ANVIL_RPC_URL_LOCAL,
  REGISTRY_ADDRESS,
  TOKEN_ADDRESS,
  PEER_PRIVATE_KEYS,
  PEER_EVM_ADDRESSES,
  fundPeerAccounts,
  waitForAnvilReady,
} from './multi-hop-helpers';

const execFileAsync = promisify(execFile);

const RUN = process.env.APP_BEHIND_TERMINATOR === '1';
const describeApp = RUN ? describe : describe.skip;

// The published relay image is real, so AC3 runs whenever the docker suite is
// gated on (APP_BEHIND_TERMINATOR=1). The compose `relay` service defaults
// RELAY_IMAGE to ghcr.io/toon-protocol/relay:latest; set RELAY_IMAGE in the
// environment to pin a specific tag (e.g. `sha-…`) — compose consumes it and
// this test needs no separate knowledge of the tag.

jest.setTimeout(300_000);

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PROFILE = 'app-behind-terminator';
const PROFILE_ARGS = ['compose', '--profile', PROFILE];

// Published to the host (127.0.0.1) by the compose profile.
const TERMINATOR_ILP_URL = 'http://127.0.0.1:3000/ilp'; // POST /ilp edge
const TERMINATOR_HEALTH_URL = 'http://127.0.0.1:8080/health';
const ANVIL_RPC_URL = 'http://127.0.0.1:8545';
const FAUCET_HEALTH_URL = 'http://127.0.0.1:3500/health';

// NOT published — only the terminator dials it over the compose network. The
// host must NOT be able to reach it (this is AC2's posture). The oblivious-mode
// store port is 3100 (`TOON_BLS_PORT`, `POST /write`); the free-read Nostr WS
// port 7100 (`TOON_RELAY_PORT`) IS published.
const RELAY_WRITE_PORT = 3100;
const RELAY_WS_READ_PORT = 7100;

// The terminated route under test (see scripts/app-behind-terminator/terminator.yaml).
const TERMINATED_PREFIX = 'g.terminator.relay';
const ROUTE_PRICE = 1000n;

// The terminator's on-chain settlement signer is Anvil account 0 (keyId
// 0xac0974… in terminator.yaml). The test client opens a funded channel TOWARD
// this address so the inbound claim's channel exists on-chain.
const TERMINATOR_SETTLEMENT_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

// The test client (an in-process ConnectorNode) uses Anvil account 2 as its
// settlement wallet — it auto-opens + funds the channel and signs the claims.
const CLIENT_KEY_INDEX = 0; // → PEER_PRIVATE_KEYS[0] / PEER_EVM_ADDRESSES[0] (account 2)

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

// ── Minimal NIP-01 signed event (kind:1) ────────────────────────────────────
interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Sign a minimal valid NIP-01 kind:1 event with secp256k1 schnorr. */
function signNostrEvent(secretKey: Uint8Array, content: string): NostrEvent {
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKey));
  const created_at = Math.floor(Date.now() / 1000);
  const kind = 1;
  const tags: string[][] = [];
  // NIP-01 serialization: [0, pubkey, created_at, kind, tags, content]
  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  const id = bytesToHex(sha256(new TextEncoder().encode(serialized)));
  const sig = bytesToHex(schnorr.sign(id, secretKey));
  return { id, pubkey, created_at, kind, tags, content, sig };
}

/**
 * Read the free Nostr WS until EOSE, collecting every EVENT[2] payload. The
 * relay emits NIP-01 EVENT[2] as a TOON-encoded STRING (not a JSON object), so
 * callers substring-match the returned strings — they must NOT JSON.parse them.
 */
function readNostrEvents(
  url: string,
  subId: string,
  filter: Record<string, unknown>,
  timeoutMs: number
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const eventStrings: string[] = [];
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out reading Nostr events from ${url}`));
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify(['REQ', subId, filter]));
    });
    ws.on('message', (data: Buffer) => {
      let msg: unknown;
      try {
        // The OUTER NIP-01 frame is JSON: ["EVENT",<subId>,<payload>] / ["EOSE",<subId>].
        msg = JSON.parse(data.toString());
      } catch {
        return; // ignore non-JSON frames
      }
      if (!Array.isArray(msg)) return;
      if (msg[0] === 'EVENT' && msg[1] === subId) {
        // payload (msg[2]) is a TOON-encoded STRING — keep it verbatim.
        eventStrings.push(String(msg[2]));
      } else if (msg[0] === 'EOSE' && msg[1] === subId) {
        clearTimeout(timer);
        ws.close();
        resolve(eventStrings);
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describeApp('App-behind-terminator E2E (Docker)', () => {
  let client: ConnectorNode | undefined;
  let claimSvc: PerPacketClaimService | undefined;
  let settlementTokenId: string | undefined;

  beforeAll(async () => {
    // Bring up the full stack — the published relay image is real, so `relay`
    // joins the `--wait` set and AC3 runs by default.
    await compose('build', 'terminator');
    await compose('up', '-d', '--wait', 'anvil', 'faucet', 'terminator', 'relay');

    // AC1 — wait for anvil (eth_chainId), faucet /health, terminator /health.
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
        const res = await fetch(TERMINATOR_HEALTH_URL, { signal: AbortSignal.timeout(2_000) });
        return res.ok;
      },
      120_000,
      'terminator /health responds'
    );

    // ── AC3 client setup: an in-process ConnectorNode that auto-opens + funds an
    // on-chain channel TOWARD the terminator's settlement address, and signs
    // claims byte-identically to a real per-packet claim (self-describing EVM
    // fields → the terminator's inbound gate verifies the signature without a
    // pre-registered channel). Mirrors ilp-http-settlement-e2e.test.ts.
    await waitForAnvilReady(60_000);
    await fundPeerAccounts([PEER_EVM_ADDRESSES[CLIENT_KEY_INDEX]!]);

    const base = 51_000 + Math.floor(Math.random() * 8_000);
    const clientConfig: ConnectorConfig = {
      nodeId: 'ac3-client',
      btpServerPort: base,
      healthCheckPort: base + 1,
      logLevel: 'warn',
      environment: 'development',
      deploymentMode: 'standalone',
      adminApi: { enabled: true, port: base + 2, host: '127.0.0.1' },
      // The peer "terminator" maps to the terminator's settlement signer address;
      // the client auto-opens + funds the channel toward it.
      peers: [
        {
          id: 'terminator',
          url: `ws://127.0.0.1:${base + 50}`, // unreachable — we never dial BTP; only sign claims
          authToken: '',
          evmAddress: TERMINATOR_SETTLEMENT_ADDRESS,
          chain: `evm:${ANVIL_CHAIN_ID}`,
        },
      ],
      routes: [{ prefix: 'g.terminator', nextHop: 'terminator' }],
      settlement: {
        connectorFeePercentage: 0.1,
        enableSettlement: true,
        tigerBeetleClusterId: 0,
        tigerBeetleReplicas: [],
        thresholds: { defaultThreshold: 5000n, pollingInterval: 100 },
      },
      chainProviders: [
        {
          chainType: 'evm',
          chainId: `evm:${ANVIL_CHAIN_ID}`,
          rpcUrl: ANVIL_RPC_URL_LOCAL,
          registryAddress: REGISTRY_ADDRESS,
          keyId: PEER_PRIVATE_KEYS[CLIENT_KEY_INDEX]!,
          tokenAddress: TOKEN_ADDRESS,
          settlementOptions: {
            threshold: '5000',
            pollingIntervalMs: 100,
            settlementTimeoutSecs: 3600,
            initialDepositMultiplier: 2,
            ledgerSnapshotPath: `./data/ledger-ac3-client-${base}.json`,
          },
        },
      ],
    };

    client = new ConnectorNode(clientConfig, createLogger('ac3-client', 'warn'));
    await client.start();

    // Open + fund the on-chain channel toward the terminator's settlement address
    // on demand (there is no BTP link to trigger auto-open — we only sign claims).
    settlementTokenId = client.defaultSettlementTokenId;
    await waitForCondition(
      async () => {
        await client!.channelManager!.ensureChannelExists('terminator', settlementTokenId!, {
          chain: `evm:${ANVIL_CHAIN_ID}`,
        });
        return client!.channelManager!.getChannelsForPeer('terminator').length > 0;
      },
      90_000,
      'client opens on-chain channel toward terminator settlement address'
    );

    // Build a test-side claim signer over the client's real channel context.
    const claimDb = new Database(':memory:') as unknown as import('better-sqlite3').Database;
    claimDb.exec(SENT_CLAIMS_TABLE_SCHEMA);
    for (const idx of SENT_CLAIMS_INDEXES) claimDb.exec(idx);
    claimSvc = new PerPacketClaimService(
      client.chainRegistry!,
      client.channelManager!,
      claimDb,
      createLogger('ac3-claim', 'warn'),
      'ac3-client',
      new Map([['terminator', `evm:${ANVIL_CHAIN_ID}`]])
    );
  });

  afterAll(async () => {
    await client?.stop().catch(() => undefined);
    await compose('down', '--volumes').catch(() => undefined);
  });

  it('AC1: the terminator edge (POST /ilp) is up and the admin API is NOT published', async () => {
    // /ilp is published on 3000; the admin API (8081) is deliberately not.
    expect(await tcpReachable('127.0.0.1', 3000, 2_000)).toBe(true);
    expect(await tcpReachable('127.0.0.1', 8081, 2_000)).toBe(false);
  });

  it("AC2: the relay's paid-write port is NOT reachable from the host", async () => {
    // The relay's write/store port is never published — only the terminator
    // dials it over the compose network by service name. A direct host probe
    // must fail at the TCP layer. (Mirrors the allowlist unreachable-port
    // assertion.)
    const reachable = await tcpReachable('127.0.0.1', RELAY_WRITE_PORT, 2_000);
    expect(reachable).toBe(false);
  });

  it('AC2: an UNPAID POST /ilp to the terminator is REJECTED (claim gate)', async () => {
    // A PREPARE addressed to the terminated route, carrying a valid HTTP
    // envelope but NO payment-channel claim header, must be rejected by the
    // inbound claim gate BEFORE it ever reaches the relay. The ILP-over-HTTP
    // edge returns 200 + a serialized ILP REJECT for an ILP-level outcome.
    const envelope = buildHttpEnvelope(
      'POST',
      '/write',
      [
        ['Host', 'relay'],
        ['Content-Type', 'application/json'],
      ],
      JSON.stringify({ note: 'unpaid write attempt' })
    );
    const prepare = buildPreparePacket(TERMINATED_PREFIX, ROUTE_PRICE, envelope);
    const body = serializePacket(prepare);

    const res = await fetch(TERMINATOR_ILP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      // No `ILP-Payment-Channel-Claim` header — this is the unpaid attempt.
      body,
      signal: AbortSignal.timeout(10_000),
    });

    // The edge answers an ILP-level outcome as 200 + serialized REJECT; a
    // transport-level refusal (e.g. 4xx) is also acceptable proof the write did
    // NOT succeed.
    if (res.status === 200) {
      const buf = Buffer.from(await res.arrayBuffer());
      // A FULFILL would mean the unpaid write slipped through — that must NOT happen.
      expect(buf.length).toBeGreaterThan(0);
      expect(buf[0]).not.toBe(PacketType.FULFILL);
      expect(buf[0]).toBe(PacketType.REJECT);
    } else {
      // Any non-2xx is also a valid "not accepted" outcome.
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC3 — full paid round-trip (FULFILL + relay stored), verified over free reads.
  // ──────────────────────────────────────────────────────────────────────────
  it('AC3: a paid POST /ilp round-trips → FULFILL and the relay stores the write', async () => {
    expect(claimSvc).toBeDefined();
    expect(settlementTokenId).toBeDefined();

    // 1. Sign a payment-channel claim ≥ the route price for the terminator channel.
    const claim = await claimSvc!.generateClaimForPacket(
      'terminator',
      settlementTokenId!,
      ROUTE_PRICE
    );
    expect(claim).not.toBeNull();

    // 2. Build the inner HTTP envelope: `POST /write`, JSON `{ event: <signed kind:1> }`.
    const clientSecretKey = schnorr.utils.randomPrivateKey();
    const event = signNostrEvent(clientSecretKey, `ac3 paid write ${Date.now()}`);
    const innerBody = JSON.stringify({ event });
    const envelope = buildHttpEnvelope(
      'POST',
      '/write',
      [
        ['Host', 'relay'],
        ['Content-Type', 'application/json'],
        ['Content-Length', String(Buffer.byteLength(innerBody))],
      ],
      innerBody
    );

    // 3. POST the ILP PREPARE (data = envelope) to the terminator edge, addressed
    //    under the terminated route, with the claim in the wire header.
    const prepare = buildPreparePacket(TERMINATED_PREFIX, ROUTE_PRICE, envelope);
    const res = await fetch(TERMINATOR_ILP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'ILP-Payment-Channel-Claim': claim!.protocolData.data.toString('base64'),
      },
      body: serializePacket(prepare),
      signal: AbortSignal.timeout(30_000),
    });

    expect(res.status).toBe(200);
    const packetBuf = Buffer.from(await res.arrayBuffer());
    const packet = deserializePacket(packetBuf);
    expect(packet.type).toBe(PacketType.FULFILL);

    // The FULFILL data is the proxied upstream HTTP response envelope. Its body
    // is the relay's `POST /write` JSON: { eventId, storedAt, ... }.
    const fulfillData = (packet as { data: Buffer }).data;
    const fulfillText = fulfillData.toString('latin1');
    // Parse out the JSON body after the response headers (CRLFCRLF separator).
    const bodyStart = fulfillText.indexOf('\r\n\r\n');
    expect(bodyStart).toBeGreaterThan(-1);
    const jsonBody = fulfillText.slice(bodyStart + 4);
    const writeResult = JSON.parse(jsonBody) as { eventId?: string };
    expect(writeResult.eventId).toBe(event.id);

    // 4. Verify storage over FREE reads (no terminator): the relay emits NIP-01
    //    EVENT[2] as a TOON-encoded STRING containing `id: <eventId>`.
    const eventStrings = await readNostrEvents(
      `ws://127.0.0.1:${RELAY_WS_READ_PORT}`,
      'ac3',
      { kinds: [1] },
      20_000
    );
    expect(eventStrings.some((s) => s.includes(`id: ${event.id}`))).toBe(true);
  });
});
