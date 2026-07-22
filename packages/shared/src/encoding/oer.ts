/**
 * OER (Octet Encoding Rules) Implementation for ILP Packets
 *
 * This module implements OER encoding/decoding for ILPv4 packets per RFC-0030.
 * Provides binary serialization and deserialization of ILP packets for network transmission.
 *
 * @see {@link https://interledger.org/rfcs/0030-notes-on-oer-encoding/|RFC-0030: Notes on OER Encoding}
 * @see {@link https://interledger.org/rfcs/0027-interledger-protocol-4/|RFC-0027: ILPv4 Packet Format}
 */

import {
  ILPPreparePacket,
  ILPFulfillPacket,
  ILPRejectPacket,
  ILPErrorCode,
  PacketType,
  isPreparePacket,
  isFulfillPacket,
  isRejectPacket,
  isValidILPAddress,
} from '../types/ilp';

/**
 * Error thrown when packet encoding/decoding fails
 */
export class InvalidPacketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPacketError';
  }
}

/**
 * Error thrown when buffer has insufficient data
 */
export class BufferUnderflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BufferUnderflowError';
  }
}

/**
 * Encode VarUInt (Variable-Length Unsigned Integer)
 *
 * Encodes unsigned 64-bit integers using minimal bytes per RFC-0030.
 *
 * Encoding rules:
 * - Values 0-127: Single byte (value itself)
 * - Values 128+: Length prefix (1 byte) + value bytes (big-endian)
 *
 * @param value - The unsigned integer to encode (0 to 2^64-1)
 * @returns Buffer containing encoded value
 *
 * @example
 * ```typescript
 * encodeVarUInt(0n)    // Buffer<0x00>
 * encodeVarUInt(127n)  // Buffer<0x7F>
 * encodeVarUInt(128n)  // Buffer<0x81, 0x80>
 * encodeVarUInt(255n)  // Buffer<0x81, 0xFF>
 * ```
 *
 * @see {@link https://interledger.org/rfcs/0030-notes-on-oer-encoding/|RFC-0030: VarUInt Encoding}
 */
export function encodeVarUInt(value: bigint): Buffer {
  // Reject out-of-contract input: VarUInt is unsigned (0 to 2^64-1). A negative
  // value would otherwise fall through the length-prefixed path with an empty
  // `while` loop and silently emit a corrupt 0-length encoding (Buffer<0x80>).
  if (value < 0n) {
    throw new InvalidPacketError(`VarUInt cannot encode negative value: ${value}`);
  }

  // Values 0-127 encoded as single byte (non-negative guaranteed by guard above)
  if (value <= 127n) {
    const buffer = Buffer.alloc(1);
    buffer.writeUInt8(Number(value), 0);
    return buffer;
  }

  // Values 128+ use length-prefixed encoding
  // Convert bigint to byte array (big-endian)
  const bytes: number[] = [];
  let remaining = value;

  while (remaining > 0n) {
    bytes.unshift(Number(remaining & 0xffn));
    remaining = remaining >> 8n;
  }

  // Create buffer: length prefix (with high bit set: 0x80 | length) + data bytes
  const buffer = Buffer.alloc(1 + bytes.length);
  buffer.writeUInt8(0x80 | bytes.length, 0);
  Buffer.from(bytes).copy(buffer, 1);

  return buffer;
}

/**
 * Decode VarUInt (Variable-Length Unsigned Integer)
 *
 * Decodes unsigned 64-bit integers from OER format per RFC-0030.
 *
 * @param buffer - Buffer containing encoded VarUInt
 * @param offset - Starting offset in buffer (default: 0)
 * @returns Object with decoded value and bytes consumed
 * @throws {BufferUnderflowError} If buffer has insufficient data
 *
 * @example
 * ```typescript
 * decodeVarUInt(Buffer.from([0x00]), 0)        // { value: 0n, bytesRead: 1 }
 * decodeVarUInt(Buffer.from([0x7F]), 0)        // { value: 127n, bytesRead: 1 }
 * decodeVarUInt(Buffer.from([0x81, 0x80]), 0)  // { value: 128n, bytesRead: 2 }
 * ```
 *
 * @see {@link https://interledger.org/rfcs/0030-notes-on-oer-encoding/|RFC-0030: VarUInt Encoding}
 */
