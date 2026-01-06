/**
 * WebSocket Telemetry Server
 * Receives telemetry from connector nodes and broadcasts to dashboard clients
 * @packageDocumentation
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Logger } from 'pino';
import { TelemetryMessage, isTelemetryMessage } from './types.js';
import {
  AccountBalanceEvent,
  SettlementTriggeredEvent,
  SettlementCompletedEvent,
  SettlementState,
  PaymentChannelOpenedEvent,
  PaymentChannelBalanceUpdateEvent,
  PaymentChannelSettledEvent,
} from '@m2m/shared';
import { ChannelStateManager, ChannelState } from './channel-state-manager.js';

/**
 * All types of messages that can be broadcast to dashboard clients
 */
type BroadcastMessage =
  | TelemetryMessage
  | PaymentChannelOpenedEvent
  | PaymentChannelBalanceUpdateEvent
  | PaymentChannelSettledEvent
  | { type: 'INITIAL_CHANNEL_STATE'; data: { channels: ChannelState[] } };

interface WebSocketWithMetadata extends WebSocket {
  nodeId?: string;
  isClient?: boolean;
}

/**
 * Balance State Storage (Story 6.8)
 * Stores current account balances for dashboard visualization
 */
export interface BalanceState {
  peerId: string;
  tokenId: string;
  debitBalance: string;
  creditBalance: string;
  netBalance: string;
  creditLimit?: string;
  settlementThreshold?: string;
  settlementState: SettlementState;
  lastUpdated: string;
}

export class TelemetryServer {
  private wss: WebSocketServer | null = null;
  private connectorConnections: Map<string, WebSocketWithMetadata> = new Map();
  private clientConnections: Set<WebSocketWithMetadata> = new Set();
  private pendingConnections: Set<WebSocketWithMetadata> = new Set();
  private lastNodeStatus: Map<string, TelemetryMessage> = new Map(); // Cache latest NODE_STATUS per connector

  // Settlement telemetry storage (Story 6.8)
  private accountBalances: Map<string, BalanceState> = new Map(); // Key: nodeId:peerId:tokenId
  private settlementEvents: (SettlementTriggeredEvent | SettlementCompletedEvent)[] = [];
  private readonly MAX_SETTLEMENT_EVENTS = 100; // Limit to last 100 events

  // Payment channel state management (Story 8.10)
  private channelStateManager: ChannelStateManager;

  private port: number;
  private logger: Logger;

  constructor(port: number, logger: Logger) {
    this.port = port;
    this.logger = logger;
    // Initialize ChannelStateManager with broadcast function
    this.channelStateManager = new ChannelStateManager(logger, (message) =>
      this.broadcast(message)
    );
  }

  /**
   * Start the WebSocket telemetry server
   */
  start(): void {
    this.wss = new WebSocketServer({ port: this.port });

    this.wss.on('connection', (ws: WebSocketWithMetadata) => {
      this.logger.info('WebSocket connection established');
      this.pendingConnections.add(ws);

      ws.on('message', (data: Buffer) => {
        this.handleMessage(ws, data);
      });

      ws.on('close', () => {
        this.handleClose(ws);
      });

      ws.on('error', (error: Error) => {
        this.logger.error('WebSocket connection error', { error: error.message });
      });
    });

    this.logger.info(`Telemetry WebSocket server listening on port ${this.port}`);
  }

