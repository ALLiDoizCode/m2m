/**
 * ConnectorNode - Core ILP connector orchestrator
 * Manages all connector components and lifecycle
 */

import { promises as fsPromises } from 'fs';
import * as nodePath from 'path';
import { Logger } from '../utils/logger';
import { RoutingTable } from '../routing/routing-table';
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
  validateChainProviders,
} from '../config/types';
import {
  TransportProvider,
  DirectTransportProvider,
  SocksTransportProvider,
  ManagedAnonClient,
  createDefaultAnonFactory,
  type AnonFactoryOptions,
  type AnonSdkHandle,
} from '../transport';
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
} from '../config/config-loader';
import { HealthServer } from '../http/health-server';
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
import { KeyManager } from '../security/key-manager';
import { requireOptional } from '../utils/optional-require';
import { TigerBeetleClient } from '../settlement/tigerbeetle-client';
import { InMemoryLedgerClient } from '../settlement/in-memory-ledger-client';
import { PerPacketClaimService } from '../settlement/per-packet-claim-service';
import { ChainProviderRegistry } from '../settlement/provider/chain-provider-registry';
import { EVMPaymentChannelProvider } from '../settlement/provider/evm-payment-channel-provider';
import type { EVMProviderConfig } from '../settlement/provider/payment-channel-provider';
import {
  SENT_CLAIMS_TABLE_SCHEMA,
  SENT_CLAIMS_INDEXES,
} from '../settlement/claim-sender-db-schema';
import { InboundClaimValidator } from '../btp/inbound-claim-validator';
import { NIP59ClaimWrapper } from '../settlement/privacy/nip59-claim-wrapper';
import { hexToBytes } from '@noble/hashes/utils';
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
  private readonly _btpClientManager: BTPClientManager;
  private readonly _packetHandler: PacketHandler;
  private readonly _btpServer: BTPServer;
  private readonly _healthServer: HealthServer;
  private _adminServer: AdminServer | null = null;
  private _paymentChannelSDK: PaymentChannelSDK | null = null;
  private _chainSDKs: Map<number, PaymentChannelSDK> = new Map();
  private _channelManager: ChannelManager | null = null;
  private _accountManager: AccountManager | null = null;
  private _claimReceiver: ClaimReceiver | null = null;
  private _settlementMonitor: SettlementMonitor | null = null;
  private _settlementExecutor: SettlementExecutor | null = null;
  private _tigerBeetleClient: TigerBeetleClient | null = null;
  private _inMemoryLedgerClient: InMemoryLedgerClient | null = null;
  private readonly _settlementPeers: Map<string, SettlementPeerConfig> = new Map();
  private _healthStatus: 'healthy' | 'unhealthy' | 'starting' = 'starting';
  private readonly _ilpMetrics!: IlpMetricsRegistry;
  private readonly _startTime: Date = new Date();
  private _btpServerStarted: boolean = false;
  private _defaultSettlementTokenId: string = 'M2M';
  // Epic 35 / Story 35.4: active transport provider + cached health
  private _transportProvider: TransportProvider | null = null;
  // Story 38.1: reference to the constructed ManagedAnonClient (when the
  // transport is `socks5` with `managed: true`), used by the admin server to
  // serve `GET /admin/hs-hostname`. `null` for direct or non-managed transports.
  private _managedAnonClient: ManagedAnonClient | null = null;
  // `_transportProviderReady` gates the public `transportProvider` getter so it
  // returns `null` during the in-flight `provider.start()` await window
  // (AC #11: "during start() before await transportProvider.start() resolves →
  // null"). Flipped to `true` only AFTER a successful `await provider.start()`,
  // and flipped back to `false` at the start of stop()/rollback, before the
  // reference is nulled. This prevents exposing a half-initialized provider.
  private _transportProviderReady: boolean = false;
  private _transportType: 'direct' | 'socks5' | null = null;
  private _lastTransportHealthy: boolean = true;
  private _transportHealthInterval: NodeJS.Timeout | null = null;
  // Epic 35 / Story 35.6 T-35.6-INT-03: transport health-check interval (ms).
  // Default 30s matches Story 35.4 wiring. Optional constructor override lets
  // integration tests shrink the cadence to sub-second so the mid-session
  // proxy-down assertion fires in CI-acceptable time without reaching into
  // private state. This is the ONLY production-code seam Story 35.6 introduces.
  private readonly _transportHealthIntervalMs: number;

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
    opts?: { transportHealthIntervalMs?: number }
  ) {
    // Story 35.6: optional seam for integration tests. Default preserves
    // pre-35.6 behavior (30s). All existing callers (2-arg form) continue to
    // work unchanged — new arg is optional.
    this._transportHealthIntervalMs = opts?.transportHealthIntervalMs ?? 30000;
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

    // Initialize BTP client manager
    this._btpClientManager = new BTPClientManager(
      resolvedConfig.nodeId,
      logger.child({ component: 'BTPClientManager' })
    );
    // Story 35.4 + per-peer transport dispatch: wire an agent factory that
    // (a) honors `peer.transport` as a per-peer override of the connector
    // level `transport.type`, and (b) defaults to the connector-level
    // `_transportType` when the peer field is omitted. Before start() or
    // after stop(), `_transportProvider` and `_transportType` are both
    // null, in which case the effective transport coalesces to `'direct'`
    // and the factory returns undefined -- matching pre-Epic-35 default
    // WebSocket behavior.
    //
    // Defense-in-depth (AC-11): if a peer requests `'socks5'` but the
    // connector has no SOCKS5 provider wired (because validation was
    // bypassed by a test fixture or future code path), the closure throws
    // rather than silently dialing direct. The provisioning validators in
    // POST /admin/peers, ConnectorNode.registerPeer(), and
    // ConfigLoader.validatePeers() are the primary line of defense; this
    // is the runtime backstop. The throw is caught by BTPClient.connect()
    // and surfaced as a BTPConnectionError.
    this._btpClientManager.setAgentFactory((peer) => {
      const effective = peer.transport ?? this._transportType ?? 'direct';

      if (
        effective === 'socks5' &&
        (!this._transportProvider || this._transportType !== 'socks5')
      ) {
        this._logger.error(
          {
            event: 'btp_agent_factory_invariant_violation',
            peerId: peer.id,
            requestedTransport: 'socks5',
            connectorTransport: this._transportType,
          },
          'Peer requested SOCKS5 transport but connector has no SOCKS5 provider — refusing to fall through to direct dial'
        );
        throw new Error('SOCKS5 transport requested for peer but no SOCKS5 provider configured');
      }

      return effective === 'socks5' ? this._transportProvider!.createAgent(peer.url) : undefined;
    });

    // Initialize packet handler
    this._packetHandler = new PacketHandler(
      this._routingTable,
      this._btpClientManager,
      resolvedConfig.nodeId,
      logger.child({ component: 'PacketHandler' })
    );

    // Initialize BTP server
    this._btpServer = new BTPServer(logger.child({ component: 'BTPServer' }), this._packetHandler);

    // Link BTPServer to PacketHandler for bidirectional forwarding (resolves circular dependency)
    this._packetHandler.setBTPServer(this._btpServer);

    // Configure local delivery if enabled (forwards local packets to agent runtime)
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
   * - **embedded**: Connector runs in same process as business logic
   *   - Use `setPacketHandler()` or `setLocalDeliveryHandler()` for incoming packets
   *   - Use `node.sendPacket()` for outgoing packets
   *   - Admin API typically disabled
   *
   * - **standalone**: Connector runs as separate process/container
   *   - Incoming packets forwarded via HTTP to `/handle-packet` on external BLS
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
   * Embedded mode means the connector runs in the same process as business logic:
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
   * - Incoming packets forwarded via HTTP POST to `/handle-packet` on external BLS
   * - Outgoing packets sent via HTTP POST to `/admin/ilp/send` on connector admin API
   * - Admin API enabled for external control
   * - Local delivery enabled with `handlerUrl` pointing to external BLS
   *
   * @returns true if deployment mode is 'standalone', false otherwise
   *
   * @example
   * ```typescript
   * if (node.isStandalone()) {
   *   console.log('Connector running in standalone mode');
   *   console.log('Admin API:', node._config.adminApi?.port);
   *   console.log('BLS URL:', node._config.localDelivery?.handlerUrl);
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
   * @param params - Packet parameters (destination, amount, condition, expiry, data)
   * @returns ILP Fulfill or Reject packet
   * @throws ConnectorNotStartedError if connector has not been started
   */
  async sendPacket(params: SendPacketParams): Promise<ILPFulfillPacket | ILPRejectPacket> {
    if (!this._btpServerStarted) {
      throw new ConnectorNotStartedError();
    }

    const packet: ILPPreparePacket = {
      type: PacketType.PREPARE,
      destination: params.destination,
      amount: params.amount,
      expiresAt: params.expiresAt,
      data: params.data ?? Buffer.alloc(0),
    };

    this._logger.info(
      {
        event: 'send_packet',
        destination: params.destination,
        amount: params.amount.toString(),
        expiresAt: params.expiresAt.toISOString(),
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

      if (
        evmProviderConfig &&
        baseRpcUrl &&
        registryAddress &&
        m2mTokenAddress &&
        treasuryPrivateKey
      ) {
        try {
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
            registryAddress,
            this._logger
          );

          // Resolve on-chain token symbol for canonical tokenId
          try {
            const resolvedSymbol = await this._paymentChannelSDK.getTokenSymbol(m2mTokenAddress);
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
          const primaryChainId =
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
            const chainRegistryAddress = chain.config.registryAddress ?? registryAddress;
            const chainPrivateKey = chain.config.privateKey ?? treasuryPrivateKey;

            // Create per-chain KeyManager if different private key
            const chainKeyManager =
              chainPrivateKey !== treasuryPrivateKey
                ? new KeyManager(
                    { backend: 'env', nodeId: this._config.nodeId, evmPrivateKey: chainPrivateKey },
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

          // Build peer ID to EVM address mapping from config (with env var fallback)
          const peerIdToAddressMap = new Map<string, string>();
          for (const peer of this._config.peers) {
            if (peer.evmAddress) {
              peerIdToAddressMap.set(peer.id, peer.evmAddress);
              this._logger.debug(
                { peerId: peer.id, address: peer.evmAddress },
                'Loaded peer EVM address from config'
              );
            }
          }

          // Env var fallback for peers without evmAddress in config
          // Supports legacy PEER{N}_EVM_ADDRESS pattern (expanded to 10; will be removed in a future epic)
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

          // Build token address map using the resolved on-chain symbol
          const tokenAddressMap = new Map<string, string>();
          tokenAddressMap.set(this._defaultSettlementTokenId, m2mTokenAddress);
          tokenAddressMap.set(m2mTokenAddress, m2mTokenAddress); // Also map address to itself for direct lookups

          // Initialize ChannelManager with TigerBeetle accounting if configured
          const defaultSettlementTimeout =
            evmProviderConfig.settlementOptions?.settlementTimeoutSecs ?? 86400;
          const initialDepositMultiplier =
            evmProviderConfig.settlementOptions?.initialDepositMultiplier ?? 1;

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

          const settlementThreshold = BigInt(
            evmProviderConfig.settlementOptions?.threshold ?? '1000000'
          );

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

          // Create a shared ChainProviderRegistry wrapping the primary SDK
          // in an EVMPaymentChannelProvider. Both SettlementExecutor and
          // PerPacketClaimService share this registry instance.
          // Resolve primary chain ID string: prefer blockchain config, then chainProviders, then fallback
          const chainProviderChainId = this._config.chainProviders?.find(
            (cp) => cp.chainType === 'evm'
          )?.chainId;
          const primaryChainIdStr = primaryChainId
            ? `evm:${primaryChainId}`
            : (chainProviderChainId ?? 'evm:unknown');
          const chainRegistry = new ChainProviderRegistry();
          const evmProvider = new EVMPaymentChannelProvider(
            this._paymentChannelSDK,
            primaryChainIdStr,
            m2mTokenAddress,
            this._logger
          );
          chainRegistry.register(evmProvider);

          // Build peerIdToChainMap — config-driven when peers have `chain` fields,
          // otherwise all peers default to the primary EVM chain.
          const peerIdToChainMap = new Map<string, string>();
          for (const peer of this._config.peers) {
            if (peer.chain) {
              // Config-driven: peer explicitly references a chain provider
              peerIdToChainMap.set(peer.id, peer.chain);
            } else if (peerIdToAddressMap.has(peer.id)) {
              // Legacy: peer defaults to primary EVM chain
              peerIdToChainMap.set(peer.id, primaryChainIdStr);
            }
          }
          // Also map env-var-discovered peers (legacy PEER{N} pattern) to primary chain
          for (const peerId of peerIdToAddressMap.keys()) {
            if (!peerIdToChainMap.has(peerId)) {
              peerIdToChainMap.set(peerId, primaryChainIdStr);
            }
          }

          // NIP-59 transport privacy setup
          const nip59Enabled = this._config.nip59?.enabled ?? false;
          const nip59Wrapper = new NIP59ClaimWrapper({
            nip59Enabled,
            logger: this._logger,
          });
          const nodeSecp256k1PrivKey = treasuryPrivateKey
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
              registryAddress,
              rpcUrl: baseRpcUrl,
              privateKey: treasuryPrivateKey,
            },
            this._paymentChannelSDK,
            this._settlementExecutor,
            this._logger
          );

          // Wire ChannelManager to SettlementExecutor for chain-agnostic channel lookup
          this._settlementExecutor.setChannelManager(this._channelManager);

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
            this._paymentChannelSDK,
            this._config.nodeId,
            this._logger,
            this._channelManager ?? undefined,
            nip59Wrapper,
            nodeSecp256k1PrivKey,
            // Relation-aware inbound validation (issue #78): consult the
            // forwarding path's single source of truth so a child node skips
            // the inline-claim requirement for PREPAREs from its parent,
            // mirroring the outbound child-skip in requiresSettlementClaim.
            (peerId) => this._packetHandler.getPeerRelation(peerId)
          );
          this._btpServer.setInboundClaimValidator((protocolData, ilpPacket, peerId) =>
            inboundClaimValidator.validate(protocolData, ilpPacket, peerId)
          );
          this._logger.info(
            { event: 'inbound_claim_validator_enabled' },
            'Inbound claim validator wired to BTP server'
          );

          // Wire ClaimReceiver for event-driven settlement monitoring
          // ClaimReceiver validates inbound claims and emits CLAIM_RECEIVED events
          // that SettlementMonitor uses to trigger on-chain claimFromChannel()
          if (this._paymentChannelSDK) {
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

      // Start BTP server to accept incoming connections
      await this._btpServer.start(this._config.btpServerPort);
      this._btpServerStarted = true;
      this._logger.info(
        {
          event: 'btp_server_started',
          port: this._config.btpServerPort,
        },
        'BTP server started'
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

      // Start admin API server if enabled
      const adminApiEnabled =
        this._config.adminApi?.enabled || process.env.ADMIN_API_ENABLED === 'true';
      if (adminApiEnabled) {
        const adminConfig = {
          enabled: true,
          port: this._config.adminApi?.port ?? parseInt(process.env.ADMIN_API_PORT || '8081', 10),
          host: this._config.adminApi?.host ?? process.env.ADMIN_API_HOST ?? '0.0.0.0',
          apiKey: this._config.adminApi?.apiKey ?? process.env.ADMIN_API_KEY,
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
          managedAnonClient: this._managedAnonClient ?? undefined,
          // Per-peer transport selection: forward the post-validation
          // connector-level discriminator so POST /admin/peers can reject
          // `transport: 'socks5'` when the connector has no SOCKS5 proxy.
          // `_transportType` is null between init() and start(); coalesce
          // to the safe default. AdminServer also defaults to 'direct'
          // (belt-and-suspenders for test fixtures that omit the field).
          transportType: this._transportType ?? 'direct',
          // Relationship-aware settlement gate (issue #76): POST /admin/peers
          // forwards a peer's relation to the PacketHandler so value-bearing
          // forwards to a 'child' next hop skip the mandatory per-packet claim.
          setPeerRelation: (peerId, relation) =>
            this._packetHandler.setPeerRelation(peerId, relation),
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

      // Update health status to healthy after all components started
      this._updateHealthStatus();

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

      // Stop BTP server
      await this._btpServer.stop();

      // Epic 35 / Story 35.4: stop the transport provider LAST (after the
      // BTP layer is torn down so no in-flight createAgent() call can race
      // the provider stop). Clear the health-refresh timer first so no
      // further healthCheck() invocations fire during or after stop().
      if (this._transportHealthInterval) {
        clearInterval(this._transportHealthInterval);
        this._transportHealthInterval = null;
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
   * Select and instantiate a TransportProvider from a validated
   * `TransportConfig`.
   *
   * Uses an exhaustive `switch` on the discriminator so future transport
   * types fail at compile-time if unhandled (leverages the Story 35.3
   * discriminated union). When the config is absent, defaults to
   * `DirectTransportProvider` -- preserving backward compatibility.
   *
   * `DirectTransportProvider` is given a synthesized `externalUrl` from
   * `btpServerPort` because `ConnectorConfig` has no `publicUrl` field
   * (Story 35.3 AC #9). The value is an internal placeholder; callers that
   * consume `getExternalUrl()` from a direct provider should treat
   * `ws://localhost:...` as "unknown public URL, do not advertise."
   *
   * @param cfg - Validated transport config, possibly undefined.
   * @returns A started-not-yet TransportProvider.
   */
  private _createTransportProvider(cfg: TransportConfig | undefined): TransportProvider {
    if (cfg === undefined || cfg.type === 'direct') {
      const externalUrl = `ws://localhost:${this._config.btpServerPort}`;
      this._logger.debug(
        { event: 'direct_transport_external_url_synthesized', externalUrl },
        'DirectTransportProvider externalUrl synthesized from btpServerPort (local placeholder)'
      );
      return new DirectTransportProvider(externalUrl);
    }
    if (cfg.type === 'socks5') {
      // Story 35.5: if `managed: true`, construct a ManagedAnonClient that
      // lazy-imports the optional @anyone-protocol/anyone-client SDK and
      // wraps it for lifecycle. Otherwise behave exactly as Story 35.2.
      let managedClient: ManagedAnonClient | undefined;
      let externalUrl = cfg.externalUrl;
      if (cfg.managed === true) {
        // Build a factory that defers SDK import until start() runs.
        // createDefaultAnonFactory() is async and throws MODULE_NOT_FOUND if
        // the SDK is missing; we capture that at factory-invocation time
        // so ManagedAnonClient.start() can surface the canonical template.
        let cachedFactory: ((opts: AnonFactoryOptions) => AnonSdkHandle) | undefined;
        // Pre-warm the factory via `createDefaultAnonFactory()` which handles
        // both CJS (`require()`) AND ESM-only (`ERR_REQUIRE_ESM` → dynamic
        // `import()`) packages. This runs asynchronously; if it rejects with
        // MODULE_NOT_FOUND we keep `cachedFactory` undefined so the synchronous
        // `anonFactory` below can re-throw a MODULE_NOT_FOUND-shaped error and
        // let `ManagedAnonClient.start()` emit the canonical install-guidance
        // message.
        let prewarmError: NodeJS.ErrnoException | undefined;
        const prewarmPromise = createDefaultAnonFactory().then(
          (f) => {
            cachedFactory = f;
          },
          (err: unknown) => {
            prewarmError = err as NodeJS.ErrnoException;
          }
        );
        const anonFactory = (opts: AnonFactoryOptions): AnonSdkHandle => {
          if (cachedFactory) {
            return cachedFactory(opts);
          }
          if (prewarmError) {
            if (prewarmError.code === 'MODULE_NOT_FOUND') {
              throw prewarmError;
            }
            throw new Error(
              `Failed to load optional dependency "@anyone-protocol/anyone-client": ` +
                `${prewarmError.message ?? String(prewarmError)}`,
              { cause: prewarmError }
            );
          }
          // Pre-warm still in flight. Fall back to synchronous `require()` so
          // we don't block the factory contract. This branch is the common
          // case for CJS-compatible SDKs (require succeeds immediately; the
          // async prewarm is a redundant belt-and-suspenders for ESM-only
          // future versions).
          try {
            const pkg = '@anyone-protocol/anyone-client';
            // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
            const mod = require(pkg);
            /* eslint-disable @typescript-eslint/no-explicit-any */
            const AnonCtor =
              (mod as any)?.Anon ?? (mod as any)?.default?.Anon ?? (mod as any)?.default;
            /* eslint-enable @typescript-eslint/no-explicit-any */
            if (typeof AnonCtor !== 'function') {
              throw new Error(
                '@anyone-protocol/anyone-client did not export an `Anon` constructor'
              );
            }
            cachedFactory = (o: AnonFactoryOptions) => new AnonCtor(o) as AnonSdkHandle;
            return cachedFactory(opts);
          } catch (err) {
            const cause = err as NodeJS.ErrnoException;
            // True missing-module: re-throw unchanged so ManagedAnonClient
            // can emit the canonical install-guidance error via its own
            // MODULE_NOT_FOUND path.
            if (cause?.code === 'MODULE_NOT_FOUND') {
              throw cause;
            }
            // ERR_REQUIRE_ESM means the package is ESM-only; the async
            // pre-warm above handles this correctly but may not have
            // resolved yet. Surface a descriptive error suggesting the
            // operator wait/retry rather than misleading them with install
            // guidance.
            if (cause?.code === 'ERR_REQUIRE_ESM') {
              throw new Error(
                `@anyone-protocol/anyone-client is an ESM-only package; ` +
                  `the async lazy-import pre-warm had not completed when the factory ` +
                  `was invoked. This is a timing bug — please file an issue.`,
                { cause }
              );
            }
            throw new Error(
              `Failed to load optional dependency "@anyone-protocol/anyone-client": ` +
                `${cause?.message ?? String(err)}`,
              { cause }
            );
          }
        };
        // Reference prewarmPromise to silence unused-variable warnings; the
        // promise runs to completion in the background and populates
        // cachedFactory or prewarmError.
        void prewarmPromise;
        managedClient = new ManagedAnonClient({
          socksProxy: cfg.socksProxy,
          hiddenServiceDir: cfg.managedOptions?.hiddenServiceDir,
          hiddenServicePort: cfg.managedOptions?.hiddenServicePort,
          binaryPath: cfg.managedOptions?.binaryPath,
          startupTimeoutMs: cfg.managedOptions?.startupTimeoutMs,
          stopTimeoutMs: cfg.managedOptions?.stopTimeoutMs,
          logger: this._logger,
          anonFactory,
        });
        // Story 38.1: stash the reference so the admin server can serve
        // `GET /admin/hs-hostname` once both subsystems are up.
        this._managedAnonClient = managedClient;

        // `externalUrl: 'auto'` resolution (AC #8) happens at start() time
        // because we need the hostname file to exist. We install a resolver
        // that the provider invokes AFTER the managed client has started and
        // BEFORE the TCP probe; it reads the SDK-written `hostname` file and
        // returns the final `wss://<hostname>/btp` URL.
        //
        // We deliberately do NOT embed `.anon` in the construction-time
        // placeholder (AC #9 log-hygiene invariant — if the placeholder ever
        // leaks into an error or log before resolution, it must not contain a
        // simulated `.anon` host). Use `wss://pending.invalid/btp` instead.
        if (externalUrl === 'auto') {
          externalUrl = 'wss://pending.invalid/btp';
        }
      } else if (externalUrl === 'auto') {
        // Defensive: schema should already reject this, but fail-closed here.
        throw new Error(
          '_createTransportProvider: transport.externalUrl "auto" requires managed: true'
        );
      }

      // Build the auto-resolver if the operator asked for it. The resolver
      // reads `${hiddenServiceDir}/hostname` (populated by `anon` on first
      // successful start) and returns the full BTP wss:// URL. It runs
      // AFTER managedClient.start() and BEFORE the TCP probe.
      let resolveExternalUrlOnStart: (() => Promise<string>) | undefined;
      if (cfg.externalUrl === 'auto') {
        const hsDir = cfg.managedOptions?.hiddenServiceDir;
        if (!hsDir) {
          throw new Error(
            '_createTransportProvider: transport.externalUrl "auto" requires managedOptions.hiddenServiceDir'
          );
        }
        // The `anon` binary writes `${hsDir}/hostname` at some point after
        // the SOCKS port binds — the exact ordering is version-dependent and
        // not guaranteed to precede SOCKS readiness. Poll with a bounded
        // deadline (default 30s; operators can override via
        // managedOptions.startupTimeoutMs since it's the outer budget) to
        // tolerate the race without hanging shutdown.
        const hostnameReadDeadlineMs = cfg.managedOptions?.startupTimeoutMs ?? 30_000;
        // Strict hostname validator for the contents of
        // `${hiddenServiceDir}/hostname`. Defense against a corrupted,
        // partially-written, or attacker-tampered hostname file producing a
        // malformed `wss://` URL that enables request-smuggling or redirects
        // the connector at an attacker-controlled peer. Per the ATOR / Tor
        // hidden service address format, v3 onion addresses are 56 lowercase
        // base32 chars followed by `.anon` (or `.onion` on upstream Tor);
        // v2 (deprecated) was 16 chars. We accept either length and both
        // TLDs defensively. No ports, no paths, no auth, no whitespace.
        const HIDDEN_SERVICE_HOSTNAME_RE = /^[a-z2-7]{16}(?:[a-z2-7]{40})?\.(?:anon|onion)$/;
        resolveExternalUrlOnStart = async (): Promise<string> => {
          // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal
          // Epic 35 retro action item #7 (triage close): `hsDir` is
          // validated at config load (validateManagedOptions rejects any
          // `..` segment before and after normalization; see
          // config-loader.ts). The joined filename is the static literal
          // `'hostname'` with no user input. The file is read, not written,
          // and the contents are further validated against a strict
          // hidden-service regex below before use. Reviewed and closed.
          const hostnameFile = nodePath.join(hsDir, 'hostname');
          const deadline = Date.now() + hostnameReadDeadlineMs;
          let lastErr: unknown;
          while (Date.now() < deadline) {
            try {
              const raw = await fsPromises.readFile(hostnameFile, 'utf8');
              // Take only the first line (anon writes "<addr>\n"; be tolerant
              // of CRLF and of the file briefly containing additional tokens
              // during rotation).
              const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? '';
              const hostname = firstLine;
              if (!hostname) {
                lastErr = new Error('hostname file is empty');
              } else if (!HIDDEN_SERVICE_HOSTNAME_RE.test(hostname)) {
                // Do NOT include the hostname in the error message — AC #9
                // log-hygiene: the full .anon address must never reach
                // INFO/WARN/ERROR. Include only the length as a breadcrumb.
                lastErr = new Error(
                  `hostname file contents did not match the expected hidden service format ` +
                    `(length=${hostname.length}); ignoring and retrying`
                );
              } else {
                return `wss://${hostname}/btp`;
              }
            } catch (err) {
              lastErr = err;
            }
            await new Promise((r) => setTimeout(r, 250));
          }
          const reason = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown');
          throw new Error(
            `hidden service hostname file "${hostnameFile}" did not become readable ` +
              `within ${hostnameReadDeadlineMs}ms (last error: ${reason})`
          );
        };
      }
      return new SocksTransportProvider({
        socksProxy: cfg.socksProxy,
        externalUrl,
        logger: this._logger,
        managedClient,
        resolveExternalUrlOnStart,
      });
    }
    // Exhaustiveness guard: if a new variant is added to TransportConfig,
    // TypeScript will error here at compile-time.
    const _exhaustive: never = cfg;
    throw new Error(
      `Unsupported transport type: ${JSON.stringify(_exhaustive)} ` +
        '(Story 35.4 _createTransportProvider exhaustiveness guard)'
    );
  }

  /**
   * Get payment channel SDK instance (for admin API access)
   * @returns PaymentChannelSDK instance or null if not initialized
   */
  get paymentChannelSDK(): PaymentChannelSDK | null {
    return this._paymentChannelSDK;
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

    // Validate required fields
    if (!config.id || typeof config.id !== 'string') {
      throw new Error('Missing or invalid peer id');
    }
    if (!config.url || typeof config.url !== 'string') {
      throw new Error('Missing or invalid peer url');
    }
    if (
      config.authToken === undefined ||
      config.authToken === null ||
      typeof config.authToken !== 'string'
    ) {
      throw new Error('authToken must be a string (can be empty for no auth)');
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

    // Validate per-peer transport against the connector-level transport type.
    // Uses `_transportType` (the post-validation field at connector-node.ts:130),
    // NOT `_config.transport.type` — `_config.transport` may be undefined for
    // partial-config test callers, and `_transportType` is the canonical source
    // of truth after start().
    if (
      config.transport !== undefined &&
      config.transport !== 'direct' &&
      config.transport !== 'socks5'
    ) {
      throw new Error(
        `Invalid transport: must be 'direct' or 'socks5' (got '${config.transport}')`
      );
    }
    if (config.transport === 'socks5' && this._transportType !== 'socks5') {
      throw new Error("transport: 'socks5' requires connector-level transport.type 'socks5'");
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

    // Check if peer already exists (idempotent re-registration)
    const existingPeers = this._btpClientManager.getPeerIds();
    const isUpdate = existingPeers.includes(config.id);

    // Only add BTP peer on initial registration
    if (!isUpdate) {
      const peer: Peer = {
        id: config.id,
        url: config.url,
        authToken: config.authToken,
        connected: false,
        lastSeen: new Date(),
        transport: config.transport,
      };
      await this._btpClientManager.addPeer(peer);
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
    } else {
      this._logger.info(
        {
          event: 'peer_reregistered',
          peerId: config.id,
          transport: this._btpClientManager.getPeerTransport(config.id) ?? null,
        },
        `Re-registering peer: ${config.id}`
      );
    }

    // Add routes if provided
    if (config.routes) {
      for (const route of config.routes) {
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
      this._applySettlementConfig(config.id, config.settlement, config.routes, isUpdate);
    }

    // Build PeerInfo response
    const routes = this._routingTable.getAllRoutes();
    const peerRoutes = routes.filter((r) => r.nextHop === config.id);
    const connected = this._btpClientManager.isConnected(config.id);

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
        // consumers (Townhouse, test fixtures, future BMad agents) keep
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

    this._routingTable.removeRoute(prefix as ILPAddress);
    this._logger.info({ event: 'route_removed', prefix }, `Removed route: ${prefix}`);
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
