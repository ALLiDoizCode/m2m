/**
 * Settlement Timeline Component
 * Displays chronological list of settlement events (triggered and completed)
 * Story 6.8 - Dashboard Telemetry Integration for Settlement Visualization
 */

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { TelemetryEvent } from '@/hooks/useTelemetry';

/**
 * Settlement Triggered Event (from @m2m/shared)
 */
export interface SettlementTriggeredEvent {
  type: 'SETTLEMENT_TRIGGERED';
  nodeId: string;
  peerId: string;
  tokenId: string;
  currentBalance: string;
  threshold: string;
  exceedsBy: string;
  triggerReason: string;
  timestamp: string;
}

/**
 * Settlement Completed Event (from @m2m/shared)
 */
export interface SettlementCompletedEvent {
  type: 'SETTLEMENT_COMPLETED';
  nodeId: string;
  peerId: string;
  tokenId: string;
  previousBalance: string;
  newBalance: string;
  settledAmount: string;
  settlementType: string;
  success: boolean;
  errorMessage?: string;
  timestamp: string;
}

type SettlementEvent = SettlementTriggeredEvent | SettlementCompletedEvent;

interface SettlementTimelineProps {
  /**
   * Telemetry events stream from WebSocket
   */
  events: TelemetryEvent[];

  /**
   * WebSocket connection status
   */
  connected: boolean;
}

/**
 * Format balance for display with thousands separators
 */
function formatBalance(balance: string): string {
  const num = BigInt(balance);
  return num.toLocaleString();
}

/**
 * Format timestamp for display
 */
function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Settlement Timeline Component
 *
 * Displays recent settlement events in reverse chronological order (newest first).
 * Shows both SETTLEMENT_TRIGGERED and SETTLEMENT_COMPLETED events with:
 * - Event type badge
 * - Peer and token information
 * - Balance/amount details
 * - Success/failure status for completed settlements
 * - Timestamp
 *
 * Events are fetched from REST API on mount and updated in real-time via WebSocket.
 */
