/**
 * ILP-over-HTTP adapter (RFC-0035).
 *
 * Binds ILP packets to HTTP request/response: a client POSTs an OER-encoded ILP
 * PREPARE and receives an OER-encoded FULFILL/REJECT back. This is the edge
 * transport for one-shot, stateless purchases — a buyer, a NAT'd client, a
 * browser, or an agent that only consumes — complementing BTP (the duplex,
 * session-stateful mesh transport).
 *
 * Design invariant: this adapter is a *thin transport binding*. It converts an
 * HTTP request into exactly the `(protocolData, ilpPacket, peerId)` triple the
 * BTP path produces, then calls the *same* two seams — the inbound claim
 * validator and `PacketHandler.handlePreparePacket` — so validation, routing,
 * fees, and settlement are byte-for-byte identical across transports. No payment
 * validation or 402/x402 challenge logic lives here.
 *
 * Wire format:
 * - Method/path: `POST /ilp`
 * - Request body: OER-encoded ILP PREPARE (`Content-Type: application/octet-stream`)
 * - Claim: carried in `ILP-Payment-Channel-Claim: base64(JSON BTPClaimMessage)`
 *   (or `ILP-Payment-Channel-Claim-Wrapped` for a NIP-59 wrapped claim) — the
 *   same bytes BTP carries as a `payment-channel-claim` protocolData entry.
 * - Identity: `ILP-Peer-Id` + `Authorization: Bearer <secret>` (optional;
 *   anonymous one-shot buyers get an ephemeral peerId derived from the claim).
 * - Response: `200 OK` + OER FULFILL/REJECT body. HTTP non-2xx is reserved for
 *   *transport* errors (malformed 400, auth 401, internal 500); ILP-level
 *   rejects ride in the 200 body, per RFC-0035.
 *
 * @module http/ilp-http-adapter
 * @see RFC-0035 - ILP Over HTTP
 */

import type { IncomingMessage, ServerResponse } from 'http';
import {
  deserializePacket,
  serializePacket,
  PacketType,
  ILPErrorCode,
  type ILPPreparePacket,
  type ILPFulfillPacket,
  type ILPRejectPacket,
} from '@toon-protocol/shared';
import type { BTPProtocolData } from '../btp/btp-types';
import { BTP_CLAIM_PROTOCOL } from '../btp/btp-claim-types';
import { BTP_WRAPPED_CLAIM_PROTOCOL } from '../settlement/privacy/nip59-claim-wrapper';
import { evaluatePeerSecret } from '../auth/peer-secret-resolver';
import type { Logger } from '../utils/logger';

/** Validates an inbound claim; returns null to proceed or an ILPRejectPacket to reject. */
export type InboundClaimValidateFn = (
  protocolData: BTPProtocolData[],
  ilpPacket: ILPPreparePacket,
  peerId: string
) => Promise<ILPRejectPacket | null>;

/** Routes an already-validated PREPARE through the connector. */
export type HandlePrepareFn = (
  ilpPacket: ILPPreparePacket,
  peerId: string,
  protocolData?: BTPProtocolData[]
) => Promise<ILPFulfillPacket | ILPRejectPacket>;

