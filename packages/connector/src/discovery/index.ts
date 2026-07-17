/**
 * Discovery Module
 *
 * Exports peer discovery functionality for automatic peer connection.
 */

export { PeerDiscoveryService } from './peer-discovery-service';
export type {
  PeerDiscoveryConfig,
  PeerInfo,
  AnnounceResponse,
  PeerListResponse,
  DiscoveryStatus,
  PeerDiscoveryEvents,
} from './types';

// Self-announce (relay#37 / store#22): the connector publishes its OWN
// kind:10032 IlpPeerInfo announcement describing its apex routes, routed
// through its own pipe (free local terminate / paid remote forward).
export { SelfAnnounceService, DEFAULT_REFRESH_INTERVAL_SECS } from './self-announce-service';
export type {
  SelfAnnounceServiceDeps,
  PublishFn,
  PublishOutcome,
  ResolveTokenNetworksFn,
} from './self-announce-service';
export {
  buildSelfAnnouncementInfo,
  deriveChainSettlementParams,
  normalizeSettlementAddressKeys,
  resolveRouteHints,
} from './self-announce-builder';
export type {
  AnnounceWarnFn,
  ChainSettlementParams,
  IlpRouteHints,
  SelfAnnouncementInfo,
} from './self-announce-builder';
export {
  planAnnouncePublish,
  encodeWriteEnvelope,
  DEFAULT_ANNOUNCE_PRICE,
} from './self-announce-publish';
export type { AnnouncePublishPlan, AnnouncePublishMode } from './self-announce-publish';
export { buildIlpPeerInfoEvent, ILP_PEER_INFO_KIND, EXPIRATION_TAG } from './ilp-peer-info-event';
export type { IlpPeerInfo, BuildIlpPeerInfoOptions } from './ilp-peer-info-event';

// Cold-start bootstrap (toon-meta#153): resolve relay seeds (curated signed
// registry → learned-peer cache → config seeds → hardcoded fallback),
// sample-and-verify candidates before trusting them, persist survivors.
export {
  BootstrapService,
  DEFAULT_SAMPLE_SIZE,
  DEFAULT_BOOTSTRAP_REFRESH_INTERVAL_SECS,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_CACHE_MAX_AGE_MS,
} from './bootstrap-service';
export type {
  BootstrapServiceDeps,
  ResolvedRelaySeed,
  RelayProbeFn,
  RelayProbeResult,
  FetchFn,
  FetchResponseLike,
  RelaysResolvedListener,
} from './bootstrap-service';
export { FALLBACK_RELAY_SEEDS, FALLBACK_CURATOR_PUBKEY } from './bootstrap-seeds';
export type { RelaySeed } from './bootstrap-seeds';
export {
  canonicalJson,
  manifestDigest,
  signSeedManifest,
  parseSeedManifest,
  verifySeedManifest,
} from './bootstrap-manifest';
export type {
  SeedManifest,
  SeedManifestPayload,
  SeedManifestParseResult,
} from './bootstrap-manifest';
export { FileBootstrapCacheStore } from './bootstrap-cache';
export type { BootstrapCacheStore, CachedRelaySeed, RelaySeedSource } from './bootstrap-cache';
export { createKind10032RelayProbe, BOOTSTRAP_PROBE_SUB_ID } from './relay-probe';
