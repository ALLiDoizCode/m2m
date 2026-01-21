/**
 * Integration Test: XRP Channel Lifecycle Across Multiple Peers
 *
 * Tests XRP channel lifecycle management with real XRPChannelSDK integration:
 * - Multi-peer XRP channel management
 * - Automatic channel opening when settlement needed
 * - Channel funding when balance low
 * - Idle channel detection and closure
 *
 * Prerequisites:
 * - Epic 7 local rippled service running (docker-compose-dev.yml)
 * - rippled accessible at ws://localhost:6006
 * - Genesis account funded for test operations
 *
 * To run these tests:
 * 1. Start rippled: docker-compose -f docker-compose-dev.yml up rippled
 * 2. Run tests: npm test -- xrp-channel-lifecycle.test.ts
 *
 * Note: These tests are skipped if rippled is not available
 */

import {
  XRPChannelLifecycleManager,
  XRPChannelLifecycleConfig,
} from '../../src/settlement/xrp-channel-lifecycle';
import { XRPChannelSDK } from '../../src/settlement/xrp-channel-sdk';
import { XRPLClient, XRPLClientConfig } from '../../src/settlement/xrpl-client';
import { PaymentChannelManager } from '../../src/settlement/xrp-channel-manager';
import { ClaimSigner } from '../../src/settlement/xrp-claim-signer';
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

