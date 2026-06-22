/**
 * Tests for the HTTP reverse-proxy local-delivery handler (issue #216).
 *
 * Per repo policy these tests use NO mocks: the integration test spins up a real
 * `http.Server` stub upstream on an ephemeral port and asserts a paid POST /ilp
 * round-trips byte-for-byte with the injected X-TOON-* headers arriving.
 *
 * @packageDocumentation
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import type { LocalDeliveryRequest } from '../../config/types';
import {
  HttpProxyHandler,
  decodeHttpRequest,
  encodeHttpRequest,
  encodeHttpResponse,
  EnvelopeDecodeError,
  TOON_PAYER_HEADER,
  TOON_AMOUNT_HEADER,
  TOON_CHAIN_HEADER,
} from './http-proxy-handler';

const CRLF = '\r\n';

/** Build a literal HTTP request envelope buffer. */
function buildRequest(
  method: string,
  target: string,
  headers: Array<[string, string]>,
  body: Buffer | string
): Buffer {
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headLines = [`${method} ${target} HTTP/1.1`];
  for (const [n, v] of headers) headLines.push(`${n}: ${v}`);
  return Buffer.concat([Buffer.from(headLines.join(CRLF) + CRLF + CRLF, 'latin1'), bodyBuf]);
}

function makeDeliveryRequest(
  data: Buffer,
  overrides?: Partial<LocalDeliveryRequest>
): LocalDeliveryRequest {
  return {
    destination: 'g.solana.alice.app',
    amount: '12345',
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    data: data.toString('base64'),
    sourcePeer: 'g.solana.payer-pubkey-abc',
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Envelope codec — unit tests
// ────────────────────────────────────────────────────────────────────────────

describe('HTTP envelope codec', () => {
  it('decodes a request-line, headers, and body', () => {
    const buf = buildRequest(
      'POST',
      '/greet?x=1',
      [
        ['Host', 'example.test'],
        ['Content-Type', 'application/json'],
      ],
      '{"hello":"world"}'
    );
    const env = decodeHttpRequest(buf);
    expect(env.method).toBe('POST');
    expect(env.target).toBe('/greet?x=1');
    expect(env.httpVersion).toBe('HTTP/1.1');
    expect(env.headers).toEqual([
      ['Host', 'example.test'],
      ['Content-Type', 'application/json'],
    ]);
    expect(env.body.toString()).toBe('{"hello":"world"}');
  });

  it('is byte-faithful: decode→encode round-trips the original buffer', () => {
    const buf = buildRequest(
      'PUT',
      '/items/42',
      [
        ['X-Custom-Header', 'KeepCase'],
        ['Accept', 'text/plain'],
      ],
      'arbitrary body bytes'
    );
    expect(encodeHttpRequest(decodeHttpRequest(buf)).equals(buf)).toBe(true);
  });

  it('preserves binary body bytes exactly', () => {
    const binBody = Buffer.from([0x00, 0xff, 0x10, 0x0d, 0x0a, 0x42]);
    const buf = buildRequest(
      'POST',
      '/bin',
      [['Content-Type', 'application/octet-stream']],
      binBody
    );
    const env = decodeHttpRequest(buf);
    expect(env.body.equals(binBody)).toBe(true);
  });

  it('preserves header name casing (not normalized)', () => {
    const buf = buildRequest('GET', '/', [['X-MiXeD-CaSe', 'v']], '');
    expect(decodeHttpRequest(buf).headers[0]?.[0]).toBe('X-MiXeD-CaSe');
  });

  it('strips leading OWS after the colon (RFC 7230) but keeps internal spaces', () => {
    const raw = Buffer.from('GET / HTTP/1.1' + CRLF + 'X-H:  a b ' + CRLF + CRLF, 'latin1');
    expect(decodeHttpRequest(raw).headers[0]).toEqual(['X-H', 'a b ']);
  });

  it('handles a header-only request with no body delimiter', () => {
    const raw = Buffer.from('GET /ping HTTP/1.1' + CRLF + 'Host: x', 'latin1');
    const env = decodeHttpRequest(raw);
    expect(env.method).toBe('GET');
    expect(env.body.length).toBe(0);
  });

  it('throws EnvelopeDecodeError on empty data', () => {
    expect(() => decodeHttpRequest(Buffer.alloc(0))).toThrow(EnvelopeDecodeError);
    expect(() => decodeHttpRequest(Buffer.alloc(0))).toThrow('empty envelope');
  });

  it('throws on a malformed request-line', () => {
    const raw = Buffer.from('GARBAGE' + CRLF + CRLF, 'latin1');
    expect(() => decodeHttpRequest(raw)).toThrow(EnvelopeDecodeError);
  });

  it('throws on a header line without a colon', () => {
    const raw = Buffer.from('GET / HTTP/1.1' + CRLF + 'no-colon-here' + CRLF + CRLF, 'latin1');
    expect(() => decodeHttpRequest(raw)).toThrow(EnvelopeDecodeError);
  });

  it('encodeHttpResponse produces a byte-faithful status line + headers + body', () => {
    const buf = encodeHttpResponse({
      httpVersion: 'HTTP/1.1',
      status: 201,
      statusText: 'Created',
      headers: [['Content-Type', 'text/plain']],
      body: Buffer.from('ok'),
    });
    expect(buf.toString()).toBe(
      'HTTP/1.1 201 Created' + CRLF + 'Content-Type: text/plain' + CRLF + CRLF + 'ok'
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Reverse proxy — integration tests against a real http.Server
// ────────────────────────────────────────────────────────────────────────────

describe('HttpProxyHandler (real upstream)', () => {
  let server: http.Server;
  let baseUrl: string;
  /** Captured by the stub upstream for assertions. */
  let received: {
    method?: string;
    url?: string;
    headers?: http.IncomingHttpHeaders;
    body?: Buffer;
  } = {};
  /** Behavior knob for the stub. */
  let respond: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void;

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        received = { method: req.method, url: req.url, headers: req.headers, body };
        respond(req, res, body);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(() => done());
  });

  beforeEach(() => {
    received = {};
    // Default stub: echo the body back with 200.
    respond = (_req, res, body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    };
  });

  it('round-trips a paid POST /ilp byte-for-byte and injects X-TOON-* headers', async () => {
    const proxy = new HttpProxyHandler({ upstreamUrl: baseUrl });
    const payload = JSON.stringify({ greeting: 'hello' });
    const reqBuf = buildRequest(
      'POST',
      '/ilp',
      [
        ['Host', 'should-be-stripped'],
        ['Content-Type', 'application/json'],
        ['Connection', 'keep-alive'], // hop-by-hop, must be stripped
        ['Proxy-Authorization', 'Bearer secret'], // hop-by-hop, must be stripped
        ['TE', 'trailers'], // hop-by-hop, must be stripped
      ],
      payload
    );

    const result = await proxy.handler(makeDeliveryRequest(reqBuf), 'g.solana.payer-pubkey-abc');

    // Upstream actually received the request.
    expect(received.method).toBe('POST');
    expect(received.url).toBe('/ilp');
    expect(received.body?.toString()).toBe(payload);

    // AC3: injected headers arrive.
    expect(received.headers?.[TOON_PAYER_HEADER.toLowerCase()]).toBe('g.solana.payer-pubkey-abc');
    expect(received.headers?.[TOON_AMOUNT_HEADER.toLowerCase()]).toBe('12345');
    expect(received.headers?.[TOON_CHAIN_HEADER.toLowerCase()]).toBe('solana');

    // AC2: hop-by-hop headers are stripped before replay. (Node's HTTP transport
    // sets its own `Connection` header, so we assert on hop-by-hop headers the
    // transport does NOT re-inject: Proxy-Authorization and TE.)
    expect(received.headers?.['proxy-authorization']).toBeUndefined();
    expect(received.headers?.['te']).toBeUndefined();
    // The forwarded request must not carry the connector's stripped Host either.
    expect(received.headers?.['host']).not.toBe('should-be-stripped');

    // AC4: the upstream response round-trips in the FULFILL data, byte-faithful.
    expect(result.fulfill).toBeDefined();
    expect(result.reject).toBeUndefined();
    const respBuf = Buffer.from(result.fulfill!.data!, 'base64');
    const respText = respBuf.toString('latin1');
    expect(respText.startsWith('HTTP/1.1 200')).toBe(true);
    expect(respText).toContain('content-type: application/json');
    expect(respBuf.subarray(respBuf.indexOf('\r\n\r\n') + 4).toString()).toBe(payload);
  });

  it('preserves a binary request/response body end-to-end', async () => {
    const bin = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x0d, 0x0a]);
    respond = (_req, res, body) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(body);
    };
    const proxy = new HttpProxyHandler({ upstreamUrl: baseUrl });
    const reqBuf = buildRequest(
      'POST',
      '/bin',
      [['Content-Type', 'application/octet-stream']],
      bin
    );

    const result = await proxy.handler(makeDeliveryRequest(reqBuf), 'g.x.payer');
    expect(received.body?.equals(bin)).toBe(true);

    const respBuf = Buffer.from(result.fulfill!.data!, 'base64');
    const respBody = respBuf.subarray(respBuf.indexOf('\r\n\r\n') + 4);
    expect(respBody.equals(bin)).toBe(true);
  });

  it('relays an upstream 5xx as a FULFILL carrying the byte-faithful response', async () => {
    respond = (_req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('upstream down');
    };
    const proxy = new HttpProxyHandler({ upstreamUrl: baseUrl });
    const reqBuf = buildRequest('GET', '/health', [['Accept', 'text/plain']], '');

    const result = await proxy.handler(makeDeliveryRequest(reqBuf), 'g.x.payer');
    expect(result.fulfill).toBeDefined();
    const respText = Buffer.from(result.fulfill!.data!, 'base64').toString('latin1');
    expect(respText.startsWith('HTTP/1.1 503')).toBe(true);
    expect(respText).toContain('upstream down');
  });

  it('rejects with T01 when the upstream is unreachable', async () => {
    // Point at a closed port (server is on a different port).
    const proxy = new HttpProxyHandler({ upstreamUrl: 'http://127.0.0.1:1' });
    const reqBuf = buildRequest('GET', '/x', [], '');
    const result = await proxy.handler(makeDeliveryRequest(reqBuf), 'g.x.payer');
    expect(result.reject?.code).toBe('T01');
  });

  it('rejects with T00 when the upstream times out', async () => {
    respond = () => {
      /* never respond → trigger abort */
    };
    const proxy = new HttpProxyHandler({ upstreamUrl: baseUrl, timeoutMs: 100 });
    const reqBuf = buildRequest('GET', '/slow', [], '');
    const result = await proxy.handler(makeDeliveryRequest(reqBuf), 'g.x.payer');
    expect(result.reject?.code).toBe('T00');
  });

  it('rejects with F01 on a malformed envelope', async () => {
    const proxy = new HttpProxyHandler({ upstreamUrl: baseUrl });
    const bad = makeDeliveryRequest(Buffer.from('NOT-HTTP', 'latin1'));
    const result = await proxy.handler(bad, 'g.x.payer');
    expect(result.reject?.code).toBe('F01');
  });

  it('rejects with F06 on empty data (no request to proxy)', async () => {
    const proxy = new HttpProxyHandler({ upstreamUrl: baseUrl });
    const empty = makeDeliveryRequest(Buffer.alloc(0));
    empty.data = '';
    const result = await proxy.handler(empty, 'g.x.payer');
    expect(result.reject?.code).toBe('F06');
  });

  it('rejects with F02 when the upstreamResolver returns no route', async () => {
    const proxy = new HttpProxyHandler({ upstreamResolver: () => undefined });
    const reqBuf = buildRequest('GET', '/x', [], '');
    const result = await proxy.handler(makeDeliveryRequest(reqBuf), 'g.x.payer');
    expect(result.reject?.code).toBe('F02');
  });

  it('upstreamResolver takes precedence and enables per-route upstreams (#218 forward-compat)', async () => {
    const proxy = new HttpProxyHandler({
      upstreamUrl: 'http://unused.invalid',
      upstreamResolver: (req) => (req.destination.includes('alice') ? baseUrl : undefined),
    });
    const reqBuf = buildRequest('POST', '/r', [['Content-Type', 'text/plain']], 'routed');
    const result = await proxy.handler(makeDeliveryRequest(reqBuf), 'g.x.payer');
    expect(received.body?.toString()).toBe('routed');
    expect(result.fulfill).toBeDefined();
  });

  it('constructor rejects when neither upstreamUrl nor upstreamResolver is given', () => {
    expect(() => new HttpProxyHandler({})).toThrow(/upstreamUrl or upstreamResolver/);
  });
});
