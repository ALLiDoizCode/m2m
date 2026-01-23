/**
 * Token Bucket Algorithm Implementation for Rate Limiting
 *
 * Implements a token bucket with configurable capacity and refill rate
 * for efficient per-peer rate limiting.
 *
 * @see docs/prd/epic-12-multi-chain-settlement-production-hardening.md lines 396-427
 */

export interface TokenBucketConfig {
  /** Maximum number of tokens the bucket can hold */
  capacity: number;
  /** Rate at which tokens are added (tokens per second) */
  refillRate: number;
}

/**
 * Token bucket for rate limiting with automatic refill
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private capacity: number,
    private refillRate: number
  ) {
    if (capacity <= 0) {
      throw new Error('Token bucket capacity must be positive');
    }
    if (refillRate <= 0) {
      throw new Error('Token bucket refill rate must be positive');
    }
    if (!Number.isFinite(capacity) || !Number.isFinite(refillRate)) {
      throw new Error('Token bucket parameters must be finite numbers');
    }

    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /**
   * Attempt to consume one token from the bucket
   * @returns true if token was consumed, false if bucket is empty
   */
  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Get current number of available tokens
   */
  getAvailableTokens(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Refill tokens based on elapsed time since last refill
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // Convert to seconds
    const tokensToAdd = elapsed * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Reset bucket to full capacity (for testing)
   */
  reset(): void {
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }
}
