import * as React from 'react';
import { Check, ChevronsUpDown, X, Search, CalendarIcon, Wallet } from 'lucide-react';
import { format } from 'date-fns';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Calendar } from '@/components/ui/calendar';
import { TelemetryEventType, EVENT_TYPE_COLORS, SETTLEMENT_EVENT_TYPES } from '../lib/event-types';
import { DateRange } from 'react-day-picker';

/**
 * Time range preset options
 */
export type TimeRangePreset = '1m' | '5m' | '1h' | '24h' | 'custom';

/**
 * Time range configuration
 */
export interface TimeRange {
  since?: number;
  until?: number;
  preset?: TimeRangePreset;
}

/**
 * Filter state interface
 */
export interface FilterState {
  eventTypes: string[];
  timeRange: TimeRange;
  direction: 'all' | 'sent' | 'received' | 'internal';
  searchText: string;
}

/**
 * FilterBar component props
 */
export interface FilterBarProps {
  filters: FilterState;
  onFilterChange: (filters: Partial<FilterState>) => void;
  onReset: () => void;
  activeFilterCount?: number;
}

/**
 * All available telemetry event types
 */
const ALL_EVENT_TYPES: TelemetryEventType[] = [
  'NODE_STATUS',
  'PACKET_RECEIVED',
  'PACKET_FORWARDED',
  'ACCOUNT_BALANCE',
  'SETTLEMENT_TRIGGERED',
  'SETTLEMENT_COMPLETED',
  'AGENT_BALANCE_CHANGED',
  'AGENT_WALLET_FUNDED',
  'AGENT_WALLET_STATE_CHANGED',
  'FUNDING_RATE_LIMIT_EXCEEDED',
  'FUNDING_TRANSACTION_CONFIRMED',
  'FUNDING_TRANSACTION_FAILED',
  'PAYMENT_CHANNEL_OPENED',
  'PAYMENT_CHANNEL_BALANCE_UPDATE',
  'PAYMENT_CHANNEL_SETTLED',
  'XRP_CHANNEL_OPENED',
  'XRP_CHANNEL_CLAIMED',
  'XRP_CHANNEL_CLOSED',
  'AGENT_CHANNEL_OPENED',
  'AGENT_CHANNEL_PAYMENT_SENT',
  'AGENT_CHANNEL_CLOSED',
  'WALLET_BALANCE_MISMATCH',
  'SUSPICIOUS_ACTIVITY_DETECTED',
  'RATE_LIMIT_EXCEEDED',
];

/**
 * Event type categories for grouped display
 */
const EVENT_TYPE_CATEGORIES: Record<string, TelemetryEventType[]> = {
  Node: ['NODE_STATUS'],
  Packets: ['PACKET_RECEIVED', 'PACKET_FORWARDED'],
  Account: ['ACCOUNT_BALANCE', 'SETTLEMENT_TRIGGERED', 'SETTLEMENT_COMPLETED'],
  'Agent Wallet': [
    'AGENT_BALANCE_CHANGED',
    'AGENT_WALLET_FUNDED',
    'AGENT_WALLET_STATE_CHANGED',
    'FUNDING_RATE_LIMIT_EXCEEDED',
    'FUNDING_TRANSACTION_CONFIRMED',
    'FUNDING_TRANSACTION_FAILED',
  ],
  'EVM Channels': [
    'PAYMENT_CHANNEL_OPENED',
    'PAYMENT_CHANNEL_BALANCE_UPDATE',
    'PAYMENT_CHANNEL_SETTLED',
  ],
  'XRP Channels': ['XRP_CHANNEL_OPENED', 'XRP_CHANNEL_CLAIMED', 'XRP_CHANNEL_CLOSED'],
  'Agent Channels': ['AGENT_CHANNEL_OPENED', 'AGENT_CHANNEL_PAYMENT_SENT', 'AGENT_CHANNEL_CLOSED'],
  Security: ['WALLET_BALANCE_MISMATCH', 'SUSPICIOUS_ACTIVITY_DETECTED', 'RATE_LIMIT_EXCEEDED'],
};

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
    default:
      return { preset };
  }
}

/**
 * Format time range for display
 */