export function decodeVarUInt(buffer: Buffer, offset = 0): { value: bigint; bytesRead: number } {
  if (offset >= buffer.length) {
    throw new BufferUnderflowError('Cannot read VarUInt: buffer underflow');
  }

  const firstByte = buffer.readUInt8(offset);

  // Single byte encoding (0-127)
  if (firstByte <= 127) {
    return { value: BigInt(firstByte), bytesRead: 1 };
  }

  // Multi-byte encoding: first byte is length prefix
  const length = firstByte & 0x7f;

  if (offset + 1 + length > buffer.length) {
    throw new BufferUnderflowError(
      `Cannot read VarUInt: expected ${length} bytes, buffer has ${buffer.length - offset - 1}`
    );
  }

  // Read value bytes (big-endian)
  let value = 0n;
  for (let i = 0; i < length; i++) {
    value = (value << 8n) | BigInt(buffer.readUInt8(offset + 1 + i));
  }

  return { value, bytesRead: 1 + length };
}

/**
 * Encode VarOctetString (Variable-Length Octet String)
 *
 * Encodes byte arrays with length prefix per RFC-0030.
 * Format: VarUInt length + data bytes
 *
 * @param data - Buffer to encode
 * @returns Buffer containing length-prefixed data
 *
 * @example
 * ```typescript
 * encodeVarOctetString(Buffer.alloc(0))     // Buffer<0x00> (empty)
 * encodeVarOctetString(Buffer.from([0x42])) // Buffer<0x01, 0x42>
 * ```
 *
 * @see {@link https://interledger.org/rfcs/0030-notes-on-oer-encoding/|RFC-0030: VarOctetString Encoding}
 */
export function encodeVarOctetString(data: Buffer): Buffer {
  const lengthPrefix = encodeVarUInt(BigInt(data.length));
  return Buffer.concat([lengthPrefix, data]);
}

/**
 * Decode VarOctetString (Variable-Length Octet String)
 *
 * Decodes length-prefixed byte arrays per RFC-0030.
 *
 * @param buffer - Buffer containing encoded VarOctetString
 * @param offset - Starting offset in buffer (default: 0)
 * @returns Object with decoded buffer and bytes consumed
 * @throws {BufferUnderflowError} If buffer has insufficient data
 *
 * @example
 * ```typescript
 * decodeVarOctetString(Buffer.from([0x00]), 0)
 *   // { value: Buffer<>, bytesRead: 1 }
 * decodeVarOctetString(Buffer.from([0x01, 0x42]), 0)
 *   // { value: Buffer<0x42>, bytesRead: 2 }
 * ```
 *
 * @see {@link https://interledger.org/rfcs/0030-notes-on-oer-encoding/|RFC-0030: VarOctetString Encoding}
 */
export function decodeVarOctetString(
  buffer: Buffer,
  offset = 0
): { value: Buffer; bytesRead: number } {
  const { value: length, bytesRead: lengthBytes } = decodeVarUInt(buffer, offset);

  const dataLength = Number(length);
  const dataStart = offset + lengthBytes;

  if (dataStart + dataLength > buffer.length) {
    throw new BufferUnderflowError(
      `Cannot read VarOctetString: expected ${dataLength} bytes, buffer has ${buffer.length - dataStart}`
    );
  }

  const value = buffer.slice(dataStart, dataStart + dataLength);
  return { value, bytesRead: lengthBytes + dataLength };
}

/**
 * Encode Fixed-Length Octet String
 *
 * Encodes fixed-size byte arrays without length prefix per RFC-0030.
 * Used for fields like executionCondition (32 bytes) and fulfillment (32 bytes).
 *
 * @param data - Buffer to encode
 * @param length - Expected fixed length
 * @returns Buffer containing fixed-length data
 * @throws {InvalidPacketError} If data length doesn't match expected length
 *
 * @example
 * ```typescript
 * encodeFixedOctetString(Buffer.alloc(32), 32) // Returns the buffer as-is
 * encodeFixedOctetString(Buffer.alloc(16), 32) // Throws InvalidPacketError
 * ```
 *
 * @see {@link https://interledger.org/rfcs/0030-notes-on-oer-encoding/|RFC-0030: Fixed Octet String}
 */
export function encodeFixedOctetString(data: Buffer, length: number): Buffer {
  if (data.length !== length) {
    throw new InvalidPacketError(
      `Fixed octet string length mismatch: expected ${length} bytes, got ${data.length}`
    );
  }
  return data;
}

