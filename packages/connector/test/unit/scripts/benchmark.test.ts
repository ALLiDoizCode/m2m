/**
 * Unit tests for the benchmark script
 *
 * Tests TPS calculation, latency percentiles, output format,
 * and pass/fail threshold logic.
 */

import { existsSync, unlinkSync, readFileSync } from 'fs';
import {
  runBenchmark,
  calculatePercentile,
  getMemoryUsageMb,
  getCpuUsagePercent,
  BenchmarkResults,
} from '../../../scripts/benchmark';

describe('benchmark script', () => {
  const testOutputFile = 'test-benchmark-results.json';

  afterEach(() => {
    // Clean up test output file
    if (existsSync(testOutputFile)) {
      unlinkSync(testOutputFile);
    }
  });

  describe('runBenchmark', () => {
    it('should complete with valid configuration', async () => {
      const results = await runBenchmark({
        durationSeconds: 1,
        targetTps: 100,
        tpsThreshold: 50,
        outputFile: testOutputFile,
      });

      expect(results).toBeDefined();
      expect(results.timestamp).toBeDefined();
      expect(results.tps).toBeGreaterThan(0);
    }, 10000);

    it('should measure TPS correctly', async () => {
      const results = await runBenchmark({
        durationSeconds: 2,
        targetTps: 500,
        tpsThreshold: 100,
        outputFile: testOutputFile,
      });

      // TPS should be positive and reasonable
      expect(results.tps).toBeGreaterThan(0);
      // TPS should be within reasonable bounds (not infinite)
      expect(results.tps).toBeLessThan(100000);
    }, 15000);

    it('should calculate latency percentiles (p50, p99)', async () => {
      const results = await runBenchmark({
        durationSeconds: 1,
        targetTps: 100,
        tpsThreshold: 50,
        outputFile: testOutputFile,
      });

      // Latencies should be positive
      expect(results.p50LatencyMs).toBeGreaterThan(0);
      expect(results.p99LatencyMs).toBeGreaterThan(0);

      // p99 should be >= p50
      expect(results.p99LatencyMs).toBeGreaterThanOrEqual(results.p50LatencyMs);
    }, 10000);

    it('should record memory usage', async () => {
      const results = await runBenchmark({
        durationSeconds: 1,
        targetTps: 100,
        tpsThreshold: 50,
        outputFile: testOutputFile,
      });

      // Memory usage should be positive
      expect(results.memoryUsageMb).toBeGreaterThan(0);
      // Should be reasonable (not TB of memory)
      expect(results.memoryUsageMb).toBeLessThan(10000);
    }, 10000);

    it('should output JSON results file', async () => {
      await runBenchmark({
        durationSeconds: 1,
        targetTps: 100,
        tpsThreshold: 50,
        outputFile: testOutputFile,
      });

      expect(existsSync(testOutputFile)).toBe(true);

      const fileContent = readFileSync(testOutputFile, 'utf-8');
      const parsedResults: BenchmarkResults = JSON.parse(fileContent);

      expect(parsedResults.timestamp).toBeDefined();
      expect(parsedResults.tps).toBeDefined();
      expect(parsedResults.p50LatencyMs).toBeDefined();
      expect(parsedResults.p99LatencyMs).toBeDefined();
      expect(parsedResults.memoryUsageMb).toBeDefined();
      expect(parsedResults.cpuUsagePercent).toBeDefined();
      expect(parsedResults.passed).toBeDefined();
    }, 10000);

    it('should return passed=true when TPS >= threshold', async () => {
      const results = await runBenchmark({
        durationSeconds: 1,
        targetTps: 100,
        tpsThreshold: 10, // Very low threshold to ensure pass
        outputFile: testOutputFile,
      });

      expect(results.passed).toBe(true);
    }, 10000);

    it('should return passed=false when TPS < threshold', async () => {
      const results = await runBenchmark({
        durationSeconds: 1,
        targetTps: 10,
        tpsThreshold: 1000000, // Impossibly high threshold to ensure fail
        outputFile: testOutputFile,
      });

      expect(results.passed).toBe(false);
    }, 10000);

    it('should handle errors gracefully', async () => {
      // Test with invalid configuration - the function should still return results
      // even with edge case parameters
      const results = await runBenchmark({
        durationSeconds: 1,
        targetTps: 1, // Minimum TPS
        tpsThreshold: 0,
        outputFile: testOutputFile,
      });

      expect(results).toBeDefined();
      expect(results.tps).toBeGreaterThanOrEqual(0);
    }, 10000);
  });

  describe('calculatePercentile', () => {
    it('should calculate p50 correctly', () => {
      const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const p50 = calculatePercentile(values, 50);
      expect(p50).toBe(5);
    });

    it('should calculate p99 correctly', () => {
      const values = Array.from({ length: 100 }, (_, i) => i + 1);
      const p99 = calculatePercentile(values, 99);
      expect(p99).toBe(99);
    });

    it('should handle empty array', () => {
      const p50 = calculatePercentile([], 50);
      expect(p50).toBe(0);
    });

    it('should handle single element', () => {
      const p50 = calculatePercentile([42], 50);
      expect(p50).toBe(42);
    });

    it('should handle p0 and p100', () => {
      const values = [1, 2, 3, 4, 5];
      expect(calculatePercentile(values, 0)).toBe(1);
      expect(calculatePercentile(values, 100)).toBe(5);
    });
  });

  describe('getMemoryUsageMb', () => {
    it('should return positive memory value', () => {
      const memory = getMemoryUsageMb();
      expect(memory).toBeGreaterThan(0);
    });

    it('should return reasonable memory value', () => {
      const memory = getMemoryUsageMb();
      // Should be less than 10GB for a simple test
      expect(memory).toBeLessThan(10000);
    });
  });

  describe('getCpuUsagePercent', () => {
    it('should return CPU usage percentage', () => {
      const startUsage = process.cpuUsage();
      // Do some work
      let sum = 0;
      for (let i = 0; i < 1000000; i++) {
        sum += i;
      }
      const cpuPercent = getCpuUsagePercent(startUsage);

      expect(cpuPercent).toBeGreaterThanOrEqual(0);
      expect(cpuPercent).toBeLessThanOrEqual(100);
      // Use sum to prevent optimization
      expect(sum).toBeGreaterThan(0);
    });
  });

  describe('BenchmarkResults interface', () => {
    it('should have all required fields', async () => {
      const results = await runBenchmark({
        durationSeconds: 1,
        targetTps: 100,
        tpsThreshold: 50,
        outputFile: testOutputFile,
      });

      // Verify all required fields from the interface
      expect(typeof results.timestamp).toBe('string');
      expect(typeof results.commitSha).toBe('string');
      expect(typeof results.branch).toBe('string');
      expect(typeof results.tps).toBe('number');
      expect(typeof results.p99LatencyMs).toBe('number');
      expect(typeof results.p50LatencyMs).toBe('number');
      expect(typeof results.memoryUsageMb).toBe('number');
      expect(typeof results.cpuUsagePercent).toBe('number');
      expect(typeof results.passed).toBe('boolean');
    }, 10000);
  });
});
