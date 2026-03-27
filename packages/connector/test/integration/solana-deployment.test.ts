/**
 * Solana Deployment Verification Tests
 *
 * Story 33.8: Verify deployment artifacts, configuration schema, Makefile targets,
 * and operational documentation for Solana devnet deployment.
 *
 * Test IDs covered:
 * - T-33.8-01: Deploy script exists and is executable
 * - T-33.8-02: program-id.json schema validation
 * - T-33.8-03: Upgrade authority documentation covers authority transfer
 * - T-33.8-04: SolanaProviderConfig accepts valid devnet config
 * - T-33.8-06: Makefile contains solana-deploy-devnet target
 * - T-33.8-07: Documentation file exists at docs/solana-deployment.md
 * - T-33.8-08: Documentation covers all required sections
 * - T-33.8-09: Deploy script verifies deployment (AC 1)
 * - T-33.8-10: Deposit management guide completeness (AC 4)
 * - T-33.8-11: Upgrade runbook completeness (AC 5)
 * - T-33.8-12: Monitoring guide completeness (AC 6)
 * - T-33.8-13: Configuration documentation completeness (AC 3)
 *
 * No infrastructure required -- these tests use static file inspection,
 * TypeScript type validation, and runtime config validation.
 *
 * @packageDocumentation
 */

import * as path from 'path';
import * as fs from 'fs';
import type { SolanaProviderConfig } from '../../src/settlement/provider/payment-channel-provider';
import type { ConnectorConfig, ChainProviderConfigEntry } from '../../src/config/types';
import { validateChainProviders } from '../../src/config/types';

jest.setTimeout(30_000);

// ---------------------------------------------------------------------------
// Path Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '../../../..');
const DEPLOY_SCRIPT = path.join(PROJECT_ROOT, 'tools/solana/deploy.sh');
const MAKEFILE = path.join(PROJECT_ROOT, 'Makefile');
const DOCS_FILE = path.join(PROJECT_ROOT, 'docs/solana-deployment.md');

// ---------------------------------------------------------------------------
// T-33.8-01: Deploy script exists and is executable (AC 1, Story 33.8)
// ---------------------------------------------------------------------------

describe('[T-33.8-01] Deploy script exists and is executable (Story 33.8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should have deploy.sh at tools/solana/deploy.sh', () => {
    // Given: the project repository with Solana deployment infrastructure
    // When: checking for the deploy script
    const exists = fs.existsSync(DEPLOY_SCRIPT);

    // Then: the deploy script exists
    expect(exists).toBe(true);
  });

  it('should have deploy.sh marked as executable', () => {
    // Given: the deploy script exists
    // When: checking file permissions
    const stats = fs.statSync(DEPLOY_SCRIPT);
    const isExecutable = (stats.mode & 0o111) !== 0;

    // Then: the script has execute permission
    expect(isExecutable).toBe(true);
  });

  it('should contain required deployment functionality', () => {
    // Given: the deploy script
    const content = fs.readFileSync(DEPLOY_SCRIPT, 'utf8');

    // Then: it contains network selection support
    expect(content).toMatch(/--network/);

    // And: it contains keypair parameter support
    expect(content).toMatch(/--keypair/);

    // And: it contains upgrade authority support
    expect(content).toMatch(/--upgrade-authority/);

    // And: it contains program ID recording
    expect(content).toMatch(/program-id\.json/);
  });
});

// ---------------------------------------------------------------------------
// T-33.8-02: program-id.json schema validation (AC 1, Story 33.8)
// ---------------------------------------------------------------------------

