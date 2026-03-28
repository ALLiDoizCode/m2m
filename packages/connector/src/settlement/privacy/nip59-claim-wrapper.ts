/**
 * NIP-59-Inspired Claim Wrapping for Transport Privacy
 *
 * Implements three-layer encryption wrapping for BTP claim messages,
 * inspired by Nostr NIP-59 Gift Wrap protocol. This provides transport-layer
 * privacy so that BTP intermediaries cannot observe claim contents, sender
 * identity, or timing patterns.
 *
 * Layers:
 * - Inner (Rumor): unsigned claim payload (deniable)
 * - Middle (Seal): encrypted to peer using ChaCha20-Poly1305, signed by sender
 * - Outer (Gift Wrap): encrypted with ephemeral one-time key, randomized timestamp
 *
 * This module is chain-agnostic -- it wraps any BTPClaimMessage (EVM, Solana, Mina).
 * The blockchain discriminator is inside the encrypted payload, invisible to intermediaries.
 *
 * Epic 34 Story 34.6
 *
 * @module nip59-claim-wrapper
 */

import { randomBytes } from 'crypto';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { utf8ToBytes } from '@noble/ciphers/utils';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { secp256k1 } from '@noble/curves/secp256k1';

import type { BTPClaimMessage } from '../../btp/btp-claim-types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Three-layer wrapped claim message for transport privacy.
 *
 * Only the ephemeral public key, encrypted payload, randomized timestamp,
 * and version are visible to BTP intermediaries.
 */
export interface WrappedClaim {
  /** Hex-encoded compressed secp256k1 public key (ephemeral, one-time use) */
  ephemeralPublicKey: string;
  /** Base64-encoded ChaCha20-Poly1305 ciphertext (gift wrap layer) */
  encryptedPayload: string;
  /** Randomized unix timestamp (+-48 hours from actual send time) */
  timestamp: number;
  /** Protocol version (independent of BTP_CLAIM_PROTOCOL version) */
  version: '1.0';
}

/**
 * BTP protocol constants for wrapped (NIP-59 encrypted) claim messages.
 */
export const BTP_WRAPPED_CLAIM_PROTOCOL = {
  NAME: 'claim-wrapped',
  CONTENT_TYPE: 0, // APPLICATION_OCTET_STREAM
  VERSION: '1.0',
} as const;

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Custom error for NIP-59 wrapping/unwrapping failures.
 *
 * Indicates which encryption layer failed and preserves the original error as `cause`.
 * Never includes decrypted claim content in error messages.
 */
export class NIP59WrapError extends Error {
  override readonly name = 'NIP59WrapError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    Error.captureStackTrace(this, NIP59WrapError);
  }
}

// ---------------------------------------------------------------------------
// Internal types for seal layer
// ---------------------------------------------------------------------------

/** Seal layer payload: encrypted rumor + sender identity + signature */
interface SealPayload {
  /** Hex-encoded compressed secp256k1 sender public key */
  senderPublicKey: string;
  /** Base64-encoded signature over the seal ciphertext */
  signature: string;
  /** Base64-encoded ChaCha20-Poly1305 ciphertext (seal layer, contains rumor) */
  sealCiphertext: string;
}

// ---------------------------------------------------------------------------
// Logger interface (minimal, avoids importing pino types)
// ---------------------------------------------------------------------------

interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** NIP59ClaimWrapper constructor options */
export interface NIP59ClaimWrapperOptions {
  /** Whether NIP-59 wrapping is enabled */
  nip59Enabled: boolean;
  /** Pino-compatible logger instance */
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
const CHACHA_NONCE_BYTES = 12;
const HKDF_KEY_BYTES = 32;
const SEAL_HKDF_INFO = 'nip59-seal';
const GIFTWRAP_HKDF_INFO = 'nip59-giftwrap';

// ---------------------------------------------------------------------------
// NIP59ClaimWrapper
// ---------------------------------------------------------------------------

/**
 * NIP-59-inspired three-layer claim wrapper for transport privacy.
 *
 * Wraps BTPClaimMessage payloads in three encryption layers (Rumor, Seal, Gift Wrap)
 * so that BTP intermediaries cannot observe claim contents, sender identity, or timing.
 *
 * @remarks
 * This class is chain-agnostic -- it wraps any BTPClaimMessage regardless of blockchain type.
 * Configuration toggle: when `nip59Enabled` is false, `wrapClaim` returns null (passthrough).
 *
 * @example
 * ```typescript
 * const wrapper = new NIP59ClaimWrapper({ nip59Enabled: true, logger });
 * const wrapped = wrapper.wrapClaim(claim, senderPrivKey, receiverPubKey);
 * // ... transmit via BTP ...
 * const unwrapped = wrapper.unwrapClaim(wrapped, receiverPrivKey);
 * ```
 */
export class NIP59ClaimWrapper {
  private readonly _nip59Enabled: boolean;
  private readonly _logger: Logger;

