/**
 * kind:10032 `IlpPeerInfo` announcement builder.
 *
 * A near-exact port of the retired TypeScript connector's
 * `discovery/ilp-peer-info-event.ts` (removed in #465 along with the whole
 * embedded `ConnectorNode`) — same wire format, so this sidecar's announce
 * parses identically under `@toon-protocol/core`'s `parseIlpPeerInfo` and any
 * client that already understood the old connector's announce.
 *
 * Wire format: `kind: 10032`, `content: JSON.stringify(info)`, an optional
 * NIP-40 `["expiration", <unix>]` tag, signed via `finalizeEvent`.
 *
 * kind:10032 sits in NIP-01's REGULAR replaceable range (10000-19999): a
 * relay replaces a node's previous announce by `(pubkey, kind)` alone —
 * there is no `d` tag, and this builder deliberately emits none (matching
 * the retired service exactly; a `d` tag belongs only to the PARAMETERIZED
 * replaceable range, 30000-39999, which kind:10032 is not).
 *
 * @module event
 */

import { finalizeEvent, type NostrEvent } from 'nostr-tools';

/** kind:10032 — regular replaceable (10000-19999) ILP peer info announcement. */
export const ILP_PEER_INFO_KIND = 10032;

/** NIP-40 expiration tag name. */
export const EXPIRATION_TAG = 'expiration';

/**
 * Operator notice (toon#183). A pointer, not the payload — the durable text
 * lives at `url`; this carries only enough for a consumer to decide whether
 * to go read it. Configuration only: this sidecar never composes or infers
 * one, so this shape is declared once here (the wire schema owns it) and
 * reused by everything that carries one.
 */
export interface OperatorNotice {
  id: string;
  severity: 'info' | 'action-required';
  summary: string;
  url: string;
}

/**
 * ILP Peer Info — the kind:10032 content payload this sidecar announces on
 * the Rust edge's behalf. Field names and shapes mirror the retired
 * connector's `IlpPeerInfo` so a kind:10032 consumer (rig, toon-client, any
 * `@toon-protocol/core` parser) needs no changes.
 */
export interface IlpPeerInfo {
  ilpAddress: string;
  ilpAddresses?: string[];
  btpEndpoint: string;
  httpEndpoint?: string;
  relayUrl?: string;
  assetCode: string;
  assetScale: number;
  supportedChains?: string[];
  settlementAddresses?: Record<string, string>;
  tokenNetworks?: Record<string, string>;
  preferredTokens?: Record<string, string>;
  routes: { publish: string; store: string };
  /** Operator notice (toon#183) — see {@link OperatorNotice}. */
  notice?: OperatorNotice;
  /** Allow additional out-of-band content fields to ride along, exactly like core. */
  [key: string]: unknown;
}

/** Options controlling how a kind:10032 announcement event is built. */
export interface BuildIlpPeerInfoOptions {
  /**
   * NIP-40 time-to-live, in seconds. When positive, the event carries an
   * `["expiration", created_at + ttlSeconds]` tag so a stale announcement
   * (this sidecar stopped, or the edge it fronts went dark) expires instead
   * of lingering forever. Omit (or pass a non-positive value) for a
   * non-expiring event.
   */
  ttlSeconds?: number;
  /** Override `created_at` (unix seconds). Defaults to `Date.now()`; exposed for tests. */
  createdAt?: number;
}

/**
 * Build and sign a kind:10032 Nostr event from `IlpPeerInfo` data.
 *
 * @param info - The ILP peer info to serialize into the event content.
 * @param secretKey - The 32-byte Nostr secret key to sign with — the
 *   sidecar's DEDICATED announce identity (never the Rust edge's own ADR
 *   0018 wrap key, which is a different keypair for a different purpose).
 * @param options - Optional build options (e.g. a NIP-40 `ttlSeconds`).
 * @returns A signed Nostr event.
 */
export function buildIlpPeerInfoEvent(
  info: IlpPeerInfo,
  secretKey: Uint8Array,
  options: BuildIlpPeerInfoOptions = {}
): NostrEvent {
  const createdAt = options.createdAt ?? Math.floor(Date.now() / 1000);
  const tags: string[][] = [];
  if (options.ttlSeconds !== undefined && options.ttlSeconds > 0) {
    tags.push([EXPIRATION_TAG, String(createdAt + Math.floor(options.ttlSeconds))]);
  }

  return finalizeEvent(
    {
      kind: ILP_PEER_INFO_KIND,
      content: JSON.stringify(info),
      tags,
      created_at: createdAt,
    },
    secretKey
  );
}
