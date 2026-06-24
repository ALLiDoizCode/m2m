/**
 * Admin API - HTTP endpoints for dynamic peer and route management
 * @packageDocumentation
 * @remarks
 * Provides REST API for runtime configuration of the connector:
 * - Peer management (add/remove BTP connections)
 * - Route management (add/remove routing table entries)
 *
 * **Security:**
 * - Designed for internal Docker Compose network access only
 * - Optional API key authentication
 * - Should NOT be exposed to public internet
 *
 * @example
 * ```typescript
 * const adminRouter = createAdminRouter({
 *   routingTable,
 *   btpClientManager,
 *   logger,
 *   apiKey: 'optional-secret-key'
 * });
 * app.use('/admin', adminRouter);
 * ```
 */

import { timingSafeEqual } from 'node:crypto';
import type { Router, Request, Response, NextFunction } from 'express';
import { Netmask } from 'netmask';
import { Logger } from '../utils/logger';
import { requireOptional } from '../utils/optional-require';
import { RoutingTable } from '../routing/routing-table';
import {
  deriveLocalPrefixes,
  deriveDefaultChildRoute,
  validateRelationRoute,
} from '../routing/relation-route-validator';
import { BTPClientManager } from '../btp/btp-client-manager';
import { Peer } from '../btp/btp-client';
import type { PeerEgress, HttpPeer } from '../transport/http-peer-transport';
import { ILPAddress, isValidILPAddress } from '@toon-protocol/shared';
import {
  AdminSettlementConfig,
  PeerConfig as SettlementPeerConfig,
  isValidEvmAddress,
  isValidNonNegativeIntegerString,
  normalizeChannelStatus,
} from '../settlement/types';
import type { AdminChannelStatus } from '../settlement/types';
import type { ChannelManager } from '../settlement/channel-manager';
import type { PaymentChannelSDK } from '../settlement/payment-channel-sdk';
import type { AccountManager } from '../settlement/account-manager';
import type { SettlementMonitor } from '../settlement/settlement-monitor';
import type { ClaimReceiver } from '../settlement/claim-receiver';
import type { SentClaimsQueries } from '../settlement/sent-claims-queries';
import type { BlockchainType } from '../btp/btp-claim-types';
import { IlpSendHandler } from './ilp-send-handler';
import type { PacketSenderFn, IsReadyFn } from './ilp-send-handler';
import type { IlpMetricsRegistry } from '../observability/metrics-registry';
import type { PeerRelation, RouteTermination, TerminationChain } from '../config/types';
import { validateRouteTermination, toRouteTermination } from '../config/types';

/**
 * Admin API Configuration
 */
export interface AdminAPIConfig {
  /** Routing table instance for route management */
  routingTable: RoutingTable;

  /** BTP client manager for peer management */
  btpClientManager: BTPClientManager;

  /** Logger instance */
  logger: Logger;

  /** Optional API key for authentication (if not set, no auth required) */
  apiKey?: string;

  /** Optional IP allowlist for access control (supports CIDR notation) */
  allowedIPs?: string[];

  /** Trust X-Forwarded-For header for client IP (only enable behind trusted proxy) */
  trustProxy?: boolean;

  /** Node ID for logging context */
  nodeId: string;

  /**
   * Optional settlement peer config Map for storing runtime settlement configurations.
   * When provided, POST /admin/peers stores PeerConfig entries and GET /admin/peers
   * includes settlement info. If omitted, settlement features are silently skipped.
   */
  settlementPeers?: Map<string, SettlementPeerConfig>;

  /** Optional ChannelManager for payment channel lifecycle operations */
  channelManager?: ChannelManager;

  /** Optional PaymentChannelSDK for on-chain EVM channel state queries */
  paymentChannelSDK?: PaymentChannelSDK;

  /** Optional AccountManager for peer balance queries (TigerBeetle) */
  accountManager?: AccountManager;

  /** Optional SettlementMonitor for settlement state queries */
  settlementMonitor?: SettlementMonitor;

  /** Optional ClaimReceiver for payment channel claim queries */
  claimReceiver?: ClaimReceiver;

  /**
   * Optional sent-claims queries (Story 37.7). Exposes read helpers over the
   * `sent_claims` SQLite table. When provided, /admin/earnings.json populates
   * `claimsSentTotal` and the outbound side of the `recentClaims` ticker.
   * When absent, the endpoint falls back to `claimsSentTotal = "0"` and an
   * inbound-only ticker (37.4 behaviour).
   */
  sentClaimsQueries?: SentClaimsQueries;

  /** Optional callback for sending ILP packets via ConnectorNode.sendPacket() */
  packetSender?: PacketSenderFn;

  /** Optional callback for checking if the connector is ready to send packets */
  isReady?: IsReadyFn;

  /** Default settlement token ID resolved from on-chain ERC-20 symbol (e.g. 'M2M') */
  defaultSettlementTokenId?: string;

  /** Optional metrics registry for ILP observability (Story 37.2). When provided, enables GET /admin/metrics.json endpoint. */
  metricsRegistry?: IlpMetricsRegistry;

  /**
   * Optional on-chain token metadata resolver (Story 37.4).
   *
   * Called by GET /admin/earnings.json to resolve raw token identifiers
   * (ERC-20 address, SPL program ID, Mina token ID) into human-friendly
   * (assetCode, assetScale) pairs via on-chain `symbol()`/`decimals()` reads.
   *
   * Implementations should cache results — the endpoint calls this once per
   * distinct asset per request and the dashboard polls at ~0.2 Hz.
   *
   * Resolver must return a fallback (raw address as code, scale 0) for tokens
   * whose metadata cannot be resolved on-chain rather than throwing. Throwing
   * degrades the entire endpoint response; returning a fallback keeps the
   * dashboard alive with raw integer amounts.
   */
  resolveTokenMetadata?: (
    blockchain: 'evm' | 'solana' | 'mina',
    tokenAddress: string
  ) => Promise<{ assetCode: string; assetScale: number }>;

  /**
   * Optional connector fee percentage (e.g. 0.1 = 0.1%) used by /admin/earnings.json
   * to compute approximate cumulative fee revenue per asset (Story 37.4).
   *
   * Formula: sum(incomingVolume per peer per asset) * connectorFeePercentage / 100.
   *
   * This is an approximation: it is derived from the TB ledger's incoming-volume
   * raw counter times the globally-configured fee rate. It does not require
   * (and does not provide) a dedicated ConnectorFee TigerBeetle account — see
   * the follow-up story for that refactor. When this field is omitted or
   * zero, the endpoint returns an empty `connectorFees` array.
   */
  connectorFeePercentage?: number;

  /**
   * Optional hook for propagating a peer's ILP relationship to the packet
   * forwarding path. When provided, `POST /admin/peers` calls this with the
   * peer id and its (defaulted) {@link PeerRelation} so the PacketHandler can
   * decide whether value-bearing forwards to the peer require a per-packet
   * settlement claim. When omitted, relation tracking is silently skipped and
   * every value-bearing peer forward requires a claim (legacy behavior).
   */
  setPeerRelation?: (peerId: string, relation: PeerRelation) => void;

  /**
   * Optional reader for a peer's current ILP relationship, mirroring
   * {@link setPeerRelation}. Used by `POST /admin/routes` to validate that a
   * route's prefix is consistent with the relation of its `nextHop` peer
   * (e.g. a `child` route must sit under the connector's own address). When
   * omitted, the relation↔route admission check is skipped.
   */
  getPeerRelation?: (peerId: string) => PeerRelation | undefined;

  /**
   * Optional persistent peer/route registry. When provided, runtime peer
   * registrations/removals made through the admin API are written through so
   * they survive a connector restart (instead of the "re-POST the route after
   * restart" RUNBOOK step). Routes are persisted at the RoutingTable layer, so
   * this is only used for the peer record (which carries relation + settlement
   * that the routing table does not see).
   */
  registryStore?: RegistryPeerSink;

  /**
   * Optional ILP-over-HTTP egress manager (Epic 38, Story 38.1). When provided,
   * `POST /admin/peers` with `peerProtocol: 'ilp-http'` registers the peer here
   * instead of opening a BTP connection. When omitted, an `ilp-http` request is
   * rejected with HTTP 400 (the connector was built without HTTP egress).
   */
  httpPeerEgress?: PeerEgress;

  /**
   * Optional hook for propagating a peer's packet protocol to the forwarding
   * seam (Epic 38). `POST /admin/peers` calls this with the peer id and its
   * (defaulted) protocol so the PacketHandler dispatches BTP vs ILP-HTTP egress.
   */
  setPeerProtocol?: (peerId: string, protocol: 'btp' | 'ilp-http') => void;

  /**
   * Optional per-route local-termination registry (issue #218). When provided,
   * `POST /admin/routes` and `PUT /admin/desired-state` reconcile terminated
   * routes (upstream/price/chains/ilpAddress/settlementAddresses/asset) into the
   * same in-memory registry #216's HttpProxyHandler resolves against — so a
   * terminated route added at runtime takes effect with no restart. When
   * omitted, route-termination fields in request bodies are still validated but
   * not applied (the registry seam is simply absent).
   */
  routeTerminationRegistry?: RouteTerminationSink;
}

/**
 * Minimal mutation surface the admin API needs from the route-termination
 * registry. Satisfied structurally by
 * {@link ../core/route-upstream-registry.RouteTerminationRegistry}; kept
 * structural so the HTTP layer has no hard dependency on the core registry.
 */
export interface RouteTerminationSink {
  set(prefix: string, termination: RouteTermination): void;
  delete(prefix: string): boolean;
  lookup(prefix: string): RouteTermination | undefined;
  prefixes(): string[];
}

/**
 * Minimal peer write-through surface the admin API needs from the registry
 * store. Kept structural so the HTTP layer has no hard dependency on the
 * concrete {@link ../core/registry-store.RegistryStore}.
 */
export interface RegistryPeerSink {
  savePeer(record: {
    id: string;
    url: string;
    authToken: string;
    relation?: string;
    transport?: string;
    settlementJson?: string;
    source: 'config' | 'runtime';
  }): void;
  deletePeer(id: string): void;
  /**
   * Optional route write-through (issue #218). The routing table already
   * persists prefix/nextHop/priority via its own sink; this overload lets the
   * admin API additionally persist a route's `terminationJson` so terminated
   * routes survive a restart. Optional so test fixtures and the structural
   * `RegistryPeerSink` callers that only need peer write-through can omit it.
   */
  saveRoute?(record: {
    prefix: string;
    nextHop: string;
    priority: number;
    source: 'config' | 'runtime';
    terminationJson?: string;
  }): void;
}

/**
 * Request body for adding a peer
 */
export interface AddPeerRequest {
  /** Unique peer identifier */
  id: string;

  /** WebSocket URL for BTP connection (e.g., ws://peer:3000) */
  url: string;

  /** Authentication token for BTP handshake */
  authToken: string;

  /** Optional routes to add for this peer */
  routes?: Array<{
    /** ILP address prefix */
    prefix: string;
    /** Route priority (higher wins, default: 0) */
    priority?: number;
  }>;

  /**
   * Optional settlement configuration for this peer.
   * When provided, a PeerConfig is created and stored for settlement routing.
   * @example
   * ```json
   * {
   *   "preference": "evm",
   *   "evmAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28",
   *   "tokenAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
   *   "chainId": 8453
   * }
   * ```
   */
  settlement?: AdminSettlementConfig;

  /**
   * Per-peer transport. Only direct TCP is supported.
   */
  transport?: 'direct';

  /**
   * ILP peering relationship for this peer (`'parent' | 'peer' | 'child'`).
   * A `'child'` next hop is forwarded value WITHOUT a mandatory per-packet
   * settlement claim (the child settles up to this connector); `'parent'` and
   * `'peer'` require a claim. Defaults to `'peer'` when omitted. See
   * {@link PeerRelation}.
   */
  relation?: PeerRelation;

  /**
   * Packet protocol for forwarding to this peer (Epic 38, Story 38.1).
   * `'btp'` (default) dials the BTP WebSocket at `url`; `'ilp-http'` POSTs OER
   * PREPAREs to {@link httpUrl}.
   */
  peerProtocol?: 'btp' | 'ilp-http';

