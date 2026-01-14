/**
 * Unit tests for ClaimSigner
 *
 * File: packages/connector/src/settlement/xrp-claim-signer.test.ts
 */
import { ClaimSigner } from './xrp-claim-signer';
import { Database } from 'better-sqlite3';
import pino from 'pino';

describe('ClaimSigner', () => {
  let signer: ClaimSigner;
  let mockDatabase: jest.Mocked<Database>;
  let mockLogger: jest.Mocked<pino.Logger>;

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
    } as unknown as jest.Mocked<pino.Logger>;

    // Use deterministic seed for reproducible tests
    const testSeed = 'sEdTM1uX8pu2do5XvTnutH6HsouMaM2';
    signer = new ClaimSigner(mockDatabase, mockLogger, testSeed);
  });

  describe('constructor and getPublicKey()', () => {
    it('should generate ed25519 keypair', () => {
      const publicKey = signer.getPublicKey();

      expect(publicKey).toBeDefined();
      expect(typeof publicKey).toBe('string');
    });

    it('should return 66-character hex public key', () => {
      const publicKey = signer.getPublicKey();

      expect(publicKey.length).toBe(66);
      expect(publicKey).toMatch(/^ED[0-9A-F]{64}$/i);
    });

    it('should initialize from seed (deterministic keypair)', () => {
      const seed = 'sEdTM1uX8pu2do5XvTnutH6HsouMaM2';
      const signer1 = new ClaimSigner(mockDatabase, mockLogger, seed);
      const signer2 = new ClaimSigner(mockDatabase, mockLogger, seed);

      const publicKey1 = signer1.getPublicKey();
      const publicKey2 = signer2.getPublicKey();

      expect(publicKey1).toBe(publicKey2);
      expect(publicKey1.length).toBe(66);
    });

    it('should generate different keypairs when no seed provided', () => {
      const signer1 = new ClaimSigner(mockDatabase, mockLogger);
      const signer2 = new ClaimSigner(mockDatabase, mockLogger);

      const publicKey1 = signer1.getPublicKey();
      const publicKey2 = signer2.getPublicKey();

      expect(publicKey1).not.toBe(publicKey2);
    });
  });

  describe('signClaim()', () => {
    it('should sign claim successfully', async () => {
      const channelId = 'A'.repeat(64); // 64-char hex channel ID
      const amount = '1000000000'; // 1,000 XRP

      const signature = await signer.signClaim(channelId, amount);

      expect(signature).toBeDefined();
      expect(typeof signature).toBe('string');
      expect(signature.length).toBe(128); // ed25519 signature = 128 hex chars
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

    it('should store claim in database', async () => {
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
        expect.any(String), // signature
        expect.any(String), // public key
        expect.any(Number) // timestamp
      );
    });
  });

  describe('verifyClaim()', () => {
    it('should verify valid claim signature', async () => {
      const channelId = 'A'.repeat(64);
      const amount = '1000000000';

      // Sign claim
      const signature = await signer.signClaim(channelId, amount);
      const publicKey = signer.getPublicKey();

      // Verify signature
      const isValid = await signer.verifyClaim(channelId, amount, signature, publicKey);

      expect(isValid).toBe(true);
    });

    it('should reject invalid signature', async () => {
      const channelId = 'A'.repeat(64);
      const amount = '1000000000';
      const invalidSignature = 'B'.repeat(128);
      const publicKey = signer.getPublicKey();

      const isValid = await signer.verifyClaim(channelId, amount, invalidSignature, publicKey);

      expect(isValid).toBe(false);
    });

    it('should reject claim exceeding channel balance', async () => {
      const channelId = 'A'.repeat(64);
      const amount = '2000000000'; // 2,000 XRP
      const channelAmount = '1000000000'; // Channel only has 1,000 XRP

      const signature = await signer.signClaim(channelId, amount);
      const publicKey = signer.getPublicKey();

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
