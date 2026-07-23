export interface JobTiming {
  name: string;
  started_at: string;
  completed_at: string;
}

/**
 * The 5 CI jobs that make up connector's gate (matches
 * gate_speed.ci_parallel_jobs in .sandcastle/gate-baseline.json).
 */
export const GATE_JOB_NAMES = [
  'Lint and Format Check',
  'TypeScript Type Check',
  'Build All Packages',
  'Test (Node.js 22.x)',
  'Test (Node.js 22.12.0)',
];

export function computeRunMetrics(jobs: JobTiming[]): {
  wallClockSeconds: number;
  runnerMinutes: number;
} {
  const durations = GATE_JOB_NAMES.map((name) => {
    const job = jobs.find((j) => j.name === name);
    if (!job) {
      throw new Error(`gate job "${name}" not found in workflow run`);
    }
    return (new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()) / 1000;
  });

  return {
    wallClockSeconds: Math.max(...durations),
    runnerMinutes: durations.reduce((a, b) => a + b, 0) / 60,
  };
}
