/**
 * HTTP Reverse-Proxy Local-Delivery Handler (issue #216)
 *
 * The foundational "connector-as-terminator" handler. It terminates a payment
 * at the connector and reverse-proxies a transparent, literal HTTP request —
 * carried opaquely in the ILP PREPARE `data` field — to an oblivious upstream
 * over plain HTTP. The upstream answers a normal HTTP response; we serialize it
 * back into the ILP FULFILL `data`. The backend never sees ILP, payment, or
 * settlement: it is "any app behind the connector."
 *
 * The connector MUST NOT assume the `data` is TOON/Nostr/x402/anything. The only
 * thing this handler does with `data` is extract an HTTP envelope (below). No
 * other part of the connector parses `data`.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * HTTP-ENVELOPE WIRE FORMAT (v1) — depended on by #217 (x402 greeting),
 * #220 (RFC9421 binding), #221 (compose). DO NOT change without bumping.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * The ILP PREPARE `data` is a literal, byte-faithful HTTP/1.1 request message as
 * defined by RFC 7230 §3, encoded exactly as it would appear on the wire:
 *
 *     request-line CRLF
 *     *( header-field CRLF )
 *     CRLF
 *     [ message-body ]
 *
 * Concretely:
 *   - request-line  = method SP request-target SP HTTP-version
 *                     e.g. `POST /greet HTTP/1.1`
 *   - header-field  = field-name ":" OWS field-value
 *                     e.g. `Content-Type: application/json`
 *   - Line terminator is CRLF (`\r\n`). The header section ends with a bare CRLF
 *     (i.e. an empty line). Everything after that empty line — to the end of the
 *     buffer — is the raw body, byte-for-byte (binary-safe; NOT re-encoded).
 *   - There is NO Content-Length requirement in the envelope itself: the body is
 *     simply "the rest of the buffer". The replay path lets the HTTP client set
 *     Content-Length so the upstream sees a well-formed request.
 *
 * This is deliberately the literal HTTP message so that downstream layers can
 * carry signed requests (RFC 9421) and arbitrary app payloads without the
 * connector re-encoding or canonicalizing anything. The codec is reversible and
 * binary-safe: decode(encode(x)) preserves body bytes and header ordering/case.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * @packageDocumentation
 */

import type { Logger } from 'pino';
import type {
  LocalDeliveryHandler,
  LocalDeliveryRequest,
  LocalDeliveryResponse,
} from '../../config/types';

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const CRLF = '\r\n';
const HEADER_DELIMITER = Buffer.from(CRLF + CRLF, 'ascii'); // end of header section

/** Default upstream request timeout (ms). */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Hop-by-hop headers (RFC 7230 §6.1). These are meaningful only for a single
 * transport-level connection and MUST NOT be forwarded by a proxy. We strip them
 * from both the inbound (replayed) request and the upstream response before
 * serializing it back into the FULFILL.
 */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Injected request headers so the backend can do per-payer / per-payment logic
 * without ever touching payment or ILP.
 */
export const TOON_PAYER_HEADER = 'X-TOON-Payer';
export const TOON_AMOUNT_HEADER = 'X-TOON-Amount';
export const TOON_CHAIN_HEADER = 'X-TOON-Chain';

// ────────────────────────────────────────────────────────────────────────────
// Envelope codec
// ────────────────────────────────────────────────────────────────────────────

/** A decoded HTTP request envelope. */
export interface HttpRequestEnvelope {
  method: string;
  /** request-target (path + query), e.g. `/greet?x=1`. */
  target: string;
  /** HTTP version token, e.g. `HTTP/1.1`. */
  httpVersion: string;
  /**
   * Header fields in wire order. Each entry is a `[name, value]` pair; names are
   * preserved as-sent (case is NOT normalized) so the message stays byte-faithful.
   */
  headers: Array<[string, string]>;
  /** Raw body bytes (may be empty). */
  body: Buffer;
}

/** Thrown when the PREPARE `data` is not a well-formed HTTP request envelope. */
export class EnvelopeDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeDecodeError';
  }
}

