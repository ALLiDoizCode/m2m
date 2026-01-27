import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useRoutingTable } from './useRoutingTable';

describe('useRoutingTable', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns empty routes array initially', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ routes: [] }),
      })
    );

    const { result } = renderHook(() => useRoutingTable());
    expect(result.current.routes).toEqual([]);
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('fetches routes on mount', async () => {
    const mockRoutes = [
      { prefix: 'g.agent.alice', nextHop: 'alice', priority: 0 },
      { prefix: 'g.agent.bob', nextHop: 'bob' },
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ routes: mockRoutes }),
      })
    );

    const { result } = renderHook(() => useRoutingTable());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.routes).toHaveLength(2);
    expect(result.current.routes[0].prefix).toBe('g.agent.alice');
    expect(result.current.routes[0].nextHop).toBe('alice');
    expect(result.current.routes[1].priority).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it('handles 404 gracefully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Routes not available' }),
      })
    );

    const { result } = renderHook(() => useRoutingTable());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.routes).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('sets error on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const { result } = renderHook(() => useRoutingTable());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Network error');
  });

  it('polls every 30 seconds', async () => {
    vi.useFakeTimers();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ routes: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    renderHook(() => useRoutingTable());

    // Initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance timer by 30 seconds
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('refresh triggers immediate fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ routes: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { result } = renderHook(() => useRoutingTable());

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  it('handles missing routes field gracefully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      })
    );

    const { result } = renderHook(() => useRoutingTable());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.routes).toEqual([]);
  });
});