  constructor(options: NIP59ClaimWrapperOptions) {
    this._nip59Enabled = options.nip59Enabled;
    this._logger = options.logger.child({ component: 'nip59-claim-wrapper' });
  }

  /**
   * Whether NIP-59 wrapping is enabled for this instance.
   */
  isEnabled(): boolean {
    return this._nip59Enabled;
  }

  /**
   * Wrap a BTP claim message in three NIP-59 layers.
   *
   * @param claim - The plaintext BTPClaimMessage to wrap
   * @param senderPrivateKey - 32-byte sender secp256k1 private key
   * @param receiverPublicKey - 33-byte compressed receiver secp256k1 public key
   * @returns WrappedClaim if enabled, null if disabled (passthrough)
   */
  wrapClaim(
    claim: BTPClaimMessage,
    senderPrivateKey: Uint8Array,
    receiverPublicKey: Uint8Array
  ): WrappedClaim | null {
    if (!this._nip59Enabled) {
      this._logger.debug(
        { event: 'nip59_wrap_skip' },
        'NIP-59 wrapping disabled, passing claim through'
      );
      return null;
    }

    try {
      // Layer 1: Rumor -- serialize claim to JSON (unsigned, deniable)
      const rumor = JSON.stringify(claim);
      const rumorBytes = utf8ToBytes(rumor);

      // Layer 2: Seal -- encrypt rumor with ECDH(sender, receiver), sign ciphertext
      const senderPubKey = secp256k1.getPublicKey(senderPrivateKey, true);
      const sealCiphertext = this._encryptSeal(
        rumorBytes,
        senderPrivateKey,
        receiverPublicKey,
        senderPubKey
      );
      const sealSignature = this._signCiphertext(sealCiphertext, senderPrivateKey);

      const sealPayload: SealPayload = {
        senderPublicKey: Buffer.from(senderPubKey).toString('hex'),
        signature: Buffer.from(sealSignature).toString('base64'),
        sealCiphertext: Buffer.from(sealCiphertext).toString('base64'),
      };

      const sealPayloadBytes = utf8ToBytes(JSON.stringify(sealPayload));

      // Layer 3: Gift Wrap -- encrypt seal with ephemeral key, randomize timestamp
      const ephemeralPrivKey = randomBytes(32);
      const ephemeralPubKey = secp256k1.getPublicKey(ephemeralPrivKey, true);

      const giftWrapCiphertext = this._encryptGiftWrap(
        sealPayloadBytes,
        ephemeralPrivKey,
        receiverPublicKey
      );

      // Zero ephemeral private key after use (defense-in-depth: limit key lifetime in memory)
      ephemeralPrivKey.fill(0);

      const wrapped: WrappedClaim = {
        ephemeralPublicKey: Buffer.from(ephemeralPubKey).toString('hex'),
        encryptedPayload: Buffer.from(giftWrapCiphertext).toString('base64'),
        timestamp: this._randomizeTimestamp(),
        version: '1.0',
      };

      this._logger.info(
        { event: 'nip59_wrap', claimMessageId: claim.messageId },
        'Wrapping claim with NIP-59 Gift Wrap'
      );

      return wrapped;
    } catch (err) {
      throw new NIP59WrapError(
        `Failed to wrap claim: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
  }

  /**
   * Unwrap a NIP-59 wrapped claim message, recovering the original BTPClaimMessage.
   *
   * @param wrappedClaim - The WrappedClaim to unwrap
   * @param receiverPrivateKey - 32-byte receiver secp256k1 private key
   * @returns The original BTPClaimMessage
   * @throws NIP59WrapError if decryption or verification fails
   */
  unwrapClaim(wrappedClaim: WrappedClaim, receiverPrivateKey: Uint8Array): BTPClaimMessage {
    // Validate wrapped claim structure
    if (!wrappedClaim.ephemeralPublicKey || wrappedClaim.ephemeralPublicKey.length === 0) {
      throw new NIP59WrapError('Invalid wrapped claim: missing ephemeralPublicKey', {
        cause: new Error('Empty ephemeralPublicKey'),
      });
    }
    if (!wrappedClaim.encryptedPayload || wrappedClaim.encryptedPayload.length === 0) {
      throw new NIP59WrapError('Invalid wrapped claim: missing encryptedPayload', {
        cause: new Error('Empty encryptedPayload'),
      });
    }

    // Step 1: Decrypt Gift Wrap layer
    let sealPayloadBytes: Uint8Array;
    try {
      const ephemeralPubKey = hexToBytes(wrappedClaim.ephemeralPublicKey);
      const encryptedPayload = base64ToBytes(wrappedClaim.encryptedPayload);

      sealPayloadBytes = this._decryptGiftWrap(
        encryptedPayload,
        receiverPrivateKey,
        ephemeralPubKey
      );
    } catch (err) {
      if (err instanceof NIP59WrapError) throw err;
      this._logger.warn(
        {
          event: 'nip59_unwrap_failed',
          layer: 'gift_wrap',
          error: err instanceof Error ? err.message : String(err),
        },
        'Failed to unwrap NIP-59 gift wrap layer'
      );
      throw new NIP59WrapError(
        `Failed to decrypt gift wrap layer: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }

    // Step 2: Parse seal payload and decrypt seal layer
    let rumorBytes: Uint8Array;
    try {
      const sealPayloadStr = bytesToUtf8(sealPayloadBytes);
      const sealPayload = JSON.parse(sealPayloadStr) as SealPayload;

      const senderPubKey = hexToBytes(sealPayload.senderPublicKey);
      const sealSignature = base64ToBytes(sealPayload.signature);
      const sealCiphertext = base64ToBytes(sealPayload.sealCiphertext);

      // Verify sender signature over seal ciphertext
      this._verifyCiphertext(sealCiphertext, sealSignature, senderPubKey);

      // Decrypt seal layer
      rumorBytes = this._decryptSeal(sealCiphertext, receiverPrivateKey, senderPubKey);
    } catch (err) {
      if (err instanceof NIP59WrapError) throw err;
      this._logger.warn(
        {
          event: 'nip59_unwrap_failed',
          layer: 'seal',
          error: err instanceof Error ? err.message : String(err),
        },
        'Failed to unwrap NIP-59 seal layer'
      );
      throw new NIP59WrapError(
        `Failed to decrypt seal layer: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }

    // Step 3: Parse rumor (JSON) -> BTPClaimMessage
    try {
      const rumorStr = bytesToUtf8(rumorBytes);
      const claim = JSON.parse(rumorStr) as BTPClaimMessage;

      // Runtime validation: verify the parsed object has required BTPClaimMessage base fields
      if (
        typeof claim !== 'object' ||
        claim === null ||
        typeof claim.version !== 'string' ||
        typeof claim.blockchain !== 'string' ||
        typeof claim.messageId !== 'string' ||
        typeof claim.timestamp !== 'string' ||
        typeof claim.senderId !== 'string'
      ) {
        throw new NIP59WrapError(
          'Rumor payload is not a valid BTPClaimMessage: missing required base fields',
          { cause: new Error('Invalid BTPClaimMessage structure') }
        );
      }

      this._logger.info(
        { event: 'nip59_unwrap', claimMessageId: claim.messageId },
        'Successfully unwrapped NIP-59 claim'
      );

      return claim;
    } catch (err) {
      this._logger.warn(
        {
          event: 'nip59_unwrap_failed',
          layer: 'rumor',
          error: err instanceof Error ? err.message : String(err),
        },
        'Failed to parse NIP-59 rumor layer'
      );
      throw new NIP59WrapError(
        `Failed to parse rumor layer: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private: Encryption / Decryption helpers
  // -------------------------------------------------------------------------

  /**
   * Encrypt the rumor (seal layer) using ECDH(senderPriv, receiverPub).
   * Uses senderPublicKey as AAD (authenticated additional data) per NIP-59 design.
   * Returns nonce (12 bytes) prepended to ciphertext.
   */
  private _encryptSeal(
    rumorBytes: Uint8Array,
    senderPrivateKey: Uint8Array,
    receiverPublicKey: Uint8Array,
    senderPublicKey: Uint8Array
  ): Uint8Array {
    const sharedSecret = this._computeSharedSecret(senderPrivateKey, receiverPublicKey);
    const key = hkdf(sha256, sharedSecret, undefined, SEAL_HKDF_INFO, HKDF_KEY_BYTES);
    const nonce = randomBytes(CHACHA_NONCE_BYTES);

    const cipher = chacha20poly1305(key, nonce, senderPublicKey);
    const ciphertext = cipher.encrypt(rumorBytes);

    // Prepend nonce to ciphertext
    const result = new Uint8Array(CHACHA_NONCE_BYTES + ciphertext.length);
    result.set(nonce, 0);
    result.set(ciphertext, CHACHA_NONCE_BYTES);
    return result;
  }

  /**
   * Decrypt the seal layer using ECDH(receiverPriv, senderPub).
   * Uses senderPublicKey as AAD (authenticated additional data) per NIP-59 design.
   * Expects nonce (12 bytes) prepended to ciphertext.
   */
  private _decryptSeal(
    sealCiphertext: Uint8Array,
    receiverPrivateKey: Uint8Array,
    senderPublicKey: Uint8Array
  ): Uint8Array {
    const sharedSecret = this._computeSharedSecret(receiverPrivateKey, senderPublicKey);
    const key = hkdf(sha256, sharedSecret, undefined, SEAL_HKDF_INFO, HKDF_KEY_BYTES);

    const nonce = sealCiphertext.slice(0, CHACHA_NONCE_BYTES);
    const ciphertext = sealCiphertext.slice(CHACHA_NONCE_BYTES);

    const cipher = chacha20poly1305(key, nonce, senderPublicKey);
    return cipher.decrypt(ciphertext);
  }

  /**
   * Encrypt the seal payload (gift wrap layer) using ECDH(ephemeralPriv, receiverPub).
   * Returns nonce (12 bytes) prepended to ciphertext.
   */
  private _encryptGiftWrap(
    sealPayloadBytes: Uint8Array,
    ephemeralPrivateKey: Uint8Array,
    receiverPublicKey: Uint8Array
  ): Uint8Array {
    const sharedSecret = this._computeSharedSecret(ephemeralPrivateKey, receiverPublicKey);
    const key = hkdf(sha256, sharedSecret, undefined, GIFTWRAP_HKDF_INFO, HKDF_KEY_BYTES);
    const nonce = randomBytes(CHACHA_NONCE_BYTES);

    const cipher = chacha20poly1305(key, nonce);
    const ciphertext = cipher.encrypt(sealPayloadBytes);

    const result = new Uint8Array(CHACHA_NONCE_BYTES + ciphertext.length);
    result.set(nonce, 0);
    result.set(ciphertext, CHACHA_NONCE_BYTES);
    return result;
  }

  /**
   * Decrypt the gift wrap layer using ECDH(receiverPriv, ephemeralPub).
   * Expects nonce (12 bytes) prepended to ciphertext.
   */
  private _decryptGiftWrap(
    giftWrapCiphertext: Uint8Array,
    receiverPrivateKey: Uint8Array,
    ephemeralPublicKey: Uint8Array
  ): Uint8Array {
    const sharedSecret = this._computeSharedSecret(receiverPrivateKey, ephemeralPublicKey);
    const key = hkdf(sha256, sharedSecret, undefined, GIFTWRAP_HKDF_INFO, HKDF_KEY_BYTES);

    const nonce = giftWrapCiphertext.slice(0, CHACHA_NONCE_BYTES);
    const ciphertext = giftWrapCiphertext.slice(CHACHA_NONCE_BYTES);

    const cipher = chacha20poly1305(key, nonce);
    return cipher.decrypt(ciphertext);
  }

  // -------------------------------------------------------------------------
  // Private: Crypto helpers
  // -------------------------------------------------------------------------

  /**
   * Compute ECDH shared secret (x-coordinate only, 32 bytes).
   */
  private _computeSharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
    const sharedPoint = secp256k1.getSharedSecret(privateKey, publicKey, true);
    // Compressed point is 33 bytes (prefix + x-coord). Take x-coordinate (bytes 1-32).
    return sharedPoint.slice(1);
  }

  /**
   * Sign ciphertext using secp256k1: sign(SHA-256(ciphertext), privateKey).
   * Returns compact 64-byte signature.
   */
  private _signCiphertext(ciphertext: Uint8Array, privateKey: Uint8Array): Uint8Array {
    const messageHash = sha256(ciphertext);
    const sig = secp256k1.sign(messageHash, privateKey);
    return sig.toCompactRawBytes();
  }

  /**
   * Verify ciphertext signature using secp256k1.
   * @throws NIP59WrapError if verification fails
   */
  private _verifyCiphertext(
    ciphertext: Uint8Array,
    signature: Uint8Array,
    publicKey: Uint8Array
  ): void {
    const messageHash = sha256(ciphertext);
    const isValid = secp256k1.verify(signature, messageHash, publicKey);
    if (!isValid) {
      throw new NIP59WrapError('Seal signature verification failed: sender signature is invalid', {
        cause: new Error('Invalid secp256k1 signature'),
      });
    }
  }

  /**
   * Generate a randomized timestamp within +-48 hours of the current time.
   */
  private _randomizeTimestamp(): number {
    const now = Date.now();
    // Random offset between -48h and +48h
    const offsetBytes = randomBytes(4);
    const offsetRaw = offsetBytes.readUInt32BE(0);
    // Map to range [-FORTY_EIGHT_HOURS_MS, +FORTY_EIGHT_HOURS_MS]
    const offset = (offsetRaw / 0xffffffff) * 2 * FORTY_EIGHT_HOURS_MS - FORTY_EIGHT_HOURS_MS;
    return Math.round(now + offset);
  }
}

/**
 * Architecture-doc alias: NIP59TransportWrapper = NIP59ClaimWrapper
 */
export const NIP59TransportWrapper = NIP59ClaimWrapper;

// ---------------------------------------------------------------------------
// BTP Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a WrappedClaim to a Buffer for BTP protocolData transport.
 *
 * @param wrapped - The WrappedClaim to serialize
 * @returns UTF-8 encoded JSON Buffer
 */
export function serializeWrappedClaim(wrapped: WrappedClaim): Buffer {
  return Buffer.from(JSON.stringify(wrapped), 'utf8');
}

/**
 * Deserialize a Buffer from BTP protocolData into a WrappedClaim.
 *
 * @param data - UTF-8 encoded JSON Buffer
 * @returns Parsed WrappedClaim
 * @throws NIP59WrapError if the buffer does not contain valid WrappedClaim JSON
 */
export function deserializeWrappedClaim(data: Buffer): WrappedClaim {
  let parsed: WrappedClaim;
  try {
    const str = data.toString('utf8');
    parsed = JSON.parse(str) as WrappedClaim;
  } catch (err) {
    throw new NIP59WrapError(
      `Failed to deserialize WrappedClaim: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }

  // Basic structural validation
  if (
    typeof parsed.ephemeralPublicKey !== 'string' ||
    typeof parsed.encryptedPayload !== 'string' ||
    typeof parsed.timestamp !== 'number' ||
    parsed.version !== '1.0'
  ) {
    throw new NIP59WrapError('Invalid WrappedClaim structure', {
      cause: new Error('Missing or invalid required fields'),
    });
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Utility: byte conversion helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${hex.length}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.substring(i, i + 2), 16);
    if (isNaN(byte)) {
      throw new Error(`Invalid hex character at position ${i}`);
    }
    bytes[i / 2] = byte;
  }
  return bytes;
}

function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

function bytesToUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}
