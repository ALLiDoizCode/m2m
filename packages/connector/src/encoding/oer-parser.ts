import { Logger } from 'pino';

/**
 * OERParser implements zero-copy parsing of OER-encoded data.
 * Uses Buffer.slice() instead of Buffer.from() to avoid copying binary data.
 * This significantly reduces memory allocation and GC pressure under high load.
 */
export class OERParser {
  constructor(_logger: Logger) {
    // Logger reserved for future use
  }

  /**
   * Read variable-length unsigned integer (zero-copy)
   * Returns both the value and the number of bytes read
   */
  readVarUInt(buffer: Buffer, offset: number): { value: bigint; bytesRead: number } {
    if (offset >= buffer.length) {
      throw new Error('Buffer underflow: cannot read var uint');
    }

    const firstByte = buffer[offset];
    if (firstByte === undefined) {
      throw new Error('Buffer underflow: cannot read first byte');
    }

    // Single byte value (0-127)
    if ((firstByte & 0x80) === 0) {
      return { value: BigInt(firstByte), bytesRead: 1 };
    }

    // Multi-byte value
    const lengthOfLength = firstByte & 0x7f;
    if (lengthOfLength > 8) {
      throw new Error(`Invalid var uint length: ${lengthOfLength}`);
    }

    if (offset + 1 + lengthOfLength > buffer.length) {
      throw new Error('Buffer underflow: incomplete var uint');
    }

    // Use buffer.slice() for zero-copy access to value bytes
    const valueBytes = buffer.slice(offset + 1, offset + 1 + lengthOfLength);
    let value = BigInt(0);

    for (let i = 0; i < lengthOfLength; i++) {
      const byte = valueBytes[i];
      if (byte === undefined) {
        throw new Error('Buffer underflow: incomplete value bytes');
      }
      value = (value << BigInt(8)) | BigInt(byte);
    }

    return { value, bytesRead: 1 + lengthOfLength };
  }

  /**
   * Read variable-length octet string (zero-copy)
   * Returns a slice view of the original buffer instead of copying
   */
  readVarOctetString(buffer: Buffer, offset: number): { value: Buffer; bytesRead: number } {
    const { value: length, bytesRead: lengthBytes } = this.readVarUInt(buffer, offset);

    const lengthNum = Number(length);
    if (lengthNum > Number.MAX_SAFE_INTEGER) {
      throw new Error(`Octet string too large: ${length}`);
    }

    if (offset + lengthBytes + lengthNum > buffer.length) {
      throw new Error('Buffer underflow: incomplete octet string');
    }

    // Zero-copy: use slice instead of allocating new buffer
    const value = buffer.slice(offset + lengthBytes, offset + lengthBytes + lengthNum);

    return { value, bytesRead: lengthBytes + lengthNum };
  }

  /**
   * Read fixed-length octet string (zero-copy)
   */
  readOctetString(
    buffer: Buffer,
    offset: number,
    length: number
  ): { value: Buffer; bytesRead: number } {
    if (offset + length > buffer.length) {
      throw new Error('Buffer underflow: incomplete fixed octet string');
    }

    // Zero-copy: use slice
    const value = buffer.slice(offset, offset + length);

    return { value, bytesRead: length };
  }

  /**
   * Read uint8 value
   */
  readUInt8(buffer: Buffer, offset: number): { value: number; bytesRead: number } {
    if (offset >= buffer.length) {
      throw new Error('Buffer underflow: cannot read uint8');
    }

    const value = buffer[offset];
    if (value === undefined) {
      throw new Error('Buffer underflow: cannot read uint8 value');
    }

    return { value, bytesRead: 1 };
  }

  /**
   * Read uint16 value (big-endian)
   */
  readUInt16(buffer: Buffer, offset: number): { value: number; bytesRead: number } {
    if (offset + 2 > buffer.length) {
      throw new Error('Buffer underflow: cannot read uint16');
    }

    const value = buffer.readUInt16BE(offset);
    return { value, bytesRead: 2 };
  }

  /**
   * Read uint32 value (big-endian)
   */
  readUInt32(buffer: Buffer, offset: number): { value: number; bytesRead: number } {
    if (offset + 4 > buffer.length) {
      throw new Error('Buffer underflow: cannot read uint32');
    }

    const value = buffer.readUInt32BE(offset);
    return { value, bytesRead: 4 };
  }

  /**
   * Read uint64 value (big-endian)
   */
  readUInt64(buffer: Buffer, offset: number): { value: bigint; bytesRead: number } {
    if (offset + 8 > buffer.length) {
      throw new Error('Buffer underflow: cannot read uint64');
    }

    const value = buffer.readBigUInt64BE(offset);
    return { value, bytesRead: 8 };
  }

  /**
   * Write variable-length unsigned integer
   */
  writeVarUInt(value: bigint | number): Buffer {
    const bigIntValue = typeof value === 'number' ? BigInt(value) : value;

    if (bigIntValue < 0) {
      throw new Error('Cannot encode negative value as var uint');
    }

    // Single byte encoding (0-127)
    if (bigIntValue < 128) {
      return Buffer.from([Number(bigIntValue)]);
    }

    // Multi-byte encoding
    const bytes: number[] = [];
    let remaining = bigIntValue;

    while (remaining > 0) {
      bytes.unshift(Number(remaining & BigInt(0xff)));
      remaining = remaining >> BigInt(8);
    }

    const lengthOfLength = bytes.length;
    if (lengthOfLength > 127) {
      throw new Error('Value too large for var uint encoding');
    }

    // First byte: 0x80 | length-of-length
    const result = Buffer.allocUnsafe(1 + lengthOfLength);
    result[0] = 0x80 | lengthOfLength;

    for (let i = 0; i < lengthOfLength; i++) {
      const byte = bytes[i];
      if (byte === undefined) {
        throw new Error('Internal error: invalid bytes array');
      }
      result[1 + i] = byte;
    }

    return result;
  }

  /**
   * Write variable-length octet string
   */
  writeVarOctetString(data: Buffer): Buffer {
    const lengthPrefix = this.writeVarUInt(data.length);
    return Buffer.concat([lengthPrefix, data]);
  }

  /**
   * Write uint8 value
   */
  writeUInt8(value: number): Buffer {
    if (value < 0 || value > 255) {
      throw new Error('Value out of range for uint8');
    }
    const buffer = Buffer.allocUnsafe(1);
    buffer.writeUInt8(value, 0);
    return buffer;
  }

  /**
   * Write uint16 value (big-endian)
   */
  writeUInt16(value: number): Buffer {
    if (value < 0 || value > 65535) {
      throw new Error('Value out of range for uint16');
    }
    const buffer = Buffer.allocUnsafe(2);
    buffer.writeUInt16BE(value, 0);
    return buffer;
  }

  /**
   * Write uint32 value (big-endian)
   */
  writeUInt32(value: number): Buffer {
    if (value < 0 || value > 4294967295) {
      throw new Error('Value out of range for uint32');
    }
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeUInt32BE(value, 0);
    return buffer;
  }

  /**
   * Write uint64 value (big-endian)
   */
  writeUInt64(value: bigint | number): Buffer {
    const bigIntValue = typeof value === 'number' ? BigInt(value) : value;
    if (bigIntValue < 0 || bigIntValue > BigInt('0xFFFFFFFFFFFFFFFF')) {
      throw new Error('Value out of range for uint64');
    }
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeBigUInt64BE(bigIntValue, 0);
    return buffer;
  }
}
