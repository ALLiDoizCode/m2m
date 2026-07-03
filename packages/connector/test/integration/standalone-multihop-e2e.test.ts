/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type, @typescript-eslint/ban-types, no-console */

/**
 * Standalone Mode Multi-Hop E2E Integration Test
 *
 * Three ConnectorNode instances in `deploymentMode: 'standalone'` form a
 * linear chain:
 *
 *   [App1] <-- peer1 <-- BTP --> peer2 <-- BTP --> peer3 --> [App3]
 *                ^                                       ^
 *          admin API                               admin API
 *                ^                                       ^
 *                └── test harness drives both ──────────┘
 *
 * Parity target: `multi-hop-e2e.test.ts` proves this topology works in
 * embedded mode with real Anvil settlement. This test proves the *routing
 * surface* works in standalone mode — packets submitted via one peer's
 * `/admin/ilp/send` traverse two BTP hops and are delivered to the far
 * peer's app via `/handle-packet`.
 *
 * Scope: zero-amount packets to isolate HTTP + BTP routing from the
 * settlement path (covered separately by standalone-settlement-e2e).
 *
 * @packageDocumentation
 */

import http from 'http';
import express, { Request, Response } from 'express';
import { ConnectorNode } from '../../src/core/connector-node';
import { createLogger } from '../../src/utils/logger';
import type { ConnectorConfig } from '../../src/config/types';

jest.setTimeout(90_000);

// ────────────────────────────────────────────────────────────────────────────
// Test app fixtures
// ────────────────────────────────────────────────────────────────────────────

interface CapturedRequest {
  destination: string;
  amount: string;
  paymentId: string;
  isTransit?: boolean;
}

interface TestApp {
  port: number;
  received: CapturedRequest[];
  stop(): Promise<void>;
}

