import { useState, useEffect, useCallback } from 'react';

export interface RoutingEntry {
  prefix: string;
  nextHop: string;
  priority?: number;
}

export interface UseRoutingTableResult {
  routes: RoutingEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const POLL_INTERVAL_MS = 30_000;

/**
 * Polling hook that fetches GET /api/routes every 30 seconds.
 * Routing table changes less frequently than peer status.
 * Gracefully handles 404/errors (endpoint may not exist in non-agent contexts).
 */
export function useRoutingTable(): UseRoutingTableResult {
  const [routes, setRoutes] = useState<RoutingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRoutes = useCallback(async () => {
    try {
      const response = await fetch('/api/routes');
      if (response.status === 404) {
        setLoading(false);
        return;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const json = await response.json();
      setRoutes(json.routes ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch routes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRoutes();
    const interval = setInterval(fetchRoutes, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchRoutes]);

  return { routes, loading, error, refresh: fetchRoutes };
}
