import { useState, useCallback } from 'react';
import { FilterState, TimeRange, TimeRangePreset } from '../components/FilterBar';

/**
 * Default filter state
 */
const DEFAULT_FILTERS: FilterState = {
  eventTypes: [],
  timeRange: {},
  direction: 'all',
  searchText: '',
};

interface UseEventFiltersOptions {
  /** Initial filter state */
  initialFilters?: Partial<FilterState>;
}

interface UseEventFiltersResult {
  /** Current filter state */
  filters: FilterState;
  /** Update specific filters */
  setFilters: (updates: Partial<FilterState>) => void;
  /** Set event types filter */
  setEventTypes: (types: string[]) => void;
  /** Set time range */
  setTimeRange: (range: TimeRange) => void;
  /** Set time range from preset */
  setTimeRangePreset: (preset: TimeRangePreset) => void;
  /** Set direction filter */
  setDirection: (direction: FilterState['direction']) => void;
  /** Set search text */
  setSearchText: (text: string) => void;
  /** Reset all filters to defaults */
  resetFilters: () => void;
  /** Check if any filters are active */
  hasActiveFilters: boolean;
}

/**
 * Get time range from preset
 */
function getTimeRangeFromPreset(preset: TimeRangePreset): TimeRange {
  const now = Date.now();
  switch (preset) {
    case '1m':
      return { since: now - 60 * 1000, preset };
    case '5m':
      return { since: now - 5 * 60 * 1000, preset };
    case '1h':
      return { since: now - 60 * 60 * 1000, preset };
    case '24h':
      return { since: now - 24 * 60 * 60 * 1000, preset };
    case 'custom':
    default:
      return { preset };
  }
}

/**
 * Hook for managing filter state
 */
export function useEventFilters(options: UseEventFiltersOptions = {}): UseEventFiltersResult {
  const { initialFilters = {} } = options;

  const [filters, setFiltersState] = useState<FilterState>({
    ...DEFAULT_FILTERS,
    ...initialFilters,
  });

  /**
   * Update specific filters
   */
  const setFilters = useCallback((updates: Partial<FilterState>) => {
    setFiltersState((prev) => ({ ...prev, ...updates }));
  }, []);

  /**
   * Set event types filter
   */
  const setEventTypes = useCallback((types: string[]) => {
    setFiltersState((prev) => ({ ...prev, eventTypes: types }));
  }, []);

  /**
   * Set time range
   */
  const setTimeRange = useCallback((range: TimeRange) => {
    setFiltersState((prev) => ({ ...prev, timeRange: range }));
  }, []);

  /**
   * Set time range from preset
   */
  const setTimeRangePreset = useCallback((preset: TimeRangePreset) => {
    const range = getTimeRangeFromPreset(preset);
    setFiltersState((prev) => ({ ...prev, timeRange: range }));
  }, []);

  /**
   * Set direction filter
   */
  const setDirection = useCallback((direction: FilterState['direction']) => {
    setFiltersState((prev) => ({ ...prev, direction }));
  }, []);

  /**
   * Set search text
   */
  const setSearchText = useCallback((text: string) => {
    setFiltersState((prev) => ({ ...prev, searchText: text }));
  }, []);

  /**
   * Reset all filters to defaults
   */
  const resetFilters = useCallback(() => {
    setFiltersState(DEFAULT_FILTERS);
  }, []);

  /**
   * Check if any filters are active
   */
  const hasActiveFilters =
    filters.eventTypes.length > 0 ||
    filters.timeRange.preset !== undefined ||
    filters.timeRange.since !== undefined ||
    filters.timeRange.until !== undefined ||
    filters.direction !== 'all' ||
    filters.searchText !== '';

  return {
    filters,
    setFilters,
    setEventTypes,
    setTimeRange,
    setTimeRangePreset,
    setDirection,
    setSearchText,
    resetFilters,
    hasActiveFilters,
  };
}

/**
 * Default filter state export for external use
 */
export { DEFAULT_FILTERS };