/**
 * Decode an HTTP request envelope from the opaque ILP `data` buffer.
 *
 * Byte-faithful: header ordering and casing are preserved; the body is the raw
 * remainder of the buffer with no re-encoding.
 *
 * @throws {EnvelopeDecodeError} if the request-line or header section is malformed.
 */
export function decodeHttpRequest(data: Buffer): HttpRequestEnvelope {
  if (data.length === 0) {
    throw new EnvelopeDecodeError('empty envelope');
  }

  const delimiterIndex = data.indexOf(HEADER_DELIMITER);
  // If there is no blank line, treat the whole buffer as the head with an empty
  // body (a request with no body and no trailing CRLFCRLF is still valid here).
  let headSection: Buffer;
  let body: Buffer;
  if (delimiterIndex === -1) {
    headSection = data;
    body = Buffer.alloc(0);
  } else {
    headSection = data.subarray(0, delimiterIndex);
    body = data.subarray(delimiterIndex + HEADER_DELIMITER.length);
  }

  const headText = headSection.toString('latin1'); // 1:1 byte<->char, ASCII-safe
  const lines = headText.split(CRLF);
  const requestLine = lines.shift();
  if (!requestLine) {
    throw new EnvelopeDecodeError('missing request-line');
  }

  // request-line = method SP request-target SP HTTP-version
  const firstSpace = requestLine.indexOf(' ');
  const lastSpace = requestLine.lastIndexOf(' ');
  if (firstSpace === -1 || lastSpace === firstSpace) {
    throw new EnvelopeDecodeError(`malformed request-line: "${requestLine}"`);
  }
  const method = requestLine.slice(0, firstSpace);
  const target = requestLine.slice(firstSpace + 1, lastSpace);
  const httpVersion = requestLine.slice(lastSpace + 1);
  if (!method || !target || !httpVersion.startsWith('HTTP/')) {
    throw new EnvelopeDecodeError(`malformed request-line: "${requestLine}"`);
  }

  const headers: Array<[string, string]> = [];
  for (const line of lines) {
    if (line === '') continue; // tolerate stray blank lines
    const colon = line.indexOf(':');
    if (colon === -1) {
      throw new EnvelopeDecodeError(`malformed header line: "${line}"`);
    }
    const name = line.slice(0, colon);
    // RFC 7230: optional leading whitespace after the colon is not part of value.
    const value = line.slice(colon + 1).replace(/^[ \t]+/, '');
    headers.push([name, value]);
  }

  return { method, target, httpVersion, headers, body };
}

/**
 * Encode an HTTP request envelope back to a byte-faithful buffer (the inverse of
 * {@link decodeHttpRequest}). Primarily used by tests and downstream tooling.
 */
export function encodeHttpRequest(env: HttpRequestEnvelope): Buffer {
  const headLines = [`${env.method} ${env.target} ${env.httpVersion}`];
  for (const [name, value] of env.headers) {
    headLines.push(`${name}: ${value}`);
  }
  const head = Buffer.from(headLines.join(CRLF) + CRLF + CRLF, 'latin1');
  return Buffer.concat([head, env.body]);
}

/**
 * Serialize an upstream HTTP response into a byte-faithful HTTP/1.1 response
 * message for the FULFILL `data`:
 *
 *     status-line CRLF
 *     *( header-field CRLF )
 *     CRLF
 *     [ body ]
 */
export function encodeHttpResponse(params: {
  httpVersion: string;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: Buffer;
}): Buffer {
  const statusLine = `${params.httpVersion} ${params.status} ${params.statusText}`.trimEnd();
  const headLines = [statusLine];
  for (const [name, value] of params.headers) {
    headLines.push(`${name}: ${value}`);
  }
  const head = Buffer.from(headLines.join(CRLF) + CRLF + CRLF, 'latin1');
  return Buffer.concat([head, params.body]);
}

