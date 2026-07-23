import { execFileSync } from 'node:child_process';
import { computeRunMetrics } from './run-metrics';
import type { JobTiming } from './run-metrics';

/**
 * Fetches a completed workflow run's job timings via `gh api` and prints
 * GITHUB_OUTPUT-formatted `wall_clock_seconds=` / `runner_minutes=` lines.
 * Invoked from .github/workflows/gate-no-regression.yml as:
 *   node packages/gate/dist/measure-run.js <run_id> >> "$GITHUB_OUTPUT"
 */
function main(): void {
  const [runId] = process.argv.slice(2);
  if (!runId) {
    console.error('Usage: measure-run <run_id>');
    process.exitCode = 1;
    return;
  }

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('GITHUB_REPOSITORY environment variable is required');
    process.exitCode = 1;
    return;
  }

  const output = execFileSync(
    'gh',
    ['api', `repos/${repo}/actions/runs/${runId}/jobs`, '--paginate', '-q', '.jobs'],
    { encoding: 'utf-8' }
  );
  const jobs = JSON.parse(output) as JobTiming[];
  const { wallClockSeconds, runnerMinutes } = computeRunMetrics(jobs);

  process.stdout.write(`wall_clock_seconds=${wallClockSeconds}\n`);
  process.stdout.write(`runner_minutes=${runnerMinutes}\n`);
}

main();
