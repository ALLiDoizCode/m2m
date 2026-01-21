/**
 * Wallet Authentication Manager Tests
 * Story 11.9: Security Hardening for Agent Wallets
 */

import {
  WalletAuthenticationManager,
  AuthConfig,
  UnauthorizedError,
} from './wallet-authentication';
import pino from 'pino';

describe('WalletAuthenticationManager', () => {
  let authManager: WalletAuthenticationManager;
  let mockLogger: pino.Logger;

  const passwordConfig: AuthConfig = {
    method: 'password',
    passwordMinLength: 16,
    totpEnabled: false,
  };

  beforeEach(() => {
    mockLogger = pino({ level: 'silent' }); // Silent mode for tests
    authManager = new WalletAuthenticationManager(passwordConfig, mockLogger);
  });

  describe('constructor', () => {
    it('should create instance with password config', () => {
      expect(authManager).toBeDefined();
    });

    it('should throw error when 2FA enabled without TOTP secret', () => {
      const invalidConfig: AuthConfig = {
        method: '2fa',
        passwordMinLength: 16,
        totpEnabled: true,
        // Missing totpSecret
      };

      expect(() => new WalletAuthenticationManager(invalidConfig, mockLogger)).toThrow(
        'TOTP secret required when 2FA authentication enabled'
      );
    });

    it('should create instance with 2FA config when secret provided', () => {
      const validConfig: AuthConfig = {
        method: '2fa',
        passwordMinLength: 16,
        totpEnabled: true,
        totpSecret: 'JBSWY3DPEHPK3PXP', // Base32 encoded secret
      };

      const manager = new WalletAuthenticationManager(validConfig, mockLogger);
      expect(manager).toBeDefined();
    });
  });

  describe('setPassword', () => {
    it('should set password successfully with strong password', async () => {
      const strongPassword = 'ThisIsAVeryStrongPassword123!';

      await expect(authManager.setPassword(strongPassword)).resolves.not.toThrow();
    });

    it('should reject password shorter than minimum length', async () => {
      const weakPassword = 'short'; // Only 5 characters

      await expect(authManager.setPassword(weakPassword)).rejects.toThrow(
        'Password must be at least 16 characters long'
      );
    });

    it('should accept password exactly at minimum length', async () => {
      const minLengthPassword = '1234567890123456'; // Exactly 16 characters

      await expect(authManager.setPassword(minLengthPassword)).resolves.not.toThrow();
    });
  });

  describe('authenticatePassword', () => {
    const validPassword = 'ThisIsAVeryStrongPassword123!';
    const invalidPassword = 'WrongPasswordThatIsStrongEnough123!';

    beforeEach(async () => {
      await authManager.setPassword(validPassword);
    });

    it('should return true for correct password', async () => {
      const isValid = await authManager.authenticatePassword(validPassword);
      expect(isValid).toBe(true);
    });

    it('should return false for incorrect password', async () => {
      const isValid = await authManager.authenticatePassword(invalidPassword);
      expect(isValid).toBe(false);
    });

    it('should return false when no password configured', async () => {
      const newManager = new WalletAuthenticationManager(passwordConfig, mockLogger);
      // No password set yet

      const isValid = await newManager.authenticatePassword('anypassword1234567890');
      expect(isValid).toBe(false);
    });

    it('should use timing-safe comparison (same execution time for valid/invalid)', async () => {
      // Measure time for correct password
      const start1 = Date.now();
      await authManager.authenticatePassword(validPassword);
      const time1 = Date.now() - start1;

      // Measure time for incorrect password
      const start2 = Date.now();
      await authManager.authenticatePassword(invalidPassword);
      const time2 = Date.now() - start2;

      // Both should take roughly the same time (within 5ms tolerance)
      // This tests timing-safe comparison to prevent timing attacks
      const timeDiff = Math.abs(time1 - time2);
      expect(timeDiff).toBeLessThan(5);
    });

    it('should authenticate multiple times with same password', async () => {
      const isValid1 = await authManager.authenticatePassword(validPassword);
      const isValid2 = await authManager.authenticatePassword(validPassword);
      const isValid3 = await authManager.authenticatePassword(validPassword);

      expect(isValid1).toBe(true);
      expect(isValid2).toBe(true);
      expect(isValid3).toBe(true);
    });
  });

  describe('authenticate2FA', () => {
    beforeEach(() => {
      const totpConfig: AuthConfig = {
        method: '2fa',
        passwordMinLength: 16,
        totpEnabled: true,
        totpSecret: 'JBSWY3DPEHPK3PXP', // Base32 encoded secret
      };

      authManager = new WalletAuthenticationManager(totpConfig, mockLogger);
    });

    it('should reject invalid token format (not 6 digits)', async () => {
      const isValid = await authManager.authenticate2FA('12345'); // Only 5 digits
      expect(isValid).toBe(false);
    });

    it('should reject token with non-numeric characters', async () => {
      const isValid = await authManager.authenticate2FA('12345a');
      expect(isValid).toBe(false);
    });

    it('should return false for MVP (2FA not fully implemented)', async () => {
      const isValid = await authManager.authenticate2FA('123456'); // Valid format
      expect(isValid).toBe(false); // Always false in MVP
    });

    it('should return false when no TOTP secret configured', async () => {
      const noSecretManager = new WalletAuthenticationManager(passwordConfig, mockLogger);

      const isValid = await noSecretManager.authenticate2FA('123456');
      expect(isValid).toBe(false);
    });
  });

  describe('authenticateHSM', () => {
    beforeEach(() => {
      const hsmConfig: AuthConfig = {
        method: 'hsm',
        passwordMinLength: 16,
        totpEnabled: false,
      };

      authManager = new WalletAuthenticationManager(hsmConfig, mockLogger);
    });

    it('should return false for MVP (HSM not implemented - Epic 12)', async () => {
      const isValid = await authManager.authenticateHSM();
      expect(isValid).toBe(false);
    });
  });

  describe('authenticate', () => {
    it('should route to password authentication when method is password', async () => {
      const validPassword = 'ThisIsAVeryStrongPassword123!';
      await authManager.setPassword(validPassword);

      const isValid = await authManager.authenticate(validPassword);
      expect(isValid).toBe(true);
    });

    it('should route to 2FA authentication when method is 2fa', async () => {
      const totpConfig: AuthConfig = {
        method: '2fa',
        passwordMinLength: 16,
        totpEnabled: true,
        totpSecret: 'JBSWY3DPEHPK3PXP',
      };

      const manager = new WalletAuthenticationManager(totpConfig, mockLogger);

      const isValid = await manager.authenticate('123456');
      expect(isValid).toBe(false); // 2FA not implemented in MVP
    });

    it('should route to HSM authentication when method is hsm', async () => {
      const hsmConfig: AuthConfig = {
        method: 'hsm',
        passwordMinLength: 16,
        totpEnabled: false,
      };

      const manager = new WalletAuthenticationManager(hsmConfig, mockLogger);

      const isValid = await manager.authenticate('any-credential');
      expect(isValid).toBe(false); // HSM not implemented in MVP
    });
  });

  describe('UnauthorizedError', () => {
    it('should create error with operation name', () => {
      const error = new UnauthorizedError('wallet derivation');

      expect(error.message).toBe(
        'Unauthorized access to wallet derivation: authentication required'
      );
      expect(error.name).toBe('UnauthorizedError');
    });
  });
});
