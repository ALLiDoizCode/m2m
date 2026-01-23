/**
 * KeyManagerSigner - Ethers.js Signer implementation backed by KeyManager
 *
 * This class wraps KeyManager to provide an ethers.Signer interface,
 * allowing KeyManager to be used with ethers.js contracts and transactions
 * while keeping private keys secure in HSM/KMS backends.
 *
 * Story: 12.2 Task 4 - PaymentChannelSDK KeyManager Integration
 */

import { ethers } from 'ethers';
import type { KeyManager } from './key-manager';
import type { Provider, TransactionRequest } from 'ethers';

export class KeyManagerSigner extends ethers.AbstractSigner {
  private keyManager: KeyManager;
  private evmKeyId: string;
  private address: string | null = null;

  constructor(keyManager: KeyManager, evmKeyId: string, provider?: Provider) {
    super(provider);
    this.keyManager = keyManager;
    this.evmKeyId = evmKeyId;
  }

  /**
   * Get the signer's address
   * Derives address from public key
   */
  async getAddress(): Promise<string> {
    if (this.address) {
      return this.address;
    }

    // Get public key from KeyManager
    const publicKeyBuffer = await this.keyManager.getPublicKey(this.evmKeyId);

    // For secp256k1 (EVM), derive address from public key
    // Public key format: 04 + x (32 bytes) + y (32 bytes) = 65 bytes uncompressed
    // Address = keccak256(pubkey)[12:]
    const publicKeyHex = '0x' + publicKeyBuffer.toString('hex');

    // Remove '04' prefix if present (uncompressed public key marker)
    const pubKeyWithoutPrefix = publicKeyHex.startsWith('0x04')
      ? '0x' + publicKeyHex.slice(4)
      : publicKeyHex;

    // Hash the public key and take last 20 bytes
    const addressHash = ethers.keccak256(pubKeyWithoutPrefix);
    this.address = ethers.getAddress('0x' + addressHash.slice(-40));

    return this.address;
  }

  /**
   * Sign a transaction
   * Creates transaction hash and signs with KeyManager
   */
  async signTransaction(transaction: TransactionRequest): Promise<string> {
    // Resolve all promises/address-like values in the transaction
    const resolved = await ethers.resolveProperties(transaction);

    // Create transaction object from resolved properties
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx = ethers.Transaction.from(resolved as any);

    // Get the digest to sign (keccak256 hash of RLP-encoded unsigned transaction)
    const digest = tx.unsignedHash;

    // Sign with KeyManager
    const signatureBuffer = await this.keyManager.sign(
      Buffer.from(digest.slice(2), 'hex'),
      this.evmKeyId
    );

    // Convert signature Buffer to ethers Signature format
    const signature = ethers.Signature.from('0x' + signatureBuffer.toString('hex'));

    // Set signature on transaction
    tx.signature = signature;

    // Return serialized signed transaction
    return tx.serialized;
  }

  /**
   * Sign a message
   * Signs arbitrary data with KeyManager
   */
  async signMessage(message: string | Uint8Array): Promise<string> {
    // Convert message to bytes
    const messageBytes = typeof message === 'string' ? ethers.toUtf8Bytes(message) : message;

    // Ethers prepends "\x19Ethereum Signed Message:\n" + length to messages
    const messageHash = ethers.hashMessage(messageBytes);

    // Sign the hash with KeyManager
    const signatureBuffer = await this.keyManager.sign(
      Buffer.from(messageHash.slice(2), 'hex'),
      this.evmKeyId
    );

    // Convert to ethers signature format (hex string)
    return '0x' + signatureBuffer.toString('hex');
  }

  /**
   * Sign typed data (EIP-712)
   * Used for balance proofs and other structured data signing
   */
  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: Record<string, any>
  ): Promise<string> {
    // Create EIP-712 hash
    const hash = ethers.TypedDataEncoder.hash(domain, types, value);

    // Sign the hash with KeyManager
    const signatureBuffer = await this.keyManager.sign(
      Buffer.from(hash.slice(2), 'hex'),
      this.evmKeyId
    );

    // Convert to ethers signature format (hex string)
    return '0x' + signatureBuffer.toString('hex');
  }

  /**
   * Connect signer to a provider
   */
  connect(provider: Provider): KeyManagerSigner {
    return new KeyManagerSigner(this.keyManager, this.evmKeyId, provider);
  }
}
