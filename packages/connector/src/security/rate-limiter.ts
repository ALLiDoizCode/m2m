/**
 * Rate Limiter and DDoS Protection
 *
 * Implements rate limiting middleware with token bucket algorithm,
 * circuit breaker logic, and comprehensive metrics.
 *
 * @see docs/prd/epic-12-multi-chain-settlement-production-hardening.md lines 345-393
 */

import type { Logger } from '../utils/logger';
import { TokenBucket } from './token-bucket';
import { ViolationCounter } from './violation-counter';

/**
 * Request types that can be rate limited
 */
export type RequestType =
  | 'BTP_CONNECTION'
  | 'BTP_MESSAGE'
  | 'ILP_PACKET'
  | 'SETTLEMENT'
  | 'HTTP_API';

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  /** Maximum requests per second (global default) */
  maxRequestsPerSecond: number;
  /** Maximum requests per minute (for connection-type events) */
  maxRequestsPerMinute: number;
  /** Burst size (token bucket capacity) */
  burstSize: number;
  /** Duration in seconds to block peer after sustained violations */
  blockDuration: number;
  /** Number of violations in window to trigger circuit breaker */
  violationThreshold: number;
  /** Violation window size in seconds */
  violationWindowSeconds: number;
  /** Per-peer rate limit overrides */
  peerLimits?: Map<string, PeerRateLimitConfig>;
  /** Trusted peers (bypass circuit breaker) */
  trustedPeers?: Set<string>;
  /** Enable adaptive rate limiting */
  adaptiveRateLimiting?: boolean;
}

/**
 * Per-peer rate limit configuration
 */
export interface PeerRateLimitConfig {
  maxRequestsPerSecond: number;
  burstSize: number;
}

/**
 * Rate limiting metrics interface
 */
export interface RateLimitMetrics {
  recordAllowed(peerId: string, requestType: RequestType): void;
  recordThrottled(peerId: string, requestType: RequestType): void;
  recordBlocked(peerId: string, requestType: RequestType): void;
}

/**
 * Blocked peer information
 */
interface BlockedPeer {
  peerId: string;
  blockedAt: number;
  unblockTimeout: NodeJS.Timeout;
}

/**
 * Main rate limiter with token bucket, circuit breaker, and metrics
 */
export class RateLimiter {
  private tokenBuckets = new Map<string, TokenBucket>();
  private blockedPeers = new Map<string, BlockedPeer>();
  private violationCounter: ViolationCounter;
  private metrics?: RateLimitMetrics;
  private adaptiveLimits = new Map<string, number>(); // peerId -> current limit multiplier

  constructor(
    private config: RateLimitConfig,
    private logger: Logger,
    metrics?: RateLimitMetrics
  ) {
    this.validateConfig(config);
    this.violationCounter = new ViolationCounter(config.violationWindowSeconds);
    this.metrics = metrics;
  }

  /**
   * Check if a request is allowed for a peer
   * @param peerId - Peer identifier (or IP address for IP-based limiting)
   * @param requestType - Type of request being rate limited
   * @returns true if request is allowed, false if throttled or blocked
   */
  async checkLimit(peerId: string, requestType: RequestType): Promise<boolean> {
    // Check if peer is blocked by circuit breaker
    if (this.blockedPeers.has(peerId)) {
      this.logger.debug({ peerId, requestType }, 'Request blocked by circuit breaker');
      this.metrics?.recordBlocked(peerId, requestType);
      return false;
    }

    // Get or create token bucket for peer
    const bucket = this.getOrCreateBucket(peerId);

    // Try to consume token
    if (bucket.tryConsume()) {
      this.metrics?.recordAllowed(peerId, requestType);
      return true;
    }

    // Request throttled - handle violation
    this.logger.warn({ peerId, requestType }, 'Request rate limited');
    this.metrics?.recordThrottled(peerId, requestType);
    this.handleViolation(peerId, requestType);
    return false;
  }

  /**
   * Get or create token bucket for a peer
   */
  private getOrCreateBucket(peerId: string): TokenBucket {
    let bucket = this.tokenBuckets.get(peerId);
    if (!bucket) {
      const { capacity, refillRate } = this.getBucketConfig(peerId);
      bucket = new TokenBucket(capacity, refillRate);
      this.tokenBuckets.set(peerId, bucket);
    }
    return bucket;
  }

  /**
   * Get bucket configuration for a peer (supports per-peer overrides)
   */
  private getBucketConfig(peerId: string): { capacity: number; refillRate: number } {
    // Check for per-peer configuration override
    const peerConfig = this.config.peerLimits?.get(peerId);
    if (peerConfig) {
      return {
        capacity: peerConfig.burstSize,
        refillRate: peerConfig.maxRequestsPerSecond,
      };
    }

    // Apply adaptive limit if enabled
    let refillRate = this.config.maxRequestsPerSecond;
    if (this.config.adaptiveRateLimiting) {
      const multiplier = this.adaptiveLimits.get(peerId) ?? 1.0;
      refillRate = refillRate * multiplier;
    }

    return {
      capacity: this.config.burstSize,
      refillRate,
    };
  }

