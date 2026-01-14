/**
 * Integration tests for ClaimSigner with real database
 *
 * File: packages/connector/test/integration/xrp-claim-signer.test.ts
 */
import { ClaimSigner } from '../../src/settlement/xrp-claim-signer';
import Database from 'better-sqlite3';
import pino from 'pino';

describe('ClaimSigner Integration', () => {
  let signer: ClaimSigner;
  let db: Database.Database;
  let logger: pino.Logger;

  beforeAll(() => {
    logger = pino({ level: 'info' });

    // Create in-memory SQLite database
    db = new Database(':memory:');

    // Apply migrations
    db.exec(`
      CREATE TABLE IF NOT EXISTS xrp_claims (
        claim_id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        amount TEXT NOT NULL,
        signature TEXT NOT NULL,
        public_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_xrp_claims_channel
        ON xrp_claims(channel_id, created_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_xrp_claims_unique
        ON xrp_claims(channel_id, amount);
    `);

    // Create ClaimSigner with deterministic seed
    const testSeed = 'sEdTM1uX8pu2do5XvTnutH6HsouMaM2';
    signer = new ClaimSigner(db, logger, testSeed);
  });

  afterAll(() => {
    db.close();
  });

  it('should sign and verify claim end-to-end', async () => {
    const channelId = 'A'.repeat(64);
    const amount = '1000000000'; // 1,000 XRP

    // Sign claim
    const signature = await signer.signClaim(channelId, amount);
    expect(signature).toBeDefined();

    // Verify signature
    const publicKey = signer.getPublicKey();
    const isValid = await signer.verifyClaim(channelId, amount, signature, publicKey);
    expect(isValid).toBe(true);
  });

  it('should enforce monotonic claim amounts', async () => {
    const channelId = 'B'.repeat(64);

    // Sign claim 1: 1,000 XRP
    await signer.signClaim(channelId, '1000000000');

    // Sign claim 2: 1,500 XRP (allowed - monotonic increase)
    await signer.signClaim(channelId, '1500000000');

    // Sign claim 3: 1,400 XRP (rejected - decrease)
    await expect(signer.signClaim(channelId, '1400000000')).rejects.toThrow(
      'must be greater than previous claim'
    );
  });

  it('should retrieve latest claim from database', async () => {
    const channelId = 'C'.repeat(64);

    // Sign multiple claims
    await signer.signClaim(channelId, '1000000000');
    await new Promise((resolve) => setTimeout(resolve, 10)); // Small delay
    await signer.signClaim(channelId, '2000000000');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const finalSignature = await signer.signClaim(channelId, '3000000000');

    // Get latest claim
    const latestClaim = await signer.getLatestClaim(channelId);

    expect(latestClaim).toBeDefined();
    expect(latestClaim!.amount).toBe('3000000000');
    expect(latestClaim!.signature).toBe(finalSignature);
  });

  it('should verify claim with channel balance check', async () => {
    const channelId = 'D'.repeat(64);
    const claimAmount = '1500000000'; // 1,500 XRP
    const channelAmount = '2000000000'; // Channel has 2,000 XRP

    const signature = await signer.signClaim(channelId, claimAmount);
    const publicKey = signer.getPublicKey();

    // Should pass: claim < channel balance
    const isValid = await signer.verifyClaim(
      channelId,
      claimAmount,
      signature,
      publicKey,
      channelAmount
    );
    expect(isValid).toBe(true);

    // Should fail: claim > channel balance
    const isValidOverLimit = await signer.verifyClaim(
      channelId,
      claimAmount,
      signature,
      publicKey,
      '1000000000' // Channel only has 1,000 XRP
    );
    expect(isValidOverLimit).toBe(false);
  });

  it('should store claims with correct structure in database', async () => {
    const channelId = 'E'.repeat(64);
    const amount = '5000000000'; // 5,000 XRP

    await signer.signClaim(channelId, amount);

    // Query database directly
    const row = db
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

    expect(row).toBeDefined();
    expect(row!.channel_id).toBe(channelId);
    expect(row!.amount).toBe(amount);
    expect(row!.signature).toHaveLength(128); // ed25519 signature
    expect(row!.public_key).toHaveLength(66); // ED prefix + 64 hex
    expect(row!.public_key).toMatch(/^ED[0-9A-F]{64}$/i);
    expect(row!.created_at).toBeGreaterThan(0);
  });

  it('should reject verification with wrong public key', async () => {
    const channelId = 'F'.repeat(64);
    const amount = '1000000000';

    // Sign claim with signer's key
    const signature = await signer.signClaim(channelId, amount);

    // Try to verify with different public key
    const wrongPublicKey = 'ED' + '9'.repeat(64);
    const isValid = await signer.verifyClaim(channelId, amount, signature, wrongPublicKey);

    expect(isValid).toBe(false);
  });

  it('should handle large claim amounts (bigint)', async () => {
    const channelId = '7'.repeat(64); // Use valid hex character
    const largeAmount = '1000000000000'; // 1 million XRP = 1,000,000,000,000 drops

    const signature = await signer.signClaim(channelId, largeAmount);
    const publicKey = signer.getPublicKey();

    const isValid = await signer.verifyClaim(channelId, largeAmount, signature, publicKey);
    expect(isValid).toBe(true);
  });

  it('should enforce unique constraint on channel_id + amount', async () => {
    const channelId = '8'.repeat(64); // Use valid hex character
    const amount = '1000000000';

    // Sign first claim
    await signer.signClaim(channelId, amount);

    // Try to sign claim with same channel + amount (should fail due to DB unique constraint)
    // This should be prevented by the monotonic check, but let's verify DB constraint too
    await expect(
      // Bypass monotonic check by directly inserting
      new Promise((resolve, reject) => {
        try {
          db.prepare(
            `INSERT INTO xrp_claims (channel_id, amount, signature, public_key, created_at)
             VALUES (?, ?, ?, ?, ?)`
          ).run(channelId, amount, 'sig123', 'pk123', Date.now());
          resolve(true);
        } catch (error) {
          if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
            reject(new Error('UNIQUE constraint failed'));
          } else {
            reject(error);
          }
        }
      })
    ).rejects.toThrow('UNIQUE constraint');
  });
});
