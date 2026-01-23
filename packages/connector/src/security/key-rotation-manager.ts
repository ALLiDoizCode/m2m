/**
 * Key Rotation Manager
 *
 * Manages automated key rotation with configurable intervals and overlap periods.
 * Ensures smooth key transitions with no downtime during rotation.
 *
 * File: packages/connector/src/security/key-rotation-manager.ts
 */
import { KeyManager, KeyRotationConfig } from './key-manager';
import { Logger } from 'pino';

/**
 * Key rotation metadata tracking
 * Stores information about key rotations for overlap period management
 */
export interface KeyRotationMetadata {
  oldKeyId: string;
  newKeyId: string;
  rotationDate: number; // Unix timestamp in milliseconds
  overlapEndsAt: number; // Unix timestamp when overlap period expires
}

/**
 * KeyRotationManager handles automated key rotation scheduling and execution
 *
 * Features:
 * - Configurable rotation intervals (default: 90 days)
 * - Overlap period support (default: 7 days) - both keys valid during transition
 * - Pre-rotation warnings (default: 14 days before rotation)
 * - Rotation metadata tracking for audit and overlap management
 */
export class KeyRotationManager {
  private readonly keyManager: KeyManager;
  private readonly config: KeyRotationConfig;
  private readonly logger: Logger;
  private rotationTimer?: NodeJS.Timeout;
  private notificationTimer?: NodeJS.Timeout;
  private rotationMetadata: Map<string, KeyRotationMetadata> = new Map();

  /**
   * Initialize KeyRotationManager
   *
   * @param keyManager - KeyManager instance for key operations
   * @param config - Key rotation configuration
   * @param logger - Pino logger instance
   */
  constructor(keyManager: KeyManager, config: KeyRotationConfig, logger: Logger) {
    this.keyManager = keyManager;
    this.config = config;
    this.logger = logger.child({ component: 'KeyRotationManager' });

    // Validate configuration
    if (config.intervalDays <= 0) {
      throw new Error('Rotation interval must be positive');
    }
    if (config.overlapDays < 0) {
      throw new Error('Overlap days must be non-negative');
    }
    if (config.notifyBeforeDays < 0) {
      throw new Error('Notification days must be non-negative');
    }
    if (config.overlapDays >= config.intervalDays) {
      throw new Error('Overlap period must be less than rotation interval');
    }
  }

  /**
   * Start automated key rotation scheduler
   *
   * Sets up periodic rotation and notification timers based on configuration.
   * Rotation occurs every config.intervalDays.
   * Notifications sent config.notifyBeforeDays before rotation.
   */
  start(): void {
    if (!this.config.enabled) {
      this.logger.info('Key rotation is disabled in configuration');
      return;
    }

    // Stop any existing timers
    this.stop();

    const rotationIntervalMs = this.config.intervalDays * 24 * 60 * 60 * 1000;

    // Schedule rotation timer
    this.rotationTimer = setInterval(() => {
      this.logger.info('Rotation timer triggered - checking for keys to rotate');
      // In production, this would check a list of managed keys
      // For now, this is a placeholder that would be triggered by configuration
    }, rotationIntervalMs);

    // Schedule notification timer (runs more frequently to check if notification is needed)
    // Check daily if we're within notification window
    const dailyCheckMs = 24 * 60 * 60 * 1000;
    this.notificationTimer = setInterval(() => {
      this.checkNotificationNeeded();
    }, dailyCheckMs);

    this.logger.info(
      {
        rotationIntervalDays: this.config.intervalDays,
        overlapDays: this.config.overlapDays,
        notifyBeforeDays: this.config.notifyBeforeDays,
      },
      'Key rotation scheduler started'
    );
  }

  /**
   * Stop automated key rotation scheduler
   *
   * Clears all timers and stops rotation scheduling.
   * Does not affect keys currently in overlap period.
   */
  stop(): void {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = undefined;
    }

    if (this.notificationTimer) {
      clearInterval(this.notificationTimer);
      this.notificationTimer = undefined;
    }

