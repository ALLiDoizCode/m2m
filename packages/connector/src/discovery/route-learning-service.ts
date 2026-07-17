/**
 * Route Learning Service — multi-hop link-state route learning over the relay
 * (toon-meta#153, epic anchor).
 *
 * The read-side complement of `SelfAnnounceService`: where that service
 * PUBLISHES this node's kind:10032 `IlpPeerInfo` (now carrying a link-state
 * `routing` block — see `ilp-peer-info-event.ts`), this service CONSUMES every
 * peer's announcements from the relay's free public read endpoint and turns
 * them into actual multi-hop reachability:
 *
 * 1. subscribe to kind:10032 on the configured relay WS URLs;
 * 2. maintain a {@link LinkStateDatabase}: freshest announcement per pubkey,
 *    NIP-40 expiry honored (replaceable-event semantics);
 * 3. compute shortest paths ({@link computeRoutes}: Dijkstra, cost-only v0
 *    metric) rooted at this node's directly-connected peers;
 * 4. install each reachable prefix whose best first hop is a direct peer as a
 *    LEARNED route (`RoutingTable.addLearnedRoute`) at
 *    {@link LEARNED_ROUTE_PRIORITY} — below every static config route, and
 *    never overwriting an existing prefix, so config always wins;
 * 5. WITHDRAW routes when the sourcing announcement expires, is superseded
 *    without the prefix, or its node becomes unreachable — recomputed on every
 *    ingest plus a periodic expiry sweep.
 *
 * Learned routes are soft state: they bypass route persistence entirely and
 * are re-learned from the relay after every boot.
 *
 * The relay transport is injected ({@link RouteLearningRelayClient}) so unit
 * tests drive the service with hand-written fakes and never touch the network.
 *
 * @module discovery/route-learning-service
 */

import type { Logger } from 'pino';
import { verifyEvent as nostrVerifyEvent, type NostrEvent } from 'nostr-tools';
import { isValidILPAddress, type ILPAddress } from '@toon-protocol/shared';
import type { ConnectorConfig, RouteLearningConfig } from '../config/types';
import type { RoutingTable } from '../routing/routing-table';
import { LinkStateDatabase } from '../routing/link-state-db';
import {
  computeRoutes,
  type ComputedRoute,
  type DirectNeighbor,
} from '../routing/path-computation';
import { ILP_PEER_INFO_KIND } from './ilp-peer-info-event';
import { nip59KeyToNostrPubkey } from './self-announce-builder';
import type { RelaySubscriptionHandle, RouteLearningRelayClient } from './nostr-relay-client';
import type { LinkStateEventInput } from '../routing/link-state-db';

/**
 * Narrow structural sink for the discovered-node seam (toon-meta#153,
 * discovered-vs-peered split). Satisfied by
 * {@link ./discovered-node-registry.DiscoveredNodeRegistry}; kept structural so
 * the service has no hard class dependency and tests can hand in fakes.
 *
 * The service feeds it every SIGNATURE-VERIFIED kind:10032 event — including
 * announcements without a link-state `routing` block, which the link-state
 * database rejects but which still identify a discoverable node — plus the
 * periodic expiry sweep, and clears it on stop (soft state). No second relay
 * subscription is ever opened for discovery.
 */
export interface DiscoveredNodeSink {
  ingest(event: LinkStateEventInput, nowSecs?: number): unknown;
  sweepExpired(nowSecs?: number): unknown;
  clear(): void;
}

/** Default seconds between periodic expiry sweeps / recomputes. */
export const DEFAULT_ROUTE_LEARNING_REFRESH_SECS = 60;

/** Default cap on installed learned routes. */
export const DEFAULT_MAX_LEARNED_ROUTES = 1000;

/**
 * Priority for learned routes. Static config routes default to priority 0
 * (and admin/runtime routes are >= 0 in practice), so a strictly negative
 * priority guarantees config wins every equal-prefix-length tie-break; the
 * exact-same-prefix case is fenced separately by `addLearnedRoute` refusing
 * to overwrite non-learned routes.
 */
export const LEARNED_ROUTE_PRIORITY = -100;

