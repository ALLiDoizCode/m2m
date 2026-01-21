/**
 * Wallet Authentication Manager
 * Story 11.9: Security Hardening for Agent Wallets
 *
 * Manages authentication requirements for wallet operations including
 * password-based auth, 2FA (TOTP), and HSM integration (Epic 12).
 */

import { pbkdf2Sync, timingSafeEqual, randomBytes } from 'crypto';
import type { Logger } from 'pino';

/**
 * Authentication configuration
 */
export interface AuthConfig {
  method: 'password' | '2fa' | 'hsm'; // Authentication method
  passwordMinLength: number; // Minimum password length (default: 16)
  totpEnabled: boolean; // Enable TOTP 2FA (default: false)
  totpSecret?: string; // TOTP secret (base32 encoded)
}

/**
 * Stored password hash data
 */
export interface PasswordHash {
  hash: Buffer; // PBKDF2 hash
  salt: Buffer; // Random salt
  iterations: number; // PBKDF2 iterations (100k)
}

/**
 * Custom error for authentication failures
 */
export class UnauthorizedError extends Error {
  constructor(operation: string) {
    super(`Unauthorized access to ${operation}: authentication required`);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Wallet Authentication Manager
 * Handles authentication for sensitive wallet operations
 */
export class WalletAuthenticationManager {
  private config: AuthConfig;
  private logger: Logger;
  private passwordHash?: PasswordHash; // Stored password hash (in-memory for MVP)
  private totpSecret?: string; // TOTP secret (base32 encoded)

  // PBKDF2 configuration (matching Story 11.1 wallet encryption)
  private static readonly PBKDF2_ITERATIONS = 100000; // 100k iterations
  private static readonly PBKDF2_KEY_LENGTH = 32; // 256-bit key
  private static readonly PBKDF2_DIGEST = 'sha256';

  constructor(config: AuthConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    // Validate configuration
    if (config.method === '2fa' && !config.totpSecret) {
      throw new Error('TOTP secret required when 2FA authentication enabled');
    }

    if (config.method === '2fa') {
      this.totpSecret = config.totpSecret;
    }
  }

  /**
   * Set password for authentication
   * @param password - User password
   * @remarks
   * Hashes password with PBKDF2 (100k iterations, SHA-256)
   * Stores hash + salt in memory for authentication
   */
  async setPassword(password: string): Promise<void> {
    // Validate password strength
    if (password.length < this.config.passwordMinLength) {
      throw new Error(`Password must be at least ${this.config.passwordMinLength} characters long`);
    }

    // Generate random salt
    const salt = randomBytes(32); // 256-bit salt

    // Hash password with PBKDF2
    const hash = pbkdf2Sync(
      password,
      salt,
      WalletAuthenticationManager.PBKDF2_ITERATIONS,
      WalletAuthenticationManager.PBKDF2_KEY_LENGTH,
      WalletAuthenticationManager.PBKDF2_DIGEST
    );

    // Store hash + salt
    this.passwordHash = {
      hash,
      salt,
      iterations: WalletAuthenticationManager.PBKDF2_ITERATIONS,
    };

    this.logger.info({ method: 'password' }, 'Password authentication configured');
  }

  /**
   * Authenticate with password
   * @param password - User password
   * @returns True if password valid, false otherwise
   * @remarks
   * Uses timing-safe comparison to prevent timing attacks
   */
  async authenticatePassword(password: string): Promise<boolean> {
    if (!this.passwordHash) {
      this.logger.warn('Password authentication attempted but no password configured');
      return false;
    }

    try {
      // Hash provided password with same salt
      const hash = pbkdf2Sync(
        password,
        this.passwordHash.salt,
        this.passwordHash.iterations,
        WalletAuthenticationManager.PBKDF2_KEY_LENGTH,
        WalletAuthenticationManager.PBKDF2_DIGEST
      );

      // Timing-safe comparison
      const isValid = timingSafeEqual(hash, this.passwordHash.hash);

      if (isValid) {
        this.logger.info({ method: 'password' }, 'Password authentication successful');
      } else {
        this.logger.warn({ method: 'password' }, 'Password authentication failed');
      }

      return isValid;
    } catch (error) {
      this.logger.error({ error, method: 'password' }, 'Password authentication error');
      return false;
    }
  }

  /**
   * Authenticate with 2FA (TOTP) token
   * @param token - 6-digit TOTP code
   * @returns True if token valid, false otherwise
   * @remarks
   * For MVP: Simplified TOTP verification (30-second window)
   * Production: Use speakeasy library for proper TOTP verification
   */
  async authenticate2FA(token: string): Promise<boolean> {
    if (!this.totpSecret) {
      this.logger.warn('2FA authentication attempted but no TOTP secret configured');
      return false;
    }

    try {
      // Validate token format (6 digits)
      if (!/^\d{6}$/.test(token)) {
        this.logger.warn({ method: '2fa' }, '2FA token invalid format (expected 6 digits)');
        return false;
      }

      // For MVP: Simple validation (in production, use speakeasy library)
      // This is a placeholder implementation - Epic 12 will integrate proper TOTP library
      this.logger.info(
        { method: '2fa' },
        '2FA authentication requested (placeholder implementation)'
      );

      // TODO: Integrate speakeasy library in Epic 12
      // const isValid = speakeasy.totp.verify({
      //   secret: this.totpSecret,
      //   encoding: 'base32',
      //   token: token,
      //   window: 1  // Allow 30-second time skew
      // });

      // Placeholder: Always return false for MVP (2FA not fully implemented)
      this.logger.warn({ method: '2fa' }, '2FA not implemented in MVP - authentication failed');
      return false;
    } catch (error) {
      this.logger.error({ error, method: '2fa' }, '2FA authentication error');
      return false;
    }
  }

  /**
   * Authenticate with HSM
   * @returns True if HSM authentication successful, false otherwise
   * @remarks
   * Deferred to Epic 12 - placeholder implementation for MVP
   * Will integrate with Epic 12's KeyManager when available
   */
  async authenticateHSM(): Promise<boolean> {
    this.logger.info({ method: 'hsm' }, 'HSM authentication requested (not implemented - Epic 12)');

    // TODO: Integrate Epic 12's KeyManager
    // const keyManager = await KeyManager.getInstance();
    // return await keyManager.authenticate();

    // Placeholder: Always return false for MVP (HSM not available)
    return false;
  }

  /**
   * Authenticate based on configured method
   * @param credentials - Authentication credentials (password or token)
   * @returns True if authentication successful, false otherwise
   * @remarks
   * Routes to appropriate authentication method based on config
   */
  async authenticate(credentials: string): Promise<boolean> {
    switch (this.config.method) {
      case 'password':
        return this.authenticatePassword(credentials);
      case '2fa':
        return this.authenticate2FA(credentials);
      case 'hsm':
        return this.authenticateHSM();
      default:
        this.logger.error({ method: this.config.method }, 'Unknown authentication method');
        return false;
    }
  }
}
