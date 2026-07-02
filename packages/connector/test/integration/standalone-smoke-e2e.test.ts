/**
 * Standalone Mode Smoke E2E Integration Test
 *
 * Proves that two ConnectorNode instances in `deploymentMode: 'standalone'`
 * achieve functional parity with embedded mode for packet delivery:
 *
 *   [Test BLS2] <-- POST /handle-packet -- [Peer2 Connector]
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
import express, { Request, Response } from 'express';
import { ConnectorNode } from '../../src/core/connector-node';
import { createLogger } from '../../src/utils/logger';
import type { ConnectorConfig } from '../../src/config/types';

jest.setTimeout(60_000);

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

interface TestBlsServer {
  port: number;
  received: CapturedRequest[];
  setResponder(fn: (req: CapturedRequest) => { accept: boolean; data?: string }): void;
  stop(): Promise<void>;
}

async function startTestBls(port: number): Promise<TestBlsServer> {
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
    server.listen(port, '127.0.0.1', () => resolve());
  });

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
// Port allocation — pick a random base per run to avoid collisions
// ────────────────────────────────────────────────────────────────────────────

function randomPortBase(): number {
  return 30000 + Math.floor(Math.random() * 20000);
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
  let bls1: TestBlsServer;
  let bls2: TestBlsServer;
  let peer1AdminPort: number;

  beforeAll(async () => {
    const base = randomPortBase();
    const peer1Btp = base;
    const peer2Btp = base + 1;
    peer1AdminPort = base + 2;
    const peer2AdminPort = base + 3;
    const bls1Port = base + 4;
    const bls2Port = base + 5;
    const peer1Health = base + 6;
    const peer2Health = base + 7;

    bls1 = await startTestBls(bls1Port);
    bls2 = await startTestBls(bls2Port);

    const buildConfig = (opts: {
      nodeId: string;
      btpPort: number;
      adminPort: number;
      healthPort: number;
      blsPort: number;
      peer: { id: string; port: number };
    }): ConnectorConfig => ({
      nodeId: opts.nodeId,
      btpServerPort: opts.btpPort,
      healthCheckPort: opts.healthPort,
      logLevel: 'warn',
      environment: 'development',
      deploymentMode: 'standalone',
      adminApi: { enabled: true, port: opts.adminPort, host: '127.0.0.1' },
      localDelivery: {
        enabled: true,
        handlerUrl: `http://127.0.0.1:${opts.blsPort}`,
      },
      peers: [
        {
          id: opts.peer.id,
          url: `ws://127.0.0.1:${opts.peer.port}`,
          authToken: '',
        },
      ],
      routes: [
        { prefix: `test.${opts.nodeId}`, nextHop: opts.nodeId },
        { prefix: `test.${opts.peer.id}`, nextHop: opts.peer.id },
      ],
    });

    const peer1Config = buildConfig({
      nodeId: 'peer1',
      btpPort: peer1Btp,
      adminPort: peer1AdminPort,
      healthPort: peer1Health,
      blsPort: bls1Port,
      peer: { id: 'peer2', port: peer2Btp },
    });
    const peer2Config = buildConfig({
      nodeId: 'peer2',
      btpPort: peer2Btp,
      adminPort: peer2AdminPort,
      healthPort: peer2Health,
      blsPort: bls2Port,
      peer: { id: 'peer1', port: peer1Btp },
    });

    peer2 = new ConnectorNode(peer2Config, createLogger('peer2', 'warn'));
    await peer2.start();

    peer1 = new ConnectorNode(peer1Config, createLogger('peer1', 'warn'));
    await peer1.start();

    await waitForPeerConnected(peer1AdminPort, 'peer2');
  });

  afterAll(async () => {
    await peer1?.stop().catch(() => undefined);
    await peer2?.stop().catch(() => undefined);
    await bls1?.stop().catch(() => undefined);
    await bls2?.stop().catch(() => undefined);
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
    bls2.setResponder(() => ({ accept: true }));
    const before = bls2.received.length;

    const { status, body } = await ilpSend(peer1AdminPort, {
      destination: 'test.peer2.receiver',
      amount: '0',
    });

    expect(status).toBe(200);
    expect(body.accepted).toBe(true);

    expect(bls2.received.length).toBe(before + 1);
    const captured = bls2.received[before]!;
    expect(captured.destination).toBe('test.peer2.receiver');
    expect(captured.amount).toBe('0');
    expect(captured.paymentId).toBeTruthy();
  });

  it('app reject propagates as accepted:false with F99', async () => {
    bls2.setResponder(() => ({ accept: false }));

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
    bls2.setResponder(() => ({ accept: true, data: echo }));

    const { status, body } = await ilpSend(peer1AdminPort, {
      destination: 'test.peer2.receiver',
      amount: '0',
    });

    expect(status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(body.data).toBe(echo);
  });
});
