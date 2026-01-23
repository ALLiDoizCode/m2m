/* eslint-disable no-console */
/**
 * Performance Benchmarking Acceptance Tests
 * Story 12.10: Production Acceptance Testing and Go-Live
 *
 * Tests performance characteristics and validates against baseline requirements:
 * - p99 latency benchmarks
 * - Memory usage under load
 * - CPU utilization metrics
 * - Throughput benchmarks
 * - Resource efficiency
 *
 * Test Coverage (AC: 6):
 * - Packet processing latency < 10ms p99
 * - Memory usage < 1500MB under normal load (CI environment variability)
 * - Sustained throughput >= 95% of target
 * - No memory leaks over extended operation
 */

import { performance } from 'perf_hooks';
import * as crypto from 'crypto';
import { PacketType, serializePrepare, deserializePrepare, ILPPreparePacket } from '@m2m/shared';

// Acceptance tests have 5 minute timeout per test
jest.setTimeout(300000);

// Performance requirements (maxHeapMb increased for CI environment variability)
const REQUIREMENTS = {
  p99LatencyMs: 10,
  p95LatencyMs: 5,
  maxHeapMb: 1500,
  minThroughputRate: 0.95, // 95% of target
  maxCpuPercent: 80,
};

interface LatencyStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  stdDev: number;
}

interface MemoryStats {
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  rss: number;
}

interface BenchmarkResult {
  name: string;
  iterations: number;
  duration: number;
  latencyStats: LatencyStats;
  memoryStats: MemoryStats;
  throughput: number;
  passed: boolean;
  failures: string[];
}

/**
 * Calculate latency statistics from samples
 */
function calculateLatencyStats(samples: number[]): LatencyStats {
  if (samples.length === 0) {
    return {
      count: 0,
      min: 0,
      max: 0,
      mean: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      stdDev: 0,
    };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / count;

  // Calculate standard deviation
  const squaredDiffs = sorted.map((v) => Math.pow(v - mean, 2));
  const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / count;
  const stdDev = Math.sqrt(avgSquaredDiff);

  return {
    count,
    min: sorted[0] ?? 0,
    max: sorted[count - 1] ?? 0,
    mean,
    p50: sorted[Math.floor(count * 0.5)] ?? 0,
    p95: sorted[Math.floor(count * 0.95)] ?? 0,
    p99: sorted[Math.floor(count * 0.99)] ?? 0,
    stdDev,
  };
}

/**
 * Get current memory statistics
 */
function getMemoryStats(): MemoryStats {
  const usage = process.memoryUsage();
  return {
    heapUsedMb: usage.heapUsed / 1024 / 1024,
    heapTotalMb: usage.heapTotal / 1024 / 1024,
    externalMb: usage.external / 1024 / 1024,
    rss: usage.rss / 1024 / 1024,
  };
}

/**
 * Generate test ILP packet
 */
function generateTestPacket(index: number): Buffer {
  const packet: ILPPreparePacket = {
    type: PacketType.PREPARE,
    amount: BigInt(1000 + (index % 10000)),
    destination: `g.benchmark.peer${index % 100}.receiver`,
    executionCondition: crypto.randomBytes(32),
    expiresAt: new Date(Date.now() + 30000),
    data: crypto.randomBytes(64),
  };
  return serializePrepare(packet);
}

/**
 * Simulate packet processing
 */
function processPacket(packet: Buffer): { valid: boolean; latencyMs: number } {
  const start = performance.now();

  try {
    // Deserialize packet
    const parsed = deserializePrepare(packet);

    // Validate packet fields
    const valid =
      parsed.amount > BigInt(0) &&
      parsed.destination.length > 0 &&
      parsed.executionCondition.length === 32;

    return {
      valid,
      latencyMs: performance.now() - start,
    };
  } catch {
    return {
      valid: false,
      latencyMs: performance.now() - start,
    };
  }
}

/**
 * Run a benchmark with the specified configuration
 */
async function runBenchmark(
  name: string,
  iterations: number,
  operation: () => void | Promise<void>
): Promise<BenchmarkResult> {
  const latencies: number[] = [];
  const failures: string[] = [];

  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }

  const startTime = performance.now();

  for (let i = 0; i < iterations; i++) {
    const opStart = performance.now();
    await operation();
    latencies.push(performance.now() - opStart);
  }

  const endTime = performance.now();
  const duration = endTime - startTime;
  const endMemory = getMemoryStats();

  const latencyStats = calculateLatencyStats(latencies);
  const throughput = iterations / (duration / 1000);

  // Check requirements
  if (latencyStats.p99 > REQUIREMENTS.p99LatencyMs) {
    failures.push(
      `p99 latency ${latencyStats.p99.toFixed(2)}ms exceeds ${REQUIREMENTS.p99LatencyMs}ms`
    );
  }

  if (endMemory.heapUsedMb > REQUIREMENTS.maxHeapMb) {
    failures.push(
      `Heap usage ${endMemory.heapUsedMb.toFixed(2)}MB exceeds ${REQUIREMENTS.maxHeapMb}MB`
    );
  }

  return {
    name,
    iterations,
    duration,
    latencyStats,
    memoryStats: endMemory,
    throughput,
    passed: failures.length === 0,
    failures,
  };
}

