/**
 * Shared types and utilities
 * @packageDocumentation
 */

export const version = '1.0.0';

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

// localDelivery wire contract (`/handle-packet`) — the cross-process source of
// truth shared by the connector and every node (relay/store/sdk bridge).
// zod schemas enable runtime validation; types are inferred from them.
export { PaymentRequestSchema, PaymentResponseSchema } from './types/local-delivery';
export type { PaymentRequest, PaymentResponse } from './types/local-delivery';

// Connector Admin-API wire contract (hub → connector) — focused slice: peer
// registration. Other admin DTOs are a documented backlog (see contracts.md).
export { PeerRegistrationRequestSchema, PeerRelationSchema, PeerRouteSchema } from './types/admin';
export type { PeerRegistrationRequest, PeerRelation, PeerRoute } from './types/admin';

// Payment Channel Types (Epic 8 Story 8.7)
export {
  ChannelStatus,
  ChannelState,
  BalanceProof,
  ChannelOpenedEvent,
  ChannelClosedEvent,
  ChannelSettledEvent,
  ChannelCooperativeSettledEvent,
  ChannelEvent,
} from './types/payment-channel';
