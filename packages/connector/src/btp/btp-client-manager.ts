/**
 * BTP Client Manager
 * Manages multiple BTPClient instances for outbound peer connections
 */

import type http from 'http';
import { Logger } from '../utils/logger';
import { BTPClient, Peer, BTPConnectionError } from './btp-client';
import { ILPPreparePacket, ILPFulfillPacket, ILPRejectPacket } from '@toon-protocol/shared';
import type { PacketHandler } from '../core/packet-handler';
import { redactPeerUrl, redactAnonInMessage } from '../utils/redact';

/**
 * BTPClientManager - Orchestrates multiple BTP client connections
 * Maintains one BTPClient instance per peer and routes packets to appropriate clients
 */
export class BTPClientManager {
  private readonly _clients: Map<string, BTPClient> = new Map();
  private readonly _logger: Logger;
  private readonly _nodeId: string;
  private _packetHandler: PacketHandler | null = null;
  private _agentFactory: ((peer: Peer) => http.Agent | undefined) | null = null;
  private _onConnectionStateChange: (() => void) | null = null;

  /**
   * Create BTPClientManager instance
   * @param nodeId - Local node identifier
   * @param logger - Pino logger instance
   */
  constructor(nodeId: string, logger: Logger) {
    this._nodeId = nodeId;
    this._logger = logger.child({ component: 'BTPClientManager' });
  }

  /**
   * Provide an agent factory for outbound BTP connections (Story 35.4 +
   * per-peer transport dispatch).
   *
   * Forwarded to every `BTPClient` created via `addPeer`. The factory
   * receives the full `Peer` (not just the URL) so per-peer transport
   * dispatch can branch on `peer.transport`. It is invoked once per
   * `connect()` attempt (not cached at client construction), so SOCKS5
   * transports can return a fresh `SocksProxyAgent` per call.
   *
   * **The factory MAY throw synchronously.** Per-peer dispatch's
   * defense-in-depth path throws when a peer requests `'socks5'` but
   * the connector has no SOCKS5 provider wired (AC-11 in the per-peer
   * transport tech spec). Throws are caught by `BTPClient.connect()`'s
   * outer try/catch and surface as `BTPConnectionError`.
   *
   * Safe to call at any time before `addPeer`. Null disables the factory
   * (i.e., WebSockets are constructed with no options bag).
   */
  setAgentFactory(factory: ((peer: Peer) => http.Agent | undefined) | null): void {
    this._agentFactory = factory;
  }

  /**
   * Register a callback invoked whenever any managed peer's BTP connection
   * state changes (connect or disconnect).
   *
   * This exists so the connector can re-evaluate derived state — notably its
   * `/health` status — as peers connect/disconnect AFTER startup, rather than
   * relying on a single snapshot taken at boot. Without this hook the health
   * status freezes at whatever the peer set looked like at the instant the
   * one-shot evaluation ran during start().
   *
   * The callback is fired synchronously from the client's 'connected' /
   * 'disconnected' event handlers and MUST NOT throw; it is wrapped in a
   * try/catch so a faulty consumer cannot destabilize the BTP event loop.
   *
   * @param callback - invoked on every connect/disconnect; null disables it.
   */
  setConnectionStateChangeCallback(callback: (() => void) | null): void {
    this._onConnectionStateChange = callback;
  }

  /**
   * Invoke the connection-state-change callback (if registered), guarding
   * against throws so a faulty consumer cannot break BTP event handling.
   */
  private _notifyConnectionStateChange(): void {
    if (!this._onConnectionStateChange) return;
    try {
      this._onConnectionStateChange();
    } catch (error) {
      this._logger.warn(
        {
          event: 'btp_connection_state_callback_error',
          error: error instanceof Error ? error.message : String(error),
        },
        'Connection-state-change callback threw; ignoring'
      );
    }
  }

  /**
   * Set PacketHandler reference (to handle incoming prepare packets from servers)
   * @param packetHandler - PacketHandler instance for routing incoming packets
   */
  setPacketHandler(packetHandler: PacketHandler): void {
    this._packetHandler = packetHandler;
    // Update existing clients
    for (const client of this._clients.values()) {
      client.setPacketHandler(packetHandler);
    }
  }