/**
 * Decode Fixed-Length Octet String
 *
 * Decodes fixed-size byte arrays without length prefix per RFC-0030.
 *
 * @param buffer - Buffer containing encoded data
 * @param offset - Starting offset in buffer
 * @param length - Expected fixed length
 * @returns Object with decoded buffer and bytes consumed
 * @throws {BufferUnderflowError} If buffer has insufficient data
 *
 * @example
 * ```typescript
 * decodeFixedOctetString(buffer, 0, 32)
 *   // { value: Buffer<32 bytes>, bytesRead: 32 }
 * ```
 *
 * @see {@link https://interledger.org/rfcs/0030-notes-on-oer-encoding/|RFC-0030: Fixed Octet String}
 */
export function decodeFixedOctetString(
  buffer: Buffer,
  offset: number,
  length: number
): { value: Buffer; bytesRead: number } {
  if (offset + length > buffer.length) {
    throw new BufferUnderflowError(
      `Cannot read fixed octet string: expected ${length} bytes, buffer has ${buffer.length - offset}`
    );
  }

  const value = buffer.slice(offset, offset + length);
  return { value, bytesRead: length };
}

/**
 * Encode Generalized Time
 *
 * Encodes Date as 19-byte generalized time string per RFC-0030.
 * Format: YYYYMMDDHHmmss.fffZ (fixed 19 bytes)
 *
 * @param date - Date to encode
 * @returns Buffer containing 19-byte generalized time string
 *
 * @example
 * ```typescript
 * encodeGeneralizedTime(new Date('2025-01-31T23:59:59.999Z'))
 *   // Buffer containing "20250131235959.999Z"
 * ```
 *
 * @see {@link https://interledger.org/rfcs/0030-notes-on-oer-encoding/|RFC-0030: Generalized Time}
 */
export function encodeGeneralizedTime(date: Date): Buffer {
  const year = date.getUTCFullYear().toString().padStart(4, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  const hour = date.getUTCHours().toString().padStart(2, '0');
  const minute = date.getUTCMinutes().toString().padStart(2, '0');
  const second = date.getUTCSeconds().toString().padStart(2, '0');
  const millisecond = date.getUTCMilliseconds().toString().padStart(3, '0');

  const timeString = `${year}${month}${day}${hour}${minute}${second}.${millisecond}Z`;
  return Buffer.from(timeString, 'utf8');
}

/**
 * Decode Generalized Time
 *
 * Decodes 19-byte generalized time string to Date per RFC-0030.
 *
 * @param buffer - Buffer containing encoded time
 * @param offset - Starting offset in buffer
 * @returns Object with decoded Date and bytes consumed
 * @throws {BufferUnderflowError} If buffer has insufficient data
 * @throws {InvalidPacketError} If time format is invalid
 *
 * @example
 * ```typescript
 * decodeGeneralizedTime(Buffer.from('20250131235959.999Z'), 0)
 *   // { value: Date('2025-01-31T23:59:59.999Z'), bytesRead: 19 }
 * ```
 *
 * @see {@link https://interledger.org/rfcs/0030-notes-on-oer-encoding/|RFC-0030: Generalized Time}
 */
export function decodeGeneralizedTime(
  buffer: Buffer,
  offset: number
): { value: Date; bytesRead: number } {
  const TIME_STRING_LENGTH = 19;

  if (offset + TIME_STRING_LENGTH > buffer.length) {
    throw new BufferUnderflowError(
      `Cannot read generalized time: expected ${TIME_STRING_LENGTH} bytes, buffer has ${buffer.length - offset}`
    );
  }

  const timeString = buffer.slice(offset, offset + TIME_STRING_LENGTH).toString('utf8');

  // Parse: YYYYMMDDHHmmss.fffZ
  const match = timeString.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/);

  if (!match) {
    throw new InvalidPacketError(
      `Invalid generalized time format: expected YYYYMMDDHHmmss.fffZ, got ${timeString}`
    );
  }

  // Extract matched groups (TypeScript strict mode requires non-null assertion since regex is validated)
  const year = match[1]!;
  const month = match[2]!;
  const day = match[3]!;
  const hour = match[4]!;
  const minute = match[5]!;
  const second = match[6]!;
  const millisecond = match[7]!;

  const date = new Date(
    Date.UTC(
      parseInt(year, 10),
      parseInt(month, 10) - 1, // Month is 0-indexed
      parseInt(day, 10),
      parseInt(hour, 10),
      parseInt(minute, 10),
      parseInt(second, 10),
      parseInt(millisecond, 10)
    )
  );

  return { value: date, bytesRead: TIME_STRING_LENGTH };
}

