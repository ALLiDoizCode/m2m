import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, XCircle, Clock, Zap, ArrowRight } from 'lucide-react';
import { formatRelativeTime } from '@/lib/event-types';

/**
 * Settlement entry for timeline display
 */
export interface SettlementEntry {
  triggeredAt?: string;
  completedAt?: string;
  amount: string;
  type: 'MOCK' | 'EVM' | 'XRP';
  success?: boolean;
  errorMessage?: string;
  triggerReason?: 'THRESHOLD_EXCEEDED' | 'MANUAL';
}

/**
 * SettlementTimeline props interface
 */
export interface SettlementTimelineProps {
  peerId: string;
  settlements: SettlementEntry[];
}

/**
 * Format settlement amount for display
 */
function formatAmount(value: string): string {
  const num = BigInt(value);
  if (num >= 1_000_000_000n) {
    return `${(Number(num) / 1_000_000_000).toFixed(2)}B`;
  }
  if (num >= 1_000_000n) {
    return `${(Number(num) / 1_000_000).toFixed(2)}M`;
  }
  if (num >= 1_000n) {
    return `${(Number(num) / 1_000).toFixed(2)}K`;
  }
  return num.toLocaleString();
}

/**
 * Get settlement type badge styling
 */
function getSettlementTypeBadge(type: SettlementEntry['type']): string {
  switch (type) {
    case 'MOCK':
      return 'bg-gray-500';
    case 'EVM':
      return 'bg-emerald-500';
    case 'XRP':
      return 'bg-orange-500';
  }
}

/**
 * Determine settlement status
 */
function getSettlementStatus(entry: SettlementEntry): {
  label: string;
  icon: typeof CheckCircle2;
  className: string;
  animate?: boolean;
} {
  if (entry.completedAt) {
    if (entry.success) {
      return {
        label: 'Completed',
        icon: CheckCircle2,
        className: 'text-green-500',
      };
    } else {
      return {
        label: 'Failed',
        icon: XCircle,
        className: 'text-red-400',
      };
    }
  }

  if (entry.triggeredAt) {
    return {
      label: 'In Progress',
      icon: Clock,
      className: 'text-blue-500',
      animate: true,
    };
  }

  return {
    label: 'Pending',
    icon: Clock,
    className: 'text-muted-foreground',
  };
}

/**
 * Calculate elapsed time for in-progress settlements
 */
function getElapsedTime(triggeredAt: string): string {
  const triggered = new Date(triggeredAt).getTime();
  const elapsed = Date.now() - triggered;

  if (elapsed < 1000) return 'just started';
  if (elapsed < 60000) return `${Math.floor(elapsed / 1000)}s`;
  if (elapsed < 3600000)
    return `${Math.floor(elapsed / 60000)}m ${Math.floor((elapsed % 60000) / 1000)}s`;
  return `${Math.floor(elapsed / 3600000)}h ${Math.floor((elapsed % 3600000) / 60000)}m`;
}

/**
 * SettlementTimeline component - displays settlement flow visualization
 * Story 14.6: Settlement and Balance Visualization
 *
 * Shows: TRIGGERED → IN_PROGRESS → COMPLETED flow
 * With success/failure indicators and settlement details
 */
export const SettlementTimeline = React.memo(function SettlementTimeline({
  peerId,
  settlements,
}: SettlementTimelineProps) {
  if (settlements.length === 0) {
    return (
      <div className="text-xs text-muted-foreground text-center py-2">
        No settlement activity for {peerId}
      </div>
    );
  }

  // Show most recent settlement first
  const sortedSettlements = [...settlements].sort((a, b) => {
    const aTime = a.triggeredAt ? new Date(a.triggeredAt).getTime() : 0;
    const bTime = b.triggeredAt ? new Date(b.triggeredAt).getTime() : 0;
    return bTime - aTime;
  });

  return (
    <div className="space-y-3">
      <div className="text-xs font-medium text-muted-foreground">Settlement History</div>

      <div className="space-y-2">
        {sortedSettlements.map((settlement, index) => {
          const status = getSettlementStatus(settlement);
          const StatusIcon = status.icon;
          const typeBadgeClass = getSettlementTypeBadge(settlement.type);

          return (
            <div key={index} className="flex items-start gap-3 p-2 rounded-md bg-muted/30 text-xs">
              {/* Status Icon */}
              <div
                className={`mt-0.5 ${status.className} ${status.animate ? 'animate-pulse' : ''}`}
              >
                <StatusIcon className="h-4 w-4" />
              </div>

              {/* Settlement Details */}
              <div className="flex-1 space-y-1">
                {/* Header: Amount + Type */}
                <div className="flex items-center gap-2">
                  <span className="font-mono font-medium">{formatAmount(settlement.amount)}</span>
                  <Badge className={`text-xs text-white ${typeBadgeClass}`}>
                    {settlement.type}
                  </Badge>
                  {settlement.triggerReason && (
                    <Badge variant="outline" className="text-xs">
                      {settlement.triggerReason === 'THRESHOLD_EXCEEDED' ? (
                        <span className="flex items-center gap-1">
                          <Zap className="h-3 w-3" />
                          Auto
                        </span>
                      ) : (
                        'Manual'
                      )}
                    </Badge>
                  )}
                </div>

                {/* Flow visualization */}
                <div className="flex items-center gap-1 text-muted-foreground">
                  {settlement.triggeredAt && (
                    <>
                      <span>Triggered</span>
                      <span className="text-xs">
                        {formatRelativeTime(new Date(settlement.triggeredAt).getTime())}
                      </span>
                    </>
                  )}

                  {settlement.triggeredAt && !settlement.completedAt && (
                    <>
                      <ArrowRight className="h-3 w-3" />
                      <span className="text-blue-500 animate-pulse">
                        In progress ({getElapsedTime(settlement.triggeredAt)})
                      </span>
                    </>
                  )}

                  {settlement.completedAt && (
                    <>
                      <ArrowRight className="h-3 w-3" />
                      <span className={settlement.success ? 'text-green-500' : 'text-red-400'}>
                        {settlement.success ? 'Completed' : 'Failed'}
                      </span>
                      <span className="text-xs">
                        {formatRelativeTime(new Date(settlement.completedAt).getTime())}
                      </span>
                    </>
                  )}
                </div>

                {/* Error message for failed settlements */}
                {!settlement.success && settlement.errorMessage && (
                  <div className="text-red-400 text-xs mt-1">Error: {settlement.errorMessage}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
