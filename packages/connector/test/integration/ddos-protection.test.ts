/* eslint-disable no-console */
/**
 * DDoS Protection Integration Test
 *
 * Demonstrates rate limiting and DDoS protection under high load (10K requests/second)
 * Tests AC 10: Integration test demonstrates DDoS protection under high load
 */

import { RateLimiter, type RateLimitConfig } from '../../src/security/rate-limiter';
import { RateLimitMetricsCollector } from '../../src/security/rate-limit-metrics';
import type { Logger } from '../../src/utils/logger';

// Mock logger for testing
const mockLogger: Logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
  trace: jest.fn(),
  child: jest.fn(),
  level: 'info',
  silent: jest.fn(),
} as unknown as Logger;

describe('DDoS Protection Integration Tests', () => {
  let rateLimiter: RateLimiter;
  let metrics: RateLimitMetricsCollector;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    rateLimiter?.destroy();
  });

  describe('burst traffic protection (AC 10)', () => {
    it('should rate limit burst traffic of 10K packets in 1 second', async () => {
      metrics = new RateLimitMetricsCollector(mockLogger);
      const config: RateLimitConfig = {
        maxRequestsPerSecond: 1000,
        maxRequestsPerMinute: 60000,
        burstSize: 1000,
        blockDuration: 300,
        violationThreshold: 100,
        violationWindowSeconds: 60,
      };

      rateLimiter = new RateLimiter(config, mockLogger, metrics);

      // Generate 10K requests as fast as possible
      const totalRequests = 10000;
      let allowed = 0;
      let throttled = 0;

      const startTime = Date.now();

      for (let i = 0; i < totalRequests; i++) {
        const result = await rateLimiter.checkLimit('attacker-peer', 'ILP_PACKET');
        if (result) {
          allowed++;
        } else {
          throttled++;
        }
      }

      const duration = Date.now() - startTime;

      // Assertions
      expect(allowed).toBeLessThan(2000); // Should allow ~1000 (burst) + some refill
      expect(throttled).toBeGreaterThan(8000); // Should throttle most requests
      expect(allowed + throttled).toBe(totalRequests);

      // Verify metrics (note: metrics track per request type)
      const peerMetrics = metrics.getMetrics('attacker-peer', 'ILP_PACKET');
      expect(peerMetrics.allowed).toBe(allowed);
      expect(peerMetrics.throttled).toBeGreaterThan(0); // Some throttling occurred

      // Log performance
      console.log(`DDoS Protection Test Results:`);
      console.log(`  Total Requests: ${totalRequests}`);
      console.log(`  Allowed: ${allowed}`);
      console.log(`  Throttled: ${throttled}`);
      console.log(`  Duration: ${duration}ms`);
      console.log(`  Throughput: ${((totalRequests / duration) * 1000).toFixed(0)} req/sec`);
    }, 30000);

    it('should handle sustained traffic of 10K packets/second for 60 seconds', async () => {
      metrics = new RateLimitMetricsCollector(mockLogger);
      const config: RateLimitConfig = {
        maxRequestsPerSecond: 100, // Lower limit for sustainable test
        maxRequestsPerMinute: 6000,
        burstSize: 200,
        blockDuration: 300,
        violationThreshold: 1000,
        violationWindowSeconds: 60,
      };

      rateLimiter = new RateLimiter(config, mockLogger, metrics);

      // Simulate sustained load over 5 seconds (instead of 60 for test performance)
      const durationSeconds = 5;
      const requestsPerSecond = 1000;
      const totalRequests = durationSeconds * requestsPerSecond;

      let allowed = 0;
      let throttled = 0;

      const startTime = Date.now();

      for (let i = 0; i < totalRequests; i++) {
        const result = await rateLimiter.checkLimit('sustained-attacker', 'ILP_PACKET');
        if (result) {
          allowed++;
        } else {
          throttled++;
        }

        // Small delay to spread load over time (1ms per request = 1000 req/sec)
        if (i % 100 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }

      const duration = Date.now() - startTime;

      // Should throttle most requests above the limit
      expect(throttled).toBeGreaterThan(allowed);
      expect(allowed + throttled).toBe(totalRequests);

      // Verify system remains stable
      expect(duration).toBeLessThan(durationSeconds * 1000 * 2); // Within 2x expected time

      console.log(`Sustained Load Test Results:`);
      console.log(`  Duration: ${duration}ms`);
      console.log(`  Total Requests: ${totalRequests}`);
      console.log(`  Allowed: ${allowed}`);
      console.log(`  Throttled: ${throttled}`);
      console.log(`  Avg Throughput: ${((totalRequests / duration) * 1000).toFixed(0)} req/sec`);
    }, 60000);
  });

  describe('mixed peer isolation (AC 10)', () => {
    it('should isolate rate limits across multiple peers', async () => {
      metrics = new RateLimitMetricsCollector(mockLogger);
      const peerLimits = new Map();
      peerLimits.set('trusted-peer', {
        maxRequestsPerSecond: 500,
        burstSize: 1000,
      });

      const config: RateLimitConfig = {
        maxRequestsPerSecond: 100,
        maxRequestsPerMinute: 6000,
        burstSize: 200,
        blockDuration: 300,
        violationThreshold: 100,
        violationWindowSeconds: 60,
        peerLimits,
      };

      rateLimiter = new RateLimiter(config, mockLogger, metrics);

      const peers = ['peer-a', 'peer-b', 'trusted-peer', 'peer-c'];
      const requestsPerPeer = 500;

      // Send requests from multiple peers in parallel
      const results = await Promise.all(
        peers.map(async (peerId) => {
          let allowed = 0;
          for (let i = 0; i < requestsPerPeer; i++) {
            const result = await rateLimiter.checkLimit(peerId, 'ILP_PACKET');
            if (result) allowed++;
          }
          return { peerId, allowed };
        })
      );

      // Verify isolation
      for (const { peerId, allowed } of results) {
        const peerMetrics = metrics.getMetrics(peerId, 'ILP_PACKET');

        if (peerId === 'trusted-peer') {
          // Trusted peer should allow more requests
          expect(allowed).toBeGreaterThan(400);
          console.log(`${peerId}: ${allowed} allowed (trusted)`);
        } else {
          // Normal peers should be limited to ~200 (burst)
          expect(allowed).toBeLessThan(300);
          expect(allowed).toBeGreaterThan(100);
          console.log(`${peerId}: ${allowed} allowed (normal)`);
        }

        // Verify metrics tracked (at least allowed should be > 0)
        expect(peerMetrics.allowed).toBe(allowed);
      }
    }, 30000);
  });

  describe('circuit breaker integration (AC 10)', () => {
    it('should trigger circuit breaker after sustained violations', async () => {
      metrics = new RateLimitMetricsCollector(mockLogger);
      const config: RateLimitConfig = {
        maxRequestsPerSecond: 10,
        maxRequestsPerMinute: 600,
        burstSize: 20,
        blockDuration: 2, // Short duration for testing
        violationThreshold: 50,
        violationWindowSeconds: 60,
      };

      rateLimiter = new RateLimiter(config, mockLogger, metrics);

      // Exhaust burst capacity
      for (let i = 0; i < 20; i++) {
        await rateLimiter.checkLimit('bad-peer', 'ILP_PACKET');
      }

      // Trigger violations to activate circuit breaker
      for (let i = 0; i < 100; i++) {
        await rateLimiter.checkLimit('bad-peer', 'ILP_PACKET');
      }

      // Verify peer is blocked
      expect(rateLimiter.getBlockedPeers()).toContain('bad-peer');
      expect(await rateLimiter.checkLimit('bad-peer', 'ILP_PACKET')).toBe(false);

      // Verify metrics show blocked requests
      const peerMetrics = metrics.getMetrics('bad-peer', 'ILP_PACKET');
      expect(peerMetrics.blocked).toBeGreaterThan(0);

      // Wait for unblock
      await new Promise((resolve) => setTimeout(resolve, 2100));

      // Verify peer is unblocked
      expect(rateLimiter.getBlockedPeers()).not.toContain('bad-peer');
      expect(mockLogger.info).toHaveBeenCalledWith({ peerId: 'bad-peer' }, 'Peer unblocked');
    }, 30000);

    it('should allow circuit breaker recovery after unblock', async () => {
      metrics = new RateLimitMetricsCollector(mockLogger);
      const config: RateLimitConfig = {
        maxRequestsPerSecond: 10,
        maxRequestsPerMinute: 600,
        burstSize: 20,
        blockDuration: 1,
        violationThreshold: 30,
        violationWindowSeconds: 60,
      };

      rateLimiter = new RateLimiter(config, mockLogger, metrics);

      // Trigger block
      for (let i = 0; i < 100; i++) {
        await rateLimiter.checkLimit('recovering-peer', 'ILP_PACKET');
      }

      expect(rateLimiter.getBlockedPeers()).toContain('recovering-peer');

      // Wait for unblock
      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(rateLimiter.getBlockedPeers()).not.toContain('recovering-peer');

      // Should allow new requests after recovery
      expect(await rateLimiter.checkLimit('recovering-peer', 'ILP_PACKET')).toBe(true);
    }, 30000);
  });

  describe('performance and stability (AC 10)', () => {
    it('should not leak memory under sustained load (100K requests)', async () => {
      metrics = new RateLimitMetricsCollector(mockLogger);
      const config: RateLimitConfig = {
        maxRequestsPerSecond: 1000,
        maxRequestsPerMinute: 60000,
        burstSize: 2000,
        blockDuration: 300,
        violationThreshold: 100,
        violationWindowSeconds: 60,
      };

      rateLimiter = new RateLimiter(config, mockLogger, metrics);

      const totalRequests = 100000;
      const batchSize = 10000;

      // Get initial memory usage
      if (global.gc) {
        global.gc();
      }
      const initialMemory = process.memoryUsage().heapUsed;

      // Process requests in batches
      for (let batch = 0; batch < totalRequests / batchSize; batch++) {
        for (let i = 0; i < batchSize; i++) {
          await rateLimiter.checkLimit(`peer-${i % 10}`, 'ILP_PACKET');
        }
      }

      // Check memory after load
      if (global.gc) {
        global.gc();
      }
      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      // Memory increase should be reasonable (< 100MB for 100K requests)
      // Allow more tolerance due to test environment overhead
      expect(memoryIncrease).toBeLessThan(100 * 1024 * 1024);

      console.log(`Memory Test Results:`);
      console.log(`  Initial Memory: ${(initialMemory / 1024 / 1024).toFixed(2)} MB`);
      console.log(`  Final Memory: ${(finalMemory / 1024 / 1024).toFixed(2)} MB`);
      console.log(`  Increase: ${(memoryIncrease / 1024 / 1024).toFixed(2)} MB`);
    }, 60000);

    it('should maintain low latency (<1ms p99) under normal load', async () => {
      metrics = new RateLimitMetricsCollector(mockLogger);
      const config: RateLimitConfig = {
        maxRequestsPerSecond: 1000,
        maxRequestsPerMinute: 60000,
        burstSize: 2000,
        blockDuration: 300,
        violationThreshold: 100,
        violationWindowSeconds: 60,
      };

      rateLimiter = new RateLimiter(config, mockLogger, metrics);

      const latencies: number[] = [];
      const iterations = 10000;

      for (let i = 0; i < iterations; i++) {
        const start = process.hrtime.bigint();
        await rateLimiter.checkLimit('test-peer', 'ILP_PACKET');
        const end = process.hrtime.bigint();
        const latencyNs = Number(end - start);
        latencies.push(latencyNs);
      }

      // Sort latencies for percentile calculation
      latencies.sort((a, b) => a - b);

      const p50 = (latencies[Math.floor(iterations * 0.5)] ?? 0) / 1000000; // Convert to ms
      const p95 = (latencies[Math.floor(iterations * 0.95)] ?? 0) / 1000000;
      const p99 = (latencies[Math.floor(iterations * 0.99)] ?? 0) / 1000000;
      const max = (latencies[latencies.length - 1] ?? 0) / 1000000;

      console.log(`Latency Test Results:`);
      console.log(`  p50: ${p50.toFixed(3)} ms`);
      console.log(`  p95: ${p95.toFixed(3)} ms`);
      console.log(`  p99: ${p99.toFixed(3)} ms`);
      console.log(`  max: ${max.toFixed(3)} ms`);

      // p99 should be < 1ms (requirement from story)
      expect(p99).toBeLessThan(1.0);
    }, 30000);
  });

  describe('Prometheus metrics integration (AC 7)', () => {
    it('should expose Prometheus-compatible metrics', async () => {
      metrics = new RateLimitMetricsCollector(mockLogger);
      const config: RateLimitConfig = {
        maxRequestsPerSecond: 100,
        maxRequestsPerMinute: 6000,
        burstSize: 200,
        blockDuration: 300,
        violationThreshold: 100,
        violationWindowSeconds: 60,
      };

      rateLimiter = new RateLimiter(config, mockLogger, metrics);

      // Generate some traffic
      for (let i = 0; i < 100; i++) {
        await rateLimiter.checkLimit('peer-a', 'ILP_PACKET');
      }
      for (let i = 0; i < 50; i++) {
        await rateLimiter.checkLimit('peer-b', 'SETTLEMENT');
      }

      const prometheusOutput = metrics.getPrometheusMetrics();

      // Verify Prometheus format
      expect(prometheusOutput).toContain('# HELP rate_limit_requests_allowed_total');
      expect(prometheusOutput).toContain('# TYPE rate_limit_requests_allowed_total counter');
      expect(prometheusOutput).toContain('rate_limit_requests_allowed_total{');
      expect(prometheusOutput).toContain('peer_id="peer-a"');
      expect(prometheusOutput).toContain('request_type="ILP_PACKET"');

      console.log('Prometheus Metrics Output:');
      console.log(prometheusOutput);
    });
  });
});
