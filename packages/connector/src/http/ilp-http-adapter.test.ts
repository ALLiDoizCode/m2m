/**
 * Unit tests for the ILP-over-HTTP adapter (RFC-0035).
 *
 * Focus: the adapter is a thin transport binding that reconstructs the exact
 * `(protocolData, ilpPacket, peerId)` triple the BTP path produces, then calls
 * the same claim-gate + packet-handler seams.
 */

import { EventEmitter } from 'events';
import { IlpHttpAdapter } from './ilp-http-adapter';
import { BTP_CLAIM_PROTOCOL } from '../btp/btp-claim-types';
import { Logger } from '../utils/logger';
import {
  ILPPreparePacket,
  ILPFulfillPacket,
  ILPRejectPacket,
  PacketType,
  ILPErrorCode,
  serializePacket,
  deserializePacket,
} from '@toon-protocol/shared';
import type { BTPProtocolData } from '../btp/btp-types';

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

const createPrepare = (): ILPPreparePacket => ({
  type: PacketType.PREPARE,
  amount: BigInt(1000),
  destination: 'g.townhouse.town',
  expiresAt: new Date(Date.now() + 10000),
  data: Buffer.from('hello'),
});

const fulfill: ILPFulfillPacket = { type: PacketType.FULFILL, data: Buffer.alloc(0) };

/** Minimal mock of an inbound http.IncomingMessage that streams `body`. */
class MockReq extends EventEmitter {
  method = 'POST';
  url = '/ilp';
  headers: Record<string, string> = {};
  socket = { remoteAddress: '127.0.0.1', remotePort: 5000 };
  constructor(
    private readonly body: Buffer,
    headers: Record<string, string> = {}
  ) {
    super();
    this.headers = { 'content-type': 'application/octet-stream', ...headers };
  }
  // Push the body on the next tick so handle() has attached its listeners.
  flush(): void {
    process.nextTick(() => {
      this.emit('data', this.body);
      this.emit('end');
    });
  }
  destroy(): void {
    /* no-op for tests */
  }
}

/** Minimal mock of http.ServerResponse capturing the reply. */
class MockRes {
  statusCode = 0;
  headers: Record<string, unknown> = {};
  body: Buffer = Buffer.alloc(0);
  ended = false;
  writeHead(status: number, headers: Record<string, unknown>): this {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }
  end(data?: Buffer | string): void {
    if (data) this.body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.ended = true;
  }
}

const run = async (adapter: IlpHttpAdapter, req: MockReq, res: MockRes): Promise<void> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = adapter.handle(req as any, res as any);
  req.flush();
  await p;
};

const claimJson = JSON.stringify({ blockchain: 'evm', signerAddress: '0xabc', nonce: 1 });

