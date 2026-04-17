/**
 * Acceptance Tests for Story 34.10: Mina Local Development Infrastructure
 *
 * These tests validate the Docker Compose infrastructure, Makefile targets,
 * readiness helper, lightnet test un-skipping, and CI pipeline changes
 * required for local Mina development.
 *
 * Acceptance Criteria Covered:
 * - AC1: Docker Compose Service — Mina Lightnet
 * - AC2: Funded Account Acquisition
 * - AC3: Makefile Targets (mina-up, mina-down, mina-logs)
 * - AC4: Lightnet Test Un-Skipped (T-34.8-18)
 * - AC5: Infra-Up Updated with Mina Profile
 * - AC6: EVM and Solana Regression
 * - AC7: CI Pipeline — Mina Integration Job
 * - AC8: Readiness Helper — waitForMinaReady()
 *
 * @module test/acceptance/story-34-10
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Path Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DOCKER_COMPOSE_PATH = path.join(PROJECT_ROOT, 'docker-compose.yml');
const MAKEFILE_PATH = path.join(PROJECT_ROOT, 'Makefile');
const CI_WORKFLOW_PATH = path.join(PROJECT_ROOT, '.github', 'workflows', 'ci.yml');
const MINA_HELPERS_PATH = path.join(
  PROJECT_ROOT,
  'packages',
  'connector',
  'test',
  'integration',
  'mina-helpers.ts'
);
const MINA_LIGHTNET_TEST_PATH = path.join(
  PROJECT_ROOT,
  'packages',
  'connector',
  'test',
  'integration',
  'mina-lightnet.test.ts'
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type ComposeFile = Record<string, any>;
type ServiceDef = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Helper: Load docker-compose.yml as parsed YAML
// ---------------------------------------------------------------------------

function loadDockerCompose(): ComposeFile {
  const content = fs.readFileSync(DOCKER_COMPOSE_PATH, 'utf8');
  return yaml.load(content) as ComposeFile;
}

// Helper: Load file content as string
function loadFileContent(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

// Helper: Get a service definition from docker-compose
function getService(compose: ComposeFile, name: string): ServiceDef {
  return (compose['services'] as Record<string, ServiceDef>)[name]!;
}

// ---------------------------------------------------------------------------
// AC 1: Docker Compose Service — Mina Lightnet (T-34.10-01, T-34.10-02)
// ---------------------------------------------------------------------------

describe('AC 1: Docker Compose Service — Mina Lightnet (Story 34.10)', () => {
  let compose: ComposeFile;

  beforeAll(() => {
    compose = loadDockerCompose();
  });

  it('[T-34.10-01] should define a mina-lightnet service', () => {
    const services = compose['services'] as Record<string, unknown>;
    expect(services).toHaveProperty('mina-lightnet');
  });

  it('[T-34.10-01] should use the o1labs mina-local-network image', () => {
    const svc = getService(compose, 'mina-lightnet');
    expect(svc['image']).toBe('o1labs/mina-local-network:compatible-latest-lightnet');
  });

  it('[T-34.10-01] should expose GraphQL on port 3085', () => {
    const svc = getService(compose, 'mina-lightnet');
    const ports = svc['ports'] as string[];
    expect(ports).toEqual(expect.arrayContaining([expect.stringContaining('3085')]));
  });

  it('[T-34.10-01] should expose accounts manager on port 8181', () => {
    const svc = getService(compose, 'mina-lightnet');
    const ports = svc['ports'] as string[];
    expect(ports).toEqual(expect.arrayContaining([expect.stringContaining('8181')]));
  });

  it('[T-34.10-01] should expose explorer on port 8282', () => {
    const svc = getService(compose, 'mina-lightnet');
    const ports = svc['ports'] as string[];
    expect(ports).toEqual(expect.arrayContaining([expect.stringContaining('8282')]));
  });

  it('[T-34.10-01] should remap archive PostgreSQL to port 5433', () => {
    const svc = getService(compose, 'mina-lightnet');
    const ports = svc['ports'] as string[];
    // Expect a mapping like '5433:5432' to avoid conflicts with local Postgres
    expect(ports).toEqual(expect.arrayContaining([expect.stringMatching(/5433.*5432/)]));
  });

  it('[T-34.10-01] should use Docker Compose profile "mina"', () => {
    const svc = getService(compose, 'mina-lightnet');
    const profiles = svc['profiles'] as string[];
    expect(profiles).toContain('mina');
  });

  it('[T-34.10-01] should allocate 4-8 GB memory via deploy.resources.limits', () => {
    const svc = getService(compose, 'mina-lightnet');
    const memory = svc?.['deploy']?.['resources']?.['limits']?.['memory'];
    expect(memory).toBeDefined();
    // Accept values like '4g', '8g', '6g', etc.
    expect(String(memory)).toMatch(/^[4-8]g$/);
  });

  it('[T-34.10-02] should define a health check using the accounts manager endpoint', () => {
    const svc = getService(compose, 'mina-lightnet');
    const healthcheck = svc['healthcheck'] as Record<string, unknown>;
    expect(healthcheck).toBeDefined();
    const test = healthcheck['test'];
    expect(JSON.stringify(test)).toContain('8181');
  });

  it('[T-34.10-02] should configure health check start_period of 120s', () => {
    const svc = getService(compose, 'mina-lightnet');
    const healthcheck = svc['healthcheck'] as Record<string, unknown>;
    expect(healthcheck).toBeDefined();
    expect(String(healthcheck['start_period'])).toMatch(/^120s?$/);
  });

  it('[T-34.10-02] should configure health check interval of 15s', () => {
    const svc = getService(compose, 'mina-lightnet');
    const healthcheck = svc['healthcheck'] as Record<string, unknown>;
    expect(healthcheck).toBeDefined();
    expect(String(healthcheck['interval'])).toMatch(/^15s?$/);
  });

  it('[T-34.10-02] should configure health check timeout of 10s', () => {
    const svc = getService(compose, 'mina-lightnet');
    const healthcheck = svc['healthcheck'] as Record<string, unknown>;
    expect(healthcheck).toBeDefined();
    expect(String(healthcheck['timeout'])).toMatch(/^10s?$/);
  });

  it('[T-34.10-02] should configure health check retries of 10', () => {
    const svc = getService(compose, 'mina-lightnet');
    const healthcheck = svc['healthcheck'] as Record<string, unknown>;
    expect(healthcheck).toBeDefined();
    expect(healthcheck['retries']).toBe(10);
  });

  it('[T-34.10-01] should configure restart policy as unless-stopped', () => {
    const svc = getService(compose, 'mina-lightnet');
    expect(svc['restart']).toBe('unless-stopped');
  });
});

// ---------------------------------------------------------------------------
// AC 2: Funded Account Acquisition (T-34.10-03)
// (This AC is verified at runtime; structural tests check helpers exist)
// ---------------------------------------------------------------------------

describe('AC 2: Funded Account Acquisition helpers exist (Story 34.10)', () => {
  it('[T-34.10-03] should have a mina-helpers.ts file with acquireFundedAccount', () => {
    expect(fs.existsSync(MINA_HELPERS_PATH)).toBe(true);
    const content = loadFileContent(MINA_HELPERS_PATH);
    expect(content).toContain('acquireFundedAccount');
  });

  it('[T-34.10-03] should have a releaseFundedAccount helper', () => {
    const content = loadFileContent(MINA_HELPERS_PATH);
    expect(content).toContain('releaseFundedAccount');
  });

  it('[T-34.10-03] should target accounts manager on port 8181', () => {
    const content = loadFileContent(MINA_HELPERS_PATH);
    expect(content).toContain('localhost:8181');
  });

  it('[T-34.10-03] should use /acquire-account endpoint for acquiring accounts', () => {
    const content = loadFileContent(MINA_HELPERS_PATH);
    expect(content).toContain('/acquire-account');
  });

  it('[T-34.10-03] should use /release-account endpoint for releasing accounts', () => {
    const content = loadFileContent(MINA_HELPERS_PATH);
    expect(content).toContain('/release-account');
  });
});

// ---------------------------------------------------------------------------
// AC 3: Makefile Targets (T-34.10-04, T-34.10-05)
// ---------------------------------------------------------------------------

describe('AC 3: Makefile provides mina-up, mina-down, mina-logs targets (Story 34.10)', () => {
  let makefileContent: string;

  beforeAll(() => {
    makefileContent = loadFileContent(MAKEFILE_PATH);
  });

  it('[T-34.10-04] should define mina-up target using --profile mina', () => {
    expect(makefileContent).toMatch(
      /mina-up:[\s\S]*?docker\s+compose\s+--profile\s+mina\s+up\s+-d/
    );
  });

  it('[T-34.10-04] should define mina-down target using --profile mina', () => {
    expect(makefileContent).toMatch(/mina-down:[\s\S]*?docker\s+compose\s+--profile\s+mina\s+down/);
  });

  it('[T-34.10-05] should define mina-logs target using --profile mina', () => {
    expect(makefileContent).toMatch(
      /mina-logs:[\s\S]*?docker\s+compose\s+--profile\s+mina\s+logs\s+-f/
    );
  });

  it('[T-34.10-04] should include mina targets in .PHONY declaration', () => {
    expect(makefileContent).toMatch(/\.PHONY:.*mina-up/);
    expect(makefileContent).toMatch(/\.PHONY:.*mina-down/);
    expect(makefileContent).toMatch(/\.PHONY:.*mina-logs/);
  });

  it('[T-34.10-04] should include mina targets in make help output', () => {
    expect(makefileContent).toMatch(/help:[\s\S]*mina-up/);
    expect(makefileContent).toMatch(/help:[\s\S]*mina-down/);
    expect(makefileContent).toMatch(/help:[\s\S]*mina-logs/);
  });
});

// ---------------------------------------------------------------------------
// AC 3/AC 5 (isolation): Mina targets are properly isolated
// ---------------------------------------------------------------------------

describe('AC 3 (isolation): Mina Makefile targets are isolated (Story 34.10)', () => {
  let makefileContent: string;

  beforeAll(() => {
    makefileContent = loadFileContent(MAKEFILE_PATH);
  });

  it('[T-34.10-04] mina-up should not reference evm or solana profile', () => {
    const minaUpMatch = makefileContent.match(/^mina-up:.*\n(?:\t.*\n)*/m);
    expect(minaUpMatch).toBeTruthy();
    expect(minaUpMatch![0]).not.toContain('--profile evm');
    expect(minaUpMatch![0]).not.toContain('--profile solana');
  });

  it('[T-34.10-04] mina-down should not reference evm or solana profile', () => {
    const minaDownMatch = makefileContent.match(/^mina-down:.*\n(?:\t.*\n)*/m);
    expect(minaDownMatch).toBeTruthy();
    expect(minaDownMatch![0]).not.toContain('--profile evm');
    expect(minaDownMatch![0]).not.toContain('--profile solana');
  });
});

