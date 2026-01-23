/**
 * Unit tests for ClaimSigner
 *
 * Refactored for Story 12.2 to use KeyManager instead of direct wallet access.
 *
 * File: packages/connector/src/settlement/xrp-claim-signer.test.ts
 */
import { ClaimSigner } from './xrp-claim-signer';
import { Database } from 'better-sqlite3';
import pino from 'pino';
import { KeyManager } from '../security/key-manager';

describe('ClaimSigner', () => {
  let signer: ClaimSigner;
  let mockDatabase: jest.Mocked<Database>;
  let mockLogger: jest.Mocked<pino.Logger>;
  let mockKeyManager: jest.Mocked<KeyManager>;
  const testXrpKeyId = 'test-xrp-key';

  // Test ed25519 public key (32 bytes) - for mocking
  const testPublicKeyBuffer = Buffer.from(
    '0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF',
    'hex'
  );

  // Test signature (64 bytes) - for mocking
  const testSignatureBuffer = Buffer.from(
    'ABCD'.repeat(32), // 128 hex chars = 64 bytes
    'hex'
  );

  beforeEach(() => {
    mockDatabase = {
      prepare: jest.fn().mockReturnValue({
        run: jest.fn(),
        get: jest.fn().mockReturnValue(null),
      }),
    } as unknown as jest.Mocked<Database>;

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      child: jest.fn().mockReturnThis(),
      debug: jest.fn(),
    } as unknown as jest.Mocked<pino.Logger>;

    mockKeyManager = {
      sign: jest.fn().mockResolvedValue(testSignatureBuffer),
      getPublicKey: jest.fn().mockResolvedValue(testPublicKeyBuffer),
      rotateKey: jest.fn(),
    } as unknown as jest.Mocked<KeyManager>;

    signer = new ClaimSigner(mockDatabase, mockLogger, mockKeyManager, testXrpKeyId);
  });

  describe('constructor and getPublicKey()', () => {
    it('should delegate getPublicKey() to KeyManager', async () => {
      const publicKey = await signer.getPublicKey();

      expect(mockKeyManager.getPublicKey).toHaveBeenCalledWith(testXrpKeyId);
      expect(publicKey).toBeDefined();
      expect(typeof publicKey).toBe('string');
    });

    it('should return 66-character hex public key with ED prefix', async () => {
      const publicKey = await signer.getPublicKey();

      expect(publicKey.length).toBe(66);
      expect(publicKey).toMatch(/^ED[0-9A-F]{64}$/i);
      expect(publicKey).toBe('ED' + testPublicKeyBuffer.toString('hex').toUpperCase());
    });

    it('should convert buffer to hex with ED prefix', async () => {
      const publicKey = await signer.getPublicKey();

      expect(publicKey.startsWith('ED')).toBe(true);
      expect(publicKey.length).toBe(66);
    });
  });

  describe('signClaim()', () => {
    it('should sign claim successfully using KeyManager', async () => {
      const channelId = 'A'.repeat(64); // 64-char hex channel ID
      const amount = '1000000000'; // 1,000 XRP

      const signature = await signer.signClaim(channelId, amount);

      expect(mockKeyManager.sign).toHaveBeenCalledWith(expect.any(Buffer), testXrpKeyId);
      expect(signature).toBeDefined();
      expect(typeof signature).toBe('string');
      expect(signature.length).toBe(128); // ed25519 signature = 128 hex chars
    });

    it('should create correct claim message format', async () => {
      const channelId = 'ABCD'.repeat(16); // 64-char hex
      const amount = '1000000000';

      await signer.signClaim(channelId, amount);

      // Verify sign() was called with correct message format
      expect(mockKeyManager.sign).toHaveBeenCalled();
      const callArgs = (mockKeyManager.sign as jest.Mock).mock.calls[0];
      const message = callArgs[0] as Buffer;

      // Message should be: 'CLM\0' (4 bytes) + channelId (32 bytes) + amount (8 bytes) = 44 bytes
      expect(message.length).toBe(44);

      // First 4 bytes should be 'CLM\0'
      expect(message.slice(0, 4).toString('ascii')).toBe('CLM\0');

      // Next 32 bytes should be channelId
      expect(message.slice(4, 36).toString('hex').toUpperCase()).toBe(channelId.toUpperCase());

      // Last 8 bytes should be amount as uint64 big-endian
      const amountFromMessage = message.readBigUInt64BE(36);
      expect(amountFromMessage.toString()).toBe(amount);
    });

    it('should throw error for invalid channelId', async () => {
      await expect(signer.signClaim('invalid', '1000000000')).rejects.toThrow('Invalid channelId');
    });

    it('should throw error for non-hex channelId', async () => {
      await expect(signer.signClaim('Z'.repeat(64), '1000000000')).rejects.toThrow(
        'Invalid channelId: must be valid hex string'
      );
    });

    it('should throw error for zero amount', async () => {
      const channelId = 'A'.repeat(64);
      await expect(signer.signClaim(channelId, '0')).rejects.toThrow('Amount must be positive');
    });

    it('should throw error for negative amount', async () => {
      const channelId = 'A'.repeat(64);
      await expect(signer.signClaim(channelId, '-1000')).rejects.toThrow();
    });

    it('should throw error for non-monotonic amount', async () => {
      const channelId = 'A'.repeat(64);

      // Mock previous claim with amount 1000 XRP
      mockDatabase.prepare = jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue({
          channel_id: channelId,
          amount: '1000000000',
          signature: 'sig1',
          public_key: 'pk1',
          created_at: Date.now() - 10000,
        }),
        run: jest.fn(),
      });

      // Try to sign claim with same amount (not allowed)
      await expect(signer.signClaim(channelId, '1000000000')).rejects.toThrow(
        'must be greater than previous claim'
      );
    });

    it('should store claim in database with signature from KeyManager', async () => {
      const channelId = 'A'.repeat(64);
      const amount = '1000000000';

      const runMock = jest.fn();
      mockDatabase.prepare = jest.fn().mockReturnValue({
        run: runMock,
        get: jest.fn().mockReturnValue(null),
      });

      await signer.signClaim(channelId, amount);

      expect(runMock).toHaveBeenCalledWith(
        channelId,
        amount,
        testSignatureBuffer.toString('hex').toUpperCase(), // signature from KeyManager
        'ED' + testPublicKeyBuffer.toString('hex').toUpperCase(), // public key from KeyManager
        expect.any(Number) // timestamp
      );
    });

    it('should convert signature buffer to uppercase hex string', async () => {
      const channelId = 'A'.repeat(64);
      const amount = '1000000000';

      const signature = await signer.signClaim(channelId, amount);

      expect(signature).toBe(testSignatureBuffer.toString('hex').toUpperCase());
      expect(signature).toMatch(/^[0-9A-F]+$/);
    });
  });

  describe('verifyClaim()', () => {
    it('should call KeyManager.sign() with correct parameters', async () => {
      const channelId = 'A'.repeat(64);
      const amount = '1000000000';

      await signer.signClaim(channelId, amount);

      // Verify KeyManager.sign() was called with correct message format
      expect(mockKeyManager.sign).toHaveBeenCalledWith(expect.any(Buffer), testXrpKeyId);

      // Verify the message passed to sign() has correct structure
      const callArgs = (mockKeyManager.sign as jest.Mock).mock.calls[0];
      const message = callArgs[0] as Buffer;

      // Message should be encoded claim data (not testing exact length as it depends on ripple-binary-codec)
      expect(message).toBeInstanceOf(Buffer);
      expect(message.length).toBeGreaterThan(0);
    });

    it('should reject invalid signature', async () => {
      const channelId = 'A'.repeat(64);
      const amount = '1000000000';
      const invalidSignature = 'B'.repeat(128);
      const publicKey = await signer.getPublicKey();

      const isValid = await signer.verifyClaim(channelId, amount, invalidSignature, publicKey);

      expect(isValid).toBe(false);
    });

    it('should reject claim exceeding channel balance', async () => {
      const channelId = 'A'.repeat(64);
      const amount = '2000000000'; // 2,000 XRP
      const channelAmount = '1000000000'; // Channel only has 1,000 XRP

      const signature = await signer.signClaim(channelId, amount);
      const publicKey = await signer.getPublicKey();

      const isValid = await signer.verifyClaim(
        channelId,
        amount,
        signature,
        publicKey,
        channelAmount
      );

      expect(isValid).toBe(false);
    });

    it('should reject invalid channelId format', async () => {
      const isValid = await signer.verifyClaim(
        'invalid',
        '1000000000',
        'A'.repeat(128),
        'ED' + 'A'.repeat(64)
      );

      expect(isValid).toBe(false);
    });

    it('should reject non-hex channelId', async () => {
      const isValid = await signer.verifyClaim(
        'Z'.repeat(64),
        '1000000000',
        'A'.repeat(128),
        'ED' + 'A'.repeat(64)
      );

      expect(isValid).toBe(false);
    });

    it('should reject invalid signature format', async () => {
      const isValid = await signer.verifyClaim(
        'A'.repeat(64),
        '1000000000',
        'invalid',
        'ED' + 'A'.repeat(64)
      );

      expect(isValid).toBe(false);
    });

    it('should reject non-hex signature', async () => {
      const isValid = await signer.verifyClaim(
        'A'.repeat(64),
        '1000000000',
        'Z'.repeat(128),
        'ED' + 'A'.repeat(64)
      );

      expect(isValid).toBe(false);
    });

    it('should reject invalid public key format', async () => {
      const isValid = await signer.verifyClaim(
        'A'.repeat(64),
        '1000000000',
        'A'.repeat(128),
        'invalid'
      );

      expect(isValid).toBe(false);
    });

    it('should reject public key without ED prefix', async () => {
      const isValid = await signer.verifyClaim(
        'A'.repeat(64),
        '1000000000',
        'A'.repeat(128),
        'AA' + 'A'.repeat(64)
      );

      expect(isValid).toBe(false);
    });

    it('should reject non-hex public key', async () => {
      const isValid = await signer.verifyClaim(
        'A'.repeat(64),
        '1000000000',
        'A'.repeat(128),
        'EDZ' + 'Z'.repeat(63)
      );

      expect(isValid).toBe(false);
    });
  });

  describe('getLatestClaim()', () => {
    it('should return latest claim for channel', async () => {
      const channelId = 'A'.repeat(64);
      const mockClaim = {
        channel_id: channelId,
        amount: '1000000000',
        signature: 'sig123',
        public_key: 'pk123',
        created_at: Date.now(),
      };

      mockDatabase.prepare = jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue(mockClaim),
      });

      const claim = await signer.getLatestClaim(channelId);

      expect(claim).toMatchObject({
        channelId: mockClaim.channel_id,
        amount: mockClaim.amount,
        signature: mockClaim.signature,
        publicKey: mockClaim.public_key,
      });
    });

    it('should return null when no claims exist', async () => {
      mockDatabase.prepare = jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue(null),
      });

      const claim = await signer.getLatestClaim('A'.repeat(64));

      expect(claim).toBeNull();
    });
  });
});
