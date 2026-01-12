/**
 * Unit tests for WalletSeedManager
 * @packageDocumentation
 */

import * as bip39 from 'bip39';
import { promises as fs } from 'fs';
import {
  WalletSeedManager,
  InvalidMnemonicError,
  DecryptionError,
  InvalidBackupError,
  WeakPasswordError,
} from './wallet-seed-manager';

// Mock fs module
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    mkdir: jest.fn(),
  },
}));

// Mock pino logger
jest.mock('pino', () => {
  return jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }));
});

describe('WalletSeedManager', () => {
  let manager: WalletSeedManager;
  const strongPassword = 'StrongP@ssw0rd123456';
  const weakPassword = 'weak';

  // Known test vector from BIP-39 spec
  const testMnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const testSeed = Buffer.from(
    '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4',
    'hex'
  );

  beforeEach(async () => {
    jest.clearAllMocks();

    // Mock filesystem operations
    (fs.readFile as jest.Mock).mockImplementation((path: string) => {
      if (path.includes('encryption-salt')) {
        // Return consistent salt for testing
        return Promise.resolve(Buffer.alloc(32, 'test-salt'));
      }
      throw new Error('File not found');
    });

    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);

    // Create manager instance
    manager = new WalletSeedManager();
    await manager.initialize();
  });

  describe('Initialization', () => {
    it('should initialize salt on first run', async () => {
      // Mock: salt file does not exist
      (fs.readFile as jest.Mock).mockRejectedValueOnce(new Error('File not found'));
      (fs.writeFile as jest.Mock).mockResolvedValueOnce(undefined);

      const newManager = new WalletSeedManager();
      await newManager.initialize();

      // Verify salt was written
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('encryption-salt'),
        expect.any(Buffer)
      );
    });

    it('should load existing salt on subsequent runs', async () => {
      const mockSalt = Buffer.alloc(32, 'existing-salt');
      (fs.readFile as jest.Mock).mockResolvedValueOnce(mockSalt);

      const newManager = new WalletSeedManager();
      await newManager.initialize();

      // Verify salt was loaded (not generated)
      expect(fs.readFile).toHaveBeenCalledWith(expect.stringContaining('encryption-salt'));
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('should use same salt across multiple instances', async () => {
      const mockSalt = Buffer.alloc(32, 'shared-salt');
      (fs.readFile as jest.Mock).mockResolvedValue(mockSalt);

      // Clear previous mock calls from beforeEach
      jest.clearAllMocks();

      const manager1 = new WalletSeedManager();
      await manager1.initialize();

      const manager2 = new WalletSeedManager();
      await manager2.initialize();

      // Both instances should load the same salt
      expect(fs.readFile).toHaveBeenCalledTimes(2);
      expect(fs.readFile).toHaveBeenCalledWith(expect.stringContaining('encryption-salt'));
    });
  });

  describe('Password Validation', () => {
    it('should accept strong password (16+ chars, uppercase, lowercase, number, symbol)', () => {
      expect(() => manager.validatePassword('StrongP@ssw0rd123456')).not.toThrow();
      expect(manager.validatePassword('StrongP@ssw0rd123456')).toBe(true);
    });

    it('should reject password that is too short', () => {
      expect(() => manager.validatePassword('Short1!')).toThrow(WeakPasswordError);
      expect(() => manager.validatePassword('Short1!')).toThrow(
        'Password must be at least 16 characters long'
      );
    });

    it('should reject password without uppercase letter', () => {
      expect(() => manager.validatePassword('nouppercase123!!')).toThrow(WeakPasswordError);
      expect(() => manager.validatePassword('nouppercase123!!')).toThrow(
        'Password must contain at least one uppercase letter'
      );
    });

    it('should reject password without lowercase letter', () => {
      expect(() => manager.validatePassword('NOLOWERCASE123!!')).toThrow(WeakPasswordError);
      expect(() => manager.validatePassword('NOLOWERCASE123!!')).toThrow(
        'Password must contain at least one lowercase letter'
      );
    });

    it('should reject password without number', () => {
      expect(() => manager.validatePassword('NoNumberHere!!!!')).toThrow(WeakPasswordError);
      expect(() => manager.validatePassword('NoNumberHere!!!!')).toThrow(
        'Password must contain at least one number'
      );
    });

    it('should reject password without symbol', () => {
      expect(() => manager.validatePassword('NoSymbol12345678')).toThrow(WeakPasswordError);
      expect(() => manager.validatePassword('NoSymbol12345678')).toThrow(
        'Password must contain at least one symbol'
      );
    });
  });

  describe('Master Seed Generation', () => {
    it('should generate 12-word mnemonic (128-bit entropy)', async () => {
      const masterSeed = await manager.generateMasterSeed(128);

      expect(masterSeed.mnemonic.split(' ')).toHaveLength(12);
      expect(masterSeed.seed).toBeInstanceOf(Buffer);
      expect(masterSeed.seed).toHaveLength(64); // 512 bits = 64 bytes
      expect(bip39.validateMnemonic(masterSeed.mnemonic)).toBe(true);
      expect(masterSeed.createdAt).toBeGreaterThan(0);
    });

    it('should generate 24-word mnemonic (256-bit entropy)', async () => {
      const masterSeed = await manager.generateMasterSeed(256);

      expect(masterSeed.mnemonic.split(' ')).toHaveLength(24);
      expect(masterSeed.seed).toBeInstanceOf(Buffer);
      expect(masterSeed.seed).toHaveLength(64); // 512 bits = 64 bytes
      expect(bip39.validateMnemonic(masterSeed.mnemonic)).toBe(true);
      expect(masterSeed.createdAt).toBeGreaterThan(0);
    });

    it('should generate unique mnemonics for each call', async () => {
      const seed1 = await manager.generateMasterSeed(256);
      const seed2 = await manager.generateMasterSeed(256);

      expect(seed1.mnemonic).not.toBe(seed2.mnemonic);
      expect(seed1.seed.equals(seed2.seed)).toBe(false);
    });
  });

  describe('Master Seed Import', () => {
    it('should import valid mnemonic and derive seed', async () => {
      const masterSeed = await manager.importMasterSeed(testMnemonic);

      expect(masterSeed.mnemonic).toBe(testMnemonic);
      expect(masterSeed.seed).toBeInstanceOf(Buffer);
      expect(masterSeed.seed).toHaveLength(64);
      // Verify seed matches expected test vector
      expect(masterSeed.seed.equals(testSeed)).toBe(true);
      expect(masterSeed.createdAt).toBeGreaterThan(0);
    });

    it('should reject invalid mnemonic (bad checksum)', async () => {
      const invalidMnemonic =
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'; // Invalid checksum

      await expect(manager.importMasterSeed(invalidMnemonic)).rejects.toThrow(InvalidMnemonicError);
      await expect(manager.importMasterSeed(invalidMnemonic)).rejects.toThrow(
        'Invalid mnemonic: checksum validation failed'
      );
    });

    it('should reject empty mnemonic', async () => {
      await expect(manager.importMasterSeed('')).rejects.toThrow(InvalidMnemonicError);
    });

    it('should reject mnemonic with invalid words', async () => {
      const invalidMnemonic = 'invalid words here that are not in the bip39 word list at all';

      await expect(manager.importMasterSeed(invalidMnemonic)).rejects.toThrow(InvalidMnemonicError);
    });
  });

  describe('Seed Encryption and Storage', () => {
    it('should encrypt and store seed with strong password', async () => {
      const masterSeed = await manager.generateMasterSeed(256);
      const encryptedData = await manager.encryptAndStore(masterSeed, strongPassword);

      expect(encryptedData).toBeDefined();
      expect(typeof encryptedData).toBe('string');
      expect(encryptedData.length).toBeGreaterThan(0);

      // Verify file system write was called
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('master-seed.enc'),
        encryptedData,
        'utf8'
      );
    });

    it('should fail to encrypt with weak password', async () => {
      const masterSeed = await manager.generateMasterSeed(256);

      await expect(manager.encryptAndStore(masterSeed, weakPassword)).rejects.toThrow(
        WeakPasswordError
      );
    });

    it('should create storage directory if not exists', async () => {
      const masterSeed = await manager.generateMasterSeed(256);
      await manager.encryptAndStore(masterSeed, strongPassword);

      expect(fs.mkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    });

    it('should produce different encrypted output for same seed with different passwords', async () => {
      const masterSeed = await manager.generateMasterSeed(256);
      const password1 = 'StrongP@ssw0rd123456';
      const password2 = 'DifferentP@ssw0rd789';

      const encrypted1 = await manager.encryptAndStore(masterSeed, password1);
      const encrypted2 = await manager.encryptAndStore(masterSeed, password2);

      expect(encrypted1).not.toBe(encrypted2);
    });

    it('should produce different encrypted output for same seed/password (random IV)', async () => {
      const masterSeed = await manager.generateMasterSeed(256);

      const encrypted1 = await manager.encryptAndStore(masterSeed, strongPassword);
      const encrypted2 = await manager.encryptAndStore(masterSeed, strongPassword);

      // Different IVs should produce different ciphertext
      expect(encrypted1).not.toBe(encrypted2);
    });
  });

  describe('Seed Decryption and Loading', () => {
    it('should decrypt and load seed with correct password', async () => {
      // Generate and encrypt seed
      const originalSeed = await manager.generateMasterSeed(256);
      const encryptedData = await manager.encryptAndStore(originalSeed, strongPassword);

      // Mock filesystem read to return encrypted data
      (fs.readFile as jest.Mock).mockResolvedValueOnce(encryptedData);

      // Decrypt and verify
      const decryptedSeed = await manager.decryptAndLoad(strongPassword);

      expect(decryptedSeed.mnemonic).toBe(originalSeed.mnemonic);
      expect(decryptedSeed.seed.equals(originalSeed.seed)).toBe(true);
    });

    it('should fail to decrypt with wrong password', async () => {
      // Generate and encrypt seed
      const masterSeed = await manager.generateMasterSeed(256);
      const encryptedData = await manager.encryptAndStore(masterSeed, 'Password123456!@');

      // Mock filesystem read to return encrypted data
      (fs.readFile as jest.Mock).mockImplementation((path: string) => {
        if (path.includes('encryption-salt')) {
          return Promise.resolve(Buffer.alloc(32, 'test-salt'));
        }
        if (path.includes('master-seed.enc')) {
          return Promise.resolve(encryptedData);
        }
        throw new Error('File not found');
      });

      // Attempt decrypt with wrong password
      await expect(manager.decryptAndLoad('WrongPassword123!')).rejects.toThrow(DecryptionError);
      await expect(manager.decryptAndLoad('WrongPassword123!')).rejects.toThrow(
        'Invalid password or corrupted data'
      );
    });

    it('should fail to decrypt corrupted data', async () => {
      // Generate and encrypt seed
      const masterSeed = await manager.generateMasterSeed(256);
      let encryptedData = await manager.encryptAndStore(masterSeed, strongPassword);

      // Corrupt the encrypted data
      const corrupted = Buffer.from(encryptedData, 'base64');
      corrupted[50] = corrupted[50]! ^ 0xff; // Flip bits in encrypted portion
      encryptedData = corrupted.toString('base64');

      // Mock filesystem read to return corrupted data
      (fs.readFile as jest.Mock).mockResolvedValueOnce(encryptedData);

      // Attempt decrypt
      await expect(manager.decryptAndLoad(strongPassword)).rejects.toThrow(DecryptionError);
    });

    it('should validate mnemonic checksum after decryption', async () => {
      // Use known test mnemonic
      const masterSeed = await manager.importMasterSeed(testMnemonic);
      const encryptedData = await manager.encryptAndStore(masterSeed, strongPassword);

      // Mock filesystem read
      (fs.readFile as jest.Mock).mockResolvedValueOnce(encryptedData);

      // Decrypt and verify
      const decryptedSeed = await manager.decryptAndLoad(strongPassword);

      expect(bip39.validateMnemonic(decryptedSeed.mnemonic)).toBe(true);
      expect(decryptedSeed.seed.equals(testSeed)).toBe(true);
    });
  });

  describe('Backup Export', () => {
    it('should export backup with checksum validation', async () => {
      const masterSeed = await manager.generateMasterSeed(256);
      const backup = await manager.exportBackup(masterSeed, strongPassword);

      expect(backup.version).toBe('1.0');
      expect(backup.createdAt).toBe(masterSeed.createdAt);
      expect(backup.encryptedSeed).toBeDefined();
      expect(backup.encryptedSeed.length).toBeGreaterThan(0);
      expect(backup.backupDate).toBeGreaterThan(0);
      expect(backup.checksum).toBeDefined();
      expect(backup.checksum.length).toBe(64); // SHA-256 hex = 64 characters
    });

    it('should calculate correct checksum', async () => {
      const masterSeed = await manager.generateMasterSeed(256);
      const backup = await manager.exportBackup(masterSeed, strongPassword);

      // Manually calculate checksum and verify
      const crypto = await import('crypto');
      const expectedChecksum = crypto
        .createHash('sha256')
        .update(backup.encryptedSeed)
        .digest('hex');

      expect(backup.checksum).toBe(expectedChecksum);
    });

    it('should export backup to JSON file', async () => {
      const masterSeed = await manager.generateMasterSeed(256);
      const backup = await manager.exportBackup(masterSeed, strongPassword);

      const filePath = await manager.exportBackupToFile(backup);

      expect(filePath).toContain('wallet-backup-');
      expect(filePath).toContain('.json');
      expect(fs.mkdir).toHaveBeenCalledWith('./backups', { recursive: true });
      expect(fs.writeFile).toHaveBeenCalledWith(
        filePath,
        expect.stringContaining(backup.version),
        'utf8'
      );
    });
  });

  describe('Backup Restore', () => {
    it('should restore seed from valid backup', async () => {
      // Create backup
      const originalSeed = await manager.generateMasterSeed(256);
      const backup = await manager.exportBackup(originalSeed, strongPassword);

      // Mock filesystem read to return encrypted data
      (fs.readFile as jest.Mock).mockImplementation((path: string) => {
        if (path.includes('master-seed.enc')) {
          return Promise.resolve(backup.encryptedSeed);
        }
        if (path.includes('encryption-salt')) {
          return Promise.resolve(Buffer.alloc(32, 'test-salt'));
        }
        throw new Error('File not found');
      });

      // Restore and verify
      const restoredSeed = await manager.restoreFromBackup(backup, strongPassword);

      expect(restoredSeed.mnemonic).toBe(originalSeed.mnemonic);
      expect(restoredSeed.seed.equals(originalSeed.seed)).toBe(true);
      expect(restoredSeed.createdAt).toBe(originalSeed.createdAt);
    });

    it('should fail to restore backup with corrupted checksum', async () => {
      const masterSeed = await manager.generateMasterSeed(256);
      const backup = await manager.exportBackup(masterSeed, strongPassword);

      // Corrupt checksum
      backup.checksum = 'invalid-checksum-that-wont-match';

      await expect(manager.restoreFromBackup(backup, strongPassword)).rejects.toThrow(
        InvalidBackupError
      );
      await expect(manager.restoreFromBackup(backup, strongPassword)).rejects.toThrow(
        'Backup integrity check failed: checksum mismatch'
      );
    });

    it('should fail to restore backup with tampered encrypted data', async () => {
      const masterSeed = await manager.generateMasterSeed(256);
      const backup = await manager.exportBackup(masterSeed, strongPassword);

      // Tamper with encrypted data (but leave checksum intact)
      const corrupted = Buffer.from(backup.encryptedSeed, 'base64');
      corrupted[10] = corrupted[10]! ^ 0xff;
      backup.encryptedSeed = corrupted.toString('base64');
      // Don't update checksum - this will be caught

      await expect(manager.restoreFromBackup(backup, strongPassword)).rejects.toThrow(
        InvalidBackupError
      );
    });
  });

  describe('Paper Wallet Generation', () => {
    it('should generate paper wallet with QR code', async () => {
      const masterSeed = await manager.generateMasterSeed(256);
      const paperWallet = await manager.generatePaperWallet(masterSeed);

      expect(paperWallet.mnemonic).toBe(masterSeed.mnemonic);
      expect(paperWallet.qrCodeDataUrl).toBeDefined();
      expect(paperWallet.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(paperWallet.createdAt).toBeGreaterThan(0);
    });

    it('should export paper wallet to HTML file', async () => {
      const masterSeed = await manager.generateMasterSeed(256);
      const paperWallet = await manager.generatePaperWallet(masterSeed);

      const filePath = await manager.exportPaperWallet(paperWallet);

      expect(filePath).toContain('paper-wallet-');
      expect(filePath).toContain('.html');
      expect(fs.mkdir).toHaveBeenCalledWith('./backups', { recursive: true });
      expect(fs.writeFile).toHaveBeenCalledWith(
        filePath,
        expect.stringContaining(paperWallet.mnemonic),
        'utf8'
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        filePath,
        expect.stringContaining(paperWallet.qrCodeDataUrl),
        'utf8'
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        filePath,
        expect.stringContaining('SECURITY WARNING'),
        'utf8'
      );
    });

    it('should include security warning in paper wallet HTML', async () => {
      const masterSeed = await manager.generateMasterSeed(256);
      const paperWallet = await manager.generatePaperWallet(masterSeed);

      await manager.exportPaperWallet(paperWallet);

      const writeCall = (fs.writeFile as jest.Mock).mock.calls.find(
        (call) => typeof call[1] === 'string' && call[1].includes('<!DOCTYPE html>')
      );

      expect(writeCall).toBeDefined();
      const html = writeCall![1] as string;
      expect(html).toContain('SECURITY WARNING');
      expect(html).toContain('unencrypted');
      expect(html).toContain('physically secure location');
    });
  });

  describe('Logger Integration', () => {
    it('should never log mnemonic or seed data', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pino = require('pino');
      const mockLogger = pino();

      const masterSeed = await manager.generateMasterSeed(256);
      await manager.encryptAndStore(masterSeed, strongPassword);

      // Check all logger calls
      const allCalls = [
        ...mockLogger.info.mock.calls,
        ...mockLogger.error.mock.calls,
        ...mockLogger.warn.mock.calls,
        ...mockLogger.debug.mock.calls,
      ];

      // Verify no sensitive data in logs
      for (const call of allCalls) {
        const logData = JSON.stringify(call);
        expect(logData).not.toContain(masterSeed.mnemonic);
        expect(logData).not.toContain(masterSeed.seed.toString('hex'));
        expect(logData).not.toContain(strongPassword);
      }
    });
  });

  describe('HSM/KMS Integration Points', () => {
    it('should use KeyManager for storage when provided', async () => {
      const mockKeyManager = {
        storeSecret: jest.fn().mockResolvedValue(undefined),
        retrieveSecret: jest.fn(),
        deleteSecret: jest.fn(),
      };

      const managerWithHSM = new WalletSeedManager(mockKeyManager, {
        storageBackend: 'hsm',
      });
      await managerWithHSM.initialize();

      const masterSeed = await managerWithHSM.generateMasterSeed(256);
      await managerWithHSM.encryptAndStore(masterSeed, strongPassword);

      // Verify KeyManager was called instead of filesystem
      expect(mockKeyManager.storeSecret).toHaveBeenCalledWith('master-seed', expect.any(String));
      expect(fs.writeFile).not.toHaveBeenCalledWith(
        expect.stringContaining('master-seed.enc'),
        expect.any(String),
        'utf8'
      );
    });

    it('should use KeyManager for retrieval when provided', async () => {
      const masterSeed = await manager.generateMasterSeed(256);
      const encryptedData = await manager.encryptAndStore(masterSeed, strongPassword);

      const mockKeyManager = {
        storeSecret: jest.fn(),
        retrieveSecret: jest.fn().mockResolvedValue(encryptedData),
        deleteSecret: jest.fn(),
      };

      const managerWithHSM = new WalletSeedManager(mockKeyManager, {
        storageBackend: 'hsm',
      });
      await managerWithHSM.initialize();

      const decryptedSeed = await managerWithHSM.decryptAndLoad(strongPassword);

      // Verify KeyManager was called instead of filesystem
      expect(mockKeyManager.retrieveSecret).toHaveBeenCalledWith('master-seed');
      expect(decryptedSeed.mnemonic).toBe(masterSeed.mnemonic);
    });

    it('should fall back to filesystem when KeyManager not provided', async () => {
      const managerNoHSM = new WalletSeedManager(undefined, {
        storageBackend: 'filesystem',
      });
      await managerNoHSM.initialize();

      const masterSeed = await managerNoHSM.generateMasterSeed(256);
      await managerNoHSM.encryptAndStore(masterSeed, strongPassword);

      // Verify filesystem was used
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('master-seed.enc'),
        expect.any(String),
        'utf8'
      );
    });
  });

  describe('Edge Cases', () => {
    it('should handle concurrent encryption operations', async () => {
      const seed1 = await manager.generateMasterSeed(256);
      const seed2 = await manager.generateMasterSeed(256);

      const [encrypted1, encrypted2] = await Promise.all([
        manager.encryptAndStore(seed1, strongPassword),
        manager.encryptAndStore(seed2, 'DifferentP@ss123456'),
      ]);

      expect(encrypted1).toBeDefined();
      expect(encrypted2).toBeDefined();
      expect(encrypted1).not.toBe(encrypted2);
    });

    it('should handle very long custom storage paths', async () => {
      const longPath = '/very/long/path/that/exceeds/normal/length/requirements/wallet/storage';
      const managerWithLongPath = new WalletSeedManager(undefined, {
        storageBackend: 'filesystem',
        storagePath: longPath,
      });
      await managerWithLongPath.initialize();

      const masterSeed = await managerWithLongPath.generateMasterSeed(256);
      await managerWithLongPath.encryptAndStore(masterSeed, strongPassword);

      expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining(longPath), {
        recursive: true,
      });
    });

    it('should handle special characters in mnemonic correctly', async () => {
      // Import and encrypt seed, then decrypt and verify
      const masterSeed = await manager.importMasterSeed(testMnemonic);
      const encryptedData = await manager.encryptAndStore(masterSeed, strongPassword);

      (fs.readFile as jest.Mock).mockResolvedValueOnce(encryptedData);

      const decryptedSeed = await manager.decryptAndLoad(strongPassword);

      // Verify mnemonic preserved exactly
      expect(decryptedSeed.mnemonic).toBe(testMnemonic);
    });
  });
});