describe('XRP Channel Lifecycle Integration', () => {
  let manager: XRPChannelLifecycleManager;
  let xrpChannelSDK: XRPChannelSDK;
  let xrplClient: XRPLClient;
  let channelManager: PaymentChannelManager;
  let claimSigner: ClaimSigner;
  let db: Database.Database;
  let config: XRPChannelLifecycleConfig;
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

    // Initialize XRPLClient
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

      CREATE TABLE xrp_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        amount TEXT NOT NULL,
        signature TEXT NOT NULL,
        public_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_xrp_claims_channel ON xrp_claims(channel_id);
    `);

    // Initialize components for XRP Channel SDK
    channelManager = new PaymentChannelManager(xrplClient, db, logger);
    claimSigner = new ClaimSigner(db, logger);

    // Initialize XRP Channel SDK
    xrpChannelSDK = new XRPChannelSDK(xrplClient, channelManager, claimSigner, logger);

    // Initialize lifecycle config with shorter thresholds for testing
    config = {
      enabled: true,
      initialChannelAmount: '1000000000', // 1,000 XRP
      defaultSettleDelay: 86400, // 24 hours
      idleChannelThreshold: 3600, // 1 hour for faster testing
      minBalanceThreshold: 0.3, // 30%
      cancelAfter: 86400, // 24 hours
    };

    // Initialize lifecycle manager
    manager = new XRPChannelLifecycleManager(config, xrpChannelSDK, logger);
    await manager.start();
  });

  afterEach(async () => {
    if (manager) {
      manager.stop();
    }
    if (xrplClient && xrplClient.isConnected()) {
      await xrplClient.disconnect();
    }
    if (db) {
      db.close();
    }
  });

  it('should manage channels for multiple peers (AC: 2, 3, 10)', async () => {
    if (!rippledAvailable) {
      return;
    }

    // Check if account has sufficient balance for 3 channels
    const accountInfo = await xrplClient.getAccountInfo(TEST_CONFIG.accountAddress);
    const balance = BigInt(accountInfo.balance);

    // Need at least 3,030 XRP (3 × 1,000 for channels + 30 for reserve)
    if (balance < BigInt(3030000000)) {
      console.warn('⚠️  Insufficient balance for multi-peer test, skipping');
      return;
    }

    // Create channels for 3 different peers
    const channelIdAlice = await manager.getOrCreateChannel(
      'peer-alice',
      'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY'
    );
    const channelIdBob = await manager.getOrCreateChannel(
      'peer-bob',
      'rfqviLZd8hLfVe3aK4tN8XSUfC8pQsyuU5'
    );
    const channelIdCharlie = await manager.getOrCreateChannel(
      'peer-charlie',
      'rLUEXYuLiQptky37CqLcm9USQpPiz5rkpD'
    );

    // Verify all channels created
    expect(channelIdAlice).toBeDefined();
    expect(channelIdBob).toBeDefined();
    expect(channelIdCharlie).toBeDefined();

    // Verify channels tracked separately
    const aliceChannel = manager.getChannelForPeer('peer-alice');
    const bobChannel = manager.getChannelForPeer('peer-bob');
    const charlieChannel = manager.getChannelForPeer('peer-charlie');

    expect(aliceChannel!.channelId).toBe(channelIdAlice);
    expect(bobChannel!.channelId).toBe(channelIdBob);
    expect(charlieChannel!.channelId).toBe(channelIdCharlie);

    // Verify channel state for each peer
    expect(aliceChannel!.peerId).toBe('peer-alice');
    expect(aliceChannel!.amount).toBe('1000000000');
    expect(aliceChannel!.status).toBe('open');

    expect(bobChannel!.peerId).toBe('peer-bob');
    expect(bobChannel!.amount).toBe('1000000000');
    expect(bobChannel!.status).toBe('open');

    expect(charlieChannel!.peerId).toBe('peer-charlie');
    expect(charlieChannel!.amount).toBe('1000000000');
    expect(charlieChannel!.status).toBe('open');

    // eslint-disable-next-line no-console
    console.log(
      `Created channels: Alice=${channelIdAlice.substring(0, 8)}..., Bob=${channelIdBob.substring(0, 8)}..., Charlie=${channelIdCharlie.substring(0, 8)}...`
    );
  }, 90000); // 90 second timeout for multiple channel creations

  it('should fund channel when balance low (AC: 5)', async () => {
    if (!rippledAvailable) {
      return;
    }

    // Check if account has sufficient balance
    const accountInfo = await xrplClient.getAccountInfo(TEST_CONFIG.accountAddress);
    const balance = BigInt(accountInfo.balance);

    // Need at least 1,510 XRP (1,000 for channel + 500 for funding + 10 for reserve)
    if (balance < BigInt(1510000000)) {
      console.warn('⚠️  Insufficient balance for funding test, skipping');
      return;
    }

    const channelId = await manager.getOrCreateChannel(
      'peer-dave',
      'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY'
    );

    // Simulate 75% claimed (below 30% threshold)
    manager.updateChannelActivity('peer-dave', '750000000'); // 750 XRP claimed

    // Check if funding needed
    expect(manager.needsFunding('peer-dave')).toBe(true);

    // Fund channel with additional 500 XRP
    await manager.fundChannel('peer-dave', '500000000');

    // Verify channel amount updated
    const channel = manager.getChannelForPeer('peer-dave');
    expect(channel!.amount).toBe('1500000000'); // 1,000 + 500 XRP

    // eslint-disable-next-line no-console
    console.log(`Channel funded: ${channelId.substring(0, 8)}... - Amount increased to 1,500 XRP`);
  }, 60000); // 60 second timeout for funding

  it('should close idle channel after threshold (AC: 6, 7)', async () => {
    if (!rippledAvailable) {
      return;
    }

    // Check if account has sufficient balance
    const accountInfo = await xrplClient.getAccountInfo(TEST_CONFIG.accountAddress);
    const balance = BigInt(accountInfo.balance);

    // Need at least 1,010 XRP (1,000 for channel + 10 for reserve)
    if (balance < BigInt(1010000000)) {
      console.warn('⚠️  Insufficient balance for idle channel test, skipping');
      return;
    }

    const channelId = await manager.getOrCreateChannel(
      'peer-eve',
      'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY'
    );

    // Manually set last activity to 2 hours ago (exceeds 1h test threshold)
    const channel = manager.getChannelForPeer('peer-eve')!;
    channel.lastActivityAt = Date.now() - 2 * 3600 * 1000;

    // Trigger idle detection
    await manager['detectIdleChannels']();

    // Verify channel closed
    const closedChannel = manager.getChannelForPeer('peer-eve');
    expect(closedChannel!.status).toBe('closing');

    // eslint-disable-next-line no-console
    console.log(`Idle channel closed: ${channelId.substring(0, 8)}... - Status: closing`);
  }, 60000); // 60 second timeout for closure

  it('should return existing channel on second call (AC: 2)', async () => {
    if (!rippledAvailable) {
      return;
    }

    // Check if account has sufficient balance
    const accountInfo = await xrplClient.getAccountInfo(TEST_CONFIG.accountAddress);
    const balance = BigInt(accountInfo.balance);

    // Need at least 1,010 XRP (1,000 for channel + 10 for reserve)
    if (balance < BigInt(1010000000)) {
      console.warn('⚠️  Insufficient balance for existing channel test, skipping');
      return;
    }

    // Create channel first time
    const channelId1 = await manager.getOrCreateChannel(
      'peer-frank',
      'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY'
    );

    // Call again - should return existing channel without creating new one
    const channelId2 = await manager.getOrCreateChannel(
      'peer-frank',
      'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY'
    );

    // Verify same channel returned
    expect(channelId1).toBe(channelId2);

    // Verify only one channel exists in database
    const channels = db
      .prepare('SELECT COUNT(*) as count FROM xrp_channels WHERE destination = ?')
      .get('rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY') as { count: number };

    expect(channels.count).toBe(1);

    // eslint-disable-next-line no-console
    console.log(`Existing channel reused: ${channelId1.substring(0, 8)}...`);
  }, 45000); // 45 second timeout

  it('should detect expiring channels (AC: 8)', async () => {
    if (!rippledAvailable) {
      return;
    }

    // Check if account has sufficient balance
    const accountInfo = await xrplClient.getAccountInfo(TEST_CONFIG.accountAddress);
    const balance = BigInt(accountInfo.balance);

    // Need at least 1,010 XRP (1,000 for channel + 10 for reserve)
    if (balance < BigInt(1010000000)) {
      console.warn('⚠️  Insufficient balance for expiration test, skipping');
      return;
    }

    const channelId = await manager.getOrCreateChannel(
      'peer-george',
      'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY'
    );

    // Manually set cancelAfter to 30 minutes from now (within 1 hour buffer)
    const channel = manager.getChannelForPeer('peer-george')!;
    channel.cancelAfter = Math.floor(Date.now() / 1000) + 1800; // 30 minutes

    // Trigger expiration detection
    await manager['detectExpiringChannels']();

    // Verify channel closed
    const closedChannel = manager.getChannelForPeer('peer-george');
    expect(closedChannel!.status).toBe('closing');

    // eslint-disable-next-line no-console
    console.log(`Expiring channel closed: ${channelId.substring(0, 8)}... - Status: closing`);
  }, 60000); // 60 second timeout
});