  /**
   * Add a peer and establish BTP connection
   * Creates BTPClient instance for the peer and initiates connection
   * @param peer - Peer configuration
   */
  async addPeer(peer: Peer): Promise<void> {
    this._logger.info(
      {
        event: 'btp_client_add_peer',
        peerId: peer.id,
        url: redactPeerUrl(peer.url),
        // `null` when the peer inherits the connector-level default;
        // explicit-null beats a `<default>` sentinel because log-shippers
        // can still grep `transport: "direct"` / `transport: "socks5"`
        // without collisions on peers literally named `<default>`.
        transport: peer.transport ?? null,
      },
      'Adding peer'
    );

    // Check if peer already exists
    if (this._clients.has(peer.id)) {
      this._logger.warn(
        { event: 'btp_client_peer_exists', peerId: peer.id },
        'Peer already exists, skipping'
      );
      return;
    }

    // Create BTPClient for peer. Forward agentFactory (when configured) so
    // SOCKS5 transports can provide a fresh SocksProxyAgent per connect
    // (Story 35.4). When no factory is set, preserve the pre-Epic-35
    // 3-argument constructor call shape byte-for-byte (regression guard).
    const client = this._agentFactory
      ? new BTPClient(peer, this._nodeId, this._logger, undefined, this._agentFactory)
      : new BTPClient(peer, this._nodeId, this._logger);

    // Set PacketHandler if available (for handling incoming prepare packets)
    if (this._packetHandler) {
      client.setPacketHandler(this._packetHandler);
    }

    // Set up event listeners for connection state tracking
    client.on('connected', () => {
      this._logger.info(
        { event: 'btp_client_connected', peerId: peer.id },
        'BTP client connected to peer'
      );
      // Re-evaluate connector-derived state (e.g. /health) now that a peer
      // connected — possibly long after the boot-time snapshot.
      this._notifyConnectionStateChange();
    });

    client.on('disconnected', () => {
      this._logger.warn(
        { event: 'btp_client_disconnected', peerId: peer.id },
        'BTP client disconnected from peer'
      );
      // Re-evaluate connector-derived state (e.g. /health) so a peer dropping
      // below the healthy threshold is reflected promptly.
      this._notifyConnectionStateChange();
    });

    client.on('error', (error: Error) => {
      this._logger.error(
        {
          event: 'btp_client_error',
          peerId: peer.id,
          error: redactAnonInMessage(error.message),
        },
        'BTP client error'
      );
    });

    // Store client before connecting
    this._clients.set(peer.id, client);

    // Bounded await: wait for the initial connection attempt, but cap at
    // BTP_CONNECT_TIMEOUT_MS (default 5 s) so hidden-service peers (30-90 s
    // circuit establishment) don't block addPeer indefinitely. If the timeout
    // fires first the connection continues in the background — BTPClient emits
    // 'connected' when established and retries on failure regardless. addPeer
    // always resolves so the HTTP handler always returns 201 quickly while
    // startup's getPeerStatus() correctly sees which peers connected in time.
    const connectTimeoutMs = parseInt(process.env.BTP_CONNECT_TIMEOUT_MS ?? '5000', 10);
    const connectTimeout = new Promise<void>((resolve) => setTimeout(resolve, connectTimeoutMs));
    await Promise.race([
      client.connect().catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this._logger.warn(
          {
            event: 'btp_client_add_peer_failed',
            peerId: peer.id,
            error: redactAnonInMessage(errorMessage),
          },
          'Initial connection to peer failed (will retry in background)'
        );
      }),
      connectTimeout,
    ]);
    this._logger.info({ event: 'btp_client_peer_added', peerId: peer.id }, 'Peer registered');
  }

  /**
   * Remove a peer and disconnect BTP connection
   * Gracefully disconnects and removes BTPClient instance
   * @param peerId - Peer identifier
   */
  async removePeer(peerId: string): Promise<void> {
    this._logger.info({ event: 'btp_client_remove_peer', peerId }, 'Removing peer');

    const client = this._clients.get(peerId);
    if (!client) {
      this._logger.warn(
        { event: 'btp_client_peer_not_found', peerId },
        'Peer not found, cannot remove'
      );
      return;
    }

    try {
      // Disconnect from peer
      await client.disconnect();
      this._logger.info(
        { event: 'btp_client_peer_removed', peerId },
        'Peer disconnected and removed'
      );
    } finally {
      // Always remove from map, even if disconnect fails
      this._clients.delete(peerId);
    }
  }

  /**
   * Send ILP packet to specific peer
   * Routes packet to appropriate BTPClient based on peer ID
   * @param peerId - Target peer identifier
   * @param packet - ILP Prepare packet to send
   * @returns ILP response packet (Fulfill or Reject)
   * @throws Error if peer not found or connection fails
   */
  async sendToPeer(
    peerId: string,
    packet: ILPPreparePacket,
    protocolData?: Array<{ protocolName: string; contentType: number; data: Buffer }>
  ): Promise<ILPFulfillPacket | ILPRejectPacket> {
    this._logger.debug(
      { event: 'btp_client_send_to_peer', peerId, destination: packet.destination },
      'Sending packet to peer'
    );

    // Look up BTPClient for peer
    const client = this._clients.get(peerId);
    if (!client) {
      const errorMessage = `Peer not found: ${peerId}`;
      this._logger.error({ event: 'btp_client_peer_not_found', peerId }, errorMessage);
      throw new Error(errorMessage);
    }

    // Check connection state before sending
    if (!client.isConnected) {
      const errorMessage = `BTP connection to ${peerId} not established`;
      this._logger.error({ event: 'btp_client_not_connected', peerId }, errorMessage);
      throw new BTPConnectionError(errorMessage);
    }

    try {
      // Derive timeout from the ILP packet's expiresAt — the protocol-level timeout.
      // This ensures BTP waits as long as the packet is valid, regardless of hop count.
      // Fall back to env var only if expiresAt is missing (shouldn't happen for valid packets).
      let timeoutMs: number;
      if (packet.expiresAt) {
        const remaining = packet.expiresAt.getTime() - Date.now();
        // Use remaining time with a small buffer (500ms) for local processing
        timeoutMs = Math.max(remaining - 500, 1000);
      } else {
        timeoutMs = parseInt(process.env.BTP_SEND_TIMEOUT_MS ?? '30000', 10);
      }
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new BTPConnectionError(`BTP send timeout to ${peerId} (${timeoutMs}ms)`));
        }, timeoutMs);
      });

      // Race between sendPacket and timeout
      const response = await Promise.race([
        client.sendPacket(packet, protocolData),
        timeoutPromise,
      ]);

      this._logger.debug(
        { event: 'btp_client_packet_sent', peerId, destination: packet.destination },
        'Packet sent successfully to peer'
      );

      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this._logger.error(
        { event: 'btp_client_send_failed', peerId, error: errorMessage },
        'Failed to send packet to peer'
      );
      throw error;
    }
  }

  /**
   * Get connection status for all peers
   * @returns Map of peer IDs to connection states
   */
  getPeerStatus(): Map<string, boolean> {
    const status = new Map<string, boolean>();
    for (const [peerId, client] of this._clients) {
      status.set(peerId, client.isConnected);
    }
    return status;
  }

  /**
   * Get list of all peer IDs
   * @returns Array of peer identifiers
   */
  getPeerIds(): string[] {
    return Array.from(this._clients.keys());
  }

  /**
   * Get BTPClient instance for a specific peer
   * @param peerId - Peer identifier
   * @returns BTPClient instance if peer exists, undefined otherwise
   * @remarks Used by settlement system to send off-chain claims via BTP protocolData
   */
  getClientForPeer(peerId: string): BTPClient | undefined {
    return this._clients.get(peerId);
  }

  /**
   * Get the per-peer transport override for a peer, or `undefined` when
   * the peer inherits the connector-level default (including when the
   * peer is unknown). Canonical accessor for admin / SDK surfaces that
   * need to surface the live (post-construction) transport — re-reads
   * from the `BTPClient`'s `_peer` record on every call.
   */
  getPeerTransport(peerId: string): 'direct' | undefined {
    return this._clients.get(peerId)?.getTransport();
  }

  /**
   * Check if a specific peer is currently connected
   * @param peerId - Peer identifier
   * @returns true if peer is connected, false otherwise
   * @remarks Returns false if peer doesn't exist or connection is not established
   */
  isConnected(peerId: string): boolean {
    const client = this._clients.get(peerId);
    return client ? client.isConnected : false;
  }

  /**
   * Get count of currently connected peers
   * @returns Number of peers with active BTP connections
   * @remarks Used by health check system to determine connector operational status
   */
  getConnectedPeerCount(): number {
    const peerStatus = this.getPeerStatus();
    return Array.from(peerStatus.values()).filter(Boolean).length;
  }

  /**
   * Get total number of configured peers
   * @returns Total count of peers regardless of connection state
   * @remarks Used by health check system to calculate connection percentage
   */
  getTotalPeerCount(): number {
    return this._clients.size;
  }

  /**
   * Get connection health percentage
   * @returns Percentage of connected peers (0-100)
   * @remarks Returns 100 if no peers are configured (standalone mode is considered healthy)
   */
  getConnectionHealth(): number {
    const totalCount = this.getTotalPeerCount();
    if (totalCount === 0) {
      return 100; // No peers configured is considered healthy
    }
    const connectedCount = this.getConnectedPeerCount();
    return (connectedCount / totalCount) * 100;
  }
}
