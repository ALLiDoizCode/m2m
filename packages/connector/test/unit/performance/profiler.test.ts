import pino from 'pino';
import { Profiler } from '../../../src/performance/profiler';

describe('Profiler', () => {
  let logger: pino.Logger;
  let profiler: Profiler;

  beforeEach(() => {
    logger = pino({ level: 'silent' });
    profiler = new Profiler(logger);
  });

  afterEach(() => {
    profiler.clearLatencyMeasurements();
  });

  describe('CPU Profiling', () => {
    it('should start and stop CPU profiling successfully', () => {
      profiler.startCPUProfile();

      // Simulate some CPU work
      let sum = 0;
      for (let i = 0; i < 1000000; i++) {
        sum += i;
      }
      void sum; // Intentionally unused - purpose is CPU work

      const profile = profiler.stopCPUProfile();

      expect(profile).toHaveProperty('startTime');
      expect(profile).toHaveProperty('endTime');
      expect(profile).toHaveProperty('durationMs');
      expect(profile).toHaveProperty('userCPUTime');
      expect(profile).toHaveProperty('systemCPUTime');
      expect(profile.durationMs).toBeGreaterThan(0);
      expect(profile.endTime).toBeGreaterThan(profile.startTime);
    });

    it('should throw error when stopping CPU profile without starting', () => {
      expect(() => profiler.stopCPUProfile()).toThrow('CPU profiling not started');
    });

    it('should allow multiple CPU profiling sessions', () => {
      profiler.startCPUProfile();
      const profile1 = profiler.stopCPUProfile();

      profiler.startCPUProfile();
      const profile2 = profiler.stopCPUProfile();

      expect(profile1).toBeDefined();
      expect(profile2).toBeDefined();
    });
  });

  describe('Memory Profiling', () => {
    it('should capture memory profile snapshot', () => {
      const profile = profiler.captureMemoryProfile();

      expect(profile).toHaveProperty('timestamp');
      expect(profile).toHaveProperty('heapUsedMB');
      expect(profile).toHaveProperty('heapTotalMB');
      expect(profile).toHaveProperty('rssMB');
      expect(profile).toHaveProperty('externalMB');
      expect(profile).toHaveProperty('arrayBuffersMB');

      expect(profile.heapUsedMB).toBeGreaterThan(0);
      expect(profile.heapTotalMB).toBeGreaterThan(0);
      expect(profile.rssMB).toBeGreaterThan(0);
      expect(profile.timestamp).toBeGreaterThan(0);
    });

    it('should capture multiple memory snapshots', () => {
      const profile1 = profiler.captureMemoryProfile();
      const profile2 = profiler.captureMemoryProfile();

      expect(profile1.timestamp).toBeLessThanOrEqual(profile2.timestamp);
    });
  });

  describe('Latency Measurements', () => {
    it('should measure latency for an operation', async () => {
      const operationId = 'test-op-1';

      profiler.startLatencyMeasurement(operationId);

      // Simulate some async work
      await new Promise((resolve) => setTimeout(resolve, 10));

      const duration = profiler.endLatencyMeasurement(operationId);

      // Allow slight timing variance due to timer resolution
      expect(duration).toBeGreaterThanOrEqual(8);
      expect(duration).toBeLessThan(50); // Should complete quickly
    });

    it('should throw error for non-existent measurement', () => {
      expect(() => profiler.endLatencyMeasurement('non-existent')).toThrow(
        'No latency measurement found for operation: non-existent'
      );
    });

    it('should track multiple concurrent measurements', async () => {
      profiler.startLatencyMeasurement('op1');
      profiler.startLatencyMeasurement('op2');

      expect(profiler.getActiveMeasurementCount()).toBe(2);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const duration1 = profiler.endLatencyMeasurement('op1');
      // Allow slight timing variance due to timer resolution
      expect(duration1).toBeGreaterThanOrEqual(8);
      expect(profiler.getActiveMeasurementCount()).toBe(1);

      const duration2 = profiler.endLatencyMeasurement('op2');
      // Allow slight timing variance due to timer resolution
      expect(duration2).toBeGreaterThanOrEqual(8);
      expect(profiler.getActiveMeasurementCount()).toBe(0);
    });

    it('should clear all latency measurements', () => {
      profiler.startLatencyMeasurement('op1');
      profiler.startLatencyMeasurement('op2');
      profiler.startLatencyMeasurement('op3');

      expect(profiler.getActiveMeasurementCount()).toBe(3);

      profiler.clearLatencyMeasurements();

      expect(profiler.getActiveMeasurementCount()).toBe(0);
    });
  });

  describe('CPU Usage Measurement', () => {
    it('should measure current CPU usage percentage', () => {
      const cpuUsage = profiler.getCurrentCPUUsage();

      expect(cpuUsage).toBeGreaterThanOrEqual(0);
      expect(cpuUsage).toBeLessThanOrEqual(100);
    });
  });
});
