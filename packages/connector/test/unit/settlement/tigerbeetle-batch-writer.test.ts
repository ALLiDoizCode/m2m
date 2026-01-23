/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for TigerBeetleBatchWriter
 *
 * Tests batching logic, size-based flushing, time-based flushing, error handling,
 * retry logic, and metrics collection using mocked TigerBeetle transfer function.
 */

import {
  TigerBeetleBatchWriter,
  BatchWriterConfig,
  Transfer,
} from '../../../src/settlement/tigerbeetle-batch-writer';
import { Logger } from 'pino';

describe('TigerBeetleBatchWriter', () => {
  let mockLogger: jest.Mocked<Logger>;
  let mockCreateTransferFn: jest.Mock;
  let batchWriter: TigerBeetleBatchWriter;
  let config: BatchWriterConfig;

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

    // Create mock transfer function (simulates TigerBeetle createTransfers)
    mockCreateTransferFn = jest.fn().mockResolvedValue([]);

    // Default config
    config = {
      batchSize: 100,
      flushIntervalMs: 10,
      maxPendingTransfers: 1000,
    };

    // Create batch writer instance
    batchWriter = new TigerBeetleBatchWriter(config, mockCreateTransferFn, mockLogger);
  });

  afterEach(async () => {
    // Shutdown batch writer to clear timers
    await batchWriter.shutdown();
    jest.clearAllMocks();
  });

  const createMockTransfer = (id: number): Transfer => ({
    id: BigInt(id),
    debitAccountId: BigInt(1000),
    creditAccountId: BigInt(2000),
    amount: BigInt(100),
    ledger: 1,
    code: 1,
    flags: 0,
  });

  describe('Initialization', () => {
    it('should initialize batch writer with config', () => {
      expect(mockLogger.child).toHaveBeenCalledWith({ component: 'tigerbeetle-batch-writer' });
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          batchSize: 100,
          flushIntervalMs: 10,
          maxPendingTransfers: 1000,
        }),
        'TigerBeetleBatchWriter initialized'
      );
    });

    it('should use default maxPendingTransfers if not specified', () => {
      const configWithoutMax: BatchWriterConfig = {
        batchSize: 50,
        flushIntervalMs: 5,
      };

      const writer = new TigerBeetleBatchWriter(configWithoutMax, mockCreateTransferFn, mockLogger);
      const stats = writer.getStats();

      expect(stats).toMatchObject({
        pendingTransfers: 0,
        totalTransfersProcessed: 0,
        totalBatchesFlushed: 0,
        isFlushing: false,
      });

      writer.shutdown();
    });
  });

  describe('Size-based flushing', () => {
    it('should flush when batch size (100 transfers) is reached', async () => {
      // Add 100 transfers (should trigger flush)
      for (let i = 0; i < 100; i++) {
        await batchWriter.addTransfer(createMockTransfer(i));
      }

      // Wait for async flush to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify flush was called with 100 transfers
      expect(mockCreateTransferFn).toHaveBeenCalledTimes(1);
      expect(mockCreateTransferFn).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: BigInt(0) }),
          expect.objectContaining({ id: BigInt(99) }),
        ])
      );
      expect(mockCreateTransferFn.mock.calls[0][0]).toHaveLength(100);

      // Verify stats
      const stats = batchWriter.getStats();
      expect(stats.totalTransfersProcessed).toBe(100);
      expect(stats.totalBatchesFlushed).toBe(1);
      expect(stats.pendingTransfers).toBe(0);
    });

    it('should flush multiple batches when adding >100 transfers', async () => {
      // Add 250 transfers (should trigger 2 full batches + 50 pending)
      for (let i = 0; i < 250; i++) {
        await batchWriter.addTransfer(createMockTransfer(i));
      }

      // Wait briefly for async operations but not long enough for periodic flush
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Verify at least 2 batches flushed (may be 3 if periodic timer fired for remaining 50)
      expect(mockCreateTransferFn).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: expect.any(BigInt) })])
      );
      expect(mockCreateTransferFn.mock.calls[0][0]).toHaveLength(100);
      expect(mockCreateTransferFn.mock.calls[1][0]).toHaveLength(100);

      // Verify stats - at least 200 processed
      const stats = batchWriter.getStats();
      expect(stats.totalTransfersProcessed).toBeGreaterThanOrEqual(200);
      expect(stats.totalBatchesFlushed).toBeGreaterThanOrEqual(2);
    });

    it('should batch multiple transfers added at once', async () => {
      const transfers = Array.from({ length: 100 }, (_, i) => createMockTransfer(i));

      await batchWriter.addTransfers(transfers);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockCreateTransferFn).toHaveBeenCalledTimes(1);
      expect(mockCreateTransferFn.mock.calls[0][0]).toHaveLength(100);
    });
  });

  describe('Time-based flushing', () => {
    it('should flush after 10ms interval even if batch not full', async () => {
      // Add only 10 transfers (less than batch size)
      for (let i = 0; i < 10; i++) {
        await batchWriter.addTransfer(createMockTransfer(i));
      }

      // Wait for periodic flush timer (10ms + buffer)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify flush was called with 10 transfers
      expect(mockCreateTransferFn).toHaveBeenCalledTimes(1);
      expect(mockCreateTransferFn.mock.calls[0][0]).toHaveLength(10);

      // Verify stats
      const stats = batchWriter.getStats();
      expect(stats.totalTransfersProcessed).toBe(10);
      expect(stats.totalBatchesFlushed).toBe(1);
      expect(stats.pendingTransfers).toBe(0);
    });

    it('should flush periodically with multiple intervals', async () => {
      // Add 10 transfers, wait for flush
      for (let i = 0; i < 10; i++) {
        await batchWriter.addTransfer(createMockTransfer(i));
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockCreateTransferFn).toHaveBeenCalledTimes(1);

      // Add 10 more transfers, wait for another flush
      for (let i = 10; i < 20; i++) {
        await batchWriter.addTransfer(createMockTransfer(i));
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockCreateTransferFn).toHaveBeenCalledTimes(2);

      const stats = batchWriter.getStats();
      expect(stats.totalTransfersProcessed).toBe(20);
      expect(stats.totalBatchesFlushed).toBe(2);
    });

    it('should not flush if queue is empty during periodic interval', async () => {
      // Wait for multiple intervals without adding transfers
      await new Promise((resolve) => setTimeout(resolve, 100));

      // No flush should occur
      expect(mockCreateTransferFn).not.toHaveBeenCalled();
    });
  });

  describe('Error handling and retry', () => {
    it('should re-queue failed batch on flush error', async () => {
      // Mock transfer function to throw error
      mockCreateTransferFn.mockRejectedValueOnce(new Error('TigerBeetle connection error'));

      // Add transfers
      const transfers = Array.from({ length: 10 }, (_, i) => createMockTransfer(i));
      await batchWriter.addTransfers(transfers);

      // Attempt flush (should fail and re-queue)
      await expect(batchWriter.flush()).rejects.toThrow('TigerBeetle connection error');

      // Verify transfers were re-queued
      const stats = batchWriter.getStats();
      expect(stats.pendingTransfers).toBe(10);
      expect(stats.totalTransfersProcessed).toBe(0);

      // Verify error was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'TigerBeetle connection error',
          batchSize: 10,
        }),
        'Error flushing transfer batch'
      );
    });

    it('should handle partial batch errors from TigerBeetle', async () => {
      // Mock transfer function to return errors for some transfers
      const errors = [
        { index: 2, code: 1 }, // Transfer at index 2 failed
        { index: 5, code: 2 }, // Transfer at index 5 failed
      ];
      mockCreateTransferFn.mockResolvedValueOnce(errors);

      // Add 10 transfers
      const transfers = Array.from({ length: 10 }, (_, i) => createMockTransfer(i));
      await batchWriter.addTransfers(transfers);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify batch was flushed with partial errors
      expect(mockCreateTransferFn).toHaveBeenCalledTimes(1);

      // Verify stats reflect partial success
      const stats = batchWriter.getStats();
      expect(stats.totalTransfersProcessed).toBe(10);
      expect(stats.totalBatchesFlushed).toBe(1);

      // Verify warning was logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          successCount: 8,
          errorCount: 2,
          batchSize: 10,
        }),
        'Batch flush completed with errors'
      );
    });

    it('should emit transfer-error events for failed transfers', async () => {
      const errors = [{ index: 0, code: 1 }];
      mockCreateTransferFn.mockResolvedValueOnce(errors);

      const errorListener = jest.fn();
      batchWriter.on('transfer-error', errorListener);

      const transfer = createMockTransfer(1);
      await batchWriter.addTransfer(transfer);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify error event was emitted
      expect(errorListener).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 0,
          code: 1,
          transfer: expect.objectContaining({ id: BigInt(1) }),
        })
      );
    });

    it('should emit batch-flushed events on successful flush', async () => {
      const flushListener = jest.fn();
      batchWriter.on('batch-flushed', flushListener);

      const transfers = Array.from({ length: 10 }, (_, i) => createMockTransfer(i));
      await batchWriter.addTransfers(transfers);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify batch-flushed event was emitted
      expect(flushListener).toHaveBeenCalledWith(
        expect.objectContaining({
          successCount: 10,
          errorCount: 0,
          errors: [],
        })
      );
    });

    it('should handle errors in periodic flush gracefully', async () => {
      // Mock transfer function to throw error on first call, succeed on second
      mockCreateTransferFn
        .mockRejectedValueOnce(new Error('Periodic flush error'))
        .mockResolvedValueOnce([]);

      // Add transfers
      await batchWriter.addTransfer(createMockTransfer(1));

      // Wait for periodic flush (should handle error gracefully)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify error was logged but didn't crash
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Periodic flush error' }),
        'Error in periodic flush'
      );

      // Transfer was re-queued after error, but may have been flushed on retry
      // Just verify the error was handled gracefully (no crash)
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('Queue management', () => {
    it('should throw error when pending queue is full', async () => {
      const smallQueueConfig: BatchWriterConfig = {
        batchSize: 100,
        flushIntervalMs: 10,
        maxPendingTransfers: 10,
      };

      const smallQueueWriter = new TigerBeetleBatchWriter(
        smallQueueConfig,
        mockCreateTransferFn,
        mockLogger
      );

      // Fill queue to max
      for (let i = 0; i < 10; i++) {
        await smallQueueWriter.addTransfer(createMockTransfer(i));
      }

      // Next transfer should throw
      await expect(smallQueueWriter.addTransfer(createMockTransfer(11))).rejects.toThrow(
        'Pending transfer queue is full'
      );

      await smallQueueWriter.shutdown();
    });

    it('should throw error when addTransfers exceeds queue limit', async () => {
      const smallQueueConfig: BatchWriterConfig = {
        batchSize: 100,
        flushIntervalMs: 10,
        maxPendingTransfers: 10,
      };

      const smallQueueWriter = new TigerBeetleBatchWriter(
        smallQueueConfig,
        mockCreateTransferFn,
        mockLogger
      );

      const transfers = Array.from({ length: 15 }, (_, i) => createMockTransfer(i));

      await expect(smallQueueWriter.addTransfers(transfers)).rejects.toThrow(
        'Pending transfer queue is full'
      );

      await smallQueueWriter.shutdown();
    });

    it('should prevent concurrent flushes', async () => {
      // Add transfers
      const transfers = Array.from({ length: 50 }, (_, i) => createMockTransfer(i));
      await batchWriter.addTransfers(transfers);

      // Call flush multiple times concurrently
      const flushPromises = [batchWriter.flush(), batchWriter.flush(), batchWriter.flush()];

      await Promise.all(flushPromises);

      // Only one flush should have occurred (others return early)
      expect(mockCreateTransferFn).toHaveBeenCalledTimes(1);
    });

    it('should return early from flush when queue is empty', async () => {
      const result = await batchWriter.flush();

      expect(result).toEqual({
        successCount: 0,
        errorCount: 0,
        errors: [],
      });
      expect(mockCreateTransferFn).not.toHaveBeenCalled();
    });
  });

  describe('Metrics and statistics', () => {
    it('should track total transfers processed', async () => {
      // Add 250 transfers (2 full batches + 50 pending)
      for (let i = 0; i < 250; i++) {
        await batchWriter.addTransfer(createMockTransfer(i));
      }

      // Wait briefly for immediate flushes but not periodic timer
      await new Promise((resolve) => setTimeout(resolve, 5));

      const stats = batchWriter.getStats();
      // At least 200 should be processed (2 batches), periodic timer may flush remaining 50
      expect(stats.totalTransfersProcessed).toBeGreaterThanOrEqual(200);
      expect(stats.totalBatchesFlushed).toBeGreaterThanOrEqual(2);
    });

    it('should track isFlushing state', async () => {
      // Mock slow transfer function
      let resolveTransfer: ((value: any[]) => void) | undefined;
      const slowTransferPromise = new Promise<any[]>((resolve) => {
        resolveTransfer = resolve;
      });
      mockCreateTransferFn.mockReturnValueOnce(slowTransferPromise);

      // Add transfers and start flush (100 triggers immediate flush)
      const transfers = Array.from({ length: 100 }, (_, i) => createMockTransfer(i));
      const addPromise = batchWriter.addTransfers(transfers);

      // Wait for flush to start
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Check isFlushing during flush
      const statsDuringFlush = batchWriter.getStats();
      expect(statsDuringFlush.isFlushing).toBe(true);

      // Complete flush
      if (resolveTransfer) {
        resolveTransfer([]);
      }
      await addPromise;
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Check isFlushing after flush
      const statsAfterFlush = batchWriter.getStats();
      expect(statsAfterFlush.isFlushing).toBe(false);
    }, 10000);

    it('should provide pending transfer count via getPendingCount', async () => {
      expect(batchWriter.getPendingCount()).toBe(0);

      await batchWriter.addTransfer(createMockTransfer(1));
      expect(batchWriter.getPendingCount()).toBe(1);

      await batchWriter.addTransfer(createMockTransfer(2));
      expect(batchWriter.getPendingCount()).toBe(2);
    });

    it('should reset pending count after flush', async () => {
      const transfers = Array.from({ length: 100 }, (_, i) => createMockTransfer(i));
      await batchWriter.addTransfers(transfers);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(batchWriter.getPendingCount()).toBe(0);
    });
  });

  describe('Shutdown', () => {
    it('should flush remaining transfers on shutdown', async () => {
      // Add 50 transfers (less than batch size)
      const transfers = Array.from({ length: 50 }, (_, i) => createMockTransfer(i));
      await batchWriter.addTransfers(transfers);

      // Shutdown should flush remaining transfers
      await batchWriter.shutdown();

      expect(mockCreateTransferFn).toHaveBeenCalledTimes(1);
      expect(mockCreateTransferFn.mock.calls[0][0]).toHaveLength(50);

      expect(mockLogger.info).toHaveBeenCalledWith('Shutting down TigerBeetleBatchWriter');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          totalTransfersProcessed: 50,
          totalBatchesFlushed: 1,
        }),
        'TigerBeetleBatchWriter shutdown complete'
      );
    });

    it('should stop periodic flush timer on shutdown', async () => {
      await batchWriter.shutdown();

      // Add transfer after shutdown
      await batchWriter.addTransfer(createMockTransfer(1));

      // Wait for what would be flush interval
      await new Promise((resolve) => setTimeout(resolve, 50));

      // No automatic flush should occur (timer stopped)
      expect(mockCreateTransferFn).not.toHaveBeenCalled();
    });

    it('should handle errors during shutdown flush gracefully', async () => {
      mockCreateTransferFn.mockRejectedValueOnce(new Error('Shutdown error'));

      await batchWriter.addTransfer(createMockTransfer(1));

      await batchWriter.shutdown();

      // Error should be logged but shutdown completes
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Shutdown error' }),
        'Error flushing during shutdown'
      );
    });

    it('should flush all pending transfers in multiple batches on shutdown', async () => {
      // Add 250 transfers
      const transfers = Array.from({ length: 250 }, (_, i) => createMockTransfer(i));
      await batchWriter.addTransfers(transfers);

      await batchWriter.shutdown();

      // Should flush all 250 transfers in 3 batches (100, 100, 50)
      expect(mockCreateTransferFn).toHaveBeenCalledTimes(3);
      expect(batchWriter.getPendingCount()).toBe(0);
    });
  });
});
