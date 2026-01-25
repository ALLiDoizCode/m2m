import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEventFilters, DEFAULT_FILTERS } from './useEventFilters';

describe('useEventFilters', () => {
  describe('initialization', () => {
    it('should return default filters on initial render', () => {
      const { result } = renderHook(() => useEventFilters());

      expect(result.current.filters).toEqual(DEFAULT_FILTERS);
      expect(result.current.hasActiveFilters).toBe(false);
    });

    it('should accept initial filters', () => {
      const initialFilters = {
        eventTypes: ['PACKET_RECEIVED'],
        direction: 'sent' as const,
      };

      const { result } = renderHook(() => useEventFilters({ initialFilters }));

      expect(result.current.filters.eventTypes).toEqual(['PACKET_RECEIVED']);
      expect(result.current.filters.direction).toBe('sent');
      expect(result.current.hasActiveFilters).toBe(true);
    });
  });

  describe('setEventTypes', () => {
    it('should update event types filter', () => {
      const { result } = renderHook(() => useEventFilters());

      act(() => {
        result.current.setEventTypes(['PACKET_RECEIVED', 'PACKET_FORWARDED']);
      });

      expect(result.current.filters.eventTypes).toEqual(['PACKET_RECEIVED', 'PACKET_FORWARDED']);
      expect(result.current.hasActiveFilters).toBe(true);
    });

    it('should handle empty event types array', () => {
      const { result } = renderHook(() =>
        useEventFilters({ initialFilters: { eventTypes: ['PACKET_RECEIVED'] } })
      );

      act(() => {
        result.current.setEventTypes([]);
      });

      expect(result.current.filters.eventTypes).toEqual([]);
    });
  });

  describe('setTimeRange', () => {
    it('should update time range with custom values', () => {
      const { result } = renderHook(() => useEventFilters());

      const since = Date.now() - 60000;
      const until = Date.now();

      act(() => {
        result.current.setTimeRange({ since, until, preset: 'custom' });
      });

      expect(result.current.filters.timeRange.since).toBe(since);
      expect(result.current.filters.timeRange.until).toBe(until);
      expect(result.current.filters.timeRange.preset).toBe('custom');
      expect(result.current.hasActiveFilters).toBe(true);
    });
  });

  describe('setTimeRangePreset', () => {
    it('should set 1m preset', () => {
      const { result } = renderHook(() => useEventFilters());
      const now = Date.now();

      act(() => {
        result.current.setTimeRangePreset('1m');
      });

      expect(result.current.filters.timeRange.preset).toBe('1m');
      expect(result.current.filters.timeRange.since).toBeGreaterThan(now - 65000);
      expect(result.current.filters.timeRange.since).toBeLessThanOrEqual(now - 55000);
    });

    it('should set 5m preset', () => {
      const { result } = renderHook(() => useEventFilters());
      const now = Date.now();

      act(() => {
        result.current.setTimeRangePreset('5m');
      });

      expect(result.current.filters.timeRange.preset).toBe('5m');
      expect(result.current.filters.timeRange.since).toBeGreaterThan(now - 5 * 65000);
    });

    it('should set 1h preset', () => {
      const { result } = renderHook(() => useEventFilters());

      act(() => {
        result.current.setTimeRangePreset('1h');
      });

      expect(result.current.filters.timeRange.preset).toBe('1h');
      expect(result.current.filters.timeRange.since).toBeDefined();
    });

    it('should set 24h preset', () => {
      const { result } = renderHook(() => useEventFilters());

      act(() => {
        result.current.setTimeRangePreset('24h');
      });

      expect(result.current.filters.timeRange.preset).toBe('24h');
      expect(result.current.filters.timeRange.since).toBeDefined();
    });
  });

  describe('setDirection', () => {
    it('should update direction filter', () => {
      const { result } = renderHook(() => useEventFilters());

      act(() => {
        result.current.setDirection('sent');
      });

      expect(result.current.filters.direction).toBe('sent');
      expect(result.current.hasActiveFilters).toBe(true);
    });

    it('should set direction to received', () => {
      const { result } = renderHook(() => useEventFilters());

      act(() => {
        result.current.setDirection('received');
      });

      expect(result.current.filters.direction).toBe('received');
    });

    it('should set direction to internal', () => {
      const { result } = renderHook(() => useEventFilters());

      act(() => {
        result.current.setDirection('internal');
      });

      expect(result.current.filters.direction).toBe('internal');
    });

    it('should set direction to all (no filter)', () => {
      const { result } = renderHook(() =>
        useEventFilters({ initialFilters: { direction: 'sent' } })
      );

      act(() => {
        result.current.setDirection('all');
      });

      expect(result.current.filters.direction).toBe('all');
    });
  });

  describe('setSearchText', () => {
    it('should update search text', () => {
      const { result } = renderHook(() => useEventFilters());

      act(() => {
        result.current.setSearchText('test.peer');
      });

      expect(result.current.filters.searchText).toBe('test.peer');
      expect(result.current.hasActiveFilters).toBe(true);
    });

    it('should handle empty search text', () => {
      const { result } = renderHook(() =>
        useEventFilters({ initialFilters: { searchText: 'test' } })
      );

      act(() => {
        result.current.setSearchText('');
      });

      expect(result.current.filters.searchText).toBe('');
    });
  });

  describe('setFilters', () => {
    it('should update multiple filters at once', () => {
      const { result } = renderHook(() => useEventFilters());

      act(() => {
        result.current.setFilters({
          eventTypes: ['NODE_STATUS'],
          direction: 'internal',
          searchText: 'node1',
        });
      });

      expect(result.current.filters.eventTypes).toEqual(['NODE_STATUS']);
      expect(result.current.filters.direction).toBe('internal');
      expect(result.current.filters.searchText).toBe('node1');
    });

    it('should preserve unmodified filters', () => {
      const { result } = renderHook(() =>
        useEventFilters({
          initialFilters: {
            eventTypes: ['PACKET_RECEIVED'],
            direction: 'sent',
          },
        })
      );

      act(() => {
        result.current.setFilters({ searchText: 'test' });
      });

      expect(result.current.filters.eventTypes).toEqual(['PACKET_RECEIVED']);
      expect(result.current.filters.direction).toBe('sent');
      expect(result.current.filters.searchText).toBe('test');
    });
  });

  describe('resetFilters', () => {
    it('should reset all filters to defaults', () => {
      const { result } = renderHook(() => useEventFilters());

      act(() => {
        result.current.setFilters({
          eventTypes: ['PACKET_RECEIVED'],
          direction: 'sent',
          searchText: 'test',
          timeRange: { since: Date.now() - 60000, preset: '1m' },
        });
      });

      expect(result.current.hasActiveFilters).toBe(true);

      act(() => {
        result.current.resetFilters();
      });

      expect(result.current.filters).toEqual(DEFAULT_FILTERS);
      expect(result.current.hasActiveFilters).toBe(false);
    });
  });

  describe('hasActiveFilters', () => {
    it('should be false when no filters are active', () => {
      const { result } = renderHook(() => useEventFilters());

      expect(result.current.hasActiveFilters).toBe(false);
    });

    it('should be true when event types filter is active', () => {
      const { result } = renderHook(() => useEventFilters());

      act(() => {
        result.current.setEventTypes(['PACKET_RECEIVED']);
      });

      expect(result.current.hasActiveFilters).toBe(true);
    });

    it('should be true when time range is active', () => {
      const { result } = renderHook(() => useEventFilters());

      act(() => {
        result.current.setTimeRangePreset('1h');
      });

      expect(result.current.hasActiveFilters).toBe(true);
    });

    it('should be true when direction filter is not all', () => {
      const { result } = renderHook(() => useEventFilters());

      act(() => {
        result.current.setDirection('sent');
      });

      expect(result.current.hasActiveFilters).toBe(true);
    });

    it('should be true when search text is present', () => {
      const { result } = renderHook(() => useEventFilters());

      act(() => {
        result.current.setSearchText('test');
      });

      expect(result.current.hasActiveFilters).toBe(true);
    });
  });
});
