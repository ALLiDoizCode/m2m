import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useRelatedEvents, hasPacketId } from './useRelatedEvents';
import { StoredEvent, TelemetryEvent } from '@/lib/event-types';

// Mock fetch
const mockFetch = vi.fn();

describe('useRelatedEvents', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Factory function to create test StoredEvent
   */
  function createStoredEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
    return {
      id: 1,
      event_type: 'PACKET_RECEIVED',
      timestamp: Date.now(),
      node_id: 'test-node',
      direction: 'incoming',
      peer_id: 'peer-1',
      packet_id: 'packet-123',
      amount: '1000',
      destination: 'g.example.receiver',
      packet_type: null,
      from_address: null,
      to_address: null,
      payload: {
        type: 'PACKET_RECEIVED',
        nodeId: 'test-node',
        timestamp: Date.now(),
      },
      ...overrides,
    };
  }

  describe('fetching related events', () => {
    it('fetches related events when packetId is present', async () => {
      const relatedEvents = [
        createStoredEvent({ id: 2, event_type: 'PACKET_FORWARDED' }),
        createStoredEvent({ id: 3, event_type: 'PACKET_RECEIVED' }),
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ events: relatedEvents }),
      });

      const event = createStoredEvent({ id: 1, packet_id: 'packet-123' });
      const { result } = renderHook(() => useRelatedEvents(event));

      // Initially loading
      expect(result.current.loading).toBe(true);

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('packetId=packet-123'));
      expect(result.current.relatedEvents).toHaveLength(2);
      expect(result.current.error).toBeNull();
    });

    it('returns empty array when no packet ID', async () => {
      const event = createStoredEvent({ packet_id: null });
      const { result } = renderHook(() => useRelatedEvents(event));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.current.relatedEvents).toEqual([]);
      expect(result.current.error).toBeNull();
    });

    it('returns empty array when event is null', async () => {
      const { result } = renderHook(() => useRelatedEvents(null));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.current.relatedEvents).toEqual([]);
      expect(result.current.error).toBeNull();
    });
  });

  describe('error handling', () => {
    it('handles API errors gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        statusText: 'Internal Server Error',
      });

      const event = createStoredEvent({ packet_id: 'packet-123' });
      const { result } = renderHook(() => useRelatedEvents(event));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.relatedEvents).toEqual([]);
      expect(result.current.error).toBe('Failed to fetch related events: Internal Server Error');
    });

    it('handles network errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const event = createStoredEvent({ packet_id: 'packet-123' });
      const { result } = renderHook(() => useRelatedEvents(event));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.relatedEvents).toEqual([]);
      expect(result.current.error).toBe('Network error');
    });

    it('handles non-Error exceptions', async () => {
      mockFetch.mockRejectedValueOnce('Unknown error');

      const event = createStoredEvent({ packet_id: 'packet-123' });
      const { result } = renderHook(() => useRelatedEvents(event));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.relatedEvents).toEqual([]);
      expect(result.current.error).toBe('Failed to fetch related events');
    });
  });

  describe('filtering current event', () => {
    it('filters out current event from results', async () => {
      const currentEvent = createStoredEvent({ id: 1, packet_id: 'packet-123' });
      const relatedEvents = [
        createStoredEvent({ id: 1, event_type: 'PACKET_RECEIVED' }), // Same ID as current
        createStoredEvent({ id: 2, event_type: 'PACKET_FORWARDED' }),
        createStoredEvent({ id: 3, event_type: 'PACKET_RECEIVED' }),
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ events: relatedEvents }),
      });

      const { result } = renderHook(() => useRelatedEvents(currentEvent));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      // Should filter out event with id: 1
      expect(result.current.relatedEvents).toHaveLength(2);
      expect(result.current.relatedEvents.map((e) => e.id)).toEqual([2, 3]);
    });

    it('does not filter when event has no numeric id', async () => {
      // TelemetryEvent without numeric id
      const telemetryEvent: TelemetryEvent = {
        type: 'PACKET_RECEIVED',
        nodeId: 'test-node',
        timestamp: Date.now(),
        packetId: 'packet-123',
      };

      const relatedEvents = [createStoredEvent({ id: 1 }), createStoredEvent({ id: 2 })];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ events: relatedEvents }),
      });

      const { result } = renderHook(() => useRelatedEvents(telemetryEvent));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      // Should keep all events
      expect(result.current.relatedEvents).toHaveLength(2);
    });
  });

  describe('loading state transitions', () => {
    it('loading state transitions correctly', async () => {
      const loadingStates: boolean[] = [];

      mockFetch.mockImplementation(() => {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              ok: true,
              json: () => Promise.resolve({ events: [] }),
            });
          }, 50);
        });
      });

      const event = createStoredEvent({ packet_id: 'packet-123' });
      const { result } = renderHook(() => useRelatedEvents(event));

      // Capture initial loading state
      loadingStates.push(result.current.loading);

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      // Capture final loading state
      loadingStates.push(result.current.loading);

      // Should transition from true to false
      expect(loadingStates[0]).toBe(true);
      expect(loadingStates[1]).toBe(false);
    });
  });

  describe('refresh function', () => {
    it('refresh function triggers new fetch', async () => {
      const initialEvents = [createStoredEvent({ id: 2 })];
      const refreshedEvents = [createStoredEvent({ id: 2 }), createStoredEvent({ id: 3 })];

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ events: initialEvents }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ events: refreshedEvents }),
        });

      const event = createStoredEvent({ id: 1, packet_id: 'packet-123' });
      const { result } = renderHook(() => useRelatedEvents(event));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.relatedEvents).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Call refresh
      act(() => {
        result.current.refresh();
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.current.relatedEvents).toHaveLength(2);
    });

    it('refresh clears error and retries', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          statusText: 'Server Error',
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ events: [createStoredEvent({ id: 2 })] }),
        });

      const event = createStoredEvent({ id: 1, packet_id: 'packet-123' });
      const { result } = renderHook(() => useRelatedEvents(event));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.error).not.toBeNull();

      // Call refresh
      act(() => {
        result.current.refresh();
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.error).toBeNull();
      expect(result.current.relatedEvents).toHaveLength(1);
    });
  });

  describe('packet ID extraction', () => {
    it('extracts packetId from TelemetryEvent with nested data', async () => {
      const telemetryEvent: TelemetryEvent = {
        type: 'PACKET_RECEIVED',
        nodeId: 'test-node',
        timestamp: Date.now(),
        data: {
          packetId: 'nested-packet-456',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ events: [] }),
      });

      const { result } = renderHook(() => useRelatedEvents(telemetryEvent));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('packetId=nested-packet-456'));
    });

    it('extracts packetId from TelemetryEvent top-level', async () => {
      const telemetryEvent: TelemetryEvent = {
        type: 'PACKET_RECEIVED',
        nodeId: 'test-node',
        timestamp: Date.now(),
        packetId: 'top-level-packet-789',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ events: [] }),
      });

      const { result } = renderHook(() => useRelatedEvents(telemetryEvent));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('packetId=top-level-packet-789')
      );
    });
  });
});

