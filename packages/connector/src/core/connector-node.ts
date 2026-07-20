/**
 * ConnectorNode - Core ILP connector orchestrator
 * Manages all connector components and lifecycle
 */

import { promises as fsPromises } from 'fs';
import { Logger } from '../utils/logger';
import { RoutingTable } from '../routing/routing-table';
import {
  deriveLocalPrefixes,
  deriveDefaultChildRoute,
  validateRelationRoute,
} from '../routing/relation-route-validator';
import { BTPClientManager } from '../btp/btp-client-manager';
import { BTPServer } from '../btp/btp-server';
import { PacketHandler } from './packet-handler';
import { Peer } from '../btp/btp-client';
import {
  RoutingTableEntry,
  ILPAddress,
  isValidILPAddress,
  ILPPreparePacket,
  ILPFulfillPacket,
  ILPRejectPacket,
  PacketType,
  ILPErrorCode,
} from '@toon-protocol/shared';
import {
  ConnectorConfig,
  SettlementConfig,
  LocalDeliveryHandler,
  SendPacketParams,
  PeerRegistrationRequest,
  PeerInfo,
  PeerAccountBalance,
  RouteInfo,
  RemovePeerResult,
  DeploymentMode,
  TransportConfig,
  RouteTermination,
  TerminationChain,
  validateChainProviders,
  toRouteTermination,
} from '../config/types';
import { RouteTerminationRegistry } from './route-upstream-registry';
import { HttpProxyHandler } from './handlers/http-proxy-handler';
import { TransportProvider, DirectTransportProvider } from '../transport';
import { HttpPeerClientManager, type HttpPeer } from '../transport/http-peer-transport';
import { PaymentHandler, createPaymentHandlerAdapter } from './payment-handler';
import {
  PeerConfig as SettlementPeerConfig,
  AdminSettlementConfig,
  normalizeChannelStatus,
} from '../settlement/types';
import { validateSettlementConfig } from '../http/admin-api';
import {
  ConfigLoader,
  ConfigurationError,
  ConnectorNotStartedError,
  InvalidExecutionConditionError,
} from '../config/config-loader';
import { HealthServer } from '../http/health-server';
import { IlpHttpAdapter, type InboundClaimValidateFn } from '../http/ilp-http-adapter';
import { AdminServer } from '../http/admin-server';
import { IlpMetricsRegistry } from '../observability/metrics-registry';
import { HealthStatus, HealthStatusProvider } from '../http/types';
import { PaymentChannelSDK } from '../settlement/payment-channel-sdk';
import { ChannelManager } from '../settlement/channel-manager';
import { SettlementExecutor } from '../settlement/settlement-executor';
import { AccountManager } from '../settlement/account-manager';
import { SettlementMonitor } from '../settlement/settlement-monitor';
import { ClaimReceiver } from '../settlement/claim-receiver';
import { initializeClaimReceiverSchema } from '../settlement/claim-receiver-db-schema';
import { initializeRegistrySchema } from './registry-db-schema';
import { RegistryStore } from './registry-store';
import { KeyManager } from '../security/key-manager';
import { requireOptional } from '../utils/optional-require';
import { TigerBeetleClient } from '../settlement/tigerbeetle-client';
import { InMemoryLedgerClient } from '../settlement/in-memory-ledger-client';
import { PerPacketClaimService } from '../settlement/per-packet-claim-service';
import { ChainProviderRegistry } from '../settlement/provider/chain-provider-registry';
import { EVMPaymentChannelProvider } from '../settlement/provider/evm-payment-channel-provider';
import { createMinaProviderFactory } from '../settlement/provider/mina-payment-channel-provider';
import type {
  EVMProviderConfig,
  MinaProviderConfig,
  SolanaProviderConfig,
} from '../settlement/provider/payment-channel-provider';
import {
  resolveMinaSignerKey,
  resolveSolanaSigner,
} from '../settlement/provider/signer-resolution';
import { createSolanaProviderFactory } from '../settlement/provider/solana-payment-channel-provider';
import {
  SENT_CLAIMS_TABLE_SCHEMA,
  SENT_CLAIMS_INDEXES,
} from '../settlement/claim-sender-db-schema';
import { InboundClaimValidator } from '../btp/inbound-claim-validator';
import { NIP59ClaimWrapper } from '../settlement/privacy/nip59-claim-wrapper';
import { deriveChainKeysFromMnemonic } from '../wallet/mnemonic-keys';
import { SelfAnnounceService, type PublishOutcome } from '../discovery/self-announce-service';
import { planAnnouncePublish } from '../discovery/self-announce-publish';
import { RouteLearningService } from '../discovery/route-learning-service';
import {
  DiscoveredNodeRegistry,
  type DiscoveredNode,
  type FundedPeerRef,
} from '../discovery/discovered-node-registry';
import { nip59KeyToNostrPubkey } from '../discovery/self-announce-builder';
import { createNostrRelayClient } from '../discovery/nostr-relay-client';
import { getPublicKey, type NostrEvent } from 'nostr-tools';
import { BootstrapService } from '../discovery/bootstrap-service';
import { FileBootstrapCacheStore } from '../discovery/bootstrap-cache';
import { createKind10032RelayProbe } from '../discovery/relay-probe';
import { hexToBytes } from '@noble/hashes/utils';

/** Round-trip timeout (ms) for a self-announce write PREPARE. */
const SELF_ANNOUNCE_PREPARE_TIMEOUT_MS = 30_000;
import { promises as dns } from 'dns';
// Import package.json for version information
import packageJson from '../../package.json';

/**
 * ConnectorNode - Main connector orchestrator
 * Coordinates RoutingTable, BTPClientManager, PacketHandler, and BTPServer
 * Implements connector startup, shutdown, and health monitoring
 */
export class ConnectorNode implements HealthStatusProvider {
  private readonly _config: ConnectorConfig;
  private readonly _logger: Logger;
  private readonly _routingTable: RoutingTable;
  // Per-route local-termination config (issue #218). Seeded from the static
  // YAML routes at construction and mutated at runtime by the admin
  // desired-state reconciler. Consumed by #216's HttpProxyHandler (via its
  // `upstreamResolver` seam) and by the #217/#220 greeting/price-binding layers.
  private readonly _routeTerminationRegistry: RouteTerminationRegistry;
  private readonly _btpClientManager: BTPClientManager;
  /**
   * ILP-over-HTTP egress manager (Epic 38, Story 38.1). Handles forwarding to
   * peers configured with `peerProtocol: 'ilp-http'`. Consumes the same
   * TransportProvider as BTP so SOCKS5/ATOR egress composes.
   */
  private readonly _httpPeerClientManager: HttpPeerClientManager;
  private readonly _packetHandler: PacketHandler;
  private readonly _btpServer: BTPServer;
  private readonly _healthServer: HealthServer;
  // The inbound claim gate, captured so the ILP-over-HTTP adapter validates
  // through the exact same function the BTP server uses. Null in routing-only mode.
  private _inboundClaimValidate: InboundClaimValidateFn | null = null;
  private _adminServer: AdminServer | null = null;
  private _paymentChannelSDK: PaymentChannelSDK | null = null;
  private _chainSDKs: Map<number, PaymentChannelSDK> = new Map();
  private _channelManager: ChannelManager | null = null;
  private _accountManager: AccountManager | null = null;
  private _claimReceiver: ClaimReceiver | null = null;
  private _settlementMonitor: SettlementMonitor | null = null;
  private _settlementExecutor: SettlementExecutor | null = null;
  // Issue #86: the shared ChainProviderRegistry built during settlement
  // bootstrap, exposed read-only via the `chainRegistry` getter so callers
  // (and integration tests) can observe which chain providers were registered.
  // Stays null when the settlement stack is disabled.
  private _chainRegistry: ChainProviderRegistry | null = null;
  private _tigerBeetleClient: TigerBeetleClient | null = null;
  private _inMemoryLedgerClient: InMemoryLedgerClient | null = null;
  private readonly _settlementPeers: Map<string, SettlementPeerConfig> = new Map();
  // Persistent peer/route registry (Epic: persistent registry). Mirrors every
  // runtime peer/route mutation to SQLite so they survive a restart instead of
  // being dropped (the "re-POST the relay route" RUNBOOK workaround). Stays null
  // when `libsql` is unavailable — registration then degrades to in-memory only.
  private _registryStore: RegistryStore | null = null;
  private _healthStatus: 'healthy' | 'unhealthy' | 'starting' = 'starting';
  private readonly _ilpMetrics!: IlpMetricsRegistry;
  private readonly _startTime: Date = new Date();
  private _btpServerStarted: boolean = false;
  private _defaultSettlementTokenId: string = 'M2M';
  // Active transport provider (direct TCP only) + cached health
  private _transportProvider: TransportProvider | null = null;
  // `_transportProviderReady` gates the public `transportProvider` getter so it
  // returns `null` during the in-flight `provider.start()` await window
  // (AC #11: "during start() before await transportProvider.start() resolves →
  // null"). Flipped to `true` only AFTER a successful `await provider.start()`,
  // and flipped back to `false` at the start of stop()/rollback, before the
  // reference is nulled. This prevents exposing a half-initialized provider.
  private _transportProviderReady: boolean = false;
  private _transportType: 'direct' | null = null;
  private _lastTransportHealthy: boolean = true;
  private _transportHealthInterval: NodeJS.Timeout | null = null;
  // Epic 35 / Story 35.6 T-35.6-INT-03: transport health-check interval (ms).
  // Default 30s matches Story 35.4 wiring. Optional constructor override lets
  // integration tests shrink the cadence to sub-second so the mid-session
  // proxy-down assertion fires in CI-acceptable time without reaching into
  // private state. This is the ONLY production-code seam Story 35.6 introduces.
  private readonly _transportHealthIntervalMs: number;
  // Periodic re-evaluation of the peer-connectivity health status. The primary
  // driver is event-based (BTPClientManager fires on every peer connect/
  // disconnect), but a low-frequency timer is a robust backstop against any
  // missed edge — e.g. a connection state transition that races startup, or a
  // future transport that doesn't emit clean connect/disconnect events. Bound
  // to node lifecycle: started at the end of start(), cleared in stop() and in
  // the start() rollback path so no interval leaks.
  private _healthStatusInterval: NodeJS.Timeout | null = null;
  // Cadence (ms) for the periodic health re-evaluation backstop. Default 10s —
  // small enough that /health converges quickly after a post-startup peer
  // connect even if an event were ever missed, large enough to be negligible
  // overhead. Optional constructor override lets tests shrink it.
  private readonly _healthStatusIntervalMs: number;
  // Optional mnemonic override (mnemonic signing mode). When set, takes
  // precedence over `process.env.TOON_MNEMONIC` at boot so multi-node tests can
  // derive distinct settlement keys without mutating global env. NEVER logged.
  private readonly _mnemonicOverride?: string;
  private readonly _mnemonicAccountIndex?: number;
  // Self-announce service (relay#37 / store#22). When `selfAnnounce.enabled` is
  // set, publishes + refreshes this node's own kind:10032 IlpPeerInfo. Null when
  // disabled or no signing identity is available.
  private _selfAnnounceService: SelfAnnounceService | null = null;
  // Route learning service (toon-meta#153). When `routeLearning.enabled` is
  // set, consumes peers' kind:10032 announcements from the relay and installs
  // learned multi-hop routes. Null when disabled.
  private _routeLearningService: RouteLearningService | null = null;
  // Discovered-node registry (toon-meta#153, discovered-vs-peered). Fed by the
  // route-learning ingest seam; surfaces the free, unbounded "discovered" set
  // (getDiscoveredNodes / GET /admin/discovered-nodes) as distinct from the
  // few deliberately FUNDED peers. Null when route learning is disabled (no
  // ingest feed → nothing discovered).
  private _discoveredNodeRegistry: DiscoveredNodeRegistry | null = null;
  // BTP `url` of peers registered at RUNTIME via registerPeer (static config
  // peers carry their url in `_config.peers`). Feeds the discovered registry's
  // funded-matching endpoint fallback. Maintained by registerPeer/removePeer.
  private readonly _runtimePeerUrls = new Map<string, string>();
  // Cold-start bootstrap service (toon-meta#153). When `bootstrap.enabled` is
  // set, resolves relay seeds (signed registry → cache → config → fallback),
  // sample-and-verifies them, and refreshes on an interval. Null when disabled.
  private _bootstrapService: BootstrapService | null = null;

  /**
   * The canonical token symbol resolved from the on-chain ERC-20 contract at startup.
   * Falls back to 'M2M' if the RPC call fails or settlement is disabled.
   */
  get defaultSettlementTokenId(): string {
    return this._defaultSettlementTokenId;
  }

  /**
   * Create ConnectorNode instance
   * @param config - ConnectorConfig object or path to YAML configuration file
   * @param logger - Pino logger instance
   * @throws ConfigurationError if configuration is invalid
   */
  constructor(
    config: ConnectorConfig | string,
    logger: Logger,
    opts?: {
      transportHealthIntervalMs?: number;
      /**
       * Cadence (ms) for the periodic peer-connectivity health re-evaluation
       * backstop. Defaults to 10s. Tests shrink this to sub-second to assert
       * timer-driven convergence without waiting. Event-driven updates fire
       * regardless of this value.
       */
      healthStatusIntervalMs?: number;
      /**
       * Mnemonic signing mode override. When provided, this BIP-39 mnemonic
       * derives the per-chain settlement keys at boot, taking precedence over
       * `process.env.TOON_MNEMONIC`. Intended for multi-node test isolation so
       * tests don't mutate global env. Production injects the mnemonic via
       * `TOON_MNEMONIC` instead. NEVER logged or persisted.
       */
      mnemonic?: string;
      /** Optional account index for mnemonic derivation (default 0). */
      mnemonicAccountIndex?: number;
    }
  ) {
    // Story 35.6: optional seam for integration tests. Default preserves
    // pre-35.6 behavior (30s). All existing callers (2-arg form) continue to
    // work unchanged — new arg is optional.
    this._transportHealthIntervalMs = opts?.transportHealthIntervalMs ?? 30000;
    this._healthStatusIntervalMs = opts?.healthStatusIntervalMs ?? 10000;
    this._mnemonicOverride = opts?.mnemonic;
    this._mnemonicAccountIndex = opts?.mnemonicAccountIndex;
    // Load and validate configuration
    let resolvedConfig: ConnectorConfig;
    try {
      if (typeof config === 'string') {
        resolvedConfig = ConfigLoader.loadConfig(config);
      } else {
        resolvedConfig = ConfigLoader.validateConfig(config);
      }
    } catch (error) {
      if (error instanceof ConfigurationError) {
        const logContext =
          typeof config === 'string'
            ? { event: 'config_load_failed', filePath: config, error: error.message }
            : { event: 'config_load_failed', source: 'object', error: error.message };
        logger.error(logContext, 'Failed to load configuration');
        throw error;
      }
      throw error;
    }

    this._config = resolvedConfig;
    this._logger = logger.child({ component: 'ConnectorNode', nodeId: resolvedConfig.nodeId });

    const loadedLogContext =
      typeof config === 'string'
        ? { event: 'config_loaded', filePath: config, nodeId: resolvedConfig.nodeId }
        : { event: 'config_loaded', source: 'object', nodeId: resolvedConfig.nodeId };
    this._logger.info(loadedLogContext, 'Configuration loaded successfully');

    // Convert RouteConfig[] to RoutingTableEntry[]
    const routingTableEntries: RoutingTableEntry[] = resolvedConfig.routes.map((route) => ({
      prefix: route.prefix as ILPAddress,
      nextHop: route.nextHop,
      priority: route.priority,
    }));

    // Initialize routing table
    this._routingTable = new RoutingTable(
      routingTableEntries,
      logger.child({ component: 'RoutingTable' })
    );

    // Initialize the route → upstream termination registry (issue #218) from the
    // static-config routes. Only routes carrying termination config (`upstream`
    // set) are registered; ordinary forwarding routes are ignored. This is the
    // seam #216's HttpProxyHandler consumes via `registry.resolveUpstream`, and
    // the source of price/chains/ilpAddress/settlementAddresses for the #217
    // greeting and #220 price-binding.
    this._routeTerminationRegistry = new RouteTerminationRegistry(
      resolvedConfig.routes.map((route) => ({
        prefix: route.prefix,
        termination: toRouteTermination(route),
      }))
    );

    // Initialize BTP client manager
    this._btpClientManager = new BTPClientManager(
      resolvedConfig.nodeId,
      logger.child({ component: 'BTPClientManager' })
    );
    // Direct TCP transport only: the agent factory always returns undefined so
    // BTPClient dials each peer's WebSocket directly (pre-Epic-35 default).
    this._btpClientManager.setAgentFactory(() => undefined);
    // Re-evaluate /health whenever a peer connects or disconnects. This is the
    // primary fix for the one-shot health-status race: the boot-time snapshot
    // in start() is no longer the only evaluation, so peers that finish
    // connecting AFTER startup correctly flip /health to "healthy" (and a peer
    // dropping below threshold flips it back). _updateHealthStatus() is a
    // cheap, idempotent recompute that no-ops until the BTP server is up.
    this._btpClientManager.setConnectionStateChangeCallback(() => this._updateHealthStatus());

    // ILP-over-HTTP egress (Epic 38, Story 38.1). With direct-only transport the
    // provider never supplies a custom agent, so HttpPeerClientManager falls
    // back to its pooled keep-alive agent.
    const httpEgressTransport: TransportProvider = {
      createAgent: () => undefined,
      getExternalUrl: () => this._transportProvider?.getExternalUrl() ?? '',
      start: async () => {},
      stop: async () => {},
      healthCheck: async () => this._transportProvider?.healthCheck() ?? true,
    };
    this._httpPeerClientManager = new HttpPeerClientManager(
      resolvedConfig.nodeId,
      logger.child({ component: 'HttpPeerClientManager' }),
      httpEgressTransport
    );

    // Initialize packet handler
    this._packetHandler = new PacketHandler(
      this._routingTable,
      this._btpClientManager,
      resolvedConfig.nodeId,
      logger.child({ component: 'PacketHandler' })
    );

    // Wire the ILP-over-HTTP egress into the forwarding seam (Epic 38, Story 38.1).
    this._packetHandler.setHttpEgress(this._httpPeerClientManager);

    // Initialize BTP server
    this._btpServer = new BTPServer(logger.child({ component: 'BTPServer' }), this._packetHandler);

    // Link BTPServer to PacketHandler for bidirectional forwarding (resolves circular dependency)
    this._packetHandler.setBTPServer(this._btpServer);

    // Configure local delivery if enabled (forwards local packets to app handler)
    const localDeliveryEnabled =
      resolvedConfig.localDelivery?.enabled || process.env.LOCAL_DELIVERY_ENABLED === 'true';
    if (localDeliveryEnabled) {
      const localDeliveryConfig = {
        enabled: true,
        handlerUrl:
          resolvedConfig.localDelivery?.handlerUrl || process.env.LOCAL_DELIVERY_URL || '',
        timeout:
          resolvedConfig.localDelivery?.timeout ||
          parseInt(process.env.LOCAL_DELIVERY_TIMEOUT || '30000', 10),
        authToken: resolvedConfig.localDelivery?.authToken || process.env.LOCAL_DELIVERY_AUTH_TOKEN,
        perHopNotification:
          resolvedConfig.localDelivery?.perHopNotification ??
          process.env.LOCAL_DELIVERY_PER_HOP_NOTIFICATION === 'true',
      };
      this._packetHandler.setLocalDelivery(localDeliveryConfig);
    }

    // Wire the #216 HttpProxyHandler to the #218 RouteTerminationRegistry.
    //
    // When the operator has configured terminated routes (registry non-empty),
    // construct a generic HTTP reverse-proxy local-delivery handler and feed it
    // the registry's `resolveUpstream` seam. Per delivery, the handler asks the
    // registry "what upstream serves this ILP destination?" — for terminated
    // destinations it reverse-proxies the opaque HTTP envelope; for destinations
    // with no terminated route the resolver returns undefined and the handler
    // rejects with F02. `chainResolver` is left default (derives the chain from
    // the ILP destination's 2nd label).
    //
    // PRECEDENCE / DO-NO-HARM: `setLocalDeliveryHandler()` registers a function
    // handler that UNCONDITIONALLY short-circuits the HTTP `localDelivery.handlerUrl`
    // client in PacketHandler (the function handler is checked first and always
    // returns). A function handler cannot "fall through" to the HTTP client. So
    // installing the proxy while a global `handlerUrl` is also configured would
    // silently break the existing handlerUrl path for non-terminated destinations
    // (they'd get F02 instead of reaching the configured app). To guarantee we
    // never regress the existing path, we install the proxy ONLY when terminated
    // routes exist AND no global HTTP localDelivery handler is configured. If BOTH
    // are configured we PRESERVE the existing handlerUrl path and log a warning —
    // reconciling the two (per-route proxy for terminated destinations, handlerUrl
    // fallback for the rest) requires a fall-through seam in PacketHandler and is
    // deferred to a human decision rather than over-engineered here.
    if (this._routeTerminationRegistry.size > 0) {
      if (localDeliveryEnabled) {
        this._logger.warn(
          {
            event: 'route_termination_proxy_skipped',
            terminatedRoutes: this._routeTerminationRegistry.size,
            reason: 'global_local_delivery_handler_configured',
          },
          'Terminated routes are configured but a global localDelivery.handlerUrl ' +
            'is also enabled; preserving the existing handlerUrl path and NOT ' +
            'installing the per-route HTTP proxy (requires PacketHandler fall-through — human decision)'
        );
      } else {
        const proxy = new HttpProxyHandler({
          upstreamResolver: this._routeTerminationRegistry.resolveUpstream,
          logger: this._logger,
        });
        this.setLocalDeliveryHandler(proxy.handler);
        this._logger.info(
          {
            event: 'route_termination_proxy_installed',
            terminatedRoutes: this._routeTerminationRegistry.size,
            prefixes: this._routeTerminationRegistry.prefixes(),
          },
          'HttpProxyHandler installed as local-delivery handler for terminated routes'
        );
      }
    }

    // Link PacketHandler to BTPClientManager for incoming packet handling (resolves circular dependency)
    this._btpClientManager.setPacketHandler(this._packetHandler);

    // Story 37.2: Initialize ILP observability metrics registry and wire through.
    // - Create scoped registry (not global prom-client default, for test isolation)
    // - Register configured peers so idle peers appear in /metrics output
    // - Pass middleware to HealthServer so GET /metrics actually serves data
    // - Wire registry into PacketHandler for counter attribution
    this._ilpMetrics = new IlpMetricsRegistry({ collectDefaults: false });
    for (const peer of resolvedConfig.peers) {
      this._ilpMetrics.registerPeer(peer.id);
      // Seed the forwarding path with each peer's ILP relationship (issue #76).
      // Defaults to 'peer' so peers without an explicit relation keep requiring
      // a per-packet claim on value-bearing forwards (pre-issue-76 behavior).
      this._packetHandler.setPeerRelation(peer.id, peer.relation ?? 'peer');
      // Seed the forwarding seam with each peer's packet protocol (Epic 38,
      // Story 38.1). Defaults to 'btp' so omitted peers take the legacy path.
      this._packetHandler.setPeerProtocol(peer.id, peer.peerProtocol ?? 'btp');
    }
    this._packetHandler.setIlpMetrics(this._ilpMetrics);

    // Initialize health server with metrics middleware
    this._healthServer = new HealthServer(logger.child({ component: 'HealthServer' }), this, {
      metricsMiddleware: this._ilpMetrics.createMetricsMiddleware(),
    });

    this._logger.info(
      {
        event: 'connector_initialized',
        nodeId: resolvedConfig.nodeId,
        peersCount: resolvedConfig.peers.length,
        routesCount: resolvedConfig.routes.length,
      },
      'Connector node initialized'
    );
  }