export interface IlpHttpAdapterDeps {
  logger: Logger;
  /** The connector's routing entry point (same one the BTP server calls). */
  handlePrepare: HandlePrepareFn;
  /**
   * The shared inbound claim validator. Optional: when absent (routing-only
   * mode with no payment channels), the adapter skips claim validation exactly
   * as the BTP server does when no validator is wired.
   */
  validateClaim?: InboundClaimValidateFn;
  /**
   * Records inbound claims for event-driven settlement (the ClaimReceiver),
   * mirroring the BTP `onMessage`→ClaimReceiver path so a one-shot `POST /ilp`
   * write credits on-chain settlement identically to a BTP write. Optional:
   * when absent, claims are still validated but not recorded for redemption.
   */
  recordClaim?: (peerId: string, protocolData: BTPProtocolData[]) => Promise<void>;
  /** This connector's ILP node id, used as `triggeredBy` on synthesized rejects. */
  nodeId: string;
  /** Max request body size in bytes (default 5 MiB). */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

/** The ILP-over-HTTP request path this adapter serves. */
export const ILP_HTTP_PATH = '/ilp';

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Best-effort extraction of a stable, claim-bound identity for an anonymous
 * HTTP request. Namespaced with an `http:` prefix so a derived id can never
 * collide with a configured BTP peer (whose env key is `BTP_PEER_<ID>_SECRET`).
 */
function ephemeralPeerIdFromClaim(claimJson: Buffer | undefined): string {
  if (!claimJson) return 'http:anon';
  try {
    const claim = JSON.parse(claimJson.toString('utf8')) as Record<string, unknown>;
    const signer =
      (claim['signerAddress'] as string | undefined) ??
      (claim['signerPublicKey'] as string | undefined);
    return signer ? `http:${signer}` : 'http:anon';
  } catch {
    return 'http:anon';
  }
}

/**
 * ILP-over-HTTP request handler. One instance per connector; `handle()` is
 * mounted on `POST /ilp` by the shared {@link IlpTransportServer}.
 */
export class IlpHttpAdapter {
  private readonly logger: Logger;
  private readonly handlePrepare: HandlePrepareFn;
  private readonly validateClaim?: InboundClaimValidateFn;
  private readonly recordClaim?: (peerId: string, protocolData: BTPProtocolData[]) => Promise<void>;
  private readonly nodeId: string;
  private readonly maxBodyBytes: number;

