/**
 * Standalone Mode Smoke E2E Integration Test
 *
 * Proves that two ConnectorNode instances in `deploymentMode: 'standalone'`
 * achieve functional parity with embedded mode for packet delivery:
 *
 *   [Test App2] <-- POST /handle-packet -- [Peer2 Connector]
 *                                                ^
 *                                              BTP
 *                                                v
 *   [Test] -- POST /admin/ilp/send --> [Peer1 Connector]
 *
 * The test exercises the full HTTP surface that standalone mode depends on:
 *   - `POST /admin/ilp/send` on peer1 (outbound packet submission)
 *   - BTP peering between the two standalone connectors
 *   - `POST /handle-packet` on peer2's app (inbound local delivery)
 *
 * No settlement / anvil — that's covered by `standalone-settlement-e2e.test.ts`.
 *
 * @packageDocumentation
 */

import http from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import express, { Request, Response } from 'express';
import { ConnectorNode } from '../../src/core/connector-node';
import { createLogger } from '../../src/utils/logger';
import type { ConnectorConfig } from '../../src/config/types';

jest.setTimeout(60_000);

// ConnectorNode persists its runtime peer/route registry at a path derived
// straight from `config.nodeId` (`./data/registry-<nodeId>.db`), replayed on
// every subsequent `start()`. `standalone-settlement-e2e.test.ts` runs
// concurrently with this file under `test:standalone` and uses the same
// literal 'peer1'/'peer2' node ids, so a fixed id here would collide with
// that file's registry db — and, on a re-run in a workspace that already has
// this file's own leftover db from a prior invocation, would replay a
// *stale* peer entry (an old, no-longer-listening BTP port) before this
// run's own `registerPeer()` call ever executes, hanging the suite exactly
// like the port collision this file was written to fix (issue #464). A
// per-process suffix keeps the db path unique across both concurrent workers
// and repeated runs. Routing labels ('peer1'/'peer2') stay fixed — routing
// and the registry-db identity are independent concerns, and the destination
// addresses below (`test.peer2.receiver`) hardcode the label.
const RUN_SUFFIX = `${process.pid}-${Math.floor(Math.random() * 1e9)}`;

// ────────────────────────────────────────────────────────────────────────────
// Test App Server
// ────────────────────────────────────────────────────────────────────────────

interface CapturedRequest {
  paymentId: string;
  destination: string;
  amount: string;
  expiresAt: string;
  data?: string;
  isTransit?: boolean;
}

interface TestAppServer {
  port: number;
  received: CapturedRequest[];
  setResponder(fn: (req: CapturedRequest) => { accept: boolean; data?: string }): void;
  stop(): Promise<void>;
}

