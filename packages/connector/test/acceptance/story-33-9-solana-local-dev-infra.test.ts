/**
 * Acceptance Tests for Story 33.9: Solana Local Development Infrastructure
 *
 * These tests validate the Docker Compose infrastructure, Makefile targets, init
 * entrypoint script, and CI pipeline changes required for local Solana development.
 *
 * Acceptance Criteria Covered:
 * - AC1: Docker Compose Service — Solana Test Validator
 * - AC2: Program Auto-Deployment on Startup
 * - AC3: Makefile Targets (solana-up, solana-down, solana-logs)
 * - AC4: Subscription Test Un-Skipped (T-33.7-05, T-33.7-10)
 * - AC5: Infra-Up / Infra-Down Convenience Targets
 * - AC6: EVM Regression — Anvil Tests Still Pass
 * - AC7: CI Pipeline — Solana Integration Job Uses Docker Compose
 *
 * @module test/acceptance/story-33-9
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

// Helper: Resolve the mounted entrypoint script content from docker-compose volumes
function getEntrypointContent(): string {
  const compose = loadDockerCompose();
  const svc = getService(compose, 'solana-validator');

  // Check inline command/entrypoint first
  const command = JSON.stringify(svc['command'] || '');
  const entrypoint = JSON.stringify(svc['entrypoint'] || '');
  let combined = command + entrypoint;

  // If the command references a mounted script, resolve and read it
  const volumes = (svc['volumes'] as string[]) || [];
  for (const vol of volumes) {
    const match = vol.match(/^\.\/(.+?):(.+?)(?::ro)?$/);
    if (match && match[2] === '/entrypoint.sh') {
      const scriptPath = path.join(PROJECT_ROOT, match[1]!);
      if (fs.existsSync(scriptPath)) {
        combined += fs.readFileSync(scriptPath, 'utf8');
      }
    }
  }

  return combined;
}

// ---------------------------------------------------------------------------
// AC 1: Docker Compose Service — Solana Test Validator (T-33.9-01, T-33.9-02)
// ---------------------------------------------------------------------------

describe('AC 1: Docker Compose Service — Solana Test Validator (Story 33.9)', () => {
  let compose: ComposeFile;

  beforeAll(() => {
    compose = loadDockerCompose();
  });

  it('[T-33.9-01] should define a solana-validator service', () => {
    const services = compose['services'] as Record<string, unknown>;
    expect(services).toHaveProperty('solana-validator');
  });

  it('[T-33.9-01] should use the beeman multi-arch image', () => {
    const svc = getService(compose, 'solana-validator');
    expect(svc['image']).toBe('ghcr.io/beeman/solana-test-validator:latest');
  });

  it('[T-33.9-01] should expose JSON-RPC on port 8899', () => {
    const svc = getService(compose, 'solana-validator');
    const ports = svc['ports'] as string[];
    expect(ports).toEqual(expect.arrayContaining([expect.stringContaining('8899')]));
  });

  it('[T-33.9-01] should expose WebSocket on port 8900', () => {
    const svc = getService(compose, 'solana-validator');
    const ports = svc['ports'] as string[];
    expect(ports).toEqual(expect.arrayContaining([expect.stringContaining('8900')]));
  });

  it('[T-33.9-01] should use Docker Compose profile "solana"', () => {
    const svc = getService(compose, 'solana-validator');
    const profiles = svc['profiles'] as string[];
    expect(profiles).toContain('solana');
  });

  it('[T-33.9-01] should include seccomp=unconfined for Agave v2+ io_uring', () => {
    const svc = getService(compose, 'solana-validator');
    const securityOpt = svc['security_opt'] as string[];
    expect(securityOpt).toEqual(
      expect.arrayContaining([expect.stringContaining('seccomp=unconfined')])
    );
  });

  it('[T-33.9-02] should define a health check using curl on port 8899', () => {
    const svc = getService(compose, 'solana-validator');
    const healthcheck = svc['healthcheck'] as Record<string, unknown>;
    expect(healthcheck).toBeDefined();
    const test = healthcheck['test'];
    expect(JSON.stringify(test)).toContain('localhost:8899/health');
  });

  it('[T-33.9-01] should use tmpfs for Solana ledger data performance', () => {
    const svc = getService(compose, 'solana-validator');
    const tmpfs = svc['tmpfs'];
    expect(tmpfs).toBeDefined();
    expect(JSON.stringify(tmpfs)).toContain('test-ledger');
  });

  it('[T-33.9-01] should mount the Solana program binary directory', () => {
    const svc = getService(compose, 'solana-validator');
    const volumes = svc['volumes'] as string[];
    expect(volumes).toEqual(
      expect.arrayContaining([expect.stringMatching(/solana-program.*target.*deploy.*\/programs/)])
    );
  });
});

// ---------------------------------------------------------------------------
// AC 1 (profiles): EVM services get "evm" profile
// ---------------------------------------------------------------------------

describe('AC 1 (profiles): Existing EVM services use "evm" profile (Story 33.9)', () => {
  let compose: ComposeFile;

  beforeAll(() => {
    compose = loadDockerCompose();
  });

  it('[T-33.9-01] should add profile "evm" to the anvil service', () => {
    const svc = getService(compose, 'anvil');
    const profiles = svc['profiles'] as string[];
    expect(profiles).toContain('evm');
  });

  it('[T-33.9-01] should add profile "evm" to the faucet service', () => {
    const svc = getService(compose, 'faucet');
    const profiles = svc['profiles'] as string[];
    expect(profiles).toContain('evm');
  });
});

// ---------------------------------------------------------------------------
// AC 2: Program Auto-Deployment on Startup (T-33.9-03)
// ---------------------------------------------------------------------------

describe('AC 2: Program Auto-Deployment on Startup (Story 33.9)', () => {
  it('[T-33.9-03] should have an init entrypoint that waits for validator readiness', () => {
    const combined = getEntrypointContent();
    expect(combined).toMatch(/cluster-version|health/);
  });

  it('[T-33.9-03] should airdrop SOL to the default keypair', () => {
    const combined = getEntrypointContent();
    expect(combined).toMatch(/airdrop/);
  });

  it('[T-33.9-03] should deploy .so files from the mounted directory', () => {
    const combined = getEntrypointContent();
    expect(combined).toMatch(/program deploy/);
    expect(combined).toMatch(/\.so/);
  });

  it('[T-33.9-03] should use --reset and --limit-ledger-size flags', () => {
    const combined = getEntrypointContent();
    expect(combined).toContain('--reset');
    expect(combined).toContain('--limit-ledger-size');
  });
});

// ---------------------------------------------------------------------------
// AC 3: Makefile Targets (T-33.9-04, T-33.9-05)
// ---------------------------------------------------------------------------

describe('AC 3: Makefile provides solana-up, solana-down, solana-logs targets (Story 33.9)', () => {
  let makefileContent: string;

  beforeAll(() => {
    makefileContent = loadFileContent(MAKEFILE_PATH);
  });

  it('[T-33.9-04] should define solana-up target using --profile solana', () => {
    expect(makefileContent).toMatch(
      /solana-up:[\s\S]*?docker\s+compose\s+--profile\s+solana\s+up\s+-d/
    );
  });

  it('[T-33.9-04] should define solana-down target using --profile solana', () => {
    expect(makefileContent).toMatch(
      /solana-down:[\s\S]*?docker\s+compose\s+--profile\s+solana\s+down/
    );
  });

  it('[T-33.9-05] should define solana-logs target using --profile solana', () => {
    expect(makefileContent).toMatch(
      /solana-logs:[\s\S]*?docker\s+compose\s+--profile\s+solana\s+logs\s+-f/
    );
  });

  it('[T-33.9-08] should retrofit anvil-up to use --profile evm', () => {
    expect(makefileContent).toMatch(
      /anvil-up:[\s\S]*?docker\s+compose\s+--profile\s+evm\s+up\s+-d/
    );
  });

  it('[T-33.9-08] should retrofit anvil-down to use --profile evm', () => {
    expect(makefileContent).toMatch(/anvil-down:[\s\S]*?docker\s+compose\s+--profile\s+evm\s+down/);
  });

  it('[T-33.9-08] should retrofit anvil-logs to use --profile evm', () => {
    expect(makefileContent).toMatch(
      /anvil-logs:[\s\S]*?docker\s+compose\s+--profile\s+evm\s+logs\s+-f/
    );
  });

  it('[T-33.9-04] should include new targets in .PHONY declaration', () => {
    expect(makefileContent).toMatch(/\.PHONY:.*solana-up/);
    expect(makefileContent).toMatch(/\.PHONY:.*solana-down/);
    expect(makefileContent).toMatch(/\.PHONY:.*solana-logs/);
    expect(makefileContent).toMatch(/\.PHONY:.*infra-up/);
    expect(makefileContent).toMatch(/\.PHONY:.*infra-down/);
  });

  it('[T-33.9-04] should include new targets in make help output', () => {
    expect(makefileContent).toMatch(/help:[\s\S]*solana-up/);
    expect(makefileContent).toMatch(/help:[\s\S]*infra-up/);
  });
});

// ---------------------------------------------------------------------------
// AC 5: Infra-Up / Infra-Down Convenience Targets (T-33.9-06, T-33.9-07)
// ---------------------------------------------------------------------------

describe('AC 5: Infra-Up / Infra-Down Convenience Targets (Story 33.9)', () => {
  let makefileContent: string;

  beforeAll(() => {
    makefileContent = loadFileContent(MAKEFILE_PATH);
  });

  it('[T-33.9-06] should define infra-up target starting evm and solana profiles', () => {
    // Regex allows additional --profile <name> tokens after solana (e.g. Stories
    // 34.10 and 36.1 append --profile mina and --profile ator). The assertion is
    // that evm+solana are composed together into a single `up -d`.
    expect(makefileContent).toMatch(
      /infra-up:[\s\S]*?docker\s+compose\s+--profile\s+evm\s+--profile\s+solana\b[\s\S]*?up\s+-d/
    );
  });

  it('[T-33.9-07] should define infra-down target stopping all profiles', () => {
    // Regex allows additional --profile <name> tokens after solana (e.g. Stories
    // 34.10 and 36.1 append --profile mina and --profile ator). The assertion is
    // that evm+solana are torn down together.
    expect(makefileContent).toMatch(
      /infra-down:[\s\S]*?docker\s+compose\s+--profile\s+evm\s+--profile\s+solana\b[\s\S]*?\bdown\b/
    );
  });
});

// ---------------------------------------------------------------------------
// AC 6: EVM Regression — docker-compose profile migration (T-33.9-08, T-33.9-11)
// ---------------------------------------------------------------------------

describe('AC 6: EVM Regression — Anvil Tests Still Pass (Story 33.9)', () => {
  let compose: ComposeFile;

  beforeAll(() => {
    compose = loadDockerCompose();
  });

  it('[T-33.9-08] should preserve anvil service configuration unchanged', () => {
    const anvil = getService(compose, 'anvil');

    expect(anvil['image']).toBe('ghcr.io/foundry-rs/foundry:latest');
    const ports = anvil['ports'] as string[];
    expect(ports).toEqual(expect.arrayContaining([expect.stringContaining('8545')]));
    expect(anvil['healthcheck']).toBeDefined();
  });

  it('[T-33.9-08] should preserve faucet service configuration unchanged', () => {
    const faucet = getService(compose, 'faucet');

    expect(faucet).toBeDefined();
    expect(faucet['depends_on']).toBeDefined();
    const ports = faucet['ports'] as string[];
    expect(ports).toEqual(expect.arrayContaining([expect.stringContaining('3500')]));
  });

  it('[T-33.9-11] should not break existing docker-compose structure', () => {
    expect(compose).toHaveProperty('services');
    const services = compose['services'] as Record<string, unknown>;
    expect(Object.keys(services).length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// AC 7: CI Pipeline — Solana Integration Job Uses Docker Compose (T-33.9-12)
// ---------------------------------------------------------------------------

describe('AC 7: CI Pipeline — Solana Integration Job Uses Docker Compose (Story 33.9)', () => {
  let ciContent: string;

  beforeAll(() => {
    ciContent = loadFileContent(CI_WORKFLOW_PATH);
  });

  it('[T-33.9-12] should remove the inline services: block for solana-validator', () => {
    expect(ciContent).not.toMatch(/solanalabs\/solana:v2\.1\.0/);
  });

  it('[T-33.9-12] should start Solana infra via docker compose in CI', () => {
    expect(ciContent).toMatch(/docker\s+compose\s+--profile\s+solana\s+up/);
  });

  it('[T-33.9-12] should wait for health check in CI', () => {
    expect(ciContent).toMatch(/localhost:8899\/health|health.*8899/);
  });

  it('[T-33.9-12] should tear down with docker compose in if: always() block', () => {
    expect(ciContent).toMatch(/docker\s+compose\s+--profile\s+solana\s+down/);
    expect(ciContent).toMatch(/if:\s*always\(\)/);
  });

  it('[T-33.9-12] should not have a manual solana program deploy step', () => {
    const solanaIntegrationSection = ciContent.split('solana-integration')[1] || '';
    const nextJobSection =
      solanaIntegrationSection.split(/^\s{2}\w+:/m)[1] || solanaIntegrationSection;
    const jobContent = solanaIntegrationSection.substring(
      0,
      solanaIntegrationSection.indexOf(nextJobSection)
    );

    expect(jobContent).not.toMatch(/solana\s+program\s+deploy/);
  });

  it('[T-33.9-12] should use beeman image consistently (no solanalabs divergence)', () => {
    expect(ciContent).not.toMatch(/solanalabs\/solana/);
  });
});

// ---------------------------------------------------------------------------
// AC 4: Subscription Tests Reference (T-33.9-09, T-33.9-10)
// ---------------------------------------------------------------------------

describe('AC 4: Subscription Tests Compatible with Local Infrastructure (Story 33.9)', () => {
  it('[T-33.9-09] should have solana-subscription.test.ts with SOLANA_INTEGRATION gate', () => {
    const testPath = path.join(
      PROJECT_ROOT,
      'packages',
      'connector',
      'test',
      'integration',
      'solana-subscription.test.ts'
    );
    const content = fs.readFileSync(testPath, 'utf8');
    expect(content).toContain('SOLANA_INTEGRATION');
  });

  it('[T-33.9-09] should reference T-33.7-05 (account subscription) test', () => {
    const testPath = path.join(
      PROJECT_ROOT,
      'packages',
      'connector',
      'test',
      'integration',
      'solana-subscription.test.ts'
    );
    const content = fs.readFileSync(testPath, 'utf8');
    expect(content).toContain('T-33.7-05');
  });

  it('[T-33.9-10] should reference T-33.7-10 (graceful shutdown) test', () => {
    const testPath = path.join(
      PROJECT_ROOT,
      'packages',
      'connector',
      'test',
      'integration',
      'solana-subscription.test.ts'
    );
    const content = fs.readFileSync(testPath, 'utf8');
    expect(content).toContain('T-33.7-10');
  });
});

// ---------------------------------------------------------------------------
// Gap-fill tests: AC 1 — Health Check Timing Parameters (T-33.9-02)
// ---------------------------------------------------------------------------

describe('AC 1 (timing): Health check timing parameters (Story 33.9)', () => {
  let compose: ComposeFile;

  beforeAll(() => {
    compose = loadDockerCompose();
  });

  it('[T-33.9-02] should configure health check start_period of 30s', () => {
    const svc = getService(compose, 'solana-validator');
    const healthcheck = svc['healthcheck'] as Record<string, unknown>;
    expect(healthcheck).toBeDefined();
    // Accepts '30s' or similar Docker duration format
    expect(String(healthcheck['start_period'])).toMatch(/^30s?$/);
  });

  it('[T-33.9-02] should configure health check interval of 10s', () => {
    const svc = getService(compose, 'solana-validator');
    const healthcheck = svc['healthcheck'] as Record<string, unknown>;
    expect(healthcheck).toBeDefined();
    expect(String(healthcheck['interval'])).toMatch(/^10s?$/);
  });

  it('[T-33.9-01] should configure restart policy as unless-stopped', () => {
    const svc = getService(compose, 'solana-validator');
    expect(svc['restart']).toBe('unless-stopped');
  });
});

// ---------------------------------------------------------------------------
// Gap-fill tests: AC 2 — Entrypoint keypair & retry logic (T-33.9-03)
// ---------------------------------------------------------------------------

describe('AC 2 (detail): Entrypoint keypair generation and airdrop retry (Story 33.9)', () => {
  it('[T-33.9-03] should generate a default keypair via solana-keygen', () => {
    const content = getEntrypointContent();
    expect(content).toMatch(/solana-keygen\s+new/);
  });

  it('[T-33.9-03] should retry airdrop up to 5 times for flaky airdrop handling', () => {
    const content = getEntrypointContent();
    // Verify retry logic exists with count of 5
    expect(content).toMatch(/AIRDROP_RETRIES=5|retry.*5|seq\s+1\s+5/);
  });

  it('[T-33.9-03] should log program deployment status to stdout', () => {
    const content = getEntrypointContent();
    // AC2 requires "the deployed program ID is logged to stdout"
    // The entrypoint uses `solana program deploy` which outputs program ID, and
    // the non-fatal echo pattern logs deploy results
    expect(content).toMatch(/echo.*[Dd]eploy|program deploy/);
    expect(content).toContain('Solana validator ready with programs deployed');
  });
});

// ---------------------------------------------------------------------------
// Gap-fill tests: AC 3/AC 6 — Profile isolation (T-33.9-04)
// ---------------------------------------------------------------------------

describe('AC 3/AC 6 (isolation): Profile-based targets are properly isolated (Story 33.9)', () => {
  let makefileContent: string;

  beforeAll(() => {
    makefileContent = loadFileContent(MAKEFILE_PATH);
  });

  it('[T-33.9-04] solana-down should not reference evm profile', () => {
    // Extract only the solana-down recipe (from target to next target)
    const solanaDownMatch = makefileContent.match(/^solana-down:.*\n(?:\t.*\n)*/m);
    expect(solanaDownMatch).toBeTruthy();
    expect(solanaDownMatch![0]).not.toContain('--profile evm');
  });

  it('[T-33.9-08] anvil-down should not reference solana profile', () => {
    // Extract only the anvil-down recipe
    const anvilDownMatch = makefileContent.match(/^anvil-down:.*\n(?:\t.*\n)*/m);
    expect(anvilDownMatch).toBeTruthy();
    expect(anvilDownMatch![0]).not.toContain('--profile solana');
  });

  it('[T-33.9-04] solana-up should not reference evm profile', () => {
    const solanaUpMatch = makefileContent.match(/^solana-up:.*\n(?:\t.*\n)*/m);
    expect(solanaUpMatch).toBeTruthy();
    expect(solanaUpMatch![0]).not.toContain('--profile evm');
  });
});

