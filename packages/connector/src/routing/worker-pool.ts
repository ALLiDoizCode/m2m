import { Worker } from 'worker_threads';
import { Logger } from 'pino';
import { EventEmitter } from 'events';
import * as os from 'os';

export interface WorkerPoolConfig {
  numWorkers: number; // Number of worker threads (default: CPU cores)
  workerScript: string; // Path to worker script
  maxQueueSize?: number; // Maximum queued tasks (default: 10000)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface WorkerTask<T = any, R = any> {
  id: string;
  data: T;
  resolve: (result: R) => void;
  reject: (error: Error) => void;
}

interface WorkerState {
  worker: Worker;
  busy: boolean;
  taskCount: number;
  currentTask: WorkerTask | null;
}

/**
 * WorkerPool manages a pool of worker threads for parallel task execution.
 * Uses round-robin distribution and automatic worker restart on failure.
 */
export class WorkerPool extends EventEmitter {
  private readonly logger: Logger;
  private readonly config: Required<WorkerPoolConfig>;
  private readonly workers: WorkerState[];
  private readonly taskQueue: WorkerTask[];
  private readonly pendingTasks: Map<string, WorkerTask>;
  private nextWorkerIndex: number;
  private isShuttingDown: boolean;
  private taskIdCounter: number;

  constructor(config: WorkerPoolConfig, logger: Logger) {
    super();
    this.logger = logger.child({ component: 'worker-pool' });
    this.config = {
      numWorkers: config.numWorkers || os.cpus().length,
      workerScript: config.workerScript,
      maxQueueSize: config.maxQueueSize || 10000,
    };
    this.workers = [];
    this.taskQueue = [];
    this.pendingTasks = new Map();
    this.nextWorkerIndex = 0;
    this.isShuttingDown = false;
    this.taskIdCounter = 0;

    this.logger.info(
      {
        numWorkers: this.config.numWorkers,
        workerScript: this.config.workerScript,
        maxQueueSize: this.config.maxQueueSize,
      },
      'WorkerPool initialized'
    );
  }

  /**
   * Initialize worker pool by spawning worker threads
   */
  async initialize(): Promise<void> {
    if (this.workers.length > 0) {
      throw new Error('WorkerPool already initialized');
    }

    const initPromises: Promise<void>[] = [];
    for (let i = 0; i < this.config.numWorkers; i++) {
      initPromises.push(this.spawnWorker(i));
    }

    await Promise.all(initPromises);

    this.logger.info({ workerCount: this.workers.length }, 'WorkerPool initialization complete');
  }

  /**
   * Spawn a new worker thread
   */
  private async spawnWorker(workerId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.config.workerScript, {
        workerData: { workerId },
      });

      const workerState: WorkerState = {
        worker,
        busy: false,
        taskCount: 0,
        currentTask: null,
      };

      worker.on('message', (result) => {
        // Check for ready message
        if (result.ready) {
          this.logger.debug({ workerId }, 'Worker ready');
          resolve();
          return;
        }

        this.handleWorkerMessage(workerId, result);
      });

      worker.on('error', (error) => {
        this.handleWorkerError(workerId, error);
        reject(error);
      });

      worker.on('exit', (code) => {
        this.handleWorkerExit(workerId, code);
      });

      this.workers[workerId] = workerState;

