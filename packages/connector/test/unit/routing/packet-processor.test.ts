/* eslint-disable @typescript-eslint/no-explicit-any */
import pino from 'pino';
import { PacketProcessor } from '../../../src/routing/packet-processor';
import { WorkerPool } from '../../../src/routing/worker-pool';

// Mock WorkerPool
jest.mock('../../../src/routing/worker-pool');

describe('PacketProcessor', () => {
  let logger: pino.Logger;
  let packetProcessor: PacketProcessor;
  let mockWorkerPool: jest.Mocked<WorkerPool>;

  beforeEach(() => {
    logger = pino({ level: 'silent' });

    // Reset mocks
    jest.clearAllMocks();

    // Create mock WorkerPool instance
    mockWorkerPool = {
      initialize: jest.fn().mockResolvedValue(undefined),
      execute: jest.fn(),
      shutdown: jest.fn().mockResolvedValue(undefined),
      getStats: jest.fn().mockReturnValue({
        totalWorkers: 4,
        busyWorkers: 0,
        queuedTasks: 0,
        pendingTasks: 0,
        totalTasksProcessed: 0,
      }),
      isBusy: jest.fn().mockReturnValue(false),
      getQueueSize: jest.fn().mockReturnValue(0),
    } as any;

    (WorkerPool as jest.MockedClass<typeof WorkerPool>).mockImplementation(() => mockWorkerPool);
  });

  afterEach(async () => {
    if (packetProcessor) {
      await packetProcessor.shutdown();
    }
  });

  describe('Initialization', () => {
    it('should initialize with parallel processing enabled', async () => {
      packetProcessor = new PacketProcessor(
        {
          workerThreads: 4,
          batchSize: 100,
          enableParallelProcessing: true,
        },
        logger
      );

      await packetProcessor.initialize();

      expect(WorkerPool).toHaveBeenCalledTimes(1);
      expect(mockWorkerPool.initialize).toHaveBeenCalled();
    });

    it('should skip worker pool initialization when parallel processing is disabled', async () => {
      packetProcessor = new PacketProcessor(
        {
          workerThreads: 4,
          batchSize: 100,
          enableParallelProcessing: false,
        },
        logger
      );

      await packetProcessor.initialize();

      expect(WorkerPool).not.toHaveBeenCalled();
    });

    it('should use default configuration values', async () => {
      packetProcessor = new PacketProcessor({}, logger);

      const stats = packetProcessor.getStats();
      expect(stats.parallelProcessingEnabled).toBe(true);
      expect(stats.configuredWorkerThreads).toBeGreaterThan(0);
      expect(stats.configuredBatchSize).toBe(100);
    });
  });

  describe('Batch Processing - Parallel Mode', () => {
    beforeEach(async () => {
      packetProcessor = new PacketProcessor(
        {
          workerThreads: 4,
          batchSize: 100,
          enableParallelProcessing: true,
        },
        logger
      );

      await packetProcessor.initialize();
    });

    it('should process batch using worker pool', async () => {
      const testPackets = [Buffer.from('packet1'), Buffer.from('packet2'), Buffer.from('packet3')];

      mockWorkerPool.execute.mockResolvedValue({
        processedPackets: testPackets,
      });

      const result = await packetProcessor.processBatch(testPackets);

      expect(mockWorkerPool.execute).toHaveBeenCalledWith({
        packets: testPackets,
      });
      expect(result.processedPackets).toEqual(testPackets);
      expect(result.batchId).toMatch(/^batch-\d+$/);
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should handle worker pool errors', async () => {
      const testPackets = [Buffer.from('packet1')];

      mockWorkerPool.execute.mockRejectedValue(new Error('Worker pool error'));

      await expect(packetProcessor.processBatch(testPackets)).rejects.toThrow('Worker pool error');
    });

    it('should process multiple batches sequentially', async () => {
      const batch1 = [Buffer.from('packet1')];
      const batch2 = [Buffer.from('packet2')];

      mockWorkerPool.execute
        .mockResolvedValueOnce({ processedPackets: batch1 })
        .mockResolvedValueOnce({ processedPackets: batch2 });

      const result1 = await packetProcessor.processBatch(batch1);
      const result2 = await packetProcessor.processBatch(batch2);

      expect(result1.processedPackets).toEqual(batch1);
      expect(result2.processedPackets).toEqual(batch2);
      expect(result1.batchId).not.toBe(result2.batchId);
    });
  });

  describe('Batch Processing - Synchronous Mode', () => {
    beforeEach(async () => {
      packetProcessor = new PacketProcessor(
        {
          workerThreads: 4,
          batchSize: 100,
          enableParallelProcessing: false,
        },
        logger
      );

      await packetProcessor.initialize();
    });

    it('should process batch synchronously when parallel processing is disabled', async () => {
      const testPackets = [Buffer.from('packet1'), Buffer.from('packet2')];

      const result = await packetProcessor.processBatch(testPackets);

      expect(mockWorkerPool.execute).not.toHaveBeenCalled();
      expect(result.processedPackets).toHaveLength(testPackets.length);
      expect(result.batchId).toMatch(/^batch-\d+$/);
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should copy packet buffers in synchronous mode', async () => {
      const originalPacket = Buffer.from('test-packet');
      const result = await packetProcessor.processBatch([originalPacket]);

      expect(result.processedPackets).toHaveLength(1);
      expect(result.processedPackets[0]).toEqual(originalPacket);
      expect(result.processedPackets[0]).not.toBe(originalPacket); // Different buffer instance
    });
  });

  describe('Single Packet Processing', () => {
    beforeEach(async () => {
      packetProcessor = new PacketProcessor(
        {
          enableParallelProcessing: true,
        },
        logger
      );

      await packetProcessor.initialize();
    });

    it('should process single packet', async () => {
      const testPacket = Buffer.from('single-packet');

      mockWorkerPool.execute.mockResolvedValue({
        processedPackets: [testPacket],
      });

      const result = await packetProcessor.processPacket(testPacket);

      expect(result).toEqual(testPacket);
    });
  });

  describe('Statistics', () => {
    beforeEach(async () => {
      packetProcessor = new PacketProcessor(
        {
          workerThreads: 4,
          batchSize: 100,
          enableParallelProcessing: true,
        },
        logger
      );

      await packetProcessor.initialize();
    });

    it('should return processor statistics', () => {
      const stats = packetProcessor.getStats();

      expect(stats.parallelProcessingEnabled).toBe(true);
      expect(stats.configuredWorkerThreads).toBe(4);
      expect(stats.configuredBatchSize).toBe(100);
      expect(stats.workerPoolStats).toBeDefined();
      expect(stats.workerPoolStats?.totalWorkers).toBe(4);
    });

    it('should return isBusy status from worker pool', () => {
      mockWorkerPool.isBusy.mockReturnValue(true);
      expect(packetProcessor.isBusy()).toBe(true);

      mockWorkerPool.isBusy.mockReturnValue(false);
      expect(packetProcessor.isBusy()).toBe(false);
    });

    it('should return false for isBusy when parallel processing is disabled', async () => {
      const syncProcessor = new PacketProcessor(
        {
          enableParallelProcessing: false,
        },
        logger
      );

      await syncProcessor.initialize();

      expect(syncProcessor.isBusy()).toBe(false);

      await syncProcessor.shutdown();
    });
  });

  describe('Shutdown', () => {
    beforeEach(async () => {
      packetProcessor = new PacketProcessor(
        {
          workerThreads: 4,
          enableParallelProcessing: true,
        },
        logger
      );

      await packetProcessor.initialize();
    });

    it('should shutdown worker pool', async () => {
      await packetProcessor.shutdown();

      expect(mockWorkerPool.shutdown).toHaveBeenCalled();
    });

    it('should handle shutdown when parallel processing is disabled', async () => {
      const syncProcessor = new PacketProcessor(
        {
          enableParallelProcessing: false,
        },
        logger
      );

      await syncProcessor.initialize();
      await syncProcessor.shutdown();

      // Should not throw error
      expect(mockWorkerPool.shutdown).not.toHaveBeenCalled();
    });
  });
});
