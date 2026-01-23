/**
 * Unit tests for ViolationCounter (sliding window for circuit breaker)
 */

import { ViolationCounter } from '../../../src/security/violation-counter';

describe('ViolationCounter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create counter with default 60-second window', () => {
      const counter = new ViolationCounter();
      expect(counter).toBeDefined();
    });

    it('should create counter with custom window size', () => {
      const counter = new ViolationCounter(120);
      expect(counter).toBeDefined();
    });

    it('should throw error for zero window size', () => {
      expect(() => new ViolationCounter(0)).toThrow(
        'Violation counter window size must be positive'
      );
    });

    it('should throw error for negative window size', () => {
      expect(() => new ViolationCounter(-10)).toThrow(
        'Violation counter window size must be positive'
      );
    });
  });

  describe('increment', () => {
    it('should increment violation count for new peer', () => {
      const counter = new ViolationCounter(60);
      const count = counter.increment('peer-a');
      expect(count).toBe(1);
    });

    it('should increment existing peer violation count', () => {
      const counter = new ViolationCounter(60);
      counter.increment('peer-a');
      counter.increment('peer-a');
      const count = counter.increment('peer-a');
      expect(count).toBe(3);
    });

    it('should track violations separately per peer', () => {
      const counter = new ViolationCounter(60);
      counter.increment('peer-a');
      counter.increment('peer-a');
      counter.increment('peer-b');

      expect(counter.getCount('peer-a')).toBe(2);
      expect(counter.getCount('peer-b')).toBe(1);
    });

    it('should reset count when window expires', async () => {
      const counter = new ViolationCounter(1); // 1-second window
      counter.increment('peer-a');
      expect(counter.getCount('peer-a')).toBe(1);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const count = counter.increment('peer-a');
      expect(count).toBe(1); // New window
    });

    it('should maintain count within same window', () => {
      const counter = new ViolationCounter(60);
      for (let i = 1; i <= 100; i++) {
        const count = counter.increment('peer-a');
        expect(count).toBe(i);
      }
    });
  });

  describe('getCount', () => {
    it('should return 0 for unknown peer', () => {
      const counter = new ViolationCounter(60);
      expect(counter.getCount('unknown-peer')).toBe(0);
    });

    it('should return current count for tracked peer', () => {
      const counter = new ViolationCounter(60);
      counter.increment('peer-a');
      counter.increment('peer-a');
      expect(counter.getCount('peer-a')).toBe(2);
    });

    it('should return 0 after window expires', async () => {
      const counter = new ViolationCounter(1); // 1-second window
      counter.increment('peer-a');
      expect(counter.getCount('peer-a')).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(counter.getCount('peer-a')).toBe(0);
    });

    it('should not modify count when called', () => {
      const counter = new ViolationCounter(60);
      counter.increment('peer-a');
      counter.increment('peer-a');
      expect(counter.getCount('peer-a')).toBe(2);
      expect(counter.getCount('peer-a')).toBe(2); // Still 2
    });
  });

  describe('reset', () => {
    it('should reset violations for specified peer', () => {
      const counter = new ViolationCounter(60);
      counter.increment('peer-a');
      counter.increment('peer-a');
      expect(counter.getCount('peer-a')).toBe(2);

      counter.reset('peer-a');
      expect(counter.getCount('peer-a')).toBe(0);
    });

    it('should not affect other peers when resetting', () => {
      const counter = new ViolationCounter(60);
      counter.increment('peer-a');
      counter.increment('peer-b');
      counter.increment('peer-b');

      counter.reset('peer-a');

      expect(counter.getCount('peer-a')).toBe(0);
      expect(counter.getCount('peer-b')).toBe(2);
    });

    it('should handle reset of unknown peer', () => {
      const counter = new ViolationCounter(60);
      expect(() => counter.reset('unknown-peer')).not.toThrow();
    });
  });

  describe('cleanup', () => {
    it('should remove expired violation records', async () => {
      const counter = new ViolationCounter(1); // 1-second window
      counter.increment('peer-a');
      counter.increment('peer-b');

      await new Promise((resolve) => setTimeout(resolve, 1100));

      counter.cleanup();
      expect(counter.getCount('peer-a')).toBe(0);
      expect(counter.getCount('peer-b')).toBe(0);
    });

    it('should not remove active violation records', async () => {
      const counter = new ViolationCounter(5); // 5-second window
      counter.increment('peer-a');

      await new Promise((resolve) => setTimeout(resolve, 1000));

      counter.cleanup();
      expect(counter.getCount('peer-a')).toBe(1); // Still active
    });

    it('should handle cleanup with no violations', () => {
      const counter = new ViolationCounter(60);
      expect(() => counter.cleanup()).not.toThrow();
    });
  });

  describe('getActivePeers', () => {
    it('should return empty array when no violations', () => {
      const counter = new ViolationCounter(60);
      expect(counter.getActivePeers()).toEqual([]);
    });

    it('should return peers with active violations', () => {
      const counter = new ViolationCounter(60);
      counter.increment('peer-a');
      counter.increment('peer-b');
      counter.increment('peer-c');

      const active = counter.getActivePeers();
      expect(active).toHaveLength(3);
      expect(active).toContain('peer-a');
      expect(active).toContain('peer-b');
      expect(active).toContain('peer-c');
    });

    it('should not return peers with expired violations', async () => {
      const counter = new ViolationCounter(1); // 1-second window
      counter.increment('peer-a');
      counter.increment('peer-b');

      await new Promise((resolve) => setTimeout(resolve, 1100));

      const active = counter.getActivePeers();
      expect(active).toEqual([]);
    });

    it('should return only non-expired peers', async () => {
      const counter = new ViolationCounter(2); // 2-second window
      counter.increment('peer-a');

      await new Promise((resolve) => setTimeout(resolve, 1000));

      counter.increment('peer-b'); // Fresh violation

      await new Promise((resolve) => setTimeout(resolve, 1100));

      // peer-a expired, peer-b still active
      const active = counter.getActivePeers();
      expect(active).toEqual(['peer-b']);
    });
  });

  describe('sliding window behavior', () => {
    it('should maintain count across multiple increments in window', () => {
      const counter = new ViolationCounter(5);
      const counts: number[] = [];

      for (let i = 0; i < 10; i++) {
        counts.push(counter.increment('peer-a'));
      }

      expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('should reset count only after full window expires', async () => {
      const counter = new ViolationCounter(2);
      counter.increment('peer-a');
      expect(counter.getCount('peer-a')).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(counter.getCount('peer-a')).toBe(1); // Still within window

      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(counter.getCount('peer-a')).toBe(0); // Window expired
    });

    it('should start new window after expiration', async () => {
      const counter = new ViolationCounter(1);
      counter.increment('peer-a');
      counter.increment('peer-a');
      expect(counter.getCount('peer-a')).toBe(2);

      await new Promise((resolve) => setTimeout(resolve, 1100));

      // New window starts
      const count = counter.increment('peer-a');
      expect(count).toBe(1);
    });
  });

  describe('high-volume scenarios', () => {
    it('should handle many violations in short time', () => {
      const counter = new ViolationCounter(60);
      for (let i = 0; i < 1000; i++) {
        counter.increment('peer-a');
      }
      expect(counter.getCount('peer-a')).toBe(1000);
    });

    it('should handle many concurrent peers', () => {
      const counter = new ViolationCounter(60);
      for (let i = 0; i < 100; i++) {
        counter.increment(`peer-${i}`);
      }

      expect(counter.getActivePeers()).toHaveLength(100);

      for (let i = 0; i < 100; i++) {
        expect(counter.getCount(`peer-${i}`)).toBe(1);
      }
    });

    it('should handle rapid increment/reset cycles', () => {
      const counter = new ViolationCounter(60);
      for (let i = 0; i < 10; i++) {
        counter.increment('peer-a');
        counter.reset('peer-a');
      }
      expect(counter.getCount('peer-a')).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle very short window (1 second)', async () => {
      const counter = new ViolationCounter(1);
      counter.increment('peer-a');
      expect(counter.getCount('peer-a')).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(counter.getCount('peer-a')).toBe(0);
    });

    it('should handle very long window (1 hour)', () => {
      const counter = new ViolationCounter(3600);
      counter.increment('peer-a');
      expect(counter.getCount('peer-a')).toBe(1);
    });

    it('should handle empty peer ID', () => {
      const counter = new ViolationCounter(60);
      counter.increment('');
      expect(counter.getCount('')).toBe(1);
    });

    it('should handle special characters in peer ID', () => {
      const counter = new ViolationCounter(60);
      const peerId = 'peer-with-special-chars-!@#$%^&*()';
      counter.increment(peerId);
      expect(counter.getCount(peerId)).toBe(1);
    });
  });
});