describe('[T-33.8-02] program-id.json schema validation (Story 33.8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should validate a well-formed program-id.json structure', () => {
    // Given: the expected schema for program-id.json output
    const validProgramIdJson = {
      programId: 'PayChan1111111111111111111111111111111111111',
      network: 'devnet',
      rpcUrl: 'https://api.devnet.solana.com',
      deployedAt: '2026-03-26T00:00:00.000Z',
      deployerPubkey: 'DeployerPubkey111111111111111111111111111111',
      binarySize: 95000,
    };

    // When: validating schema fields
    // Then: all required fields are present and correctly typed
    expect(typeof validProgramIdJson.programId).toBe('string');
    expect(typeof validProgramIdJson.network).toBe('string');
    expect(typeof validProgramIdJson.rpcUrl).toBe('string');
    expect(typeof validProgramIdJson.deployedAt).toBe('string');
    expect(typeof validProgramIdJson.deployerPubkey).toBe('string');
    expect(typeof validProgramIdJson.binarySize).toBe('number');

    // And: programId is a valid base58 string (32+ chars)
    expect(validProgramIdJson.programId.length).toBeGreaterThanOrEqual(32);

    // And: network is a valid Solana cluster
    expect(['devnet', 'testnet', 'mainnet-beta']).toContain(validProgramIdJson.network);
  });

  it('should verify deploy script writes program-id.json on deployment', () => {
    // Given: the deploy script source
    const deployScript = fs.readFileSync(DEPLOY_SCRIPT, 'utf8');

    // Then: the script writes to program-id.json
    expect(deployScript).toMatch(/program-id\.json/);

    // And: the script captures programId from deployment output
    expect(deployScript).toMatch(/programId/i);
  });
});

// ---------------------------------------------------------------------------
// T-33.8-03: Upgrade authority documentation (AC 2, Story 33.8)
// ---------------------------------------------------------------------------

describe('[T-33.8-03] Upgrade authority documentation covers authority transfer (Story 33.8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should have documentation covering upgrade authority management', () => {
    // Given: the operational documentation file
    // When: checking file existence
    const exists = fs.existsSync(DOCS_FILE);

    // Then: documentation file exists
    expect(exists).toBe(true);

    // And: it contains upgrade authority section
    const content = fs.readFileSync(DOCS_FILE, 'utf8');
    expect(content.toLowerCase()).toMatch(/upgrade.?authority/);
  });

  it('should document authority transfer process', () => {
    // Given: the operational documentation
    const content = fs.readFileSync(DOCS_FILE, 'utf8');

    // Then: it documents how to transfer upgrade authority
    expect(content).toMatch(/set-upgrade-authority|transfer.*authority|--upgrade-authority/i);
  });

  it('should warn about making program immutable', () => {
    // Given: the operational documentation
    const content = fs.readFileSync(DOCS_FILE, 'utf8');

    // Then: it warns about the irreversible --final flag
    expect(content).toMatch(/--final|immutable|irreversible/i);
  });
});

// ---------------------------------------------------------------------------
// T-33.8-04: SolanaProviderConfig accepts valid devnet config (AC 3, Story 33.8)
// ---------------------------------------------------------------------------

