import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  TelemetryEvent,
  AccountState,
  SettlementState,
  BalanceHistoryEntry,
} from '../lib/event-types';

/**
 * ACCOUNT_BALANCE event from telemetry
 */
interface AccountBalanceEvent extends TelemetryEvent {
  type: 'ACCOUNT_BALANCE';
  nodeId: string;
  peerId: string;
  tokenId: string;
  debitBalance: string;
  creditBalance: string;
  netBalance: string;
  creditLimit?: string;
  settlementThreshold?: string;
  settlementState: SettlementState;
}

interface UseAccountBalancesOptions {
  /** Maximum balance history entries per account */
  maxHistoryEntries?: number;
  /** Reconnect delay in milliseconds */
  reconnectDelay?: number;
  /** Maximum reconnect attempts */
  maxReconnectAttempts?: number;
}

interface UseAccountBalancesResult {
  /** List of accounts sorted by net balance (highest first) */
  accounts: AccountState[];
  /** Map of accounts by peerId for quick lookup */
  accountsMap: Map<string, AccountState>;
  /** Connection status including hydration */
  status: 'hydrating' | 'connecting' | 'connected' | 'disconnected' | 'error';
  /** Error message if status is 'error' */
  error: string | null;
  /** Total number of accounts */
  totalAccounts: number;
  /** Number of accounts near settlement threshold (>70%) */
  nearThresholdCount: number;
  /** Clear all account data */
  clearAccounts: () => void;
  /** Manually reconnect */
  reconnect: () => void;
}

const DEFAULT_MAX_HISTORY_ENTRIES = 20;
const DEFAULT_RECONNECT_DELAY = 1000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;

/**
 * Check if an event is an ACCOUNT_BALANCE event
 */
function isAccountBalanceEvent(event: TelemetryEvent): event is AccountBalanceEvent {
  return event.type === 'ACCOUNT_BALANCE';
}

/**
 * Create account state key (peerId + tokenId for uniqueness)
 */
function getAccountKey(peerId: string, tokenId: string): string {
  return `${peerId}:${tokenId}`;
}

/**
 * useAccountBalances hook - tracks peer account balances from WebSocket events
 * Story 14.6: Settlement and Balance Visualization
 */
