import { executeWithRetry, calculateBackoff, sleep } from '../retry-utils';
import type { RetryOptions } from '../types';

describe('retry-utils', () => {
  describe('calculateBackoff', () => {
    it('should calculate exponential backoff correctly', () => {
      // Arrange & Act & Assert
      expect(calculateBackoff(0, 1000, 30000)).toBe(1000); // 1s
      expect(calculateBackoff(1, 1000, 30000)).toBe(2000); // 2s
      expect(calculateBackoff(2, 1000, 30000)).toBe(4000); // 4s
      expect(calculateBackoff(3, 1000, 30000)).toBe(8000); // 8s
      expect(calculateBackoff(4, 1000, 30000)).toBe(16000); // 16s
      expect(calculateBackoff(5, 1000, 30000)).toBe(30000); // 30s (capped)
      expect(calculateBackoff(6, 1000, 30000)).toBe(30000); // 30s (capped)
    });

    it('should use default values when not specified', () => {
      // Act & Assert
      expect(calculateBackoff(0)).toBe(1000); // Default: 1000ms base, 30000ms max
      expect(calculateBackoff(5)).toBe(30000); // Capped at default max
    });

    it('should respect custom base and max values', () => {
      // Arrange
      const baseMs = 500;
      const maxMs = 5000;

      // Act & Assert
      expect(calculateBackoff(0, baseMs, maxMs)).toBe(500); // 0.5s
      expect(calculateBackoff(1, baseMs, maxMs)).toBe(1000); // 1s
      expect(calculateBackoff(2, baseMs, maxMs)).toBe(2000); // 2s
      expect(calculateBackoff(3, baseMs, maxMs)).toBe(4000); // 4s
      expect(calculateBackoff(4, baseMs, maxMs)).toBe(5000); // 5s (capped)
      expect(calculateBackoff(5, baseMs, maxMs)).toBe(5000); // 5s (capped)
    });

    it('should handle zero attempt', () => {
      // Act
      const result = calculateBackoff(0, 1000, 30000);

      // Assert
      expect(result).toBe(1000);
    });

    it('should cap at maxMs for large attempts', () => {
      // Act
      const result = calculateBackoff(100, 1000, 10000);

      // Assert
      expect(result).toBe(10000);
    });
  });

  describe('sleep', () => {
    it('should sleep for specified milliseconds', async () => {
      // Arrange
      const sleepMs = 50;
      const startTime = Date.now();

      // Act
      await sleep(sleepMs);
      const elapsed = Date.now() - startTime;

      // Assert
      expect(elapsed).toBeGreaterThanOrEqual(sleepMs - 10); // Allow 10ms tolerance
      expect(elapsed).toBeLessThan(sleepMs + 100); // Allow 100ms overhead for slow CI
    });

    it('should resolve immediately for zero sleep', async () => {
      // Arrange
      const startTime = Date.now();

      // Act
      await sleep(0);
      const elapsed = Date.now() - startTime;

      // Assert
      expect(elapsed).toBeLessThan(20); // Should be near-instant
    });
  });

  describe('executeWithRetry', () => {
    it('should succeed on first attempt without retries', async () => {
      // Arrange
      const expectedValue = 'success';
      const fn = jest.fn().mockResolvedValue(expectedValue);
      const options: RetryOptions = { maxRetries: 3 };

      // Act
      const result = await executeWithRetry(fn, options);

      // Assert
      expect(result).toBe(expectedValue);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and eventually succeed', async () => {
      // Arrange
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('Attempt 1 failed'))
        .mockRejectedValueOnce(new Error('Attempt 2 failed'))
        .mockResolvedValue('success');
      const options: RetryOptions = {
        maxRetries: 3,
        baseBackoffMs: 10, // Fast for testing
        maxBackoffMs: 100,
      };

      // Act
      const result = await executeWithRetry(fn, options);

      // Assert
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3); // 2 failures + 1 success
    });

    it('should throw last error when max retries exhausted', async () => {
      // Arrange
      const lastError = new Error('Final failure');
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('Attempt 1'))
        .mockRejectedValueOnce(new Error('Attempt 2'))
        .mockRejectedValueOnce(new Error('Attempt 3'))
        .mockRejectedValue(lastError);
      const options: RetryOptions = {
        maxRetries: 3,
        baseBackoffMs: 10,
        maxBackoffMs: 100,
      };

      // Act & Assert
      await expect(executeWithRetry(fn, options)).rejects.toThrow(lastError);
      expect(fn).toHaveBeenCalledTimes(4); // Initial + 3 retries
    });

    it('should call onRetry callback before each retry', async () => {
      // Arrange
      const onRetry = jest.fn();
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockResolvedValue('success');
      const options: RetryOptions = {
        maxRetries: 3,
        baseBackoffMs: 10,
        maxBackoffMs: 100,
        onRetry,
      };

      // Act
      await executeWithRetry(fn, options);

      // Assert
      expect(onRetry).toHaveBeenCalledTimes(2); // Called before retry 1 and 2
      expect(onRetry).toHaveBeenNthCalledWith(1, 0, expect.any(Error));
      expect(onRetry).toHaveBeenNthCalledWith(2, 1, expect.any(Error));
    });

    it('should not retry when shouldRetry returns false', async () => {
      // Arrange
      const nonRetryableError = new Error('Non-retryable');
      const fn = jest.fn().mockRejectedValue(nonRetryableError);
      const shouldRetry = jest.fn().mockReturnValue(false);
      const options: RetryOptions = {
        maxRetries: 3,
        shouldRetry,
      };

      // Act & Assert
      await expect(executeWithRetry(fn, options)).rejects.toThrow(nonRetryableError);
      expect(fn).toHaveBeenCalledTimes(1); // Only initial attempt
      expect(shouldRetry).toHaveBeenCalledWith(nonRetryableError);
    });

    it('should retry only for retryable errors based on shouldRetry predicate', async () => {
      // Arrange
      const retryableError = new Error('ECONNREFUSED');
      const nonRetryableError = new Error('INVALID_AUTH');
      const fn = jest
        .fn()
        .mockRejectedValueOnce(retryableError)
        .mockRejectedValueOnce(nonRetryableError);
      const shouldRetry = (error: Error) => error.message.includes('ECONNREFUSED');
      const options: RetryOptions = {
        maxRetries: 3,
        baseBackoffMs: 10,
        maxBackoffMs: 100,
        shouldRetry,
      };

      // Act & Assert
      await expect(executeWithRetry(fn, options)).rejects.toThrow(nonRetryableError);
      expect(fn).toHaveBeenCalledTimes(2); // Retried once for retryable, stopped on non-retryable
    });

    it('should handle zero max retries (fail immediately)', async () => {
      // Arrange
      const error = new Error('Immediate failure');
      const fn = jest.fn().mockRejectedValue(error);
      const options: RetryOptions = { maxRetries: 0 };

      // Act & Assert
      await expect(executeWithRetry(fn, options)).rejects.toThrow(error);
      expect(fn).toHaveBeenCalledTimes(1); // Only initial attempt, no retries
    });

    it('should respect custom backoff parameters', async () => {
      // Arrange
      const fn = jest.fn().mockRejectedValueOnce(new Error('Fail 1')).mockResolvedValue('success');
      const options: RetryOptions = {
        maxRetries: 1,
        baseBackoffMs: 50,
        maxBackoffMs: 500,
      };
      const startTime = Date.now();

      // Act
      await executeWithRetry(fn, options);
      const elapsed = Date.now() - startTime;

      // Assert
      expect(fn).toHaveBeenCalledTimes(2);
      expect(elapsed).toBeGreaterThanOrEqual(50 - 10); // At least one 50ms backoff
    });

    it('should handle async onRetry callback', async () => {
      // Arrange
      const onRetry = jest.fn().mockImplementation(async () => {
        await sleep(20);
      });
      const fn = jest.fn().mockRejectedValueOnce(new Error('Fail')).mockResolvedValue('success');
      const options: RetryOptions = {
        maxRetries: 1,
        baseBackoffMs: 10,
        maxBackoffMs: 100,
        onRetry,
      };

      // Act
      await executeWithRetry(fn, options);

      // Assert
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('should pass correct attempt number and error to onRetry', async () => {
      // Arrange
      const error1 = new Error('First error');
      const error2 = new Error('Second error');
      const onRetry = jest.fn();
      const fn = jest
        .fn()
        .mockRejectedValueOnce(error1)
        .mockRejectedValueOnce(error2)
        .mockResolvedValue('success');
      const options: RetryOptions = {
        maxRetries: 2,
        baseBackoffMs: 10,
        maxBackoffMs: 100,
        onRetry,
      };

      // Act
      await executeWithRetry(fn, options);

      // Assert
      expect(onRetry).toHaveBeenNthCalledWith(1, 0, error1);
      expect(onRetry).toHaveBeenNthCalledWith(2, 1, error2);
    });
  });
});
