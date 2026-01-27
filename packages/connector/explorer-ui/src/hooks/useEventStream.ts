import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { TelemetryEvent } from '../lib/event-types';
import { FilterState } from '../components/FilterBar';

interface UseEventStreamOptions {
  /** Maximum events to keep in memory */
  maxEvents?: number;
  /** Reconnect delay in milliseconds */
  reconnectDelay?: number;
  /** Maximum reconnect attempts */
  maxReconnectAttempts?: number;
  /** Filter state for filtering events */
  filters?: FilterState;
}

interface UseEventStreamResult {
  /** Current list of events (newest first) - all events */
  events: TelemetryEvent[];
  /** Filtered events based on filter state */
  filteredEvents: TelemetryEvent[];
  /** WebSocket connection status */
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  /** Error message if status is 'error' */
  error: string | null;
  /** Clear all events */
  clearEvents: () => void;
  /** Manually reconnect */
  reconnect: () => void;
}

const DEFAULT_MAX_EVENTS = 1000;
const DEFAULT_RECONNECT_DELAY = 1000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;

/**
 * Filter a single event against filter state
 * Time range filter is NOT applied to live events (they always pass time filter)
 */
function eventMatchesFilters(event: TelemetryEvent, filters: FilterState): boolean {
  // Event type filter (empty array = all types)
  if (filters.eventTypes.length > 0 && !filters.eventTypes.includes(event.type)) {
    return false;
  }

  // Direction filter (all = no filter)
  if (filters.direction !== 'all') {
    const eventDirection = (event as { direction?: string }).direction;
    if (eventDirection !== filters.direction) {
      return false;
    }
  }

  // Text search filter (case-insensitive substring match)
  if (filters.searchText) {
    const searchLower = filters.searchText.toLowerCase();
    const destination = ((event as { destination?: string }).destination || '').toLowerCase();
    const peerId = (event.peerId || '').toLowerCase();
    const packetId = ((event as { packetId?: string }).packetId || '').toLowerCase();

    const matchesDestination = destination.includes(searchLower);
    const matchesPeerId = peerId.includes(searchLower);
    const matchesPacketId = packetId.includes(searchLower);

    if (!matchesDestination && !matchesPeerId && !matchesPacketId) {
      return false;
    }
  }

  return true;
}

export function useEventStream(options: UseEventStreamOptions = {}): UseEventStreamResult {
  const {
    maxEvents = DEFAULT_MAX_EVENTS,
    reconnectDelay = DEFAULT_RECONNECT_DELAY,
    maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS,
    filters,
  } = options;

  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>(
    'connecting'
  );
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // RAF batching refs
  const bufferRef = useRef<TelemetryEvent[]>([]);
  const rafRef = useRef<number | null>(null);

  const flushBuffer = useCallback(() => {
    rafRef.current = null;
    const buffered = bufferRef.current;
    if (buffered.length === 0) return;
    bufferRef.current = [];
    setEvents((prev) => {
      const updated = [...buffered.reverse(), ...prev];
      return updated.length > maxEvents ? updated.slice(0, maxEvents) : updated;
    });
  }, [maxEvents]);

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

    ws.onmessage = (event) => {
      try {
        const telemetryEvent = JSON.parse(event.data) as TelemetryEvent;
        bufferRef.current.push(telemetryEvent);
        if (rafRef.current === null) {
          rafRef.current = requestAnimationFrame(flushBuffer);
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

  const clearEvents = useCallback(() => {
    setEvents([]);
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
      // Flush any remaining buffered events on unmount
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
      if (bufferRef.current.length > 0) {
        const remaining = bufferRef.current;
        bufferRef.current = [];
        setEvents((prev) => {
          const updated = [...remaining.reverse(), ...prev];
          return updated.length > maxEvents ? updated.slice(0, maxEvents) : updated;
        });
      }
    };
  }, [connect, maxEvents]);

  // Filter events based on filter state
  const filteredEvents = useMemo(() => {
    if (!filters) {
      return events;
    }
    return events.filter((event) => eventMatchesFilters(event, filters));
  }, [events, filters]);

  return { events, filteredEvents, status, error, clearEvents, reconnect };
}
