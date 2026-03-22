/**
 * Performance Tests for OER Encoding/Decoding
 *
 * Validates that encoding/decoding 1000 packets completes in <100ms per AC #9.
 *
 * @see {@link https://interledger.org/rfcs/0030-notes-on-oer-encoding/|RFC-0030: OER Encoding}
 */

import {
  serializePacket,
  deserializePacket,
  serializePrepare,
  deserializePrepare,
  serializeFulfill,
  deserializeFulfill,
  serializeReject,
  deserializeReject,
} from './oer';

import {
  PacketType,
  ILPPreparePacket,
  ILPFulfillPacket,
  ILPRejectPacket,
  ILPErrorCode,
} from '../types/ilp';

// ============================================================================
// Test Data Factories
// ============================================================================

function createTestPreparePacket(index: number): ILPPreparePacket {
  return {
    type: PacketType.PREPARE,
    amount: BigInt(1000 + index),
    destination: `g.alice.payment_${index}`,
    expiresAt: new Date('2025-12-31T23:59:59.999Z'), // Fixed date for consistent encoding
    data: Buffer.from(`Payment ${index} data`),
  };
}

function createTestFulfillPacket(index: number): ILPFulfillPacket {
  return {
    type: PacketType.FULFILL,
    data: Buffer.from(`Fulfillment ${index} data`),
  };
}

function createTestRejectPacket(index: number): ILPRejectPacket {
  const errorCodes = [
    ILPErrorCode.F02_UNREACHABLE,
    ILPErrorCode.T00_INTERNAL_ERROR,
    ILPErrorCode.R00_TRANSFER_TIMED_OUT,
  ];

  return {
    type: PacketType.REJECT,
    code: errorCodes[index % errorCodes.length]!,
    triggeredBy: `g.connector_${index}`,
    message: `Error for packet ${index}`,
    data: Buffer.from(`Error context ${index}`),
  };
}

// ============================================================================
// Performance Tests
// ============================================================================

describe('OER Performance Tests', () => {
  const PACKET_COUNT = 1000;
  const MAX_TIME_MS = 100;

  it('should encode 1000 Prepare packets in <100ms', () => {
    const packets = Array.from({ length: PACKET_COUNT }, (_, i) => createTestPreparePacket(i));

    const startTime = performance.now();

    packets.forEach((packet) => {
      serializePrepare(packet);
    });

    const endTime = performance.now();
    const duration = endTime - startTime;

    // Performance assertion: encoding should complete in <100ms
    expect(duration).toBeLessThan(MAX_TIME_MS);
  });

  it('should decode 1000 Prepare packets in <100ms', () => {
    const packets = Array.from({ length: PACKET_COUNT }, (_, i) => createTestPreparePacket(i));
    const serialized = packets.map((p) => serializePrepare(p));

    const startTime = performance.now();

    serialized.forEach((buffer) => {
      deserializePrepare(buffer);
    });

    const endTime = performance.now();
    const duration = endTime - startTime;

    // Performance assertion: decoding should complete in <100ms
    expect(duration).toBeLessThan(MAX_TIME_MS);
  });

  it('should encode 1000 Fulfill packets in <100ms', () => {
    const packets = Array.from({ length: PACKET_COUNT }, (_, i) => createTestFulfillPacket(i));

    const startTime = performance.now();

    packets.forEach((packet) => {
      serializeFulfill(packet);
    });

    const endTime = performance.now();
    const duration = endTime - startTime;

    // Performance assertion: encoding should complete in <100ms
    expect(duration).toBeLessThan(MAX_TIME_MS);
  });

  it('should decode 1000 Fulfill packets in <100ms', () => {
    const packets = Array.from({ length: PACKET_COUNT }, (_, i) => createTestFulfillPacket(i));
    const serialized = packets.map((p) => serializeFulfill(p));

    const startTime = performance.now();

    serialized.forEach((buffer) => {
      deserializeFulfill(buffer);
    });

    const endTime = performance.now();
    const duration = endTime - startTime;

    // Performance assertion: decoding should complete in <100ms
    expect(duration).toBeLessThan(MAX_TIME_MS);
  });

  it('should encode 1000 Reject packets in <100ms', () => {
    const packets = Array.from({ length: PACKET_COUNT }, (_, i) => createTestRejectPacket(i));

    const startTime = performance.now();

    packets.forEach((packet) => {
      serializeReject(packet);
    });

    const endTime = performance.now();
    const duration = endTime - startTime;

    // Performance assertion: encoding should complete in <100ms
    expect(duration).toBeLessThan(MAX_TIME_MS);
  });

  it('should decode 1000 Reject packets in <100ms', () => {
    const packets = Array.from({ length: PACKET_COUNT }, (_, i) => createTestRejectPacket(i));
    const serialized = packets.map((p) => serializeReject(p));

    const startTime = performance.now();

    serialized.forEach((buffer) => {
      deserializeReject(buffer);
    });

    const endTime = performance.now();
    const duration = endTime - startTime;

    // Performance assertion: decoding should complete in <100ms
    expect(duration).toBeLessThan(MAX_TIME_MS);
  });

  it('should encode + decode 1000 mixed packets in <100ms', () => {
    // Mix of all three packet types
    const packets: (ILPPreparePacket | ILPFulfillPacket | ILPRejectPacket)[] = [];
    for (let i = 0; i < PACKET_COUNT; i++) {
      if (i % 3 === 0) packets.push(createTestPreparePacket(i));
      else if (i % 3 === 1) packets.push(createTestFulfillPacket(i));
      else packets.push(createTestRejectPacket(i));
    }

    const startTime = performance.now();

    const serialized = packets.map((p) => serializePacket(p));
    serialized.forEach((buffer) => {
      deserializePacket(buffer);
    });

    const endTime = performance.now();
    const duration = endTime - startTime;

    // Performance assertion: encode + decode should complete in <100ms
    expect(duration).toBeLessThan(MAX_TIME_MS);
  });
});
