/**
 * Unit tests for BTP Claim Message Protocol
 *
 * Tests cover EVM claim message validation, type guards, edge cases, and JSON serialization.
 * Epic 30 Story 30.4: Removed XRP/Aptos tests (EVM-only settlement).
 *
 * @module btp-claim-types.test
 */

import {
  BTPClaimMessage,
  EVMClaimMessage,
  SolanaClaimMessage,
  MinaClaimMessage,
  BlockchainType,
  validateClaimMessage,
  isEVMClaim,
  isSolanaClaim,
  isMinaClaim,
  BTP_CLAIM_PROTOCOL,
} from './btp-claim-types';

describe('BTP_CLAIM_PROTOCOL constants', () => {
  it('should define correct protocol constants', () => {
    expect(BTP_CLAIM_PROTOCOL.NAME).toBe('payment-channel-claim');
    expect(BTP_CLAIM_PROTOCOL.CONTENT_TYPE).toBe(1);
    expect(BTP_CLAIM_PROTOCOL.VERSION).toBe('1.0');
  });
});

describe('validateClaimMessage - Valid Messages', () => {
  it('should accept valid EVM claim message', () => {
    // Arrange
    const validEVMClaim: EVMClaimMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-evm-001',
      timestamp: '2026-02-02T12:00:00.000Z',
      senderId: 'peer-bob',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 5,
      transferredAmount: '1000000000000000000', // 1 ETH in wei
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    };

    // Act & Assert
    expect(() => validateClaimMessage(validEVMClaim)).not.toThrow();
  });
});

describe('validateClaimMessage - Common Field Validation', () => {
  it('should reject non-object message', () => {
    // Arrange
    const invalidMessage = 'not an object';

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow('Claim message must be an object');
  });

  it('should reject null message', () => {
    // Arrange
    const invalidMessage = null;

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow('Claim message must be an object');
  });

  it('should reject array message', () => {
    // Arrange
    const invalidMessage = ['not', 'an', 'object'];

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow('Invalid version');
  });

  it('should reject unsupported version', () => {
    // Arrange
    const invalidMessage = {
      version: '2.0',
      blockchain: 'evm',
      messageId: 'claim-001',
      timestamp: '2026-02-02T12:00:00.000Z',
      senderId: 'peer-alice',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 1,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      "Invalid version (expected '1.0', got '2.0')"
    );
  });

  it('should reject invalid blockchain type', () => {
    // Arrange
    const invalidMessage = {
      version: '1.0',
      blockchain: 'bitcoin',
      messageId: 'claim-001',
      timestamp: '2026-02-02T12:00:00.000Z',
      senderId: 'peer-alice',
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      'Unsupported blockchain type: bitcoin'
    );
  });

  it('should reject missing messageId', () => {
    // Arrange
    const invalidMessage = {
      version: '1.0',
      blockchain: 'evm',
      timestamp: '2026-02-02T12:00:00.000Z',
      senderId: 'peer-alice',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 1,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      'Missing or invalid messageId (expected non-empty string)'
    );
  });

  it('should reject invalid timestamp format', () => {
    // Arrange
    const invalidMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-001',
      timestamp: '2026-02-02 12:00:00', // Not ISO 8601
      senderId: 'peer-alice',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 1,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      'Invalid timestamp format (expected ISO 8601 with Z timezone)'
    );
  });

  it('should reject missing timestamp', () => {
    // Arrange
    const invalidMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-001',
      senderId: 'peer-alice',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 1,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      'Missing or invalid timestamp (expected ISO 8601 string)'
    );
  });

  it('should reject missing senderId', () => {
    // Arrange
    const invalidMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-001',
      timestamp: '2026-02-02T12:00:00.000Z',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 1,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      'Missing or invalid senderId (expected non-empty string)'
    );
  });
});

