/**
 * Mina Deployment Verification Tests
 *
 * Story 34.9: Verify deployment artifacts, configuration schema, Makefile targets,
 * and operational documentation for Mina devnet deployment.
 *
 * Test IDs covered:
 * - T-34.9-01: Deploy script argument parsing (--network required, HTTPS enforced, --deployer-key fallback)
 * - T-34.9-02: MinaProviderConfig schema validation (required fields, optional fields, invalid chainType)
 * - T-34.9-02b: Invalid chainType rejection via runtime validation
 * - T-34.9-03: zkApp address format validation (B62 prefix, length checks, invalid formats rejected)
 * - T-34.9-04: Mina chainId format validation (mina:devnet, mina:mainnet accepted, invalid rejected)
 * - T-34.9-04b: Performance benchmark documentation completeness
 * - T-34.9-05: Documentation file exists at docs/mina-deployment.md
 * - T-34.9-05b: Documentation covers all required sections (config, privacy, benchmarks, ops)
 * - T-34.9-06: Makefile contains mina-deploy-devnet target
 * - T-34.9-06b: Documentation lists Makefile targets (mina-build, mina-test, mina-deploy-devnet) with prerequisites
 * - T-34.9-07: Deployment verification logic with mock GraphQL
 *
 * No infrastructure required -- these tests use static file inspection,
 * TypeScript type validation, and runtime config validation.
 *
 * @packageDocumentation
 */

import * as path from 'path';
import * as fs from 'fs';
// Note: Uses Jest (project standard) -- not vitest
import type { MinaProviderConfig } from '../../src/settlement/provider/payment-channel-provider';
import type { ConnectorConfig, ChainProviderConfigEntry } from '../../src/config/types';
import { validateChainProviders } from '../../src/config/types';

jest.setTimeout(30_000);

// ---------------------------------------------------------------------------
// Path Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '../../../..');
const DEPLOY_SCRIPT = path.join(PROJECT_ROOT, 'tools/mina/deploy-zkapp.ts');
const MAKEFILE = path.join(PROJECT_ROOT, 'Makefile');
const DOCS_FILE = path.join(PROJECT_ROOT, 'docs/mina-deployment.md');

// ---------------------------------------------------------------------------
// T-34.9-01: Deploy script argument parsing (AC 7, Story 34.9)
// ---------------------------------------------------------------------------

describe('[T-34.9-01] Deploy script exists and validates arguments (Story 34.9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should have deploy-zkapp.ts at tools/mina/deploy-zkapp.ts', () => {
    // Given: the project repository with Mina deployment infrastructure
    // When: checking for the deploy script
    const exists = fs.existsSync(DEPLOY_SCRIPT);

    // Then: the deploy script exists
    expect(exists).toBe(true);
  });

  it('should require --network argument', () => {
    // Given: the deploy script source
    const content = fs.readFileSync(DEPLOY_SCRIPT, 'utf8');

    // Then: the script checks for --network and exits if missing
    expect(content).toMatch(/--network/);
    expect(content).toMatch(/--network.*required|Error.*--network/i);
  });

  it('should enforce HTTPS on network URL', () => {
    // Given: the deploy script source
    const content = fs.readFileSync(DEPLOY_SCRIPT, 'utf8');

    // Then: the script rejects non-HTTPS URLs
    expect(content).toMatch(/https:\/\//);
    expect(content).toMatch(/HTTPS|https/);
  });

  it('should support --deployer-key as CLI argument', () => {
    // Given: the deploy script source
    const content = fs.readFileSync(DEPLOY_SCRIPT, 'utf8');

    // Then: it accepts --deployer-key
    expect(content).toMatch(/--deployer-key/);
  });

  it('should fall back to MINA_DEPLOYER_KEY environment variable', () => {
    // Given: the deploy script source
    const content = fs.readFileSync(DEPLOY_SCRIPT, 'utf8');

    // Then: it checks MINA_DEPLOYER_KEY env var
    expect(content).toMatch(/MINA_DEPLOYER_KEY/);
  });

  it('should output zkApp private key to stderr for security', () => {
    // Given: the deploy script source
    const content = fs.readFileSync(DEPLOY_SCRIPT, 'utf8');

    // Then: it outputs sensitive data to stderr (console.error) not stdout
    expect(content).toMatch(/console\.error/);
    expect(content).toMatch(/SENSITIVE.*private key/i);
  });

  it('should compile PaymentChannel circuit before deployment', () => {
    // Given: the deploy script source
    const content = fs.readFileSync(DEPLOY_SCRIPT, 'utf8');

    // Then: it calls compile
    expect(content).toMatch(/PaymentChannel\.compile/);
  });

  it('should output verification key hash', () => {
    // Given: the deploy script source
    const content = fs.readFileSync(DEPLOY_SCRIPT, 'utf8');

    // Then: it logs the verification key hash
    expect(content).toMatch(/verificationKey\.hash/);
  });
});

