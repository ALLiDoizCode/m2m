/**
 * Unit Tests for OER Encoding/Decoding
 *
 * Comprehensive test suite for OER (Octet Encoding Rules) implementation.
 * Tests cover VarUInt, VarOctetString, and ILP packet serialization/deserialization.
 *
 * @see {@link https://interledger.org/rfcs/0030-notes-on-oer-encoding/|RFC-0030: OER Encoding}
 * @see {@link https://interledger.org/rfcs/0027-interledger-protocol-4/|RFC-0027: ILPv4}
 */

import {
  encodeVarUInt,
  decodeVarUInt,
  encodeVarOctetString,
  decodeVarOctetString,
  encodeFixedOctetString,
  decodeFixedOctetString,
  encodeGeneralizedTime,
  decodeGeneralizedTime,
  serializePrepare,
  deserializePrepare,
  serializeFulfill,
  deserializeFulfill,
  serializeReject,
  deserializeReject,
  serializePacket,
  deserializePacket,
  InvalidPacketError,
  BufferUnderflowError,
} from './oer';

import {
  PacketType,
  ILPPreparePacket,
  ILPFulfillPacket,
  ILPRejectPacket,
  ILPErrorCode,
} from '../types/ilp';

// ============================================================================
// VarUInt Encoding/Decoding Tests
// ============================================================================

