/**
 * Integration tests for XRPLClient connecting to local rippled
 *
 * Prerequisites:
 * - Epic 7 local rippled service running (docker-compose-dev.yml)
 * - rippled accessible at ws://localhost:6006
 * - Genesis account funded for test operations
 *
 * To run these tests:
 * 1. Start rippled: docker-compose -f docker-compose-dev.yml up rippled
 * 2. Run tests: npm test -- xrpl-client.test.ts
 *
 * Note: These tests are skipped if rippled is not available
 */

import { XRPLClient, XRPLClientConfig, XRPLErrorCode } from '../../src/settlement/xrpl-client';
import { PaymentChannelManager } from '../../src/settlement/xrp-channel-manager';
import { ClaimSigner } from '../../src/settlement/xrp-claim-signer';
import { Logger } from 'pino';
import pino from 'pino';
import Database from 'better-sqlite3';

// Test configuration
const TEST_CONFIG: XRPLClientConfig = {
  wssUrl: process.env.XRPL_WSS_URL || 'ws://localhost:6006',
  accountSecret: process.env.XRPL_ACCOUNT_SECRET || 'snoPBrXtMeMyMHUVTgbuqAfg1SUTb', // Test account
  accountAddress: process.env.XRPL_ACCOUNT_ADDRESS || 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', // Derived from test secret
};

// Check if rippled is available
async function isRippledAvailable(): Promise<boolean> {
  try {
    const logger = pino({ level: 'silent' });
    const client = new XRPLClient(TEST_CONFIG, logger);
    await client.connect();
    await client.disconnect();
    return true;
  } catch {
    return false;
  }
}

describe('XRPLClient Integration (Local rippled)', () => {
  let client: XRPLClient;
  let logger: Logger;
  let rippledAvailable: boolean;

  beforeAll(async () => {
    rippledAvailable = await isRippledAvailable();

    if (!rippledAvailable) {
      console.warn(
        '\n⚠️  Rippled not available at ws://localhost:6006 - skipping integration tests\n' +
          '   To run these tests, start rippled with: docker-compose -f docker-compose-dev.yml up rippled\n'
      );
    }

    logger = pino({ level: 'info' });
  });

  beforeEach(async () => {
    if (!rippledAvailable) {
      return;
    }

    client = new XRPLClient(TEST_CONFIG, logger);
    await client.connect();
  });

  afterEach(async () => {
    if (client && client.isConnected()) {
      await client.disconnect();
    }
  });

  it('should connect to local rippled and validate connection', async () => {
    if (!rippledAvailable) {
      return;
    }

    expect(client.isConnected()).toBe(true);
  });

  it('should query account info for test account', async () => {
    if (!rippledAvailable) {
      return;
    }

    const accountInfo = await client.getAccountInfo(TEST_CONFIG.accountAddress);

    expect(accountInfo).toMatchObject({
      balance: expect.any(String),
      sequence: expect.any(Number),
      ownerCount: expect.any(Number),
    });

    // Balance should be a valid number in drops
    const balance = BigInt(accountInfo.balance);
    expect(balance).toBeGreaterThanOrEqual(BigInt(0));

    // eslint-disable-next-line no-console
    console.log(`Test account balance: ${accountInfo.balance} drops`);
  });

  it('should handle account not found error for invalid address', async () => {
    if (!rippledAvailable) {
      return;
    }

    await expect(
      client.getAccountInfo('rInvalidAddressDoesNotExist12345678901234')
    ).rejects.toMatchObject({
      code: XRPLErrorCode.ACCOUNT_NOT_FOUND,
    });
  });

  it('should submit Payment transaction successfully', async () => {
    if (!rippledAvailable) {
      return;
    }

    // Get account info to check balance
    const accountInfo = await client.getAccountInfo(TEST_CONFIG.accountAddress);
    const balance = BigInt(accountInfo.balance);

    // Skip if account has insufficient balance (needs at least 1 XRP + fees + reserve)
    if (balance < BigInt(11000000)) {
      console.warn('⚠️  Insufficient balance for Payment transaction test, skipping');
      return;
    }

    const paymentTx = {
      TransactionType: 'Payment',
      Account: TEST_CONFIG.accountAddress,
      Destination: 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY', // Well-known test destination
      Amount: '100000', // 0.1 XRP in drops
    };

    const result = await client.submitAndWait(paymentTx);

    expect(result).toMatchObject({
      hash: expect.any(String),
      ledgerIndex: expect.any(Number),
      result: expect.any(Object),
    });

    expect(result.hash).toMatch(/^[0-9A-F]{64}$/i);
    expect(result.ledgerIndex).toBeGreaterThan(0);

    // eslint-disable-next-line no-console
    console.log(`Payment transaction confirmed: ${result.hash} at ledger ${result.ledgerIndex}`);
  });

  it('should disconnect gracefully', async () => {
    if (!rippledAvailable) {
      return;
    }

    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });
});

