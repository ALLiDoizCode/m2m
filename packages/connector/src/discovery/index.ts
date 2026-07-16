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
