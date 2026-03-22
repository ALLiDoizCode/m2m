/**
 * Unit Tests for ILP Type Definitions
 *
 * Tests for ILP packet type guards and address validation per RFC-0027 and RFC-0015.
 */

import {
  PacketType,
  ILPErrorCode,
  ILPPreparePacket,
  ILPFulfillPacket,
  ILPRejectPacket,
  isPreparePacket,
  isFulfillPacket,
  isRejectPacket,
  isValidILPAddress,
} from './ilp';

/**
 * Test Data Factory: Create ILP Prepare Packet
 *
 * Reusable factory function for creating test Prepare packets.
 * Useful for this story and future OER encoding tests.
 */
export function createTestPreparePacket(overrides?: Partial<ILPPreparePacket>): ILPPreparePacket {
  return {
    type: PacketType.PREPARE,
    amount: BigInt(1000),
    destination: 'g.alice',
    expiresAt: new Date('2025-12-31T23:59:59Z'),
    data: Buffer.alloc(0),
    ...overrides,
  };
}

/**
 * Test Data Factory: Create ILP Fulfill Packet
 *
 * Reusable factory function for creating test Fulfill packets.
 */
export function createTestFulfillPacket(overrides?: Partial<ILPFulfillPacket>): ILPFulfillPacket {
  return {
    type: PacketType.FULFILL,
    data: Buffer.alloc(0),
    ...overrides,
  };
}

/**
 * Test Data Factory: Create ILP Reject Packet
 *
 * Reusable factory function for creating test Reject packets.
 */
export function createTestRejectPacket(overrides?: Partial<ILPRejectPacket>): ILPRejectPacket {
  return {
    type: PacketType.REJECT,
    code: ILPErrorCode.F02_UNREACHABLE,
    triggeredBy: 'g.connector',
    message: 'No route to destination',
    data: Buffer.alloc(0),
    ...overrides,
  };
}

