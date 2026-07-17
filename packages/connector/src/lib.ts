/**
 * ILP Connector Library Exports
 * Side-effect-free entry point for library consumers
 * @packageDocumentation
 */

import { ConnectorNode } from './core/connector-node';
import {
  ConfigLoader,
  ConfigurationError,
  ConnectorNotStartedError,
  InvalidExecutionConditionError,
} from './config/config-loader';
import { createLogger } from './utils/logger';
import { RoutingTable } from './routing/routing-table';
import { PacketHandler } from './core/packet-handler';
import { BTPServer } from './btp/btp-server';
import { BTPClient } from './btp/btp-client';
import { BTPClientManager } from './btp/btp-client-manager';
// LocalDeliveryClient is INTERNAL ONLY - not exported
// Library consumers should use ConnectorNode.setLocalDeliveryHandler() instead
// import { LocalDeliveryClient } from './core/local-delivery-client';
import { AdminServer } from './http/admin-server';
import { IlpHttpAdapter } from './http/ilp-http-adapter';
import { evaluatePeerSecret } from './auth/peer-secret-resolver';
import { AccountManager } from './settlement/account-manager';
import { SettlementMonitor } from './settlement/settlement-monitor';
import { UnifiedSettlementExecutor } from './settlement/unified-settlement-executor';
import {
  createPaymentHandlerAdapter,
  REJECT_CODE_MAP,
  generatePaymentId,
  mapRejectCode,
  validateResponseData,
  validateFulfillment,
} from './core/payment-handler';
import { IlpSendHandler, validateIlpSendRequest } from './http/ilp-send-handler';

// Export public API
export {
  ConnectorNode,
  ConfigLoader,
  ConfigurationError,
  ConnectorNotStartedError,
  InvalidExecutionConditionError,
  RoutingTable,
  PacketHandler,
  BTPServer,
  BTPClient,
  BTPClientManager,
  // LocalDeliveryClient is INTERNAL ONLY - not exported
  // Library consumers should use ConnectorNode.setLocalDeliveryHandler() instead
  AdminServer,
  IlpHttpAdapter,
  evaluatePeerSecret,
  AccountManager,
  SettlementMonitor,
  UnifiedSettlementExecutor,
  createLogger,
  // Payment handler utilities
  createPaymentHandlerAdapter,
  REJECT_CODE_MAP,
  generatePaymentId,
  mapRejectCode,
  validateResponseData,
  validateFulfillment,
  // ILP send handler
  IlpSendHandler,
  validateIlpSendRequest,
};

// Typed admin API client (runtime peer/route management)
export { ConnectorAdminClient, ConnectorAdminError } from './client/connector-admin-client';
export type {
  ConnectorAdminClientOptions,
  RegisterPeerInput,
  AdminRouteInput,
  RouteInput,
  RouteTerminationInput,
  FetchLike,
} from './client/connector-admin-client';

// Multi-hop route learning via link-state over kind:10032 (toon-meta#153)
export {
  RouteLearningService,
  DEFAULT_ROUTE_LEARNING_REFRESH_SECS,
  DEFAULT_MAX_LEARNED_ROUTES,
  LEARNED_ROUTE_PRIORITY,
} from './discovery/route-learning-service';
export type { RouteLearningServiceDeps } from './discovery/route-learning-service';
export { createNostrRelayClient } from './discovery/nostr-relay-client';
export type {
  RouteLearningRelayClient,
  RelaySubscriptionHandle,
  RelayEventFilter,
} from './discovery/nostr-relay-client';
export { LinkStateDatabase, parseExpirationTag } from './routing/link-state-db';
export type {
  LinkStateEntry,
  LinkStateEventInput,
  LinkStateIngestResult,
} from './routing/link-state-db';
export { computeRoutes } from './routing/path-computation';
export type { ComputedRoute, DirectNeighbor } from './routing/path-computation';
export {
  parseRoutingInfo,
  parseCapabilityDirectory,
  normalizeCapabilityName,
  CAPABILITY_NAME_PATTERN,
} from './discovery/ilp-peer-info-event';
export type {
  IlpRoutingInfo,
  IlpRoutingPrefix,
  IlpCapabilityEntry,
} from './discovery/ilp-peer-info-event';
export {
  buildCapabilityDirectory,
  buildRoutingInfo,
  nip59KeyToNostrPubkey,
  PUBLISH_HINT_CAPABILITY,
  STORE_HINT_CAPABILITY,
} from './discovery/self-announce-builder';

// Export configuration types
export type {
  ConnectorConfig,
  PeerConfig,
  RouteConfig,
  SettlementConfig,
  LocalDeliveryConfig,
  LocalDeliveryHandler,
  LocalDeliveryRequest,
  LocalDeliveryResponse,
  SendPacketParams,
  PeerRegistrationRequest,
  PeerInfo,
  PeerAccountBalance,
  RouteInfo,
  RemovePeerResult,
  IlpSendRequest,
  IlpSendResponse,
  TransportConfig,
  RouteLearningConfig,
  ChildConfig,
} from './config/types';

// Child-prefix registration + apex derivation (toon-meta#153)
export { ChildConfigError, deriveApex, expandChildren } from './config/child-expander';

