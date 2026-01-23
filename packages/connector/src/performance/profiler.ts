import { Logger } from 'pino';
import { performance } from 'perf_hooks';

export interface CPUProfile {
  startTime: number;
  endTime: number;
  durationMs: number;
  userCPUTime: number;
  systemCPUTime: number;
}

export interface MemoryProfile {
  timestamp: number;
  heapUsedMB: number;
  heapTotalMB: number;
  rssMB: number;
  externalMB: number;
  arrayBuffersMB: number;
}

export interface LatencyMeasurement {
  operationId: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
}

/**
 * Profiler provides CPU, memory, and latency profiling utilities
 * for performance optimization and benchmarking.
 */
export class Profiler {
  private readonly logger: Logger;
  private cpuStartUsage?: NodeJS.CpuUsage;
  private cpuStartTime?: number;
  private latencyMeasurements: Map<string, LatencyMeasurement>;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'profiler' });
    this.latencyMeasurements = new Map();
  }

  /**
   * Start CPU profiling session
   */
  startCPUProfile(): void {
    this.cpuStartUsage = process.cpuUsage();
    this.cpuStartTime = performance.now();
    this.logger.debug('CPU profiling started');
  }

  /**
   * Stop CPU profiling and return profile data
   */
  stopCPUProfile(): CPUProfile {
    if (!this.cpuStartUsage || !this.cpuStartTime) {
      throw new Error('CPU profiling not started');
    }

    const endTime = performance.now();
    const cpuUsage = process.cpuUsage(this.cpuStartUsage);

    const profile: CPUProfile = {
      startTime: this.cpuStartTime,
      endTime,
      durationMs: endTime - this.cpuStartTime,
      userCPUTime: cpuUsage.user / 1000, // Convert microseconds to milliseconds
      systemCPUTime: cpuUsage.system / 1000,
    };

    this.logger.debug(
      {
        durationMs: profile.durationMs,
        userCPUMs: profile.userCPUTime,
        systemCPUMs: profile.systemCPUTime,
      },
      'CPU profile completed'
    );

    // Reset for next session
    this.cpuStartUsage = undefined;
    this.cpuStartTime = undefined;

    return profile;
  }

  /**
   * Capture current memory usage snapshot
   */
  captureMemoryProfile(): MemoryProfile {
    const memUsage = process.memoryUsage();

    const profile: MemoryProfile = {
      timestamp: Date.now(),
      heapUsedMB: memUsage.heapUsed / 1024 / 1024,
      heapTotalMB: memUsage.heapTotal / 1024 / 1024,
      rssMB: memUsage.rss / 1024 / 1024,
      externalMB: memUsage.external / 1024 / 1024,
      arrayBuffersMB: memUsage.arrayBuffers / 1024 / 1024,
    };

    this.logger.trace(
      {
        heapUsedMB: profile.heapUsedMB.toFixed(2),
        heapTotalMB: profile.heapTotalMB.toFixed(2),
        rssMB: profile.rssMB.toFixed(2),
      },
      'Memory profile captured'
    );

    return profile;
  }

  /**
   * Start latency measurement for an operation
   */
  startLatencyMeasurement(operationId: string): void {
    const measurement: LatencyMeasurement = {
      operationId,
      startTime: performance.now(),
    };
    this.latencyMeasurements.set(operationId, measurement);
  }

  /**
   * End latency measurement and return duration in milliseconds
   */
  endLatencyMeasurement(operationId: string): number {
    const measurement = this.latencyMeasurements.get(operationId);
    if (!measurement) {
      throw new Error(`No latency measurement found for operation: ${operationId}`);
    }

    measurement.endTime = performance.now();
    measurement.durationMs = measurement.endTime - measurement.startTime;

    this.latencyMeasurements.delete(operationId);

    return measurement.durationMs;
  }

  /**
   * Get current CPU usage percentage (0-100)
   * Note: Returns average CPU usage since last call to this method
   */
  getCurrentCPUUsage(): number {
    const startUsage = process.cpuUsage();
    const startTime = performance.now();

    // Wait 100ms to measure CPU usage
    const endTime = startTime + 100;
    while (performance.now() < endTime) {
      // Busy wait for 100ms
    }

    const endUsage = process.cpuUsage(startUsage);
    const elapsedMs = performance.now() - startTime;
    const elapsedMicroseconds = elapsedMs * 1000;

    const userTime = endUsage.user;
    const systemTime = endUsage.system;
    const totalCPUTime = userTime + systemTime;

    // CPU usage percentage (capped at 100%)
    const cpuPercent = (totalCPUTime / elapsedMicroseconds) * 100;
    return Math.min(cpuPercent, 100);
  }

  /**
   * Clear all active latency measurements
   */
  clearLatencyMeasurements(): void {
    this.latencyMeasurements.clear();
    this.logger.debug('Cleared all latency measurements');
  }

  /**
   * Get count of active latency measurements
   */
  getActiveMeasurementCount(): number {
    return this.latencyMeasurements.size;
  }
}