describe('ILP Type Guards', () => {
  describe('isPreparePacket', () => {
    it('should return true when packet type is PREPARE (12)', () => {
      // Arrange
      const packet = createTestPreparePacket();

      // Act
      const result = isPreparePacket(packet);

      // Assert
      expect(result).toBe(true);
    });

    it('should return false when packet type is FULFILL (13)', () => {
      // Arrange
      const packet = createTestFulfillPacket();

      // Act
      const result = isPreparePacket(packet);

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when packet type is REJECT (14)', () => {
      // Arrange
      const packet = createTestRejectPacket();

      // Act
      const result = isPreparePacket(packet);

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when packet is undefined', () => {
      // Arrange
      const packet = undefined;

      // Act
      const result = isPreparePacket(packet);

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when packet is null', () => {
      // Arrange
      const packet = null;

      // Act
      const result = isPreparePacket(packet);

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when packet is missing type field', () => {
      // Arrange
      const packet = { data: Buffer.alloc(0) };

      // Act
      const result = isPreparePacket(packet);

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when packet type is invalid number', () => {
      // Arrange
      const packet = { type: 99, data: Buffer.alloc(0) };

      // Act
      const result = isPreparePacket(packet);

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when packet is not an object', () => {
      // Arrange
      const packet = 'not an object';

      // Act
      const result = isPreparePacket(packet);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('isFulfillPacket', () => {
    it('should return true when packet type is FULFILL (13)', () => {
      // Arrange
      const packet = createTestFulfillPacket();

      // Act
      const result = isFulfillPacket(packet);

      // Assert
      expect(result).toBe(true);
    });

    it('should return false when packet type is PREPARE (12)', () => {
      // Arrange
      const packet = createTestPreparePacket();

      // Act
      const result = isFulfillPacket(packet);

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when packet type is REJECT (14)', () => {
      // Arrange
      const packet = createTestRejectPacket();

      // Act
      const result = isFulfillPacket(packet);

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when packet is undefined', () => {
      // Arrange
      const packet = undefined;

      // Act
      const result = isFulfillPacket(packet);

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when packet is null', () => {
      // Arrange
      const packet = null;

      // Act
      const result = isFulfillPacket(packet);

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when packet is missing type field', () => {
      // Arrange
      const packet = { data: Buffer.alloc(0) };

      // Act
      const result = isFulfillPacket(packet);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('isRejectPacket', () => {
    it('should return true when packet type is REJECT (14)', () => {
      // Arrange
      const packet = createTestRejectPacket();

      // Act
      const result = isRejectPacket(packet);

      // Assert
      expect(result).toBe(true);
    });

    it('should return false when packet type is PREPARE (12)', () => {
      // Arrange
      const packet = createTestPreparePacket();

      // Act
      const result = isRejectPacket(packet);

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when packet type is FULFILL (13)', () => {
      // Arrange
      const packet = createTestFulfillPacket();

      // Act
      const result = isRejectPacket(packet);

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when packet is undefined', () => {
      // Arrange
      const packet = undefined;

      // Act
      const result = isRejectPacket(packet);

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when packet is null', () => {
      // Arrange
      const packet = null;

      // Act
      const result = isRejectPacket(packet);

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when packet is missing type field', () => {
      // Arrange
      const packet = { data: Buffer.alloc(0) };

      // Act
      const result = isRejectPacket(packet);

      // Assert
      expect(result).toBe(false);
    });
  });
});

describe('ILP Address Validation', () => {
  describe('isValidILPAddress', () => {
    describe('Valid Addresses', () => {
      it('should accept single segment address "g"', () => {
        // Arrange
        const address = 'g';

        // Act
        const result = isValidILPAddress(address);

        // Assert
        expect(result).toBe(true);
      });

      it('should accept two-segment address "g.alice"', () => {
        // Arrange
        const address = 'g.alice';

        // Act
        const result = isValidILPAddress(address);

        // Assert
        expect(result).toBe(true);
      });

      it('should accept multi-segment address "g.bob.crypto"', () => {
        // Arrange
        const address = 'g.bob.crypto';

        // Act
        const result = isValidILPAddress(address);

        // Assert
        expect(result).toBe(true);
      });

      it('should accept address with hyphens "g.connector-a.peer1"', () => {
        // Arrange
        const address = 'g.connector-a.peer1';

        // Act
        const result = isValidILPAddress(address);

        // Assert
        expect(result).toBe(true);
      });

      it('should accept address with underscores "test.example_address.123"', () => {
        // Arrange
        const address = 'test.example_address.123';

        // Act
        const result = isValidILPAddress(address);

        // Assert
        expect(result).toBe(true);
      });

      it('should accept address with mixed alphanumeric characters "g.user123.account456"', () => {
        // Arrange
        const address = 'g.user123.account456';

        // Act
        const result = isValidILPAddress(address);

        // Assert
        expect(result).toBe(true);
      });

      it('should accept maximum length valid address (1023 characters)', () => {
        // Arrange - Create 1023 character valid address
        const segment = 'a'.repeat(1023);
        const address = segment;

        // Act
        const result = isValidILPAddress(address);

        // Assert
        expect(result).toBe(true);
        expect(address.length).toBe(1023);
      });
    });

    describe('Invalid Addresses', () => {
      it('should reject empty string', () => {
        // Arrange
        const address = '';

        // Act
        const result = isValidILPAddress(address);

        // Assert
        expect(result).toBe(false);
      });

      it('should reject leading dot ".g.alice"', () => {
        // Arrange
        const address = '.g.alice';

        // Act
        const result = isValidILPAddress(address);

        // Assert
        expect(result).toBe(false);
      });

      it('should reject trailing dot "g.alice."', () => {
        // Arrange
        const address = 'g.alice.';

        // Act
        const result = isValidILPAddress(address);

        // Assert
        expect(result).toBe(false);
      });

      it('should reject consecutive dots "g..alice"', () => {
        // Arrange
        const address = 'g..alice';

        // Act
        const result = isValidILPAddress(address);

        // Assert
        expect(result).toBe(false);
      });

      it('should reject space character "g.alice bob"', () => {
        // Arrange
        const address = 'g.alice bob';

        // Act
        const result = isValidILPAddress(address);

        // Assert
        expect(result).toBe(false);
      });

      it('should reject special character @ "g.alice@crypto"', () => {
        // Arrange
        const address = 'g.alice@crypto';

        // Act
        const result = isValidILPAddress(address);

        // Assert
        expect(result).toBe(false);
      });

      it('should reject special character # "g.alice#crypto"', () => {
        // Arrange
        const address = 'g.alice#crypto';

        // Act
        const result = isValidILPAddress(address);

        // Assert
        expect(result).toBe(false);
      });

      it('should reject special character $ "g.alice$crypto"', () => {
        // Arrange
        const address = 'g.alice$crypto';

        // Act
        const result = isValidILPAddress(address);

        // Assert
        expect(result).toBe(false);
      });

      it('should reject address exceeding maximum length (1024 characters)', () => {
        // Arrange - Create 1024 character address (exceeds limit)
        const segment = 'a'.repeat(1024);
        const address = segment;

        // Act
        const result = isValidILPAddress(address);

        // Assert
        expect(result).toBe(false);
        expect(address.length).toBe(1024);
      });

      it('should reject slash character "g.alice/crypto"', () => {
        // Arrange
        const address = 'g.alice/crypto';

        // Act
        const result = isValidILPAddress(address);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});
