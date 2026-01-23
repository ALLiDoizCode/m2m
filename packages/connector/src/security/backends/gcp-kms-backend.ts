import { Logger } from 'pino';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { KeyManagerBackend, GCPConfig } from '../key-manager';

/**
 * GCPKMSBackend implements KeyManagerBackend using Google Cloud Key Management Service
 * Supports EVM (secp256k1) and XRP (ed25519) key types
 */
export class GCPKMSBackend implements KeyManagerBackend {
  private client: KeyManagementServiceClient;
  private config: GCPConfig;
  private logger: Logger;

  constructor(config: GCPConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({ component: 'GCPKMSBackend' });

    // Initialize GCP KMS client
    this.client = new KeyManagementServiceClient();

    this.logger.info(
      {
        projectId: config.projectId,
        locationId: config.locationId,
        keyRingId: config.keyRingId,
      },
      'GCPKMSBackend initialized'
    );
  }

  /**
   * Detects key type based on keyId
   * @param keyId - Key identifier (crypto key name)
   * @returns Key type ('evm' or 'xrp')
   */
  private _detectKeyType(keyId: string): 'evm' | 'xrp' {
    const lowerKeyId = keyId.toLowerCase();
    if (lowerKeyId.includes('evm') || keyId === this.config.evmKeyId) {
      return 'evm';
    }
    if (lowerKeyId.includes('xrp') || keyId === this.config.xrpKeyId) {
      return 'xrp';
    }
    // Default to EVM
    return 'evm';
  }

  /**
   * Constructs GCP KMS resource name for crypto key version
   * @param keyId - Crypto key name
   * @returns Full resource name
   */
  private _getCryptoKeyVersionName(keyId: string): string {
    return `projects/${this.config.projectId}/locations/${this.config.locationId}/keyRings/${this.config.keyRingId}/cryptoKeys/${keyId}/cryptoKeyVersions/1`;
  }

  /**
   * Constructs GCP KMS resource name for crypto key
   * @param keyId - Crypto key name
   * @returns Full resource name
   */
  private _getCryptoKeyName(keyId: string): string {
    return `projects/${this.config.projectId}/locations/${this.config.locationId}/keyRings/${this.config.keyRingId}/cryptoKeys/${keyId}`;
  }

  /**
   * Signs a message using GCP KMS asymmetricSign API
   * @param message - Message to sign
   * @param keyId - GCP KMS crypto key name
   * @returns Signature buffer
   */
  async sign(message: Buffer, keyId: string): Promise<Buffer> {
    const keyType = this._detectKeyType(keyId);
    const cryptoKeyVersionName = this._getCryptoKeyVersionName(keyId);

    this.logger.debug({ keyId, keyType, cryptoKeyVersionName }, 'Signing with GCP KMS');

    try {
      // GCP KMS requires message digest (SHA256)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const crypto = require('crypto');
      const digest = crypto.createHash('sha256').update(message).digest();

      const [response] = await this.client.asymmetricSign({
        name: cryptoKeyVersionName,
        digest: {
          sha256: digest,
        },
      });

      if (!response.signature) {
        throw new Error('GCP KMS returned no signature');
      }

      const signature = Buffer.from(response.signature as Uint8Array);
      this.logger.info({ keyId, signatureLength: signature.length }, 'GCP KMS signature generated');

      return signature;
    } catch (error) {
      this.logger.error({ keyId, error }, 'GCP KMS signing failed');
      throw error;
    }
  }

  /**
   * Retrieves public key from GCP KMS
   * @param keyId - GCP KMS crypto key name
   * @returns Public key buffer
   */
  async getPublicKey(keyId: string): Promise<Buffer> {
    const cryptoKeyVersionName = this._getCryptoKeyVersionName(keyId);

    this.logger.debug({ keyId, cryptoKeyVersionName }, 'Retrieving public key from GCP KMS');

    try {
      const [response] = await this.client.getPublicKey({
        name: cryptoKeyVersionName,
      });

      if (!response.pem) {
        throw new Error('GCP KMS returned no public key');
      }

      // Parse PEM format to extract raw public key bytes
      const publicKeyPem = response.pem;
      const publicKeyDer = this._pemToDer(publicKeyPem);

      this.logger.info(
        { keyId, publicKeyLength: publicKeyDer.length },
        'GCP KMS public key retrieved'
      );

      return publicKeyDer;
    } catch (error) {
      this.logger.error({ keyId, error }, 'GCP KMS public key retrieval failed');
      throw error;
    }
  }

  /**
   * Converts PEM-encoded public key to DER format
   * @param pem - PEM-encoded public key
   * @returns DER-encoded public key buffer
   */
  private _pemToDer(pem: string): Buffer {
    // Remove PEM headers/footers and decode base64
    const base64 = pem
      .replace(/-----BEGIN PUBLIC KEY-----/, '')
      .replace(/-----END PUBLIC KEY-----/, '')
      .replace(/\s/g, '');
    return Buffer.from(base64, 'base64');
  }

  /**
   * Creates a new GCP KMS crypto key version for rotation
   * @param keyId - Current crypto key name
   * @returns New crypto key version name
   */
  async rotateKey(keyId: string): Promise<string> {
    const cryptoKeyName = this._getCryptoKeyName(keyId);

    this.logger.info(
      { oldKeyId: keyId, cryptoKeyName },
      'Creating new GCP KMS key version for rotation'
    );

    try {
      const [response] = await this.client.createCryptoKeyVersion({
        parent: cryptoKeyName,
      });

      if (!response.name) {
        throw new Error('GCP KMS returned no key version name');
      }

      const newKeyVersionName = response.name;
      this.logger.info({ oldKeyId: keyId, newKeyVersionName }, 'GCP KMS key rotation completed');

      // Return the crypto key name (not version name) for consistency
      return keyId;
    } catch (error) {
      this.logger.error({ keyId, error }, 'GCP KMS key rotation failed');
      throw error;
    }
  }
}
