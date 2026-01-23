import { Logger } from 'pino';
import { Wallet } from 'ethers';
import * as xrpl from 'xrpl';
import { KeyManagerBackend } from '../key-manager';

/**
 * EnvironmentVariableBackend implements KeyManagerBackend using private keys from environment variables
 * For development and testing only - not suitable for production use
 */
export class EnvironmentVariableBackend implements KeyManagerBackend {
  private evmWallet?: Wallet;
  private xrpWallet?: xrpl.Wallet;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'EnvironmentVariableBackend' });

    // Load EVM private key from environment
    const evmPrivateKey = process.env.EVM_PRIVATE_KEY;
    if (evmPrivateKey) {
      try {
        this.evmWallet = new Wallet(evmPrivateKey);
        this.logger.info({ address: this.evmWallet.address }, 'EVM wallet loaded from environment');
      } catch (error) {
        this.logger.error({ error }, 'Failed to load EVM private key');
        throw new Error('Invalid EVM_PRIVATE_KEY in environment');
      }
    }

    // Load XRP seed from environment
    const xrpSeed = process.env.XRP_SEED;
    if (xrpSeed) {
      try {
        this.xrpWallet = xrpl.Wallet.fromSeed(xrpSeed);
        this.logger.info({ address: this.xrpWallet.address }, 'XRP wallet loaded from environment');
      } catch (error) {
        this.logger.error({ error }, 'Failed to load XRP seed');
        throw new Error('Invalid XRP_SEED in environment');
      }
    }

    if (!this.evmWallet && !this.xrpWallet) {
      this.logger.warn('No keys loaded from environment (EVM_PRIVATE_KEY or XRP_SEED)');
    }
  }

  /**
   * Detects key type based on keyId
   * @param keyId - Key identifier containing 'evm' or 'xrp'
   * @returns Key type ('evm' or 'xrp')
   */
  private _detectKeyType(keyId: string): 'evm' | 'xrp' {
    const lowerKeyId = keyId.toLowerCase();
    if (lowerKeyId.includes('evm')) {
      return 'evm';
    }
    if (lowerKeyId.includes('xrp')) {
      return 'xrp';
    }
    // Default to EVM if no identifier found
    return 'evm';
  }

  /**
   * Signs a message using the appropriate wallet (EVM or XRP)
   * @param message - Message to sign
   * @param keyId - Key identifier (contains 'evm' or 'xrp')
   * @returns Signature buffer
   */
  async sign(message: Buffer, keyId: string): Promise<Buffer> {
    const keyType = this._detectKeyType(keyId);

    if (keyType === 'evm') {
      if (!this.evmWallet) {
        throw new Error('EVM wallet not initialized. Set EVM_PRIVATE_KEY environment variable.');
      }

      // Sign message using ethers.Wallet
      const signature = await this.evmWallet.signMessage(message);
      return Buffer.from(signature.slice(2), 'hex'); // Remove '0x' prefix
    } else {
      if (!this.xrpWallet) {
        throw new Error('XRP wallet not initialized. Set XRP_SEED environment variable.');
      }

      // Sign message using ed25519 (for XRP payment channel claims)
      // The message is expected to be the raw bytes to sign (already encoded by caller)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { sign } = require('ripple-keypairs');
      const signature = sign(message.toString('hex').toUpperCase(), this.xrpWallet.privateKey);
      return Buffer.from(signature, 'hex');
    }
  }

  /**
   * Retrieves public key derived from private key
   * @param keyId - Key identifier (contains 'evm' or 'xrp')
   * @returns Public key buffer
   */
  async getPublicKey(keyId: string): Promise<Buffer> {
    const keyType = this._detectKeyType(keyId);

    if (keyType === 'evm') {
      if (!this.evmWallet) {
        throw new Error('EVM wallet not initialized. Set EVM_PRIVATE_KEY environment variable.');
      }

      // Get public key from wallet (compressed secp256k1 format)
      const publicKey = this.evmWallet.signingKey.publicKey;
      return Buffer.from(publicKey.slice(2), 'hex'); // Remove '0x' prefix
    } else {
      if (!this.xrpWallet) {
        throw new Error('XRP wallet not initialized. Set XRP_SEED environment variable.');
      }

      // Get public key from XRP wallet
      // XRP wallet publicKey is hex string with 'ED' prefix (66 chars)
      // Remove 'ED' prefix and convert remaining 64 hex chars to 32-byte buffer
      const publicKeyHex = this.xrpWallet.publicKey.slice(2); // Remove 'ED' prefix
      return Buffer.from(publicKeyHex, 'hex');
    }
  }

  /**
   * Key rotation not supported for environment variable backend
   * Manual rotation required (update environment variables and restart)
   * @param keyId - Key identifier
   * @throws Error indicating manual rotation required
   */
  async rotateKey(_keyId: string): Promise<string> {
    throw new Error(
      'Manual rotation required for environment backend. Update EVM_PRIVATE_KEY or XRP_SEED and restart the connector.'
    );
  }
}
