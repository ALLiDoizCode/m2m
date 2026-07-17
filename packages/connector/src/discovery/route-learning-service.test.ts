/**
 * Unit tests for the RouteLearningService (toon-meta#153).
 *
 * Per the repo's mock-free policy, the relay transport is a hand-written
 * in-memory fake (`FakeRelayClient`, an honest `RouteLearningRelayClient`
 * implementation — no network), and every ingested event is REAL: built and
 * Schnorr-signed with `nostr-tools` under freshly generated keys, so the
 * production signature-verification path runs for real.
 *
 * Covers: lifecycle (disabled / no-relays / start / stop), relay URL fallback,
 * ingest → learned-route install (config pubkeys and btpEndpoint mapping),
 * config-route precedence, withdrawal on NIP-40 expiry / supersede /
 * unreachability, malformed + forged event resilience, self-exclusion, and
 * the maxRoutes cap.
 *
 * @module discovery/route-learning-service.test
 */

import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools';
import { createLogger } from '../utils/logger';
import type { ConnectorConfig, RouteLearningConfig } from '../config/types';
import { RoutingTable } from '../routing/routing-table';
import { buildIlpPeerInfoEvent, ILP_PEER_INFO_KIND, type IlpPeerInfo } from './ilp-peer-info-event';
import type {
  RelayEventFilter,
  RelaySubscriptionHandle,
  RouteLearningRelayClient,
} from './nostr-relay-client';
import { LEARNED_ROUTE_PRIORITY, RouteLearningService } from './route-learning-service';

const logger = createLogger('route-learning-test', 'silent');

const skSelf = generateSecretKey();
const pkSelf = getPublicKey(skSelf);
const skB = generateSecretKey();
const pkB = getPublicKey(skB);
const skC = generateSecretKey();
const pkC = getPublicKey(skC);

/** An honest in-memory RouteLearningRelayClient — records calls, no network. */
class FakeRelayClient implements RouteLearningRelayClient {
  subscribeCalls: Array<{ relayUrls: string[]; filter: RelayEventFilter }> = [];
  onEvent: ((event: NostrEvent) => void) | null = null;
  closeCount = 0;
  destroyCount = 0;

  subscribe(
    relayUrls: string[],
    filter: RelayEventFilter,
    onEvent: (event: NostrEvent) => void
  ): RelaySubscriptionHandle {
    this.subscribeCalls.push({ relayUrls, filter });
    this.onEvent = onEvent;
    return {
      close: () => {
        this.closeCount++;
      },
    };
  }

  destroy(): void {
    this.destroyCount++;
  }

  deliver(event: NostrEvent): void {
    this.onEvent?.(event);
  }
}

function makeConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    nodeId: 'connector-self',
    btpServerPort: 3000,
    environment: 'development',
    peers: [
      {
        id: 'peer-b',
        url: 'ws://peer-b:3000',
        authToken: 'secret-b',
        nip59PublicKey: `02${pkB}`,
      },
    ],
    routes: [],
    ...overrides,
  } as ConnectorConfig;
}

/** Build + sign a real kind:10032 announcement carrying a link-state block. */
function announcement(
  sk: Uint8Array,
  routing: IlpPeerInfo['routing'],
  opts: { ttlSeconds?: number; createdAt?: number; btpEndpoint?: string } = {}
): NostrEvent {
  const info: IlpPeerInfo = {
    ilpAddress: 'g.node',
    btpEndpoint: opts.btpEndpoint ?? '',
    assetCode: 'USDC',
    assetScale: 6,
    ...(routing ? { routing } : {}),
  };
  if (opts.createdAt !== undefined) {
    // Explicit created_at (supersede tests need strictly increasing stamps).
    const tags: string[][] = [];
    if (opts.ttlSeconds !== undefined && opts.ttlSeconds > 0) {
      tags.push(['expiration', String(opts.createdAt + opts.ttlSeconds)]);
    }
    return finalizeEvent(
      {
        kind: ILP_PEER_INFO_KIND,
        content: JSON.stringify(info),
        tags,
        created_at: opts.createdAt,
      },
      sk
    );
  }
  return buildIlpPeerInfoEvent(info, sk, {
    ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
  });
}

interface Harness {
  service: RouteLearningService;
  relay: FakeRelayClient;
  routingTable: RoutingTable;
}

