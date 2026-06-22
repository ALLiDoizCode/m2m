/**
 * ILP-over-HTTP egress (RFC-0035) — outbound counterpart of {@link IlpHttpAdapter}.
 *
 * Today inter-connector forwarding is BTP-only: {@link PacketHandler.forwardToNextHop}
 * dials a peer's BTP WebSocket. Some peers, however, expose an ILP-over-HTTP
 * *ingress* (the `POST /ilp` surface served by {@link IlpHttpAdapter}) and no BTP
 * server at all. This module lets the connector FORWARD a PREPARE to such a peer.
 *
 * Design:
 * - {@link PeerEgress} is the protocol-agnostic egress seam — the exact shape
 *   `BTPClientManager` already implements. {@link HttpPeerClientManager} is the
 *   HTTP implementation; both satisfy `PeerEgress`, so the forwarding seam can
 *   dispatch on a peer's configured protocol with a single call shape.
 * - The network-agent axis (direct vs SOCKS5/Tor) is *orthogonal* and stays in
 *   {@link TransportProvider}. `HttpPeerClientManager` CONSUMES a
 *   `TransportProvider` to obtain the `http.Agent` for each request, so
 *   ATOR/SOCKS egress composes for free.
 *
 * Wire symmetry (the load-bearing invariant): the bytes this egress emits are
 * exactly what {@link IlpHttpAdapter} accepts on `POST /ilp`:
 * - body = OER `serializePacket(prepare)`, `Content-Type: application/octet-stream`
 * - `ILP-Peer-Id: <this node id>` + `Authorization: Bearer <authToken>`
 * - any `payment-channel-claim` / wrapped-claim `protocolData` entry re-encoded
 *   into the `ILP-Payment-Channel-Claim` / `ILP-Payment-Channel-Claim-Wrapped`
 *   base64 header (the exact inverse of the ingress header→protocolData rebuild).
 *
 * @module transport/http-peer-transport
 * @see http/ilp-http-adapter — the ingress this egress targets
 * @see RFC-0035 — ILP Over HTTP
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import {
  serializePacket,
  deserializePacket,
  PacketType,
  ILPErrorCode,
  type ILPPreparePacket,
  type ILPFulfillPacket,
  type ILPRejectPacket,
} from '@toon-protocol/shared';
import type { Logger } from '../utils/logger';
import type { TransportProvider } from './transport-provider';
import type { Peer } from '../btp/btp-client';
import type { BTPProtocolData } from '../btp/btp-types';
import { BTP_CLAIM_PROTOCOL } from '../btp/btp-claim-types';
import { BTP_WRAPPED_CLAIM_PROTOCOL } from '../settlement/privacy/nip59-claim-wrapper';

/** Default ILP-over-HTTP egress path — the REAL shipped ingress path ({@link ILP_HTTP_PATH}). */
export const DEFAULT_ILP_HTTP_EGRESS_PATH = '/ilp';

/** Default per-request timeout (ms) when a packet carries no `expiresAt`. */
const DEFAULT_HTTP_TIMEOUT_MS = 30000;

/**
 * Thrown when the HTTP transport cannot reach the peer (connection refused,
 * DNS failure, socket reset). {@link PacketHandler.forwardToNextHop} maps this
 * to ILP `T01_PEER_UNREACHABLE`, mirroring how `BTPConnectionError` is mapped.
 */
export class HttpPeerConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpPeerConnectionError';
    Error.captureStackTrace(this, HttpPeerConnectionError);
  }
}

/**
 * Thrown when the peer does not respond within the packet's remaining validity.
 * Mapped to ILP `R00_TRANSFER_TIMED_OUT` (matching the BTP egress timeout map).
 */
export class HttpPeerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpPeerTimeoutError';
    Error.captureStackTrace(this, HttpPeerTimeoutError);
  }
}

/**
 * Per-peer egress configuration consumed by {@link HttpPeerClientManager}.
 * Mirrors the {@link BTPClientManager} `Peer` record for the HTTP transport.
 */
