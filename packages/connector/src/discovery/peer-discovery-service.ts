/**
 * Peer Discovery Service
 *
 * Handles automatic peer discovery by broadcasting connector availability
 * to configured discovery endpoints. Periodically announces the connector's
 * presence and listens for peer announcements from the network.
 */

import type { Logger } from 'pino';
import type {
  PeerDiscoveryConfig,
  PeerInfo,
  AnnounceResponse,
  PeerListResponse,
  DiscoveryStatus,
} from './types';

/**
 * Default broadcast interval in seconds
 */
const DEFAULT_BROADCAST_INTERVAL = 60;

/**
 * Default TTL for peer entries (2x broadcast interval)
 */
const DEFAULT_PEER_TTL = 120;

/**
 * Connection retry delay in milliseconds
 */
const CONNECTION_RETRY_DELAY = 5000;

/**
 * Maximum connection retries
 */
const MAX_CONNECTION_RETRIES = 3;

/**
 * PeerDiscoveryService handles automatic peer discovery and connection.
 */
export class PeerDiscoveryService {
  private readonly _config: PeerDiscoveryConfig;
  private readonly _logger: Logger;
  private readonly _discoveredPeers: Map<string, PeerInfo> = new Map();
  private readonly _connectedPeers: Set<string> = new Set();
  private readonly _connectionRetries: Map<string, number> = new Map();

  private _status: DiscoveryStatus = 'stopped';
  private _broadcastTimer: ReturnType<typeof setInterval> | null = null;
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Store bound handlers for proper cleanup
  private readonly _boundBroadcast: () => Promise<void>;
  private readonly _boundCleanup: () => void;

  // Optional callback for BTP connection
  private _btpConnector?: (btpEndpoint: string) => Promise<void>;

  constructor(config: PeerDiscoveryConfig, logger: Logger) {
    this._config = {
      ...config,
      broadcastInterval: config.broadcastInterval || DEFAULT_BROADCAST_INTERVAL,
    };
    this._logger = logger.child({ component: 'PeerDiscoveryService' });

    // Bind handlers in constructor for proper cleanup
    this._boundBroadcast = this._performBroadcast.bind(this);
    this._boundCleanup = this._cleanupStalePeers.bind(this);
  }

  /**
   * Get the current discovery service status
   */
  get status(): DiscoveryStatus {
    return this._status;
  }

  /**
   * Set an optional BTP connector function for automatic peer connection
   * @param connector - Function that connects to a BTP endpoint
   */
  setBtpConnector(connector: (btpEndpoint: string) => Promise<void>): void {
    this._btpConnector = connector;
  }

  /**
   * Start the peer discovery service
   */
  async start(): Promise<void> {
    if (this._status !== 'stopped') {
      this._logger.warn('Discovery service already running');
      return;
    }

    if (!this._config.enabled) {
      this._logger.info('Peer discovery is disabled');
      return;
    }

    if (!this._config.discoveryEndpoints || this._config.discoveryEndpoints.length === 0) {
      this._logger.warn('No discovery endpoints configured');
      return;
    }

    this._status = 'starting';
    this._logger.info('Starting peer discovery service');

    try {
      // Perform initial broadcast
      await this._boundBroadcast();

      // Start periodic broadcast
      const intervalMs = this._config.broadcastInterval * 1000;
      this._broadcastTimer = setInterval(() => {
        this._boundBroadcast().catch((err) => {
          this._logger.error({ err }, 'Broadcast failed');
        });
      }, intervalMs);

      // Start periodic cleanup of stale peers
      this._cleanupTimer = setInterval(this._boundCleanup, intervalMs);

      this._status = 'running';
      this._logger.info('Peer discovery service started');
    } catch (error) {
      this._status = 'stopped';
      this._logger.error({ error }, 'Failed to start peer discovery service');
      throw error;
    }
  }

  /**
   * Stop the peer discovery service
   */
  stop(): void {
    if (this._status === 'stopped') {
      return;
    }

    this._status = 'stopping';
    this._logger.info('Stopping peer discovery service');

    // Clear timers
    if (this._broadcastTimer) {
      clearInterval(this._broadcastTimer);
      this._broadcastTimer = null;
    }

    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }

    // Deregister from discovery endpoints (fire and forget)
    this._deregisterFromEndpoints().catch((err) => {
      this._logger.warn({ err }, 'Deregistration failed during shutdown');
    });

