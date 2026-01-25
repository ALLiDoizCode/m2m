import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useEventHistory } from './useEventHistory';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('useEventHistory', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const mockEventsResponse = {
    events: [
      {
        id: 1,
        event_type: 'PACKET_RECEIVED',
        timestamp: 1706140800000,
        node_id: 'node1',
        direction: 'received',
        peer_id: 'peer1',
        packet_id: 'pkt1',
        amount: '1000',
        destination: 'g.test.receiver',
        payload: {
          type: 'PACKET_RECEIVED',
          timestamp: 1706140800000,
          nodeId: 'node1',
        },
      },
      {
        id: 2,
        event_type: 'PACKET_FORWARDED',
        timestamp: 1706140801000,
        node_id: 'node1',
        direction: 'sent',
        peer_id: 'peer2',
        packet_id: 'pkt1',
        amount: '1000',
        destination: 'g.test.receiver',
        payload: {
          type: 'PACKET_FORWARDED',
          timestamp: 1706140801000,
          nodeId: 'node1',
        },
      },
    ],
    total: 100,
    limit: 50,
    offset: 0,
  };

  describe('initialization', () => {
    it('should fetch events on mount when autoFetch is true', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockEventsResponse,
      });

      const { result } = renderHook(() => useEventHistory({ autoFetch: true }));

      expect(result.current.loading).toBe(true);

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.events).toHaveLength(2);
      expect(result.current.total).toBe(100);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should not fetch events on mount when autoFetch is false', async () => {
      const { result } = renderHook(() => useEventHistory({ autoFetch: false }));

      expect(result.current.loading).toBe(false);
      expect(result.current.events).toHaveLength(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('event transformation', () => {
    it('should transform StoredEvent to TelemetryEvent', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockEventsResponse,
      });

      const { result } = renderHook(() => useEventHistory({ autoFetch: true }));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      const firstEvent = result.current.events[0];
      expect(firstEvent.type).toBe('PACKET_RECEIVED');
      expect(firstEvent.timestamp).toBe(1706140800000);
      expect(firstEvent.nodeId).toBe('node1');
      expect(firstEvent.peerId).toBe('peer1');
      expect((firstEvent as { destination?: string }).destination).toBe('g.test.receiver');
    });
  });

  describe('filtering', () => {
    it('should include event types in query string', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...mockEventsResponse, events: [] }),
      });

      renderHook(() =>
        useEventHistory({
          autoFetch: true,
          initialFilters: {
            eventTypes: ['PACKET_RECEIVED', 'PACKET_FORWARDED'],
          },
        })
      );

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('types=PACKET_RECEIVED%2CPACKET_FORWARDED');
    });

    it('should include time range in query string', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...mockEventsResponse, events: [] }),
      });

      const since = 1706140000000;
      const until = 1706150000000;

      renderHook(() =>
        useEventHistory({
          autoFetch: true,
          initialFilters: { since, until },
        })
      );

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain(`since=${since}`);
      expect(url).toContain(`until=${until}`);
    });

    it('should include direction in query string', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...mockEventsResponse, events: [] }),
      });

      renderHook(() =>
        useEventHistory({
          autoFetch: true,
          initialFilters: { direction: 'sent' },
        })
      );

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('direction=sent');
    });
  });

  describe('pagination', () => {
    it('should use default page size of 50', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockEventsResponse,
      });

      renderHook(() => useEventHistory({ autoFetch: true }));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('limit=50');
    });

    it('should respect custom page size', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockEventsResponse,
      });

      renderHook(() =>
        useEventHistory({
          autoFetch: true,
          pageSize: 25,
        })
      );

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('limit=25');
    });

    it('should fetch more events with correct offset', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockEventsResponse,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockEventsResponse,
            events: [
              {
                id: 3,
                event_type: 'NODE_STATUS',
                timestamp: 1706140802000,
                node_id: 'node1',
                direction: null,
                peer_id: null,
                packet_id: null,
                amount: null,
                destination: null,
                payload: { type: 'NODE_STATUS', timestamp: 1706140802000 },
              },
            ],
            offset: 2,
          }),
        });

      const { result } = renderHook(() => useEventHistory({ autoFetch: true }));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.events).toHaveLength(2);
      expect(result.current.hasMore).toBe(true);

      await act(async () => {
        await result.current.fetchMore();
      });

      await waitFor(() => {
        expect(result.current.events).toHaveLength(3);
      });
    });

    it('should indicate when no more events are available', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          events: mockEventsResponse.events,
          total: 2,
          limit: 50,
          offset: 0,
        }),
      });

      const { result } = renderHook(() => useEventHistory({ autoFetch: true }));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.hasMore).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should handle API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const { result } = renderHook(() => useEventHistory({ autoFetch: true }));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.error).toContain('API error: 500');
      expect(result.current.events).toHaveLength(0);
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useEventHistory({ autoFetch: true }));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.error).toBe('Network error');
    });
  });

  describe('refresh', () => {
    it('should refetch from the beginning', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockEventsResponse,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockEventsResponse,
            events: [mockEventsResponse.events[0]],
            total: 1,
          }),
        });

      const { result } = renderHook(() => useEventHistory({ autoFetch: true }));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.events).toHaveLength(2);

      await act(async () => {
        await result.current.refresh();
      });

      await waitFor(() => {
        expect(result.current.events).toHaveLength(1);
      });

      const [url] = mockFetch.mock.calls[1];
      expect(url).toContain('offset=0');
    });
  });

  describe('updateFilters', () => {
    it('should refetch with new filters', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockEventsResponse,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockEventsResponse,
            events: [mockEventsResponse.events[0]],
          }),
        });

      const { result } = renderHook(() => useEventHistory({ autoFetch: true }));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await result.current.updateFilters({
          eventTypes: ['PACKET_RECEIVED'],
        });
      });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      const [url] = mockFetch.mock.calls[1];
      expect(url).toContain('types=PACKET_RECEIVED');
      expect(url).toContain('offset=0');
    });
  });
});
