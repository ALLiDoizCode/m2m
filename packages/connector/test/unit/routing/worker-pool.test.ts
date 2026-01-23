/* eslint-disable @typescript-eslint/no-explicit-any */
import pino from 'pino';
import { WorkerPool } from '../../../src/routing/worker-pool';
import { Worker } from 'worker_threads';

// Mock worker_threads
jest.mock('worker_threads', () => ({
  Worker: jest.fn(),
}));

describe('WorkerPool', () => {
  let logger: pino.Logger;
  let workerPool: WorkerPool;
  let mockWorkerInstances: any[];

  beforeEach(() => {
    logger = pino({ level: 'silent' });
    mockWorkerInstances = [];

    // Mock Worker constructor
    (Worker as jest.MockedClass<typeof Worker>).mockImplementation((_script: any, options: any) => {
      const mockWorker: any = {
        postMessage: jest.fn(),
        terminate: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
        once: jest.fn(),
        off: jest.fn(),
        removeListener: jest.fn(),
      };

      mockWorkerInstances.push(mockWorker);

      // Simulate ready message after a short delay
      setImmediate(() => {
        const messageHandler = mockWorker.on.mock.calls.find(
          (call: any) => call[0] === 'message'
        )?.[1];
        if (messageHandler) {
          messageHandler({ ready: true, workerId: options.workerData.workerId });
        }
      });

      return mockWorker;
    });

    workerPool = new WorkerPool(
      {
        numWorkers: 2,
        workerScript: '/fake/path/worker.js',
        maxQueueSize: 100,
      },
      logger
    );
  });

  afterEach(async () => {
    // Silence unhandled rejection warnings from pending tasks
    const originalConsoleError = console.error;
    console.error = jest.fn();

    if (workerPool) {
      try {
        await workerPool.shutdown();
      } catch (error) {
        // Ignore shutdown errors in cleanup
      }
    }

    console.error = originalConsoleError;
    jest.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should initialize worker pool with specified number of workers', async () => {
      await workerPool.initialize();

      expect(Worker).toHaveBeenCalledTimes(2);
      const stats = workerPool.getStats();
      expect(stats.totalWorkers).toBe(2);
    });

    it('should throw error if already initialized', async () => {
      await workerPool.initialize();
      await expect(workerPool.initialize()).rejects.toThrow('WorkerPool already initialized');
    });
  });

  describe('Task Execution', () => {
    beforeEach(async () => {
      await workerPool.initialize();
    });

    it('should execute task and return result', async () => {
      const testData = { value: 42 };
      const expectedResult = { taskId: 'task-0', result: 84 };

      // Simulate worker response
      const executePromise = workerPool.execute(testData);

      // Find the message handler and simulate worker response
      const worker = mockWorkerInstances[0];
      const messageHandler = worker.on.mock.calls.find((call: any) => call[0] === 'message')?.[1];

      setImmediate(() => {
        messageHandler(expectedResult);
      });

      const result = await executePromise;
      expect(result).toEqual(expectedResult);
    });

    it('should distribute tasks across workers using round-robin', async () => {
      const task1Promise = workerPool.execute({ id: 1 });
      const task2Promise = workerPool.execute({ id: 2 });

      // Simulate responses from different workers
      setImmediate(() => {
        const worker0Handler = mockWorkerInstances[0].on.mock.calls.find(
          (call: any) => call[0] === 'message'
        )?.[1];
        worker0Handler({ taskId: 'task-0', result: 'worker0' });

        const worker1Handler = mockWorkerInstances[1].on.mock.calls.find(
          (call: any) => call[0] === 'message'
        )?.[1];
        worker1Handler({ taskId: 'task-1', result: 'worker1' });
      });

      const [result1, result2] = await Promise.all([task1Promise, task2Promise]);
      expect(result1.result).toBeDefined();
      expect(result2.result).toBeDefined();
    });

    it('should queue tasks when all workers are busy', async () => {
      // Start 3 tasks with only 2 workers
      const promises = [
        workerPool.execute({ id: 1 }),
        workerPool.execute({ id: 2 }),
        workerPool.execute({ id: 3 }),
      ];

      // Give some time for tasks to be queued
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Check queue size before completing any tasks
      const stats = workerPool.getStats();
      expect(stats.queuedTasks).toBeGreaterThan(0);

      // Complete all tasks sequentially
      setImmediate(() => {
        const handler0 = mockWorkerInstances[0].on.mock.calls.find(
          (call: any) => call[0] === 'message'
        )?.[1];
        handler0({ taskId: 'task-0', result: 'done-0' });

        setTimeout(() => {
          const handler1 = mockWorkerInstances[1].on.mock.calls.find(
            (call: any) => call[0] === 'message'
          )?.[1];
          handler1({ taskId: 'task-1', result: 'done-1' });

          setTimeout(() => {
            const handler2 = mockWorkerInstances[0].on.mock.calls.find(
              (call: any) => call[0] === 'message'
            )?.[1];
            handler2({ taskId: 'task-2', result: 'done-2' });
          }, 10);
        }, 10);
      });

      await Promise.all(promises);
    });

    it('should throw error when queue is full', async () => {
      const smallPool = new WorkerPool(
        {
          numWorkers: 1,
          workerScript: '/fake/path/worker.js',
          maxQueueSize: 2,
        },
        logger
      );

      await smallPool.initialize();

      // Fill the queue
      const promises: Promise<unknown>[] = [];
      for (let i = 0; i < 3; i++) {
        promises.push(smallPool.execute({ id: i }));
      }

      // Next task should fail
      await expect(smallPool.execute({ id: 100 })).rejects.toThrow('Task queue is full');

      // Shutdown rejects pending tasks - catch them to avoid unhandled rejections
      await smallPool.shutdown();
      await Promise.allSettled(promises);
    });

    it.skip('should reject task on worker error', async () => {
      // Simulate worker returning error immediately
      const worker = mockWorkerInstances[0];
      const messageHandler = worker.on.mock.calls.find((call: any) => call[0] === 'message')?.[1];

      // Override postMessage to immediately send error response
      worker.postMessage.mockImplementation(() => {
        setImmediate(() => {
          messageHandler({ taskId: 'task-0', error: 'Worker processing failed' });
        });
      });

      await expect(workerPool.execute({ value: 42 })).rejects.toThrow('Worker processing failed');
    });
  });

  describe('Shutdown', () => {
    beforeEach(async () => {
      await workerPool.initialize();
    });

    it('should terminate all workers on shutdown', async () => {
      await workerPool.shutdown();

      mockWorkerInstances.forEach((worker) => {
        expect(worker.terminate).toHaveBeenCalled();
      });

      const stats = workerPool.getStats();
      expect(stats.totalWorkers).toBe(0);
    });

    it('should reject new tasks after shutdown', async () => {
      await workerPool.shutdown();

      await expect(workerPool.execute({ value: 42 })).rejects.toThrow(
        'WorkerPool is shutting down'
      );
    });

    it('should reject pending tasks on shutdown', async () => {
      const promise = workerPool.execute({ value: 42 });

      // Shutdown before task completes
      await workerPool.shutdown();

      await expect(promise).rejects.toThrow('WorkerPool is shutting down');
    });
  });

  describe('Statistics', () => {
    beforeEach(async () => {
      await workerPool.initialize();
    });

    it('should return accurate statistics', async () => {
      const stats = workerPool.getStats();

      expect(stats.totalWorkers).toBe(2);
      expect(stats.busyWorkers).toBe(0);
      expect(stats.queuedTasks).toBe(0);
      expect(stats.pendingTasks).toBe(0);
      expect(stats.totalTasksProcessed).toBe(0);
    });

    it('should track processed tasks', async () => {
      const promise = workerPool.execute({ value: 42 });

      setImmediate(() => {
        const worker = mockWorkerInstances[0];
        const messageHandler = worker.on.mock.calls.find((call: any) => call[0] === 'message')?.[1];
        messageHandler({ taskId: 'task-0', result: 84 });
      });

      await promise;

      const stats = workerPool.getStats();
      expect(stats.totalTasksProcessed).toBe(1);
    });
  });
});
