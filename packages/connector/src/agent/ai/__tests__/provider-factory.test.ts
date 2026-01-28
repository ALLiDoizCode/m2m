/**
 * Unit tests for AI Provider Factory
 *
 * Tests createModelFromConfig for supported/unsupported providers,
 * MODULE_NOT_FOUND handling, and env var fallback for API keys.
 */

import type { AIAgentConfig } from '../ai-agent-config';

// Mock the dynamic imports
const mockAnthropicModel = { modelId: 'claude-haiku-4-5', provider: 'anthropic' };
const mockOpenAIModel = { modelId: 'gpt-4o-mini', provider: 'openai' };

const mockCreateAnthropic = jest
  .fn()
  .mockReturnValue(jest.fn().mockReturnValue(mockAnthropicModel));
const mockCreateOpenAI = jest.fn().mockReturnValue(jest.fn().mockReturnValue(mockOpenAIModel));

describe('Provider Factory', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_API_KEY;
    mockCreateAnthropic.mockClear();
    mockCreateOpenAI.mockClear();
    mockCreateAnthropic.mockReturnValue(jest.fn().mockReturnValue(mockAnthropicModel));
    mockCreateOpenAI.mockReturnValue(jest.fn().mockReturnValue(mockOpenAIModel));
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const createConfig = (overrides: Partial<AIAgentConfig> = {}): AIAgentConfig => ({
    enabled: true,
    model: 'anthropic:claude-haiku-4-5',
    maxTokensPerRequest: 1024,
    budget: {
      maxTokensPerHour: 100000,
      fallbackOnExhaustion: true,
    },
    ...overrides,
  });

  // ==========================================================================
  // createModelFromConfig - Anthropic
  // ==========================================================================
  describe('createModelFromConfig - Anthropic', () => {
    it('should create Anthropic model with config apiKey', async () => {
      // Mock the dynamic import
      jest.doMock('@ai-sdk/anthropic', () => ({
        createAnthropic: mockCreateAnthropic,
      }));

      const { createModelFromConfig } = await import('../provider-factory');
      const config = createConfig({
        model: 'anthropic:claude-haiku-4-5',
        apiKey: 'sk-ant-test-key',
      });

      const model = await createModelFromConfig(config);

      expect(mockCreateAnthropic).toHaveBeenCalledWith({
        apiKey: 'sk-ant-test-key',
      });
      expect(model).toBe(mockAnthropicModel);
    });

    it('should fall back to ANTHROPIC_API_KEY env var when no config apiKey', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';

      jest.doMock('@ai-sdk/anthropic', () => ({
        createAnthropic: mockCreateAnthropic,
      }));

      const { createModelFromConfig } = await import('../provider-factory');
      const config = createConfig({
        model: 'anthropic:claude-haiku-4-5',
      });

      await createModelFromConfig(config);

      expect(mockCreateAnthropic).toHaveBeenCalledWith({
        apiKey: 'sk-ant-env-key',
      });
    });
  });

  // ==========================================================================
  // createModelFromConfig - OpenAI
  // ==========================================================================
  describe('createModelFromConfig - OpenAI', () => {
    it('should create OpenAI model with config apiKey', async () => {
      jest.doMock('@ai-sdk/openai', () => ({
        createOpenAI: mockCreateOpenAI,
      }));

      const { createModelFromConfig } = await import('../provider-factory');
      const config = createConfig({
        model: 'openai:gpt-4o-mini',
        apiKey: 'sk-openai-test-key',
      });

      const model = await createModelFromConfig(config);

      expect(mockCreateOpenAI).toHaveBeenCalledWith({
        apiKey: 'sk-openai-test-key',
      });
      expect(model).toBe(mockOpenAIModel);
    });

    it('should fall back to OPENAI_API_KEY env var when no config apiKey', async () => {
      process.env.OPENAI_API_KEY = 'sk-openai-env-key';

      jest.doMock('@ai-sdk/openai', () => ({
        createOpenAI: mockCreateOpenAI,
      }));

      const { createModelFromConfig } = await import('../provider-factory');
      const config = createConfig({
        model: 'openai:gpt-4o-mini',
      });

      await createModelFromConfig(config);

      expect(mockCreateOpenAI).toHaveBeenCalledWith({
        apiKey: 'sk-openai-env-key',
      });
    });
  });

  // ==========================================================================
  // createModelFromConfig - Unsupported provider
  // ==========================================================================
  describe('createModelFromConfig - unsupported provider', () => {
    it('should throw for unsupported provider with actionable message', async () => {
      const { createModelFromConfig } = await import('../provider-factory');
      const config = createConfig({
        model: 'google:gemini-pro',
      });

      await expect(createModelFromConfig(config)).rejects.toThrow(
        /Unsupported AI provider: "google"/
      );
    });

    it('should list supported providers in error message', async () => {
      const { createModelFromConfig } = await import('../provider-factory');
      const config = createConfig({
        model: 'cohere:command-r',
      });

      await expect(createModelFromConfig(config)).rejects.toThrow(
        /Supported providers: anthropic, openai/
      );
    });
  });

  // ==========================================================================
  // createModelFromConfig - MODULE_NOT_FOUND
  // ==========================================================================
  describe('createModelFromConfig - MODULE_NOT_FOUND', () => {
    it('should throw actionable error when @ai-sdk/anthropic is not installed', async () => {
      const moduleError = new Error('Cannot find module') as NodeJS.ErrnoException;
      moduleError.code = 'MODULE_NOT_FOUND';

      jest.doMock('@ai-sdk/anthropic', () => {
        throw moduleError;
      });

      const { createModelFromConfig } = await import('../provider-factory');
      const config = createConfig({
        model: 'anthropic:claude-haiku-4-5',
      });

      await expect(createModelFromConfig(config)).rejects.toThrow(
        /Anthropic provider requires @ai-sdk\/anthropic package/
      );
    });

    it('should throw actionable error when @ai-sdk/openai is not installed', async () => {
      const moduleError = new Error('Cannot find module') as NodeJS.ErrnoException;
      moduleError.code = 'MODULE_NOT_FOUND';

      jest.doMock('@ai-sdk/openai', () => {
        throw moduleError;
      });

      const { createModelFromConfig } = await import('../provider-factory');
      const config = createConfig({
        model: 'openai:gpt-4o-mini',
      });

      await expect(createModelFromConfig(config)).rejects.toThrow(
        /OpenAI provider requires @ai-sdk\/openai package/
      );
    });

    it('should re-throw non-MODULE_NOT_FOUND errors from Anthropic', async () => {
      jest.doMock('@ai-sdk/anthropic', () => ({
        createAnthropic: () => {
          throw new Error('API initialization failed');
        },
      }));

      const { createModelFromConfig } = await import('../provider-factory');
      const config = createConfig({
        model: 'anthropic:claude-haiku-4-5',
      });

      await expect(createModelFromConfig(config)).rejects.toThrow('API initialization failed');
    });

    it('should re-throw non-MODULE_NOT_FOUND errors from OpenAI', async () => {
      jest.doMock('@ai-sdk/openai', () => ({
        createOpenAI: () => {
          throw new Error('Network error');
        },
      }));

      const { createModelFromConfig } = await import('../provider-factory');
      const config = createConfig({
        model: 'openai:gpt-4o-mini',
      });

      await expect(createModelFromConfig(config)).rejects.toThrow('Network error');
    });
  });
});
