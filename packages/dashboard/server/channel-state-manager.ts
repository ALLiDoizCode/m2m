/**
 * Channel State Manager
 * Manages in-memory payment channel state for dashboard visualization
 * @packageDocumentation
 */

import type { Logger } from 'pino';
import {
  PaymentChannelOpenedEvent,
  PaymentChannelBalanceUpdateEvent,
  PaymentChannelSettledEvent,
} from '@m2m/shared';

/**
 * Type for channel telemetry events
 */
type ChannelTelemetryEvent =
  | PaymentChannelOpenedEvent
  | PaymentChannelBalanceUpdateEvent
  | PaymentChannelSettledEvent;

/**
 * Channel State
 * Represents the current state of a payment channel tracked by the dashboard
 */
export interface ChannelState {
  /** Unique channel identifier (bytes32 hex string) */
  channelId: string;
  /** Connector node ID that owns this channel */
  nodeId: string;
  /** Ethereum addresses of both channel participants [participant1, participant2] */
  participants: [string, string];
  /** ERC20 token contract address */
  tokenAddress: string;
  /** Human-readable token symbol (e.g., "USDC") */
  tokenSymbol: string;
  /** Channel status: opening, active, settling, settled, disputed */
  status: 'opening' | 'active' | 'settling' | 'settled' | 'disputed';
  /** Challenge period duration in seconds */
  settlementTimeout: number;
  /** Initial deposits keyed by participant address, bigint as string */
  initialDeposits: { [participant: string]: string };
  /** Current balance state (nonces and cumulative transferred amounts) */
  currentBalances: {
    myNonce: number;
    theirNonce: number;
    myTransferred: string;
    theirTransferred: string;
  };
  /** Unix timestamp (ms) when channel was opened */
  openedAt: number;
  /** Unix timestamp (ms) when channel was settled (if applicable) */
  settledAt?: number;
  /** Settlement method (if channel settled): cooperative, unilateral, or disputed */
  settlementType?: 'cooperative' | 'unilateral' | 'disputed';
}

/**
 * Channel State Manager
 * Manages payment channel state and broadcasts updates to dashboard clients
 */
export class ChannelStateManager {
  private channels: Map<string, ChannelState> = new Map();
  private logger: Logger;
  private broadcastFn: (message: ChannelTelemetryEvent) => void;

  /**
   * @param logger - Pino logger instance
   * @param broadcastFn - Function to broadcast messages to all dashboard clients
   */
  constructor(logger: Logger, broadcastFn: (message: ChannelTelemetryEvent) => void) {
    this.logger = logger;
    this.broadcastFn = broadcastFn;
  }

  /**
   * Handle PAYMENT_CHANNEL_OPENED event
   * Creates new channel state and broadcasts to all dashboard clients
   */
  handleChannelOpened(event: PaymentChannelOpenedEvent): void {
    try {
      const channelState: ChannelState = {
        channelId: event.channelId,
        nodeId: event.nodeId,
        participants: event.participants,
        tokenAddress: event.tokenAddress,
        tokenSymbol: event.tokenSymbol,
        status: 'active',
        settlementTimeout: event.settlementTimeout,
        initialDeposits: event.initialDeposits,
        currentBalances: {
          myNonce: 0,
          theirNonce: 0,
          myTransferred: '0',
          theirTransferred: '0',
        },
        openedAt: event.timestamp,
      };

      this.channels.set(event.channelId, channelState);

      this.logger.info('Payment channel opened', {
        channelId: event.channelId,
        nodeId: event.nodeId,
        tokenSymbol: event.tokenSymbol,
        participants: event.participants,
      });

      // Broadcast channel opened event to all dashboard clients
      this.broadcastFn(event);
    } catch (error) {
      this.logger.warn('Failed to handle channel opened event', {
        error: error instanceof Error ? error.message : 'Unknown error',
        channelId: event.channelId,
      });
    }
  }

  /**
   * Handle PAYMENT_CHANNEL_BALANCE_UPDATE event
   * Updates channel balance state and broadcasts to all dashboard clients
   */
  handleBalanceUpdate(event: PaymentChannelBalanceUpdateEvent): void {
    try {
      const channel = this.channels.get(event.channelId);

      if (!channel) {
        this.logger.warn('Balance update for unknown channel', {
          channelId: event.channelId,
          nodeId: event.nodeId,
        });
        return;
      }

      // Update current balances
      channel.currentBalances = {
        myNonce: event.myNonce,
        theirNonce: event.theirNonce,
        myTransferred: event.myTransferred,
        theirTransferred: event.theirTransferred,
      };

      this.logger.debug('Payment channel balance updated', {
        channelId: event.channelId,
        nodeId: event.nodeId,
        myNonce: event.myNonce,
        theirNonce: event.theirNonce,
      });

      // Broadcast balance update event to all dashboard clients
      this.broadcastFn(event);
    } catch (error) {
      this.logger.warn('Failed to handle balance update event', {
        error: error instanceof Error ? error.message : 'Unknown error',
        channelId: event.channelId,
      });
    }
  }

  /**
   * Handle PAYMENT_CHANNEL_SETTLED event
   * Updates channel status to settled and broadcasts to all dashboard clients
   */
  handleChannelSettled(event: PaymentChannelSettledEvent): void {
    try {
      const channel = this.channels.get(event.channelId);

      if (!channel) {
        this.logger.warn('Settlement event for unknown channel', {
          channelId: event.channelId,
          nodeId: event.nodeId,
        });
        return;
      }

      // Update channel status to settled
      channel.status = 'settled';
      channel.settledAt = event.timestamp;
      channel.settlementType = event.settlementType;

      this.logger.info('Payment channel settled', {
        channelId: event.channelId,
        nodeId: event.nodeId,
        settlementType: event.settlementType,
      });

      // Broadcast channel settled event to all dashboard clients
      this.broadcastFn(event);
    } catch (error) {
      this.logger.warn('Failed to handle channel settled event', {
        error: error instanceof Error ? error.message : 'Unknown error',
        channelId: event.channelId,
      });
    }
  }

  /**
   * Get all tracked channels
   * Used for dashboard initialization when client connects
   * @returns Array of all channel states
   */
  getAllChannels(): ChannelState[] {
    return Array.from(this.channels.values());
  }

  /**
   * Get channels for a specific connector node
   * Used for filtering channels by node in dashboard
   * @param nodeId - Connector node ID
   * @returns Array of channel states for the specified node
   */
  getChannelsByNode(nodeId: string): ChannelState[] {
    return Array.from(this.channels.values()).filter((channel) => channel.nodeId === nodeId);
  }

  /**
   * Get channel by ID
   * @param channelId - Channel identifier
   * @returns Channel state if found, undefined otherwise
   */
  getChannelById(channelId: string): ChannelState | undefined {
    return this.channels.get(channelId);
  }
}