export function SettlementTimeline({ events, connected }: SettlementTimelineProps): JSX.Element {
  const [settlementEvents, setSettlementEvents] = useState<SettlementEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch initial settlement events from REST API
  useEffect(() => {
    const fetchEvents = async (): Promise<void> => {
      try {
        setLoading(true);
        setError(null);

        const response = await fetch('/api/settlements/recent');
        if (!response.ok) {
          throw new Error(`Failed to fetch settlement events: ${response.statusText}`);
        }

        const data = (await response.json()) as SettlementEvent[];
        setSettlementEvents(data);
        setLoading(false);
      } catch (err) {
        console.error('[SettlementTimeline] Failed to fetch settlement events:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch settlement events');
        setLoading(false);
      }
    };

    void fetchEvents();
  }, []);

  // Process real-time settlement events from WebSocket
  useEffect(() => {
    events.forEach((event) => {
      if (event.type === 'SETTLEMENT_TRIGGERED') {
        // Type guard for SETTLEMENT_TRIGGERED event
        const eventData = event.data as Record<string, unknown>;

        if (
          typeof eventData.peerId === 'string' &&
          typeof eventData.tokenId === 'string' &&
          typeof eventData.currentBalance === 'string' &&
          typeof eventData.threshold === 'string'
        ) {
          const settlementEvent: SettlementTriggeredEvent = {
            type: 'SETTLEMENT_TRIGGERED',
            nodeId: event.nodeId,
            peerId: eventData.peerId as string,
            tokenId: eventData.tokenId as string,
            currentBalance: eventData.currentBalance as string,
            threshold: eventData.threshold as string,
            exceedsBy: eventData.exceedsBy as string,
            triggerReason: eventData.triggerReason as string,
            timestamp: event.timestamp,
          };

          setSettlementEvents((prev) => {
            const updated = [settlementEvent, ...prev];
            return updated.slice(0, 100);
          });
        }
      } else if (event.type === 'SETTLEMENT_COMPLETED') {
        // Type guard for SETTLEMENT_COMPLETED event
        const eventData = event.data as Record<string, unknown>;

        if (
          typeof eventData.peerId === 'string' &&
          typeof eventData.tokenId === 'string' &&
          typeof eventData.success === 'boolean'
        ) {
          const settlementEvent: SettlementCompletedEvent = {
            type: 'SETTLEMENT_COMPLETED',
            nodeId: event.nodeId,
            peerId: eventData.peerId as string,
            tokenId: eventData.tokenId as string,
            previousBalance: eventData.previousBalance as string,
            newBalance: eventData.newBalance as string,
            settledAmount: eventData.settledAmount as string,
            settlementType: eventData.settlementType as string,
            success: eventData.success as boolean,
            errorMessage: eventData.errorMessage as string | undefined,
            timestamp: event.timestamp,
          };

          setSettlementEvents((prev) => {
            const updated = [settlementEvent, ...prev];
            return updated.slice(0, 100);
          });
        }
      }
    });
  }, [events]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Settlement Timeline</CardTitle>
        <CardDescription>
          Recent settlement events (last 100)
          {!connected && <span className="text-destructive"> (Disconnected)</span>}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading && (
          <div className="text-sm text-muted-foreground">Loading settlement events...</div>
        )}

        {error && <div className="text-sm text-destructive">Error: {error}</div>}

        {!loading && !error && settlementEvents.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No settlement events yet. Waiting for settlement activity...
          </div>
        )}

        {!loading && !error && settlementEvents.length > 0 && (
          <div className="space-y-4 max-h-[500px] overflow-y-auto">
            {settlementEvents.map((event, index) => (
              <div
                key={`${event.type}-${event.timestamp}-${index}`}
                className="border-l-2 border-muted pl-4 pb-4 last:pb-0"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 space-y-1">
                    {/* Event Type Badge */}
                    <div className="flex items-center gap-2">
                      {event.type === 'SETTLEMENT_TRIGGERED' ? (
                        <Badge variant="outline">Triggered</Badge>
                      ) : event.type === 'SETTLEMENT_COMPLETED' ? (
                        <Badge
                          variant={
                            (event as SettlementCompletedEvent).success ? 'default' : 'destructive'
                          }
                        >
                          {(event as SettlementCompletedEvent).success ? 'Completed' : 'Failed'}
                        </Badge>
                      ) : null}
                      <span className="text-xs text-muted-foreground">
                        {formatTimestamp(event.timestamp)}
                      </span>
                    </div>

                    {/* Peer and Token Info */}
                    <div className="text-sm">
                      <span className="font-medium">{event.peerId}</span>
                      <span className="text-muted-foreground"> · {event.tokenId}</span>
                    </div>

                    {/* Event Details */}
                    {event.type === 'SETTLEMENT_TRIGGERED' && (
                      <div className="text-sm text-muted-foreground">
                        Balance exceeded threshold:{' '}
                        <span className="font-mono">{formatBalance(event.currentBalance)}</span>{' '}
                        &gt; <span className="font-mono">{formatBalance(event.threshold)}</span>
                        <span className="text-xs ml-2">(+{formatBalance(event.exceedsBy)})</span>
                      </div>
                    )}

                    {event.type === 'SETTLEMENT_COMPLETED' && (
                      <div className="text-sm text-muted-foreground">
                        {event.success ? (
                          <>
                            Settled{' '}
                            <span className="font-mono">{formatBalance(event.settledAmount)}</span>
                            {' · '}
                            Balance:{' '}
                            <span className="font-mono">
                              {formatBalance(event.previousBalance)}
                            </span>
                            {' → '}
                            <span className="font-mono">{formatBalance(event.newBalance)}</span>
                            <span className="text-xs ml-2">({event.settlementType})</span>
                          </>
                        ) : (
                          <>
                            Settlement failed
                            {event.errorMessage && (
                              <span className="text-destructive">: {event.errorMessage}</span>
                            )}
                          </>
                        )}
                      </div>
                    )}

                    {/* Node ID */}
                    <div className="text-xs text-muted-foreground">Node: {event.nodeId}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
