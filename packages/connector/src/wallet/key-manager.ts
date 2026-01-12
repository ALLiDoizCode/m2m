/**
 * Key Manager Interface - HSM/KMS integration stub
 * @packageDocumentation
 * @remarks
 * This is a placeholder interface for Epic 12 Story 12.2 HSM/KMS integration.
 * Epic 12 will implement concrete classes (AWSKMSKeyManager, VaultKeyManager, etc.)
 * that provide secure key storage using hardware security modules or cloud key
 * management services.
 *
 * @example Future HSM usage (Epic 12)
 * ```typescript
 * const keyManager = new AWSKMSKeyManager({ region: 'us-east-1', keyId: 'abc123' });
 * const manager = new WalletSeedManager(keyManager);
 * await manager.initialize();
 * await manager.encryptAndStore(masterSeed, password);
 * // Seed encrypted and stored in AWS KMS instead of filesystem
 * ```
 */

/**
 * KeyManager interface for HSM/KMS secret storage
 * @remarks
 * Provides abstract interface for storing, retrieving, and deleting secrets.
 * Implementations in Epic 12 will support:
 * - AWS KMS (Key Management Service)
 * - HashiCorp Vault
 * - Azure Key Vault
 * - Google Cloud KMS
 * - Hardware Security Modules (HSM)
 */
export interface KeyManager {
  /**
   * Store secret in HSM/KMS
   * @param name - Secret name/identifier
   * @param value - Secret value (encrypted seed, private key, etc.)
   * @returns Promise that resolves when secret is stored
   */
  storeSecret(name: string, value: string): Promise<void>;

  /**
   * Retrieve secret from HSM/KMS
   * @param name - Secret name/identifier
   * @returns Promise that resolves to secret value
   * @throws Error if secret not found
   */
  retrieveSecret(name: string): Promise<string>;

  /**
   * Delete secret from HSM/KMS
   * @param name - Secret name/identifier
   * @returns Promise that resolves when secret is deleted
   */
  deleteSecret(name: string): Promise<void>;
}
