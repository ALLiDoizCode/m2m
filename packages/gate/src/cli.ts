import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadBaseline } from './baseline';
import { evaluateCorrectnessGate } from './correctness-guard';
import { deriveRegressionBaseline, evaluateRegressionGate } from './regression-guard';
import { countTscErrors, sumEslintCounts, type EslintFileResult } from './parsers';
import type { CorrectnessSnapshot, RegressionSnapshot } from './types';

const REPO_ROOT = resolve(__dirname, '../../../');
const BASELINE_PATH = resolve(REPO_ROOT, '.sandcastle/gate-baseline.json');

function runCommandCapturingOutput(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { cwd: REPO_ROOT, encoding: 'utf-8' });
  } catch (error) {
    const withOutput = error as { stdout?: string };
    return withOutput.stdout ?? '';
  }
}

function measureLintWorkspace(workspace: string): { errors: number; warnings: number } {
  const output = runCommandCapturingOutput('npx', [
    'eslint',
    `${workspace}/src`,
    '--ext',
    '.ts',
    '-f',
    'json',
  ]);
  const results = JSON.parse(output || '[]') as EslintFileResult[];
  return sumEslintCounts(results);
}

function measureTypecheckWorkspace(workspace: string): number {
  // Route through `npm run typecheck` (not a direct `tsc -p` call) so
  // per-workspace pre-hooks run first — e.g. mina-usdc-faucet-web's
  // `pretypecheck` generates src/zkapp-compiled/ that its typecheck imports.
  const output = runCommandCapturingOutput('npm', ['run', 'typecheck', `--workspace=${workspace}`]);
  return countTscErrors(output);
}

function runCorrectness(): void {
  const baseline = loadBaseline(BASELINE_PATH);

  const current: CorrectnessSnapshot = { lint: {}, typecheck: {} };
  for (const workspace of baseline.gate_correctness.lint.workspaces_linted) {
    current.lint[workspace] = measureLintWorkspace(workspace);
  }
  for (const workspace of baseline.gate_correctness.typecheck.workspaces_typechecked) {
    current.typecheck[workspace] = measureTypecheckWorkspace(workspace);
  }

  const result = evaluateCorrectnessGate(baseline.gate_correctness, current);

  if (result.pass) {
    console.error('gate-check correctness: PASS (no violations beyond the frozen allowlist)');
    return;
  }

  console.error('gate-check correctness: FAIL');
  for (const violation of result.violations) {
    console.error(
      `  ${violation.workspace}: ${violation.category} allowed=${violation.allowed} actual=${violation.actual}`
    );
  }
  process.exitCode = 1;
}

function parseNumberArg(args: string[], flag: string): number | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined) return undefined;
  return Number(value);
}

function runRegression(args: string[]): void {
  const baseline = loadBaseline(BASELINE_PATH);
  const baselineSnapshot = deriveRegressionBaseline(baseline.gate_speed, baseline.gate_performance);

  const wallClockSeconds = parseNumberArg(args, '--wall-clock-seconds');
  const runnerMinutes = parseNumberArg(args, '--runner-minutes');
  const dockerImageSizeBytes = parseNumberArg(args, '--docker-image-bytes');

  if (wallClockSeconds === undefined || runnerMinutes === undefined) {
    console.error(
      'gate-check regression requires --wall-clock-seconds <n> --runner-minutes <n> [--docker-image-bytes <n>]'
    );
    process.exitCode = 1;
    return;
  }

  const current: RegressionSnapshot = {
    wallClockSeconds,
    runnerMinutes,
    dockerImageSizeBytes: dockerImageSizeBytes ?? null,
  };

  const result = evaluateRegressionGate(baselineSnapshot, current);

  if (result.pass) {
    console.error('gate-check regression: PASS (within tolerance of the frozen baseline)');
    return;
  }

  console.error('gate-check regression: FAIL');
  for (const violation of result.violations) {
    console.error(
      `  ${violation.metric}: baseline=${violation.baseline} allowedMax=${violation.allowedMax} actual=${violation.actual}`
    );
  }
  process.exitCode = 1;
}

function main(): void {
  const [subcommand, ...rest] = process.argv.slice(2);

  switch (subcommand) {
    case 'correctness':
      runCorrectness();
      break;
    case 'regression':
      runRegression(rest);
      break;
    default:
      console.error('Usage: gate-check <correctness|regression> [options]');
      process.exitCode = 1;
  }
}

main();
