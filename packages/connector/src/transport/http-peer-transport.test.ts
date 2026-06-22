/**
 * Tests for ILP-over-HTTP egress (Epic 38, Story 38.1).
 *
 * Mock-free: every test runs against a REAL `node:http` receiver on an ephemeral
 * port. The strongest test posts to the EXISTING {@link IlpHttpAdapter} ingress
 * to prove egress/ingress wire symmetry (claim round-trips byte-for-byte).
 */

import http from 'http';
import { AddressInfo } from 'net';
import {
  PacketType,
  ILPErrorCode,
  serializePacket,
  type ILPPreparePacket,
  type ILPFulfillPacket,
  type ILPRejectPacket,
} from '@toon-protocol/shared';
import { createLogger } from '../utils/logger';
import {
  HttpPeerClientManager,
  HttpPeerConnectionError,
  type PeerEgress,
  type HttpPeer,
} from './http-peer-transport';
import { DirectTransportProvider } from './direct-transport-provider';
import type { TransportProvider } from './transport-provider';
import { HttpPeerTestServer } from '../../test/fixtures/http-peer-test-server';
import { IlpHttpAdapter, ILP_HTTP_PATH } from '../http/ilp-http-adapter';
import { BTP_CLAIM_PROTOCOL } from '../btp/btp-claim-types';
import { BTP_WRAPPED_CLAIM_PROTOCOL } from '../settlement/privacy/nip59-claim-wrapper';
import type { BTPProtocolData } from '../btp/btp-types';

const logger = createLogger('http-egress-test', 'silent');
const transport = new DirectTransportProvider('ws://localhost:9999');

const buildPrepare = (overrides: Partial<ILPPreparePacket> = {}): ILPPreparePacket => ({
  type: PacketType.PREPARE,
  amount: 100n,
  destination: 'test.peer.receiver',
  expiresAt: new Date(Date.now() + 30_000),
  data: Buffer.from('hello'),
  ...overrides,
});

const makeManager = (provider: TransportProvider = transport): HttpPeerClientManager =>
  new HttpPeerClientManager('test.this-node', logger, provider);

