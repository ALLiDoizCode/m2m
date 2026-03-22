/**
 * ILP Packet Factory for Test Packet Generation
 *
 * Creates valid ILP packets (Prepare, Fulfill, Reject) for testing purposes.
 * Implements RFC-0027 packet format.
 */

import {
  ILPPreparePacket,
  ILPFulfillPacket,
  ILPRejectPacket,
  PacketType,
  ILPErrorCode,
  isValidILPAddress,
} from '@toon-protocol/shared';

/**
 * Result from creating a test Prepare packet
 */
export interface PreparePacketResult {
  packet: ILPPreparePacket;
}

/**
 * Create a test ILP Prepare packet
 *
 * Generates a Prepare packet with:
 * - Future expiration timestamp
 * - Validated destination address
 *
 * @param destination - ILP destination address (e.g., g.connectora.dest)
 * @param amount - Transfer amount in smallest unit (uint64)
 * @param expirySeconds - Packet expiry time in seconds from now (default: 30)
 * @param data - Optional application data payload
 * @returns PreparePacketResult containing packet
 * @throws Error if destination address is invalid
 */
export function createTestPreparePacket(
  destination: string,
  amount: bigint,
  expirySeconds = 30,
  data?: Buffer
): PreparePacketResult {
  // Validate destination address
  if (!isValidILPAddress(destination)) {
    throw new Error(`Invalid ILP address: ${destination}`);
  }

  // Calculate expiry timestamp: current time + expirySeconds
  const expiresAt = new Date(Date.now() + expirySeconds * 1000);

  // Create ILP Prepare packet
  const packet: ILPPreparePacket = {
    type: PacketType.PREPARE,
    amount,
    destination,
    expiresAt,
    data: data ?? Buffer.alloc(0),
  };

  return { packet };
}

/**
 * Create a test ILP Fulfill packet
 *
 * @param data - Optional return data payload
 * @returns ILPFulfillPacket
 */
export function createTestFulfillPacket(data?: Buffer): ILPFulfillPacket {
  return {
    type: PacketType.FULFILL,
    data: data ?? Buffer.alloc(0),
  };
}

/**
 * Create a test ILP Reject packet
 *
 * @param code - ILP error code (e.g., F02_UNREACHABLE, T01_PEER_UNREACHABLE)
 * @param message - Human-readable error description
 * @param triggeredBy - ILP address of connector that generated error
 * @param data - Optional error context data
 * @returns ILPRejectPacket
 * @throws Error if triggeredBy address is invalid
 */
export function createTestRejectPacket(
  code: ILPErrorCode,
  message: string,
  triggeredBy: string,
  data?: Buffer
): ILPRejectPacket {
  // Validate triggeredBy address
  if (!isValidILPAddress(triggeredBy)) {
    throw new Error(`Invalid ILP address for triggeredBy: ${triggeredBy}`);
  }

  return {
    type: PacketType.REJECT,
    code,
    triggeredBy,
    message,
    data: data ?? Buffer.alloc(0),
  };
}