describe('validateClaimMessage - EVM-Specific Validation', () => {
  it('should reject invalid EVM channelId format (missing 0x prefix)', () => {
    // Arrange
    const invalidMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-001',
      timestamp: '2026-02-02T12:00:00.000Z',
      senderId: 'peer-bob',
      channelId: '1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 5,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      'Invalid channelId format (expected 0x-prefixed 64-char hex)'
    );
  });

  it('should reject invalid EVM channelId format (wrong length)', () => {
    // Arrange
    const invalidMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-001',
      timestamp: '2026-02-02T12:00:00.000Z',
      senderId: 'peer-bob',
      channelId: '0x1234',
      nonce: 5,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      'Invalid channelId format (expected 0x-prefixed 64-char hex)'
    );
  });

  it('should reject negative EVM nonce', () => {
    // Arrange
    const invalidMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-001',
      timestamp: '2026-02-02T12:00:00.000Z',
      senderId: 'peer-bob',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: -5,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      'Missing or invalid nonce (expected non-negative integer)'
    );
  });

  it('should reject invalid EVM transferredAmount format (non-numeric)', () => {
    // Arrange
    const invalidMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-001',
      timestamp: '2026-02-02T12:00:00.000Z',
      senderId: 'peer-bob',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 5,
      transferredAmount: 'invalid-amount',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      'Invalid transferredAmount (expected non-negative integer string)'
    );
  });

  it('should reject missing EVM transferredAmount', () => {
    // Arrange
    const invalidMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-001',
      timestamp: '2026-02-02T12:00:00.000Z',
      senderId: 'peer-bob',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 5,
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      'Missing or invalid transferredAmount (expected non-empty string)'
    );
  });

  it('should reject invalid EVM signerAddress format (missing 0x prefix)', () => {
    // Arrange
    const invalidMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-001',
      timestamp: '2026-02-02T12:00:00.000Z',
      senderId: 'peer-bob',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 5,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      'Invalid signerAddress format (expected 0x-prefixed 40-char hex)'
    );
  });

  it('should reject invalid EVM signerAddress format (wrong length)', () => {
    // Arrange
    const invalidMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-001',
      timestamp: '2026-02-02T12:00:00.000Z',
      senderId: 'peer-bob',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 5,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x1234',
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      'Invalid signerAddress format (expected 0x-prefixed 40-char hex)'
    );
  });
});

describe('Type Guards', () => {
  const evmClaim: EVMClaimMessage = {
    version: '1.0',
    blockchain: 'evm',
    messageId: 'claim-evm-001',
    timestamp: '2026-02-02T12:00:00.000Z',
    senderId: 'peer-bob',
    channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
    nonce: 5,
    transferredAmount: '1000000000000000000',
    lockedAmount: '0',
    locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
    signature: '0xabcdef1234567890',
    signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
  };

  describe('isEVMClaim', () => {
    it('should return true for EVM claim', () => {
      expect(isEVMClaim(evmClaim)).toBe(true);
    });

    it('should narrow type to EVMClaimMessage', () => {
      const claim: BTPClaimMessage = evmClaim;
      if (isEVMClaim(claim)) {
        // TypeScript should recognize claim.nonce exists
        expect(claim.nonce).toBeDefined();
        expect(claim.channelId).toBeDefined();
        expect(claim.transferredAmount).toBeDefined();
        expect(claim.signerAddress).toBeDefined();
      }
    });
  });
});

