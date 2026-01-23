/**
 * Unit tests for TelemetryBuffer
 *
 * Tests batching logic, size-based flushing, time-based flushing, error handling,
 * event ordering preservation, and metrics collection using mocked flush function.
 */

import {
  TelemetryBuffer,
  TelemetryBufferConfig,
  TelemetryEvent,
} from '../../../src/telemetry/telemetry-buffer';
import { Logger } from 'pino';

describe('TelemetryBuffer', () => {
  let mockLogger: jest.Mocked<Logger>;
  let mockFlushFn: jest.Mock;
  let telemetryBuffer: TelemetryBuffer;
  let config: TelemetryBufferConfig;

  beforeEach(() => {
    // Create mock logger
    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
      child: jest.fn().mockReturnThis(),
    } as unknown as jest.Mocked<Logger>;

    // Create mock flush function
    mockFlushFn = jest.fn();

    // Default config
    config = {
      bufferSize: 1000,
      flushIntervalMs: 100,
    };

    // Create telemetry buffer instance
    telemetryBuffer = new TelemetryBuffer(config, mockFlushFn, mockLogger);
  });

  afterEach(() => {
    // Shutdown buffer to clear timers
    telemetryBuffer.shutdown();
    jest.clearAllMocks();
  });

  const createMockEvent = (id: number): TelemetryEvent => ({
    eventType: 'packet.forwarded',
    timestamp: Date.now(),
    data: {
      packetId: `packet-${id}`,
      amount: 100,
      destination: 'test.alice',
    },
  });

  describe('Initialization', () => {
    it('should initialize telemetry buffer with config', () => {
      expect(mockLogger.child).toHaveBeenCalledWith({ component: 'telemetry-buffer' });
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          bufferSize: 1000,
          flushIntervalMs: 100,
        }),
        'TelemetryBuffer initialized'
      );
    });

    it('should start with empty buffer and zero stats', () => {
      const stats = telemetryBuffer.getStats();

      expect(stats).toEqual({
        pendingEvents: 0,
        totalEventsFlushed: 0,
        totalFlushes: 0,
        isFlushing: false,
      });
    });
  });

  describe('Size-based flushing', () => {
    it('should flush when buffer size (1000 events) is reached', () => {
      // Add 1000 events (should trigger flush)
      for (let i = 0; i < 1000; i++) {
        telemetryBuffer.addEvent(createMockEvent(i));
      }

      // Verify flush was called with 1000 events
      expect(mockFlushFn).toHaveBeenCalledTimes(1);
      expect(mockFlushFn).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ eventType: 'packet.forwarded' })])
      );
      expect(mockFlushFn.mock.calls[0][0]).toHaveLength(1000);

      // Verify stats
      const stats = telemetryBuffer.getStats();
      expect(stats.totalEventsFlushed).toBe(1000);
      expect(stats.totalFlushes).toBe(1);
      expect(stats.pendingEvents).toBe(0);
    });

    it('should flush multiple batches when adding >1000 events', () => {
      // Add 2500 events (should trigger 2 full batches + 500 pending)
      for (let i = 0; i < 2500; i++) {
        telemetryBuffer.addEvent(createMockEvent(i));
      }

      // Verify 2 batches flushed
      expect(mockFlushFn).toHaveBeenCalledTimes(2);
      expect(mockFlushFn.mock.calls[0][0]).toHaveLength(1000);
      expect(mockFlushFn.mock.calls[1][0]).toHaveLength(1000);

      // Verify stats
      const stats = telemetryBuffer.getStats();
      expect(stats.totalEventsFlushed).toBe(2000);
      expect(stats.totalFlushes).toBe(2);
      expect(stats.pendingEvents).toBe(500);
    });

    it('should batch multiple events added at once', () => {
      const events = Array.from({ length: 1000 }, (_, i) => createMockEvent(i));

      telemetryBuffer.addEvents(events);

      expect(mockFlushFn).toHaveBeenCalledTimes(1);
      expect(mockFlushFn.mock.calls[0][0]).toHaveLength(1000);
    });

    it('should handle addEvents with multiple batches', () => {
      const events = Array.from({ length: 2500 }, (_, i) => createMockEvent(i));

      telemetryBuffer.addEvents(events);

      expect(mockFlushFn).toHaveBeenCalledTimes(2);
      expect(mockFlushFn.mock.calls[0][0]).toHaveLength(1000);
      expect(mockFlushFn.mock.calls[1][0]).toHaveLength(1000);

      const stats = telemetryBuffer.getStats();
      expect(stats.pendingEvents).toBe(500);
    });
  });

  describe('Time-based flushing', () => {
    it('should flush after 100ms interval even if buffer not full', async () => {
      // Add only 100 events (less than buffer size)
      for (let i = 0; i < 100; i++) {
        telemetryBuffer.addEvent(createMockEvent(i));
      }

      // Wait for periodic flush timer (100ms + buffer)
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Verify flush was called with 100 events
      expect(mockFlushFn).toHaveBeenCalledTimes(1);
      expect(mockFlushFn.mock.calls[0][0]).toHaveLength(100);

      // Verify stats
      const stats = telemetryBuffer.getStats();
      expect(stats.totalEventsFlushed).toBe(100);
      expect(stats.totalFlushes).toBe(1);
      expect(stats.pendingEvents).toBe(0);
    });

    it('should flush periodically with multiple intervals', async () => {
      // Add 100 events, wait for flush
      for (let i = 0; i < 100; i++) {
        telemetryBuffer.addEvent(createMockEvent(i));
      }

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(mockFlushFn).toHaveBeenCalledTimes(1);

      // Add 100 more events, wait for another flush
      for (let i = 100; i < 200; i++) {
        telemetryBuffer.addEvent(createMockEvent(i));
      }

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(mockFlushFn).toHaveBeenCalledTimes(2);

      const stats = telemetryBuffer.getStats();
      expect(stats.totalEventsFlushed).toBe(200);
      expect(stats.totalFlushes).toBe(2);
    });

    it('should not flush if buffer is empty during periodic interval', async () => {
      // Wait for multiple intervals without adding events
      await new Promise((resolve) => setTimeout(resolve, 300));

      // No flush should occur
      expect(mockFlushFn).not.toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('should re-queue failed events on flush error', () => {
      // Mock flush function to throw error
      mockFlushFn.mockImplementationOnce(() => {
        throw new Error('Logger connection error');
      });

      // Add events and manually flush
      const events = Array.from({ length: 100 }, (_, i) => createMockEvent(i));
      telemetryBuffer.addEvents(events);
      telemetryBuffer.flush();

      // Flush should be called
      expect(mockFlushFn).toHaveBeenCalledTimes(1);

      // Verify events were re-queued
      const stats = telemetryBuffer.getStats();
      expect(stats.pendingEvents).toBe(100);
      expect(stats.totalEventsFlushed).toBe(0);

      // Verify error was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Logger connection error',
          batchSize: 100,
        }),
        'Error flushing telemetry batch'
      );
    });

    it('should emit flush-error event on flush failure', () => {
      mockFlushFn.mockImplementationOnce(() => {
        throw new Error('Flush error');
      });

      const errorListener = jest.fn();
      telemetryBuffer.on('flush-error', errorListener);

      telemetryBuffer.addEvent(createMockEvent(1));
      telemetryBuffer.flush();

      // Verify error event was emitted
      expect(errorListener).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should emit batch-flushed event on successful flush', () => {
      const flushListener = jest.fn();
      telemetryBuffer.on('batch-flushed', flushListener);

      const events = Array.from({ length: 100 }, (_, i) => createMockEvent(i));
      telemetryBuffer.addEvents(events);
      telemetryBuffer.flush();

      // Verify batch-flushed event was emitted
      expect(flushListener).toHaveBeenCalledWith(
        expect.objectContaining({
          eventCount: 100,
          timestamp: expect.any(Number),
        })
      );
    });

    it('should handle errors in periodic flush gracefully', async () => {
      // Mock flush function to throw error on first call, succeed on second
      mockFlushFn
        .mockImplementationOnce(() => {
          throw new Error('Periodic flush error');
        })
        .mockImplementationOnce(() => {});

      // Add events
      telemetryBuffer.addEvent(createMockEvent(1));

      // Wait for periodic flush (should handle error gracefully)
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Verify error was logged but didn't crash
      // The error comes from the flush() method, not the periodic timer wrapper
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Periodic flush error' }),
        'Error flushing telemetry batch'
      );

      // Error was handled gracefully (no crash)
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('Event ordering preservation', () => {
    it('should preserve event order in flush', () => {
      const events = [
        { eventType: 'event-1', timestamp: 1000, data: { id: 1 } },
        { eventType: 'event-2', timestamp: 2000, data: { id: 2 } },
        { eventType: 'event-3', timestamp: 3000, data: { id: 3 } },
      ];

      telemetryBuffer.addEvents(events);
      telemetryBuffer.flush();

      // Verify events were flushed in order
      expect(mockFlushFn).toHaveBeenCalledWith([
        expect.objectContaining({ eventType: 'event-1', data: { id: 1 } }),
        expect.objectContaining({ eventType: 'event-2', data: { id: 2 } }),
        expect.objectContaining({ eventType: 'event-3', data: { id: 3 } }),
      ]);
    });

    it('should maintain order across multiple addEvent calls', () => {
      telemetryBuffer.addEvent({ eventType: 'event-1', timestamp: 1000, data: { id: 1 } });
      telemetryBuffer.addEvent({ eventType: 'event-2', timestamp: 2000, data: { id: 2 } });
      telemetryBuffer.addEvent({ eventType: 'event-3', timestamp: 3000, data: { id: 3 } });

      telemetryBuffer.flush();

      const flushedEvents = mockFlushFn.mock.calls[0][0];
      expect(flushedEvents[0]).toMatchObject({ eventType: 'event-1' });
      expect(flushedEvents[1]).toMatchObject({ eventType: 'event-2' });
      expect(flushedEvents[2]).toMatchObject({ eventType: 'event-3' });
    });

    it('should maintain order after re-queueing failed events', () => {
      // First flush fails
      mockFlushFn.mockImplementationOnce(() => {
        throw new Error('Flush error');
      });

      telemetryBuffer.addEvent({ eventType: 'event-1', timestamp: 1000, data: { id: 1 } });
      telemetryBuffer.addEvent({ eventType: 'event-2', timestamp: 2000, data: { id: 2 } });
      telemetryBuffer.flush();

      // Second flush succeeds
      mockFlushFn.mockImplementationOnce(() => {});
      telemetryBuffer.flush();

      // Events should still be in order
      const flushedEvents = mockFlushFn.mock.calls[1][0];
      expect(flushedEvents[0]).toMatchObject({ eventType: 'event-1' });
      expect(flushedEvents[1]).toMatchObject({ eventType: 'event-2' });
    });
  });

  describe('Buffer management', () => {
    it('should prevent concurrent flushes', () => {
      // Add events
      const events = Array.from({ length: 500 }, (_, i) => createMockEvent(i));
      telemetryBuffer.addEvents(events);

      // Call flush multiple times
      telemetryBuffer.flush();
      telemetryBuffer.flush();
      telemetryBuffer.flush();

      // Only one flush should occur
      expect(mockFlushFn).toHaveBeenCalledTimes(1);
    });

    it('should return early from flush when buffer is empty', () => {
      telemetryBuffer.flush();

      expect(mockFlushFn).not.toHaveBeenCalled();
    });

    it('should handle edge case of exactly buffer size events', () => {
      const events = Array.from({ length: 1000 }, (_, i) => createMockEvent(i));

      telemetryBuffer.addEvents(events);

      expect(mockFlushFn).toHaveBeenCalledTimes(1);
      expect(mockFlushFn.mock.calls[0][0]).toHaveLength(1000);

      const stats = telemetryBuffer.getStats();
      expect(stats.pendingEvents).toBe(0);
    });
  });

  describe('Metrics and statistics', () => {
    it('should track total events flushed', () => {
      // Add 2500 events (2 full batches + 500 pending)
      for (let i = 0; i < 2500; i++) {
        telemetryBuffer.addEvent(createMockEvent(i));
      }

      const stats = telemetryBuffer.getStats();
      expect(stats.totalEventsFlushed).toBeGreaterThanOrEqual(2000);
      expect(stats.totalFlushes).toBeGreaterThanOrEqual(2);
    });

    it('should track isFlushing state', () => {
      // Mock flush function that throws to keep isFlushing true during processing
      let callCount = 0;
      mockFlushFn.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // During first call, check isFlushing is true
          const statsDuringFlush = telemetryBuffer.getStats();
          expect(statsDuringFlush.isFlushing).toBe(true);
        }
      });

      // Add events and trigger flush
      const events = Array.from({ length: 1000 }, (_, i) => createMockEvent(i));
      telemetryBuffer.addEvents(events);

      // After flush completes, isFlushing should be false
      const statsAfterFlush = telemetryBuffer.getStats();
      expect(statsAfterFlush.isFlushing).toBe(false);
    });

    it('should provide pending event count via getPendingCount', () => {
      expect(telemetryBuffer.getPendingCount()).toBe(0);

      telemetryBuffer.addEvent(createMockEvent(1));
      expect(telemetryBuffer.getPendingCount()).toBe(1);

      telemetryBuffer.addEvent(createMockEvent(2));
      expect(telemetryBuffer.getPendingCount()).toBe(2);
    });

    it('should reset pending count after flush', () => {
      const events = Array.from({ length: 1000 }, (_, i) => createMockEvent(i));
      telemetryBuffer.addEvents(events);

      expect(telemetryBuffer.getPendingCount()).toBe(0);
    });
  });

  describe('Shutdown', () => {
    it('should flush remaining events on shutdown', () => {
      // Add 500 events (less than buffer size)
      const events = Array.from({ length: 500 }, (_, i) => createMockEvent(i));
      telemetryBuffer.addEvents(events);

      // Shutdown should flush remaining events
      telemetryBuffer.shutdown();

      expect(mockFlushFn).toHaveBeenCalledTimes(1);
      expect(mockFlushFn.mock.calls[0][0]).toHaveLength(500);

      expect(mockLogger.info).toHaveBeenCalledWith('Shutting down TelemetryBuffer');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          totalEventsFlushed: 500,
          totalFlushes: 1,
        }),
        'TelemetryBuffer shutdown complete'
      );
    });

    it('should stop periodic flush timer on shutdown', async () => {
      telemetryBuffer.shutdown();

      // Add event after shutdown
      telemetryBuffer.addEvent(createMockEvent(1));

      // Wait for what would be flush interval
      await new Promise((resolve) => setTimeout(resolve, 150));

      // No automatic flush should occur (timer stopped)
      expect(mockFlushFn).not.toHaveBeenCalled();
    });

    it('should handle errors during shutdown flush gracefully', () => {
      mockFlushFn.mockImplementationOnce(() => {
        throw new Error('Shutdown error');
      });

      telemetryBuffer.addEvent(createMockEvent(1));

      telemetryBuffer.shutdown();

      // Error should be logged but shutdown completes
      // The error comes from the flush() method
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Shutdown error' }),
        'Error flushing telemetry batch'
      );
    });

    it('should flush all pending events in multiple batches on shutdown', () => {
      // Add 2500 events
      const events = Array.from({ length: 2500 }, (_, i) => createMockEvent(i));
      telemetryBuffer.addEvents(events);

      telemetryBuffer.shutdown();

      // Should flush all 2500 events in 3 batches (1000, 1000, 500)
      expect(mockFlushFn).toHaveBeenCalledTimes(3);
      expect(telemetryBuffer.getPendingCount()).toBe(0);
    });
  });
});