export interface HttpPeer {
  /** Unique peer identifier (matches route nextHop). */
  id: string;
  /** Full http(s) endpoint of the peer's ILP-over-HTTP ingress (origin only; path appended). */
  httpUrl: string;
  /** Optional path override (default {@link DEFAULT_ILP_HTTP_EGRESS_PATH}). */
  httpPath?: string;
  /** Shared secret sent as `Authorization: Bearer <authToken>`. */
  authToken: string;
  /** Optional fixed per-request timeout (ms). When absent, derived from `packet.expiresAt`. */
  httpTimeoutMs?: number;
}

/**
 * Protocol-agnostic peer egress seam.
 *
 * The exact shape {@link BTPClientManager} already implements — extracted so the
 * forwarding seam can hold either a BTP or an HTTP egress and dispatch on a
 * peer's configured protocol with a single call shape. `BTPClientManager`
 * satisfies this as-is.
 */
export interface PeerEgress {
  /**
   * Send an ILP PREPARE to a peer and resolve with its FULFILL/REJECT.
   * @param peerId - Target peer identifier.
   * @param packet - ILP PREPARE to forward.
   * @param protocolData - Optional BTP-equivalent sub-protocol entries (e.g. claims).
   */
  sendToPeer(
    peerId: string,
    packet: ILPPreparePacket,
    protocolData?: BTPProtocolData[]
  ): Promise<ILPFulfillPacket | ILPRejectPacket>;

  /** Whether the peer is currently reachable/registered for egress. */
  isConnected(peerId: string): boolean;

  /**
   * Register a peer for egress. The concrete record type depends on the
   * implementation: {@link BTPClientManager} takes a BTP {@link Peer},
   * {@link HttpPeerClientManager} takes an {@link HttpPeer}. Typed as the union
   * so both managers satisfy this seam (method params are bivariant).
   */
  addPeer(peer: Peer | HttpPeer): Promise<void>;

  /** Deregister a peer and release any pooled resources. */
  removePeer(peerId: string): Promise<void>;

  /** List registered peer ids (used by admin idempotent re-registration). */
  getPeerIds(): string[];
}

/**
 * ILP-over-HTTP egress manager — the HTTP implementation of {@link PeerEgress}.
 *
 * Holds one registered {@link HttpPeer} per id and emits, per `sendToPeer`, the
 * symmetric `POST /ilp` the connector's own {@link IlpHttpAdapter} ingress
 * accepts. The `http.Agent` for each request comes from the injected
 * {@link TransportProvider} (so SOCKS5/ATOR egress composes); when the provider
 * returns `undefined` (direct transport), a keep-alive pooled agent is used so
 * 100-concurrent forwards reuse sockets.
 */
export class HttpPeerClientManager implements PeerEgress {
  private readonly _peers = new Map<string, HttpPeer>();
  private readonly _logger: Logger;
  private readonly _nodeId: string;
  private readonly _transportProvider: TransportProvider;
  /** Pooled keep-alive agents for direct (non-SOCKS) egress, keyed by `http|https`. */
  private readonly _keepAliveHttp: http.Agent;
  private readonly _keepAliveHttps: https.Agent;