describe('validateClaimMessage - Epic 31 Self-Describing Fields', () => {
  it('should accept valid EVM claim WITH all three new fields', () => {
    // Arrange
    const validEVMClaimWithFields: EVMClaimMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-evm-002',
      timestamp: '2026-03-07T12:00:00.000Z',
      senderId: 'peer-charlie',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 10,
      transferredAmount: '2000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
      chainId: 8453,
      tokenNetworkAddress: '0x1234567890123456789012345678901234567890',
      tokenAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    };

    // Act & Assert
    expect(() => validateClaimMessage(validEVMClaimWithFields)).not.toThrow();
  });

  it('should accept valid EVM claim WITHOUT new fields (backward compatibility)', () => {
    // Arrange
    const validEVMClaimWithoutFields: EVMClaimMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-evm-003',
      timestamp: '2026-03-07T12:00:00.000Z',
      senderId: 'peer-dave',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 15,
      transferredAmount: '3000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    };

    // Act & Assert
    expect(() => validateClaimMessage(validEVMClaimWithoutFields)).not.toThrow();
  });

  it('should reject invalid chainId (zero)', () => {
    // Arrange
    const invalidMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-001',
      timestamp: '2026-03-07T12:00:00.000Z',
      senderId: 'peer-eve',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 5,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
      chainId: 0,
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      'Invalid chainId (expected positive integer)'
    );
  });

  it('should reject invalid chainId (negative)', () => {
    // Arrange
    const invalidMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-001',
      timestamp: '2026-03-07T12:00:00.000Z',
      senderId: 'peer-eve',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 5,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
      chainId: -1,
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      'Invalid chainId (expected positive integer)'
    );
  });

  it('should reject invalid chainId (fractional)', () => {
    // Arrange
    const invalidMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-001',
      timestamp: '2026-03-07T12:00:00.000Z',
      senderId: 'peer-eve',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 5,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
      chainId: 1.5,
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      'Invalid chainId (expected positive integer)'
    );
  });

  it('should reject invalid chainId (string type)', () => {
    // Arrange
    const invalidMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-001',
      timestamp: '2026-03-07T12:00:00.000Z',
      senderId: 'peer-eve',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 5,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
      chainId: '8453',
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      'Invalid chainId (expected positive integer)'
    );
  });

  it('should reject invalid tokenNetworkAddress (missing 0x prefix)', () => {
    // Arrange
    const invalidMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-001',
      timestamp: '2026-03-07T12:00:00.000Z',
      senderId: 'peer-eve',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 5,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
      tokenNetworkAddress: '1234567890123456789012345678901234567890',
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      'Invalid tokenNetworkAddress format (expected 0x-prefixed 40-char hex)'
    );
  });

  it('should reject invalid tokenNetworkAddress (wrong length)', () => {
    // Arrange
    const invalidMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-001',
      timestamp: '2026-03-07T12:00:00.000Z',
      senderId: 'peer-eve',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 5,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
      tokenNetworkAddress: '0x1234',
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      'Invalid tokenNetworkAddress format (expected 0x-prefixed 40-char hex)'
    );
  });

  it('should reject invalid tokenAddress (missing 0x prefix)', () => {
    // Arrange
    const invalidMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-001',
      timestamp: '2026-03-07T12:00:00.000Z',
      senderId: 'peer-eve',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 5,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
      tokenAddress: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      'Invalid tokenAddress format (expected 0x-prefixed 40-char hex)'
    );
  });

  it('should reject invalid tokenAddress (wrong length)', () => {
    // Arrange
    const invalidMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-001',
      timestamp: '2026-03-07T12:00:00.000Z',
      senderId: 'peer-eve',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 5,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
      tokenAddress: '0xabcd',
    };

    // Act & Assert
    expect(() => validateClaimMessage(invalidMessage)).toThrow(
      'Invalid tokenAddress format (expected 0x-prefixed 40-char hex)'
    );
  });

  it('should accept partial new fields (only chainId)', () => {
    // Arrange
    const partialFieldsMessage: EVMClaimMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-partial-001',
      timestamp: '2026-03-07T12:00:00.000Z',
      senderId: 'peer-frank',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 20,
      transferredAmount: '4000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
      chainId: 84532,
    };

    // Act & Assert
    expect(() => validateClaimMessage(partialFieldsMessage)).not.toThrow();
  });

  it('should accept partial new fields (only tokenNetworkAddress)', () => {
    // Arrange
    const partialFieldsMessage: EVMClaimMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-partial-002',
      timestamp: '2026-03-07T12:00:00.000Z',
      senderId: 'peer-grace',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 25,
      transferredAmount: '5000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
      tokenNetworkAddress: '0xfedcbafedcbafedcbafedcbafedcbafedcbafed1',
    };

    // Act & Assert
    expect(() => validateClaimMessage(partialFieldsMessage)).not.toThrow();
  });
});

