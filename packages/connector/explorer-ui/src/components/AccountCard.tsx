import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { BalanceHistoryChart } from './BalanceHistoryChart';
import { SettlementState, BalanceHistoryEntry } from '@/lib/event-types';
import { Zap, Link2 } from 'lucide-react';

/**
 * AccountCard props interface (Story 14.6)
 */
export interface AccountCardProps {
  peerId: string;
  tokenId: string;
  debitBalance: bigint;
  creditBalance: bigint;
  netBalance: bigint;
  creditLimit?: bigint;
  settlementThreshold?: bigint;
  settlementState: SettlementState;
  balanceHistory: BalanceHistoryEntry[];
  hasActiveChannel?: boolean;
  channelType?: 'evm' | 'xrp';
}

/**
 * Format bigint balance for display with abbreviations for large numbers
 */
function formatBalance(value: bigint): string {
  const absValue = value < 0n ? -value : value;
  const sign = value < 0n ? '-' : '';

  if (absValue >= 1_000_000_000n) {
    return `${sign}${(Number(absValue) / 1_000_000_000).toFixed(1)}B`;
  }
  if (absValue >= 1_000_000n) {
    return `${sign}${(Number(absValue) / 1_000_000).toFixed(1)}M`;
  }
  if (absValue >= 1_000n) {
    return `${sign}${(Number(absValue) / 1_000).toFixed(1)}K`;
  }
  return value.toLocaleString();
}

/**
 * Get CSS class for balance color coding
 */
function getBalanceColor(value: bigint): string {
  if (value > 0n) return 'text-green-500';
  if (value < 0n) return 'text-red-400';
  return 'text-muted-foreground';
}

/**
 * Get settlement state badge variant and label
 */
function getSettlementStateBadge(state: SettlementState): {
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
  label: string;
  className: string;
} {
  switch (state) {
    case 'IDLE':
      return { variant: 'secondary', label: 'Idle', className: 'bg-gray-500' };
    case 'SETTLEMENT_PENDING':
      return { variant: 'default', label: 'Pending', className: 'bg-yellow-500' };
    case 'SETTLEMENT_IN_PROGRESS':
      return { variant: 'default', label: 'In Progress', className: 'bg-blue-500 animate-pulse' };
  }
}

/**
 * Calculate settlement progress percentage
 */
function calculateSettlementProgress(creditBalance: bigint, threshold: bigint | undefined): number {
  if (!threshold || threshold === 0n) return 0;
  const progress = Number((creditBalance * 100n) / threshold);
  return Math.min(100, Math.max(0, progress));
}

/**
 * AccountCard component - displays individual peer account balance and status
 * Story 14.6: Settlement and Balance Visualization
 */
export const AccountCard = React.memo(function AccountCard({
  peerId,
  tokenId,
  debitBalance,
  creditBalance,
  netBalance,
  settlementThreshold,
  settlementState,
  balanceHistory,
  hasActiveChannel,
  channelType,
}: AccountCardProps) {
  const settlementProgress = calculateSettlementProgress(creditBalance, settlementThreshold);
  const stateBadge = getSettlementStateBadge(settlementState);

  return (
    <Card className="py-4 hover:border-primary/50 transition-colors">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium truncate" title={peerId}>
            {peerId}
          </CardTitle>
          <div className="flex items-center gap-1.5">
            {hasActiveChannel && (
              <Badge
                variant="outline"
                className={`text-xs ${channelType === 'evm' ? 'border-emerald-500 text-emerald-500' : 'border-orange-500 text-orange-500'}`}
              >
                <Link2 className="h-3 w-3 mr-1" />
                {channelType === 'evm' ? 'EVM' : 'XRP'}
              </Badge>
            )}
            <Badge variant="outline" className="text-xs">
              {tokenId}
            </Badge>
          </div>
        </div>
        <CardDescription className="flex items-center gap-2">
          <Badge className={`text-xs text-white ${stateBadge.className}`}>{stateBadge.label}</Badge>
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Balance Display */}
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="text-center">
            <div className="text-muted-foreground">We Owe</div>
            <div className={`font-mono font-medium ${getBalanceColor(-debitBalance)}`}>
              {formatBalance(debitBalance)}
            </div>
          </div>
          <div className="text-center">
            <div className="text-muted-foreground">They Owe</div>
            <div className={`font-mono font-medium ${getBalanceColor(creditBalance)}`}>
              {formatBalance(creditBalance)}
            </div>
          </div>
          <div className="text-center">
            <div className="text-muted-foreground">Net</div>
            <div className={`font-mono font-medium ${getBalanceColor(netBalance)}`}>
              {formatBalance(netBalance)}
            </div>
          </div>
        </div>

        {/* Settlement Threshold Progress */}
        {settlementThreshold && settlementThreshold > 0n ? (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground flex items-center gap-1">
                <Zap className="h-3 w-3" />
                Settlement Threshold
              </span>
              <span className="font-mono">{settlementProgress.toFixed(0)}%</span>
            </div>
            <Progress
              value={settlementProgress}
              className={`h-1.5 ${settlementProgress >= 90 ? '[&>div]:bg-red-500' : settlementProgress >= 70 ? '[&>div]:bg-yellow-500' : ''}`}
            />
            <div className="text-xs text-muted-foreground text-right font-mono">
              {formatBalance(creditBalance)} / {formatBalance(settlementThreshold)}
            </div>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground italic">No threshold set</div>
        )}

        {/* Balance History Chart */}
        {balanceHistory.length > 0 && <BalanceHistoryChart history={balanceHistory} />}
      </CardContent>
    </Card>
  );
});
