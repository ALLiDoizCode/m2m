/**
 * Admin API HTTP Server
 * @packageDocumentation
 * @remarks
 * Provides HTTP server for admin API endpoints.
 * Manages dynamic peer and route configuration at runtime.
 *
 * **Security:**
 * - Bind to internal network only (Docker Compose, Kubernetes)
 * - Optional API key authentication
 * - Should NOT be exposed to public internet
 */

import type { Express } from 'express';
import { Server } from 'http';
import { Logger } from '../utils/logger';
import { RoutingTable } from '../routing/routing-table';
import { BTPClientManager } from '../btp/btp-client-manager';
import { createAdminRouter } from './admin-api';
import { AdminApiConfig } from '../config/types';
import { PeerConfig as SettlementPeerConfig } from '../settlement/types';
import type { ChannelManager } from '../settlement/channel-manager';
import type { PaymentChannelSDK } from '../settlement/payment-channel-sdk';
import type { AccountManager } from '../settlement/account-manager';
import type { SettlementMonitor } from '../settlement/settlement-monitor';
import type { ClaimReceiver } from '../settlement/claim-receiver';
import type { PacketSenderFn, IsReadyFn } from './ilp-send-handler';
import type { IlpMetricsRegistry } from '../observability/metrics-registry';
import { requireOptional } from '../utils/optional-require';

/**
 * Admin API HTTP Server
 *
 * Wraps Express app with admin API router and provides start/stop lifecycle.
 *
 * @example
 * ```typescript
 * const adminServer = new AdminServer({
 *   routingTable,
 *   btpClientManager,
 *   nodeId: 'connector-1',
 *   config: { enabled: true, port: 8081 },
 *   logger
 * });
 *
 * await adminServer.start();
 * // Server now accepting requests at http://localhost:8081/admin/*
 *
 * await adminServer.stop();
 * ```
 */
export class AdminServer {
  private _app!: Express;
  private _server: Server | null = null;
  private readonly _logger: Logger;
  private readonly _config: AdminApiConfig;
  private readonly _nodeId: string;
  private readonly _options: {
    routingTable: RoutingTable;
    btpClientManager: BTPClientManager;
    nodeId: string;
    config: AdminApiConfig;
    logger: Logger;
    settlementPeers?: Map<string, SettlementPeerConfig>;
    channelManager?: ChannelManager;
    paymentChannelSDK?: PaymentChannelSDK;
    accountManager?: AccountManager;
    settlementMonitor?: SettlementMonitor;
    claimReceiver?: ClaimReceiver;
    sentClaimsQueries?: import('../settlement/sent-claims-queries').SentClaimsQueries;
    defaultSettlementTokenId?: string;
    packetSender?: PacketSenderFn;
    isReady?: IsReadyFn;
    metricsRegistry?: IlpMetricsRegistry;
    resolveTokenMetadata?: (
      blockchain: 'evm' | 'solana' | 'mina',
      tokenAddress: string
    ) => Promise<{ assetCode: string; assetScale: number }>;
    connectorFeePercentage?: number;
    setPeerRelation?: (peerId: string, relation: import('../config/types').PeerRelation) => void;
    getPeerRelation?: (peerId: string) => import('../config/types').PeerRelation | undefined;
    registryStore?: import('./admin-api').RegistryPeerSink;
    httpPeerEgress?: import('../transport/http-peer-transport').PeerEgress;
    setPeerProtocol?: (peerId: string, protocol: 'btp' | 'ilp-http') => void;
    routeTerminationRegistry?: import('./admin-api').RouteTerminationSink;
    getDiscoveredNodes?: () => import('../discovery/discovered-node-registry').DiscoveredNode[];
    checkFundedChannelCap?: (peerId: string) => string | null;
    recordRuntimePeerUrl?: (peerId: string, url: string) => void;
    forgetRuntimePeerUrl?: (peerId: string) => void;
  };

