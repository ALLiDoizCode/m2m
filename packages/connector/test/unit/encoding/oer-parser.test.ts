import pino from 'pino';
import { OERParser } from '../../../src/encoding/oer-parser';

describe('OERParser', () => {
  let logger: pino.Logger;
  let parser: OERParser;

  beforeEach(() => {
    logger = pino({ level: 'silent' });
    parser = new OERParser(logger);
  });

  describe('Variable-Length Unsigned Integer', () => {
    it('should read single-byte var uint (0-127)', () => {
      const buffer = Buffer.from([0x42]); // 66 in decimal
      const result = parser.readVarUInt(buffer, 0);

      expect(result.value).toBe(BigInt(66));
      expect(result.bytesRead).toBe(1);
    });

    it('should read multi-byte var uint', () => {
      // 0x82 = length prefix (2 bytes follow), 0x01 0x00 = 256
      const buffer = Buffer.from([0x82, 0x01, 0x00]);
      const result = parser.readVarUInt(buffer, 0);

      expect(result.value).toBe(BigInt(256));
      expect(result.bytesRead).toBe(3);
    });

    it('should read large var uint', () => {
      // 8-byte value: 0xFFFFFFFFFFFFFFFF
      const buffer = Buffer.from([0x88, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
      const result = parser.readVarUInt(buffer, 0);

      expect(result.value).toBe(BigInt('0xFFFFFFFFFFFFFFFF'));
      expect(result.bytesRead).toBe(9);
    });

    it('should throw on buffer underflow', () => {
      const buffer = Buffer.from([0x82, 0x01]); // Incomplete multi-byte value
      expect(() => parser.readVarUInt(buffer, 0)).toThrow('Buffer underflow');
    });

    it('should write single-byte var uint', () => {
      const buffer = parser.writeVarUInt(66);
      expect(buffer).toEqual(Buffer.from([0x42]));
    });

    it('should write multi-byte var uint', () => {
      const buffer = parser.writeVarUInt(256);
      expect(buffer).toEqual(Buffer.from([0x82, 0x01, 0x00]));
    });

    it('should round-trip var uint values', () => {
      const testValues = [0, 1, 127, 128, 255, 256, 65535, 65536, 16777215];

      for (const value of testValues) {
        const encoded = parser.writeVarUInt(value);
        const decoded = parser.readVarUInt(encoded, 0);
        expect(Number(decoded.value)).toBe(value);
      }
    });
  });

  describe('Variable-Length Octet String', () => {
    it('should read var octet string (zero-copy)', () => {
      const data = Buffer.from('Hello, World!', 'utf8');
      const length = parser.writeVarUInt(data.length);
      const buffer = Buffer.concat([length, data]);

      const result = parser.readVarOctetString(buffer, 0);

      expect(result.value.toString('utf8')).toBe('Hello, World!');
      expect(result.bytesRead).toBe(length.length + data.length);

      // Verify zero-copy: modifying the original buffer should affect the slice
      buffer[length.length] = 0x58; // Change 'H' to 'X'
      expect(result.value[0]).toBe(0x58);
    });

    it('should write var octet string', () => {
      const data = Buffer.from('test');
      const encoded = parser.writeVarOctetString(data);

      // First byte should be length (4)
      expect(encoded[0]).toBe(4);
      expect(encoded.slice(1).toString()).toBe('test');
    });

    it('should round-trip var octet strings', () => {
      const testStrings = ['', 'a', 'Hello', 'x'.repeat(200)];

      for (const str of testStrings) {
        const original = Buffer.from(str, 'utf8');
        const encoded = parser.writeVarOctetString(original);
        const decoded = parser.readVarOctetString(encoded, 0);
        expect(decoded.value.toString('utf8')).toBe(str);
      }
    });

    it('should throw on buffer underflow', () => {
      const buffer = Buffer.from([0x0a, 0x01, 0x02]); // Claims 10 bytes but only has 2
      expect(() => parser.readVarOctetString(buffer, 0)).toThrow('Buffer underflow');
    });
  });

  describe('Fixed-Length Octet String', () => {
    it('should read fixed octet string (zero-copy)', () => {
      const buffer = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
      const result = parser.readOctetString(buffer, 1, 3);

      expect(result.value).toEqual(Buffer.from([0x02, 0x03, 0x04]));
      expect(result.bytesRead).toBe(3);

      // Verify zero-copy
      buffer[2] = 0xff;
      expect(result.value[1]).toBe(0xff);
    });

    it('should throw on buffer underflow', () => {
      const buffer = Buffer.from([0x01, 0x02]);
      expect(() => parser.readOctetString(buffer, 0, 5)).toThrow('Buffer underflow');
    });
  });

  describe('Fixed-Size Integers', () => {
    describe('UInt8', () => {
      it('should read uint8', () => {
        const buffer = Buffer.from([0xff]);
        const result = parser.readUInt8(buffer, 0);
        expect(result.value).toBe(255);
        expect(result.bytesRead).toBe(1);
      });

      it('should write uint8', () => {
        const buffer = parser.writeUInt8(255);
        expect(buffer).toEqual(Buffer.from([0xff]));
      });

      it('should throw on out-of-range values', () => {
        expect(() => parser.writeUInt8(-1)).toThrow('Value out of range');
        expect(() => parser.writeUInt8(256)).toThrow('Value out of range');
      });
    });

    describe('UInt16', () => {
      it('should read uint16 (big-endian)', () => {
        const buffer = Buffer.from([0x01, 0x00]); // 256 in big-endian
        const result = parser.readUInt16(buffer, 0);
        expect(result.value).toBe(256);
        expect(result.bytesRead).toBe(2);
      });

      it('should write uint16', () => {
        const buffer = parser.writeUInt16(256);
        expect(buffer).toEqual(Buffer.from([0x01, 0x00]));
      });

      it('should round-trip uint16 values', () => {
        const testValues = [0, 1, 255, 256, 65535];
        for (const value of testValues) {
          const encoded = parser.writeUInt16(value);
          const decoded = parser.readUInt16(encoded, 0);
          expect(decoded.value).toBe(value);
        }
      });
    });

    describe('UInt32', () => {
      it('should read uint32 (big-endian)', () => {
        const buffer = Buffer.from([0x00, 0x01, 0x00, 0x00]); // 65536
        const result = parser.readUInt32(buffer, 0);
        expect(result.value).toBe(65536);
        expect(result.bytesRead).toBe(4);
      });

      it('should write uint32', () => {
        const buffer = parser.writeUInt32(65536);
        expect(buffer).toEqual(Buffer.from([0x00, 0x01, 0x00, 0x00]));
      });

      it('should round-trip uint32 values', () => {
        const testValues = [0, 1, 65536, 16777216, 4294967295];
        for (const value of testValues) {
          const encoded = parser.writeUInt32(value);
          const decoded = parser.readUInt32(encoded, 0);
          expect(decoded.value).toBe(value);
        }
      });
    });

    describe('UInt64', () => {
      it('should read uint64 (big-endian)', () => {
        const buffer = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
        const result = parser.readUInt64(buffer, 0);
        expect(result.value).toBe(BigInt('4294967296'));
        expect(result.bytesRead).toBe(8);
      });

      it('should write uint64', () => {
        const buffer = parser.writeUInt64(BigInt('4294967296'));
        expect(buffer).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]));
      });

      it('should round-trip uint64 values', () => {
        const testValues = [
          BigInt(0),
          BigInt(1),
          BigInt(4294967296),
          BigInt('18446744073709551615'), // Max uint64
        ];
        for (const value of testValues) {
          const encoded = parser.writeUInt64(value);
          const decoded = parser.readUInt64(encoded, 0);
          expect(decoded.value).toBe(value);
        }
      });
    });
  });

  describe('Zero-Copy Verification', () => {
    it('should use buffer slices instead of copies for octet strings', () => {
      const originalBuffer = Buffer.allocUnsafe(100);
      originalBuffer.fill(0x42);

      // Read a slice
      const result = parser.readOctetString(originalBuffer, 10, 20);

      // Modify original buffer
      originalBuffer[15] = 0xff;

      // Slice should reflect the change (proving it's zero-copy)
      expect(result.value[5]).toBe(0xff);
    });

    it('should not allocate new buffers when reading slices', () => {
      const buffer = Buffer.from([0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
      const result = parser.readVarOctetString(buffer, 0);

      // The returned buffer should share the same underlying ArrayBuffer
      // (not a perfect test, but demonstrates the concept)
      expect(result.value.buffer).toBe(buffer.buffer);
    });
  });
});
