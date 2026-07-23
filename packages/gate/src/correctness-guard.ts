import type {
  CorrectnessSnapshot,
  CorrectnessViolation,
  GateCorrectnessBaseline,
  GateResult,
} from './types';

/**
 * Compares live lint/typecheck counts against the frozen per-workspace
 * allowlist in .sandcastle/gate-baseline.json. A workspace missing from the
 * baseline gets zero tolerance, so newly added workspaces start debt-free.
 * Pure and deterministic: never fails on counts at or below the frozen
 * baseline (no false FAIL), only on counts that exceed it (no false PASS).
 */
export function evaluateCorrectnessGate(
  baseline: GateCorrectnessBaseline,
  current: CorrectnessSnapshot
): GateResult<CorrectnessViolation> {
  const violations: CorrectnessViolation[] = [];

  for (const [workspace, counts] of Object.entries(current.lint)) {
    const allowed = baseline.lint.by_workspace[workspace] ?? { errors: 0, warnings: 0 };

    if (counts.errors > allowed.errors) {
      violations.push({
        workspace,
        category: 'lint-errors',
        allowed: allowed.errors,
        actual: counts.errors,
      });
    }

    if (counts.warnings > allowed.warnings) {
      violations.push({
        workspace,
        category: 'lint-warnings',
        allowed: allowed.warnings,
        actual: counts.warnings,
      });
    }
  }

  for (const [workspace, errors] of Object.entries(current.typecheck)) {
    const allowed = baseline.typecheck.by_workspace[workspace] ?? 0;

    if (errors > allowed) {
      violations.push({
        workspace,
        category: 'typecheck-errors',
        allowed,
        actual: errors,
      });
    }
  }

  return { pass: violations.length === 0, violations };
}