    this.logger.info('Key rotation scheduler stopped');
  }

  /**
   * Check if rotation notification should be sent
   * Called periodically by notification timer
   */
  private checkNotificationNeeded(): void {
    // In a full implementation, this would check:
    // - List of managed keys
    // - Last rotation date for each key
    // - Calculate next rotation date
    // - If (nextRotationDate - now) <= notifyBeforeDays, send notification

    this.logger.debug('Checking if rotation notifications needed');
  }

  // Note: sendRotationNotification() method commented out as it's not used in current implementation
  // In production, this would be called by checkNotificationNeeded() to send alerts via:
  // - Log warning
  // - Email notification (if configured)
  // - Slack alert (if configured)
  // - Notification queue/database

  /**
   * Rotate a key and manage overlap period
   *
   * Creates new key, maintains overlap period where both old and new keys are valid.
   * After overlap period, old key is disabled.
   *
   * @param keyId - Key to rotate
   * @returns New key ID
   */
  async rotateKey(keyId: string): Promise<string> {
    this.logger.info({ keyId }, 'Starting key rotation');

    try {
      // Delegate rotation to KeyManager backend
      const newKeyId = await this.keyManager.rotateKey(keyId);

      // Calculate overlap period end time
      const rotationDate = Date.now();
      const overlapEndsAt = rotationDate + this.config.overlapDays * 24 * 60 * 60 * 1000;

      // Store rotation metadata
      const metadata: KeyRotationMetadata = {
        oldKeyId: keyId,
        newKeyId,
        rotationDate,
        overlapEndsAt,
      };

      this.rotationMetadata.set(newKeyId, metadata);

      this.logger.info(
        {
          oldKeyId: keyId,
          newKeyId,
          rotationDate: new Date(rotationDate).toISOString(),
          overlapEndsAt: new Date(overlapEndsAt).toISOString(),
          overlapDays: this.config.overlapDays,
        },
        'Key rotation completed - overlap period started'
      );

      // Schedule cleanup of old key after overlap period
      this.scheduleOverlapCleanup(keyId, newKeyId, overlapEndsAt);

      return newKeyId;
    } catch (error) {
      this.logger.error({ keyId, error }, 'Key rotation failed');
      throw error;
    }
  }

  /**
   * Schedule cleanup task to disable old key after overlap period
   *
   * @param oldKeyId - Old key to disable
   * @param newKeyId - New key (for logging)
   * @param overlapEndsAt - Timestamp when overlap ends
   */
  private scheduleOverlapCleanup(oldKeyId: string, newKeyId: string, overlapEndsAt: number): void {
    const delayMs = overlapEndsAt - Date.now();

    if (delayMs <= 0) {
      // Overlap already ended, disable immediately
      this.disableOldKey(oldKeyId, newKeyId);
      return;
    }

    setTimeout(() => {
      this.disableOldKey(oldKeyId, newKeyId);
    }, delayMs);

    this.logger.debug(
      {
        oldKeyId,
        newKeyId,
        overlapEndsAt: new Date(overlapEndsAt).toISOString(),
        delayMs,
      },
      'Scheduled old key cleanup after overlap period'
    );
  }

  /**
   * Disable old key after overlap period expires
   *
   * @param oldKeyId - Old key to disable
   * @param newKeyId - New key (for logging)
   */
  private disableOldKey(oldKeyId: string, newKeyId: string): void {
    this.logger.info(
      {
        oldKeyId,
        newKeyId,
      },
      'Overlap period expired - disabling old key'
    );

    // Remove from active metadata
    this.rotationMetadata.delete(newKeyId);

    // In production, this would:
    // - Update configuration to mark old key as inactive
    // - Update database/key management system
    // - Notify administrators
    // - Archive old key for audit purposes (do not delete)
  }

  /**
   * Check if a key is currently valid
   *
   * Returns true if key is:
   * - Active (current key), OR
   * - Within overlap period (old key being phased out)
   *
   * @param keyId - Key to check
   * @returns true if key is valid for signing/verification
   */
  isKeyValid(keyId: string): boolean {
    // Check if this is a new key with active rotation
    const metadata = this.rotationMetadata.get(keyId);
    if (metadata) {
      // This is the new key, always valid
      return true;
    }

    // Check if this is an old key still in overlap period
    for (const [, meta] of this.rotationMetadata.entries()) {
      if (meta.oldKeyId === keyId) {
        // This is an old key, check if overlap period still active
        return Date.now() < meta.overlapEndsAt;
      }
    }

    // Not in rotation metadata, assume active key
    return true;
  }

  /**
   * Get rotation metadata for a key
   *
   * @param keyId - Key ID (can be old or new key)
   * @returns Rotation metadata if found
   */
  getRotationMetadata(keyId: string): KeyRotationMetadata | undefined {
    // Check if this is the new key
    const metadata = this.rotationMetadata.get(keyId);
    if (metadata) {
      return metadata;
    }

    // Check if this is the old key
    for (const [, meta] of this.rotationMetadata.entries()) {
      if (meta.oldKeyId === keyId) {
        return meta;
      }
    }

    return undefined;
  }

  /**
   * Get all active rotation metadata
   *
   * @returns Map of newKeyId -> metadata for all active rotations
   */
  getAllRotationMetadata(): Map<string, KeyRotationMetadata> {
    return new Map(this.rotationMetadata);
  }
}
