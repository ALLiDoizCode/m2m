export interface LintBaseline {
  errors: number;
  warnings: number;
  workspaces_linted: string[];
  by_workspace: Record<string, { errors: number; warnings: number }>;
}

export interface TypecheckBaseline {
  errors: number;
  workspaces_typechecked: string[];
  by_workspace: Record<string, number>;
}

export interface GateCorrectnessBaseline {
  lint: LintBaseline;
  typecheck: TypecheckBaseline;
}

export interface GateSpeedBaseline {
  ci_parallel_jobs: {
    lint_and_format_check: number;
    type_check: number;
    build_all_packages: number;
    test_node_22_x: number;
    test_node_22_12_0: number;
    wall_clock_critical_path: number;
  };
}

export interface GatePerformanceBaseline {
  runner_minutes: { billed: number };
  docker_image_size: { value: number | null };
}

export interface GateBaseline {
  gate_correctness: GateCorrectnessBaseline;
  gate_speed: GateSpeedBaseline;
  gate_performance: GatePerformanceBaseline;
}

export interface CorrectnessSnapshot {
  lint: Record<string, { errors: number; warnings: number }>;
  typecheck: Record<string, number>;
}

export interface CorrectnessViolation {
  workspace: string;
  category: 'lint-errors' | 'lint-warnings' | 'typecheck-errors';
  allowed: number;
  actual: number;
}

export interface GateResult<Violation> {
  pass: boolean;
  violations: Violation[];
}

export interface RegressionSnapshot {
  wallClockSeconds: number;
  runnerMinutes: number;
  dockerImageSizeBytes: number | null;
}

export interface RegressionViolation {
  metric: 'wall-clock-seconds' | 'runner-minutes' | 'docker-image-size-bytes';
  baseline: number;
  allowedMax: number;
  actual: number;
}
