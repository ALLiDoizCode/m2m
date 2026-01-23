/**
 * Unit tests for RateLimiter
 */

import {
  RateLimiter,
  type RateLimitConfig,
  type RateLimitMetrics,
} from '../../../src/security/rate-limiter';
import type { Logger } from '../../../src/utils/logger';

// Mock logger
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

// Mock metrics collector
const mockMetrics: jest.Mocked<RateLimitMetrics> = {
  recordAllowed: jest.fn(),
  recordThrottled: jest.fn(),
  recordBlocked: jest.fn(),
};

describe('RateLimiter', () => {
  let defaultConfig: RateLimitConfig;
  let rateLimiters: RateLimiter[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimiters = [];
    defaultConfig = {
      maxRequestsPerSecond: 10,
      maxRequestsPerMinute: 600,
      burstSize: 20,
      blockDuration: 300,
      violationThreshold: 100,
      violationWindowSeconds: 60,
    };
  });

  afterEach(() => {
    // Clean up all rate limiters to prevent timer leaks
    rateLimiters.forEach((rl) => rl.destroy());
    rateLimiters = [];
  });

  function createRateLimiter(
    config: RateLimitConfig,
    logger: Logger,
    metrics?: RateLimitMetrics
  ): RateLimiter {
    const rl = new RateLimiter(config, logger, metrics);
    rateLimiters.push(rl);
    return rl;
  }

  describe('constructor', () => {
    it('should create rate limiter with valid config', () => {
      const rateLimiter = createRateLimiter(defaultConfig, mockLogger, mockMetrics);
      expect(rateLimiter).toBeDefined();
    });

    it('should throw error for zero maxRequestsPerSecond', () => {
      const config = { ...defaultConfig, maxRequestsPerSecond: 0 };
      expect(() => createRateLimiter(config, mockLogger)).toThrow(
        'maxRequestsPerSecond must be positive'
      );
    });

    it('should throw error for negative maxRequestsPerMinute', () => {
      const config = { ...defaultConfig, maxRequestsPerMinute: -1 };
      expect(() => createRateLimiter(config, mockLogger)).toThrow(
        'maxRequestsPerMinute must be positive'
      );
    });

    it('should throw error for zero burstSize', () => {
      const config = { ...defaultConfig, burstSize: 0 };
      expect(() => createRateLimiter(config, mockLogger)).toThrow('burstSize must be positive');
    });

    it('should throw error for negative blockDuration', () => {
      const config = { ...defaultConfig, blockDuration: -5 };
      expect(() => createRateLimiter(config, mockLogger)).toThrow('blockDuration must be positive');
    });

    it('should throw error for zero violationThreshold', () => {
      const config = { ...defaultConfig, violationThreshold: 0 };
      expect(() => createRateLimiter(config, mockLogger)).toThrow(
        'violationThreshold must be positive'
      );
    });

    it('should throw error for negative violationWindowSeconds', () => {
      const config = { ...defaultConfig, violationWindowSeconds: -1 };
      expect(() => createRateLimiter(config, mockLogger)).toThrow(
        'violationWindowSeconds must be positive'
      );
    });
  });

  describe('checkLimit', () => {
    it('should allow request within rate limit', async () => {
      const rateLimiter = createRateLimiter(defaultConfig, mockLogger, mockMetrics);
      const allowed = await rateLimiter.checkLimit('peer-a', 'ILP_PACKET');
      expect(allowed).toBe(true);
      expect(mockMetrics.recordAllowed).toHaveBeenCalledWith('peer-a', 'ILP_PACKET');
    });

    it('should throttle requests exceeding burst capacity', async () => {
      const rateLimiter = createRateLimiter(defaultConfig, mockLogger, mockMetrics);

      // Consume all burst capacity (20 requests)
      for (let i = 0; i < 20; i++) {
        await rateLimiter.checkLimit('peer-a', 'ILP_PACKET');
      }

      // Next request should be throttled
      const allowed = await rateLimiter.checkLimit('peer-a', 'ILP_PACKET');
      expect(allowed).toBe(false);
      expect(mockMetrics.recordThrottled).toHaveBeenCalledWith('peer-a', 'ILP_PACKET');
    });

    it('should track limits separately per peer', async () => {
      const rateLimiter = createRateLimiter(defaultConfig, mockLogger, mockMetrics);

      // Exhaust peer-a's limit
      for (let i = 0; i < 20; i++) {
        await rateLimiter.checkLimit('peer-a', 'ILP_PACKET');
      }
      expect(await rateLimiter.checkLimit('peer-a', 'ILP_PACKET')).toBe(false);

      // peer-b should still have full capacity
      expect(await rateLimiter.checkLimit('peer-b', 'ILP_PACKET')).toBe(true);
    });

    it('should block peer after sustained violations', async () => {
      const config = { ...defaultConfig, violationThreshold: 5 };
      const rateLimiter = createRateLimiter(config, mockLogger, mockMetrics);

      // Exhaust burst capacity to trigger violations
      for (let i = 0; i < 20; i++) {
        await rateLimiter.checkLimit('peer-a', 'ILP_PACKET');
      }

      // Trigger violations
      for (let i = 0; i < 10; i++) {
        await rateLimiter.checkLimit('peer-a', 'ILP_PACKET');
      }

      // Should be blocked now
      expect(rateLimiter.getBlockedPeers()).toContain('peer-a');
      expect(await rateLimiter.checkLimit('peer-a', 'ILP_PACKET')).toBe(false);
      expect(mockMetrics.recordBlocked).toHaveBeenCalled();
    });

    it('should log warning when throttling', async () => {
      const rateLimiter = createRateLimiter(defaultConfig, mockLogger);

      // Exhaust capacity
      for (let i = 0; i < 20; i++) {
        await rateLimiter.checkLimit('peer-a', 'ILP_PACKET');
      }

      await rateLimiter.checkLimit('peer-a', 'ILP_PACKET');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { peerId: 'peer-a', requestType: 'ILP_PACKET' },
        'Request rate limited'
      );
    });
  });

  describe('per-peer configuration', () => {
    it('should apply per-peer rate limits', async () => {
      const peerLimits = new Map();
      peerLimits.set('trusted-peer', {
        maxRequestsPerSecond: 100,
        burstSize: 200,
      });

      const config = { ...defaultConfig, peerLimits };
      const rateLimiter = createRateLimiter(config, mockLogger, mockMetrics);

      // Trusted peer should have higher limit (200 burst)
      let allowedCount = 0;
      for (let i = 0; i < 200; i++) {
        const allowed = await rateLimiter.checkLimit('trusted-peer', 'ILP_PACKET');
        if (allowed) allowedCount++;
      }
      // Should allow approximately 200 requests (allow small tolerance for refill)
      expect(allowedCount).toBeGreaterThanOrEqual(195);
      expect(allowedCount).toBeLessThanOrEqual(200);

      // After burst, should be throttled (or close to it)
      const allowed = await rateLimiter.checkLimit('trusted-peer', 'ILP_PACKET');
      expect(allowed).toBe(false);

      // Normal peer should still have default limit (20 burst)
      for (let i = 0; i < 20; i++) {
        expect(await rateLimiter.checkLimit('normal-peer', 'ILP_PACKET')).toBe(true);
      }
      expect(await rateLimiter.checkLimit('normal-peer', 'ILP_PACKET')).toBe(false);
    });
  });

  describe('circuit breaker', () => {
    it('should block peer after exceeding violation threshold', async () => {
      const config = { ...defaultConfig, violationThreshold: 3 };
      const rateLimiter = createRateLimiter(config, mockLogger, mockMetrics);

      // Exhaust capacity
      for (let i = 0; i < 20; i++) {
        await rateLimiter.checkLimit('peer-a', 'ILP_PACKET');
      }

      // Trigger violations
      for (let i = 0; i < 5; i++) {
        await rateLimiter.checkLimit('peer-a', 'ILP_PACKET');
      }

      expect(rateLimiter.getBlockedPeers()).toContain('peer-a');
    });

    it('should log warning when blocking peer', async () => {
      const config = { ...defaultConfig, violationThreshold: 3 };
      const rateLimiter = createRateLimiter(config, mockLogger);

      // Trigger block
      for (let i = 0; i < 25; i++) {
        await rateLimiter.checkLimit('peer-a', 'ILP_PACKET');
      }

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: 'peer-a',
          blockDuration: 300,
        }),
        'Peer blocked due to sustained rate limit violations'
      );
    });

    it('should unblock peer after block duration', async () => {
      const config = { ...defaultConfig, violationThreshold: 3, blockDuration: 1 };
      const rateLimiter = createRateLimiter(config, mockLogger, mockMetrics);

      // Trigger block
      for (let i = 0; i < 25; i++) {
        await rateLimiter.checkLimit('peer-a', 'ILP_PACKET');
      }

      expect(rateLimiter.getBlockedPeers()).toContain('peer-a');

      // Wait for unblock
      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(rateLimiter.getBlockedPeers()).not.toContain('peer-a');
      expect(mockLogger.info).toHaveBeenCalledWith({ peerId: 'peer-a' }, 'Peer unblocked');
    });

    it('should not block trusted peers', async () => {
      const trustedPeers = new Set(['trusted-peer']);
      const config = { ...defaultConfig, violationThreshold: 3, trustedPeers };
      const rateLimiter = createRateLimiter(config, mockLogger, mockMetrics);

      // Trigger violations for trusted peer
      for (let i = 0; i < 30; i++) {
        await rateLimiter.checkLimit('trusted-peer', 'ILP_PACKET');
      }

      expect(rateLimiter.getBlockedPeers()).not.toContain('trusted-peer');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: 'trusted-peer',
        }),
        'Trusted peer exceeded violations but not blocked'
      );
    });
  });

  describe('adaptive rate limiting', () => {
    it('should decrease limit for suspicious peers', async () => {
      const config = { ...defaultConfig, adaptiveRateLimiting: true, violationThreshold: 100 };
      const rateLimiter = createRateLimiter(config, mockLogger);

      // Exhaust capacity to trigger violations
      for (let i = 0; i < 20; i++) {
        await rateLimiter.checkLimit('peer-a', 'ILP_PACKET');
      }

      // Trigger some violations (decrease adaptive limit)
      for (let i = 0; i < 10; i++) {
        await rateLimiter.checkLimit('peer-a', 'ILP_PACKET');
      }

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: 'peer-a',
          newMultiplier: expect.any(Number),
        }),
        'Decreased adaptive rate limit'
      );
    });

    it('should increase limit for trusted peers', () => {
      const config = { ...defaultConfig, adaptiveRateLimiting: true };
      const rateLimiter = createRateLimiter(config, mockLogger);

      rateLimiter.increaseAdaptiveLimit('peer-a');

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: 'peer-a',
          newMultiplier: expect.any(Number),
        }),
        'Increased adaptive rate limit'
      );
    });

    it('should not decrease limit for trusted peers', async () => {
      const trustedPeers = new Set(['trusted-peer']);
      const config = {
        ...defaultConfig,
        adaptiveRateLimiting: true,
        trustedPeers,
        violationThreshold: 100,
      };
      const rateLimiter = createRateLimiter(config, mockLogger);

      // Trigger violations for trusted peer
      for (let i = 0; i < 30; i++) {
        await rateLimiter.checkLimit('trusted-peer', 'ILP_PACKET');
      }

      // Should not log decreased adaptive limit for trusted peer
      expect(mockLogger.debug).not.toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: 'trusted-peer',
        }),
        'Decreased adaptive rate limit'
      );
    });
  });

  describe('manual unblock', () => {
    it('should allow manual unblocking of peer', async () => {
      const config = { ...defaultConfig, violationThreshold: 3 };
      const rateLimiter = createRateLimiter(config, mockLogger);

      // Trigger block
      for (let i = 0; i < 25; i++) {
        await rateLimiter.checkLimit('peer-a', 'ILP_PACKET');
      }

      expect(rateLimiter.getBlockedPeers()).toContain('peer-a');

      rateLimiter.unblock('peer-a');

      expect(rateLimiter.getBlockedPeers()).not.toContain('peer-a');
    });

    it('should handle unblock of non-blocked peer', () => {
      const rateLimiter = createRateLimiter(defaultConfig, mockLogger);
      expect(() => rateLimiter.unblock('unknown-peer')).not.toThrow();
    });
  });

  describe('getBlockedPeers', () => {
    it('should return empty array when no peers blocked', () => {
      const rateLimiter = createRateLimiter(defaultConfig, mockLogger);
      expect(rateLimiter.getBlockedPeers()).toEqual([]);
    });

    it('should return list of blocked peers', async () => {
      const config = { ...defaultConfig, violationThreshold: 3 };
      const rateLimiter = createRateLimiter(config, mockLogger);

      // Block peer-a
      for (let i = 0; i < 25; i++) {
        await rateLimiter.checkLimit('peer-a', 'ILP_PACKET');
      }

      // Block peer-b
      for (let i = 0; i < 25; i++) {
        await rateLimiter.checkLimit('peer-b', 'ILP_PACKET');
      }

      const blocked = rateLimiter.getBlockedPeers();
      expect(blocked).toContain('peer-a');
      expect(blocked).toContain('peer-b');
    });
  });

  describe('destroy', () => {
    it('should clear all timeouts and state', async () => {
      const config = { ...defaultConfig, violationThreshold: 3 };
      const rateLimiter = createRateLimiter(config, mockLogger);

      // Block a peer
      for (let i = 0; i < 25; i++) {
        await rateLimiter.checkLimit('peer-a', 'ILP_PACKET');
      }

      expect(rateLimiter.getBlockedPeers()).toContain('peer-a');

      rateLimiter.destroy();

      expect(rateLimiter.getBlockedPeers()).toEqual([]);
    });
  });

  describe('request types', () => {
    it('should handle different request types', async () => {
      const rateLimiter = createRateLimiter(defaultConfig, mockLogger, mockMetrics);

      expect(await rateLimiter.checkLimit('peer-a', 'BTP_CONNECTION')).toBe(true);
      expect(await rateLimiter.checkLimit('peer-a', 'BTP_MESSAGE')).toBe(true);
      expect(await rateLimiter.checkLimit('peer-a', 'ILP_PACKET')).toBe(true);
      expect(await rateLimiter.checkLimit('peer-a', 'SETTLEMENT')).toBe(true);
      expect(await rateLimiter.checkLimit('peer-a', 'HTTP_API')).toBe(true);
    });
  });
});