/**
 * Serialize ILP Prepare Packet
 *
 * Encodes ILPPreparePacket to binary format per RFC-0027 Section 3.1.
 *
 * Binary format:
 * - Type (uint8): 12
 * - Amount (VarUInt): uint64
 * - ExpiresAt (19 bytes): Generalized time (YYYYMMDDHHmmss.fffZ)
 * - ExecutionCondition (32 bytes): SHA-256 hash
 * - Destination (VarOctetString): UTF-8 encoded ILP address
 * - Data (VarOctetString): Application payload
 *
 * @param packet - ILP Prepare packet to serialize
 * @returns Buffer containing serialized packet
 * @throws {InvalidPacketError} If packet structure is invalid
 *
 * @see {@link https://interledger.org/rfcs/0027-interledger-protocol-4/#ilp-prepare|RFC-0027 Section 3.1}
 */
export function serializePrepare(packet: ILPPreparePacket): Buffer {
  const type = Buffer.from([PacketType.PREPARE]);
  const amount = encodeVarUInt(packet.amount);
  const expiresAt = encodeGeneralizedTime(packet.expiresAt);
  const executionCondition = encodeFixedOctetString(
    Buffer.from(packet.executionCondition ?? Buffer.alloc(32)),
    32
  );
  const destination = encodeVarOctetString(Buffer.from(packet.destination, 'utf8'));
  const data = encodeVarOctetString(packet.data);

  return Buffer.concat([type, amount, expiresAt, executionCondition, destination, data]);
}

/**
 * Serialize ILP Fulfill Packet
 *
 * Encodes ILPFulfillPacket to binary format per RFC-0027 Section 3.2.
 *
 * Binary format:
 * - Type (uint8): 13
 * - Fulfillment (32 bytes): Preimage
 * - Data (VarOctetString): Return data
 *
 * @param packet - ILP Fulfill packet to serialize
 * @returns Buffer containing serialized packet
 * @throws {InvalidPacketError} If packet structure is invalid
 *
 * @see {@link https://interledger.org/rfcs/0027-interledger-protocol-4/#ilp-fulfill|RFC-0027 Section 3.2}
 */
export function serializeFulfill(packet: ILPFulfillPacket): Buffer {
  const type = Buffer.from([PacketType.FULFILL]);
  const fulfillment = encodeFixedOctetString(
    Buffer.from(packet.fulfillment ?? Buffer.alloc(32)),
    32
  );
  const data = encodeVarOctetString(packet.data);

  return Buffer.concat([type, fulfillment, data]);
}

/**
 * Serialize ILP Reject Packet
 *
 * Encodes ILPRejectPacket to binary format per RFC-0027 Section 3.3.
 *
 * Binary format:
 * - Type (uint8): 14
 * - Code (3 bytes): UTF-8 error code (e.g., "F02")
 * - TriggeredBy (VarOctetString): UTF-8 encoded ILP address
 * - Message (VarOctetString): UTF-8 error message
 * - Data (VarOctetString): Additional context
 *
 * @param packet - ILP Reject packet to serialize
 * @returns Buffer containing serialized packet
 * @throws {InvalidPacketError} If packet structure is invalid
 *
 * @see {@link https://interledger.org/rfcs/0027-interledger-protocol-4/#ilp-reject|RFC-0027 Section 3.3}
 */
export function serializeReject(packet: ILPRejectPacket): Buffer {
  // Validate error code is 3 characters
  if (packet.code.length !== 3) {
    throw new InvalidPacketError(`error code must be 3 characters, got ${packet.code.length}`);
  }

  const type = Buffer.from([PacketType.REJECT]);
  const code = Buffer.from(packet.code, 'utf8'); // Fixed 3 bytes
  const triggeredBy = encodeVarOctetString(Buffer.from(packet.triggeredBy, 'utf8'));
  const message = encodeVarOctetString(Buffer.from(packet.message, 'utf8'));
  const data = encodeVarOctetString(packet.data);

  return Buffer.concat([type, code, triggeredBy, message, data]);
}

/**
 * Serialize ILP Packet (Generic)
 *
 * Dispatches to type-specific serializer based on packet type.
 *
 * @param packet - ILP packet to serialize (Prepare, Fulfill, or Reject)
 * @returns Buffer containing serialized packet
 * @throws {InvalidPacketError} If packet type is invalid or unknown
 *
 * @example
 * ```typescript
 * const buffer = serializePacket(preparePacket);
 * const buffer2 = serializePacket(fulfillPacket);
 * ```
 *
 * @see {@link https://interledger.org/rfcs/0027-interledger-protocol-4/|RFC-0027: ILPv4}
 */
