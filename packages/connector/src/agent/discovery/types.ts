import { z } from 'zod';

/**
 * Agent type categorization for the Agent Society Protocol
 * Defines the role an agent plays in the network
 */
export type AgentType = 'dvm' | 'assistant' | 'specialist' | 'coordinator' | 'relay';

/**
 * Pricing entry for a specific event kind
 * Defines the cost structure for handling an event kind
 */
export interface PricingEntry {
  /** Event kind this pricing applies to */
  kind: number;
  /** Price amount in smallest unit (ILP base units) */
  amount: bigint;
  /** Currency unit for the price */
  currency: 'msat' | 'sat' | 'usd';
}

/**
 * Agent capacity information
 * Indicates how much load the agent can handle
 */
export interface CapacityInfo {
  /** Maximum number of concurrent requests the agent can handle */
  maxConcurrent: number;
  /** Maximum queue depth for pending requests */
  queueDepth: number;
}

/**
 * Extended capabilities metadata for an agent
 * Optional detailed information about agent capabilities
 */
export interface AgentCapabilities {
  /** Supported natural languages (e.g., ['en', 'es', 'fr']) */
  languages?: string[];
  /** Domain expertise areas (e.g., ['finance', 'legal', 'medical']) */
  domains?: string[];
  /** Maximum context window size in tokens */
  maxContextTokens?: number;
}

/**
 * Agent metadata stored in Kind 31990 content field
 * Provides human-readable information about the agent
 */
export interface AgentMetadata {
  /** Agent display name */
  name: string;
  /** Agent description */
  about?: string;
  /** Avatar image URL */
  picture?: string;
  /** Agent website URL */
  website?: string;
  /** Nostr NIP-05 identifier */
  nip05?: string;
  /** Lightning address (LNURL) */
  lud16?: string;
  /** Extended capabilities information */
  capabilities?: AgentCapabilities;
}

/**
 * Complete agent capability advertisement (Kind 31990)
 * Represents the full capability profile of an agent
 */
export interface AgentCapability {
  /** Agent's Nostr public key (64-character hex) */
  pubkey: string;
  /** Unique identifier for this capability event (d tag value, typically ILP address) */
  identifier: string;
  /** Array of event kinds this agent can handle */
  supportedKinds: number[];
  /** Array of Nostr Improvement Proposals (NIPs) this agent supports */
  supportedNips: string[];
  /** Type/role of this agent in the network */
  agentType: AgentType;
  /** ILP address for sending payments to this agent */
  ilpAddress: string;
  /** Pricing information per event kind */
  pricing: Map<number, PricingEntry>;
  /** Optional capacity constraints */
  capacity?: CapacityInfo;
  /** Optional AI model identifier (e.g., 'anthropic:claude-haiku-4-5') */
  model?: string;
  /** Optional list of skill names this agent provides */
  skills?: string[];
  /** Agent metadata from content field */
  metadata: AgentMetadata;
  /** Unix timestamp when this capability event was created */
  createdAt: number;
}

/**
 * Tag name constants for NIP-XX1 capability events
 * Defines the standard tag names used in Kind 31990 events
 */
export const TAG_NAMES = {
  /** Unique identifier tag (parameterized replaceable event) */
  IDENTIFIER: 'd',
  /** Event kind tag (indicates supported event kinds) */
  KIND: 'k',
  /** NIP support tag (indicates supported Nostr Improvement Proposals) */
  NIP: 'nip',
  /** Agent type tag */
  AGENT_TYPE: 'agent-type',
  /** ILP address tag */
  ILP_ADDRESS: 'ilp-address',
  /** Pricing tag (format: ['pricing', kind, amount, currency]) */
  PRICING: 'pricing',
  /** Capacity tag (format: ['capacity', maxConcurrent, queueDepth]) */
  CAPACITY: 'capacity',
  /** AI model tag */
  MODEL: 'model',
  /** Skills tag */
  SKILLS: 'skills',
} as const;

/**
 * Zod schema for AgentCapabilities validation
 */
export const AgentCapabilitiesSchema = z.object({
  languages: z.array(z.string()).optional(),
  domains: z.array(z.string()).optional(),
  maxContextTokens: z.number().int().positive().optional(),
});

/**
 * Zod schema for AgentMetadata validation
 */
export const AgentMetadataSchema = z.object({
  name: z.string().min(1),
  about: z.string().optional(),
  picture: z.string().url().optional(),
  website: z.string().url().optional(),
  nip05: z.string().optional(),
  lud16: z.string().optional(),
  capabilities: AgentCapabilitiesSchema.optional(),
});

/**
 * Zod schema for PricingEntry validation
 * Note: Zod doesn't natively support bigint, so we validate the structure
 * and handle bigint conversion separately
 */
export const PricingEntrySchema = z.object({
  kind: z.number().int().nonnegative(),
  amount: z.union([z.bigint(), z.number(), z.string()]).transform((val) => BigInt(val)),
  currency: z.enum(['msat', 'sat', 'usd']),
});

/**
 * Zod schema for CapacityInfo validation
 */
export const CapacityInfoSchema = z.object({
  maxConcurrent: z.number().int().positive(),
  queueDepth: z.number().int().nonnegative(),
});

/**
 * Zod schema for AgentCapability validation
 * Note: The pricing Map is handled specially due to Zod's Map support limitations
 */
export const AgentCapabilitySchema = z.object({
  pubkey: z.string().length(64),
  identifier: z.string().min(1),
  supportedKinds: z.array(z.number().int().nonnegative()),
  supportedNips: z.array(z.string()),
  agentType: z.enum(['dvm', 'assistant', 'specialist', 'coordinator', 'relay']),
  ilpAddress: z.string().min(1),
  pricing: z
    .map(z.number(), PricingEntrySchema)
    .or(z.array(z.tuple([z.number(), PricingEntrySchema])).transform((arr) => new Map(arr))),
  capacity: CapacityInfoSchema.optional(),
  model: z.string().optional(),
  skills: z.array(z.string()).optional(),
  metadata: AgentMetadataSchema,
  createdAt: z.number().int().positive(),
});

/**
 * Runtime validation helper for AgentCapability
 * Validates unknown data against the AgentCapability schema
 *
 * @param data - Unknown data to validate
 * @returns Validated AgentCapability object
 * @throws ZodError if validation fails
 */
export function validateAgentCapability(data: unknown): AgentCapability {
  return AgentCapabilitySchema.parse(data);
}

/**
 * Runtime validation helper for AgentMetadata
 * Validates unknown data against the AgentMetadata schema
 *
 * @param data - Unknown data to validate
 * @returns Validated AgentMetadata object
 * @throws ZodError if validation fails
 */
export function validateAgentMetadata(data: unknown): AgentMetadata {
  return AgentMetadataSchema.parse(data);
}