  /**
   * @param nodeId - This connector's ILP node id, sent as `ILP-Peer-Id`.
   * @param logger - Pino logger.
   * @param transportProvider - Network-agent source. `createAgent(httpUrl)` is
   *   called per request; `undefined` (direct) falls back to the pooled keep-alive agent.
   */
  constructor(nodeId: string, logger: Logger, transportProvider: TransportProvider) {
    this._nodeId = nodeId;
    this._logger = logger.child({ component: 'HttpPeerClientManager' });
    this._transportProvider = transportProvider;
    this._keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 256 });
    this._keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 256 });
  }

  async addPeer(peer: HttpPeer): Promise<void> {
    if (this._peers.has(peer.id)) {
      this._logger.warn(
        { event: 'http_peer_exists', peerId: peer.id },
        'HTTP peer already exists, skipping'
      );
      return;
    }
    this._peers.set(peer.id, peer);
    this._logger.info(
      {
        event: 'http_peer_added',
        peerId: peer.id,
        path: peer.httpPath ?? DEFAULT_ILP_HTTP_EGRESS_PATH,
      },
      'HTTP egress peer registered'
    );
  }

  async removePeer(peerId: string): Promise<void> {
    if (this._peers.delete(peerId)) {
      this._logger.info({ event: 'http_peer_removed', peerId }, 'HTTP egress peer removed');
    } else {
      this._logger.warn(
        { event: 'http_peer_not_found', peerId },
        'HTTP egress peer not found, cannot remove'
      );
    }
  }

  /**
   * A registered HTTP peer is always considered "connected": HTTP is
   * connectionless, so reachability is only known at send time. Returning `true`
   * lets the forwarding seam route to this peer; an unreachable endpoint then
   * surfaces as `HttpPeerConnectionError` → T01 at send time (same outcome as a
   * BTP peer whose socket drops between the connectivity check and the send).
   */
  isConnected(peerId: string): boolean {
    return this._peers.has(peerId);
  }

  /** List registered HTTP egress peer ids. */
  getPeerIds(): string[] {
    return Array.from(this._peers.keys());
  }

  async sendToPeer(
    peerId: string,
    packet: ILPPreparePacket,
    protocolData?: BTPProtocolData[]
  ): Promise<ILPFulfillPacket | ILPRejectPacket> {
    const peer = this._peers.get(peerId);
    if (!peer) {
      throw new HttpPeerConnectionError(`HTTP peer not found: ${peerId}`);
    }

    const body = serializePacket(packet);
    const headers = this.buildHeaders(peer, body, protocolData);
    const { target, agent, isHttps } = this.resolveTarget(peer);
    const timeoutMs = this.resolveTimeoutMs(peer, packet);

    this._logger.debug(
      { event: 'http_peer_send', peerId, destination: packet.destination, timeoutMs },
      'Sending PREPARE to HTTP peer'
    );

    const responseBody = await this.post(target, agent, isHttps, headers, body, timeoutMs, peerId);

    // HTTP 200 carried a serialized FULFILL/REJECT (per RFC-0035). Deserialize
    // and return it; anything else was already converted to a synthesized reject
    // (or thrown) inside `post`.
    const decoded = deserializePacket(responseBody);
    if (decoded.type !== PacketType.FULFILL && decoded.type !== PacketType.REJECT) {
      throw new HttpPeerConnectionError(
        `HTTP peer ${peerId} returned non-FULFILL/REJECT packet type ${decoded.type}`
      );
    }
    this._logger.debug(
      { event: 'http_peer_response', peerId, responseType: decoded.type },
      'Received response from HTTP peer'
    );
    return decoded as ILPFulfillPacket | ILPRejectPacket;
  }

  /**
   * Build the symmetric request headers. Re-encodes any claim protocolData entry
   * into the base64 header the ingress rebuilds it from — the exact inverse of
   * {@link IlpHttpAdapter}'s header→protocolData logic.
   */
  private buildHeaders(
    peer: HttpPeer,
    body: Buffer,
    protocolData?: BTPProtocolData[]
  ): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': body.length,
      'ILP-Peer-Id': this._nodeId,
    };

    // Only send Authorization for a non-empty secret. An empty authToken is a
    // valid no-auth request, but a literal `Authorization: Bearer ` header has
    // its trailing whitespace stripped on the wire and would arrive as the
    // non-empty secret "Bearer" at the ingress (whose extractBearer then fails
    // the `Bearer\s+` form). Omitting the header lets the ingress default the
    // secret to '' → no-auth, exactly as it documents.
    if (peer.authToken !== '') {
      headers.Authorization = `Bearer ${peer.authToken}`;
    }

    if (protocolData) {
      for (const entry of protocolData) {
        if (entry.protocolName === BTP_CLAIM_PROTOCOL.NAME) {
          headers['ILP-Payment-Channel-Claim'] = entry.data.toString('base64');
        } else if (entry.protocolName === BTP_WRAPPED_CLAIM_PROTOCOL.NAME) {
          headers['ILP-Payment-Channel-Claim-Wrapped'] = entry.data.toString('base64');
        }
      }
    }

    return headers;
  }

  /** Resolve the request target URL + agent (SOCKS from provider, else pooled keep-alive). */
  private resolveTarget(peer: HttpPeer): { target: URL; agent: http.Agent; isHttps: boolean } {
    const path = peer.httpPath ?? DEFAULT_ILP_HTTP_EGRESS_PATH;
    const target = new URL(path, peer.httpUrl);
    const isHttps = target.protocol === 'https:';

    // SOCKS/ATOR egress composes: the TransportProvider may return a
    // SocksProxyAgent. Direct transport returns undefined → pooled keep-alive.
    const providerAgent = this._transportProvider.createAgent(peer.httpUrl);
    const agent = providerAgent ?? (isHttps ? this._keepAliveHttps : this._keepAliveHttp);
    return { target, agent, isHttps };
  }

  /**
   * Per-request timeout. Prefer the packet's remaining validity (mirrors BTP
   * egress: remaining − 500ms buffer, floor 1000ms); fall back to the peer's
   * fixed `httpTimeoutMs` or the module default.
   */
  private resolveTimeoutMs(peer: HttpPeer, packet: ILPPreparePacket): number {
    if (packet.expiresAt) {
      const remaining = packet.expiresAt.getTime() - Date.now();
      return Math.max(remaining - 500, 1000);
    }
    return peer.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  }

  /**
   * Perform the POST. Resolves with the raw 200 body, or:
   * - throws {@link HttpPeerTimeoutError} on timeout → R00 upstream,
   * - throws {@link HttpPeerConnectionError} on socket/DNS error → T01 upstream,
   * - resolves with a synthesized REJECT body for any non-2xx status.
   */
  private post(
    target: URL,
    agent: http.Agent,
    isHttps: boolean,
    headers: http.OutgoingHttpHeaders,
    body: Buffer,
    timeoutMs: number,
    peerId: string
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const requestFn = isHttps ? https.request : http.request;
      const req = requestFn(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          path: target.pathname + target.search,
          method: 'POST',
          headers,
          agent,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            const resBody = Buffer.concat(chunks);
            if (status >= 200 && status < 300) {
              resolve(resBody);
              return;
            }
            // Non-2xx: an HTTP *transport* error. Synthesize the matching ILP
            // reject so the forwarding path returns a packet rather than throwing.
            resolve(serializePacket(this.synthesizeReject(status, peerId, resBody)));
          });
          res.on('error', (err) =>
            reject(
              new HttpPeerConnectionError(`HTTP peer ${peerId} response error: ${err.message}`)
            )
          );
        }
      );

      req.on('timeout', () => {
        req.destroy(new HttpPeerTimeoutError(`HTTP peer ${peerId} timed out after ${timeoutMs}ms`));
      });

      req.on('error', (err) => {
        if (err instanceof HttpPeerTimeoutError) {
          reject(err);
          return;
        }
        reject(new HttpPeerConnectionError(`HTTP peer ${peerId} request error: ${err.message}`));
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Map a non-2xx HTTP status to an ILP reject:
   * - 401 → T01 (matches BTP auth-failure handling: a temporary peer-reach problem),
   * - other 4xx → F00 (final, bad request — the peer rejected our request shape),
   * - 5xx / everything else → T01 (peer temporarily unreachable / overloaded).
   */
  private synthesizeReject(status: number, peerId: string, _resBody: Buffer): ILPRejectPacket {
    let code: ILPErrorCode;
    if (status === 401) {
      code = ILPErrorCode.T01_PEER_UNREACHABLE;
    } else if (status >= 400 && status < 500) {
      code = ILPErrorCode.F00_BAD_REQUEST;
    } else {
      code = ILPErrorCode.T01_PEER_UNREACHABLE;
    }
    this._logger.warn(
      { event: 'http_peer_non_2xx', peerId, status, code },
      'HTTP peer returned non-2xx; synthesizing ILP reject'
    );
    return {
      type: PacketType.REJECT,
      code,
      triggeredBy: this._nodeId,
      message: `HTTP peer ${peerId} returned HTTP ${status}`,
      data: Buffer.alloc(0),
    };
  }
}
