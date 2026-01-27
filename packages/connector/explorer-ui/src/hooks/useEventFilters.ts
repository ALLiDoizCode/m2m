import { useState, useCallback, useEffect, useRef } from 'react';
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

/**
 * Valid direction values
 */
const VALID_DIRECTIONS: FilterState['direction'][] = ['all', 'sent', 'received', 'internal'];

/**
 * Valid time range presets
 */
const VALID_PRESETS: TimeRangePreset[] = ['1m', '5m', '1h', '24h', 'custom'];

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
  /** Number of active non-default filters */
  activeFilterCount: number;
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
 * Parse filter state from URL search params
 */
function parseFiltersFromURL(): Partial<FilterState> {
  try {
    const params = new URLSearchParams(window.location.search);
    const result: Partial<FilterState> = {};

    // eventTypes
    const eventTypes = params.get('eventTypes');
    if (eventTypes) {
      result.eventTypes = eventTypes.split(',').filter(Boolean);
    }

    // direction
    const direction = params.get('direction');
    if (direction && VALID_DIRECTIONS.includes(direction as FilterState['direction'])) {
      result.direction = direction as FilterState['direction'];
    }

    // search
    const search = params.get('search');
    if (search) {
      result.searchText = search;
    }

    // timeRange
    const timeRange = params.get('timeRange');
    const timeStart = params.get('timeStart');
    const timeEnd = params.get('timeEnd');

    if (
      timeRange &&
      VALID_PRESETS.includes(timeRange as TimeRangePreset) &&
      timeRange !== 'custom'
    ) {
      result.timeRange = getTimeRangeFromPreset(timeRange as TimeRangePreset);
    } else if (timeStart || timeEnd) {
      const tr: TimeRange = { preset: 'custom' };
      if (timeStart) {
        const ts = new Date(timeStart).getTime();
        if (!isNaN(ts)) tr.since = ts;
      }
      if (timeEnd) {
        const ts = new Date(timeEnd).getTime();
        if (!isNaN(ts)) tr.until = ts;
      }
      if (tr.since !== undefined || tr.until !== undefined) {
        result.timeRange = tr;
      }
    }

    return result;
  } catch {
    return {};
  }
}

/**
 * Serialize filter state to URL search params
 */
function serializeFiltersToURL(filters: FilterState): void {
  try {
    const params = new URLSearchParams();

    if (filters.eventTypes.length > 0) {
      params.set('eventTypes', filters.eventTypes.join(','));
    }

    if (filters.direction !== 'all') {
      params.set('direction', filters.direction);
    }

    if (filters.searchText) {
      params.set('search', filters.searchText);
    }

    if (filters.timeRange.preset && filters.timeRange.preset !== 'custom') {
      params.set('timeRange', filters.timeRange.preset);
    } else if (filters.timeRange.preset === 'custom') {
      if (filters.timeRange.since !== undefined) {
        params.set('timeStart', new Date(filters.timeRange.since).toISOString());
      }
      if (filters.timeRange.until !== undefined) {
        params.set('timeEnd', new Date(filters.timeRange.until).toISOString());
      }
    }

    const queryString = params.toString();
    const newUrl = queryString
      ? `${window.location.pathname}?${queryString}`
      : window.location.pathname;

    window.history.replaceState(null, '', newUrl);
  } catch {
    // Silently ignore URL serialization errors
  }
}

/**
 * Hook for managing filter state with URL persistence
 */
export function useEventFilters(options: UseEventFiltersOptions = {}): UseEventFiltersResult {
  const { initialFilters = {} } = options;

  // On mount, parse URL params and merge with defaults (URL takes precedence)
  const [filters, setFiltersState] = useState<FilterState>(() => {
    const urlFilters = parseFiltersFromURL();
    return {
      ...DEFAULT_FILTERS,
      ...initialFilters,
      ...urlFilters,
    };
  });

  // Track whether this is the initial mount to avoid double-writing URL
  const isInitialMount = useRef(true);

  // Sync filter state to URL whenever filters change
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      // Still write on mount to ensure URL is clean
      serializeFiltersToURL(filters);
      return;
    }
    serializeFiltersToURL(filters);
  }, [filters]);

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
   * Reset all filters to defaults and clear URL params
   */
  const resetFilters = useCallback(() => {
    setFiltersState(DEFAULT_FILTERS);
    // Clear URL params explicitly
    try {
      window.history.replaceState(null, '', window.location.pathname);
    } catch {
      // Silently ignore
    }
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

  /**
   * Count number of active non-default filters
   */
  let activeFilterCount = 0;
  if (filters.eventTypes.length > 0) activeFilterCount++;
  if (
    filters.timeRange.preset !== undefined ||
    filters.timeRange.since !== undefined ||
    filters.timeRange.until !== undefined
  ) {
    activeFilterCount++;
  }
  if (filters.direction !== 'all') activeFilterCount++;
  if (filters.searchText !== '') activeFilterCount++;

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
    activeFilterCount,
  };
}

/**
 * Default filter state export for external use
 */
export { DEFAULT_FILTERS };