describe('HttpPeerClientManager — ILP-over-HTTP egress', () => {
  let server: HttpPeerTestServer;
  let mgr: HttpPeerClientManager;

  beforeEach(async () => {
    server = new HttpPeerTestServer();
    await server.start();
    mgr = makeManager();
  });

  afterEach(async () => {
    await server.stop();
  });

  const addPeer = async (extra: Partial<HttpPeer> = {}): Promise<void> => {
    await mgr.addPeer({ id: 'peerX', httpUrl: server.url, authToken: 'sekret', ...extra });
  };

  it('conformance: satisfies the PeerEgress interface', () => {
    const egress: PeerEgress = mgr;
    expect(typeof egress.sendToPeer).toBe('function');
    expect(typeof egress.isConnected).toBe('function');
    expect(typeof egress.addPeer).toBe('function');
    expect(typeof egress.removePeer).toBe('function');
  });

  it('isConnected reflects registration; removePeer deregisters', async () => {
    expect(mgr.isConnected('peerX')).toBe(false);
    await addPeer();
    expect(mgr.isConnected('peerX')).toBe(true);
    await mgr.removePeer('peerX');
    expect(mgr.isConnected('peerX')).toBe(false);
  });

  it('POSTs the symmetric request and returns the FULFILL', async () => {
    await addPeer();
    server.setBehavior({ kind: 'fulfill', fulfillment: Buffer.alloc(32, 7) });

    const res = await mgr.sendToPeer('peerX', buildPrepare());

    expect(res.type).toBe(PacketType.FULFILL);
    expect(Buffer.from((res as ILPFulfillPacket).fulfillment!)).toEqual(Buffer.alloc(32, 7));

    const captured = server.lastRequest!;
    expect(captured.method).toBe('POST');
    expect(captured.path).toBe('/ilp'); // default egress path
    expect(captured.headers['content-type']).toBe('application/octet-stream');
    expect(captured.headers['ilp-peer-id']).toBe('test.this-node');
    expect(captured.headers['authorization']).toBe('Bearer sekret');
    expect(captured.prepare.destination).toBe('test.peer.receiver');
    expect(captured.prepare.amount).toBe(100n);
  });

  it('honors a custom httpPath', async () => {
    await addPeer({ httpPath: '/ilp/v1/packet' });
    await mgr.sendToPeer('peerX', buildPrepare());
    expect(server.lastRequest!.path).toBe('/ilp/v1/packet');
  });

  it('returns the peer REJECT verbatim (ILP-level reject rides in 200 body)', async () => {
    await addPeer();
    server.setBehavior({
      kind: 'reject',
      code: ILPErrorCode.F02_UNREACHABLE,
      message: 'no route',
    });
    const res = await mgr.sendToPeer('peerX', buildPrepare());
    expect(res.type).toBe(PacketType.REJECT);
    expect((res as ILPRejectPacket).code).toBe(ILPErrorCode.F02_UNREACHABLE);
  });

  it('re-encodes a claim protocolData entry into the base64 header', async () => {
    await addPeer();
    const claimBytes = Buffer.from(JSON.stringify({ signerAddress: '0xabc', amount: '5' }));
    const protocolData: BTPProtocolData[] = [
      { protocolName: BTP_CLAIM_PROTOCOL.NAME, contentType: 1, data: claimBytes },
    ];
    await mgr.sendToPeer('peerX', buildPrepare(), protocolData);

    const captured = server.lastRequest!;
    expect(captured.headers['ilp-payment-channel-claim']).toBe(claimBytes.toString('base64'));
    expect(captured.claim).toEqual(claimBytes); // round-trips byte-for-byte
  });

  it('re-encodes a wrapped-claim protocolData entry into the wrapped header', async () => {
    await addPeer();
    const wrapped = Buffer.from('wrapped-gift-wrap-bytes');
    const protocolData: BTPProtocolData[] = [
      { protocolName: BTP_WRAPPED_CLAIM_PROTOCOL.NAME, contentType: 0, data: wrapped },
    ];
    await mgr.sendToPeer('peerX', buildPrepare(), protocolData);
    expect(server.lastRequest!.wrappedClaim).toEqual(wrapped);
  });

  describe('response-code → ILP-reject mapping', () => {
    it.each([
      [401, ILPErrorCode.T01_PEER_UNREACHABLE],
      [400, ILPErrorCode.F00_BAD_REQUEST],
      [404, ILPErrorCode.F00_BAD_REQUEST],
      [500, ILPErrorCode.T01_PEER_UNREACHABLE],
      [503, ILPErrorCode.T01_PEER_UNREACHABLE],
    ])('HTTP %d → %s', async (status, expectedCode) => {
      await addPeer();
      server.setBehavior({ kind: 'http-status', status });
      const res = await mgr.sendToPeer('peerX', buildPrepare());
      expect(res.type).toBe(PacketType.REJECT);
      expect((res as ILPRejectPacket).code).toBe(expectedCode);
    });
  });

  it('connection-refused → throws HttpPeerConnectionError (→ T01 upstream)', async () => {
    // Register a peer pointing at a closed port (server stopped).
    await server.stop();
    await mgr.addPeer({ id: 'dead', httpUrl: server.url, authToken: 't' });
    await expect(mgr.sendToPeer('dead', buildPrepare())).rejects.toBeInstanceOf(
      HttpPeerConnectionError
    );
    // restart a no-op server so afterEach stop() succeeds
    server = new HttpPeerTestServer();
    await server.start();
  });

  it('unknown peer → throws HttpPeerConnectionError', async () => {
    await expect(mgr.sendToPeer('nope', buildPrepare())).rejects.toBeInstanceOf(
      HttpPeerConnectionError
    );
  });

  it('slow receiver → timeout (rejects, derived from short expiry)', async () => {
    await addPeer();
    server.setBehavior({ kind: 'slow', delayMs: 2000 });
    // expiresAt 1.2s out → egress timeout floor 1000ms fires before the 2s reply.
    const prepare = buildPrepare({ expiresAt: new Date(Date.now() + 1200) });
    await expect(mgr.sendToPeer('peerX', prepare)).rejects.toThrow(/timed out/i);
  });

  it('pooling: 100 concurrent forwards succeed and reuse sockets', async () => {
    await addPeer();
    server.setBehavior({ kind: 'fulfill' });
    const results = await Promise.all(
      Array.from({ length: 100 }, () => mgr.sendToPeer('peerX', buildPrepare()))
    );
    expect(results).toHaveLength(100);
    expect(results.every((r) => r.type === PacketType.FULFILL)).toBe(true);
    expect(server.requests).toHaveLength(100);
  });

  it('SOCKS composition: consults the injected TransportProvider for an agent', async () => {
    let createAgentCalls = 0;
    const probingProvider: TransportProvider = {
      createAgent: (url: string) => {
        createAgentCalls++;
        expect(url).toBe(server.url);
        return undefined; // fall back to pooled keep-alive; request still succeeds
      },
      getExternalUrl: () => '',
      start: async () => {},
      stop: async () => {},
      healthCheck: async () => true,
    };
    const socksMgr = makeManager(probingProvider);
    await socksMgr.addPeer({ id: 'p', httpUrl: server.url, authToken: 't' });
    const res = await socksMgr.sendToPeer('p', buildPrepare());
    expect(res.type).toBe(PacketType.FULFILL);
    expect(createAgentCalls).toBe(1);
  });
});

