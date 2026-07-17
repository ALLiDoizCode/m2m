/**
 * Link-State Database for multi-hop route learning (toon-meta#153).
 *
 * Holds the freshest kind:10032 `IlpPeerInfo` announcement per announcer
 * pubkey, reduced to the link-state facts path computation needs: the
 * announcer's reachable prefixes (+cost), its declared adjacency (neighbor
 * Nostr pubkeys), the event timestamp, and the NIP-40 expiry.
 *
 * Semantics mirror Nostr replaceable events (kind 10000-19999): per pubkey,
 * the newest `created_at` wins; an older event for a pubkey we already track
 * is ignored as stale. Freshness is enforced two ways:
 * - at ingest: an already-expired event is skipped;
 * - via {@link LinkStateDatabase.sweepExpired}: a periodic sweep removes
 *   entries whose NIP-40 `expiration` has lapsed, driving route WITHDRAWAL.
 *
 * All parsing of OTHER nodes' content is defensive — malformed content never
 * throws, it just yields an `'invalid'` ingest result the caller can log.
 *
 * @module routing/link-state-db
 */

import {
  EXPIRATION_TAG,
  ILP_PEER_INFO_KIND,
  parseRoutingInfo,
  type IlpPeerInfo,
  type IlpRoutingInfo,
} from '../discovery/ilp-peer-info-event';

/**
 * Minimal structural view of a Nostr event — everything ingest needs, nothing
 * transport-specific, so tests and fake relay clients need no network types.
 */
export interface LinkStateEventInput {
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
}

/** One announcer's link-state record. */
export interface LinkStateEntry {
  /** Announcer Nostr pubkey (64-hex, x-only). */
  pubkey: string;
  /** Sanitized link-state block from the announcement content. */
  routing: IlpRoutingInfo;
  /** Full parsed content (endpoint metadata, e.g. `btpEndpoint` for peer-id mapping). */
  info: IlpPeerInfo;
  /** Event `created_at` (unix seconds) — replaceable-event freshness key. */
  createdAt: number;
  /** NIP-40 expiry (unix seconds), or `null` for a non-expiring announcement. */
  expiresAt: number | null;
}

/** Outcome of a {@link LinkStateDatabase.ingest} call. */
export type LinkStateIngestResult =
  /** Entry stored (new announcer, or superseded a previous announcement). */
  | 'ingested'
  /** Older than (or equal-age to identical) what we already hold; ignored. */
  | 'stale'
  /** Already expired at ingest time; ignored. */
  | 'expired'
  /** Wrong kind, malformed content, or no usable `routing` block; ignored. */
  | 'invalid';

/** 64-char lowercase-hex x-only pubkey (a Nostr pubkey). */
const NOSTR_PUBKEY_RE = /^[0-9a-f]{64}$/;

/**
 * Parse the NIP-40 `expiration` tag off an event. Returns `null` when absent
 * or unparseable (an unparseable expiry is treated as "no expiry" rather than
 * poisoning the event — the periodic full recompute still bounds staleness).
 */
export function parseExpirationTag(tags: string[][]): number | null {
  for (const tag of tags) {
    if (tag[0] === EXPIRATION_TAG && typeof tag[1] === 'string') {
      const value = Number.parseInt(tag[1], 10);
      return Number.isFinite(value) && value > 0 ? value : null;
    }
  }
  return null;
}

/**
 * The link-state database: freshest usable announcement per pubkey.
 */
export class LinkStateDatabase {
  private readonly _entries = new Map<string, LinkStateEntry>();

  /**
   * Ingest a kind:10032 event. Defensive: never throws on malformed input.
   *
   * @param event - The (already signature-verified) event to ingest.
   * @param nowSecs - Current unix time in seconds (injectable for tests).
   * @returns What happened — see {@link LinkStateIngestResult}.
   */
  ingest(
    event: LinkStateEventInput,
    nowSecs: number = Math.floor(Date.now() / 1000)
  ): LinkStateIngestResult {
    if (event.kind !== ILP_PEER_INFO_KIND) return 'invalid';
    if (!NOSTR_PUBKEY_RE.test(event.pubkey)) return 'invalid';
    if (!Number.isFinite(event.created_at)) return 'invalid';

    const expiresAt = parseExpirationTag(event.tags);
    if (expiresAt !== null && expiresAt <= nowSecs) return 'expired';

    const existing = this._entries.get(event.pubkey);
    if (existing && event.created_at <= existing.createdAt) return 'stale';

    let content: unknown;
    try {
      content = JSON.parse(event.content);
    } catch {
      return 'invalid';
    }
    if (!content || typeof content !== 'object' || Array.isArray(content)) return 'invalid';

    const routing = parseRoutingInfo(content);
    if (routing === null) {
      // A newer announcement WITHOUT a routing block supersedes an older one
      // that had one — the announcer stopped participating, so its link-state
      // contribution is withdrawn (replaceable-event semantics).
      if (existing) {
        this._entries.delete(event.pubkey);
        return 'ingested';
      }
      return 'invalid';
    }

    this._entries.set(event.pubkey, {
      pubkey: event.pubkey,
      routing,
      info: content as IlpPeerInfo,
      createdAt: event.created_at,
      expiresAt,
    });
    return 'ingested';
  }

  /**
   * Remove entries whose NIP-40 expiry has lapsed.
   *
   * @param nowSecs - Current unix time in seconds (injectable for tests).
   * @returns The pubkeys whose entries were removed (may be empty).
   */
  sweepExpired(nowSecs: number = Math.floor(Date.now() / 1000)): string[] {
    const removed: string[] = [];
    for (const [pubkey, entry] of this._entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= nowSecs) {
        this._entries.delete(pubkey);
        removed.push(pubkey);
      }
    }
    return removed;
  }

  /** Look up one announcer's entry. */
  get(pubkey: string): LinkStateEntry | undefined {
    return this._entries.get(pubkey);
  }

  /** Snapshot of all current entries. */
  entries(): LinkStateEntry[] {
    return Array.from(this._entries.values());
  }

  /** Number of tracked announcers. */
  get size(): number {
    return this._entries.size;
  }

  /** Drop everything (used on service stop). */
  clear(): void {
    this._entries.clear();
  }
}
