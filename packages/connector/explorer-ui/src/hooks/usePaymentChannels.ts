import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { TelemetryEvent, ChannelState } from '../lib/event-types';

interface UsePaymentChannelsOptions {
  /** Reconnect delay in milliseconds */
  reconnectDelay?: number;
  /** Maximum reconnect attempts */
  maxReconnectAttempts?: number;
}

interface UsePaymentChannelsResult {
  /** List of channels sorted by lastActivityAt (most recent first) */
  channels: ChannelState[];
  /** Map of channels by channelId */
  channelsMap: Map<string, ChannelState>;
  /** WebSocket connection status */
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  /** Error message if status is 'error' */
  error: string | null;
  /** Total number of channels */
  totalChannels: number;
  /** Number of active channels */
  activeChannelCount: number;
  /** Clear all channel data */
  clearChannels: () => void;
  /** Manually reconnect */
  reconnect: () => void;
}

const DEFAULT_RECONNECT_DELAY = 1000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;

/**
 * usePaymentChannels hook - tracks payment channel state from WebSocket events
 * Story 14.6 Task 10 - Full implementation
 */
export function usePaymentChannels(
  options: UsePaymentChannelsOptions = {}
): UsePaymentChannelsResult {
  const {
    reconnectDelay = DEFAULT_RECONNECT_DELAY,
    maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS,
  } = options;

  const [channelsMap, setChannelsMap] = useState<Map<string, ChannelState>>(new Map());
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>(
    'connecting'
  );
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Process channel events and update state
   */
  const processChannelEvent = useCallback((event: TelemetryEvent) => {
    const timestamp =
      typeof event.timestamp === 'string'
        ? event.timestamp
        : new Date(event.timestamp).toISOString();

    setChannelsMap((prev) => {
      const newMap = new Map(prev);

      switch (event.type) {
        case 'PAYMENT_CHANNEL_OPENED': {
          const channelEvent = event as TelemetryEvent & {
            channelId: string;
            nodeId: string;
            peerId: string;
            participants: [string, string];
            tokenAddress: string;
            tokenSymbol: string;
            settlementTimeout: number;
            initialDeposits: Record<string, string>;
          };
          const channel: ChannelState = {
            channelId: channelEvent.channelId,
            nodeId: channelEvent.nodeId || '',
            peerId: channelEvent.peerId || '',
            participants: channelEvent.participants,
            tokenAddress: channelEvent.tokenAddress,
            tokenSymbol: channelEvent.tokenSymbol,
            settlementTimeout: channelEvent.settlementTimeout,
            deposits: channelEvent.initialDeposits,
            myNonce: 0,
            theirNonce: 0,
            myTransferred: '0',
            theirTransferred: '0',
            status: 'active',
            openedAt: timestamp,
            lastActivityAt: timestamp,
            settlementMethod: 'evm',
          };
          newMap.set(channelEvent.channelId, channel);
          break;
        }

        case 'PAYMENT_CHANNEL_BALANCE_UPDATE': {
          const balanceEvent = event as TelemetryEvent & {
            channelId: string;
            myNonce: number;
            theirNonce: number;
            myTransferred: string;
            theirTransferred: string;
          };
          const existing = newMap.get(balanceEvent.channelId);
          if (existing) {
            newMap.set(balanceEvent.channelId, {
              ...existing,
              myNonce: balanceEvent.myNonce,
              theirNonce: balanceEvent.theirNonce,
              myTransferred: balanceEvent.myTransferred,
              theirTransferred: balanceEvent.theirTransferred,
              lastActivityAt: timestamp,
            });
          }
          break;
        }

        case 'PAYMENT_CHANNEL_SETTLED': {
          const settledEvent = event as TelemetryEvent & {
            channelId: string;
            finalBalances: Record<string, string>;
            settlementType: string;
          };
          const existing = newMap.get(settledEvent.channelId);
          if (existing) {
            newMap.set(settledEvent.channelId, {
              ...existing,
              status: 'settled',
              settledAt: timestamp,
              lastActivityAt: timestamp,
              deposits: settledEvent.finalBalances,
            });
          }
          break;
        }

        case 'XRP_CHANNEL_OPENED': {
          const xrpEvent = event as TelemetryEvent & {
            channelId: string;
            nodeId?: string;
            peerId?: string;
            account: string;
            destination: string;
            amount: string;
            settleDelay: number;
            publicKey: string;
          };
          const channel: ChannelState = {
            channelId: xrpEvent.channelId,
            nodeId: xrpEvent.nodeId || '',
            peerId: xrpEvent.peerId || '',
            participants: [xrpEvent.account, xrpEvent.destination],
            tokenAddress: 'XRP',
            tokenSymbol: 'XRP',
            settlementTimeout: xrpEvent.settleDelay,
            deposits: { [xrpEvent.account]: xrpEvent.amount },
            myNonce: 0,
            theirNonce: 0,
            myTransferred: '0',
            theirTransferred: '0',
            status: 'active',
            openedAt: timestamp,
            lastActivityAt: timestamp,
            settlementMethod: 'xrp',
            xrpAccount: xrpEvent.account,
            xrpDestination: xrpEvent.destination,
            xrpAmount: xrpEvent.amount,
            xrpBalance: '0',
            xrpSettleDelay: xrpEvent.settleDelay,
            xrpPublicKey: xrpEvent.publicKey,
          };
          newMap.set(xrpEvent.channelId, channel);
          break;
        }

        case 'XRP_CHANNEL_CLAIMED': {
          const claimEvent = event as TelemetryEvent & {
            channelId: string;
            balance: string;
          };
          const existing = newMap.get(claimEvent.channelId);
          if (existing) {
            newMap.set(claimEvent.channelId, {
              ...existing,
              xrpBalance: claimEvent.balance,
              lastActivityAt: timestamp,
            });
          }
          break;
        }

        case 'XRP_CHANNEL_CLOSED': {
          const closeEvent = event as TelemetryEvent & {
            channelId: string;
          };
          const existing = newMap.get(closeEvent.channelId);
          if (existing) {
            newMap.set(closeEvent.channelId, {
              ...existing,
              status: 'settled',
              settledAt: timestamp,
              lastActivityAt: timestamp,
            });
          }
          break;
        }
      }

      return newMap;
    });
  }, []);

  /**
   * Connect to WebSocket
   */
  const connect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }

    setStatus('connecting');
    setError(null);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws`;

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setStatus('connected');
      setError(null);
      reconnectAttemptsRef.current = 0;
    };

    ws.onmessage = (messageEvent) => {
      try {
        const event = JSON.parse(messageEvent.data) as TelemetryEvent;
        const channelEventTypes = [
          'PAYMENT_CHANNEL_OPENED',
          'PAYMENT_CHANNEL_BALANCE_UPDATE',
          'PAYMENT_CHANNEL_SETTLED',
          'XRP_CHANNEL_OPENED',
          'XRP_CHANNEL_CLAIMED',
          'XRP_CHANNEL_CLOSED',
        ];
        if (channelEventTypes.includes(event.type)) {
          processChannelEvent(event);
        }
      } catch {
        // Silently ignore parse errors
      }
    };

    ws.onerror = () => {
      setError('WebSocket connection error');
    };

    ws.onclose = () => {
      setStatus('disconnected');
      wsRef.current = null;

      if (reconnectAttemptsRef.current < maxReconnectAttempts) {
        const delay = reconnectDelay * Math.pow(2, reconnectAttemptsRef.current);
        reconnectAttemptsRef.current++;

        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, delay);
      } else {
        setStatus('error');
        setError('Max reconnect attempts reached');
      }
    };

    wsRef.current = ws;
  }, [processChannelEvent, reconnectDelay, maxReconnectAttempts]);

  const clearChannels = useCallback(() => {
    setChannelsMap(new Map());
  }, []);

  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    connect();
  }, [connect]);

  useEffect(() => {
    connect();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [connect]);

  // Sort channels by lastActivityAt (most recent first)
  const channels = useMemo(() => {
    return Array.from(channelsMap.values()).sort((a, b) => {
      return new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
    });
  }, [channelsMap]);

  const totalChannels = channelsMap.size;

  const activeChannelCount = useMemo(() => {
    return Array.from(channelsMap.values()).filter((ch) => ch.status === 'active').length;
  }, [channelsMap]);

  return {
    channels,
    channelsMap,
    status,
    error,
    totalChannels,
    activeChannelCount,
    clearChannels,
    reconnect,
  };
}
