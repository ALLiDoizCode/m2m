/**
 * Integration tests for PaymentChannelManager connecting to local rippled
 *
 * Prerequisites:
 * - Epic 7 local rippled service running (docker-compose-dev.yml)
 * - rippled accessible at ws://localhost:6006
 * - Genesis account funded for test operations
 *
 * To run these tests:
 * 1. Start rippled: docker-compose -f docker-compose-dev.yml up rippled
 * 2. Run tests: npm test -- xrp-channel-manager.test.ts
 *
 * Note: These tests are skipped if rippled is not available
 */

import { PaymentChannelManager } from '../../src/settlement/xrp-channel-manager';
import { XRPLClient, XRPLClientConfig } from '../../src/settlement/xrpl-client';
import Database from 'better-sqlite3';
import pino, { Logger } from 'pino';

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

describe('PaymentChannelManager Integration (Local rippled)', () => {
  let manager: PaymentChannelManager;
  let xrplClient: XRPLClient;
  let db: Database.Database;
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

    // Initialize XRPLClient (Story 9.1)
    xrplClient = new XRPLClient(TEST_CONFIG, logger);
    await xrplClient.connect();

    // Initialize in-memory SQLite database
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE xrp_channels (
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

      CREATE INDEX idx_xrp_channels_destination ON xrp_channels(destination);
      CREATE INDEX idx_xrp_channels_status ON xrp_channels(status);
    `);

    // Initialize PaymentChannelManager
    manager = new PaymentChannelManager(xrplClient, db, logger);
  });

  afterEach(async () => {
    if (xrplClient && xrplClient.isConnected()) {
      await xrplClient.disconnect();
    }
    if (db) {
      db.close();
    }
  });

  it('should create payment channel on local rippled', async () => {
    if (!rippledAvailable) {
      return;
    }

    // Check if account has sufficient balance
    const accountInfo = await xrplClient.getAccountInfo(TEST_CONFIG.accountAddress);
    const balance = BigInt(accountInfo.balance);

    // Need at least 1,010 XRP (1,000 for channel + 10 for reserve)
    if (balance < BigInt(1010000000)) {
      console.warn('⚠️  Insufficient balance for channel creation test, skipping');
      return;
    }

    const destination = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY'; // Well-known test address
    const amount = '1000000000'; // 1,000 XRP
    const settleDelay = 86400; // 24 hours

    const channelId = await manager.createChannel(destination, amount, settleDelay);

    expect(channelId).toBeDefined();
    expect(typeof channelId).toBe('string');
    expect(channelId.length).toBe(64); // 256-bit hash = 64 hex chars
    expect(channelId).toMatch(/^[0-9A-F]{64}$/i);

    // Verify channel exists on-ledger
    const channelState = await manager.getChannelState(channelId);
    expect(channelState).toMatchObject({
      channelId: channelId,
      account: TEST_CONFIG.accountAddress,
      destination: destination,
      amount: amount,
      balance: '0',
      settleDelay: settleDelay,
      status: 'open',
    });

    // eslint-disable-next-line no-console
    console.log(`Payment channel created: ${channelId}`);
  }, 30000); // 30 second timeout for channel creation

  it('should fund existing channel on local rippled', async () => {
    if (!rippledAvailable) {
      return;
    }

    // Check if account has sufficient balance
    const accountInfo = await xrplClient.getAccountInfo(TEST_CONFIG.accountAddress);
    const balance = BigInt(accountInfo.balance);

    // Need at least 1,510 XRP (1,000 initial + 500 additional + 10 reserve)
    if (balance < BigInt(1510000000)) {
      console.warn('⚠️  Insufficient balance for channel funding test, skipping');
      return;
    }

    const destination = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
    const initialAmount = '1000000000'; // 1,000 XRP
    const additionalAmount = '500000000'; // 500 XRP

    // Create channel
    const channelId = await manager.createChannel(destination, initialAmount, 86400);

    // Fund channel
    await manager.fundChannel(channelId, additionalAmount);

    // Verify new amount on-ledger
    const channelState = await manager.getChannelState(channelId);
    expect(channelState.amount).toBe((BigInt(initialAmount) + BigInt(additionalAmount)).toString());

    // eslint-disable-next-line no-console
    console.log(`Payment channel funded: ${channelId}, new amount: ${channelState.amount} drops`);
  }, 60000); // 60 second timeout for channel creation + funding

  it('should track multiple channels for same peer', async () => {
    if (!rippledAvailable) {
      return;
    }

    // Check if account has sufficient balance
    const accountInfo = await xrplClient.getAccountInfo(TEST_CONFIG.accountAddress);
    const balance = BigInt(accountInfo.balance);

    // Need at least 3,010 XRP (1,000 + 2,000 + 10 reserve)
    if (balance < BigInt(3010000000)) {
      console.warn('⚠️  Insufficient balance for multiple channels test, skipping');
      return;
    }

    const destination = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';

    // Create two channels
    const channelId1 = await manager.createChannel(destination, '1000000000', 86400);
    const channelId2 = await manager.createChannel(destination, '2000000000', 86400);

    expect(channelId1).not.toBe(channelId2); // Different channel IDs

    // Verify both channels tracked
    const channels = await manager.getChannelsForPeer(destination);
    expect(channels).toContain(channelId1);
    expect(channels).toContain(channelId2);
    expect(channels.length).toBe(2);

    // eslint-disable-next-line no-console
    console.log(`Multiple channels created for peer: ${channelId1}, ${channelId2}`);
  }, 90000); // 90 second timeout for creating 2 channels
});
