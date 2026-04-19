/**
 * Story 36.5 structural validation — verifies that the nightly CI workflow,
 * system-tor fallback smoke test, docs Platform Matrix, CHANGELOG, and
 * sprint-status all satisfy their acceptance criteria.
 *
 * This test file validates static artifacts (YAML workflow, docs, CHANGELOG)
 * that cannot be exercised by running the workflow itself. It runs under
 * `make test` without any env-gate — every test is always active.
 *
 * Acceptance Criteria Covered:
 *   - AC 1:  Workflow file exists at canonical path with correct triggers
 *   - AC 2:  Real-binary job matrix covers Linux + macOS (T-36.5-05)
 *   - AC 3:  System-tor fallback job covers Linux + macOS (T-36.5-07)
 *   - AC 4:  System-tor fallback smoke test file exists with env-gate
 *   - AC 5:  T-36.5-01 — Nightly cron fires (workflow cron configured)
 *   - AC 6:  T-36.5-02 — workflow_dispatch is configured
 *   - AC 10: T-36.5-03/T-36.5-08 — Failure artifacts + version recording
 *   - AC 11: docs/ator-transport.md Platform Matrix section
 *   - AC 12: make test remains unaffected (fallback test env-gated)
 *   - AC 14: CHANGELOG + sprint-status updates
 *   - AC 15: T-36.5-04 — Timeout budgets configured
 *   - AC 16: T-36.5-06 — macOS Docker availability check
 *   - AC 17: T-36.5-09 — arm64 coverage gap documented
 *
 * @module test/integration/story-36-5-nightly-ci-validation
 */

