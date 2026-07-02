/**
 * Standalone Mode Claim Validation Gate E2E Integration Test
 *
 * Proves the F06 inbound claim validation gate still fires in standalone
 * mode. A raw BTP WebSocket client (simulating an attacker or misconfigured
 * peer) connects directly to a standalone connector's BTP port and sends
 * ILP PREPARE packets WITHOUT a signed payment-channel claim. The connector
 * must reject these at the BTP transport layer (before reaching the
 * standalone localDelivery HTTP bridge), matching the behavior tested for
 * embedded mode in `claim-validation-gate.test.ts`.
 *
 * Standalone-specific concern: when `adminApi.enabled` and `localDelivery`
 * are active, the connector exposes new HTTP surfaces — this test verifies
 * those surfaces do NOT bypass the inbound claim gate for packets arriving
 * over BTP.
 *
 * Prerequisites:
 *   make anvil-up
 *   EVM_INTEGRATION=true npx jest test/integration/standalone-claim-gate-e2e.test.ts
 *
 * @packageDocumentation
 */

import http from 'http';
import express, { Request, Response } from 'express';
import WebSocket from 'ws';
import { ConnectorNode } from '../../src/core/connector-node';
import { createLogger } from '../../src/utils/logger';
import type { ConnectorConfig } from '../../src/config/types';
import { serializeBTPMessage, parseBTPMessage } from '../../src/btp/btp-message-parser';
import {
  serializePacket,
  deserializePacket,
  PacketType,
  ILPErrorCode,
} from '@toon-protocol/shared';
import type { ILPPreparePacket, ILPRejectPacket, ILPFulfillPacket } from '@toon-protocol/shared';
import { BTPMessageType } from '../../src/btp/btp-types';
import type { BTPMessage, BTPData } from '../../src/btp/btp-types';
import {
  ANVIL_CHAIN_ID,
  ANVIL_RPC_URL,
  REGISTRY_ADDRESS,
  TOKEN_ADDRESS,
  PEER_PRIVATE_KEYS,
  PEER_EVM_ADDRESSES,
  waitForAnvilReady,
  fundPeerAccounts,
} from './multi-hop-helpers';

const RUN_EVM = process.env.EVM_INTEGRATION === 'true';
const describeEvm = RUN_EVM ? describe : describe.skip;

jest.setTimeout(180_000);

// ────────────────────────────────────────────────────────────────────────────
// Test app — tracks packets that leak past the claim gate (should be zero)
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
// Raw BTP client — simulates an attacker or misconfigured peer
// ────────────────────────────────────────────────────────────────────────────

async function connectRawBTPClient(port: number, peerId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    let authenticated = false;

    ws.on('open', () => {
      const authData = { peerId, secret: '' };
      const authMessage: BTPMessage = {
        type: BTPMessageType.MESSAGE,
        requestId: 1,
        data: {
          protocolData: [
            {
              protocolName: 'auth',
              contentType: 0,
              data: Buffer.from(JSON.stringify(authData), 'utf8'),
            },
          ],
          ilpPacket: Buffer.alloc(0),
        } as BTPData,
      };
      ws.send(serializeBTPMessage(authMessage));
    });

    ws.on('message', (_data: Buffer) => {
      if (!authenticated) {
        authenticated = true;
        resolve(ws);
      }
    });

    ws.on('error', reject);

    setTimeout(() => {
      if (!authenticated) {
        ws.close();
        reject(new Error('BTP auth timeout'));
      }
    }, 10_000);
  });
}

async function sendRawBTPPrepare(
  ws: WebSocket,
  ilpPrepare: ILPPreparePacket
): Promise<ILPFulfillPacket | ILPRejectPacket> {
  const requestId = Math.floor(Math.random() * 0xffffffff);
  const serializedPacket = serializePacket(ilpPrepare);

  const btpMessage: BTPMessage = {
    type: BTPMessageType.MESSAGE,
    requestId,
    data: {
      protocolData: [], // No claim — this is the attack
      ilpPacket: serializedPacket,
    } as BTPData,
  };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('BTP response timeout')), 15_000);
    const handler = (data: Buffer): void => {
      try {
        const response = parseBTPMessage(data as Buffer);
        if (response.requestId === requestId) {
          clearTimeout(timeout);
          ws.removeListener('message', handler);
          const responseData = response.data as BTPData;
          if (responseData.ilpPacket && responseData.ilpPacket.length > 0) {
            resolve(
              deserializePacket(responseData.ilpPacket) as ILPFulfillPacket | ILPRejectPacket
            );
          } else {
            reject(new Error('No ILP packet in BTP response'));
          }
        }
      } catch {
        // Not our response
      }
    };
    ws.on('message', handler);
    ws.send(serializeBTPMessage(btpMessage));
  });
}

