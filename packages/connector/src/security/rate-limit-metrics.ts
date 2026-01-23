/**
 * Rate Limit Metrics Collector
 *
 * Implements metrics collection for rate limiting with Prometheus-compatible format
 */

import type { RateLimitMetrics, RequestType } from './rate-limiter';
import type { Logger } from '../utils/logger';

/**
 * Metric counters for rate limiting
 */
interface MetricCounters {
  allowed: number;
  throttled: number;
  blocked: number;
}

/**
 * Simple in-memory metrics collector for rate limiting
 * In production, this would integrate with Prometheus or similar
 */
export class RateLimitMetricsCollector implements RateLimitMetrics {
  private metrics = new Map<string, MetricCounters>();
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  /**
   * Record an allowed request
   */
  recordAllowed(peerId: string, requestType: RequestType): void {
    const key = this.getMetricKey(peerId, requestType);
    const counters = this.getOrCreateCounters(key);
    counters.allowed++;

    this.logger?.debug(
      {
        peerId,
        requestType,
        action: 'allowed',
        totalAllowed: counters.allowed,
      },
      'Request allowed by rate limiter'
    );
  }

  /**
   * Record a throttled request
   */
  recordThrottled(peerId: string, requestType: RequestType): void {
    const key = this.getMetricKey(peerId, requestType);
    const counters = this.getOrCreateCounters(key);
    counters.throttled++;

    this.logger?.debug(
      {
        peerId,
        requestType,
        action: 'throttled',
        totalThrottled: counters.throttled,
      },
      'Request throttled by rate limiter'
    );
  }

  /**
   * Record a blocked request (circuit breaker active)
   */
  recordBlocked(peerId: string, requestType: RequestType): void {
    const key = this.getMetricKey(peerId, requestType);
    const counters = this.getOrCreateCounters(key);
    counters.blocked++;

    this.logger?.debug(
      {
        peerId,
        requestType,
        action: 'blocked',
        totalBlocked: counters.blocked,
      },
      'Request blocked by circuit breaker'
    );
  }

  /**
   * Get metrics for a specific peer and request type
   */
  getMetrics(peerId: string, requestType: RequestType): MetricCounters {
    const key = this.getMetricKey(peerId, requestType);
    return this.getOrCreateCounters(key);
  }

  /**
   * Get all metrics
   */
  getAllMetrics(): Map<string, MetricCounters> {
    return new Map(this.metrics);
  }

  /**
   * Reset all metrics (for testing)
   */
  reset(): void {
    this.metrics.clear();
  }

  /**
   * Get Prometheus-formatted metrics output
   */
  getPrometheusMetrics(): string {
    const lines: string[] = [];

    // Metrics metadata
    lines.push('# HELP rate_limit_requests_allowed_total Total number of allowed requests');
    lines.push('# TYPE rate_limit_requests_allowed_total counter');

    lines.push('# HELP rate_limit_requests_throttled_total Total number of throttled requests');
    lines.push('# TYPE rate_limit_requests_throttled_total counter');

    lines.push('# HELP rate_limit_requests_blocked_total Total number of blocked requests');
    lines.push('# TYPE rate_limit_requests_blocked_total counter');

    // Metrics data
    for (const [key, counters] of this.metrics.entries()) {
      const [peerId, requestType] = key.split(':');
      const labels = `peer_id="${peerId}",request_type="${requestType}"`;

      lines.push(`rate_limit_requests_allowed_total{${labels}} ${counters.allowed}`);
      lines.push(`rate_limit_requests_throttled_total{${labels}} ${counters.throttled}`);
      lines.push(`rate_limit_requests_blocked_total{${labels}} ${counters.blocked}`);
    }

    return lines.join('\n');
  }

  /**
   * Get metric key for peer and request type
   */
  private getMetricKey(peerId: string, requestType: RequestType): string {
    return `${peerId}:${requestType}`;
  }

  /**
   * Get or create counters for a metric key
   */
  private getOrCreateCounters(key: string): MetricCounters {
    let counters = this.metrics.get(key);
    if (!counters) {
      counters = { allowed: 0, throttled: 0, blocked: 0 };
      this.metrics.set(key, counters);
    }
    return counters;
  }
}