  /**
   * Stop the WebSocket server and close all connections
   */
  stop(): void {
    if (!this.wss) {
      return;
    }

    // Close all connections
    this.connectorConnections.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });

    this.clientConnections.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });

    this.pendingConnections.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });

    // Close server
    this.wss.close();
    this.logger.info('Telemetry server stopped');
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(ws: WebSocketWithMetadata, data: Buffer): void {
    let message: unknown;

    // Level 1: Parse JSON
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      this.logger.warn('Received malformed telemetry message - invalid JSON', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return;
    }

    // Handle CLIENT_CONNECT message before validation (CLIENT_CONNECT doesn't have required telemetry fields)
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'CLIENT_CONNECT'
    ) {
      this.registerClient(ws);
      return;
    }

    // Level 2: Validate required fields
    // Type guard: Ensure message is an object with a type field
    if (typeof message !== 'object' || message === null || !('type' in message)) {
      this.logger.warn('Telemetry message missing type field', { message });
      return;
    }

    // Skip strict validation for channel events (Story 8.10) as they have different structure
    const isChannelEvent = [
      'PAYMENT_CHANNEL_OPENED',
      'PAYMENT_CHANNEL_BALANCE_UPDATE',
      'PAYMENT_CHANNEL_SETTLED',
    ].includes(message.type as string);

    if (!isChannelEvent && !isTelemetryMessage(message)) {
      this.logger.warn('Telemetry message missing required fields', { message });
      return;
    }

    // Handle telemetry events from connectors
    if (this.isTelemetryEvent(message.type)) {
      // Register connector if not already registered
      if (!ws.nodeId && message.nodeId) {
        this.registerConnector(ws, message.nodeId);
      }

      // Cache NODE_STATUS messages for replay to new clients
      if (message.type === 'NODE_STATUS' && message.nodeId) {
        this.lastNodeStatus.set(message.nodeId, message);
      }

      // Handle settlement telemetry events (Story 6.8)
      this.handleSettlementTelemetry(message);

      // Handle payment channel telemetry events (Story 8.10)
      this.handleChannelTelemetry(message);

      // Broadcast to all clients (for non-channel events, channels broadcast themselves)
      const messageType = (message as { type: string }).type;
      if (
        messageType !== 'PAYMENT_CHANNEL_OPENED' &&
        messageType !== 'PAYMENT_CHANNEL_BALANCE_UPDATE' &&
        messageType !== 'PAYMENT_CHANNEL_SETTLED'
      ) {
        this.broadcast(message as BroadcastMessage);
      }
    }
  }

  /**
   * Check if message type is a telemetry event
   */
  private isTelemetryEvent(type: string): boolean {
    return [
      'NODE_STATUS',
      'PACKET_SENT',
      'PACKET_RECEIVED',
      'ROUTE_LOOKUP',
      'LOG',
      'ACCOUNT_BALANCE',
      'SETTLEMENT_TRIGGERED',
      'SETTLEMENT_COMPLETED',
      'PAYMENT_CHANNEL_OPENED',
      'PAYMENT_CHANNEL_BALANCE_UPDATE',
      'PAYMENT_CHANNEL_SETTLED',
    ].includes(type);
  }

  /**
   * Handle payment channel telemetry events (Story 8.10)
   * Delegates to ChannelStateManager for channel state tracking
   */
  private handleChannelTelemetry(message: { type: string }): void {
    try {
      if (message.type === 'PAYMENT_CHANNEL_OPENED') {
        const event = message as PaymentChannelOpenedEvent;
        this.channelStateManager.handleChannelOpened(event);
      } else if (message.type === 'PAYMENT_CHANNEL_BALANCE_UPDATE') {
        const event = message as PaymentChannelBalanceUpdateEvent;
        this.channelStateManager.handleBalanceUpdate(event);
      } else if (message.type === 'PAYMENT_CHANNEL_SETTLED') {
        const event = message as PaymentChannelSettledEvent;
        this.channelStateManager.handleChannelSettled(event);
      }
    } catch (error) {
      this.logger.warn('Failed to process channel telemetry', {
        error: error instanceof Error ? error.message : 'Unknown error',
        messageType: message.type,
      });
    }
  }

  /**
   * Handle settlement telemetry events (Story 6.8)
   * Stores balance state and settlement events in memory for dashboard visualization
   */
  private handleSettlementTelemetry(message: { type: string }): void {
    try {
      if (message.type === 'ACCOUNT_BALANCE') {
        const event = message as AccountBalanceEvent;
        const key = `${event.nodeId}:${event.peerId}:${event.tokenId}`;

        const balanceState: BalanceState = {
          peerId: event.peerId,
          tokenId: event.tokenId,
          debitBalance: event.debitBalance,
          creditBalance: event.creditBalance,
          netBalance: event.netBalance,
          creditLimit: event.creditLimit,
          settlementThreshold: event.settlementThreshold,
          settlementState: event.settlementState,
          lastUpdated: event.timestamp,
        };

        this.accountBalances.set(key, balanceState);
        this.logger.debug('Account balance updated', {
          nodeId: event.nodeId,
          peerId: event.peerId,
          tokenId: event.tokenId,
          creditBalance: event.creditBalance,
        });
      } else if (message.type === 'SETTLEMENT_TRIGGERED') {
        const event = message as SettlementTriggeredEvent;
        this.settlementEvents.push(event);

        // Limit array to last 100 events
        if (this.settlementEvents.length > this.MAX_SETTLEMENT_EVENTS) {
          this.settlementEvents.shift();
        }

        this.logger.info('Settlement triggered event stored', {
          nodeId: event.nodeId,
          peerId: event.peerId,
          tokenId: event.tokenId,
          threshold: event.threshold,
        });
      } else if (message.type === 'SETTLEMENT_COMPLETED') {
        const event = message as SettlementCompletedEvent;
        this.settlementEvents.push(event);

        // Limit array to last 100 events
        if (this.settlementEvents.length > this.MAX_SETTLEMENT_EVENTS) {
          this.settlementEvents.shift();
        }

        this.logger.info('Settlement completed event stored', {
          nodeId: event.nodeId,
          peerId: event.peerId,
          tokenId: event.tokenId,
          success: event.success,
          settledAmount: event.settledAmount,
        });
      }
    } catch (error) {
      this.logger.warn('Failed to process settlement telemetry', {
        error: error instanceof Error ? error.message : 'Unknown error',
        messageType: message.type,
      });
    }
  }

  /**
   * Register a WebSocket as a connector
   */
  private registerConnector(ws: WebSocketWithMetadata, nodeId: string): void {
    this.pendingConnections.delete(ws);
    ws.nodeId = nodeId;
    ws.isClient = false;
    this.connectorConnections.set(nodeId, ws);
    this.logger.info('Connector registered', { nodeId });
  }

  /**
   * Register a WebSocket as a browser client
   */
  private registerClient(ws: WebSocketWithMetadata): void {
    this.pendingConnections.delete(ws);
    ws.isClient = true;
    this.clientConnections.add(ws);
    this.logger.info('Dashboard client connected', {
      cachedNodeStatusCount: this.lastNodeStatus.size,
    });

    // Replay all cached NODE_STATUS messages to the new client
    this.lastNodeStatus.forEach((nodeStatus, nodeId) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(nodeStatus));
        this.logger.info('Replayed cached NODE_STATUS to client', { nodeId });
      }
    });

    // Send initial channel state to new client (Story 8.10)
    const channels = this.channelStateManager.getAllChannels();
    if (channels.length > 0 && ws.readyState === WebSocket.OPEN) {
      const initialStateMessage = {
        type: 'INITIAL_CHANNEL_STATE',
        channels: channels,
      };
      ws.send(JSON.stringify(initialStateMessage));
      this.logger.info('Sent initial channel state to client', {
        channelCount: channels.length,
      });
    }
  }

  /**
   * Handle WebSocket connection close
   */
  private handleClose(ws: WebSocketWithMetadata): void {
    // Remove from pending connections
    this.pendingConnections.delete(ws);

    // Check if it's a connector
    if (ws.nodeId) {
      this.connectorConnections.delete(ws.nodeId);
      this.logger.info('Connector disconnected', { nodeId: ws.nodeId });
      return;
    }

    // Check if it's a client
    if (ws.isClient) {
      this.clientConnections.delete(ws);
      this.logger.info('Dashboard client disconnected');
      return;
    }

    // Unidentified connection closed
    this.logger.debug('Unidentified WebSocket connection closed');
  }

  /**
   * Broadcast telemetry message to all connected clients
   */
  broadcast(message: BroadcastMessage): void {
    const jsonMessage = JSON.stringify(message);

    this.clientConnections.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(jsonMessage);
        } catch (error) {
          this.logger.debug('Failed to send message to client', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          // Remove disconnected client
          this.clientConnections.delete(client);
        }
      }
    });

    this.logger.debug('Broadcasting telemetry event', {
      type: message.type,
      nodeId: message.nodeId,
    });
  }

  /**
   * Get all current account balances (Story 6.8)
   * Used by REST API endpoint for initial dashboard state load
   * @returns Array of all balance states
   */
  getAccountBalances(): BalanceState[] {
    return Array.from(this.accountBalances.values());
  }

  /**
   * Get recent settlement events (Story 6.8)
   * Returns last 100 settlement events (both triggered and completed)
   * Used by REST API endpoint for initial dashboard state load
   * @returns Array of settlement events, sorted by timestamp descending (newest first)
   */
  getSettlementEvents(): (SettlementTriggeredEvent | SettlementCompletedEvent)[] {
    // Return copy sorted by timestamp descending (newest first)
    return [...this.settlementEvents].sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime();
      const timeB = new Date(b.timestamp).getTime();
      return timeB - timeA;
    });
  }

  /**
   * Get all payment channels (Story 8.10)
   * Returns all tracked payment channel states
   * Used by REST API endpoint for initial dashboard state load
   * @returns Array of all channel states
   */
  getChannels(): ChannelState[] {
    return this.channelStateManager.getAllChannels();
  }
}
