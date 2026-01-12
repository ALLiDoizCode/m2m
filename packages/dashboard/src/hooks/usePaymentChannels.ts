/**
 * Custom React hook for payment channel state management
 * Subscribes to payment channel telemetry events and maintains channel state
 */

import { useState, useEffect } from 'react';
import { useTelemetry } from './useTelemetry';
import type {
  DashboardChannelState,
  PaymentChannelOpenedEvent,
  PaymentChannelBalanceUpdateEvent,
  PaymentChannelSettledEvent,
} from '@m2m/shared';
import { createLogger } from '../utils/logger';

const logger = createLogger('usePaymentChannels');

/**
 * Hook result interface
 */
export interface UsePaymentChannelsResult {
  channels: DashboardChannelState[];
  loading: boolean;
  error: Error | null;
}

/**
 * Custom hook to track payment channel state from telemetry events
 * Listens for PAYMENT_CHANNEL_OPENED, PAYMENT_CHANNEL_BALANCE_UPDATE, and PAYMENT_CHANNEL_SETTLED events
 */
export function usePaymentChannels(): UsePaymentChannelsResult {
  const { events, connected, error: telemetryError } = useTelemetry();
  const [channels, setChannels] = useState<DashboardChannelState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    // Set loading state based on connection status
    if (connected) {
      setLoading(false);
    }

    // Set error from telemetry connection
    if (telemetryError) {
      setError(telemetryError);
    }
  }, [connected, telemetryError]);

  useEffect(() => {
    // Process each new event
    if (events.length === 0) {
      return;
    }

    const latestEvent = events[events.length - 1];
    if (!latestEvent) {
      return;
    }

    try {
      if (latestEvent.type === 'PAYMENT_CHANNEL_OPENED') {
        const event = latestEvent as unknown as PaymentChannelOpenedEvent;

        // Create new channel state
        const newChannel: DashboardChannelState = {
          channelId: event.channelId,
          nodeId: event.nodeId,
          peerId: event.peerId,
          participants: event.participants,
          tokenAddress: event.tokenAddress,
          tokenSymbol: event.tokenSymbol,
          settlementTimeout: event.settlementTimeout,
          deposits: event.initialDeposits,
          myNonce: 0,
          theirNonce: 0,
          myTransferred: '0',
          theirTransferred: '0',
          status: 'active',
          openedAt: event.timestamp,
          lastActivityAt: event.timestamp,
        };

        setChannels((prev) => {
          // Check if channel already exists (avoid duplicates)
          if (prev.find((ch) => ch.channelId === newChannel.channelId)) {
            return prev;
          }
          return [...prev, newChannel];
        });

        logger.debug({ channelId: event.channelId }, 'Payment channel opened');
      } else if (latestEvent.type === 'PAYMENT_CHANNEL_BALANCE_UPDATE') {
        const event = latestEvent as unknown as PaymentChannelBalanceUpdateEvent;

        setChannels((prev) =>
          prev.map((channel) => {
            if (channel.channelId === event.channelId) {
              return {
                ...channel,
                myNonce: event.myNonce,
                theirNonce: event.theirNonce,
                myTransferred: event.myTransferred,
                theirTransferred: event.theirTransferred,
                lastActivityAt: event.timestamp,
              };
            }
            return channel;
          })
        );

        logger.debug({ channelId: event.channelId }, 'Payment channel balance updated');
      } else if (latestEvent.type === 'PAYMENT_CHANNEL_SETTLED') {
        const event = latestEvent as unknown as PaymentChannelSettledEvent;

        setChannels((prev) =>
          prev.map((channel) => {
            if (channel.channelId === event.channelId) {
              return {
                ...channel,
                status: 'settled',
                settledAt: event.timestamp,
              };
            }
            return channel;
          })
        );

        logger.info({ channelId: event.channelId }, 'Payment channel settled');

        // Remove settled channels after 5 minutes
        setTimeout(
          () => {
            setChannels((prev) => prev.filter((ch) => ch.channelId !== event.channelId));
            logger.debug({ channelId: event.channelId }, 'Settled channel removed from state');
          },
          5 * 60 * 1000
        );
      }
    } catch (err) {
      logger.error({ error: err }, 'Failed to process payment channel event');
      setError(err instanceof Error ? err : new Error('Unknown error processing channel event'));
    }
  }, [events]);

  return { channels, loading, error };
}