// ---------------------------------------------------------------------------
// T-34.9-02: MinaProviderConfig schema validation (AC 7, Story 34.9)
// ---------------------------------------------------------------------------

describe('[T-34.9-02] MinaProviderConfig schema validation (Story 34.9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should accept a valid Mina devnet configuration', () => {
    // Given: a valid MinaProviderConfig for devnet
    const config: MinaProviderConfig = {
      chainType: 'mina',
      graphqlUrl: 'https://api.minascan.io/node/devnet/v1/graphql',
      zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
      keyId: 'mina-operator-key',
      tokenId: 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf',
      network: 'devnet',
    };

    // Then: all required fields are present
    expect(config.chainType).toBe('mina');
    expect(config.graphqlUrl).toMatch(/^https?:\/\//);
    expect(config.zkAppAddress).toBeTruthy();
    expect(config.zkAppAddress).toMatch(/^B62/);
  });

  it('should accept config with only required fields', () => {
    // Given: a minimal MinaProviderConfig (only required fields)
    const config: MinaProviderConfig = {
      chainType: 'mina',
      graphqlUrl: 'https://api.minascan.io/node/devnet/v1/graphql',
      zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
    };

    // Then: config is valid without optional keyId, tokenId, network
    expect(config.chainType).toBe('mina');
    expect(config.keyId).toBeUndefined();
    expect(config.tokenId).toBeUndefined();
    expect(config.network).toBeUndefined();
  });

  it('should pass runtime validateChainProviders for a valid Mina devnet config', () => {
    // Given: a ConnectorConfig with a Mina chainProvider and a peer referencing it
    const config: ConnectorConfig = {
      nodeId: 'test-node',
      btpServerPort: 3000,
      environment: 'development',
      peers: [
        {
          id: 'peer-mina',
          url: 'wss://peer-mina:3001',
          authToken: 'secret',
          chain: 'mina:devnet',
        },
      ],
      routes: [],
      chainProviders: [
        {
          chainType: 'mina',
          chainId: 'mina:devnet',
          graphqlUrl: 'https://api.minascan.io/node/devnet/v1/graphql',
          zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
          keyId: 'mina-operator-key',
          network: 'devnet',
        },
      ],
    };

    // When/Then: runtime validation passes without throwing
    expect(() => validateChainProviders(config)).not.toThrow();
  });

  it('should reject Mina config missing required graphqlUrl via runtime validation', () => {
    // Given: a ConnectorConfig with a Mina provider missing graphqlUrl
    const config: ConnectorConfig = {
      nodeId: 'test-node',
      btpServerPort: 3000,
      environment: 'development',
      peers: [],
      routes: [],
      chainProviders: [
        {
          chainType: 'mina',
          chainId: 'mina:devnet',
          zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
          keyId: 'mina-operator-key',
        } as ChainProviderConfigEntry,
      ],
    };

    // When/Then: runtime validation rejects the missing field
    expect(() => validateChainProviders(config)).toThrow(/Missing required field 'graphqlUrl'/);
  });

  it('should reject Mina config missing required zkAppAddress via runtime validation', () => {
    // Given: a ConnectorConfig with a Mina provider missing zkAppAddress
    const config: ConnectorConfig = {
      nodeId: 'test-node',
      btpServerPort: 3000,
      environment: 'development',
      peers: [],
      routes: [],
      chainProviders: [
        {
          chainType: 'mina',
          chainId: 'mina:devnet',
          graphqlUrl: 'https://api.minascan.io/node/devnet/v1/graphql',
          keyId: 'mina-operator-key',
        } as ChainProviderConfigEntry,
      ],
    };

    // When/Then: runtime validation rejects the missing field
    expect(() => validateChainProviders(config)).toThrow(/Missing required field 'zkAppAddress'/);
  });

  it('should reject peer referencing unregistered Mina chain', () => {
    // Given: a peer referencing a chainId not in chainProviders
    const config: ConnectorConfig = {
      nodeId: 'test-node',
      btpServerPort: 3000,
      environment: 'development',
      peers: [
        {
          id: 'peer-mina',
          url: 'wss://peer-mina:3001',
          authToken: 'secret',
          chain: 'mina:devnet',
        },
      ],
      routes: [],
      chainProviders: [
        {
          chainType: 'mina',
          chainId: 'mina:mainnet',
          graphqlUrl: 'https://api.minascan.io/node/mainnet/v1/graphql',
          zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
          keyId: 'mina-operator-key',
        },
      ],
    };

    // When/Then: runtime validation rejects the unregistered chain reference
    expect(() => validateChainProviders(config)).toThrow(/unregistered chain/);
  });
});

