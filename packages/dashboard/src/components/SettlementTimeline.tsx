/**
 * Settlement Timeline Component
 * Displays chronological list of settlement events (triggered and completed)
 * Story 6.8 - Dashboard Telemetry Integration for Settlement Visualization
 * Story 8.10 - Add Payment Channel Lifecycle Events
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

/**
 * Payment Channel Opened Event (from @m2m/shared)
 * Story 8.10 - Payment Channel Telemetry
 */
export interface PaymentChannelOpenedEvent {
  type: 'PAYMENT_CHANNEL_OPENED';
  nodeId: string;
  channelId: string;
  participants: [string, string];
  peerId: string;
  tokenAddress: string;
  tokenSymbol: string;
  settlementTimeout: number;
  initialDeposits: {
    [participant: string]: string;
  };
  timestamp: string;
}

/**
 * Payment Channel Balance Update Event (from @m2m/shared)
 * Story 8.10 - Payment Channel Telemetry
 */
export interface PaymentChannelBalanceUpdateEvent {
  type: 'PAYMENT_CHANNEL_BALANCE_UPDATE';
  nodeId: string;
  channelId: string;
  myNonce: number;
  theirNonce: number;
  myTransferred: string;
  theirTransferred: string;
  timestamp: string;
}

/**
 * Payment Channel Settled Event (from @m2m/shared)
 * Story 8.10 - Payment Channel Telemetry
 */
export interface PaymentChannelSettledEvent {
  type: 'PAYMENT_CHANNEL_SETTLED';
  nodeId: string;
  channelId: string;
  finalBalances: {
    [participant: string]: string;
  };
  settlementType: 'cooperative' | 'unilateral' | 'disputed';
  timestamp: string;
}

/**
 * XRP Channel Opened Event (from @m2m/shared)
 * Story 9.7 - XRP Payment Channel Telemetry
 */
export interface XRPChannelOpenedEvent {
  type: 'XRP_CHANNEL_OPENED';
  nodeId: string;
  channelId: string;
  account: string;
  destination: string;
  amount: string;
  settleDelay: number;
  publicKey: string;
  peerId?: string;
  timestamp: string;
}

/**
 * XRP Channel Claimed Event (from @m2m/shared)
 * Story 9.7 - XRP Payment Channel Telemetry
 */
export interface XRPChannelClaimedEvent {
  type: 'XRP_CHANNEL_CLAIMED';
  nodeId: string;
  channelId: string;
  claimAmount: string;
  remainingBalance: string;
  peerId?: string;
  timestamp: string;
}

/**
 * XRP Channel Closed Event (from @m2m/shared)
 * Story 9.7 - XRP Payment Channel Telemetry
 */
export interface XRPChannelClosedEvent {
  type: 'XRP_CHANNEL_CLOSED';
  nodeId: string;
  channelId: string;
  finalBalance: string;
  closeType: 'cooperative' | 'expiration' | 'unilateral';
  peerId?: string;
  timestamp: string;
}

type SettlementEvent =
  | SettlementTriggeredEvent
  | SettlementCompletedEvent
  | PaymentChannelOpenedEvent
  | PaymentChannelBalanceUpdateEvent
  | PaymentChannelSettledEvent
  | XRPChannelOpenedEvent
  | XRPChannelClaimedEvent
  | XRPChannelClosedEvent;

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
 * Format XRP drops as "10,000 XRP"
 */
