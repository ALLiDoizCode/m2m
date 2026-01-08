/**
 * Shared types and utilities
 * @packageDocumentation
 */

export const version = '0.1.0';

// ILP Type Definitions (RFC-0027, RFC-0015)
export {
  // Enums
  PacketType,
  ILPErrorCode,
  // Types
  ILPAddress,
  ILPPacket,
  ILPPreparePacket,
  ILPFulfillPacket,
  ILPRejectPacket,
  // Type Guards
  isPreparePacket,
  isFulfillPacket,
  isRejectPacket,
  // Validation Helpers
  isValidILPAddress,
} from './types/ilp';

// OER Encoding/Decoding (RFC-0030)
export {
  // Error Classes
  InvalidPacketError,
  BufferUnderflowError,
  // Generic Packet Serialization
  serializePacket,
  deserializePacket,
  // Type-Specific Serialization
  serializePrepare,
  deserializePrepare,
  serializeFulfill,
  deserializeFulfill,
  serializeReject,
  deserializeReject,
  // OER Primitives
  encodeVarUInt,
  decodeVarUInt,
  encodeVarOctetString,
  decodeVarOctetString,
  encodeFixedOctetString,
  decodeFixedOctetString,
  encodeGeneralizedTime,
  decodeGeneralizedTime,
} from './encoding/oer';

// Routing Types
export { RoutingTableEntry } from './types/routing';

// Telemetry Types (Story 6.8, Story 11.3, Story 11.4, Story 11.5)
export {
  TelemetryEventType,
  SettlementState,
  AccountBalanceEvent,
  SettlementTriggeredEvent,
  SettlementCompletedEvent,
  AgentBalanceChangedEvent,
  FundingTransaction,
  AgentWalletFundedEvent,
  FundingRateLimitExceededEvent,
  FundingTransactionConfirmedEvent,
  FundingTransactionFailedEvent,
  AgentWalletStateChangedEvent,
  TelemetryEvent,
} from './types/telemetry';
