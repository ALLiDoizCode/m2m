import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  TelemetryEvent,
  EVENT_TYPE_COLORS,
  PACKET_TYPE_COLORS,
  formatRelativeTime,
} from '../lib/event-types';
import { Badge } from '@/components/ui/badge';
import { useKeyboardNavigation } from '../hooks/useKeyboardNavigation';
import { Radio, WifiOff, SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface EventTableProps {
  events: TelemetryEvent[];
  onEventClick?: (event: TelemetryEvent) => void;
  loading?: boolean;
  showPagination?: boolean;
  total?: number;
  onLoadMore?: () => void;
  connectionStatus?: 'connecting' | 'connected' | 'disconnected' | 'error';
  hasActiveFilters?: boolean;
  onClearFilters?: () => void;
  onScrollStateChange?: (isAtTop: boolean) => void;
}

const ROW_HEIGHT = 48;

/**
 * Check if event is a packet event with ILP semantics
 */
function isPacketEvent(event: TelemetryEvent): boolean {
  return event.type === 'AGENT_CHANNEL_PAYMENT_SENT' && 'packetType' in event;
}

/**
 * Get display type - packet type for packet events, event type otherwise
 */
function getDisplayType(event: TelemetryEvent): { label: string; colorClass: string } {
  if (isPacketEvent(event)) {
    const packetType = (event as { packetType?: string }).packetType;
    if (packetType) {
      const label = packetType.charAt(0).toUpperCase() + packetType.slice(1);
      const colorClass = PACKET_TYPE_COLORS[packetType] || 'bg-gray-500';
      return { label, colorClass };
    }
  }
  // Fallback to event type
  return {
    label: event.type.replace(/_/g, ' '),
    colorClass: EVENT_TYPE_COLORS[event.type] || 'bg-gray-500',
  };
}

/**
 * Get the "from" address (packet sender)
 */
function getFrom(event: TelemetryEvent): string | null {
  if ('from' in event && typeof event.from === 'string') {
    return event.from;
  }
  // Fallback for older events
  if ('agentId' in event && typeof event.agentId === 'string') {
    return event.agentId;
  }
  return null;
}

/**
 * Get the "to" address (next hop)
 */
function getTo(event: TelemetryEvent): string | null {
  if ('to' in event && typeof event.to === 'string') {
    return event.to;
  }
  // Fallback for older events
  if ('peerId' in event && typeof event.peerId === 'string') {
    return event.peerId;
  }
  return null;
}

/**
 * Extract amount from event
 */
function getAmount(event: TelemetryEvent): string | null {
  const amountFields = [
    'amount',
    'settledAmount',
    'netBalance',
    'change',
    'claimAmount',
    'finalBalance',
  ];
  for (const field of amountFields) {
    if (field in event && event[field]) {
      return event[field] as string;
    }
  }
  return null;
}

/**
 * Format amount for display (truncate large numbers)
 */
function formatAmount(amount: string): string {
  try {
    const num = BigInt(amount);
    if (num > BigInt(1e18)) {
      return `${(Number(num) / 1e18).toFixed(4)} ETH`;
    }
    if (num > BigInt(1e12)) {
      return `${(Number(num) / 1e12).toFixed(2)}T`;
    }
    if (num > BigInt(1e9)) {
      return `${(Number(num) / 1e9).toFixed(2)}B`;
    }
    if (num > BigInt(1e6)) {
      return `${(Number(num) / 1e6).toFixed(2)}M`;
    }
    if (num > BigInt(1e3)) {
      return `${(Number(num) / 1e3).toFixed(2)}K`;
    }
    return amount;
  } catch {
    return amount;
  }
}

/**
 * Normalize timestamp to number
 */
function normalizeTimestamp(ts: string | number): number {
  if (typeof ts === 'number') return ts;
  return new Date(ts).getTime();
}

/**
 * Extract destination ILP address from event
 */
function getDestination(event: TelemetryEvent): string | null {
  const destFields = ['destination', 'destinationAddress', 'to', 'toAddress'];
  for (const field of destFields) {
    if (field in event && typeof event[field] === 'string') {
      return event[field] as string;
    }
  }
  return null;
}

/**
 * Truncate ILP address for display
 */
function formatDestination(destination: string): string {
  if (destination.length <= 30) return destination;
  return `${destination.slice(0, 20)}...${destination.slice(-8)}`;
}

/**
 * Get Explorer URL for a peer ID or ILP address
 * Maps peer IDs like "peer-0", "peer-1" or ILP addresses like "g.agent.peer-0"
 * to their Explorer ports. Returns null if no peer pattern is found.
 */
function getPeerExplorerUrl(address: string | null): string | null {
  if (!address) return null;

  // Try to extract peer index from ILP address (e.g., "g.agent.peer-0" -> 0)
  // or peer ID (e.g., "peer-0" -> 0)
  const peerMatch = address.match(/peer-(\d+)/i);
  if (peerMatch) {
    const peerIndex = parseInt(peerMatch[1], 10);
    const explorerPort = 9100 + peerIndex;
    // Use current hostname but different port
    const currentHost = window.location.hostname;
    return `http://${currentHost}:${explorerPort}`;
  }

  // Also handle agent-0, agent-1 patterns
  const agentMatch = address.match(/agent-(\d+)/i);
  if (agentMatch) {
    const agentIndex = parseInt(agentMatch[1], 10);
    const explorerPort = 9100 + agentIndex;
    const currentHost = window.location.hostname;
    return `http://${currentHost}:${explorerPort}`;
  }

  return null;
}

/**
 * Determine event status (success/failure/pending/neutral)
 */
type EventStatus = 'success' | 'failure' | 'pending' | 'neutral';

/**
 * Build a map of packet_id -> resolved status from FULFILL/REJECT packets
 * This is used to show the resolved status for PREPARE packets
 */
function buildPacketStatusMap(events: TelemetryEvent[]): Map<string, 'success' | 'failure'> {
  const statusMap = new Map<string, 'success' | 'failure'>();

  for (const event of events) {
    if (event.type === 'AGENT_CHANNEL_PAYMENT_SENT' && 'packetType' in event) {
      const packetEvent = event as { packetType?: string; packetId?: string };
      const packetId = packetEvent.packetId;
      if (!packetId) continue;

      if (packetEvent.packetType === 'fulfill') {
        statusMap.set(packetId, 'success');
      } else if (packetEvent.packetType === 'reject') {
        statusMap.set(packetId, 'failure');
      }
    }
  }

  return statusMap;
}

/**
 * Get packet ID from event
 */
function getPacketId(event: TelemetryEvent): string | null {
  if ('packetId' in event && typeof event.packetId === 'string') {
    return event.packetId;
  }
  return null;
}

function getEventStatus(
  event: TelemetryEvent,
  resolvedStatus?: 'success' | 'failure'
): EventStatus {
  const type = event.type;

  // For packet events, status is based on packet type
  if (type === 'AGENT_CHANNEL_PAYMENT_SENT' && 'packetType' in event) {
    const packetType = (event as { packetType?: string }).packetType;
    if (packetType === 'fulfill') return 'success';
    if (packetType === 'reject') return 'failure';
    // For PREPARE packets, use the resolved status if available
    if (packetType === 'prepare') {
      return resolvedStatus || 'pending';
    }
  }

  const successTypes = [
    'PACKET_FORWARDED',
    'SETTLEMENT_COMPLETED',
    'FUNDING_TRANSACTION_CONFIRMED',
    'PAYMENT_CHANNEL_SETTLED',
    'XRP_CHANNEL_CLAIMED',
    'AGENT_WALLET_FUNDED',
    // Channel opened events are emitted after successful on-chain confirmation
    'PAYMENT_CHANNEL_OPENED',
    'XRP_CHANNEL_OPENED',
    'AGENT_CHANNEL_OPENED',
  ];

  const failureTypes = [
    'FUNDING_TRANSACTION_FAILED',
    'WALLET_BALANCE_MISMATCH',
    'SUSPICIOUS_ACTIVITY_DETECTED',
    'RATE_LIMIT_EXCEEDED',
    'FUNDING_RATE_LIMIT_EXCEEDED',
  ];

  const pendingTypes = ['SETTLEMENT_TRIGGERED'];

  if (successTypes.includes(type)) return 'success';
  if (failureTypes.includes(type)) return 'failure';
  if (pendingTypes.includes(type)) return 'pending';
  return 'neutral';
}

/**
 * Get status display with icon and color
 */
function getStatusDisplay(status: EventStatus): { icon: string; text: string; className: string } {
  switch (status) {
    case 'success':
      return { icon: '✓', text: 'Success', className: 'text-green-500' };
    case 'failure':
      return { icon: '✗', text: 'Failed', className: 'text-red-400' };
    case 'pending':
      return { icon: '◐', text: 'Pending', className: 'text-yellow-500' };
    default:
      return { icon: '○', text: '-', className: 'text-muted-foreground' };
  }
}

/**
 * Clickable peer link component
 * Opens the peer's Explorer in a new tab
 */
const PeerLink = React.memo(function PeerLink({ peerId }: { peerId: string | null }) {
  if (!peerId) return <span>-</span>;

  const explorerUrl = getPeerExplorerUrl(peerId);

  if (!explorerUrl) {
    // Not a recognized peer ID format, just display as text
    return <span title={peerId}>{peerId}</span>;
  }

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent row click
    window.open(explorerUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <button
      onClick={handleClick}
      className="text-blue-400 hover:text-blue-300 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 focus:ring-offset-background rounded"
      title={`Open ${peerId} Explorer (${explorerUrl})`}
    >
      {peerId}
    </button>
  );
});

/**
 * Memoized row component for better performance
 */
const EventRow = React.memo(function EventRow({
  event,
  onSelect,
  index,
  style,
  resolvedStatus,
  isSelected,
  isNew,
}: {
  event: TelemetryEvent;
  onSelect?: (index: number) => void;
  index: number;
  style: React.CSSProperties;
  resolvedStatus?: 'success' | 'failure';
  isSelected?: boolean;
  isNew?: boolean;
}) {
  const handleClick = React.useCallback(() => {
    onSelect?.(index);
  }, [onSelect, index]);
  const displayType = getDisplayType(event);
  const from = getFrom(event);
  const to = getTo(event);
  const amount = getAmount(event);
  const timestamp = normalizeTimestamp(event.timestamp);
  const destination = getDestination(event);
  const status = getEventStatus(event, resolvedStatus);
  const statusDisplay = getStatusDisplay(status);

  return (
    <div
      className={`flex items-center border-b border-border cursor-pointer hover:bg-muted/50 ${isSelected ? 'bg-muted/50 ring-1 ring-primary' : ''} ${isNew ? 'animate-fadeIn' : ''}`}
      style={style}
      onClick={handleClick}
    >
      <div className="w-[12%] min-w-[80px] px-3 font-mono text-sm text-muted-foreground truncate">
        {formatRelativeTime(timestamp)}
      </div>
      <div className="w-[14%] min-w-[100px] px-3">
        <Badge
          variant="secondary"
          className={`${displayType.colorClass} text-white text-xs max-w-full truncate`}
          title={displayType.label}
        >
          {displayType.label}
        </Badge>
      </div>
      <div className="w-[16%] min-w-[100px] px-3 font-mono text-sm truncate">
        <PeerLink peerId={from} />
      </div>
      <div className="w-[16%] min-w-[100px] px-3 font-mono text-sm truncate">
        <PeerLink peerId={to} />
      </div>
      <div
        className="hidden lg:block w-[20%] min-w-[150px] px-3 font-mono text-sm truncate"
        title={destination || undefined}
      >
        {destination ? formatDestination(destination) : '-'}
      </div>
      <div className="hidden md:block w-[10%] min-w-[80px] px-3 font-mono text-sm truncate">
        {amount ? formatAmount(amount) : '-'}
      </div>
      <div className={`w-[12%] min-w-[80px] px-3 text-sm ${statusDisplay.className}`}>
        <span title={statusDisplay.text}>
          {statusDisplay.icon} {statusDisplay.text}
        </span>
      </div>
    </div>
  );
});

export function EventTable({
  events,
  onEventClick,
  loading,
  showPagination,
  total,
  onLoadMore,
  onScrollStateChange,
  ...emptyStateProps
}: EventTableProps) {
  const { connectionStatus, hasActiveFilters, onClearFilters } = emptyStateProps;
  const parentRef = React.useRef<HTMLDivElement>(null);
  const eventsRef = React.useRef(events);
  eventsRef.current = events;

  // Build a map of packet_id -> resolved status for PREPARE packets
  const packetStatusMap = React.useMemo(() => buildPacketStatusMap(events), [events]);

  // Track new events for fade-in animation (live mode only)
  const prevEventCountRef = React.useRef(events.length);
  const newEventCountRef = React.useRef(0);
  const isLiveMode = !showPagination;

  React.useEffect(() => {
    const prevCount = prevEventCountRef.current;
    const currentCount = events.length;
    if (isLiveMode && currentCount > prevCount) {
      // New events were prepended at the beginning
      newEventCountRef.current = currentCount - prevCount;
      // Clear new event markers after animation duration
      const timer = setTimeout(() => {
        newEventCountRef.current = 0;
      }, 500);
      prevEventCountRef.current = currentCount;
      return () => clearTimeout(timer);
    }
    prevEventCountRef.current = currentCount;
  }, [events.length, isLiveMode]);

  // Stable callback that uses ref-based lookup to avoid events array dependency
  const handleRowSelect = React.useCallback(
    (index: number) => {
      onEventClick?.(eventsRef.current[index]);
    },
    [onEventClick]
  );

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // Stable scrollToIndex callback for keyboard navigation
  const scrollToIndex = React.useCallback(
    (index: number) => {
      virtualizer.scrollToIndex(index, { align: 'auto' });
    },
    [virtualizer]
  );

  // Keyboard navigation for event rows (j/k/Enter)
  const { selectedIndex } = useKeyboardNavigation({
    events,
    onEventClick: onEventClick || (() => {}),
    scrollToIndex,
  });

  // Monitor scroll position for auto-switch to live
  const lastIsAtTopRef = React.useRef(true);
  React.useEffect(() => {
    const scrollEl = parentRef.current;
    if (!scrollEl || !onScrollStateChange) return;

    const handleScroll = () => {
      const isAtTop = scrollEl.scrollTop <= 10;
      if (isAtTop !== lastIsAtTopRef.current) {
        lastIsAtTopRef.current = isAtTop;
        onScrollStateChange(isAtTop);
      }
    };

    scrollEl.addEventListener('scroll', handleScroll, { passive: true });
    return () => scrollEl.removeEventListener('scroll', handleScroll);
  }, [onScrollStateChange]);

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="flex flex-col h-[calc(100vh-280px)]">
      {/* Header */}
      <div className="flex items-center border-b border-border bg-muted/50 h-10 shrink-0 min-w-0 shadow-sm">
        <div className="w-[12%] min-w-[80px] px-3 text-sm font-medium">Time</div>
        <div className="w-[14%] min-w-[100px] px-3 text-sm font-medium">Type</div>
        <div className="w-[16%] min-w-[100px] px-3 text-sm font-medium">From</div>
        <div className="w-[16%] min-w-[100px] px-3 text-sm font-medium">To</div>
        <div className="hidden lg:block w-[20%] min-w-[150px] px-3 text-sm font-medium">
          Destination
        </div>
        <div className="hidden md:block w-[10%] min-w-[80px] px-3 text-sm font-medium">Amount</div>
        <div className="w-[12%] min-w-[80px] px-3 text-sm font-medium">Status</div>
      </div>

      {/* Body with virtual scrolling */}
      <div ref={parentRef} className="flex-1 overflow-auto">
        {loading ? (
          <div className="w-full">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center border-b border-border h-12">
                <div className="w-[12%] min-w-[80px] px-3">
                  <div className="h-4 w-16 bg-muted animate-pulse rounded" />
                </div>
                <div className="w-[14%] min-w-[100px] px-3">
                  <div className="h-5 w-24 bg-muted animate-pulse rounded" />
                </div>
                <div className="w-[16%] min-w-[100px] px-3">
                  <div className="h-4 w-20 bg-muted animate-pulse rounded" />
                </div>
                <div className="w-[16%] min-w-[100px] px-3">
                  <div className="h-4 w-20 bg-muted animate-pulse rounded" />
                </div>
                <div className="hidden lg:block w-[20%] min-w-[150px] px-3">
                  <div className="h-4 w-32 bg-muted animate-pulse rounded" />
                </div>
                <div className="hidden md:block w-[10%] min-w-[80px] px-3">
                  <div className="h-4 w-14 bg-muted animate-pulse rounded" />
                </div>
                <div className="w-[12%] min-w-[80px] px-3">
                  <div className="h-4 w-16 bg-muted animate-pulse rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : connectionStatus === 'disconnected' || connectionStatus === 'error' ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
            <WifiOff className="h-12 w-12 text-muted-foreground/50" />
            <h3 className="text-lg font-medium text-foreground">Disconnected</h3>
            <p className="text-sm">Unable to connect to agent. Attempting to reconnect...</p>
          </div>
        ) : events.length === 0 && hasActiveFilters ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
            <SearchX className="h-12 w-12 text-muted-foreground/50" />
            <h3 className="text-lg font-medium text-foreground">No events match your filters</h3>
            <p className="text-sm">Try adjusting or clearing your filters</p>
            {onClearFilters && (
              <Button variant="outline" size="sm" onClick={onClearFilters} className="mt-2">
                Clear filters
              </Button>
            )}
          </div>
        ) : events.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
            <Radio className="h-12 w-12 text-muted-foreground/50 animate-pulse" />
            <h3 className="text-lg font-medium text-foreground">Waiting for events...</h3>
            <p className="text-sm">Agent Explorer is connected and listening</p>
          </div>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualItems.map((virtualRow) => {
              const event = events[virtualRow.index];
              const timestamp = normalizeTimestamp(event.timestamp);
              const packetId = getPacketId(event);
              const resolvedStatus = packetId ? packetStatusMap.get(packetId) : undefined;

              return (
                <EventRow
                  key={`${timestamp}-${virtualRow.index}`}
                  event={event}
                  onSelect={handleRowSelect}
                  index={virtualRow.index}
                  resolvedStatus={resolvedStatus}
                  isSelected={selectedIndex === virtualRow.index}
                  isNew={isLiveMode && virtualRow.index < newEventCountRef.current}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Pagination footer */}
      {showPagination && total !== undefined && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-border shrink-0">
          <span className="text-sm text-muted-foreground">
            Showing {events.length} of {total.toLocaleString()} events
          </span>
          {events.length < total && onLoadMore && (
            <button
              onClick={onLoadMore}
              className="px-4 py-2 text-sm font-medium text-primary bg-primary/10 rounded-md hover:bg-primary/20 transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background"
            >
              Load More
            </button>
          )}
        </div>
      )}
    </div>
  );
}
