/**
 * ConnectorHttpClient — thin HTTP client over the client edge
 * (`docs/protocol/client-edge-spec.md` §1.1: `POST /ilp`, OER-encoded PREPARE
 * in, OER-encoded FULFILL/REJECT out).
 *
 * Issue #456: the narrow surface `swap`, `town` and `mill` actually depend on
 * is a single `sendPacket`-shaped call — this mirrors {@link
 * import('../core/connector-node').ConnectorNode.sendPacket}'s shape so a
 * caller can swap the embedded connector for this HTTP client with the same
 * call site. It does not remove or replace `ConnectorNode` (that is #457).
 *
 * Transport-agnostic: pass any `fetch`-compatible function (defaults to the
 * global `fetch`), so it works in Node 18+, the browser, and test harnesses.
 * No native dependencies, no prebuilt binaries.
 *
 * @module client/connector-http-client
 */

import {
  serializePacket,
  deserializePacket,
  PacketType,
  isFulfillPacket,
  isRejectPacket,
  type ILPPreparePacket,
  type ILPFulfillPacket,
  type ILPRejectPacket,
} from '@toon-protocol/shared';

const OCTET_STREAM = 'application/octet-stream';

/** Parameters for {@link ConnectorHttpClient.sendPacket} — shaped after
 * `ConnectorNode.sendPacket`'s `SendPacketParams`. */
export interface SendIlpPacketParams {
  /** ILP destination address (RFC-0015 format). */
  destination: string;
  /** Transfer amount in smallest currency unit. */
  amount: bigint;
  /** Packet expiration timestamp. */
  expiresAt: Date;
  /** Optional application data payload. */
  data?: Buffer;
  /** Optional SHA-256 execution condition (exactly 32 bytes); omitted means
   * "no condition" (wire-encoded as 32 zero bytes per RFC-0027). */
  executionCondition?: Uint8Array;
  /**
   * Extra request headers layered onto `POST /ilp` — identity (§1.2,
   * `ILP-Peer-Id`/`Authorization`) and payment claim (§1.3,
   * `ILP-Payment-Channel-Claim`) headers the caller has already built. This
   * client does not construct or validate claims itself.
   */
  headers?: Record<string, string>;
}

export interface ConnectorHttpClientOptions {
  /** Base URL of the connector's client edge, e.g. `http://connector:3000`. Trailing slash optional. */
  baseUrl: string;
  /** Optional `fetch` implementation (defaults to the global `fetch`). */
  fetch?: typeof fetch;
}

/** Thrown when `POST /ilp` returns a non-`200` status — a transport-level
 * failure per client-edge-spec.md §1.1's status table, distinct from an
 * ILP-level REJECT (which is a normal, successful return value). */
export class ConnectorHttpTransportError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Buffer
  ) {
    super(message);
    this.name = 'ConnectorHttpTransportError';
  }
}

export class ConnectorHttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ConnectorHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    const resolved = options.fetch ?? globalThis.fetch;
    if (!resolved) {
      throw new Error('No fetch implementation available; pass one via options.fetch');
    }
    this.fetchImpl = resolved;
  }

  /**
   * Send an ILP Prepare packet over the client edge. `POST /ilp`.
   *
   * @returns The ILP Fulfill or Reject packet the connector decoded from the
   *   response — a Reject is a normal return value, not a thrown error.
   * @throws {ConnectorHttpTransportError} On a non-`200` (transport-level
   *   failure) response.
   */
  async sendPacket(params: SendIlpPacketParams): Promise<ILPFulfillPacket | ILPRejectPacket> {
    const prepare: ILPPreparePacket = {
      type: PacketType.PREPARE,
      destination: params.destination,
      amount: params.amount,
      expiresAt: params.expiresAt,
      data: params.data ?? Buffer.alloc(0),
      ...(params.executionCondition ? { executionCondition: params.executionCondition } : {}),
    };

    const res = await this.fetchImpl(`${this.baseUrl}/ilp`, {
      method: 'POST',
      headers: { ...params.headers, 'content-type': OCTET_STREAM },
      body: serializePacket(prepare),
    });

    const body = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200) {
      throw new ConnectorHttpTransportError(`POST /ilp failed: ${res.status}`, res.status, body);
    }

    const packet = deserializePacket(body);
    if (isFulfillPacket(packet) || isRejectPacket(packet)) {
      return packet;
    }
    throw new ConnectorHttpTransportError(
      'POST /ilp returned an unexpected packet type',
      res.status,
      body
    );
  }
}
