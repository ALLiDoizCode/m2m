import { evaluateCorrectnessGate } from './correctness-guard';
import type { GateCorrectnessBaseline, CorrectnessSnapshot } from './types';

function baseline(overrides: Partial<GateCorrectnessBaseline> = {}): GateCorrectnessBaseline {
  return {
    lint: {
      errors: 0,
      warnings: 0,
      workspaces_linted: ['packages/connector', 'packages/mina-zkapp', 'packages/shared'],
      by_workspace: {
        'packages/connector': { errors: 0, warnings: 0 },
        'packages/mina-zkapp': { errors: 0, warnings: 0 },
        'packages/shared': { errors: 0, warnings: 0 },
      },
    },
    typecheck: {
      errors: 0,
      workspaces_typechecked: ['packages/connector', 'packages/mina-zkapp', 'packages/shared'],
      by_workspace: {
        'packages/connector': 0,
        'packages/mina-zkapp': 0,
        'packages/shared': 0,
      },
    },
    ...overrides,
  };
}

describe('evaluateCorrectnessGate', () => {
  it('passes when current counts exactly match the frozen baseline', () => {
    const current: CorrectnessSnapshot = {
      lint: {
        'packages/connector': { errors: 0, warnings: 0 },
        'packages/mina-zkapp': { errors: 0, warnings: 0 },
        'packages/shared': { errors: 0, warnings: 0 },
      },
      typecheck: {
        'packages/connector': 0,
        'packages/mina-zkapp': 0,
        'packages/shared': 0,
      },
    };

    const result = evaluateCorrectnessGate(baseline(), current);

    expect(result.pass).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('passes when current counts are lower than the frozen baseline (improvement)', () => {
    const withDebt = baseline({
      lint: {
        errors: 2,
        warnings: 3,
        workspaces_linted: ['packages/connector'],
        by_workspace: { 'packages/connector': { errors: 2, warnings: 3 } },
      },
      typecheck: {
        errors: 0,
        workspaces_typechecked: ['packages/connector'],
        by_workspace: { 'packages/connector': 0 },
      },
    });
    const current: CorrectnessSnapshot = {
      lint: { 'packages/connector': { errors: 0, warnings: 1 } },
      typecheck: { 'packages/connector': 0 },
    };

    const result = evaluateCorrectnessGate(withDebt, current);

    expect(result.pass).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('fails when a workspace introduces a new lint error beyond the frozen allowlist', () => {
    const current: CorrectnessSnapshot = {
      lint: {
        'packages/connector': { errors: 1, warnings: 0 },
        'packages/mina-zkapp': { errors: 0, warnings: 0 },
        'packages/shared': { errors: 0, warnings: 0 },
      },
      typecheck: {
        'packages/connector': 0,
        'packages/mina-zkapp': 0,
        'packages/shared': 0,
      },
    };

    const result = evaluateCorrectnessGate(baseline(), current);

    expect(result.pass).toBe(false);
    expect(result.violations).toEqual([
      { workspace: 'packages/connector', category: 'lint-errors', allowed: 0, actual: 1 },
    ]);
  });

  it('fails when a workspace introduces a new typecheck error beyond the frozen allowlist', () => {
    const current: CorrectnessSnapshot = {
      lint: {
        'packages/connector': { errors: 0, warnings: 0 },
        'packages/mina-zkapp': { errors: 0, warnings: 0 },
        'packages/shared': { errors: 0, warnings: 0 },
      },
      typecheck: {
        'packages/connector': 0,
        'packages/mina-zkapp': 3,
        'packages/shared': 0,
      },
    };

    const result = evaluateCorrectnessGate(baseline(), current);

    expect(result.pass).toBe(false);
    expect(result.violations).toEqual([
      { workspace: 'packages/mina-zkapp', category: 'typecheck-errors', allowed: 0, actual: 3 },
    ]);
  });

  it('reports every violation across workspaces and categories, not just the first', () => {
    const current: CorrectnessSnapshot = {
      lint: {
        'packages/connector': { errors: 1, warnings: 2 },
        'packages/mina-zkapp': { errors: 0, warnings: 0 },
        'packages/shared': { errors: 0, warnings: 0 },
      },
      typecheck: {
        'packages/connector': 0,
        'packages/mina-zkapp': 0,
        'packages/shared': 1,
      },
    };

    const result = evaluateCorrectnessGate(baseline(), current);

    expect(result.pass).toBe(false);
    expect(result.violations).toEqual([
      { workspace: 'packages/connector', category: 'lint-errors', allowed: 0, actual: 1 },
      { workspace: 'packages/connector', category: 'lint-warnings', allowed: 0, actual: 2 },
      { workspace: 'packages/shared', category: 'typecheck-errors', allowed: 0, actual: 1 },
    ]);
  });

  it('defaults to zero tolerance for a workspace absent from the frozen baseline', () => {
    const current: CorrectnessSnapshot = {
      lint: { 'packages/new-tool': { errors: 0, warnings: 1 } },
      typecheck: { 'packages/new-tool': 0 },
    };

    const result = evaluateCorrectnessGate(baseline(), current);

    expect(result.pass).toBe(false);
    expect(result.violations).toEqual([
      { workspace: 'packages/new-tool', category: 'lint-warnings', allowed: 0, actual: 1 },
    ]);
  });

  it('is deterministic: identical inputs always produce identical verdicts', () => {
    const current: CorrectnessSnapshot = {
      lint: { 'packages/connector': { errors: 1, warnings: 0 } },
      typecheck: { 'packages/connector': 0 },
    };

    const first = evaluateCorrectnessGate(baseline(), current);
    const second = evaluateCorrectnessGate(baseline(), current);

    expect(second).toEqual(first);
  });
});
