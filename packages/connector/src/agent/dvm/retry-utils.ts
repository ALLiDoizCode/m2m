import type { RetryOptions } from './types';

/**
 * Calculate exponential backoff delay with capping.
 *
 * Formula: min(baseMs * 2^attempt, maxMs)
 *
 * @param attempt - Attempt number (0-indexed)
 * @param baseMs - Base delay in milliseconds (default: 1000)
 * @param maxMs - Maximum delay cap in milliseconds (default: 30000)
 * @returns Backoff delay in milliseconds
 *
 * @example
 * ```typescript
 * calculateBackoff(0, 1000, 30000); // 1000ms (1s)
 * calculateBackoff(1, 1000, 30000); // 2000ms (2s)
 * calculateBackoff(2, 1000, 30000); // 4000ms (4s)
 * calculateBackoff(3, 1000, 30000); // 8000ms (8s)
 * calculateBackoff(4, 1000, 30000); // 16000ms (16s)
 * calculateBackoff(5, 1000, 30000); // 30000ms (30s, capped)
 * ```
 */
export function calculateBackoff(
  attempt: number,
  baseMs: number = 1000,
  maxMs: number = 30000
): number {
  const exponentialBackoff = baseMs * Math.pow(2, attempt);
  return Math.min(exponentialBackoff, maxMs);
}

/**
 * Sleep for specified milliseconds.
 *
 * @param ms - Milliseconds to sleep
 * @returns Promise that resolves after delay
 *
 * @example
 * ```typescript
 * await sleep(1000); // Wait 1 second
 * ```
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with automatic retries and exponential backoff.
 *
 * Retries failed executions with exponential backoff between attempts.
 * Stops retrying when max retries exhausted or shouldRetry returns false.
 *
 * @param fn - Function to execute (returns Promise)
 * @param options - Retry configuration options
 * @returns Promise resolving to function result
 * @throws {Error} Last error if all retries exhausted
 *
 * @example
 * ```typescript
 * const result = await executeWithRetry(
 *   () => fetchDataFromAPI(),
 *   {
 *     maxRetries: 3,
 *     baseBackoffMs: 1000,
 *     maxBackoffMs: 10000,
 *     shouldRetry: (error) => {
 *       // Only retry on network errors
 *       return error.message.includes('ECONNREFUSED');
 *     },
 *     onRetry: (attempt, error) => {
 *       console.log(`Retry ${attempt + 1} after error: ${error.message}`);
 *     },
 *   }
 * );
 * ```
 */
export async function executeWithRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    maxRetries,
    baseBackoffMs = 1000,
    maxBackoffMs = 30000,
    shouldRetry = () => true,
    onRetry,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Check if we should retry
      const isLastAttempt = attempt >= maxRetries;
      const isRetryable = shouldRetry(lastError);

      if (isLastAttempt || !isRetryable) {
        throw lastError;
      }

      // Call onRetry callback if provided
      if (onRetry) {
        await onRetry(attempt, lastError);
      }

      // Calculate and wait for backoff delay
      const backoffMs = calculateBackoff(attempt, baseBackoffMs, maxBackoffMs);
      await sleep(backoffMs);
    }
  }

  // This should never be reached due to throw in loop, but TypeScript needs it
  throw lastError!;
}