// ---------------------------------------------------------------------------
// AC 4: Lightnet Test Un-Skipped (T-34.10-10, T-34.10-11)
// ---------------------------------------------------------------------------

describe('AC 4: Lightnet test un-skipped with environment gating (Story 34.10)', () => {
  it('[T-34.10-10] should use MINA_INTEGRATION environment variable gating, not hard-coded describe.skip', () => {
    const content = loadFileContent(MINA_LIGHTNET_TEST_PATH);
    expect(content).toContain('MINA_INTEGRATION');
    // The ternary pattern `? describe : describe.skip` is correct env-var gating.
    // What we reject is a hard-coded `describe.skip(` call that unconditionally skips.
    expect(content).not.toMatch(/describe\.skip\s*\(/);
  });

  it('[T-34.10-10] should use waitForMinaReady in beforeAll', () => {
    const content = loadFileContent(MINA_LIGHTNET_TEST_PATH);
    expect(content).toContain('waitForMinaReady');
  });

  it('[T-34.10-10] should use acquireFundedAccount for test accounts', () => {
    const content = loadFileContent(MINA_LIGHTNET_TEST_PATH);
    expect(content).toContain('acquireFundedAccount');
  });

  it('[T-34.10-10] should use releaseFundedAccount for cleanup', () => {
    const content = loadFileContent(MINA_LIGHTNET_TEST_PATH);
    expect(content).toContain('releaseFundedAccount');
  });

  it('[T-34.10-10] should reference T-34.8-18 archive node event retrieval test', () => {
    const content = loadFileContent(MINA_LIGHTNET_TEST_PATH);
    expect(content).toContain('T-34.8-18');
  });

  it('[T-34.10-11] should not have expect.assertions(0) placeholder', () => {
    const content = loadFileContent(MINA_LIGHTNET_TEST_PATH);
    expect(content).not.toContain('expect.assertions(0)');
  });
});

// ---------------------------------------------------------------------------
// AC 5: Infra-Up Updated with Mina Profile (T-34.10-06, T-34.10-07)
// ---------------------------------------------------------------------------

describe('AC 5: Infra-Up includes all three profiles (Story 34.10)', () => {
  let makefileContent: string;

  beforeAll(() => {
    makefileContent = loadFileContent(MAKEFILE_PATH);
  });

  it('[T-34.10-06] should define infra-up target starting evm, solana, and mina profiles', () => {
    // Regex allows additional --profile <name> tokens to appear after mina (e.g.,
    // Story 36.1 appended --profile ator). The assertion is that evm+solana+mina
    // are composed together into a single `up -d`; we do not forbid more profiles.
    expect(makefileContent).toMatch(
      /infra-up:[\s\S]*?docker\s+compose\s+--profile\s+evm\s+--profile\s+solana\s+--profile\s+mina\b[\s\S]*?up\s+-d/
    );
  });

  it('[T-34.10-07] should define infra-down target stopping all three profiles', () => {
    // Regex allows additional --profile <name> tokens to appear after mina (e.g.,
    // Story 36.1 appended --profile ator). The assertion is evm+solana+mina are
    // all torn down together; we do not forbid more profiles.
    expect(makefileContent).toMatch(
      /infra-down:[\s\S]*?docker\s+compose\s+--profile\s+evm\s+--profile\s+solana\s+--profile\s+mina\b[\s\S]*?\bdown\b/
    );
  });
});

// ---------------------------------------------------------------------------
// AC 6: EVM and Solana Regression (T-34.10-08, T-34.10-09, T-34.10-12, T-34.10-13)
// ---------------------------------------------------------------------------

describe('AC 6: EVM and Solana Regression (Story 34.10)', () => {
  let compose: ComposeFile;

  beforeAll(() => {
    compose = loadDockerCompose();
  });

  it('[T-34.10-08] should preserve anvil service configuration unchanged', () => {
    const anvil = getService(compose, 'anvil');
    expect(anvil['image']).toBe('ghcr.io/foundry-rs/foundry:latest');
    const ports = anvil['ports'] as string[];
    expect(ports).toEqual(expect.arrayContaining([expect.stringContaining('8545')]));
    expect(anvil['healthcheck']).toBeDefined();
    const profiles = anvil['profiles'] as string[];
    expect(profiles).toContain('evm');
  });

  it('[T-34.10-08] should preserve faucet service configuration unchanged', () => {
    const faucet = getService(compose, 'faucet');
    expect(faucet).toBeDefined();
    expect(faucet['depends_on']).toBeDefined();
    const ports = faucet['ports'] as string[];
    expect(ports).toEqual(expect.arrayContaining([expect.stringContaining('3500')]));
    const profiles = faucet['profiles'] as string[];
    expect(profiles).toContain('evm');
  });

  it('[T-34.10-09] should preserve solana-validator service configuration unchanged', () => {
    const solana = getService(compose, 'solana-validator');
    expect(solana['image']).toBe('ghcr.io/beeman/solana-test-validator:latest');
    const ports = solana['ports'] as string[];
    expect(ports).toEqual(expect.arrayContaining([expect.stringContaining('8899')]));
    expect(solana['healthcheck']).toBeDefined();
    const profiles = solana['profiles'] as string[];
    expect(profiles).toContain('solana');
  });

  it('[T-34.10-12] should have at least 4 services in docker-compose (anvil, faucet, solana-validator, mina-lightnet)', () => {
    const services = compose['services'] as Record<string, unknown>;
    expect(Object.keys(services).length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// AC 7: CI Pipeline — Mina Integration Job (T-34.10-14)
// ---------------------------------------------------------------------------

describe('AC 7: CI Pipeline — Mina Integration Job (Story 34.10)', () => {
  let ciContent: string;

  beforeAll(() => {
    ciContent = loadFileContent(CI_WORKFLOW_PATH);
  });

  it('[T-34.10-14] should define a mina-integration job', () => {
    expect(ciContent).toMatch(/mina-integration:/);
  });

  it('[T-34.10-14] should gate mina-integration on push to main', () => {
    // Check the overall CI file has the main branch push condition near the mina-integration job
    expect(ciContent).toMatch(
      /mina-integration:[\s\S]*?if:.*push.*main|mina-integration:[\s\S]*?refs\/heads\/main/
    );
  });

  it('[T-34.10-14] should start Mina infra via docker compose in CI', () => {
    expect(ciContent).toMatch(/docker\s+compose\s+--profile\s+mina\s+up/);
  });

  it('[T-34.10-14] should wait for Mina health check in CI (accounts manager on 8181)', () => {
    expect(ciContent).toMatch(/localhost:8181|8181.*health/);
  });

  it('[T-34.10-14] should set MINA_INTEGRATION env var to true in CI', () => {
    expect(ciContent).toMatch(/MINA_INTEGRATION:\s*['"]?true['"]?/);
  });

  it('[T-34.10-14] should run mina-lightnet test file in CI', () => {
    expect(ciContent).toMatch(/mina-lightnet\.test\.ts/);
  });

  it('[T-34.10-14] should tear down Mina with docker compose in if: always() block', () => {
    expect(ciContent).toMatch(/docker\s+compose\s+--profile\s+mina\s+down/);
  });

  it('[T-34.10-14] should set job timeout to 10 minutes', () => {
    // Match timeout-minutes: 10 near the mina-integration job
    const minaSection = ciContent.split('mina-integration:')[1] || '';
    expect(minaSection).toMatch(/timeout-minutes:\s*10/);
  });

  it('[T-34.10-14] should add mina-integration to ci-status needs array', () => {
    const ciStatusSection = ciContent.split('ci-status:')[1] || '';
    expect(ciStatusSection).toContain('mina-integration');
  });

  it('[T-34.10-14] should log mina-integration result in ci-status summary', () => {
    const ciStatusSection = ciContent.split('ci-status:')[1] || '';
    expect(ciStatusSection).toMatch(
      /[Mm]ina.*[Ii]ntegration.*result|needs\.mina-integration\.result/
    );
  });
});

// ---------------------------------------------------------------------------
// AC 8: Readiness Helper — waitForMinaReady() (T-34.10-15)
// ---------------------------------------------------------------------------

describe('AC 8: Readiness Helper — waitForMinaReady() (Story 34.10)', () => {
  it('[T-34.10-15] should have a mina-helpers.ts file', () => {
    expect(fs.existsSync(MINA_HELPERS_PATH)).toBe(true);
  });

  it('[T-34.10-15] should export waitForMinaReady function', () => {
    const content = loadFileContent(MINA_HELPERS_PATH);
    expect(content).toMatch(/export\s+(async\s+)?function\s+waitForMinaReady/);
  });

  it('[T-34.10-15] should poll accounts manager using non-mutating endpoint (list-acquired-accounts)', () => {
    const content = loadFileContent(MINA_HELPERS_PATH);
    expect(content).toContain('list-acquired-accounts');
  });

  it('[T-34.10-15] should NOT use /acquire-account for readiness polling', () => {
    const content = loadFileContent(MINA_HELPERS_PATH);
    // The helper should contain /acquire-account only in the acquireFundedAccount function,
    // NOT in the waitForMinaReady function
    const waitForMinaSection = content.split('waitForMinaReady')[1]?.split('export')[0] || '';
    expect(waitForMinaSection).not.toContain('/acquire-account');
  });

  it('[T-34.10-15] should poll GraphQL endpoint on port 3085', () => {
    const content = loadFileContent(MINA_HELPERS_PATH);
    expect(content).toContain('localhost:3085');
  });

  it('[T-34.10-15] should have a 180-second timeout', () => {
    const content = loadFileContent(MINA_HELPERS_PATH);
    expect(content).toMatch(/180[_\s]*000|180\s*\*\s*1000|timeout.*180/i);
  });

  it('[T-34.10-15] should use 2-second polling interval', () => {
    const content = loadFileContent(MINA_HELPERS_PATH);
    expect(content).toMatch(/2[_\s]*000|2\s*\*\s*1000|interval.*2/i);
  });

  it('[T-34.10-15] should throw a descriptive error on timeout', () => {
    const content = loadFileContent(MINA_HELPERS_PATH);
    expect(content).toMatch(/throw\s+new\s+Error|Error\(/);
    expect(content).toMatch(/ready|timeout|not.*available/i);
  });
});

// ---------------------------------------------------------------------------
// Documentation Updates Verification
// ---------------------------------------------------------------------------

describe('Documentation: CLAUDE.md and docker-compose comments updated (Story 34.10)', () => {
  it('should mention mina-up in CLAUDE.md', () => {
    const claudeMd = loadFileContent(path.join(PROJECT_ROOT, 'CLAUDE.md'));
    expect(claudeMd).toContain('mina-up');
  });

  it('should mention mina-down in CLAUDE.md', () => {
    const claudeMd = loadFileContent(path.join(PROJECT_ROOT, 'CLAUDE.md'));
    expect(claudeMd).toContain('mina-down');
  });

  it('should mention mina-logs in CLAUDE.md', () => {
    const claudeMd = loadFileContent(path.join(PROJECT_ROOT, 'CLAUDE.md'));
    expect(claudeMd).toContain('mina-logs');
  });

  it('should update docker-compose.yml usage comment to include mina targets', () => {
    const composeContent = loadFileContent(DOCKER_COMPOSE_PATH);
    expect(composeContent).toMatch(/mina-up/);
    expect(composeContent).toMatch(/mina-down/);
  });

  it('should update infra-up description in CLAUDE.md to reference all three chains', () => {
    const claudeMd = loadFileContent(path.join(PROJECT_ROOT, 'CLAUDE.md'));
    // Should mention EVM + Solana + Mina together in the infra-up context
    expect(claudeMd).toMatch(/EVM.*Solana.*Mina|all.*chains.*EVM.*Solana.*Mina/i);
  });
});