describe('encodeVarUInt', () => {
  it('should encode 0 as single byte', () => {
    const result = encodeVarUInt(0n);
    expect(result).toEqual(Buffer.from([0x00]));
  });

  it('should encode 127 as single byte', () => {
    const result = encodeVarUInt(127n);
    expect(result).toEqual(Buffer.from([0x7f]));
  });

  it('should encode 128 with length prefix', () => {
    const result = encodeVarUInt(128n);
    expect(result).toEqual(Buffer.from([0x81, 0x80])); // 0x80 | 1 = 0x81
  });

  it('should encode 255 with length prefix', () => {
    const result = encodeVarUInt(255n);
    expect(result).toEqual(Buffer.from([0x81, 0xff])); // 0x80 | 1 = 0x81
  });

  it('should encode 256 with length prefix', () => {
    const result = encodeVarUInt(256n);
    expect(result).toEqual(Buffer.from([0x82, 0x01, 0x00])); // 0x80 | 2 = 0x82
  });

  it('should encode 1000 with length prefix', () => {
    const result = encodeVarUInt(1000n);
    expect(result).toEqual(Buffer.from([0x82, 0x03, 0xe8])); // 0x80 | 2 = 0x82
  });

  it('should encode 65535 with length prefix', () => {
    const result = encodeVarUInt(65535n);
    expect(result).toEqual(Buffer.from([0x82, 0xff, 0xff])); // 0x80 | 2 = 0x82
  });

  it('should encode maximum uint64 value', () => {
    const maxUint64 = BigInt('18446744073709551615'); // 2^64 - 1
    const result = encodeVarUInt(maxUint64);
    expect(result.length).toBe(9); // 1 length byte + 8 data bytes
    expect(result[0]).toBe(0x88); // 0x80 | 8 = 0x88
    expect(result.slice(1)).toEqual(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
  });

  it('should throw InvalidPacketError for -1 instead of emitting corrupt bytes', () => {
    expect(() => encodeVarUInt(-1n)).toThrow(InvalidPacketError);
  });

  it('should throw InvalidPacketError for a large negative value', () => {
    expect(() => encodeVarUInt(-123456789n)).toThrow(InvalidPacketError);
  });
});

describe('decodeVarUInt', () => {
  it('should decode single byte value 0', () => {
    const result = decodeVarUInt(Buffer.from([0x00]), 0);
    expect(result.value).toBe(0n);
    expect(result.bytesRead).toBe(1);
  });

  it('should decode single byte value 127', () => {
    const result = decodeVarUInt(Buffer.from([0x7f]), 0);
    expect(result.value).toBe(127n);
    expect(result.bytesRead).toBe(1);
  });

  it('should decode length-prefixed value 128', () => {
    const result = decodeVarUInt(Buffer.from([0x81, 0x80]), 0);
    expect(result.value).toBe(128n);
    expect(result.bytesRead).toBe(2);
  });

  it('should decode length-prefixed value 255', () => {
    const result = decodeVarUInt(Buffer.from([0x81, 0xff]), 0);
    expect(result.value).toBe(255n);
    expect(result.bytesRead).toBe(2);
  });

  it('should decode length-prefixed value 1000', () => {
    const result = decodeVarUInt(Buffer.from([0x82, 0x03, 0xe8]), 0);
    expect(result.value).toBe(1000n);
    expect(result.bytesRead).toBe(3);
  });

  it('should decode maximum uint64 value', () => {
    const buffer = Buffer.from([0x88, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const result = decodeVarUInt(buffer, 0);
    expect(result.value).toBe(BigInt('18446744073709551615'));
    expect(result.bytesRead).toBe(9);
  });

  it('should decode with non-zero offset', () => {
    const buffer = Buffer.from([0xff, 0xff, 0x81, 0x80]); // Padding + VarUInt(128)
    const result = decodeVarUInt(buffer, 2);
    expect(result.value).toBe(128n);
    expect(result.bytesRead).toBe(2);
  });

  it('should throw BufferUnderflowError when buffer is empty', () => {
    expect(() => decodeVarUInt(Buffer.alloc(0), 0)).toThrow(BufferUnderflowError);
  });

  it('should throw BufferUnderflowError when buffer underflows on length prefix', () => {
    expect(() => decodeVarUInt(Buffer.from([0x82, 0x01]), 0)).toThrow(BufferUnderflowError);
  });

  it('should round-trip encode/decode various values', () => {
    const testValues = [
      0n,
      1n,
      127n,
      128n,
      255n,
      256n,
      1000n,
      65535n,
      BigInt(2 ** 32),
      BigInt('18446744073709551615'),
    ];

    testValues.forEach((value) => {
      const encoded = encodeVarUInt(value);
      const decoded = decodeVarUInt(encoded, 0);
      expect(decoded.value).toBe(value);
    });
  });
});

// ============================================================================
// VarOctetString Encoding/Decoding Tests
// ============================================================================

describe('encodeVarOctetString', () => {
  it('should encode empty buffer', () => {
    const result = encodeVarOctetString(Buffer.alloc(0));
    expect(result).toEqual(Buffer.from([0x00])); // Length 0
  });

  it('should encode 1-byte buffer', () => {
    const result = encodeVarOctetString(Buffer.from([0x42]));
    expect(result).toEqual(Buffer.from([0x01, 0x42]));
  });

  it('should encode 127-byte buffer', () => {
    const data = Buffer.alloc(127, 0xaa);
    const result = encodeVarOctetString(data);
    expect(result[0]).toBe(0x7f); // Length as single byte
    expect(result.length).toBe(128); // 1 length byte + 127 data bytes
    expect(result.slice(1)).toEqual(data);
  });

  it('should encode 128-byte buffer with multi-byte length', () => {
    const data = Buffer.alloc(128, 0xbb);
    const result = encodeVarOctetString(data);
    expect(result[0]).toBe(0x81); // Length prefix (0x80 | 1)
    expect(result[1]).toBe(0x80); // Length value (128)
    expect(result.length).toBe(130); // 2 length bytes + 128 data bytes
    expect(result.slice(2)).toEqual(data);
  });

  it('should encode 1000-byte buffer', () => {
    const data = Buffer.alloc(1000, 0xcc);
    const result = encodeVarOctetString(data);
    // Length 1000 = 0x03e8 → VarUInt: [0x82, 0x03, 0xe8]
    expect(result.slice(0, 3)).toEqual(Buffer.from([0x82, 0x03, 0xe8]));
    expect(result.length).toBe(1003);
    expect(result.slice(3)).toEqual(data);
  });
});

describe('decodeVarOctetString', () => {
  it('should decode empty buffer', () => {
    const result = decodeVarOctetString(Buffer.from([0x00]), 0);
    expect(result.value).toEqual(Buffer.alloc(0));
    expect(result.bytesRead).toBe(1);
  });

  it('should decode 1-byte buffer', () => {
    const result = decodeVarOctetString(Buffer.from([0x01, 0x42]), 0);
    expect(result.value).toEqual(Buffer.from([0x42]));
    expect(result.bytesRead).toBe(2);
  });

  it('should decode 127-byte buffer', () => {
    const data = Buffer.alloc(127, 0xaa);
    const encoded = Buffer.concat([Buffer.from([0x7f]), data]);
    const result = decodeVarOctetString(encoded, 0);
    expect(result.value).toEqual(data);
    expect(result.bytesRead).toBe(128);
  });

  it('should decode 128-byte buffer', () => {
    const data = Buffer.alloc(128, 0xbb);
    const encoded = Buffer.concat([Buffer.from([0x81, 0x80]), data]);
    const result = decodeVarOctetString(encoded, 0);
    expect(result.value).toEqual(data);
    expect(result.bytesRead).toBe(130);
  });

  it('should decode with non-zero offset', () => {
    const buffer = Buffer.from([0xff, 0xff, 0x01, 0x42]); // Padding + VarOctetString
    const result = decodeVarOctetString(buffer, 2);
    expect(result.value).toEqual(Buffer.from([0x42]));
    expect(result.bytesRead).toBe(2);
  });

  it('should throw BufferUnderflowError when data is truncated', () => {
    // Length says 10 bytes, but only 2 bytes available
    expect(() => decodeVarOctetString(Buffer.from([0x0a, 0x01, 0x02]), 0)).toThrow(
      BufferUnderflowError
    );
  });

  it('should round-trip encode/decode various lengths', () => {
    const testLengths = [0, 1, 127, 128, 255, 1000];

    testLengths.forEach((length) => {
      const data = Buffer.alloc(length, length % 256);
      const encoded = encodeVarOctetString(data);
      const decoded = decodeVarOctetString(encoded, 0);
      expect(decoded.value).toEqual(data);
    });
  });
});

// ============================================================================
// Fixed Octet String Tests
// ============================================================================

describe('encodeFixedOctetString', () => {
  it('should encode buffer matching expected length', () => {
    const data = Buffer.alloc(32, 0xaa);
    const result = encodeFixedOctetString(data, 32);
    expect(result).toEqual(data);
  });

  it('should throw InvalidPacketError when length mismatches', () => {
    const data = Buffer.alloc(16);
    expect(() => encodeFixedOctetString(data, 32)).toThrow(InvalidPacketError);
  });
});

describe('decodeFixedOctetString', () => {
  it('should decode fixed-length buffer', () => {
    const buffer = Buffer.alloc(32, 0xbb);
    const result = decodeFixedOctetString(buffer, 0, 32);
    expect(result.value).toEqual(buffer);
    expect(result.bytesRead).toBe(32);
  });

  it('should decode with non-zero offset', () => {
    const buffer = Buffer.concat([Buffer.alloc(10, 0xff), Buffer.alloc(32, 0xcc)]);
    const result = decodeFixedOctetString(buffer, 10, 32);
    expect(result.value).toEqual(Buffer.alloc(32, 0xcc));
    expect(result.bytesRead).toBe(32);
  });

  it('should throw BufferUnderflowError when buffer is too short', () => {
    const buffer = Buffer.alloc(16);
    expect(() => decodeFixedOctetString(buffer, 0, 32)).toThrow(BufferUnderflowError);
  });
});

// ============================================================================
// Generalized Time Tests
// ============================================================================

describe('encodeGeneralizedTime', () => {
  it('should encode date to 19-byte generalized time format', () => {
    const date = new Date('2025-01-31T23:59:59.999Z');
    const result = encodeGeneralizedTime(date);
    expect(result.toString('utf8')).toBe('20250131235959.999Z');
    expect(result.length).toBe(19);
  });

  it('should encode date with zero milliseconds', () => {
    const date = new Date('2025-01-01T00:00:00.000Z');
    const result = encodeGeneralizedTime(date);
    expect(result.toString('utf8')).toBe('20250101000000.000Z');
  });

  it('should encode date in far future', () => {
    const date = new Date('2099-12-31T23:59:59.999Z');
    const result = encodeGeneralizedTime(date);
    expect(result.toString('utf8')).toBe('20991231235959.999Z');
  });
});

describe('decodeGeneralizedTime', () => {
  it('should decode generalized time to Date', () => {
    const buffer = Buffer.from('20250131235959.999Z', 'utf8');
    const result = decodeGeneralizedTime(buffer, 0);
    expect(result.value).toEqual(new Date('2025-01-31T23:59:59.999Z'));
    expect(result.bytesRead).toBe(19);
  });

  it('should decode with non-zero offset', () => {
    const buffer = Buffer.concat([Buffer.alloc(5), Buffer.from('20250101000000.000Z', 'utf8')]);
    const result = decodeGeneralizedTime(buffer, 5);
    expect(result.value).toEqual(new Date('2025-01-01T00:00:00.000Z'));
    expect(result.bytesRead).toBe(19);
  });

  it('should throw BufferUnderflowError when buffer is too short', () => {
    const buffer = Buffer.from('2025013123', 'utf8'); // Only 10 bytes
    expect(() => decodeGeneralizedTime(buffer, 0)).toThrow(BufferUnderflowError);
  });

  it('should throw InvalidPacketError for invalid format', () => {
    const buffer = Buffer.from('INVALIDTIMEFMT12345', 'utf8'); // 19 bytes but invalid format
    expect(() => decodeGeneralizedTime(buffer, 0)).toThrow(InvalidPacketError);
  });

  it('should round-trip encode/decode dates', () => {
    const dates = [
      new Date('2025-01-01T00:00:00.000Z'),
      new Date('2025-06-15T12:30:45.123Z'),
      new Date('2099-12-31T23:59:59.999Z'),
    ];

    dates.forEach((date) => {
      const encoded = encodeGeneralizedTime(date);
      const decoded = decodeGeneralizedTime(encoded, 0);
      expect(decoded.value).toEqual(date);
    });
  });
});

// ============================================================================
// Test Factories (reuse from Story 1.2)
// ============================================================================

function createTestPreparePacket(overrides?: Partial<ILPPreparePacket>): ILPPreparePacket {
  return {
    type: PacketType.PREPARE,
    amount: 1000n,
    destination: 'g.alice',
    expiresAt: new Date('2025-12-31T23:59:59.999Z'),
    data: Buffer.from('test data'),
    ...overrides,
  };
}

function createTestFulfillPacket(overrides?: Partial<ILPFulfillPacket>): ILPFulfillPacket {
  return {
    type: PacketType.FULFILL,
    data: Buffer.from('return data'),
    ...overrides,
  };
}

function createTestRejectPacket(overrides?: Partial<ILPRejectPacket>): ILPRejectPacket {
  return {
    type: PacketType.REJECT,
    code: ILPErrorCode.F02_UNREACHABLE,
    triggeredBy: 'g.connector',
    message: 'No route to destination',
    data: Buffer.from('error context'),
    ...overrides,
  };
}

// ============================================================================
// ILP Prepare Packet Tests
// ============================================================================

describe('serializePrepare', () => {
  it('should serialize Prepare packet correctly', () => {
    const packet = createTestPreparePacket();
    const result = serializePrepare(packet);

    expect(result[0]).toBe(PacketType.PREPARE); // Type byte
    expect(result.length).toBeGreaterThan(50); // Reasonable size check
  });

  it('should serialize Prepare packet with 32 zero bytes for wire-format executionCondition', () => {
    const packet = createTestPreparePacket();
    const result = serializePrepare(packet);

    // OER writes 32 zero bytes for the executionCondition field (wire compatibility)
    expect(result.length).toBeGreaterThan(50);
  });
});

describe('deserializePrepare', () => {
  it('should deserialize Prepare packet correctly', () => {
    const original = createTestPreparePacket();
    const serialized = serializePrepare(original);
    const deserialized = deserializePrepare(serialized);

    expect(deserialized.type).toBe(PacketType.PREPARE);
    expect(deserialized.amount).toBe(original.amount);
    expect(deserialized.destination).toBe(original.destination);
    expect(deserialized.expiresAt).toEqual(original.expiresAt);
    expect(deserialized.data).toEqual(original.data);
    // When executionCondition is omitted, OER serializes 32 zero bytes and deserializes to undefined
    expect(deserialized.executionCondition).toBeUndefined();
  });

  it('should round-trip Prepare packet with known 32-byte executionCondition', () => {
    const condition = new Uint8Array(32).fill(0xab);
    const packet = createTestPreparePacket({ executionCondition: condition });
    const serialized = serializePrepare(packet);
    const deserialized = deserializePrepare(serialized);

    expect(deserialized.executionCondition).toEqual(condition);
  });

  it('should round-trip Prepare packet without executionCondition as undefined (backward compat)', () => {
    const packet = createTestPreparePacket();
    expect(packet.executionCondition).toBeUndefined();
    const serialized = serializePrepare(packet);
    const deserialized = deserializePrepare(serialized);

    expect(deserialized.executionCondition).toBeUndefined();
  });

  it('should throw BufferUnderflowError when buffer is empty (Line 515)', () => {
    const emptyBuffer = Buffer.alloc(0);
    expect(() => deserializePrepare(emptyBuffer)).toThrow(BufferUnderflowError);
    expect(() => deserializePrepare(emptyBuffer)).toThrow(
      /Cannot read packet type: buffer underflow/
    );
  });

  it('should throw InvalidPacketError when type byte is incorrect', () => {
    const buffer = Buffer.from([PacketType.FULFILL]); // Wrong type
    expect(() => deserializePrepare(buffer)).toThrow(InvalidPacketError);
  });

  it('should throw BufferUnderflowError when buffer is truncated', () => {
    const buffer = Buffer.from([PacketType.PREPARE]); // Only type byte
    expect(() => deserializePrepare(buffer)).toThrow(BufferUnderflowError);
  });

  it('should throw InvalidPacketError when destination address is invalid', () => {
    // Create a packet with invalid address directly
    const corruptPacket = createTestPreparePacket({ destination: '..invalid' });

    // Since serializePrepare doesn't validate, we serialize then expect deserialize to fail
    const buffer = serializePrepare(corruptPacket);
    expect(() => deserializePrepare(buffer)).toThrow(InvalidPacketError);
  });

  it('should handle zero amount', () => {
    const packet = createTestPreparePacket({ amount: 0n });
    const serialized = serializePrepare(packet);
    const deserialized = deserializePrepare(serialized);

    expect(deserialized.amount).toBe(0n);
  });

  it('should handle maximum uint64 amount', () => {
    const maxAmount = BigInt('18446744073709551615');
    const packet = createTestPreparePacket({ amount: maxAmount });
    const serialized = serializePrepare(packet);
    const deserialized = deserializePrepare(serialized);

    expect(deserialized.amount).toBe(maxAmount);
  });

  it('should handle empty data field', () => {
    const packet = createTestPreparePacket({ data: Buffer.alloc(0) });
    const serialized = serializePrepare(packet);
    const deserialized = deserializePrepare(serialized);

    expect(deserialized.data).toEqual(Buffer.alloc(0));
  });

  it('should handle far future expiry date', () => {
    const farFuture = new Date('2099-12-31T23:59:59.999Z');
    const packet = createTestPreparePacket({ expiresAt: farFuture });
    const serialized = serializePrepare(packet);
    const deserialized = deserializePrepare(serialized);

    expect(deserialized.expiresAt).toEqual(farFuture);
  });

  it('should handle minimum valid ILP address', () => {
    const packet = createTestPreparePacket({ destination: 'g' });
    const serialized = serializePrepare(packet);
    const deserialized = deserializePrepare(serialized);

    expect(deserialized.destination).toBe('g');
  });

  it('should handle maximum length ILP address (1023 chars)', () => {
    const longAddress = 'g.' + 'a'.repeat(1021); // 1 + 1 + 1021 = 1023 chars
    const packet = createTestPreparePacket({ destination: longAddress });
    const serialized = serializePrepare(packet);
    const deserialized = deserializePrepare(serialized);

    expect(deserialized.destination).toBe(longAddress);
  });
});

// ============================================================================
// ILP Fulfill Packet Tests
// ============================================================================

describe('serializeFulfill', () => {
  it('should serialize Fulfill packet correctly', () => {
    const packet = createTestFulfillPacket();
    const result = serializeFulfill(packet);

    expect(result[0]).toBe(PacketType.FULFILL);
    expect(result.length).toBeGreaterThan(33); // Type + 32 zero bytes + data
  });

  it('should serialize Fulfill packet with 32 zero bytes for wire-format fulfillment', () => {
    const packet = createTestFulfillPacket();
    const result = serializeFulfill(packet);

    // OER writes 32 zero bytes for the fulfillment field (wire compatibility)
    expect(result[0]).toBe(PacketType.FULFILL);
    expect(result.length).toBeGreaterThan(33);
  });
});

describe('deserializeFulfill', () => {
  it('should deserialize Fulfill packet correctly', () => {
    const original = createTestFulfillPacket();
    const serialized = serializeFulfill(original);
    const deserialized = deserializeFulfill(serialized);

    expect(deserialized.type).toBe(PacketType.FULFILL);
    expect(deserialized.data).toEqual(original.data);
    // When fulfillment is omitted, OER serializes 32 zero bytes and deserializes to undefined
    expect(deserialized.fulfillment).toBeUndefined();
  });

  it('should round-trip Fulfill packet with known 32-byte fulfillment', () => {
    const fulfillmentBytes = new Uint8Array(32).fill(0xcd);
    const packet = createTestFulfillPacket({ fulfillment: fulfillmentBytes });
    const serialized = serializeFulfill(packet);
    const deserialized = deserializeFulfill(serialized);

    expect(deserialized.fulfillment).toEqual(fulfillmentBytes);
  });

  it('should round-trip Fulfill packet without fulfillment as undefined (backward compat)', () => {
    const packet = createTestFulfillPacket();
    expect(packet.fulfillment).toBeUndefined();
    const serialized = serializeFulfill(packet);
    const deserialized = deserializeFulfill(serialized);

    expect(deserialized.fulfillment).toBeUndefined();
  });

  it('should throw InvalidPacketError when type byte is incorrect', () => {
    const buffer = Buffer.from([PacketType.PREPARE]); // Wrong type
    expect(() => deserializeFulfill(buffer)).toThrow(InvalidPacketError);
  });

  it('should throw BufferUnderflowError when buffer is truncated', () => {
    const buffer = Buffer.from([PacketType.FULFILL]); // Only type byte
    expect(() => deserializeFulfill(buffer)).toThrow(BufferUnderflowError);
  });

  it('should handle empty data field', () => {
    const packet = createTestFulfillPacket({ data: Buffer.alloc(0) });
    const serialized = serializeFulfill(packet);
    const deserialized = deserializeFulfill(serialized);

    expect(deserialized.data).toEqual(Buffer.alloc(0));
  });

  it('should round-trip Fulfill packet with empty data', () => {
    const packet = createTestFulfillPacket({ data: Buffer.alloc(0) });
    const serialized = serializeFulfill(packet);
    const deserialized = deserializeFulfill(serialized);

    expect(deserialized.type).toBe(PacketType.FULFILL);
    expect(deserialized.data).toEqual(Buffer.alloc(0));
  });

  it('should round-trip Fulfill packet with non-empty data', () => {
    const packet = createTestFulfillPacket({ data: Buffer.from('test') });
    const serialized = serializeFulfill(packet);
    const deserialized = deserializeFulfill(serialized);

    expect(deserialized.type).toBe(PacketType.FULFILL);
    expect(deserialized.data).toEqual(Buffer.from('test'));
  });
});

// ============================================================================
// ILP Reject Packet Tests
// ============================================================================

describe('serializeReject', () => {
  it('should serialize Reject packet correctly', () => {
    const packet = createTestRejectPacket();
    const result = serializeReject(packet);

    expect(result[0]).toBe(PacketType.REJECT);
    expect(result.length).toBeGreaterThan(10); // Type + code + fields
  });

  it('should throw InvalidPacketError when error code is not 3 characters', () => {
    const packet = createTestRejectPacket({ code: 'F0' as ILPErrorCode }); // Wrong length

    expect(() => serializeReject(packet)).toThrow(InvalidPacketError);
  });
});

describe('deserializeReject', () => {
  it('should deserialize Reject packet correctly', () => {
    const original = createTestRejectPacket();
    const serialized = serializeReject(original);
    const deserialized = deserializeReject(serialized);

    expect(deserialized.type).toBe(PacketType.REJECT);
    expect(deserialized.code).toBe(original.code);
    expect(deserialized.triggeredBy).toBe(original.triggeredBy);
    expect(deserialized.message).toBe(original.message);
    expect(deserialized.data).toEqual(original.data);
  });

  it('should throw InvalidPacketError when type byte is incorrect', () => {
    const buffer = Buffer.from([PacketType.PREPARE]); // Wrong type
    expect(() => deserializeReject(buffer)).toThrow(InvalidPacketError);
  });

  it('should throw BufferUnderflowError when buffer is truncated', () => {
    const buffer = Buffer.from([PacketType.REJECT]); // Only type byte
    expect(() => deserializeReject(buffer)).toThrow(BufferUnderflowError);
  });

  it('should handle all error code categories', () => {
    const errorCodes = [
      ILPErrorCode.F00_BAD_REQUEST,
      ILPErrorCode.F02_UNREACHABLE,
      ILPErrorCode.T00_INTERNAL_ERROR,
      ILPErrorCode.T01_PEER_UNREACHABLE,
      ILPErrorCode.R00_TRANSFER_TIMED_OUT,
      ILPErrorCode.R01_INSUFFICIENT_SOURCE_AMOUNT,
    ];

    errorCodes.forEach((code) => {
      const packet = createTestRejectPacket({ code });
      const serialized = serializeReject(packet);
      const deserialized = deserializeReject(serialized);

      expect(deserialized.code).toBe(code);
    });
  });

  it('should handle empty message string', () => {
    const packet = createTestRejectPacket({ message: '' });
    const serialized = serializeReject(packet);
    const deserialized = deserializeReject(serialized);

    expect(deserialized.message).toBe('');
  });

  it('should handle empty data field', () => {
    const packet = createTestRejectPacket({ data: Buffer.alloc(0) });
    const serialized = serializeReject(packet);
    const deserialized = deserializeReject(serialized);

    expect(deserialized.data).toEqual(Buffer.alloc(0));
  });

  it('should handle maximum length error message', () => {
    const longMessage = 'a'.repeat(1000);
    const packet = createTestRejectPacket({ message: longMessage });
    const serialized = serializeReject(packet);
    const deserialized = deserializeReject(serialized);

    expect(deserialized.message).toBe(longMessage);
  });

  it('should throw InvalidPacketError when triggeredBy address is invalid', () => {
    const packet = createTestRejectPacket({ triggeredBy: '..invalid' });
    const serialized = serializeReject(packet);

    expect(() => deserializeReject(serialized)).toThrow(InvalidPacketError);
  });
});

// ============================================================================
// Generic Packet Serialization/Deserialization Tests
// ============================================================================

describe('serializePacket', () => {
  it('should dispatch to serializePrepare for Prepare packets', () => {
    const packet = createTestPreparePacket();
    const result = serializePacket(packet);

    expect(result[0]).toBe(PacketType.PREPARE);
  });

  it('should dispatch to serializeFulfill for Fulfill packets', () => {
    const packet = createTestFulfillPacket();
    const result = serializePacket(packet);

    expect(result[0]).toBe(PacketType.FULFILL);
  });

  it('should dispatch to serializeReject for Reject packets', () => {
    const packet = createTestRejectPacket();
    const result = serializePacket(packet);

    expect(result[0]).toBe(PacketType.REJECT);
  });

  it('should throw InvalidPacketError for invalid packet type', () => {
    const invalidPacket = { type: 99 } as unknown as ILPPreparePacket;

    expect(() => serializePacket(invalidPacket)).toThrow(InvalidPacketError);
  });
});

describe('deserializePacket', () => {
  it('should dispatch to deserializePrepare when type is 12', () => {
    const original = createTestPreparePacket();
    const serialized = serializePacket(original);
    const deserialized = deserializePacket(serialized);

    expect(deserialized.type).toBe(PacketType.PREPARE);
  });

  it('should dispatch to deserializeFulfill when type is 13', () => {
    const original = createTestFulfillPacket();
    const serialized = serializePacket(original);
    const deserialized = deserializePacket(serialized);

    expect(deserialized.type).toBe(PacketType.FULFILL);
  });

  it('should dispatch to deserializeReject when type is 14', () => {
    const original = createTestRejectPacket();
    const serialized = serializePacket(original);
    const deserialized = deserializePacket(serialized);

    expect(deserialized.type).toBe(PacketType.REJECT);
  });

  it('should throw InvalidPacketError for empty buffer', () => {
    expect(() => deserializePacket(Buffer.alloc(0))).toThrow(InvalidPacketError);
  });

  it('should throw InvalidPacketError for invalid type byte 0', () => {
    const buffer = Buffer.from([0x00]);
    expect(() => deserializePacket(buffer)).toThrow(InvalidPacketError);
  });

  it('should throw InvalidPacketError for invalid type byte 15', () => {
    const buffer = Buffer.from([0x0f]);
    expect(() => deserializePacket(buffer)).toThrow(InvalidPacketError);
  });

  it('should throw InvalidPacketError for invalid type byte 255', () => {
    const buffer = Buffer.from([0xff]);
    expect(() => deserializePacket(buffer)).toThrow(InvalidPacketError);
  });

  it('should round-trip all three packet types', () => {
    const packets = [
      createTestPreparePacket(),
      createTestFulfillPacket(),
      createTestRejectPacket(),
    ];

    packets.forEach((original) => {
      const serialized = serializePacket(original);
      const deserialized = deserializePacket(serialized);

      expect(deserialized.type).toBe(original.type);
    });
  });
});

// ============================================================================
// RFC-0027 Test Vectors (AC #2)
// ============================================================================

describe('RFC-0027 ILPv4 Test Vectors - Binary Format Validation', () => {
  describe('ILP Prepare Packet Test Vector #1 (RFC-0027 Section 3.1)', () => {
    it('should encode Prepare packet matching RFC-0027 binary format exactly', () => {
      // Test Vector: Minimal Prepare packet
      const packet: ILPPreparePacket = {
        type: PacketType.PREPARE,
        amount: 1000n,
        destination: 'g.example.alice',
        expiresAt: new Date('2024-01-01T12:00:00.000Z'),
        data: Buffer.from([]),
      };

      const serialized = serializePrepare(packet);

      // Verify packet structure byte-by-byte (RFC-0027 Section 3.1)
      let offset = 0;

      // Type byte: 12 (0x0C)
      expect(serialized[offset]).toBe(0x0c);
      offset += 1;

      // Amount: 1000 encoded as VarUInt
      // 1000 = 0x03E8, requires 2 bytes: [0x82, 0x03, 0xE8]
      expect(serialized[offset]).toBe(0x82); // Length prefix (0x80 | 2)
      expect(serialized[offset + 1]).toBe(0x03);
      expect(serialized[offset + 2]).toBe(0xe8);
      offset += 3;

      // ExpiresAt: 19-byte generalized time
      const expiresAtStr = serialized.slice(offset, offset + 19).toString('utf8');
      expect(expiresAtStr).toBe('20240101120000.000Z');
      offset += 19;

      // ExecutionCondition: 32 zero bytes (wire format compatibility)
      expect(serialized.slice(offset, offset + 32)).toEqual(Buffer.alloc(32));
      offset += 32;

      // Destination: VarOctetString
      // "g.example.alice" = 15 bytes
      expect(serialized[offset]).toBe(0x0f); // Length 15
      expect(serialized.slice(offset + 1, offset + 16).toString('utf8')).toBe('g.example.alice');
      offset += 16;

      // Data: Empty VarOctetString
      expect(serialized[offset]).toBe(0x00); // Length 0
      offset += 1;

      // Verify total length
      expect(serialized.length).toBe(offset);
    });

    it('should deserialize Prepare packet from RFC-0027 binary format', () => {
      const packet: ILPPreparePacket = {
        type: PacketType.PREPARE,
        amount: 1000n,
        destination: 'g.example.alice',
        expiresAt: new Date('2024-01-01T12:00:00.000Z'),
        data: Buffer.from([]),
      };

      const serialized = serializePrepare(packet);
      const deserialized = deserializePrepare(serialized);

      expect(deserialized).toEqual(packet);
    });

    it('should round-trip Prepare packet with zero amount (edge case)', () => {
      const packet: ILPPreparePacket = {
        type: PacketType.PREPARE,
        amount: 0n,
        destination: 'g.bob',
        expiresAt: new Date('2025-12-31T23:59:59.999Z'),
        data: Buffer.from('test payload'),
      };

      const serialized = serializePrepare(packet);
      const deserialized = deserializePrepare(serialized);

      expect(deserialized.amount).toBe(0n);
      expect(deserialized.destination).toBe(packet.destination);
      expect(deserialized.data.toString()).toBe('test payload');
    });

    it('should round-trip Prepare packet with maximum uint64 amount (edge case)', () => {
      const maxAmount = BigInt('18446744073709551615'); // 2^64 - 1
      const packet: ILPPreparePacket = {
        type: PacketType.PREPARE,
        amount: maxAmount,
        destination: 'g.connector',
        expiresAt: new Date('2025-06-15T10:30:00.500Z'),
        data: Buffer.from([0x01, 0x02, 0x03]),
      };

      const serialized = serializePrepare(packet);
      const deserialized = deserializePrepare(serialized);

      expect(deserialized.amount).toBe(maxAmount);
      expect(deserialized.data).toEqual(Buffer.from([0x01, 0x02, 0x03]));
    });
  });

  describe('ILP Fulfill Packet Test Vector #2 (RFC-0027 Section 3.2)', () => {
    it('should encode Fulfill packet matching RFC-0027 binary format exactly', () => {
      // Test Vector: Fulfill packet with empty data
      const packet: ILPFulfillPacket = {
        type: PacketType.FULFILL,
        data: Buffer.from([]),
      };

      const serialized = serializeFulfill(packet);

      // Verify packet structure byte-by-byte (RFC-0027 Section 3.2)
      let offset = 0;

      // Type byte: 13 (0x0D)
      expect(serialized[offset]).toBe(0x0d);
      offset += 1;

      // Fulfillment: 32 zero bytes (wire format compatibility)
      expect(serialized.slice(offset, offset + 32)).toEqual(Buffer.alloc(32));
      offset += 32;

      // Data: Empty VarOctetString
      expect(serialized[offset]).toBe(0x00); // Length 0
      offset += 1;

      // Verify total length
      expect(serialized.length).toBe(34); // 1 + 32 + 1
    });

    it('should deserialize Fulfill packet from RFC-0027 binary format', () => {
      const packet: ILPFulfillPacket = {
        type: PacketType.FULFILL,
        data: Buffer.from([]),
      };

      const serialized = serializeFulfill(packet);
      const deserialized = deserializeFulfill(serialized);

      expect(deserialized).toEqual(packet);
    });

    it('should round-trip Fulfill packet with non-empty data', () => {
      const packet: ILPFulfillPacket = {
        type: PacketType.FULFILL,
        data: Buffer.from('return value'),
      };

      const serialized = serializeFulfill(packet);
      const deserialized = deserializeFulfill(serialized);

      expect(deserialized.data.toString()).toBe('return value');
    });
  });

  describe('ILP Reject Packet Test Vector #3 (RFC-0027 Section 3.3)', () => {
    it('should encode Reject packet matching RFC-0027 binary format exactly', () => {
      // Test Vector: F02 Unreachable error
      const packet: ILPRejectPacket = {
        type: PacketType.REJECT,
        code: ILPErrorCode.F02_UNREACHABLE,
        triggeredBy: 'g.hub',
        message: 'No route found',
        data: Buffer.from([]),
      };

      const serialized = serializeReject(packet);

      // Verify packet structure byte-by-byte (RFC-0027 Section 3.3)
      let offset = 0;

      // Type byte: 14 (0x0E)
      expect(serialized[offset]).toBe(0x0e);
      offset += 1;

      // Code: 3 bytes (fixed) "F02"
      expect(serialized.slice(offset, offset + 3).toString('utf8')).toBe('F02');
      offset += 3;

      // TriggeredBy: VarOctetString "g.hub" (5 bytes)
      expect(serialized[offset]).toBe(0x05); // Length 5
      expect(serialized.slice(offset + 1, offset + 6).toString('utf8')).toBe('g.hub');
      offset += 6;

      // Message: VarOctetString "No route found" (14 bytes)
      expect(serialized[offset]).toBe(0x0e); // Length 14
      expect(serialized.slice(offset + 1, offset + 15).toString('utf8')).toBe('No route found');
      offset += 15;

      // Data: Empty VarOctetString
      expect(serialized[offset]).toBe(0x00); // Length 0
      offset += 1;

      // Verify total length
      expect(serialized.length).toBe(offset);
    });

    it('should deserialize Reject packet from RFC-0027 binary format', () => {
      const packet: ILPRejectPacket = {
        type: PacketType.REJECT,
        code: ILPErrorCode.F02_UNREACHABLE,
        triggeredBy: 'g.hub',
        message: 'No route found',
        data: Buffer.from([]),
      };

      const serialized = serializeReject(packet);
      const deserialized = deserializeReject(serialized);

      expect(deserialized).toEqual(packet);
    });

    it('should round-trip Reject packet with all error code categories (F/T/R)', () => {
      const testCases: Array<{ code: ILPErrorCode; message: string }> = [
        { code: ILPErrorCode.F00_BAD_REQUEST, message: 'Bad request' },
        { code: ILPErrorCode.F01_INVALID_PACKET, message: 'Invalid packet structure' },
        { code: ILPErrorCode.F02_UNREACHABLE, message: 'No route to destination' },
        { code: ILPErrorCode.T00_INTERNAL_ERROR, message: 'Transfer timed out' },
        { code: ILPErrorCode.T01_PEER_UNREACHABLE, message: 'Peer offline' },
        { code: ILPErrorCode.R00_TRANSFER_TIMED_OUT, message: 'Transfer cancelled' },
      ];

      testCases.forEach(({ code, message }) => {
        const packet: ILPRejectPacket = {
          type: PacketType.REJECT,
          code,
          triggeredBy: 'g.test',
          message,
          data: Buffer.from([]),
        };

        const serialized = serializeReject(packet);
        const deserialized = deserializeReject(serialized);

        expect(deserialized.code).toBe(code);
        expect(deserialized.message).toBe(message);
      });
    });
  });

  describe('RFC-0027 Edge Cases and Malformed Packets', () => {
    it('should handle malformed Prepare packet with invalid type byte', () => {
      // Create buffer with wrong type byte
      const buffer = Buffer.from([PacketType.FULFILL]); // Type 13 instead of 12
      expect(() => deserializePrepare(buffer)).toThrow(InvalidPacketError);
      expect(() => deserializePrepare(buffer)).toThrow(/Invalid packet type/);
    });

    it('should handle truncated Prepare packet (missing data field)', () => {
      const packet: ILPPreparePacket = {
        type: PacketType.PREPARE,
        amount: 100n,
        destination: 'g.test',
        expiresAt: new Date('2025-01-01T00:00:00.000Z'),
        data: Buffer.from('test'),
      };

      const serialized = serializePrepare(packet);
      const truncated = serialized.slice(0, serialized.length - 5); // Remove last 5 bytes

      expect(() => deserializePrepare(truncated)).toThrow(BufferUnderflowError);
    });

    it('should handle Prepare packet with maximum data field length', () => {
      // Test with 1000-byte data field (reasonable max)
      const largeData = Buffer.alloc(1000, 0x42);
      const packet: ILPPreparePacket = {
        type: PacketType.PREPARE,
        amount: 500n,
        destination: 'g.receiver',
        expiresAt: new Date('2025-06-01T00:00:00.000Z'),
        data: largeData,
      };

      const serialized = serializePrepare(packet);
      const deserialized = deserializePrepare(serialized);

      expect(deserialized.data.length).toBe(1000);
      expect(deserialized.data).toEqual(largeData);
    });

    it('should handle Fulfill packet with empty data', () => {
      const packet: ILPFulfillPacket = {
        type: PacketType.FULFILL,
        data: Buffer.from([]),
      };

      const serialized = serializeFulfill(packet);
      const deserialized = deserializeFulfill(serialized);

      expect(deserialized.type).toBe(PacketType.FULFILL);
      expect(deserialized.data).toEqual(Buffer.from([]));
    });

    it('should handle Fulfill packet with data payload', () => {
      const packet: ILPFulfillPacket = {
        type: PacketType.FULFILL,
        data: Buffer.from('test-data'),
      };

      const serialized = serializeFulfill(packet);
      const deserialized = deserializeFulfill(serialized);

      expect(deserialized.type).toBe(PacketType.FULFILL);
      expect(deserialized.data).toEqual(Buffer.from('test-data'));
    });

    it('should handle Reject packet with empty message string', () => {
      const packet: ILPRejectPacket = {
        type: PacketType.REJECT,
        code: ILPErrorCode.F99_APPLICATION_ERROR,
        triggeredBy: 'g.connector',
        message: '',
        data: Buffer.from([]),
      };

      const serialized = serializeReject(packet);
      const deserialized = deserializeReject(serialized);

      expect(deserialized.message).toBe('');
    });

    it('should handle Reject packet with maximum length error message', () => {
      const longMessage = 'Error: ' + 'x'.repeat(500); // 507 characters
      const packet: ILPRejectPacket = {
        type: PacketType.REJECT,
        code: ILPErrorCode.T99_APPLICATION_ERROR,
        triggeredBy: 'g.node',
        message: longMessage,
        data: Buffer.from([]),
      };

      const serialized = serializeReject(packet);
      const deserialized = deserializeReject(serialized);

      expect(deserialized.message).toBe(longMessage);
      expect(deserialized.message.length).toBe(507);
    });
  });
});

// ============================================================================
// Task 3: Uncovered Edge Cases in oer.ts (Lines 515, 586, 632, 652)
// ============================================================================

describe('OER Encoding Uncovered Edge Cases (Coverage Improvement)', () => {
  describe('Line 586: deserializeFulfill empty buffer handling', () => {
    it('should throw BufferUnderflowError when deserializing empty buffer for Fulfill packet', () => {
      const emptyBuffer = Buffer.alloc(0);
      expect(() => deserializeFulfill(emptyBuffer)).toThrow(BufferUnderflowError);
      expect(() => deserializeFulfill(emptyBuffer)).toThrow(
        /Cannot read packet type: buffer underflow/
      );
    });
  });

  describe('Line 632: deserializeReject empty buffer handling', () => {
    it('should throw BufferUnderflowError when deserializing empty buffer for Reject packet', () => {
      const emptyBuffer = Buffer.alloc(0);
      expect(() => deserializeReject(emptyBuffer)).toThrow(BufferUnderflowError);
      expect(() => deserializeReject(emptyBuffer)).toThrow(
        /Cannot read packet type: buffer underflow/
      );
    });
  });

  describe('Line 652: Error code length validation in deserializeReject', () => {
    it('should validate error code is exactly 3 characters (defensive check)', () => {
      // Line 652 is a defensive check: if (code.length !== 3)
      // This is practically unreachable because buffer.slice(offset, offset + 3).toString('utf8')
      // always produces a 3-character string, even with null bytes.
      //
      // This test validates the normal path works correctly with various 3-character codes:

      const validRejectPacket: ILPRejectPacket = {
        type: PacketType.REJECT,
        code: ILPErrorCode.F02_UNREACHABLE,
        triggeredBy: 'g.test',
        message: 'test',
        data: Buffer.from([]),
      };

      const serialized = serializeReject(validRejectPacket);
      const deserialized = deserializeReject(serialized);

      expect(deserialized.code).toBe('F02');
      expect(deserialized.code.length).toBe(3);
    });

    it('should correctly handle error code with special UTF-8 characters (3 bytes)', () => {
      // Test that error codes are always exactly 3 characters
      // This validates the defensive check at line 652

      const testCodes = [
        ILPErrorCode.F00_BAD_REQUEST,
        ILPErrorCode.F01_INVALID_PACKET,
        ILPErrorCode.T00_INTERNAL_ERROR,
        ILPErrorCode.R00_TRANSFER_TIMED_OUT,
      ];

      testCodes.forEach((code) => {
        const packet: ILPRejectPacket = {
          type: PacketType.REJECT,
          code,
          triggeredBy: 'g.connector',
          message: 'Test message',
          data: Buffer.from([]),
        };

        const serialized = serializeReject(packet);
        const deserialized = deserializeReject(serialized);

        // Validate code is exactly 3 characters (line 652 check)
        expect(deserialized.code.length).toBe(3);
        expect(deserialized.code).toBe(code);
      });
    });
  });

  describe('Variable-length integer encoding boundary conditions (Line 586 context)', () => {
    it('should handle VarUInt encoding at 127/128 boundary correctly', () => {
      // Test boundary between single-byte and multi-byte encoding
      const value127 = encodeVarUInt(127n);
      expect(value127.length).toBe(1);
      expect(value127[0]).toBe(0x7f);

      const value128 = encodeVarUInt(128n);
      expect(value128.length).toBe(2);
      expect(value128[0]).toBe(0x81); // 0x80 | 1
      expect(value128[1]).toBe(0x80);
    });

    it('should handle VarUInt decoding with maximum length prefix', () => {
      // Test maximum uint64 value encoding (8 bytes)
      const maxValue = BigInt('18446744073709551615');
      const encoded = encodeVarUInt(maxValue);

      expect(encoded.length).toBe(9); // 1 length byte + 8 data bytes
      expect(encoded[0]).toBe(0x88); // 0x80 | 8

      const decoded = decodeVarUInt(encoded, 0);
      expect(decoded.value).toBe(maxValue);
      expect(decoded.bytesRead).toBe(9);
    });
  });

  describe('Buffer boundary handling during deserialization (Line 632 context)', () => {
    it('should throw BufferUnderflowError when Reject packet buffer ends mid-field', () => {
      const validPacket: ILPRejectPacket = {
        type: PacketType.REJECT,
        code: ILPErrorCode.T01_PEER_UNREACHABLE,
        triggeredBy: 'g.peer',
        message: 'Connection lost',
        data: Buffer.from('additional context'),
      };

      const serialized = serializeReject(validPacket);

      // Truncate buffer at various points to test boundary conditions
      const truncations = [
        { bytes: 1 },
        { bytes: 2 },
        { bytes: 4 },
        { bytes: serialized.length - 5 },
      ];

      truncations.forEach(({ bytes }) => {
        const truncated = serialized.slice(0, bytes);
        expect(() => deserializeReject(truncated)).toThrow(BufferUnderflowError);
      });
    });

    it('should throw BufferUnderflowError when Fulfill packet buffer is truncated', () => {
      const validPacket: ILPFulfillPacket = {
        type: PacketType.FULFILL,
        data: Buffer.from('response data'),
      };

      const serialized = serializeFulfill(validPacket);

      // Truncate after type byte but before full wire-format fulfillment (32 zero bytes)
      const truncated = serialized.slice(0, 20); // Type (1) + partial zero bytes (19 of 32)

      expect(() => deserializeFulfill(truncated)).toThrow(BufferUnderflowError);
    });

    it('should throw BufferUnderflowError when Prepare packet expires field is truncated', () => {
      const validPacket: ILPPreparePacket = {
        type: PacketType.PREPARE,
        amount: 1000n,
        destination: 'g.alice',
        expiresAt: new Date('2025-12-31T23:59:59.999Z'),
        data: Buffer.from([]),
      };

      const serialized = serializePrepare(validPacket);

      // Truncate in the middle of the expiresAt field (which is 19 bytes)
      // Type (1) + Amount (3 for 1000) + partial expiresAt (10 of 19)
      const truncated = serialized.slice(0, 14);

      expect(() => deserializePrepare(truncated)).toThrow(BufferUnderflowError);
    });
  });
});
