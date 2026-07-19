/**
 * Discovered Node Registry — the "discovered" half of the discovered-vs-peered
 * split (toon-meta#153).
 *
 * Tracks every node KNOWN from kind:10032 `IlpPeerInfo` relay ingest, keyed by
 * announcer pubkey. Discovery is FREE and unbounded: a discovered node is
 * routable-through (multi-hop, via the RouteLearningService's learned routes)
 * without any link, channel, or capital commitment. "Peered" — a funded
 * settlement channel — is a separate, deliberate, bounded operator choice:
 * promote a discovered node via the EXISTING `POST /admin/peers`
 * (`ConnectorNode.registerPeer`), whose admission is capped by
 * `peeringPolicy.maxFundedChannels`.
 *
 * This registry deliberately does NOT open links to discovered nodes — that
 * was the capital-explosion failure mode of the dormant HTTP
 * `PeerDiscoveryService` (N discovered nodes → pressure toward N funded
 * channels). The epic's thesis: sparse channels, dense reachability.
 *
 * Soft state, mirroring the link-state database:
 * - populated from the RouteLearningService's ingest seam (no second relay
 *   subscription) — every signature-verified kind:10032 event lands here,
 *   including announcements WITHOUT a link-state `routing` block;
 * - replaceable-event semantics per pubkey (newest `created_at` wins);
 * - entries expire with their announcement's NIP-40 `expiration` tag on the
 *   periodic sweep;
 * - cleared on service stop; re-learned from the relay after every boot.
 *
 * The `funded` flag on each listed entry is computed at read time against the
 * connector's LIVE registered peers (injected via {@link FundedPeerRef}s):
 * a discovered node is funded when a currently-registered peer maps to it,
 * matched by the configured peer's `nip59PublicKey` (converted to the x-only
 * Nostr pubkey) or — as a fallback — by the announced `btpEndpoint` equalling
 * the peer's BTP `url`.
 *
 * @module discovery/discovered-node-registry
 */

import type { Logger } from 'pino';
import { ILP_PEER_INFO_KIND } from './ilp-peer-info-event';
import { parseExpirationTag, type LinkStateEventInput } from '../routing/link-state-db';

/** 64-char lowercase-hex x-only pubkey (a Nostr pubkey). */
const NOSTR_PUBKEY_RE = /^[0-9a-f]{64}$/;

/**
 * A discovered node, as surfaced to operators (`GET /admin/discovered-nodes`,
 * `ConnectorNode.getDiscoveredNodes()`). All timestamps are unix SECONDS,
 * matching the kind:10032 `created_at` / NIP-40 `expiration` conventions.
 */
export interface DiscoveredNode {
  /** Announcer Nostr pubkey (64-hex, x-only) — the registry key. */
  pubkey: string;
  /** Primary ILP address announced by the node. */
  ilpAddress: string;
  /** All announced ILP addresses (defaults to `[ilpAddress]`). */
  ilpAddresses: string[];
  /** BTP WebSocket endpoint — what `POST /admin/peers` takes as `url` on promotion. */
  btpEndpoint: string;
  /** ILP-over-HTTP ingress URL (RFC-0035), when announced. */
  httpEndpoint?: string;
  /** Public Nostr relay WS URL for free reads, when announced. */
  relayUrl?: string;
  /** Asset code for the announced peering relationship (e.g. `USDC`). */
  assetCode: string;
  /** Asset scale (decimal places). */
  assetScale: number;
  /** Supported settlement chain ids (e.g. `["evm:31337"]`), when announced. */
  supportedChains?: string[];
  /** Chain id → settlement address hints for the promotion settlement block. */
  settlementAddresses?: Record<string, string>;
  /** When this node was FIRST seen by this connector (unix seconds). */
  firstSeenAt: number;
  /** When the freshest announcement for this node was ingested (unix seconds). */
  lastSeenAt: number;
  /** NIP-40 expiry of the freshest announcement (unix seconds); absent = non-expiring. */
  expiresAt?: number;
  /**
   * Whether a LIVE registered peer currently maps to this node (see module
   * docs for the matching rules). `false` = discovered-but-unfunded: reachable
   * through learned multi-hop routes, candidate for deliberate promotion.
   */
  funded: boolean;
}

