/**
 * AI Agent Module
 *
 * Provides AI-native event handling for the Agent Society Protocol.
 * Uses Vercel AI SDK with agent skills to intelligently process
 * incoming Nostr events carried by ILP packets.
 *
 * @packageDocumentation
 */

// Configuration
export {
  parseAIConfig,
  isValidModelString,
  parseModelString,
  AI_AGENT_DEFAULTS,
} from './ai-agent-config';
export type {
  AIAgentConfig,
  AIYamlConfig,
  AIBudgetConfig,
  AIAgentPersonality,
} from './ai-agent-config';

// Provider Factory
export { createModelFromConfig } from './provider-factory';

// Skill Registry
export { SkillRegistry } from './skill-registry';
export type { AgentSkill, SkillExecuteContext, SkillSummary } from './skill-registry';

// System Prompt
export { SystemPromptBuilder } from './system-prompt';

// Token Budget
export { TokenBudget } from './token-budget';
export type { TokenUsageRecord, TokenBudgetStatus } from './token-budget';

// AI Agent Dispatcher
export { AIAgentDispatcher } from './ai-agent-dispatcher';

// Built-in Skills
export { registerBuiltInSkills } from './skills';
export type { RegisterSkillsConfig } from './skills';