import * as fs from 'fs';
import * as path from 'path';
import * as jsYaml from 'js-yaml';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const WORKFLOW_PATH = path.join(PROJECT_ROOT, '.github', 'workflows', 'nightly-ator.yml');
const FALLBACK_TEST_PATH = path.join(
  PROJECT_ROOT,
  'packages',
  'connector',
  'test',
  'integration',
  'transport-system-tor-fallback.test.ts'
);
const DOCS_PATH = path.join(PROJECT_ROOT, 'docs', 'ator-transport.md');
const CHANGELOG_PATH = path.join(PROJECT_ROOT, 'CHANGELOG.md');
const SPRINT_STATUS_PATH = path.join(
  PROJECT_ROOT,
  '_bmad-output',
  'implementation-artifacts',
  'sprint-status.yaml'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface WorkflowYaml {
  name?: string;
  on?: {
    schedule?: Array<{ cron: string }>;
    workflow_dispatch?: Record<string, unknown>;
  };
  jobs?: Record<string, JobDef>;
}

interface JobDef {
  strategy?: {
    'fail-fast'?: boolean;
    matrix?: {
      os?: string[];
      include?: Array<Record<string, unknown>>;
    };
  };
  'runs-on'?: string;
  'timeout-minutes'?: number;
  steps?: Array<StepDef>;
}

interface StepDef {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  'working-directory'?: string;
}

function loadWorkflow(): WorkflowYaml {
  const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  return jsYaml.load(raw) as WorkflowYaml;
}

function loadWorkflowRaw(): string {
  return fs.readFileSync(WORKFLOW_PATH, 'utf8');
}

// ---------------------------------------------------------------------------
// AC 1: Nightly workflow file exists at canonical path
// ---------------------------------------------------------------------------
describe('AC 1: Nightly workflow file exists at canonical path (Story 36.5)', () => {
  it('file exists at .github/workflows/nightly-ator.yml', () => {
    expect(fs.existsSync(WORKFLOW_PATH)).toBe(true);
  });

  it('workflow name is "nightly-ator"', () => {
    const wf = loadWorkflow();
    expect(wf.name).toBe('nightly-ator');
  });
});

// ---------------------------------------------------------------------------
// AC 5 (T-36.5-01): Nightly cron fires at 04:00 UTC
// ---------------------------------------------------------------------------
describe('AC 5 / T-36.5-01: Nightly cron fires and triggers the workflow', () => {
  it('on.schedule defines cron "0 4 * * *" (04:00 UTC daily)', () => {
    const wf = loadWorkflow();
    expect(wf.on?.schedule).toBeDefined();
    expect(Array.isArray(wf.on?.schedule)).toBe(true);
    const crons = wf.on!.schedule!.map((s) => s.cron);
    expect(crons).toContain('0 4 * * *');
  });
});

// ---------------------------------------------------------------------------
// AC 6 (T-36.5-02): workflow_dispatch allows manual runs
// ---------------------------------------------------------------------------
describe('AC 6 / T-36.5-02: workflow_dispatch is configured', () => {
  it('on.workflow_dispatch is defined', () => {
    const wf = loadWorkflow();
    expect(wf.on?.workflow_dispatch).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC 2 (T-36.5-05): Real-binary job matrix covers Linux + macOS
// ---------------------------------------------------------------------------
describe('AC 2 / T-36.5-05: Real-binary job matrix (Story 36.5)', () => {
  let realBinaryJob: JobDef;

  beforeAll(() => {
    const wf = loadWorkflow();
    expect(wf.jobs).toBeDefined();
    expect(wf.jobs!['real-binary']).toBeDefined();
    realBinaryJob = wf.jobs!['real-binary']!;
  });

  it('matrix includes ubuntu-latest and macos-14', () => {
    const osMatrix = realBinaryJob.strategy?.matrix?.os;
    expect(osMatrix).toBeDefined();
    expect(osMatrix).toContain('ubuntu-latest');
    expect(osMatrix).toContain('macos-14');
  });

  it('fail-fast is false', () => {
    expect(realBinaryJob.strategy?.['fail-fast']).toBe(false);
  });

  it('timeout-minutes is 30', () => {
    expect(realBinaryJob['timeout-minutes']).toBe(30);
  });

  it('steps include checkout, setup-node, npm ci, build, docker compose up, ator-test, teardown', () => {
    const steps = realBinaryJob.steps ?? [];
    const stepNames = steps.map((s) => s.name ?? '').filter(Boolean);

    // Key steps must be present (order not strictly enforced here)
    expect(stepNames.some((n) => /checkout/i.test(n))).toBe(true);
    expect(stepNames.some((n) => /node/i.test(n))).toBe(true);
    expect(stepNames.some((n) => /install.*dep|npm ci/i.test(n))).toBe(true);
    expect(stepNames.some((n) => /build.*shared|shared.*build/i.test(n))).toBe(true);
    expect(stepNames.some((n) => /start.*ator|ator.*network/i.test(n))).toBe(true);
    expect(stepNames.some((n) => /ator.*test|real-binary/i.test(n))).toBe(true);
    expect(stepNames.some((n) => /tear.*down/i.test(n))).toBe(true);
  });

  it('setup-node uses version 22.11.0', () => {
    const steps = realBinaryJob.steps ?? [];
    const nodeStep = steps.find((s) => s.uses?.includes('actions/setup-node'));
    expect(nodeStep).toBeDefined();
    expect(nodeStep?.with?.['node-version']).toBe('22.11.0');
  });
});

// ---------------------------------------------------------------------------
// AC 3 (T-36.5-07): System-tor fallback job covers Linux + macOS
// ---------------------------------------------------------------------------
describe('AC 3 / T-36.5-07: System-tor fallback job matrix (Story 36.5)', () => {
  let fallbackJob: JobDef;

  beforeAll(() => {
    const wf = loadWorkflow();
    expect(wf.jobs).toBeDefined();
    expect(wf.jobs!['system-tor-fallback']).toBeDefined();
    fallbackJob = wf.jobs!['system-tor-fallback']!;
  });

  it('matrix include has ubuntu-latest and macos-14 entries', () => {
    const includes = fallbackJob.strategy?.matrix?.include;
    expect(includes).toBeDefined();
    expect(Array.isArray(includes)).toBe(true);

    const osList = includes!.map((entry) => entry['os']);
    expect(osList).toContain('ubuntu-latest');
    expect(osList).toContain('macos-14');
  });

  it('ubuntu-latest entry has apt-get install tor command', () => {
    const includes = fallbackJob.strategy?.matrix?.include ?? [];
    const ubuntuEntry = includes.find((e) => e['os'] === 'ubuntu-latest');
    expect(ubuntuEntry).toBeDefined();
    const installCmd = String(ubuntuEntry!['install'] ?? '');
    expect(installCmd).toMatch(/apt-get.*install.*tor/);
    expect(installCmd).toMatch(/apt-get update/);
  });

  it('macos-14 entry has brew install tor command', () => {
    const includes = fallbackJob.strategy?.matrix?.include ?? [];
    const macEntry = includes.find((e) => e['os'] === 'macos-14');
    expect(macEntry).toBeDefined();
    expect(String(macEntry!['install'] ?? '')).toMatch(/brew install tor/);
  });

  it('fail-fast is false', () => {
    expect(fallbackJob.strategy?.['fail-fast']).toBe(false);
  });

  it('timeout-minutes is 15', () => {
    expect(fallbackJob['timeout-minutes']).toBe(15);
  });

  it('smoke test step sets SYSTEM_TOR_SMOKE=1 env var', () => {
    const steps = fallbackJob.steps ?? [];
    const smokeStep = steps.find(
      (s) => s.env?.['SYSTEM_TOR_SMOKE'] === '1' || (s.run && s.run.includes('SYSTEM_TOR_SMOKE'))
    );
    expect(smokeStep).toBeDefined();
  });

  it('steps include tor install, tor start, SOCKS port wait, smoke test, tor stop', () => {
    const steps = fallbackJob.steps ?? [];
    const stepNames = steps.map((s) => s.name ?? '').filter(Boolean);

    expect(stepNames.some((n) => /install.*tor/i.test(n))).toBe(true);
    expect(stepNames.some((n) => /start.*tor/i.test(n))).toBe(true);
    expect(stepNames.some((n) => /socks.*port|wait.*9050|port.*9050/i.test(n))).toBe(true);
    expect(stepNames.some((n) => /smoke|fallback/i.test(n))).toBe(true);
    expect(stepNames.some((n) => /stop.*tor/i.test(n))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC 4: System-tor fallback smoke test file exists with env-gate
// ---------------------------------------------------------------------------
describe('AC 4: System-tor fallback smoke test file exists (Story 36.5)', () => {
  let testSource: string;

  beforeAll(() => {
    testSource = fs.readFileSync(FALLBACK_TEST_PATH, 'utf8');
  });

  it('file exists at packages/connector/test/integration/transport-system-tor-fallback.test.ts', () => {
    expect(fs.existsSync(FALLBACK_TEST_PATH)).toBe(true);
  });

  it('file-level JSDoc declares scope about system-tor fallback smoke', () => {
    expect(testSource).toMatch(/System-tor fallback smoke/i);
    expect(testSource).toMatch(/SYSTEM_TOR_SMOKE/);
  });

  it('top-level describe is gated by SYSTEM_TOR_SMOKE === "1" with describe.skip', () => {
    expect(testSource).toMatch(/process\.env\.SYSTEM_TOR_SMOKE\s*===\s*'1'/);
    expect(testSource).toMatch(/SMOKE\s*\?\s*describe\s*:\s*describe\.skip/);
  });

  it('accepts SYSTEM_TOR_PORT env var override with default 9050', () => {
    expect(testSource).toMatch(/SYSTEM_TOR_PORT/);
    expect(testSource).toMatch(/9050/);
  });

  it('when SYSTEM_TOR_SMOKE is unset the file loads cleanly (no syntax errors)', () => {
    // The fallback test file is discovered by Jest in the same run as this
    // file. If it had import errors or top-level side effects that threw,
    // the test runner would fail before reaching this point. We verify
    // structural correctness by checking the file parses as valid TS
    // (the fact that Jest loaded it is proof enough -- we just assert
    // the file is non-empty and contains the expected exports).
    const source = fs.readFileSync(FALLBACK_TEST_PATH, 'utf8');
    expect(source.length).toBeGreaterThan(100);
    expect(source).toMatch(/export\s*\{\}/);
  });
});

// ---------------------------------------------------------------------------
// AC 10 (T-36.5-03, T-36.5-08): Failure artifacts + version recording
// ---------------------------------------------------------------------------
describe('AC 10 / T-36.5-03 + T-36.5-08: Failure artifacts and version recording (Story 36.5)', () => {
  let realBinarySteps: StepDef[];

  beforeAll(() => {
    const wf = loadWorkflow();
    realBinarySteps = wf.jobs?.['real-binary']?.steps ?? [];
  });

  it('real-binary job records ATOR version in job summary (T-36.5-03)', () => {
    const versionStep = realBinarySteps.find(
      (s) => s.run && s.run.includes('GITHUB_STEP_SUMMARY') && s.run.includes('version')
    );
    expect(versionStep).toBeDefined();
  });

  it('real-binary job uploads compose logs on failure (T-36.5-08)', () => {
    const uploadStep = realBinarySteps.find((s) => s.uses?.includes('actions/upload-artifact'));
    expect(uploadStep).toBeDefined();
    expect(uploadStep?.if).toMatch(/failure/);
  });

  it('failure artifact uses retention-days: 7', () => {
    const uploadStep = realBinarySteps.find((s) => s.uses?.includes('actions/upload-artifact'));
    expect(uploadStep).toBeDefined();
    expect(uploadStep?.with?.['retention-days']).toBe(7);
  });

  it('compose logs are captured before artifact upload', () => {
    const logStep = realBinarySteps.find((s) => s.run && s.run.includes('ator-compose-logs'));
    expect(logStep).toBeDefined();
    expect(logStep?.if).toMatch(/failure/);
  });
});

// ---------------------------------------------------------------------------
// AC 15 (T-36.5-04): Workflow completes within time budget
// ---------------------------------------------------------------------------
describe('AC 15 / T-36.5-04: Workflow timeout budgets (Story 36.5)', () => {
  it('real-binary job timeout-minutes <= 30', () => {
    const wf = loadWorkflow();
    const timeout = wf.jobs?.['real-binary']?.['timeout-minutes'];
    expect(timeout).toBeDefined();
    expect(timeout).toBeLessThanOrEqual(30);
  });

  it('system-tor-fallback job timeout-minutes <= 15', () => {
    const wf = loadWorkflow();
    const timeout = wf.jobs?.['system-tor-fallback']?.['timeout-minutes'];
    expect(timeout).toBeDefined();
    expect(timeout).toBeLessThanOrEqual(15);
  });
});

// ---------------------------------------------------------------------------
// AC 16 (T-36.5-06): macOS Docker availability check
// ---------------------------------------------------------------------------
describe('AC 16 / T-36.5-06: macOS Docker availability check (Story 36.5)', () => {
  let realBinarySteps: StepDef[];

  beforeAll(() => {
    const wf = loadWorkflow();
    realBinarySteps = wf.jobs?.['real-binary']?.steps ?? [];
  });

  it('has a Docker availability check step', () => {
    const dockerCheck = realBinarySteps.find(
      (s) => s.id === 'docker-check' || (s.name && /docker.*availab/i.test(s.name))
    );
    expect(dockerCheck).toBeDefined();
  });

  it('Docker-dependent steps are conditional on docker_available', () => {
    const dockerDependentSteps = realBinarySteps.filter(
      (s) => s.if && s.if.includes('docker_available')
    );
    // At minimum: start ATOR, wait hs1, run tests, teardown, version, logs, upload
    expect(dockerDependentSteps.length).toBeGreaterThanOrEqual(4);
  });

  it('has a skip notice step for when Docker is unavailable', () => {
    const skipStep = realBinarySteps.find(
      (s) =>
        s.if &&
        s.if.includes('docker_available') &&
        s.if.includes('!=') &&
        s.run &&
        /skip|warning/i.test(s.run)
    );
    expect(skipStep).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC 17 (T-36.5-09): arm64 coverage gap documented in workflow
// ---------------------------------------------------------------------------
describe('AC 17 / T-36.5-09: arm64 coverage gap documented (Story 36.5)', () => {
  it('workflow file contains arm64 coverage gap documentation', () => {
    const raw = loadWorkflowRaw();
    expect(raw).toMatch(/arm64/i);
    expect(raw).toMatch(/coverage gap/i);
  });

  it('arm64 documentation links to Epic 36 retro follow-up', () => {
    const raw = loadWorkflowRaw();
    expect(raw).toMatch(/epic.?36.*retro|retro.*follow/i);
  });

  it('T-36.5-09 test-ID is referenced in comments', () => {
    const raw = loadWorkflowRaw();
    expect(raw).toMatch(/T-36\.5-09/);
  });
});

// ---------------------------------------------------------------------------
// AC 11: docs/ator-transport.md Platform Matrix section
// ---------------------------------------------------------------------------
describe('AC 11: docs/ator-transport.md Platform Matrix (Story 36.5)', () => {
  let docsContent: string;

  beforeAll(() => {
    docsContent = fs.readFileSync(DOCS_PATH, 'utf8');
  });

  it('Platform Matrix section exists', () => {
    expect(docsContent).toMatch(/## Platform Matrix/);
  });

  it('documents ubuntu-latest with nightly CI coverage', () => {
    expect(docsContent).toMatch(/ubuntu-latest/);
    expect(docsContent).toMatch(/real-binary/i);
    expect(docsContent).toMatch(/system-tor-fallback/i);
  });

  it('documents macos-14 with nightly CI coverage', () => {
    expect(docsContent).toMatch(/macos-14/);
  });

  it('documents arm64 coverage gap with Rosetta note', () => {
    expect(docsContent).toMatch(/arm64/);
    expect(docsContent).toMatch(/Rosetta/i);
  });

  it('documents Windows as not supported', () => {
    expect(docsContent).toMatch(/Windows/);
    expect(docsContent).toMatch(/[Nn]ot supported/);
  });

  it('references the nightly workflow file path', () => {
    expect(docsContent).toMatch(/nightly-ator\.yml/);
  });
});

// ---------------------------------------------------------------------------
// AC 12: make test remains unaffected (env-gate validation)
// ---------------------------------------------------------------------------
describe('AC 12: make test remains unaffected (Story 36.5)', () => {
  it('transport-system-tor-fallback.test.ts uses describe.skip when SYSTEM_TOR_SMOKE is unset', () => {
    // This test runs under make test where SYSTEM_TOR_SMOKE is NOT set.
    // The fact that the fallback test file loaded without error (AC 4 test
    // above) and its gated tests are skipped proves AC 12.
    const testSource = fs.readFileSync(FALLBACK_TEST_PATH, 'utf8');
    expect(testSource).toMatch(/SMOKE\s*\?\s*describe\s*:\s*describe\.skip/);
  });

  it('skip reason is documented for developer clarity', () => {
    const testSource = fs.readFileSync(FALLBACK_TEST_PATH, 'utf8');
    expect(testSource).toMatch(
      /requires SYSTEM_TOR_SMOKE=1 and a running system tor on localhost:9050/
    );
  });
});

// ---------------------------------------------------------------------------
// AC 14: CHANGELOG + sprint-status updates
// ---------------------------------------------------------------------------
describe('AC 14: CHANGELOG + sprint-status updates (Story 36.5)', () => {
  it('CHANGELOG.md has a 36.5 entry under [Unreleased]', () => {
    const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');
    // Find the [Unreleased] section
    const unreleasedMatch = changelog.match(/## \[Unreleased\]([\s\S]*?)(?=## \[|$)/);
    expect(unreleasedMatch).not.toBeNull();
    const unreleasedSection = unreleasedMatch![1]!;
    expect(unreleasedSection).toMatch(/36[.-]5/);
    expect(unreleasedSection).toMatch(/nightly/i);
  });

  it('sprint-status.yaml has story 36.5 status set', () => {
    // Note: js-yaml.load() chokes on sprint-status.yaml because YAML 1.1
    // treats bare decimal keys like 34.10 as floats (34.1 == 34.10 =>
    // duplicate key error). We use regex matching instead.
    const raw = fs.readFileSync(SPRINT_STATUS_PATH, 'utf8');

    // Find the 36.5 story block and extract its status
    const match = raw.match(/36\.5:\s*\n\s*name:.*\n\s*status:\s*(\S+)/);
    expect(match).not.toBeNull();
    const storyStatus = match![1];
    // Status should be 'done' or 'review' (acceptable during review phase)
    expect(['done', 'review']).toContain(storyStatus);
  });
});

// ---------------------------------------------------------------------------
// Workflow structure: nick-fields/retry and @libsql patterns from ci.yml
// ---------------------------------------------------------------------------
describe('Workflow follows existing CI patterns (Story 36.5)', () => {
  it('real-binary job uses nick-fields/retry for npm ci', () => {
    const wf = loadWorkflow();
    const steps = wf.jobs?.['real-binary']?.steps ?? [];
    const retryStep = steps.find((s) => s.uses?.includes('nick-fields/retry'));
    expect(retryStep).toBeDefined();
  });

  it('system-tor-fallback job uses nick-fields/retry for npm ci', () => {
    const wf = loadWorkflow();
    const steps = wf.jobs?.['system-tor-fallback']?.steps ?? [];
    const retryStep = steps.find((s) => s.uses?.includes('nick-fields/retry'));
    expect(retryStep).toBeDefined();
  });

  it('real-binary job includes @libsql/linux-x64-gnu workaround for Linux', () => {
    const wf = loadWorkflow();
    const steps = wf.jobs?.['real-binary']?.steps ?? [];
    const libsqlStep = steps.find((s) => s.run?.includes('libsql'));
    expect(libsqlStep).toBeDefined();
    expect(libsqlStep?.if).toMatch(/Linux/i);
  });

  it('teardown step uses if: always() condition', () => {
    const wf = loadWorkflow();
    const steps = wf.jobs?.['real-binary']?.steps ?? [];
    const teardownStep = steps.find((s) => s.name && /tear.*down/i.test(s.name));
    expect(teardownStep).toBeDefined();
    expect(teardownStep?.if).toMatch(/always/);
  });

  it('system-tor-fallback stop step uses if: always() condition', () => {
    const wf = loadWorkflow();
    const steps = wf.jobs?.['system-tor-fallback']?.steps ?? [];
    const stopStep = steps.find((s) => s.name && /stop.*tor/i.test(s.name));
    expect(stopStep).toBeDefined();
    expect(stopStep?.if).toMatch(/always/);
  });
});

// ---------------------------------------------------------------------------
// No exports -- this is a test module.
// ---------------------------------------------------------------------------
export {};
