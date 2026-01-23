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