// ────────────────────────────────────────────────────────────────────────────
// Handler
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the upstream base URL for a given delivery. Returning `undefined`
 * signals "no route" (→ F02). #218 will provide a route→upstream map; this
 * interface is forward-compatible: pass a function that consults a map.
 */
export type UpstreamResolver = (request: LocalDeliveryRequest) => string | undefined;

/**
 * Derive the `X-TOON-Chain` value from the delivery. Default derives the chain
 * from the ILP destination address (the second label, e.g. `g.<chain>....`);
 * override for richer routing. Returning `undefined` omits the header.
 */
export type ChainResolver = (request: LocalDeliveryRequest) => string | undefined;

export interface HttpProxyHandlerOptions {
  /**
   * Single default upstream base URL (e.g. `http://127.0.0.1:8080`). Mutually
   * usable with — but lower precedence than — {@link upstreamResolver}.
   */
  upstreamUrl?: string;
  /**
   * Per-request upstream resolver. Designed so #218 can inject a route→upstream
   * map without changing this constructor's surface. Takes precedence over
   * {@link upstreamUrl}; if it returns `undefined`, falls back to `upstreamUrl`.
   */
  upstreamResolver?: UpstreamResolver;
  /** Override how `X-TOON-Chain` is derived (default: ILP-address-based). */
  chainResolver?: ChainResolver;
  /** Upstream request timeout in ms (default: 30000). */
  timeoutMs?: number;
  /** `fetch`-compatible client. Defaults to Node's global `fetch` (Node ≥ 22). */
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

/** Default chain derivation: second label of the ILP destination address. */
function defaultChainResolver(request: LocalDeliveryRequest): string | undefined {
  const labels = request.destination.split('.');
  // `g.<chain>.<...>` → labels[1]; `g.alice` → labels[1]. Single-label → undefined.
  return labels.length >= 2 ? labels[1] : undefined;
}

/**
 * Generic HTTP reverse-proxy local-delivery handler.
 *
 * Wire it into a {@link ConnectorNode} via `setLocalDeliveryHandler()`:
 *
 *     const proxy = new HttpProxyHandler({ upstreamUrl: 'http://127.0.0.1:8080' });
 *     node.setLocalDeliveryHandler(proxy.handler);
 *
 * (`setLocalDeliveryHandler` is used rather than `setPacketHandler` because the
 * latter's simplified `PaymentHandler` drops `sourcePeer` — which is the payer
 * identity we need for `X-TOON-Payer`. Both share the same handler slot.)
 */
export class HttpProxyHandler {
  private readonly upstreamUrl?: string;
  private readonly upstreamResolver?: UpstreamResolver;
  private readonly chainResolver: ChainResolver;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: Logger;

  constructor(options: HttpProxyHandlerOptions) {
    if (!options.upstreamUrl && !options.upstreamResolver) {
      throw new Error('HttpProxyHandler requires upstreamUrl or upstreamResolver');
    }
    this.upstreamUrl = options.upstreamUrl;
    this.upstreamResolver = options.upstreamResolver;
    this.chainResolver = options.chainResolver ?? defaultChainResolver;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger?.child({ component: 'HttpProxyHandler' });
  }

  /**
   * The bound {@link LocalDeliveryHandler}. Pass this to
   * `ConnectorNode.setLocalDeliveryHandler()`.
   */
  readonly handler: LocalDeliveryHandler = async (
    request: LocalDeliveryRequest
  ): Promise<LocalDeliveryResponse> => {
    return this.deliver(request);
  };

  private resolveUpstream(request: LocalDeliveryRequest): string | undefined {
    return this.upstreamResolver?.(request) ?? this.upstreamUrl;
  }