describe('JSON Serialization Round-Trip', () => {
  it('should serialize and deserialize EVM claim correctly', () => {
    // Arrange
    const originalClaim: EVMClaimMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-evm-001',
      timestamp: '2026-02-02T12:00:00.000Z',
      senderId: 'peer-bob',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 5,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    };

    // Act
    const serialized = JSON.stringify(originalClaim);
    const deserialized = JSON.parse(serialized);
    validateClaimMessage(deserialized);

    // Assert
    expect(deserialized).toEqual(originalClaim);
    expect(isEVMClaim(deserialized)).toBe(true);
  });

  it('should serialize and deserialize EVM claim with new fields correctly', () => {
    // Arrange
    const originalClaimWithFields: EVMClaimMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-evm-004',
      timestamp: '2026-03-07T12:00:00.000Z',
      senderId: 'peer-henry',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 30,
      transferredAmount: '6000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
      chainId: 8453,
      tokenNetworkAddress: '0x9876543210987654321098765432109876543210',
      tokenAddress: '0x1111222233334444555566667777888899990000',
    };

    // Act
    const serialized = JSON.stringify(originalClaimWithFields);
    const deserialized = JSON.parse(serialized);
    validateClaimMessage(deserialized);

    // Assert
    expect(deserialized).toEqual(originalClaimWithFields);
    expect(isEVMClaim(deserialized)).toBe(true);
    if (isEVMClaim(deserialized)) {
      expect(deserialized.chainId).toBe(8453);
      expect(deserialized.tokenNetworkAddress).toBe('0x9876543210987654321098765432109876543210');
      expect(deserialized.tokenAddress).toBe('0x1111222233334444555566667777888899990000');
    }
  });
});

describe('validateClaimMessage - Solana Claim Validation (Epic 33 Prep)', () => {
  const validSolanaClaim: SolanaClaimMessage = {
    version: '1.0',
    blockchain: 'solana',
    messageId: 'claim-sol-001',
    timestamp: '2026-03-25T12:00:00.000Z',
    senderId: 'peer-alice',
    programId: '11111111111111111111111111111111',
    channelAccount: '22222222222222222222222222222222',
    nonce: 1,
    transferredAmount: '1000000000',
    signature: 'c2lnbmF0dXJlLWRhdGE=',
    signerPublicKey: '33333333333333333333333333333333',
  };

  it('should accept valid Solana claim message', () => {
    expect(() => validateClaimMessage(validSolanaClaim)).not.toThrow();
  });

  it('should accept valid Solana claim with cluster field', () => {
    const claimWithCluster: SolanaClaimMessage = {
      ...validSolanaClaim,
      messageId: 'claim-sol-002',
      cluster: 'devnet',
    };
    expect(() => validateClaimMessage(claimWithCluster)).not.toThrow();
  });

  it('should narrow type via isSolanaClaim guard', () => {
    const claim: BTPClaimMessage = validSolanaClaim;
    expect(isSolanaClaim(claim)).toBe(true);
    if (isSolanaClaim(claim)) {
      expect(claim.programId).toBeDefined();
      expect(claim.channelAccount).toBeDefined();
      expect(claim.signerPublicKey).toBeDefined();
    }
  });

  it('should reject missing programId', () => {
    const invalid = { ...validSolanaClaim, programId: '' };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Missing or invalid programId (expected non-empty string)'
    );
  });

  it('should reject invalid programId format (not base58)', () => {
    const invalid = { ...validSolanaClaim, programId: '0xINVALID' };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Invalid programId format (expected base58-encoded Solana address)'
    );
  });

  it('should reject missing channelAccount', () => {
    const invalid = { ...validSolanaClaim, channelAccount: '' };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Missing or invalid channelAccount (expected non-empty string)'
    );
  });

  it('should reject invalid channelAccount format', () => {
    const invalid = { ...validSolanaClaim, channelAccount: 'short' };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Invalid channelAccount format (expected base58-encoded Solana address)'
    );
  });

  it('should reject negative nonce', () => {
    const invalid = { ...validSolanaClaim, nonce: -1 };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Missing or invalid nonce (expected non-negative integer)'
    );
  });

  it('should reject non-numeric transferredAmount', () => {
    const invalid = { ...validSolanaClaim, transferredAmount: 'abc' };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Invalid transferredAmount (expected non-negative integer string)'
    );
  });

  it('should reject missing signature', () => {
    const invalid = { ...validSolanaClaim, signature: '' };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Missing or invalid signature (expected non-empty string)'
    );
  });

  it('should reject missing signerPublicKey', () => {
    const invalid = { ...validSolanaClaim, signerPublicKey: '' };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Missing or invalid signerPublicKey (expected non-empty string)'
    );
  });

  it('should reject invalid signerPublicKey format', () => {
    const invalid = { ...validSolanaClaim, signerPublicKey: '0xNotBase58' };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Invalid signerPublicKey format (expected base58-encoded Solana public key)'
    );
  });

  it('should reject invalid cluster value', () => {
    const invalid = { ...validSolanaClaim, cluster: 'invalid-cluster' };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Invalid cluster (expected one of: mainnet-beta, devnet, testnet, localnet)'
    );
  });

  it('should serialize and deserialize Solana claim correctly', () => {
    const serialized = JSON.stringify(validSolanaClaim);
    const deserialized = JSON.parse(serialized);
    validateClaimMessage(deserialized);

    expect(deserialized).toEqual(validSolanaClaim);
    expect(isSolanaClaim(deserialized)).toBe(true);
  });
});