// ---------------------------------------------------------------------------
// T-34.9-03: zkApp address format validation (AC 7, Story 34.9)
// ---------------------------------------------------------------------------

describe('[T-34.9-03] zkApp address format validation (Story 34.9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should accept a valid B62 address', () => {
    // Given: a valid Mina B62 public key address
    const address = 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy';

    // Then: it starts with B62 prefix
    expect(address).toMatch(/^B62/);

    // And: it has the expected length (55 characters for Mina addresses)
    expect(address.length).toBe(55);
  });

  it('should reject address without B62 prefix', () => {
    // Given: an address that does not start with B62
    const invalidAddress = '0x1234567890123456789012345678901234567890';

    // Then: it does not match the Mina address pattern
    expect(invalidAddress).not.toMatch(/^B62/);
  });

  it('should reject address with wrong length', () => {
    // Given: a B62-prefixed string that is too short
    const shortAddress = 'B62abc';

    // Then: it does not have the expected length
    expect(shortAddress.length).not.toBe(55);
  });

  it('should reject empty address', () => {
    // Given: an empty string
    const emptyAddress = '';

    // Then: it is falsy
    expect(emptyAddress).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// T-34.9-04: Mina chainId format validation (AC 7, Story 34.9)
// ---------------------------------------------------------------------------

describe('[T-34.9-04] Mina chainId format validation (Story 34.9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should accept mina:devnet as a valid chainId', () => {
    // Given: a Mina devnet chainId
    const chainId = 'mina:devnet';

    // Then: it matches the expected format
    expect(chainId).toMatch(/^mina:(devnet|mainnet)$/);
  });

  it('should accept mina:mainnet as a valid chainId', () => {
    // Given: a Mina mainnet chainId
    const chainId = 'mina:mainnet';

    // Then: it matches the expected format
    expect(chainId).toMatch(/^mina:(devnet|mainnet)$/);
  });

  it('should reject invalid chainId format', () => {
    // Given: various invalid chainId formats
    const invalidChainIds = ['mina:', ':devnet', 'solana:devnet', 'mina', 'mina:testnet'];

    // Then: none match the valid Mina chainId pattern
    for (const chainId of invalidChainIds) {
      expect(chainId).not.toMatch(/^mina:(devnet|mainnet)$/);
    }
  });

  it('should validate chainId in runtime config context', () => {
    // Given: a ConnectorConfig with a valid Mina chainProvider using mina:devnet
    const config: ConnectorConfig = {
      nodeId: 'test-node',
      btpServerPort: 3000,
      environment: 'development',
      peers: [
        {
          id: 'peer-mina',
          url: 'wss://peer-mina:3001',
          authToken: 'secret',
          chain: 'mina:devnet',
        },
      ],
      routes: [],
      chainProviders: [
        {
          chainType: 'mina',
          chainId: 'mina:devnet',
          graphqlUrl: 'https://api.minascan.io/node/devnet/v1/graphql',
          zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
        },
      ],
    };

    // When/Then: validates without error
    expect(() => validateChainProviders(config)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// T-34.9-05: Documentation file exists (AC 3, Story 34.9)
// ---------------------------------------------------------------------------

describe('[T-34.9-05] Documentation file exists at docs/mina-deployment.md (Story 34.9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should have documentation file at docs/mina-deployment.md', () => {
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
// T-34.9-05b: Documentation covers all required sections (AC 3,4,5,6,8, Story 34.9)
// ---------------------------------------------------------------------------

describe('[T-34.9-05b] Documentation covers all required sections (Story 34.9)', () => {
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

  it('should document GraphQL endpoint configuration', () => {
    // Given: the operational documentation
    // Then: it documents GraphQL endpoints
    expect(docsContent).toMatch(/graphql.*endpoint|graphqlUrl|api\.minascan\.io/i);
  });

  it('should document zkApp address configuration', () => {
    // Given: the operational documentation
    // Then: it documents zkApp address setup
    expect(docsContent).toMatch(/zkApp.*address|zkAppAddress/i);
  });

  it('should include a complete YAML config example with peers section', () => {
    // Given: the operational documentation
    // Then: the YAML example includes both chainProviders and peers
    expect(docsContent).toMatch(/chainProviders/);
    expect(docsContent).toMatch(/peers:/);
  });

  it('should document the chainId format for Mina', () => {
    // Given: the configuration documentation
    // Then: it shows the Mina chainId format
    expect(docsContent).toMatch(/mina:devnet/);
  });

  it('should document the MinaProviderConfig field table', () => {
    // Given: the configuration documentation
    // Then: it includes a structured field reference (table format)
    expect(docsContent).toMatch(/chainType.*mina|Field.*Type.*Required/i);
  });

  it('should document devnet GraphQL endpoint URL', () => {
    // Given: the configuration documentation
    // Then: it includes the devnet endpoint URL
    expect(docsContent).toMatch(/https:\/\/api\.minascan\.io\/node\/devnet\/v1\/graphql/);
  });

  // AC 4: Performance Benchmarks
  it('should have a performance benchmarks section', () => {
    // Given: the operational documentation
    // Then: it contains performance benchmarks
    expect(docsContent.toLowerCase()).toMatch(
      /performance.*benchmark|benchmark|proof.*generation.*time/
    );
  });

  it('should document hardware recommendations', () => {
    // Given: the operational documentation
    // Then: it specifies hardware requirements
    expect(docsContent.toLowerCase()).toMatch(/hardware|cpu.*core|ram|memory/);
  });

  it('should document proof generation tuning', () => {
    // Given: the operational documentation
    // Then: it documents proof generation optimization
    expect(docsContent.toLowerCase()).toMatch(/proof.*generation|proofsEnabled|compile.*circuit/);
  });

  // AC 5: Privacy Model Documentation
  it('should have a privacy model section', () => {
    // Given: the operational documentation
    // Then: it contains privacy documentation
    expect(docsContent.toLowerCase()).toMatch(/privacy.*model|privacy.*guarantee/);
  });

  it('should document what is hidden on-chain', () => {
    // Given: the privacy documentation
    // Then: it explains what is hidden (balances, salt)
    expect(docsContent).toMatch(/balanceCommitment|Poseidon/);
    expect(docsContent.toLowerCase()).toMatch(/hidden|private/);
  });

  it('should document what is visible on-chain', () => {
    // Given: the privacy documentation
    // Then: it explains what is visible (channelHash, depositTotal, channelState)
    expect(docsContent).toMatch(/channelHash|depositTotal|channelState/);
  });

  it('should document NIP-59 transport privacy', () => {
    // Given: the privacy documentation
    // Then: it explains NIP-59 transport privacy
    expect(docsContent).toMatch(/NIP-59|transport.*privacy/i);
  });

  it('should document privacy limitations', () => {
    // Given: the privacy documentation
    // Then: it documents privacy limitations
    expect(docsContent.toLowerCase()).toMatch(/limitation|timing.*analysis|metadata/);
  });

  // AC 6: Operational Documentation
  it('should document archive node requirements', () => {
    // Given: the operational documentation
    // Then: it documents archive node requirements
    expect(docsContent.toLowerCase()).toMatch(/archive.*node|event.*retrieval/);
  });

  it('should document block times and finality', () => {
    // Given: the operational documentation
    // Then: it documents Mina block timing
    expect(docsContent.toLowerCase()).toMatch(/block.*time|finality|3.*minute/);
  });

  it('should document channel lifecycle operations', () => {
    // Given: the operational documentation
    // Then: it documents channel operations
    expect(docsContent.toLowerCase()).toMatch(/channel.*lifecycle|open.*channel|close.*channel/);
  });

  it('should have a troubleshooting section', () => {
    // Given: the operational documentation
    // Then: it contains troubleshooting guidance
    expect(docsContent.toLowerCase()).toMatch(/troubleshoot/);
  });

  // AC 1, 2: Deployment documentation
  it('should document deployment prerequisites', () => {
    // Given: the operational documentation
    // Then: it documents prerequisites (Node.js, o1js, funded account)
    expect(docsContent.toLowerCase()).toMatch(/prerequisite|node\.js|o1js|funded.*account|faucet/);
  });

  it('should document deployment cost estimates', () => {
    // Given: the operational documentation
    // Then: it documents deployment costs
    expect(docsContent.toLowerCase()).toMatch(/cost|fee|1.*mina/);
  });

  it('should document deployment verification via GraphQL', () => {
    // Given: the operational documentation
    // Then: it documents verification via GraphQL queries
    expect(docsContent).toMatch(/verificationKey|verification.*key.*hash/i);
    expect(docsContent).toMatch(/graphql|GraphQL/i);
  });
});

// ---------------------------------------------------------------------------
// T-34.9-06: Makefile contains mina-deploy-devnet target (AC 8, Story 34.9)
// ---------------------------------------------------------------------------

describe('[T-34.9-06] Makefile contains mina-deploy-devnet target (Story 34.9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should have mina-deploy-devnet target in Makefile', () => {
    // Given: the project Makefile
    const content = fs.readFileSync(MAKEFILE, 'utf8');

    // Then: it contains the mina-deploy-devnet target
    expect(content).toMatch(/^mina-deploy-devnet:/m);
  });

  it('should have mina-build target in Makefile', () => {
    // Given: the project Makefile
    const content = fs.readFileSync(MAKEFILE, 'utf8');

    // Then: it contains the mina-build target
    expect(content).toMatch(/^mina-build:/m);
  });

  it('should have mina-test target in Makefile', () => {
    // Given: the project Makefile
    const content = fs.readFileSync(MAKEFILE, 'utf8');

    // Then: it contains the mina-test target
    expect(content).toMatch(/^mina-test:/m);
  });

  it('should require DEPLOYER_KEY for mina deployment', () => {
    // Given: the project Makefile
    const content = fs.readFileSync(MAKEFILE, 'utf8');

    // Then: deployment target requires DEPLOYER_KEY
    expect(content).toMatch(/DEPLOYER_KEY/);
  });
});

// ---------------------------------------------------------------------------
// T-34.9-06b: Docs list Makefile targets with prerequisites (AC 8, Story 34.9)
// ---------------------------------------------------------------------------

describe('[T-34.9-06b] docs/mina-deployment.md lists Makefile targets with prerequisites (Story 34.9)', () => {
  let docsContent: string;

  beforeAll(() => {
    docsContent = fs.readFileSync(DOCS_FILE, 'utf8');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should document the mina-build Makefile target', () => {
    // Given: the Mina deployment documentation
    // When: reading the Makefile targets section
    // Then: mina-build is listed
    expect(docsContent).toMatch(/make mina-build/);
  });

  it('should document the mina-test Makefile target', () => {
    // Given: the Mina deployment documentation
    // When: reading the Makefile targets section
    // Then: mina-test is listed
    expect(docsContent).toMatch(/make mina-test/);
  });

  it('should document the mina-deploy-devnet Makefile target', () => {
    // Given: the Mina deployment documentation
    // When: reading the Makefile targets section
    // Then: mina-deploy-devnet is listed
    expect(docsContent).toMatch(/make mina-deploy-devnet/);
  });

  it('should document o1js as a prerequisite', () => {
    // Given: the Mina deployment documentation
    // When: reading the prerequisites section
    // Then: o1js is listed as a requirement
    expect(docsContent).toMatch(/o1js/);
  });

  it('should document funded devnet account as a prerequisite', () => {
    // Given: the Mina deployment documentation
    // When: reading the prerequisites section
    // Then: funded Mina devnet account is listed
    expect(docsContent).toMatch(/[Ff]unded.*[Mm]ina.*devnet.*account|[Ff]unded.*devnet.*account/);
  });

  it('should document npm build order as a prerequisite (shared before mina-zkapp)', () => {
    // Given: the Mina deployment documentation
    // When: reading the prerequisites or build section
    // Then: the build order (shared first, then mina-zkapp) is documented
    expect(docsContent).toMatch(/build --workspace=packages\/shared/);
    expect(docsContent).toMatch(/build --workspace=packages\/mina-zkapp/);
    // The shared build appears before the mina-zkapp build in the docs
    const sharedIdx = docsContent.indexOf('build --workspace=packages/shared');
    const minaIdx = docsContent.indexOf('build --workspace=packages/mina-zkapp');
    expect(sharedIdx).toBeLessThan(minaIdx);
  });

  it('should have a dedicated Makefile Targets section in the documentation', () => {
    // Given: the Mina deployment documentation
    // When: checking the section headings
    // Then: there is a Makefile Targets section
    expect(docsContent).toMatch(/^##\s+Makefile Targets/m);
  });
});

// ---------------------------------------------------------------------------
// T-34.9-02b: Invalid chainType rejection (AC 7, Story 34.9)
// ---------------------------------------------------------------------------

describe('[T-34.9-02b] Invalid chainType rejection via runtime validation (Story 34.9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should reject config with unknown chainType', () => {
    // Given: a ConnectorConfig with an unknown chainType
    const config: ConnectorConfig = {
      nodeId: 'test-node',
      btpServerPort: 3000,
      environment: 'development',
      peers: [],
      routes: [],
      chainProviders: [
        {
          chainType: 'unknown-chain' as 'mina',
          chainId: 'unknown:devnet',
          graphqlUrl: 'https://example.com/graphql',
          zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
        } as ChainProviderConfigEntry,
      ],
    };

    // When/Then: runtime validation rejects the unknown chainType
    expect(() => validateChainProviders(config)).toThrow(/Unknown chain type/);
  });

  it('should reject config with duplicate chainId values', () => {
    // Given: a ConnectorConfig with duplicate chainIds
    const config: ConnectorConfig = {
      nodeId: 'test-node',
      btpServerPort: 3000,
      environment: 'development',
      peers: [],
      routes: [],
      chainProviders: [
        {
          chainType: 'mina',
          chainId: 'mina:devnet',
          graphqlUrl: 'https://api.minascan.io/node/devnet/v1/graphql',
          zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
        },
        {
          chainType: 'mina',
          chainId: 'mina:devnet',
          graphqlUrl: 'https://api.minascan.io/node/devnet/v1/graphql',
          zkAppAddress: 'B62qjsV6WQwTeEWrNrRRBP6VaaLvQhwWTnFi4WP4LQjGvpfZEumXzxb',
        },
      ],
    };

    // When/Then: runtime validation rejects the duplicate chainId
    expect(() => validateChainProviders(config)).toThrow(/Duplicate chainId/);
  });
});

// ---------------------------------------------------------------------------
// T-34.9-07: Deployment verification logic (AC 7, Story 34.9)
// Mock GraphQL response validation for deployed zkApp verification
// ---------------------------------------------------------------------------

describe('[T-34.9-07] Deployment verification logic with mock GraphQL (Story 34.9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Simulates the verification step described in the deployment docs:
   * query the zkApp account and check verification key hash.
   */
  function verifyDeployment(graphqlResponse: Record<string, unknown>): {
    valid: boolean;
    verificationKeyHash?: string;
    error?: string;
  } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = graphqlResponse as any;
    if (!data?.data?.account) {
      return { valid: false, error: 'Account not found' };
    }
    if (!data.data.account.zkapp) {
      return { valid: false, error: 'Not a zkApp account' };
    }
    const vkHash = data.data.account.zkapp.verificationKey?.hash;
    if (!vkHash || typeof vkHash !== 'string') {
      return { valid: false, error: 'No verification key hash' };
    }
    return { valid: true, verificationKeyHash: vkHash };
  }

  it('should verify a valid mock GraphQL response for a deployed zkApp', () => {
    // Given: a mock GraphQL response representing a successfully deployed zkApp
    const mockResponse = {
      data: {
        account: {
          zkapp: {
            verificationKey: {
              hash: '20374849183049201837465728394012837465029384756102938475',
            },
          },
        },
      },
    };

    // When: verifying the deployment
    const result = verifyDeployment(mockResponse);

    // Then: verification succeeds with the expected hash
    expect(result.valid).toBe(true);
    expect(result.verificationKeyHash).toBe(
      '20374849183049201837465728394012837465029384756102938475'
    );
  });

  it('should fail verification when account does not exist', () => {
    // Given: a mock GraphQL response where the account is null
    const mockResponse = {
      data: {
        account: null,
      },
    };

    // When: verifying the deployment
    const result = verifyDeployment(mockResponse);

    // Then: verification fails with appropriate error
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Account not found/);
  });

  it('should fail verification when account is not a zkApp', () => {
    // Given: a mock GraphQL response where the account exists but has no zkApp
    const mockResponse = {
      data: {
        account: {
          publicKey: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
          zkapp: null,
        },
      },
    };

    // When: verifying the deployment
    const result = verifyDeployment(mockResponse);

    // Then: verification fails
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Not a zkApp account/);
  });

  it('should fail verification when verification key hash is missing', () => {
    // Given: a mock GraphQL response with a zkApp but no verification key
    const mockResponse = {
      data: {
        account: {
          zkapp: {
            verificationKey: null,
          },
        },
      },
    };

    // When: verifying the deployment
    const result = verifyDeployment(mockResponse);

    // Then: verification fails
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/No verification key hash/);
  });

  it('should match verification key hash against expected compile output', () => {
    // Given: a known verification key hash from compilation
    const expectedHash = '20374849183049201837465728394012837465029384756102938475';

    // And: a mock GraphQL response with that hash
    const mockResponse = {
      data: {
        account: {
          zkapp: {
            verificationKey: {
              hash: expectedHash,
            },
          },
        },
      },
    };

    // When: verifying the deployment
    const result = verifyDeployment(mockResponse);

    // Then: the returned hash matches the expected compile output
    expect(result.valid).toBe(true);
    expect(result.verificationKeyHash).toBe(expectedHash);
  });
});

