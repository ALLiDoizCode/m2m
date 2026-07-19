/**
 * Integration tests for ILP-over-HTTP + HTTP→BTP upgrade on the shared listener.
 *
 * The BTPServer owns one HTTP port that serves both transports into the same
 * packet handler. Proves:
 *  - ILP-over-HTTP one-shot (`POST /ilp`)
 *  - BTP backward compatibility (plain WebSocket upgrade + in-band auth frame)
 *  - HTTP→BTP upgrade with pre-auth continuity (headers, no in-band auth frame)
 */

import http from 'http';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { BTPServer } from '../btp/btp-server';
import { IlpHttpAdapter } from './ilp-http-adapter';
import { Logger } from '../utils/logger';
import { PacketHandler } from '../core/packet-handler';
import { BTPMessage, BTPMessageType } from '../btp/btp-types';
import { parseBTPMessage, serializeBTPMessage } from '../btp/btp-message-parser';
import {
  ILPPreparePacket,
  ILPFulfillPacket,
  PacketType,
  serializePacket,
  deserializePacket,
} from '@toon-protocol/shared';

const createMockLogger = (): jest.Mocked<Logger> =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    trace: jest.fn(),
    silent: jest.fn(),
    level: 'info',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    child: jest.fn(function (this: any) {
      return this;
    }),
  }) as unknown as jest.Mocked<Logger>;

const prepare = (): ILPPreparePacket => ({
  type: PacketType.PREPARE,
  amount: BigInt(1000),
  destination: 'g.connector.relay',
  expiresAt: new Date(Date.now() + 10000),
  data: Buffer.from('hi'),
});

const fulfill: ILPFulfillPacket = { type: PacketType.FULFILL, data: Buffer.alloc(0) };

const createMockPacketHandler = (): jest.Mocked<PacketHandler> =>
  ({
    handlePreparePacket: jest.fn().mockResolvedValue(fulfill),
  }) as unknown as jest.Mocked<PacketHandler>;

function postIlp(
  port: number,
  body: Buffer,
  headers: Record<string, string> = {}
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

function btpRoundTrip(
  port: number,
  opts: { headers?: Record<string, string>; sendAuthFrame?: boolean } = {}
): Promise<ILPFulfillPacket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}`,
      opts.headers ? { headers: opts.headers } : undefined
    );
    let authed = !opts.sendAuthFrame;

    const sendPrepare = (): void => {
      const msg: BTPMessage = {
        type: BTPMessageType.MESSAGE,
        requestId: 42,
        data: { protocolData: [], ilpPacket: serializePacket(prepare()) },
      };
      ws.send(serializeBTPMessage(msg));
    };

    ws.on('open', () => {
      if (opts.sendAuthFrame) {
        const auth: BTPMessage = {
          type: BTPMessageType.MESSAGE,
          requestId: 1,
          data: {
            protocolData: [
              {
                protocolName: 'auth',
                contentType: 0,
                data: Buffer.from(JSON.stringify({ peerId: 'p1', secret: '' }), 'utf8'),
              },
            ],
          },
        };
        ws.send(serializeBTPMessage(auth));
      } else {
        sendPrepare();
      }
    });

    ws.on('message', (data: Buffer) => {
      const msg = parseBTPMessage(data);
      if (!authed) {
        authed = true;
        sendPrepare();
        return;
      }
      if (msg.type === BTPMessageType.RESPONSE && 'ilpPacket' in msg.data && msg.data.ilpPacket) {
        ws.close();
        resolve(deserializePacket(msg.data.ilpPacket) as ILPFulfillPacket);
      } else if (msg.type === BTPMessageType.ERROR) {
        ws.close();
        reject(new Error(`BTP ERROR: ${(msg.data as { code: string }).code}`));
      }
    });
    ws.on('error', reject);
  });
}

describe('ILP-over-HTTP + BTP upgrade (shared listener)', () => {
  let btpServer: BTPServer;
  let packetHandler: jest.Mocked<PacketHandler>;
  let port: number;

  beforeEach(async () => {
    const logger = createMockLogger();
    packetHandler = createMockPacketHandler();
    btpServer = new BTPServer(logger, packetHandler);
    const adapter = new IlpHttpAdapter({
      logger,
      nodeId: 'g.connector',
      handlePrepare: (p, id, pd) => packetHandler.handlePreparePacket(p, id, pd),
    });
    btpServer.setIlpHttpHandler((req, res) => adapter.handle(req, res));
    await btpServer.start(0);
    port = (btpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await btpServer.stop();
  });

  it('serves a one-shot ILP-over-HTTP write (POST /ilp) → FULFILL', async () => {
    const { status, body } = await postIlp(port, serializePacket(prepare()));
    expect(status).toBe(200);
    expect(deserializePacket(body).type).toBe(PacketType.FULFILL);
    expect(packetHandler.handlePreparePacket).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for non-/ilp requests', async () => {
    const status = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/nope' }, (r) => resolve(r.statusCode ?? 0));
    });
    expect(status).toBe(404);
  });

  it('remains BTP backward-compatible: plain WS upgrade + in-band auth frame → FULFILL', async () => {
    const result = await btpRoundTrip(port, { sendAuthFrame: true });
    expect(result.type).toBe(PacketType.FULFILL);
  });

  it('supports HTTP→BTP upgrade with pre-auth continuity (no in-band auth frame)', async () => {
    // ILP-Peer-Id with no Authorization = no-auth peer (permissionless default).
    const result = await btpRoundTrip(port, {
      headers: { 'ILP-Peer-Id': 'p1' },
      sendAuthFrame: false,
    });
    expect(result.type).toBe(PacketType.FULFILL);
    expect(packetHandler.handlePreparePacket).toHaveBeenCalledWith(
      expect.objectContaining({ destination: 'g.connector.relay' }),
      'p1'
    );
  });
});