export function serializePacket(
  packet: ILPPreparePacket | ILPFulfillPacket | ILPRejectPacket
): Buffer {
  if (isPreparePacket(packet)) {
    return serializePrepare(packet);
  }

  if (isFulfillPacket(packet)) {
    return serializeFulfill(packet);
  }

  if (isRejectPacket(packet)) {
    return serializeReject(packet);
  }

  throw new InvalidPacketError('Invalid packet type: unknown packet structure');
}

/**
 * Deserialize ILP Prepare Packet
 *
 * Decodes binary data to ILPPreparePacket per RFC-0027 Section 3.1.
 *
 * @param buffer - Buffer containing serialized Prepare packet
 * @returns Decoded ILP Prepare packet
 * @throws {InvalidPacketError} If packet type is invalid or format is malformed
 * @throws {BufferUnderflowError} If buffer has insufficient data
 *
 * @see {@link https://interledger.org/rfcs/0027-interledger-protocol-4/#ilp-prepare|RFC-0027 Section 3.1}
 */
export function deserializePrepare(buffer: Buffer): ILPPreparePacket {
  let offset = 0;

  // Read and validate type byte
  if (buffer.length < 1) {
    throw new BufferUnderflowError('Cannot read packet type: buffer underflow');
  }

  const type = buffer.readUInt8(offset);
  offset += 1;

  if (type !== PacketType.PREPARE) {
    throw new InvalidPacketError(
      `Invalid packet type: expected ${PacketType.PREPARE}, got ${type}`
    );
  }

  // Decode amount
  const { value: amount, bytesRead: amountBytes } = decodeVarUInt(buffer, offset);
  offset += amountBytes;

  // Decode expiresAt
  const { value: expiresAt, bytesRead: expiresAtBytes } = decodeGeneralizedTime(buffer, offset);
  offset += expiresAtBytes;

  // Read executionCondition field (32 bytes)
  const { value: executionCondition, bytesRead: conditionBytes } = decodeFixedOctetString(
    buffer,
    offset,
    32
  );
  offset += conditionBytes;

  // Decode destination
  const { value: destinationBuffer, bytesRead: destinationBytes } = decodeVarOctetString(
    buffer,
    offset
  );
  offset += destinationBytes;

  const destination = destinationBuffer.toString('utf8');

  // Validate ILP address format
  if (!isValidILPAddress(destination)) {
    throw new InvalidPacketError(`Invalid ILP address format: ${destination}`);
  }

  // Decode data
  const { value: data, bytesRead: dataBytes } = decodeVarOctetString(buffer, offset);
  offset += dataBytes;

  // Only populate executionCondition if non-zero (preserves optional semantics)
  const conditionArray = new Uint8Array(executionCondition);
  const hasCondition = !conditionArray.every((b: number) => b === 0);

  return {
    type: PacketType.PREPARE,
    amount,
    destination,
    expiresAt,
    ...(hasCondition ? { executionCondition: conditionArray } : {}),
    data,
  };
}

/**
 * Deserialize ILP Fulfill Packet
 *
 * Decodes binary data to ILPFulfillPacket per RFC-0027 Section 3.2.
 *
 * @param buffer - Buffer containing serialized Fulfill packet
 * @returns Decoded ILP Fulfill packet
 * @throws {InvalidPacketError} If packet type is invalid or format is malformed
 * @throws {BufferUnderflowError} If buffer has insufficient data
 *
 * @see {@link https://interledger.org/rfcs/0027-interledger-protocol-4/#ilp-fulfill|RFC-0027 Section 3.2}
 */
export function deserializeFulfill(buffer: Buffer): ILPFulfillPacket {
  let offset = 0;

  // Read and validate type byte
  if (buffer.length < 1) {
    throw new BufferUnderflowError('Cannot read packet type: buffer underflow');
  }

  const type = buffer.readUInt8(offset);
  offset += 1;

  if (type !== PacketType.FULFILL) {
    throw new InvalidPacketError(
      `Invalid packet type: expected ${PacketType.FULFILL}, got ${type}`
    );
  }

  // Read fulfillment field (32 bytes)
  const { value: fulfillment, bytesRead: fulfillmentBytes } = decodeFixedOctetString(
    buffer,
    offset,
    32
  );
  offset += fulfillmentBytes;

  // Decode data
  const { value: data, bytesRead: dataBytes } = decodeVarOctetString(buffer, offset);
  offset += dataBytes;

  // Only populate fulfillment if non-zero (preserves optional semantics)
  const fulfillmentArray = new Uint8Array(fulfillment);
  const hasFulfillment = !fulfillmentArray.every((b: number) => b === 0);

  return {
    type: PacketType.FULFILL,
    ...(hasFulfillment ? { fulfillment: fulfillmentArray } : {}),
    data,
  };
}

