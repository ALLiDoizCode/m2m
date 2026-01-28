/**
 * Unit tests for AI Agent Configuration
 *
 * Tests config types, defaults, parseAIConfig, isValidModelString,
 * parseModelString, and env var overrides.
 */

import {
  parseAIConfig,
  isValidModelString,
  parseModelString,
  AI_AGENT_DEFAULTS,
  AIYamlConfig,
} from '../ai-agent-config';

describe('AI Agent Config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    // Clear AI-related env vars
    delete process.env.AI_AGENT_ENABLED;
    delete process.env.AI_AGENT_MODEL;
    delete process.env.AI_API_KEY;
    delete process.env.AI_MAX_TOKENS_PER_REQUEST;
    delete process.env.AI_MAX_TOKENS_PER_HOUR;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ==========================================================================
  // AI_AGENT_DEFAULTS
  // ==========================================================================
  describe('AI_AGENT_DEFAULTS', () => {
    it('should have enabled=true by default', () => {
      expect(AI_AGENT_DEFAULTS.enabled).toBe(true);
    });

    it('should have model=anthropic:claude-haiku-4-5 by default', () => {
      expect(AI_AGENT_DEFAULTS.model).toBe('anthropic:claude-haiku-4-5');
    });

    it('should have maxTokensPerRequest=1024 by default', () => {
      expect(AI_AGENT_DEFAULTS.maxTokensPerRequest).toBe(1024);
    });

    it('should have budget.maxTokensPerHour=100000 by default', () => {
      expect(AI_AGENT_DEFAULTS.budget.maxTokensPerHour).toBe(100000);
    });

    it('should have budget.fallbackOnExhaustion=true by default', () => {
      expect(AI_AGENT_DEFAULTS.budget.fallbackOnExhaustion).toBe(true);
    });

    it('should not have an apiKey by default', () => {
      expect(AI_AGENT_DEFAULTS.apiKey).toBeUndefined();
    });
  });

  // ==========================================================================
  // isValidModelString
  // ==========================================================================
  describe('isValidModelString', () => {
    it('should accept valid provider:model format', () => {
      expect(isValidModelString('anthropic:claude-haiku-4-5')).toBe(true);
    });

    it('should accept openai provider', () => {
      expect(isValidModelString('openai:gpt-4o-mini')).toBe(true);
    });

    it('should accept model names with colons (provider:model:variant)', () => {
      expect(isValidModelString('provider:model:variant')).toBe(true);
    });

    it('should reject empty string', () => {
      expect(isValidModelString('')).toBe(false);
    });

    it('should reject string without colon', () => {
      expect(isValidModelString('anthropic-claude')).toBe(false);
    });

    it('should reject string with empty provider', () => {
      expect(isValidModelString(':claude-haiku-4-5')).toBe(false);
    });

    it('should reject string with empty model name', () => {
      expect(isValidModelString('anthropic:')).toBe(false);
    });
  });

  // ==========================================================================
  // parseModelString
  // ==========================================================================
  describe('parseModelString', () => {
    it('should parse anthropic:claude-haiku-4-5 correctly', () => {
      const result = parseModelString('anthropic:claude-haiku-4-5');
      expect(result.provider).toBe('anthropic');
      expect(result.modelName).toBe('claude-haiku-4-5');
    });

    it('should parse openai:gpt-4o correctly', () => {
      const result = parseModelString('openai:gpt-4o');
      expect(result.provider).toBe('openai');
      expect(result.modelName).toBe('gpt-4o');
    });

    it('should handle model names with colons (split on first colon only)', () => {
      const result = parseModelString('provider:model:variant');
      expect(result.provider).toBe('provider');
      expect(result.modelName).toBe('model:variant');
    });

    it('should throw for string without colon', () => {
      expect(() => parseModelString('invalid')).toThrow(/Invalid model format/);
    });
  });

  // ==========================================================================
  // parseAIConfig - defaults
  // ==========================================================================
  describe('parseAIConfig - defaults', () => {
    it('should return defaults when called with no arguments', () => {
      const config = parseAIConfig();

      expect(config.enabled).toBe(true);
      expect(config.model).toBe('anthropic:claude-haiku-4-5');
      expect(config.maxTokensPerRequest).toBe(1024);
      expect(config.budget.maxTokensPerHour).toBe(100000);
      expect(config.budget.fallbackOnExhaustion).toBe(true);
      expect(config.apiKey).toBeUndefined();
    });

    it('should return defaults when called with undefined', () => {
      const config = parseAIConfig(undefined);

      expect(config.enabled).toBe(AI_AGENT_DEFAULTS.enabled);
      expect(config.model).toBe(AI_AGENT_DEFAULTS.model);
    });

    it('should return defaults when called with empty object', () => {
      const config = parseAIConfig({});

      expect(config.enabled).toBe(true);
      expect(config.model).toBe('anthropic:claude-haiku-4-5');
    });
  });

  // ==========================================================================
  // parseAIConfig - YAML overrides
  // ==========================================================================
  describe('parseAIConfig - YAML overrides', () => {
    it('should override enabled from YAML', () => {
      const config = parseAIConfig({ enabled: false });
      expect(config.enabled).toBe(false);
    });

    it('should override model from YAML', () => {
      const config = parseAIConfig({ model: 'openai:gpt-4o' });
      expect(config.model).toBe('openai:gpt-4o');
    });

    it('should override apiKey from YAML', () => {
      const config = parseAIConfig({ apiKey: 'sk-test-key' });
      expect(config.apiKey).toBe('sk-test-key');
    });

    it('should override maxTokensPerRequest from YAML', () => {
      const config = parseAIConfig({ maxTokensPerRequest: 2048 });
      expect(config.maxTokensPerRequest).toBe(2048);
    });

    it('should override budget from YAML', () => {
      const config = parseAIConfig({
        budget: {
          maxTokensPerHour: 50000,
          fallbackOnExhaustion: false,
        },
      });
      expect(config.budget.maxTokensPerHour).toBe(50000);
      expect(config.budget.fallbackOnExhaustion).toBe(false);
    });

    it('should override personality from YAML', () => {
      const config = parseAIConfig({
        personality: {
          name: 'TestBot',
          role: 'Tester',
          instructions: 'Be thorough',
        },
      });
      expect(config.personality?.name).toBe('TestBot');
      expect(config.personality?.role).toBe('Tester');
      expect(config.personality?.instructions).toBe('Be thorough');
    });

    it('should apply full YAML config', () => {
      const yamlConfig: AIYamlConfig = {
        enabled: true,
        model: 'openai:gpt-4o-mini',
        apiKey: 'sk-full-test',
        maxTokensPerRequest: 512,
        budget: {
          maxTokensPerHour: 200000,
          fallbackOnExhaustion: false,
        },
        personality: {
          name: 'AgentSmith',
          role: 'Financial Analyst',
        },
      };

      const config = parseAIConfig(yamlConfig);

      expect(config.enabled).toBe(true);
      expect(config.model).toBe('openai:gpt-4o-mini');
      expect(config.apiKey).toBe('sk-full-test');
      expect(config.maxTokensPerRequest).toBe(512);
      expect(config.budget.maxTokensPerHour).toBe(200000);
      expect(config.budget.fallbackOnExhaustion).toBe(false);
      expect(config.personality?.name).toBe('AgentSmith');
    });
  });

  // ==========================================================================
  // parseAIConfig - env var overrides
  // ==========================================================================
  describe('parseAIConfig - env var overrides', () => {
    it('should override enabled from AI_AGENT_ENABLED env var', () => {
      process.env.AI_AGENT_ENABLED = 'false';
      const config = parseAIConfig();
      expect(config.enabled).toBe(false);
    });

    it('should accept AI_AGENT_ENABLED=true', () => {
      process.env.AI_AGENT_ENABLED = 'true';
      const config = parseAIConfig();
      expect(config.enabled).toBe(true);
    });

    it('should accept AI_AGENT_ENABLED=1 as true', () => {
      process.env.AI_AGENT_ENABLED = '1';
      const config = parseAIConfig();
      expect(config.enabled).toBe(true);
    });

    it('should treat AI_AGENT_ENABLED=0 as false', () => {
      process.env.AI_AGENT_ENABLED = '0';
      const config = parseAIConfig();
      expect(config.enabled).toBe(false);
    });

    it('should override model from AI_AGENT_MODEL env var', () => {
      process.env.AI_AGENT_MODEL = 'openai:gpt-4o';
      const config = parseAIConfig();
      expect(config.model).toBe('openai:gpt-4o');
    });

    it('should override apiKey from AI_API_KEY env var', () => {
      process.env.AI_API_KEY = 'sk-env-key';
      const config = parseAIConfig();
      expect(config.apiKey).toBe('sk-env-key');
    });

    it('should override maxTokensPerRequest from AI_MAX_TOKENS_PER_REQUEST env var', () => {
      process.env.AI_MAX_TOKENS_PER_REQUEST = '4096';
      const config = parseAIConfig();
      expect(config.maxTokensPerRequest).toBe(4096);
    });

    it('should override maxTokensPerHour from AI_MAX_TOKENS_PER_HOUR env var', () => {
      process.env.AI_MAX_TOKENS_PER_HOUR = '500000';
      const config = parseAIConfig();
      expect(config.budget.maxTokensPerHour).toBe(500000);
    });

    it('should ignore non-numeric AI_MAX_TOKENS_PER_REQUEST value', () => {
      process.env.AI_MAX_TOKENS_PER_REQUEST = 'not-a-number';
      const config = parseAIConfig();
      expect(config.maxTokensPerRequest).toBe(AI_AGENT_DEFAULTS.maxTokensPerRequest);
    });

    it('should ignore non-numeric AI_MAX_TOKENS_PER_HOUR value', () => {
      process.env.AI_MAX_TOKENS_PER_HOUR = 'invalid';
      const config = parseAIConfig();
      expect(config.budget.maxTokensPerHour).toBe(AI_AGENT_DEFAULTS.budget.maxTokensPerHour);
    });
  });

  // ==========================================================================
  // parseAIConfig - precedence (YAML > env > defaults)
  // ==========================================================================
  describe('parseAIConfig - precedence', () => {
    it('should prefer YAML value over env var for enabled', () => {
      process.env.AI_AGENT_ENABLED = 'false';
      const config = parseAIConfig({ enabled: true });
      expect(config.enabled).toBe(true);
    });

    it('should prefer YAML value over env var for model', () => {
      process.env.AI_AGENT_MODEL = 'openai:gpt-4o';
      const config = parseAIConfig({ model: 'anthropic:claude-sonnet-4' });
      expect(config.model).toBe('anthropic:claude-sonnet-4');
    });

    it('should prefer YAML value over env var for apiKey', () => {
      process.env.AI_API_KEY = 'env-key';
      const config = parseAIConfig({ apiKey: 'yaml-key' });
      expect(config.apiKey).toBe('yaml-key');
    });

    it('should prefer YAML value over env var for maxTokensPerRequest', () => {
      process.env.AI_MAX_TOKENS_PER_REQUEST = '8192';
      const config = parseAIConfig({ maxTokensPerRequest: 512 });
      expect(config.maxTokensPerRequest).toBe(512);
    });

    it('should fall back to env var when YAML value not set', () => {
      process.env.AI_AGENT_MODEL = 'openai:gpt-4o';
      const config = parseAIConfig({});
      expect(config.model).toBe('openai:gpt-4o');
    });

    it('should fall back to default when neither YAML nor env var set', () => {
      const config = parseAIConfig({});
      expect(config.model).toBe('anthropic:claude-haiku-4-5');
    });
  });

  // ==========================================================================
  // parseAIConfig - validation
  // ==========================================================================
  describe('parseAIConfig - validation', () => {
    it('should throw for invalid model string when enabled', () => {
      expect(() => parseAIConfig({ model: 'invalid-model' })).toThrow(/Invalid AI model format/);
    });

    it('should not validate model string when disabled', () => {
      expect(() => parseAIConfig({ enabled: false, model: 'invalid' })).not.toThrow();
    });

    it('should throw for non-positive maxTokensPerHour', () => {
      expect(() =>
        parseAIConfig({
          budget: { maxTokensPerHour: 0, fallbackOnExhaustion: true },
        })
      ).toThrow(/maxTokensPerHour must be a positive number/);
    });

    it('should throw for negative maxTokensPerHour', () => {
      expect(() =>
        parseAIConfig({
          budget: { maxTokensPerHour: -100, fallbackOnExhaustion: true },
        })
      ).toThrow(/maxTokensPerHour must be a positive number/);
    });

    it('should throw for non-positive maxTokensPerRequest', () => {
      expect(() => parseAIConfig({ maxTokensPerRequest: 0 })).toThrow(
        /maxTokensPerRequest must be a positive number/
      );
    });

    it('should throw for negative maxTokensPerRequest', () => {
      expect(() => parseAIConfig({ maxTokensPerRequest: -1 })).toThrow(
        /maxTokensPerRequest must be a positive number/
      );
    });
  });
});
