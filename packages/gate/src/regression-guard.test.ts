import {
  deriveRegressionBaseline,
  evaluateRegressionGate,
  REGRESSION_TOLERANCE,
} from './regression-guard';
import type { GatePerformanceBaseline, GateSpeedBaseline, RegressionSnapshot } from './types';

const speed: GateSpeedBaseline = {
  ci_parallel_jobs: {
    lint_and_format_check: 61,
    type_check: 52,
    build_all_packages: 59,
    test_node_22_x: 753,
    test_node_22_12_0: 772,
    wall_clock_critical_path: 772,
  },
};

const performanceWithImage: GatePerformanceBaseline = {
  runner_minutes: { billed: 0 },
  docker_image_size: { value: 500_000_000 },
};

const performanceNoImage: GatePerformanceBaseline = {
  runner_minutes: { billed: 0 },
  docker_image_size: { value: null },
};

describe('deriveRegressionBaseline', () => {
  it('uses the critical-path job as wall-clock and sums the 5 gate jobs as the runner-minutes proxy', () => {
    const derived = deriveRegressionBaseline(speed, performanceWithImage);

    expect(derived.wallClockSeconds).toBe(772);
    expect(derived.runnerMinutes).toBeCloseTo((61 + 52 + 59 + 753 + 772) / 60, 5);
    expect(derived.dockerImageSizeBytes).toBe(500_000_000);
  });

  it('passes through a null docker image size baseline unchanged', () => {
    const derived = deriveRegressionBaseline(speed, performanceNoImage);

    expect(derived.dockerImageSizeBytes).toBeNull();
  });
});

describe('evaluateRegressionGate', () => {
  const baseline: RegressionSnapshot = {
    wallClockSeconds: 772,
    runnerMinutes: 28.28,
    dockerImageSizeBytes: 500_000_000,
  };

  it('passes when current measurements exactly match the frozen baseline', () => {
    const result = evaluateRegressionGate(baseline, { ...baseline });

    expect(result.pass).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('passes when current measurements are faster/smaller than baseline', () => {
    const current: RegressionSnapshot = {
      wallClockSeconds: 700,
      runnerMinutes: 25,
      dockerImageSizeBytes: 400_000_000,
    };

    const result = evaluateRegressionGate(baseline, current);

    expect(result.pass).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('passes when a regression is within the fixed tolerance', () => {
    const current: RegressionSnapshot = {
      wallClockSeconds: 772 * (1 + REGRESSION_TOLERANCE - 0.01),
      runnerMinutes: baseline.runnerMinutes,
      dockerImageSizeBytes: baseline.dockerImageSizeBytes,
    };

    const result = evaluateRegressionGate(baseline, current);

    expect(result.pass).toBe(true);
  });

  it('fails when wall-clock regresses beyond the tolerance', () => {
    const current: RegressionSnapshot = {
      wallClockSeconds: 772 * 2,
      runnerMinutes: baseline.runnerMinutes,
      dockerImageSizeBytes: baseline.dockerImageSizeBytes,
    };

    const result = evaluateRegressionGate(baseline, current);

    expect(result.pass).toBe(false);
    expect(result.violations).toEqual([
      {
        metric: 'wall-clock-seconds',
        baseline: 772,
        allowedMax: 772 * (1 + REGRESSION_TOLERANCE),
        actual: 772 * 2,
      },
    ]);
  });

  it('fails when runner-minutes regresses beyond the tolerance', () => {
    const current: RegressionSnapshot = {
      wallClockSeconds: baseline.wallClockSeconds,
      runnerMinutes: 100,
      dockerImageSizeBytes: baseline.dockerImageSizeBytes,
    };

    const result = evaluateRegressionGate(baseline, current);

    expect(result.pass).toBe(false);
    expect(result.violations).toEqual([
      {
        metric: 'runner-minutes',
        baseline: 28.28,
        allowedMax: 28.28 * (1 + REGRESSION_TOLERANCE),
        actual: 100,
      },
    ]);
  });

  it('fails when docker image size regresses beyond the tolerance', () => {
    const current: RegressionSnapshot = {
      wallClockSeconds: baseline.wallClockSeconds,
      runnerMinutes: baseline.runnerMinutes,
      dockerImageSizeBytes: 900_000_000,
    };

    const result = evaluateRegressionGate(baseline, current);

    expect(result.pass).toBe(false);
    expect(result.violations).toEqual([
      {
        metric: 'docker-image-size-bytes',
        baseline: 500_000_000,
        allowedMax: 500_000_000 * (1 + REGRESSION_TOLERANCE),
        actual: 900_000_000,
      },
    ]);
  });

  it('skips the docker image size check when the frozen baseline has no captured value', () => {
    const baselineNoImage: RegressionSnapshot = { ...baseline, dockerImageSizeBytes: null };
    const current: RegressionSnapshot = {
      wallClockSeconds: baseline.wallClockSeconds,
      runnerMinutes: baseline.runnerMinutes,
      dockerImageSizeBytes: 5_000_000_000,
    };

    const result = evaluateRegressionGate(baselineNoImage, current);

    expect(result.pass).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('reports multiple simultaneous regressions', () => {
    const current: RegressionSnapshot = {
      wallClockSeconds: 772 * 2,
      runnerMinutes: 100,
      dockerImageSizeBytes: baseline.dockerImageSizeBytes,
    };

    const result = evaluateRegressionGate(baseline, current);

    expect(result.pass).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations.map((v) => v.metric)).toEqual([
      'wall-clock-seconds',
      'runner-minutes',
    ]);
  });

  it('is deterministic: identical inputs always produce identical verdicts', () => {
    const current: RegressionSnapshot = {
      wallClockSeconds: 772 * 2,
      runnerMinutes: baseline.runnerMinutes,
      dockerImageSizeBytes: baseline.dockerImageSizeBytes,
    };

    const first = evaluateRegressionGate(baseline, current);
    const second = evaluateRegressionGate(baseline, current);

    expect(second).toEqual(first);
  });
});
