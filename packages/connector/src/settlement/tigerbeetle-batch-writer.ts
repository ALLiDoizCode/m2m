import { Logger } from 'pino';
import { EventEmitter } from 'events';

export interface BatchWriterConfig {
  batchSize: number; // Transfers per batch (default: 100)
  flushIntervalMs: number; // Periodic flush interval (default: 10ms)
  maxPendingTransfers?: number; // Maximum pending transfers (default: 1000)
}

export interface Transfer {
  id: bigint;
  debitAccountId: bigint;
  creditAccountId: bigint;
  amount: bigint;
  ledger: number;
  code: number;
  flags: number;
  timestamp?: bigint;
  userData128?: bigint;
  userData64?: bigint;
  userData32?: number;
  timeout?: number;
}

export interface TransferError {
  index: number;
  code: number;
}

export interface BatchResult {
  successCount: number;
  errorCount: number;
  errors: Array<{ index: number; code: number; transfer: Transfer }>;
}

/**
 * TigerBeetleBatchWriter accumulates pending transfers and flushes them in batches.
 * Implements periodic flushing (every 10ms) and size-based flushing (every 100 transfers)
 * to balance latency and throughput.
 */
export class TigerBeetleBatchWriter extends EventEmitter {
  private readonly logger: Logger;
  private readonly config: Required<BatchWriterConfig>;
  private readonly pendingTransfers: Transfer[];
  private readonly createTransferFn: (transfers: Transfer[]) => Promise<TransferError[]>;
  private flushTimer?: NodeJS.Timeout;
  private isFlushing: boolean;
  private totalTransfersProcessed: number;
  private totalBatchesFlushed: number;

  constructor(
    config: BatchWriterConfig,
    createTransferFn: (transfers: Transfer[]) => Promise<TransferError[]>,
    logger: Logger
  ) {
    super();
    this.logger = logger.child({ component: 'tigerbeetle-batch-writer' });
    this.config = {
      batchSize: config.batchSize,
      flushIntervalMs: config.flushIntervalMs,
      maxPendingTransfers: config.maxPendingTransfers || 1000,
    };
    this.createTransferFn = createTransferFn;
    this.pendingTransfers = [];
    this.isFlushing = false;
    this.totalTransfersProcessed = 0;
    this.totalBatchesFlushed = 0;

    this.logger.info(
      {
        batchSize: this.config.batchSize,
        flushIntervalMs: this.config.flushIntervalMs,
        maxPendingTransfers: this.config.maxPendingTransfers,
      },
      'TigerBeetleBatchWriter initialized'
    );

    // Start periodic flush timer
    this.startFlushTimer();
  }

  /**
   * Add a transfer to the pending queue
   */
  async addTransfer(transfer: Transfer): Promise<void> {
    if (this.pendingTransfers.length >= this.config.maxPendingTransfers) {
      throw new Error('Pending transfer queue is full');
    }

    this.pendingTransfers.push(transfer);

    this.logger.trace(
      {
        transferId: transfer.id.toString(),
        pendingCount: this.pendingTransfers.length,
      },
      'Transfer added to batch'
    );

    // Size-based flushing: flush when batch size is reached
    if (this.pendingTransfers.length >= this.config.batchSize) {
      await this.flush();
    }
  }

  /**
   * Add multiple transfers to the pending queue
   */
  async addTransfers(transfers: Transfer[]): Promise<void> {
    for (const transfer of transfers) {
      this.pendingTransfers.push(transfer);

      if (this.pendingTransfers.length >= this.config.maxPendingTransfers) {
        throw new Error('Pending transfer queue is full');
      }
    }

    this.logger.trace(
      {
        count: transfers.length,
        pendingCount: this.pendingTransfers.length,
      },
      'Transfers added to batch'
    );

    // Flush if batch size reached
    if (this.pendingTransfers.length >= this.config.batchSize) {
      await this.flush();
    }
  }

  /**
   * Flush pending transfers to TigerBeetle
   */
  async flush(): Promise<BatchResult> {
    // Prevent concurrent flushes
    if (this.isFlushing || this.pendingTransfers.length === 0) {
      return { successCount: 0, errorCount: 0, errors: [] };
    }

    this.isFlushing = true;

    // Extract batch to flush
    const batch = this.pendingTransfers.splice(0, this.config.batchSize);

    try {
      this.logger.debug({ batchSize: batch.length }, 'Flushing transfer batch to TigerBeetle');

      // Execute batch write
      const errors = await this.createTransferFn(batch);

      const result: BatchResult = {
        successCount: batch.length - errors.length,
        errorCount: errors.length,
        errors: errors
          .filter((error: TransferError) => error.index < batch.length)
          .map((error: TransferError) => ({
            index: error.index,
            code: error.code,
            transfer: batch[error.index]!,
          })),
      };

      // Update metrics
      this.totalTransfersProcessed += batch.length;
      this.totalBatchesFlushed++;

      if (errors.length > 0) {
        this.logger.warn(
          {
            successCount: result.successCount,
            errorCount: result.errorCount,
            batchSize: batch.length,
          },
          'Batch flush completed with errors'
        );

        // Emit error event for each failed transfer
        for (const error of result.errors) {
          this.emit('transfer-error', error);
        }
      } else {
        this.logger.trace(
          {
            batchSize: batch.length,
            totalProcessed: this.totalTransfersProcessed,
          },
          'Batch flush successful'
        );
      }

      this.emit('batch-flushed', result);

      return result;
    } catch (error) {
      this.logger.error(
        {
          error: (error as Error).message,
          batchSize: batch.length,
        },
        'Error flushing transfer batch'
      );

      // Re-queue failed transfers at the front
      this.pendingTransfers.unshift(...batch);

      throw error;
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Start periodic flush timer
   */
  private startFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    this.flushTimer = setInterval(async () => {
      try {
        await this.flush();
      } catch (error) {
        this.logger.error({ error: (error as Error).message }, 'Error in periodic flush');
      }
    }, this.config.flushIntervalMs);

    // Prevent timer from keeping process alive
    this.flushTimer.unref();
  }

  /**
   * Stop the batch writer and flush remaining transfers
   */
  async shutdown(): Promise<void> {
    this.logger.info('Shutting down TigerBeetleBatchWriter');

    // Stop flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    // Flush any remaining transfers
    while (this.pendingTransfers.length > 0) {
      try {
        await this.flush();
      } catch (error) {
        this.logger.error({ error: (error as Error).message }, 'Error flushing during shutdown');
        break;
      }
    }

    this.logger.info(
      {
        totalTransfersProcessed: this.totalTransfersProcessed,
        totalBatchesFlushed: this.totalBatchesFlushed,
      },
      'TigerBeetleBatchWriter shutdown complete'
    );
  }

  /**
   * Get batch writer statistics
   */
  getStats(): {
    pendingTransfers: number;
    totalTransfersProcessed: number;
    totalBatchesFlushed: number;
    isFlushing: boolean;
  } {
    return {
      pendingTransfers: this.pendingTransfers.length,
      totalTransfersProcessed: this.totalTransfersProcessed,
      totalBatchesFlushed: this.totalBatchesFlushed,
      isFlushing: this.isFlushing,
    };
  }

  /**
   * Get pending transfer count
   */
  getPendingCount(): number {
    return this.pendingTransfers.length;
  }
}