export interface RouteLearningServiceDeps {
  /** Full connector config (peers for pubkey mapping; selfAnnounce for relay fallback). */
  config: ConnectorConfig;
  /** The `routeLearning` config block. */
  routeLearning: RouteLearningConfig;
  /** The live routing table learned routes are installed into / withdrawn from. */
  routingTable: RoutingTable;
  /** Injected relay READ transport (fake in unit tests, SimplePool in production). */
  relayClient: RouteLearningRelayClient;
  /**
   * Returns the ids of directly-connected peers (the BTP client peer set) —
   * the only legal first hops for learned routes.
   */
  getDirectPeerIds: () => string[];
  /**
   * This node's own Nostr pubkey (64-hex). Its own announcement in the relay
   * stream is ignored (a node never learns routes to itself). Optional — when
   * unknown, self-filtering is skipped.
   */
  ownPubkey?: string;
  /**
   * Event signature verifier. Defaults to `nostr-tools`' `verifyEvent`;
   * injectable only for tests that need to exercise the rejection path.
   */
  verifyEvent?: (event: NostrEvent) => boolean;
  /**
   * Optional discovered-node registry seam (toon-meta#153). When provided,
   * every verified announcement is mirrored into it and the periodic sweep
   * expires its entries — see {@link DiscoveredNodeSink}.
   */
  discoveredNodes?: DiscoveredNodeSink;
  /** Pino logger. */
  logger: Logger;
}

/**
 * Consumes kind:10032 announcements and maintains learned multi-hop routes.
 */
export class RouteLearningService {
  private readonly _config: ConnectorConfig;
  private readonly _routeLearning: RouteLearningConfig;
  private readonly _routingTable: RoutingTable;
  private readonly _relayClient: RouteLearningRelayClient;
  private readonly _getDirectPeerIds: () => string[];
  private readonly _ownPubkey: string | undefined;
  private readonly _verifyEvent: (event: NostrEvent) => boolean;
  private readonly _discoveredNodes: DiscoveredNodeSink | undefined;
  private readonly _logger: Logger;
  private readonly _refreshIntervalSecs: number;
  private readonly _maxRoutes: number;

  private readonly _db = new LinkStateDatabase();
  /** Currently-installed learned routes: prefix → nextHop peer id. */
  private readonly _installed = new Map<string, string>();

  private _subscription: RelaySubscriptionHandle | null = null;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  constructor(deps: RouteLearningServiceDeps) {
    this._config = deps.config;
    this._routeLearning = deps.routeLearning;
    this._routingTable = deps.routingTable;
    this._relayClient = deps.relayClient;
    this._getDirectPeerIds = deps.getDirectPeerIds;
    this._ownPubkey = deps.ownPubkey;
    this._verifyEvent = deps.verifyEvent ?? nostrVerifyEvent;
    this._discoveredNodes = deps.discoveredNodes;
    this._logger = deps.logger.child({ component: 'RouteLearningService' });

    const refresh = deps.routeLearning.refreshIntervalSecs;
    this._refreshIntervalSecs =
      refresh && refresh > 0 ? Math.floor(refresh) : DEFAULT_ROUTE_LEARNING_REFRESH_SECS;
    const maxRoutes = deps.routeLearning.maxRoutes;
    this._maxRoutes =
      maxRoutes && maxRoutes > 0 ? Math.floor(maxRoutes) : DEFAULT_MAX_LEARNED_ROUTES;
  }

  /** Whether the service is subscribed and sweeping. */
  get running(): boolean {
    return this._running;
  }

  /** Number of announcers currently tracked in the link-state database. */
  get linkStateSize(): number {
    return this._db.size;
  }

  /** Snapshot of currently-installed learned routes (prefix → nextHop). */
  getInstalledRoutes(): ReadonlyMap<string, string> {
    return new Map(this._installed);
  }

  /**
   * Resolve the relay URLs to read from: the explicit `routeLearning.relayUrls`
   * list, else the `selfAnnounce.relayUrl` fallback when present.
   */
  resolveRelayUrls(): string[] {
    const explicit = this._routeLearning.relayUrls;
    if (explicit && explicit.length > 0) {
      return [...explicit];
    }
    const fallback = this._config.selfAnnounce?.relayUrl;
    return fallback ? [fallback] : [];
  }

