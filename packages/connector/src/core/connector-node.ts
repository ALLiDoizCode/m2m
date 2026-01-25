/**
 * ConnectorNode - Core ILP connector orchestrator
 * Manages all connector components and lifecycle
 */

import { Logger } from '../utils/logger';
import { RoutingTable } from '../routing/routing-table';
import { BTPClientManager } from '../btp/btp-client-manager';
import { BTPServer } from '../btp/btp-server';
import { PacketHandler } from './packet-handler';
import { Peer } from '../btp/btp-client';
import { RoutingTableEntry, ILPAddress } from '@m2m/shared';
import { ConnectorConfig } from '../config/types';
import { ConfigLoader, ConfigurationError } from '../config/config-loader';
import { HealthServer } from '../http/health-server';
import { HealthStatus, HealthStatusProvider } from '../http/types';
import { TelemetryEmitter } from '../telemetry/telemetry-emitter';
import { PeerStatus } from '../telemetry/types';
import { EventStore, ExplorerServer } from '../explorer';
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
  private readonly _telemetryEmitter: TelemetryEmitter | null;
  private _eventStore: EventStore | null = null;
  private _explorerServer: ExplorerServer | null = null;
  private _healthStatus: 'healthy' | 'unhealthy' | 'starting' = 'starting';
  private readonly _startTime: Date = new Date();
  private _btpServerStarted: boolean = false;

  /**
   * Create ConnectorNode instance
   * @param configFilePath - Path to YAML configuration file
   * @param logger - Pino logger instance
   * @throws ConfigurationError if configuration is invalid
   */
  constructor(configFilePath: string, logger: Logger) {
    // Load and validate configuration from YAML file
    let config: ConnectorConfig;
    try {
      config = ConfigLoader.loadConfig(configFilePath);
    } catch (error) {
      if (error instanceof ConfigurationError) {
        logger.error(
          {
            event: 'config_load_failed',
            filePath: configFilePath,
            error: error.message,
          },
          'Failed to load configuration'
        );
        throw error;
      }
      throw error;
    }

    this._config = config;
    this._logger = logger.child({ component: 'ConnectorNode', nodeId: config.nodeId });

    this._logger.info(
      {
        event: 'config_loaded',
        filePath: configFilePath,
        nodeId: config.nodeId,
      },
      'Configuration loaded successfully'
    );

    // Convert RouteConfig[] to RoutingTableEntry[]
    const routingTableEntries: RoutingTableEntry[] = config.routes.map((route) => ({
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
      config.nodeId,
      logger.child({ component: 'BTPClientManager' })
    );

    // Initialize telemetry emitter if DASHBOARD_TELEMETRY_URL is set
    const dashboardUrl = process.env.DASHBOARD_TELEMETRY_URL;
    if (dashboardUrl) {
      this._telemetryEmitter = new TelemetryEmitter(
        dashboardUrl,
        config.nodeId,
        logger.child({ component: 'TelemetryEmitter' })
      );
      this._logger.info(
        { event: 'telemetry_enabled', dashboardUrl },
        'Telemetry emitter initialized'
      );
    } else {
      this._telemetryEmitter = null;
      this._logger.info(
        { event: 'telemetry_disabled' },
        'Telemetry disabled (DASHBOARD_TELEMETRY_URL not set)'
      );
    }

    // Initialize packet handler (pass telemetryEmitter for telemetry integration)
    this._packetHandler = new PacketHandler(
      this._routingTable,
      this._btpClientManager,
      config.nodeId,
      logger.child({ component: 'PacketHandler' }),
      this._telemetryEmitter
    );

    // Initialize BTP server
    this._btpServer = new BTPServer(logger.child({ component: 'BTPServer' }), this._packetHandler);

    // Link BTPServer to PacketHandler for bidirectional forwarding (resolves circular dependency)
    this._packetHandler.setBTPServer(this._btpServer);

    // Link PacketHandler to BTPClientManager for incoming packet handling (resolves circular dependency)
    this._btpClientManager.setPacketHandler(this._packetHandler);

    // Initialize health server
    this._healthServer = new HealthServer(logger.child({ component: 'HealthServer' }), this);

    this._logger.info(
      {
        event: 'connector_initialized',
        nodeId: config.nodeId,
        peersCount: config.peers.length,
        routesCount: config.routes.length,
      },
      'Connector node initialized'
    );
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

      // Start explorer if enabled (default: true)
      if (this._config.explorer?.enabled !== false && this._telemetryEmitter) {
        try {
          const explorerConfig = this._config.explorer || {};
          const explorerPort = explorerConfig.port ?? 3001;
          const retentionDays = explorerConfig.retentionDays ?? 7;
          const maxEvents = explorerConfig.maxEvents ?? 1000000;

          // Initialize EventStore
          this._eventStore = new EventStore(
            {
              path: `./data/explorer-${this._config.nodeId}.db`,
              maxEventCount: maxEvents,
              maxAgeMs: retentionDays * 24 * 60 * 60 * 1000,
            },
            this._logger.child({ component: 'EventStore' })
          );
          await this._eventStore.initialize();

          // Wire TelemetryEmitter to EventStore for persistence
          this._telemetryEmitter.onEvent((event) => {
            this._eventStore?.storeEvent(event).catch((err) => {
              this._logger.warn({ error: err.message }, 'Failed to store telemetry event');
            });
          });

          // Initialize ExplorerServer
          this._explorerServer = new ExplorerServer(
            {
              port: explorerPort,
              nodeId: this._config.nodeId,
            },
            this._eventStore,
            this._telemetryEmitter,
            this._logger
          );
          await this._explorerServer.start();

          this._logger.info(
            {
              event: 'explorer_server_started',
              port: explorerPort,
              retentionDays,
              maxEvents,
            },
            'Explorer server started'
          );
        } catch (error) {
          // Explorer failures should not prevent connector startup
          const errorMessage = error instanceof Error ? error.message : String(error);
          this._logger.warn(
            { event: 'explorer_start_failed', error: errorMessage },
            'Failed to start explorer (connector continues running)'
          );
        }
      } else if (this._config.explorer?.enabled === false) {
        this._logger.info({ event: 'explorer_disabled' }, 'Explorer UI disabled by configuration');
      } else if (!this._telemetryEmitter) {
        this._logger.info(
          { event: 'explorer_skipped' },
          'Explorer UI skipped (telemetry emitter not available)'
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

      // Update health status to healthy after all components started
      this._updateHealthStatus();

      // Connect telemetry emitter and emit NODE_STATUS if enabled
      if (this._telemetryEmitter) {
        try {
          await this._telemetryEmitter.connect();
          this._logger.info({ event: 'telemetry_connected' }, 'Telemetry connected to dashboard');

          // Emit NODE_STATUS telemetry after successful connection
          this._logger.info({ event: 'preparing_node_status' }, 'Preparing NODE_STATUS telemetry');
          const routes = this._routingTable.getAllRoutes();
          const peers: PeerStatus[] = this._config.peers.map((peerConfig) => ({
            id: peerConfig.id,
            url: peerConfig.url,
            connected: connectedPeers.get(peerConfig.id) || false,
          }));

          this._logger.info(
            {
              event: 'emitting_node_status',
              routes: routes.length,
              peers: peers.length,
              health: this._healthStatus,
            },
            'Emitting NODE_STATUS telemetry'
          );
          this._telemetryEmitter.emitNodeStatus(routes, peers, this._healthStatus);
          this._logger.info(
            { event: 'telemetry_node_status_emitted', routes: routes.length, peers: peers.length },
            'NODE_STATUS telemetry emitted'
          );
        } catch (error) {
          // Telemetry failures should not prevent connector startup
          const errorMessage = error instanceof Error ? error.message : String(error);
          this._logger.warn(
            { event: 'telemetry_connect_failed', error: errorMessage },
            'Failed to connect telemetry (connector continues running)'
          );
        }
      }

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
      this._healthStatus = 'unhealthy';
      throw error;
    }
  }

  /**
   * Stop connector and disconnect all peers
   * Gracefully shuts down all components
   */
  async stop(): Promise<void> {
    this._logger.info(
      {
        event: 'connector_stopping',
        nodeId: this._config.nodeId,
      },
      'Stopping connector node'
    );

    try {
      // Stop explorer server if running (before health server)
      if (this._explorerServer) {
        await this._explorerServer.stop();
        this._logger.info({ event: 'explorer_server_stopped' }, 'Explorer server stopped');
        this._explorerServer = null;
      }

      // Close event store if initialized
      if (this._eventStore) {
        await this._eventStore.close();
        this._logger.info({ event: 'event_store_closed' }, 'Event store closed');
        this._eventStore = null;
      }

      // Disconnect telemetry emitter if enabled
      if (this._telemetryEmitter) {
        await this._telemetryEmitter.disconnect();
        this._logger.info({ event: 'telemetry_disconnected' }, 'Telemetry disconnected');
      }

      // Disconnect all BTP clients
      const peerIds = this._btpClientManager.getPeerIds();
      for (const peerId of peerIds) {
        await this._btpClientManager.removePeer(peerId);
      }

      // Stop health server
      await this._healthServer.stop();

      // Stop BTP server
      await this._btpServer.stop();

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

    // Add explorer status if enabled
    if (this._explorerServer && this._eventStore) {
      healthStatus.explorer = {
        enabled: true,
        port: this._explorerServer.getPort(),
        eventCount: 0, // Will be fetched asynchronously if needed
        wsConnections: this._explorerServer.getBroadcaster().getClientCount(),
      };
    }

    return healthStatus;
  }

  /**
   * Update health status based on current peer connections
   * Called internally when connection state changes
   * @private
   */
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

  /**
   * Get routing table entries
   * @returns Array of current routing table entries
   */
  getRoutingTable(): RoutingTableEntry[] {
    return this._routingTable.getAllRoutes();
  }
}
