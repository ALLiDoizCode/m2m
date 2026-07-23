import { computeRunMetrics, GATE_JOB_NAMES } from './run-metrics';
import type { JobTiming } from './run-metrics';

function jobsFromDurations(durationsSeconds: number[]): JobTiming[] {
  const start = new Date('2026-07-23T00:00:00.000Z').getTime();
  return GATE_JOB_NAMES.map((name, i) => ({
    name,
    started_at: new Date(start).toISOString(),
    completed_at: new Date(start + durationsSeconds[i]! * 1000).toISOString(),
  }));
}

describe('computeRunMetrics', () => {
  it('uses the slowest gate job as wall-clock and the summed durations/60 as runner-minutes', () => {
    const jobs = jobsFromDurations([61, 52, 59, 753, 772]);

    const result = computeRunMetrics(jobs);

    expect(result.wallClockSeconds).toBe(772);
    expect(result.runnerMinutes).toBeCloseTo((61 + 52 + 59 + 753 + 772) / 60, 5);
  });

  it('ignores non-gate jobs present in the same run', () => {
    const jobs: JobTiming[] = [
      ...jobsFromDurations([61, 52, 59, 753, 772]),
      {
        name: 'Security Audit',
        started_at: '2026-07-23T00:00:00.000Z',
        completed_at: '2026-07-23T01:00:00.000Z',
      },
    ];

    const result = computeRunMetrics(jobs);

    expect(result.wallClockSeconds).toBe(772);
  });

  it('throws when a required gate job is missing from the run', () => {
    const jobs = jobsFromDurations([61, 52, 59, 753, 772]).filter(
      (j) => j.name !== 'Build All Packages'
    );

    expect(() => computeRunMetrics(jobs)).toThrow(/Build All Packages/);
  });
});
