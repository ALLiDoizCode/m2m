import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { usePeers } from './usePeers';

describe('usePeers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns empty peers array initially', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ peers: [] }),
      })
    );

    const { result } = renderHook(() => usePeers());
    expect(result.current.peers).toEqual([]);
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('fetches peers on mount', async () => {
    const mockPeers = [
      {
        peerId: 'alice',
        ilpAddress: 'g.agent.alice',
        evmAddress: '0xabc',
        connected: true,
        petname: 'alice',
        pubkey: 'abc123def456',
      },
      {
        peerId: 'bob',
        ilpAddress: 'g.agent.bob',
        connected: false,
        petname: 'bob',
      },
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ peers: mockPeers }),
      })
    );

    const { result } = renderHook(() => usePeers());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.peers).toHaveLength(2);
    expect(result.current.peers[0].peerId).toBe('alice');
    expect(result.current.peers[0].connected).toBe(true);
    expect(result.current.peers[1].peerId).toBe('bob');
    expect(result.current.peers[1].connected).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('handles 404 gracefully (non-agent context)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Peers not available' }),
      })
    );

    const { result } = renderHook(() => usePeers());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.peers).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('sets error on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const { result } = renderHook(() => usePeers());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Network error');
  });

  it('sets error on non-OK HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      })
    );

    const { result } = renderHook(() => usePeers());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('HTTP 500');
  });

  it('polls periodically', async () => {
    vi.useFakeTimers();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ peers: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    renderHook(() => usePeers());

    // Initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance timer by 10 seconds
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('refresh triggers immediate fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ peers: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { result } = renderHook(() => usePeers());

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

  it('handles missing peers field gracefully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      })
    );

    const { result } = renderHook(() => usePeers());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.peers).toEqual([]);
  });
});
