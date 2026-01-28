/**
 * Token Budget Manager
 *
 * Tracks AI token usage with a rolling window to enforce cost limits.
 * Supports auto-fallback to direct dispatch when budget is exhausted.
 *
 * @packageDocumentation
 */

/**
 * Record of a single token usage.
 */
export interface TokenUsageRecord {
  /** Timestamp of the usage */
  timestamp: number;
  /** Number of prompt tokens used */
  promptTokens: number;
  /** Number of completion tokens used */
  completionTokens: number;
  /** Total tokens used */
  totalTokens: number;
}

/**
 * Current budget status.
 */
export interface TokenBudgetStatus {
  /** Total tokens used in the current window */
  tokensUsedInWindow: number;
  /** Maximum tokens allowed per window */
  maxTokensPerWindow: number;
  /** Remaining tokens in the current window */
  remainingTokens: number;
  /** Usage as a percentage (0-100) */
  usagePercent: number;
  /** Whether the budget is exhausted */
  isExhausted: boolean;
  /** Number of requests in the current window */
  requestCount: number;
  /** Window size in milliseconds */
  windowMs: number;
}

/**
 * Telemetry events emitted by the token budget.
 */
export interface TokenBudgetTelemetryEvent {
  type: 'AI_TOKEN_USAGE' | 'AI_BUDGET_WARNING' | 'AI_BUDGET_EXHAUSTED';
  timestamp: string;
  tokensUsed: number;
  tokensRemaining: number;
  usagePercent: number;
  windowMs: number;
}

/** Default window size: 1 hour in milliseconds */
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Rolling window token budget tracker.
 */
export class TokenBudget {
  private readonly _maxTokensPerWindow: number;
  private readonly _windowMs: number;
  private readonly _records: TokenUsageRecord[] = [];
  private _onTelemetry?: (event: TokenBudgetTelemetryEvent) => void;
  private _warningEmitted80 = false;
  private _warningEmitted95 = false;

  constructor(config: {
    maxTokensPerWindow: number;
    windowMs?: number;
    onTelemetry?: (event: TokenBudgetTelemetryEvent) => void;
  }) {
    this._maxTokensPerWindow = config.maxTokensPerWindow;
    this._windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
    this._onTelemetry = config.onTelemetry;
  }

  /**
   * Set the telemetry callback.
   */
  set onTelemetry(callback: ((event: TokenBudgetTelemetryEvent) => void) | undefined) {
    this._onTelemetry = callback;
  }

  /**
   * Check if there is budget available for a request.
   *
   * @param estimatedTokens - Estimated tokens for the request (optional)
   * @returns true if budget is available
   */
  canSpend(estimatedTokens?: number): boolean {
    this._pruneExpiredRecords();
    const used = this._getTotalUsed();
    const remaining = this._maxTokensPerWindow - used;
    return remaining > (estimatedTokens ?? 0);
  }

  /**
   * Record token usage from a completed request.
   *
   * @param usage - Token usage to record
   */
  recordUsage(usage: Omit<TokenUsageRecord, 'timestamp'>): void {
    const record: TokenUsageRecord = {
      ...usage,
      timestamp: Date.now(),
    };
    this._records.push(record);

    // Prune old records
    this._pruneExpiredRecords();

    // Check budget thresholds and emit telemetry
    const status = this.getStatus();

    // Emit usage telemetry
    this._emitTelemetry({
      type: 'AI_TOKEN_USAGE',
      timestamp: new Date().toISOString(),
      tokensUsed: usage.totalTokens,
      tokensRemaining: status.remainingTokens,
      usagePercent: status.usagePercent,
      windowMs: this._windowMs,
    });

    // Check warning thresholds
    if (status.usagePercent >= 95 && !this._warningEmitted95) {
      this._warningEmitted95 = true;
      this._emitTelemetry({
        type: 'AI_BUDGET_WARNING',
        timestamp: new Date().toISOString(),
        tokensUsed: status.tokensUsedInWindow,
        tokensRemaining: status.remainingTokens,
        usagePercent: status.usagePercent,
        windowMs: this._windowMs,
      });
    } else if (status.usagePercent >= 80 && !this._warningEmitted80) {
      this._warningEmitted80 = true;
      this._emitTelemetry({
        type: 'AI_BUDGET_WARNING',
        timestamp: new Date().toISOString(),
        tokensUsed: status.tokensUsedInWindow,
        tokensRemaining: status.remainingTokens,
        usagePercent: status.usagePercent,
        windowMs: this._windowMs,
      });
    }

    if (status.isExhausted) {
      this._emitTelemetry({
        type: 'AI_BUDGET_EXHAUSTED',
        timestamp: new Date().toISOString(),
        tokensUsed: status.tokensUsedInWindow,
        tokensRemaining: 0,
        usagePercent: 100,
        windowMs: this._windowMs,
      });
    }
  }

  /**
   * Get the current budget status.
   */
  getStatus(): TokenBudgetStatus {
    this._pruneExpiredRecords();
    const used = this._getTotalUsed();
    const remaining = Math.max(0, this._maxTokensPerWindow - used);
    const usagePercent = Math.min(100, Math.round((used / this._maxTokensPerWindow) * 100));

    return {
      tokensUsedInWindow: used,
      maxTokensPerWindow: this._maxTokensPerWindow,
      remainingTokens: remaining,
      usagePercent,
      isExhausted: remaining === 0,
      requestCount: this._records.length,
      windowMs: this._windowMs,
    };
  }

  /**
   * Get the remaining budget in tokens.
   */
  getRemainingBudget(): number {
    this._pruneExpiredRecords();
    return Math.max(0, this._maxTokensPerWindow - this._getTotalUsed());
  }

  /**
   * Reset the budget (clears all records).
   */
  reset(): void {
    this._records.length = 0;
    this._warningEmitted80 = false;
    this._warningEmitted95 = false;
  }

  private _getTotalUsed(): number {
    return this._records.reduce((sum, r) => sum + r.totalTokens, 0);
  }

  private _pruneExpiredRecords(): void {
    const cutoff = Date.now() - this._windowMs;
    while (this._records.length > 0 && this._records[0]!.timestamp < cutoff) {
      this._records.shift();
    }

    // Reset warning flags if usage drops below thresholds after pruning
    const used = this._getTotalUsed();
    const usagePercent = Math.round((used / this._maxTokensPerWindow) * 100);
    if (usagePercent < 80) {
      this._warningEmitted80 = false;
      this._warningEmitted95 = false;
    } else if (usagePercent < 95) {
      this._warningEmitted95 = false;
    }
  }

  private _emitTelemetry(event: TokenBudgetTelemetryEvent): void {
    try {
      this._onTelemetry?.(event);
    } catch {
      // Non-blocking — telemetry errors should not affect budget tracking
    }
  }
}