  /**
   * Register a direct in-process delivery handler for local ILP packets.
   * Bypasses the HTTP LocalDeliveryClient when set, delivering packets
   * directly to the handler function without an HTTP round-trip.
   *
   * @param handler - Function handler for local delivery, or null to clear and revert to HTTP fallback
   */
  setLocalDeliveryHandler(handler: LocalDeliveryHandler | null): void {
    this._logger.info(
      { event: 'local_delivery_handler_set', hasHandler: handler !== null },
      handler
        ? 'Local delivery function handler registered'
        : 'Local delivery function handler cleared'
    );
    this._packetHandler.setLocalDeliveryHandler(handler);
  }

  /**
   * Register a packet handler for local ILP packets.
   * Wraps the handler with an adapter that handles fulfillment computation,
   * error code mapping, and expiry checks — so the handler only needs to
   * return `{ accept: true }` or `{ accept: false }`.
   *
   * Shares the same underlying slot as `setLocalDeliveryHandler()` —
   * setting one overwrites the other (last writer wins).
   *
   * @param handler - Packet handler function, or null to clear
   */
  setPacketHandler(handler: PaymentHandler | null): void {
    this._logger.info(
      { event: 'packet_handler_set', hasHandler: handler !== null },
      handler ? 'Packet handler registered' : 'Packet handler cleared'
    );
    if (handler) {
      const adapter = createPaymentHandlerAdapter(handler, this._logger);
      this._packetHandler.setLocalDeliveryHandler(adapter);
    } else {
      this._packetHandler.setLocalDeliveryHandler(null);
    }
  }

  /**
   * Get the effective deployment mode for this connector.
   *
   * Returns the deployment mode based on configuration:
   * 1. If `config.deploymentMode` is explicitly set, returns that value
   * 2. Otherwise, infers mode from `localDelivery` and `adminApi` flags:
   *    - `localDelivery.enabled=true` + `adminApi.enabled=true` → 'standalone'
   *    - `localDelivery.enabled=false` + `adminApi.enabled=false` → 'embedded'
   *    - Other combinations → defaults to 'embedded'
   *
   * **Deployment Modes:**
   * - **embedded**: Connector runs in same process as the app
   *   - Use `setPacketHandler()` or `setLocalDeliveryHandler()` for incoming packets
   *   - Use `node.sendPacket()` for outgoing packets
   *   - Admin API typically disabled
   *
   * - **standalone**: Connector runs as separate process/container
   *   - Incoming packets forwarded via HTTP to `/handle-packet` on external app
   *   - Outgoing packets sent via HTTP to `/admin/ilp/send` on connector admin API
   *   - Admin API enabled for external control
   *
   * @returns 'embedded' or 'standalone'
   *
   * @example
   * ```typescript
   * const mode = node.getDeploymentMode();
   * if (mode === 'embedded') {
   *   // In-process integration - use function handlers
   *   node.setPacketHandler(async (req) => ({ accept: true }));
   * } else {
   *   // Standalone mode - packets forwarded via HTTP
   *   console.log('Waiting for HTTP requests on /handle-packet');
   * }
   * ```
   */
  getDeploymentMode(): DeploymentMode {
    // Return explicit mode if configured
    if (this._config.deploymentMode) {
      return this._config.deploymentMode;
    }

    // Infer mode from configuration flags
    const hasLocalDelivery = this._config.localDelivery?.enabled === true;
    const hasAdminApi = this._config.adminApi?.enabled === true;

    // Standalone: Both HTTP delivery and admin API enabled
    if (hasLocalDelivery && hasAdminApi) {
      return 'standalone';
    }

    // Embedded: Both disabled (function handlers + library calls)
    if (!hasLocalDelivery && !hasAdminApi) {
      return 'embedded';
    }

    // Hybrid/unusual configuration — default to embedded
    // (e.g., adminApi enabled but localDelivery disabled = rare but valid)
    return 'embedded';
  }

  /**
   * Check if the connector is running in embedded mode.
   *
   * Embedded mode means the connector runs in the same process as the app:
   * - Incoming packets handled via `setPacketHandler()` or `setLocalDeliveryHandler()`
   * - Outgoing packets sent via `node.sendPacket()` library calls
   * - Admin API typically disabled (not needed for in-process communication)
   * - Local delivery disabled (function handlers used instead of HTTP)
   *
   * @returns true if deployment mode is 'embedded', false otherwise
   *
   * @example
   * ```typescript
   * if (node.isEmbedded()) {
   *   node.setPacketHandler(async (req) => {
   *     console.log('Received packet:', req);
   *     return { accept: true };
   *   });
   * }
   * ```
   */
  isEmbedded(): boolean {
    return this.getDeploymentMode() === 'embedded';
  }

  /**
   * Check if the connector is running in standalone mode.
   *
   * Standalone mode means the connector runs as a separate process/container:
   * - Incoming packets forwarded via HTTP POST to `/handle-packet` on external app
   * - Outgoing packets sent via HTTP POST to `/admin/ilp/send` on connector admin API
   * - Admin API enabled for external control
   * - Local delivery enabled with `handlerUrl` pointing to external app
   *
   * @returns true if deployment mode is 'standalone', false otherwise
   *
   * @example
   * ```typescript
   * if (node.isStandalone()) {
   *   console.log('Connector running in standalone mode');
   *   console.log('Admin API:', node._config.adminApi?.port);
   *   console.log('App URL:', node._config.localDelivery?.handlerUrl);
   * }
   * ```
   */
  isStandalone(): boolean {
    return this.getDeploymentMode() === 'standalone';
  }

  /**
   * Send an ILP Prepare packet through the connector's routing logic.
   * Routes through PacketHandler using RoutingTable longest-prefix matching.
   *
   * When `params.executionCondition` is provided (sender-chosen condition,
   * issue #309/PR #310 egress symmetry; toon-meta#145 §3 R4), it rides the
   * outgoing PREPARE verbatim — the claim/NIP-59 path never overwrites an
   * existing condition — and the resolved FULFILL carries the terminating
   * application's `fulfillment` preimage so the caller can verify
   * `sha256(fulfillment) === executionCondition`.
   *
   * @param params - Packet parameters (destination, amount, condition, expiry, data)
   * @returns ILP Fulfill or Reject packet
   * @throws ConnectorNotStartedError if connector has not been started
   * @throws InvalidExecutionConditionError if `executionCondition` is malformed
   *   (not base64 / not exactly 32 bytes / all-zero)
   */
  async sendPacket(params: SendPacketParams): Promise<ILPFulfillPacket | ILPRejectPacket> {
    if (!this._btpServerStarted) {
      throw new ConnectorNotStartedError();
    }

    const executionCondition = this._decodeExecutionCondition(params.executionCondition);

    const packet: ILPPreparePacket = {
      type: PacketType.PREPARE,
      destination: params.destination,
      amount: params.amount,
      expiresAt: params.expiresAt,
      data: params.data ?? Buffer.alloc(0),
      ...(executionCondition ? { executionCondition } : {}),
    };

    this._logger.info(
      {
        event: 'send_packet',
        destination: params.destination,
        amount: params.amount.toString(),
        expiresAt: params.expiresAt.toISOString(),
        hasExecutionCondition: !!executionCondition,
      },
      'Sending packet via public API'
    );

    try {
      return await this._packetHandler.handlePreparePacket(packet, this._config.nodeId);
    } catch (error) {
      this._logger.error(
        {
          event: 'send_packet_error',
          destination: params.destination,
          error: error instanceof Error ? error.message : String(error),
        },
        'Unexpected error sending packet'
      );
      return {
        type: PacketType.REJECT,
        code: ILPErrorCode.T00_INTERNAL_ERROR,
        triggeredBy: this._config.nodeId,
        message: 'Internal connector error',
        data: Buffer.alloc(0),
      } as ILPRejectPacket;
    }
  }

  /**
   * Decode and validate a caller-supplied execution condition for
   * {@link sendPacket} (issue #309/PR #310 egress symmetry).
   *
   * Accepts raw bytes or a base64 string; returns `undefined` when absent.
   * Enforces exactly 32 bytes after decode and rejects an all-zero condition:
   * all-zero is the wire encoding for "no condition" (the OER codec drops it
   * on decode and the claim path would replace it with a derived condition),
   * so it can never ride verbatim — callers wanting legacy behavior must omit
   * the field instead.
   *
   * @throws InvalidExecutionConditionError on malformed input
   */
  private _decodeExecutionCondition(
    condition: Uint8Array | string | undefined
  ): Uint8Array | undefined {
    if (condition === undefined) {
      return undefined;
    }

    let bytes: Uint8Array;
    if (typeof condition === 'string') {
      const decoded = Buffer.from(condition, 'base64');
      // Round-trip check: Buffer.from(..., 'base64') silently tolerates
      // invalid input; mirror the admin API's strict base64 validation.
      if (decoded.toString('base64') !== condition) {
        throw new InvalidExecutionConditionError('executionCondition must be valid base64');
      }
      bytes = new Uint8Array(decoded);
    } else {
      bytes = new Uint8Array(condition);
    }

    if (bytes.length !== 32) {
      throw new InvalidExecutionConditionError(
        `executionCondition must be exactly 32 bytes, got ${bytes.length}`
      );
    }
    if (bytes.every((b) => b === 0)) {
      throw new InvalidExecutionConditionError(
        'executionCondition must not be all-zero (all-zero means "no condition" on the wire); ' +
          'omit the field for unconditional packets'
      );
    }

    return bytes;
  }

  /**
   * Mnemonic signing mode (operator-provided runtime secret).
   *
   * When `process.env.TOON_MNEMONIC` (or the constructor `mnemonic` override for
   * tests) is set, derive the connector's EVM/Solana/Mina settlement keys from
   * that single BIP-39 mnemonic using the canonical multi-chain paths (matching
   * `@toon-protocol/sdk`'s `fromMnemonicFull`), and inject them into the
   * matching `chainProviders[].keyId` slots. The production image ships keyless;
   * the operator injects the seed phrase at deploy time via container env / a
   * secret manager. The mnemonic is sourced from the environment directly —
   * never from the YAML config (the loader does not interpolate `${...}`, and a
   * production seed must never live in a config file or the image).
   *
   * Additive and backward-compatible: when no mnemonic is present this is a
   * no-op and existing per-chain `keyId` configs boot unchanged. When a mnemonic
   * IS present, derived keys overwrite any per-chain `keyId` already in the
   * config (the mnemonic is the single source of truth for that node's keys).
   *
   * SECURITY: never logs the mnemonic or any derived private key.
   */
  private _applyMnemonicSigningMode(): void {
    const mnemonic = this._mnemonicOverride ?? process.env.TOON_MNEMONIC;
    if (!mnemonic) {
      return; // mnemonic mode inactive — keep existing per-chain keyId behavior
    }

    const providers = this._config.chainProviders;
    if (!providers || providers.length === 0) {
      this._logger.warn(
        { event: 'mnemonic_mode_no_chain_providers' },
        'TOON_MNEMONIC is set but no chainProviders are configured; no settlement keys to derive'
      );
      return;
    }

    const keys = deriveChainKeysFromMnemonic(mnemonic, this._mnemonicAccountIndex ?? 0);

    let evmInjected = false;
    let solanaInjected = false;
    let minaInjected = false;
    for (const provider of providers) {
      switch (provider.chainType) {
        case 'evm':
          provider.keyId = keys.evm.privateKey;
          evmInjected = true;
          break;
        case 'solana':
          provider.keyId = keys.solana.privateKey;
          solanaInjected = true;
          break;
        case 'mina':
          provider.keyId = keys.mina.privateKey;
          minaInjected = true;
          break;
      }
    }

    // Log only non-secret context: which chains got a derived key, and the
    // PUBLIC EVM/Solana addresses (never the private keys / mnemonic).
    this._logger.info(
      {
        event: 'mnemonic_signing_mode_enabled',
        evm: evmInjected,
        solana: solanaInjected,
        mina: minaInjected,
        evmAddress: evmInjected ? keys.evm.address : undefined,
        solanaAddress: solanaInjected ? keys.solana.address : undefined,
      },
      'Mnemonic signing mode active: derived per-chain settlement keys from TOON_MNEMONIC'
    );
  }

  /**
   * Resolve the connector's Nostr secret key (NIP-06) for self-announce signing.
   *
   * The NIP-06 Nostr key IS the connector's secp256k1 EVM settlement key
   * (`m/44'/1237'/0'/0/0`), so the self-announcement is signed under the SAME
   * identity the node settles with — matching how the devnet store apex pubkey
   * (`f9308a019258…036f9`) is derived. Resolution order:
   *
   * 1. The EVM `chainProviders[].keyId` (a raw 0x-hex private key). After
   *    `_applyMnemonicSigningMode()`, this already holds the mnemonic-derived
   *    key, so this branch covers both raw-key and mnemonic deploys.
   * 2. Otherwise derive directly from the mnemonic (env `TOON_MNEMONIC` or the
   *    test override).
   *
   * Returns null (with a warning) when no signing identity is available.
   *
   * SECURITY: never logs the key bytes or the mnemonic.
   */
  private _resolveNostrSecretKey(): Uint8Array | null {
    const evmProvider = this._config.chainProviders?.find((p) => p.chainType === 'evm');
    const keyId = (evmProvider as { keyId?: string } | undefined)?.keyId;
    if (keyId && /^(0x)?[0-9a-fA-F]{64}$/.test(keyId)) {
      return hexToBytes(keyId.replace(/^0x/, ''));
    }

    const mnemonic = this._mnemonicOverride ?? process.env.TOON_MNEMONIC;
    if (mnemonic) {
      try {
        const keys = deriveChainKeysFromMnemonic(mnemonic, this._mnemonicAccountIndex ?? 0);
        return hexToBytes(keys.evm.privateKey.replace(/^0x/, ''));
      } catch (err) {
        this._logger.warn(
          {
            event: 'self_announce_key_derive_failed',
            err: err instanceof Error ? err.message : String(err),
          },
          'Failed to derive Nostr key for self-announce'
        );
        return null;
      }
    }

    return null;
  }