/**
 * Deserialize ILP Reject Packet
 *
 * Decodes binary data to ILPRejectPacket per RFC-0027 Section 3.3.
 *
 * @param buffer - Buffer containing serialized Reject packet
 * @returns Decoded ILP Reject packet
 * @throws {InvalidPacketError} If packet type is invalid or format is malformed
 * @throws {BufferUnderflowError} If buffer has insufficient data
 *
 * @see {@link https://interledger.org/rfcs/0027-interledger-protocol-4/#ilp-reject|RFC-0027 Section 3.3}
 */
export function deserializeReject(buffer: Buffer): ILPRejectPacket {
  let offset = 0;

  // Read and validate type byte
  if (buffer.length < 1) {
    throw new BufferUnderflowError('Cannot read packet type: buffer underflow');
  }

  const type = buffer.readUInt8(offset);
  offset += 1;

  if (type !== PacketType.REJECT) {
    throw new InvalidPacketError(`Invalid packet type: expected ${PacketType.REJECT}, got ${type}`);
  }

  // Decode error code (3 bytes fixed)
  if (offset + 3 > buffer.length) {
    throw new BufferUnderflowError('Cannot read error code: buffer underflow');
  }

  const code = buffer.slice(offset, offset + 3).toString('utf8') as ILPErrorCode;
  offset += 3;

  // Validate error code format (3 characters)
  if (code.length !== 3) {
    throw new InvalidPacketError(
      `Invalid error code format: expected 3 characters, got ${code.length}`
    );
  }

  // Decode triggeredBy
  const { value: triggeredByBuffer, bytesRead: triggeredByBytes } = decodeVarOctetString(
    buffer,
    offset
  );
  offset += triggeredByBytes;

  const triggeredBy = triggeredByBuffer.toString('utf8');

  // Validate triggeredBy ILP address format (empty string is allowed per ILPv4 spec)
  if (triggeredBy.length > 0 && !isValidILPAddress(triggeredBy)) {
    throw new InvalidPacketError(`Invalid triggeredBy ILP address format: ${triggeredBy}`);
  }

  // Decode message
  const { value: messageBuffer, bytesRead: messageBytes } = decodeVarOctetString(buffer, offset);
  offset += messageBytes;

  const message = messageBuffer.toString('utf8');

  // Decode data
  const { value: data, bytesRead: dataBytes } = decodeVarOctetString(buffer, offset);
  offset += dataBytes;

  return {
    type: PacketType.REJECT,
    code,
    triggeredBy,
    message,
    data,
  };
}

/**
 * Deserialize ILP Packet (Generic)
 *
 * Reads type byte and dispatches to type-specific deserializer.
 *
 * @param buffer - Buffer containing serialized ILP packet
 * @returns Decoded ILP packet (Prepare, Fulfill, or Reject)
 * @throws {InvalidPacketError} If packet type is invalid or unknown
 * @throws {BufferUnderflowError} If buffer is empty or has insufficient data
 *
 * @example
 * ```typescript
 * const packet = deserializePacket(buffer);
 * if (isPreparePacket(packet)) {
 *   console.log(packet.destination);
 * }
 * ```
 *
 * @see {@link https://interledger.org/rfcs/0027-interledger-protocol-4/|RFC-0027: ILPv4}
 */
export function deserializePacket(
  buffer: Buffer
): ILPPreparePacket | ILPFulfillPacket | ILPRejectPacket {
  if (buffer.length === 0) {
    throw new InvalidPacketError('Cannot deserialize packet: empty buffer');
  }

  const type = buffer.readUInt8(0);

  switch (type) {
    case PacketType.PREPARE:
      return deserializePrepare(buffer);
    case PacketType.FULFILL:
      return deserializeFulfill(buffer);
    case PacketType.REJECT:
      return deserializeReject(buffer);
    default:
      throw new InvalidPacketError(`Invalid packet type: expected 12, 13, or 14, got ${type}`);
  }
}