  /**
   * Handle rate limit violation (increment counter and check circuit breaker)
   */
  private handleViolation(peerId: string, requestType: RequestType): void {
    const violations = this.violationCounter.increment(peerId);

    // Decrease adaptive limit for suspicious peers
    if (this.config.adaptiveRateLimiting && !this.config.trustedPeers?.has(peerId)) {
      this.decreaseAdaptiveLimit(peerId);
    }

    // Check if circuit breaker should activate
    if (violations >= this.config.violationThreshold) {
      // Bypass circuit breaker for trusted peers
      if (this.config.trustedPeers?.has(peerId)) {
        this.logger.info(
          { peerId, violations, requestType },
          'Trusted peer exceeded violations but not blocked'
        );
        return;
      }

      this.blockPeer(peerId, this.config.blockDuration);
    }
  }

  /**
   * Block a peer for a specified duration (circuit breaker activation)
   */
  private blockPeer(peerId: string, durationSeconds: number): void {
    // Already blocked
    if (this.blockedPeers.has(peerId)) {
      return;
    }

    const violations = this.violationCounter.getCount(peerId);
    this.logger.warn(
      {
        peerId,
        violations,
        blockDuration: durationSeconds,
      },
      'Peer blocked due to sustained rate limit violations'
    );

    // Schedule unblock
    const unblockTimeout = setTimeout(() => {
      this.unblockPeer(peerId);
    }, durationSeconds * 1000);

    // Store blocked peer info
    this.blockedPeers.set(peerId, {
      peerId,
      blockedAt: Date.now(),
      unblockTimeout,
    });
  }

  /**
   * Unblock a peer (circuit breaker recovery)
   */
  private unblockPeer(peerId: string): void {
    const blocked = this.blockedPeers.get(peerId);
    if (!blocked) {
      return;
    }

    this.logger.info({ peerId }, 'Peer unblocked');
    this.blockedPeers.delete(peerId);
    this.violationCounter.reset(peerId);

    // Reset adaptive limit on unblock
    this.adaptiveLimits.delete(peerId);
  }

  /**
   * Increase adaptive limit for trusted peer behavior
   */
  increaseAdaptiveLimit(peerId: string): void {
    if (!this.config.adaptiveRateLimiting) {
      return;
    }

    const current = this.adaptiveLimits.get(peerId) ?? 1.0;
    const newLimit = Math.min(5.0, current * 1.1); // Max 5x increase
    this.adaptiveLimits.set(peerId, newLimit);

    this.logger.debug({ peerId, newMultiplier: newLimit }, 'Increased adaptive rate limit');
  }

  /**
   * Decrease adaptive limit for suspicious peer behavior
   */
  private decreaseAdaptiveLimit(peerId: string): void {
    const current = this.adaptiveLimits.get(peerId) ?? 1.0;
    const newLimit = Math.max(0.1, current * 0.9); // Min 0.1x (10% of normal)
    this.adaptiveLimits.set(peerId, newLimit);

    this.logger.debug({ peerId, newMultiplier: newLimit }, 'Decreased adaptive rate limit');
  }

  /**
   * Get list of currently blocked peers
   */
  getBlockedPeers(): string[] {
    return Array.from(this.blockedPeers.keys());
  }

  /**
   * Get current requests per second for a peer (approximation)
   */
  getRequestsPerSecond(peerId: string): number {
    const bucket = this.tokenBuckets.get(peerId);
    if (!bucket) {
      return 0;
    }

    // Approximate current rate based on available tokens
    const available = bucket.getAvailableTokens();
    const { capacity, refillRate } = this.getBucketConfig(peerId);
    return Math.max(0, refillRate - (capacity - available));
  }

  /**
   * Manually unblock a peer (for administrative override)
   */
  unblock(peerId: string): void {
    const blocked = this.blockedPeers.get(peerId);
    if (blocked) {
      clearTimeout(blocked.unblockTimeout);
      this.unblockPeer(peerId);
    }
  }

  /**
   * Validate rate limit configuration
   */
  private validateConfig(config: RateLimitConfig): void {
    if (config.maxRequestsPerSecond <= 0) {
      throw new Error('maxRequestsPerSecond must be positive');
    }
    if (config.maxRequestsPerMinute <= 0) {
      throw new Error('maxRequestsPerMinute must be positive');
    }
    if (config.burstSize <= 0) {
      throw new Error('burstSize must be positive');
    }
    if (config.blockDuration <= 0) {
      throw new Error('blockDuration must be positive');
    }
    if (config.violationThreshold <= 0) {
      throw new Error('violationThreshold must be positive');
    }
    if (config.violationWindowSeconds <= 0) {
      throw new Error('violationWindowSeconds must be positive');
    }
  }

  /**
   * Cleanup resources (clear all timeouts)
   */
  destroy(): void {
    for (const blocked of this.blockedPeers.values()) {
      clearTimeout(blocked.unblockTimeout);
    }
    this.blockedPeers.clear();
    this.tokenBuckets.clear();
    this.adaptiveLimits.clear();
  }
}
