import { Logger } from 'pino';
import { KeyClient, CryptographyClient } from '@azure/keyvault-keys';
import { ClientSecretCredential } from '@azure/identity';
import { KeyManagerBackend, AzureConfig } from '../key-manager';

/**
 * AzureKeyVaultBackend implements KeyManagerBackend using Azure Key Vault
 * Supports EVM (secp256k1) and XRP (ed25519) key types
 */
export class AzureKeyVaultBackend implements KeyManagerBackend {
  private keyClient: KeyClient;
  private config: AzureConfig;
  private logger: Logger;

  constructor(config: AzureConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({ component: 'AzureKeyVaultBackend' });

    // Initialize Azure Key Vault client
    let credential;
    if (config.credentials) {
      credential = new ClientSecretCredential(
        config.credentials.tenantId,
        config.credentials.clientId,
        config.credentials.clientSecret
      );
    } else {
      // Use DefaultAzureCredential if no explicit credentials provided
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DefaultAzureCredential } = require('@azure/identity');
      credential = new DefaultAzureCredential();
    }

    this.keyClient = new KeyClient(config.vaultUrl, credential);

    this.logger.info(
      { vaultUrl: config.vaultUrl, evmKeyName: config.evmKeyName, xrpKeyName: config.xrpKeyName },
      'AzureKeyVaultBackend initialized'
    );
  }

  /**
   * Detects key type based on keyName
   * @param keyName - Key name in Azure Key Vault
   * @returns Key type ('evm' or 'xrp')
   */
  private _detectKeyType(keyName: string): 'evm' | 'xrp' {
    const lowerKeyName = keyName.toLowerCase();
    if (lowerKeyName.includes('evm') || keyName === this.config.evmKeyName) {
      return 'evm';
    }
    if (lowerKeyName.includes('xrp') || keyName === this.config.xrpKeyName) {
      return 'xrp';
    }
    // Default to EVM
    return 'evm';
  }

  /**
   * Gets the appropriate signing algorithm for Azure Key Vault
   * @param keyType - Key type ('evm' or 'xrp')
   * @returns Azure signing algorithm
   */
  private _getSignAlgorithm(keyType: 'evm' | 'xrp'): string {
    if (keyType === 'evm') {
      return 'ES256K'; // secp256k1 with SHA-256
    } else {
      return 'EdDSA'; // ed25519
    }
  }

  /**
   * Signs a message using Azure Key Vault
   * @param message - Message to sign
   * @param keyName - Azure Key Vault key name
   * @returns Signature buffer
   */
  async sign(message: Buffer, keyName: string): Promise<Buffer> {
    const keyType = this._detectKeyType(keyName);
    const algorithm = this._getSignAlgorithm(keyType);

    this.logger.debug({ keyName, keyType, algorithm }, 'Signing with Azure Key Vault');

    try {
      // Get the key to create a CryptographyClient
      const key = await this.keyClient.getKey(keyName);

      if (!key.id) {
        throw new Error('Azure Key Vault returned no key ID');
      }

      // Create cryptography client for signing
      const cryptoClient = new CryptographyClient(key, this.keyClient['credential']);

      // Azure Key Vault requires message digest (SHA256 for ES256K)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const crypto = require('crypto');
      const digest = crypto.createHash('sha256').update(message).digest();

      // Sign the digest
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await cryptoClient.sign(algorithm as any, digest);

      if (!result.result) {
        throw new Error('Azure Key Vault returned no signature');
      }

      const signature = Buffer.from(result.result);
      this.logger.info(
        { keyName, signatureLength: signature.length },
        'Azure Key Vault signature generated'
      );

      return signature;
    } catch (error) {
      this.logger.error({ keyName, error }, 'Azure Key Vault signing failed');
      throw error;
    }
  }

  /**
   * Retrieves public key from Azure Key Vault
   * @param keyName - Azure Key Vault key name
   * @returns Public key buffer
   */
  async getPublicKey(keyName: string): Promise<Buffer> {
    this.logger.debug({ keyName }, 'Retrieving public key from Azure Key Vault');

    try {
      const key = await this.keyClient.getKey(keyName);

      if (!key.key) {
        throw new Error('Azure Key Vault returned no public key');
      }

      // Extract public key from JWK format
      // For EC keys, we need to combine x and y coordinates
      if (key.key.x && key.key.y) {
        const xBuffer = Buffer.from(key.key.x);
        const yBuffer = Buffer.from(key.key.y);

        // Combine x and y for uncompressed public key format (0x04 + x + y)
        const publicKey = Buffer.concat([Buffer.from([0x04]), xBuffer, yBuffer]);

        this.logger.info(
          { keyName, publicKeyLength: publicKey.length },
          'Azure Key Vault public key retrieved'
        );

        return publicKey;
      } else {
        throw new Error('Azure Key Vault key missing x or y coordinates');
      }
    } catch (error) {
      this.logger.error({ keyName, error }, 'Azure Key Vault public key retrieval failed');
      throw error;
    }
  }

  /**
   * Creates a new Azure Key Vault key for rotation
   * @param keyName - Current key name
   * @returns New key name
   */
  async rotateKey(keyName: string): Promise<string> {
    const keyType = this._detectKeyType(keyName);

    this.logger.info(
      { oldKeyName: keyName, keyType },
      'Creating new Azure Key Vault key for rotation'
    );

    try {
      // Azure Key Vault supports key rotation via creating a new key version
      // For manual rotation, we create a new key with a suffix
      const newKeyName = `${keyName}-rotated-${Date.now()}`;

      // Determine key type and curve
      const curve = keyType === 'evm' ? 'SECP256K1' : 'Ed25519';

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const newKey = await this.keyClient.createKey(newKeyName, curve as any, {
        keyOps: ['sign', 'verify'],
        tags: {
          purpose: 'ILP-Connector-Settlement',
          keyType: keyType.toUpperCase(),
          rotatedFrom: keyName,
        },
      });

      if (!newKey.name) {
        throw new Error('Azure Key Vault returned no key name');
      }

      this.logger.info(
        { oldKeyName: keyName, newKeyName: newKey.name },
        'Azure Key Vault key rotation completed'
      );

      return newKey.name;
    } catch (error) {
      this.logger.error({ keyName, error }, 'Azure Key Vault key rotation failed');
      throw error;
    }
  }
}
