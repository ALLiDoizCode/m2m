/**
 * Unit tests for KeyRotationManager
 *
 * File: packages/connector/src/security/key-rotation-manager.test.ts
 */
import { KeyRotationManager } from './key-rotation-manager';
import { KeyManager, KeyRotationConfig } from './key-manager';
import pino from 'pino';

describe('KeyRotationManager', () => {
  let manager: KeyRotationManager;
  let mockKeyManager: jest.Mocked<KeyManager>;
  let mockLogger: jest.Mocked<pino.Logger>;
  let config: KeyRotationConfig;

  beforeEach(() => {
    mockKeyManager = {
      sign: jest.fn(),
      getPublicKey: jest.fn(),
      rotateKey: jest.fn().mockResolvedValue('new-key-id'),
    } as unknown as jest.Mocked<KeyManager>;

    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
    } as unknown as jest.Mocked<pino.Logger>;

    config = {
      enabled: true,
      intervalDays: 90,
      overlapDays: 7,
      notifyBeforeDays: 14,
    };

    manager = new KeyRotationManager(mockKeyManager, config, mockLogger);
  });

  afterEach(() => {
    manager.stop();
  });

  describe('constructor', () => {
    it('should initialize with valid configuration', () => {
      expect(manager).toBeDefined();
      expect(mockLogger.child).toHaveBeenCalledWith({ component: 'KeyRotationManager' });
    });

    it('should throw error for non-positive interval', () => {
      expect(() => {
        new KeyRotationManager(mockKeyManager, { ...config, intervalDays: 0 }, mockLogger);
      }).toThrow('Rotation interval must be positive');
    });

    it('should throw error for negative overlap days', () => {
      expect(() => {
        new KeyRotationManager(mockKeyManager, { ...config, overlapDays: -1 }, mockLogger);
      }).toThrow('Overlap days must be non-negative');
    });

    it('should throw error when overlap period >= rotation interval', () => {
      expect(() => {
        new KeyRotationManager(
          mockKeyManager,
          { ...config, intervalDays: 90, overlapDays: 90 },
          mockLogger
        );
      }).toThrow('Overlap period must be less than rotation interval');
    });
  });

  describe('start() and stop()', () => {
    it('should start rotation scheduler when enabled', () => {
      manager.start();

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          rotationIntervalDays: 90,
          overlapDays: 7,
          notifyBeforeDays: 14,
        }),
        'Key rotation scheduler started'
      );
    });

    it('should not start scheduler when disabled', () => {
      const disabledManager = new KeyRotationManager(
        mockKeyManager,
        { ...config, enabled: false },
        mockLogger
      );

      disabledManager.start();

      expect(mockLogger.info).toHaveBeenCalledWith('Key rotation is disabled in configuration');
    });

    it('should stop rotation scheduler', () => {
      manager.start();
      manager.stop();

      expect(mockLogger.info).toHaveBeenCalledWith('Key rotation scheduler stopped');
    });
  });

  describe('rotateKey()', () => {
    it('should initiate key rotation via KeyManager', async () => {
      const oldKeyId = 'old-key-id';

      const newKeyId = await manager.rotateKey(oldKeyId);

      expect(mockKeyManager.rotateKey).toHaveBeenCalledWith(oldKeyId);
      expect(newKeyId).toBe('new-key-id');
    });

    it('should log rotation start and completion', async () => {
      await manager.rotateKey('test-key');

      expect(mockLogger.info).toHaveBeenCalledWith({ keyId: 'test-key' }, 'Starting key rotation');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          oldKeyId: 'test-key',
          newKeyId: 'new-key-id',
          overlapDays: 7,
        }),
        'Key rotation completed - overlap period started'
      );
    });

    it('should store rotation metadata', async () => {
      const newKeyId = await manager.rotateKey('old-key');

      const metadata = manager.getRotationMetadata(newKeyId);
      expect(metadata).toBeDefined();
      expect(metadata!.oldKeyId).toBe('old-key');
      expect(metadata!.newKeyId).toBe('new-key-id');
    });

    it('should calculate overlap end time correctly', async () => {
      const beforeRotation = Date.now();
      const newKeyId = await manager.rotateKey('old-key');

      const metadata = manager.getRotationMetadata(newKeyId);
      const expectedOverlapEnd = metadata!.rotationDate + 7 * 24 * 60 * 60 * 1000;

      expect(metadata!.overlapEndsAt).toBe(expectedOverlapEnd);
      expect(metadata!.rotationDate).toBeGreaterThanOrEqual(beforeRotation);
    });

    it('should handle rotation failure', async () => {
      const error = new Error('KMS rotation failed');
      mockKeyManager.rotateKey = jest.fn().mockRejectedValue(error);

      await expect(manager.rotateKey('test-key')).rejects.toThrow('KMS rotation failed');

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          keyId: 'test-key',
          error,
        }),
        'Key rotation failed'
      );
    });
  });

  describe('isKeyValid()', () => {
    it('should return true for new key immediately after rotation', async () => {
      const newKeyId = await manager.rotateKey('old-key');

      expect(manager.isKeyValid(newKeyId)).toBe(true);
    });

    it('should return true for old key during overlap period', async () => {
      const oldKeyId = 'old-key';
      await manager.rotateKey(oldKeyId);

      // Old key should be valid during overlap (tested without advancing timers)
      expect(manager.isKeyValid(oldKeyId)).toBe(true);
    });

    it('should return true for keys not in rotation metadata', () => {
      // Keys not being rotated are assumed active
      expect(manager.isKeyValid('some-active-key')).toBe(true);
    });
  });

  describe('getRotationMetadata()', () => {
    it('should return metadata for new key', async () => {
      const newKeyId = await manager.rotateKey('old-key');

      const metadata = manager.getRotationMetadata(newKeyId);

      expect(metadata).toBeDefined();
      expect(metadata!.newKeyId).toBe(newKeyId);
      expect(metadata!.oldKeyId).toBe('old-key');
    });

    it('should return metadata for old key', async () => {
      const oldKeyId = 'old-key';
      await manager.rotateKey(oldKeyId);

      const metadata = manager.getRotationMetadata(oldKeyId);

      expect(metadata).toBeDefined();
      expect(metadata!.oldKeyId).toBe(oldKeyId);
      expect(metadata!.newKeyId).toBe('new-key-id');
    });

    it('should return undefined for keys not in rotation', () => {
      const metadata = manager.getRotationMetadata('unknown-key');

      expect(metadata).toBeUndefined();
    });
  });

  describe('getAllRotationMetadata()', () => {
    it('should return empty map when no rotations active', () => {
      const allMetadata = manager.getAllRotationMetadata();

      expect(allMetadata.size).toBe(0);
    });

    it('should return all active rotation metadata', async () => {
      mockKeyManager.rotateKey = jest
        .fn()
        .mockResolvedValueOnce('new-key-1')
        .mockResolvedValueOnce('new-key-2');

      const newKeyId1 = await manager.rotateKey('old-key-1');
      const newKeyId2 = await manager.rotateKey('old-key-2');

      const allMetadata = manager.getAllRotationMetadata();

      expect(allMetadata.size).toBe(2);
      expect(allMetadata.has(newKeyId1)).toBe(true);
      expect(allMetadata.has(newKeyId2)).toBe(true);
    });

    it('should return independent copy of metadata map', async () => {
      await manager.rotateKey('old-key');

      const metadata1 = manager.getAllRotationMetadata();
      const metadata2 = manager.getAllRotationMetadata();

      // Should be different objects
      expect(metadata1).not.toBe(metadata2);

      // But with same content
      expect(metadata1.size).toBe(metadata2.size);
    });
  });
});
