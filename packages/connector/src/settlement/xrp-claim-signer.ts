/**
 * Claim Signer
 *
 * Signs and verifies XRP payment channel claims using ed25519 signatures.
 * Enhanced from Story 9.2 stub to implement full signing/verification.
 *
 * File: packages/connector/src/settlement/xrp-claim-signer.ts
 */
import { Wallet, signPaymentChannelClaim, verifyPaymentChannelClaim } from 'xrpl';
import { Database } from 'better-sqlite3';
import pino from 'pino';

/**
 * XRP Payment Channel Claim
 *
 * Off-chain signed claim authorizing XRP transfer from payment channel.
 * Claim can be submitted to ledger by recipient to redeem XRP.
 */
export interface PaymentChannelClaim {
  /**
   * Channel identifier (transaction hash from PaymentChannelCreate)
   * Format: 64-character hex string (256-bit hash)
   */
  channelId: string;

  /**
   * Cumulative XRP amount to claim (drops)
   * Format: String for bigint precision (1 XRP = 1,000,000 drops)
   * Must be greater than all previous claims for this channel
   */
  amount: string;

  /**
   * ed25519 signature of claim message
   * Format: Hex-encoded signature (128 hex characters)
   * Signature covers: CLM\0 + channelId + amount (uint64 big-endian)
   */
  signature: string;

  /**
   * ed25519 public key for signature verification
   * Format: 66-character hex string (ED prefix + 64 hex)
   * Must match public key from PaymentChannelCreate transaction
   */
  publicKey: string;

  /**
   * Timestamp when claim was created (ISO 8601)
   */
  createdAt: string;
}

/**
 * ClaimSigner manages ed25519 keypairs for XRP payment channel claims.
 *
 * Signs and verifies off-chain claims for XRP payment channels per XRP Ledger specification.
 * Stores claims in database for dispute resolution and enforces monotonic claim amounts.
 */
export class ClaimSigner {
  private readonly wallet: Wallet;
  private readonly logger: pino.Logger;

  /**
   * Initialize ClaimSigner with database and optional seed for deterministic keypair generation.
   *
   * @param db - SQLite database instance for claim storage
   * @param logger - Pino logger instance
   * @param seed - Optional ed25519 seed (e.g., from XRPL_CLAIM_SIGNER_SEED env var)
   *               If not provided, generates random keypair
   */
  constructor(
    private readonly db: Database,
    logger: pino.Logger,
    seed?: string
  ) {
    // Generate ed25519 keypair
    // If seed provided, use it; otherwise generate random
    this.wallet = seed ? Wallet.fromSeed(seed) : Wallet.generate();
    this.logger = logger.child({ component: 'ClaimSigner' });
  }

  /**
   * Get ed25519 public key for PaymentChannelCreate transaction
   *
   * @returns Hex-encoded public key (66 chars: ED prefix + 64 hex)
   */
  getPublicKey(): string {
    return this.wallet.publicKey;
  }