async function startApp(port: number): Promise<TestApp> {
  const app = express();
  app.use(express.json());
  const received: CapturedRequest[] = [];
  app.post('/handle-packet', (req: Request, res: Response) => {
    const body = req.body as CapturedRequest;
    received.push({
      destination: body.destination,
      amount: body.amount,
      paymentId: body.paymentId,
      isTransit: body.isTransit,
    });
    res.json({ accept: true });
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
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ────────────────────────────────────────────────────────────────────────────

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
    await sleep(100);
  }
  throw new Error(`Timed out waiting for: ${description} (${timeoutMs}ms)`);
}

async function waitPeerConnected(
  adminPort: number,
  peerId: string,
  timeoutMs = 20_000
): Promise<void> {
  await waitForCondition(
    async () => {
      const res = await fetch(`http://127.0.0.1:${adminPort}/admin/peers`);
      if (!res.ok) return false;
      const body = (await res.json()) as { peers: Array<{ id: string; connected: boolean }> };
      return body.peers.find((p) => p.id === peerId)?.connected === true;
    },
    timeoutMs,
    `${adminPort} → ${peerId} BTP connection`
  );
}

interface IlpSendResponse {
  accepted: boolean;
  code?: string;
  message?: string;
}

async function ilpSend(
  adminPort: number,
  destination: string
): Promise<{ status: number; body: IlpSendResponse }> {
  const res = await fetch(`http://127.0.0.1:${adminPort}/admin/ilp/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destination, amount: '0', data: '' }),
  });
  return { status: res.status, body: (await res.json()) as IlpSendResponse };
}

// ────────────────────────────────────────────────────────────────────────────
// Network topology builder
// ────────────────────────────────────────────────────────────────────────────

function randomPortBase(): number {
  return 30000 + Math.floor(Math.random() * 15000);
}

interface PeerCtx {
  node: ConnectorNode;
  app: TestApp;
  adminPort: number;
}

interface StandaloneChain {
  peers: PeerCtx[];
  stop(): Promise<void>;
}

async function buildChain(): Promise<StandaloneChain> {
  const base = randomPortBase();
  // 3 peers × 4 ports each (btp, admin, health, app) = 12 consecutive ports.
  const btp = (i: number) => base + i;
  const admin = (i: number) => base + 3 + i;
  const health = (i: number) => base + 6 + i;
  const appPort = (i: number) => base + 9 + i;

  const appInstances: TestApp[] = [];
  for (let i = 0; i < 3; i++) {
    appInstances.push(await startApp(appPort(i)));
  }

  const buildConfig = (i: number): ConnectorConfig => {
    const nodeId = `peer${i + 1}`;
    const peers = [];
    const routes: Array<{ prefix: string; nextHop: string }> = [
      { prefix: `test.${nodeId}`, nextHop: nodeId },
    ];

    if (i > 0) {
      const leftId = `peer${i}`;
      peers.push({ id: leftId, url: `ws://127.0.0.1:${btp(i - 1)}`, authToken: '' });
      // routes to anything further left: route to left peer
      for (let j = 0; j < i; j++) {
        routes.push({ prefix: `test.peer${j + 1}`, nextHop: leftId });
      }
    }
    if (i < 2) {
      const rightId = `peer${i + 2}`;
      peers.push({ id: rightId, url: `ws://127.0.0.1:${btp(i + 1)}`, authToken: '' });
      for (let j = i + 1; j < 3; j++) {
        routes.push({ prefix: `test.peer${j + 1}`, nextHop: rightId });
      }
    }

    return {
      nodeId,
      btpServerPort: btp(i),
      healthCheckPort: health(i),
      logLevel: 'warn',
      environment: 'development',
      deploymentMode: 'standalone',
      adminApi: { enabled: true, port: admin(i), host: '127.0.0.1' },
      localDelivery: {
        enabled: true,
        handlerUrl: `http://127.0.0.1:${appPort(i)}`,
      },
      peers,
      routes,
    };
  };

  // Start from the tail end backward so each peer's target is already listening
  // by the time the next one boots (R-001 mitigation from multi-hop-helpers).
  const nodes: ConnectorNode[] = new Array(3);
  for (let i = 2; i >= 0; i--) {
    const cfg = buildConfig(i);
    const node = new ConnectorNode(cfg, createLogger(cfg.nodeId, 'warn'));
    await node.start();
    nodes[i] = node;
    if (i > 0) await sleep(300);
  }

  // Wait for BTP links on both sides of peer2 (the middle hop).
  await waitPeerConnected(admin(1), 'peer1');
  await waitPeerConnected(admin(1), 'peer3');

  const peers: PeerCtx[] = nodes.map((node, i) => ({
    node,
    app: appInstances[i]!,
    adminPort: admin(i),
  }));

  return {
    peers,
    async stop() {
      for (const peer of peers) {
        await peer.node.stop().catch(() => undefined);
      }
      for (const app of appInstances) {
        await app.stop().catch(() => undefined);
      }
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('Standalone Mode Multi-Hop E2E (3-peer linear chain)', () => {
  let chain: StandaloneChain;

  beforeAll(async () => {
    chain = await buildChain();
  });

  afterAll(async () => {
    await chain?.stop();
  });

  it('all three peers report standalone mode', () => {
    for (const peer of chain.peers) {
      expect(peer.node.getDeploymentMode()).toBe('standalone');
    }
  });

  it('peer1 → peer3: packet traverses 2 BTP hops, lands at peer3 app (not peer1/peer2)', async () => {
    const peer1 = chain.peers[0]!;
    const peer2 = chain.peers[1]!;
    const peer3 = chain.peers[2]!;

    const before3 = peer3.app.received.length;

    const { status, body } = await ilpSend(peer1.adminPort, 'test.peer3.receiver');
    expect(status).toBe(200);
    expect(body.accepted).toBe(true);

    expect(peer3.app.received.length).toBe(before3 + 1);
    expect(peer3.app.received[before3]!.destination).toBe('test.peer3.receiver');

    // Intermediate peers should NOT get final delivery — their app only sees
    // the packet if `localDelivery.perHopNotification` is enabled, which it
    // is not in our config.
    expect(peer1.app.received).toEqual([]);
    expect(peer2.app.received).toEqual([]);
  });

  it('peer3 → peer1: reverse direction routes the other way', async () => {
    const peer1 = chain.peers[0]!;
    const peer3 = chain.peers[2]!;

    const before1 = peer1.app.received.length;
    const { status, body } = await ilpSend(peer3.adminPort, 'test.peer1.receiver');
    expect(status).toBe(200);
    expect(body.accepted).toBe(true);

    expect(peer1.app.received.length).toBe(before1 + 1);
    expect(peer1.app.received[before1]!.destination).toBe('test.peer1.receiver');
  });

  it('peer1 → peer2: single-hop delivery to middle peer also works', async () => {
    const peer1 = chain.peers[0]!;
    const peer2 = chain.peers[1]!;

    const before2 = peer2.app.received.length;
    const { status, body } = await ilpSend(peer1.adminPort, 'test.peer2.receiver');
    expect(status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(peer2.app.received.length).toBe(before2 + 1);
  });

  it('unknown destination prefix gets rejected (no matching route)', async () => {
    const peer1 = chain.peers[0]!;
    const { status, body } = await ilpSend(peer1.adminPort, 'test.nonexistent.receiver');
    expect(status).toBe(200);
    expect(body.accepted).toBe(false);
    // F02 UNREACHABLE is the canonical "no route" reject code
    expect(body.code?.startsWith('F')).toBe(true);
  });
});
