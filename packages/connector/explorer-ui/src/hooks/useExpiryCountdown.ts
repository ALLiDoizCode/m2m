import * as React from 'react';

export interface UseExpiryCountdownResult {
  /** Formatted countdown string */
  countdown: string;
  /** Whether the expiry is in the past */
  isExpired: boolean;
  /** Raw time difference in milliseconds */
  diffMs: number;
}

/**
 * Format a time difference in milliseconds to a human-readable string
 */
function formatCountdown(diffMs: number): string {
  const absDiff = Math.abs(diffMs);
  const isExpired = diffMs < 0;
  const prefix = isExpired ? 'Expired ' : '';
  const suffix = isExpired ? ' ago' : '';

  if (absDiff < 1000) {
    return isExpired ? 'Just expired' : 'Expiring now';
  }

  const seconds = Math.floor(absDiff / 1000) % 60;
  const minutes = Math.floor(absDiff / (1000 * 60)) % 60;
  const hours = Math.floor(absDiff / (1000 * 60 * 60)) % 24;
  const days = Math.floor(absDiff / (1000 * 60 * 60 * 24));

  // More than 24 hours - show date instead
  if (days > 0) {
    if (days === 1) {
      return prefix + '1 day' + suffix;
    }
    return prefix + `${days} days` + suffix;
  }

  // Format as HH:MM:SS for times less than 24 hours
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return prefix + parts.join(' ') + suffix;
}

/**
 * Hook for live expiry countdown
 *
 * Updates every second for times less than 24 hours away.
 * Shows relative date for times more than 24 hours away.
 *
 * @param expiresAt - Expiry timestamp (Date, number ms, or ISO string)
 * @returns Countdown string and expired status
 *
 * @example
 * ```tsx
 * function ExpiryDisplay({ expiresAt }: { expiresAt: Date }) {
 *   const { countdown, isExpired } = useExpiryCountdown(expiresAt);
 *   return (
 *     <span className={isExpired ? 'text-red-500' : 'text-green-500'}>
 *       {countdown}
 *     </span>
 *   );
 * }
 * ```
 */
export function useExpiryCountdown(
  expiresAt: Date | number | string | null | undefined
): UseExpiryCountdownResult {
  const [now, setNow] = React.useState(Date.now());

  // Parse expiry timestamp
  const expiryMs = React.useMemo(() => {
    if (!expiresAt) return null;
    if (expiresAt instanceof Date) return expiresAt.getTime();
    if (typeof expiresAt === 'number') return expiresAt;
    if (typeof expiresAt === 'string') {
      const parsed = new Date(expiresAt).getTime();
      return isNaN(parsed) ? null : parsed;
    }
    return null;
  }, [expiresAt]);

  // Calculate difference
  const diffMs = expiryMs !== null ? expiryMs - now : 0;
  const isExpired = diffMs < 0;
  const absDiff = Math.abs(diffMs);

  // Only update timer if expiry is within 24 hours
  const shouldUpdate = expiryMs !== null && absDiff < 24 * 60 * 60 * 1000;

  React.useEffect(() => {
    if (!shouldUpdate) return;

    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => clearInterval(interval);
  }, [shouldUpdate]);

  // Format countdown
  const countdown = React.useMemo(() => {
    if (expiryMs === null) return 'N/A';
    return formatCountdown(diffMs);
  }, [expiryMs, diffMs]);

  return {
    countdown,
    isExpired,
    diffMs,
  };
}