function makeHarness(
  opts: {
    routeLearning?: RouteLearningConfig;
    config?: ConnectorConfig;
    routingTable?: RoutingTable;
    directPeerIds?: string[];
  } = {}
): Harness {
  const relay = new FakeRelayClient();
  const routingTable = opts.routingTable ?? new RoutingTable();
  const service = new RouteLearningService({
    config: opts.config ?? makeConfig(),
    routeLearning: opts.routeLearning ?? { enabled: true, relayUrls: ['wss://relay.test'] },
    routingTable,
    relayClient: relay,
    getDirectPeerIds: () => opts.directPeerIds ?? ['peer-b'],
    ownPubkey: pkSelf,
    logger,
  });
  return { service, relay, routingTable };
}

describe('RouteLearningService', () => {
  describe('lifecycle', () => {
    it('does not start when disabled', () => {
      const { service, relay } = makeHarness({ routeLearning: { enabled: false } });
      service.start();
      expect(service.running).toBe(false);
      expect(relay.subscribeCalls).toHaveLength(0);
    });

    it('does not start when no relay URLs resolve', () => {
      const { service, relay } = makeHarness({ routeLearning: { enabled: true } });
      service.start();
      expect(service.running).toBe(false);
      expect(relay.subscribeCalls).toHaveLength(0);
    });

    it('subscribes to kind:10032 on the configured relays', () => {
      const { service, relay } = makeHarness({
        routeLearning: { enabled: true, relayUrls: ['wss://r1.test', 'wss://r2.test'] },
      });
      service.start();
      expect(service.running).toBe(true);
      expect(relay.subscribeCalls).toEqual([
        { relayUrls: ['wss://r1.test', 'wss://r2.test'], filter: { kinds: [10032] } },
      ]);
      service.stop();
    });

    it('falls back to selfAnnounce.relayUrl when relayUrls is omitted', () => {
      const config = makeConfig({
        selfAnnounce: {
          enabled: true,
          announceTo: 'g.proxy.relay',
          relayUrl: 'wss://announce-relay.test',
        },
      });
      const { service, relay } = makeHarness({ config, routeLearning: { enabled: true } });
      service.start();
      expect(service.running).toBe(true);
      expect(relay.subscribeCalls[0]?.relayUrls).toEqual(['wss://announce-relay.test']);
      service.stop();
    });

    it('stop() closes the subscription, destroys the relay client, and withdraws learned routes', () => {
      const { service, relay, routingTable } = makeHarness();
      service.start();
      relay.deliver(announcement(skB, { prefixes: [{ prefix: 'g.b' }], adjacency: [] }));
      expect(routingTable.getNextHop('g.b.dest')).toBe('peer-b');

      service.stop();
      expect(service.running).toBe(false);
      expect(relay.closeCount).toBe(1);
      expect(relay.destroyCount).toBe(1);
      expect(routingTable.getNextHop('g.b.dest')).toBeNull();
      expect(service.getInstalledRoutes().size).toBe(0);
      expect(service.linkStateSize).toBe(0);

      // Idempotent.
      service.stop();
      expect(relay.closeCount).toBe(1);
    });
  });

  describe('ingest and install', () => {
    it('installs a direct neighbor prefix as a learned route below config priority', () => {
      const { service, relay, routingTable } = makeHarness();
      service.start();

      relay.deliver(
        announcement(skB, { prefixes: [{ prefix: 'g.b.store', cost: 0 }], adjacency: [] })
      );

      expect(routingTable.getNextHop('g.b.store.blob1')).toBe('peer-b');
      expect(routingTable.getLearnedRoutes()).toEqual([
        { prefix: 'g.b.store', nextHop: 'peer-b', priority: LEARNED_ROUTE_PRIORITY },
      ]);
      service.stop();
    });

    it('learns multi-hop prefixes through the adjacency graph', () => {
      const { service, relay, routingTable } = makeHarness();
      service.start();

      // B (direct) declares C as a neighbor; C announces g.c.
      relay.deliver(announcement(skB, { prefixes: [{ prefix: 'g.b' }], adjacency: [pkC] }));
      relay.deliver(announcement(skC, { prefixes: [{ prefix: 'g.c' }], adjacency: [pkB] }));

      expect(routingTable.getNextHop('g.b.x')).toBe('peer-b');
      expect(routingTable.getNextHop('g.c.wallet')).toBe('peer-b');
      expect(service.getInstalledRoutes().get('g.c')).toBe('peer-b');
      service.stop();
    });

    it('maps an announcer to a peer by btpEndpoint when no nip59PublicKey is configured', () => {
      const config = makeConfig({
        peers: [{ id: 'peer-b', url: 'ws://peer-b:3000', authToken: 'secret-b' }],
      });
      const { service, relay, routingTable } = makeHarness({ config });
      service.start();

      relay.deliver(
        announcement(
          skB,
          { prefixes: [{ prefix: 'g.b' }], adjacency: [] },
          { btpEndpoint: 'ws://peer-b:3000' }
        )
      );

      expect(routingTable.getNextHop('g.b.x')).toBe('peer-b');
      service.stop();
    });

    it('never overwrites a static config route for the same prefix (config wins)', () => {
      const routingTable = new RoutingTable([{ prefix: 'g.b', nextHop: 'peer-config' }]);
      const { service, relay } = makeHarness({ routingTable });
      service.start();

      relay.deliver(announcement(skB, { prefixes: [{ prefix: 'g.b' }], adjacency: [] }));

      expect(routingTable.getNextHop('g.b.x')).toBe('peer-config');
      expect(service.getInstalledRoutes().has('g.b')).toBe(false);
      service.stop();
    });

    it('ignores announcers whose first hop is not a directly-connected peer', () => {
      const { service, relay, routingTable } = makeHarness({ directPeerIds: [] });
      service.start();

      relay.deliver(announcement(skB, { prefixes: [{ prefix: 'g.b' }], adjacency: [] }));

      expect(routingTable.getNextHop('g.b.x')).toBeNull();
      service.stop();
    });

    it("ignores this node's own announcement", () => {
      const { service, relay, routingTable } = makeHarness();
      service.start();

      relay.deliver(announcement(skSelf, { prefixes: [{ prefix: 'g.self' }], adjacency: [pkB] }));

      expect(routingTable.getNextHop('g.self.x')).toBeNull();
      service.stop();
    });

    it('caps installed routes at maxRoutes, best cost first', () => {
      const { service, relay, routingTable } = makeHarness({
        routeLearning: { enabled: true, relayUrls: ['wss://relay.test'], maxRoutes: 1 },
      });
      service.start();

      // g.near costs 1 (direct), g.far costs 2 (via C).
      relay.deliver(announcement(skB, { prefixes: [{ prefix: 'g.near' }], adjacency: [pkC] }));
      relay.deliver(announcement(skC, { prefixes: [{ prefix: 'g.far' }], adjacency: [] }));

      expect(routingTable.getNextHop('g.near.x')).toBe('peer-b');
      expect(routingTable.getNextHop('g.far.x')).toBeNull();
      expect(service.getInstalledRoutes().size).toBe(1);
      service.stop();
    });

    it('skips learned routes with invalid ILP prefixes without throwing', () => {
      const { service, relay, routingTable } = makeHarness();
      service.start();

      relay.deliver(
        announcement(skB, {
          prefixes: [{ prefix: 'NOT A VALID ILP ADDRESS' }, { prefix: 'g.ok' }],
          adjacency: [],
        })
      );

      expect(routingTable.getNextHop('g.ok.x')).toBe('peer-b');
      expect(service.getInstalledRoutes().size).toBe(1);
      service.stop();
    });
  });

  describe('withdrawal', () => {
    it('withdraws routes when the sourcing announcement expires (NIP-40 sweep)', () => {
      const { service, relay, routingTable } = makeHarness();
      service.start();

      relay.deliver(
        announcement(skB, { prefixes: [{ prefix: 'g.b' }], adjacency: [pkC] }, { ttlSeconds: 60 })
      );
      relay.deliver(announcement(skC, { prefixes: [{ prefix: 'g.c' }], adjacency: [] }));
      expect(routingTable.getNextHop('g.b.x')).toBe('peer-b');
      expect(routingTable.getNextHop('g.c.x')).toBe('peer-b');

      // Past B's expiry: B's own prefix is withdrawn AND C (reachable only
      // through B's adjacency) becomes unreachable — withdrawn too.
      service.sweep(Math.floor(Date.now() / 1000) + 120);

      expect(routingTable.getNextHop('g.b.x')).toBeNull();
      expect(routingTable.getNextHop('g.c.x')).toBeNull();
      expect(service.getInstalledRoutes().size).toBe(0);
      service.stop();
    });

    it('withdraws a prefix dropped by a superseding announcement', () => {
      const { service, relay, routingTable } = makeHarness();
      service.start();

      const base = Math.floor(Date.now() / 1000);
      relay.deliver(
        announcement(
          skB,
          { prefixes: [{ prefix: 'g.b1' }, { prefix: 'g.b2' }], adjacency: [] },
          { createdAt: base }
        )
      );
      expect(routingTable.getNextHop('g.b1.x')).toBe('peer-b');
      expect(routingTable.getNextHop('g.b2.x')).toBe('peer-b');

      // Newer replaceable event keeps only g.b1.
      relay.deliver(
        announcement(
          skB,
          { prefixes: [{ prefix: 'g.b1' }], adjacency: [] },
          { createdAt: base + 10 }
        )
      );

      expect(routingTable.getNextHop('g.b1.x')).toBe('peer-b');
      expect(routingTable.getNextHop('g.b2.x')).toBeNull();
      service.stop();
    });

    it('ignores a STALE (older) announcement instead of regressing', () => {
      const { service, relay, routingTable } = makeHarness();
      service.start();

      const base = Math.floor(Date.now() / 1000);
      relay.deliver(
        announcement(skB, { prefixes: [{ prefix: 'g.new' }], adjacency: [] }, { createdAt: base })
      );
      relay.deliver(
        announcement(
          skB,
          { prefixes: [{ prefix: 'g.old' }], adjacency: [] },
          { createdAt: base - 60 }
        )
      );

      expect(routingTable.getNextHop('g.new.x')).toBe('peer-b');
      expect(routingTable.getNextHop('g.old.x')).toBeNull();
      service.stop();
    });

    it('withdraws routes when the direct peer disappears from the peer set', () => {
      const directPeerIds: string[] = ['peer-b'];
      const relay = new FakeRelayClient();
      const routingTable = new RoutingTable();
      const service = new RouteLearningService({
        config: makeConfig(),
        routeLearning: { enabled: true, relayUrls: ['wss://relay.test'] },
        routingTable,
        relayClient: relay,
        getDirectPeerIds: () => [...directPeerIds],
        ownPubkey: pkSelf,
        logger,
      });
      service.start();

      relay.deliver(announcement(skB, { prefixes: [{ prefix: 'g.b' }], adjacency: [] }));
      expect(routingTable.getNextHop('g.b.x')).toBe('peer-b');

      directPeerIds.length = 0; // peer removed
      service.sweep();

      expect(routingTable.getNextHop('g.b.x')).toBeNull();
      service.stop();
    });
  });

  describe('resilience', () => {
    it('drops events with forged signatures', () => {
      const { service, relay, routingTable } = makeHarness();
      service.start();

      const genuine = announcement(skB, { prefixes: [{ prefix: 'g.b' }], adjacency: [] });
      // Round-trip through JSON, exactly like an event arriving off the relay
      // wire (this also strips nostr-tools' verified-cache symbol, which an
      // object spread would otherwise carry over), then tamper with it.
      const forged = JSON.parse(JSON.stringify(genuine)) as NostrEvent;
      forged.content = JSON.stringify({
        ilpAddress: 'g.evil',
        routing: { prefixes: [{ prefix: 'g.evil' }], adjacency: [] },
      });
      relay.deliver(forged);

      expect(routingTable.getNextHop('g.evil.x')).toBeNull();
      expect(service.linkStateSize).toBe(0);
      service.stop();
    });

    it('never throws on malformed announcement content', () => {
      const { service, relay, routingTable } = makeHarness();
      service.start();

      const garbage = finalizeEvent(
        {
          kind: ILP_PEER_INFO_KIND,
          content: 'not json at all {{{',
          tags: [],
          created_at: Math.floor(Date.now() / 1000),
        },
        skB
      );
      expect(() => relay.deliver(garbage)).not.toThrow();

      const wrongShape = finalizeEvent(
        {
          kind: ILP_PEER_INFO_KIND,
          content: JSON.stringify({ routing: { prefixes: 'nope', adjacency: null } }),
          tags: [],
          created_at: Math.floor(Date.now() / 1000),
        },
        skB
      );
      expect(() => relay.deliver(wrongShape)).not.toThrow();

      expect(routingTable.getLearnedRoutes()).toEqual([]);
      expect(service.linkStateSize).toBe(0);
      service.stop();
    });

    it('ignores non-10032 kinds', () => {
      const { service, relay } = makeHarness();
      service.start();

      const note = finalizeEvent(
        { kind: 1, content: 'hello', tags: [], created_at: Math.floor(Date.now() / 1000) },
        skB
      );
      expect(() => relay.deliver(note)).not.toThrow();
      expect(service.linkStateSize).toBe(0);
      service.stop();
    });
  });
});
