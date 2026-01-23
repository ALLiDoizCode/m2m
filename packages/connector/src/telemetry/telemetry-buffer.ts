import { Logger } from 'pino';
import { EventEmitter } from 'events';

export interface TelemetryBufferConfig {
  bufferSize: number; // Events per batch (default: 1000)
  flushIntervalMs: number; // Periodic flush interval (default: 100ms)
}

export interface TelemetryEvent {
  eventType: string;
  timestamp: number;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface FlushResult {
  eventCount: number;
  timestamp: number;
}

/**
 * TelemetryBuffer accumulates telemetry events and flushes them in batches.
 * Implements periodic flushing (every 100ms) and size-based flushing (every 1000 events)
 * to prevent excessive logging overhead from high-frequency events.
 */
export class TelemetryBuffer extends EventEmitter {
  private readonly logger: Logger;
  private readonly config: Required<TelemetryBufferConfig>;
  private readonly pendingEvents: TelemetryEvent[];
  private readonly flushFn: (events: TelemetryEvent[]) => void;
  private flushTimer?: NodeJS.Timeout;
  private isFlushing: boolean;
  private totalEventsFlushed: number;
  private totalFlushes: number;

  constructor(
    config: TelemetryBufferConfig,
    flushFn: (events: TelemetryEvent[]) => void,
    logger: Logger
  ) {
    super();
    this.logger = logger.child({ component: 'telemetry-buffer' });
    this.config = {
      bufferSize: config.bufferSize,
      flushIntervalMs: config.flushIntervalMs,
    };
    this.flushFn = flushFn;
    this.pendingEvents = [];
    this.isFlushing = false;
    this.totalEventsFlushed = 0;
    this.totalFlushes = 0;

    this.logger.info(
      {
        bufferSize: this.config.bufferSize,
        flushIntervalMs: this.config.flushIntervalMs,
      },
      'TelemetryBuffer initialized'
    );

    // Start periodic flush timer
    this.startFlushTimer();
  }

  /**
   * Add a single telemetry event to the buffer
   */
  addEvent(event: TelemetryEvent): void {
    this.pendingEvents.push(event);

    this.logger.trace(
      {
        eventType: event.eventType,
        pendingCount: this.pendingEvents.length,
      },
      'Event added to buffer'
    );

    // Size-based flushing: flush when buffer size is reached
    if (this.pendingEvents.length >= this.config.bufferSize) {
      this.flush();
    }
  }

  /**
   * Add multiple telemetry events to the buffer
   */
  addEvents(events: TelemetryEvent[]): void {
    for (const event of events) {
      this.pendingEvents.push(event);

      // Flush if buffer size reached
      if (this.pendingEvents.length >= this.config.bufferSize) {
        this.flush();
      }
    }

    this.logger.trace(
      {
        count: events.length,
        pendingCount: this.pendingEvents.length,
      },
      'Events added to buffer'
    );
  }

  /**
   * Flush pending events to logger
   */
  flush(): void {
    // Prevent concurrent flushes
    if (this.isFlushing || this.pendingEvents.length === 0) {
      return;
    }

    this.isFlushing = true;

    // Extract batch to flush
    const batch = this.pendingEvents.splice(0, this.config.bufferSize);

    try {
      this.logger.debug({ batchSize: batch.length }, 'Flushing telemetry event batch');

      // Execute flush
      this.flushFn(batch);

      // Update metrics
      this.totalEventsFlushed += batch.length;
      this.totalFlushes++;

      const result: FlushResult = {
        eventCount: batch.length,
        timestamp: Date.now(),
      };

      this.logger.trace(
        {
          batchSize: batch.length,
          totalFlushed: this.totalEventsFlushed,
        },
        'Telemetry batch flushed successfully'
      );

      this.emit('batch-flushed', result);
    } catch (error) {
      this.logger.error(
        {
          error: (error as Error).message,
          batchSize: batch.length,
        },
        'Error flushing telemetry batch'
      );

      // Re-queue failed events at the front
      this.pendingEvents.unshift(...batch);

      this.emit('flush-error', error);
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

    this.flushTimer = setInterval(() => {
      try {
        this.flush();
      } catch (error) {
        this.logger.error({ error: (error as Error).message }, 'Error in periodic flush');
      }
    }, this.config.flushIntervalMs);

    // Prevent timer from keeping process alive
    this.flushTimer.unref();
  }

  /**
   * Stop the telemetry buffer and flush remaining events
   */
  shutdown(): void {
    this.logger.info('Shutting down TelemetryBuffer');

    // Stop flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    // Flush any remaining events
    while (this.pendingEvents.length > 0 && !this.isFlushing) {
      try {
        this.flush();
      } catch (error) {
        this.logger.error({ error: (error as Error).message }, 'Error flushing during shutdown');
        break;
      }
    }

    this.logger.info(
      {
        totalEventsFlushed: this.totalEventsFlushed,
        totalFlushes: this.totalFlushes,
      },
      'TelemetryBuffer shutdown complete'
    );
  }

  /**
   * Get buffer statistics
   */
  getStats(): {
    pendingEvents: number;
    totalEventsFlushed: number;
    totalFlushes: number;
    isFlushing: boolean;
  } {
    return {
      pendingEvents: this.pendingEvents.length,
      totalEventsFlushed: this.totalEventsFlushed,
      totalFlushes: this.totalFlushes,
      isFlushing: this.isFlushing,
    };
  }

  /**
   * Get pending event count
   */
  getPendingCount(): number {
    return this.pendingEvents.length;
  }
}
