import { useState, useEffect, useCallback } from 'react';
import type { WalletBalances } from '@/lib/event-types';

export interface UseWalletBalancesResult {
  data: WalletBalances | null;
  loading: boolean;
  error: string | null;
  lastUpdated: number | null;
  refresh: () => void;
}

const POLL_INTERVAL_MS = 10_000;

/**
 * Polling hook that fetches GET /api/balances every 10 seconds.
 * Gracefully handles 404/errors (endpoint may not exist in non-agent contexts).
 */
export function useWalletBalances(): UseWalletBalancesResult {
  const [data, setData] = useState<WalletBalances | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const fetchBalances = useCallback(async () => {
    try {
      const response = await fetch('/api/balances');
      if (response.status === 404) {
        // Endpoint not available (non-agent context) - not an error
        setLoading(false);
        return;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const json: WalletBalances = await response.json();
      setData(json);
      setError(null);
      setLastUpdated(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch balances');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBalances();
    const interval = setInterval(fetchBalances, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchBalances]);

  return { data, loading, error, lastUpdated, refresh: fetchBalances };
}
