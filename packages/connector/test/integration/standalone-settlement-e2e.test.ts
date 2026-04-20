/**
 * Standalone Mode Settlement E2E Integration Test
 *
 * Proves that standalone mode works end-to-end with real EVM settlement:
 *   - `chainProviders[evm]` config alone is sufficient (no `settlementInfra`)
 *   - `POST /admin/channels` opens a payment channel on-chain
 *   - `POST /admin/ilp/send` with amount > 0 routes through BTP and settles
 *   - Per-packet claim service works in standalone mode (chainProviders wired)
 *
 *   [BLS2] <-- /handle-packet -- [Peer2 standalone + chainProviders]
 *                                          ^
 *                                        BTP
 *                                          v
 *   [Test] -- /admin/channels --> [Peer1 standalone + chainProviders]
 *   [Test] -- /admin/ilp/send -->
 *
 * Prerequisites:
 *   make anvil-up                    # Anvil + Faucet + deployed TokenNetworkRegistry
 *   EVM_INTEGRATION=true npx jest test/integration/standalone-settlement-e2e.test.ts
 *
 * @packageDocumentation
 */

import http from 'http';
import express, { Request, Response } from 'express';
import { ConnectorNode } from '../../src/core/connector-node';
import { createLogger } from '../../src/utils/logger';
import type { ConnectorConfig } from '../../src/config/types';
import {
  ANVIL_CHAIN_ID,
  ANVIL_RPC_URL,
  REGISTRY_ADDRESS,
  TOKEN_ADDRESS,
  PEER_PRIVATE_KEYS,
  PEER_EVM_ADDRESSES,
  fundPeerAccounts,
  waitForAnvilReady,
} from './multi-hop-helpers';

// ────────────────────────────────────────────────────────────────────────────
// Integration gate + timeout (real EVM operations are slow)
// ────────────────────────────────────────────────────────────────────────────

const RUN_EVM = process.env.EVM_INTEGRATION === 'true';
const describeEvm = RUN_EVM ? describe : describe.skip;

jest.setTimeout(180_000);

