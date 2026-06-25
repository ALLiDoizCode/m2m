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
// kind:10032 IlpPeerInfo announcement describing its apex routes.
export { SelfAnnounceService, DEFAULT_REFRESH_INTERVAL_SECS } from './self-announce-service';
export type { SelfAnnounceServiceDeps, FetchLike } from './self-announce-service';
export { buildSelfAnnouncementInfo, resolveRouteHints } from './self-announce-builder';
export type { IlpRouteHints, SelfAnnouncementInfo } from './self-announce-builder';
export { buildIlpPeerInfoEvent, ILP_PEER_INFO_KIND, EXPIRATION_TAG } from './ilp-peer-info-event';
export type { IlpPeerInfo, BuildIlpPeerInfoOptions } from './ilp-peer-info-event';