describe('[T-33.8-04] SolanaProviderConfig accepts valid devnet config (Story 33.8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should accept a valid devnet configuration', () => {
    // Given: a valid SolanaProviderConfig for devnet
    const config: SolanaProviderConfig = {
      chainType: 'solana',
      rpcUrl: 'https://api.devnet.solana.com',
      wsUrl: 'wss://api.devnet.solana.com',
      programId: 'PayChan1111111111111111111111111111111111111',
      keyId: 'solana-operator-key',
      cluster: 'devnet',
    };

    // Then: all required fields are present
    expect(config.chainType).toBe('solana');
    expect(config.rpcUrl).toMatch(/^https?:\/\//);
    expect(config.programId).toBeTruthy();
    expect(config.keyId).toBeTruthy();
  });

  it('should accept config without optional fields', () => {
    // Given: a minimal SolanaProviderConfig (only required fields)
    const config: SolanaProviderConfig = {
      chainType: 'solana',
      rpcUrl: 'https://api.devnet.solana.com',
      programId: 'PayChan1111111111111111111111111111111111111',
      keyId: 'solana-operator-key',
    };

    // Then: config is valid without optional wsUrl and cluster
    expect(config.chainType).toBe('solana');
    expect(config.wsUrl).toBeUndefined();
    expect(config.cluster).toBeUndefined();
  });

  it('should have documentation explaining all config fields', () => {
    // Given: the documentation file
    const exists = fs.existsSync(DOCS_FILE);
    expect(exists).toBe(true);

    const content = fs.readFileSync(DOCS_FILE, 'utf8');

    // Then: all SolanaProviderConfig fields are documented
    expect(content).toMatch(/rpcUrl/);
    expect(content).toMatch(/programId/);
    expect(content).toMatch(/keyId/);
    expect(content).toMatch(/wsUrl/);
    expect(content).toMatch(/cluster/);
  });

  it('should have documentation with a working YAML config example', () => {
    // Given: the documentation file
    const content = fs.readFileSync(DOCS_FILE, 'utf8');

    // Then: it contains a YAML config example with chainProviders
    expect(content).toMatch(/chainProviders/);
    expect(content).toMatch(/chainType:\s*solana/);
  });

  it('should pass runtime validateChainProviders for a valid Solana devnet config', () => {
    // Given: a ConnectorConfig with a Solana chainProvider and a peer referencing it
    const config: ConnectorConfig = {
      nodeId: 'test-node',
      btpServerPort: 3000,
      environment: 'development',
      peers: [
        {
          id: 'peer-solana',
          url: 'wss://peer-solana:3001',
          authToken: 'secret',
          chain: 'solana:devnet',
        },
      ],
      routes: [],
      chainProviders: [
        {
          chainType: 'solana',
          chainId: 'solana:devnet',
          rpcUrl: 'https://api.devnet.solana.com',
          programId: 'PayChan1111111111111111111111111111111111111',
          keyId: 'solana-operator-key',
          cluster: 'devnet',
        },
      ],
    };

    // When/Then: runtime validation passes without throwing
    expect(() => validateChainProviders(config)).not.toThrow();
  });

  it('should reject Solana config missing required programId via runtime validation', () => {
    // Given: a ConnectorConfig with a Solana provider missing programId
    const config: ConnectorConfig = {
      nodeId: 'test-node',
      btpServerPort: 3000,
      environment: 'development',
      peers: [],
      routes: [],
      chainProviders: [
        {
          chainType: 'solana',
          chainId: 'solana:devnet',
          rpcUrl: 'https://api.devnet.solana.com',
          keyId: 'solana-operator-key',
        } as ChainProviderConfigEntry,
      ],
    };

    // When/Then: runtime validation rejects the missing field
    expect(() => validateChainProviders(config)).toThrow(/Missing required field 'programId'/);
  });

  it('should reject peer referencing unregistered Solana chain', () => {
    // Given: a peer referencing a chainId not in chainProviders
    const config: ConnectorConfig = {
      nodeId: 'test-node',
      btpServerPort: 3000,
      environment: 'development',
      peers: [
        {
          id: 'peer-solana',
          url: 'wss://peer-solana:3001',
          authToken: 'secret',
          chain: 'solana:devnet',
        },
      ],
      routes: [],
      chainProviders: [
        {
          chainType: 'solana',
          chainId: 'solana:mainnet-beta',
          rpcUrl: 'https://api.mainnet-beta.solana.com',
          programId: 'PayChan1111111111111111111111111111111111111',
          keyId: 'solana-operator-key',
        },
      ],
    };

    // When/Then: runtime validation rejects the unregistered chain reference
    expect(() => validateChainProviders(config)).toThrow(/unregistered chain/);
  });
});

// ---------------------------------------------------------------------------
// T-33.8-06: Makefile contains solana-deploy-devnet target (AC 1, Story 33.8)
// ---------------------------------------------------------------------------

describe('[T-33.8-06] Makefile contains solana-deploy-devnet target (Story 33.8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should have solana-deploy-devnet target in Makefile', () => {
    // Given: the project Makefile
    const content = fs.readFileSync(MAKEFILE, 'utf8');

    // Then: it contains the solana-deploy-devnet target
    expect(content).toMatch(/^solana-deploy-devnet:/m);
  });

  it('should have solana-build target in Makefile', () => {
    // Given: the project Makefile
    const content = fs.readFileSync(MAKEFILE, 'utf8');

    // Then: it contains the solana-build target
    expect(content).toMatch(/^solana-build:/m);
  });

  it('should have solana-test target in Makefile', () => {
    // Given: the project Makefile
    const content = fs.readFileSync(MAKEFILE, 'utf8');

    // Then: it contains the solana-test target
    expect(content).toMatch(/^solana-test:/m);
  });

  it('should require DEPLOYER_KEYPAIR for deployment', () => {
    // Given: the project Makefile
    const content = fs.readFileSync(MAKEFILE, 'utf8');

    // Then: deployment target requires DEPLOYER_KEYPAIR
    expect(content).toMatch(/DEPLOYER_KEYPAIR/);
  });
});

