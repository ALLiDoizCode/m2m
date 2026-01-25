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
  /** WebSocket connection status */
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
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
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>(
    'connecting'
  );
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Process an ACCOUNT_BALANCE event and update account state
   */
  const processAccountBalanceEvent = useCallback(
    (event: AccountBalanceEvent) => {
      setAccountsMap((prev) => {
        const key = getAccountKey(event.peerId, event.tokenId);
        const existing = prev.get(key);
        const timestamp =
          typeof event.timestamp === 'string'
            ? new Date(event.timestamp).getTime()
            : event.timestamp;

        // Parse balance values as bigints
        const debitBalance = BigInt(event.debitBalance);
        const creditBalance = BigInt(event.creditBalance);
        const netBalance = BigInt(event.netBalance);
        const creditLimit = event.creditLimit ? BigInt(event.creditLimit) : undefined;
        const settlementThreshold = event.settlementThreshold
          ? BigInt(event.settlementThreshold)
          : undefined;

        // Build balance history (keep last N entries)
        const newHistoryEntry: BalanceHistoryEntry = {
          timestamp,
          balance: netBalance,
        };
        const balanceHistory = existing
          ? [...existing.balanceHistory, newHistoryEntry].slice(-maxHistoryEntries)
          : [newHistoryEntry];

        const updatedAccount: AccountState = {
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
        };

        const newMap = new Map(prev);
        newMap.set(key, updatedAccount);
        return newMap;
      });
    },
    [maxHistoryEntries]
  );

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
        if (isAccountBalanceEvent(event)) {
          processAccountBalanceEvent(event);
        }
      } catch (err) {
        // Silently ignore parse errors to not spam console
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
  }, [processAccountBalanceEvent, reconnectDelay, maxReconnectAttempts]);

  const clearAccounts = useCallback(() => {
    setAccountsMap(new Map());
  }, []);

  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    connect();
  }, [connect]);

  // Connect on mount
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
