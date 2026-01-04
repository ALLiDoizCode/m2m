/**
 * Settlement Status Panel Component
 * Displays real-time account balances and settlement states for all peer connections
 * Story 6.8 - Dashboard Telemetry Integration for Settlement Visualization
 */

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import type { TelemetryEvent } from '@/hooks/useTelemetry';

/**
 * Balance State (matches dashboard backend BalanceState interface)
 */
export interface BalanceState {
  peerId: string;
  tokenId: string;
  debitBalance: string;
  creditBalance: string;
  netBalance: string;
  creditLimit?: string;
  settlementThreshold?: string;
  settlementState: 'IDLE' | 'SETTLEMENT_PENDING' | 'SETTLEMENT_IN_PROGRESS';
  lastUpdated: string;
}

interface SettlementStatusPanelProps {
  /**
   * Telemetry events stream from WebSocket
   * Used to update balances in real-time
   */
  events: TelemetryEvent[];

  /**
   * WebSocket connection status
   */
  connected: boolean;
}

/**
 * Format balance amount for display
 * Converts string bigint to human-readable format with thousands separators
 */
function formatBalance(balance: string): string {
  const num = BigInt(balance);
  return num.toLocaleString();
}

/**
 * Calculate credit utilization percentage
 * Returns percentage of credit limit used, or null if no limit configured
 */
function calculateUtilization(creditBalance: string, creditLimit?: string): number | null {
  if (!creditLimit || creditLimit === '0') {
    return null;
  }

  const balance = BigInt(creditBalance);
  const limit = BigInt(creditLimit);

  if (limit === 0n) {
    return null;
  }

  // Calculate percentage: (balance / limit) * 100
  const percentage = Number((balance * 100n) / limit);
  return percentage;
}

/**
 * Get badge variant and label for settlement state
 */
function getStateDisplay(state: BalanceState['settlementState']): {
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
  label: string;
} {
  switch (state) {
    case 'IDLE':
      return { variant: 'secondary', label: 'Idle' };
    case 'SETTLEMENT_PENDING':
      return { variant: 'outline', label: 'Pending' };
    case 'SETTLEMENT_IN_PROGRESS':
      return { variant: 'default', label: 'In Progress' };
    default:
      return { variant: 'secondary', label: 'Unknown' };
  }
}

/**
 * Settlement Status Panel Component
 *
 * Displays account balances for all peer connections with real-time updates.
 * Shows:
 * - Peer ID and token type
 * - Debit/Credit balances (owed to peer / owed by peer)
 * - Net balance
 * - Credit utilization percentage
 * - Settlement state (IDLE, PENDING, IN_PROGRESS)
 * - Last update timestamp
 */
export function SettlementStatusPanel({ events, connected }: SettlementStatusPanelProps): JSX.Element {
  const [balances, setBalances] = useState<Map<string, BalanceState>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch initial balance state from REST API
  useEffect(() => {
    const fetchBalances = async (): Promise<void> => {
      try {
        setLoading(true);
        setError(null);

        const response = await fetch('/api/balances');
        if (!response.ok) {
          throw new Error(`Failed to fetch balances: ${response.statusText}`);
        }

        const data = (await response.json()) as BalanceState[];

        // Convert array to Map for efficient updates
        const balanceMap = new Map<string, BalanceState>();
        data.forEach((balance) => {
          const key = `${balance.peerId}:${balance.tokenId}`;
          balanceMap.set(key, balance);
        });

        setBalances(balanceMap);
        setLoading(false);
      } catch (err) {
        console.error('[SettlementStatusPanel] Failed to fetch balances:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch balances');
        setLoading(false);
      }
    };

    void fetchBalances();
  }, []);

  // Process real-time ACCOUNT_BALANCE events from WebSocket
  useEffect(() => {
    events.forEach((event) => {
      if (event.type === 'ACCOUNT_BALANCE') {
        // Type guard: verify event has required fields for ACCOUNT_BALANCE
        const eventData = event.data as Record<string, unknown>;

        if (
          typeof eventData.peerId === 'string' &&
          typeof eventData.tokenId === 'string' &&
          typeof eventData.debitBalance === 'string' &&
          typeof eventData.creditBalance === 'string' &&
          typeof eventData.netBalance === 'string' &&
          typeof eventData.settlementState === 'string'
        ) {
          const key = `${eventData.peerId}:${eventData.tokenId}`;

          setBalances((prev) => {
            const updated = new Map(prev);
            updated.set(key, {
              peerId: eventData.peerId as string,
              tokenId: eventData.tokenId as string,
              debitBalance: eventData.debitBalance as string,
              creditBalance: eventData.creditBalance as string,
              netBalance: eventData.netBalance as string,
              creditLimit: eventData.creditLimit as string | undefined,
              settlementThreshold: eventData.settlementThreshold as string | undefined,
              settlementState: eventData.settlementState as BalanceState['settlementState'],
              lastUpdated: (eventData.timestamp as string) || event.timestamp,
            });
            return updated;
          });
        }
      }
    });
  }, [events]);

  // Convert Map to Array for rendering
  const balanceArray = Array.from(balances.values()).sort((a, b) =>
    a.peerId.localeCompare(b.peerId)
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Settlement Status</CardTitle>
        <CardDescription>
          Real-time account balances and settlement states for all peer connections
          {!connected && <span className="text-destructive"> (Disconnected)</span>}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading && <div className="text-sm text-muted-foreground">Loading balances...</div>}

        {error && <div className="text-sm text-destructive">Error: {error}</div>}

        {!loading && !error && balanceArray.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No peer balances available. Waiting for settlement telemetry...
          </div>
        )}

        {!loading && !error && balanceArray.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Peer</TableHead>
                <TableHead>Token</TableHead>
                <TableHead className="text-right">Credit Balance</TableHead>
                <TableHead className="text-right">Utilization</TableHead>
                <TableHead className="text-right">Net Balance</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Last Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {balanceArray.map((balance) => {
                const key = `${balance.peerId}:${balance.tokenId}`;
                const utilization = calculateUtilization(
                  balance.creditBalance,
                  balance.creditLimit
                );
                const stateDisplay = getStateDisplay(balance.settlementState);

                return (
                  <TableRow key={key}>
                    <TableCell className="font-medium">{balance.peerId}</TableCell>
                    <TableCell>{balance.tokenId}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatBalance(balance.creditBalance)}
                    </TableCell>
                    <TableCell className="text-right">
                      {utilization !== null ? (
                        <span
                          className={
                            utilization > 80
                              ? 'text-destructive font-semibold'
                              : utilization > 50
                                ? 'text-yellow-600 dark:text-yellow-500'
                                : 'text-muted-foreground'
                          }
                        >
                          {utilization.toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatBalance(balance.netBalance)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={stateDisplay.variant}>{stateDisplay.label}</Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {new Date(balance.lastUpdated).toLocaleTimeString()}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
