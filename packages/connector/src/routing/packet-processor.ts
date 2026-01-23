import { Logger } from 'pino';
import { WorkerPool, WorkerPoolConfig } from './worker-pool';
import { PacketWorkerResult } from './packet-worker';
import * as path from 'path';
import * as os from 'os';

export interface PacketProcessorConfig {
  workerThreads?: number; // Number of worker threads (default: CPU cores)
  batchSize?: number; // Packets per batch (default: 100)
  enableParallelProcessing?: boolean; // Enable/disable parallel processing (default: true)
}

export interface PacketBatch {
  packets: Buffer[];
  batchId: string;
}

export interface ProcessedPacketBatch {
  processedPackets: Buffer[];
  batchId: string;
  processingTimeMs: number;
}

/**
 * PacketProcessor parallelizes packet processing across worker threads.
 * Distributes incoming packet batches across CPU cores for high-throughput processing.
 */
export class PacketProcessor {
  private readonly logger: Logger;
  private readonly config: Required<PacketProcessorConfig>;
  private workerPool?: WorkerPool;
  private batchIdCounter: number;

  constructor(config: PacketProcessorConfig, logger: Logger) {
    this.logger = logger.child({ component: 'packet-processor' });
    this.config = {
      workerThreads: config.workerThreads || os.cpus().length,
      batchSize: config.batchSize || 100,
      enableParallelProcessing: config.enableParallelProcessing ?? true,
    };
    this.batchIdCounter = 0;

    this.logger.info(
      {
        workerThreads: this.config.workerThreads,
        batchSize: this.config.batchSize,
        enableParallelProcessing: this.config.enableParallelProcessing,
      },
      'PacketProcessor initialized'
    );
  }

  /**
   * Initialize the packet processor and worker pool
   */
  async initialize(): Promise<void> {
    if (!this.config.enableParallelProcessing) {
      this.logger.info('Parallel processing disabled, using synchronous mode');
      return;
    }

    // Determine worker script path
    const workerScriptPath = path.join(__dirname, 'packet-worker.js');

    const poolConfig: WorkerPoolConfig = {
      numWorkers: this.config.workerThreads,
      workerScript: workerScriptPath,
      maxQueueSize: 10000,
    };

    this.workerPool = new WorkerPool(poolConfig, this.logger);
    await this.workerPool.initialize();

    this.logger.info('PacketProcessor worker pool initialized');
  }

  /**
   * Process a batch of packets (parallel or synchronous based on config)
   */
  async processBatch(packets: Buffer[]): Promise<ProcessedPacketBatch> {
    const startTime = Date.now();
    const batchId = `batch-${this.batchIdCounter++}`;

    if (!this.config.enableParallelProcessing || !this.workerPool) {
      // Synchronous processing (fallback when parallel processing is disabled)
      const processedPackets = this.processBatchSync(packets);
      const processingTimeMs = Date.now() - startTime;

      return {
        processedPackets,
        batchId,
        processingTimeMs,
      };
    }

    // Parallel processing using worker pool
    try {
      const result = await this.workerPool.execute<{ packets: Buffer[] }, PacketWorkerResult>({
        packets,
      });

      const processingTimeMs = Date.now() - startTime;

      this.logger.trace(
        {
          batchId,
          packetCount: packets.length,
          processingTimeMs,
        },
        'Batch processed'
      );

      return {
        processedPackets: result.processedPackets,
        batchId,
        processingTimeMs,
      };
    } catch (error) {
      this.logger.error(
        {
          batchId,
          error: (error as Error).message,
        },
        'Error processing batch'
      );
      throw error;
    }
  }

  /**
   * Process packets synchronously (fallback mode)
   */
  private processBatchSync(packets: Buffer[]): Buffer[] {
    // Synchronous packet processing (placeholder implementation)
    // In a real implementation, this would perform OER decoding/encoding
    return packets.map((packet) => {
      const copy = Buffer.allocUnsafe(packet.length);
      packet.copy(copy);
      return copy;
    });
  }

  /**
   * Process a single packet (convenience method)
   */
  async processPacket(packet: Buffer): Promise<Buffer> {
    const result = await this.processBatch([packet]);
    const processed = result.processedPackets[0];
    if (!processed) {
      throw new Error('No processed packet returned from batch');
    }
    return processed;
  }

  /**
   * Shutdown the packet processor and worker pool
   */
  async shutdown(): Promise<void> {
    if (this.workerPool) {
      await this.workerPool.shutdown();
      this.logger.info('PacketProcessor worker pool shutdown complete');
    }
  }

  /**
   * Get processor statistics
   */
  getStats(): {
    workerPoolStats?: ReturnType<WorkerPool['getStats']>;
    parallelProcessingEnabled: boolean;
    configuredWorkerThreads: number;
    configuredBatchSize: number;
  } {
    return {
      workerPoolStats: this.workerPool?.getStats(),
      parallelProcessingEnabled: this.config.enableParallelProcessing,
      configuredWorkerThreads: this.config.workerThreads,
      configuredBatchSize: this.config.batchSize,
    };
  }

  /**
   * Check if worker pool is busy
   */
  isBusy(): boolean {
    return this.workerPool?.isBusy() ?? false;
  }
}
