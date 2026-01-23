/**
 * Unit tests for TokenBucket rate limiting algorithm
 */

import { TokenBucket } from '../../../src/security/token-bucket';

describe('TokenBucket', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create bucket with specified capacity and refill rate', () => {
      const bucket = new TokenBucket(10, 5);
      expect(bucket.getAvailableTokens()).toBe(10);
    });

    it('should start with full capacity', () => {
      const bucket = new TokenBucket(100, 50);
      expect(bucket.getAvailableTokens()).toBe(100);
    });

    it('should throw error for zero capacity', () => {
      expect(() => new TokenBucket(0, 10)).toThrow('Token bucket capacity must be positive');
    });

    it('should throw error for negative capacity', () => {
      expect(() => new TokenBucket(-5, 10)).toThrow('Token bucket capacity must be positive');
    });

    it('should throw error for zero refill rate', () => {
      expect(() => new TokenBucket(10, 0)).toThrow('Token bucket refill rate must be positive');
    });

    it('should throw error for negative refill rate', () => {
      expect(() => new TokenBucket(10, -5)).toThrow('Token bucket refill rate must be positive');
    });

    it('should throw error for NaN capacity', () => {
      expect(() => new TokenBucket(NaN, 10)).toThrow(
        'Token bucket parameters must be finite numbers'
      );
    });

    it('should throw error for infinite refill rate', () => {
      expect(() => new TokenBucket(10, Infinity)).toThrow(
        'Token bucket parameters must be finite numbers'
      );
    });
  });

  describe('tryConsume', () => {
    it('should consume token when bucket has tokens', () => {
      const bucket = new TokenBucket(10, 5);
      expect(bucket.tryConsume()).toBe(true);
      // Allow small refill due to time elapsed
      expect(bucket.getAvailableTokens()).toBeCloseTo(9, 0);
    });

    it('should consume multiple tokens sequentially', () => {
      const bucket = new TokenBucket(5, 1);
      expect(bucket.tryConsume()).toBe(true);
      expect(bucket.tryConsume()).toBe(true);
      expect(bucket.tryConsume()).toBe(true);
      // Allow small refill due to time elapsed
      expect(bucket.getAvailableTokens()).toBeCloseTo(2, 0);
    });

    it('should return false when bucket is empty', () => {
      const bucket = new TokenBucket(2, 1);
      expect(bucket.tryConsume()).toBe(true); // 1 left
      expect(bucket.tryConsume()).toBe(true); // 0 left
      expect(bucket.tryConsume()).toBe(false); // Empty
      // Allow tiny refill due to time elapsed between operations
      expect(bucket.getAvailableTokens()).toBeLessThan(0.1);
    });

    it('should not go below zero tokens', () => {
      const bucket = new TokenBucket(1, 0.1);
      expect(bucket.tryConsume()).toBe(true);
      expect(bucket.tryConsume()).toBe(false);
      expect(bucket.tryConsume()).toBe(false);
      // Allow tiny refill due to time elapsed between operations
      expect(bucket.getAvailableTokens()).toBeLessThan(0.1);
    });
  });

  describe('refill', () => {
    it('should refill tokens based on elapsed time', async () => {
      const bucket = new TokenBucket(10, 10); // 10 tokens/second
      bucket.tryConsume(); // 9 tokens left

      // Wait 100ms (should refill 1 token: 10 tokens/sec * 0.1 sec = 1 token)
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(bucket.getAvailableTokens()).toBeCloseTo(10, 0);
    });

    it('should not exceed capacity during refill', async () => {
      const bucket = new TokenBucket(5, 100); // High refill rate

      // Wait 100ms (would add 10 tokens, but capped at capacity)
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(bucket.getAvailableTokens()).toBe(5);
    });

    it('should refill proportionally to elapsed time', async () => {
      const bucket = new TokenBucket(100, 100); // 100 tokens/second
      // Consume all tokens
      for (let i = 0; i < 100; i++) {
        bucket.tryConsume();
      }
      // Allow tiny refill during loop execution
      expect(bucket.getAvailableTokens()).toBeLessThan(1);

      // Wait 500ms (should refill ~50 tokens)
      await new Promise((resolve) => setTimeout(resolve, 500));

      const available = bucket.getAvailableTokens();
      expect(available).toBeGreaterThan(40);
      expect(available).toBeLessThan(60);
    });

    it('should allow consumption after refill', async () => {
      const bucket = new TokenBucket(2, 10);
      bucket.tryConsume(); // 1 left
      bucket.tryConsume(); // 0 left
      expect(bucket.tryConsume()).toBe(false); // Empty

      // Wait 150ms (should refill ~1.5 tokens)
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(bucket.tryConsume()).toBe(true); // Should succeed after refill
    });
  });

  describe('getAvailableTokens', () => {
    it('should return current token count', () => {
      const bucket = new TokenBucket(10, 5);
      expect(bucket.getAvailableTokens()).toBe(10);
      bucket.tryConsume();
      // Allow tiny refill due to time elapsed
      expect(bucket.getAvailableTokens()).toBeCloseTo(9, 0);
    });

    it('should account for refill when called', async () => {
      const bucket = new TokenBucket(10, 10);
      bucket.tryConsume(); // 9 left

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should be refilled close to 10 (capped at capacity), allow timing variance
      expect(bucket.getAvailableTokens()).toBeGreaterThan(9.9);
      expect(bucket.getAvailableTokens()).toBeLessThanOrEqual(10);
    });
  });

  describe('reset', () => {
    it('should reset bucket to full capacity', () => {
      const bucket = new TokenBucket(10, 5);
      bucket.tryConsume();
      bucket.tryConsume();
      bucket.tryConsume();
      // Allow tiny refill due to time elapsed
      expect(bucket.getAvailableTokens()).toBeCloseTo(7, 0);

      bucket.reset();
      expect(bucket.getAvailableTokens()).toBe(10);
    });

    it('should reset refill timer', async () => {
      const bucket = new TokenBucket(10, 10);
      bucket.tryConsume(); // 9 left

      bucket.reset();
      expect(bucket.getAvailableTokens()).toBe(10);

      // Consume some tokens
      bucket.tryConsume();
      bucket.tryConsume();
      // Allow tiny refill due to time elapsed
      expect(bucket.getAvailableTokens()).toBeCloseTo(8, 0);

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should refill approximately 2 tokens (10 tokens/sec * 0.2 sec)
      const available = bucket.getAvailableTokens();
      expect(available).toBeGreaterThan(9);
      expect(available).toBeLessThanOrEqual(10);
    });
  });

  describe('high-load scenarios', () => {
    it('should handle burst traffic within capacity', () => {
      const bucket = new TokenBucket(1000, 100);
      let allowed = 0;

      // Attempt 1000 requests (should all succeed due to burst capacity)
      for (let i = 0; i < 1000; i++) {
        if (bucket.tryConsume()) {
          allowed++;
        }
      }

      expect(allowed).toBe(1000);
    });

    it('should throttle requests exceeding capacity', () => {
      const bucket = new TokenBucket(10, 1);
      let allowed = 0;

      // Attempt 100 requests (only 10 should succeed)
      for (let i = 0; i < 100; i++) {
        if (bucket.tryConsume()) {
          allowed++;
        }
      }

      expect(allowed).toBe(10);
    });

    it('should maintain steady-state rate under sustained load', async () => {
      const bucket = new TokenBucket(10, 100); // 100 req/sec
      const results: boolean[] = [];

      // Generate 50 requests over 500ms (expected: ~50 allowed)
      for (let i = 0; i < 50; i++) {
        results.push(bucket.tryConsume());
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const allowed = results.filter((r) => r).length;
      // Should allow approximately 50 requests (100/sec * 0.5sec)
      // Allow some tolerance for timing
      expect(allowed).toBeGreaterThan(40);
      expect(allowed).toBeLessThanOrEqual(60);
    });
  });

  describe('edge cases', () => {
    it('should handle fractional refill rates', async () => {
      const bucket = new TokenBucket(10, 0.5); // 0.5 tokens/second
      bucket.tryConsume(); // 9 left

      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Should refill 1 token (0.5 * 2 seconds)
      expect(bucket.getAvailableTokens()).toBeCloseTo(10, 0);
    });

    it('should handle very high refill rates', async () => {
      const bucket = new TokenBucket(1000, 10000);
      for (let i = 0; i < 1000; i++) {
        bucket.tryConsume();
      }
      // Allow for small refill during loop execution
      expect(bucket.getAvailableTokens()).toBeLessThanOrEqual(100);

      // Wait a tiny bit for refill
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Even with high refill rate, should not exceed capacity
      expect(bucket.getAvailableTokens()).toBeLessThanOrEqual(1000);
    });

    it('should handle capacity of 1', () => {
      const bucket = new TokenBucket(1, 1);
      expect(bucket.tryConsume()).toBe(true);
      expect(bucket.tryConsume()).toBe(false);
    });

    it('should handle very large capacity', () => {
      const bucket = new TokenBucket(1000000, 100000);
      expect(bucket.getAvailableTokens()).toBe(1000000);
      bucket.tryConsume();
      // Allow tiny refill due to time elapsed
      expect(bucket.getAvailableTokens()).toBeCloseTo(999999, -1);
    });
  });
});