  /** http(s) ingress endpoint; required when `peerProtocol === 'ilp-http'`. */
  httpUrl?: string;

  /** Optional ILP-over-HTTP egress path override (default `/ilp`). */
  httpPath?: string;

  /** Optional fixed ILP-over-HTTP egress timeout (ms); else derived from `expiresAt`. */
  httpTimeoutMs?: number;
}

/**
 * Request body for adding a route
 */
export interface AddRouteRequest {
  /** ILP address prefix (e.g., g.agent.alice) */
  prefix: string;

  /** Peer ID to forward packets to */
  nextHop: string;

  /** Route priority (higher wins, default: 0) */
  priority?: number;

  // ── Optional local-termination config (issue #218) ──
  // Mirror the YAML `RouteTermination` shape 1:1. Present iff `upstream` is set,
  // in which case the full shape is required and validated by
  // `validateRouteTermination` (the same helper the boot loader uses).

  /** Upstream HTTP(S) base URL; presence marks the route as locally terminated. */
  upstream?: string;

  /** Price to terminate, decimal-string atomic units (nano-USDC, 6dp). */
  price?: string;

  /** Settlement chains accepted (subset of evm|solana|mina). */
  chains?: TerminationChain[];

  /** Connector's advertised ILP address for the toon-channel upgrade. */
  ilpAddress?: string;

  /** Chain → payTo settlement address (keys ⊆ chains). */
  settlementAddresses?: Partial<Record<TerminationChain, string>>;

  /** Optional chain → token (USDC) contract override (keys ⊆ chains). */
  asset?: Partial<Record<TerminationChain, string>>;
}

/**
 * GET /admin/balances/:peerId response
 * MVP: balances array always contains a single element (one tokenId per query).
 * Array structure allows future multi-token expansion without breaking the API.
 */
export interface BalanceResponse {
  peerId: string;
  balances: Array<{
    tokenId: string;
    debitBalance: string;
    creditBalance: string;
    netBalance: string;
  }>;
}

/**
 * GET /admin/earnings.json response — per-peer per-asset earnings row (Story 37.4).
 *
 * Cumulative amounts are expressed as decimal-string bigints (JSON-safe for any
 * asset scale). `claimsReceivedTotal` tracks value the peer has sent us (they
 * are paying); `claimsSentTotal` tracks value we have forwarded to the peer
 * (they are earning). Both reduce to zero as on-chain settlements drain the
 * underlying TB counters.
 */
export interface AdminEarningsByAsset {
  assetCode: string;
  assetScale: number;
  claimsReceivedTotal: string;
  claimsSentTotal: string;
  netBalance: string;
  lastClaimAt: string | null;
}

export interface AdminEarningsJsonPeer {
  peerId: string;
  byAsset: AdminEarningsByAsset[];
}

export interface AdminEarningsConnectorFee {
  assetCode: string;
  assetScale: number;
  total: string;
}

export interface AdminEarningsRecentClaim {
  peerId: string;
  assetCode: string;
  assetScale: number;
  amount: string;
  direction: 'inbound' | 'outbound';
  at: string;
}

export interface AdminEarningsJsonResponse {
  uptimeSeconds: number;
  peers: AdminEarningsJsonPeer[];
  connectorFees: AdminEarningsConnectorFee[];
  recentClaims: AdminEarningsRecentClaim[];
  timestamp: string;
}

/**
 * GET /admin/metrics.json response — per-peer ILP counter snapshot.
 * Shape locked in response doc §9.4.
 */
export interface AdminMetricsJsonPeer {
  peerId: string;
  connected: boolean;
  packetsForwarded: number;
  packetsRejected: number;
  bytesSent: number;
  packetsLocallyDelivered: number;
  lastPacketAt: string | null;
}

/**
 * GET /admin/metrics.json response — top-level aggregate + peer list.
 * Shape locked in response doc §9.4.
 */
export interface AdminMetricsJsonResponse {
  uptimeSeconds: number;
  aggregate: {
    packetsForwarded: number;
    packetsRejected: number;
    bytesSent: number;
    packetsLocallyDelivered: number;
  };
  peers: AdminMetricsJsonPeer[];
  timestamp: string;
}

/**
 * GET /admin/settlement/states response item
 */
export interface SettlementStateResponse {
  peerId: string;
  tokenId: string;
  state: string;
}

/**
 * Helper: Normalize IP address (convert IPv4-mapped IPv6 to IPv4)
 * @param ip - IP address (may be IPv4-mapped IPv6 like ::ffff:127.0.0.1)
 * @returns Normalized IP address
 */
function normalizeIP(ip: string): string {
  // Convert IPv4-mapped IPv6 (::ffff:192.0.2.1) to IPv4 (192.0.2.1)
  if (ip.startsWith('::ffff:')) {
    return ip.substring(7);
  }
  return ip;
}

/**
 * Helper: Extract client IP from request
 * @param req - Express request object
 * @param trustProxy - Whether to trust X-Forwarded-For header
 * @returns Client IP address (normalized)
 */
function getClientIP(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    // When behind proxy, use X-Forwarded-For (first IP is client)
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      const headerValue = typeof forwardedFor === 'string' ? forwardedFor : forwardedFor[0];
      if (headerValue) {
        const ips = headerValue.split(',');
        const firstIP = ips[0];
        if (firstIP) {
          return normalizeIP(firstIP.trim());
        }
      }
    }
  }
  // Direct connection: use socket IP
  const rawIP = req.ip || req.socket.remoteAddress || 'unknown';
  return normalizeIP(rawIP);
}

/**
 * Helper: Check if IP matches allowlist (supports CIDR notation)
 * @param ip - Client IP address
 * @param allowedIPs - Array of allowed IPs/CIDR ranges
 * @returns True if IP is allowed, false otherwise
 */
function isIPAllowed(ip: string, allowedIPs: string[]): boolean {
  for (const allowed of allowedIPs) {
    try {
      // Check if it's a CIDR range
      if (allowed.includes('/')) {
        const block = new Netmask(allowed);
        if (block.contains(ip)) {
          return true;
        }
      } else {
        // Exact IP match
        if (ip === allowed) {
          return true;
        }
      }
    } catch (err) {
      // Invalid CIDR notation — skip this entry
      continue;
    }
  }
  return false;
}

/**
 * Create IP allowlist middleware
 * @param allowedIPs - Array of allowed IP addresses/CIDR ranges
 * @param trustProxy - Whether to trust X-Forwarded-For header
 * @param logger - Logger instance
 * @returns Express middleware function
 */
function createIPAllowlistMiddleware(
  allowedIPs: string[],
  trustProxy: boolean,
  logger: Logger
): (req: Request, res: Response, next: NextFunction) => void {
  const log = logger.child({ component: 'IPAllowlist' });

  return (req: Request, res: Response, next: NextFunction) => {
    const clientIP = getClientIP(req, trustProxy);

    if (!isIPAllowed(clientIP, allowedIPs)) {
      log.warn(
        {
          event: 'admin_api_ip_blocked',
          ip: clientIP,
          path: req.path,
          allowedIPs,
          trustProxy,
        },
        'Admin API request blocked by IP allowlist'
      );
      res.status(403).json({
        error: 'Forbidden',
        message: 'IP address not allowed',
      });
      return;
    }

    // IP is allowed — continue to next middleware
    next();
  };
}

/**
 * Create Admin API Express router
 *
 * @param config - Admin API configuration
 * @returns Express router with admin endpoints
 *
 * @remarks
 * Endpoints:
 * - GET /admin/peers - List all peers with connection status
 * - POST /admin/peers - Add a new peer (and optionally routes)
 * - DELETE /admin/peers/:peerId - Remove a peer (and optionally its routes)
 * - GET /admin/routes - List all routes
 * - POST /admin/routes - Add a new route
 * - DELETE /admin/routes/:prefix - Remove a route
 */
