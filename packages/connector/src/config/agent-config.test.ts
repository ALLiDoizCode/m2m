/**
 * Unit tests for AgentConfigLoader
 *
 * Tests configuration loading, validation, and conversion for
 * Agent Society Protocol configuration.
 */

import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { getPublicKey } from 'nostr-tools';
import { AgentConfigLoader, AgentConfigurationError, AgentYamlConfig } from './agent-config';

// Mock fs module
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

// Test fixtures
const VALID_PRIVATE_KEY = 'a'.repeat(64);
const VALID_PUBLIC_KEY = getPublicKey(Buffer.from(VALID_PRIVATE_KEY, 'hex'));
const VALID_PUBKEY_2 = 'b'.repeat(64);

const createValidConfig = (overrides: Partial<AgentYamlConfig> = {}): AgentYamlConfig => ({
  agent: {
    privateKey: VALID_PRIVATE_KEY,
    ...overrides.agent,
  },
  database: {
    path: ':memory:',
    ...overrides.database,
  },
  pricing: {
    noteStorage: '100',
    followUpdate: '50',
    deletion: '10',
    queryBase: '200',
    ...overrides.pricing,
  },
  ...overrides,
});

describe('AgentConfigLoader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clear environment variables
    delete process.env.AGENT_PRIVATE_KEY;
    delete process.env.AGENT_KEY_FILE_PATH;
    delete process.env.AGENT_DATABASE_PATH;
    delete process.env.AGENT_KEY_PASSWORD;
  });

  // ==========================================================================
  // Task 10: YAML Loading Tests
  // ==========================================================================
  describe('loadConfig', () => {
    it('should load valid config file successfully', () => {
      const validConfig = createValidConfig();
      mockFs.readFileSync.mockReturnValue(yaml.dump(validConfig));

      const config = AgentConfigLoader.loadConfig('./test-config.yaml');

      expect(config.agent.privateKey).toBe(VALID_PRIVATE_KEY);
      expect(config.database.path).toBe(':memory:');
      expect(config.pricing.noteStorage).toBe('100');
    });

    it('should throw AgentConfigurationError for missing file', () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockFs.readFileSync.mockImplementation(() => {
        throw error;
      });

      expect(() => AgentConfigLoader.loadConfig('./missing.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./missing.yaml')).toThrow(
        /Configuration file not found/
      );
    });

    it('should throw AgentConfigurationError for invalid YAML syntax', () => {
      mockFs.readFileSync.mockReturnValue('invalid: yaml: content: [');

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(/Invalid YAML syntax/);
    });

    it('should throw AgentConfigurationError for non-object YAML', () => {
      mockFs.readFileSync.mockReturnValue('just a string');

      expect(() => AgentConfigLoader.loadConfig('./string.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./string.yaml')).toThrow(
        /Configuration must be a YAML object/
      );
    });

    it('should handle empty optional sections', () => {
      const config = createValidConfig();
      // Remove optional sections by setting to undefined
      const configWithoutOptional = {
        agent: config.agent,
        database: config.database,
        pricing: config.pricing,
      };
      mockFs.readFileSync.mockReturnValue(yaml.dump(configWithoutOptional));

      const loaded = AgentConfigLoader.loadConfig('./minimal.yaml');

      expect(loaded.follows).toBeUndefined();
      expect(loaded.handlers).toBeUndefined();
      expect(loaded.subscriptions).toBeUndefined();
    });
  });

  // ==========================================================================
  // Task 10: Identity Validation Tests (AC: 1)
  // ==========================================================================
  describe('validateConfig - identity', () => {
    it('should accept valid privateKey (64-char hex)', () => {
      const config = createValidConfig();
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./valid.yaml')).not.toThrow();
    });

    it('should accept valid keyFilePath', () => {
      const config = createValidConfig({
        agent: { keyFilePath: './key.enc' },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./valid.yaml')).not.toThrow();
    });

    it('should reject invalid privateKey format (too short)', () => {
      const config = createValidConfig({
        agent: { privateKey: 'tooshort' },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /64-character hex string/
      );
    });

    it('should reject invalid privateKey format (non-hex)', () => {
      const config = createValidConfig({
        agent: { privateKey: 'g'.repeat(64) }, // 'g' is not valid hex
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
    });

    it('should reject config with neither privateKey nor keyFilePath', () => {
      const config = createValidConfig({
        agent: {},
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /Either privateKey or keyFilePath must be provided/
      );
    });

    it('should accept both privateKey and keyFilePath (privateKey takes precedence)', () => {
      const config = createValidConfig({
        agent: {
          privateKey: VALID_PRIVATE_KEY,
          keyFilePath: './key.enc',
        },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      const loaded = AgentConfigLoader.loadConfig('./valid.yaml');
      expect(loaded.agent.privateKey).toBe(VALID_PRIVATE_KEY);
    });

    it('should validate publicKey format if provided', () => {
      const config = createValidConfig({
        agent: {
          privateKey: VALID_PRIVATE_KEY,
          publicKey: 'invalid',
        },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /publicKey must be a 64-character hex string/
      );
    });
  });

  // ==========================================================================
  // Task 10: Database Validation Tests (AC: 2)
  // ==========================================================================
  describe('validateConfig - database', () => {
    it('should reject missing database path', () => {
      const config = createValidConfig({
        database: { path: '' },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /database\.path is required/
      );
    });

    it('should accept memory path (":memory:")', () => {
      const config = createValidConfig({
        database: { path: ':memory:' },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./valid.yaml')).not.toThrow();
    });

    it('should accept file path ("file:./data/events.db")', () => {
      const config = createValidConfig({
        database: { path: 'file:./data/events.db' },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./valid.yaml')).not.toThrow();
    });

    it('should reject invalid path format', () => {
      const config = createValidConfig({
        database: { path: './invalid/path.db' },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /must start with "file:" or be ":memory:"/
      );
    });

    it('should validate maxSizeBytes is positive', () => {
      const config = createValidConfig({
        database: { path: ':memory:', maxSizeBytes: -100 },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /maxSizeBytes must be non-negative/
      );
    });

    it('should accept zero maxSizeBytes (intentional for testing)', () => {
      const config = createValidConfig({
        database: { path: ':memory:', maxSizeBytes: 0 },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./valid.yaml')).not.toThrow();
    });
  });

  // ==========================================================================
  // Task 10: Pricing Validation Tests (AC: 3)
  // ==========================================================================
  describe('validateConfig - pricing', () => {
    it('should parse valid pricing strings to bigint', () => {
      const config = createValidConfig({
        pricing: {
          noteStorage: '100',
          followUpdate: '50',
          deletion: '10',
          queryBase: '200',
        },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      const loaded = AgentConfigLoader.loadConfig('./valid.yaml');
      const parsed = AgentConfigLoader.parsePricing(loaded.pricing);

      expect(parsed.noteStorage).toBe(100n);
      expect(parsed.followUpdate).toBe(50n);
      expect(parsed.deletion).toBe(10n);
      expect(parsed.queryBase).toBe(200n);
    });

    it('should reject negative pricing values', () => {
      const config = createValidConfig({
        pricing: {
          noteStorage: '-100',
          followUpdate: '50',
          deletion: '10',
          queryBase: '200',
        },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(/must be non-negative/);
    });

    it('should reject non-numeric pricing strings', () => {
      const config = createValidConfig({
        pricing: {
          noteStorage: 'abc',
          followUpdate: '50',
          deletion: '10',
          queryBase: '200',
        },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /Cannot parse as bigint/
      );
    });

    it('should handle optional queryPerResult', () => {
      const config = createValidConfig({
        pricing: {
          noteStorage: '100',
          followUpdate: '50',
          deletion: '10',
          queryBase: '200',
          queryPerResult: '5',
        },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      const loaded = AgentConfigLoader.loadConfig('./valid.yaml');
      const parsed = AgentConfigLoader.parsePricing(loaded.pricing);

      expect(parsed.queryPerResult).toBe(5n);
    });

    it('should handle scientific notation (1e6)', () => {
      const config = createValidConfig({
        pricing: {
          noteStorage: '1e6',
          followUpdate: '50',
          deletion: '10',
          queryBase: '200',
        },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      const loaded = AgentConfigLoader.loadConfig('./valid.yaml');
      const parsed = AgentConfigLoader.parsePricing(loaded.pricing);

      expect(parsed.noteStorage).toBe(1000000n);
    });

    it('should reject missing required pricing field', () => {
      const config = createValidConfig();
      // Create config with missing noteStorage
      const invalidPricing = {
        followUpdate: '50',
        deletion: '10',
        queryBase: '200',
      };
      mockFs.readFileSync.mockReturnValue(
        yaml.dump({
          ...config,
          pricing: invalidPricing,
        })
      );

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /Missing required pricing field: noteStorage/
      );
    });
  });

  // ==========================================================================
  // Task 10: Follows Validation Tests (AC: 4)
  // ==========================================================================
  describe('validateConfig - follows', () => {
    it('should accept valid follows array', () => {
      const config = createValidConfig({
        follows: [
          {
            pubkey: VALID_PUBKEY_2,
            ilpAddress: 'g.agent.alice',
            petname: 'alice',
          },
        ],
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./valid.yaml')).not.toThrow();
    });

    it('should reject invalid pubkey format', () => {
      const config = createValidConfig({
        follows: [
          {
            pubkey: 'invalid',
            ilpAddress: 'g.agent.alice',
          },
        ],
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /64-character hex string/
      );
    });

    it('should reject invalid ILP address format', () => {
      const config = createValidConfig({
        follows: [
          {
            pubkey: VALID_PUBKEY_2,
            ilpAddress: 'invalid address!',
          },
        ],
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /not a valid ILP address/
      );
    });

    it('should handle empty follows array', () => {
      const config = createValidConfig({
        follows: [],
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./valid.yaml')).not.toThrow();
    });

    it('should accept follows with optional petname', () => {
      const config = createValidConfig({
        follows: [
          {
            pubkey: VALID_PUBKEY_2,
            ilpAddress: 'g.agent.alice',
          },
        ],
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      const loaded = AgentConfigLoader.loadConfig('./valid.yaml');
      expect(loaded.follows).toBeDefined();
      expect(loaded.follows).toHaveLength(1);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const firstFollow = loaded.follows![0]!;
      expect(firstFollow.petname).toBeUndefined();
    });
  });

  // ==========================================================================
  // Task 10: Handlers Validation Tests (AC: 5)
  // ==========================================================================
  describe('validateConfig - handlers', () => {
    it('should accept boolean values', () => {
      const config = createValidConfig({
        handlers: {
          enableNoteHandler: true,
          enableFollowHandler: false,
          enableDeleteHandler: true,
          enableQueryHandler: false,
        },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./valid.yaml')).not.toThrow();
    });

    it('should reject non-boolean values', () => {
      const config = createValidConfig({
        handlers: {
          enableNoteHandler: 'yes' as unknown as boolean,
        },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(/must be a boolean/);
    });

    it('should use defaults when handlers section omitted', () => {
      const config = createValidConfig();
      // Create config without handlers section
      const configWithoutHandlers = {
        agent: config.agent,
        database: config.database,
        pricing: config.pricing,
      };
      mockFs.readFileSync.mockReturnValue(yaml.dump(configWithoutHandlers));

      const loaded = AgentConfigLoader.loadConfig('./valid.yaml');
      const handlerConfig = AgentConfigLoader.getHandlerConfig(loaded);

      expect(handlerConfig.enableNoteHandler).toBe(true);
      expect(handlerConfig.enableFollowHandler).toBe(true);
      expect(handlerConfig.enableDeleteHandler).toBe(true);
      expect(handlerConfig.enableQueryHandler).toBe(true);
    });
  });

  // ==========================================================================
  // Task 11: Config Conversion Tests
  // ==========================================================================
  describe('toAgentNodeConfig', () => {
    it('should convert YAML config to AgentNodeConfig correctly', () => {
      const config = createValidConfig();

      const nodeConfig = AgentConfigLoader.toAgentNodeConfig(config);

      expect(nodeConfig.agentPubkey).toBe(VALID_PUBLIC_KEY);
      expect(nodeConfig.agentPrivkey).toBe(VALID_PRIVATE_KEY);
      expect(nodeConfig.databasePath).toBe(':memory:');
      expect(nodeConfig.pricing.noteStorage).toBe(100n);
      expect(nodeConfig.pricing.followUpdate).toBe(50n);
      expect(nodeConfig.pricing.deletion).toBe(10n);
      expect(nodeConfig.pricing.queryBase).toBe(200n);
    });

    it('should apply default values for omitted fields', () => {
      const config = createValidConfig();

      const nodeConfig = AgentConfigLoader.toAgentNodeConfig(config);

      // Default maxSizeBytes is 100MB
      expect(nodeConfig.databaseMaxSize).toBe(100 * 1024 * 1024);
      // Default maxSubscriptionsPerPeer is 10
      expect(nodeConfig.maxSubscriptionsPerPeer).toBe(10);
      // Default enableBuiltInHandlers is true
      expect(nodeConfig.enableBuiltInHandlers).toBe(true);
    });

    it('should convert pricing strings to bigint', () => {
      const config = createValidConfig({
        pricing: {
          noteStorage: '1000000',
          followUpdate: '500000',
          deletion: '100000',
          queryBase: '2000000',
          queryPerResult: '50000',
        },
      });

      const nodeConfig = AgentConfigLoader.toAgentNodeConfig(config);

      expect(nodeConfig.pricing.noteStorage).toBe(1000000n);
      expect(nodeConfig.pricing.followUpdate).toBe(500000n);
      expect(nodeConfig.pricing.deletion).toBe(100000n);
      expect(nodeConfig.pricing.queryBase).toBe(2000000n);
      expect(nodeConfig.pricing.queryPerResult).toBe(50000n);
    });

    it('should map enableBuiltInHandlers from handlers config (all enabled)', () => {
      const config = createValidConfig({
        handlers: {
          enableNoteHandler: true,
          enableFollowHandler: true,
          enableDeleteHandler: true,
          enableQueryHandler: true,
        },
      });

      const nodeConfig = AgentConfigLoader.toAgentNodeConfig(config);

      expect(nodeConfig.enableBuiltInHandlers).toBe(true);
    });

    it('should map enableBuiltInHandlers = false only if ALL handlers disabled', () => {
      const config = createValidConfig({
        handlers: {
          enableNoteHandler: false,
          enableFollowHandler: false,
          enableDeleteHandler: false,
          enableQueryHandler: false,
        },
      });

      const nodeConfig = AgentConfigLoader.toAgentNodeConfig(config);

      expect(nodeConfig.enableBuiltInHandlers).toBe(false);
    });

    it('should map enableBuiltInHandlers = true if ANY handler enabled', () => {
      const config = createValidConfig({
        handlers: {
          enableNoteHandler: true,
          enableFollowHandler: false,
          enableDeleteHandler: false,
          enableQueryHandler: false,
        },
      });

      const nodeConfig = AgentConfigLoader.toAgentNodeConfig(config);

      expect(nodeConfig.enableBuiltInHandlers).toBe(true);
    });

    it('should derive publicKey from privateKey', () => {
      const config = createValidConfig({
        agent: { privateKey: VALID_PRIVATE_KEY },
      });

      const nodeConfig = AgentConfigLoader.toAgentNodeConfig(config);

      expect(nodeConfig.agentPubkey).toBe(VALID_PUBLIC_KEY);
    });

    it('should use explicit publicKey if provided', () => {
      const explicitPubKey = 'c'.repeat(64);
      const config = createValidConfig({
        agent: {
          privateKey: VALID_PRIVATE_KEY,
          publicKey: explicitPubKey,
        },
      });

      const nodeConfig = AgentConfigLoader.toAgentNodeConfig(config);

      expect(nodeConfig.agentPubkey).toBe(explicitPubKey);
    });
  });

  // ==========================================================================
  // Task 11: Environment Variable Loading Tests
  // ==========================================================================
  describe('loadConfigFromEnv', () => {
    it('should load config from AGENT_* environment variables', () => {
      process.env.AGENT_PRIVATE_KEY = VALID_PRIVATE_KEY;
      process.env.AGENT_DATABASE_PATH = ':memory:';
      process.env.AGENT_PRICING_NOTE_STORAGE = '100';
      process.env.AGENT_PRICING_FOLLOW_UPDATE = '50';
      process.env.AGENT_PRICING_DELETION = '10';
      process.env.AGENT_PRICING_QUERY_BASE = '200';

      const config = AgentConfigLoader.loadConfigFromEnv();

      expect(config.agent.privateKey).toBe(VALID_PRIVATE_KEY);
      expect(config.database.path).toBe(':memory:');
      expect(config.pricing.noteStorage).toBe('100');
    });

    it('should throw if required environment variables missing', () => {
      // No env vars set
      expect(() => AgentConfigLoader.loadConfigFromEnv()).toThrow(AgentConfigurationError);
    });

    it('should load optional environment variables', () => {
      process.env.AGENT_PRIVATE_KEY = VALID_PRIVATE_KEY;
      process.env.AGENT_DATABASE_PATH = ':memory:';
      process.env.AGENT_DATABASE_MAX_SIZE = '50000000';
      process.env.AGENT_PRICING_NOTE_STORAGE = '100';
      process.env.AGENT_PRICING_FOLLOW_UPDATE = '50';
      process.env.AGENT_PRICING_DELETION = '10';
      process.env.AGENT_PRICING_QUERY_BASE = '200';
      process.env.AGENT_PRICING_QUERY_PER_RESULT = '5';
      process.env.AGENT_MAX_SUBSCRIPTIONS_PER_PEER = '20';

      const config = AgentConfigLoader.loadConfigFromEnv();

      expect(config.database.maxSizeBytes).toBe(50000000);
      expect(config.pricing.queryPerResult).toBe('5');
      expect(config.subscriptions?.maxPerPeer).toBe(20);
    });
  });

  // ==========================================================================
  // Task 4: Key File Loading Tests
  // ==========================================================================
  describe('loadPrivateKeyFromFile', () => {
    it('should load raw hex key from file', () => {
      mockFs.readFileSync.mockReturnValue(VALID_PRIVATE_KEY);
      mockFs.statSync.mockReturnValue({ mode: 0o600 } as fs.Stats);

      const key = AgentConfigLoader.loadPrivateKeyFromFile('./key.txt');

      expect(key).toBe(VALID_PRIVATE_KEY);
    });

    it('should throw for missing file', () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockFs.readFileSync.mockImplementation(() => {
        throw error;
      });

      expect(() => AgentConfigLoader.loadPrivateKeyFromFile('./missing.txt')).toThrow(
        AgentConfigurationError
      );
      expect(() => AgentConfigLoader.loadPrivateKeyFromFile('./missing.txt')).toThrow(
        /Key file not found/
      );
    });

    it('should throw for permission denied', () => {
      const error = new Error('EACCES') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      mockFs.readFileSync.mockImplementation(() => {
        throw error;
      });

      expect(() => AgentConfigLoader.loadPrivateKeyFromFile('./restricted.txt')).toThrow(
        AgentConfigurationError
      );
      expect(() => AgentConfigLoader.loadPrivateKeyFromFile('./restricted.txt')).toThrow(
        /Permission denied/
      );
    });

    it('should throw for invalid key format', () => {
      mockFs.readFileSync.mockReturnValue('not a valid key');
      mockFs.statSync.mockReturnValue({ mode: 0o600 } as fs.Stats);

      expect(() => AgentConfigLoader.loadPrivateKeyFromFile('./invalid.txt')).toThrow(
        AgentConfigurationError
      );
      expect(() => AgentConfigLoader.loadPrivateKeyFromFile('./invalid.txt')).toThrow(
        /Invalid key file format/
      );
    });
  });

  // ==========================================================================
  // Task 5: Pricing Parser Tests
  // ==========================================================================
  describe('parsePricing', () => {
    it('should parse numeric strings to bigint', () => {
      const pricing = {
        noteStorage: '12345',
        followUpdate: '67890',
        deletion: '11111',
        queryBase: '22222',
      };

      const parsed = AgentConfigLoader.parsePricing(pricing);

      expect(parsed.noteStorage).toBe(12345n);
      expect(parsed.followUpdate).toBe(67890n);
      expect(parsed.deletion).toBe(11111n);
      expect(parsed.queryBase).toBe(22222n);
    });

    it('should handle large numbers', () => {
      const pricing = {
        noteStorage: '999999999999999999',
        followUpdate: '50',
        deletion: '10',
        queryBase: '200',
      };

      const parsed = AgentConfigLoader.parsePricing(pricing);

      expect(parsed.noteStorage).toBe(999999999999999999n);
    });

    it('should handle zero values', () => {
      const pricing = {
        noteStorage: '0',
        followUpdate: '0',
        deletion: '0',
        queryBase: '0',
      };

      const parsed = AgentConfigLoader.parsePricing(pricing);

      expect(parsed.noteStorage).toBe(0n);
      expect(parsed.followUpdate).toBe(0n);
      expect(parsed.deletion).toBe(0n);
      expect(parsed.queryBase).toBe(0n);
    });

    it('should handle scientific notation', () => {
      const pricing = {
        noteStorage: '1e9',
        followUpdate: '5e5',
        deletion: '1e3',
        queryBase: '2e6',
      };

      const parsed = AgentConfigLoader.parsePricing(pricing);

      expect(parsed.noteStorage).toBe(1000000000n);
      expect(parsed.followUpdate).toBe(500000n);
      expect(parsed.deletion).toBe(1000n);
      expect(parsed.queryBase).toBe(2000000n);
    });
  });

  // ==========================================================================
  // Task 7: Follow Loading Tests
  // ==========================================================================
  describe('loadFollowsToRouter', () => {
    it('should do nothing with empty follows array', () => {
      const mockRouter = {
        addFollow: jest.fn(),
      };

      AgentConfigLoader.loadFollowsToRouter([], mockRouter as never);

      expect(mockRouter.addFollow).not.toHaveBeenCalled();
    });

    it('should do nothing with undefined follows', () => {
      const mockRouter = {
        addFollow: jest.fn(),
      };

      AgentConfigLoader.loadFollowsToRouter(undefined, mockRouter as never);

      expect(mockRouter.addFollow).not.toHaveBeenCalled();
    });

    it('should call router.addFollow for each follow entry', () => {
      const mockRouter = {
        addFollow: jest.fn(),
      };

      const follows = [
        { pubkey: VALID_PUBKEY_2, ilpAddress: 'g.agent.alice', petname: 'alice' },
        { pubkey: 'c'.repeat(64), ilpAddress: 'g.agent.bob' },
      ];

      AgentConfigLoader.loadFollowsToRouter(follows, mockRouter as never);

      expect(mockRouter.addFollow).toHaveBeenCalledTimes(2);
      expect(mockRouter.addFollow).toHaveBeenCalledWith({
        pubkey: VALID_PUBKEY_2,
        ilpAddress: 'g.agent.alice',
        petname: 'alice',
      });
      expect(mockRouter.addFollow).toHaveBeenCalledWith({
        pubkey: 'c'.repeat(64),
        ilpAddress: 'g.agent.bob',
        petname: undefined,
      });
    });

    it('should handle router.addFollow errors gracefully', () => {
      const mockRouter = {
        addFollow: jest.fn().mockImplementation(() => {
          throw new Error('Router error');
        }),
      };
      const mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
      };

      const follows = [{ pubkey: VALID_PUBKEY_2, ilpAddress: 'g.agent.alice' }];

      // Should not throw
      expect(() =>
        AgentConfigLoader.loadFollowsToRouter(follows, mockRouter as never, mockLogger as never)
      ).not.toThrow();

      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // validateAIConfig Tests (Story 16.1)
  // ==========================================================================
  describe('validateConfig - AI config', () => {
    it('should accept valid AI config', () => {
      const config = createValidConfig({
        ai: {
          enabled: true,
          model: 'anthropic:claude-haiku-4-5',
          apiKey: 'sk-test-key',
          maxTokensPerRequest: 1024,
          budget: {
            maxTokensPerHour: 100000,
            fallbackOnExhaustion: true,
          },
          personality: {
            name: 'TestBot',
            role: 'Assistant',
            instructions: 'Be helpful',
          },
        },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./valid.yaml')).not.toThrow();
    });

    it('should accept config without AI section', () => {
      const config = createValidConfig();
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./valid.yaml')).not.toThrow();
    });

    it('should accept minimal AI config (empty object)', () => {
      const config = createValidConfig({ ai: {} });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./valid.yaml')).not.toThrow();
    });

    it('should reject non-boolean enabled', () => {
      const config = createValidConfig({
        ai: { enabled: 'yes' as unknown as boolean },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /ai\.enabled must be a boolean/
      );
    });

    it('should reject invalid model format (no colon)', () => {
      const config = createValidConfig({
        ai: { model: 'invalid-model' },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /ai\.model must be in "provider:model" format/
      );
    });

    it('should reject model with empty provider', () => {
      const config = createValidConfig({
        ai: { model: ':some-model' },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /ai\.model must be in "provider:model" format/
      );
    });

    it('should reject model with empty model name', () => {
      const config = createValidConfig({
        ai: { model: 'anthropic:' },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /ai\.model must be in "provider:model" format/
      );
    });

    it('should reject non-positive maxTokensPerRequest', () => {
      const config = createValidConfig({
        ai: { maxTokensPerRequest: 0 },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /ai\.maxTokensPerRequest must be a positive number/
      );
    });

    it('should reject negative maxTokensPerRequest', () => {
      const config = createValidConfig({
        ai: { maxTokensPerRequest: -100 },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /ai\.maxTokensPerRequest must be a positive number/
      );
    });

    it('should reject non-object budget', () => {
      const config = createValidConfig({
        ai: { budget: 'invalid' as unknown as object },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /ai\.budget must be an object/
      );
    });

    it('should reject non-positive budget.maxTokensPerHour', () => {
      const config = createValidConfig({
        ai: { budget: { maxTokensPerHour: 0 } },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /ai\.budget\.maxTokensPerHour must be a positive number/
      );
    });

    it('should reject non-boolean budget.fallbackOnExhaustion', () => {
      const config = createValidConfig({
        ai: { budget: { fallbackOnExhaustion: 'yes' as unknown as boolean } },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /ai\.budget\.fallbackOnExhaustion must be a boolean/
      );
    });

    it('should reject non-object personality', () => {
      const config = createValidConfig({
        ai: { personality: 'invalid' as unknown as object },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /ai\.personality must be an object/
      );
    });

    it('should reject non-string personality.name', () => {
      const config = createValidConfig({
        ai: { personality: { name: 123 as unknown as string } },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /ai\.personality\.name must be a string/
      );
    });

    it('should reject non-string personality.role', () => {
      const config = createValidConfig({
        ai: { personality: { role: 456 as unknown as string } },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /ai\.personality\.role must be a string/
      );
    });

    it('should reject non-string personality.instructions', () => {
      const config = createValidConfig({
        ai: { personality: { instructions: true as unknown as string } },
      });
      mockFs.readFileSync.mockReturnValue(yaml.dump(config));

      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(AgentConfigurationError);
      expect(() => AgentConfigLoader.loadConfig('./invalid.yaml')).toThrow(
        /ai\.personality\.instructions must be a string/
      );
    });
  });

  // ==========================================================================
  // toAgentNodeConfig - AI config passthrough (Story 16.1)
  // ==========================================================================
  describe('toAgentNodeConfig - AI config', () => {
    it('should pass parsed AI config through to AgentNodeConfig', () => {
      const config = createValidConfig({
        ai: {
          enabled: true,
          model: 'anthropic:claude-haiku-4-5',
          maxTokensPerRequest: 2048,
        },
      });

      const nodeConfig = AgentConfigLoader.toAgentNodeConfig(config);

      expect(nodeConfig.ai).toBeDefined();
      expect(nodeConfig.ai?.enabled).toBe(true);
      expect(nodeConfig.ai?.model).toBe('anthropic:claude-haiku-4-5');
      expect(nodeConfig.ai?.maxTokensPerRequest).toBe(2048);
    });

    it('should apply defaults when AI section is minimal', () => {
      const config = createValidConfig({
        ai: {},
      });

      const nodeConfig = AgentConfigLoader.toAgentNodeConfig(config);

      expect(nodeConfig.ai).toBeDefined();
      expect(nodeConfig.ai?.enabled).toBe(true);
      expect(nodeConfig.ai?.model).toBe('anthropic:claude-haiku-4-5');
      expect(nodeConfig.ai?.maxTokensPerRequest).toBe(1024);
      expect(nodeConfig.ai?.budget.maxTokensPerHour).toBe(100000);
    });

    it('should pass AI config even when no AI section in YAML', () => {
      const config = createValidConfig();

      const nodeConfig = AgentConfigLoader.toAgentNodeConfig(config);

      // parseAIConfig(undefined) returns defaults
      expect(nodeConfig.ai).toBeDefined();
      expect(nodeConfig.ai?.enabled).toBe(true);
    });
  });

  // ==========================================================================
  // Error Class Tests
  // ==========================================================================
  describe('AgentConfigurationError', () => {
    it('should include field in message when provided', () => {
      const error = new AgentConfigurationError('Test error', 'testField');

      expect(error.message).toContain('testField');
      expect(error.field).toBe('testField');
      expect(error.name).toBe('AgentConfigurationError');
    });

    it('should work without field', () => {
      const error = new AgentConfigurationError('Test error');

      expect(error.message).toBe('Test error');
      expect(error.field).toBeUndefined();
    });
  });
});