// ---------------------------------------------------------------------------
// Gap-fill tests: AC 7 — CI environment and flags (T-33.9-12)
// ---------------------------------------------------------------------------

describe('AC 7 (detail): CI pipeline environment and flag details (Story 33.9)', () => {
  let ciContent: string;

  beforeAll(() => {
    ciContent = loadFileContent(CI_WORKFLOW_PATH);
  });

  it('[T-33.9-12] should set SOLANA_INTEGRATION env var to true in CI test step', () => {
    expect(ciContent).toMatch(/SOLANA_INTEGRATION:\s*['"]?true['"]?/);
  });

  it('[T-33.9-12] should start docker compose in detached mode (-d) in CI', () => {
    expect(ciContent).toMatch(/docker\s+compose\s+--profile\s+solana\s+up\s+-d/);
  });

  it('[T-33.9-12] should not have an inline services block for any solana image', () => {
    // Verify no GitHub Actions services: block references any solana image
    // This catches both solanalabs and beeman images in an inline services block
    const servicesBlockMatch = ciContent.match(
      /^\s+services:\s*\n(?:\s+\w[\w-]*:\s*\n(?:\s+\w.*\n)*)+/gm
    );
    if (servicesBlockMatch) {
      for (const block of servicesBlockMatch) {
        expect(block).not.toMatch(/solana/i);
      }
    }
  });

  it('[T-33.9-12] should configure SOLANA_RPC_URL and SOLANA_WS_URL in CI', () => {
    expect(ciContent).toMatch(/SOLANA_RPC_URL:\s*http:\/\/localhost:8899/);
    expect(ciContent).toMatch(/SOLANA_WS_URL:\s*ws:\/\/localhost:8900/);
  });
});
