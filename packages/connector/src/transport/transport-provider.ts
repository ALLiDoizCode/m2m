/**
 * Transport Provider Interface
 *
 * Pluggable transport abstraction for outbound BTP WebSocket connections.
 * Implementations control how the connector establishes TCP connections to peers.
 *
 * Epic 35 Story 35.1
 *
 * @module transport-provider
 */

import type http from 'http';

/**
 * Pluggable transport abstraction for outbound BTP WebSocket connections.
 *
 * Implementations control how the connector establishes TCP connections to peers:
 * - `DirectTransportProvider`: uses default Node.js networking (no proxy)
 * - `SocksTransportProvider` (Story 35.2): routes through a SOCKS5 proxy (e.g., ATOR)
 *
 * The returned `http.Agent` (or `undefined`) is passed to the `ws` WebSocket
 * constructor's `agent` option.
 */
export interface TransportProvider {
  /**
   * Create an HTTP agent for outbound WebSocket connections to a peer.
   * DirectTransportProvider returns undefined (use Node.js default agent).
   * SocksTransportProvider (Story 35.2) returns a SocksProxyAgent.
   *
   * The returned agent is passed to the `ws` WebSocket constructor's `agent` option.
   * When undefined, `ws` uses its default connection behavior.
   *
   * @param peerUrl - WebSocket URL of the peer to connect to
   * @returns An HTTP agent for the connection, or undefined to use the default agent
   */
  createAgent(peerUrl: string): http.Agent | undefined;

  /**
   * Get this node's externally reachable URL for inbound peering.
   * For direct transport, this is the configured public URL (e.g., "wss://mynode:3000/btp").
   * For SOCKS5 transport, this is the .anon hidden service URL.
   *
   * @returns The externally reachable WebSocket URL for this node
   */
  getExternalUrl(): string;

  /**
   * Initialize the transport provider. Called during connector startup.
   * DirectTransportProvider: no-op.
   * SocksTransportProvider: validates proxy connectivity.
   *
   * @returns Resolves when the provider is ready to create agents
   */
  start(): Promise<void>;

  /**
   * Shut down the transport provider. Called during connector shutdown.
   * DirectTransportProvider: no-op.
   * SocksTransportProvider: no-op (unless managed).
   *
   * @returns Resolves when the provider has released all resources
   */
  stop(): Promise<void>;

  /**
   * Check transport health. Used by the health endpoint.
   * DirectTransportProvider: always returns true.
   * SocksTransportProvider: probes SOCKS5 proxy connectivity.
   *
   * @returns `true` if the transport is healthy, `false` otherwise
   */
  healthCheck(): Promise<boolean>;
}
