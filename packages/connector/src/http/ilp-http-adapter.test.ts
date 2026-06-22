/**
 * Unit tests for the ILP-over-HTTP adapter (RFC-0035).
 *
 * Focus: the adapter is a thin transport binding that reconstructs the exact
 * `(protocolData, ilpPacket, peerId)` triple the BTP path produces, then calls
 * the same claim-gate + packet-handler seams.
 */

import { EventEmitter } from 'events';
import { IlpHttpAdapter } from './ilp-http-adapter';
import { X402_PAYMENT_REQUIRED_HEADER, X402_PAYMENT_SIGNATURE_HEADER } from './x402-greeting';
import type { RouteTermination } from '../config/types';
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

  // ---------------------------------------------------------------------------
  // x402 v2 "402 Payment Required" greeting on the HTTP edge (issue #217).
  //
  // Wire shape pinned against the authoritative x402 v2 spec:
  //   https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
  //   https://github.com/coinbase/x402/blob/main/specs/transports-v2/http.md
  // v2 PaymentRequired = { x402Version: 2, error?, resource{url,...}, accepts[] }
  // v2 accepts[] entry  = { scheme, network, amount, asset?, payTo, maxTimeoutSeconds, extra? }
  // ---------------------------------------------------------------------------
  describe('x402 v2 greeting (#217)', () => {
    // A real RouteTermination (no mocks) — the source of truth the greeting reads.
    const termination: RouteTermination = {
      upstream: 'http://127.0.0.1:8080',
      price: '1000', // atomic nano-USDC; must be advertised byte-identical
      chains: ['evm', 'solana', 'mina'],
      ilpAddress: 'g.townhouse.town',
      settlementAddresses: {
        evm: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
        solana: '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2',
        mina: 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyVAyZTtbTbCXP',
      },
    };
    const chainIds = { evm: 'evm:8453', solana: 'solana:devnet' } as const;

    const makeAdapter = (
      _unused?: undefined,
      term: RouteTermination | null = termination
    ): { adapter: IlpHttpAdapter; handlePrepare: jest.Mock; validateClaim: jest.Mock } => {
      const handlePrepare = jest.fn(async () => fulfill);
      const validateClaim = jest.fn(async () => null);
      const adapter = new IlpHttpAdapter({
        logger: createMockLogger(),
        nodeId: 'g.townhouse',
        handlePrepare,
        validateClaim,
        resolveTermination: () => term,
        terminationChainIds: chainIds,
      });
      return { adapter, handlePrepare, validateClaim };
    };

    interface GreetingBody {
      x402Version: number;
      error?: string;
      resource: { url: string; description?: string; mimeType?: string };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      accepts: any[];
    }
    const parseGreeting = (res: MockRes): GreetingBody =>
      JSON.parse(res.body.toString('utf8')) as GreetingBody;

    it('AC1: unpaid POST to a terminated route → 402 with v2 accepts body; handlePrepare NOT called', async () => {
      const { adapter, handlePrepare, validateClaim } = makeAdapter();
      const res = new MockRes();
      await run(adapter, new MockReq(serializePacket(createPrepare())), res);

      expect(res.statusCode).toBe(402);
      expect(handlePrepare).not.toHaveBeenCalled();
      expect(validateClaim).not.toHaveBeenCalled();
      const body = parseGreeting(res);
      expect(Array.isArray(body.accepts)).toBe(true);
      expect(body.accepts.length).toBeGreaterThan(0);
      // Also carried in the v2 PAYMENT-REQUIRED response header as base64 JSON.
      const headerB64 = res.headers[X402_PAYMENT_REQUIRED_HEADER] as string;
      expect(headerB64).toBeDefined();
      expect(JSON.parse(Buffer.from(headerB64, 'base64').toString('utf8'))).toEqual(body);
    });

    it('AC5: asserts EXACT v2 field names and x402Version: 2', async () => {
      const { adapter } = makeAdapter();
      const res = new MockRes();
      await run(adapter, new MockReq(serializePacket(createPrepare())), res);
      const body = parseGreeting(res);

      expect(body.x402Version).toBe(2);
      expect(body.resource).toEqual({ url: 'g.townhouse.town' });
      expect(body.error).toBe(`${X402_PAYMENT_SIGNATURE_HEADER} header is required`);
      for (const entry of body.accepts) {
        expect(entry).toHaveProperty('scheme');
        expect(entry).toHaveProperty('network');
        expect(entry).toHaveProperty('amount'); // v2 uses `amount`, NOT `price`/`maxAmountRequired`
        expect(entry).toHaveProperty('payTo');
        expect(entry).toHaveProperty('maxTimeoutSeconds');
        expect(entry).not.toHaveProperty('price');
        expect(entry).not.toHaveProperty('maxAmountRequired');
      }
    });

    it('AC2: vanilla exact (EVM+Solana CAIP-2) + toon-channel entry whose extra deep-equals the RouteTermination', async () => {
      const { adapter } = makeAdapter();
      const res = new MockRes();
      await run(adapter, new MockReq(serializePacket(createPrepare())), res);
      const body = parseGreeting(res);

      const exactEntries = body.accepts.filter((a: { scheme: string }) => a.scheme === 'exact');
      const evm = exactEntries.find((a: { network: string }) => a.network === 'eip155:8453');
      const sol = exactEntries.find((a: { network: string }) => a.network === 'solana:devnet');
      expect(evm).toMatchObject({
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '1000',
        payTo: termination.settlementAddresses.evm,
      });
      expect(sol).toMatchObject({
        scheme: 'exact',
        network: 'solana:devnet',
        amount: '1000',
        payTo: termination.settlementAddresses.solana,
      });
      // No vanilla exact entry for mina (x402 has no Mina network id).
      expect(
        exactEntries.some((a: { network: string }) => a.network.startsWith('mina')) ||
          exactEntries.some(
            (a: { payTo: string }) => a.payTo === termination.settlementAddresses.mina
          )
      ).toBe(false);

      const toon = body.accepts.find((a: { scheme: string }) => a.scheme === 'toon-channel');
      expect(toon).toBeDefined();
      // extra carries the FULL multi-chain payload INCLUDING mina, verbatim.
      expect(toon.extra).toEqual({
        ilpAddress: termination.ilpAddress,
        endpoint: '/ilp',
        price: termination.price,
        chains: termination.chains, // incl. mina
        settlementAddresses: termination.settlementAddresses, // incl. mina
      });
    });

    it('AC3 (graceful degradation): filtering to scheme:"exact" yields complete v2 PaymentRequirements', async () => {
      const { adapter } = makeAdapter();
      const res = new MockRes();
      await run(adapter, new MockReq(serializePacket(createPrepare())), res);
      const body = parseGreeting(res);

      const exactOnly = body.accepts.filter((a: { scheme: string }) => a.scheme === 'exact');
      expect(exactOnly.length).toBeGreaterThan(0);
      for (const e of exactOnly) {
        expect(typeof e.network).toBe('string');
        expect(typeof e.amount).toBe('string');
        expect(typeof e.payTo).toBe('string');
        expect(e.payTo.length).toBeGreaterThan(0);
        expect(typeof e.maxTimeoutSeconds).toBe('number');
      }
    });

    it('AC4: changing the RouteTermination changes the emitted body (config-sourced)', async () => {
      const altTermination: RouteTermination = {
        ...termination,
        price: '5000',
        chains: ['evm'],
        settlementAddresses: { evm: '0x0000000000000000000000000000000000000001' },
      };
      const { adapter } = makeAdapter(undefined, altTermination);
      const res = new MockRes();
      await run(adapter, new MockReq(serializePacket(createPrepare())), res);
      const body = parseGreeting(res);

      const exactEntries = body.accepts.filter((a: { scheme: string }) => a.scheme === 'exact');
      expect(exactEntries).toHaveLength(1); // only evm now
      expect(exactEntries[0].amount).toBe('5000');
      expect(exactEntries[0].payTo).toBe('0x0000000000000000000000000000000000000001');
      const toon = body.accepts.find((a: { scheme: string }) => a.scheme === 'toon-channel');
      expect(toon.extra.price).toBe('5000');
      expect(toon.extra.chains).toEqual(['evm']);
    });

    it('skips a chain whose settlement payTo is missing (never advertises an unpayable address)', async () => {
      const noSolAddr: RouteTermination = {
        ...termination,
        settlementAddresses: { evm: termination.settlementAddresses.evm }, // solana omitted
      };
      const { adapter } = makeAdapter(undefined, noSolAddr);
      const res = new MockRes();
      await run(adapter, new MockReq(serializePacket(createPrepare())), res);
      const body = parseGreeting(res);
      const exactEntries = body.accepts.filter((a: { scheme: string }) => a.scheme === 'exact');
      expect(exactEntries.map((a: { network: string }) => a.network)).toEqual(['eip155:8453']);
    });

    it('pass-through: a present claim suppresses the greeting (terminated + claim → NOT 402)', async () => {
      const { adapter, handlePrepare, validateClaim } = makeAdapter();
      const req = new MockReq(serializePacket(createPrepare()), {
        'ilp-payment-channel-claim': Buffer.from(claimJson, 'utf8').toString('base64'),
      });
      const res = new MockRes();
      await run(adapter, req, res);

      expect(res.statusCode).toBe(200);
      expect(validateClaim).toHaveBeenCalledTimes(1);
      expect(handlePrepare).toHaveBeenCalledTimes(1);
    });

    it('pass-through: a PAYMENT-SIGNATURE header suppresses the greeting (v2 paid → NOT 402)', async () => {
      const { adapter, handlePrepare } = makeAdapter();
      const req = new MockReq(serializePacket(createPrepare()), {
        [X402_PAYMENT_SIGNATURE_HEADER.toLowerCase()]: 'eyJzb21lIjoicGF5bG9hZCJ9',
      });
      const res = new MockRes();
      await run(adapter, req, res);

      expect(res.statusCode).toBe(200);
      expect(handlePrepare).toHaveBeenCalledTimes(1);
    });

    it('regression: non-terminated destination → NOT 402 (no greeting)', async () => {
      const { adapter, handlePrepare } = makeAdapter(undefined, null);
      const res = new MockRes();
      await run(adapter, new MockReq(serializePacket(createPrepare())), res);
      expect(res.statusCode).toBe(200);
      expect(handlePrepare).toHaveBeenCalledTimes(1);
    });

    it('regression: resolveTermination undefined → unchanged behavior (no greeting)', async () => {
      const handlePrepare = jest.fn(async () => fulfill);
      const adapter = new IlpHttpAdapter({
        logger: createMockLogger(),
        nodeId: 'g.townhouse',
        handlePrepare,
        validateClaim: jest.fn(async () => null),
        // resolveTermination intentionally omitted
      });
      const res = new MockRes();
      await run(adapter, new MockReq(serializePacket(createPrepare())), res);
      expect(res.statusCode).toBe(200);
      expect(handlePrepare).toHaveBeenCalledTimes(1);
    });
  });
});
