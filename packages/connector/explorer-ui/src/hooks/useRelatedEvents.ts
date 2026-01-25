import * as React from 'react';
import { StoredEvent, TelemetryEvent } from '@/lib/event-types';

export interface UseRelatedEventsResult {
  /** Related events found */
  relatedEvents: StoredEvent[];
  /** Loading state */
  loading: boolean;
  /** Error message if fetch failed */
  error: string | null;
  /** Refresh related events */
  refresh: () => void;
}

/**
 * API base URL - defaults to same origin for production, configurable for dev
 */
const API_BASE = import.meta.env.VITE_API_BASE || '';

/**
 * Extract packet ID from an event
 */
function getPacketId(event: TelemetryEvent | StoredEvent | null): string | null {
  if (!event) return null;

  // StoredEvent has packet_id directly
  if ('packet_id' in event) {
    const storedEvent = event as StoredEvent;
    if (storedEvent.packet_id) {
      return storedEvent.packet_id;
    }
  }

  // TelemetryEvent may have packetId in various forms
  const data = event as Record<string, unknown>;
  if (data.packetId) return data.packetId as string;
  if (data.data && typeof data.data === 'object') {
    const nested = data.data as Record<string, unknown>;
    if (nested.packetId) return nested.packetId as string;
  }

  return null;
}

/**
 * Fetch related events by packet ID
 */
async function fetchRelatedEvents(packetId: string): Promise<StoredEvent[]> {
  const url = new URL(`${API_BASE}/api/events`, window.location.origin);
  url.searchParams.set('packetId', packetId);
  url.searchParams.set('limit', '10');

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Failed to fetch related events: ${response.statusText}`);
  }

  const data = await response.json();
  return data.events || [];
}

/**
 * Hook to fetch related events for a given event
 *
 * For PACKET_RECEIVED events, finds matching PACKET_FORWARDED by packet ID.
 * For Prepare packets, finds corresponding Fulfill or Reject.
 *
 * @param event - The event to find related events for
 * @returns Related events, loading state, and error
 */
export function useRelatedEvents(
  event: TelemetryEvent | StoredEvent | null
): UseRelatedEventsResult {
  const [relatedEvents, setRelatedEvents] = React.useState<StoredEvent[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const packetId = getPacketId(event);

  const fetchRelated = React.useCallback(async () => {
    if (!packetId) {
      setRelatedEvents([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const events = await fetchRelatedEvents(packetId);

      // Filter out the current event if it's in the results
      const currentId = event && 'id' in event && typeof event.id === 'number' ? event.id : null;
      const filtered = currentId ? events.filter((e) => e.id !== currentId) : events;

      setRelatedEvents(filtered);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch related events');
      setRelatedEvents([]);
    } finally {
      setLoading(false);
    }
  }, [packetId, event]);

  // Fetch on mount and when packetId changes
  React.useEffect(() => {
    fetchRelated();
  }, [fetchRelated]);

  return {
    relatedEvents,
    loading,
    error,
    refresh: fetchRelated,
  };
}

/**
 * Check if an event has a packet ID for related event lookup
 */
export function hasPacketId(event: TelemetryEvent | StoredEvent | null): boolean {
  return getPacketId(event) !== null;
}
