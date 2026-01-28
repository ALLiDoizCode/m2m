/**
 * Agent Society Protocol - Agent Module
 *
 * This module provides components for agent-to-agent communication
 * using Nostr events over the Interledger network.
 */

// TOON Codec for Nostr event serialization
export {
  ToonCodec,
  NostrEvent,
  ToonEncodeError,
  ToonDecodeError,
  ValidationError,
} from './toon-codec';

// Agent Event Database for NIP-01 compatible event storage
export {
  AgentEventDatabase,
  AgentEventDatabaseConfig,
  NostrFilter,
  DatabaseSizeExceededError,
} from './event-database';

// Agent Event Handler for kind-based event dispatch with payment validation
export {
  AgentEventHandler,
  AgentEventHandlerConfig,
  EventHandlerContext,
  EventHandlerResult,
  EventHandler,
  HandlerConfig,
  InsufficientPaymentError,
} from './event-handler';

// Follow Graph Router for routing ILP packets via Nostr follow relationships
export {
  FollowGraphRouter,
  FollowGraphRouterConfig,
  AgentFollow,
  FollowGraphEdge,
} from './follow-graph-router';

// Subscription Manager for event subscription filtering and matching
export {
  SubscriptionManager,
  SubscriptionManagerConfig,
  Subscription,
} from './subscription-manager';

// Built-in Event Kind Handlers
export {
  createNoteHandler,
  createFollowHandler,
  createDeleteHandler,
  createQueryHandler,
  registerBuiltInHandlers,
} from './handlers';
export type {
  FollowHandlerConfig,
  DeleteHandlerConfig,
  QueryHandlerConfig,
  BuiltInHandlersConfig,
} from './handlers';

// Agent Node Orchestrator
export { AgentNode } from './agent-node';
export type { AgentNodeConfig, AgentTelemetryEvent } from './agent-node';

// AI Agent Module
export {
  AIAgentDispatcher,
  SkillRegistry,
  SystemPromptBuilder,
  TokenBudget,
  parseAIConfig,
  createModelFromConfig,
  registerBuiltInSkills,
  AI_AGENT_DEFAULTS,
} from './ai';
export type {
  AIAgentConfig,
  AIAgentDispatcherConfig,
  AIYamlConfig,
  AIBudgetConfig,
  AIAgentPersonality,
  AgentSkill,
  SkillExecuteContext,
  SkillSummary,
  TokenUsageRecord,
  TokenBudgetStatus,
  TokenBudgetTelemetryEvent,
  PromptContext,
} from './ai';

// DVM Module - NIP-90 Compatibility
export { DVM_KIND_RANGE, DVM_ERROR_CODES, DVMParseError, parseDVMJobRequest } from './dvm';
export type { DVMJobRequest, DVMInput, DVMInputType, DVMErrorCode } from './dvm';