export async function createAdminRouter(config: AdminAPIConfig): Promise<Router> {
  const { default: express } = await requireOptional<{ default: typeof import('express') }>(
    'express',
    'HTTP admin/health APIs'
  );
  const router = express.Router();
  const {
    routingTable,
    btpClientManager,
    logger,
    apiKey,
    allowedIPs,
    trustProxy = false,
    nodeId,
    settlementPeers,
    channelManager,
    paymentChannelSDK,
    accountManager,
    settlementMonitor,
    claimReceiver,
    sentClaimsQueries,
    packetSender,
    isReady,
    defaultSettlementTokenId,
    metricsRegistry,
    resolveTokenMetadata,
    connectorFeePercentage,
    setPeerRelation,
    getPeerRelation,
    registryStore,
    httpPeerEgress,
    setPeerProtocol,
    routeTerminationRegistry,
  } = config;
  const log = logger.child({ component: 'AdminAPI' });

  // JSON body parser
  router.use(express.json());

  // Optional IP allowlist middleware (checked BEFORE API key for fast rejection)
  if (allowedIPs && allowedIPs.length > 0) {
    router.use(createIPAllowlistMiddleware(allowedIPs, trustProxy, logger));
  }

  // Optional API key authentication middleware
  if (apiKey) {
    const apiKeyBuffer = Buffer.from(apiKey);
    router.use((req: Request, res: Response, next: NextFunction) => {
      // Only accept API key via X-Api-Key header — reject query param to avoid
      // keys leaking into access logs, proxy logs, and browser history.
      if (req.query.apiKey) {
        log.warn(
          {
            event: 'admin_api_key_in_query',
            ip: req.ip,
            path: req.path,
          },
          'API key supplied via query parameter (rejected — use X-Api-Key header)'
        );
        res.status(401).json({
          error: 'Unauthorized',
          message: 'API key must be provided via X-Api-Key header, not query parameter',
        });
        return;
      }

      const providedKey = req.headers['x-api-key'];

      // Timing-safe comparison: convert to equal-length buffers to avoid
      // leaking key length via early-exit on length mismatch.
      const providedBuffer = Buffer.from(typeof providedKey === 'string' ? providedKey : '');
      const isLengthMatch = providedBuffer.length === apiKeyBuffer.length;
      // Compare against actual key when lengths match, otherwise compare against
      // a dummy of the same length as the provided key to burn constant time.
      const comparand = isLengthMatch ? apiKeyBuffer : providedBuffer;
      const isMatch = timingSafeEqual(providedBuffer, comparand) && isLengthMatch;

      if (!isMatch) {
        log.warn(
          {
            event: 'admin_api_auth_failed',
            ip: req.ip,
            path: req.path,
          },
          'Admin API authentication failed'
        );
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid or missing API key',
        });
        return;
      }

      next();
    });
  }

  // Request logging middleware
  router.use((req: Request, _res: Response, next: NextFunction) => {
    log.info(
      {
        event: 'admin_api_request',
        method: req.method,
        path: req.path,
        ip: req.ip,
      },
      `Admin API: ${req.method} ${req.path}`
    );
    next();
  });

  /**
   * GET /admin/peers
   * List all peers with their connection status
   */
  router.get('/peers', (_req: Request, res: Response) => {
    try {
      const peerIds = btpClientManager.getPeerIds();
      const peerStatus = btpClientManager.getPeerStatus();
      const routes = routingTable.getAllRoutes();

      // Build peer response with ILP addresses from routes
      const peers = peerIds.map((peerId) => {
        // Find routes that use this peer as nextHop
        const peerRoutes = routes.filter((r) => r.nextHop === peerId);
        const ilpAddresses = peerRoutes.map((r) => r.prefix);

        const peerResponse: Record<string, unknown> = {
          id: peerId,
          connected: peerStatus.get(peerId) ?? false,
          ilpAddresses,
          routeCount: peerRoutes.length,
          // Per-peer transport override (`undefined` for peers that inherit
          // the connector-level default — e.g. legacy peers loaded before
          // the field existed in YAML, or peers registered without an
          // explicit `transport` field).
          transport: btpClientManager.getPeerTransport(peerId),
        };

        // Include settlement info if available
        if (settlementPeers) {
          const peerConfig = settlementPeers.get(peerId);
          if (peerConfig) {
            peerResponse.settlement = {
              preference: peerConfig.settlementPreference,
              evmAddress: peerConfig.evmAddress,
              tokenAddress: peerConfig.tokenAddress,
              tokenNetworkAddress: peerConfig.tokenNetworkAddress,
              chainId: peerConfig.chainId,
              channelId: peerConfig.channelId,
              initialDeposit: peerConfig.initialDeposit,
            };
          }
        }

        return peerResponse;
      });

      res.json({
        nodeId,
        peerCount: peers.length,
        connectedCount: peers.filter((p) => p.connected).length,
        peers,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error({ event: 'admin_api_error', error: errorMessage }, 'Failed to list peers');
      res.status(500).json({ error: 'Internal server error', message: errorMessage });
    }
  });

  /**
   * POST /admin/peers
   * Add a new peer with optional routes
   */
  router.post('/peers', async (req: Request, res: Response) => {
    try {
      const body = req.body as AddPeerRequest;

      // Epic 38, Story 38.1: select egress family. Validated up front so URL
      // validation can branch (BTP requires ws://; ILP-HTTP requires httpUrl).
      const peerProtocol = body.peerProtocol ?? 'btp';
      if (peerProtocol !== 'btp' && peerProtocol !== 'ilp-http') {
        res.status(400).json({
          error: 'Bad request',
          message: `Invalid peerProtocol: must be 'btp' or 'ilp-http' (got '${peerProtocol}')`,
        });
        return;
      }

      // Validate required fields
      if (!body.id || typeof body.id !== 'string') {
        res.status(400).json({ error: 'Bad request', message: 'Missing or invalid peer id' });
        return;
      }
      if (
        body.authToken === undefined ||
        body.authToken === null ||
        typeof body.authToken !== 'string'
      ) {
        res.status(400).json({
          error: 'Bad request',
          message: 'authToken must be a string (can be empty for no auth)',
        });
        return;
      }

      if (peerProtocol === 'ilp-http') {
        if (!httpPeerEgress || !setPeerProtocol) {
          res.status(400).json({
            error: 'Bad request',
            message: 'ILP-over-HTTP egress is not available on this connector',
          });
          return;
        }
        if (!body.httpUrl || typeof body.httpUrl !== 'string') {
          res.status(400).json({
            error: 'Bad request',
            message: "peerProtocol 'ilp-http' requires httpUrl (http(s) endpoint)",
          });
          return;
        }
        if (!/^https?:\/\/.+/.test(body.httpUrl)) {
          res.status(400).json({
            error: 'Bad request',
            message: 'httpUrl must start with http:// or https://',
          });
          return;
        }
      } else {
        if (!body.url || typeof body.url !== 'string') {
          res.status(400).json({ error: 'Bad request', message: 'Missing or invalid peer url' });
          return;
        }
        // Validate URL format
        if (!body.url.startsWith('ws://') && !body.url.startsWith('wss://')) {
          res.status(400).json({
            error: 'Bad request',
            message: 'URL must start with ws:// or wss://',
          });
          return;
        }
      }

      // Validate per-peer transport. Only direct TCP is supported.
      if (body.transport !== undefined && body.transport !== 'direct') {
        res.status(400).json({
          error: 'Bad request',
          message: `Invalid transport: must be 'direct' (got '${String(body.transport)}')`,
        });
        return;
      }

      // Validate peer relation (issue #76). Error string is byte-identical to
      // the one thrown by ConnectorNode.registerPeer() for cross-surface parity.
      if (
        body.relation !== undefined &&
        body.relation !== 'parent' &&
        body.relation !== 'peer' &&
        body.relation !== 'child'
      ) {
        res.status(400).json({
          error: 'Bad request',
          message: `Invalid relation: must be 'parent', 'peer', or 'child' (got '${body.relation}')`,
        });
        return;
      }

      // Check if peer already exists (idempotent re-registration). Epic 38: an
      // 'ilp-http' peer lives in the HTTP egress manager, not the BTP client map.
      const existingPeers =
        peerProtocol === 'ilp-http' && httpPeerEgress
          ? httpPeerEgress.getPeerIds()
          : btpClientManager.getPeerIds();
      const isUpdate = existingPeers.includes(body.id);

      // Validate routes if provided
      if (body.routes) {
        for (const route of body.routes) {
          if (!route.prefix || typeof route.prefix !== 'string') {
            res.status(400).json({
              error: 'Bad request',
              message: 'Invalid route: missing prefix',
            });
            return;
          }
          if (!isValidILPAddress(route.prefix)) {
            res.status(400).json({
              error: 'Bad request',
              message: `Invalid ILP address prefix: ${route.prefix}`,
            });
            return;
          }
        }
      }

      // Validate settlement config if provided
      if (body.settlement) {
        const settlementError = validateSettlementConfig(body.settlement);
        if (settlementError) {
          res.status(400).json({ error: 'Bad request', message: settlementError });
          return;
        }
      }

      // Relation ↔ route admission validation + child auto-route (Phase 2),
      // mirroring ConnectorNode.registerPeer() for cross-surface parity. The
      // connector's self-prefixes are the routes terminating locally; when none
      // exist the validator no-ops (routing-only nodes are unaffected). A
      // `child` with no explicit route gets `<self>.<peerId>` derived.
      const localPrefixes = deriveLocalPrefixes(routingTable.getAllRoutes(), nodeId);
      let effectiveRoutes = body.routes;
      if (!effectiveRoutes || effectiveRoutes.length === 0) {
        const autoRoute = deriveDefaultChildRoute(body.relation, localPrefixes, body.id);
        if (autoRoute) {
          effectiveRoutes = [autoRoute];
        }
      }
      if (effectiveRoutes && effectiveRoutes.length > 0) {
        const relationValidation = validateRelationRoute(
          body.relation,
          localPrefixes,
          effectiveRoutes.map((r) => r.prefix)
        );
        if (!relationValidation.ok) {
          res.status(400).json({ error: 'Bad request', message: relationValidation.error });
          return;
        }
      }

      // Only add the peer on initial registration (connection params don't
      // change on re-registration).
      if (!isUpdate) {
        if (peerProtocol === 'ilp-http' && httpPeerEgress) {
          const httpPeer: HttpPeer = {
            id: body.id,
            httpUrl: body.httpUrl!,
            httpPath: body.httpPath,
            authToken: body.authToken,
            httpTimeoutMs: body.httpTimeoutMs,
          };
          await httpPeerEgress.addPeer(httpPeer);
          log.info(
            { event: 'admin_peer_added', peerId: body.id, peerProtocol, httpUrl: body.httpUrl },
            `Added ILP-over-HTTP peer: ${body.id}`
          );
        } else {
          const peer: Peer = {
            id: body.id,
            url: body.url,
            authToken: body.authToken,
            connected: false,
            lastSeen: new Date(),
            transport: body.transport,
          };

          await btpClientManager.addPeer(peer);

          log.info(
            {
              event: 'admin_peer_added',
              peerId: body.id,
              url: body.url,
              // `null` when inheriting the connector default; explicit-null
              // beats a `<default>` sentinel for log-shipper grep semantics.
              transport: body.transport ?? null,
            },
            `Added peer: ${body.id}`
          );
        }
      } else {
        log.info(
          {
            event: 'admin_peer_reregistered',
            peerId: body.id,
            // Live transport — re-registration cannot change it (Decision 7).
            transport: btpClientManager.getPeerTransport(body.id) ?? null,
          },
          `Re-registering peer: ${body.id}`
        );
      }

      // Add routes if provided — explicit or the auto-derived child route.
      // (Routes persist via the RoutingTable write-through; addRoute replaces
      // existing same-prefix routes, no duplicates.)
      const addedRoutes: string[] = [];
      if (effectiveRoutes) {
        for (const route of effectiveRoutes) {
          routingTable.addRoute(route.prefix as ILPAddress, body.id, route.priority ?? 0);
          addedRoutes.push(route.prefix);
          log.info(
            { event: 'admin_route_added', prefix: route.prefix, nextHop: body.id },
            `Added route: ${route.prefix} -> ${body.id}`
          );
        }
      }

      // Propagate the peer's ILP relationship to the forwarding path (issue #76).
      // Defaults to 'peer' so an omitted relation preserves the legacy
      // claim-on-every-forward behavior. Applied on both fresh registration and
      // re-registration so an operator can flip a peer's relation via re-POST.
      if (setPeerRelation) {
        setPeerRelation(body.id, body.relation ?? 'peer');
      }

      // Propagate the peer's packet protocol to the forwarding seam (Epic 38).
      if (setPeerProtocol) {
        setPeerProtocol(body.id, peerProtocol);
      }

      // Create/merge PeerConfig if settlement provided and settlementPeers available
      if (body.settlement && settlementPeers) {
        const s = body.settlement;
        const ilpAddress =
          effectiveRoutes && effectiveRoutes.length > 0 ? effectiveRoutes[0]!.prefix : '';

        // Build settlementTokens
        const settlementTokens: string[] = [];
        if (s.tokenAddress) {
          settlementTokens.push(s.tokenAddress);
        } else {
          if (s.evmAddress) settlementTokens.push('EVM');
        }

        const newConfig: SettlementPeerConfig = {
          peerId: body.id,
          address: ilpAddress,
          settlementPreference: s.preference,
          settlementTokens,
          evmAddress: s.evmAddress,
          tokenAddress: s.tokenAddress,
          tokenNetworkAddress: s.tokenNetworkAddress,
          chainId: s.chainId,
          channelId: s.channelId,
          initialDeposit: s.initialDeposit,
        };

        if (isUpdate) {
          // Merge: spread existing config, overwrite with new non-undefined fields
          const existingConfig = settlementPeers.get(body.id);
          if (existingConfig) {
            const mergedConfig: SettlementPeerConfig = { ...existingConfig };
            for (const [key, value] of Object.entries(newConfig)) {
              if (value !== undefined) {
                (mergedConfig as unknown as Record<string, unknown>)[key] = value;
              }
            }
            settlementPeers.set(body.id, mergedConfig);
          } else {
            settlementPeers.set(body.id, newConfig);
          }
          log.info(
            {
              event: 'admin_settlement_config_merged',
              peerId: body.id,
              preference: s.preference,
            },
            `Merged settlement config for peer: ${body.id}`
          );
        } else {
          settlementPeers.set(body.id, newConfig);
          log.info(
            {
              event: 'admin_settlement_config_added',
              peerId: body.id,
              preference: s.preference,
            },
            `Added settlement config for peer: ${body.id}`
          );
        }
      }

      // Write-through to the persistent registry so this runtime registration
      // survives a restart (the routes were already persisted at the
      // RoutingTable layer; here we persist the peer record with its relation +
      // settlement). Best-effort — the store swallows and logs its own errors.
      registryStore?.savePeer({
        id: body.id,
        url: body.url,
        authToken: body.authToken,
        relation: body.relation,
        transport: body.transport,
        settlementJson: body.settlement ? JSON.stringify(body.settlement) : undefined,
        source: 'runtime',
      });

      if (isUpdate) {
        // Return 200 for re-registration. Per F10/AC-10: echo the LIVE
        // transport (read from the existing BTPClient), NOT body.transport
        // — re-registration cannot change a peer's live transport, so
        // returning the requested value would mislead operators.
        const connected = btpClientManager.isConnected(body.id);
        res.status(200).json({
          success: true,
          peer: {
            id: body.id,
            url: body.url,
            connected,
            transport: btpClientManager.getPeerTransport(body.id),
            relation: body.relation,
          },
          routes: addedRoutes,
          updated: true,
          message: `Peer '${body.id}' updated`,
        });
      } else {
        // Check connection status after a brief delay for new peers
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const connected = btpClientManager.isConnected(body.id);

        res.status(201).json({
          success: true,
          peer: {
            id: body.id,
            url: body.url,
            connected,
            // Fresh registration: echo the requested value (matches what
            // was just persisted on the new BTPClient's Peer record).
            transport: body.transport,
            relation: body.relation,
          },
          routes: addedRoutes,
          created: true,
          message: connected
            ? `Peer '${body.id}' added and connected`
            : `Peer '${body.id}' added (connection pending)`,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error({ event: 'admin_api_error', error: errorMessage }, 'Failed to add peer');
      res.status(500).json({ error: 'Internal server error', message: errorMessage });
    }
  });

  /**
   * DELETE /admin/peers/:peerId
   * Remove a peer and optionally its routes
   */
  router.delete('/peers/:peerId', async (req: Request, res: Response) => {
    try {
      const peerId = req.params.peerId;
      if (!peerId) {
        res.status(400).json({ error: 'Bad request', message: 'Missing peerId parameter' });
        return;
      }
      const removeRoutes = req.query.removeRoutes !== 'false'; // Default: true

      // Check if peer exists
      const existingPeers = btpClientManager.getPeerIds();
      if (!existingPeers.includes(peerId)) {
        res.status(404).json({
          error: 'Not found',
          message: `Peer '${peerId}' not found`,
        });
        return;
      }

      // Remove peer
      await btpClientManager.removePeer(peerId);
      log.info({ event: 'admin_peer_removed', peerId }, `Removed peer: ${peerId}`);

      // Remove settlement config if exists
      if (settlementPeers && settlementPeers.delete(peerId)) {
        log.info(
          { event: 'admin_settlement_config_removed', peerId },
          `Removed settlement config for peer: ${peerId}`
        );
      }

      // Remove routes if requested
      const removedRoutes: string[] = [];
      if (removeRoutes) {
        const routes = routingTable.getAllRoutes();
        for (const route of routes) {
          if (route.nextHop === peerId) {
            routingTable.removeRoute(route.prefix);
            removedRoutes.push(route.prefix);
            log.info(
              { event: 'admin_route_removed', prefix: route.prefix },
              `Removed route: ${route.prefix}`
            );
          }
        }
      }

      // Write-through: drop the peer from the persistent registry so it is not
      // replayed on the next boot. (Removed routes were dropped via the
      // RoutingTable write-through as removeRoute ran above.)
      registryStore?.deletePeer(peerId);

      res.json({
        success: true,
        peerId,
        removedRoutes,
        message: `Peer '${peerId}' removed${removedRoutes.length > 0 ? ` with ${removedRoutes.length} routes` : ''}`,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error({ event: 'admin_api_error', error: errorMessage }, 'Failed to remove peer');
      res.status(500).json({ error: 'Internal server error', message: errorMessage });
    }
  });

  /**
   * PUT /admin/peers/:peerId
   * Update an existing peer's settlement config and/or routes
   */
  router.put('/peers/:peerId', (req: Request, res: Response) => {
    try {
      const peerId = req.params.peerId;
      if (!peerId) {
        res.status(400).json({ error: 'Bad request', message: 'Missing peerId parameter' });
        return;
      }

      // Validate peerId exists
      const existingPeers = btpClientManager.getPeerIds();
      if (!existingPeers.includes(peerId)) {
        res.status(404).json({
          error: 'Not found',
          message: 'Peer not found',
        });
        return;
      }

      const body = req.body as {
        settlement?: AdminSettlementConfig;
        routes?: Array<{ prefix: string; priority?: number }>;
      };

      // Validate settlement config if provided
      if (body.settlement) {
        const settlementError = validateSettlementConfig(body.settlement);
        if (settlementError) {
          res.status(400).json({ error: 'Bad request', message: settlementError });
          return;
        }
      }

      // Validate routes if provided
      if (body.routes) {
        for (const route of body.routes) {
          if (!route.prefix || typeof route.prefix !== 'string') {
            res.status(400).json({
              error: 'Bad request',
              message: 'Invalid route: missing prefix',
            });
            return;
          }
          if (!isValidILPAddress(route.prefix)) {
            res.status(400).json({
              error: 'Bad request',
              message: `Invalid ILP address prefix: ${route.prefix}`,
            });
            return;
          }
        }
      }

      // Update settlement config if provided
      if (body.settlement && settlementPeers) {
        const s = body.settlement;
        const existingConfig = settlementPeers.get(peerId);

        const settlementTokens: string[] = [];
        if (s.tokenAddress) {
          settlementTokens.push(s.tokenAddress);
        } else {
          if (s.evmAddress) settlementTokens.push('EVM');
        }

        const newConfig: SettlementPeerConfig = {
          peerId,
          address: existingConfig?.address ?? '',
          settlementPreference: s.preference,
          settlementTokens,
          evmAddress: s.evmAddress,
          tokenAddress: s.tokenAddress,
          tokenNetworkAddress: s.tokenNetworkAddress,
          chainId: s.chainId,
          channelId: s.channelId,
          initialDeposit: s.initialDeposit,
        };

        if (existingConfig) {
          const mergedConfig: SettlementPeerConfig = { ...existingConfig };
          for (const [key, value] of Object.entries(newConfig)) {
            if (value !== undefined) {
              (mergedConfig as unknown as Record<string, unknown>)[key] = value;
            }
          }
          settlementPeers.set(peerId, mergedConfig);
        } else {
          settlementPeers.set(peerId, newConfig);
        }

        log.info(
          { event: 'admin_peer_settlement_updated', peerId, preference: s.preference },
          `Updated settlement config for peer: ${peerId}`
        );
      }

      // Add routes if provided
      if (body.routes) {
        for (const route of body.routes) {
          routingTable.addRoute(route.prefix as ILPAddress, peerId, route.priority ?? 0);
          log.info(
            { event: 'admin_route_added', prefix: route.prefix, nextHop: peerId },
            `Added route: ${route.prefix} -> ${peerId}`
          );
        }
      }

      res.status(200).json({
        success: true,
        peerId,
        updated: true,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error({ event: 'admin_api_error', error: errorMessage }, 'Failed to update peer');
      res.status(500).json({ error: 'Internal server error', message: errorMessage });
    }
  });

  /**
   * GET /admin/routes
   * List all routes in the routing table
   */
  router.get('/routes', (_req: Request, res: Response) => {
    try {
      const routes = routingTable.getAllRoutes();

      res.json({
        nodeId,
        routeCount: routes.length,
        routes: routes.map((r) => {
          // Enrich with local-termination config (issue #218) when this route is
          // a terminated "app" route — lets `connector app ls` distinguish
          // terminated routes (those carrying `upstream`) from transit routes.
          const termination = routeTerminationRegistry?.lookup(r.prefix);
          return {
            prefix: r.prefix,
            nextHop: r.nextHop,
            priority: r.priority ?? 0,
            ...(termination ? { termination } : {}),
          };
        }),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error({ event: 'admin_api_error', error: errorMessage }, 'Failed to list routes');
      res.status(500).json({ error: 'Internal server error', message: errorMessage });
    }
  });

  /**
   * POST /admin/routes
   * Add a new route to the routing table
   */
  router.post('/routes', (req: Request, res: Response) => {
    try {
      const body = req.body as AddRouteRequest;

      // Validate required fields
      if (!body.prefix || typeof body.prefix !== 'string') {
        res.status(400).json({ error: 'Bad request', message: 'Missing or invalid prefix' });
        return;
      }
      if (!body.nextHop || typeof body.nextHop !== 'string') {
        res.status(400).json({ error: 'Bad request', message: 'Missing or invalid nextHop' });
        return;
      }

      // Validate ILP address format
      if (!isValidILPAddress(body.prefix)) {
        res.status(400).json({
          error: 'Bad request',
          message: `Invalid ILP address prefix: ${body.prefix}`,
        });
        return;
      }

      // Check if nextHop peer exists (warning only, don't block)
      const existingPeers = btpClientManager.getPeerIds();
      const peerExists = existingPeers.includes(body.nextHop);

      // Relation ↔ route admission validation against the nextHop peer's
      // relation (Phase 2), mirroring ConnectorNode.addRoute(). Unknown/local
      // nextHops resolve to undefined → treated as 'peer' (no constraint), so
      // this only rejects an unambiguous child/parent-shaped mismatch.
      const nextHopRelation = getPeerRelation?.(body.nextHop);
      const localPrefixes = deriveLocalPrefixes(routingTable.getAllRoutes(), nodeId);
      const relationValidation = validateRelationRoute(nextHopRelation, localPrefixes, [
        body.prefix,
      ]);
      if (!relationValidation.ok) {
        res.status(400).json({ error: 'Bad request', message: relationValidation.error });
        return;
      }

      // Validate optional local-termination config (issue #218) with the SAME
      // helper the boot loader uses, so runtime and boot are identical. No-op
      // for ordinary forwarding routes (no `upstream`).
      const terminationValidation = validateRouteTermination(body, isValidNonNegativeIntegerString);
      if (!terminationValidation.ok) {
        res.status(400).json({ error: 'Bad request', message: terminationValidation.error });
        return;
      }

      // Add route (persisted via the RoutingTable write-through)
      const priority = body.priority ?? 0;
      routingTable.addRoute(body.prefix as ILPAddress, body.nextHop, priority);

      // Apply (or clear) the route's termination config in the registry #216's
      // proxy handler resolves against, and persist it (write-through) so a
      // terminated route survives a restart.
      const termination = toRouteTermination(body);
      if (termination) {
        routeTerminationRegistry?.set(body.prefix, termination);
      } else {
        routeTerminationRegistry?.delete(body.prefix);
      }
      registryStore?.saveRoute?.({
        prefix: body.prefix,
        nextHop: body.nextHop,
        priority,
        source: 'runtime',
        terminationJson: termination ? JSON.stringify(termination) : undefined,
      });

      log.info(
        { event: 'admin_route_added', prefix: body.prefix, nextHop: body.nextHop, priority },
        `Added route: ${body.prefix} -> ${body.nextHop}`
      );

      res.status(201).json({
        success: true,
        route: {
          prefix: body.prefix,
          nextHop: body.nextHop,
          priority,
        },
        warning: peerExists ? undefined : `Peer '${body.nextHop}' does not exist yet`,
        message: `Route '${body.prefix}' -> '${body.nextHop}' added`,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error({ event: 'admin_api_error', error: errorMessage }, 'Failed to add route');
      res.status(500).json({ error: 'Internal server error', message: errorMessage });
    }
  });

  /**
   * DELETE /admin/routes/:prefix
   * Remove a route from the routing table
   *
   * Note: prefix is URL-encoded (e.g., g.agent.alice becomes g.agent.alice)
   * Use encodeURIComponent for prefixes with special characters
   */
  router.delete('/routes/:prefix(*)', (req: Request, res: Response) => {
    try {
      const rawPrefix = req.params.prefix;
      if (!rawPrefix) {
        res.status(400).json({ error: 'Bad request', message: 'Missing prefix parameter' });
        return;
      }
      const prefix = decodeURIComponent(rawPrefix);

      // Check if route exists
      const routes = routingTable.getAllRoutes();
      const existingRoute = routes.find((r) => r.prefix === prefix);

      if (!existingRoute) {
        res.status(404).json({
          error: 'Not found',
          message: `Route with prefix '${prefix}' not found`,
        });
        return;
      }

      // Remove route
      routingTable.removeRoute(prefix);

      log.info({ event: 'admin_route_removed', prefix }, `Removed route: ${prefix}`);

      res.json({
        success: true,
        prefix,
        message: `Route '${prefix}' removed`,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error({ event: 'admin_api_error', error: errorMessage }, 'Failed to remove route');
      res.status(500).json({ error: 'Internal server error', message: errorMessage });
    }
  });

  /**
   * PUT /admin/desired-state
   *
   * Declarative reconciliation of the full peer/route set. The body describes
   * the desired end-state; the connector diffs it against the running state and
   * applies the minimal add/update/remove to converge. Idempotent: re-PUTting
   * the same body is a no-op. This is the front-end to the persistent registry —
   * the resulting peers/routes are written through and survive a restart.
   *
   * Body: `{ peers?: AddPeerRequest[], routes?: AddRouteRequest[] }`
   *   - `peers` is the COMPLETE desired peer set; peers not listed are removed.
   *   - A peer's `routes` (or the child auto-route) plus the top-level `routes`
   *     form the COMPLETE desired set of peer routes; peer routes not listed are
   *     removed. The connector's own local routes (nextHop === nodeId/'local')
   *     are always preserved.
   *
   * Validation is atomic: if any peer/route is invalid the whole request is
   * rejected with 400 and nothing is mutated.
   */
  router.put('/desired-state', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        peers?: AddPeerRequest[];
        routes?: AddRouteRequest[];
      };
      const desiredPeers = body.peers ?? [];
      const desiredTopRoutes = body.routes ?? [];

      const localPrefixes = deriveLocalPrefixes(routingTable.getAllRoutes(), nodeId);
      // Relations of peers in THIS request, so a top-level route whose nextHop
      // is a peer being added in the same PUT validates against its new relation.
      const desiredRelations = new Map<string, PeerRelation>();
      for (const p of desiredPeers) {
        desiredRelations.set(p.id, (p.relation as PeerRelation) ?? 'peer');
      }

      // ── Validate everything up front (no mutation on failure) ──
      const reject = (message: string): void => {
        res.status(400).json({ error: 'Bad request', message });
      };
      // Per-peer effective routes (explicit or child auto-route), reused below.
      const peerEffectiveRoutes = new Map<string, Array<{ prefix: string; priority?: number }>>();
      for (const peer of desiredPeers) {
        if (!peer.id || typeof peer.id !== 'string') return reject('Missing or invalid peer id');
        if (!peer.url || typeof peer.url !== 'string') return reject('Missing or invalid peer url');
        if (typeof peer.authToken !== 'string') {
          return reject('authToken must be a string (can be empty for no auth)');
        }
        if (!peer.url.startsWith('ws://') && !peer.url.startsWith('wss://')) {
          return reject('URL must start with ws:// or wss://');
        }
        if (peer.transport !== undefined && peer.transport !== 'direct') {
          return reject(`Invalid transport: must be 'direct' (got '${String(peer.transport)}')`);
        }
        if (
          peer.relation !== undefined &&
          peer.relation !== 'parent' &&
          peer.relation !== 'peer' &&
          peer.relation !== 'child'
        ) {
          return reject(
            `Invalid relation: must be 'parent', 'peer', or 'child' (got '${peer.relation}')`
          );
        }
        let effective = peer.routes;
        if (!effective || effective.length === 0) {
          const autoRoute = deriveDefaultChildRoute(peer.relation, localPrefixes, peer.id);
          if (autoRoute) effective = [autoRoute];
        }
        for (const r of effective ?? []) {
          if (!r.prefix || !isValidILPAddress(r.prefix)) {
            return reject(`Invalid ILP address prefix: ${r.prefix}`);
          }
        }
        if (effective && effective.length > 0) {
          const v = validateRelationRoute(
            peer.relation,
            localPrefixes,
            effective.map((r) => r.prefix)
          );
          if (!v.ok) return reject(v.error);
        }
        peerEffectiveRoutes.set(peer.id, effective ?? []);
      }
      for (const route of desiredTopRoutes) {
        if (!route.prefix || !isValidILPAddress(route.prefix)) {
          return reject(`Invalid ILP address prefix: ${route.prefix}`);
        }
        if (!route.nextHop || typeof route.nextHop !== 'string') {
          return reject('Missing or invalid nextHop');
        }
        const relation = desiredRelations.get(route.nextHop) ?? getPeerRelation?.(route.nextHop);
        const v = validateRelationRoute(relation, localPrefixes, [route.prefix]);
        if (!v.ok) return reject(v.error);
        // Local-termination config (issue #218) — validated atomically up front
        // with the boot loader's helper; nothing is mutated if any route fails.
        const tv = validateRouteTermination(route, isValidNonNegativeIntegerString);
        if (!tv.ok) return reject(tv.error);
      }

      // ── Build the desired route set (peer routes + top-level routes) ──
      const desiredRoutes = new Map<
        string,
        { nextHop: string; priority: number; termination?: RouteTermination }
      >();
      for (const peer of desiredPeers) {
        for (const r of peerEffectiveRoutes.get(peer.id) ?? []) {
          desiredRoutes.set(r.prefix, { nextHop: peer.id, priority: r.priority ?? 0 });
        }
      }
      for (const r of desiredTopRoutes) {
        desiredRoutes.set(r.prefix, {
          nextHop: r.nextHop,
          priority: r.priority ?? 0,
          termination: toRouteTermination(r),
        });
      }

      // ── Reconcile peers: remove those not desired ──
      const desiredPeerIds = new Set(desiredPeers.map((p) => p.id));
      const currentPeerIds = btpClientManager.getPeerIds();
      const removedPeers: string[] = [];
      for (const peerId of currentPeerIds) {
        if (!desiredPeerIds.has(peerId)) {
          await btpClientManager.removePeer(peerId);
          settlementPeers?.delete(peerId);
          registryStore?.deletePeer(peerId);
          removedPeers.push(peerId);
        }
      }

      // ── Reconcile peers: add/update desired ──
      const addedPeers: string[] = [];
      for (const peer of desiredPeers) {
        const isUpdate = currentPeerIds.includes(peer.id);
        if (!isUpdate) {
          await btpClientManager.addPeer({
            id: peer.id,
            url: peer.url,
            authToken: peer.authToken,
            connected: false,
            lastSeen: new Date(),
            transport: peer.transport,
          });
          addedPeers.push(peer.id);
        }
        if (setPeerRelation) setPeerRelation(peer.id, peer.relation ?? 'peer');
        if (peer.settlement && settlementPeers) {
          const s = peer.settlement;
          const ilp = peerEffectiveRoutes.get(peer.id)?.[0]?.prefix ?? '';
          const settlementTokens: string[] = s.tokenAddress
            ? [s.tokenAddress]
            : s.evmAddress
              ? ['EVM']
              : [];
          settlementPeers.set(peer.id, {
            peerId: peer.id,
            address: ilp,
            settlementPreference: s.preference,
            settlementTokens,
            evmAddress: s.evmAddress,
            tokenAddress: s.tokenAddress,
            tokenNetworkAddress: s.tokenNetworkAddress,
            chainId: s.chainId,
            channelId: s.channelId,
            initialDeposit: s.initialDeposit,
          });
        }
        registryStore?.savePeer({
          id: peer.id,
          url: peer.url,
          authToken: peer.authToken,
          relation: peer.relation,
          transport: peer.transport,
          settlementJson: peer.settlement ? JSON.stringify(peer.settlement) : undefined,
          source: 'runtime',
        });
      }

      // ── Reconcile routes: drop undesired peer routes (preserve local self
      //    routes), then upsert desired routes (RoutingTable persists them) ──
      const removedRoutes: string[] = [];
      for (const r of routingTable.getAllRoutes()) {
        const isLocal = r.nextHop === nodeId || r.nextHop === 'local';
        if (!isLocal && !desiredRoutes.has(r.prefix)) {
          routingTable.removeRoute(r.prefix);
          removedRoutes.push(r.prefix);
        }
      }
      for (const [prefix, info] of desiredRoutes) {
        routingTable.addRoute(prefix as ILPAddress, info.nextHop, info.priority);
      }

      // ── Reconcile the route-termination registry (issue #218) ──
      // Clear undesired terminated prefixes, then upsert desired ones. Mirrors
      // the routing-table reconcile above so the proxy handler's upstream
      // resolution converges with the routing table. Prefixes carried by routes
      // without termination config are cleared (a route can flip from terminated
      // to plain forwarding via a re-PUT). Local self-routes are never in the
      // registry (they carry no termination), so they are implicitly preserved.
      if (routeTerminationRegistry) {
        for (const prefix of routeTerminationRegistry.prefixes()) {
          if (!desiredRoutes.has(prefix) || !desiredRoutes.get(prefix)?.termination) {
            routeTerminationRegistry.delete(prefix);
          }
        }
        for (const [prefix, info] of desiredRoutes) {
          if (info.termination) {
            routeTerminationRegistry.set(prefix, info.termination);
          }
        }
      }
      // Persist terminated routes' config (write-through) so they survive a
      // restart. prefix/nextHop/priority are already persisted by the routing
      // table's own sink; this carries the termination JSON the routing table
      // does not see.
      for (const [prefix, info] of desiredRoutes) {
        if (info.termination) {
          registryStore?.saveRoute?.({
            prefix,
            nextHop: info.nextHop,
            priority: info.priority,
            source: 'runtime',
            terminationJson: JSON.stringify(info.termination),
          });
        }
      }

      log.info(
        {
          event: 'admin_desired_state_reconciled',
          addedPeers: addedPeers.length,
          removedPeers: removedPeers.length,
          desiredRoutes: desiredRoutes.size,
          removedRoutes: removedRoutes.length,
        },
        'Reconciled desired state'
      );

      res.json({
        success: true,
        peers: {
          added: addedPeers,
          removed: removedPeers,
          total: desiredPeers.length,
        },
        routes: {
          desired: Array.from(desiredRoutes.keys()),
          removed: removedRoutes,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(
        { event: 'admin_api_error', error: errorMessage },
        'Failed to reconcile desired state'
      );
      res.status(500).json({ error: 'Internal server error', message: errorMessage });
    }
  });

  // --- Payment Channel Endpoints ---

  /**
   * POST /admin/channels
   * Open a new payment channel
   */
  router.post('/channels', async (req: Request, res: Response) => {
    try {
      if (!channelManager) {
        res.status(503).json({
          error: 'Service Unavailable',
          message: 'Settlement infrastructure not enabled',
        });
        return;
      }

      const validation = validateOpenChannelRequest(req.body as Record<string, unknown>);
      if (!validation.valid) {
        res.status(400).json({ error: 'Bad request', message: validation.error });
        return;
      }

      const body = req.body as OpenChannelRequest;

      // Validate peer exists before opening channels
      const existingPeers = btpClientManager.getPeerIds();
      if (!existingPeers.includes(body.peerId)) {
        res.status(404).json({
          error: 'Not found',
          message: `Peer '${body.peerId}' must be registered before opening channels`,
        });
        return;
      }

      const chainPrefix = body.chain.split(':')[0];

      if (chainPrefix === 'evm') {
        // Derive tokenId from request
        const tokenId = body.token ?? 'AGENT';

        // Resolve peer EVM address: explicit request field, then settlementPeers fallback
        const peerConfig = settlementPeers?.get(body.peerId);
        const peerAddress = body.peerAddress || peerConfig?.evmAddress;
        if (!peerAddress) {
          res.status(400).json({
            error: 'Bad request',
            message: 'Peer EVM address must be provided in request or peer registration',
          });
          return;
        }

        // Validate EVM address format if provided in request
        if (body.peerAddress && !/^0x[0-9a-fA-F]{40}$/.test(body.peerAddress)) {
          res.status(400).json({
            error: 'Bad request',
            message: 'Invalid EVM address format: must be 0x-prefixed 42-char hex',
          });
          return;
        }

        const addressSource = body.peerAddress ? 'request' : 'registration';
        log.info(
          { peerId: body.peerId, peerAddress, source: addressSource },
          `Resolved peer EVM address from ${addressSource}`
        );

        // Check for existing channel
        const existing = channelManager.getChannelForPeer(body.peerId, tokenId);
        if (existing && existing.status !== 'closed') {
          res.status(409).json({
            error: 'Conflict',
            message: `Channel already exists for peer ${body.peerId} with token ${tokenId} on chain ${body.chain}`,
          });
          return;
        }

        const channelId = await channelManager.ensureChannelExists(body.peerId, tokenId, {
          initialDeposit: BigInt(body.initialDeposit),
          settlementTimeout: body.settlementTimeout,
          chain: body.chain,
          peerAddress,
        });

        log.info(
          { peerId: body.peerId, chain: body.chain, channelId },
          'Channel opened via Admin API'
        );

        const metadata = channelManager.getChannelById(channelId);
        if (!metadata) {
          res.status(500).json({
            error: 'Internal error',
            message: 'Channel created but metadata unavailable',
          });
          return;
        }

        res.status(201).json({
          channelId,
          chain: body.chain,
          status: normalizeChannelStatus(metadata.status, log),
          deposit: body.initialDeposit,
        } satisfies OpenChannelResponse);
      } else {
        res.status(400).json({
          error: 'Bad request',
          message: `Unsupported blockchain: ${chainPrefix}`,
        });
      }
    } catch (error) {
      log.error(
        {
          err: error,
          peerId: (req.body as Record<string, unknown>).peerId,
          chain: (req.body as Record<string, unknown>).chain,
        },
        'Channel open failed'
      );
      res.status(500).json({ error: 'Internal error', message: 'Channel open failed' });
    }
  });

  /**
   * GET /admin/channels
   * List all channels with optional filters
   */
  router.get('/channels', async (_req: Request, res: Response) => {
    try {
      if (!channelManager) {
        res.status(503).json({
          error: 'Service Unavailable',
          message: 'Settlement infrastructure not enabled',
        });
        return;
      }

      let channels = channelManager.getAllChannels();

      // Apply optional query filters
      const filterPeerId = _req.query.peerId as string | undefined;
      const filterChain = _req.query.chain as string | undefined;
      const filterStatus = _req.query.status as string | undefined;

      if (filterPeerId) {
        channels = channels.filter((ch) => ch.peerId === filterPeerId);
      }
      if (filterChain) {
        channels = channels.filter((ch) => ch.chain === filterChain);
      }
      if (filterStatus) {
        const normalizedFilter = normalizeChannelStatus(filterStatus, log);
        channels = channels.filter(
          (ch) => normalizeChannelStatus(ch.status, log) === normalizedFilter
        );
      }

      // Map to response format
      const summaries: ChannelSummary[] = channels.map((ch) => ({
        channelId: ch.channelId,
        peerId: ch.peerId,
        chain: ch.chain,
        status: normalizeChannelStatus(ch.status, log),
        deposit: 'unknown',
        lastActivity: ch.lastActivityAt.toISOString(),
      }));

      // Try to enrich with on-chain deposit info (parallel queries)
      if (paymentChannelSDK) {
        await Promise.all(
          summaries.map(async (summary) => {
            try {
              const ch = channels.find((c) => c.channelId === summary.channelId);
              if (ch) {
                const state = await paymentChannelSDK.getChannelState(
                  ch.channelId,
                  ch.tokenAddress
                );
                summary.deposit = state.myDeposit.toString();
              }
            } catch {
              // Leave as 'unknown' if query fails
            }
          })
        );
      }

      res.json(summaries);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error({ event: 'admin_api_error', error: errorMessage }, 'Failed to list channels');
      res.status(500).json({ error: 'Internal server error', message: errorMessage });
    }
  });

  /**
   * GET /admin/channels/:channelId
   * Get channel details with on-chain state
   */
  router.get('/channels/:channelId', async (req: Request, res: Response) => {
    try {
      if (!channelManager) {
        res.status(503).json({
          error: 'Service Unavailable',
          message: 'Settlement infrastructure not enabled',
        });
        return;
      }

      const reqChannelId = req.params.channelId as string;
      const metadata = channelManager.getChannelById(reqChannelId);

      if (!metadata) {
        res.status(404).json({ error: 'Not found', message: 'Channel not found' });
        return;
      }

      // Query on-chain state if SDK available
      if (paymentChannelSDK && metadata.chain.startsWith('evm')) {
        const state = await paymentChannelSDK.getChannelState(
          metadata.channelId,
          metadata.tokenAddress
        );

        // Serialize BigInt values to strings
        res.json({
          channelId: state.channelId,
          participants: state.participants,
          deposit: state.myDeposit.toString(),
          theirDeposit: state.theirDeposit.toString(),
          transferred: state.myTransferred.toString(),
          theirTransferred: state.theirTransferred.toString(),
          status: normalizeChannelStatus(state.status, log),
          nonce: state.myNonce,
          theirNonce: state.theirNonce,
          settlementTimeout: state.settlementTimeout,
          openedAt: state.openedAt,
          closedAt: state.closedAt,
        } satisfies ChannelDetailResponse);
        return;
      }

      // Fallback: return metadata only (non-EVM or SDK unavailable)
      res.json({
        channelId: metadata.channelId,
        peerId: metadata.peerId,
        chain: metadata.chain,
        status: normalizeChannelStatus(metadata.status, log),
        deposit: 'unknown',
        tokenId: metadata.tokenId,
        createdAt: metadata.createdAt.toISOString(),
        lastActivity: metadata.lastActivityAt.toISOString(),
      } satisfies ChannelDetailResponse);
    } catch (error) {
      log.error({ err: error, channelId: req.params.channelId }, 'Failed to query channel state');
      res.status(500).json({ error: 'Internal error', message: 'Failed to query channel state' });
    }
  });

  /**
   * POST /admin/channels/:channelId/deposit
   * Add funds to a payment channel
   */
  router.post('/channels/:channelId/deposit', async (req: Request, res: Response) => {
    try {
      if (!channelManager) {
        res.status(503).json({
          error: 'Service Unavailable',
          message: 'Settlement infrastructure not enabled',
        });
        return;
      }

      const reqChannelId = req.params.channelId as string;
      const metadata = channelManager.getChannelById(reqChannelId);

      if (!metadata) {
        res.status(404).json({ error: 'Not found', message: 'Channel not found' });
        return;
      }

      const validation = validateDepositRequest(req.body as Record<string, unknown>);
      if (!validation.valid) {
        res.status(400).json({ error: 'Bad request', message: validation.error });
        return;
      }

      if (normalizeChannelStatus(metadata.status, log) !== 'open') {
        res.status(400).json({
          error: 'Bad request',
          message: 'Channel is not in open state',
        });
        return;
      }

      const { amount } = req.body as DepositRequest;
      const chainPrefix = metadata.chain.split(':')[0];

      if (chainPrefix === 'evm') {
        if (!paymentChannelSDK) {
          res.status(503).json({
            error: 'Service Unavailable',
            message: 'EVM settlement infrastructure not enabled',
          });
          return;
        }

        await paymentChannelSDK.deposit(reqChannelId, metadata.tokenAddress, BigInt(amount));

        const state = await paymentChannelSDK.getChannelState(reqChannelId, metadata.tokenAddress);

        metadata.lastActivityAt = new Date();

        log.info(
          { channelId: reqChannelId, chain: chainPrefix, amount },
          'Deposit completed via Admin API'
        );

        res.json({
          channelId: reqChannelId,
          newDeposit: state.myDeposit.toString(),
          status: normalizeChannelStatus(metadata.status, log),
        } satisfies DepositResponse);
      } else {
        res.status(400).json({
          error: 'Bad request',
          message: `Unsupported blockchain: ${chainPrefix}`,
        });
      }
    } catch (error) {
      log.error({ err: error, channelId: req.params.channelId }, 'Deposit failed');
      res.status(500).json({ error: 'Internal error', message: 'Deposit failed' });
    }
  });

  /**
   * POST /admin/channels/:channelId/close
   * Initiate channel close
   */
  router.post('/channels/:channelId/close', async (req: Request, res: Response) => {
    try {
      if (!channelManager) {
        res.status(503).json({
          error: 'Service Unavailable',
          message: 'Settlement infrastructure not enabled',
        });
        return;
      }

      const reqChannelId = req.params.channelId as string;
      const metadata = channelManager.getChannelById(reqChannelId);

      if (!metadata) {
        res.status(404).json({ error: 'Not found', message: 'Channel not found' });
        return;
      }

      const normalizedStatus = normalizeChannelStatus(metadata.status, log);
      if (normalizedStatus !== 'open' && normalizedStatus !== 'opening') {
        res.status(400).json({
          error: 'Bad request',
          message: 'Channel is not in a closeable state',
        });
        return;
      }

      const chainPrefix = metadata.chain.split(':')[0];

      if (chainPrefix === 'evm') {
        if (!paymentChannelSDK) {
          res.status(503).json({
            error: 'Service Unavailable',
            message: 'EVM settlement infrastructure not enabled',
          });
          return;
        }

        // Close channel — starts grace period for receiver to submit claims
        await paymentChannelSDK.closeChannel(reqChannelId, metadata.tokenAddress);

        metadata.status = 'closing';
        metadata.lastActivityAt = new Date();

        log.info(
          { channelId: reqChannelId, chain: chainPrefix },
          'Channel close initiated via Admin API (grace period started)'
        );

        res.json({
          channelId: reqChannelId,
          status: 'closing',
        } satisfies CloseChannelResponse);
      } else {
        res.status(400).json({
          error: 'Bad request',
          message: `Unsupported blockchain: ${chainPrefix}`,
        });
      }
    } catch (error) {
      log.error({ err: error, channelId: req.params.channelId }, 'Channel close failed');
      res.status(500).json({ error: 'Internal error', message: 'Channel close failed' });
    }
  });

  // --- Balance and Settlement State Query Endpoints (Story 21.3) ---

  /**
   * GET /admin/balances/:peerId
   * Query balance for a specific peer
   */
  router.get('/balances/:peerId', async (req: Request, res: Response) => {
    try {
      if (!accountManager) {
        res.status(503).json({
          error: 'Service Unavailable',
          message: 'Account management not enabled',
        });
        return;
      }

      const peerId = req.params.peerId as string;
      const tokenId = (req.query.tokenId as string) || (defaultSettlementTokenId ?? 'M2M');

      // Story 37.1: Distinguish unknown peer (404) from known-but-idle peer (200 zeros).
      // Without this guard, account-manager.ts:441 returns zeroed balances for any peerId
      // because it deterministically derives TigerBeetle account IDs and defaults missing
      // ledger entries to 0n, collapsing both cases into an identical 200 response.
      const registeredPeers = btpClientManager.getPeerIds();
      if (!registeredPeers.includes(peerId)) {
        res.status(404).json({
          error: 'Not found',
          peerId,
          message: `Peer '${peerId}' not found`,
        });
        return;
      }

      const balance = await accountManager.getAccountBalance(peerId, tokenId);

      const response = {
        peerId,
        balances: [
          {
            tokenId,
            debitBalance: balance.debitBalance.toString(),
            creditBalance: balance.creditBalance.toString(),
            netBalance: balance.netBalance.toString(),
          },
        ],
      } satisfies BalanceResponse;

      log.info({ peerId, tokenId }, 'Balance queried via Admin API');
      res.json(response);
    } catch (error) {
      log.error({ err: error, peerId: req.params.peerId }, 'Balance query failed');
      res.status(500).json({ error: 'Internal error', message: 'Balance query failed' });
    }
  });

  /**
   * GET /admin/settlement/states
   * Query all settlement monitor states
   */
  router.get('/settlement/states', (_req: Request, res: Response) => {
    try {
      if (!settlementMonitor) {
        res.status(503).json({
          error: 'Service Unavailable',
          message: 'Settlement monitoring not enabled',
        });
        return;
      }

      const allStates = settlementMonitor.getAllSettlementStates();
      const states: SettlementStateResponse[] = [];

      for (const [key, state] of allStates.entries()) {
        const separatorIndex = key.lastIndexOf(':');
        const peerId = key.substring(0, separatorIndex);
        const tokenId = key.substring(separatorIndex + 1);
        states.push({ peerId, tokenId, state });
      }

      log.info({ stateCount: states.length }, 'Settlement states queried via Admin API');
      res.json(states);
    } catch (error) {
      log.error({ err: error }, 'Settlement state query failed');
      res.status(500).json({ error: 'Internal error', message: 'Settlement state query failed' });
    }
  });

  /**
   * GET /admin/channels/:channelId/claims
   * Get latest claim for a channel
   */
  router.get('/channels/:channelId/claims', async (req: Request, res: Response) => {
    try {
      if (!channelManager) {
        res.status(503).json({
          error: 'Service Unavailable',
          message: 'Settlement infrastructure not enabled',
        });
        return;
      }

      if (!claimReceiver) {
        res.status(503).json({
          error: 'Service Unavailable',
          message: 'Claim receiver not enabled',
        });
        return;
      }

      const channelId = req.params.channelId as string;
      const metadata = channelManager.getChannelById(channelId);

      if (!metadata) {
        res.status(404).json({ error: 'Not found', message: 'Channel not found' });
        return;
      }

      const chainPrefix = metadata.chain.split(':')[0];
      const blockchain = chainPrefix as BlockchainType;

      const claim = await claimReceiver.getLatestVerifiedClaim(
        metadata.peerId,
        blockchain,
        channelId
      );

      if (!claim) {
        res.status(404).json({ error: 'Not found', message: 'No claims found for this channel' });
        return;
      }

      log.info({ channelId, blockchain }, 'Claim queried via Admin API');
      res.json(claim);
    } catch (error) {
      log.error({ err: error, channelId: req.params.channelId }, 'Claim query failed');
      res.status(500).json({ error: 'Internal error', message: 'Claim query failed' });
    }
  });

  // --- ILP Send Endpoint ---

  /**
   * POST /admin/ilp/send
   * Send an outbound ILP Prepare packet
   */
  const ilpSendHandler = new IlpSendHandler(packetSender ?? null, isReady ?? null, log);
  router.post('/ilp/send', ilpSendHandler.handle.bind(ilpSendHandler));

  /**
   * GET /admin/metrics.json
   * JSON projection of per-peer ILP counters from the metrics registry.
   * Story 37.3 — mirrors the Prometheus counters in a dashboard-friendly format.
   */
  router.get('/metrics.json', async (_req: Request, res: Response) => {
    try {
      if (!metricsRegistry) {
        res.status(503).json({
          error: 'Service Unavailable',
          message: 'Metrics not enabled',
        });
        return;
      }

      // `btpClientManager.getPeerIds()` is the authoritative peer set: peers removed via
      // POST/DELETE /admin/peers disappear from this response immediately, even if their
      // counter labels persist in the registry. The snapshot is used only to read current
      // counter values; a peer appearing in the snapshot but not in getPeerIds() is a
      // removed peer and is intentionally dropped. Idle peers (registered but zero
      // activity) still appear because getPeerIds() includes them (AC 3).
      const livePeerIds = btpClientManager.getPeerIds();
      const peerSnapshots = await metricsRegistry.snapshotPeers();
      const snapshotByPeer = new Map(peerSnapshots.map((s) => [s.peerId, s]));

      // Build per-peer entries
      const peerStatus = btpClientManager.getPeerStatus();
      const peers = [...livePeerIds].sort().map((peerId) => {
        const snap = snapshotByPeer.get(peerId);
        const lastPacketAt =
          snap && snap.lastPacketAtUnixSeconds > 0
            ? new Date(snap.lastPacketAtUnixSeconds * 1000).toISOString()
            : null;
        return {
          peerId,
          connected: peerStatus.get(peerId) ?? false,
          packetsForwarded: snap?.packetsForwarded ?? 0,
          packetsRejected: snap?.packetsRejected ?? 0,
          bytesSent: snap?.bytesSent ?? 0,
          packetsLocallyDelivered: snap?.packetsLocallyDelivered ?? 0,
          lastPacketAt,
        } satisfies AdminMetricsJsonPeer;
      });

      // Aggregate rollup
      const aggregate = peers.reduce(
        (acc, p) => ({
          packetsForwarded: acc.packetsForwarded + p.packetsForwarded,
          packetsRejected: acc.packetsRejected + p.packetsRejected,
          bytesSent: acc.bytesSent + p.bytesSent,
          packetsLocallyDelivered: acc.packetsLocallyDelivered + p.packetsLocallyDelivered,
        }),
        { packetsForwarded: 0, packetsRejected: 0, bytesSent: 0, packetsLocallyDelivered: 0 }
      );

      // Dashboard polls at 1 Hz; prevent proxies / browsers from caching stale data.
      res.set('Cache-Control', 'no-store');
      res.json({
        uptimeSeconds: Math.floor(process.uptime()),
        aggregate,
        peers,
        timestamp: new Date().toISOString(),
      } satisfies AdminMetricsJsonResponse);
    } catch (error) {
      log.error(
        {
          event: 'admin_api_metrics_error',
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to generate metrics.json'
      );
      res.status(500).json({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /admin/earnings.json
   *
   * Per-peer per-asset earnings projection for the connector node-operator
   * dashboard (Story 37.4). Sources:
   *   - Per-asset cumulative volume: AccountManager.getPeerVolumeTotals()
   *     reads raw TigerBeetle `debits_posted` / `credits_posted` counters
   *     bypassing the legacy self-balancing `netBalance` quirks.
   *   - Asset inventory per peer: ClaimReceiver.getAssetsForPeer() returns
   *     distinct (blockchain, tokenAddress) pairs observed in verified claims,
   *     merged with the configured settlement token for each peer so that
   *     idle peers with no claim history still appear (AC 3).
   *   - Asset metadata (assetCode/assetScale): the injected
   *     `resolveTokenMetadata` resolver performs an on-chain lookup
   *     (ERC-20 symbol()/decimals() on EVM, SPL mint metadata on Solana,
   *     zkApp token lookup on Mina) with in-closure caching.
   *   - Connector fee revenue: approximate — sum(incomingVolume) * feePct.
   *     A dedicated fee-ledger account is a deliberate follow-up; see story
   *     37.4 dev-notes.
   *   - recentClaims ring: ClaimReceiver.getRecentClaims() ORDER BY ts DESC.
   *
   * Peer set: authoritative via `btpClientManager.getPeerIds()`, consistent
   * with /metrics.json (D1 in 37.3 review).
   */
  router.get('/earnings.json', async (_req: Request, res: Response) => {
    try {
      if (!accountManager || !claimReceiver) {
        res.status(503).json({
          error: 'Service Unavailable',
          message: 'Earnings subsystem not enabled (accountManager or claimReceiver missing)',
        });
        return;
      }

      // Per-request metadata resolver: default to raw-address fallback when the
      // operator did not inject an on-chain resolver. The fallback satisfies
      // the AdminEarningsByAsset shape (assetCode is non-null, assetScale is a
      // finite number) but yields raw integer amounts on the dashboard.
      const metadataFallback = async (
        _chain: 'evm' | 'solana' | 'mina',
        tokenAddress: string
      ): Promise<{ assetCode: string; assetScale: number }> => ({
        assetCode: tokenAddress || 'UNKNOWN',
        assetScale: 0,
      });
      const resolve = resolveTokenMetadata ?? metadataFallback;

      // Per-request cache keyed by `${blockchain}:${tokenAddress}`. Dashboard
      // polls at ~0.2 Hz so each request does at most one RPC per distinct
      // asset. The injected resolver is expected to cache across requests;
      // this cache is only for intra-request dedup.
      const metaCache = new Map<string, { assetCode: string; assetScale: number }>();
      const resolveCached = async (
        blockchain: 'evm' | 'solana' | 'mina',
        tokenAddress: string
      ): Promise<{ assetCode: string; assetScale: number }> => {
        const key = `${blockchain}:${tokenAddress}`;
        const hit = metaCache.get(key);
        if (hit) return hit;
        let meta: { assetCode: string; assetScale: number };
        try {
          meta = await resolve(blockchain, tokenAddress);
        } catch (err) {
          log.warn(
            {
              event: 'admin_api_earnings_metadata_failed',
              blockchain,
              tokenAddress,
              error: err instanceof Error ? err.message : String(err),
            },
            'Token metadata lookup failed; using raw-address fallback'
          );
          meta = await metadataFallback(blockchain, tokenAddress);
        }
        metaCache.set(key, meta);
        return meta;
      };

      const livePeerIds = [...btpClientManager.getPeerIds()].sort();

      // Per-peer entries. Assets = union of three sources:
      //   - chain-verified inbound claims (received_claims DB)
      //   - chain-verified outbound claims (sent_claims DB) — when wired
      //   - configured settlement tokens (idle-peer completeness)
      // This merge guarantees inbound-only, outbound-only, and bidirectional
      // peers all surface with the right byAsset rows.
      //
      // When `sentClaimsQueries` is not provided the endpoint degrades to the
      // 37.4 behaviour (claimsSentTotal = "0", inbound-only ticker).
      const peersOut: AdminEarningsJsonPeer[] = [];
      const incomingTotalByAsset = new Map<string, bigint>();
      void accountManager; // reachability check; also keeps the 503 guard honest
      for (const peerId of livePeerIds) {
        // 1. Chain-verified inbound by asset (latest-nonce per channel, summed).
        const inboundByAsset = await claimReceiver.getCumulativeInboundByAsset(peerId);

        // 2. Chain-verified outbound by asset (empty map if queries not wired).
        const outboundByAsset = sentClaimsQueries
          ? await sentClaimsQueries.getCumulativeOutboundByAsset(peerId)
          : new Map<
              string,
              {
                blockchain: 'evm' | 'solana' | 'mina';
                tokenAddress: string;
                total: bigint;
                lastAt: number;
              }
            >();

        // 3. Configured settlement tokens (idle-peer completeness).
        const peerConfig = settlementPeers?.get(peerId);
        const configuredTokens = new Set<string>();
        if (peerConfig?.tokenAddress) configuredTokens.add(peerConfig.tokenAddress);
        for (const t of peerConfig?.settlementTokens ?? []) configuredTokens.add(t);

        // 4. Merge asset keys from all three sources.
        const assetKeys = new Set<string>([...inboundByAsset.keys(), ...outboundByAsset.keys()]);
        const configuredBlockchain: 'evm' | 'solana' | 'mina' =
          peerConfig?.settlementPreference === 'solana'
            ? 'solana'
            : peerConfig?.settlementPreference === 'mina'
              ? 'mina'
              : 'evm';
        for (const t of configuredTokens) assetKeys.add(`${configuredBlockchain}:${t}`);

        // 5. Resolve metadata + build rows per asset.
        const byAsset: AdminEarningsByAsset[] = [];
        for (const key of assetKeys) {
          const sepIdx = key.indexOf(':');
          const blockchain = key.substring(0, sepIdx) as 'evm' | 'solana' | 'mina';
          const tokenAddress = key.substring(sepIdx + 1);
          const meta = await resolveCached(blockchain, tokenAddress);
          const inbound = inboundByAsset.get(key);
          const outbound = outboundByAsset.get(key);
          const received = inbound?.total ?? 0n;
          const sent = outbound?.total ?? 0n;
          // lastClaimAt = max of inbound + outbound timestamps across this asset.
          const lastInbound = inbound?.lastAt ?? 0;
          const lastOutbound = outbound?.lastAt ?? 0;
          const lastAtMax = Math.max(lastInbound, lastOutbound);
          const lastAt = lastAtMax > 0 ? lastAtMax : null;

          byAsset.push({
            assetCode: meta.assetCode,
            assetScale: meta.assetScale,
            claimsReceivedTotal: received.toString(),
            claimsSentTotal: sent.toString(),
            // netBalance > 0 → we owe the peer (they've earned from us);
            // netBalance < 0 → peer owes us.
            netBalance: (sent - received).toString(),
            lastClaimAt: lastAt ? new Date(lastAt).toISOString() : null,
          });

          // Fees accrue on inbound volume only (we collect fees when a peer
          // pays us to forward), so aggregate only the received side.
          const feeKey = `${meta.assetCode}|${meta.assetScale}`;
          incomingTotalByAsset.set(feeKey, (incomingTotalByAsset.get(feeKey) ?? 0n) + received);
        }

        peersOut.push({ peerId, byAsset });
      }

      // 5. connectorFees — approximate: sum(inbound claim amounts across peers)
      // * feePct. Returns [] when fee percentage is unset or zero. This is a
      // stop-gap: a dedicated ConnectorFee TigerBeetle account is a deliberate
      // follow-up (see story 37.4 dev-notes).
      const connectorFees: AdminEarningsConnectorFee[] = [];
      const feePct = connectorFeePercentage ?? 0;
      if (feePct > 0) {
        // Basis points = feePct * 100 (so 1% → 100 bp). Divisor = 10_000
        // (100 percent * 100 bp per percent).
        const basisPoints = BigInt(Math.round(feePct * 100));
        for (const [key, incomingSum] of incomingTotalByAsset) {
          if (incomingSum === 0n) continue;
          const sepIdx = key.lastIndexOf('|');
          const assetCode = key.substring(0, sepIdx);
          const assetScale = parseInt(key.substring(sepIdx + 1), 10);
          const total = (incomingSum * basisPoints) / 10_000n;
          connectorFees.push({ assetCode, assetScale, total: total.toString() });
        }
      }

      // 6. recentClaims ring buffer, newest first, max 50. Merges inbound +
      // outbound (when sentClaimsQueries is wired). Each claim's amount is
      // the per-claim delta on its channel+direction (this cumulative minus
      // the prior cumulative on the same channel+direction — inbound and
      // outbound cumulatives are independent lineages).
      //
      // Algorithm:
      //   (a) fetch up to 50 newest-first from each source
      //   (b) tag with direction, merge, sort by ts DESC, truncate to 50
      //   (c) walk oldest-first tracking (bc, channel, direction) prior
      //       cumulative to compute deltas
      //   (d) reverse back to newest-first for the response
      const inboundRaw = await claimReceiver.getRecentClaims(50);
      const outboundRaw = sentClaimsQueries ? await sentClaimsQueries.getRecentSentClaims(50) : [];

      type Parsed = {
        peerId: string;
        blockchain: 'evm' | 'solana' | 'mina';
        channelId: string;
        tokenAddress: string;
        cumulative: bigint;
        direction: 'inbound' | 'outbound';
        at: number;
        meta: { assetCode: string; assetScale: number };
      };

      // Extract (tokenAddress, cumulative) from a claim payload (variant-aware).
      const extractClaim = (
        blockchain: 'evm' | 'solana' | 'mina',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        c: any
      ): { tokenAddress: string; cumulative: bigint } => {
        if (blockchain === 'evm') {
          let cum = 0n;
          try {
            cum = BigInt(c.transferredAmount ?? '0');
          } catch {
            cum = 0n;
          }
          return { tokenAddress: c.tokenAddress ?? '', cumulative: cum };
        }
        if (blockchain === 'solana') {
          let cum = 0n;
          try {
            cum = BigInt(c.transferredAmount ?? '0');
          } catch {
            cum = 0n;
          }
          return { tokenAddress: c.programId ?? '', cumulative: cum };
        }
        // mina: commitment, not plaintext amount
        return { tokenAddress: c.tokenId ?? '', cumulative: 0n };
      };

      const parsed: Parsed[] = [];
      for (const row of inboundRaw) {
        const blockchain = row.blockchain as 'evm' | 'solana' | 'mina';
        const { tokenAddress, cumulative } = extractClaim(blockchain, row.claimData);
        const meta = tokenAddress
          ? await resolveCached(blockchain, tokenAddress)
          : { assetCode: 'UNKNOWN', assetScale: 0 };
        parsed.push({
          peerId: row.peerId,
          blockchain,
          channelId: row.channelId,
          tokenAddress,
          cumulative,
          direction: 'inbound',
          at: row.receivedAt,
          meta,
        });
      }
      for (const row of outboundRaw) {
        const blockchain = row.blockchain as 'evm' | 'solana' | 'mina';
        const { tokenAddress, cumulative } = extractClaim(blockchain, row.claimData);
        const meta = tokenAddress
          ? await resolveCached(blockchain, tokenAddress)
          : { assetCode: 'UNKNOWN', assetScale: 0 };
        parsed.push({
          peerId: row.peerId,
          blockchain,
          channelId: row.channelId,
          tokenAddress,
          cumulative,
          direction: 'outbound',
          at: row.sentAt,
          meta,
        });
      }

      // Sort by ts DESC across both directions; keep at most 50.
      parsed.sort((a, b) => b.at - a.at);
      const topN = parsed.slice(0, 50);

      // Walk oldest-first to compute per-channel+direction deltas.
      const priorByChannel = new Map<string, bigint>();
      const withDeltas: Array<AdminEarningsRecentClaim & { _sortKey: number }> = [];
      for (let i = topN.length - 1; i >= 0; i--) {
        const p = topN[i];
        if (!p) continue;
        const chanKey = `${p.blockchain}:${p.channelId}:${p.direction}`;
        const prior = priorByChannel.get(chanKey) ?? 0n;
        const delta = p.cumulative - prior;
        priorByChannel.set(chanKey, p.cumulative);

        withDeltas.push({
          peerId: p.peerId,
          assetCode: p.meta.assetCode,
          assetScale: p.meta.assetScale,
          amount: delta.toString(),
          direction: p.direction,
          at: new Date(p.at).toISOString(),
          _sortKey: p.at,
        });
      }
      // Restore newest-first ordering (AC 5).
      withDeltas.sort((a, b) => b._sortKey - a._sortKey);
      const recentClaims: AdminEarningsRecentClaim[] = withDeltas.map(({ _sortKey, ...rest }) => {
        void _sortKey;
        return rest;
      });

      res.set('Cache-Control', 'no-store');
      res.json({
        uptimeSeconds: Math.floor(process.uptime()),
        peers: peersOut,
        connectorFees,
        recentClaims,
        timestamp: new Date().toISOString(),
      } satisfies AdminEarningsJsonResponse);
    } catch (error) {
      log.error(
        {
          event: 'admin_api_earnings_error',
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to generate earnings.json'
      );
      res.status(500).json({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}

/**
 * Admin API Server Configuration
 */
export interface AdminServerConfig {
  /** Port to listen on (default: 8081) */
  port?: number;

  /** Host to bind to (default: '0.0.0.0' for Docker, '127.0.0.1' for local) */
  host?: string;

  /** Optional API key for authentication */
  apiKey?: string;

  /** Enable/disable admin API (default: false) */
  enabled?: boolean;
}

// --- Payment Channel Admin API Types ---

/** Chain format: {blockchain}:{network}:{chainId} */
export const CHAIN_FORMAT_REGEX = /^evm:[a-zA-Z0-9]+:\d+$/;

/** POST /admin/channels request body */
export interface OpenChannelRequest {
  peerId: string;
  chain: string;
  token?: string;
  tokenNetwork?: string;
  initialDeposit: string;
  settlementTimeout?: number;
  /** Peer's blockchain address (e.g., EVM address). Falls back to settlementPeers if omitted. */
  peerAddress?: string;
}

/** POST /admin/channels response.
 *  Superset of agent-society's OpenChannelResult — includes `chain` and `deposit`
 *  fields that agent-society ignores but are useful for debugging.
 *  Agent-society expects: { channelId: string, status: string }
 */
export interface OpenChannelResponse {
  channelId: string;
  chain: string;
  status: AdminChannelStatus;
  deposit: string;
}

/** GET /admin/channels response item */
export interface ChannelSummary {
  channelId: string;
  peerId: string;
  chain: string;
  status: AdminChannelStatus;
  deposit: string;
  lastActivity: string;
}

/** GET /admin/channels/:channelId response.
 *  Agent-society's ChannelState expects: { channelId, status, chain }
 *  This response is a superset — additional fields (deposit, etc.) are safe to ignore.
 */
export interface ChannelDetailResponse {
  channelId: string;
  status: AdminChannelStatus;
  deposit: string;
  [key: string]: unknown;
}

/** POST /admin/channels/:channelId/deposit request body */
export interface DepositRequest {
  amount: string;
  token?: string;
}

/** POST /admin/channels/:channelId/deposit response */
export interface DepositResponse {
  channelId: string;
  /**
   * For EVM channels: total cumulative deposit from getChannelState().myDeposit (includes all prior deposits).
   */
  newDeposit: string;
  status: AdminChannelStatus;
}

/** POST /admin/channels/:channelId/close request body */
export interface CloseChannelRequest {
  cooperative?: boolean;
}

/** POST /admin/channels/:channelId/close response */
export interface CloseChannelResponse {
  channelId: string;
  status: AdminChannelStatus;
  txHash?: string;
}

/**
 * Validate a deposit request body
 * @returns Object with valid flag and optional error message
 */
export function validateDepositRequest(body: Record<string, unknown>): {
  valid: boolean;
  error?: string;
} {
  if (body.amount === undefined || body.amount === null) {
    return { valid: false, error: 'Missing amount' };
  }

  if (typeof body.amount !== 'string') {
    return { valid: false, error: 'amount must be a string' };
  }

  if (!isValidNonNegativeIntegerString(body.amount)) {
    return { valid: false, error: 'amount must be a positive integer string' };
  }

  if (body.amount === '0') {
    return { valid: false, error: 'amount must be greater than zero' };
  }

  return { valid: true };
}

/**
 * Validate settlement configuration fields.
 * @returns Error message string if invalid, or null if valid
 */
export function validateSettlementConfig(s: AdminSettlementConfig): string | null {
  const VALID_PREFERENCES = ['evm', 'any'];

  if (!s.preference || !VALID_PREFERENCES.includes(s.preference)) {
    return 'settlement.preference must be one of: evm, any';
  }

  if (s.preference === 'evm' && !s.evmAddress) {
    return 'settlement.evmAddress required when preference is evm';
  }
  if (s.preference === 'any' && !s.evmAddress) {
    return 'settlement: evmAddress required when preference is any';
  }

  if (s.evmAddress && !isValidEvmAddress(s.evmAddress)) {
    return 'settlement.evmAddress must be a valid 0x-prefixed address (42 chars)';
  }
  if (s.tokenAddress && !isValidEvmAddress(s.tokenAddress)) {
    return 'settlement.tokenAddress must be a valid 0x-prefixed address (42 chars)';
  }
  if (s.tokenNetworkAddress && !isValidEvmAddress(s.tokenNetworkAddress)) {
    return 'settlement.tokenNetworkAddress must be a valid 0x-prefixed address (42 chars)';
  }
  if (s.chainId !== undefined && (!Number.isInteger(s.chainId) || s.chainId <= 0)) {
    return 'settlement.chainId must be a positive integer';
  }
  if (s.initialDeposit !== undefined && !isValidNonNegativeIntegerString(s.initialDeposit)) {
    return 'settlement.initialDeposit must be a non-negative integer string';
  }

  return null;
}

/**
 * Validate an OpenChannelRequest body
 * @returns Object with valid flag and optional error message
 */
export function validateOpenChannelRequest(body: Record<string, unknown>): {
  valid: boolean;
  error?: string;
} {
  if (!body.peerId || typeof body.peerId !== 'string') {
    return { valid: false, error: 'Missing or invalid peerId' };
  }

  if (!body.chain || typeof body.chain !== 'string') {
    return { valid: false, error: 'Missing or invalid chain' };
  }

  if (!CHAIN_FORMAT_REGEX.test(body.chain)) {
    return {
      valid: false,
      error: `Invalid chain format: ${body.chain}. Expected {blockchain}:{network}:{chainId}`,
    };
  }

  if (body.initialDeposit === undefined || body.initialDeposit === null) {
    return { valid: false, error: 'Missing initialDeposit' };
  }

  if (typeof body.initialDeposit !== 'string') {
    return { valid: false, error: 'initialDeposit must be a string' };
  }

  if (!isValidNonNegativeIntegerString(body.initialDeposit)) {
    return { valid: false, error: 'initialDeposit must be a non-negative integer string' };
  }

  if (
    body.token !== undefined &&
    typeof body.token === 'string' &&
    !isValidEvmAddress(body.token)
  ) {
    return { valid: false, error: 'Invalid token address format' };
  }

  if (
    body.tokenNetwork !== undefined &&
    typeof body.tokenNetwork === 'string' &&
    !isValidEvmAddress(body.tokenNetwork)
  ) {
    return { valid: false, error: 'Invalid tokenNetwork address format' };
  }

  if (body.settlementTimeout !== undefined) {
    if (
      typeof body.settlementTimeout !== 'number' ||
      !Number.isInteger(body.settlementTimeout) ||
      body.settlementTimeout <= 0
    ) {
      return { valid: false, error: 'settlementTimeout must be a positive integer' };
    }
  }

  return { valid: true };
}
