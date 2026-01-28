/**
 * Agent Capability Discovery Module
 *
 * This module implements NIP-XX1 (Agent Capability Advertisement) for the Agent Society Protocol.
 * It provides types, schemas, and utilities for advertising and discovering agent capabilities
 * across the network.
 */

export {
  // Types
  type AgentType,
  type PricingEntry,
  type CapacityInfo,
  type AgentCapabilities,
  type AgentMetadata,
  type AgentCapability,
  // Schemas
  AgentCapabilitiesSchema,
  AgentMetadataSchema,
  PricingEntrySchema,
  CapacityInfoSchema,
  AgentCapabilitySchema,
  // Validation helpers
  validateAgentCapability,
  validateAgentMetadata,
  // Constants
  TAG_NAMES,
} from './types';

export { CapabilityPublisher, type CapabilityPublisherConfig } from './capability-publisher';