// Binds to port 0 (kernel-assigned) and reads the real port back off the
// listening socket — no port is ever chosen by this process, so two Jest
// workers running this suite concurrently cannot pick the same one (issue
// #464). No check-then-bind window exists either: the OS hands out the port
// as part of the bind itself.
async function startTestApp(): Promise<TestAppServer> {
  const app = express();
  app.use(express.json());

  const received: CapturedRequest[] = [];
  let responder: (req: CapturedRequest) => { accept: boolean; data?: string } = () => ({
    accept: true,
  });

  app.post('/handle-packet', (req: Request, res: Response) => {
    const body = req.body as CapturedRequest;
    received.push(body);
    res.json(responder(body));
  });

  app.get('/health', (_req, res) => res.json({ status: 'healthy' }));

  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    port,
    received,
    setResponder(fn) {
      responder = fn;
    },
    stop() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Admin API helpers
// ────────────────────────────────────────────────────────────────────────────

interface IlpSendResponse {
  accepted: boolean;
  code?: string;
  message?: string;
  data?: string;
}

async function registerPeer(adminPort: number, peer: { id: string; url: string }): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${adminPort}/admin/peers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: peer.id, url: peer.url, authToken: '' }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to register peer ${peer.id}: ${response.status} ${text}`);
  }
}

async function ilpSend(
  adminPort: number,
  body: { destination: string; amount: string; data?: string; timeoutMs?: number }
): Promise<{ status: number; body: IlpSendResponse }> {
  const response = await fetch(`http://127.0.0.1:${adminPort}/admin/ilp/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: '', ...body }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: JSON.parse(text) as IlpSendResponse,
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPeerConnected(
  adminPort: number,
  peerId: string,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${adminPort}/admin/peers`);
      if (response.ok) {
        const body = (await response.json()) as {
          peers: Array<{ id: string; connected: boolean }>;
        };
        const peer = body.peers.find((p) => p.id === peerId);
        if (peer?.connected) return;
      }
    } catch {
      // not ready yet
    }
    await sleep(100);
  }
  throw new Error(`Peer ${peerId} did not connect within ${timeoutMs}ms`);
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('Standalone Mode Smoke E2E', () => {
  let peer1: ConnectorNode;
  let peer2: ConnectorNode;
  let app1: TestAppServer;
  let app2: TestAppServer;
  let peer1AdminPort: number;

  beforeAll(async () => {
    // Every listening port below is OS-assigned (bind to 0, read the real
    // port back off the socket) — no port number is chosen by this process,
    // so a second Jest worker running this same file concurrently cannot
    // collide with it (issue #464).
    app1 = await startTestApp();
    app2 = await startTestApp();

    // `label` drives routing (route prefixes + the peer id the other side
    // registers this node under) and stays fixed across runs — test bodies
    // below hardcode `test.peer2.receiver`. `nodeId` (config identity + the
    // registry-db path) gets a RUN_SUFFIX so it can never collide with
    // another concurrent worker or a prior run's leftover db (see RUN_SUFFIX
    // comment above).
    const buildConfig = (opts: {
      label: string;
      peerLabel: string;
      appPort: number;
    }): ConnectorConfig => ({
      nodeId: `${opts.label}-${RUN_SUFFIX}`,
      btpServerPort: 0,
      healthCheckPort: 0,
      logLevel: 'warn',
      environment: 'development',
      deploymentMode: 'standalone',
      adminApi: { enabled: true, port: 0, host: '127.0.0.1' },
      localDelivery: {
        enabled: true,
        handlerUrl: `http://127.0.0.1:${opts.appPort}`,
      },
      // Peers are wired up after both nodes are listening (see below) —
      // neither node's BTP port is known until its own start() resolves, so
      // it can't be embedded in the other's config up front the way a
      // pre-guessed port number could.
      peers: [],
      routes: [
        { prefix: `test.${opts.label}`, nextHop: `${opts.label}-${RUN_SUFFIX}` },
        { prefix: `test.${opts.peerLabel}`, nextHop: opts.peerLabel },
      ],
    });

    // peer1 starts first, with no peers configured — its BTP port is read
    // back below and handed to peer2's config.
    const peer1Config = buildConfig({ label: 'peer1', peerLabel: 'peer2', appPort: app1.port });
    peer1 = new ConnectorNode(peer1Config, createLogger('peer1', 'warn'));
    await peer1.start();
    const peer1BtpPort = peer1.getBtpServerPort();
    peer1AdminPort = peer1.getAdminApiPort()!;
    if (peer1BtpPort === null || peer1AdminPort === null) {
      throw new Error('peer1 did not report its bound BTP/admin ports after start()');
    }

    // peer2 dials peer1 (already listening) from its own config.
    const peer2Config = buildConfig({ label: 'peer2', peerLabel: 'peer1', appPort: app2.port });
    peer2Config.peers = [{ id: 'peer1', url: `ws://127.0.0.1:${peer1BtpPort}`, authToken: '' }];
    peer2 = new ConnectorNode(peer2Config, createLogger('peer2', 'warn'));
    await peer2.start();
    const peer2BtpPort = peer2.getBtpServerPort();
    if (peer2BtpPort === null) {
      throw new Error('peer2 did not report its bound BTP port after start()');
    }

    // peer1 learns peer2's now-known BTP port via the same dynamic-peer
    // admin surface a real operator would use.
    await registerPeer(peer1AdminPort, { id: 'peer2', url: `ws://127.0.0.1:${peer2BtpPort}` });

    await waitForPeerConnected(peer1AdminPort, 'peer2');
  });

  afterAll(async () => {
    await peer1?.stop().catch(() => undefined);
    await peer2?.stop().catch(() => undefined);
    await app1?.stop().catch(() => undefined);
    await app2?.stop().catch(() => undefined);

    // Each run's RUN_SUFFIX'd nodeId gets its own registry-db file (see
    // RUN_SUFFIX comment above) rather than reusing one across runs — clean
    // it up so repeated local runs don't accumulate one file pair per run.
    for (const label of ['peer1', 'peer2']) {
      try {
        fs.unlinkSync(`./data/registry-${label}-${RUN_SUFFIX}.db`);
      } catch {
        // best-effort
      }
    }
  });

  it('should report standalone deployment mode', () => {
    expect(peer1.getDeploymentMode()).toBe('standalone');
    expect(peer2.getDeploymentMode()).toBe('standalone');
  });

  // Zero-amount packets bypass the per-packet claim service (which requires
  // chainProviders settlement setup). Stage 1 validates the pure HTTP surface
  // — admin API → BTP → local delivery HTTP client → app /handle-packet.
  // Non-zero amounts are exercised in standalone-settlement-e2e.test.ts.

  it('POST /admin/ilp/send → BTP → POST /handle-packet → fulfill', async () => {
    app2.setResponder(() => ({ accept: true }));
    const before = app2.received.length;

    const { status, body } = await ilpSend(peer1AdminPort, {
      destination: 'test.peer2.receiver',
      amount: '0',
    });

    expect(status).toBe(200);
    expect(body.accepted).toBe(true);

    expect(app2.received.length).toBe(before + 1);
    const captured = app2.received[before]!;
    expect(captured.destination).toBe('test.peer2.receiver');
    expect(captured.amount).toBe('0');
    expect(captured.paymentId).toBeTruthy();
  });

  it('app reject propagates as accepted:false with F99', async () => {
    app2.setResponder(() => ({ accept: false }));

    const { status, body } = await ilpSend(peer1AdminPort, {
      destination: 'test.peer2.receiver',
      amount: '0',
    });

    expect(status).toBe(200);
    expect(body.accepted).toBe(false);
    expect(body.code).toBe('F99');
  });

  it('app echoes response data on fulfill', async () => {
    const echo = Buffer.from('hello-standalone').toString('base64');
    app2.setResponder(() => ({ accept: true, data: echo }));

    const { status, body } = await ilpSend(peer1AdminPort, {
      destination: 'test.peer2.receiver',
      amount: '0',
    });

    expect(status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(body.data).toBe(echo);
  });
});