describe('IlpHttpAdapter', () => {
  it('reconstructs BTP-identical protocolData from the claim header and forwards a FULFILL', async () => {
    const validateClaim = jest.fn(async () => null);
    const handlePrepare = jest.fn(async () => fulfill);
    const adapter = new IlpHttpAdapter({
      logger: createMockLogger(),
      nodeId: 'g.townhouse',
      handlePrepare,
      validateClaim,
    });

    const req = new MockReq(serializePacket(createPrepare()), {
      'ilp-payment-channel-claim': Buffer.from(claimJson, 'utf8').toString('base64'),
      'ilp-peer-id': 'connector-b', // no Authorization → no-auth peer
    });
    const res = new MockRes();
    await run(adapter, req, res);

    // Claim gate received exactly one payment-channel-claim entry whose bytes are
    // byte-identical to the JSON BTP would carry (the parity guarantee).
    expect(validateClaim).toHaveBeenCalledTimes(1);
    const [protocolData, ilpPacket, peerId] = validateClaim.mock.calls[0] as unknown as [
      BTPProtocolData[],
      ILPPreparePacket,
      string,
    ];
    const claimEntry = protocolData.find((pd) => pd.protocolName === BTP_CLAIM_PROTOCOL.NAME);
    expect(claimEntry).toBeDefined();
    expect(claimEntry!.contentType).toBe(BTP_CLAIM_PROTOCOL.CONTENT_TYPE);
    expect(claimEntry!.data.toString('utf8')).toBe(claimJson);
    expect(ilpPacket.destination).toBe('g.townhouse.town');
    expect(peerId).toBe('connector-b'); // authenticated via header (no-auth secret)

    // Response is 200 + the serialized FULFILL in the body (RFC-0035).
    expect(res.statusCode).toBe(200);
    expect(deserializePacket(res.body).type).toBe(PacketType.FULFILL);
  });

  it('records the claim for settlement (recordClaim) before validation', async () => {
    const order: string[] = [];
    const recordClaim = jest.fn(async () => {
      order.push('record');
    });
    const validateClaim = jest.fn(async () => {
      order.push('validate');
      return null;
    });
    const adapter = new IlpHttpAdapter({
      logger: createMockLogger(),
      nodeId: 'g.townhouse',
      handlePrepare: jest.fn(async () => fulfill),
      validateClaim,
      recordClaim,
    });

    const req = new MockReq(serializePacket(createPrepare()), {
      'ilp-payment-channel-claim': Buffer.from(claimJson, 'utf8').toString('base64'),
    });
    await run(adapter, req, new MockRes());

    expect(recordClaim).toHaveBeenCalledTimes(1);
    const [peerId, protocolData] = recordClaim.mock.calls[0] as unknown as [
      string,
      BTPProtocolData[],
    ];
    expect(peerId).toBe('http:0xabc');
    expect(protocolData.find((pd) => pd.protocolName === BTP_CLAIM_PROTOCOL.NAME)).toBeDefined();
    // Recorded independent of (and ahead of) packet validation, mirroring BTP.
    expect(order).toEqual(['record', 'validate']);
  });

  it('does not call recordClaim when no claim header is present', async () => {
    const recordClaim = jest.fn(async () => {});
    const adapter = new IlpHttpAdapter({
      logger: createMockLogger(),
      nodeId: 'g.townhouse',
      handlePrepare: jest.fn(async () => fulfill),
      recordClaim,
    });
    await run(adapter, new MockReq(serializePacket(createPrepare())), new MockRes());
    expect(recordClaim).not.toHaveBeenCalled();
  });

  it('returns the claim-gate REJECT in a 200 body (not an HTTP error)', async () => {
    const reject: ILPRejectPacket = {
      type: PacketType.REJECT,
      code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
      triggeredBy: 'g.townhouse',
      message: 'No payment channel claim attached to packet',
      data: Buffer.alloc(0),
    };
    const handlePrepare = jest.fn(async () => fulfill);
    const adapter = new IlpHttpAdapter({
      logger: createMockLogger(),
      nodeId: 'g.townhouse',
      handlePrepare,
      validateClaim: jest.fn(async () => reject),
    });

    const req = new MockReq(serializePacket(createPrepare()));
    const res = new MockRes();
    await run(adapter, req, res);

    expect(handlePrepare).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    const out = deserializePacket(res.body) as ILPRejectPacket;
    expect(out.type).toBe(PacketType.REJECT);
    expect(out.code).toBe(ILPErrorCode.F06_UNEXPECTED_PAYMENT);
  });

  it('derives an ephemeral http: peerId from the claim signer when no ILP-Peer-Id header is sent', async () => {
    const validateClaim = jest.fn(async () => null);
    const adapter = new IlpHttpAdapter({
      logger: createMockLogger(),
      nodeId: 'g.townhouse',
      handlePrepare: jest.fn(async () => fulfill),
      validateClaim,
    });

    const req = new MockReq(serializePacket(createPrepare()), {
      'ilp-payment-channel-claim': Buffer.from(claimJson, 'utf8').toString('base64'),
    });
    await run(adapter, req, new MockRes());

    const peerId = (validateClaim.mock.calls[0] as unknown[])[2] as string;
    expect(peerId).toBe('http:0xabc');
  });

  it('rejects a configured peerId with a bad secret as HTTP 401', async () => {
    const handlePrepare = jest.fn(async () => fulfill);
    const adapter = new IlpHttpAdapter({
      logger: createMockLogger(),
      nodeId: 'g.townhouse',
      handlePrepare,
      validateClaim: jest.fn(async () => null),
    });

    process.env['BTP_PEER_CONNECTOR_B_SECRET'] = 'right-secret';
    const req = new MockReq(serializePacket(createPrepare()), {
      'ilp-peer-id': 'connector-b',
      authorization: 'Bearer wrong-secret',
    });
    const res = new MockRes();
    await run(adapter, req, res);
    delete process.env['BTP_PEER_CONNECTOR_B_SECRET'];

    expect(res.statusCode).toBe(401);
    expect(handlePrepare).not.toHaveBeenCalled();
  });

  it('returns HTTP 400 for a malformed ILP body', async () => {
    const adapter = new IlpHttpAdapter({
      logger: createMockLogger(),
      nodeId: 'g.townhouse',
      handlePrepare: jest.fn(async () => fulfill),
    });
    const req = new MockReq(Buffer.from([0xff, 0x00, 0x01]));
    const res = new MockRes();
    await run(adapter, req, res);
    expect(res.statusCode).toBe(400);
  });
});
