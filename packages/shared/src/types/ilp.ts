/**
 * ILP (Interledger Protocol) v4 Type Definitions
 *
 * This module provides TypeScript type definitions for ILPv4 packets per RFC-0027.
 *
 * @see {@link https://interledger.org/rfcs/0027-interledger-protocol-4/|RFC-0027: ILPv4}
 * @see {@link https://interledger.org/rfcs/0015-ilp-addresses/|RFC-0015: ILP Addresses}
 */

/**
 * ILP Packet Type Discriminator
 *
 * Enumeration of packet types used in ILP v4 protocol.
 *
 * @see {@link https://interledger.org/rfcs/0027-interledger-protocol-4/#packet-format|RFC-0027: Packet Format}
 */
export enum PacketType {
  /** ILP Prepare packet - initiates conditional payment (RFC-0027 Section 3.1) */
  PREPARE = 12,
  /** ILP Fulfill packet - completes payment with fulfillment (RFC-0027 Section 3.2) */
  FULFILL = 13,
  /** ILP Reject packet - rejects payment with error (RFC-0027 Section 3.3) */
  REJECT = 14,
}

/**
 * ILP Address Type
 *
 * Hierarchical addressing scheme for ILP protocol per RFC-0015.
 * Format: dot-separated segments (e.g., "g.alice", "g.bob.crypto")
 *
 * @see {@link https://interledger.org/rfcs/0015-ilp-addresses/|RFC-0015: ILP Addresses}
 */
export type ILPAddress = string;

/**
 * Base ILP Packet Interface
 *
 * Abstract base type for all ILP packet types (Prepare, Fulfill, Reject).
 * Not directly instantiated - use specific packet types instead.
 *
 * @see {@link https://interledger.org/rfcs/0027-interledger-protocol-4/|RFC-0027: ILPv4}
 */
export interface ILPPacket {
  /** Packet type discriminator (12=Prepare, 13=Fulfill, 14=Reject) */
  type: PacketType;
  /** Binary payload data */
  data: Buffer;
}

/**
 * ILP Prepare Packet
 *
 * Represents a payment packet initiating an ILP transaction.
 * Self-described claims in the data field provide payment semantics;
 * the legacy executionCondition field is written as 32 zero bytes
 * on the wire for ILPv4 format compatibility.
 *
 * @see {@link https://interledger.org/rfcs/0027-interledger-protocol-4/#ilp-prepare|RFC-0027 Section 3.1: ILP Prepare}
 */
export interface ILPPreparePacket {
  /** Packet type identifier - always PREPARE (12) */
  type: PacketType.PREPARE;
  /** Transfer amount in smallest unit (uint64) */
  amount: bigint;
  /** Payment destination address (hierarchical ILP address per RFC-0015) */
  destination: ILPAddress;
  /**
   * Expiration timestamp (ISO 8601)
   * Payment must be fulfilled or rejected before this time
   */
  expiresAt: Date;
  /** Application data payload (contains self-described claims) */
  data: Buffer;
}

/**
 * ILP Fulfill Packet
 *
 * Represents successful payment acceptance in response to a Prepare packet.
 * The legacy fulfillment field is written as 32 zero bytes on the wire
 * for ILPv4 format compatibility. Payment verification relies on
 * self-described claims rather than fulfillment/condition cryptography.
 *
 * @see {@link https://interledger.org/rfcs/0027-interledger-protocol-4/#ilp-fulfill|RFC-0027 Section 3.2: ILP Fulfill}
 */
export interface ILPFulfillPacket {
  /** Packet type identifier - always FULFILL (13) */
  type: PacketType.FULFILL;
  /** Optional return data */
  data: Buffer;
}

/**
 * ILP Error Codes
 *
 * Standard error codes for ILP Reject packets per RFC-0027 Section 3.3.
 *
 * Error code categories:
 * - F-prefix: Final errors (permanent failures, should not retry)
 * - T-prefix: Temporary errors (retryable failures)
 * - R-prefix: Relative errors (protocol violations, issues with packet format/timing)
 *
 * @see {@link https://interledger.org/rfcs/0027-interledger-protocol-4/#ilp-reject|RFC-0027 Section 3.3: Error Codes}
 */
export enum ILPErrorCode {
  // Final Errors (F-prefix) - Permanent failures
  /** F00: Bad Request - Generic final error */
  F00_BAD_REQUEST = 'F00',
  /** F01: Invalid Packet - Packet format violation */
  F01_INVALID_PACKET = 'F01',
  /** F02: Unreachable - No route to destination */
  F02_UNREACHABLE = 'F02',
  /** F03: Invalid Amount - Amount exceeds allowable range */
  F03_INVALID_AMOUNT = 'F03',
  /** F06: Unexpected Payment - Receiver not expecting payment */
  F06_UNEXPECTED_PAYMENT = 'F06',
  /** F08: Duplicate Packet - Packet already processed */
  F08_DUPLICATE_PACKET = 'F08',
  /** F99: Application Error - Application-level rejection */
  F99_APPLICATION_ERROR = 'F99',

  // Temporary Errors (T-prefix) - Retryable failures
  /** T00: Internal Error - Temporary internal error (retryable) */
  T00_INTERNAL_ERROR = 'T00',
  /** T01: Peer Unreachable - Next-hop peer unavailable */
  T01_PEER_UNREACHABLE = 'T01',
  /** T02: Peer Busy - Peer temporarily busy */
  T02_PEER_BUSY = 'T02',
  /** T03: Connector Busy - This connector temporarily busy */
  T03_CONNECTOR_BUSY = 'T03',
  /** T04: Insufficient Liquidity - Temporary liquidity shortage */
  T04_INSUFFICIENT_LIQUIDITY = 'T04',
  /** T99: Application Error - Temporary application error */
  T99_APPLICATION_ERROR = 'T99',