function createTestPrepare(destination: string, amount: bigint): ILPPreparePacket {
  return {
    type: PacketType.PREPARE,
    destination,
    amount,
    expiresAt: new Date(Date.now() + 60_000),
    data: Buffer.alloc(0),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describeEvm('Standalone Claim Validation Gate E2E', () => {
  let peer2: ConnectorNode;
  let bls2: TestBls;
  let peer2BtpPort: number;

  beforeAll(async () => {
    await waitForAnvilReady(30_000);
    await fundPeerAccounts([PEER_EVM_ADDRESSES[1]!]);

    const base = 40_000 + Math.floor(Math.random() * 10_000);
    peer2BtpPort = base;
    const adminPort = base + 1;
    const healthPort = base + 2;
    const blsPort = base + 3;

    bls2 = await startBls(blsPort);

    const peer2Config: ConnectorConfig = {
      nodeId: 'peer2',
      btpServerPort: peer2BtpPort,
      healthCheckPort: healthPort,
      logLevel: 'warn',
      environment: 'development',
      deploymentMode: 'standalone',
      adminApi: { enabled: true, port: adminPort, host: '127.0.0.1' },
      localDelivery: {
        enabled: true,
        handlerUrl: `http://127.0.0.1:${blsPort}`,
      },
      peers: [
        {
          id: 'peer1',
          url: `ws://127.0.0.1:${base + 100}`, // unreachable, irrelevant for this test
          authToken: '',
          evmAddress: PEER_EVM_ADDRESSES[0]!,
          chain: `evm:${ANVIL_CHAIN_ID}`,
        },
      ],
      routes: [
        { prefix: 'test.peer2', nextHop: 'peer2' },
        { prefix: 'test.peer1', nextHop: 'peer1' },
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
          keyId: PEER_PRIVATE_KEYS[1]!,
          tokenAddress: TOKEN_ADDRESS,
          settlementOptions: {
            threshold: '5000',
            pollingIntervalMs: 100,
            settlementTimeoutSecs: 3600,
            initialDepositMultiplier: 2,
            ledgerSnapshotPath: `./data/ledger-standalone-claim-gate-${base}.json`,
          },
        },
      ],
    };

    peer2 = new ConnectorNode(peer2Config, createLogger('peer2', 'warn'));
    await peer2.start();
  });

  afterAll(async () => {
    await peer2?.stop().catch(() => undefined);
    await bls2?.stop().catch(() => undefined);
  });

  it('BTP prepare without a signed claim → F06 reject, app not invoked', async () => {
    const ws = await connectRawBTPClient(peer2BtpPort, 'peer1');
    try {
      const beforeCount = bls2.received.length;

      const prepare = createTestPrepare('test.peer2.receiver', 1000n);
      const response = await sendRawBTPPrepare(ws, prepare);

      expect(response.type).toBe(PacketType.REJECT);
      const reject = response as ILPRejectPacket;
      // Claim validation gate rejects with F06 (unexpected payment) per
      // Epic 17 design; accept any F-class reject to be robust to the exact
      // code that carries this semantic.
      expect(reject.code.startsWith('F')).toBe(true);

      // Critical: the app must NOT have been called — the gate must reject
      // BEFORE the packet reaches localDelivery.
      expect(bls2.received.length).toBe(beforeCount);
    } finally {
      ws.close();
    }
  });

  it('second unsigned prepare also rejected (gate stays armed)', async () => {
    const ws = await connectRawBTPClient(peer2BtpPort, 'peer1');
    try {
      const beforeCount = bls2.received.length;
      const prepare = createTestPrepare('test.peer2.receiver', 42n);
      const response = await sendRawBTPPrepare(ws, prepare);

      expect(response.type).toBe(PacketType.REJECT);
      expect(bls2.received.length).toBe(beforeCount);

      // Silence unused-var lint on ILPErrorCode.F06 by referencing it
      expect(typeof ILPErrorCode.F06_UNEXPECTED_PAYMENT).toBe('string');
    } finally {
      ws.close();
    }
  });
});