/**
 * A currently-registered (live) peer, reduced to the fields funded-matching
 * needs. Supplied by the connector at read time so the registry never holds a
 * stale copy of the peer set.
 */
export interface FundedPeerRef {
  /** Local peer id. */
  peerId: string;
  /** X-only Nostr pubkey derived from the configured `nip59PublicKey`, when known. */
  nostrPubkey?: string;
  /** The peer's BTP `url` — endpoint-equality fallback match. */
  btpUrl?: string;
}

/** Outcome of a {@link DiscoveredNodeRegistry.ingest} call. */
export type DiscoveredNodeIngestResult =
  /** New announcer — a node was discovered. */
  | 'discovered'
  /** Known announcer superseded by a fresher announcement — updated in place. */
  | 'updated'
  /** Older than (or equal-age to) what we already hold; ignored. */
  | 'stale'
  /** Already expired at ingest time; ignored. */
  | 'expired'
  /** This connector's own announcement; ignored (a node never discovers itself). */
  | 'self'
  /** Wrong kind, malformed content, or missing required peer-info fields; ignored. */
  | 'invalid';

export interface DiscoveredNodeRegistryDeps {
  /**
   * Returns the connector's LIVE registered peers (funded-matching source).
   * Called on every `list()`/`counts()` so results always reflect the current
   * peer set (a `removePeer` immediately un-funds the discovered entry).
   */
  getFundedPeers: () => FundedPeerRef[];
  /**
   * This node's own Nostr pubkey (64-hex). Its own announcement in the relay
   * stream is skipped. Optional — when unknown, self-filtering is skipped.
   */
  ownPubkey?: string;
  /** Pino logger. */
  logger: Logger;
}

/** Internal entry — {@link DiscoveredNode} minus the read-time `funded` flag. */
interface StoredNode {
  pubkey: string;
  ilpAddress: string;
  ilpAddresses: string[];
  btpEndpoint: string;
  httpEndpoint?: string;
  relayUrl?: string;
  assetCode: string;
  assetScale: number;
  supportedChains?: string[];
  settlementAddresses?: Record<string, string>;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Replaceable-event freshness key (`created_at`, unix seconds). */
  createdAt: number;
  expiresAt?: number;
}

/**
 * In-memory registry of nodes discovered from kind:10032 ingest.
 */
export class DiscoveredNodeRegistry {
  private readonly _getFundedPeers: () => FundedPeerRef[];
  private readonly _ownPubkey: string | undefined;
  private readonly _logger: Logger;
  private readonly _nodes = new Map<string, StoredNode>();

  constructor(deps: DiscoveredNodeRegistryDeps) {
    this._getFundedPeers = deps.getFundedPeers;
    this._ownPubkey = deps.ownPubkey;
    this._logger = deps.logger.child({ component: 'DiscoveredNodeRegistry' });
  }