function formatXRPAmount(drops: string): string {
  try {
    const dropsNum = BigInt(drops);
    const xrp = Number(dropsNum) / 1_000_000;
    return `${xrp.toLocaleString()} XRP`;
  } catch {
    return drops;
  }
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
      } else if (event.type === 'PAYMENT_CHANNEL_OPENED') {
        // Type guard for PAYMENT_CHANNEL_OPENED event (Story 8.10)
        const channelEvent = event as unknown as PaymentChannelOpenedEvent;

        if (
          typeof channelEvent.channelId === 'string' &&
          typeof channelEvent.peerId === 'string' &&
          typeof channelEvent.tokenSymbol === 'string'
        ) {
          setSettlementEvents((prev) => {
            const updated = [channelEvent, ...prev];
            return updated.slice(0, 100);
          });
        }
      } else if (event.type === 'PAYMENT_CHANNEL_BALANCE_UPDATE') {
        // Type guard for PAYMENT_CHANNEL_BALANCE_UPDATE event (Story 8.10)
        const channelEvent = event as unknown as PaymentChannelBalanceUpdateEvent;

        if (
          typeof channelEvent.channelId === 'string' &&
          typeof channelEvent.myTransferred === 'string' &&
          typeof channelEvent.theirTransferred === 'string'
        ) {
          setSettlementEvents((prev) => {
            const updated = [channelEvent, ...prev];
            return updated.slice(0, 100);
          });
        }
      } else if (event.type === 'PAYMENT_CHANNEL_SETTLED') {
        // Type guard for PAYMENT_CHANNEL_SETTLED event (Story 8.10)
        const channelEvent = event as unknown as PaymentChannelSettledEvent;

        if (typeof channelEvent.channelId === 'string' && channelEvent.finalBalances) {
          setSettlementEvents((prev) => {
            const updated = [channelEvent, ...prev];
            return updated.slice(0, 100);
          });
        }
      } else if (event.type === 'XRP_CHANNEL_OPENED') {
        // Type guard for XRP_CHANNEL_OPENED event (Story 9.7)
        const xrpEvent = event as unknown as XRPChannelOpenedEvent;

        if (typeof xrpEvent.channelId === 'string' && typeof xrpEvent.amount === 'string') {
          setSettlementEvents((prev) => {
            const updated = [xrpEvent, ...prev];
            return updated.slice(0, 100);
          });
        }
      } else if (event.type === 'XRP_CHANNEL_CLAIMED') {
        // Type guard for XRP_CHANNEL_CLAIMED event (Story 9.7)
        const xrpEvent = event as unknown as XRPChannelClaimedEvent;

        if (typeof xrpEvent.channelId === 'string' && typeof xrpEvent.claimAmount === 'string') {
          setSettlementEvents((prev) => {
            const updated = [xrpEvent, ...prev];
            return updated.slice(0, 100);
          });
        }
      } else if (event.type === 'XRP_CHANNEL_CLOSED') {
        // Type guard for XRP_CHANNEL_CLOSED event (Story 9.7)
        const xrpEvent = event as unknown as XRPChannelClosedEvent;

        if (typeof xrpEvent.channelId === 'string' && typeof xrpEvent.finalBalance === 'string') {
          setSettlementEvents((prev) => {
            const updated = [xrpEvent, ...prev];
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
                      ) : event.type === 'PAYMENT_CHANNEL_OPENED' ? (
                        <Badge variant="secondary">🔗 Channel Opened</Badge>
                      ) : event.type === 'PAYMENT_CHANNEL_BALANCE_UPDATE' ? (
                        <Badge variant="outline">💸 Balance Update</Badge>
                      ) : event.type === 'PAYMENT_CHANNEL_SETTLED' ? (
                        <Badge variant="default">✅ Channel Settled</Badge>
                      ) : event.type === 'XRP_CHANNEL_OPENED' ? (
                        <Badge className="bg-orange-500 text-white">🔗 XRP Channel Opened</Badge>
                      ) : event.type === 'XRP_CHANNEL_CLAIMED' ? (
                        <Badge className="bg-orange-500 text-white">💸 XRP Claim Submitted</Badge>
                      ) : event.type === 'XRP_CHANNEL_CLOSED' ? (
                        <Badge className="bg-orange-500 text-white">✅ XRP Channel Closed</Badge>
                      ) : null}
                      <span className="text-xs text-muted-foreground">
                        {formatTimestamp(event.timestamp)}
                      </span>
                    </div>

                    {/* Peer and Token Info */}
                    <div className="text-sm">
                      {event.type === 'PAYMENT_CHANNEL_OPENED' ||
                      event.type === 'PAYMENT_CHANNEL_BALANCE_UPDATE' ||
                      event.type === 'PAYMENT_CHANNEL_SETTLED' ? (
                        <>
                          <span className="font-medium">
                            {(event as PaymentChannelOpenedEvent).peerId ||
                              `Channel ${(event as PaymentChannelSettledEvent).channelId.slice(0, 8)}...`}
                          </span>
                          {event.type === 'PAYMENT_CHANNEL_OPENED' && (
                            <span className="text-muted-foreground">
                              {' '}
                              · {(event as PaymentChannelOpenedEvent).tokenSymbol}
                            </span>
                          )}
                        </>
                      ) : event.type === 'XRP_CHANNEL_OPENED' ||
                        event.type === 'XRP_CHANNEL_CLAIMED' ||
                        event.type === 'XRP_CHANNEL_CLOSED' ? (
                        <span className="font-medium">
                          {(event as XRPChannelOpenedEvent).peerId ||
                            `Channel ${(event as XRPChannelClosedEvent).channelId.slice(0, 8)}...`}
                          <span className="text-muted-foreground"> · XRP</span>
                        </span>
                      ) : (
                        <>
                          <span className="font-medium">
                            {(event as SettlementTriggeredEvent | SettlementCompletedEvent).peerId}
                          </span>
                          <span className="text-muted-foreground">
                            {' '}
                            ·{' '}
                            {(event as SettlementTriggeredEvent | SettlementCompletedEvent).tokenId}
                          </span>
                        </>
                      )}
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

                    {event.type === 'PAYMENT_CHANNEL_OPENED' && (
                      <div className="text-sm text-muted-foreground">
                        Channel{' '}
                        <span className="font-mono text-xs">
                          {(event as PaymentChannelOpenedEvent).channelId.slice(0, 10)}...
                        </span>{' '}
                        opened for{' '}
                        <span className="font-medium">
                          {(event as PaymentChannelOpenedEvent).peerId}
                        </span>{' '}
                        ({(event as PaymentChannelOpenedEvent).tokenSymbol})
                        <br />
                        Initial deposits:{' '}
                        {Object.entries((event as PaymentChannelOpenedEvent).initialDeposits).map(
                          ([participant, amount], idx) => (
                            <span key={participant}>
                              {idx > 0 && ', '}
                              <span className="font-mono">{formatBalance(amount)}</span>
                            </span>
                          )
                        )}
                        {' · '}
                        Timeout:{' '}
                        <span className="font-mono">
                          {((event as PaymentChannelOpenedEvent).settlementTimeout / 3600).toFixed(
                            1
                          )}
                          h
                        </span>
                      </div>
                    )}

                    {event.type === 'PAYMENT_CHANNEL_BALANCE_UPDATE' && (
                      <div className="text-sm text-muted-foreground">
                        Channel{' '}
                        <span className="font-mono text-xs">
                          {(event as PaymentChannelBalanceUpdateEvent).channelId.slice(0, 10)}...
                        </span>{' '}
                        transferred:{' '}
                        <span className="font-mono">
                          {formatBalance((event as PaymentChannelBalanceUpdateEvent).myTransferred)}
                        </span>{' '}
                        (nonce: {(event as PaymentChannelBalanceUpdateEvent).myNonce})
                        <br />
                        Received:{' '}
                        <span className="font-mono">
                          {formatBalance(
                            (event as PaymentChannelBalanceUpdateEvent).theirTransferred
                          )}
                        </span>{' '}
                        (nonce: {(event as PaymentChannelBalanceUpdateEvent).theirNonce})
                      </div>
                    )}

                    {event.type === 'PAYMENT_CHANNEL_SETTLED' && (
                      <div className="text-sm text-muted-foreground">
                        Channel{' '}
                        <span className="font-mono text-xs">
                          {(event as PaymentChannelSettledEvent).channelId.slice(0, 10)}...
                        </span>{' '}
                        settled via{' '}
                        <span className="font-medium">
                          {(event as PaymentChannelSettledEvent).settlementType}
                        </span>
                        <br />
                        Final balances:{' '}
                        {Object.entries((event as PaymentChannelSettledEvent).finalBalances).map(
                          ([participant, amount], idx) => (
                            <span key={participant}>
                              {idx > 0 && ', '}
                              <span className="font-mono">{formatBalance(amount)}</span>
                            </span>
                          )
                        )}
                      </div>
                    )}

                    {event.type === 'XRP_CHANNEL_OPENED' && (
                      <div className="text-sm text-muted-foreground">
                        Channel{' '}
                        <span className="font-mono text-xs">
                          {(event as XRPChannelOpenedEvent).channelId.slice(0, 10)}...
                        </span>{' '}
                        opened to{' '}
                        <span className="font-medium">
                          {(event as XRPChannelOpenedEvent).destination.slice(0, 12)}...
                        </span>
                        <br />
                        Amount:{' '}
                        <span className="font-mono">
                          {formatXRPAmount((event as XRPChannelOpenedEvent).amount)}
                        </span>
                        {' · '}
                        Settle Delay:{' '}
                        <span className="font-mono">
                          {((event as XRPChannelOpenedEvent).settleDelay / 3600).toFixed(1)}h
                        </span>
                      </div>
                    )}

                    {event.type === 'XRP_CHANNEL_CLAIMED' && (
                      <div className="text-sm text-muted-foreground">
                        Channel{' '}
                        <span className="font-mono text-xs">
                          {(event as XRPChannelClaimedEvent).channelId.slice(0, 10)}...
                        </span>
                        <br />
                        Claim:{' '}
                        <span className="font-mono">
                          {formatXRPAmount((event as XRPChannelClaimedEvent).claimAmount)}
                        </span>
                        {' · '}
                        Remaining:{' '}
                        <span className="font-mono">
                          {formatXRPAmount((event as XRPChannelClaimedEvent).remainingBalance)}
                        </span>
                      </div>
                    )}

                    {event.type === 'XRP_CHANNEL_CLOSED' && (
                      <div className="text-sm text-muted-foreground">
                        Channel{' '}
                        <span className="font-mono text-xs">
                          {(event as XRPChannelClosedEvent).channelId.slice(0, 10)}...
                        </span>{' '}
                        closed via{' '}
                        <span className="font-medium">
                          {(event as XRPChannelClosedEvent).closeType}
                        </span>
                        <br />
                        Final Balance:{' '}
                        <span className="font-mono">
                          {formatXRPAmount((event as XRPChannelClosedEvent).finalBalance)}
                        </span>
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
