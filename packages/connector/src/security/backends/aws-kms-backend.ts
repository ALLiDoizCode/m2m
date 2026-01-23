import { Logger } from 'pino';
import {
  KMSClient,
  SignCommand,
  GetPublicKeyCommand,
  CreateKeyCommand,
  KeyUsageType,
  KeySpec,
  SigningAlgorithmSpec,
} from '@aws-sdk/client-kms';
import { KeyManagerBackend, AWSConfig } from '../key-manager';

/**
 * AWSKMSBackend implements KeyManagerBackend using AWS Key Management Service
 * Supports EVM (secp256k1) and XRP (ed25519) key types
 */
export class AWSKMSBackend implements KeyManagerBackend {
  private client: KMSClient;
  private config: AWSConfig;
  private logger: Logger;

  constructor(config: AWSConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({ component: 'AWSKMSBackend' });

    // Initialize AWS KMS client
    this.client = new KMSClient({
      region: config.region,
      credentials: config.credentials,
    });

    this.logger.info(
      { region: config.region, evmKeyId: config.evmKeyId, xrpKeyId: config.xrpKeyId },
      'AWSKMSBackend initialized'
    );
  }

  /**
   * Detects key type based on keyId
   * @param keyId - Key identifier (ARN or alias)
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
   * Gets the appropriate signing algorithm based on key type
   * @param keyType - Key type ('evm' or 'xrp')
   * @returns AWS KMS signing algorithm
   */
  private _getSigningAlgorithm(keyType: 'evm' | 'xrp'): SigningAlgorithmSpec {
    if (keyType === 'evm') {
      return SigningAlgorithmSpec.ECDSA_SHA_256;
    } else {
      // XRP uses ed25519 - ED25519_SHA_512 for RAW message signing
      return SigningAlgorithmSpec.ED25519_SHA_512;
    }
  }

  /**
   * Gets the appropriate key spec for key creation
   * @param keyType - Key type ('evm' | 'xrp')
   * @returns AWS KMS key spec
   */
  private _getKeySpec(keyType: 'evm' | 'xrp'): KeySpec {
    if (keyType === 'evm') {
      return KeySpec.ECC_SECG_P256K1; // secp256k1 for EVM
    } else {
      return KeySpec.ECC_NIST_EDWARDS25519; // ed25519 for XRP
    }
  }

  /**
   * Signs a message using AWS KMS
   * @param message - Message to sign
   * @param keyId - AWS KMS key ID or ARN
   * @returns Signature buffer
   */
  async sign(message: Buffer, keyId: string): Promise<Buffer> {
    const keyType = this._detectKeyType(keyId);
    const signingAlgorithm = this._getSigningAlgorithm(keyType);

    this.logger.debug({ keyId, keyType, signingAlgorithm }, 'Signing with AWS KMS');

    try {
      const command = new SignCommand({
        KeyId: keyId,
        Message: message,
        SigningAlgorithm: signingAlgorithm,
        MessageType: 'RAW', // Sign raw message (not digest)
      });

      const response = await this.client.send(command);

      if (!response.Signature) {
        throw new Error('AWS KMS returned no signature');
      }

      const signature = Buffer.from(response.Signature);
      this.logger.info({ keyId, signatureLength: signature.length }, 'AWS KMS signature generated');

      return signature;
    } catch (error) {
      this.logger.error({ keyId, error }, 'AWS KMS signing failed');
      throw error;
    }
  }

  /**
   * Retrieves public key from AWS KMS
   * @param keyId - AWS KMS key ID or ARN
   * @returns Public key buffer
   */
  async getPublicKey(keyId: string): Promise<Buffer> {
    this.logger.debug({ keyId }, 'Retrieving public key from AWS KMS');

    try {
      const command = new GetPublicKeyCommand({
        KeyId: keyId,
      });

      const response = await this.client.send(command);

      if (!response.PublicKey) {
        throw new Error('AWS KMS returned no public key');
      }

      const publicKey = Buffer.from(response.PublicKey);
      this.logger.info(
        { keyId, publicKeyLength: publicKey.length },
        'AWS KMS public key retrieved'
      );

      return publicKey;
    } catch (error) {
      this.logger.error({ keyId, error }, 'AWS KMS public key retrieval failed');
      throw error;
    }
  }

  /**
   * Creates a new AWS KMS key for rotation
   * @param keyId - Current key ID (used to determine key type)
   * @returns New key ID (ARN)
   */
  async rotateKey(keyId: string): Promise<string> {
    const keyType = this._detectKeyType(keyId);
    const keySpec = this._getKeySpec(keyType);

    this.logger.info(
      { oldKeyId: keyId, keyType, keySpec },
      'Creating new AWS KMS key for rotation'
    );

    try {
      const command = new CreateKeyCommand({
        KeyUsage: KeyUsageType.SIGN_VERIFY,
        KeySpec: keySpec,
        Description: `Rotated ${keyType.toUpperCase()} key from ${keyId}`,
        Tags: [
          {
            TagKey: 'Purpose',
            TagValue: 'ILP-Connector-Settlement',
          },
          {
            TagKey: 'KeyType',
            TagValue: keyType.toUpperCase(),
          },
          {
            TagKey: 'RotatedFrom',
            TagValue: keyId,
          },
        ],
      });

      const response = await this.client.send(command);

      if (!response.KeyMetadata?.Arn) {
        throw new Error('AWS KMS returned no key ARN');
      }

      const newKeyId = response.KeyMetadata.Arn;
      this.logger.info({ oldKeyId: keyId, newKeyId }, 'AWS KMS key rotation completed');

      return newKeyId;
    } catch (error) {
      this.logger.error({ keyId, error }, 'AWS KMS key rotation failed');
      throw error;
    }
  }
}