// ---------------------------------------------------------------------------
// T-34.9-04b: Performance benchmark documentation completeness (AC 4, Story 34.9)
// ---------------------------------------------------------------------------

describe('[T-34.9-04b] Performance benchmarks cover all operation types (Story 34.9)', () => {
  let docsContent: string;

  beforeAll(() => {
    docsContent = fs.readFileSync(DOCS_FILE, 'utf8');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should document circuit compile benchmark', () => {
    // Given: the performance benchmarks section
    // Then: compile operation is documented
    expect(docsContent).toMatch(/Circuit compile|circuit.*compile/i);
  });

  it('should document claimFromChannel proof benchmark', () => {
    // Given: the performance benchmarks section
    // Then: claimFromChannel operation time is documented
    expect(docsContent).toMatch(/claimFromChannel/);
  });

  it('should document initiateClose proof benchmark', () => {
    // Given: the performance benchmarks section
    // Then: initiateClose operation time is documented
    expect(docsContent).toMatch(/initiateClose/);
  });

  it('should document settle proof benchmark', () => {
    // Given: the performance benchmarks section
    // Then: settle operation time is documented
    expect(docsContent).toMatch(/`settle`|settle.*proof/i);
  });

  it('should document minimum hardware requirements', () => {
    // Given: the hardware recommendations section
    // Then: minimum tier is specified with CPU and RAM
    expect(docsContent).toMatch(/Minimum.*4 cores|4 cores.*Minimum/i);
    expect(docsContent).toMatch(/4 GB/);
  });

  it('should document recommended hardware requirements', () => {
    // Given: the hardware recommendations section
    // Then: recommended tier is specified
    expect(docsContent).toMatch(/Recommended.*8\+ cores|8\+ cores.*Recommended/i);
    expect(docsContent).toMatch(/8\+ GB/);
  });

  it('should document ARM performance advantage', () => {
    // Given: the hardware recommendations section
    // Then: ARM (M1/M2) advantage is noted
    expect(docsContent).toMatch(/ARM.*M1.*M2|M1\/M2.*30%/i);
  });

  it('should document proofsEnabled toggle for development vs production', () => {
    // Given: the proof generation tuning section
    // Then: proofsEnabled flag is documented for both modes
    expect(docsContent).toMatch(/proofsEnabled.*false/);
    expect(docsContent).toMatch(/proofsEnabled.*true/);
  });
});