  private async deliver(request: LocalDeliveryRequest): Promise<LocalDeliveryResponse> {
    // 1. Decode the literal HTTP request from the opaque PREPARE data (AC1).
    let envelope: HttpRequestEnvelope;
    try {
      const data = request.data ? Buffer.from(request.data, 'base64') : Buffer.alloc(0);
      envelope = decodeHttpRequest(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn({ err: message }, 'Failed to decode HTTP envelope from PREPARE data');
      // Malformed envelope → F01 (invalid packet). Empty data → F06 (no request
      // to proxy = receiver wasn't expecting this payment).
      const code = message === 'empty envelope' ? 'F06' : 'F01';
      return { reject: { code, message: `Invalid HTTP envelope: ${message}` } };
    }

    // 2. Resolve the upstream (AC2/AC3 design hook for #218).
    const upstreamBase = this.resolveUpstream(request);
    if (!upstreamBase) {
      this.logger?.warn({ destination: request.destination }, 'No upstream configured for route');
      return { reject: { code: 'F02', message: 'No upstream route for destination' } };
    }

    // 3. Build the replayed request: strip hop-by-hop headers (AC2), inject
    //    X-TOON-* headers (AC3).
    const outgoingHeaders = new Headers();
    for (const [name, value] of envelope.headers) {
      if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
      // Host is connection-specific to the upstream; let fetch set it.
      if (name.toLowerCase() === 'host') continue;
      outgoingHeaders.append(name, value);
    }
    outgoingHeaders.set(TOON_PAYER_HEADER, request.sourcePeer);
    outgoingHeaders.set(TOON_AMOUNT_HEADER, request.amount);
    const chain = this.chainResolver(request);
    if (chain) outgoingHeaders.set(TOON_CHAIN_HEADER, chain);

    const url = joinUrl(upstreamBase, envelope.target);
    const method = envelope.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD' && envelope.body.length > 0;

    // 4. Replay to upstream over plain HTTP (AC2) and serialize the response (AC4).
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const upstreamRes = await this.fetchImpl(url, {
        method,
        headers: outgoingHeaders,
        body: hasBody ? envelope.body : undefined,
        signal: controller.signal,
      });

      const responseBody = Buffer.from(await upstreamRes.arrayBuffer());
      const responseHeaders: Array<[string, string]> = [];
      upstreamRes.headers.forEach((value, name) => {
        if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) return;
        responseHeaders.push([name, value]);
      });

      const serialized = encodeHttpResponse({
        httpVersion: 'HTTP/1.1',
        status: upstreamRes.status,
        statusText: upstreamRes.statusText || statusTextFor(upstreamRes.status),
        headers: responseHeaders,
        body: responseBody,
      });

      // AC4: upstream 5xx → we still FULFILL and surface the byte-faithful
      // response in the FULFILL `data`. The backend returning 5xx is an
      // application outcome the client paid to observe, not a transport failure,
      // so the connector relays it rather than rejecting. (A reject-on-5xx policy
      // is a human decision — flagged in the PR description.)
      this.logger?.info(
        { url, status: upstreamRes.status, payer: request.sourcePeer },
        'Upstream response proxied into FULFILL'
      );
      return { fulfill: { data: serialized.toString('base64') } };
    } catch (err) {
      // undici surfaces an aborted fetch in several shapes (DOMException
      // 'AbortError', a wrapped TypeError with a cause, or 'TimeoutError'); the
      // controller's own signal is the authoritative source of truth.
      const isAbort =
        controller.signal.aborted ||
        (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'));
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error({ url, err: message }, 'Upstream request failed');
      // Upstream unreachable / network error → T01 (peer unreachable, retryable).
      // Timeout → T00 (temporary internal error, retryable).
      return {
        reject: {
          code: isAbort ? 'T00' : 'T01',
          message: isAbort ? 'Upstream request timed out' : `Upstream unreachable: ${message}`,
        },
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Join an upstream base URL with a request-target, preserving query string. */
function joinUrl(base: string, target: string): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const path = target.startsWith('/') ? target : `/${target}`;
  return `${trimmedBase}${path}`;
}

/** Minimal status-text fallback for codes where fetch leaves statusText blank. */
function statusTextFor(status: number): string {
  const map: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    202: 'Accepted',
    204: 'No Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    400: 'Bad Request',
    401: 'Unauthorized',
    402: 'Payment Required',
    403: 'Forbidden',
    404: 'Not Found',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  };
  return map[status] ?? '';
}
