/**
 * AI Agent Configuration Types
 *
 * Defines the configuration interfaces for the AI agent dispatcher,
 * including model selection, token budgets, and personality settings.
 *
 * @packageDocumentation
 */

/**
 * Personality configuration for the AI agent.
 */
export interface AIAgentPersonality {
  /** Display name for the agent */
  name?: string;
  /** Role description */
  role?: string;
  /** Additional behavioral instructions */
  instructions?: string;
}

/**
 * Token budget configuration for cost management.
 */
export interface AIBudgetConfig {
  /** Maximum tokens per rolling hour window (default: 100000) */
  maxTokensPerHour: number;
  /** Whether to fall back to direct dispatch when budget is exhausted (default: true) */
  fallbackOnExhaustion: boolean;
}

/**
 * Complete AI agent configuration.
 */
export interface AIAgentConfig {
  /** Whether AI dispatch is enabled (default: true) */
  enabled: boolean;
  /** Model identifier in provider:model format (e.g., "anthropic:claude-haiku-4-5") */
  model: string;
  /** API key for the AI provider */
  apiKey?: string;
  /** Maximum tokens per request (default: 1024) */
  maxTokensPerRequest: number;
  /** Token budget configuration */
  budget: AIBudgetConfig;
  /** Agent personality configuration */
  personality?: AIAgentPersonality;
}

/**
 * YAML configuration structure for the AI section.
 * String/number values that map to the parsed AIAgentConfig.
 */
export interface AIYamlConfig {
  enabled?: boolean;
  model?: string;
  apiKey?: string;
  maxTokensPerRequest?: number;
  budget?: {
    maxTokensPerHour?: number;
    fallbackOnExhaustion?: boolean;
  };
  personality?: AIAgentPersonality;
}

/**
 * Default AI agent configuration values.
 */
export const AI_AGENT_DEFAULTS: AIAgentConfig = {
  enabled: true,
  model: 'anthropic:claude-haiku-4-5',
  maxTokensPerRequest: 1024,
  budget: {
    maxTokensPerHour: 100000,
    fallbackOnExhaustion: true,
  },
};

/**
 * Parse and validate AI configuration from YAML or environment variables.
 *
 * @param yaml - Raw YAML AI config section (may be undefined)
 * @returns Validated AIAgentConfig with defaults applied
 */
export function parseAIConfig(yaml?: AIYamlConfig): AIAgentConfig {
  const config: AIAgentConfig = {
    enabled: yaml?.enabled ?? envBool('AI_AGENT_ENABLED') ?? AI_AGENT_DEFAULTS.enabled,
    model: yaml?.model || process.env.AI_AGENT_MODEL || AI_AGENT_DEFAULTS.model,
    apiKey: yaml?.apiKey || process.env.AI_API_KEY,
    maxTokensPerRequest:
      yaml?.maxTokensPerRequest ??
      envInt('AI_MAX_TOKENS_PER_REQUEST') ??
      AI_AGENT_DEFAULTS.maxTokensPerRequest,
    budget: {
      maxTokensPerHour:
        yaml?.budget?.maxTokensPerHour ??
        envInt('AI_MAX_TOKENS_PER_HOUR') ??
        AI_AGENT_DEFAULTS.budget.maxTokensPerHour,
      fallbackOnExhaustion:
        yaml?.budget?.fallbackOnExhaustion ?? AI_AGENT_DEFAULTS.budget.fallbackOnExhaustion,
    },
    personality: yaml?.personality,
  };

  // Validate model format
  if (config.enabled && !isValidModelString(config.model)) {
    throw new Error(
      `Invalid AI model format: "${config.model}". Expected "provider:model" format (e.g., "anthropic:claude-haiku-4-5").`
    );
  }

  // Validate budget
  if (config.budget.maxTokensPerHour <= 0) {
    throw new Error('AI budget maxTokensPerHour must be a positive number');
  }

  if (config.maxTokensPerRequest <= 0) {
    throw new Error('AI maxTokensPerRequest must be a positive number');
  }

  return config;
}

/**
 * Check if a model string is in valid provider:model format.
 */
export function isValidModelString(model: string): boolean {
  const parts = model.split(':');
  return parts.length >= 2 && (parts[0]?.length ?? 0) > 0 && (parts[1]?.length ?? 0) > 0;
}

/**
 * Parse a model string into provider and model name.
 */
export function parseModelString(model: string): { provider: string; modelName: string } {
  const colonIndex = model.indexOf(':');
  if (colonIndex === -1) {
    throw new Error(`Invalid model format: "${model}". Expected "provider:model".`);
  }
  return {
    provider: model.substring(0, colonIndex),
    modelName: model.substring(colonIndex + 1),
  };
}

function envBool(key: string): boolean | undefined {
  const value = process.env[key];
  if (value === undefined) return undefined;
  return value === 'true' || value === '1';
}

function envInt(key: string): number | undefined {
  const value = process.env[key];
  if (value === undefined) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