  /**
   * Create AdminServer instance
   *
   * @param options - Server configuration
   * @param options.routingTable - Routing table instance for route management
   * @param options.btpClientManager - BTP client manager for peer management
   * @param options.nodeId - Node identifier for logging
   * @param options.config - Admin API configuration
   * @param options.logger - Logger instance
   */
  constructor(options: {
    routingTable: RoutingTable;
    btpClientManager: BTPClientManager;
    nodeId: string;
    config: AdminApiConfig;
    logger: Logger;
    settlementPeers?: Map<string, SettlementPeerConfig>;
    channelManager?: ChannelManager;
    paymentChannelSDK?: PaymentChannelSDK;
    accountManager?: AccountManager;
    settlementMonitor?: SettlementMonitor;
    claimReceiver?: ClaimReceiver;
    sentClaimsQueries?: import('../settlement/sent-claims-queries').SentClaimsQueries;
    defaultSettlementTokenId?: string;
    packetSender?: PacketSenderFn;
    isReady?: IsReadyFn;
    metricsRegistry?: IlpMetricsRegistry;
    resolveTokenMetadata?: (
      blockchain: 'evm' | 'solana' | 'mina',
      tokenAddress: string
    ) => Promise<{ assetCode: string; assetScale: number }>;
    connectorFeePercentage?: number;
    /**
     * Relationship-aware settlement gate hook (issue #76). Forwarded to the
     * admin router so `POST /admin/peers` can propagate a peer's
     * {@link PeerRelation} to the PacketHandler. Omitted by test fixtures that
     * do not exercise the forwarding path.
     */
    setPeerRelation?: (peerId: string, relation: import('../config/types').PeerRelation) => void;
    getPeerRelation?: (peerId: string) => import('../config/types').PeerRelation | undefined;
    registryStore?: import('./admin-api').RegistryPeerSink;
    /**
     * ILP-over-HTTP egress (Epic 38, Story 38.1). Forwarded to the admin router
     * so `POST /admin/peers { peerProtocol: 'ilp-http' }` registers the peer
     * with the HTTP egress instead of opening a BTP connection. Omitted by test
     * fixtures / connectors built without HTTP egress.
     */
    httpPeerEgress?: import('../transport/http-peer-transport').PeerEgress;
    setPeerProtocol?: (peerId: string, protocol: 'btp' | 'ilp-http') => void;
    /**
     * Issue #218: per-route local-termination registry. Forwarded to the admin
     * router so PUT /admin/desired-state reconciles terminated routes into the
     * same in-memory registry #216's HttpProxyHandler resolves against.
     */
    routeTerminationRegistry?: import('./admin-api').RouteTerminationSink;
    /**
     * Discovered-node reader (toon-meta#153). Forwarded to the admin router
     * so `GET /admin/discovered-nodes` lists the discovered set with each
     * entry's `funded` flag. Omitted when route learning is disabled.
     */
    getDiscoveredNodes?: () => import('../discovery/discovered-node-registry').DiscoveredNode[];
    /**
     * Funded-channel cap gate (toon-meta#153). Forwarded to the admin router
     * so `POST /admin/peers` with a settlement block enforces
     * `peeringPolicy.maxFundedChannels` with the same error string as
     * `ConnectorNode.registerPeer`.
     */
    checkFundedChannelCap?: (peerId: string) => string | null;
    /**
     * Runtime peer-URL bookkeeping hooks (issue #345). Forwarded to the admin
     * router so `POST /admin/peers` records (and `DELETE /admin/peers/:peerId`
     * forgets) the peer's BTP url in the same map `ConnectorNode.registerPeer`
     * / `removePeer` maintain — keeping the discovered-node registry's
     * endpoint-fallback funded matching correct for peers promoted via the
     * admin HTTP surface.
     */
    recordRuntimePeerUrl?: (peerId: string, url: string) => void;
    forgetRuntimePeerUrl?: (peerId: string) => void;
  }) {
    this._options = options;
    this._nodeId = options.nodeId;
    this._config = options.config;
    this._logger = options.logger.child({ component: 'AdminServer' });
  }

  /**
   * Initialize Express app with admin routes (called from start())
   */
  private async _initApp(): Promise<void> {
    const { default: express } = await requireOptional<{ default: typeof import('express') }>(
      'express',
      'HTTP admin/health APIs'
    );

    const {
      routingTable,
      btpClientManager,
      nodeId,
      config,
      settlementPeers,
      channelManager,
      paymentChannelSDK,
      accountManager,
      settlementMonitor,
      claimReceiver,
      sentClaimsQueries,
      defaultSettlementTokenId,
      packetSender,
      isReady,
      metricsRegistry,
      resolveTokenMetadata,
      connectorFeePercentage,
      setPeerRelation,
      getPeerRelation,
      registryStore,
      httpPeerEgress,
      setPeerProtocol,
      routeTerminationRegistry,
      getDiscoveredNodes,
      checkFundedChannelCap,
      recordRuntimePeerUrl,
      forgetRuntimePeerUrl,
    } = this._options;

    this._app = express();

    // Create and mount admin router
    const adminRouter = await createAdminRouter({
      routingTable,
      btpClientManager,
      nodeId,
      apiKey: config.apiKey,
      allowedIPs: config.allowedIPs,
      trustProxy: config.trustProxy,
      logger: this._logger,
      settlementPeers,
      channelManager,
      paymentChannelSDK,
      accountManager,
      settlementMonitor,
      claimReceiver,
      sentClaimsQueries,
      defaultSettlementTokenId,
      packetSender,
      isReady,
      metricsRegistry,
      resolveTokenMetadata,
      connectorFeePercentage,
      setPeerRelation,
      getPeerRelation,
      registryStore,
      httpPeerEgress,
      setPeerProtocol,
      routeTerminationRegistry,
      getDiscoveredNodes,
      checkFundedChannelCap,
      recordRuntimePeerUrl,
      forgetRuntimePeerUrl,
    });

    this._app.use('/admin', adminRouter);

    // Health endpoint for the admin server itself
    this._app.get('/health', (_req, res) => {
      res.json({
        status: 'healthy',
        service: 'admin-api',
        nodeId: this._nodeId,
        timestamp: new Date().toISOString(),
      });
    });

    this._logger.info(
      {
        event: 'admin_server_initialized',
        port: config.port ?? 8081,
        apiKeyConfigured: !!config.apiKey,
        ipAllowlistConfigured: !!config.allowedIPs && config.allowedIPs.length > 0,
        trustProxy: config.trustProxy ?? false,
      },
      'Admin server initialized'
    );
  }

