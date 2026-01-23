import { Logger } from 'pino';
import { Profiler } from './profiler';

export interface PerformanceMetrics {
  throughputTPS: number; // Transactions per second
  p50LatencyMs: number; // 50th percentile latency
  p99LatencyMs: number; // 99th percentile latency
  p999LatencyMs: number; // 99.9th percentile latency
  heapUsageMB: number; // Current heap memory usage
  cpuUsagePercent: number; // CPU utilization percentage
  timestamp: number; // Measurement timestamp
}

export interface LatencyStats {
  p50: number;
  p99: number;
  p999: number;
  min: number;
  max: number;
  mean: number;
  count: number;
}

/**
 * MetricsCollector tracks performance metrics including throughput,
 * latency percentiles, memory usage, and CPU utilization.
 */
export class MetricsCollector {
  private readonly logger: Logger;
  private readonly profiler: Profiler;

  private packetCount: number;
  private latencySamples: number[];
  private startTime: number;

  constructor(logger: Logger, profiler?: Profiler) {
    this.logger = logger.child({ component: 'metrics-collector' });
    this.profiler = profiler || new Profiler(logger);

    this.packetCount = 0;
    this.latencySamples = [];
    this.startTime = Date.now();
  }

  /**
   * Record a processed packet with its latency
   */
  recordPacket(latencyMs: number): void {
    this.packetCount++;
    this.latencySamples.push(latencyMs);

    // Log every 1000 packets to track progress
    if (this.packetCount % 1000 === 0) {
      this.logger.trace(
        {
          totalPackets: this.packetCount,
          latencySampleCount: this.latencySamples.length,
        },
        'Packet count milestone'
      );
    }
  }

  /**
   * Calculate throughput in transactions per second
   */
  calculateThroughput(): number {
    const elapsedSeconds = (Date.now() - this.startTime) / 1000;
    if (elapsedSeconds === 0) {
      return 0;
    }
    return this.packetCount / elapsedSeconds;
  }

  /**
   * Calculate latency percentiles from recorded samples
   */
  calculateLatencyStats(): LatencyStats {
    if (this.latencySamples.length === 0) {
      return {
        p50: 0,
        p99: 0,
        p999: 0,
        min: 0,
        max: 0,
        mean: 0,
        count: 0,
      };
    }

    // Sort samples for percentile calculation
    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    const count = sorted.length;

    const p50Index = Math.floor(count * 0.5);
    const p99Index = Math.floor(count * 0.99);
    const p999Index = Math.floor(count * 0.999);

    const sum = sorted.reduce((acc, val) => acc + val, 0);
    const mean = sum / count;

    return {
      p50: sorted[p50Index] || 0,
      p99: sorted[p99Index] || 0,
      p999: sorted[p999Index] || 0,
      min: sorted[0] || 0,
      max: sorted[count - 1] || 0,
      mean,
      count,
    };
  }

  /**
   * Collect comprehensive performance metrics snapshot
   */
  collectMetrics(): PerformanceMetrics {
    const latencyStats = this.calculateLatencyStats();
    const memProfile = this.profiler.captureMemoryProfile();
    const throughput = this.calculateThroughput();

    // CPU usage measurement is expensive, so we calculate it inline
    const cpuUsage = this.profiler.getCurrentCPUUsage();

    const metrics: PerformanceMetrics = {
      throughputTPS: throughput,
      p50LatencyMs: latencyStats.p50,
      p99LatencyMs: latencyStats.p99,
      p999LatencyMs: latencyStats.p999,
      heapUsageMB: memProfile.heapUsedMB,
      cpuUsagePercent: cpuUsage,
      timestamp: Date.now(),
    };

    this.logger.info(
      {
        throughputTPS: metrics.throughputTPS.toFixed(2),
        p50LatencyMs: metrics.p50LatencyMs.toFixed(2),
        p99LatencyMs: metrics.p99LatencyMs.toFixed(2),
        p999LatencyMs: metrics.p999LatencyMs.toFixed(2),
        heapUsageMB: metrics.heapUsageMB.toFixed(2),
        cpuUsagePercent: metrics.cpuUsagePercent.toFixed(2),
      },
      'Performance metrics collected'
    );

    return metrics;
  }

  /**
   * Export metrics in Prometheus format for monitoring integration
   */
  exportPrometheusMetrics(): string {
    const metrics = this.collectMetrics();
    const timestamp = metrics.timestamp;

    const lines: string[] = [
      '# HELP connector_throughput_tps Connector throughput in transactions per second',
      '# TYPE connector_throughput_tps gauge',
      `connector_throughput_tps ${metrics.throughputTPS} ${timestamp}`,
      '',
      '# HELP connector_latency_p50_ms Connector p50 latency in milliseconds',
      '# TYPE connector_latency_p50_ms gauge',
      `connector_latency_p50_ms ${metrics.p50LatencyMs} ${timestamp}`,
      '',
      '# HELP connector_latency_p99_ms Connector p99 latency in milliseconds',
      '# TYPE connector_latency_p99_ms gauge',
      `connector_latency_p99_ms ${metrics.p99LatencyMs} ${timestamp}`,
      '',
      '# HELP connector_latency_p999_ms Connector p999 latency in milliseconds',
      '# TYPE connector_latency_p999_ms gauge',
      `connector_latency_p999_ms ${metrics.p999LatencyMs} ${timestamp}`,
      '',
      '# HELP connector_heap_usage_mb Connector heap memory usage in MB',
      '# TYPE connector_heap_usage_mb gauge',
      `connector_heap_usage_mb ${metrics.heapUsageMB} ${timestamp}`,
      '',
      '# HELP connector_cpu_usage_percent Connector CPU usage percentage',
      '# TYPE connector_cpu_usage_percent gauge',
      `connector_cpu_usage_percent ${metrics.cpuUsagePercent} ${timestamp}`,
      '',
    ];

    return lines.join('\n');
  }

  /**
   * Reset all collected metrics
   */
  reset(): void {
    this.packetCount = 0;
    this.latencySamples = [];
    this.startTime = Date.now();
    this.logger.debug('Metrics collector reset');
  }

  /**
   * Get current packet count
   */
  getPacketCount(): number {
    return this.packetCount;
  }

  /**
   * Get latency sample count
   */
  getLatencySampleCount(): number {
    return this.latencySamples.length;
  }

  /**
   * Clear latency samples to prevent memory bloat during long-running tests
   */
  clearLatencySamples(): void {
    this.latencySamples = [];
    this.logger.debug('Latency samples cleared');
  }
}
