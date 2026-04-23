/* eslint-disable @typescript-eslint/no-explicit-any */
import pino from 'pino';
import { WorkerPool } from '../../../src/routing/worker-pool';
import { Worker } from 'worker_threads';
jest.mock('worker_threads', () => ({
  Worker: jest.fn(),
}));

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return {
    ...actual,
    cpus: jest.fn().mockReturnValue([{}, {}, {}, {}]),
  };
});

describe('WorkerPool branch coverage', () => {
  let logger: pino.Logger;
  let mockWorkerInstances: any[];

  beforeEach(() => {
    logger = pino({ level: 'silent' });
    mockWorkerInstances = [];

    (Worker as jest.MockedClass<typeof Worker>).mockImplementation(
      (_script: any, _options: any) => {
        const mockWorker: any = {
          postMessage: jest.fn(),
          terminate: jest.fn().mockResolvedValue(undefined),
          on: jest.fn((_event: string, _handler: any) => mockWorker),
          once: jest.fn(),
          off: jest.fn(),
          removeListener: jest.fn(),
        };
        mockWorkerInstances.push(mockWorker);
        return mockWorker;
      }
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function getHandler(workerIndex: number, event: string) {
    const worker = mockWorkerInstances[workerIndex];
    if (!worker) return undefined;
    return worker.on.mock.calls.find((call: any) => call[0] === event)?.[1];
  }

  function triggerReady(workerIndex: number) {
    const handler = getHandler(workerIndex, 'message');
    if (handler) {
      handler({ ready: true, workerId: workerIndex });
    }
  }

  async function initializePool(pool: WorkerPool, numWorkers: number) {
    const promise = pool.initialize();
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < numWorkers; i++) {
      triggerReady(i);
    }
    await promise;
  }

  describe('constructor defaults', () => {
    it('defaults numWorkers to os.cpus().length when 0 provided', () => {
      const pool = new WorkerPool(
        {
          numWorkers: 0,
          workerScript: '/fake/path/worker.js',
        },
        logger
      );
      expect((pool as any).config.numWorkers).toBe(4);
    });

    it('defaults maxQueueSize to 10000 when undefined', () => {
      const pool = new WorkerPool(
        {
          numWorkers: 2,
          workerScript: '/fake/path/worker.js',
        },
        logger
      );
      expect((pool as any).config.maxQueueSize).toBe(10000);
    });

    it('defaults maxQueueSize to 10000 when 0 provided', () => {
      const pool = new WorkerPool(
        {
          numWorkers: 2,
          workerScript: '/fake/path/worker.js',
          maxQueueSize: 0,
        },
        logger
      );
      expect((pool as any).config.maxQueueSize).toBe(10000);
    });
  });

  describe('execute validation branches', () => {
    it('throws when pool is shutting down', async () => {
      const pool = new WorkerPool(
        {
          numWorkers: 1,
          workerScript: '/fake/path/worker.js',
        },
        logger
      );
      (pool as any).isShuttingDown = true;
      await expect(pool.execute({ value: 1 })).rejects.toThrow('WorkerPool is shutting down');
    });

    it('throws when pool is not initialized', async () => {
      const pool = new WorkerPool(
        {
          numWorkers: 1,
          workerScript: '/fake/path/worker.js',
        },
        logger
      );
      await expect(pool.execute({ value: 1 })).rejects.toThrow('WorkerPool not initialized');
    });
  });

  describe('spawnWorker error branch', () => {
    it('rejects initialize when worker emits error before ready', async () => {
      const pool = new WorkerPool(
        {
          numWorkers: 1,
          workerScript: '/fake/path/worker.js',
        },
        logger
      );

      (Worker as jest.MockedClass<typeof Worker>).mockImplementationOnce(
        (_script: any, _options: any) => {
          const mockWorker: any = {
            postMessage: jest.fn(),
            terminate: jest.fn().mockResolvedValue(undefined),
            on: jest.fn((_event: string, _handler: any) => {
              if (_event === 'error') {
                setImmediate(() => _handler(new Error('spawn failed')));
              }
              return mockWorker;
            }),
            once: jest.fn(),
            off: jest.fn(),
            removeListener: jest.fn(),
          };
          mockWorkerInstances.push(mockWorker);
          return mockWorker;
        }
      );

      await expect(pool.initialize()).rejects.toThrow('spawn failed');
    });
  });

  describe('worker message handling branches', () => {
    let pool: WorkerPool;

    beforeEach(async () => {
      pool = new WorkerPool(
        {
          numWorkers: 2,
          workerScript: '/fake/path/worker.js',
        },
        logger
      );
      await initializePool(pool, 2);
    });

    afterEach(async () => {
      if (pool) {
        try {
          await pool.shutdown();
        } catch (e) {
          // ignore
        }
      }
    });

    it('resolves task when worker returns success', async () => {
      const promise = pool.execute({ value: 42 });
      await new Promise((resolve) => setImmediate(resolve));
      const pendingTasks = (pool as any).pendingTasks;
      const taskId = pendingTasks.keys().next().value;
      getHandler(0, 'message')({ taskId, result: 84 });
      const result = await promise;
      expect(result.result).toBe(84);
    });

    it('warns on message from unknown worker', () => {
      expect(() => {
        (pool as any).handleWorkerMessage(999, { taskId: 'task-x', result: 1 });
      }).not.toThrow();
    });

    it('warns on result for unknown task', () => {
      expect(() => {
        (pool as any).handleWorkerMessage(0, {
          taskId: 'unknown-task',
          result: 1,
        });
      }).not.toThrow();
    });

    it('rejects task when worker returns error', async () => {
      const promise = pool.execute({ value: 42 });
      await new Promise((resolve) => setImmediate(resolve));
      const pendingTasks = (pool as any).pendingTasks;
      const taskId = pendingTasks.keys().next().value;
      getHandler(0, 'message')({ taskId, error: 'processing failed' });
      await expect(promise).rejects.toThrow('processing failed');
    });
  });

  describe('handleWorkerError branches', () => {
    let pool: WorkerPool;

    beforeEach(async () => {
      pool = new WorkerPool(
        {
          numWorkers: 2,
          workerScript: '/fake/path/worker.js',
        },
        logger
      );
      await initializePool(pool, 2);
    });

    afterEach(async () => {
      if (pool) {
        try {
          await pool.shutdown();
        } catch (e) {
          // ignore
        }
      }
    });

    it('handles error for unknown worker without throwing', () => {
      expect(() => (pool as any).handleWorkerError(999, new Error('unknown worker'))).not.toThrow();
    });

    it('rejects current task on worker error', async () => {
      const promise = pool.execute({ value: 1 });
      await new Promise((resolve) => setImmediate(resolve));
      await (pool as any).handleWorkerError(0, new Error('worker crashed'));
      await expect(promise).rejects.toThrow('worker crashed');
    });

    it('handles worker error when no current task is assigned', () => {
      expect(() =>
        (pool as any).handleWorkerError(0, new Error('idle worker error'))
      ).not.toThrow();
    });
  });

  describe('handleWorkerExit branches', () => {
    let pool: WorkerPool;

    beforeEach(async () => {
      pool = new WorkerPool(
        {
          numWorkers: 2,
          workerScript: '/fake/path/worker.js',
        },
        logger
      );
      await initializePool(pool, 2);
    });

    afterEach(async () => {
      if (pool) {
        try {
          await pool.shutdown();
        } catch (e) {
          // ignore
        }
      }
    });

    it('does not restart worker when shutting down', async () => {
      (pool as any).isShuttingDown = true;
      await (pool as any).handleWorkerExit(0, 1);
      expect(Worker).toHaveBeenCalledTimes(2);
    });

    it('does not restart worker on normal exit (code 0)', async () => {
      await (pool as any).handleWorkerExit(0, 0);
      await new Promise((resolve) => setImmediate(resolve));
      expect(Worker).toHaveBeenCalledTimes(2);
    });

    it('restarts worker on unexpected exit', async () => {
      const handlePromise = (pool as any).handleWorkerExit(0, 1);
      await new Promise((resolve) => setImmediate(resolve));
      triggerReady(2);
      await handlePromise;
      expect(Worker).toHaveBeenCalledTimes(3);
    });

    it('logs error when worker restart fails', async () => {
      (Worker as jest.MockedClass<typeof Worker>).mockImplementationOnce(
        (_script: any, _options: any) => {
          const mockWorker: any = {
            postMessage: jest.fn(),
            terminate: jest.fn().mockResolvedValue(undefined),
            on: jest.fn((_event: string, _handler: any) => {
              if (_event === 'error') {
                setImmediate(() => _handler(new Error('restart failed')));
              }
              return mockWorker;
            }),
            once: jest.fn(),
            off: jest.fn(),
            removeListener: jest.fn(),
          };
          mockWorkerInstances.push(mockWorker);
          return mockWorker;
        }
      );

      await (pool as any).handleWorkerExit(0, 1);
      expect(Worker).toHaveBeenCalledTimes(3);
    });
  });

  describe('processQueue and findAvailableWorker branches', () => {
    let pool: WorkerPool;

    beforeEach(async () => {
      pool = new WorkerPool(
        {
          numWorkers: 1,
          workerScript: '/fake/path/worker.js',
        },
        logger
      );
      await initializePool(pool, 1);
    });

    afterEach(async () => {
      if (pool) {
        try {
          await pool.shutdown();
        } catch (e) {
          // ignore
        }
      }
    });

    it('returns early when queue is empty', () => {
      expect(() => (pool as any).processQueue()).not.toThrow();
    });

    it('returns early when no worker is available', async () => {
      const promise = pool.execute({ value: 1 });
      await new Promise((resolve) => setImmediate(resolve));
      expect(pool.getStats().busyWorkers).toBe(1);

      const promise2 = pool.execute({ value: 2 });
      await new Promise((resolve) => setImmediate(resolve));
      expect(pool.getStats().queuedTasks).toBe(1);

      // Complete both tasks to avoid unhandled rejections
      getHandler(0, 'message')({ taskId: 'task-0', result: 'done' });
      await promise;
      getHandler(0, 'message')({ taskId: 'task-1', result: 'done' });
      await promise2;
    });

    it('returns early when task shift returns undefined', () => {
      (pool as any).taskQueue.length = 1;
      expect(() => (pool as any).processQueue()).not.toThrow();
    });

    it('finds available worker skipping undefined slots', () => {
      (pool as any).workers.push(undefined);
      const result = (pool as any).findAvailableWorker();
      expect(result).toBeDefined();
      expect(result.index).toBe(0);
    });

    it('returns null when all workers are busy', async () => {
      const promise = pool.execute({ value: 1 });
      await new Promise((resolve) => setImmediate(resolve));
      const result = (pool as any).findAvailableWorker();
      expect(result).toBeNull();
      getHandler(0, 'message')({ taskId: 'task-0', result: 'done' });
      await promise;
    });
  });

  describe('shutdown branches', () => {
    let pool: WorkerPool;

    beforeEach(async () => {
      pool = new WorkerPool(
        {
          numWorkers: 2,
          workerScript: '/fake/path/worker.js',
        },
        logger
      );
      await initializePool(pool, 2);
    });

    afterEach(async () => {
      if (pool) {
        try {
          await pool.shutdown();
        } catch (e) {
          // ignore
        }
      }
    });

    it('logs error when worker terminate fails', async () => {
      mockWorkerInstances[0].terminate.mockRejectedValueOnce(new Error('terminate failed'));
      await pool.shutdown();
      expect(mockWorkerInstances[0].terminate).toHaveBeenCalled();
      expect(mockWorkerInstances[1].terminate).toHaveBeenCalled();
    });

    it('handles sparse workers array during shutdown', async () => {
      (pool as any).workers[0] = undefined;
      await pool.shutdown();
      expect(mockWorkerInstances[0].terminate).not.toHaveBeenCalled();
      expect(mockWorkerInstances[1].terminate).toHaveBeenCalled();
    });
  });

  describe('getStats, getQueueSize, isBusy', () => {
    let pool: WorkerPool;

    beforeEach(async () => {
      pool = new WorkerPool(
        {
          numWorkers: 2,
          workerScript: '/fake/path/worker.js',
        },
        logger
      );
      await initializePool(pool, 2);
    });

    afterEach(async () => {
      if (pool) {
        try {
          await pool.shutdown();
        } catch (e) {
          // ignore
        }
      }
    });

    it('returns stats with undefined workers in sparse array', async () => {
      const promise = pool.execute({ value: 1 });
      await new Promise((resolve) => setImmediate(resolve));
      (pool as any).workers[1] = undefined;

      const stats = pool.getStats();
      expect(stats.totalWorkers).toBe(2);
      expect(stats.busyWorkers).toBe(1);
      expect(stats.totalTasksProcessed).toBe(0);

      getHandler(0, 'message')({ taskId: 'task-0', result: 'done' });
      await promise;

      const stats2 = pool.getStats();
      expect(stats2.totalTasksProcessed).toBe(1);
    });

    it('returns queue size', () => {
      expect(pool.getQueueSize()).toBe(0);
      (pool as any).taskQueue.push({ id: 'task-x' });
      expect(pool.getQueueSize()).toBe(1);
    });

    it('returns isBusy accurately', async () => {
      const emptyPool = new WorkerPool(
        {
          numWorkers: 1,
          workerScript: '/fake/path/worker.js',
        },
        logger
      );
      expect(emptyPool.isBusy()).toBe(true);

      expect(pool.isBusy()).toBe(false);

      const p1 = pool.execute({ value: 1 });
      const p2 = pool.execute({ value: 2 });
      await new Promise((resolve) => setImmediate(resolve));
      expect(pool.isBusy()).toBe(true);

      getHandler(0, 'message')({ taskId: 'task-0', result: 'done' });
      await p1;
      expect(pool.isBusy()).toBe(false);

      getHandler(1, 'message')({ taskId: 'task-1', result: 'done' });
      await p2;
      expect(pool.isBusy()).toBe(false);
    });
  });

  describe('execute queue full', () => {
    it('throws when task queue is full', async () => {
      const pool = new WorkerPool(
        {
          numWorkers: 1,
          workerScript: '/fake/path/worker.js',
          maxQueueSize: 1,
        },
        logger
      );
      await initializePool(pool, 1);

      const promise1 = pool.execute({ value: 1 });
      await new Promise((resolve) => setImmediate(resolve));

      const promise2 = pool.execute({ value: 2 });
      await new Promise((resolve) => setImmediate(resolve));

      await expect(pool.execute({ value: 3 })).rejects.toThrow('Task queue is full');

      await pool.shutdown();
      await Promise.allSettled([promise1, promise2]);
    });
  });
});