  // Relative Errors (R-prefix) - Protocol violations
  /** R00: Transfer Timed Out - Packet expired during forwarding */
  R00_TRANSFER_TIMED_OUT = 'R00',
  /** R01: Insufficient Source Amount - Amount too low after fees */
  R01_INSUFFICIENT_SOURCE_AMOUNT = 'R01',
  /** R02: Insufficient Timeout - Expiry too soon for forwarding */
  R02_INSUFFICIENT_TIMEOUT = 'R02',
  /** R99: Application Error - Protocol violation */
  R99_APPLICATION_ERROR = 'R99',
}

/**
 * ILP Reject Packet
 *
 * Represents payment rejection with error information in response to a Prepare packet.
 * Used when a payment cannot be fulfilled due to routing issues, validation failures,
 * or business logic constraints.
 *
 * @see {@link https://interledger.org/rfcs/0027-interledger-protocol-4/#ilp-reject|RFC-0027 Section 3.3: ILP Reject}
 */
export interface ILPRejectPacket {
  /** Packet type identifier - always REJECT (14) */
  type: PacketType.REJECT;
  /** Three-character error code (F00-F99, T00-T99, R00-R99) */
  code: ILPErrorCode;
  /** Address of connector that generated this error */
  triggeredBy: ILPAddress;
  /** Human-readable error description */
  message: string;
  /** Additional error context data */
  data: Buffer;
}

/**
 * Validates ILP Address Format
 *
 * Validates that a string conforms to the ILP address format per RFC-0015.
 *
 * Validation rules:
 * - Format: dot-separated segments (e.g., "g.alice", "g.bob.crypto")
 * - Allowed characters: alphanumeric (a-z, A-Z, 0-9), hyphen (-), underscore (_)
 * - Case-sensitive
 * - Minimum length: 1 character (single segment like "g" is valid)
 * - Maximum length: 1023 characters total
 * - No leading/trailing dots
 * - No consecutive dots (empty segments)
 *
 * @param address - The address string to validate
 * @returns true if the address is valid, false otherwise
 *
 * @example
 * ```typescript
 * isValidILPAddress('g.alice') // true
 * isValidILPAddress('g.bob.crypto') // true
 * isValidILPAddress('.g.alice') // false (leading dot)
 * isValidILPAddress('g..alice') // false (consecutive dots)
 * ```
 *
 * @see {@link https://interledger.org/rfcs/0015-ilp-addresses/|RFC-0015: ILP Addresses}
 */
export function isValidILPAddress(address: string): boolean {
  // Check for empty string
  if (address.length === 0) {
    return false;
  }

  // Check maximum length (1023 characters)
  if (address.length > 1023) {
    return false;
  }

  // Validate format: alphanumeric, hyphen, underscore, dots
  // No leading/trailing dots, no consecutive dots
  const addressRegex = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;

  return addressRegex.test(address);
}

/**
 * Type Guard: Check if packet is ILP Prepare Packet
 *
 * Type guard function to narrow packet type to ILPPreparePacket.
 * Checks if the packet type discriminator is PREPARE (12).
 *
 * @param packet - The packet to check
 * @returns true if packet is ILPPreparePacket, false otherwise
 *
 * @example
 * ```typescript
 * if (isPreparePacket(packet)) {
 *   // TypeScript knows packet is ILPPreparePacket here
 *   console.log(packet.destination);
 * }
 * ```
 */
export function isPreparePacket(packet: unknown): packet is ILPPreparePacket {
  return (
    typeof packet === 'object' &&
    packet !== null &&
    'type' in packet &&
    packet.type === PacketType.PREPARE
  );
}

/**
 * Type Guard: Check if packet is ILP Fulfill Packet
 *
 * Type guard function to narrow packet type to ILPFulfillPacket.
 * Checks if the packet type discriminator is FULFILL (13).
 *
 * @param packet - The packet to check
 * @returns true if packet is ILPFulfillPacket, false otherwise
 *
 * @example
 * ```typescript
 * if (isFulfillPacket(packet)) {
 *   // TypeScript knows packet is ILPFulfillPacket here
 *   console.log(packet.fulfillment);
 * }
 * ```
 */
export function isFulfillPacket(packet: unknown): packet is ILPFulfillPacket {
  return (
    typeof packet === 'object' &&
    packet !== null &&
    'type' in packet &&
    packet.type === PacketType.FULFILL
  );
}

/**
 * Type Guard: Check if packet is ILP Reject Packet
 *
 * Type guard function to narrow packet type to ILPRejectPacket.
 * Checks if the packet type discriminator is REJECT (14).
 *
 * @param packet - The packet to check
 * @returns true if packet is ILPRejectPacket, false otherwise
 *
 * @example
 * ```typescript
 * if (isRejectPacket(packet)) {
 *   // TypeScript knows packet is ILPRejectPacket here
 *   console.log(packet.code, packet.message);
 * }
 * ```
 */
export function isRejectPacket(packet: unknown): packet is ILPRejectPacket {
  return (
    typeof packet === 'object' &&
    packet !== null &&
    'type' in packet &&
    packet.type === PacketType.REJECT
  );
}