// Cold-start bootstrap (toon-meta#153): relay-seed resolution, signed seed
// registry verification, learned-peer cache, and sample-and-verify probing.
export {
  BootstrapService,
  DEFAULT_SAMPLE_SIZE,
  DEFAULT_BOOTSTRAP_REFRESH_INTERVAL_SECS,
} from './discovery/bootstrap-service';
export type {
  BootstrapServiceDeps,
  ResolvedRelaySeed,
  RelayProbeFn,
  RelayProbeResult,
  RelaysResolvedListener,
} from './discovery/bootstrap-service';
export { FALLBACK_RELAY_SEEDS, FALLBACK_CURATOR_PUBKEY } from './discovery/bootstrap-seeds';
export type { RelaySeed } from './discovery/bootstrap-seeds';
export {
  signSeedManifest,
  parseSeedManifest,
  verifySeedManifest,
} from './discovery/bootstrap-manifest';
export type { SeedManifest, SeedManifestPayload } from './discovery/bootstrap-manifest';
export { FileBootstrapCacheStore } from './discovery/bootstrap-cache';
export type { BootstrapCacheStore, CachedRelaySeed } from './discovery/bootstrap-cache';
export { createKind10032RelayProbe } from './discovery/relay-probe';
export type { BootstrapConfig, BootstrapSeedEntry } from './config/types';

// Re-export settlement types for library consumers
export type { AdminSettlementConfig } from './settlement/types';

// Re-export channel manager types for library consumers (embedded mode)
export type { ChannelOpenOptions, ChannelMetadata } from './settlement/channel-manager';

// Re-export payment handler types for library consumers
export type { PaymentRequest, PaymentResponse, PaymentHandler } from './core/payment-handler';

// Re-export ILP send handler types for library consumers
export type { PacketSenderFn, IsReadyFn } from './http/ilp-send-handler';

// Connector paid reverse proxy: generic HTTP reverse-proxy local-delivery handler (#216)
export {
  HttpProxyHandler,
  EnvelopeDecodeError,
  decodeHttpRequest,
  encodeHttpRequest,
  encodeHttpResponse,
  TOON_PAYER_HEADER,
  TOON_AMOUNT_HEADER,
  TOON_CHAIN_HEADER,
} from './core/handlers/http-proxy-handler';
export type {
  HttpProxyHandlerOptions,
  HttpRequestEnvelope,
  UpstreamResolver,
  ChainResolver,
} from './core/handlers/http-proxy-handler';

// Per-route termination config surface (#218): registry + canonical types.
export { RouteTerminationRegistry } from './core/route-upstream-registry';
export type { RouteTermination, TerminationChain } from './config/types';
export { validateRouteTermination, toRouteTermination } from './config/types';

// Re-export ILP packet types for library consumers
export type { ILPPreparePacket, ILPFulfillPacket, ILPRejectPacket } from '@toon-protocol/shared';

// ILP-over-HTTP + BTP-upgrade transport types
export type { BtpPreAuth, IlpHttpHandler } from './btp/btp-server';
export type {
  InboundClaimValidateFn,
  HandlePrepareFn,
  IlpHttpAdapterDeps,
  ResolveTerminationFn,
} from './http/ilp-http-adapter';
export type { PeerSecretDecision } from './auth/peer-secret-resolver';

// ILP-over-HTTP egress (Epic 38, Story 38.1)
export {
  HttpPeerClientManager,
  HttpPeerConnectionError,
  HttpPeerTimeoutError,
  DEFAULT_ILP_HTTP_EGRESS_PATH,
} from './transport/http-peer-transport';
export type { PeerEgress, HttpPeer } from './transport/http-peer-transport';

// x402 v2 "402 Payment Required" greeting on the HTTP edge (#217).
export {
  buildX402Greeting,
  chainToCaip2,
  X402_VERSION,
  X402_PAYMENT_SIGNATURE_HEADER,
  X402_PAYMENT_REQUIRED_HEADER,
  X402_DEFAULT_MAX_TIMEOUT_SECONDS,
  TOON_CHANNEL_SCHEME,
  TOON_CHANNEL_ENDPOINT,
} from './http/x402-greeting';
export type {
  X402PaymentRequired,
  X402PaymentRequirements,
  X402ResourceInfo,
  X402GreetingContext,
  ToonChannelExtra,
} from './http/x402-greeting';

// RFC 9421 claim↔request binding (#220): net-new verifier/signer modules.
// NOT yet wired into ilp-http-adapter.ts — that integration is gated on #218's
// route-config and is done at merge time by the project lead.
export {
  verify as verifyRfc9421Signature,
  computeContentDigest,
  verifyContentDigest,
  buildSignatureBase,
  signRequest as signRfc9421Request,
  publicKeyToKeyid,
  COVERED_COMPONENTS as RFC9421_COVERED_COMPONENTS,
  PRICE_HEADER as TOON_PRICE_HEADER,
  PRICE_HEADER_WIRE as TOON_PRICE_HEADER_WIRE,
  SIGNATURE_ALG as RFC9421_SIGNATURE_ALG,
} from './auth/rfc9421';
export type {
  VerifyResult as Rfc9421VerifyResult,
  VerifyOptions as Rfc9421VerifyOptions,
  VerifyFailureCode as Rfc9421VerifyFailureCode,
  SignRequestInput as Rfc9421SignRequestInput,
  SignedHeaders as Rfc9421SignedHeaders,
} from './auth/rfc9421';
