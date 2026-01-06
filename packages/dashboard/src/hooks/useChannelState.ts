/**
 * Custom React hook for tracking payment channel state
 * Listens for PAYMENT_CHANNEL_* events and maintains channel state map
 */

import { useState, useEffect } from 'react';
import { TelemetryEvent } from './useTelemetry';
import {
  PaymentChannelOpenedEvent,
  PaymentChannelBalanceUpdateEvent,
  PaymentChannelSettledEvent,
} from '@m2m/shared';

/**
 * Channel State
 * Represents the current state of a payment channel in the dashboard
 */
export interface ChannelState {
  channelId: string;
  nodeId: string;
  participants: [string, string];
  tokenAddress: string;
  tokenSymbol: string;
  status: 'opening' | 'active' | 'settling' | 'settled' | 'disputed';
  settlementTimeout: number;
  initialDeposits: { [participant: string]: string };
  currentBalances: {
    myNonce: number;
    theirNonce: number;
    myTransferred: string;
    theirTransferred: string;
  };
  openedAt: number;
  settledAt?: number;
  settlementType?: 'cooperative' | 'unilateral' | 'disputed';
}

/**
 * Initial channel state event from backend
 */
interface InitialChannelStateEvent {
  type: 'INITIAL_CHANNEL_STATE';
  data: {
    channels: ChannelState[];
  };
}

/**
 * Hook interface for channel state
 */
export interface UseChannelStateResult {
  channels: Map<string, ChannelState>;
  getChannelsByParticipants: (participant1: string, participant2: string) => ChannelState[];
  getAllChannels: () => ChannelState[];
}

/**
 * Custom hook to track payment channel state from telemetry events
 */
export function useChannelState(events: TelemetryEvent[]): UseChannelStateResult {
  const [channels, setChannels] = useState<Map<string, ChannelState>>(new Map());

  useEffect(() => {
    // Process only the latest event
    if (events.length === 0) return;
    const latestEvent = events[events.length - 1];
    if (!latestEvent) return;

    setChannels((prevChannels) => {
      const newChannels = new Map(prevChannels);

      switch (latestEvent.type) {
        case 'PAYMENT_CHANNEL_OPENED': {
          const event = latestEvent as unknown as PaymentChannelOpenedEvent;
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
          newChannels.set(event.channelId, channelState);
          break;
        }

        case 'PAYMENT_CHANNEL_BALANCE_UPDATE': {
          const event = latestEvent as unknown as PaymentChannelBalanceUpdateEvent;
          const existingChannel = newChannels.get(event.channelId);
          if (existingChannel) {
            newChannels.set(event.channelId, {
              ...existingChannel,
              currentBalances: {
                myNonce: event.myNonce,
                theirNonce: event.theirNonce,
                myTransferred: event.myTransferred,
                theirTransferred: event.theirTransferred,
              },
            });
          }
          break;
        }

        case 'PAYMENT_CHANNEL_SETTLED': {
          const event = latestEvent as unknown as PaymentChannelSettledEvent;
          const existingChannel = newChannels.get(event.channelId);
          if (existingChannel) {
            newChannels.set(event.channelId, {
              ...existingChannel,
              status: 'settled',
              settledAt: event.timestamp,
              settlementType: event.settlementType,
            });
          }
          break;
        }

        case 'INITIAL_CHANNEL_STATE': {
          // Handle initial state load from backend
          const event = latestEvent as unknown as InitialChannelStateEvent;
          const channelStates = event.data?.channels;
          if (channelStates && Array.isArray(channelStates)) {
            channelStates.forEach((channelState) => {
              newChannels.set(channelState.channelId, channelState);
            });
          }
          break;
        }
      }

      return newChannels;
    });
  }, [events]);

  // Helper function to get channels by participants
  const getChannelsByParticipants = (
    participant1: string,
    participant2: string
  ): ChannelState[] => {
    const channelList: ChannelState[] = [];
    channels.forEach((channel) => {
      const [p1, p2] = channel.participants;
      if (
        (p1.toLowerCase() === participant1.toLowerCase() &&
          p2.toLowerCase() === participant2.toLowerCase()) ||
        (p1.toLowerCase() === participant2.toLowerCase() &&
          p2.toLowerCase() === participant1.toLowerCase())
      ) {
        channelList.push(channel);
      }
    });
    return channelList;
  };

  // Helper function to get all channels as array
  const getAllChannels = (): ChannelState[] => {
    return Array.from(channels.values());
  };

  return {
    channels,
    getChannelsByParticipants,
    getAllChannels,
  };
}
