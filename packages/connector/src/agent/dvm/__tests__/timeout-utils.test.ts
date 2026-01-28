import { executeWithTimeout, createTimeoutPromise } from '../timeout-utils';
import { TimeoutError } from '../types';

describe('timeout-utils', () => {
  describe('createTimeoutPromise', () => {
    it('should reject with TimeoutError after specified delay', async () => {
      // Arrange
      const timeoutMs = 100;

      // Act & Assert
      await expect(createTimeoutPromise(timeoutMs)).rejects.toThrow(TimeoutError);
      await expect(createTimeoutPromise(timeoutMs)).rejects.toThrow(
        `Operation timed out after ${timeoutMs}ms`
      );
    });

    it('should reject with TimeoutError that is instanceof TimeoutError', async () => {
      // Arrange & Act
      try {
        await createTimeoutPromise(50);
        fail('Should have thrown TimeoutError');
      } catch (error) {
        // Assert
        expect(error).toBeInstanceOf(TimeoutError);
        expect((error as TimeoutError).name).toBe('TimeoutError');
      }
    });
  });

  describe('executeWithTimeout', () => {
    it('should resolve successfully if promise completes within timeout', async () => {
      // Arrange
      const expectedValue = 'success';
      const promise = Promise.resolve(expectedValue);
      const timeoutMs = 1000;

      // Act
      const result = await executeWithTimeout(promise, timeoutMs);

      // Assert
      expect(result).toBe(expectedValue);
    });

    it('should reject with TimeoutError if promise exceeds timeout', async () => {
      // Arrange
      const slowPromise = new Promise<string>((resolve) => {
        setTimeout(() => resolve('too slow'), 1000);
      });
      const timeoutMs = 100;

      // Act & Assert
      await expect(executeWithTimeout(slowPromise, timeoutMs)).rejects.toThrow(TimeoutError);
      await expect(executeWithTimeout(slowPromise, timeoutMs)).rejects.toThrow(
        `Operation timed out after ${timeoutMs}ms`
      );
    });

    it('should reject with original error if promise rejects before timeout', async () => {
      // Arrange
      const expectedError = new Error('Original error');
      const promise = Promise.reject(expectedError);
      const timeoutMs = 1000;

      // Act & Assert
      await expect(executeWithTimeout(promise, timeoutMs)).rejects.toThrow(expectedError);
    });

    it('should reject immediately with validation error for zero timeout', async () => {
      // Arrange
      const promise = Promise.resolve('value');
      const timeoutMs = 0;

      // Act & Assert
      await expect(executeWithTimeout(promise, timeoutMs)).rejects.toThrow(
        'Invalid timeout: 0ms. Must be positive.'
      );
    });

    it('should reject immediately with validation error for negative timeout', async () => {
      // Arrange
      const promise = Promise.resolve('value');
      const timeoutMs = -1000;

      // Act & Assert
      await expect(executeWithTimeout(promise, timeoutMs)).rejects.toThrow(
        'Invalid timeout: -1000ms. Must be positive.'
      );
    });

    it('should handle async functions that resolve quickly', async () => {
      // Arrange
      const asyncFn = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 42;
      };
      const timeoutMs = 1000;

      // Act
      const result = await executeWithTimeout(asyncFn(), timeoutMs);

      // Assert
      expect(result).toBe(42);
    });

    it('should handle async functions that timeout', async () => {
      // Arrange
      const slowAsyncFn = async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return 'never reached';
      };
      const timeoutMs = 100;

      // Act & Assert
      await expect(executeWithTimeout(slowAsyncFn(), timeoutMs)).rejects.toThrow(TimeoutError);
    });

    it('should work with very short timeouts', async () => {
      // Arrange
      const promise = new Promise<string>((resolve) => {
        setTimeout(() => resolve('slow'), 500);
      });
      const timeoutMs = 1; // 1ms timeout

      // Act & Assert
      await expect(executeWithTimeout(promise, timeoutMs)).rejects.toThrow(TimeoutError);
    });
  });
});
