/**
 * Rate Limit Configuration
 *
 * Provides configuration loading and defaults for rate limiting
 */

import type { RateLimitConfig, PeerRateLimitConfig } from './rate-limiter';

/**
 * Default rate limit configuration
 */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  maxRequestsPerSecond: parseIntEnv('RATE_LIMIT_MAX_PER_SECOND', 1000),
  maxRequestsPerMinute: parseIntEnv('RATE_LIMIT_MAX_PER_MINUTE', 60000),
  burstSize: parseIntEnv('RATE_LIMIT_BURST_SIZE', 2000),
  blockDuration: parseIntEnv('RATE_LIMIT_BLOCK_DURATION', 300), // 5 minutes
  violationThreshold: parseIntEnv('RATE_LIMIT_VIOLATION_THRESHOLD', 100),
  violationWindowSeconds: parseIntEnv('RATE_LIMIT_VIOLATION_WINDOW', 60),
  adaptiveRateLimiting: parseBoolEnv('RATE_LIMIT_ADAPTIVE_ENABLED', true),
};

/**
 * Create rate limit configuration with optional overrides
 */
export function createRateLimitConfig(overrides?: Partial<RateLimitConfig>): RateLimitConfig {
  return {
    ...DEFAULT_RATE_LIMIT_CONFIG,
    ...overrides,
  };
}

/**
 * Add trusted peer to rate limit configuration
 */
export function addTrustedPeer(config: RateLimitConfig, peerId: string): RateLimitConfig {
  const trustedPeers = config.trustedPeers ?? new Set();
  trustedPeers.add(peerId);
  return {
    ...config,
    trustedPeers,
  };
}

/**
 * Set per-peer rate limit configuration
 */
export function setPeerLimit(
  config: RateLimitConfig,
  peerId: string,
  peerConfig: PeerRateLimitConfig
): RateLimitConfig {
  const peerLimits = config.peerLimits ?? new Map();
  peerLimits.set(peerId, peerConfig);
  return {
    ...config,
    peerLimits,
  };
}

/**
 * Parse integer from environment variable with default
 * Note: Silently falls back to default for invalid values.
 * TODO: Add validation logging once logger is available at config load time
 */
function parseIntEnv(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse boolean from environment variable with default
 */
function parseBoolEnv(key: string, defaultValue: boolean): boolean {
  const value = process.env[key]?.toLowerCase();
  if (!value) {
    return defaultValue;
  }
  return value === 'true' || value === '1' || value === 'yes';
}

/**
 * Check if rate limiting is enabled
 */
export function isRateLimitingEnabled(): boolean {
  return parseBoolEnv('RATE_LIMIT_ENABLED', true);
}