  /**
   * Start: subscribe to kind:10032 on the resolved relays and begin the
   * periodic expiry sweep. No-ops (with a log) when disabled or when no relay
   * URL is resolvable. Never throws.
   */
  start(): void {
    if (this._running) {
      this._logger.warn('Route learning already running');
      return;
    }
    if (!this._routeLearning.enabled) {
      this._logger.info('Route learning disabled');
      return;
    }
    const relayUrls = this.resolveRelayUrls();
    if (relayUrls.length === 0) {
      this._logger.warn(
        { event: 'route_learning_no_relays' },
        'routeLearning.enabled but no relayUrls configured and no selfAnnounce.relayUrl fallback; not learning'
      );
      return;
    }

    this._subscription = this._relayClient.subscribe(
      relayUrls,
      { kinds: [ILP_PEER_INFO_KIND] },
      (event) => this.handleEvent(event)
    );

    this._timer = setInterval(() => this.sweep(), this._refreshIntervalSecs * 1000);
    this._timer.unref?.();

    this._running = true;
    this._logger.info(
      {
        event: 'route_learning_started',
        relayUrls,
        refreshIntervalSecs: this._refreshIntervalSecs,
        maxRoutes: this._maxRoutes,
      },
      'Route learning service started'
    );
  }

  /**
   * Stop: close the subscription (and the owned relay client's connections),
   * halt the sweep, withdraw every learned route (soft state), and drop the
   * link-state database. Idempotent. The service OWNS the injected relay
   * client's lifecycle — `destroy()` is called here.
   */
  stop(): void {
    if (this._subscription) {
      this._subscription.close();
      this._subscription = null;
    }
    try {
      this._relayClient.destroy();
    } catch (err) {
      this._logger.warn(
        { event: 'route_learning_relay_destroy_failed', err: errMsg(err) },
        'Relay client destroy failed during stop; continuing'
      );
    }
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    for (const prefix of this._installed.keys()) {
      this._routingTable.removeLearnedRoute(prefix);
    }
    this._installed.clear();
    this._db.clear();
    // Discovered set is soft state fed exclusively by this subscription —
    // once the feed stops, the snapshot goes stale, so drop it too.
    this._discoveredNodes?.clear();
    if (this._running) {
      this._logger.info({ event: 'route_learning_stopped' }, 'Route learning service stopped');
    }
    this._running = false;
  }

  /**
   * Ingest one relay event: verify the signature, feed the link-state
   * database, and recompute routes when anything changed. Defensive — a
   * malformed or forged event logs and is skipped, never thrown.
   */
  handleEvent(event: NostrEvent): void {
    let verified: boolean;
    try {
      verified = this._verifyEvent(event);
    } catch {
      verified = false;
    }
    if (!verified) {
      this._logger.warn(
        { event: 'route_learning_bad_signature', pubkey: String(event?.pubkey ?? '').slice(0, 16) },
        'Dropping kind:10032 event with invalid signature'
      );
      return;
    }

    // Discovered-vs-peered seam (toon-meta#153): every verified announcement
    // marks a DISCOVERED node, whether or not it carries a routing block the
    // link-state database can use. The registry does its own defensive
    // parsing and never throws.
    this._discoveredNodes?.ingest(event);

    const result = this._db.ingest(event);
    if (result === 'ingested') {
      this._logger.debug(
        { event: 'route_learning_announcement_ingested', pubkey: event.pubkey.slice(0, 16) },
        'Ingested kind:10032 link-state announcement'
      );
      this.recompute();
    } else if (result === 'invalid') {
      this._logger.warn(
        { event: 'route_learning_announcement_invalid', pubkey: event.pubkey.slice(0, 16) },
        'Skipping malformed kind:10032 announcement'
      );
    } else {
      this._logger.debug(
        { event: 'route_learning_announcement_skipped', reason: result },
        'Skipped kind:10032 announcement'
      );
    }
  }

  /**
   * Periodic sweep: expire lapsed announcements (NIP-40) and recompute —
   * which also picks up direct-peer connectivity changes between ingests.
   */
  sweep(nowSecs: number = Math.floor(Date.now() / 1000)): void {
    this._discoveredNodes?.sweepExpired(nowSecs);
    const removed = this._db.sweepExpired(nowSecs);
    if (removed.length > 0) {
      this._logger.info(
        {
          event: 'route_learning_announcements_expired',
          pubkeys: removed.map((p) => p.slice(0, 16)),
        },
        'Expired stale kind:10032 announcements'
      );
    }
    this.recompute();
  }