  /**
   * Start admin API HTTP server
   *
   * @returns Promise that resolves when server is listening
   * @throws Error if port is already in use
   *
   * @example
   * ```typescript
   * await adminServer.start();
   * console.log('Admin API listening on port 8081');
   * ```
   */
  async start(): Promise<void> {
    await this._initApp();
    const port = this._config.port ?? 8081;
    const host = this._config.host ?? '0.0.0.0';
    const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];

    return new Promise((resolve, reject) => {
      try {
        this._server = this._app.listen(port, host, () => {
          this._logger.info(
            {
              event: 'admin_server_started',
              port,
              host,
              endpoints: [
                'GET /admin/dashboard',
                'GET /admin/peers',
                'POST /admin/peers',
                'DELETE /admin/peers/:peerId',
                'GET /admin/discovered-nodes',
                'GET /admin/routes',
                'POST /admin/routes',
                'DELETE /admin/routes/:prefix',
                'POST /admin/channels',
                'GET /admin/channels',
                'GET /admin/channels/:channelId',
                'GET /admin/balances/:peerId',
                'GET /admin/settlement/states',
                'GET /admin/channels/:channelId/claims',
                'POST /admin/ilp/send',
              ],
            },
            `Admin API server started on ${host}:${port}`
          );

          // Warn when the admin API has no API key/IP allowlist and binds to a non-loopback address
          const hasIPAllowlist = this._config.allowedIPs && this._config.allowedIPs.length > 0;
          if (!this._config.apiKey && !hasIPAllowlist && !LOOPBACK_HOSTS.includes(host)) {
            this._logger.warn(
              {
                event: 'admin_api_no_auth',
                host,
                port,
              },
              `Admin API is listening on ${host}:${port} WITHOUT authentication. ` +
                'Set ADMIN_API_KEY or ADMIN_API_ALLOWED_IPS to secure the admin API.'
            );
          }

          resolve();
        });

        this._server.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE') {
            const errorMessage = `Admin API port ${port} is already in use`;
            this._logger.error(
              {
                event: 'admin_server_start_failed',
                port,
                error: errorMessage,
              },
              errorMessage
            );
            reject(new Error(errorMessage));
          } else {
            this._logger.error(
              {
                event: 'admin_server_error',
                error: error.message,
              },
              'Admin server error'
            );
            reject(error);
          }
        });
      } catch (error) {
        this._logger.error(
          {
            event: 'admin_server_start_exception',
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to start admin server'
        );
        reject(error);
      }
    });
  }

  /** The bound HTTP address (after `start()` resolves), or null when not listening. */
  address(): ReturnType<Server['address']> {
    return this._server?.address() ?? null;
  }

  /**
   * Stop admin API HTTP server gracefully
   *
   * @returns Promise that resolves when server is closed
   *
   * @example
   * ```typescript
   * await adminServer.stop();
   * console.log('Admin API server stopped');
   * ```
   */
  async stop(): Promise<void> {
    if (!this._server) {
      return;
    }

    return new Promise((resolve, reject) => {
      this._server!.close((error) => {
        if (error) {
          this._logger.error(
            {
              event: 'admin_server_stop_failed',
              error: error.message,
            },
            'Failed to stop admin server'
          );
          reject(error);
        } else {
          this._logger.info(
            {
              event: 'admin_server_stopped',
            },
            'Admin API server stopped'
          );
          this._server = null;
          resolve();
        }
      });
    });
  }

  /**
   * Get the configured port
   * @returns Admin API port number
   */
  getPort(): number {
    return this._config.port ?? 8081;
  }

  /**
   * Check if server is running
   * @returns true if server is listening
   */
  isRunning(): boolean {
    return this._server !== null && this._server.listening;
  }
}
