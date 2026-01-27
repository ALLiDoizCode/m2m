import { useState, useCallback, useEffect, useMemo } from 'react';
import { TelemetryEvent } from '../lib/event-types';
import { FilterState } from '../components/FilterBar';
import { useEventStream } from './useEventStream';
import { useEventHistory, EventQueryFilter } from './useEventHistory';

export type EventMode = 'live' | 'history';

interface UseEventsOptions {
  /** Initial mode */
  initialMode?: EventMode;
  /** Filter state */
  filters?: FilterState;
  /** Page size for history mode */
  pageSize?: number;
  /** Max events in live mode */
  maxLiveEvents?: number;
}

interface UseEventsResult {
  /** Current display mode */
  mode: EventMode;
  /** Set display mode */
  setMode: (mode: EventMode) => void;
  /** Events to display (filtered) */
  events: TelemetryEvent[];
  /** Total events (for history mode) */
  total: number;
  /** Loading state */
  loading: boolean;
  /** Error message */
  error: string | null;
  /** WebSocket connection status */
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error';
  /** Load more events (history mode only) */
  loadMore: () => Promise<void>;
  /** Has more events to load (history mode) */
  hasMore: boolean;
  /** Refresh current view */
  refresh: () => void;
  /** Jump to live mode */
  jumpToLive: () => void;
}

/**
 * Convert FilterState to EventQueryFilter for API calls
 */
function filterStateToQueryFilter(filters: FilterState): EventQueryFilter {
  const query: EventQueryFilter = {};

  if (filters.eventTypes.length > 0) {
    query.eventTypes = filters.eventTypes;
  }

  if (filters.timeRange.since !== undefined) {
    query.since = filters.timeRange.since;
  }

  if (filters.timeRange.until !== undefined) {
    query.until = filters.timeRange.until;
  }

  if (filters.direction !== 'all') {
    query.direction = filters.direction;
  }

  // Note: searchText is applied client-side, not sent to API

  return query;
}

/**
 * Apply text search filter to events (client-side)
 */
function applyTextSearch(events: TelemetryEvent[], searchText: string): TelemetryEvent[] {
  if (!searchText) {
    return events;
  }

  const searchLower = searchText.toLowerCase();

  return events.filter((event) => {
    const destination = ((event as { destination?: string }).destination || '').toLowerCase();
    const peerId = (event.peerId || '').toLowerCase();
    const packetId = ((event as { packetId?: string }).packetId || '').toLowerCase();

    return (
      destination.includes(searchLower) ||
      peerId.includes(searchLower) ||
      packetId.includes(searchLower)
    );
  });
}

/**
 * Combined hook for managing events in both live and history modes
 */
export function useEvents(options: UseEventsOptions = {}): UseEventsResult {
  const { initialMode = 'live', filters, pageSize = 50, maxLiveEvents = 1000 } = options;

  const [mode, setModeState] = useState<EventMode>(initialMode);

  // Live events stream with filters
  const {
    filteredEvents: liveEvents,
    status: connectionStatus,
    error: liveError,
    clearEvents,
    reconnect,
  } = useEventStream({
    maxEvents: maxLiveEvents,
    filters,
  });

  // Historical events with API-compatible filters
  const queryFilter = useMemo(() => {
    return filters ? filterStateToQueryFilter(filters) : {};
  }, [filters]);

  const {
    events: historyEventsRaw,
    total: historyTotal,
    loading: historyLoading,
    error: historyError,
    fetchMore,
    refresh: historyRefresh,
    updateFilters,
    hasMore,
  } = useEventHistory({
    initialFilters: queryFilter,
    autoFetch: mode === 'history',
    pageSize,
  });

  // Apply text search filter to history events (client-side)
  const historyEvents = useMemo(() => {
    if (!filters?.searchText) {
      return historyEventsRaw;
    }
    return applyTextSearch(historyEventsRaw, filters.searchText);
  }, [historyEventsRaw, filters?.searchText]);

  // Set mode with side effects
  const setMode = useCallback(
    (newMode: EventMode) => {
      setModeState(newMode);
      if (newMode === 'history') {
        // Refresh history when switching to history mode
        updateFilters(queryFilter);
      }
    },
    [queryFilter, updateFilters]
  );

  // Update history filters when filters change in history mode
  useEffect(() => {
    if (mode === 'history') {
      updateFilters(queryFilter);
    }
  }, [mode, queryFilter, updateFilters]);

  // Jump to live mode
  const jumpToLive = useCallback(() => {
    setModeState('live');
    clearEvents();
    reconnect();
  }, [clearEvents, reconnect]);

  // Refresh current view
  const refresh = useCallback(() => {
    if (mode === 'live') {
      clearEvents();
      reconnect();
    } else {
      historyRefresh();
    }
  }, [mode, clearEvents, reconnect, historyRefresh]);

  // Load more (history mode only)
  const loadMore = useCallback(async () => {
    if (mode === 'history') {
      await fetchMore();
    }
  }, [mode, fetchMore]);

  // Combine results based on mode
  const events = mode === 'live' ? liveEvents : historyEvents;
  const total = mode === 'live' ? liveEvents.length : historyTotal;
  const loading = mode === 'history' ? historyLoading : false;
  const error = mode === 'live' ? liveError : historyError;

  return {
    mode,
    setMode,
    events,
    total,
    loading,
    error,
    connectionStatus,
    loadMore,
    hasMore: mode === 'history' ? hasMore : false,
    refresh,
    jumpToLive,
  };
}
