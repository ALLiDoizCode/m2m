import { useState, useCallback, useEffect, useRef } from 'react';
import { TelemetryEvent, StoredEvent, EventsResponse } from '../lib/event-types';

/**
 * Query filter parameters for historical events
 */
export interface EventQueryFilter {
  eventTypes?: string[];
  since?: number;
  until?: number;
  peerId?: string;
  packetId?: string;
  direction?: 'sent' | 'received' | 'internal';
  limit?: number;
  offset?: number;
}

interface UseEventHistoryOptions {
  /** Initial filter state */
  initialFilters?: EventQueryFilter;
  /** Auto-fetch on mount */
  autoFetch?: boolean;
  /** Page size (default: 50) */
  pageSize?: number;
}

interface UseEventHistoryResult {
  /** List of historical events */
  events: TelemetryEvent[];
  /** Total number of events matching the filter */
  total: number;
  /** Loading state */
  loading: boolean;
  /** Error message */
  error: string | null;
  /** Current offset for pagination */
  offset: number;
  /** Fetch more events (pagination) */
  fetchMore: () => Promise<void>;
  /** Refresh with current filters */
  refresh: () => Promise<void>;
  /** Update filters and refetch */
  updateFilters: (filters: EventQueryFilter) => Promise<void>;
  /** Check if more events are available */
  hasMore: boolean;
}

const DEFAULT_PAGE_SIZE = 50;

/**
 * Convert StoredEvent to TelemetryEvent
 */
function storedEventToTelemetryEvent(stored: StoredEvent): TelemetryEvent {
  return {
    ...stored.payload,
    type: stored.event_type as TelemetryEvent['type'],
    timestamp: stored.timestamp,
    nodeId: stored.node_id,
    peerId: stored.peer_id || undefined,
    direction: stored.direction || undefined,
    destination: stored.destination || undefined,
    amount: stored.amount || undefined,
    packetId: stored.packet_id || undefined,
  };
}

/**
 * Build query string from filter parameters
 */
function buildQueryString(filters: EventQueryFilter): string {
  const params = new URLSearchParams();

  if (filters.eventTypes && filters.eventTypes.length > 0) {
    params.set('types', filters.eventTypes.join(','));
  }
  if (filters.since !== undefined) {
    params.set('since', filters.since.toString());
  }
  if (filters.until !== undefined) {
    params.set('until', filters.until.toString());
  }
  if (filters.peerId) {
    params.set('peerId', filters.peerId);
  }
  if (filters.packetId) {
    params.set('packetId', filters.packetId);
  }
  if (filters.direction) {
    params.set('direction', filters.direction);
  }
  if (filters.limit !== undefined) {
    params.set('limit', filters.limit.toString());
  }
  if (filters.offset !== undefined) {
    params.set('offset', filters.offset.toString());
  }

  return params.toString();
}

/**
 * Hook for fetching historical events with pagination and filtering
 */
export function useEventHistory(options: UseEventHistoryOptions = {}): UseEventHistoryResult {
  const { initialFilters = {}, autoFetch = true, pageSize = DEFAULT_PAGE_SIZE } = options;

  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  const filtersRef = useRef<EventQueryFilter>(initialFilters);
  const abortControllerRef = useRef<AbortController | null>(null);

  /**
   * Fetch events from API
   */
  const fetchEvents = useCallback(
    async (filters: EventQueryFilter, append: boolean = false): Promise<void> => {
      // Cancel any pending request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      abortControllerRef.current = new AbortController();
      setLoading(true);
      setError(null);

      try {
        const queryString = buildQueryString({
          ...filters,
          limit: filters.limit ?? pageSize,
        });

        const response = await fetch(`/api/events?${queryString}`, {
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API error: ${response.status} - ${errorText}`);
        }

        const data: EventsResponse = await response.json();

        const telemetryEvents = data.events.map(storedEventToTelemetryEvent);

        if (append) {
          setEvents((prev) => [...prev, ...telemetryEvents]);
        } else {
          setEvents(telemetryEvents);
        }

        setTotal(data.total);
        setOffset(data.offset + data.events.length);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          // Request was cancelled, ignore
          return;
        }
        const message = err instanceof Error ? err.message : 'Failed to fetch events';
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [pageSize]
  );

  /**
   * Refresh with current filters (reset to first page)
   */
  const refresh = useCallback(async (): Promise<void> => {
    const filters = { ...filtersRef.current, offset: 0 };
    filtersRef.current = filters;
    setOffset(0);
    await fetchEvents(filters, false);
  }, [fetchEvents]);

  /**
   * Fetch more events (next page)
   */
  const fetchMore = useCallback(async (): Promise<void> => {
    const filters = { ...filtersRef.current, offset };
    await fetchEvents(filters, true);
  }, [fetchEvents, offset]);

  /**
   * Update filters and refetch from beginning
   */
  const updateFilters = useCallback(
    async (newFilters: EventQueryFilter): Promise<void> => {
      filtersRef.current = { ...newFilters, offset: 0 };
      setOffset(0);
      await fetchEvents(filtersRef.current, false);
    },
    [fetchEvents]
  );

  /**
   * Auto-fetch on mount if enabled
   */
  useEffect(() => {
    if (autoFetch) {
      fetchEvents({ ...initialFilters, offset: 0 }, false);
    }

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const hasMore = offset < total;

  return {
    events,
    total,
    loading,
    error,
    offset,
    fetchMore,
    refresh,
    updateFilters,
    hasMore,
  };
}
