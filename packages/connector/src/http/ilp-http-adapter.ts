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
 * fees, and settlement are byte-for-byte identical across transports.
 *
 * The one edge-local behaviour is the x402 v2 greeting (issue #217): an UNPAID
 * request to a *locally-terminated* route (one carrying a `RouteTermination` in
 * the injected registry) short-circuits into an HTTP `402 Payment Required`
 * advertising both a vanilla on-chain `exact` option and the `toon-channel`
 * upgrade, *before* the claim-record/validate seams run. This is a self-contained
 * early return that performs no claim *validation* — a present claim simply
 * suppresses the greeting and the request flows through the shared seams
 * unchanged. (#220's verifier wiring is inserted adjacent, just before the seams.)
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
import type { RouteTermination, TerminationChain } from '../config/types';
import {
  buildX402Greeting,
  X402_PAYMENT_REQUIRED_HEADER,
  X402_PAYMENT_SIGNATURE_HEADER,
} from './x402-greeting';
import {
  decodeHttpRequest,
  EnvelopeDecodeError,
  type HttpRequestEnvelope,
} from '../core/handlers/http-proxy-handler';
import { verify as verifyRfc9421Signature, type VerifyFailureCode } from '../auth/rfc9421';

/**
 * Resolves the {@link RouteTermination} for an inbound PREPARE — the seam #217
 * uses to decide whether a destination is a *locally-terminated* route (and thus
 * eligible for the x402 v2 greeting). Sourced from the connector's
 * `RouteTerminationRegistry` (registry.match(prepare.destination)). Returns
 * `null` for an ordinary forwarding destination.
 */
export type ResolveTerminationFn = (prepare: ILPPreparePacket) => RouteTermination | null;

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
  /**
   * Resolves a destination's {@link RouteTermination} (issue #217). When wired
   * (sourced from the connector's `RouteTerminationRegistry` in connector-node)
   * an UNPAID request to a terminated route is greeted with an x402 v2 `402
   * Payment Required`. Optional: when absent the adapter behaves exactly as
   * before (no greeting), so deployments without paid routes are unaffected.
   */
  resolveTermination?: ResolveTerminationFn;
  /**
   * Internal namespaced chainId per chain, e.g. `{ evm: 'evm:8453', solana:
   * 'solana:devnet' }` — sourced from the connector's chainProviders/EVM config.
   * Used to map evm/solana → CAIP-2 `network` ids in the x402 greeting. When a
   * chain has no id here, its vanilla `exact` entry is skipped (mina is always
   * skipped — x402 has no Mina network id — and rides the toon-channel upgrade).
   */
  terminationChainIds?: Partial<Record<TerminationChain, string>>;
}

const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

/** The ILP-over-HTTP request path this adapter serves. */
export const ILP_HTTP_PATH = '/ilp';

/**
 * Map an RFC 9421 verification failure (#220) to the ILP error code the
 * connector rejects the PREPARE with. A `price_mismatch` is an
 * amount/price-class failure → F03 (invalid amount); every other binding
 * failure (digest/signature/keyid/covered-set/malformed/missing) is a packet
 * integrity failure → F01 (invalid packet). The original failure `code` is
 * always carried in the reject `message` for debuggability.
 */
const RFC9421_REJECT_CODE_MAP: Record<VerifyFailureCode, ILPErrorCode> = {
  missing_signature: ILPErrorCode.F01_INVALID_PACKET,
  malformed_signature: ILPErrorCode.F01_INVALID_PACKET,
  unsupported_alg: ILPErrorCode.F01_INVALID_PACKET,
  covered_components_mismatch: ILPErrorCode.F01_INVALID_PACKET,
  missing_component: ILPErrorCode.F01_INVALID_PACKET,
  digest_mismatch: ILPErrorCode.F01_INVALID_PACKET,
  keyid_mismatch: ILPErrorCode.F01_INVALID_PACKET,
  signature_invalid: ILPErrorCode.F01_INVALID_PACKET,
  // price_mismatch is the core anti-replay binding: a cheap claim cannot pay for
  // an expensive route. Treated as an amount/price-class failure (F03).
  price_mismatch: ILPErrorCode.F03_INVALID_AMOUNT,
};

/**
 * Flatten an HTTP-envelope header array (#216 codec, wire order, case-preserved)
 * into the lower-cased `Record<string,string>` the RFC 9421 verifier (#220)
 * expects. Duplicate field names collapse to the last value seen; the MVP
 * covered set (`content-digest`, `toon-price`, `signature`, `signature-input`)
 * is single-valued, so this is sufficient and avoids re-canonicalisation.
 */
function lowerCaseHeaderMap(headers: ReadonlyArray<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    out[name.toLowerCase()] = value;
  }
  return out;
}