    this._status = 'stopped';
    this._logger.info('Peer discovery service stopped');
  }

  /**
   * Broadcast connector availability to all discovery endpoints
   */
  async broadcastAvailability(): Promise<void> {
    await this._boundBroadcast();
  }

  /**
   * Get the list of discovered peers
   * @returns Array of discovered peer info
   */
  getDiscoveredPeers(): PeerInfo[] {
    return Array.from(this._discoveredPeers.values());
  }

  /**
   * Connect to a discovered peer
   * @param peerInfo - The peer to connect to
   */
  async connectToPeer(peerInfo: PeerInfo): Promise<void> {
    if (this._connectedPeers.has(peerInfo.nodeId)) {
      this._logger.debug({ nodeId: peerInfo.nodeId }, 'Already connected to peer');
      return;
    }

    if (!this._btpConnector) {
      this._logger.warn('No BTP connector configured, skipping peer connection');
      return;
    }

    const retries = this._connectionRetries.get(peerInfo.nodeId) || 0;
    if (retries >= MAX_CONNECTION_RETRIES) {
      this._logger.warn(
        { nodeId: peerInfo.nodeId, retries },
        'Max connection retries exceeded, skipping peer'
      );
      return;
    }

    try {
      this._logger.info(
        { nodeId: peerInfo.nodeId, endpoint: peerInfo.btpEndpoint },
        'Connecting to peer'
      );
      await this._btpConnector(peerInfo.btpEndpoint);
      this._connectedPeers.add(peerInfo.nodeId);
      this._connectionRetries.delete(peerInfo.nodeId);
      this._logger.info({ nodeId: peerInfo.nodeId }, 'Connected to peer');
    } catch (error) {
      this._connectionRetries.set(peerInfo.nodeId, retries + 1);
      this._logger.error(
        { nodeId: peerInfo.nodeId, error, retries: retries + 1 },
        'Failed to connect to peer'
      );

      // Schedule retry if under max retries
      if (retries + 1 < MAX_CONNECTION_RETRIES) {
        setTimeout(() => {
          this.connectToPeer(peerInfo).catch(() => {
            // Retry errors already logged
          });
        }, CONNECTION_RETRY_DELAY);
      }

      throw error;
    }
  }

  /**
   * Perform broadcast to all discovery endpoints
   */
  private async _performBroadcast(): Promise<void> {
    if (!this._config.discoveryEndpoints) {
      return;
    }

    const peerInfo: Omit<PeerInfo, 'lastSeen'> = {
      nodeId: this._config.nodeId,
      btpEndpoint: this._config.announceAddress || this._config.btpEndpoint,
      ilpAddress: this._config.ilpAddress,
      capabilities: this._config.capabilities,
      version: this._config.version,
    };

    const announcePromises = this._config.discoveryEndpoints.map(async (endpoint) => {
      try {
        await this._announceToEndpoint(endpoint, peerInfo);
        await this._fetchPeersFromEndpoint(endpoint);
      } catch (error) {
        this._logger.warn({ endpoint, error }, 'Discovery endpoint unavailable');
        // Continue with other endpoints
      }
    });

    await Promise.allSettled(announcePromises);
  }

  /**
   * Announce to a single discovery endpoint
   */
  private async _announceToEndpoint(
    endpoint: string,
    peerInfo: Omit<PeerInfo, 'lastSeen'>
  ): Promise<void> {
    const url = `${endpoint}/api/v1/peers/announce`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(peerInfo),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      throw new Error(`Announce failed: ${response.status} - ${text}`);
    }

    const result = (await response.json()) as AnnounceResponse;

    if (!result.success) {
      throw new Error(`Announce rejected: ${result.error || 'Unknown error'}`);
    }

    this._logger.debug({ endpoint, ttl: result.ttl }, 'Announced to discovery endpoint');
  }

  /**
   * Fetch peers from a single discovery endpoint
   */
  private async _fetchPeersFromEndpoint(endpoint: string): Promise<void> {
    const url = `${endpoint}/api/v1/peers`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Fetch peers failed: ${response.status}`);
    }

    const result = (await response.json()) as PeerListResponse;

    for (const peer of result.peers) {
      // Skip self
      if (peer.nodeId === this._config.nodeId) {
        continue;
      }

      const existingPeer = this._discoveredPeers.get(peer.nodeId);
      if (!existingPeer || peer.lastSeen > existingPeer.lastSeen) {
        this._discoveredPeers.set(peer.nodeId, peer);

        if (!existingPeer) {
          this._logger.info(
            { nodeId: peer.nodeId, endpoint: peer.btpEndpoint },
            'Discovered new peer'
          );
        }
      }
    }
  }

  /**
   * Deregister from all discovery endpoints
   */
  private async _deregisterFromEndpoints(): Promise<void> {
    if (!this._config.discoveryEndpoints) {
      return;
    }

    const deregisterPromises = this._config.discoveryEndpoints.map(async (endpoint) => {
      try {
        const url = `${endpoint}/api/v1/peers/${encodeURIComponent(this._config.nodeId)}`;

        await fetch(url, {
          method: 'DELETE',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(2000),
        });

        this._logger.debug({ endpoint }, 'Deregistered from discovery endpoint');
      } catch (error) {
        // Ignore deregistration errors during shutdown
        this._logger.debug({ endpoint, error }, 'Deregistration failed');
      }
    });

    await Promise.allSettled(deregisterPromises);
  }

  /**
   * Clean up stale peers that haven't been seen recently
   */
  private _cleanupStalePeers(): void {
    const now = Date.now();
    const maxAge = DEFAULT_PEER_TTL * 1000;

    for (const [nodeId, peer] of this._discoveredPeers.entries()) {
      if (now - peer.lastSeen > maxAge) {
        this._discoveredPeers.delete(nodeId);
        this._connectedPeers.delete(nodeId);
        this._connectionRetries.delete(nodeId);
        this._logger.info({ nodeId }, 'Removed stale peer');
      }
    }
  }
}
