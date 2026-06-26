/**
 * Self-announce publish PLAN (relay#37 / store#22).
 *
 * Pure, side-effect-free logic that turns a signed kind:10032 event + the
 * connector's own routing knowledge into a `sendPacket` plan. The connector
 * then executes the plan through its OWN pipe (`ConnectorNode.sendPacket`), so
 * routing decides free-vs-paid:
 *
 * - **Locally terminated** `announceTo` (this connector fronts the relay) →
 *   `amount = 0`. `sendPacket` routes the PREPARE to this node's own delivery
 *   handler (the `HttpProxyHandler` for the terminated route), which reverse-
 *   proxies the inner `POST /write` to the route's resolved upstream. Local
 *   delivery returns BEFORE the forward/claim path, so **no claim is attached =
 *   free**.
 * - **Remote** `announceTo` (a relay this connector forwards to) → `amount > 0`.
 *   `sendPacket` forwards the PREPARE to the next-hop peer, and the forward path
 *   attaches a mandatory per-packet settlement claim funded from the connector's
 *   OWN channel (`PerPacketClaimService.generateClaimForPacket`) — the connector
 *   **pays for its own write**, like any client.
 *
 * `amount > 0` is therefore the SINGLE thing that distinguishes paid from free:
 * the connector attaches a claim iff `forwardingPacket.amount > 0n` on a
 * value-bearing forward to a non-`child` peer (see `PacketHandler`).
 *
 * The announcement rides inside the PREPARE `data` as the literal `POST /write`
 * HTTP envelope (the same wire format `HttpProxyHandler` decodes), body
 * `{ "event": <NostrEvent> }` — exactly what the relay's private store expects.
 *
 * @module discovery/self-announce-publish
 */

import type { NostrEvent } from 'nostr-tools';
import { encodeHttpRequest } from '../core/handlers/http-proxy-handler';

/** Default price (atomic units) paid on the remote/forwarded publish branch. */
export const DEFAULT_ANNOUNCE_PRICE = '1000';

/** Whether the publish resolves to a free local delivery or a paid forward. */
export type AnnouncePublishMode = 'local-free' | 'remote-paid';

/** A concrete `sendPacket` plan for publishing the announcement. */
export interface AnnouncePublishPlan {
  /** ILP destination to route the write through (`selfAnnounce.announceTo`). */
  destination: string;
  /**
   * PREPARE amount. `0n` for a locally-terminated (free) write; the configured
   * `announcePrice` (> 0) for a remote (paid) write — the value that triggers
   * the per-packet settlement claim.
   */
  amount: bigint;
  /** Resolution outcome, for logging/telemetry. */
  mode: AnnouncePublishMode;
  /** The literal `POST /write` HTTP envelope carrying `{ event }`, for PREPARE `data`. */
  data: Buffer;
}

/**
 * Encode the inner `POST /write` HTTP request envelope carrying `{ event }`.
 *
 * Byte-faithful HTTP/1.1 as `HttpProxyHandler.decodeHttpRequest` expects; the
 * handler strips `Host` and lets the HTTP client set `Content-Length`.
 */
export function encodeWriteEnvelope(event: NostrEvent): Buffer {
  const body = Buffer.from(JSON.stringify({ event }), 'utf8');
  return encodeHttpRequest({
    method: 'POST',
    target: '/write',
    httpVersion: 'HTTP/1.1',
    headers: [
      ['Host', 'relay'],
      ['Content-Type', 'application/json'],
      ['Content-Length', String(body.length)],
    ],
    body,
  });
}

/**
 * Build the publish plan from the signed event and the connector's routing
 * knowledge.
 *
 * @param announceTo - The ILP route to publish through (`selfAnnounce.announceTo`).
 * @param event - The signed kind:10032 announcement.
 * @param isLocallyTerminated - Whether `announceTo` matches a local terminated
 *   route (i.e. `routeTerminationRegistry.match(announceTo)` is truthy).
 * @param remotePriceAtomic - Price (atomic units) to pay on the remote branch.
 * @returns A `sendPacket` plan: `amount = 0` (free local) or `> 0` (paid remote).
 */
export function planAnnouncePublish(args: {
  announceTo: string;
  event: NostrEvent;
  isLocallyTerminated: boolean;
  remotePriceAtomic?: string;
}): AnnouncePublishPlan {
  const data = encodeWriteEnvelope(args.event);
  if (args.isLocallyTerminated) {
    return { destination: args.announceTo, amount: 0n, mode: 'local-free', data };
  }
  const price = args.remotePriceAtomic ?? DEFAULT_ANNOUNCE_PRICE;
  return {
    destination: args.announceTo,
    amount: BigInt(price),
    mode: 'remote-paid',
    data,
  };
}
