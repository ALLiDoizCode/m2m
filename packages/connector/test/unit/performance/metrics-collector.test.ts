import pino from 'pino';
import { MetricsCollector } from '../../../src/performance/metrics-collector';
import { Profiler } from '../../../src/performance/profiler';

describe('MetricsCollector', () => {
  let logger: pino.Logger;
  let profiler: Profiler;
  let metricsCollector: MetricsCollector;

  beforeEach(() => {
    logger = pino({ level: 'silent' });
    profiler = new Profiler(logger);
    metricsCollector = new MetricsCollector(logger, profiler);
  });

  afterEach(() => {
    metricsCollector.reset();
  });

  describe('Packet Recording', () => {
    it('should record packet with latency', () => {
      metricsCollector.recordPacket(5.5);
      metricsCollector.recordPacket(10.2);
      metricsCollector.recordPacket(3.8);

      expect(metricsCollector.getPacketCount()).toBe(3);
      expect(metricsCollector.getLatencySampleCount()).toBe(3);
    });

    it('should track thousands of packets', () => {
      for (let i = 0; i < 5000; i++) {
        metricsCollector.recordPacket(Math.random() * 10);
      }

      expect(metricsCollector.getPacketCount()).toBe(5000);
      expect(metricsCollector.getLatencySampleCount()).toBe(5000);
    });
  });

  describe('Throughput Calculation', () => {
    it('should calculate throughput in TPS', async () => {
      // Record 100 packets over ~100ms
      for (let i = 0; i < 100; i++) {
        metricsCollector.recordPacket(1.0);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));

      const throughput = metricsCollector.calculateThroughput();

      // Should be roughly 1000 TPS (100 packets / 0.1 seconds)
      expect(throughput).toBeGreaterThan(500);
      expect(throughput).toBeLessThan(2000);
    });

    it('should return 0 throughput when no time elapsed', () => {
      metricsCollector.reset();
      const throughput = metricsCollector.calculateThroughput();
      expect(throughput).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Latency Statistics', () => {
    it('should calculate latency percentiles', () => {
      // Record latencies from 1ms to 100ms
      for (let i = 1; i <= 100; i++) {
        metricsCollector.recordPacket(i);
      }

      const stats = metricsCollector.calculateLatencyStats();

      expect(stats.count).toBe(100);
      expect(stats.min).toBe(1);
      expect(stats.max).toBe(100);
      expect(stats.mean).toBeCloseTo(50.5, 1);
      // Percentiles are approximate due to floor calculation
      expect(stats.p50).toBeGreaterThan(48);
      expect(stats.p50).toBeLessThan(52);
      expect(stats.p99).toBeGreaterThan(97);
      expect(stats.p99).toBeLessThanOrEqual(100);
      expect(stats.p999).toBeGreaterThan(97);
      expect(stats.p999).toBeLessThanOrEqual(100);
    });

    it('should return zero stats when no samples', () => {
      const stats = metricsCollector.calculateLatencyStats();

      expect(stats.count).toBe(0);
      expect(stats.min).toBe(0);
      expect(stats.max).toBe(0);
      expect(stats.mean).toBe(0);
      expect(stats.p50).toBe(0);
      expect(stats.p99).toBe(0);
      expect(stats.p999).toBe(0);
    });

    it('should handle small sample sizes', () => {
      metricsCollector.recordPacket(5.0);
      metricsCollector.recordPacket(10.0);

      const stats = metricsCollector.calculateLatencyStats();

      expect(stats.count).toBe(2);
      expect(stats.min).toBe(5.0);
      expect(stats.max).toBe(10.0);
    });
  });

  describe('Metrics Collection', () => {
    it('should collect comprehensive performance metrics', async () => {
      // Record some packets
      for (let i = 0; i < 100; i++) {
        metricsCollector.recordPacket(Math.random() * 10);
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      const metrics = metricsCollector.collectMetrics();

      expect(metrics).toHaveProperty('throughputTPS');
      expect(metrics).toHaveProperty('p50LatencyMs');
      expect(metrics).toHaveProperty('p99LatencyMs');
      expect(metrics).toHaveProperty('p999LatencyMs');
      expect(metrics).toHaveProperty('heapUsageMB');
      expect(metrics).toHaveProperty('cpuUsagePercent');
      expect(metrics).toHaveProperty('timestamp');

      expect(metrics.throughputTPS).toBeGreaterThan(0);
      expect(metrics.heapUsageMB).toBeGreaterThan(0);
      expect(metrics.cpuUsagePercent).toBeGreaterThanOrEqual(0);
      expect(metrics.cpuUsagePercent).toBeLessThanOrEqual(100);
      expect(metrics.timestamp).toBeGreaterThan(0);
    });
  });

  describe('Prometheus Export', () => {
    it('should export metrics in Prometheus format', async () => {
      // Record some packets
      for (let i = 0; i < 50; i++) {
        metricsCollector.recordPacket(5.0 + Math.random());
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      const prometheusText = metricsCollector.exportPrometheusMetrics();

      expect(prometheusText).toContain('# HELP connector_throughput_tps');
      expect(prometheusText).toContain('# TYPE connector_throughput_tps gauge');
      expect(prometheusText).toContain('connector_throughput_tps');

      expect(prometheusText).toContain('# HELP connector_latency_p50_ms');
      expect(prometheusText).toContain('connector_latency_p50_ms');

      expect(prometheusText).toContain('# HELP connector_latency_p99_ms');
      expect(prometheusText).toContain('connector_latency_p99_ms');

      expect(prometheusText).toContain('# HELP connector_heap_usage_mb');
      expect(prometheusText).toContain('connector_heap_usage_mb');

      expect(prometheusText).toContain('# HELP connector_cpu_usage_percent');
      expect(prometheusText).toContain('connector_cpu_usage_percent');
    });
  });

  describe('Reset and Clear', () => {
    it('should reset all metrics', () => {
      metricsCollector.recordPacket(5.0);
      metricsCollector.recordPacket(10.0);

      expect(metricsCollector.getPacketCount()).toBe(2);
      expect(metricsCollector.getLatencySampleCount()).toBe(2);

      metricsCollector.reset();

      expect(metricsCollector.getPacketCount()).toBe(0);
      expect(metricsCollector.getLatencySampleCount()).toBe(0);
    });

    it('should clear latency samples without resetting packet count', () => {
      metricsCollector.recordPacket(5.0);
      metricsCollector.recordPacket(10.0);

      expect(metricsCollector.getPacketCount()).toBe(2);
      expect(metricsCollector.getLatencySampleCount()).toBe(2);

      metricsCollector.clearLatencySamples();

      expect(metricsCollector.getPacketCount()).toBe(2);
      expect(metricsCollector.getLatencySampleCount()).toBe(0);
    });
  });
});
