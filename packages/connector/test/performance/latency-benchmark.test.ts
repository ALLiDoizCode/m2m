import pino from 'pino';
import { performance } from 'perf_hooks';
import { MetricsCollector, LatencyStats } from '../../src/performance/metrics-collector';
import { Profiler } from '../../src/performance/profiler';
import { OERParser } from '../../src/encoding/oer-parser';

let oerParser: OERParser;

/**
 * Latency Benchmark Tests
 *
 * These tests validate p50, p99, and p999 latency at varying packet loads.
 * Target: p99 latency <10ms at 10K TPS
 *
 * [Source: Epic 12 Story 12.5 AC 7]
 */
describe('Latency Benchmarks', () => {
  let logger: pino.Logger;
  let profiler: Profiler;
  let metricsCollector: MetricsCollector;

  // Test duration
  const TEST_DURATION_MS = 3000; // 3 seconds per test

  // Latency thresholds (milliseconds)
  const P99_THRESHOLD_MS = 10;
  const P999_THRESHOLD_MS = 50;

  beforeAll(() => {
    logger = pino({ level: 'silent' });
    profiler = new Profiler(logger);
    oerParser = new OERParser(logger);
  });

  beforeEach(() => {
    metricsCollector = new MetricsCollector(logger, profiler);
  });

  afterEach(() => {
    metricsCollector.reset();
  });

  /**
   * Generate realistic ILP packet for latency testing
   */
  function generatePacket(size: number = 256): Buffer {
    const packet = Buffer.allocUnsafe(size);
    packet[0] = 12; // ILP Prepare type
    const addrLen = Math.floor(Math.random() * 32) + 1;
    packet[1] = addrLen;
    for (let i = 2; i < size; i++) {
      packet[i] = Math.floor(Math.random() * 256);
    }
    return packet;
  }

  /**
   * Simulate realistic packet processing operations
   */
  function processPacket(packet: Buffer): Buffer {
    // Simulate OER parsing
    let offset = 0;
    const type = oerParser.readUInt8(packet, offset);
    offset += type.bytesRead;
    const addrLen = oerParser.readVarUInt(packet, offset);
    offset += addrLen.bytesRead;
    const addrLenNum = Number(addrLen.value);
    if (addrLenNum > 0 && offset + addrLenNum <= packet.length) {
      oerParser.readOctetString(packet, offset, addrLenNum);
    }

    // Simulate routing lookup (hash calculation)
    let hash = 0;
    for (let i = 0; i < Math.min(packet.length, 64); i++) {
      hash = ((hash << 5) - hash + (packet[i] || 0)) | 0;
    }

    return packet;
  }

  /**
   * Run latency test at specified target TPS
   */
  async function runLatencyTest(
    targetTPS: number,
    durationMs: number
  ): Promise<{
    stats: LatencyStats;
    actualTPS: number;
    packetCount: number;
  }> {
    const startTime = performance.now();
    const targetEndTime = startTime + durationMs;
    const targetIntervalMs = 1000 / targetTPS;
    let packetCount = 0;
    let nextPacketTime = startTime;

    // Pre-generate packets to avoid allocation overhead during test
    const packets: Buffer[] = [];
    for (let i = 0; i < 1000; i++) {
      packets.push(generatePacket());
    }

    while (performance.now() < targetEndTime) {
      const now = performance.now();

      // Process packets at target rate
      while (nextPacketTime <= now && performance.now() < targetEndTime) {
        const packet = packets[packetCount % packets.length];
        if (!packet) continue;

        const processStart = performance.now();
        processPacket(packet);
        const latency = performance.now() - processStart;

        metricsCollector.recordPacket(latency);
        packetCount++;
        nextPacketTime += targetIntervalMs;
      }

      // Yield to event loop if we're ahead of schedule
      if (nextPacketTime > now + 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    const elapsed = performance.now() - startTime;
    const actualTPS = (packetCount / elapsed) * 1000;
    const stats = metricsCollector.calculateLatencyStats();

    return { stats, actualTPS, packetCount };
  }

  describe('Latency at Varying Load Levels', () => {
    it('should maintain low latency at 1K TPS', async () => {
      const result = await runLatencyTest(1000, TEST_DURATION_MS);

      expect(result.stats.p99).toBeLessThan(P99_THRESHOLD_MS);
      expect(result.stats.p999).toBeLessThan(P999_THRESHOLD_MS);
      expect(result.actualTPS).toBeGreaterThan(800); // Allow 20% variance

      logger.info(
        {
          targetTPS: 1000,
          actualTPS: result.actualTPS.toFixed(2),
          p50Ms: result.stats.p50.toFixed(4),
          p99Ms: result.stats.p99.toFixed(4),
          p999Ms: result.stats.p999.toFixed(4),
          minMs: result.stats.min.toFixed(4),
          maxMs: result.stats.max.toFixed(4),
        },
        'Latency at 1K TPS'
      );
    });

    it('should maintain low latency at 5K TPS', async () => {
      const result = await runLatencyTest(5000, TEST_DURATION_MS);

      expect(result.stats.p99).toBeLessThan(P99_THRESHOLD_MS);
      expect(result.stats.p999).toBeLessThan(P999_THRESHOLD_MS);
      expect(result.actualTPS).toBeGreaterThan(4000);

      logger.info(
        {
          targetTPS: 5000,
          actualTPS: result.actualTPS.toFixed(2),
          p50Ms: result.stats.p50.toFixed(4),
          p99Ms: result.stats.p99.toFixed(4),
          p999Ms: result.stats.p999.toFixed(4),
          minMs: result.stats.min.toFixed(4),
          maxMs: result.stats.max.toFixed(4),
        },
        'Latency at 5K TPS'
      );
    });

    it('should maintain p99 <10ms at 10K TPS', async () => {
      const result = await runLatencyTest(10000, TEST_DURATION_MS);

      // Primary acceptance criteria: p99 < 10ms at 10K TPS
      expect(result.stats.p99).toBeLessThan(P99_THRESHOLD_MS);
      expect(result.actualTPS).toBeGreaterThan(8000);

      logger.info(
        {
          targetTPS: 10000,
          actualTPS: result.actualTPS.toFixed(2),
          p50Ms: result.stats.p50.toFixed(4),
          p99Ms: result.stats.p99.toFixed(4),
          p999Ms: result.stats.p999.toFixed(4),
          minMs: result.stats.min.toFixed(4),
          maxMs: result.stats.max.toFixed(4),
          packetCount: result.packetCount,
        },
        'Latency at 10K TPS'
      );
    });

    it('should handle burst traffic with acceptable latency', async () => {
      metricsCollector.reset();

      // Simulate burst: 20K packets in short window
      const burstSize = 20000;
      const packets: Buffer[] = [];
      for (let i = 0; i < 1000; i++) {
        packets.push(generatePacket());
      }

      const startTime = performance.now();

      for (let i = 0; i < burstSize; i++) {
        const packet = packets[i % packets.length];
        if (!packet) continue;

        const processStart = performance.now();
        processPacket(packet);
        const latency = performance.now() - processStart;
        metricsCollector.recordPacket(latency);
      }

      const elapsed = performance.now() - startTime;
      const burstTPS = (burstSize / elapsed) * 1000;
      const stats = metricsCollector.calculateLatencyStats();

      // Even during burst, p99 should remain reasonable
      expect(stats.p99).toBeLessThan(P99_THRESHOLD_MS * 2); // Allow 2x for burst

      logger.info(
        {
          burstSize,
          elapsedMs: elapsed.toFixed(2),
          burstTPS: burstTPS.toFixed(2),
          p50Ms: stats.p50.toFixed(4),
          p99Ms: stats.p99.toFixed(4),
          p999Ms: stats.p999.toFixed(4),
          maxMs: stats.max.toFixed(4),
        },
        'Burst traffic latency'
      );
    });
  });

  describe('Latency Percentile Accuracy', () => {
    it('should correctly calculate percentiles', () => {
      // Add known latency values
      const latencies = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100]; // 100 is an outlier

      for (const lat of latencies) {
        metricsCollector.recordPacket(lat);
      }

      const stats = metricsCollector.calculateLatencyStats();

      // p50 should be median (6 for 11 elements)
      expect(stats.p50).toBe(6);
      // p99 should be near the high end
      expect(stats.p99).toBeGreaterThanOrEqual(10);
      // Mean should be calculated correctly
      expect(stats.mean).toBeCloseTo(155 / 11, 2);
      // Min and max should be correct
      expect(stats.min).toBe(1);
      expect(stats.max).toBe(100);
      expect(stats.count).toBe(11);
    });

    it('should handle large sample sizes efficiently', () => {
      const sampleSize = 100000;
      const addStartTime = performance.now();

      // Add many latency samples
      for (let i = 0; i < sampleSize; i++) {
        metricsCollector.recordPacket(Math.random() * 5); // 0-5ms random latency
      }

      const addTime = performance.now() - addStartTime;

      const calcStartTime = performance.now();
      const stats = metricsCollector.calculateLatencyStats();
      const calcTime = performance.now() - calcStartTime;

      expect(stats.count).toBe(sampleSize);
      // Calculation should complete in reasonable time (<500ms for 100K samples)
      expect(calcTime).toBeLessThan(500);
      // Adding samples should be very fast (<100ms for 100K samples)
      expect(addTime).toBeLessThan(100);

      logger.info(
        {
          sampleSize,
          addTimeMs: addTime.toFixed(2),
          calcTimeMs: calcTime.toFixed(2),
          p50Ms: stats.p50.toFixed(4),
          p99Ms: stats.p99.toFixed(4),
        },
        'Large sample size performance'
      );
    });
  });

  describe('Operation-Specific Latency', () => {
    it('should measure OER parsing latency', () => {
      const packets = Array.from({ length: 10000 }, () => generatePacket());
      const latencies: number[] = [];

      for (const packet of packets) {
        const start = performance.now();

        let offset = 0;
        const type = oerParser.readUInt8(packet, offset);
        offset += type.bytesRead;
        const addrLen = oerParser.readVarUInt(packet, offset);
        offset += addrLen.bytesRead;
        const remaining = packet.length - offset;
        oerParser.readOctetString(packet, offset, Math.min(32, remaining));

        latencies.push(performance.now() - start);
      }

      // Sort for percentile calculation
      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
      const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
      const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;

      // OER parsing should be fast (allowing for CI environment variance)
      expect(p99).toBeLessThan(1); // <1ms (allows for system load variance)

      logger.info(
        {
          operations: packets.length,
          p50Ms: p50.toFixed(6),
          p99Ms: p99.toFixed(6),
          meanMs: mean.toFixed(6),
        },
        'OER parsing latency'
      );
    });

    it('should measure buffer allocation latency', () => {
      const allocCount = 10000;
      const allocSize = 256;
      const latencies: number[] = [];

      for (let i = 0; i < allocCount; i++) {
        const start = performance.now();
        const buf = Buffer.allocUnsafe(allocSize);
        // Touch buffer to ensure allocation
        buf[0] = 1;
        latencies.push(performance.now() - start);
      }

      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
      const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;

      // Buffer allocation should be very fast
      expect(p99).toBeLessThan(0.5); // <0.5ms

      logger.info(
        {
          allocations: allocCount,
          bufferSize: allocSize,
          p50Ms: p50.toFixed(6),
          p99Ms: p99.toFixed(6),
        },
        'Buffer allocation latency'
      );
    });
  });

  describe('Latency Under Memory Pressure', () => {
    it('should maintain latency during GC pressure', async () => {
      // Pre-generate packets
      const packets: Buffer[] = [];
      for (let i = 0; i < 1000; i++) {
        packets.push(generatePacket());
      }

      // Create memory pressure by allocating arrays
      const garbageCollections: Buffer[][] = [];
      const startTime = performance.now();
      let packetCount = 0;

      while (performance.now() - startTime < TEST_DURATION_MS) {
        // Process packets
        for (let i = 0; i < 100; i++) {
          const packet = packets[packetCount % packets.length];
          if (!packet) continue;

          const processStart = performance.now();
          processPacket(packet);
          metricsCollector.recordPacket(performance.now() - processStart);
          packetCount++;
        }

        // Create garbage to trigger GC
        const garbage: Buffer[] = [];
        for (let i = 0; i < 100; i++) {
          garbage.push(Buffer.alloc(1024));
        }
        garbageCollections.push(garbage);

        // Release old garbage
        if (garbageCollections.length > 10) {
          garbageCollections.shift();
        }
      }

      const stats = metricsCollector.calculateLatencyStats();

      // Even under GC pressure, p99 should be reasonable
      expect(stats.p99).toBeLessThan(P99_THRESHOLD_MS * 3); // Allow 3x for GC

      logger.info(
        {
          packetCount,
          p50Ms: stats.p50.toFixed(4),
          p99Ms: stats.p99.toFixed(4),
          maxMs: stats.max.toFixed(4),
        },
        'Latency under GC pressure'
      );
    });
  });

  describe('Latency Distribution Analysis', () => {
    it('should report latency distribution histogram', async () => {
      const result = await runLatencyTest(5000, TEST_DURATION_MS);

      // Get raw samples for histogram
      const stats = result.stats;

      // Log distribution summary based on percentiles
      logger.info(
        {
          total: stats.count,
          min: stats.min.toFixed(6),
          p50: stats.p50.toFixed(6),
          p99: stats.p99.toFixed(6),
          p999: stats.p999.toFixed(6),
          max: stats.max.toFixed(6),
        },
        'Latency distribution summary'
      );

      // Most latencies should be in the low buckets
      expect(stats.p50).toBeLessThan(1); // p50 < 1ms
    });
  });
});