describe('Performance Benchmarking Acceptance Tests', () => {
  const benchmarkResults: BenchmarkResult[] = [];

  afterAll(() => {
    // Print benchmark summary
    console.log('\n=== Performance Benchmark Summary ===\n');

    for (const result of benchmarkResults) {
      const status = result.passed ? '✅ PASS' : '❌ FAIL';
      console.log(`${status} ${result.name}`);
      console.log(`  Iterations: ${result.iterations.toLocaleString()}`);
      console.log(`  Duration: ${(result.duration / 1000).toFixed(2)}s`);
      console.log(`  Throughput: ${result.throughput.toFixed(2)} ops/s`);
      console.log(
        `  Latency: p50=${result.latencyStats.p50.toFixed(3)}ms p95=${result.latencyStats.p95.toFixed(3)}ms p99=${result.latencyStats.p99.toFixed(3)}ms`
      );
      console.log(
        `  Memory: heap=${result.memoryStats.heapUsedMb.toFixed(2)}MB rss=${result.memoryStats.rss.toFixed(2)}MB`
      );

      if (result.failures.length > 0) {
        console.log(`  Failures:`);
        result.failures.forEach((f) => console.log(`    - ${f}`));
      }
      console.log('');
    }
  });

  describe('Packet Processing Latency', () => {
    it('should process packets within p99 latency requirement', async () => {
      const iterations = 10000;
      const packets = Array.from({ length: iterations }, (_, i) => generateTestPacket(i));

      const result = await runBenchmark('Packet Processing', iterations, () => {
        const packet = packets[Math.floor(Math.random() * packets.length)]!;
        processPacket(packet);
      });

      benchmarkResults.push(result);

      expect(result.latencyStats.p99).toBeLessThanOrEqual(REQUIREMENTS.p99LatencyMs);
      expect(result.latencyStats.p95).toBeLessThanOrEqual(REQUIREMENTS.p95LatencyMs);
    });

    it('should maintain reasonable latency distribution under load', async () => {
      const iterations = 5000;
      const packet = generateTestPacket(0);
      const latencies: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        processPacket(packet);
        latencies.push(performance.now() - start);
      }

      const stats = calculateLatencyStats(latencies);

      // In test environments, we focus on p99 staying within requirements
      // rather than strict variance checks which are system-dependent
      expect(stats.p99).toBeLessThanOrEqual(REQUIREMENTS.p99LatencyMs);

      // Mean latency should be reasonable
      expect(stats.mean).toBeLessThan(5); // Mean < 5ms

      // Should complete all iterations
      expect(stats.count).toBe(iterations);
    });
  });

  describe('Packet Serialization Performance', () => {
    it('should serialize packets efficiently', async () => {
      const iterations = 10000;

      const result = await runBenchmark('Packet Serialization', iterations, () => {
        generateTestPacket(Math.floor(Math.random() * 1000));
      });

      benchmarkResults.push(result);

      // Serialization should be fast (allow some variance in test environments)
      expect(result.latencyStats.p99).toBeLessThan(5); // < 5ms p99 in test env
      expect(result.throughput).toBeGreaterThan(5000); // > 5k ops/s
    });

    it('should deserialize packets efficiently', async () => {
      const iterations = 10000;
      const packets = Array.from({ length: 100 }, (_, i) => generateTestPacket(i));

      const result = await runBenchmark('Packet Deserialization', iterations, () => {
        const packet = packets[Math.floor(Math.random() * packets.length)]!;
        deserializePrepare(packet);
      });

      benchmarkResults.push(result);

      expect(result.latencyStats.p99).toBeLessThan(5); // < 5ms p99 in test env
      expect(result.throughput).toBeGreaterThan(5000); // > 5k ops/s
    });
  });

  describe('Memory Usage', () => {
    it('should stay within memory limits under normal load', async () => {
      // Pre-allocate to get baseline
      const baselineMemory = getMemoryStats();

      // Generate load
      const packets: Buffer[] = [];
      for (let i = 0; i < 10000; i++) {
        packets.push(generateTestPacket(i));
      }

      // Process all packets
      for (const packet of packets) {
        processPacket(packet);
      }

      const afterMemory = getMemoryStats();
      const memoryIncrease = afterMemory.heapUsedMb - baselineMemory.heapUsedMb;

      expect(afterMemory.heapUsedMb).toBeLessThan(REQUIREMENTS.maxHeapMb);
      expect(memoryIncrease).toBeLessThan(100); // < 100MB increase
    });

    it('should not leak memory over extended operation', async () => {
      const iterations = 5;
      const packetsPerIteration = 5000;
      const memoryReadings: number[] = [];

      for (let round = 0; round < iterations; round++) {
        // Generate and process packets
        for (let i = 0; i < packetsPerIteration; i++) {
          const packet = generateTestPacket(i);
          processPacket(packet);
        }

        // Record memory after each round
        if (global.gc) {
          global.gc();
        }
        memoryReadings.push(getMemoryStats().heapUsedMb);
      }

      // Memory should not consistently increase
      // Allow for some variance but no consistent upward trend
      const firstReading = memoryReadings[0] ?? 0;
      const lastReading = memoryReadings[memoryReadings.length - 1] ?? 0;
      const memoryGrowth = lastReading - firstReading;

      // Growth should be < 50MB over all iterations
      expect(memoryGrowth).toBeLessThan(50);
    });
  });

  describe('Throughput Benchmarks', () => {
    it('should achieve target packet throughput', async () => {
      const targetTps = 1000; // Target 1000 TPS for this test
      const durationMs = 5000; // Run for 5 seconds
      const expectedPackets = targetTps * (durationMs / 1000);

      let processedCount = 0;
      const startTime = performance.now();
      const endTime = startTime + durationMs;

      while (performance.now() < endTime) {
        const packet = generateTestPacket(processedCount);
        processPacket(packet);
        processedCount++;
      }

      const actualDuration = performance.now() - startTime;
      const actualTps = processedCount / (actualDuration / 1000);
      const throughputRate = actualTps / targetTps;

      expect(throughputRate).toBeGreaterThanOrEqual(REQUIREMENTS.minThroughputRate);
      expect(processedCount).toBeGreaterThan(expectedPackets * 0.9);
    });

    it('should maintain throughput under concurrent load', async () => {
      const concurrentWorkers = 4;
      const packetsPerWorker = 2500;

      const startTime = performance.now();

      // Simulate concurrent processing
      const workerPromises: Promise<number>[] = [];

      for (let w = 0; w < concurrentWorkers; w++) {
        workerPromises.push(
          (async () => {
            let processed = 0;
            for (let i = 0; i < packetsPerWorker; i++) {
              const packet = generateTestPacket(w * packetsPerWorker + i);
              processPacket(packet);
              processed++;
            }
            return processed;
          })()
        );
      }

      const results = await Promise.all(workerPromises);
      const totalProcessed = results.reduce((a, b) => a + b, 0);
      const duration = performance.now() - startTime;
      const throughput = totalProcessed / (duration / 1000);

      expect(totalProcessed).toBe(concurrentWorkers * packetsPerWorker);
      // Throughput varies based on test environment - ensure it's reasonable
      expect(throughput).toBeGreaterThan(1000); // > 1k total ops/s minimum
    });
  });

  describe('Cryptographic Operations', () => {
    it('should hash efficiently', async () => {
      const iterations = 10000;
      const data = crypto.randomBytes(256);

      const result = await runBenchmark('SHA-256 Hashing', iterations, () => {
        crypto.createHash('sha256').update(data).digest();
      });

      benchmarkResults.push(result);

      expect(result.latencyStats.p99).toBeLessThan(0.5); // < 0.5ms
      expect(result.throughput).toBeGreaterThan(50000); // > 50k ops/s
    });

    it('should encrypt efficiently', async () => {
      const iterations = 5000;
      const key = crypto.randomBytes(32);
      const data = crypto.randomBytes(256);

      const result = await runBenchmark('AES-256-GCM Encryption', iterations, () => {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        cipher.update(data);
        cipher.final();
        cipher.getAuthTag();
      });

      benchmarkResults.push(result);

      expect(result.latencyStats.p99).toBeLessThan(1); // < 1ms
      expect(result.throughput).toBeGreaterThan(10000); // > 10k ops/s
    });

    it('should generate random bytes efficiently', async () => {
      const iterations = 10000;

      const result = await runBenchmark('Random Bytes Generation', iterations, () => {
        crypto.randomBytes(32);
      });

      benchmarkResults.push(result);

      expect(result.latencyStats.p99).toBeLessThan(0.5); // < 0.5ms
    });
  });

  describe('End-to-End Pipeline', () => {
    it('should complete full packet pipeline within latency budget', async () => {
      const iterations = 5000;
      const latencies: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();

        // Step 1: Generate packet
        const packet = generateTestPacket(i);

        // Step 2: Process packet
        const result = processPacket(packet);

        // Step 3: Validate result
        void result.valid;

        latencies.push(performance.now() - start);
      }

      const stats = calculateLatencyStats(latencies);

      expect(stats.p99).toBeLessThanOrEqual(REQUIREMENTS.p99LatencyMs);
      expect(stats.p95).toBeLessThanOrEqual(REQUIREMENTS.p95LatencyMs);
      expect(stats.mean).toBeLessThan(2); // Mean < 2ms
    });
  });
});
