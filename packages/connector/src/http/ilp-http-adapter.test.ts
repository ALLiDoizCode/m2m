/**
 * Unit tests for the ILP-over-HTTP adapter (RFC-0035).
 *
 * Focus: the adapter is a thin transport binding that reconstructs the exact
 * `(protocolData, ilpPacket, peerId)` triple the BTP path produces, then calls
 * the same claim-gate + packet-handler seams.
 */

import { EventEmitter } from 'events';
import { ed25519 } from '@noble/curves/ed25519';
import { IlpHttpAdapter } from './ilp-http-adapter';
import { X402_PAYMENT_REQUIRED_HEADER, X402_PAYMENT_SIGNATURE_HEADER } from './x402-greeting';
import type { RouteTermination } from '../config/types';
import { BTP_CLAIM_PROTOCOL } from '../btp/btp-claim-types';
import type { BTPClaimMessage, SolanaClaimMessage } from '../btp/btp-claim-types';
import { InboundClaimValidator } from '../btp/inbound-claim-validator';
import { ChainProviderRegistry } from '../settlement/provider/chain-provider-registry';
import type { PaymentChannelProvider } from '../settlement/provider/payment-channel-provider';
import { signRequest as signRfc9421Request } from '../auth/rfc9421';
import { encodeHttpRequest, type HttpRequestEnvelope } from '../core/handlers/http-proxy-handler';
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
  destination: 'g.connector.relay',
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
      nodeId: 'g.connector',
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
    expect(ilpPacket.destination).toBe('g.connector.relay');
    expect(peerId).toBe('connector-b'); // authenticated via header (no-auth secret)

    // Response is 200 + the serialized FULFILL in the body (RFC-0035).
    expect(res.statusCode).toBe(200);
    expect(deserializePacket(res.body).type).toBe(PacketType.FULFILL);
  });

  it('validates the claim BEFORE recording it for settlement (#353 watermark ordering)', async () => {
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
      nodeId: 'g.connector',
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
    // Gate-then-record (issue #353): the gate's freshness check must read the
    // received-claim watermark as it stood BEFORE this request — recording
    // first would advance the watermark to this claim's own nonce and the
    // strictly-advancing check would reject the claim being recorded. Mirrors
    // BTP, where handleMessage completes before the onMessage ingest fires.
    expect(order).toEqual(['validate', 'record']);
  });

  it('does not record a claim the gate rejected (#353)', async () => {
    const recordClaim = jest.fn(async () => {});
    const reject: ILPRejectPacket = {
      type: PacketType.REJECT,
      code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
      triggeredBy: 'g.connector',
      message: 'Stale payment claim',
      data: Buffer.alloc(0),
    };
    const handlePrepare = jest.fn(async () => fulfill);
    const adapter = new IlpHttpAdapter({
      logger: createMockLogger(),
      nodeId: 'g.connector',
      handlePrepare,
      validateClaim: jest.fn(async () => reject),
      recordClaim,
    });

    const req = new MockReq(serializePacket(createPrepare()), {
      'ilp-payment-channel-claim': Buffer.from(claimJson, 'utf8').toString('base64'),
    });
    const res = new MockRes();
    await run(adapter, req, res);

    expect(recordClaim).not.toHaveBeenCalled();
    expect(handlePrepare).not.toHaveBeenCalled();
    expect((deserializePacket(res.body) as ILPRejectPacket).code).toBe(
      ILPErrorCode.F06_UNEXPECTED_PAYMENT
    );
  });

  it('does not call recordClaim when no claim header is present', async () => {
    const recordClaim = jest.fn(async () => {});
    const adapter = new IlpHttpAdapter({
      logger: createMockLogger(),
      nodeId: 'g.connector',
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
      triggeredBy: 'g.connector',
      message: 'No payment channel claim attached to packet',
      data: Buffer.alloc(0),
    };
    const handlePrepare = jest.fn(async () => fulfill);
    const adapter = new IlpHttpAdapter({
      logger: createMockLogger(),
      nodeId: 'g.connector',
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
      nodeId: 'g.connector',
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
      nodeId: 'g.connector',
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
      nodeId: 'g.connector',
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
      ilpAddress: 'g.connector.relay',
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
        nodeId: 'g.connector',
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
      expect(body.resource).toEqual({ url: 'g.connector.relay' });
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

    it('emits httpEndpoint on the toon-channel entry when Host + X-Forwarded-Proto headers are present', async () => {
      const { adapter } = makeAdapter();
      const req = new MockReq(serializePacket(createPrepare()), {
        host: 'proxy.devnet.toonprotocol.dev',
        'x-forwarded-proto': 'https',
      });
      const res = new MockRes();
      await run(adapter, req, res);

      expect(res.statusCode).toBe(402);
      const body = parseGreeting(res);
      const toon = body.accepts.find((a: { scheme: string }) => a.scheme === 'toon-channel');
      expect(toon?.httpEndpoint).toBe('https://proxy.devnet.toonprotocol.dev/ilp');
    });

    it('omits httpEndpoint from toon-channel entry when no Host header is present', async () => {
      const { adapter } = makeAdapter();
      const res = new MockRes();
      await run(adapter, new MockReq(serializePacket(createPrepare())), res);

      expect(res.statusCode).toBe(402);
      const body = parseGreeting(res);
      const toon = body.accepts.find((a: { scheme: string }) => a.scheme === 'toon-channel');
      expect(toon?.httpEndpoint).toBeUndefined();
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
        nodeId: 'g.connector',
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

  // ---------------------------------------------------------------------------
  // RFC 9421 claim↔request binding on the terminated paid path (issue #220 wiring).
  //
  // Repo policy: NEVER mock. We use a real ed25519 keypair + the #220 reference
  // signer over a real #216 HTTP envelope carried in the PREPARE `data`. The
  // signature, content-digest, and TOON-Price live on the INNER envelope (the
  // literal HTTP request #216 proxies), NOT the outer `POST /ilp`.
  // ---------------------------------------------------------------------------
  describe('RFC 9421 claim↔request binding (#220 wiring)', () => {
    const BIND_PATH = '/greet';
    const BIND_METHOD = 'POST';
    const BIND_PRICE = '1000';
    const innerBody = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8');

    const termination = (overrides: Partial<RouteTermination> = {}): RouteTermination => ({
      upstream: 'http://127.0.0.1:8080',
      price: BIND_PRICE,
      chains: ['evm'],
      ilpAddress: 'g.connector.relay',
      settlementAddresses: { evm: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28' },
      ...overrides,
    });

    const makeAdapter = (
      term: RouteTermination | null
    ): { adapter: IlpHttpAdapter; handlePrepare: jest.Mock; validateClaim: jest.Mock } => {
      const handlePrepare = jest.fn(async () => fulfill);
      const validateClaim = jest.fn(async () => null);
      const adapter = new IlpHttpAdapter({
        logger: createMockLogger(),
        nodeId: 'g.connector',
        handlePrepare,
        validateClaim,
        resolveTermination: () => term,
      });
      return { adapter, handlePrepare, validateClaim };
    };

    /**
     * Build a PREPARE whose `data` is a real #216 HTTP envelope. When `signed`
     * headers are provided they are added to the envelope (a real RFC 9421
     * signature). A claim header on the outer request makes the request "paid"
     * so the greeting does not fire and the binding check runs.
     */
    const makePaidReq = (envHeaders: Record<string, string>, body: Buffer = innerBody): MockReq => {
      const envelope: HttpRequestEnvelope = {
        method: BIND_METHOD,
        target: BIND_PATH,
        httpVersion: 'HTTP/1.1',
        headers: Object.entries(envHeaders),
        body,
      };
      const prepare: ILPPreparePacket = {
        type: PacketType.PREPARE,
        amount: BigInt(1000),
        destination: 'g.connector.relay',
        expiresAt: new Date(Date.now() + 10000),
        data: encodeHttpRequest(envelope),
      };
      return new MockReq(serializePacket(prepare), {
        // Outer claim header → "paid" → greeting suppressed → binding check runs.
        'ilp-payment-channel-claim': Buffer.from(claimJson, 'utf8').toString('base64'),
      });
    };

    const sign = (opts: {
      price?: string;
      body?: Buffer;
      keypairBody?: Buffer;
    }): Record<string, string> => {
      const privateKey = ed25519.utils.randomPrivateKey();
      const signed = signRfc9421Request({
        privateKey,
        method: BIND_METHOD,
        path: BIND_PATH,
        body: opts.keypairBody ?? opts.body ?? innerBody,
        price: opts.price ?? BIND_PRICE,
      });
      return signed.headers;
    };

    it('correctly-signed inner envelope (matching method/path/digest/price) → proxied (FULFILL), NOT rejected', async () => {
      const { adapter, handlePrepare } = makeAdapter(termination());
      const res = new MockRes();
      await run(adapter, makePaidReq(sign({})), res);

      expect(handlePrepare).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
      expect(deserializePacket(res.body).type).toBe(PacketType.FULFILL);
    });

    it('signature for a DIFFERENT price → REJECT (price_mismatch, F03), not proxied', async () => {
      const { adapter, handlePrepare } = makeAdapter(termination({ price: '1000' }));
      const res = new MockRes();
      // Client signed price '9999' but the route expects '1000'.
      await run(adapter, makePaidReq(sign({ price: '9999' })), res);

      expect(handlePrepare).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
      const out = deserializePacket(res.body) as ILPRejectPacket;
      expect(out.type).toBe(PacketType.REJECT);
      expect(out.code).toBe(ILPErrorCode.F03_INVALID_AMOUNT);
      expect(out.message).toContain('price_mismatch');
    });

    it('tampered body (digest mismatch) → REJECT (F01)', async () => {
      const { adapter, handlePrepare } = makeAdapter(termination());
      // Sign over the original body, then ship a different body → digest mismatch.
      const signedHeaders = sign({ keypairBody: innerBody });
      const tampered = Buffer.from(JSON.stringify({ hello: 'tampered' }), 'utf8');
      const res = new MockRes();
      await run(adapter, makePaidReq(signedHeaders, tampered), res);

      expect(handlePrepare).not.toHaveBeenCalled();
      const out = deserializePacket(res.body) as ILPRejectPacket;
      expect(out.type).toBe(PacketType.REJECT);
      expect(out.code).toBe(ILPErrorCode.F01_INVALID_PACKET);
      expect(out.message).toContain('digest_mismatch');
    });

    it('NO signature + requireRequestBinding:false (default) → passes through (NOT rejected by binding)', async () => {
      const { adapter, handlePrepare, validateClaim } = makeAdapter(
        termination({ requireRequestBinding: false })
      );
      const res = new MockRes();
      // No RFC 9421 headers on the inner envelope; just a content-type.
      await run(adapter, makePaidReq({ 'content-type': 'application/json' }), res);

      expect(validateClaim).toHaveBeenCalledTimes(1);
      expect(handlePrepare).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
      expect(deserializePacket(res.body).type).toBe(PacketType.FULFILL);
    });

    it('NO signature + requireRequestBinding:true → REJECT (missing_signature → F01)', async () => {
      const { adapter, handlePrepare } = makeAdapter(termination({ requireRequestBinding: true }));
      const res = new MockRes();
      await run(adapter, makePaidReq({ 'content-type': 'application/json' }), res);

      expect(handlePrepare).not.toHaveBeenCalled();
      const out = deserializePacket(res.body) as ILPRejectPacket;
      expect(out.type).toBe(PacketType.REJECT);
      expect(out.code).toBe(ILPErrorCode.F01_INVALID_PACKET);
      expect(out.message).toContain('missing_signature');
    });

    it('regression: non-terminated destination → binding check never runs (signed-but-mismatched body still proxied)', async () => {
      // resolveTermination returns null → binding must NOT run even with a
      // present-but-bogus signature. The request flows to the shared seams.
      const { adapter, handlePrepare } = makeAdapter(null);
      const res = new MockRes();
      await run(adapter, makePaidReq(sign({ price: '9999' })), res);

      expect(handlePrepare).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
      expect(deserializePacket(res.body).type).toBe(PacketType.FULFILL);
    });
  });
});

/**
 * End-to-end replay gate through the HTTP transport (issue #353).
 *
 * Wires the REAL InboundClaimValidator (with a mock chain provider whose
 * crypto verification always passes — isolating the freshness check) plus a
 * received-claim watermark lookup into the adapter, and asserts the full
 * economic invariant: a stale/equal-nonce replay is F06-rejected BEFORE the
 * backend (handlePrepare) or the settlement recorder is ever invoked, while an
 * advancing claim flows through unchanged. Also proves the hot path adds no
 * chain RPC: a replay is rejected without even reaching the provider's
 * verifyBalanceProof.
 */
describe('IlpHttpAdapter × InboundClaimValidator — stale-claim replay gate (#353)', () => {
  const CHANNEL_ACCOUNT = 'ChanAcct1111111111111111111111111111111111';
  const SIGNER_PUBKEY = 'SiGnEr111111111111111111111111111111111111';
  const PROGRAM_ID = '11111111111111111111111111111111';

  const solanaClaim = (nonce: number): SolanaClaimMessage => ({
    version: '1.0',
    blockchain: 'solana',
    messageId: `sol-msg-${nonce}-${Math.random().toString(36).slice(2)}`,
    timestamp: '2026-07-17T12:00:00.000Z',
    senderId: 'peer-a',
    programId: PROGRAM_ID,
    channelAccount: CHANNEL_ACCOUNT,
    nonce,
    transferredAmount: String(1000 * nonce),
    signature: 'c2lnbmF0dXJl',
    signerPublicKey: SIGNER_PUBKEY,
    cluster: 'devnet',
  });

  interface Harness {
    adapter: IlpHttpAdapter;
    handlePrepare: jest.Mock;
    recordClaim: jest.Mock;
    verifyBalanceProof: jest.Mock;
    watermarkLookup: jest.Mock;
  }

  /** Build the adapter around a real validator + a fixed watermark claim. */
  const makeHarness = (watermark: BTPClaimMessage | null): Harness => {
    const verifyBalanceProof = jest.fn(async () => true);
    const provider = {
      chainType: 'solana',
      chainId: 'solana:devnet',
      verifyBalanceProof,
    } as unknown as PaymentChannelProvider;
    const registry = new ChainProviderRegistry();
    registry.register(provider);

    const watermarkLookup = jest.fn(async () => watermark);
    const validator = new InboundClaimValidator(
      undefined, // no EVM SDK — Solana path
      'g.connector',
      createMockLogger() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      registry,
      watermarkLookup
    );

    const handlePrepare = jest.fn(async () => fulfill);
    const recordClaim = jest.fn(async () => {});
    const adapter = new IlpHttpAdapter({
      logger: createMockLogger(),
      nodeId: 'g.connector',
      handlePrepare,
      validateClaim: (pd, pkt, peer) => validator.validate(pd, pkt, peer),
      recordClaim,
    });
    return { adapter, handlePrepare, recordClaim, verifyBalanceProof, watermarkLookup };
  };

  const paidReq = (nonce: number): MockReq =>
    new MockReq(serializePacket(createPrepare()), {
      'ilp-payment-channel-claim': Buffer.from(JSON.stringify(solanaClaim(nonce)), 'utf8').toString(
        'base64'
      ),
    });

  it('F06-rejects a stale-nonce replay: backend NOT hit, claim NOT recorded, no crypto/RPC', async () => {
    const h = makeHarness(solanaClaim(6)); // watermark: latest verified nonce 6
    const res = new MockRes();
    await run(h.adapter, paidReq(4), res); // replayed old claim (nonce 4)

    expect(res.statusCode).toBe(200); // ILP-level reject rides the 200 body
    const out = deserializePacket(res.body) as ILPRejectPacket;
    expect(out.type).toBe(PacketType.REJECT);
    expect(out.code).toBe(ILPErrorCode.F06_UNEXPECTED_PAYMENT);
    expect(out.message).toContain('Stale payment claim');
    expect(h.handlePrepare).not.toHaveBeenCalled(); // zero backend calls
    expect(h.recordClaim).not.toHaveBeenCalled(); // watermark untouched
    // Rejected on the local watermark read alone — before signature
    // verification, and with no chain RPC on the hot path.
    expect(h.verifyBalanceProof).not.toHaveBeenCalled();
  });

  it('F06-rejects an equal-nonce replay (clients sign a fresh claim per write)', async () => {
    const h = makeHarness(solanaClaim(6));
    const res = new MockRes();
    await run(h.adapter, paidReq(6), res);

    const out = deserializePacket(res.body) as ILPRejectPacket;
    expect(out.type).toBe(PacketType.REJECT);
    expect(out.code).toBe(ILPErrorCode.F06_UNEXPECTED_PAYMENT);
    expect(h.handlePrepare).not.toHaveBeenCalled();
    expect(h.recordClaim).not.toHaveBeenCalled();
  });

  it('admits an advancing-nonce claim: crypto gate runs, backend hit, claim recorded', async () => {
    const h = makeHarness(solanaClaim(6));
    const res = new MockRes();
    await run(h.adapter, paidReq(7), res);

    expect(h.watermarkLookup).toHaveBeenCalledWith(
      'http:' + SIGNER_PUBKEY,
      'solana',
      CHANNEL_ACCOUNT
    );
    expect(h.verifyBalanceProof).toHaveBeenCalledTimes(1);
    expect(h.handlePrepare).toHaveBeenCalledTimes(1);
    expect(h.recordClaim).toHaveBeenCalledTimes(1);
    expect(deserializePacket(res.body).type).toBe(PacketType.FULFILL);
  });

  it('first claim on an unknown channel (no watermark) passes to the crypto gate', async () => {
    const h = makeHarness(null);
    const res = new MockRes();
    await run(h.adapter, paidReq(1), res);

    expect(h.watermarkLookup).toHaveBeenCalledTimes(1);
    expect(h.verifyBalanceProof).toHaveBeenCalledTimes(1);
    expect(h.handlePrepare).toHaveBeenCalledTimes(1);
    expect(deserializePacket(res.body).type).toBe(PacketType.FULFILL);
  });

  it('fails open to the crypto gate when the watermark read throws', async () => {
    const h = makeHarness(null);
    h.watermarkLookup.mockRejectedValueOnce(new Error('db closed'));
    const res = new MockRes();
    await run(h.adapter, paidReq(1), res);

    expect(h.verifyBalanceProof).toHaveBeenCalledTimes(1);
    expect(deserializePacket(res.body).type).toBe(PacketType.FULFILL);
  });
});

describe('IlpHttpAdapter × InboundClaimValidator — claim-value ↔ price binding (#359)', () => {
  const CHANNEL_ACCOUNT = 'ChanAcct2222222222222222222222222222222222';
  const SIGNER_PUBKEY = 'SiGnEr222222222222222222222222222222222222';
  const PROGRAM_ID = '11111111111111111111111111111111';

  const solanaClaim = (nonce: number): SolanaClaimMessage => ({
    version: '1.0',
    blockchain: 'solana',
    messageId: `sol-msg-${nonce}-${Math.random().toString(36).slice(2)}`,
    timestamp: '2026-07-17T12:00:00.000Z',
    senderId: 'peer-a',
    programId: PROGRAM_ID,
    channelAccount: CHANNEL_ACCOUNT,
    nonce,
    transferredAmount: String(1000 * nonce), // cumulative advances 1000/nonce
    signature: 'c2lnbmF0dXJl',
    signerPublicKey: SIGNER_PUBKEY,
    cluster: 'devnet',
  });

  interface Harness {
    adapter: IlpHttpAdapter;
    handlePrepare: jest.Mock;
    recordClaim: jest.Mock;
    verifyBalanceProof: jest.Mock;
    routePriceLookup: jest.Mock;
  }

  /**
   * Adapter wrapped around a real validator with both the watermark and the
   * route-price resolver wired — the full #353+#359 gate over the real HTTP
   * path, so "backend not hit" is a genuine end-to-end assertion.
   */
  const makeHarness = (watermark: BTPClaimMessage | null, routePrice: string | null): Harness => {
    const verifyBalanceProof = jest.fn(async () => true);
    const registry = new ChainProviderRegistry();
    registry.register({
      chainType: 'solana',
      chainId: 'solana:devnet',
      verifyBalanceProof,
    } as unknown as PaymentChannelProvider);

    const routePriceLookup = jest.fn(() => routePrice);
    const validator = new InboundClaimValidator(
      undefined,
      'g.connector',
      createMockLogger() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      registry,
      jest.fn(async () => watermark),
      routePriceLookup
    );

    const handlePrepare = jest.fn(async () => fulfill);
    const recordClaim = jest.fn(async () => {});
    const adapter = new IlpHttpAdapter({
      logger: createMockLogger(),
      nodeId: 'g.connector',
      handlePrepare,
      validateClaim: (pd, pkt, peer) => validator.validate(pd, pkt, peer),
      recordClaim,
    });
    return { adapter, handlePrepare, recordClaim, verifyBalanceProof, routePriceLookup };
  };

  const paidReq = (nonce: number): MockReq =>
    new MockReq(serializePacket(createPrepare()), {
      'ilp-payment-channel-claim': Buffer.from(JSON.stringify(solanaClaim(nonce)), 'utf8').toString(
        'base64'
      ),
    });

  it('F06-rejects an underpaying claim end-to-end: backend NOT hit, claim NOT recorded, no crypto', async () => {
    // watermark nonce 6 (cumulative 6000) → claim nonce 7 (cumulative 7000):
    // delta 1000; route price 2000 → underpaid.
    const h = makeHarness(solanaClaim(6), '2000');
    const res = new MockRes();
    await run(h.adapter, paidReq(7), res);

    expect(res.statusCode).toBe(200);
    const out = deserializePacket(res.body) as ILPRejectPacket;
    expect(out.type).toBe(PacketType.REJECT);
    expect(out.code).toBe(ILPErrorCode.F06_UNEXPECTED_PAYMENT);
    expect(out.message).toContain('Insufficient claim value');
    expect(h.handlePrepare).not.toHaveBeenCalled(); // zero backend calls
    expect(h.recordClaim).not.toHaveBeenCalled();
    expect(h.verifyBalanceProof).not.toHaveBeenCalled();
  });

  it('admits an exact-price claim: crypto gate runs, backend hit, claim recorded', async () => {
    const h = makeHarness(solanaClaim(6), '1000'); // delta 1000 == price
    const res = new MockRes();
    await run(h.adapter, paidReq(7), res);

    expect(h.verifyBalanceProof).toHaveBeenCalledTimes(1);
    expect(h.handlePrepare).toHaveBeenCalledTimes(1);
    expect(h.recordClaim).toHaveBeenCalledTimes(1);
    expect(deserializePacket(res.body).type).toBe(PacketType.FULFILL);
  });

  it('admits an overpaying claim (delta > price)', async () => {
    const h = makeHarness(solanaClaim(6), '500'); // delta 1000 > price 500
    const res = new MockRes();
    await run(h.adapter, paidReq(7), res);

    expect(h.handlePrepare).toHaveBeenCalledTimes(1);
    expect(deserializePacket(res.body).type).toBe(PacketType.FULFILL);
  });

  it('does not enforce value on a forwarded / non-terminated destination (no route price)', async () => {
    const h = makeHarness(solanaClaim(6), null); // resolver → null
    const res = new MockRes();
    await run(h.adapter, paidReq(7), res);

    expect(h.handlePrepare).toHaveBeenCalledTimes(1);
    expect(deserializePacket(res.body).type).toBe(PacketType.FULFILL);
  });
});