      this.logger.debug({ workerId }, 'Worker spawned');
    });
  }

  /**
   * Handle message from worker
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleWorkerMessage(workerId: number, result: any): void {
    const workerState = this.workers[workerId];
    if (!workerState) {
      this.logger.warn({ workerId }, 'Received message from unknown worker');
      return;
    }

    const taskId = result.taskId;
    const task = this.pendingTasks.get(taskId);

    if (!task) {
      this.logger.warn({ taskId }, 'Received result for unknown task');
      return;
    }

    // Remove from pending tasks
    this.pendingTasks.delete(taskId);

    // Mark worker as available
    workerState.busy = false;
    workerState.taskCount++;
    workerState.currentTask = null;

    this.logger.trace(
      { workerId, taskId, taskCount: workerState.taskCount },
      'Worker completed task'
    );

    // Resolve or reject the task promise
    if (result.error) {
      task.reject(new Error(result.error));
    } else {
      task.resolve(result);
    }

    // Process next task from queue
    this.processQueue();
  }

  /**
   * Handle worker error
   */
  private handleWorkerError(workerId: number, error: Error): void {
    this.logger.error({ workerId, error: error.message }, 'Worker encountered error');

    const workerState = this.workers[workerId];
    if (workerState?.currentTask) {
      workerState.currentTask.reject(error);
      workerState.currentTask = null;
    }

    this.emit('worker-error', { workerId, error });
  }

  /**
   * Handle worker exit
   */
  private async handleWorkerExit(workerId: number, code: number): Promise<void> {
    this.logger.warn({ workerId, exitCode: code }, 'Worker exited');

    if (this.isShuttingDown) {
      return;
    }

    // Restart worker on unexpected exit
    if (code !== 0) {
      this.logger.info({ workerId }, 'Restarting worker after unexpected exit');
      try {
        await this.spawnWorker(workerId);
      } catch (error) {
        this.logger.error(
          { workerId, error: (error as Error).message },
          'Failed to restart worker'
        );
      }
    }
  }

  /**
   * Execute a task using the worker pool
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute<T = any, R = any>(data: T): Promise<R> {
    if (this.isShuttingDown) {
      throw new Error('WorkerPool is shutting down');
    }

    if (this.workers.length === 0) {
      throw new Error('WorkerPool not initialized');
    }

    if (this.taskQueue.length >= this.config.maxQueueSize) {
      throw new Error('Task queue is full');
    }

    return new Promise<R>((resolve, reject) => {
      const taskId = `task-${this.taskIdCounter++}`;
      const task: WorkerTask<T, R> = {
        id: taskId,
        data,
        resolve,
        reject,
      };

      this.taskQueue.push(task);
      this.pendingTasks.set(taskId, task);
      this.processQueue();
    });
  }

  /**
   * Process task queue using round-robin worker selection
   */
  private processQueue(): void {
    if (this.taskQueue.length === 0) {
      return;
    }

    // Find available worker
    const availableWorker = this.findAvailableWorker();
    if (!availableWorker) {
      return; // All workers busy
    }

    const task = this.taskQueue.shift();
    if (!task) {
      return;
    }

    // Mark worker as busy
    availableWorker.state.busy = true;
    availableWorker.state.currentTask = task;

    // Send task to worker
    availableWorker.state.worker.postMessage({
      taskId: task.id,
      ...task.data,
    });

    this.logger.trace(
      { workerId: availableWorker.index, taskId: task.id },
      'Task dispatched to worker'
    );
  }

  /**
   * Find available worker using round-robin selection
   */
  private findAvailableWorker(): { index: number; state: WorkerState } | null {
    const startIndex = this.nextWorkerIndex;
    let currentIndex = startIndex;

    do {
      const workerState = this.workers[currentIndex];
      if (workerState && !workerState.busy) {
        this.nextWorkerIndex = (currentIndex + 1) % this.workers.length;
        return { index: currentIndex, state: workerState };
      }
      currentIndex = (currentIndex + 1) % this.workers.length;
    } while (currentIndex !== startIndex);

    return null; // All workers busy
  }

  /**
   * Shutdown worker pool
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    this.logger.info('Shutting down worker pool');

    // Reject all pending tasks
    for (const [taskId, task] of this.pendingTasks.entries()) {
      task.reject(new Error('WorkerPool is shutting down'));
      this.pendingTasks.delete(taskId);
    }

    // Clear task queue
    for (const task of this.taskQueue) {
      task.reject(new Error('WorkerPool is shutting down'));
    }
    this.taskQueue.length = 0;

    // Terminate all workers
    const terminationPromises = this.workers.map(async (workerState, index) => {
      if (workerState) {
        try {
          await workerState.worker.terminate();
          this.logger.debug({ workerId: index }, 'Worker terminated');
        } catch (error) {
          this.logger.error(
            { workerId: index, error: (error as Error).message },
            'Error terminating worker'
          );
        }
      }
    });

    await Promise.all(terminationPromises);

    this.workers.length = 0;

    this.logger.info('Worker pool shutdown complete');
  }

  /**
   * Get worker pool statistics
   */
  getStats(): {
    totalWorkers: number;
    busyWorkers: number;
    queuedTasks: number;
    pendingTasks: number;
    totalTasksProcessed: number;
  } {
    const busyWorkers = this.workers.filter((w) => w?.busy).length;
    const totalTasksProcessed = this.workers.reduce((sum, w) => sum + (w?.taskCount || 0), 0);

    return {
      totalWorkers: this.workers.length,
      busyWorkers,
      queuedTasks: this.taskQueue.length,
      pendingTasks: this.pendingTasks.size,
      totalTasksProcessed,
    };
  }

  /**
   * Get queue size
   */
  getQueueSize(): number {
    return this.taskQueue.length;
  }

  /**
   * Check if worker pool is busy (all workers occupied)
   */
  isBusy(): boolean {
    return this.workers.every((w) => w?.busy);
  }
}
