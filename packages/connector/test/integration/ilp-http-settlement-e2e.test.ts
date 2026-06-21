/**
 * ILP-over-HTTP Settlement E2E Integration Test
 *
 * Proves the ILP-over-HTTP edge (RFC-0035) credits on-chain settlement
 * identically to BTP: a one-shot `POST /ilp` carrying a signed payment-channel
 * claim is recorded by the receiver's ClaimReceiver and, once the cumulative
 * amount crosses the threshold, redeemed on-chain via claimFromChannel.
 *
 *   [BLS2] <-- /handle-packet -- [peer2 standalone + chainProviders]
 *                                          ^
 *                            POST /ilp (PREPARE + claim header)
 *                                          |
 *   [Test] -- signs claim via peer1's PerPacketClaimService for the
 *             peer1↔peer2 channel, then posts it to peer2's /ilp
 *
 * peer1 exists only to auto-open + fund the on-chain channel and to provide the
 * signing context; the writes themselves are delivered to peer2 over HTTP, not
 * BTP — exercising the new recordClaim → ClaimReceiver wiring end-to-end.
 *
 * Prerequisites:
 *   docker compose --profile evm up -d   # Anvil + deployed TokenNetworkRegistry
 *   EVM_INTEGRATION=true npx jest test/integration/ilp-http-settlement-e2e.test.ts
 *
 * @packageDocumentation
 */

import http from 'http';
import express, { Request, Response } from 'express';
import Database from 'libsql';
import { ConnectorNode } from '../../src/core/connector-node';
import { createLogger } from '../../src/utils/logger';
import type { ConnectorConfig } from '../../src/config/types';
import { PerPacketClaimService } from '../../src/settlement/per-packet-claim-service';
import {
  SENT_CLAIMS_TABLE_SCHEMA,
  SENT_CLAIMS_INDEXES,
} from '../../src/settlement/claim-sender-db-schema';
import {
  serializePacket,
  deserializePacket,
  PacketType,
  type ILPPreparePacket,
} from '@toon-protocol/shared';
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

const RUN_EVM = process.env.EVM_INTEGRATION === 'true';
const describeEvm = RUN_EVM ? describe : describe.skip;

jest.setTimeout(180_000);

// ── Minimal BLS that records delivered packets ──────────────────────────────
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
    stop: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function adminGet<T>(port: number, path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: (await response.json()) as T };
}

/** POST an OER ILP packet to `/ilp`, attaching the claim header. */
function postIlp(
  port: number,
  body: Buffer,
  headers: Record<string, string>
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/ilp',
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': body.length,
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
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
    await sleep(200);
  }
  throw new Error(`Timed out waiting for: ${description} (${timeoutMs}ms)`);
}

const buildPrepare = (amount: bigint): ILPPreparePacket => ({
  type: PacketType.PREPARE,
  amount,
  destination: 'test.peer2.receiver',
  expiresAt: new Date(Date.now() + 30_000),
  data: Buffer.alloc(0),
});

// ────────────────────────────────────────────────────────────────────────────