describe('hasPacketId', () => {
  it('returns true for StoredEvent with packet_id', () => {
    const event: StoredEvent = {
      id: 1,
      event_type: 'PACKET_RECEIVED',
      timestamp: Date.now(),
      node_id: 'test-node',
      direction: 'incoming',
      peer_id: 'peer-1',
      packet_id: 'packet-123',
      amount: null,
      destination: null,
      packet_type: null,
      from_address: null,
      to_address: null,
      payload: {
        type: 'PACKET_RECEIVED',
        nodeId: 'test-node',
        timestamp: Date.now(),
      },
    };

    expect(hasPacketId(event)).toBe(true);
  });

  it('returns false for StoredEvent without packet_id', () => {
    const event: StoredEvent = {
      id: 1,
      event_type: 'NODE_STATUS',
      timestamp: Date.now(),
      node_id: 'test-node',
      direction: null,
      peer_id: null,
      packet_id: null,
      amount: null,
      destination: null,
      packet_type: null,
      from_address: null,
      to_address: null,
      payload: {
        type: 'NODE_STATUS',
        nodeId: 'test-node',
        timestamp: Date.now(),
      },
    };

    expect(hasPacketId(event)).toBe(false);
  });

  it('returns true for TelemetryEvent with packetId', () => {
    const event: TelemetryEvent = {
      type: 'PACKET_RECEIVED',
      nodeId: 'test-node',
      timestamp: Date.now(),
      packetId: 'packet-123',
    };

    expect(hasPacketId(event)).toBe(true);
  });

  it('returns false for TelemetryEvent without packetId', () => {
    const event: TelemetryEvent = {
      type: 'NODE_STATUS',
      nodeId: 'test-node',
      timestamp: Date.now(),
    };

    expect(hasPacketId(event)).toBe(false);
  });

  it('returns false for null', () => {
    expect(hasPacketId(null)).toBe(false);
  });
});