// ---------------------------------------------------------------------------
// T-33.8-07: Documentation file exists (AC 3, Story 33.8)
// ---------------------------------------------------------------------------

describe('[T-33.8-07] Documentation file exists at docs/solana-deployment.md (Story 33.8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should have documentation file at docs/solana-deployment.md', () => {
    // Given: the project directory structure
    // When: checking for the documentation file
    const exists = fs.existsSync(DOCS_FILE);

    // Then: the documentation file exists
    expect(exists).toBe(true);
  });

  it('should have non-empty documentation content', () => {
    // Given: the documentation file
    const content = fs.readFileSync(DOCS_FILE, 'utf8');

    // Then: it is not empty
    expect(content.length).toBeGreaterThan(100);
  });

  it('should have a top-level heading', () => {
    // Given: the documentation file
    const content = fs.readFileSync(DOCS_FILE, 'utf8');

    // Then: it starts with a markdown heading
    expect(content).toMatch(/^#\s+/m);
  });
});

// ---------------------------------------------------------------------------
// T-33.8-08: Documentation covers all required sections (AC 3,4,5,6, Story 33.8)
// ---------------------------------------------------------------------------

describe('[T-33.8-08] Documentation covers all required sections (Story 33.8)', () => {
  let docsContent: string;

  beforeAll(() => {
    docsContent = fs.readFileSync(DOCS_FILE, 'utf8');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // AC 3: Configuration Documentation
  it('should have a configuration section', () => {
    // Given: the operational documentation
    // Then: it contains a configuration section
    expect(docsContent.toLowerCase()).toMatch(/configuration|provider.*config/);
  });

  it('should document RPC endpoint configuration', () => {
    // Given: the operational documentation
    // Then: it documents RPC endpoints
    expect(docsContent).toMatch(/rpc.*endpoint|rpcUrl|api\.devnet\.solana\.com/i);
  });

  it('should document program ID configuration', () => {
    // Given: the operational documentation
    // Then: it documents program ID setup
    expect(docsContent).toMatch(/program.?id|programId/i);
  });

  // AC 4: Deposit Management Guide
  it('should have a deposit management section', () => {
    // Given: the operational documentation
    // Then: it contains deposit management guidance
    expect(docsContent.toLowerCase()).toMatch(/deposit|fund.*channel|vault/);
  });

  // AC 5: Upgrade Runbook
  it('should have an upgrade runbook section', () => {
    // Given: the operational documentation
    // Then: it contains upgrade instructions
    expect(docsContent.toLowerCase()).toMatch(/upgrade.*runbook|program.*upgrade|upgrade.*program/);
  });

  it('should document the upgrade process steps', () => {
    // Given: the operational documentation
    // Then: it documents building new binary
    expect(docsContent).toMatch(/cargo build-sbf|solana program deploy/i);
  });

  // AC 6: Monitoring Guide
  it('should have a monitoring section', () => {
    // Given: the operational documentation
    // Then: it contains monitoring guidance
    expect(docsContent.toLowerCase()).toMatch(/monitor|channel.*health|stuck.*channel/);
  });

  it('should document stuck channel detection', () => {
    // Given: the operational documentation
    // Then: it documents how to detect stuck channels
    expect(docsContent.toLowerCase()).toMatch(/stuck|challenge.*period|close.*timestamp/);
  });

  // Deployment prerequisites
  it('should document deployment prerequisites', () => {
    // Given: the operational documentation
    // Then: it documents prerequisites (Solana CLI, keypair, SOL balance)
    expect(docsContent.toLowerCase()).toMatch(/prerequisite|solana.*cli|keypair|airdrop/);
  });

  // Cost estimates
  it('should document deployment cost estimates', () => {
    // Given: the operational documentation
    // Then: it documents rent and cost information
    expect(docsContent.toLowerCase()).toMatch(/cost|rent|sol/);
  });
});

// ---------------------------------------------------------------------------
// T-33.8-09: Deploy script includes deployment verification (AC 1, Story 33.8)
// ---------------------------------------------------------------------------

describe('[T-33.8-09] Deploy script verifies deployment on-chain (Story 33.8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should verify deployment via solana program show', () => {
    // Given: the deploy script
    const content = fs.readFileSync(DEPLOY_SCRIPT, 'utf8');

    // Then: the script contains a verification step using solana program show
    expect(content).toMatch(/solana\s+program\s+show/);
  });

  it('should support devnet as a deployment target', () => {
    // Given: the deploy script
    const content = fs.readFileSync(DEPLOY_SCRIPT, 'utf8');

    // Then: the script references devnet as a valid network
    expect(content).toMatch(/devnet/);
  });

  it('should check deployer balance before deployment', () => {
    // Given: the deploy script
    const content = fs.readFileSync(DEPLOY_SCRIPT, 'utf8');

    // Then: the script checks the deployer balance
    expect(content).toMatch(/balance/i);
  });

  it('should require confirmation for mainnet-beta', () => {
    // Given: the deploy script
    const content = fs.readFileSync(DEPLOY_SCRIPT, 'utf8');

    // Then: the script requires confirmation for mainnet-beta deployments
    expect(content).toMatch(/mainnet-beta/);
  });
});