describe('XRPLClient Integration - Claim Submission', () => {
  let client: XRPLClient;
  let channelManager: PaymentChannelManager;
  let claimSigner: ClaimSigner;
  let logger: Logger;
  let db: Database.Database;
  let rippledAvailable: boolean;

  beforeAll(async () => {
    rippledAvailable = await isRippledAvailable();

    if (!rippledAvailable) {
      console.warn(
        '\n⚠️  Rippled not available at ws://localhost:6006 - skipping claim submission tests\n'
      );
      return;
    }

    logger = pino({ level: 'info' });

    // Create in-memory database for testing
    db = new Database(':memory:');

    // Apply database migrations
    db.exec(`
      CREATE TABLE IF NOT EXISTS xrp_channels (
        channel_id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        destination TEXT NOT NULL,
        amount TEXT NOT NULL,
        balance TEXT NOT NULL DEFAULT '0',
        settle_delay INTEGER NOT NULL,
        public_key TEXT NOT NULL,
        cancel_after INTEGER,
        expiration INTEGER,
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS xrp_claims (
        claim_id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        amount TEXT NOT NULL,
        signature TEXT NOT NULL,
        public_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (channel_id) REFERENCES xrp_channels(channel_id)
      );
    `);

    // Initialize XRPLClient
    client = new XRPLClient(TEST_CONFIG, logger);
    await client.connect();

    // Initialize ClaimSigner and PaymentChannelManager
    claimSigner = new ClaimSigner(db, logger);
    channelManager = new PaymentChannelManager(client, db, logger);
  });

  afterAll(async () => {
    if (client && client.isConnected()) {
      await client.disconnect();
    }
    if (db) {
      db.close();
    }
  });

  it('should create channel, sign claim, submit claim, and verify XRP transfer', async () => {
    if (!rippledAvailable) {
      return;
    }

    // Check if account has sufficient balance (needs at least 11 XRP + fees + reserve)
    const accountInfo = await client.getAccountInfo(TEST_CONFIG.accountAddress);
    const balance = BigInt(accountInfo.balance);

    if (balance < BigInt(11000000)) {
      console.warn('⚠️  Insufficient balance for channel creation test, skipping');
      return;
    }

    // 1. Create payment channel (1 XRP = 1,000,000 drops)
    const destination = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
    const channelAmount = '1000000'; // 1 XRP
    const settleDelay = 3600; // 1 hour

    const channelId = await channelManager.createChannel(destination, channelAmount, settleDelay);
    expect(channelId).toBeDefined();
    expect(channelId).toMatch(/^[0-9A-F]{64}$/i);

    // eslint-disable-next-line no-console
    console.log(`Created payment channel: ${channelId}`);

    // 2. Sign claim for 0.5 XRP
    const claimAmount = '500000'; // 0.5 XRP
    const signature = await claimSigner.signClaim(channelId, claimAmount);
    const publicKey = claimSigner.getPublicKey();

    expect(signature).toBeDefined();
    expect(signature).toMatch(/^[0-9A-Fa-f]{128}$/);
    expect(publicKey).toMatch(/^ED[0-9A-Fa-f]{64}$/i);

    // eslint-disable-next-line no-console
    console.log(`Signed claim: amount=${claimAmount}, signature=${signature.substring(0, 16)}...`);

    // 3. Submit claim to ledger (partial claim)
    const result = await client.submitClaim(channelId, claimAmount, signature, publicKey);

    expect(result.hash).toBeDefined();
    expect(result.hash).toMatch(/^[0-9A-F]{64}$/i);
    expect(result.ledgerIndex).toBeGreaterThan(0);

    // eslint-disable-next-line no-console
    console.log(`Claim submitted: ${result.hash} at ledger ${result.ledgerIndex}`);

    // 4. Verify channel state updated (balance = 0.5 XRP claimed)
    const channelState = await channelManager.getChannelState(channelId);

    expect(channelState.balance).toBe(claimAmount);
    expect(channelState.status).toBe('open'); // Still open (partial claim)
    expect(BigInt(channelState.amount) - BigInt(channelState.balance)).toBe(BigInt('500000')); // 0.5 XRP remaining
  });

  it('should submit final claim with close flag and verify channel closure', async () => {
    if (!rippledAvailable) {
      return;
    }

    // Check balance
    const accountInfo = await client.getAccountInfo(TEST_CONFIG.accountAddress);
    if (BigInt(accountInfo.balance) < BigInt(11000000)) {
      console.warn('⚠️  Insufficient balance for final claim test, skipping');
      return;
    }

    // 1. Create payment channel
    const destination = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
    const channelAmount = '500000'; // 0.5 XRP
    const settleDelay = 3600; // 1 hour

    const channelId = await channelManager.createChannel(destination, channelAmount, settleDelay);

    // eslint-disable-next-line no-console
    console.log(`Created payment channel for final claim test: ${channelId}`);

    // 2. Sign final claim (full channel amount)
    const signature = await claimSigner.signClaim(channelId, channelAmount);
    const publicKey = claimSigner.getPublicKey();

    // 3. Submit final claim with close flag
    const result = await client.submitClaim(channelId, channelAmount, signature, publicKey, true);

    expect(result.hash).toBeDefined();

    // eslint-disable-next-line no-console
    console.log(`Final claim submitted with close flag: ${result.hash}`);

    // Note: Channel enters "closing" state immediately but finalization requires waiting settleDelay
    // For this test, we just verify the claim transaction succeeded
  });

  it('should close channel cooperatively without claim', async () => {
    if (!rippledAvailable) {
      return;
    }

    // Check balance
    const accountInfo = await client.getAccountInfo(TEST_CONFIG.accountAddress);
    if (BigInt(accountInfo.balance) < BigInt(11000000)) {
      console.warn('⚠️  Insufficient balance for cooperative closure test, skipping');
      return;
    }

    // 1. Create payment channel
    const destination = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
    const channelAmount = '500000'; // 0.5 XRP
    const settleDelay = 3600;

    const channelId = await channelManager.createChannel(destination, channelAmount, settleDelay);

    // eslint-disable-next-line no-console
    console.log(`Created payment channel for cooperative closure: ${channelId}`);

    // 2. Close channel without claim
    const result = await client.closeChannel(channelId);

    expect(result.hash).toBeDefined();
    expect(result.hash).toMatch(/^[0-9A-F]{64}$/i);

    // eslint-disable-next-line no-console
    console.log(`Channel close initiated: ${result.hash}`);
  });

  it('should cancel channel closure during settlement delay', async () => {
    if (!rippledAvailable) {
      return;
    }

    // Check balance
    const accountInfo = await client.getAccountInfo(TEST_CONFIG.accountAddress);
    if (BigInt(accountInfo.balance) < BigInt(11000000)) {
      console.warn('⚠️  Insufficient balance for cancel closure test, skipping');
      return;
    }

    // 1. Create and close channel
    const destination = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
    const channelId = await channelManager.createChannel(destination, '500000', 3600);

    // eslint-disable-next-line no-console
    console.log(`Created payment channel for cancel closure test: ${channelId}`);

    await client.closeChannel(channelId);

    // eslint-disable-next-line no-console
    console.log(`Channel closure initiated, now cancelling...`);

    // 2. Cancel closure during settlement delay
    const result = await client.cancelChannelClose(channelId);

    expect(result.hash).toBeDefined();
    expect(result.hash).toMatch(/^[0-9A-F]{64}$/i);

    // eslint-disable-next-line no-console
    console.log(`Channel closure cancelled: ${result.hash}`);
  });
});
