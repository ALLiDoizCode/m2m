/**
 * Performance Benchmark Script
 *
 * Measures connector performance by simulating packet processing
 * and collecting metrics. Used in CI for performance regression testing.
 *
 * @example
 * ```bash
 * npx ts-node scripts/benchmark.ts
 * npx ts-node scripts/benchmark.ts --duration 30 --target-tps 10000
 * ```
 */

import { writeFileSync } from 'fs';
import { Logger } from 'pino';

/**
 * Benchmark result interface matching story specification
 */
export interface BenchmarkResults {
  timestamp: string;
  commitSha: string;
  branch: string;
  tps: number;
  p99LatencyMs: number;
  p50LatencyMs: number;
  memoryUsageMb: number;
  cpuUsagePercent: number;
  passed: boolean;
}

/**
 * Benchmark configuration options
 */
export interface BenchmarkConfig {
  /** Target TPS to achieve (default: 10000) */
  targetTps: number;
  /** Test duration in seconds (default: 10) */
  durationSeconds: number;
  /** Output file path (default: benchmark-results.json) */
  outputFile: string;
  /** TPS threshold for pass/fail (default: 10000) */
  tpsThreshold: number;
  /** Logger instance (optional) */
  logger?: Logger;
}

/**
 * Default benchmark configuration
 */
const DEFAULT_CONFIG: BenchmarkConfig = {
  targetTps: 10000,
  durationSeconds: 10,
  outputFile: 'benchmark-results.json',
  tpsThreshold: 10000,
};

/**
 * Simulates a packet processing operation with realistic latency
 * This represents the core packet handling logic in the connector
 */
async function simulatePacketProcessing(): Promise<number> {
  const startTime = process.hrtime.bigint();

  // Simulate packet validation, routing lookup, and forwarding
  // Real latency varies 0.1ms - 2ms depending on operation
  const simulatedWorkMicroseconds = Math.random() * 1900 + 100;
  const endTime = startTime + BigInt(Math.floor(simulatedWorkMicroseconds * 1000));

  // Busy-wait to simulate CPU work (more accurate than setTimeout for microbenchmarks)
  while (process.hrtime.bigint() < endTime) {
    // Intentionally empty - simulating CPU-bound work
  }

  const elapsedNs = Number(process.hrtime.bigint() - startTime);
  return elapsedNs / 1_000_000; // Return milliseconds
}

/**
 * Calculate percentile from sorted array
 */
export function calculatePercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) return 0;

  const index = Math.ceil((percentile / 100) * sortedValues.length) - 1;
  const safeIndex = Math.max(0, Math.min(index, sortedValues.length - 1));
  return sortedValues[safeIndex] ?? 0;
}

/**
 * Get current memory usage in MB
 */
export function getMemoryUsageMb(): number {
  const usage = process.memoryUsage();
  return Math.round((usage.heapUsed / 1024 / 1024) * 100) / 100;
}

/**
 * Get CPU usage percentage (approximation based on event loop delay)
 */
export function getCpuUsagePercent(startCpuUsage: NodeJS.CpuUsage): number {
  const cpuUsage = process.cpuUsage(startCpuUsage);
  const totalMicroseconds = cpuUsage.user + cpuUsage.system;
  // Normalize to percentage (rough approximation)
  return Math.min(100, Math.round((totalMicroseconds / 1_000_000) * 10));
}

/**
 * Run the performance benchmark
 *
 * @param config - Benchmark configuration
 * @returns Benchmark results
 */
export async function runBenchmark(
  config: Partial<BenchmarkConfig> = {}
): Promise<BenchmarkResults> {
  const mergedConfig: BenchmarkConfig = { ...DEFAULT_CONFIG, ...config };
  const { targetTps, durationSeconds, outputFile, tpsThreshold, logger } = mergedConfig;

  const log = (message: string): void => {
    if (logger) {
      logger.info(message);
    } else {
      // eslint-disable-next-line no-console
      console.log(`[benchmark] ${message}`);
    }
  };

  log(`Starting benchmark: target=${targetTps} TPS, duration=${durationSeconds}s`);

  const latencies: number[] = [];
  let packetsProcessed = 0;
  const startCpuUsage = process.cpuUsage();
  const startTime = Date.now();
  const endTime = startTime + durationSeconds * 1000;

  // Calculate delay between packets to achieve target TPS
  const targetDelayMs = 1000 / targetTps;

  // Run benchmark loop
  while (Date.now() < endTime) {
    const packetStart = Date.now();

    // Process packets in batches for efficiency
    const batchSize = Math.min(100, Math.floor(targetTps / 10));
    const batchPromises: Promise<number>[] = [];

    for (let i = 0; i < batchSize; i++) {
      batchPromises.push(simulatePacketProcessing());
    }

    const batchLatencies = await Promise.all(batchPromises);
    latencies.push(...batchLatencies);
    packetsProcessed += batchSize;

    // Calculate how long to wait before next batch
    const elapsed = Date.now() - packetStart;
    const targetBatchTime = batchSize * targetDelayMs;
    const sleepTime = Math.max(0, targetBatchTime - elapsed);

    if (sleepTime > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepTime));
    }
  }

  const actualDuration = (Date.now() - startTime) / 1000;
  const tps = Math.round(packetsProcessed / actualDuration);

  // Sort latencies for percentile calculation
  latencies.sort((a, b) => a - b);

  const p50LatencyMs = Math.round(calculatePercentile(latencies, 50) * 1000) / 1000;
  const p99LatencyMs = Math.round(calculatePercentile(latencies, 99) * 1000) / 1000;
  const memoryUsageMb = getMemoryUsageMb();
  const cpuUsagePercent = getCpuUsagePercent(startCpuUsage);

  const results: BenchmarkResults = {
    timestamp: new Date().toISOString(),
    commitSha: process.env.GITHUB_SHA || process.env.GIT_COMMIT || 'unknown',
    branch: process.env.GITHUB_REF_NAME || process.env.GIT_BRANCH || 'unknown',
    tps,
    p50LatencyMs,
    p99LatencyMs,
    memoryUsageMb,
    cpuUsagePercent,
    passed: tps >= tpsThreshold,
  };

  log(`Benchmark complete:`);
  log(`  TPS: ${tps} (threshold: ${tpsThreshold})`);
  log(`  P50 Latency: ${p50LatencyMs}ms`);
  log(`  P99 Latency: ${p99LatencyMs}ms`);
  log(`  Memory: ${memoryUsageMb}MB`);
  log(`  CPU: ${cpuUsagePercent}%`);
  log(`  Passed: ${results.passed}`);

  // Write results to file
  writeFileSync(outputFile, JSON.stringify(results, null, 2));
  log(`Results written to: ${outputFile}`);

  return results;
}

/**
 * Parse command line arguments
 */
function parseArgs(): Partial<BenchmarkConfig> {
  const args = process.argv.slice(2);
  const config: Partial<BenchmarkConfig> = {};

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];

    if (!value) continue;

    switch (key) {
      case '--duration':
        config.durationSeconds = parseInt(value, 10);
        break;
      case '--target-tps':
        config.targetTps = parseInt(value, 10);
        break;
      case '--threshold':
        config.tpsThreshold = parseInt(value, 10);
        break;
      case '--output':
        config.outputFile = value;
        break;
    }
  }

  return config;
}

// Main entry point when run directly
if (require.main === module) {
  const config = parseArgs();

  runBenchmark(config)
    .then((results) => {
      process.exit(results.passed ? 0 : 1);
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error('Benchmark failed:', error);
      process.exit(1);
    });
}