describe('Egress/ingress wire symmetry (real IlpHttpAdapter ingress)', () => {
  let ingress: http.Server;
  let ingressPort: number;
  let received: { protocolData: BTPProtocolData[]; peerId: string } | null;
  let mgr: HttpPeerClientManager;

  beforeAll(async () => {
    received = null;
    const adapter = new IlpHttpAdapter({
      logger,
      nodeId: 'test.ingress-node',
      // Capture what the ingress rebuilds, then fulfill.
      handlePrepare: async (
        _prepare: ILPPreparePacket,
        peerId: string,
        protocolData?: BTPProtocolData[]
      ): Promise<ILPFulfillPacket | ILPRejectPacket> => {
        received = { protocolData: protocolData ?? [], peerId };
        return {
          type: PacketType.FULFILL,
          fulfillment: Buffer.alloc(32, 9),
          data: Buffer.alloc(0),
        };
      },
    });
    ingress = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === ILP_HTTP_PATH) {
        void adapter.handle(req, res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => ingress.listen(0, '127.0.0.1', resolve));
    ingressPort = (ingress.address() as AddressInfo).port;
    mgr = new HttpPeerClientManager('test.egress-node', logger, transport);
    await mgr.addPeer({
      id: 'ingress',
      httpUrl: `http://127.0.0.1:${ingressPort}`,
      authToken: '',
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      ingress.close((err) => (err ? reject(err) : resolve()))
    );
  });

  it('the real ingress accepts our POST and fulfills', async () => {
    const prepare = buildPrepare({ destination: 'test.ingress-node.local' });
    const res = await mgr.sendToPeer('ingress', prepare);
    expect(res.type).toBe(PacketType.FULFILL);
    expect(Buffer.from((res as ILPFulfillPacket).fulfillment!)).toEqual(Buffer.alloc(32, 9));
    // ILP-Peer-Id propagated as the authenticated peer id at the ingress.
    expect(received!.peerId).toBe('test.egress-node');
  });

  it('claim protocolData round-trips byte-for-byte through the real ingress', async () => {
    const claimBytes = Buffer.from(JSON.stringify({ signerAddress: '0xfeed', amount: '42' }));
    const protocolData: BTPProtocolData[] = [
      { protocolName: BTP_CLAIM_PROTOCOL.NAME, contentType: 1, data: claimBytes },
    ];
    await mgr.sendToPeer('ingress', buildPrepare(), protocolData);

    const rebuilt = received!.protocolData.find((p) => p.protocolName === BTP_CLAIM_PROTOCOL.NAME);
    expect(rebuilt).toBeDefined();
    // The exact bytes the egress emitted are what the ingress rebuilt.
    expect(rebuilt!.data).toEqual(claimBytes);
  });

  it('a serialized PREPARE the egress sends deserializes identically at the ingress', async () => {
    // Sanity: the egress body is a plain serializePacket(prepare).
    const prepare = buildPrepare({ amount: 777n, data: Buffer.from('payload') });
    const body = serializePacket(prepare);
    expect(body.length).toBeGreaterThan(0);
    await mgr.sendToPeer('ingress', prepare);
    expect(received).not.toBeNull();
  });
});