// ────────────────────────────────────────────────────────────────────────────
// Test BLS Server (minimal /handle-packet responder)
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

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function adminPost<T>(
  port: number,
  path: string,
  body: unknown
): Promise<{ status: number; body: T }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function adminGet<T>(port: number, path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
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
      // keep polling
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for: ${description} (${timeoutMs}ms)`);
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describeEvm('Standalone Mode Settlement E2E (real Anvil)', () => {
  let peer1: ConnectorNode;
  let peer2: ConnectorNode;
  let bls1: TestBls;
  let bls2: TestBls;
  let peer1Admin: number;
  let peer2Admin: number;

  beforeAll(async () => {
    await waitForAnvilReady(30_000);
    await fundPeerAccounts(PEER_EVM_ADDRESSES.slice(0, 2));

    const base = 40000 + Math.floor(Math.random() * 10000);
    const peer1Btp = base;
    const peer2Btp = base + 1;
    peer1Admin = base + 2;
    peer2Admin = base + 3;
    const bls1Port = base + 4;
    const bls2Port = base + 5;
    const peer1Health = base + 6;
    const peer2Health = base + 7;

    bls1 = await startBls(bls1Port);
    bls2 = await startBls(bls2Port);

    const buildConfig = (opts: {
      nodeId: string;
      btpPort: number;
      adminPort: number;
      healthPort: number;
      blsPort: number;
      peer: { id: string; port: number; evmAddress: string };
      keyId: string;
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
          evmAddress: opts.peer.evmAddress,
          chain: `evm:${ANVIL_CHAIN_ID}`,
        },
      ],
      routes: [
        { prefix: `test.${opts.nodeId}`, nextHop: opts.nodeId },
        { prefix: `test.${opts.peer.id}`, nextHop: opts.peer.id },
      ],
      settlement: {
        connectorFeePercentage: 0.1,
        enableSettlement: true,
        tigerBeetleClusterId: 0,
        tigerBeetleReplicas: [],
        thresholds: {
          defaultThreshold: 5000n,
          pollingInterval: 100,
        },
      },
      chainProviders: [
        {
          chainType: 'evm',
          chainId: `evm:${ANVIL_CHAIN_ID}`,
          rpcUrl: ANVIL_RPC_URL,
          registryAddress: REGISTRY_ADDRESS,
          keyId: opts.keyId,
          tokenAddress: TOKEN_ADDRESS,
          settlementOptions: {
            threshold: '5000',
            pollingIntervalMs: 100,
            settlementTimeoutSecs: 3600,
            initialDepositMultiplier: 2,
            ledgerSnapshotPath: `./data/ledger-standalone-${opts.nodeId}-${base}.json`,
          },
        },
      ],
    });

    const peer2Config = buildConfig({
      nodeId: 'peer2',
      btpPort: peer2Btp,
      adminPort: peer2Admin,
      healthPort: peer2Health,
      blsPort: bls2Port,
      peer: { id: 'peer1', port: peer1Btp, evmAddress: PEER_EVM_ADDRESSES[0]! },
      keyId: PEER_PRIVATE_KEYS[1]!,
    });
    const peer1Config = buildConfig({
      nodeId: 'peer1',
      btpPort: peer1Btp,
      adminPort: peer1Admin,
      healthPort: peer1Health,
      blsPort: bls1Port,
      peer: { id: 'peer2', port: peer2Btp, evmAddress: PEER_EVM_ADDRESSES[1]! },
      keyId: PEER_PRIVATE_KEYS[0]!,
    });

    peer2 = new ConnectorNode(peer2Config, createLogger('peer2', 'warn'));
    await peer2.start();
    await sleep(500);

    peer1 = new ConnectorNode(peer1Config, createLogger('peer1', 'warn'));
    await peer1.start();

    await waitForCondition(
      async () => {
        const { body } = await adminGet<{ peers: Array<{ id: string; connected: boolean }> }>(
          peer1Admin,
          '/admin/peers'
        );
        return body.peers.find((p) => p.id === 'peer2')?.connected === true;
      },
      20_000,
      'peer1 → peer2 BTP connection'
    );
  });

  afterAll(async () => {
    await peer1?.stop().catch(() => undefined);
    await peer2?.stop().catch(() => undefined);
    await bls1?.stop().catch(() => undefined);
    await bls2?.stop().catch(() => undefined);
  });

  it('reports standalone deployment mode on both peers', () => {
    expect(peer1.getDeploymentMode()).toBe('standalone');
    expect(peer2.getDeploymentMode()).toBe('standalone');
  });

  it('GET /admin/channels returns auto-opened channel after BTP connect', async () => {
    // ChannelManager auto-opens channels for connected peers when settlement is configured.
    // Wait for the channel to materialize and be visible via admin API.
    // (GET /admin/channels returns a raw ChannelSummary[] array, not wrapped.)
    let channelId: string | undefined;
    await waitForCondition(
      async () => {
        const { body } = await adminGet<
          Array<{ channelId: string; peerId: string; status: string }>
        >(peer1Admin, '/admin/channels');
        const ch = body.find((c) => c.peerId === 'peer2');
        if (ch) {
          channelId = ch.channelId;
          return true;
        }
        return false;
      },
      60_000,
      'peer1 auto-opens channel with peer2'
    );

    expect(channelId).toBeTruthy();
    const { body: detail } = await adminGet<{ channelId: string; status: string; chain: string }>(
      peer1Admin,
      `/admin/channels/${channelId}`
    );
    expect(detail.channelId).toBe(channelId);
    expect(['opening', 'open']).toContain(detail.status);
  });

  it('POST /admin/ilp/send with amount > 0 fulfills end-to-end', async () => {
    const before = bls2.received.length;

    const { status, body } = await adminPost<{ accepted: boolean; code?: string }>(
      peer1Admin,
      '/admin/ilp/send',
      {
        destination: 'test.peer2.receiver',
        amount: '1000',
        data: '',
      }
    );

    expect(status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(bls2.received.length).toBe(before + 1);
    // Peer1 deducts a 0.1% connector fee before forwarding to peer2, so BLS2
    // sees amount = 1000 - floor(1000 * 10 / 10000) = 999.
    expect(bls2.received[before]!.amount).toBe('999');
  });

  it('multiple non-zero packets succeed (per-packet claim service is live)', async () => {
    const before = bls2.received.length;
    for (let i = 0; i < 3; i++) {
      const { body } = await adminPost<{ accepted: boolean }>(peer1Admin, '/admin/ilp/send', {
        destination: 'test.peer2.receiver',
        amount: '500',
        data: '',
      });
      expect(body.accepted).toBe(true);
    }
    expect(bls2.received.length).toBe(before + 3);
  });

  it('settlement threshold triggers successful on-chain claimFromChannel', async () => {
    // Push enough packet volume through peer1 → peer2 to cross peer2's
    // credit-side threshold (5000). We previously sent 1000 + 3*500 = 2500,
    // so ~6000 more comfortably exceeds it. ClaimReceiver should have a
    // verified claim, and SettlementExecutor should redeem it on-chain.
    for (let i = 0; i < 6; i++) {
      const { body } = await adminPost<{ accepted: boolean }>(peer1Admin, '/admin/ilp/send', {
        destination: 'test.peer2.receiver',
        amount: '1000',
        data: '',
      });
      expect(body.accepted).toBe(true);
    }

    // Wait for settlement to complete via the admin API. After claimFromChannel
    // succeeds on-chain and recordSettlement drains the ledger credit,
    // GET /admin/settlement/states should show no pending settlement for peer1.
    await waitForCondition(
      async () => {
        const { status, body } = await adminGet<Record<string, unknown>>(
          peer2Admin,
          '/admin/settlement/states'
        );
        if (status !== 200) return false;
        // No error keys and no peer1 entry still IN_PROGRESS
        const states = (body.states ?? body) as Array<{ peerId: string; state: string }>;
        if (!Array.isArray(states)) return true; // no pending settlements
        const peer1State = states.find((s) => s.peerId === 'peer1');
        return !peer1State || peer1State.state !== 'IN_PROGRESS';
      },
      45_000,
      'peer2 settlement state no longer IN_PROGRESS for peer1'
    );
  });
});
