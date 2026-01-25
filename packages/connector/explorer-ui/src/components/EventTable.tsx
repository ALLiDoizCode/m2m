import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { TelemetryEvent, EVENT_TYPE_COLORS, formatRelativeTime } from '../lib/event-types';
import { Badge } from '@/components/ui/badge';

interface EventTableProps {
  events: TelemetryEvent[];
  onEventClick?: (event: TelemetryEvent) => void;
  loading?: boolean;
  showPagination?: boolean;
  total?: number;
  onLoadMore?: () => void;
}

const ROW_HEIGHT = 48;

/**
 * Extract direction from event
 */
function getDirection(event: TelemetryEvent): string {
  if ('direction' in event && event.direction) {
    return event.direction as string;
  }
  if (event.type === 'AGENT_CHANNEL_PAYMENT_SENT') {
    return 'sent';
  }
  return '-';
}

/**
 * Get direction display with icon
 */
function getDirectionDisplay(direction: string): string {
  switch (direction) {
    case 'sent':
      return '→ Sent';
    case 'received':
      return '← Received';
    case 'internal':
      return '⟳ Internal';
    default:
      return '-';
  }
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
 * Determine event status (success/failure/pending/neutral)
 */
type EventStatus = 'success' | 'failure' | 'pending' | 'neutral';

function getEventStatus(event: TelemetryEvent): EventStatus {
  const type = event.type;

  const successTypes = [
    'PACKET_FORWARDED',
    'SETTLEMENT_COMPLETED',
    'FUNDING_TRANSACTION_CONFIRMED',
    'PAYMENT_CHANNEL_SETTLED',
    'XRP_CHANNEL_CLAIMED',
    'AGENT_CHANNEL_PAYMENT_SENT',
    'AGENT_WALLET_FUNDED',
  ];

  const failureTypes = [
    'FUNDING_TRANSACTION_FAILED',
    'WALLET_BALANCE_MISMATCH',
    'SUSPICIOUS_ACTIVITY_DETECTED',
    'RATE_LIMIT_EXCEEDED',
    'FUNDING_RATE_LIMIT_EXCEEDED',
  ];

  const pendingTypes = [
    'SETTLEMENT_TRIGGERED',
    'PAYMENT_CHANNEL_OPENED',
    'XRP_CHANNEL_OPENED',
    'AGENT_CHANNEL_OPENED',
  ];

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
      return { icon: '✗', text: 'Failed', className: 'text-red-500' };
    case 'pending':
      return { icon: '◐', text: 'Pending', className: 'text-yellow-500' };
    default:
      return { icon: '○', text: '-', className: 'text-muted-foreground' };
  }
}

/**
 * Memoized row component for better performance
 */
const EventRow = React.memo(function EventRow({
  event,
  onClick,
  style,
}: {
  event: TelemetryEvent;
  onClick?: () => void;
  style: React.CSSProperties;
}) {
  const direction = getDirection(event);
  const amount = getAmount(event);
  const timestamp = normalizeTimestamp(event.timestamp);
  const destination = getDestination(event);
  const status = getEventStatus(event);
  const statusDisplay = getStatusDisplay(status);

  return (
    <div
      className="flex items-center border-b border-border cursor-pointer hover:bg-muted/50"
      style={style}
      onClick={onClick}
    >
      <div className="w-[100px] px-4 font-mono text-sm text-muted-foreground truncate">
        {formatRelativeTime(timestamp)}
      </div>
      <div className="w-[180px] px-4">
        <Badge
          variant="secondary"
          className={`${EVENT_TYPE_COLORS[event.type] || 'bg-gray-500'} text-white text-xs`}
        >
          {event.type.replace(/_/g, ' ')}
        </Badge>
      </div>
      <div className="w-[90px] px-4 text-sm">{getDirectionDisplay(direction)}</div>
      <div className="w-[120px] px-4 font-mono text-sm truncate" title={event.peerId || undefined}>
        {event.peerId || '-'}
      </div>
      <div className="w-[180px] px-4 font-mono text-sm truncate" title={destination || undefined}>
        {destination ? formatDestination(destination) : '-'}
      </div>
      <div className="w-[100px] px-4 font-mono text-sm">{amount ? formatAmount(amount) : '-'}</div>
      <div className={`w-[80px] px-4 text-sm ${statusDisplay.className}`}>
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
}: EventTableProps) {
  const parentRef = React.useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="flex flex-col h-[calc(100vh-280px)]">
      {/* Header */}
      <div className="flex items-center border-b border-border bg-muted/50 h-10 shrink-0">
        <div className="w-[100px] px-4 text-sm font-medium">Time</div>
        <div className="w-[180px] px-4 text-sm font-medium">Type</div>
        <div className="w-[90px] px-4 text-sm font-medium">Direction</div>
        <div className="w-[120px] px-4 text-sm font-medium">Peer</div>
        <div className="w-[180px] px-4 text-sm font-medium">Destination</div>
        <div className="w-[100px] px-4 text-sm font-medium">Amount</div>
        <div className="w-[80px] px-4 text-sm font-medium">Status</div>
      </div>

      {/* Body with virtual scrolling */}
      <div ref={parentRef} className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            Loading events...
          </div>
        ) : events.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            Waiting for events...
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

              return (
                <EventRow
                  key={`${timestamp}-${virtualRow.index}`}
                  event={event}
                  onClick={() => onEventClick?.(event)}
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
              className="px-4 py-2 text-sm font-medium text-primary bg-primary/10 rounded-md hover:bg-primary/20 transition-colors"
            >
              Load More
            </button>
          )}
        </div>
      )}
    </div>
  );
}