function formatTimeRange(range: TimeRange): string {
  if (range.preset && range.preset !== 'custom') {
    const labels: Record<string, string> = {
      '1m': 'Last 1 minute',
      '5m': 'Last 5 minutes',
      '1h': 'Last 1 hour',
      '24h': 'Last 24 hours',
    };
    return labels[range.preset] || 'All time';
  }
  if (range.since && range.until) {
    return `${format(range.since, 'MMM d, HH:mm')} - ${format(range.until, 'MMM d, HH:mm')}`;
  }
  if (range.since) {
    return `Since ${format(range.since, 'MMM d, HH:mm')}`;
  }
  if (range.until) {
    return `Until ${format(range.until, 'MMM d, HH:mm')}`;
  }
  return 'All time';
}

/**
 * Multi-select dropdown for event types
 */
function EventTypeMultiSelect({
  selectedTypes,
  onSelectionChange,
}: {
  selectedTypes: string[];
  onSelectionChange: (types: string[]) => void;
}) {
  const [open, setOpen] = React.useState(false);

  const handleToggle = (eventType: string) => {
    if (selectedTypes.includes(eventType)) {
      onSelectionChange(selectedTypes.filter((t) => t !== eventType));
    } else {
      onSelectionChange([...selectedTypes, eventType]);
    }
  };

  const handleSelectAll = () => {
    onSelectionChange([...ALL_EVENT_TYPES]);
  };

  const handleClearAll = () => {
    onSelectionChange([]);
  };

  const displayText =
    selectedTypes.length === 0
      ? 'All event types'
      : selectedTypes.length === ALL_EVENT_TYPES.length
        ? 'All event types'
        : `${selectedTypes.length} types selected`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-[180px] justify-between"
        >
          <span className="truncate">{displayText}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search event types..." />
          <CommandList>
            <CommandEmpty>No event type found.</CommandEmpty>
            <CommandGroup>
              <CommandItem onSelect={handleSelectAll}>
                <Check
                  className={cn(
                    'mr-2 h-4 w-4',
                    selectedTypes.length === ALL_EVENT_TYPES.length ? 'opacity-100' : 'opacity-0'
                  )}
                />
                Select All
              </CommandItem>
              <CommandItem onSelect={handleClearAll}>
                <X className="mr-2 h-4 w-4 opacity-50" />
                Clear All
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            {Object.entries(EVENT_TYPE_CATEGORIES).map(([category, types]) => (
              <CommandGroup key={category} heading={category}>
                {types.map((eventType) => (
                  <CommandItem
                    key={eventType}
                    value={eventType}
                    onSelect={() => handleToggle(eventType)}
                  >
                    <Check
                      className={cn(
                        'mr-2 h-4 w-4',
                        selectedTypes.includes(eventType) ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    <Badge
                      variant="secondary"
                      className={`${EVENT_TYPE_COLORS[eventType] || 'bg-gray-500'} text-white text-xs mr-2`}
                    >
                      {eventType.replace(/_/g, ' ')}
                    </Badge>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Time range selector component
 */
function TimeRangeSelector({
  timeRange,
  onTimeRangeChange,
}: {
  timeRange: TimeRange;
  onTimeRangeChange: (range: TimeRange) => void;
}) {
  const [calendarOpen, setCalendarOpen] = React.useState(false);
  const [dateRange, setDateRange] = React.useState<DateRange | undefined>(
    timeRange.since && timeRange.until
      ? { from: new Date(timeRange.since), to: new Date(timeRange.until) }
      : undefined
  );

  const handlePresetClick = (preset: TimeRangePreset) => {
    if (preset === 'custom') {
      setCalendarOpen(true);
    } else {
      onTimeRangeChange(getTimeRangeFromPreset(preset));
    }
  };

  const handleDateRangeSelect = (range: DateRange | undefined) => {
    setDateRange(range);
    if (range?.from && range?.to) {
      onTimeRangeChange({
        since: range.from.getTime(),
        until: range.to.getTime(),
        preset: 'custom',
      });
    } else if (range?.from) {
      onTimeRangeChange({
        since: range.from.getTime(),
        preset: 'custom',
      });
    }
  };

  const presets: TimeRangePreset[] = ['1m', '5m', '1h', '24h'];

  return (
    <div className="flex items-center gap-1">
      {presets.map((preset) => (
        <Button
          key={preset}
          variant={timeRange.preset === preset ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => handlePresetClick(preset)}
          className="px-2"
        >
          {preset}
        </Button>
      ))}
      <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={timeRange.preset === 'custom' ? 'secondary' : 'ghost'}
            size="sm"
            className="px-2"
          >
            <CalendarIcon className="h-4 w-4 mr-1" />
            Custom
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            selected={dateRange}
            onSelect={handleDateRangeSelect}
            numberOfMonths={2}
          />
          <div className="p-3 border-t">
            <Button size="sm" className="w-full" onClick={() => setCalendarOpen(false)}>
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <span className="text-sm text-muted-foreground ml-2">{formatTimeRange(timeRange)}</span>
    </div>
  );
}

/**
 * FilterBar component
 */
export function FilterBar({ filters, onFilterChange, onReset, activeFilterCount }: FilterBarProps) {
  const [searchInput, setSearchInput] = React.useState(filters.searchText);
  const searchTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);

  // Debounced search update
  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    searchTimeoutRef.current = setTimeout(() => {
      onFilterChange({ searchText: value });
    }, 300);
  };

  // Clear search
  const handleClearSearch = () => {
    setSearchInput('');
    onFilterChange({ searchText: '' });
  };

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, []);

  // Sync searchInput with filters.searchText when filters change externally
  React.useEffect(() => {
    setSearchInput(filters.searchText);
  }, [filters.searchText]);

  const hasActiveFilters =
    filters.eventTypes.length > 0 ||
    filters.timeRange.preset !== undefined ||
    filters.direction !== 'all' ||
    filters.searchText !== '';

  return (
    <div className="flex flex-col gap-3 px-4 md:px-6 py-3 border-b border-border bg-card">
      {/* First row: Event types and Direction */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">Type:</span>
          <EventTypeMultiSelect
            selectedTypes={filters.eventTypes}
            onSelectionChange={(types) => onFilterChange({ eventTypes: types })}
          />
          {/* Settlement quick filter preset (Story 14.6) */}
          <Button
            variant={
              filters.eventTypes.length === SETTLEMENT_EVENT_TYPES.length &&
              SETTLEMENT_EVENT_TYPES.every((t) => filters.eventTypes.includes(t))
                ? 'secondary'
                : 'outline'
            }
            size="sm"
            onClick={() => {
              const isSettlementActive =
                filters.eventTypes.length === SETTLEMENT_EVENT_TYPES.length &&
                SETTLEMENT_EVENT_TYPES.every((t) => filters.eventTypes.includes(t));
              onFilterChange({ eventTypes: isSettlementActive ? [] : [...SETTLEMENT_EVENT_TYPES] });
            }}
            className="gap-1.5"
          >
            <Wallet className="h-4 w-4" />
            Settlement
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">Direction:</span>
          <Select
            value={filters.direction}
            onValueChange={(value) =>
              onFilterChange({ direction: value as FilterState['direction'] })
            }
          >
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="Direction" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="sent">Sent</SelectItem>
              <SelectItem value="received">Received</SelectItem>
              <SelectItem value="internal">Internal</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2 flex-1 min-w-[200px] w-full md:w-auto">
          <span className="text-sm font-medium text-muted-foreground">Search:</span>
          <div className="relative flex-1 max-w-full md:max-w-[300px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              id="explorer-search-input"
              placeholder="Search destination, peer, packet..."
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-8 pr-8"
            />
            {searchInput && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1 h-7 w-7"
                onClick={handleClearSearch}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        {hasActiveFilters && (
          <div className="flex items-center gap-2">
            {activeFilterCount !== undefined && activeFilterCount > 0 && (
              <Badge variant="secondary" className="text-xs">
                {activeFilterCount} active
              </Badge>
            )}
            <Button variant="outline" size="sm" onClick={onReset}>
              <X className="h-4 w-4 mr-1" />
              Clear all filters
            </Button>
          </div>
        )}
      </div>

      {/* Second row: Time range */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-muted-foreground">Time:</span>
        <TimeRangeSelector
          timeRange={filters.timeRange}
          onTimeRangeChange={(range) => onFilterChange({ timeRange: range })}
        />
      </div>

      {/* Selected event types badges */}
      {filters.eventTypes.length > 0 && filters.eventTypes.length < ALL_EVENT_TYPES.length && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-muted-foreground">Showing:</span>
          {filters.eventTypes.slice(0, 5).map((type) => (
            <Badge
              key={type}
              variant="secondary"
              className={`${EVENT_TYPE_COLORS[type] || 'bg-gray-500'} text-white text-xs cursor-pointer`}
              onClick={() =>
                onFilterChange({
                  eventTypes: filters.eventTypes.filter((t) => t !== type),
                })
              }
            >
              {type.replace(/_/g, ' ')}
              <X className="h-3 w-3 ml-1" />
            </Badge>
          ))}
          {filters.eventTypes.length > 5 && (
            <span className="text-xs text-muted-foreground">
              +{filters.eventTypes.length - 5} more
            </span>
          )}
        </div>
      )}
    </div>
  );
}
