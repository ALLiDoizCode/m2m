/**
 * EventBroadcaster - WebSocket event broadcasting for Explorer UI
 *
 * Manages WebSocket client connections and broadcasts telemetry events
 * to all connected clients in real-time.
 *
 * @packageDocumentation
 */

import WebSocket, { WebSocketServer } from 'ws';
import { TelemetryEvent } from '@m2m/shared';
import { Logger } from '../utils/logger';

/**
 * EventBroadcaster handles WebSocket client connections and broadcasts
 * telemetry events to all connected clients.
 *
 * Features:
 * - Tracks connected clients in a Set for O(1) lookup
 * - Broadcasts events to all clients with OPEN readyState
 * - Handles individual send failures gracefully (non-blocking)
 * - Provides client count for health monitoring
 * - Supports graceful close of all connections
 */
export class EventBroadcaster {
  private readonly _wss: WebSocketServer;
  private readonly _clients: Set<WebSocket>;
  private readonly _logger: Logger;

  /**
   * Create an EventBroadcaster instance.
   *
   * @param wss - WebSocket.Server instance
   * @param logger - Pino logger instance
   */
  constructor(wss: WebSocketServer, logger: Logger) {
    this._wss = wss;
    this._clients = new Set();
    this._logger = logger.child({ component: 'EventBroadcaster' });

    // Setup connection handler
    this._wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });
  }

  /**
   * Handle new WebSocket client connection.
   *
   * @param ws - WebSocket client connection
   */
  handleConnection(ws: WebSocket): void {
    // Add client to Set
    this._clients.add(ws);

    this._logger.info(
      { event: 'ws_client_connected', clientCount: this._clients.size },
      'WebSocket client connected'
    );

    // Setup close handler
    ws.on('close', () => {
      this._clients.delete(ws);
      this._logger.info(
        { event: 'ws_client_disconnected', clientCount: this._clients.size },
        'WebSocket client disconnected'
      );
    });

    // Setup error handler
    ws.on('error', (error) => {
      this._logger.warn(
        { event: 'ws_client_error', error: error.message },
        'WebSocket client error'
      );
      this._clients.delete(ws);
    });

    // Handle unexpected messages (clients shouldn't send anything)
    ws.on('message', (data) => {
      this._logger.debug(
        { event: 'ws_client_message', size: data.toString().length },
        'Unexpected message from WebSocket client (ignored)'
      );
    });
  }

  /**
   * Broadcast event to all connected clients.
   *
   * @param event - Telemetry event to broadcast
   */
  broadcast(event: TelemetryEvent): void {
    if (this._clients.size === 0) {
      return;
    }

    const json = JSON.stringify(event);

    for (const client of this._clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(json);
        } catch (error) {
          // Log individual send failure but don't block other clients
          this._logger.warn(
            {
              event: 'ws_broadcast_failed',
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            'Failed to send event to WebSocket client'
          );
        }
      }
    }

    this._logger.debug(
      { event: 'ws_broadcast', eventType: event.type, clientCount: this._clients.size },
      'Broadcasted event to WebSocket clients'
    );
  }

  /**
   * Get count of connected clients.
   *
   * @returns Number of connected WebSocket clients
   */
  getClientCount(): number {
    return this._clients.size;
  }

  /**
   * Close all WebSocket connections gracefully.
   *
   * Sends close code 1001 (Going Away) to all clients.
   */
  closeAll(): void {
    this._logger.info(
      { event: 'ws_close_all', clientCount: this._clients.size },
      'Closing all WebSocket connections'
    );

    for (const client of this._clients) {
      try {
        // 1001 = Going Away
        client.close(1001, 'Server shutting down');
      } catch (error) {
        this._logger.debug(
          { error: error instanceof Error ? error.message : 'Unknown error' },
          'Error closing WebSocket client'
        );
      }
    }

    this._clients.clear();
  }
}
