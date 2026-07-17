/**
 * Public API surface test for the discovery barrel (toon-meta#153).
 *
 * The barrel is the module boundary `ConnectorNode` and external consumers
 * import from, so every value export is pinned here: removing or renaming one
 * (or wiring a re-export to the wrong module) is a breaking change this test
 * catches. Constants are additionally pinned to the concrete modules'
 * values so the barrel cannot silently drift from its sources.
 *
 * @module discovery/index.test
 */

import * as discovery from './index';
import { ILP_PEER_INFO_KIND as SOURCE_ILP_PEER_INFO_KIND } from './ilp-peer-info-event';
import { FALLBACK_RELAY_SEEDS as SOURCE_FALLBACK_RELAY_SEEDS } from './bootstrap-seeds';
import { BOOTSTRAP_PROBE_SUB_ID as SOURCE_BOOTSTRAP_PROBE_SUB_ID } from './relay-probe';

describe('discovery barrel public API', () => {
  it('exports the peer discovery and self-announce surface', () => {
    expect(typeof discovery.PeerDiscoveryService).toBe('function');
    expect(typeof discovery.SelfAnnounceService).toBe('function');
    expect(typeof discovery.DEFAULT_REFRESH_INTERVAL_SECS).toBe('number');
    expect(typeof discovery.buildCapabilityDirectory).toBe('function');
    expect(typeof discovery.buildSelfAnnouncementInfo).toBe('function');
    expect(typeof discovery.buildRoutingInfo).toBe('function');
    expect(typeof discovery.deriveChainSettlementParams).toBe('function');
    expect(typeof discovery.nip59KeyToNostrPubkey).toBe('function');
    expect(typeof discovery.normalizeSettlementAddressKeys).toBe('function');
    expect(typeof discovery.resolveRouteHints).toBe('function');
    expect(typeof discovery.PUBLISH_HINT_CAPABILITY).toBe('string');
    expect(typeof discovery.STORE_HINT_CAPABILITY).toBe('string');
    expect(typeof discovery.planAnnouncePublish).toBe('function');
    expect(typeof discovery.encodeWriteEnvelope).toBe('function');
    expect(typeof discovery.DEFAULT_ANNOUNCE_PRICE).toBe('string');
  });

  it('exports the kind:10032 wire-format surface', () => {
    expect(typeof discovery.buildIlpPeerInfoEvent).toBe('function');
    expect(typeof discovery.parseRoutingInfo).toBe('function');
    expect(typeof discovery.parseCapabilityDirectory).toBe('function');
    expect(typeof discovery.normalizeCapabilityName).toBe('function');
    expect(discovery.ILP_PEER_INFO_KIND).toBe(SOURCE_ILP_PEER_INFO_KIND);
    expect(discovery.ILP_PEER_INFO_KIND).toBe(10032);
    expect(typeof discovery.EXPIRATION_TAG).toBe('string');
    expect(discovery.CAPABILITY_NAME_PATTERN).toBeInstanceOf(RegExp);
  });

  it('exports the route learning surface', () => {
    expect(typeof discovery.RouteLearningService).toBe('function');
    expect(typeof discovery.DEFAULT_ROUTE_LEARNING_REFRESH_SECS).toBe('number');
    expect(typeof discovery.DEFAULT_MAX_LEARNED_ROUTES).toBe('number');
    expect(typeof discovery.LEARNED_ROUTE_PRIORITY).toBe('number');
    expect(typeof discovery.createNostrRelayClient).toBe('function');
  });

  it('exports the discovered-node registry surface', () => {
    expect(typeof discovery.DiscoveredNodeRegistry).toBe('function');
  });

  it('exports the cold-start bootstrap surface', () => {
    expect(typeof discovery.BootstrapService).toBe('function');
    expect(typeof discovery.DEFAULT_SAMPLE_SIZE).toBe('number');
    expect(typeof discovery.DEFAULT_BOOTSTRAP_REFRESH_INTERVAL_SECS).toBe('number');
    expect(typeof discovery.DEFAULT_PROBE_TIMEOUT_MS).toBe('number');
    expect(typeof discovery.DEFAULT_CACHE_MAX_AGE_MS).toBe('number');
    expect(discovery.FALLBACK_RELAY_SEEDS).toBe(SOURCE_FALLBACK_RELAY_SEEDS);
    expect(Array.isArray(discovery.FALLBACK_RELAY_SEEDS)).toBe(true);
    expect(typeof discovery.FALLBACK_CURATOR_PUBKEY).toBe('string');
    expect(typeof discovery.canonicalJson).toBe('function');
    expect(typeof discovery.manifestDigest).toBe('function');
    expect(typeof discovery.signSeedManifest).toBe('function');
    expect(typeof discovery.parseSeedManifest).toBe('function');
    expect(typeof discovery.verifySeedManifest).toBe('function');
    expect(typeof discovery.FileBootstrapCacheStore).toBe('function');
    expect(typeof discovery.createKind10032RelayProbe).toBe('function');
    expect(discovery.BOOTSTRAP_PROBE_SUB_ID).toBe(SOURCE_BOOTSTRAP_PROBE_SUB_ID);
  });
});
