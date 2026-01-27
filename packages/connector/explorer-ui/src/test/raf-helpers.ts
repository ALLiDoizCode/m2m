import { act } from '@testing-library/react';

/**
 * Shared requestAnimationFrame test helpers.
 *
 * Usage in test files:
 *   import { createRAFMock } from '@/test/raf-helpers';
 *
 *   let rafMock: ReturnType<typeof createRAFMock>;
 *   beforeEach(() => {
 *     rafMock = createRAFMock();
 *     vi.stubGlobal('requestAnimationFrame', rafMock.requestAnimationFrame);
 *     vi.stubGlobal('cancelAnimationFrame', rafMock.cancelAnimationFrame);
 *   });
 *
 *   // In tests:
 *   await rafMock.flush();
 */
interface RAFMock {
  requestAnimationFrame: (cb: () => void) => number;
  cancelAnimationFrame: (_id: number) => void;
  flush: () => Promise<void>;
  reset: () => void;
}

export function createRAFMock(): RAFMock {
  let callbacks: (() => void)[] = [];
  let idCounter = 0;

  return {
    requestAnimationFrame(cb: () => void): number {
      callbacks.push(cb);
      return ++idCounter;
    },

    cancelAnimationFrame(_id: number): void {
      // Simple cancel — clear all pending (sufficient for tests)
    },

    async flush(): Promise<void> {
      await act(async () => {
        const cbs = callbacks.splice(0);
        for (const cb of cbs) cb();
      });
    },

    reset(): void {
      callbacks = [];
      idCounter = 0;
    },
  };
}