  /**
   * Ingest one (already signature-verified) kind:10032 event. Defensive —
   * malformed content never throws, it yields an `'invalid'` result.
   *
   * @param event - Structural Nostr event view (transport-free, fakeable).
   * @param nowSecs - Current unix time in seconds (injectable for tests).
   */
  ingest(
    event: LinkStateEventInput,
    nowSecs: number = Math.floor(Date.now() / 1000)
  ): DiscoveredNodeIngestResult {
    if (event.kind !== ILP_PEER_INFO_KIND) return 'invalid';
    if (!NOSTR_PUBKEY_RE.test(event.pubkey)) return 'invalid';
    if (!Number.isFinite(event.created_at)) return 'invalid';
    if (this._ownPubkey !== undefined && event.pubkey === this._ownPubkey) return 'self';

    const expiresAt = parseExpirationTag(event.tags);
    if (expiresAt !== null && expiresAt <= nowSecs) return 'expired';

    const existing = this._nodes.get(event.pubkey);
    if (existing && event.created_at <= existing.createdAt) return 'stale';

    const parsed = parseDiscoveredPeerInfo(event.content);
    if (parsed === null) return 'invalid';

    const stored: StoredNode = {
      ...parsed,
      pubkey: event.pubkey,
      firstSeenAt: existing ? existing.firstSeenAt : nowSecs,
      lastSeenAt: nowSecs,
      createdAt: event.created_at,
      ...(expiresAt !== null ? { expiresAt } : {}),
    };
    this._nodes.set(event.pubkey, stored);

    if (existing) {
      this._logger.debug(
        {
          event: 'node_updated',
          pubkey: event.pubkey.slice(0, 16),
          ilpAddress: stored.ilpAddress,
          expiresAt: stored.expiresAt ?? null,
        },
        'Discovered node updated by a fresher announcement'
      );
      return 'updated';
    }

    this._logger.info(
      {
        event: 'node_discovered',
        pubkey: event.pubkey.slice(0, 16),
        ilpAddress: stored.ilpAddress,
        btpEndpoint: stored.btpEndpoint,
        expiresAt: stored.expiresAt ?? null,
        discovered: this._nodes.size,
      },
      'Discovered node from kind:10032 announcement'
    );
    return 'discovered';
  }

  /**
   * Remove entries whose NIP-40 expiry has lapsed (soft state — a node that
   * stops re-announcing vanishes with its announcement).
   *
   * @param nowSecs - Current unix time in seconds (injectable for tests).
   * @returns The pubkeys whose entries were removed (may be empty).
   */
  sweepExpired(nowSecs: number = Math.floor(Date.now() / 1000)): string[] {
    const removed: string[] = [];
    for (const [pubkey, node] of this._nodes) {
      if (node.expiresAt !== undefined && node.expiresAt <= nowSecs) {
        this._nodes.delete(pubkey);
        removed.push(pubkey);
        this._logger.info(
          {
            event: 'node_expired',
            pubkey: pubkey.slice(0, 16),
            ilpAddress: node.ilpAddress,
            discovered: this._nodes.size,
          },
          'Discovered node expired with its announcement'
        );
      }
    }
    return removed;
  }

  /**
   * Snapshot of the discovered set with the read-time `funded` flag, sorted
   * by ILP address for stable operator output.
   */
  list(): DiscoveredNode[] {
    const fundedPeers = this._getFundedPeers();
    return Array.from(this._nodes.values())
      .map((node) => ({
        pubkey: node.pubkey,
        ilpAddress: node.ilpAddress,
        ilpAddresses: [...node.ilpAddresses],
        btpEndpoint: node.btpEndpoint,
        ...(node.httpEndpoint !== undefined ? { httpEndpoint: node.httpEndpoint } : {}),
        ...(node.relayUrl !== undefined ? { relayUrl: node.relayUrl } : {}),
        assetCode: node.assetCode,
        assetScale: node.assetScale,
        ...(node.supportedChains !== undefined
          ? { supportedChains: [...node.supportedChains] }
          : {}),
        ...(node.settlementAddresses !== undefined
          ? { settlementAddresses: { ...node.settlementAddresses } }
          : {}),
        firstSeenAt: node.firstSeenAt,
        lastSeenAt: node.lastSeenAt,
        ...(node.expiresAt !== undefined ? { expiresAt: node.expiresAt } : {}),
        funded: isFundedBy(node, fundedPeers),
      }))
      .sort((a, b) => (a.ilpAddress < b.ilpAddress ? -1 : a.ilpAddress > b.ilpAddress ? 1 : 0));
  }