describeEvm('ILP-over-HTTP Settlement E2E (real Anvil)', () => {
  let peer1: ConnectorNode;
  let peer2: ConnectorNode;
  let bls1: TestBls;
  let bls2: TestBls;
  let peer1Admin: number;
  let peer2Admin: number;
  let peer2Btp: number;
  let claimSvc: PerPacketClaimService;
  let settlementTokenId: string;

  beforeAll(async () => {
    await waitForAnvilReady(30_000);
    await fundPeerAccounts(PEER_EVM_ADDRESSES.slice(0, 2));

    const base = 50000 + Math.floor(Math.random() * 9000);
    const peer1Btp = base;
    peer2Btp = base + 1;
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
      localDelivery: { enabled: true, handlerUrl: `http://127.0.0.1:${opts.blsPort}` },
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
        thresholds: { defaultThreshold: 5000n, pollingInterval: 100 },
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
            ledgerSnapshotPath: `./data/ledger-http-${opts.nodeId}-${base}.json`,
          },
        },
      ],
    });

    peer2 = new ConnectorNode(
      buildConfig({
        nodeId: 'peer2',
        btpPort: peer2Btp,
        adminPort: peer2Admin,
        healthPort: peer2Health,
        blsPort: bls2Port,
        peer: { id: 'peer1', port: peer1Btp, evmAddress: PEER_EVM_ADDRESSES[0]! },
        keyId: PEER_PRIVATE_KEYS[1]!,
      }),
      createLogger('peer2', 'warn')
    );
    await peer2.start();
    await sleep(500);

    peer1 = new ConnectorNode(
      buildConfig({
        nodeId: 'peer1',
        btpPort: peer1Btp,
        adminPort: peer1Admin,
        healthPort: peer1Health,
        blsPort: bls1Port,
        peer: { id: 'peer2', port: peer2Btp, evmAddress: PEER_EVM_ADDRESSES[1]! },
        keyId: PEER_PRIVATE_KEYS[0]!,
      }),
      createLogger('peer1', 'warn')
    );
    await peer1.start();

    // Wait for peer1 to auto-open the on-chain channel toward peer2.
    await waitForCondition(
      async () => {
        const { body } = await adminGet<Array<{ peerId: string; status: string }>>(
          peer1Admin,
          '/admin/channels'
        );
        return body.some((c) => c.peerId === 'peer2' && ['opening', 'open'].includes(c.status));
      },
      60_000,
      'peer1 auto-opens channel with peer2'
    );

    // Discover the tokenId the channel is indexed under (the claim signer must
    // use the same key the channel manager registered the channel with).
    await waitForCondition(
      async () => peer1.channelManager!.getChannelsForPeer('peer2').length > 0,
      30_000,
      'peer1 channel manager has a channel for peer2'
    );
    settlementTokenId = peer1.channelManager!.getChannelsForPeer('peer2')[0]!.tokenId;

    // Build a test-side claim signer over peer1's real channel context. This
    // produces claims byte-identical to peer1's per-packet claim service — the
    // same ones it would attach to a BTP write — so we can deliver them to
    // peer2 over HTTP instead.
    // libsql is a better-sqlite3-compatible drop-in at runtime; the connector
    // itself feeds a libsql instance where a better-sqlite3 Database is typed.
    const claimDb = new Database(':memory:') as unknown as import('better-sqlite3').Database;
    claimDb.exec(SENT_CLAIMS_TABLE_SCHEMA);
    for (const idx of SENT_CLAIMS_INDEXES) claimDb.exec(idx);
    claimSvc = new PerPacketClaimService(
      peer1.chainRegistry!,
      peer1.channelManager!,
      claimDb,
      createLogger('http-claim', 'warn'),
      'peer1',
      new Map([['peer2', `evm:${ANVIL_CHAIN_ID}`]])
    );
  });

  afterAll(async () => {
    await peer1?.stop().catch(() => undefined);
    await peer2?.stop().catch(() => undefined);
    await bls1?.stop().catch(() => undefined);
    await bls2?.stop().catch(() => undefined);
  });

  it('POST /ilp with a signed claim fulfills end-to-end and reaches the BLS', async () => {
    const before = bls2.received.length;
    const amount = 1000n;
    const claim = await claimSvc.generateClaimForPacket('peer2', settlementTokenId, amount);
    expect(claim).not.toBeNull();

    const { status, body } = await postIlp(peer2Btp, serializePacket(buildPrepare(amount)), {
      'ilp-peer-id': 'peer1',
      'ilp-payment-channel-claim': claim!.protocolData.data.toString('base64'),
    });

    expect(status).toBe(200);
    expect(deserializePacket(body).type).toBe(PacketType.FULFILL);
    expect(bls2.received.length).toBe(before + 1);
    expect(bls2.received[before]!.amount).toBe('1000'); // terminal delivery: no fee
  });

  it('crossing the threshold over HTTP triggers on-chain claimFromChannel', async () => {
    // Cumulative is now 1000 from the first test; push past the 5000 threshold.
    for (let i = 0; i < 6; i++) {
      const amount = 1000n;
      const claim = await claimSvc.generateClaimForPacket('peer2', settlementTokenId, amount);
      const { status } = await postIlp(peer2Btp, serializePacket(buildPrepare(amount)), {
        'ilp-peer-id': 'peer1',
        'ilp-payment-channel-claim': claim!.protocolData.data.toString('base64'),
      });
      expect(status).toBe(200);
    }

    // peer2's ClaimReceiver recorded the HTTP-delivered claims and the
    // SettlementMonitor redeemed on-chain: settlement for peer1 is no longer
    // pending/in-progress (mirrors the BTP settlement assertion).
    await waitForCondition(
      async () => {
        const { status, body } = await adminGet<Record<string, unknown>>(
          peer2Admin,
          '/admin/settlement/states'
        );
        if (status !== 200) return false;
        const states = (body.states ?? body) as Array<{ peerId: string; state: string }>;
        if (!Array.isArray(states)) return true;
        const peer1State = states.find((s) => s.peerId === 'peer1');
        return !peer1State || peer1State.state !== 'IN_PROGRESS';
      },
      45_000,
      'peer2 settlement for peer1 settles after HTTP-delivered claims'
    );

    // Earnings endpoint reflects at least one verified claim received from peer1.
    const { body: earnings } = await adminGet<Record<string, unknown>>(
      peer2Admin,
      '/admin/earnings.json'
    );
    expect(JSON.stringify(earnings)).toContain('peer1');
  });
});