  /**
   * Map announcer pubkeys to LOCAL peer ids, from two sources:
   * 1. `peers[].nip59PublicKey` (compressed secp256k1 → x-only Nostr pubkey);
   * 2. announcements whose `btpEndpoint` exactly matches a configured peer's
   *    BTP `url` (lets route learning work before operators add pubkeys).
   * Config-declared pubkeys win over endpoint matches.
   */
  private _buildPubkeyToPeerId(): Map<string, string> {
    const map = new Map<string, string>();
    const urlToPeerId = new Map<string, string>();
    for (const peer of this._config.peers) {
      const pubkey = nip59KeyToNostrPubkey(peer.nip59PublicKey);
      if (pubkey && !map.has(pubkey)) {
        map.set(pubkey, peer.id);
      }
      if (peer.url && !urlToPeerId.has(peer.url)) {
        urlToPeerId.set(peer.url, peer.id);
      }
    }
    for (const entry of this._db.entries()) {
      if (map.has(entry.pubkey)) continue;
      const btpEndpoint = entry.info.btpEndpoint;
      if (typeof btpEndpoint === 'string') {
        const peerId = urlToPeerId.get(btpEndpoint);
        if (peerId !== undefined) {
          map.set(entry.pubkey, peerId);
        }
      }
    }
    return map;
  }

  /**
   * Full recompute: Dijkstra over the current link-state database rooted at
   * the directly-connected peers, then reconcile the routing table — install
   * new/changed learned routes, withdraw ones no longer justified.
   */
  recompute(): void {
    const pubkeyToPeerId = this._buildPubkeyToPeerId();
    const directPeerIds = new Set(this._getDirectPeerIds());
    const neighbors: DirectNeighbor[] = [];
    for (const [pubkey, peerId] of pubkeyToPeerId) {
      if (directPeerIds.has(peerId)) {
        neighbors.push({ pubkey, peerId });
      }
    }

    const computed = computeRoutes(this._db.entries(), neighbors, this._ownPubkey);

    // Validate + cap deterministically: best (lowest) cost wins, then prefix.
    const valid = computed.filter((route) => {
      if (isValidILPAddress(route.prefix)) return true;
      this._logger.warn(
        {
          event: 'route_learning_invalid_prefix',
          prefix: route.prefix,
          pubkey: route.sourcePubkey.slice(0, 16),
        },
        'Skipping learned route with invalid ILP prefix'
      );
      return false;
    });
    valid.sort((a, b) => (a.cost !== b.cost ? a.cost - b.cost : a.prefix < b.prefix ? -1 : 1));
    const desired: ComputedRoute[] = valid.slice(0, this._maxRoutes);

    let installedCount = 0;
    let withdrawnCount = 0;
    const desiredPrefixes = new Set<string>();
    for (const route of desired) {
      desiredPrefixes.add(route.prefix);
      const current = this._installed.get(route.prefix);
      if (current === route.nextHop) continue;
      const ok = this._routingTable.addLearnedRoute(
        route.prefix as ILPAddress,
        route.nextHop,
        LEARNED_ROUTE_PRIORITY
      );
      if (ok) {
        this._installed.set(route.prefix, route.nextHop);
        installedCount++;
      } else {
        // A config/runtime route owns this exact prefix — config wins. Also
        // drop any stale bookkeeping (a runtime add can promote a previously
        // learned prefix out from under us).
        this._installed.delete(route.prefix);
      }
    }

    for (const prefix of Array.from(this._installed.keys())) {
      if (!desiredPrefixes.has(prefix)) {
        this._routingTable.removeLearnedRoute(prefix);
        this._installed.delete(prefix);
        withdrawnCount++;
      }
    }

    if (installedCount > 0 || withdrawnCount > 0) {
      this._logger.info(
        {
          event: 'route_learning_recomputed',
          installed: installedCount,
          withdrawn: withdrawnCount,
          totalLearned: this._installed.size,
          announcers: this._db.size,
          directNeighbors: neighbors.length,
        },
        'Recomputed learned routes'
      );
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