  /** Number of tracked discovered nodes (gauge-friendly). */
  size(): number {
    return this._nodes.size;
  }

  /** Gauge-friendly counts: total discovered vs the funded subset. */
  counts(): { discovered: number; funded: number } {
    const fundedPeers = this._getFundedPeers();
    let funded = 0;
    for (const node of this._nodes.values()) {
      if (isFundedBy(node, fundedPeers)) funded++;
    }
    return { discovered: this._nodes.size, funded };
  }

  /** Drop everything (service stop — soft state is re-learned after boot). */
  clear(): void {
    this._nodes.clear();
  }
}

/**
 * Funded-matching rule: a live registered peer maps to the discovered node
 * when its configured Nostr pubkey equals the announcer pubkey, or — the
 * fallback for operators who have not configured `nip59PublicKey` — when the
 * announced `btpEndpoint` exactly equals the peer's BTP `url`.
 */
function isFundedBy(node: StoredNode, fundedPeers: FundedPeerRef[]): boolean {
  for (const peer of fundedPeers) {
    if (peer.nostrPubkey !== undefined && peer.nostrPubkey === node.pubkey) return true;
    if (peer.btpUrl !== undefined && peer.btpUrl === node.btpEndpoint) return true;
  }
  return false;
}

/**
 * Defensively parse the peer-info fields the registry stores out of a
 * kind:10032 content string produced by SOMEONE ELSE. Requires the wire
 * type's mandatory fields (`ilpAddress`, `btpEndpoint`, `assetCode`,
 * `assetScale`); optional fields are copied only when well-typed, and
 * malformed individual optional entries are dropped rather than poisoning
 * the whole announcement. Never throws.
 */
function parseDiscoveredPeerInfo(
  content: string
): Omit<StoredNode, 'pubkey' | 'firstSeenAt' | 'lastSeenAt' | 'createdAt' | 'expiresAt'> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;

  const { ilpAddress, btpEndpoint, assetCode, assetScale } = raw;
  if (typeof ilpAddress !== 'string' || ilpAddress.length === 0) return null;
  if (typeof btpEndpoint !== 'string' || btpEndpoint.length === 0) return null;
  if (typeof assetCode !== 'string' || assetCode.length === 0) return null;
  if (typeof assetScale !== 'number' || !Number.isFinite(assetScale)) return null;

  const ilpAddresses = Array.isArray(raw.ilpAddresses)
    ? raw.ilpAddresses.filter((a): a is string => typeof a === 'string' && a.length > 0)
    : [];

  const supportedChains = Array.isArray(raw.supportedChains)
    ? raw.supportedChains.filter((c): c is string => typeof c === 'string' && c.length > 0)
    : undefined;

  let settlementAddresses: Record<string, string> | undefined;
  if (
    raw.settlementAddresses &&
    typeof raw.settlementAddresses === 'object' &&
    !Array.isArray(raw.settlementAddresses)
  ) {
    settlementAddresses = {};
    for (const [chain, address] of Object.entries(raw.settlementAddresses)) {
      if (typeof address === 'string' && address.length > 0) {
        settlementAddresses[chain] = address;
      }
    }
  }

  return {
    ilpAddress,
    ilpAddresses: ilpAddresses.length > 0 ? ilpAddresses : [ilpAddress],
    btpEndpoint,
    ...(typeof raw.httpEndpoint === 'string' && raw.httpEndpoint.length > 0
      ? { httpEndpoint: raw.httpEndpoint }
      : {}),
    ...(typeof raw.relayUrl === 'string' && raw.relayUrl.length > 0
      ? { relayUrl: raw.relayUrl }
      : {}),
    assetCode,
    assetScale,
    ...(supportedChains && supportedChains.length > 0 ? { supportedChains } : {}),
    ...(settlementAddresses && Object.keys(settlementAddresses).length > 0
      ? { settlementAddresses }
      : {}),
  };
}
