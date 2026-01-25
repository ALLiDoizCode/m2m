import { useMemo } from 'react';
import { BalanceHistoryEntry } from '@/lib/event-types';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

/**
 * BalanceHistoryChart props interface
 */
export interface BalanceHistoryChartProps {
  history: BalanceHistoryEntry[];
  /** Maximum bars to display */
  maxBars?: number;
}

/**
 * Calculate trend from history
 */
function calculateTrend(history: BalanceHistoryEntry[]): 'up' | 'down' | 'stable' {
  if (history.length < 2) return 'stable';

  const recent = history.slice(-5);
  if (recent.length < 2) return 'stable';

  const first = recent[0].balance;
  const last = recent[recent.length - 1].balance;

  if (last > first) return 'up';
  if (last < first) return 'down';
  return 'stable';
}

/**
 * BalanceHistoryChart component - mini sparkline showing balance changes over time
 * Story 14.6: Settlement and Balance Visualization
 *
 * Uses CSS-based bars instead of heavy charting library.
 * Shows last N balance changes with color-coded bars (green for increases, red for decreases)
 */
export function BalanceHistoryChart({ history, maxBars = 20 }: BalanceHistoryChartProps) {
  // Calculate bar data
  const { bars, trend } = useMemo(() => {
    if (history.length === 0) {
      return { bars: [], trend: 'stable' as const };
    }

    // Take last N entries
    const recentHistory = history.slice(-maxBars);

    // Find min and max for normalization
    let minBalance = recentHistory[0].balance;
    let maxBalance = recentHistory[0].balance;

    for (const entry of recentHistory) {
      if (entry.balance < minBalance) minBalance = entry.balance;
      if (entry.balance > maxBalance) maxBalance = entry.balance;
    }

    // Calculate range (avoid division by zero)
    const range = maxBalance - minBalance;
    const hasRange = range !== 0n;

    // Build bars with normalized heights and change direction
    const bars = recentHistory.map((entry, index) => {
      // Normalize height (0-100%)
      const normalizedHeight = hasRange
        ? Number(((entry.balance - minBalance) * 100n) / range)
        : 50;

      // Determine color based on change from previous
      let changeType: 'up' | 'down' | 'neutral' = 'neutral';
      if (index > 0) {
        const prev = recentHistory[index - 1].balance;
        if (entry.balance > prev) changeType = 'up';
        else if (entry.balance < prev) changeType = 'down';
      }

      return {
        timestamp: entry.timestamp,
        height: Math.max(5, Math.min(100, normalizedHeight)), // Min 5% height for visibility
        changeType,
      };
    });

    const trend = calculateTrend(recentHistory);

    return { bars, trend };
  }, [history, maxBars]);

  if (bars.length === 0) {
    return null;
  }

  // Trend icon
  const TrendIcon = trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : Minus;
  const trendColor =
    trend === 'up' ? 'text-green-500' : trend === 'down' ? 'text-red-500' : 'text-muted-foreground';
  const trendLabel = trend === 'up' ? 'Increasing' : trend === 'down' ? 'Decreasing' : 'Stable';

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Balance History</span>
        <span className={`flex items-center gap-1 ${trendColor}`}>
          <TrendIcon className="h-3 w-3" />
          {trendLabel}
        </span>
      </div>

      {/* Sparkline bars */}
      <div className="flex items-end gap-px h-8 bg-muted/20 rounded px-1 py-1">
        {bars.map((bar, index) => (
          <div
            key={index}
            className={`flex-1 min-w-[2px] max-w-[6px] rounded-t transition-all ${
              bar.changeType === 'up'
                ? 'bg-green-500'
                : bar.changeType === 'down'
                  ? 'bg-red-500'
                  : 'bg-muted-foreground/50'
            }`}
            style={{ height: `${bar.height}%` }}
            title={new Date(bar.timestamp).toLocaleString()}
          />
        ))}
      </div>

      <div className="text-xs text-muted-foreground text-center">{bars.length} changes</div>
    </div>
  );
}
