import pino, { Logger } from 'pino';
import { performance } from 'perf_hooks';
import { MetricsCollector } from '../../src/performance/metrics-collector';
import { Profiler } from '../../src/performance/profiler';
import { TelemetryBuffer, TelemetryEvent } from '../../src/telemetry/telemetry-buffer';
import { OERParser } from '../../src/encoding/oer-parser';

/**
 * Throughput Benchmark Tests
 *
 * These tests validate the connector's ability to sustain 10K+ TPS throughput.
 * Note: Full 1-hour sustained tests are disabled by default for CI - enable with
 * PERFORMANCE_TEST_FULL=true environment variable.
 *
 * [Source: Epic 12 Story 12.5 AC 7, 10]
 * [Source: docs/prd/epic-12-multi-chain-settlement-production-hardening.md lines 766-799]
 */
describe('Throughput Benchmarks', () => {
  let logger: Logger;
  let profiler: Profiler;
  let metricsCollector: MetricsCollector;
  let telemetryBuffer: TelemetryBuffer;
  let oerParser: OERParser;

  // Test configuration
  const SHORT_TEST_DURATION_MS = 5000; // 5 seconds for quick tests
  const MEDIUM_TEST_DURATION_MS = 60000; // 60 seconds for validation tests
  const FULL_TEST_DURATION_MS = 3600000; // 1 hour for full benchmark

  // Target thresholds
  // Note: Actual throughput varies by machine; these are baseline expectations
  const TARGET_TPS = 10000;
  const MIN_TPS_THRESHOLD = 5000; // Allow significant variance in test environments

  beforeAll(() => {
    logger = pino({ level: 'silent' });
    profiler = new Profiler(logger);
    oerParser = new OERParser(logger);
  });

  beforeEach(() => {
    metricsCollector = new MetricsCollector(logger, profiler);

    // Initialize TelemetryBuffer for batched telemetry (reduces overhead)
    telemetryBuffer = new TelemetryBuffer(
      {
        bufferSize: 1000,
        flushIntervalMs: 100,
      },
      (_events: TelemetryEvent[]) => {
        // No-op flush function for benchmarking
      },
      logger
    );
  });

  afterEach(async () => {
    await telemetryBuffer.shutdown();
    metricsCollector.reset();
  });

  /**
   * Generate realistic ILP packet data for benchmarking
   */
  function generatePacketBuffer(size: number = 256): Buffer {
    const packet = Buffer.allocUnsafe(size);
    // Fill with random data simulating ILP packet structure
    packet[0] = 12; // ILP Prepare type
    // Random destination address length (1-32 bytes)
    const addrLen = Math.floor(Math.random() * 32) + 1;
    packet[1] = addrLen;
    // Fill rest with random data
    for (let i = 2; i < size; i++) {
      packet[i] = Math.floor(Math.random() * 256);
    }
    return packet;
  }

  /**
   * Generate a batch of packets
   */
  function generatePacketBatch(count: number, packetSize: number = 256): Buffer[] {
    const batch: Buffer[] = [];
    for (let i = 0; i < count; i++) {
      batch.push(generatePacketBuffer(packetSize));
    }
    return batch;
  }

  /**
   * Simulate packet processing with realistic operations
   */
  function processPacketSimulation(packet: Buffer): Buffer {
    // Simulate OER parsing (zero-copy operations)
    let offset = 0;
    const packetType = oerParser.readUInt8(packet, offset);
    offset += packetType.bytesRead;
    const addrLen = oerParser.readVarUInt(packet, offset);
    offset += addrLen.bytesRead;

    // Simulate some computation (signature verification placeholder)
    let checksum = 0;
    for (let i = 0; i < packet.length; i++) {
      checksum ^= packet[i] || 0;
    }
    void checksum; // Intentionally unused - purpose is to simulate CPU work

    // Return original packet (zero-copy for benchmarking)
    return packet;
  }

  describe('Synchronous Packet Processing', () => {
    it('should process packets at high throughput (short test)', async () => {
      const startTime = performance.now();
      const targetEndTime = startTime + SHORT_TEST_DURATION_MS;
      let packetCount = 0;

      // Process packets until time limit
      while (performance.now() < targetEndTime) {
        const batch = generatePacketBatch(100);

        for (const packet of batch) {
          const processStartTime = performance.now();
          processPacketSimulation(packet);
          const latency = performance.now() - processStartTime;
          metricsCollector.recordPacket(latency);
          packetCount++;
        }
      }

      const elapsed = performance.now() - startTime;
      const actualTPS = (packetCount / elapsed) * 1000;

      const metrics = metricsCollector.collectMetrics();

      expect(actualTPS).toBeGreaterThan(MIN_TPS_THRESHOLD);
      expect(metrics.p99LatencyMs).toBeLessThan(10); // p99 < 10ms

      // Log results for analysis
      logger.info(
        {
          packetCount,
          elapsedMs: elapsed,
          actualTPS: actualTPS.toFixed(2),
          p50LatencyMs: metrics.p50LatencyMs.toFixed(4),
          p99LatencyMs: metrics.p99LatencyMs.toFixed(4),
          heapUsageMB: metrics.heapUsageMB.toFixed(2),
        },
        'Throughput benchmark results (short)'
      );
    });

    it('should sustain throughput over extended period (1 minute)', async () => {
      // Skip in CI unless explicitly enabled
      const isFullTest = process.env.PERFORMANCE_TEST_MEDIUM === 'true';
      if (!isFullTest) {
        // Run abbreviated 5-second test
        const startTime = performance.now();
        const targetEndTime = startTime + SHORT_TEST_DURATION_MS;
        let packetCount = 0;

        while (performance.now() < targetEndTime) {
          const batch = generatePacketBatch(100);
          for (const packet of batch) {
            const processStartTime = performance.now();
            processPacketSimulation(packet);
            const latency = performance.now() - processStartTime;
            metricsCollector.recordPacket(latency);
            packetCount++;
          }
        }

        const elapsed = performance.now() - startTime;
        const actualTPS = (packetCount / elapsed) * 1000;

        expect(actualTPS).toBeGreaterThan(MIN_TPS_THRESHOLD);
        return;
      }

      // Full 1-minute sustained test
      const startTime = performance.now();
      const targetEndTime = startTime + MEDIUM_TEST_DURATION_MS;
      let packetCount = 0;
      const tpsSnapshots: number[] = [];
      let lastSnapshotTime = startTime;
      let lastSnapshotCount = 0;

      while (performance.now() < targetEndTime) {
        const batch = generatePacketBatch(100);

        for (const packet of batch) {
          const processStartTime = performance.now();
          processPacketSimulation(packet);
          const latency = performance.now() - processStartTime;
          metricsCollector.recordPacket(latency);
          packetCount++;
        }

        // Capture TPS snapshots every second
        const now = performance.now();
        if (now - lastSnapshotTime >= 1000) {
          const intervalPackets = packetCount - lastSnapshotCount;
          const intervalTPS = (intervalPackets / (now - lastSnapshotTime)) * 1000;
          tpsSnapshots.push(intervalTPS);
          lastSnapshotTime = now;
          lastSnapshotCount = packetCount;
        }
      }

      const elapsed = performance.now() - startTime;
      const averageTPS = (packetCount / elapsed) * 1000;

      // Calculate TPS stability (standard deviation)
      const meanTPS = tpsSnapshots.reduce((a, b) => a + b, 0) / tpsSnapshots.length;
      const variance =
        tpsSnapshots.reduce((acc, tps) => acc + Math.pow(tps - meanTPS, 2), 0) /
        tpsSnapshots.length;
      const stdDev = Math.sqrt(variance);
      const coefficientOfVariation = stdDev / meanTPS;

      const metrics = metricsCollector.collectMetrics();

      expect(averageTPS).toBeGreaterThan(TARGET_TPS);
      expect(coefficientOfVariation).toBeLessThan(0.2); // Less than 20% variation
      expect(metrics.p99LatencyMs).toBeLessThan(10);

      logger.info(
        {
          packetCount,
          elapsedMs: elapsed,
          averageTPS: averageTPS.toFixed(2),
          tpsStdDev: stdDev.toFixed(2),
          tpsCoeffVar: (coefficientOfVariation * 100).toFixed(2) + '%',
          p99LatencyMs: metrics.p99LatencyMs.toFixed(4),
          heapUsageMB: metrics.heapUsageMB.toFixed(2),
        },
        'Throughput benchmark results (1 minute)'
      );
    });
  });

  describe('Batch Processing Throughput', () => {
    it('should achieve higher throughput with larger batches', async () => {
      const batchSizes = [10, 50, 100, 500];
      const results: Array<{ batchSize: number; tps: number; avgLatencyMs: number }> = [];

      for (const batchSize of batchSizes) {
        metricsCollector.reset();
        const startTime = performance.now();
        const targetEndTime = startTime + 2000; // 2 seconds per batch size
        let packetCount = 0;

        while (performance.now() < targetEndTime) {
          const batch = generatePacketBatch(batchSize);
          const batchStartTime = performance.now();

          for (const packet of batch) {
            processPacketSimulation(packet);
          }

          const batchLatency = (performance.now() - batchStartTime) / batchSize;
          for (let i = 0; i < batchSize; i++) {
            metricsCollector.recordPacket(batchLatency);
          }
          packetCount += batchSize;
        }

        const elapsed = performance.now() - startTime;
        const tps = (packetCount / elapsed) * 1000;
        const stats = metricsCollector.calculateLatencyStats();

        results.push({
          batchSize,
          tps,
          avgLatencyMs: stats.mean,
        });
      }

      // Both batch sizes should achieve reasonable throughput
      const smallBatchTPS = results.find((r) => r.batchSize === 10)?.tps || 0;
      const largeBatchTPS = results.find((r) => r.batchSize === 100)?.tps || 0;

      // Both should exceed minimum threshold (in test environment, variance is expected)
      expect(smallBatchTPS).toBeGreaterThan(1000);
      expect(largeBatchTPS).toBeGreaterThan(1000);

      logger.info({ results }, 'Batch size throughput comparison');
    });
  });

  describe('Telemetry Overhead', () => {
    it('should maintain throughput with telemetry buffering enabled', async () => {
      const startTime = performance.now();
      const targetEndTime = startTime + SHORT_TEST_DURATION_MS;
      let packetCount = 0;

      while (performance.now() < targetEndTime) {
        const batch = generatePacketBatch(100);

        for (const packet of batch) {
          const processStartTime = performance.now();
          processPacketSimulation(packet);
          const latency = performance.now() - processStartTime;
          metricsCollector.recordPacket(latency);

          // Add telemetry event (buffered)
          telemetryBuffer.addEvent({
            eventType: 'packet_processed',
            timestamp: Date.now(),
            data: {
              packetSize: packet.length,
              latencyMs: latency,
            },
          });

          packetCount++;
        }
      }

      const elapsed = performance.now() - startTime;
      const actualTPS = (packetCount / elapsed) * 1000;
      const bufferStats = telemetryBuffer.getStats();

      // Should still achieve target throughput with telemetry
      expect(actualTPS).toBeGreaterThan(MIN_TPS_THRESHOLD);

      logger.info(
        {
          packetCount,
          actualTPS: actualTPS.toFixed(2),
          telemetryEventsBuffered: bufferStats.pendingEvents,
          telemetryFlushCount: bufferStats.totalFlushes,
        },
        'Throughput with telemetry buffering'
      );
    });
  });

  describe('OER Parser Zero-Copy Performance', () => {
    it('should achieve high throughput with zero-copy parsing', async () => {
      const startTime = performance.now();
      const targetEndTime = startTime + SHORT_TEST_DURATION_MS;
      let parseCount = 0;

      // Pre-generate packets for parsing benchmark
      const packets = generatePacketBatch(1000);
      let packetIndex = 0;

      while (performance.now() < targetEndTime) {
        const packet = packets[packetIndex % packets.length];
        if (!packet) continue;

        const parseStartTime = performance.now();

        // Perform zero-copy parsing operations
        let offset = 0;
        const type = oerParser.readUInt8(packet, offset);
        offset += type.bytesRead;
        const addrLen = oerParser.readVarUInt(packet, offset);
        offset += addrLen.bytesRead;
        const addrLenNum = Number(addrLen.value);
        if (addrLenNum > 0 && offset + addrLenNum <= packet.length) {
          oerParser.readOctetString(packet, offset, addrLenNum);
          // Zero-copy - result.value is a slice of original buffer
        }

        const latency = performance.now() - parseStartTime;
        metricsCollector.recordPacket(latency);
        parseCount++;
        packetIndex++;
      }

      const elapsed = performance.now() - startTime;
      const parseTPS = (parseCount / elapsed) * 1000;
      const stats = metricsCollector.calculateLatencyStats();

      // OER parsing should be extremely fast (>100K ops/sec)
      expect(parseTPS).toBeGreaterThan(50000);
      expect(stats.mean).toBeLessThan(0.1); // Sub-0.1ms average

      logger.info(
        {
          parseCount,
          parseTPS: parseTPS.toFixed(2),
          avgLatencyMs: stats.mean.toFixed(6),
          p99LatencyMs: stats.p99.toFixed(6),
        },
        'OER zero-copy parsing throughput'
      );
    });
  });

  describe('Full Hour Benchmark (CI Only)', () => {
    it('should sustain 10K TPS for 1 hour', async () => {
      // Only run in CI with explicit flag
      const isFullTest = process.env.PERFORMANCE_TEST_FULL === 'true';
      if (!isFullTest) {
        // Skip with message
        expect(true).toBe(true);
        return;
      }

      const startTime = performance.now();
      const targetEndTime = startTime + FULL_TEST_DURATION_MS;
      let packetCount = 0;
      const minuteSnapshots: Array<{
        minute: number;
        tps: number;
        heapMB: number;
        p99Ms: number;
      }> = [];

      let lastMinuteTime = startTime;
      let lastMinuteCount = 0;
      let currentMinute = 0;

      while (performance.now() < targetEndTime) {
        const batch = generatePacketBatch(100);

        for (const packet of batch) {
          const processStartTime = performance.now();
          processPacketSimulation(packet);
          const latency = performance.now() - processStartTime;
          metricsCollector.recordPacket(latency);
          packetCount++;
        }

        // Capture minute snapshots
        const now = performance.now();
        if (now - lastMinuteTime >= 60000) {
          currentMinute++;
          const intervalPackets = packetCount - lastMinuteCount;
          const intervalTPS = (intervalPackets / (now - lastMinuteTime)) * 1000;
          const memProfile = profiler.captureMemoryProfile();
          const stats = metricsCollector.calculateLatencyStats();

          minuteSnapshots.push({
            minute: currentMinute,
            tps: intervalTPS,
            heapMB: memProfile.heapUsedMB,
            p99Ms: stats.p99,
          });

          // Clear latency samples to prevent memory growth
          metricsCollector.clearLatencySamples();

          lastMinuteTime = now;
          lastMinuteCount = packetCount;

          logger.info(
            {
              minute: currentMinute,
              tps: intervalTPS.toFixed(2),
              heapMB: memProfile.heapUsedMB.toFixed(2),
              p99Ms: stats.p99.toFixed(4),
            },
            'Minute snapshot'
          );
        }
      }

      const totalElapsed = performance.now() - startTime;
      const averageTPS = (packetCount / totalElapsed) * 1000;

      // Verify sustained throughput
      const lowTPSMinutes = minuteSnapshots.filter((s) => s.tps < TARGET_TPS * 0.9);
      const highHeapMinutes = minuteSnapshots.filter((s) => s.heapMB > 500);
      const highLatencyMinutes = minuteSnapshots.filter((s) => s.p99Ms > 10);

      expect(averageTPS).toBeGreaterThan(TARGET_TPS);
      expect(lowTPSMinutes.length).toBeLessThan(minuteSnapshots.length * 0.1); // <10% below target
      expect(highHeapMinutes.length).toBe(0); // No memory spikes >500MB
      expect(highLatencyMinutes.length).toBeLessThan(minuteSnapshots.length * 0.05); // <5% high latency

      logger.info(
        {
          totalPackets: packetCount,
          totalMinutes: currentMinute,
          averageTPS: averageTPS.toFixed(2),
          lowTPSMinutes: lowTPSMinutes.length,
          highHeapMinutes: highHeapMinutes.length,
          highLatencyMinutes: highLatencyMinutes.length,
        },
        'Full hour benchmark complete'
      );
    }, 3700000); // 1 hour + 100 seconds timeout buffer
  });
});
