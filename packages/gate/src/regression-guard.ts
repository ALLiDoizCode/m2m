import type {
  GatePerformanceBaseline,
  GateResult,
  GateSpeedBaseline,
  RegressionSnapshot,
  RegressionViolation,
} from './types';

/**
 * Fixed margin allowed above the frozen baseline before a measurement counts
 * as a regression. A code constant (not read from any external/live source),
 * so the same commit always earns the same verdict against a given baseline.
 */
export const REGRESSION_TOLERANCE = 0.2;

/**
 * Derives the comparable regression baseline from the frozen
 * .sandcastle/gate-baseline.json. Runner-minutes uses the summed wall-clock
 * of the 5 gate jobs as a cost proxy, per the baseline's own note that
 * `billed` is always 0 for this public repo.
 */
export function deriveRegressionBaseline(
  speed: GateSpeedBaseline,
  performance: GatePerformanceBaseline
): RegressionSnapshot {
  const jobs = speed.ci_parallel_jobs;
  const runnerSeconds =
    jobs.lint_and_format_check +
    jobs.type_check +
    jobs.build_all_packages +
    jobs.test_node_22_x +
    jobs.test_node_22_12_0;

  return {
    wallClockSeconds: jobs.wall_clock_critical_path,
    runnerMinutes: runnerSeconds / 60,
    dockerImageSizeBytes: performance.docker_image_size.value,
  };
}

/**
 * Compares a live measurement against the frozen baseline. Pure and
 * deterministic: only the tolerance-adjusted frozen baseline values are read,
 * never a live/moving threshold. A metric with no captured baseline (e.g.
 * docker image size not yet measured) is skipped rather than failed.
 */
export function evaluateRegressionGate(
  baseline: RegressionSnapshot,
  current: RegressionSnapshot
): GateResult<RegressionViolation> {
  const violations: RegressionViolation[] = [];

  const check = (
    metric: RegressionViolation['metric'],
    baselineValue: number,
    actual: number
  ): void => {
    const allowedMax = baselineValue * (1 + REGRESSION_TOLERANCE);
    if (actual > allowedMax) {
      violations.push({ metric, baseline: baselineValue, allowedMax, actual });
    }
  };

  check('wall-clock-seconds', baseline.wallClockSeconds, current.wallClockSeconds);
  check('runner-minutes', baseline.runnerMinutes, current.runnerMinutes);

  if (baseline.dockerImageSizeBytes !== null && current.dockerImageSizeBytes !== null) {
    check('docker-image-size-bytes', baseline.dockerImageSizeBytes, current.dockerImageSizeBytes);
  }

  return { pass: violations.length === 0, violations };
}
