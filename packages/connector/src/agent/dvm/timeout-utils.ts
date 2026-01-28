import { TimeoutError } from './types';

/**
 * Create a promise that rejects with TimeoutError after specified delay.
 *
 * @param timeoutMs - Timeout duration in milliseconds
 * @returns Promise that rejects with TimeoutError
 *
 * @example
 * ```typescript
 * const timeoutPromise = createTimeoutPromise(5000);
 * // Rejects after 5 seconds with TimeoutError
 * ```
 */
export function createTimeoutPromise(timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new TimeoutError(`Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

/**
 * Execute a promise with a timeout. If the promise doesn't resolve within the timeout,
 * it rejects with a TimeoutError.
 *
 * Uses Promise.race to implement timeout behavior. The original promise continues
 * executing in the background even after timeout (JavaScript promises cannot be cancelled).
 *
 * @param promise - The promise to execute with timeout
 * @param timeoutMs - Maximum execution time in milliseconds
 * @returns Promise that resolves with the result or rejects with TimeoutError
 * @throws {TimeoutError} If operation exceeds timeout
 * @throws {Error} If the original promise rejects
 *
 * @example
 * ```typescript
 * try {
 *   const result = await executeWithTimeout(
 *     fetchData(),
 *     5000 // 5 second timeout
 *   );
 *   console.log('Success:', result);
 * } catch (error) {
 *   if (error instanceof TimeoutError) {
 *     console.error('Operation timed out');
 *   }
 * }
 * ```
 */
export async function executeWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  // Validate timeout
  if (timeoutMs <= 0) {
    throw new Error(`Invalid timeout: ${timeoutMs}ms. Must be positive.`);
  }

  const timeoutPromise = createTimeoutPromise(timeoutMs);
  return Promise.race([promise, timeoutPromise]);
}