/**
 * Story 34.7: Mina Claim Message Types & Serialization
 *
 * Tests Mina claim validation, type guards, serialization, and backward compatibility.
 */
describe('validateClaimMessage - Mina Claim Validation (Story 34.7)', () => {
  const validMinaClaim: MinaClaimMessage = {
    version: '1.0',
    blockchain: 'mina',
    messageId: 'claim-mina-001',
    timestamp: '2026-03-28T12:00:00.000Z',
    senderId: 'peer-mina-alice',
    zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
    tokenId: 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf',
    balanceCommitment: '12345678901234567890123456789012345678901234567890',
    nonce: 1,
    proof: 'eyJwcm9vZiI6InRlc3QifQ==',
    salt: 'abcdef1234567890',
    network: 'devnet',
  };

  // T-34.7-01: BlockchainType union includes 'mina'
  it('[T-34.7-01] BlockchainType union includes mina (type check)', () => {
    const minaType: BlockchainType = 'mina';
    expect(minaType).toBe('mina');
  });

  // T-34.7-02: MinaClaimMessage has all required fields (type check)
  it('[T-34.7-02] MinaClaimMessage has all required fields', () => {
    // Type check: all required fields present at compile time
    const claim: MinaClaimMessage = validMinaClaim;
    expect(claim.blockchain).toBe('mina');
    expect(claim.zkAppAddress).toBeDefined();
    expect(claim.tokenId).toBeDefined();
    expect(claim.balanceCommitment).toBeDefined();
    expect(claim.nonce).toBeDefined();
    expect(claim.proof).toBeDefined();
    expect(claim.salt).toBeDefined();
    expect(claim.network).toBeDefined();
  });

  // T-34.7-03: isMinaClaim() type guard narrows correctly
  it('[T-34.7-03] isMinaClaim() narrows correctly', () => {
    const claim: BTPClaimMessage = validMinaClaim;
    expect(isMinaClaim(claim)).toBe(true);
    if (isMinaClaim(claim)) {
      expect(claim.zkAppAddress).toBeDefined();
      expect(claim.tokenId).toBeDefined();
      expect(claim.balanceCommitment).toBeDefined();
      expect(claim.proof).toBeDefined();
      expect(claim.salt).toBeDefined();
    }
  });

  // T-34.7-04: isEVMClaim() still narrows correctly (backward compat)
  it('[T-34.7-04] isEVMClaim() still narrows correctly (backward compat)', () => {
    const evmClaim: BTPClaimMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-evm-compat',
      timestamp: '2026-03-28T12:00:00.000Z',
      senderId: 'peer-bob',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 5,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    };
    expect(isEVMClaim(evmClaim)).toBe(true);
    expect(isMinaClaim(evmClaim)).toBe(false);
  });

  // T-34.7-05: isSolanaClaim() still narrows correctly (backward compat)
  it('[T-34.7-05] isSolanaClaim() still narrows correctly (backward compat)', () => {
    const solanaClaim: BTPClaimMessage = {
      version: '1.0',
      blockchain: 'solana',
      messageId: 'claim-sol-compat',
      timestamp: '2026-03-28T12:00:00.000Z',
      senderId: 'peer-carol',
      programId: '11111111111111111111111111111111',
      channelAccount: '22222222222222222222222222222222',
      nonce: 1,
      transferredAmount: '1000000000',
      signature: 'c2lnbmF0dXJlLWRhdGE=',
      signerPublicKey: '33333333333333333333333333333333',
    };
    expect(isSolanaClaim(solanaClaim)).toBe(true);
    expect(isMinaClaim(solanaClaim)).toBe(false);
  });

  // T-34.7-14: validateClaimMessage() accepts valid MinaClaimMessage
  it('[T-34.7-14] validateClaimMessage() accepts valid MinaClaimMessage', () => {
    expect(() => validateClaimMessage(validMinaClaim)).not.toThrow();
  });

  // Issue #114: optional self-describing signerPublicKey (base58 B62 address)
  it('should accept a valid Mina claim with signerPublicKey', () => {
    const claimWithSigner: MinaClaimMessage = {
      ...validMinaClaim,
      messageId: 'claim-mina-signer',
      signerPublicKey: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
    };
    expect(() => validateClaimMessage(claimWithSigner)).not.toThrow();
  });

  it('should reject an invalid signerPublicKey format on a Mina claim', () => {
    const invalid = { ...validMinaClaim, signerPublicKey: '0xNotABase58MinaAddress' };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Invalid signerPublicKey (expected B62-prefixed base58 Mina address, 55 chars)'
    );
  });

  // Accept valid Mina claim without optional network field
  it('should accept valid Mina claim without network field', () => {
    const claimWithoutNetwork: MinaClaimMessage = {
      ...validMinaClaim,
      messageId: 'claim-mina-002',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (claimWithoutNetwork as any).network;
    expect(() => validateClaimMessage(claimWithoutNetwork)).not.toThrow();
  });

  // T-34.7-06: Serialization to BTP protocolData JSON includes blockchain: 'mina'
  it('[T-34.7-06] Serialization includes blockchain=mina discriminator', () => {
    const serialized = JSON.stringify(validMinaClaim);
    const parsed = JSON.parse(serialized);
    expect(parsed.blockchain).toBe('mina');
    expect(parsed.zkAppAddress).toBe(validMinaClaim.zkAppAddress);
    expect(parsed.tokenId).toBe(validMinaClaim.tokenId);
    expect(parsed.balanceCommitment).toBe(validMinaClaim.balanceCommitment);
    expect(parsed.nonce).toBe(validMinaClaim.nonce);
    expect(parsed.proof).toBe(validMinaClaim.proof);
    expect(parsed.salt).toBe(validMinaClaim.salt);
    expect(parsed.network).toBe('devnet');
  });

  // T-34.7-07: Deserialization from JSON produces typed MinaClaimMessage
  it('[T-34.7-07] Deserialization from JSON produces MinaClaimMessage', () => {
    const serialized = JSON.stringify(validMinaClaim);
    const deserialized = JSON.parse(serialized);
    validateClaimMessage(deserialized);

    expect(deserialized).toEqual(validMinaClaim);
    expect(isMinaClaim(deserialized)).toBe(true);
  });

  // T-34.7-08: EVM deserialization unchanged (backward compat)
  it('[T-34.7-08] EVM deserialization unchanged (backward compat)', () => {
    const evmClaim: EVMClaimMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-evm-backcompat',
      timestamp: '2026-03-28T12:00:00.000Z',
      senderId: 'peer-bob',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 5,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    };
    const serialized = JSON.stringify(evmClaim);
    const deserialized = JSON.parse(serialized);
    validateClaimMessage(deserialized);
    expect(deserialized).toEqual(evmClaim);
    expect(isEVMClaim(deserialized)).toBe(true);
  });

  // T-34.7-09: Solana deserialization unchanged (backward compat)
  it('[T-34.7-09] Solana deserialization unchanged (backward compat)', () => {
    const solanaClaim: SolanaClaimMessage = {
      version: '1.0',
      blockchain: 'solana',
      messageId: 'claim-sol-backcompat',
      timestamp: '2026-03-28T12:00:00.000Z',
      senderId: 'peer-carol',
      programId: '11111111111111111111111111111111',
      channelAccount: '22222222222222222222222222222222',
      nonce: 1,
      transferredAmount: '1000000000',
      signature: 'c2lnbmF0dXJlLWRhdGE=',
      signerPublicKey: '33333333333333333333333333333333',
    };
    const serialized = JSON.stringify(solanaClaim);
    const deserialized = JSON.parse(serialized);
    validateClaimMessage(deserialized);
    expect(deserialized).toEqual(solanaClaim);
    expect(isSolanaClaim(deserialized)).toBe(true);
  });

  // T-34.7-10: Missing required field rejected by validateClaimMessage()
  it('[T-34.7-10] Missing zkAppAddress rejected', () => {
    const invalid = { ...validMinaClaim, zkAppAddress: '' };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Missing or invalid zkAppAddress (expected non-empty string)'
    );
  });

  it('Missing tokenId rejected', () => {
    const invalid = { ...validMinaClaim, tokenId: '' };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Missing or invalid tokenId (expected non-empty string)'
    );
  });

  it('Missing balanceCommitment rejected', () => {
    const invalid = { ...validMinaClaim, balanceCommitment: '' };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Missing or invalid balanceCommitment (expected non-empty string)'
    );
  });

  it('Missing proof rejected', () => {
    const invalid = { ...validMinaClaim, proof: '' };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Missing or invalid proof (expected non-empty string)'
    );
  });

  it('Missing salt rejected', () => {
    const invalid = { ...validMinaClaim, salt: '' };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Missing or invalid salt (expected non-empty string)'
    );
  });

  it('Negative nonce rejected', () => {
    const invalid = { ...validMinaClaim, nonce: -1 };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Missing or invalid nonce (expected non-negative integer)'
    );
  });

  it('Fractional nonce rejected', () => {
    const invalid = { ...validMinaClaim, nonce: 1.5 };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Missing or invalid nonce (expected non-negative integer)'
    );
  });

  it('Invalid proof format rejected (not base64)', () => {
    const invalid = { ...validMinaClaim, proof: 'not-valid-base64!!!' };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Invalid proof format (expected base64-encoded zk-SNARK proof)'
    );
  });

  // T-34.7-15: validateClaimMessage() rejects invalid balanceCommitment/zkAppAddress format
  it('[T-34.7-15] Invalid zkAppAddress format rejected (not B62 prefix)', () => {
    const invalid = {
      ...validMinaClaim,
      zkAppAddress: 'InvalidAddress12345678901234567890123456789012345678901',
    };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Invalid zkAppAddress format (expected B62-prefixed base58 Mina address, 55 chars)'
    );
  });

  it('Invalid zkAppAddress format rejected (wrong length)', () => {
    const invalid = { ...validMinaClaim, zkAppAddress: 'B62short' };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Invalid zkAppAddress format (expected B62-prefixed base58 Mina address, 55 chars)'
    );
  });

  it('Invalid network value rejected', () => {
    const invalid = { ...validMinaClaim, network: 'invalid-network' };
    expect(() => validateClaimMessage(invalid)).toThrow(
      'Invalid network (expected one of: mainnet, devnet, berkeley, lightnet)'
    );
  });

  it('Valid network values accepted', () => {
    for (const network of ['mainnet', 'devnet', 'berkeley', 'lightnet']) {
      const claim = { ...validMinaClaim, messageId: `claim-mina-${network}`, network };
      expect(() => validateClaimMessage(claim)).not.toThrow();
    }
  });

  // T-34.7-16: NIP-59 wrapped claim uses claim-wrapped protocol name (reference only)
  it('[T-34.7-16] BTP_CLAIM_PROTOCOL constants unchanged after Mina addition', () => {
    expect(BTP_CLAIM_PROTOCOL.NAME).toBe('payment-channel-claim');
    expect(BTP_CLAIM_PROTOCOL.CONTENT_TYPE).toBe(1);
    expect(BTP_CLAIM_PROTOCOL.VERSION).toBe('1.0');
  });
});