  constructor(deps: IlpHttpAdapterDeps) {
    this.logger = deps.logger.child({ component: 'IlpHttpAdapter' });
    this.handlePrepare = deps.handlePrepare;
    this.validateClaim = deps.validateClaim;
    this.recordClaim = deps.recordClaim;
    this.nodeId = deps.nodeId;
    this.maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  /**
   * Handle a `POST /ilp` request end-to-end.
   * Never throws — transport failures become HTTP 4xx/5xx, ILP-level outcomes
   * become a 200 + serialized FULFILL/REJECT.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Buffer;
    try {
      body = await this.readBody(req);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.respondText(res, message === 'payload too large' ? 413 : 400, message);
      return;
    }

    // Deserialize the ILP packet and require PREPARE — transport-level checks.
    let prepare: ILPPreparePacket;
    try {
      const packet = deserializePacket(body);
      if (packet.type !== PacketType.PREPARE) {
        this.respondText(res, 400, `Expected ILP PREPARE, got type ${packet.type}`);
        return;
      }
      prepare = packet as ILPPreparePacket;
    } catch (error) {
      this.respondText(
        res,
        400,
        `Malformed ILP packet: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    // Rebuild the BTP-equivalent protocolData from claim headers so the
    // validator path is byte-identical to BTP.
    const protocolData: BTPProtocolData[] = [];
    const claimHeader = firstHeader(req.headers['ilp-payment-channel-claim']);
    const wrappedHeader = firstHeader(req.headers['ilp-payment-channel-claim-wrapped']);
    let plaintextClaim: Buffer | undefined;
    if (claimHeader) {
      plaintextClaim = Buffer.from(claimHeader, 'base64');
      protocolData.push({
        protocolName: BTP_CLAIM_PROTOCOL.NAME,
        contentType: BTP_CLAIM_PROTOCOL.CONTENT_TYPE,
        data: plaintextClaim,
      });
    }
    if (wrappedHeader) {
      protocolData.push({
        protocolName: BTP_WRAPPED_CLAIM_PROTOCOL.NAME,
        contentType: BTP_WRAPPED_CLAIM_PROTOCOL.CONTENT_TYPE,
        data: Buffer.from(wrappedHeader, 'base64'),
      });
    }

    // Resolve identity. A configured peer authenticates via ILP-Peer-Id +
    // Authorization; an anonymous buyer gets an ephemeral, claim-bound id.
    const headerPeerId = firstHeader(req.headers['ilp-peer-id']);
    let peerId: string;
    if (headerPeerId) {
      // A present ILP-Peer-Id with no Authorization header is a no-auth request
      // (secret ''), accepted on permissionless networks — mirroring BTP's
      // `secret: ''` auth frame. HTTP strips a trailing-space bearer, so we
      // cannot rely on `Bearer ` to carry an empty secret; default it here.
      const secret = this.extractBearer(firstHeader(req.headers['authorization'])) ?? '';
      const decision = evaluatePeerSecret(headerPeerId, secret);
      if (!decision.ok) {
        this.logger.warn(
          { event: 'ilp_http_auth_failed', peerId: headerPeerId, reason: decision.reason },
          'ILP-over-HTTP authentication failed'
        );
        this.respondText(res, 401, `Authentication failed: ${decision.reason}`);
        return;
      }
      peerId = headerPeerId;
    } else {
      peerId = ephemeralPeerIdFromClaim(plaintextClaim);
    }

    try {
      // Record the claim for event-driven settlement, independent of the packet
      // outcome — mirroring the BTP onMessage→ClaimReceiver path (which records
      // every message's claim). Best-effort: a recording failure never blocks
      // the ILP response.
      if (this.recordClaim && protocolData.length > 0) {
        await this.recordClaim(peerId, protocolData).catch((err) => {
          this.logger.warn(
            {
              event: 'ilp_http_claim_record_failed',
              peerId,
              error: err instanceof Error ? err.message : String(err),
            },
            'Failed to record inbound claim for settlement'
          );
        });
      }

      // Seam 1: the single claim gate (shared with BTP). Skipped only when no
      // validator is wired (routing-only mode), matching BTP behavior.
      if (this.validateClaim) {
        const rejection = await this.validateClaim(protocolData, prepare, peerId);
        if (rejection) {
          this.logger.warn(
            {
              event: 'ilp_http_claim_rejected',
              peerId,
              destination: prepare.destination,
              code: rejection.code,
            },
            'ILP-over-HTTP PREPARE rejected: claim validation failed'
          );
          this.respondPacket(res, rejection);
          return;
        }
      }

      // Seam 2: routing/fees/forward/settlement (shared with BTP). Pass the
      // claim protocolData so any downstream forwarding carries it.
      const response = await this.handlePrepare(prepare, peerId, protocolData);
      this.respondPacket(res, response);
      this.logger.info(
        {
          event: 'ilp_http_response',
          peerId,
          destination: prepare.destination,
          responseType: response.type === PacketType.FULFILL ? 'FULFILL' : 'REJECT',
        },
        'ILP-over-HTTP response sent'
      );
    } catch (error) {
      // Unexpected internal failure → synthesize a retryable T00 reject in the
      // 200 body (ILP-level), per RFC-0035 response semantics.
      this.logger.error(
        {
          event: 'ilp_http_internal_error',
          peerId,
          error: error instanceof Error ? error.message : String(error),
        },
        'ILP-over-HTTP internal error'
      );
      this.respondPacket(res, {
        type: PacketType.REJECT,
        code: ILPErrorCode.T00_INTERNAL_ERROR,
        triggeredBy: this.nodeId,
        message: 'Internal error processing ILP-over-HTTP request',
        data: Buffer.alloc(0),
      });
    }
  }

  /** Read the request body into a Buffer, enforcing the size cap. */
  private readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > this.maxBodyBytes) {
          req.destroy();
          reject(new Error('payload too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', (err) => reject(err));
    });
  }

  private extractBearer(authHeader: string | undefined): string | undefined {
    if (!authHeader) return undefined;
    const match = /^Bearer\s+(.*)$/i.exec(authHeader.trim());
    return match ? match[1] : authHeader.trim();
  }

  private respondPacket(res: ServerResponse, packet: ILPFulfillPacket | ILPRejectPacket): void {
    const buffer = serializePacket(packet);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  private respondText(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(`${message}\n`);
  }
}