/** Strip a query string from an HTTP request-target to get the bare `@path`. */
function pathOf(target: string): string {
  const q = target.indexOf('?');
  return q === -1 ? target : target.slice(0, q);
}

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
  private readonly resolveTermination?: ResolveTerminationFn;
  private readonly terminationChainIds: Partial<Record<TerminationChain, string>>;

  constructor(deps: IlpHttpAdapterDeps) {
    this.logger = deps.logger.child({ component: 'IlpHttpAdapter' });
    this.handlePrepare = deps.handlePrepare;
    this.validateClaim = deps.validateClaim;
    this.recordClaim = deps.recordClaim;
    this.nodeId = deps.nodeId;
    this.maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.resolveTermination = deps.resolveTermination;
    this.terminationChainIds = deps.terminationChainIds ?? {};
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

    // --- x402 v2 greeting (#217) ---
    // Greet an UNPAID request to a locally-terminated route with an x402 v2
    // `402 Payment Required` advertising both the vanilla on-chain `exact`
    // option and the toon-channel upgrade. Self-contained early return: it runs
    // BEFORE the claim-record/validate seams and performs NO claim validation —
    // a present claim merely suppresses the greeting so the request flows through
    // the shared seams unchanged. (#220's verifier wiring goes adjacent, just
    // before the seams in the try-block below; keep this branch standalone.)
    if (this.resolveTermination) {
      const termination = this.resolveTermination(prepare);
      if (termination && this.isUnpaid(protocolData, req)) {
        this.respond402(res, termination, req);
        this.logger.info(
          { event: 'ilp_http_x402_greeting', peerId, destination: prepare.destination },
          'ILP-over-HTTP unpaid terminated request greeted with x402 402'
        );
        return;
      }
    }
    // --- end x402 v2 greeting (#217) ---

    try {
      // --- RFC 9421 claim↔request binding (#220) ---
      // Paid-route path only: when this destination is a locally-terminated
      // route we bind the prepaid claim to the INNER HTTP request that #216
      // proxies (the literal HTTP envelope carried in PREPARE `data`), NOT the
      // outer `POST /ilp`. The signature, content-digest, and `TOON-Price`
      // headers live on that inner envelope. We reach this point only on the
      // PAID path (an unpaid terminated request already early-returned a 402
      // above), so this is the cross-route / cross-price replay defence.
      //
      // Policy (do-no-harm, opt-in enforcement):
      //   - signature PRESENT → ALWAYS verify; on failure reject (never proxy).
      //   - signature ABSENT  → reject (F01) only when requireRequestBinding is
      //     true; otherwise pass through unchanged (claim-only flow preserved).
      const reject = this.checkRequestBinding(prepare);
      if (reject) {
        this.logger.warn(
          {
            event: 'ilp_http_request_binding_rejected',
            peerId,
            destination: prepare.destination,
            code: reject.code,
            detail: reject.message,
          },
          'ILP-over-HTTP PREPARE rejected: RFC 9421 request binding failed'
        );
        this.respondPacket(res, reject);
        return;
      }
      // --- end RFC 9421 claim↔request binding (#220) ---

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

  /**
   * An inbound request is "unpaid" (issue #217) when it carries NO payment
   * proof in either transport form:
   *  - no reconstructed `payment-channel-claim` (or wrapped) protocolData entry
   *    (i.e. no `ILP-Payment-Channel-Claim[-Wrapped]` header), AND
   *  - no x402 v2 `PAYMENT-SIGNATURE` header (the v2 rename of v1's `X-PAYMENT`).
   * Either present → the request is (purportedly) paid; the greeting is
   * suppressed and the shared claim seams below decide the outcome.
   */
  private isUnpaid(protocolData: BTPProtocolData[], req: IncomingMessage): boolean {
    if (protocolData.length > 0) return false;
    const paymentSig = req.headers[X402_PAYMENT_SIGNATURE_HEADER.toLowerCase()];
    return paymentSig === undefined;
  }

  /**
   * Emit the x402 v2 `402 Payment Required` greeting for a locally-terminated
   * route. The v2 `PaymentRequired` object is both serialized into the JSON body
   * (so a client/test can read `accepts` directly) and base64-encoded into the
   * `PAYMENT-REQUIRED` response header per the v2 HTTP transport spec.
   *
   * The connector's own `POST /ilp` URL is derived from the incoming request's
   * `Host` and `X-Forwarded-Proto` headers (set by nginx) so clients can read
   * the payment endpoint directly from the top-level `toon-channel` entry.
   */
  private respond402(
    res: ServerResponse,
    termination: RouteTermination,
    req: IncomingMessage
  ): void {
    const proto = firstHeader(req.headers['x-forwarded-proto']) ?? 'https';
    const host = firstHeader(req.headers['host']);
    const httpEndpoint = host ? `${proto}://${host}${ILP_HTTP_PATH}` : undefined;
    const body = buildX402Greeting(termination, {
      chainIds: this.terminationChainIds,
      resourceUrl: termination.ilpAddress,
      error: `${X402_PAYMENT_SIGNATURE_HEADER} header is required`,
      httpEndpoint,
    });
    const json = JSON.stringify(body);
    res.writeHead(402, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
      [X402_PAYMENT_REQUIRED_HEADER]: Buffer.from(json, 'utf8').toString('base64'),
    });
    res.end(json);
  }

  /**
   * RFC 9421 claim↔request binding check (#220) for the terminated paid path.
   *
   * Returns `null` to proceed (no termination, or no signature present with
   * enforcement off, or signature verified ok) or an {@link ILPRejectPacket} to
   * reject the PREPARE (never proxy). Only runs for terminated routes; ordinary
   * forwarding destinations return `null` immediately so they are untouched.
   *
   * The thing being bound is the INNER HTTP request carried in the PREPARE
   * `data` (the literal HTTP envelope #216 proxies), so the signature,
   * content-digest, and `TOON-Price` headers are read off that inner envelope —
   * NOT the outer `POST /ilp`. `expectedPrice` is the matched route's `price`,
   * compared byte-exactly against the signed `TOON-Price`.
   */
  private checkRequestBinding(prepare: ILPPreparePacket): ILPRejectPacket | null {
    if (!this.resolveTermination) return null;
    const termination = this.resolveTermination(prepare);
    if (!termination) return null; // non-terminated destination → never bind

    const enforce = termination.requireRequestBinding === true;

    // Decode the inner HTTP envelope from PREPARE `data` via the #216 codec.
    // A `data` that is not a well-formed HTTP envelope carries no RFC 9421
    // signature surface to verify: under the do-no-harm default this is a
    // pass-through (the existing claim-only flow); only enforcement rejects it
    // (the inner request could not be proxied by #216 anyway → F01).
    let envelope: HttpRequestEnvelope;
    try {
      envelope = decodeHttpRequest(prepare.data ?? Buffer.alloc(0));
    } catch (err) {
      if (!enforce) return null;
      const detail = err instanceof EnvelopeDecodeError ? err.message : String(err);
      return this.bindingReject(ILPErrorCode.F01_INVALID_PACKET, `malformed_envelope: ${detail}`);
    }

    const headers = lowerCaseHeaderMap(envelope.headers);
    const hasSignature =
      headers['signature'] !== undefined && headers['signature-input'] !== undefined;

    if (!hasSignature) {
      // Absent signature: enforce only when opted in (do-no-harm default).
      if (enforce) {
        return this.bindingReject(ILPErrorCode.F01_INVALID_PACKET, 'missing_signature');
      }
      return null; // pass through to the existing claim-only seams
    }

    // Signature present: ALWAYS verify it, regardless of requireRequestBinding.
    const result = verifyRfc9421Signature(headers, envelope.body, {
      method: envelope.method,
      path: pathOf(envelope.target),
      expectedPrice: termination.price,
    });
    if (result.ok) return null; // bound → proceed to the shared seams

    const code = RFC9421_REJECT_CODE_MAP[result.code];
    const detail = result.detail ? `${result.code}: ${result.detail}` : result.code;
    return this.bindingReject(code, detail);
  }

  /** Build an ILP REJECT for a request-binding failure, with the code in-message. */
  private bindingReject(code: ILPErrorCode, detail: string): ILPRejectPacket {
    return {
      type: PacketType.REJECT,
      code,
      triggeredBy: this.nodeId,
      message: `RFC 9421 request binding failed: ${detail}`,
      data: Buffer.alloc(0),
    };
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