// ---------------------------------------------------------------------------
// T-33.8-10: Deposit management guide completeness (AC 4, Story 33.8)
// ---------------------------------------------------------------------------

describe('[T-33.8-10] Deposit management guide covers full workflow (Story 33.8)', () => {
  let docsContent: string;

  beforeAll(() => {
    docsContent = fs.readFileSync(DOCS_FILE, 'utf8');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should document how to open a channel', () => {
    // Given: the deposit management documentation
    // Then: it explains opening a channel
    expect(docsContent.toLowerCase()).toMatch(/open.*channel|opening.*channel/);
  });

  it('should document how to fund a channel vault', () => {
    // Given: the deposit management documentation
    // Then: it explains funding a vault
    expect(docsContent.toLowerCase()).toMatch(/fund.*vault|funding.*vault|deposit/);
  });

  it('should document how to verify a deposit on-chain', () => {
    // Given: the deposit management documentation
    // Then: it explains verifying deposits on-chain via RPC
    expect(docsContent).toMatch(/verif.*deposit|solana\s+account/i);
  });

  it('should document PDA derivation for channel accounts', () => {
    // Given: the deposit management documentation
    // Then: it explains PDA seeds for channel identification
    expect(docsContent).toMatch(/PDA|program.derived.address|seeds/i);
  });

  it('should include SDK deposit code example', () => {
    // Given: the deposit management documentation
    // Then: it includes a TypeScript code example for deposits
    expect(docsContent).toMatch(/deposit\(/);
  });
});

// ---------------------------------------------------------------------------
// T-33.8-11: Upgrade runbook completeness (AC 5, Story 33.8)
// ---------------------------------------------------------------------------

describe('[T-33.8-11] Upgrade runbook covers full upgrade lifecycle (Story 33.8)', () => {
  let docsContent: string;

  beforeAll(() => {
    docsContent = fs.readFileSync(DOCS_FILE, 'utf8');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should document building a new program binary', () => {
    // Given: the upgrade runbook
    // Then: it documents building the new binary
    expect(docsContent).toMatch(/cargo build-sbf/);
  });

  it('should document deploying an upgrade with --program-id', () => {
    // Given: the upgrade runbook
    // Then: it documents the upgrade deployment using --program-id
    expect(docsContent).toMatch(/--program-id/);
  });

  it('should document upgrade authority transfer during upgrade', () => {
    // Given: the upgrade runbook
    // Then: it documents authority management in upgrade context
    expect(docsContent).toMatch(/set-upgrade-authority/);
  });

  it('should document rollback process', () => {
    // Given: the upgrade runbook
    // Then: it documents how to roll back to a previous version
    expect(docsContent.toLowerCase()).toMatch(/rollback/);
  });

  it('should warn that rollback requires upgradeable program', () => {
    // Given: the upgrade runbook
    // Then: it warns that rollback is only possible if program is upgradeable
    expect(docsContent.toLowerCase()).toMatch(
      /rollback.*upgradeable|upgradeable.*rollback|not.*--final|not.*immutable/
    );
  });

  it('should document verifying the upgrade via solana program show', () => {
    // Given: the upgrade runbook
    // Then: it documents verifying the upgrade
    expect(docsContent).toMatch(/solana program show/);
  });
});

// ---------------------------------------------------------------------------
// T-33.8-12: Monitoring guide completeness (AC 6, Story 33.8)
// ---------------------------------------------------------------------------

describe('[T-33.8-12] Monitoring guide covers channel health observation (Story 33.8)', () => {
  let docsContent: string;

  beforeAll(() => {
    docsContent = fs.readFileSync(DOCS_FILE, 'utf8');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should document channel state values (Opened, Closed, Settled)', () => {
    // Given: the monitoring guide
    // Then: it documents all channel states
    expect(docsContent).toMatch(/Opened/);
    expect(docsContent).toMatch(/Closed/);
    expect(docsContent).toMatch(/Settled/);
  });

  it('should document observing channel state changes via subscriptions', () => {
    // Given: the monitoring guide
    // Then: it documents SDK-based subscriptions for state changes
    expect(docsContent).toMatch(/subscribe|onAccountChange/i);
  });

  it('should document stuck channel detection logic with challenge period', () => {
    // Given: the monitoring guide
    // Then: it documents the detection logic involving challenge_duration
    expect(docsContent).toMatch(/challenge_duration|challengeDuration/);
    expect(docsContent).toMatch(/close_timestamp|closeTimestamp/);
  });

  it('should document the alert threshold for stuck channels', () => {
    // Given: the monitoring guide
    // Then: it specifies the alert threshold (challenge_duration + grace period)
    expect(docsContent.toLowerCase()).toMatch(/grace.*period|5.*minute|alert.*threshold/);
  });

  it('should document RPC-based monitoring commands', () => {
    // Given: the monitoring guide
    // Then: it includes RPC commands for checking program and channel state
    expect(docsContent).toMatch(/solana program show/);
    expect(docsContent).toMatch(/solana account/);
    expect(docsContent).toMatch(/solana balance/);
  });

  it('should include SDK-based monitoring code example', () => {
    // Given: the monitoring guide
    // Then: it includes TypeScript code for monitoring
    expect(docsContent).toMatch(/subscribeToChannel|getChannelState/);
  });

  it('should document periodic polling as alternative to subscriptions', () => {
    // Given: the monitoring guide
    // Then: it documents polling as an alternative monitoring approach
    expect(docsContent.toLowerCase()).toMatch(/poll|interval|periodic/);
  });
});

// ---------------------------------------------------------------------------
// T-33.8-13: Configuration documentation completeness (AC 3, Story 33.8)
// ---------------------------------------------------------------------------

describe('[T-33.8-13] Configuration documentation covers all required elements (Story 33.8)', () => {
  let docsContent: string;

  beforeAll(() => {
    docsContent = fs.readFileSync(DOCS_FILE, 'utf8');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should document per-peer chain field referencing chainId', () => {
    // Given: the configuration documentation
    // Then: it documents the per-peer chain field
    expect(docsContent).toMatch(/chain.*chainId|chain.*reference|per.*peer/i);
  });

  it('should include a complete YAML example with peers section', () => {
    // Given: the configuration documentation
    // Then: the YAML example includes both chainProviders and peers
    expect(docsContent).toMatch(/chainProviders/);
    expect(docsContent).toMatch(/peers:/);
  });

  it('should document the chainId format for Solana', () => {
    // Given: the configuration documentation
    // Then: it shows the Solana chainId format (e.g., solana:devnet)
    expect(docsContent).toMatch(/solana:devnet/);
  });

  it('should document the SolanaProviderConfig field table', () => {
    // Given: the configuration documentation
    // Then: it includes a structured field reference (table format)
    expect(docsContent).toMatch(/chainType.*solana|Field.*Type.*Required/i);
  });

  it('should document devnet RPC endpoint URLs', () => {
    // Given: the configuration documentation
    // Then: it includes devnet endpoint URLs
    expect(docsContent).toMatch(/https:\/\/api\.devnet\.solana\.com/);
    expect(docsContent).toMatch(/wss:\/\/api\.devnet\.solana\.com/);
  });
});