  /**
   * Start the cold-start bootstrap service (toon-meta#153) when configured.
   *
   * Opt-in via `bootstrap.enabled`. Resolves relay seeds through the curated
   * signed registry → learned-peer cache → config seeds → hardcoded fallback
   * chain, sample-and-verifies candidates with a minimal kind:10032 probe, and
   * persists the survivors. Consumers stay loosely coupled: the discovered
   * relays are exposed via the public {@link bootstrapService} getter and the
   * service's `onRelaysResolved` callback — deep integration (self-announce
   * targets, kind:10032 route learning) belongs to the route-learning branch.
   * Best-effort: any failure logs and skips so startup is never blocked.
   */
  private _startBootstrap(): void {
    const bootstrap = this._config.bootstrap;
    if (!bootstrap?.enabled) {
      return;
    }

    try {
      const cachePath = bootstrap.cachePath ?? `./data/bootstrap-cache-${this._config.nodeId}.json`;
      const service = new BootstrapService({
        config: bootstrap,
        relayProbe: createKind10032RelayProbe(this._logger),
        cacheStore: new FileBootstrapCacheStore(cachePath, this._logger),
        logger: this._logger,
      });
      service.onRelaysResolved((relayUrls) => {
        // The route-learning branch will consume these; for now surface them.
        // Flag when self-announce carries no relay hint of its own — the
        // bootstrap result is then the node's only view of the relay set.
        this._logger.info(
          {
            event: 'bootstrap_relays_available',
            relayUrls,
            selfAnnounceHasRelayHint: Boolean(this._config.selfAnnounce?.relayUrl),
          },
          'Bootstrap discovered verified relays'
        );
      });
      service.start();
      this._bootstrapService = service;
    } catch (err) {
      this._bootstrapService = null;
      this._logger.warn(
        {
          event: 'bootstrap_start_failed',
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to start cold-start bootstrap service; continuing without it'
      );
    }
  }

  /**
   * Start the self-announce service (relay#37 / store#22) when configured.
   *
   * Opt-in via `selfAnnounce.enabled`. Builds the kind:10032 IlpPeerInfo from
   * this node's own routes/chainProviders/endpoints, signs with the NIP-06 key,
   * and publishes + refreshes it THROUGH this connector's own routing via
   * {@link _publishAnnouncement}. Best-effort: any failure logs and skips so
   * startup is never blocked.
   */
  private _startSelfAnnounce(): void {
    const selfAnnounce = this._config.selfAnnounce;
    if (!selfAnnounce?.enabled) {
      return;
    }

    const secretKey = this._resolveNostrSecretKey();
    if (!secretKey) {
      this._logger.warn(
        { event: 'self_announce_no_identity' },
        'selfAnnounce.enabled but no Nostr signing identity (set TOON_MNEMONIC or an EVM keyId); not announcing'
      );
      return;
    }

    try {
      this._selfAnnounceService = new SelfAnnounceService({
        config: this._config,
        selfAnnounce,
        secretKey,
        // Route the write through THIS connector's own pipe: a locally-terminated
        // announceTo delivers free; a remote announceTo pays from our channel.
        publish: (event) => this._publishAnnouncement(event),
        // Runtime-only announce fields: the EVM TokenNetwork contract is an
        // on-chain registry lookup, so it comes from the live providers rather
        // than config (Solana/Mina channel params are config-derived in the
        // builder). Resolved lazily by the service and cached.
        resolveTokenNetworks: () => this._resolveAnnounceTokenNetworks(),
        logger: this._logger,
      });
      this._selfAnnounceService.start();
    } catch (err) {
      this._selfAnnounceService = null;
      this._logger.warn(
        {
          event: 'self_announce_start_failed',
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to start self-announce service; continuing without it'
      );
    }
  }

  /**
   * Start the route-learning service (toon-meta#153) when configured.
   *
   * Opt-in via `routeLearning.enabled`. Subscribes to kind:10032 announcements
   * on the relay's FREE public read endpoint (SimplePool over WS), maintains a
   * link-state database, and installs/withdraws LEARNED routes in the routing
   * table below config precedence. Best-effort: any failure logs and skips so
   * startup is never blocked.
   */
  private _startRouteLearning(): void {
    const routeLearning = this._config.routeLearning;
    if (!routeLearning?.enabled) {
      return;
    }

    // Own pubkey (to ignore our own announcement in the relay stream). Derived
    // from the same NIP-06 key self-announce signs with; optional — without a
    // signing identity the node still learns, it just can't self-filter.
    const secretKey = this._resolveNostrSecretKey();
    const ownPubkey = secretKey ? getPublicKey(secretKey) : undefined;

    try {
      // Discovered-vs-peered (toon-meta#153): the registry rides the SAME
      // relay subscription via the route-learning ingest seam — discovery
      // stays free and opens no links; funding stays a bounded operator
      // choice (registerPeer + peeringPolicy.maxFundedChannels).
      this._discoveredNodeRegistry = new DiscoveredNodeRegistry({
        getFundedPeers: () => this._getFundedPeerRefs(),
        ...(ownPubkey ? { ownPubkey } : {}),
        logger: this._logger,
      });
      this._ilpMetrics.setDiscoveredNodeCountsProvider(
        () => this._discoveredNodeRegistry?.counts() ?? { discovered: 0, funded: 0 }
      );
      this._routeLearningService = new RouteLearningService({
        config: this._config,
        routeLearning,
        routingTable: this._routingTable,
        relayClient: createNostrRelayClient(),
        // Legal first hops are the BTP client peer set (the ids PacketHandler
        // can actually egress on).
        getDirectPeerIds: () => this._btpClientManager.getPeerIds(),
        ...(ownPubkey ? { ownPubkey } : {}),
        discoveredNodes: this._discoveredNodeRegistry,
        logger: this._logger,
      });
      this._routeLearningService.start();
    } catch (err) {
      this._routeLearningService = null;
      this._discoveredNodeRegistry = null;
      this._logger.warn(
        {
          event: 'route_learning_start_failed',
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to start route-learning service; continuing without it'
      );
    }
  }

  /**
   * Resolve the runtime-only `tokenNetworks` announce entries from the live
   * chain providers: for each EVM provider, the TokenNetwork contract address
   * looked up on-chain from the configured TokenNetworkRegistry (toon-client#378
   * consumes it as `tokenNetworks[chainId]`). Solana/Mina entries are
   * config-derived inside the announce builder and need no runtime resolution.
   *
   * Keyed by the providers' `chainId` — the exact identifiers the announcement
   * lists in `supportedChains` (both derive from `config.chainProviders`).
   * Per-provider failures are logged and skipped (a chain whose RPC is down
   * must not blank the whole map); an empty result is fine — the announcement
   * simply omits those entries.
   */
  private async _resolveAnnounceTokenNetworks(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const providers = this._chainRegistry?.getAllProviders() ?? [];
    for (const provider of providers) {
      if (!(provider instanceof EVMPaymentChannelProvider)) {
        continue;
      }
      try {
        const { tokenNetworkAddress } = await provider.getSigningContext();
        if (tokenNetworkAddress) {
          out[provider.chainId] = tokenNetworkAddress;
        }
      } catch (err) {
        this._logger.warn(
          {
            event: 'self_announce_token_network_lookup_failed',
            chainId: provider.chainId,
            err: err instanceof Error ? err.message : String(err),
          },
          'Failed to resolve TokenNetwork contract for announce (entry omitted)'
        );
      }
    }
    return out;
  }

  /**
   * Publish a signed kind:10032 announcement THROUGH this connector's own
   * routing (relay#37 / store#22). The same write path any client uses:
   *
   * - `announceTo` resolves to a LOCAL terminated route (this connector fronts
   *   the relay) → `sendPacket` with amount `0` → routed to this node's local
   *   delivery handler (the route's `HttpProxyHandler`), which reverse-proxies
   *   the inner `POST /write` to the route's resolved upstream. Local delivery
   *   returns before the forward/claim path, so it is **free**.
   * - `announceTo` is REMOTE (forwarded) → `sendPacket` with amount =
   *   `announcePrice` (> 0) → forwarded to the next-hop peer, where the forward
   *   path attaches a per-packet settlement claim funded from THIS connector's
   *   own channel. The connector **pays for its own write**.
   *
   * `routeTerminationRegistry.match(announceTo)` is the local-vs-remote signal;
   * `planAnnouncePublish` turns it into the `sendPacket` amount + envelope. The
   * write is delivered through `sendPacket`, never a raw POST to a private port.
   */
  private async _publishAnnouncement(event: NostrEvent): Promise<PublishOutcome> {
    const selfAnnounce = this._config.selfAnnounce!;
    const announceTo = selfAnnounce.announceTo;
    const isLocallyTerminated = this._routeTerminationRegistry.match(announceTo) !== undefined;

    const plan = planAnnouncePublish({
      announceTo,
      event,
      isLocallyTerminated,
      ...(selfAnnounce.announcePrice ? { remotePriceAtomic: selfAnnounce.announcePrice } : {}),
    });

    const expiresAt = new Date(Date.now() + SELF_ANNOUNCE_PREPARE_TIMEOUT_MS);
    const response = await this.sendPacket({
      destination: plan.destination,
      amount: plan.amount,
      expiresAt,
      data: plan.data,
    });

    if (response.type === PacketType.FULFILL) {
      return { mode: plan.mode, ok: true };
    }
    const reject = response as ILPRejectPacket;
    return { mode: plan.mode, ok: false, detail: `${reject.code}: ${reject.message ?? ''}`.trim() };
  }

  /**
   * Start connector and establish peer connections
   * Starts BTP server and connects to all configured peers
   */
  async start(): Promise<void> {
    this._logger.info(
      {
        event: 'connector_starting',
        nodeId: this._config.nodeId,
        peersCount: this._config.peers.length,
        routesCount: this._config.routes.length,
      },
      'Starting connector node'
    );

    try {
      // Validate chain provider configuration (checks chainType, duplicate chainIds,
      // required fields, and peer chain references)
      validateChainProviders(this._config, this._logger);

      // Mnemonic signing mode: when a single operator-provided BIP-39 mnemonic
      // is present (env `TOON_MNEMONIC` or the test override), derive the
      // EVM/Solana/Mina settlement keys and inject them into the
      // `chainProviders[].keyId` slots BEFORE the settlement stack consumes them
      // below. Additive and backward-compatible: absent a mnemonic, existing
      // per-chain `keyId` configs boot unchanged.
      this._applyMnemonicSigningMode();

      // Epic 35 / Story 35.4: initialize the transport provider BEFORE any
      // outbound subsystem (BTP server, settlement init, admin server, peer
      // loop). `provider.start()` is the fail-closed point -- if the
      // configured SOCKS5 proxy is unreachable, this throws and the entire
      // start() aborts before any BTP WebSocket is ever constructed.
      //
      // Note: `validateChainProviders` above is a pure config check (no
      // outbound network I/O), so ordering it before transport start is
      // safe. Chain RPC probes, if they occur, happen later during the
      // settlement init block -- those are out of scope for Story 35.4.
      // Construct the provider first; only record the resolved discriminator
      // AFTER construction succeeds so that a throw from `_createTransportProvider`
      // (e.g., the exhaustiveness guard for a future variant) cannot leave
      // `_transportType` stale while `_transportProvider` is still null.
      const createdProvider = this._createTransportProvider(this._config.transport);
      this._transportProvider = createdProvider;
      this._transportType =
        this._config.transport === undefined ? 'direct' : this._config.transport.type;
      try {
        await createdProvider.start();
      } catch (err) {
        // Clear the reference so a failed start() leaves the node
        // cleanly-stopped and re-startable (AC #3, #11).
        this._transportProvider = null;
        this._transportType = null;
        this._transportProviderReady = false;
        throw err;
      }
      // Provider successfully started -- now (and only now) expose it via the
      // public `transportProvider` getter (AC #11).
      this._transportProviderReady = true;
      // Seed the cached health value -- provider just verified reachability.
      this._lastTransportHealthy = true;
      // Schedule the background health refresh (AC #12). Bound to provider
      // lifecycle; cleared in stop() before provider.stop() is awaited.
      // The resolved handler captures the provider it invoked healthCheck() on
      // and only writes the cached value when that same provider is still the
      // active one AND is still ready -- otherwise an in-flight healthCheck()
      // promise resolving after stop() could mutate `_lastTransportHealthy`
      // on a stopped node, violating the spirit of AC #12.
      this._transportHealthInterval = setInterval(() => {
        const provider = this._transportProvider;
        if (!provider || !this._transportProviderReady) return;
        provider
          .healthCheck()
          .then((healthy) => {
            if (this._transportProviderReady && this._transportProvider === provider) {
              this._lastTransportHealthy = healthy;
            }
          })
          .catch(() => {
            if (this._transportProviderReady && this._transportProvider === provider) {
              this._lastTransportHealthy = false;
            }
          });
      }, this._transportHealthIntervalMs);
      // Do not keep the event loop alive solely for this timer.
      this._transportHealthInterval.unref?.();

      // Initialize EVM Payment Channel infrastructure from chainProviders
      const evmProviderConfig = this._config.chainProviders?.find((p) => p.chainType === 'evm') as
        | (EVMProviderConfig & { chainId: string })
        | undefined;

      // Warn if legacy settlement env vars are set
      const legacySettlementVars = [
        'BASE_L2_RPC_URL',
        'SETTLEMENT_ENABLED',
        'TOKEN_NETWORK_REGISTRY',
        'M2M_TOKEN_ADDRESS',
        'TREASURY_EVM_PRIVATE_KEY',
      ];
      const detectedLegacyVars = legacySettlementVars.filter((v) => process.env[v]);
      if (detectedLegacyVars.length > 0) {
        this._logger.warn(
          { event: 'legacy_env_vars_detected', vars: detectedLegacyVars },
          'Detected legacy settlement env vars -- these are no longer used. Configure chainProviders with an EVM entry instead.'
        );
      }

      const baseRpcUrl = evmProviderConfig?.rpcUrl;
      const registryAddress = evmProviderConfig?.registryAddress;
      const m2mTokenAddress = evmProviderConfig?.tokenAddress;
      const treasuryPrivateKey = evmProviderConfig?.keyId;

      // Issue #86: the settlement stack is no longer EVM-only. A node settles on
      // any configured chain — EVM (full config), Solana (rpc+program+key), or
      // Mina (graphql+zkApp+key). The EVM-specific sub-blocks below are gated on
      // `hasEvm`; everything chain-agnostic runs whenever `hasAnySettlementChain`.
      const chainProviderConfigs = this._config.chainProviders ?? [];
      const hasAnySettlementChain = chainProviderConfigs.some(
        (p) =>
          (p.chainType === 'evm' && p.rpcUrl && p.registryAddress && p.tokenAddress && p.keyId) ||
          (p.chainType === 'solana' &&
            p.rpcUrl &&
            p.programId &&
            (p.keyId || process.env.SOLANA_PRIVATE_KEY)) ||
          (p.chainType === 'mina' &&
            p.graphqlUrl &&
            p.zkAppAddress &&
            (p.keyId || process.env.MINA_PRIVATE_KEY))
      );
      const hasEvm = !!(
        evmProviderConfig &&
        baseRpcUrl &&
        registryAddress &&
        m2mTokenAddress &&
        treasuryPrivateKey
      );

      if (hasAnySettlementChain) {
        try {
          // -----------------------------------------------------------------
          // EVM-specific construction (issue #86): only runs when a full EVM
          // chainProvider is configured. For Solana-only / Mina-only nodes,
          // `this._paymentChannelSDK` and `this._channelManager` stay null and
          // the chain-agnostic code below builds the registry + executor +
          // claim receiver from the non-EVM providers instead.
          // -----------------------------------------------------------------
          // Primary EVM chain id (numeric, from blockchain config). Hoisted to
          // the outer scope because chain-agnostic code below references it when
          // computing `primaryChainIdStr`. Undefined for non-EVM-only nodes.
          let primaryChainId: number | undefined;

          if (hasEvm) {
            // Initialize KeyManager with Environment backend using direct private key injection
            // No process.env mutation needed — enables multi-node isolation
            const keyManager = new KeyManager(
              {
                backend: 'env',
                nodeId: this._config.nodeId,
                evmPrivateKey: treasuryPrivateKey,
              },
              this._logger
            );

            // Use 'evm' as key ID (EnvironmentVariableBackend detects type from keyId)
            const evmKeyId = 'evm';

            // Initialize PaymentChannelSDK (primary chain)
            const { ethers } = await requireOptional<typeof import('ethers')>(
              'ethers',
              'EVM settlement'
            );
            const provider = new ethers.JsonRpcProvider(baseRpcUrl);
            this._paymentChannelSDK = new PaymentChannelSDK(
              provider,
              keyManager,
              evmKeyId,
              registryAddress!,
              this._logger
            );

            // Resolve on-chain token symbol for canonical tokenId
            try {
              const resolvedSymbol = await this._paymentChannelSDK.getTokenSymbol(m2mTokenAddress!);
              if (resolvedSymbol) {
                this._defaultSettlementTokenId = resolvedSymbol;
                this._logger.info(
                  {
                    event: 'token_symbol_resolved',
                    symbol: resolvedSymbol,
                    tokenAddress: m2mTokenAddress,
                  },
                  `Resolved on-chain token symbol: ${resolvedSymbol}`
                );
              } else {
                this._logger.warn(
                  { event: 'token_symbol_empty', tokenAddress: m2mTokenAddress },
                  'ERC-20 symbol() returned empty string, falling back to M2M'
                );
              }
            } catch (symbolError) {
              this._logger.warn(
                {
                  event: 'token_symbol_resolution_failed',
                  tokenAddress: m2mTokenAddress,
                  error: symbolError instanceof Error ? symbolError.message : String(symbolError),
                },
                'Failed to resolve on-chain token symbol, falling back to M2M'
              );
            }

            // Store primary SDK in chain map
            primaryChainId =
              this._config.blockchain?.base?.chainId ?? this._config.blockchain?.arbitrum?.chainId;
            if (primaryChainId) {
              this._chainSDKs.set(primaryChainId, this._paymentChannelSDK);
            }

            // Initialize additional chain SDKs for multi-chain settlement
            const enabledChains: Array<{
              name: string;
              config: import('../config/types').EVMChainConfig;
            }> = [];
            if (this._config.blockchain?.base?.enabled && this._config.blockchain.base) {
              enabledChains.push({ name: 'Base', config: this._config.blockchain.base });
            }
            if (this._config.blockchain?.arbitrum?.enabled && this._config.blockchain.arbitrum) {
              enabledChains.push({ name: 'Arbitrum', config: this._config.blockchain.arbitrum });
            }

            for (const chain of enabledChains) {
              // Skip if already stored (primary chain)
              if (this._chainSDKs.has(chain.config.chainId)) {
                continue;
              }

              const chainRpcUrl = chain.config.rpcUrl;
              const chainRegistryAddress = chain.config.registryAddress ?? registryAddress!;
              const chainPrivateKey = chain.config.privateKey ?? treasuryPrivateKey!;

              // Create per-chain KeyManager if different private key
              const chainKeyManager =
                chainPrivateKey !== treasuryPrivateKey
                  ? new KeyManager(
                      {
                        backend: 'env',
                        nodeId: this._config.nodeId,
                        evmPrivateKey: chainPrivateKey,
                      },
                      this._logger
                    )
                  : keyManager;

              const chainProvider = new ethers.JsonRpcProvider(chainRpcUrl);
              const chainSDK = new PaymentChannelSDK(
                chainProvider,
                chainKeyManager,
                evmKeyId,
                chainRegistryAddress,
                this._logger
              );
              this._chainSDKs.set(chain.config.chainId, chainSDK);

              this._logger.info(
                {
                  event: 'chain_sdk_initialized',
                  chain: chain.name,
                  chainId: chain.config.chainId,
                  rpcUrl: chainRpcUrl,
                },
                `PaymentChannelSDK initialized for ${chain.name} (chainId: ${chain.config.chainId})`
              );
            }
          } // end if (hasEvm)

          // -----------------------------------------------------------------
          // Chain-agnostic settlement defaults (issue #86).
          //
          // When no EVM provider is configured, derive the default settlement
          // token id from the first non-EVM provider so executor token lookups
          // succeed: Solana -> `tokenMint ?? 'SOL'`, Mina -> `tokenId ?? 'MINA'`.
          // -----------------------------------------------------------------
          const firstNonEvmConfig = chainProviderConfigs.find(
            (p) => p.chainType === 'solana' || p.chainType === 'mina'
          );
          if (!hasEvm && firstNonEvmConfig) {
            if (firstNonEvmConfig.chainType === 'solana') {
              this._defaultSettlementTokenId = firstNonEvmConfig.tokenMint ?? 'SOL';
            } else if (firstNonEvmConfig.chainType === 'mina') {
              this._defaultSettlementTokenId = firstNonEvmConfig.tokenId ?? 'MINA';
            }
          }

          // Build peer ID to settlement-address mapping from config. EVM peers
          // use `evmAddress`; non-EVM peers use the generic `settlementAddress`.
          const peerIdToAddressMap = new Map<string, string>();
          for (const peer of this._config.peers) {
            const peerAddr = peer.evmAddress ?? peer.settlementAddress;
            if (peerAddr) {
              peerIdToAddressMap.set(peer.id, peerAddr);
              this._logger.debug(
                { peerId: peer.id, address: peerAddr },
                'Loaded peer settlement address from config'
              );
            }
          }

          // Env var fallback for peers without an address in config.
          // The legacy PEER{N}_EVM_ADDRESS pattern is EVM-only.
          if (hasEvm) {
            for (let i = 1; i <= 10; i++) {
              const peerAddress = process.env[`PEER${i}_EVM_ADDRESS`];
              const peerId = `peer${i}`;
              if (peerAddress && !peerIdToAddressMap.has(peerId)) {
                peerIdToAddressMap.set(peerId, peerAddress);
                this._logger.debug(
                  { peerId, address: peerAddress },
                  'Loaded peer EVM address from env var (fallback)'
                );
              }
            }
          }

          // Build token address map. For EVM, seed the resolved on-chain symbol
          // and the M2M token address. For non-EVM-only nodes, seed the default
          // token id -> on-chain token reference (Solana mint / Mina zkApp).
          const tokenAddressMap = new Map<string, string>();
          if (hasEvm) {
            tokenAddressMap.set(this._defaultSettlementTokenId, m2mTokenAddress!);
            tokenAddressMap.set(m2mTokenAddress!, m2mTokenAddress!); // Also map address to itself for direct lookups
          } else if (firstNonEvmConfig) {
            const nonEvmTokenRef =
              firstNonEvmConfig.chainType === 'solana'
                ? (firstNonEvmConfig.tokenMint ?? this._defaultSettlementTokenId)
                : firstNonEvmConfig.zkAppAddress;
            tokenAddressMap.set(this._defaultSettlementTokenId, nonEvmTokenRef);
          }

          // Settlement tuning: read from the first chainProvider that carries
          // settlementOptions (EVM today), falling back to safe defaults.
          const firstSettlementOptions = chainProviderConfigs.find(
            (p): p is EVMProviderConfig & { chainId: string } =>
              p.chainType === 'evm' && !!p.settlementOptions
          )?.settlementOptions;
          const defaultSettlementTimeout = firstSettlementOptions?.settlementTimeoutSecs ?? 86400;
          const initialDepositMultiplier = firstSettlementOptions?.initialDepositMultiplier ?? 1;

          // Initialize TigerBeetle AccountManager if configured (Story 19.1-19.2)
          // When TigerBeetle is unavailable, falls back to mock AccountManager (graceful degradation)
          let accountManager: AccountManager;
          const tigerBeetleClusterId = process.env.TIGERBEETLE_CLUSTER_ID;
          const tigerBeetleReplicas = process.env.TIGERBEETLE_REPLICAS;

          if (tigerBeetleClusterId && tigerBeetleReplicas) {
            try {
              // Resolve hostnames to IP addresses (TigerBeetle client requires IP addresses)
              const rawAddresses = tigerBeetleReplicas.split(',').map((s) => s.trim());
              const resolvedAddresses = await Promise.all(
                rawAddresses.map(async (addr) => {
                  const parts = addr.split(':');
                  const hostOrIp = parts[0] || addr;
                  const port = parts[1] || '3000';
                  // Check if already an IP address
                  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostOrIp)) {
                    return addr;
                  }
                  // Resolve hostname to IP
                  try {
                    const result = await dns.lookup(hostOrIp);
                    this._logger.debug(
                      { hostname: hostOrIp, ip: result.address },
                      'Resolved TigerBeetle hostname to IP'
                    );
                    return `${result.address}:${port}`;
                  } catch (dnsError) {
                    this._logger.warn(
                      { hostname: hostOrIp, error: dnsError },
                      'Failed to resolve TigerBeetle hostname, using as-is'
                    );
                    return addr;
                  }
                })
              );

              // Create TigerBeetle client
              const tbOperationTimeout = parseInt(
                process.env.TIGERBEETLE_OPERATION_TIMEOUT ?? '15000',
                10
              );
              const tigerBeetleClient = new TigerBeetleClient(
                {
                  clusterId: parseInt(tigerBeetleClusterId, 10),
                  replicaAddresses: resolvedAddresses,
                  connectionTimeout: 5000,
                  operationTimeout: tbOperationTimeout,
                },
                this._logger
              );

              // Initialize TigerBeetle connection
              await tigerBeetleClient.initialize();
              this._tigerBeetleClient = tigerBeetleClient;

              // Create AccountManager
              accountManager = new AccountManager(
                { nodeId: this._config.nodeId },
                tigerBeetleClient,
                this._logger
              );

              this._accountManager = accountManager;

              this._logger.info(
                {
                  event: 'tigerbeetle_account_manager_initialized',
                  clusterId: tigerBeetleClusterId,
                  replicas: tigerBeetleReplicas,
                },
                `Accounting backend: TigerBeetle (cluster: ${tigerBeetleClusterId}, replicas: ${tigerBeetleReplicas})`
              );
            } catch (error) {
              // Fall back to in-memory ledger if TigerBeetle initialization fails
              const errorMessage = error instanceof Error ? error.message : String(error);
              this._logger.warn(
                {
                  event: 'tigerbeetle_init_failed',
                  error: errorMessage,
                  clusterId: tigerBeetleClusterId,
                  replicas: tigerBeetleReplicas,
                },
                'TigerBeetle initialization failed, using in-memory ledger'
              );
              // Create InMemoryLedgerClient-backed AccountManager
              accountManager = await this._createInMemoryAccountManager();
              this._accountManager = accountManager;
            }
          } else {
            this._logger.info(
              { event: 'tigerbeetle_not_configured' },
              'TigerBeetle not configured (TIGERBEETLE_CLUSTER_ID or TIGERBEETLE_REPLICAS not set), using in-memory ledger'
            );
            // Create InMemoryLedgerClient-backed AccountManager
            accountManager = await this._createInMemoryAccountManager();
            this._accountManager = accountManager;
          }

          // Initialize SettlementMonitor for threshold-based settlement triggering
          // Extract peer IDs from peerIdToAddressMap (includes all known peers in the network)
          const peerIds = Array.from(peerIdToAddressMap.keys());

          const settlementThreshold = BigInt(firstSettlementOptions?.threshold ?? '1000000');

          this._logger.info(
            {
              event: 'settlement_monitor_config',
              peerIds,
              threshold: settlementThreshold.toString(),
            },
            'Initializing event-driven settlement monitor with peer list'
          );

          const settlementMonitor = new SettlementMonitor(
            {
              thresholds: {
                defaultThreshold: settlementThreshold,
              },
              peers: peerIds,
              tokenIds: [this._defaultSettlementTokenId],
            },
            this._logger
          );
          this._settlementMonitor = settlementMonitor;

          // Create a shared ChainProviderRegistry. Both SettlementExecutor and
          // PerPacketClaimService share this registry instance. Each configured
          // chain registers its own provider (issue #86): EVM (when hasEvm),
          // Solana, and Mina. One bad chain must not abort the others.
          const chainRegistry = new ChainProviderRegistry();
          // Expose the registry on the instance (read-only via the
          // `chainRegistry` getter) so the settlement stack's wiring is
          // observable after start() (issue #86).
          this._chainRegistry = chainRegistry;

          // Resolve primary EVM chain ID string: prefer blockchain config, then
          // chainProviders, then fallback. Only meaningful when hasEvm.
          const chainProviderChainId = this._config.chainProviders?.find(
            (cp) => cp.chainType === 'evm'
          )?.chainId;
          const evmChainIdStr = primaryChainId
            ? `evm:${primaryChainId}`
            : (chainProviderChainId ?? 'evm:unknown');

          if (hasEvm) {
            const evmProvider = new EVMPaymentChannelProvider(
              this._paymentChannelSDK!,
              evmChainIdStr,
              m2mTokenAddress!,
              this._logger
            );
            chainRegistry.register(evmProvider);
            this._logger.info(
              { event: 'chain_provider_registered', chainType: 'evm', chainId: evmChainIdStr },
              `EVM payment channel provider registered (${evmChainIdStr})`
            );
          }

          // Register Solana providers (issue #86). The signer is built from the
          // config keyId (raw base58) or the SOLANA_PRIVATE_KEY env fallback.
          for (const cfg of chainProviderConfigs) {
            if (cfg.chainType !== 'solana') continue;
            try {
              const solanaCfg = cfg as SolanaProviderConfig & { chainId: string };
              const signer = await resolveSolanaSigner(solanaCfg.keyId, this._logger);
              const tokenMint = solanaCfg.tokenMint ?? this._defaultSettlementTokenId;
              const provider = createSolanaProviderFactory(
                this._logger,
                signer,
                tokenMint
              )(solanaCfg);
              chainRegistry.register(provider);
              this._logger.info(
                {
                  event: 'chain_provider_registered',
                  chainType: 'solana',
                  chainId: provider.chainId,
                },
                `Solana payment channel provider registered (${provider.chainId})`
              );
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              this._logger.error(
                {
                  event: 'chain_provider_registration_failed',
                  chainType: 'solana',
                  chainId: cfg.chainId,
                  error: errorMessage,
                },
                'Failed to register Solana payment channel provider'
              );
            }
          }

          // Register Mina providers (issue #86). The signer key is the config
          // keyId (raw base58) or the MINA_PRIVATE_KEY env fallback.
          for (const cfg of chainProviderConfigs) {
            if (cfg.chainType !== 'mina') continue;
            try {
              const minaCfg = cfg as MinaProviderConfig & { chainId: string };
              const key = resolveMinaSignerKey(minaCfg.keyId);
              const provider = createMinaProviderFactory(this._logger, key)(minaCfg);
              chainRegistry.register(provider);
              this._logger.info(
                {
                  event: 'chain_provider_registered',
                  chainType: 'mina',
                  chainId: provider.chainId,
                },
                `Mina payment channel provider registered (${provider.chainId})`
              );
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              this._logger.error(
                {
                  event: 'chain_provider_registration_failed',
                  chainType: 'mina',
                  chainId: cfg.chainId,
                  error: errorMessage,
                },
                'Failed to register Mina payment channel provider'
              );
            }
          }

          // Determine the primary chain id string used as the default for peers
          // that don't explicitly reference a chain. For EVM nodes this is the
          // EVM chain. For non-EVM-only nodes it is the single registered chain;
          // if multiple non-EVM chains are registered, there is no safe default.
          const registeredChainIds = chainRegistry.getAllProviders().map((p) => p.chainId);
          const nonEvmChainIds = registeredChainIds.filter((id) => !id.startsWith('evm:'));
          const primaryChainIdStr = hasEvm
            ? evmChainIdStr
            : nonEvmChainIds.length === 1
              ? nonEvmChainIds[0]
              : undefined;

          // Build peerIdToChainMap — config-driven when peers have `chain` fields,
          // otherwise peers default to the single primary chain. When there are
          // multiple non-EVM chains and no explicit `peer.chain`, skip the peer
          // rather than guess.
          const peerIdToChainMap = new Map<string, string>();
          for (const peer of this._config.peers) {
            if (peer.chain) {
              // Config-driven: peer explicitly references a chain provider
              peerIdToChainMap.set(peer.id, peer.chain);
            } else if (peerIdToAddressMap.has(peer.id)) {
              if (primaryChainIdStr) {
                peerIdToChainMap.set(peer.id, primaryChainIdStr);
              } else {
                this._logger.warn(
                  { event: 'peer_chain_ambiguous', peerId: peer.id, chains: nonEvmChainIds },
                  'Peer has no explicit chain and multiple non-EVM chains are registered; skipping default chain mapping'
                );
              }
            }
          }
          // Also map env-var-discovered peers (legacy PEER{N} pattern) to the primary chain.
          if (primaryChainIdStr) {
            for (const peerId of peerIdToAddressMap.keys()) {
              if (!peerIdToChainMap.has(peerId)) {
                peerIdToChainMap.set(peerId, primaryChainIdStr);
              }
            }
          }

          // NIP-59 transport privacy setup
          const nip59Enabled = this._config.nip59?.enabled ?? false;
          const nip59Wrapper = new NIP59ClaimWrapper({
            nip59Enabled,
            logger: this._logger,
          });
          // NIP-59 wrapping needs an secp256k1 private key. This is derived from
          // the EVM treasury key; non-EVM-only nodes have no such key, so NIP-59
          // wrapping is simply unavailable for them (acceptable — issue #86).
          const nodeSecp256k1PrivKey =
            hasEvm && treasuryPrivateKey
              ? hexToBytes(treasuryPrivateKey.replace(/^0x/, ''))
              : undefined;
          const peerIdToNip59PubKey = new Map<string, Uint8Array>();
          for (const peer of this._config.peers) {
            if (peer.nip59PublicKey) {
              peerIdToNip59PubKey.set(peer.id, hexToBytes(peer.nip59PublicKey));
            }
          }
          if (nip59Enabled) {
            this._logger.info(
              { event: 'nip59_enabled', peerCount: peerIdToNip59PubKey.size },
              'NIP-59 transport privacy enabled for claim wrapping'
            );
          }

          this._settlementExecutor = new SettlementExecutor(
            {
              nodeId: this._config.nodeId,
              defaultSettlementTimeout,
              initialDepositMultiplier,
              minDepositThreshold: 0.5,
              maxRetries: 3,
              retryDelayMs: 5000,
              tokenAddressMap,
              peerIdToAddressMap,
              peerIdToChainMap,
            },
            accountManager,
            chainRegistry,
            settlementMonitor,
            this._logger
          );

          // Start automatic settlement execution
          this._settlementExecutor.start();
          this._logger.info(
            { event: 'settlement_executor_started' },
            'Automatic settlement execution enabled'
          );

          // Start event-driven settlement monitoring
          // ClaimReceiver will be wired below after PerPacketClaimService setup
          settlementMonitor.start();
          this._logger.info(
            {
              event: 'settlement_monitor_started',
              threshold: settlementThreshold.toString(),
              peerCount: peerIds.length,
            },
            'Event-driven settlement monitoring started'
          );

          // ChannelManager requires the EVM SDK + EVM registry/rpc/key, so it is
          // built only for EVM nodes (issue #86). For non-EVM-only nodes it stays
          // null; the SettlementExecutor's Wave-2 ClaimReceiver fallback derives
          // channel ids from verified inbound claims instead.
          if (hasEvm) {
            this._channelManager = new ChannelManager(
              {
                nodeId: this._config.nodeId,
                defaultSettlementTimeout,
                initialDepositMultiplier,
                idleChannelThreshold: 86400,
                minDepositThreshold: 0.5,
                idleCheckInterval: 3600,
                tokenAddressMap,
                peerIdToAddressMap,
                registryAddress: registryAddress!,
                rpcUrl: baseRpcUrl!,
                privateKey: treasuryPrivateKey!,
              },
              this._paymentChannelSDK!,
              this._settlementExecutor,
              this._logger
            );

            // Wire ChannelManager to SettlementExecutor for chain-agnostic channel lookup
            this._settlementExecutor.setChannelManager(this._channelManager);
          }

          this._logger.info(
            {
              event: 'payment_channel_sdk_initialized',
              registryAddress,
              tokenAddress: m2mTokenAddress,
              peerCount: peerIdToAddressMap.size,
            },
            'Payment channel infrastructure initialized'
          );

          // Wire PerPacketClaimService for attaching claims to outgoing packets
          if (this._channelManager && this._paymentChannelSDK) {
            try {
              // libsql is a better-sqlite3-compatible drop-in shipping N-API
              // prebuilt binaries, so it loads on Node 22.11+ and Node 24 with
              // no C toolchain (unlike native better-sqlite3, which has no Node
              // 24 prebuild). The @types/better-sqlite3 Database type still
              // describes the API surface accurately (issue #79).
              const LibsqlModule = await requireOptional<{
                default: new (path: string) => import('better-sqlite3').Database;
              }>('libsql', 'per-packet claims persistence');
              const LibsqlDatabase = LibsqlModule.default;

              const claimDbPath = `./data/claims-${this._config.nodeId}.db`;
              const claimDb = new LibsqlDatabase(claimDbPath);
              claimDb.exec(SENT_CLAIMS_TABLE_SCHEMA);
              for (const indexSql of SENT_CLAIMS_INDEXES) {
                claimDb.exec(indexSql);
              }

              // Reuse the shared chainRegistry hoisted before SettlementExecutor construction
              const perPacketClaimService = new PerPacketClaimService(
                chainRegistry,
                this._channelManager,
                claimDb,
                this._logger,
                this._config.nodeId,
                peerIdToChainMap,
                nip59Wrapper,
                nodeSecp256k1PrivKey,
                peerIdToNip59PubKey
              );
              this._packetHandler.setPerPacketClaimService(perPacketClaimService);
              this._settlementExecutor?.setPerPacketClaimService(perPacketClaimService);

              this._logger.info(
                { event: 'per_packet_claims_enabled' },
                'Per-packet claim service wired to PacketHandler and SettlementExecutor'
              );
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              this._logger.error(
                { event: 'per_packet_claims_init_failed', error: errorMessage },
                'Failed to initialize per-packet claim service'
              );
              throw error;
            }
          }

          // Wire inbound claim validator to BTP server to prevent unpaid writes.
          // Every ILP PREPARE arriving via BTP must carry a valid signed claim
          // before reaching the packet handler / local delivery.
          const inboundClaimValidator = new InboundClaimValidator(
            this._paymentChannelSDK ?? undefined,
            this._config.nodeId,
            this._logger,
            this._channelManager ?? undefined,
            nip59Wrapper,
            nodeSecp256k1PrivKey,
            // Relation-aware inbound validation (issue #78): consult the
            // forwarding path's single source of truth so a child node skips
            // the inline-claim requirement for PREPAREs from its parent,
            // mirroring the outbound child-skip in requiresSettlementClaim.
            (peerId) => this._packetHandler.getPeerRelation(peerId),
            // Issue #86: pass the registry so non-EVM inbound claims (Solana/Mina)
            // are accepted when a provider is registered for the claim's chain.
            chainRegistry,
            // Issue #353: freshness gate. The validator consults the
            // ClaimReceiver's received-claim nonce watermark (a LOCAL DB read,
            // no chain RPC) so a replayed stale-nonce claim is F06-rejected
            // BEFORE the packet ever reaches the local delivery handler /
            // backend. Lazy closure: the ClaimReceiver is constructed a few
            // steps below this validator; by the time packets flow it is
            // wired. When it is absent (routing-only mode, or init failure)
            // the gate falls back to crypto-only, the pre-#353 behavior.
            async (peerId, blockchain, channelId) =>
              this._claimReceiver
                ? this._claimReceiver.getReceivedClaimWatermark(peerId, blockchain, channelId)
                : null,
            // Issue #359: claim-value ↔ price binding. Resolve the destination's
            // authoritative flat route price from the #218 RouteTerminationRegistry
            // (an in-memory prefix map — RPC-free, hot-path-safe) so the gate can
            // require claimDelta >= price on locally-terminated priced routes and
            // F06-reject an underpaying claim BEFORE the backend runs. `match`
            // returns undefined for a forwarded / non-terminated destination →
            // coalesce to null (this connector is not the pricing authority there;
            // the gate falls back to freshness-only for such packets).
            (destination) => this._routeTerminationRegistry.match(destination)?.price ?? null,
            // Issue #359 / toon-meta#168: Mina value-binding migration switch.
            // Default fail-open-and-log for an ABSENT/unopenable Mina preimage
            // during the client-rollout window; the operator flips it to strict
            // (reject) once the fleet emits the openable `[transferredAmount,
            // balanceB, salt]` preimage everywhere. A PRESENT-but-mismatched
            // preimage is always rejected regardless of this flag.
            this._config.settlement?.minaValueBindingStrict ?? false
          );
          this._inboundClaimValidate = (protocolData, ilpPacket, peerId) =>
            inboundClaimValidator.validate(protocolData, ilpPacket, peerId);
          this._btpServer.setInboundClaimValidator(this._inboundClaimValidate);
          this._logger.info(
            { event: 'inbound_claim_validator_enabled' },
            'Inbound claim validator wired to BTP + ILP-over-HTTP transports'
          );

          // Wire ClaimReceiver for event-driven settlement monitoring
          // ClaimReceiver validates inbound claims and emits CLAIM_RECEIVED events
          // that SettlementMonitor uses to trigger on-chain claimFromChannel().
          // Issue #86: built for any active settlement stack — it only needs the
          // chainRegistry (not the EVM SDK), so non-EVM nodes get the credit path.
          if (chainRegistry.getAllProviders().length > 0) {
            try {
              // libsql: better-sqlite3-compatible drop-in with N-API prebuilts
              // (Node 22.11+/24, no native build). See note above (issue #79).
              const LibsqlModule = await requireOptional<{
                default: new (path: string) => import('better-sqlite3').Database;
              }>('libsql', 'claim receiver persistence');
              const LibsqlDatabase = LibsqlModule.default;

              const receivedClaimDbPath = `./data/received-claims-${this._config.nodeId}.db`;
              const receivedClaimDb = new LibsqlDatabase(receivedClaimDbPath);
              initializeClaimReceiverSchema(receivedClaimDb);

              const claimReceiver = new ClaimReceiver(
                receivedClaimDb,
                chainRegistry,
                this._logger,
                this._channelManager ?? undefined,
                peerIdToAddressMap,
                nip59Wrapper,
                nodeSecp256k1PrivKey
              );

              // Register with BTP server to receive claim messages
              claimReceiver.registerWithBTPServer(this._btpServer);

              // Wire to SettlementMonitor for event-driven threshold detection
              if (this._settlementMonitor) {
                this._settlementMonitor.setClaimReceiver(claimReceiver);
                // Restart monitor to subscribe to the new ClaimReceiver
                this._settlementMonitor.stop();
                this._settlementMonitor.start();
              }

              // Wire to SettlementExecutor so claimFromChannel can source the
              // peer's signed balance proof from received claims, not just
              // locally-sent ones. Without this, the credit-side settlement
              // path has no claim to submit on-chain.
              this._settlementExecutor?.setClaimReceiver(claimReceiver);

              // Store on the instance so AdminServer can expose it on the
              // /admin/earnings.json endpoint. Without this, the earnings
              // endpoint always returns 503 even when claimReceiver is wired.
              this._claimReceiver = claimReceiver;

              this._logger.info(
                { event: 'claim_receiver_enabled' },
                'ClaimReceiver wired to BTP server and SettlementMonitor'
              );
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              this._logger.error(
                { event: 'claim_receiver_init_failed', error: errorMessage },
                'Failed to initialize ClaimReceiver'
              );
            }
          }

          // Wire AccountManager into PacketHandler for settlement recording
          if (accountManager) {
            const settlementConfig: SettlementConfig = {
              connectorFeePercentage: this._config.settlement?.connectorFeePercentage ?? 0.1,
              enableSettlement: true,
              tigerBeetleClusterId: tigerBeetleClusterId ? parseInt(tigerBeetleClusterId, 10) : 0,
              tigerBeetleReplicas: tigerBeetleReplicas
                ? tigerBeetleReplicas.split(',').map((s) => s.trim())
                : [],
            };

            this._packetHandler.setSettlement(
              accountManager,
              settlementConfig,
              this._defaultSettlementTokenId
            );
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          // Missing native SQLite modules are deployment defects (e.g. Docker
          // image built without compiled bindings), not runtime issues. Fail
          // closed so operators see the failure at startup instead of silently
          // running in routing-only mode and rejecting paid traffic later. The
          // pattern matches requireOptional()'s canonical message format.
          const isMissingNativeDep = /^(better-sqlite3|libsql) is required for /.test(errorMessage);
          this._logger.error(
            {
              event: isMissingNativeDep
                ? 'payment_channel_init_aborted'
                : 'payment_channel_init_failed',
              error: errorMessage,
            },
            isMissingNativeDep
              ? 'Payment channel native dependency missing — connector startup aborted'
              : 'Failed to initialize payment channel infrastructure (connector continues without channels)'
          );
          if (isMissingNativeDep) {
            throw error;
          }
        }
      } else {
        this._logger.info(
          { event: 'payment_channels_disabled' },
          'Payment channel infrastructure disabled (missing configuration)'
        );
      }

      // x402 v2 greeting (#217): map each x402-nameable settlement chain to the
      // connector's internal namespaced chainId (`evm:<id>`, `solana:<cluster>`)
      // so the greeting can derive CAIP-2 `network` ids. Sourced from
      // chainProviders config — never hardcoded. Mina is intentionally absent
      // (x402 has no Mina network id; mina rides the toon-channel upgrade only).
      const terminationChainIds: Partial<Record<TerminationChain, string>> = {};
      for (const cp of this._config.chainProviders ?? []) {
        if (cp.chainType === 'evm' && !terminationChainIds.evm) {
          terminationChainIds.evm = cp.chainId;
        } else if (cp.chainType === 'solana' && !terminationChainIds.solana) {
          terminationChainIds.solana = cp.chainId;
        }
      }

      // Enable ILP-over-HTTP (RFC-0035) on the same listener the BTP server
      // owns: POST /ilp terminates at the same claim gate + packet handler as
      // BTP. Wire before start() so the handler is live when the port opens.
      const ilpHttpAdapter = new IlpHttpAdapter({
        logger: this._logger,
        nodeId: this._config.nodeId,
        handlePrepare: (ilpPacket, peerId, protocolData) =>
          this._packetHandler.handlePreparePacket(ilpPacket, peerId, protocolData),
        validateClaim: this._inboundClaimValidate ?? undefined,
        // Record HTTP-delivered claims through the same ClaimReceiver as BTP so
        // one-shot POST /ilp writes credit on-chain settlement identically.
        recordClaim: this._claimReceiver
          ? (peerId, protocolData) => this._claimReceiver!.ingestProtocolData(peerId, protocolData)
          : undefined,
        // x402 v2 greeting (#217): resolve a destination's RouteTermination from
        // the #218 registry so an unpaid request to a terminated route is greeted
        // with a 402. `match` returns undefined → coalesce to null (no greeting).
        resolveTermination: (prepare) =>
          this._routeTerminationRegistry.match(prepare.destination) ?? null,
        terminationChainIds,
      });
      this._btpServer.setIlpHttpHandler((req, res) => ilpHttpAdapter.handle(req, res));

      // Start the BTP server (now also serves ILP-over-HTTP on the same port).
      await this._btpServer.start(this._config.btpServerPort);
      this._btpServerStarted = true;
      this._logger.info(
        {
          event: 'btp_server_started',
          port: this._config.btpServerPort,
        },
        'BTP + ILP-over-HTTP server started'
      );

      // Start health server
      const healthCheckPort = this._config.healthCheckPort || 8080;
      await this._healthServer.start(healthCheckPort);
      this._logger.info(
        {
          event: 'health_server_started',
          port: healthCheckPort,
        },
        'Health server started'
      );

      // Open the persistent peer/route registry before the admin server so the
      // admin HTTP surface (the primary operator path for runtime peers/routes)
      // shares the same store and its mutations survive a restart.
      await this._openRegistryStore();

      // Start admin API server if enabled
      const adminApiEnabled =
        this._config.adminApi?.enabled || process.env.ADMIN_API_ENABLED === 'true';
      if (adminApiEnabled) {
        const adminConfig = {
          enabled: true,
          port: this._config.adminApi?.port ?? parseInt(process.env.ADMIN_API_PORT || '8081', 10),
          host: this._config.adminApi?.host ?? process.env.ADMIN_API_HOST ?? '0.0.0.0',
          apiKey: this._config.adminApi?.apiKey ?? process.env.ADMIN_API_KEY,
          // Forward the IP allowlist / trust-proxy from config (or env) to the
          // AdminServer. Without this, `adminApi.allowedIPs` set in the YAML was
          // silently dropped — the admin API bound without the allowlist the
          // operator configured, leaving it protected only by host/port binding.
          allowedIPs:
            this._config.adminApi?.allowedIPs ??
            (process.env.ADMIN_API_ALLOWED_IPS
              ? process.env.ADMIN_API_ALLOWED_IPS.split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
              : undefined),
          trustProxy:
            this._config.adminApi?.trustProxy ?? process.env.ADMIN_API_TRUST_PROXY === 'true',
        };

        this._adminServer = new AdminServer({
          routingTable: this._routingTable,
          btpClientManager: this._btpClientManager,
          nodeId: this._config.nodeId,
          config: adminConfig,
          logger: this._logger,
          settlementPeers: this._settlementPeers,
          channelManager: this._channelManager ?? undefined,
          paymentChannelSDK: this._paymentChannelSDK ?? undefined,
          accountManager: this._accountManager ?? undefined,
          claimReceiver: this._claimReceiver ?? undefined,
          settlementMonitor: this._settlementMonitor ?? undefined,
          defaultSettlementTokenId: this._defaultSettlementTokenId,
          packetSender: (params) => this.sendPacket(params),
          isReady: () => this._btpServerStarted,
          metricsRegistry: this._ilpMetrics,
          // Per-peer transport selection: forward the post-validation
          // Relationship-aware settlement gate (issue #76): POST /admin/peers
          // forwards a peer's relation to the PacketHandler so value-bearing
          // forwards to a 'child' next hop skip the mandatory per-packet claim.
          setPeerRelation: (peerId, relation) =>
            this._packetHandler.setPeerRelation(peerId, relation),
          // Phase 2/persistence: let the admin handlers read a peer's relation
          // (for relation↔route admission validation) and write-through peer
          // registrations to the shared registry so they survive a restart.
          getPeerRelation: (peerId) => this._packetHandler.getPeerRelation(peerId),
          registryStore: this._registryStore ?? undefined,
          // Epic 38, Story 38.1: let POST /admin/peers register ilp-http peers
          // with the HTTP egress and propagate the packet protocol to the seam.
          httpPeerEgress: this._httpPeerClientManager,
          setPeerProtocol: (peerId, protocol) =>
            this._packetHandler.setPeerProtocol(peerId, protocol),
          // Issue #218: let PUT /admin/desired-state reconcile per-route
          // local-termination config (upstream/price/chains/…) into the same
          // in-memory registry #216's proxy handler resolves against.
          routeTerminationRegistry: this._routeTerminationRegistry,
          // toon-meta#153 (discovered-vs-peered): surface the discovered set
          // read-only, and mirror the funded-channel cap on POST /admin/peers
          // with the exact error string registerPeer throws (cross-surface
          // parity).
          getDiscoveredNodes: () => this.getDiscoveredNodes(),
          checkFundedChannelCap: (peerId) => this._checkFundedChannelCap(peerId),
          // Issue #345: POST/DELETE /admin/peers mutate the client managers
          // directly (they do not call registerPeer/removePeer), so they must
          // maintain the same runtime-url map the discovered registry's
          // endpoint-fallback funded matching reads — otherwise a peer
          // promoted via the admin surface shows `funded: false` until a
          // restart replays the registration.
          recordRuntimePeerUrl: (peerId, url) => this._runtimePeerUrls.set(peerId, url),
          forgetRuntimePeerUrl: (peerId) => this._runtimePeerUrls.delete(peerId),
        });

        await this._adminServer.start();
        this._logger.info(
          {
            event: 'admin_server_started',
            port: adminConfig.port,
            host: adminConfig.host,
            apiKeyConfigured: !!adminConfig.apiKey,
          },
          'Admin API server started'
        );
      } else {
        this._logger.debug(
          { event: 'admin_api_disabled' },
          'Admin API disabled (set ADMIN_API_ENABLED=true or adminApi.enabled=true to enable)'
        );
      }

      // Connect BTP clients to all configured peers
      // Convert PeerConfig to Peer format
      const peerConnections: Promise<void>[] = [];
      for (const peerConfig of this._config.peers) {
        // Epic 38, Story 38.1: an 'ilp-http' peer registers with the HTTP egress
        // manager (connectionless POST /ilp) instead of opening a BTP socket.
        if (peerConfig.peerProtocol === 'ilp-http') {
          const httpPeer: HttpPeer = {
            id: peerConfig.id,
            httpUrl: peerConfig.httpUrl!,
            httpPath: peerConfig.httpPath,
            authToken: peerConfig.authToken,
            httpTimeoutMs: peerConfig.httpTimeoutMs,
          };
          peerConnections.push(this._httpPeerClientManager.addPeer(httpPeer));
          continue;
        }
        const peer: Peer = {
          id: peerConfig.id,
          url: peerConfig.url,
          authToken: peerConfig.authToken,
          connected: false,
          lastSeen: new Date(),
          transport: peerConfig.transport,
        };
        peerConnections.push(this._btpClientManager.addPeer(peer));
      }

      // Wait for all peer connection attempts (don't fail if some connections fail)
      // BTPClient will automatically retry failed connections in the background
      const peerResults = await Promise.allSettled(peerConnections);
      const failedPeers = peerResults.filter((r) => r.status === 'rejected');
      if (failedPeers.length > 0) {
        this._logger.warn(
          {
            event: 'peer_connection_failures',
            failedCount: failedPeers.length,
            totalPeers: this._config.peers.length,
          },
          'Some peer connections failed during startup (will retry in background)'
        );
      }

      // Replay any runtime-added peers/routes from a previous run so they
      // survive this restart (instead of the "re-POST the relay route" RUNBOOK
      // recovery). The store itself was opened earlier (before the admin server)
      // so the admin HTTP surface shares it. Best-effort.
      await this._reconcileRegistry();

      const connectedPeers = this._btpClientManager.getPeerStatus();
      const connectedCount = Array.from(connectedPeers.values()).filter(Boolean).length;

      // Create payment channels for connected peers (if channel infrastructure is enabled)
      if (this._channelManager && this._paymentChannelSDK) {
        this._logger.info(
          { event: 'creating_payment_channels', connectedCount },
          'Creating payment channels for connected peers'
        );

        const channelCreationPromises: Promise<void>[] = [];
        for (const [peerId, connected] of connectedPeers.entries()) {
          if (!connected) {
            continue; // Skip disconnected peers
          }

          // Create channel creation promise (don't await - run in parallel)
          const channelPromise = (async () => {
            try {
              const tokenId = this._defaultSettlementTokenId;
              const peerConfig = this._config.peers.find((p) => p.id === peerId);
              const peerChain = peerConfig?.chain;
              const channelId = await this._channelManager!.ensureChannelExists(
                peerId,
                tokenId,
                peerChain ? { chain: peerChain } : undefined
              );
              this._logger.info(
                { event: 'payment_channel_ready', peerId, channelId, chain: peerChain },
                'Payment channel ready for peer'
              );
            } catch (error) {
              // Don't fail startup if channel creation fails
              const errorMessage = error instanceof Error ? error.message : String(error);
              this._logger.warn(
                { event: 'payment_channel_creation_failed', peerId, error: errorMessage },
                'Failed to create payment channel for peer (will retry on-demand)'
              );
            }
          })();

          channelCreationPromises.push(channelPromise);
        }

        // Wait for all channel creation attempts (but don't fail if some fail)
        await Promise.allSettled(channelCreationPromises);
        this._logger.info(
          { event: 'payment_channels_initialized' },
          'Payment channel creation completed'
        );
      }

      // Cold-start bootstrap (toon-meta#153): resolve + verify relay seeds so
      // a cold node can find its first relay. Started alongside self-announce
      // (below) once the node is otherwise up. Best-effort: a failure logs and
      // skips rather than aborting startup.
      this._startBootstrap();

      // Self-announce (relay#37 / store#22): publish + refresh this node's own
      // kind:10032 IlpPeerInfo so its apex routes are discoverable out of band.
      // Started last (after the BTP/HTTP/admin surfaces are up) so the
      // announcement reflects a fully-running node. Best-effort: a build/key
      // failure logs and skips rather than aborting startup.
      this._startSelfAnnounce();

      // Route learning (toon-meta#153): consume peers' kind:10032
      // announcements and install learned multi-hop routes. Started alongside
      // self-announce (after the BTP peer set exists). Best-effort.
      this._startRouteLearning();

      // Initial health-status snapshot after all components started. NOTE: at
      // this instant peers may still be mid-connect (e.g. BTP handshakes that
      // complete a few seconds later), so this snapshot alone is NOT
      // authoritative — hence the event-driven callback wired in the
      // constructor plus the periodic backstop below.
      this._updateHealthStatus();

      // Periodic health re-evaluation backstop. Event-driven updates (peer
      // connect/disconnect) are the primary trigger; this timer guarantees
      // convergence even if an event were ever missed. Cleared in stop() and
      // the start() rollback path so no interval leaks. unref() so the timer
      // never keeps the process alive on its own.
      this._healthStatusInterval = setInterval(() => {
        this._updateHealthStatus();
      }, this._healthStatusIntervalMs);
      this._healthStatusInterval.unref?.();

      this._logger.info(
        {
          event: 'connector_ready',
          nodeId: this._config.nodeId,
          connectedPeers: connectedCount,
          totalPeers: this._config.peers.length,
          healthStatus: this._healthStatus,
        },
        'Connector node ready'
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this._logger.error(
        {
          event: 'connector_start_failed',
          nodeId: this._config.nodeId,
          error: errorMessage,
        },
        'Failed to start connector node'
      );
      // Epic 35 / Story 35.4: rollback transport provider + health timer if
      // they were started before a later subsystem (BTP server, settlement,
      // admin, peer loop) failed. Without this, the stop() idempotence guard
      // (keyed on _btpServerStarted && _adminServer) returns early and leaks
      // the running transport provider and its 30s health-refresh interval.
      if (this._transportHealthInterval) {
        clearInterval(this._transportHealthInterval);
        this._transportHealthInterval = null;
      }
      if (this._healthStatusInterval) {
        clearInterval(this._healthStatusInterval);
        this._healthStatusInterval = null;
      }
      if (this._transportProvider) {
        // AC #11: hide the provider from the public getter immediately — the
        // rollback path is morally equivalent to stop() beginning.
        this._transportProviderReady = false;
        try {
          await this._transportProvider.stop();
        } catch (stopErr) {
          const stopMsg = stopErr instanceof Error ? stopErr.message : String(stopErr);
          this._logger.warn(
            { event: 'transport_rollback_stop_failed', error: stopMsg },
            'Transport provider stop() failed during start() rollback; continuing'
          );
        } finally {
          this._transportProvider = null;
          this._transportType = null;
        }
      }
      this._healthStatus = 'unhealthy';
      throw error;
    }
  }

  /**
   * Stop connector and disconnect all peers
   * Gracefully shuts down all components
   */
  async stop(): Promise<void> {
    // Idempotent guard: if already stopped, return immediately
    if (!this._btpServerStarted && !this._adminServer) {
      this._logger.debug(
        { event: 'connector_already_stopped' },
        'Connector already stopped, ignoring'
      );
      return;
    }

    this._logger.info(
      {
        event: 'connector_stopping',
        nodeId: this._config.nodeId,
      },
      'Stopping connector node'
    );

    try {
      // Stop the self-announce refresh loop first (clears its unref'd timer).
      if (this._selfAnnounceService) {
        this._selfAnnounceService.stop();
        this._selfAnnounceService = null;
      }

      // Stop route learning (closes the relay subscription, withdraws all
      // learned soft-state routes, clears its unref'd sweep timer, and clears
      // the discovered-node registry it feeds — soft state, re-learned after
      // boot).
      if (this._routeLearningService) {
        this._routeLearningService.stop();
        this._routeLearningService = null;
      }
      this._discoveredNodeRegistry = null;

      // Stop the cold-start bootstrap refresh loop (clears its unref'd timer).
      if (this._bootstrapService) {
        this._bootstrapService.stop();
        this._bootstrapService = null;
      }

      // Stop settlement monitor FIRST to stop polling the ledger during drain.
      // The executor already unsubscribes in its own stop(), so no new events fire.
      if (this._settlementMonitor) {
        await this._settlementMonitor.stop();
        this._logger.info({ event: 'settlement_monitor_stopped' }, 'Settlement monitor stopped');
        this._settlementMonitor = null;
      }

      // Stop settlement executor — awaits in-flight settlements to prevent
      // on-chain/off-chain balance mismatches on SIGTERM/shutdown
      if (this._settlementExecutor) {
        await this._settlementExecutor.stop();
        this._logger.info({ event: 'settlement_executor_stopped' }, 'Settlement executor stopped');
        this._settlementExecutor = null;
      }

      // Stop channel manager if running
      if (this._channelManager) {
        this._channelManager.stop();
        this._logger.info({ event: 'channel_manager_stopped' }, 'Channel manager stopped');
        this._channelManager = null;
      }

      // Clean up all chain SDKs
      for (const [chainId, sdk] of this._chainSDKs.entries()) {
        sdk.removeAllListeners();
        this._logger.debug(
          { event: 'chain_sdk_stopped', chainId },
          `Chain SDK stopped (chainId: ${chainId})`
        );
      }
      this._chainSDKs.clear();

      // Clean up primary payment channel SDK reference
      if (this._paymentChannelSDK) {
        // Already cleaned up via _chainSDKs iteration above, just null the reference
        this._logger.info({ event: 'payment_channel_sdk_stopped' }, 'Payment channel SDK stopped');
        this._paymentChannelSDK = null;
      }

      // Drop the chain provider registry reference (issue #86 observability surface)
      this._chainRegistry = null;

      // Close TigerBeetle client if connected
      if (this._tigerBeetleClient) {
        await this._tigerBeetleClient.close();
        this._logger.info({ event: 'tigerbeetle_client_closed' }, 'TigerBeetle client closed');
        this._tigerBeetleClient = null;
      }

      // Close InMemoryLedgerClient if connected (ensures final snapshot persistence)
      if (this._inMemoryLedgerClient) {
        await this._inMemoryLedgerClient.close();
        this._logger.info({ event: 'in_memory_ledger_closed' }, 'In-memory ledger client closed');
        this._inMemoryLedgerClient = null;
      }

      // Code-review C2: stop AdminServer BEFORE nulling `_claimReceiver`. The
      // AdminServer captures `claimReceiver` by value at construction (see
      // ~line 1251). Nulling the node-side field while the AdminServer is
      // still serving requests creates a race window where the server keeps
      // serving with a captured reference whose underlying resources are
      // being torn down. Stopping the AdminServer first rejects new requests
      // and waits for in-flight handlers to drain.
      if (this._adminServer) {
        await this._adminServer.stop();
        this._logger.info({ event: 'admin_server_stopped' }, 'Admin API server stopped');
        this._adminServer = null;
      }

      // Code-review C1: dispose ClaimReceiver before nulling. Optional
      // chaining keeps this safe today (ClaimReceiver has no dispose() yet)
      // and establishes the pattern for when dispose() is implemented to
      // release SQLite handles + close file descriptors. Without this, the
      // node-side null masks open resource handles in tests that recreate
      // connector instances repeatedly.
      try {
        await (
          this._claimReceiver as unknown as { dispose?: () => Promise<void> } | null
        )?.dispose?.();
      } catch (e) {
        this._logger.warn(
          { event: 'claim_receiver_dispose_failed', err: e },
          'ClaimReceiver dispose() threw — ignoring'
        );
      }
      this._accountManager = null;
      this._claimReceiver = null;

      // Disconnect all BTP clients
      const peerIds = this._btpClientManager.getPeerIds();
      for (const peerId of peerIds) {
        await this._btpClientManager.removePeer(peerId);
      }

      // Stop health server
      await this._healthServer.stop();

      // Stop the BTP server (closes the HTTP listener, peer sockets, and the WS).
      await this._btpServer.stop();

      // Epic 35 / Story 35.4: stop the transport provider LAST (after the
      // BTP layer is torn down so no in-flight createAgent() call can race
      // the provider stop). Clear the health-refresh timer first so no
      // further healthCheck() invocations fire during or after stop().
      if (this._transportHealthInterval) {
        clearInterval(this._transportHealthInterval);
        this._transportHealthInterval = null;
      }
      // Clear the periodic health re-evaluation backstop so no interval leaks.
      if (this._healthStatusInterval) {
        clearInterval(this._healthStatusInterval);
        this._healthStatusInterval = null;
      }
      if (this._transportProvider) {
        // AC #11: flip the getter to null BEFORE awaiting provider.stop() so
        // callers never observe a provider that is mid-teardown.
        this._transportProviderReady = false;
        try {
          await this._transportProvider.stop();
        } finally {
          this._transportProvider = null;
          this._transportType = null;
        }
      }

      this._logger.info(
        {
          event: 'connector_stopped',
          nodeId: this._config.nodeId,
        },
        'Connector node stopped'
      );

      this._healthStatus = 'starting'; // Reset to initial state
      this._btpServerStarted = false;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this._logger.error(
        {
          event: 'connector_stop_failed',
          nodeId: this._config.nodeId,
          error: errorMessage,
        },
        'Failed to stop connector node gracefully'
      );
      throw error;
    }
  }

  /**
   * Get connector health status (implements HealthStatusProvider interface)
   * @returns Current health status including connected peers and uptime
   */
  getHealthStatus(): HealthStatus {
    const peerStatus = this._btpClientManager.getPeerStatus();
    const peersConnected = Array.from(peerStatus.values()).filter(Boolean).length;
    const totalPeers = this._config.peers.length;
    const uptime = Math.floor((Date.now() - this._startTime.getTime()) / 1000);

    const healthStatus: HealthStatus = {
      status: this._healthStatus,
      uptime,
      peersConnected,
      totalPeers,
      timestamp: new Date().toISOString(),
      nodeId: this._config.nodeId,
      version: packageJson.version,
    };

    // Epic 35 / Story 35.4: surface transport status. Absent before start()
    // and after stop() (i.e., when the provider reference is null). The
    // `healthy` value is the cached result of the background refresh
    // (Option A -- getHealthStatus must remain synchronous).
    if (this._transportProviderReady && this._transportProvider && this._transportType) {
      healthStatus.transport = {
        type: this._transportType,
        healthy: this._transportType === 'direct' ? true : this._lastTransportHealthy,
      };
    }

    return healthStatus;
  }

  /**
   * Update health status based on current peer connections
   * Called internally when connection state changes
   * @private
   */

  /**
   * Get routing table instance (for admin API access)
   * @returns RoutingTable instance
   */
  get routingTable(): RoutingTable {
    return this._routingTable;
  }

  /**
   * Get the route → upstream termination registry (issue #218).
   *
   * Exposed so callers can (a) bind `registry.resolveUpstream` as the
   * `upstreamResolver` for a #216 {@link HttpProxyHandler}, and (b) read the
   * full {@link RouteTermination} (price/chains/ilpAddress/settlementAddresses)
   * for the #217 greeting / #220 price-binding layers.
   *
   * @returns RouteTerminationRegistry instance
   */
  get routeTerminationRegistry(): RouteTerminationRegistry {
    return this._routeTerminationRegistry;
  }

  /**
   * Get BTP client manager instance (for admin API access)
   * @returns BTPClientManager instance
   */
  get btpClientManager(): BTPClientManager {
    return this._btpClientManager;
  }

  /**
   * Get the active TransportProvider (Epic 35 / Story 35.4).
   *
   * Returns `null` before `start()` completes successfully and once `stop()`
   * begins tearing down the provider. Callers MUST NOT invoke
   * `start()`/`stop()` on the returned provider -- lifecycle is managed
   * exclusively by ConnectorNode.
   *
   * @returns The active provider, or `null` when not running.
   */
  get transportProvider(): TransportProvider | null {
    // AC #11: only expose the provider when it is fully started AND not yet
    // torn down. During the in-flight `provider.start()` await and during any
    // part of stop()/rollback, this getter returns `null`.
    return this._transportProviderReady ? this._transportProvider : null;
  }

  /**
   * Get the cold-start bootstrap service (toon-meta#153), or `null` when
   * `bootstrap.enabled` is false or the node is stopped.
   *
   * The deliberate coupling surface for consumers of discovered relays
   * (self-announce targets, the future kind:10032 route-learning client):
   * read `getRelayUrls()` for the current verified list, or subscribe with
   * `onRelaysResolved()`. Callers MUST NOT invoke `start()`/`stop()` on the
   * returned service — lifecycle is managed exclusively by ConnectorNode.
   */
  get bootstrapService(): BootstrapService | null {
    return this._bootstrapService;
  }

  /**
   * Instantiate the TransportProvider. Only direct TCP is supported.
   *
   * `DirectTransportProvider` is given a synthesized `externalUrl` from
   * `btpServerPort` because `ConnectorConfig` has no `publicUrl` field. The
   * value is an internal placeholder; callers that consume `getExternalUrl()`
   * from a direct provider should treat `ws://localhost:...` as "unknown public
   * URL, do not advertise."
   *
   * @returns A not-yet-started TransportProvider.
   */
  private _createTransportProvider(_cfg: TransportConfig | undefined): TransportProvider {
    const externalUrl = `ws://localhost:${this._config.btpServerPort}`;
    this._logger.debug(
      { event: 'direct_transport_external_url_synthesized', externalUrl },
      'DirectTransportProvider externalUrl synthesized from btpServerPort (local placeholder)'
    );
    return new DirectTransportProvider(externalUrl);
  }

  /**
   * Get payment channel SDK instance (for admin API access)
   * @returns PaymentChannelSDK instance or null if not initialized
   */
  get paymentChannelSDK(): PaymentChannelSDK | null {
    return this._paymentChannelSDK;
  }

  /**
   * Get the shared ChainProviderRegistry built during settlement bootstrap.
   *
   * Read-only observability surface (issue #86): callers and integration tests
   * can inspect which chain providers (evm:*, solana:*, mina:*) were registered
   * after `start()`. Returns `null` when the settlement stack is disabled (no
   * settlement-capable chainProviders configured).
   *
   * @returns The ChainProviderRegistry, or null if settlement is disabled
   */
  get chainRegistry(): ChainProviderRegistry | null {
    return this._chainRegistry;
  }

  /**
   * Get channel manager instance (for admin API access)
   * @returns ChannelManager instance or null if not initialized
   */
  get channelManager(): ChannelManager | null {
    return this._channelManager;
  }

  /**
   * Get account manager instance (for admin API access)
   * @returns AccountManager instance or null if not initialized
   */
  get accountManager(): AccountManager | null {
    return this._accountManager;
  }

  /**
   * Get PaymentChannelSDK for a specific chain ID.
   * Used for multi-chain settlement when peers settle on different chains.
   *
   * @param chainId - EVM chain ID (e.g., 8453 for Base, 42161 for Arbitrum)
   * @returns PaymentChannelSDK for the chain, or null if not initialized
   */
  getPaymentChannelSDKForChain(chainId: number): PaymentChannelSDK | null {
    return this._chainSDKs.get(chainId) ?? null;
  }

  /**
   * Creates an AccountManager backed by InMemoryLedgerClient when TigerBeetle is unavailable.
   * Provides working balance tracking with snapshot persistence.
   * @returns AccountManager instance with in-memory ledger backend
   * @private
   */
  private async _createInMemoryAccountManager(): Promise<AccountManager> {
    const evmProvider = this._config.chainProviders?.find((p) => p.chainType === 'evm') as
      | (EVMProviderConfig & { chainId: string })
      | undefined;
    const snapshotPath =
      evmProvider?.settlementOptions?.ledgerSnapshotPath ?? './data/ledger-snapshot.json';
    const persistIntervalMs = evmProvider?.settlementOptions?.ledgerPersistIntervalMs ?? 30000;

    let inMemoryClient: InMemoryLedgerClient;

    try {
      // Create InMemoryLedgerClient with persistence config
      inMemoryClient = new InMemoryLedgerClient(
        {
          snapshotPath,
          persistIntervalMs,
        },
        this._logger
      );

      // Initialize (will restore from snapshot if it exists)
      await inMemoryClient.initialize();

      this._logger.info(
        {
          event: 'in_memory_ledger_initialized',
          snapshotPath,
          persistIntervalMs,
        },
        `Accounting backend: in-memory ledger (snapshot: ${snapshotPath})`
      );
    } catch (error) {
      // Snapshot restore failed (corrupt file, disk permission, etc.)
      // Retry with fresh in-memory client (no snapshot restore)
      const errorMessage = error instanceof Error ? error.message : String(error);
      this._logger.warn(
        {
          event: 'in_memory_ledger_snapshot_restore_failed',
          error: errorMessage,
          snapshotPath,
        },
        'Failed to restore from snapshot, starting with fresh in-memory ledger'
      );

      try {
        // Create fresh client with a unique path to skip snapshot restore
        inMemoryClient = new InMemoryLedgerClient(
          {
            snapshotPath: `${snapshotPath}.fresh-${Date.now()}`,
            persistIntervalMs,
          },
          this._logger
        );

        await inMemoryClient.initialize();

        this._logger.info(
          {
            event: 'in_memory_ledger_fresh_start',
            snapshotPath,
          },
          'In-memory ledger started with empty state'
        );
      } catch (freshInitError) {
        // Even fresh initialization failed - this should be impossible
        // Re-throw to let outer settlement block catch handle it
        const freshErrorMessage =
          freshInitError instanceof Error ? freshInitError.message : String(freshInitError);
        this._logger.error(
          {
            event: 'in_memory_ledger_fresh_init_failed',
            error: freshErrorMessage,
          },
          'Critical: Fresh in-memory ledger initialization failed'
        );
        throw freshInitError;
      }
    }

    // Store reference for shutdown lifecycle
    this._inMemoryLedgerClient = inMemoryClient;

    const accountManager = new AccountManager(
      { nodeId: this._config.nodeId },
      inMemoryClient,
      this._logger
    );

    return accountManager;
  }

  private _updateHealthStatus(): void {
    // During startup phase (BTP server not listening yet)
    if (!this._btpServerStarted) {
      if (this._healthStatus !== 'starting') {
        this._logger.info(
          {
            event: 'health_status_changed',
            oldStatus: this._healthStatus,
            newStatus: 'starting',
            reason: 'BTP server not started',
          },
          'Health status changed'
        );
        this._healthStatus = 'starting';
      }
      return;
    }

    // If no peers configured, connector is healthy (standalone mode)
    const totalPeers = this._config.peers.length;
    if (totalPeers === 0) {
      if (this._healthStatus !== 'healthy') {
        this._logger.info(
          {
            event: 'health_status_changed',
            oldStatus: this._healthStatus,
            newStatus: 'healthy',
            reason: 'No peers configured (standalone mode)',
          },
          'Health status changed'
        );
        this._healthStatus = 'healthy';
      }
      return;
    }

    // Calculate connection percentage
    const peerStatus = this._btpClientManager.getPeerStatus();
    const connectedCount = Array.from(peerStatus.values()).filter(Boolean).length;
    const connectionPercentage = (connectedCount / totalPeers) * 100;

    // Determine new health status
    let newStatus: 'healthy' | 'unhealthy' | 'starting';
    let reason: string;

    if (connectionPercentage < 50) {
      newStatus = 'unhealthy';
      reason = `Only ${connectedCount}/${totalPeers} peers connected (<50%)`;
    } else {
      newStatus = 'healthy';
      reason = `${connectedCount}/${totalPeers} peers connected (≥50%)`;
    }

    // Log status changes
    if (this._healthStatus !== newStatus) {
      this._logger.info(
        { event: 'health_status_changed', oldStatus: this._healthStatus, newStatus, reason },
        'Health status changed'
      );
      this._healthStatus = newStatus;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Admin Operations — direct method API (Story 24.4)
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Register a new peer with BTP connection and optional routes/settlement config.
   * Equivalent to POST /admin/peers — same validation and behavior.
   *
   * @param config - Peer registration parameters
   * @returns PeerInfo with connection status
   * @throws ConnectorNotStartedError if connector has not been started
   * @throws Error('Missing or invalid peer id') if id is missing/empty
   * @throws Error if url format is invalid (must use the WebSocket or secure
   *   WebSocket scheme; plain scheme is permitted for trusted local networks
   *   and SOCKS5/ATOR overlay transport, where encryption is handled at the
   *   transport layer)
   * @throws Error('Invalid ILP address prefix: ...') if route prefix is invalid
   * @throws Error (from validateSettlementConfig) if settlement config is invalid
   */
  async registerPeer(config: PeerRegistrationRequest): Promise<PeerInfo> {
    if (!this._btpServerStarted) {
      throw new ConnectorNotStartedError(
        'Connector is not started. Call start() before registerPeer().'
      );
    }

    // Epic 38, Story 38.1: packet protocol selects the egress family. Validated
    // up front so URL validation below can branch (BTP requires ws://; ILP-HTTP
    // requires httpUrl).
    const peerProtocol = config.peerProtocol ?? 'btp';
    if (peerProtocol !== 'btp' && peerProtocol !== 'ilp-http') {
      throw new Error(`Invalid peerProtocol: must be 'btp' or 'ilp-http' (got '${peerProtocol}')`);
    }

    // Validate required fields
    if (!config.id || typeof config.id !== 'string') {
      throw new Error('Missing or invalid peer id');
    }
    if (
      config.authToken === undefined ||
      config.authToken === null ||
      typeof config.authToken !== 'string'
    ) {
      throw new Error('authToken must be a string (can be empty for no auth)');
    }

    if (peerProtocol === 'ilp-http') {
      // ILP-over-HTTP egress: require an http(s) endpoint; the BTP `url` is unused.
      if (!config.httpUrl || typeof config.httpUrl !== 'string') {
        throw new Error("peerProtocol 'ilp-http' requires httpUrl (http(s) endpoint)");
      }
      if (!/^https?:\/\/.+/.test(config.httpUrl)) {
        throw new Error('httpUrl must start with http:// or https://');
      }
    } else {
      if (!config.url || typeof config.url !== 'string') {
        throw new Error('Missing or invalid peer url');
      }
      // Validate URL format. Both the plain and TLS-wrapped WebSocket schemes are
      // accepted: the plain scheme is required for the ATOR overlay transport
      // (Epic 35), where .onion hosts are reached via SOCKS5 and the transport
      // layer provides encryption, and is also appropriate for trusted
      // local/internal networks. Production deployments over untrusted networks
      // should use the TLS-wrapped scheme.
      const PLAIN_WS_PREFIX = 'ws' + '://';
      const SECURE_WS_PREFIX = 'wss' + '://';
      if (!config.url.startsWith(PLAIN_WS_PREFIX) && !config.url.startsWith(SECURE_WS_PREFIX)) {
        throw new Error(`URL must start with ${PLAIN_WS_PREFIX} or ${SECURE_WS_PREFIX}`);
      }
    }

    // Validate per-peer transport. Only direct TCP is supported.
    if (config.transport !== undefined && config.transport !== 'direct') {
      throw new Error(`Invalid transport: must be 'direct' (got '${String(config.transport)}')`);
    }

    // Validate peer relation (issue #76). Error string is byte-identical to the
    // POST /admin/peers handler for cross-surface parity (see CLAUDE.md AG3).
    if (
      config.relation !== undefined &&
      config.relation !== 'parent' &&
      config.relation !== 'peer' &&
      config.relation !== 'child'
    ) {
      throw new Error(
        `Invalid relation: must be 'parent', 'peer', or 'child' (got '${config.relation}')`
      );
    }

    // Validate routes if provided
    if (config.routes) {
      for (const route of config.routes) {
        if (!route.prefix || typeof route.prefix !== 'string') {
          throw new Error('Invalid route: missing prefix');
        }
        if (!isValidILPAddress(route.prefix)) {
          throw new Error(`Invalid ILP address prefix: ${route.prefix}`);
        }
      }
    }

    // Validate settlement config if provided
    if (config.settlement) {
      const settlementError = validateSettlementConfig(config.settlement);
      if (settlementError) {
        throw new Error(settlementError);
      }
    }

    // Funded-peering admission (toon-meta#153, discovered-vs-peered): a
    // settlement block on a registration is the intent to FUND a channel to
    // this peer. peeringPolicy.maxFundedChannels bounds how many such funded
    // channels may exist at once — discovery/routing-through stays free and
    // unbounded. Checked BEFORE any mutation so a rejected registration
    // leaves no partial state.
    if (config.settlement) {
      const capError = this._checkFundedChannelCap(config.id);
      if (capError) {
        throw new Error(capError);
      }
    }

    // Config-declared child binding (toon-meta#153): when this peer id is
    // bound as a `children[].peerId`, its route `<apex>.<name>` was already
    // expanded at config load with an admission contract of relation 'child'.
    // Reject a contradictory relation at runtime registration, and skip the
    // auto-derived `<self>.<peerId>` route (the expanded binding already
    // routes to this peer).
    const childBinding = this._config.children?.find((c) => c.peerId === config.id);
    if (childBinding && config.relation !== undefined && config.relation !== 'child') {
      throw new Error(
        `Peer '${config.id}' is bound as child '${childBinding.name}' in config; relation must be 'child' (got '${config.relation}')`
      );
    }

    // Relation ↔ route admission validation + child auto-route (Phase 2).
    // The connector's self-prefixes are the routes that terminate locally
    // (plus the explicit apex, toon-meta#153); when none exist the validator
    // no-ops, so this never breaks routing-only nodes.
    // A `child` registered without an explicit route gets `<self>.<peerId>`
    // derived, collapsing the old two-step (register peer, then add route) and
    // closing the mis-tagged-child F06/T00 trap before any packet flows.
    const localPrefixes = this._selfPrefixesWithApex();
    let effectiveRoutes = config.routes;
    if ((!effectiveRoutes || effectiveRoutes.length === 0) && !childBinding) {
      const autoRoute = deriveDefaultChildRoute(config.relation, localPrefixes, config.id);
      if (autoRoute) {
        effectiveRoutes = [autoRoute];
      }
    }
    if (effectiveRoutes && effectiveRoutes.length > 0) {
      const relationValidation = validateRelationRoute(
        config.relation,
        localPrefixes,
        effectiveRoutes.map((r) => r.prefix)
      );
      if (!relationValidation.ok) {
        throw new Error(relationValidation.error);
      }
    }

    // Check if peer already exists (idempotent re-registration). Epic 38: an
    // 'ilp-http' peer lives in the HTTP egress manager, not the BTP client map.
    const existingPeers =
      peerProtocol === 'ilp-http'
        ? this._httpPeerClientManager.getPeerIds()
        : this._btpClientManager.getPeerIds();
    const isUpdate = existingPeers.includes(config.id);

    // Only add the peer on initial registration
    if (!isUpdate) {
      if (peerProtocol === 'ilp-http') {
        const httpPeer: HttpPeer = {
          id: config.id,
          httpUrl: config.httpUrl!,
          httpPath: config.httpPath,
          authToken: config.authToken,
          httpTimeoutMs: config.httpTimeoutMs,
        };
        await this._httpPeerClientManager.addPeer(httpPeer);
        this._ilpMetrics.registerPeer(config.id);
        this._logger.info(
          { event: 'peer_registered', peerId: config.id, peerProtocol, httpUrl: config.httpUrl },
          `Registered ILP-over-HTTP peer: ${config.id}`
        );
      } else {
        const peer: Peer = {
          id: config.id,
          url: config.url,
          authToken: config.authToken,
          connected: false,
          lastSeen: new Date(),
          transport: config.transport,
        };
        await this._btpClientManager.addPeer(peer);
        // Discovered-vs-peered (toon-meta#153): remember the runtime peer's
        // BTP url so the discovered registry's endpoint-fallback funded
        // matching also covers peers registered after boot.
        this._runtimePeerUrls.set(config.id, config.url);
        // Story 37.2/37.3: prime metrics labels so runtime-added peers appear in both
        // the Prometheus scrape (with zero counters) and /admin/metrics.json before
        // their first packet.
        this._ilpMetrics.registerPeer(config.id);
        this._logger.info(
          {
            event: 'peer_registered',
            peerId: config.id,
            url: config.url,
            // `null` when inheriting the connector default — see addPeer for rationale.
            transport: config.transport ?? null,
          },
          `Registered peer: ${config.id}`
        );
      }
    } else {
      this._logger.info(
        {
          event: 'peer_reregistered',
          peerId: config.id,
          peerProtocol,
          transport:
            peerProtocol === 'ilp-http'
              ? null
              : (this._btpClientManager.getPeerTransport(config.id) ?? null),
        },
        `Re-registering peer: ${config.id}`
      );
    }

    // Propagate the peer's packet protocol to the forwarding seam (Epic 38).
    // Applied on both fresh and re-registration.
    this._packetHandler.setPeerProtocol(config.id, peerProtocol);

    // Add routes if provided (explicit or auto-derived for a child peer)
    if (effectiveRoutes) {
      for (const route of effectiveRoutes) {
        this._routingTable.addRoute(route.prefix as ILPAddress, config.id, route.priority ?? 0);
        this._logger.info(
          { event: 'route_added', prefix: route.prefix, nextHop: config.id },
          `Added route: ${route.prefix} -> ${config.id}`
        );
      }
    }

    // Propagate the peer's ILP relationship to the forwarding path (issue #76).
    // Defaults to 'peer' so an omitted relation preserves the legacy
    // claim-on-every-forward behavior. Applied on both fresh and
    // re-registration so an operator can flip a peer's relation via re-register.
    this._packetHandler.setPeerRelation(config.id, config.relation ?? 'peer');

    // Create/merge settlement config
    if (config.settlement) {
      this._applySettlementConfig(config.id, config.settlement, effectiveRoutes, isUpdate);
    }

    // Write-through to the persistent registry so this runtime registration
    // (and its routes) is replayed on the next boot. Peers registered via this
    // path are always runtime additions (static-config peers are wired directly
    // in start()), so they carry source='runtime'.
    // (Routes are persisted by the RoutingTable write-through; here we persist
    // only the peer record, which carries relation + settlement that the
    // routing table does not see.)
    this._registryStore?.savePeer({
      id: config.id,
      url: config.url,
      authToken: config.authToken,
      relation: config.relation,
      transport: config.transport,
      settlementJson: config.settlement ? JSON.stringify(config.settlement) : undefined,
      source: 'runtime',
    });

    // Build PeerInfo response
    const routes = this._routingTable.getAllRoutes();
    const peerRoutes = routes.filter((r) => r.nextHop === config.id);
    // Epic 38: an 'ilp-http' peer is "connected" iff registered with the HTTP
    // egress (HTTP is connectionless — reachability is only known at send time).
    const connected =
      peerProtocol === 'ilp-http'
        ? this._httpPeerClientManager.isConnected(config.id)
        : this._btpClientManager.isConnected(config.id);

    const peerInfo: PeerInfo = {
      id: config.id,
      connected,
      ilpAddresses: peerRoutes.map((r) => r.prefix),
      routeCount: peerRoutes.length,
      // Fresh registration: echo the requested transport (the BTPClient may
      // not be fully wired at this moment). Re-registration cannot change a
      // peer's live transport (Decision 7), so the response surfaces the
      // ORIGINAL live transport read from the existing client, NOT the
      // requested value (mirrors the admin POST re-reg semantics in F10).
      transport: isUpdate ? this._btpClientManager.getPeerTransport(config.id) : config.transport,
      // Echo the effective relation (issue #76). `config.relation` is undefined
      // when the caller omitted it; the forwarding path treats that as 'peer'.
      relation: config.relation,
    };

    const peerConfig = this._settlementPeers.get(config.id);
    if (peerConfig) {
      peerInfo.settlement = {
        preference: peerConfig.settlementPreference,
        evmAddress: peerConfig.evmAddress,
        tokenAddress: peerConfig.tokenAddress,
        chainId: peerConfig.chainId,
      };
    }

    return peerInfo;
  }

  /**
   * Remove a peer, disconnect BTP connection, and optionally remove associated routes.
   * Equivalent to DELETE /admin/peers/:peerId — same validation and behavior.
   *
   * @param peerId - Peer identifier to remove
   * @param removeRoutes - Whether to remove routes associated with this peer (default: true)
   * @returns RemovePeerResult with peerId and list of removed route prefixes
   * @throws ConnectorNotStartedError if connector has not been started
   * @throws Error('Peer not found: ...') if peer does not exist
   */
  async removePeer(peerId: string, removeRoutes: boolean = true): Promise<RemovePeerResult> {
    if (!this._btpServerStarted) {
      throw new ConnectorNotStartedError(
        'Connector is not started. Call start() before removePeer().'
      );
    }

    // Check peer exists
    const existingPeers = this._btpClientManager.getPeerIds();
    if (!existingPeers.includes(peerId)) {
      throw new Error(`Peer not found: ${peerId}`);
    }

    // Remove BTP peer
    await this._btpClientManager.removePeer(peerId);
    // Discovered-vs-peered (toon-meta#153): removing a peer frees its funded
    // slot (the settlement config is deleted below) and drops its runtime-url
    // record from the discovered registry's funded-matching set.
    this._runtimePeerUrls.delete(peerId);
    // Story 37.2/37.3: drop peer from the metrics "known peers" set so it stops
    // being surfaced as idle in Prometheus scrapes. Historical counter totals
    // are preserved internally but no longer exposed via /admin/metrics.json
    // (which uses btpClientManager.getPeerIds() as the authoritative set).
    this._ilpMetrics.unregisterPeer(peerId);
    this._logger.info({ event: 'peer_removed', peerId }, `Removed peer: ${peerId}`);

    // Remove settlement config
    if (this._settlementPeers.delete(peerId)) {
      this._logger.info(
        { event: 'settlement_config_removed', peerId },
        `Removed settlement config for peer: ${peerId}`
      );
    }

    // Remove routes if requested
    const removedRoutes: string[] = [];
    if (removeRoutes) {
      const routes = this._routingTable.getAllRoutes();
      for (const route of routes) {
        if (route.nextHop === peerId) {
          this._routingTable.removeRoute(route.prefix);
          removedRoutes.push(route.prefix);
          this._logger.info(
            { event: 'route_removed', prefix: route.prefix },
            `Removed route: ${route.prefix}`
          );
        }
      }
    }

    // Write-through: drop the peer from the persistent registry so it is not
    // replayed on the next boot. (Removed routes are dropped by the RoutingTable
    // write-through as removeRoute runs above.)
    this._registryStore?.deletePeer(peerId);

    return { peerId, removedRoutes };
  }

  /**
   * List all peers with connection status and routing info.
   * Equivalent to GET /admin/peers — same response shape.
   *
   * @returns Array of PeerInfo objects
   */
  listPeers(): PeerInfo[] {
    const peerIds = this._btpClientManager.getPeerIds();
    const peerStatus = this._btpClientManager.getPeerStatus();
    const routes = this._routingTable.getAllRoutes();

    return peerIds.map((peerId) => {
      const peerRoutes = routes.filter((r) => r.nextHop === peerId);
      const peerInfo: PeerInfo = {
        id: peerId,
        connected: peerStatus.get(peerId) ?? false,
        ilpAddresses: peerRoutes.map((r) => r.prefix),
        routeCount: peerRoutes.length,
        // Per-peer transport override; `undefined` when the peer inherits
        // the connector-level default. Mirrors GET /admin/peers so SDK
        // consumers (connector SDK, test fixtures, future BMad agents) keep
        // parity with the admin API.
        transport: this._btpClientManager.getPeerTransport(peerId),
      };

      const peerConfig = this._settlementPeers.get(peerId);
      if (peerConfig) {
        peerInfo.settlement = {
          preference: peerConfig.settlementPreference,
          evmAddress: peerConfig.evmAddress,
          tokenAddress: peerConfig.tokenAddress,
          chainId: peerConfig.chainId,
        };
      }

      return peerInfo;
    });
  }

  /**
   * List the DISCOVERED node set (toon-meta#153, discovered-vs-peered):
   * every node known from kind:10032 relay ingest, each flagged `funded`
   * when a live registered peer currently maps to it. Equivalent to
   * GET /admin/discovered-nodes.
   *
   * Discovered-but-unfunded nodes are reachable through learned multi-hop
   * routes at zero capital cost; an operator promotes one to a FUNDED peer
   * via the existing {@link registerPeer} / POST /admin/peers (the entry
   * supplies `btpEndpoint` for `url` plus settlement hints), subject to
   * `peeringPolicy.maxFundedChannels`.
   *
   * @returns The discovered nodes (empty when route learning is disabled —
   *   there is no ingest feed without it).
   */
  getDiscoveredNodes(): DiscoveredNode[] {
    return this._discoveredNodeRegistry ? this._discoveredNodeRegistry.list() : [];
  }

  /**
   * Funded-matching source for the discovered-node registry: the LIVE
   * registered peers (BTP + ILP-HTTP), each carrying the identifiers a
   * discovered entry can be matched on — the x-only Nostr pubkey derived from
   * the configured `nip59PublicKey`, and the BTP `url` (from static config,
   * or the runtime-registration record for peers added after boot).
   */
  private _getFundedPeerRefs(): FundedPeerRef[] {
    const refsById = new Map<string, FundedPeerRef>();
    for (const peerId of this._btpClientManager.getPeerIds()) {
      refsById.set(peerId, { peerId });
    }
    for (const peerId of this._httpPeerClientManager.getPeerIds()) {
      if (!refsById.has(peerId)) refsById.set(peerId, { peerId });
    }
    for (const peer of this._config.peers) {
      const ref = refsById.get(peer.id);
      if (!ref) continue;
      const nostrPubkey = nip59KeyToNostrPubkey(peer.nip59PublicKey);
      if (nostrPubkey) ref.nostrPubkey = nostrPubkey;
      if (peer.url) ref.btpUrl = peer.url;
    }
    for (const [peerId, url] of this._runtimePeerUrls) {
      const ref = refsById.get(peerId);
      if (ref && ref.btpUrl === undefined) ref.btpUrl = url;
    }
    return Array.from(refsById.values());
  }

  /**
   * Count the FUNDED channels currently held (toon-meta#153): registered
   * peers (live in the BTP / ILP-HTTP client managers) that carry runtime
   * settlement config — i.e. an entry in `_settlementPeers`, created by
   * `registerPeer`/POST /admin/peers settlement blocks (including those
   * replayed from the persistent registry at boot). Route-only peers do not
   * count. See {@link PeeringPolicyConfig.maxFundedChannels} for the exact
   * counting contract.
   */
  private _countFundedChannels(): number {
    const liveIds = new Set([
      ...this._btpClientManager.getPeerIds(),
      ...this._httpPeerClientManager.getPeerIds(),
    ]);
    let count = 0;
    for (const peerId of this._settlementPeers.keys()) {
      if (liveIds.has(peerId)) count++;
    }
    return count;
  }

  /**
   * Enforce `peeringPolicy.maxFundedChannels` for a registration that carries
   * a settlement block. Returns the rejection message, or `null` when
   * admission is allowed: no cap configured, the peer is ALREADY funded
   * (re-registration merges config without consuming a new slot), or the cap
   * has headroom. Shared verbatim by `registerPeer` and the mirrored
   * POST /admin/peers handler for cross-surface error parity.
   */
  private _checkFundedChannelCap(peerId: string): string | null {
    const maxFundedChannels = this._config.peeringPolicy?.maxFundedChannels;
    if (maxFundedChannels === undefined) return null;
    if (this._settlementPeers.has(peerId)) return null;
    const funded = this._countFundedChannels();
    if (funded < maxFundedChannels) return null;
    return (
      `Funded-channel cap reached: ${funded}/${maxFundedChannels} funded channels in use ` +
      `(peeringPolicy.maxFundedChannels). Registering '${peerId}' with settlement config would ` +
      `open another funded channel — remove a funded peer first (DELETE /admin/peers/:peerId) ` +
      `or raise the cap. Discovered nodes stay reachable through learned multi-hop routes ` +
      `without a funded channel.`
    );
  }

  /**
   * Get balance for a specific peer from TigerBeetle.
   * Equivalent to GET /admin/balances/:peerId — same response shape.
   *
   * @param peerId - Peer identifier
   * @param tokenId - Token identifier (defaults to the resolved on-chain symbol, e.g. 'M2M')
   * @returns PeerAccountBalance with debit/credit/net balances
   * @throws Error if account management is not enabled
   */
  async getBalance(
    peerId: string,
    tokenId: string = this._defaultSettlementTokenId
  ): Promise<PeerAccountBalance> {
    if (!this._accountManager) {
      throw new Error('Account management not enabled');
    }

    const balance = await this._accountManager.getAccountBalance(peerId, tokenId);
    return {
      peerId,
      balances: [
        {
          tokenId,
          debitBalance: balance.debitBalance.toString(),
          creditBalance: balance.creditBalance.toString(),
          netBalance: balance.netBalance.toString(),
        },
      ],
    };
  }

  /**
   * List all routes in the routing table.
   * Equivalent to GET /admin/routes — same response shape.
   *
   * @returns Array of RouteInfo objects
   */
  listRoutes(): RouteInfo[] {
    const routes = this._routingTable.getAllRoutes();
    return routes.map((r) => ({
      prefix: r.prefix,
      nextHop: r.nextHop,
      priority: r.priority ?? 0,
    }));
  }

  /**
   * The connector's self-prefixes for relation ↔ route admission checks: the
   * locally-terminating routes' prefixes plus the explicit config `apex`
   * (toon-meta#153) when set — so child admission works even when the apex has
   * no local route of its own.
   */
  private _selfPrefixesWithApex(): string[] {
    const localPrefixes = deriveLocalPrefixes(
      this._routingTable.getAllRoutes(),
      this._config.nodeId
    );
    const apex = this._config.apex;
    if (apex !== undefined && !localPrefixes.includes(apex)) {
      localPrefixes.push(apex);
    }
    return localPrefixes;
  }

  /**
   * Add a static route to the routing table.
   * Equivalent to POST /admin/routes — same validation.
   *
   * @param route - Route configuration (prefix, nextHop, priority)
   * @throws Error('Invalid ILP address prefix: ...') if prefix is not a valid ILP address
   * @throws Error('Missing or invalid nextHop') if nextHop is empty
   */
  addRoute(route: RouteInfo): void {
    // Validate prefix
    if (!isValidILPAddress(route.prefix)) {
      throw new Error(`Invalid ILP address prefix: ${route.prefix}`);
    }

    // Validate nextHop
    if (!route.nextHop || typeof route.nextHop !== 'string') {
      throw new Error('Missing or invalid nextHop');
    }

    // Warn if nextHop peer doesn't exist (but don't block)
    const existingPeers = this._btpClientManager.getPeerIds();
    if (!existingPeers.includes(route.nextHop)) {
      this._logger.warn(
        { event: 'route_nextHop_unknown', prefix: route.prefix, nextHop: route.nextHop },
        `Adding route with unknown nextHop peer: ${route.nextHop}`
      );
    }

    // Relation ↔ route admission validation against the nextHop peer's relation
    // (Phase 2). Unknown/local nextHops resolve to undefined → treated as 'peer'
    // (no constraint), so this only rejects an unambiguously child/parent-shaped
    // mismatch and never blocks routing-only or local routes.
    const nextHopRelation = this._packetHandler.getPeerRelation(route.nextHop);
    const localPrefixes = this._selfPrefixesWithApex();
    const relationValidation = validateRelationRoute(nextHopRelation, localPrefixes, [
      route.prefix,
    ]);
    if (!relationValidation.ok) {
      throw new Error(relationValidation.error);
    }

    // Persisted via the RoutingTable write-through.
    this._routingTable.addRoute(route.prefix as ILPAddress, route.nextHop, route.priority ?? 0);

    this._logger.info(
      { event: 'route_added', prefix: route.prefix, nextHop: route.nextHop },
      `Added route: ${route.prefix} -> ${route.nextHop}`
    );
  }

  /**
   * Remove a route from the routing table by prefix.
   * Equivalent to DELETE /admin/routes/:prefix — same validation.
   *
   * @param prefix - ILP address prefix of the route to remove
   * @throws Error('Route not found: ...') if no route with the given prefix exists
   */
  removeRoute(prefix: string): void {
    const routes = this._routingTable.getAllRoutes();
    const exists = routes.some((r) => r.prefix === prefix);
    if (!exists) {
      throw new Error(`Route not found: ${prefix}`);
    }

    // Persisted via the RoutingTable write-through.
    this._routingTable.removeRoute(prefix as ILPAddress);
    this._logger.info({ event: 'route_removed', prefix }, `Removed route: ${prefix}`);
  }

  /**
   * Open the persistent peer/route registry and reconcile it with the running
   * state. Runs once during start(), after the BTP server is up and the static
   * config peers have been wired.
   *
   * Reconciliation model (additive over static config):
   *  1. Mirror the static-config baseline into the store (source='config') so
   *     the declarative desired-state surface sees a complete picture. Config
   *     entries are already applied in-memory from YAML, so this is just a
   *     refresh of the mirror — it never re-applies them.
   *  2. Replay every `source='runtime'` peer/route that isn't already present.
   *     These are the admin-API additions from a previous run; without this they
   *     would be lost on restart (the "re-POST the relay route" RUNBOOK step).
   *
   * Best-effort: if `libsql` is unavailable the store stays null and the
   * connector keeps today's in-memory-only behavior.
   */
  private async _openRegistryStore(): Promise<void> {
    try {
      // libsql is the better-sqlite3-compatible drop-in used by the claim
      // stores (N-API prebuilts; no native toolchain). Mirror that wiring.
      const LibsqlModule = await requireOptional<{
        default: new (path: string) => import('better-sqlite3').Database;
      }>('libsql', 'peer/route registry persistence');
      const LibsqlDatabase = LibsqlModule.default;

      // better-sqlite3/libsql do not create parent dirs; ensure ./data exists
      // (the claim stores assume it, but registry boot must not depend on that).
      await fsPromises.mkdir('./data', { recursive: true });
      const registryDbPath = `./data/registry-${this._config.nodeId}.db`;
      const registryDb = new LibsqlDatabase(registryDbPath);
      initializeRegistrySchema(registryDb);
      this._registryStore = new RegistryStore(registryDb, this._logger);
      // Route persistence is write-through at the RoutingTable layer so it
      // covers both the programmatic API and the admin HTTP surface. The
      // constructor already loaded the static-config routes before this point,
      // so only runtime routes will reach the sink.
      this._routingTable.setPersistence(this._registryStore);
    } catch (error) {
      this._logger.warn(
        {
          event: 'registry_persistence_disabled',
          error: error instanceof Error ? error.message : String(error),
        },
        'Peer/route registry persistence unavailable; runtime peers/routes will not survive restart'
      );
      this._registryStore = null;
    }
  }

  /**
   * Reconcile the running state with the persistent registry: refresh the
   * static-config mirror and replay runtime-added peers/routes from a previous
   * run. Runs once during start(), after the BTP server is up and the static
   * config peers have been wired. No-op when persistence is unavailable.
   */
  private async _reconcileRegistry(): Promise<void> {
    if (!this._registryStore) {
      return;
    }
    const { peers, routes } = this._registryStore.loadAll();

    // 1. Refresh the static-config mirror (source='config').
    for (const peer of this._config.peers) {
      this._registryStore.savePeer({
        id: peer.id,
        url: peer.url,
        authToken: peer.authToken,
        relation: peer.relation,
        transport: peer.transport,
        source: 'config',
      });
    }
    for (const route of this._config.routes) {
      // Issue #218: persist any per-route termination config from static YAML so
      // it is durably mirrored (the in-memory registry is already seeded from
      // `_config.routes` at construction).
      const termination = toRouteTermination(route);
      this._registryStore.saveRoute({
        prefix: route.prefix,
        nextHop: route.nextHop,
        priority: route.priority ?? 0,
        source: 'config',
        terminationJson: termination ? JSON.stringify(termination) : undefined,
      });
    }

    // 2. Replay runtime peers, then runtime routes (peers first so a route's
    //    nextHop peer exists). Each replay is isolated so one bad row (e.g. a
    //    transport no longer supported by the current config) can't abort boot.
    const existingPeerIds = new Set(this._btpClientManager.getPeerIds());
    let replayedPeers = 0;
    for (const peer of peers) {
      if (peer.source !== 'runtime' || existingPeerIds.has(peer.id)) {
        continue;
      }
      try {
        await this.registerPeer({
          id: peer.id,
          url: peer.url,
          authToken: peer.authToken,
          relation: peer.relation as PeerRegistrationRequest['relation'],
          transport: peer.transport as PeerRegistrationRequest['transport'],
          settlement: peer.settlementJson
            ? (JSON.parse(peer.settlementJson) as AdminSettlementConfig)
            : undefined,
        });
        replayedPeers++;
      } catch (error) {
        this._logger.warn(
          {
            event: 'registry_peer_replay_failed',
            peerId: peer.id,
            error: error instanceof Error ? error.message : String(error),
          },
          `Failed to replay persisted peer: ${peer.id}`
        );
      }
    }

    const existingPrefixes = new Set(this._routingTable.getAllRoutes().map((r) => r.prefix));
    let replayedRoutes = 0;
    for (const route of routes) {
      if (route.source !== 'runtime' || existingPrefixes.has(route.prefix)) {
        continue;
      }
      try {
        this.addRoute({
          prefix: route.prefix,
          nextHop: route.nextHop,
          priority: route.priority,
        });
        // Issue #218: restore the route's local-termination config into the
        // in-memory registry so #216's proxy handler resolves it post-restart.
        if (route.terminationJson) {
          try {
            this._routeTerminationRegistry.set(
              route.prefix,
              JSON.parse(route.terminationJson) as RouteTermination
            );
          } catch (parseError) {
            this._logger.warn(
              {
                event: 'registry_route_termination_replay_failed',
                prefix: route.prefix,
                error: parseError instanceof Error ? parseError.message : String(parseError),
              },
              `Failed to restore persisted route termination: ${route.prefix}`
            );
          }
        }
        replayedRoutes++;
      } catch (error) {
        this._logger.warn(
          {
            event: 'registry_route_replay_failed',
            prefix: route.prefix,
            error: error instanceof Error ? error.message : String(error),
          },
          `Failed to replay persisted route: ${route.prefix}`
        );
      }
    }

    if (replayedPeers > 0 || replayedRoutes > 0) {
      this._logger.info(
        { event: 'registry_reconciled', replayedPeers, replayedRoutes },
        `Replayed ${replayedPeers} peer(s) and ${replayedRoutes} route(s) from the persistent registry`
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Payment Channel Operations — direct method API
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Open a payment channel for a registered peer.
   * Equivalent to POST /admin/channels (EVM path) — same validation and behavior.
   *
   * @param params - Channel open parameters
   * @returns Object with channelId and normalized status
   * @throws ConnectorNotStartedError if connector has not been started
   * @throws Error('Settlement infrastructure not enabled') if channelManager is null
   * @throws Error('Peer ... must be registered before opening channels') if peer not found
   * @throws Error('Channel already exists for peer ...') if active channel exists for peer+token
   */
  async openChannel(params: {
    peerId: string;
    chain: string;
    token?: string;
    tokenNetwork?: string;
    peerAddress: string;
    initialDeposit?: string;
    settlementTimeout?: number;
  }): Promise<{ channelId: string; status: string }> {
    if (!this._btpServerStarted) {
      throw new ConnectorNotStartedError(
        'Connector is not started. Call start() before openChannel().'
      );
    }

    if (!this._channelManager) {
      throw new Error(
        'No EVM chain provider configured -- openChannel requires a chainProviders entry with chainType: "evm"'
      );
    }

    // Validate peer exists
    const existingPeers = this._btpClientManager.getPeerIds();
    if (!existingPeers.includes(params.peerId)) {
      throw new Error(`Peer '${params.peerId}' must be registered before opening channels`);
    }

    const tokenId = params.token ?? 'AGENT';

    // Resolve peer address: explicit param, then settlementPeers fallback
    const peerAddress = params.peerAddress || this._settlementPeers.get(params.peerId)?.evmAddress;
    if (!peerAddress) {
      throw new Error('Peer EVM address must be provided in params or peer registration');
    }

    // Check for existing active channel
    const existing = this._channelManager.getChannelForPeer(params.peerId, tokenId);
    if (existing && existing.status !== 'closed') {
      throw new Error(
        `Channel already exists for peer ${params.peerId} with token ${tokenId} on chain ${params.chain}`
      );
    }

    const channelId = await this._channelManager.ensureChannelExists(params.peerId, tokenId, {
      initialDeposit: BigInt(params.initialDeposit ?? '0'),
      settlementTimeout: params.settlementTimeout,
      chain: params.chain,
      peerAddress,
    });

    const metadata = this._channelManager.getChannelById(channelId);
    const status = metadata ? normalizeChannelStatus(metadata.status, this._logger) : 'opening';

    this._logger.info(
      { event: 'channel_opened', peerId: params.peerId, chain: params.chain, channelId },
      'Channel opened via direct API'
    );

    return { channelId, status };
  }

  /**
   * Get the state of a payment channel by ID.
   * Returns metadata-based state (no on-chain query) — sufficient for embedded mode polling.
   *
   * @param channelId - The channel identifier
   * @returns Object with channelId, normalized status, and chain
   * @throws ConnectorNotStartedError if connector has not been started
   * @throws Error('Settlement infrastructure not enabled') if channelManager is null
   * @throws Error('Channel not found: ...') if channel does not exist
   */
  async getChannelState(channelId: string): Promise<{
    channelId: string;
    status: 'opening' | 'open' | 'closed' | 'settled';
    chain: string;
  }> {
    if (!this._btpServerStarted) {
      throw new ConnectorNotStartedError(
        'Connector is not started. Call start() before getChannelState().'
      );
    }

    if (!this._channelManager) {
      throw new Error(
        'No EVM chain provider configured -- openChannel requires a chainProviders entry with chainType: "evm"'
      );
    }

    const metadata = this._channelManager.getChannelById(channelId);
    if (!metadata) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    return {
      channelId: metadata.channelId,
      status: normalizeChannelStatus(metadata.status, this._logger) as
        | 'opening'
        | 'open'
        | 'closed'
        | 'settled',
      chain: metadata.chain,
    };
  }

  /**
   * Apply settlement configuration for a peer.
   * Converts AdminSettlementConfig to SettlementPeerConfig and stores/merges.
   * @private
   */
  private _applySettlementConfig(
    peerId: string,
    s: AdminSettlementConfig,
    routes: Array<{ prefix: string; priority?: number }> | undefined,
    isUpdate: boolean
  ): void {
    const ilpAddress = routes && routes.length > 0 ? routes[0]!.prefix : '';

    // Build settlementTokens
    const settlementTokens: string[] = [];
    if (s.tokenAddress) {
      settlementTokens.push(s.tokenAddress);
    } else {
      if (s.evmAddress) settlementTokens.push('EVM');
    }

    const newConfig: SettlementPeerConfig = {
      peerId,
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
      const existingConfig = this._settlementPeers.get(peerId);
      if (existingConfig) {
        const mergedConfig: SettlementPeerConfig = { ...existingConfig };
        for (const [key, value] of Object.entries(newConfig)) {
          if (value !== undefined) {
            (mergedConfig as unknown as Record<string, unknown>)[key] = value;
          }
        }
        this._settlementPeers.set(peerId, mergedConfig);
      } else {
        this._settlementPeers.set(peerId, newConfig);
      }
      this._logger.info(
        { event: 'settlement_config_merged', peerId, preference: s.preference },
        `Merged settlement config for peer: ${peerId}`
      );
    } else {
      this._settlementPeers.set(peerId, newConfig);
      this._logger.info(
        { event: 'settlement_config_added', peerId, preference: s.preference },
        `Added settlement config for peer: ${peerId}`
      );
    }
  }

  /**
   * Get routing table entries
   * @returns Array of current routing table entries
   */
  getRoutingTable(): RoutingTableEntry[] {
    return this._routingTable.getAllRoutes();
  }
}
