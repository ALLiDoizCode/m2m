/**
 * AI Provider Factory
 *
 * Creates AI SDK model instances from the provider:model configuration string.
 * Supports Anthropic, OpenAI, and any other AI SDK-compatible providers.
 *
 * @packageDocumentation
 */

import type { LanguageModelV1 } from 'ai';
import { parseModelString, type AIAgentConfig } from './ai-agent-config';

/**
 * Create an AI SDK language model from configuration.
 *
 * Dynamically imports the appropriate provider package based on the
 * provider:model configuration string.
 *
 * @param config - AI agent configuration
 * @returns AI SDK language model instance
 * @throws Error if provider is unsupported or package is not installed
 */
export async function createModelFromConfig(config: AIAgentConfig): Promise<LanguageModelV1> {
  const { provider, modelName } = parseModelString(config.model);

  switch (provider) {
    case 'anthropic':
      return createAnthropicModel(modelName, config.apiKey);

    case 'openai':
      return createOpenAIModel(modelName, config.apiKey);

    default:
      throw new Error(
        `Unsupported AI provider: "${provider}". ` +
          `Supported providers: anthropic, openai. ` +
          `Install the corresponding @ai-sdk/${provider} package to add support.`
      );
  }
}

async function createAnthropicModel(modelName: string, apiKey?: string): Promise<LanguageModelV1> {
  try {
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    const anthropic = createAnthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
    });
    return anthropic(modelName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
      throw new Error(
        'Anthropic provider requires @ai-sdk/anthropic package. Install with: npm install @ai-sdk/anthropic'
      );
    }
    throw error;
  }
}

async function createOpenAIModel(modelName: string, apiKey?: string): Promise<LanguageModelV1> {
  try {
    const { createOpenAI } = await import('@ai-sdk/openai');
    const openai = createOpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY,
    });
    return openai(modelName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
      throw new Error(
        'OpenAI provider requires @ai-sdk/openai package. Install with: npm install @ai-sdk/openai'
      );
    }
    throw error;
  }
}