  /**
   * Sign claim for XRP payment channel
   *
   * Creates ed25519 signature over claim message (CLM\0 + channelId + amount).
   * Stores signed claim in database for dispute resolution.
   * Validates amount is greater than previous claims (monotonic increase).
   *
   * @param channelId - Channel ID (64-char hex)
   * @param amount - XRP drops (string for bigint precision)
   * @returns Hex-encoded signature (128 hex chars)
   * @throws Error if amount <= previous claim amount
   */
  async signClaim(channelId: string, amount: string): Promise<string> {
    this.logger.info({ channelId, amount }, 'Signing XRP payment channel claim...');

    // Validate inputs
    if (!channelId || channelId.length !== 64) {
      throw new Error('Invalid channelId: must be 64-character hex string');
    }

    if (!/^[0-9A-Fa-f]{64}$/.test(channelId)) {
      throw new Error('Invalid channelId: must be valid hex string');
    }

    const amountBigInt = BigInt(amount);
    if (amountBigInt <= BigInt(0)) {
      throw new Error('Amount must be positive');
    }

    // Check monotonic increase: amount > previous claims
    const latestClaim = await this.getLatestClaim(channelId);
    if (latestClaim && BigInt(amount) <= BigInt(latestClaim.amount)) {
      throw new Error(
        `Claim amount must be greater than previous claim: ${amount} <= ${latestClaim.amount}`
      );
    }

    // Sign payment channel claim using xrpl.js
    const signature = signPaymentChannelClaim(channelId, amount, this.wallet.privateKey);

    this.logger.info({ channelId, amount, signature }, 'Claim signed successfully');

    // Store claim in database
    this.db
      .prepare(
        `INSERT INTO xrp_claims (channel_id, amount, signature, public_key, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(channelId, amount, signature, this.wallet.publicKey, Date.now());

    return signature;
  }

  /**
   * Verify claim signature
   *
   * Validates ed25519 signature over claim message.
   * Optionally checks amount doesn't exceed channel balance.
   *
   * @param channelId - Channel ID (64-char hex)
   * @param amount - XRP drops (string)
   * @param signature - Hex-encoded signature (128 hex chars)
   * @param publicKey - ed25519 public key (66 hex chars)
   * @param channelAmount - Optional: total channel amount for validation
   * @returns true if signature valid and amount valid, false otherwise
   */
  async verifyClaim(
    channelId: string,
    amount: string,
    signature: string,
    publicKey: string,
    channelAmount?: string
  ): Promise<boolean> {
    this.logger.info({ channelId, amount, publicKey }, 'Verifying XRP claim signature...');

    try {
      // Validate inputs
      if (!channelId || channelId.length !== 64) {
        this.logger.warn({ channelId }, 'Invalid channelId format');
        return false;
      }

      if (!/^[0-9A-Fa-f]{64}$/.test(channelId)) {
        this.logger.warn({ channelId }, 'Invalid channelId: not valid hex');
        return false;
      }

      if (!signature || signature.length !== 128) {
        this.logger.warn({ signature }, 'Invalid signature format');
        return false;
      }

      if (!/^[0-9A-Fa-f]{128}$/.test(signature)) {
        this.logger.warn({ signature }, 'Invalid signature: not valid hex');
        return false;
      }

      if (!publicKey || publicKey.length !== 66 || !publicKey.startsWith('ED')) {
        this.logger.warn({ publicKey }, 'Invalid public key format');
        return false;
      }

      if (!/^ED[0-9A-Fa-f]{64}$/i.test(publicKey)) {
        this.logger.warn({ publicKey }, 'Invalid public key: not valid hex with ED prefix');
        return false;
      }

      // Check amount doesn't exceed channel balance (if provided)
      if (channelAmount && BigInt(amount) > BigInt(channelAmount)) {
        this.logger.warn({ amount, channelAmount }, 'Claim amount exceeds channel balance');
        return false;
      }

      // Verify payment channel claim using xrpl.js
      const isValid = verifyPaymentChannelClaim(channelId, amount, signature, publicKey);

      this.logger.info({ channelId, isValid }, 'Claim verification complete');
      return isValid;
    } catch (error) {
      this.logger.error({ error, channelId }, 'Claim verification failed');
      return false;
    }
  }

  /**
   * Get latest claim for channel
   *
   * @param channelId - Channel ID
   * @returns Latest claim or null if no claims exist
   */
  async getLatestClaim(channelId: string): Promise<PaymentChannelClaim | null> {
    const row = this.db
      .prepare(
        `SELECT channel_id, amount, signature, public_key, created_at
         FROM xrp_claims
         WHERE channel_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(channelId) as
      | {
          channel_id: string;
          amount: string;
          signature: string;
          public_key: string;
          created_at: number;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      channelId: row.channel_id,
      amount: row.amount,
      signature: row.signature,
      publicKey: row.public_key,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }
}