export function useAccountBalances(
  options: UseAccountBalancesOptions = {}
): UseAccountBalancesResult {
  const {
    maxHistoryEntries = DEFAULT_MAX_HISTORY_ENTRIES,
    reconnectDelay = DEFAULT_RECONNECT_DELAY,
    maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS,
  } = options;

  const [accountsMap, setAccountsMap] = useState<Map<string, AccountState>>(new Map());
  const [status, setStatus] = useState<
    'hydrating' | 'connecting' | 'connected' | 'disconnected' | 'error'
  >('hydrating');
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydratedRef = useRef(false);

  // RAF batching refs
  const bufferRef = useRef<TelemetryEvent[]>([]);
  const rafRef = useRef<number | null>(null);

  /**
   * Apply a single ACCOUNT_BALANCE event to the accounts map (pure function)
   */
  const applyAccountBalanceEvent = useCallback(
    (map: Map<string, AccountState>, event: AccountBalanceEvent): void => {
      const key = getAccountKey(event.peerId, event.tokenId);
      const existing = map.get(key);
      const timestamp =
        typeof event.timestamp === 'string' ? new Date(event.timestamp).getTime() : event.timestamp;

      const debitBalance = BigInt(event.debitBalance);
      const creditBalance = BigInt(event.creditBalance);
      const netBalance = BigInt(event.netBalance);
      const creditLimit = event.creditLimit ? BigInt(event.creditLimit) : undefined;
      const settlementThreshold = event.settlementThreshold
        ? BigInt(event.settlementThreshold)
        : undefined;

      const newHistoryEntry: BalanceHistoryEntry = {
        timestamp,
        balance: netBalance,
      };
      const balanceHistory = existing
        ? [...existing.balanceHistory, newHistoryEntry].slice(-maxHistoryEntries)
        : [newHistoryEntry];

      map.set(key, {
        peerId: event.peerId,
        tokenId: event.tokenId,
        debitBalance,
        creditBalance,
        netBalance,
        creditLimit,
        settlementThreshold,
        settlementState: event.settlementState,
        balanceHistory,
        hasActiveChannel: existing?.hasActiveChannel,
        channelType: existing?.channelType,
        lastUpdated: timestamp,
      });
    },
    [maxHistoryEntries]
  );

  /**
   * Apply a single AGENT_CHANNEL_PAYMENT_SENT event to the accounts map (pure function)
   */
  const applyAgentPaymentEvent = useCallback(
    (
      map: Map<string, AccountState>,
      event: TelemetryEvent & {
        peerId: string;
        amount: string;
        packetType: string;
        channelId: string;
      }
    ): void => {
      const peerId = event.peerId;
      const tokenId = 'AGENT';
      const key = getAccountKey(peerId, tokenId);
      const existing = map.get(key);
      const timestamp =
        typeof event.timestamp === 'string' ? new Date(event.timestamp).getTime() : event.timestamp;

      const amount = BigInt(event.amount || '0');

      const prevDebit = existing?.debitBalance ?? 0n;
      const prevCredit = existing?.creditBalance ?? 0n;

      const isFulfill = event.packetType === 'fulfill';
      const debitBalance = isFulfill ? prevDebit + amount : prevDebit;
      const creditBalance = prevCredit;
      const netBalance = creditBalance - debitBalance;

      const newHistoryEntry: BalanceHistoryEntry = {
        timestamp,
        balance: netBalance,
      };
      const balanceHistory = existing
        ? [...existing.balanceHistory, newHistoryEntry].slice(-maxHistoryEntries)
        : [newHistoryEntry];

      map.set(key, {
        peerId,
        tokenId,
        debitBalance,
        creditBalance,
        netBalance,
        settlementThreshold: 1000n,
        settlementState: 'IDLE',
        balanceHistory,
        hasActiveChannel: true,
        channelType: 'evm',
        lastUpdated: timestamp,
      });
    },
    [maxHistoryEntries]
  );

  /**
   * Flush buffered events as a single state update
   */
  const flushBuffer = useCallback(() => {
    rafRef.current = null;
    const buffered = bufferRef.current;
    if (buffered.length === 0) return;
    bufferRef.current = [];

    setAccountsMap((prev) => {
      const newMap = new Map(prev);
      for (const event of buffered) {
        if (isAccountBalanceEvent(event)) {
          applyAccountBalanceEvent(newMap, event);
        } else if (event.type === 'AGENT_CHANNEL_PAYMENT_SENT') {
          applyAgentPaymentEvent(
            newMap,
            event as TelemetryEvent & {
              peerId: string;
              amount: string;
              packetType: string;
              channelId: string;
            }
          );
        }
      }
      return newMap;
    });
  }, [applyAccountBalanceEvent, applyAgentPaymentEvent]);

  /**
   * Connect to WebSocket
   */
  const connect = useCallback(() => {
    // Clean up existing connection
    if (wsRef.current) {
      wsRef.current.close();
    }

    setStatus('connecting');
    setError(null);

    // Determine WebSocket URL
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
        if (isAccountBalanceEvent(event) || event.type === 'AGENT_CHANNEL_PAYMENT_SENT') {
          bufferRef.current.push(event);
          if (rafRef.current === null) {
            rafRef.current = requestAnimationFrame(flushBuffer);
          }
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

      // Auto-reconnect with exponential backoff
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
  }, [flushBuffer, reconnectDelay, maxReconnectAttempts]);

  const clearAccounts = useCallback(() => {
    setAccountsMap(new Map());
  }, []);

  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    connect();
  }, [connect]);

  /**
   * Hydrate account state from historical events via REST API
   */
  const hydrate = useCallback(async () => {
    if (hydratedRef.current) {
      connect();
      return;
    }

    setStatus('hydrating');

    try {
      const baseUrl = `${window.location.protocol}//${window.location.host}`;
      const url = `${baseUrl}/api/accounts/events?types=ACCOUNT_BALANCE,AGENT_CHANNEL_PAYMENT_SENT&limit=5000`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const events = data.events as Array<{ payload: TelemetryEvent }>;

      if (events.length > 0) {
        setAccountsMap(() => {
          const newMap = new Map<string, AccountState>();
          for (const storedEvent of events) {
            const event = storedEvent.payload;
            if (isAccountBalanceEvent(event)) {
              applyAccountBalanceEvent(newMap, event);
            } else if (event.type === 'AGENT_CHANNEL_PAYMENT_SENT') {
              applyAgentPaymentEvent(
                newMap,
                event as TelemetryEvent & {
                  peerId: string;
                  amount: string;
                  packetType: string;
                  channelId: string;
                }
              );
            }
          }
          return newMap;
        });
      }
    } catch {
      // Hydration failed — fall back to WebSocket-only behavior
    }

    hydratedRef.current = true;
    connect();
  }, [connect, applyAccountBalanceEvent, applyAgentPaymentEvent]);

  // Hydrate on mount, then connect WebSocket
  useEffect(() => {
    hydrate();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      // Flush remaining buffer on unmount
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
      // Process remaining buffered events synchronously
      if (bufferRef.current.length > 0) {
        const remaining = bufferRef.current;
        bufferRef.current = [];
        setAccountsMap((prev) => {
          const newMap = new Map(prev);
          for (const event of remaining) {
            if (isAccountBalanceEvent(event)) {
              applyAccountBalanceEvent(newMap, event);
            } else if (event.type === 'AGENT_CHANNEL_PAYMENT_SENT') {
              applyAgentPaymentEvent(
                newMap,
                event as TelemetryEvent & {
                  peerId: string;
                  amount: string;
                  packetType: string;
                  channelId: string;
                }
              );
            }
          }
          return newMap;
        });
      }
    };
  }, [hydrate, applyAccountBalanceEvent, applyAgentPaymentEvent]);

  // Sort accounts by net balance (highest first)
  const accounts = useMemo(() => {
    return Array.from(accountsMap.values()).sort((a, b) => {
      // Compare bigints - highest first (most positive)
      if (a.netBalance > b.netBalance) return -1;
      if (a.netBalance < b.netBalance) return 1;
      return 0;
    });
  }, [accountsMap]);

  // Calculate summary stats
  const totalAccounts = accountsMap.size;

  const nearThresholdCount = useMemo(() => {
    return Array.from(accountsMap.values()).filter((account) => {
      if (!account.settlementThreshold || account.settlementThreshold === 0n) return false;
      const progress = Number((account.creditBalance * 100n) / account.settlementThreshold);
      return progress >= 70;
    }).length;
  }, [accountsMap]);

  return {
    accounts,
    accountsMap,
    status,
    error,
    totalAccounts,
    nearThresholdCount,
    clearAccounts,
    reconnect,
  };
}
