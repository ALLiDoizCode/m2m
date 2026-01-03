/**
 * Settlement API Execution Integration Test
 *
 * End-to-end test demonstrating settlement API with real TigerBeetle.
 * Tests manual settlement execution via HTTP API and balance reduction.
 *
 * Prerequisites:
 * - TigerBeetle container running with port 3000 exposed
 * - docker-compose up -d tigerbeetle
 *
 * Test Flow:
 * 1. Create AccountManager and SettlementMonitor
 * 2. Create Settlement API router and mount on Express server
 * 3. Record transfers to simulate packet forwarding (balance = 150 units)
 * 4. Call POST /settlement/execute via HTTP
 * 5. Verify balance reduced to zero in TigerBeetle
 * 6. Verify settlement state reset to IDLE
 *
 * @packageDocumentation
 */

import { AccountManager } from '../../src/settlement/account-manager';
import { SettlementMonitor } from '../../src/settlement/settlement-monitor';
import { TigerBeetleClient } from '../../src/settlement/tigerbeetle-client';
import { createSettlementRouter, SettlementAPIConfig } from '../../src/settlement/settlement-api';
import { SettlementState } from '../../src/config/types';
import pino from 'pino';
import { exec } from 'child_process';
import { promisify } from 'util';
import express, { Express } from 'express';
import request from 'supertest';

const execAsync = promisify(exec);

// Integration test timeout - 3 minutes for Docker + settlement flow
jest.setTimeout(180000);

// Skip tests unless E2E_TESTS is enabled (requires TigerBeetle container)
const e2eEnabled = process.env.E2E_TESTS === 'true';

/**
 * Check if Docker is available
 */
async function isDockerAvailable(): Promise<boolean> {
  try {
    await execAsync('docker --version');
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if TigerBeetle is accessible on port 3000
 */
async function isTigerBeetleAccessible(): Promise<boolean> {
  const logger = pino({ level: 'silent' });

  try {
    const client = new TigerBeetleClient(
      {
        clusterId: 0,
        replicaAddresses: ['127.0.0.1:3000'],
        connectionTimeout: 3000,
        operationTimeout: 3000,
      },
      logger
    );

    await Promise.race([
      client.initialize(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000)),
    ]);

    await client.close();
    return true;
  } catch {
    return false;
  }
}

const describeIfE2E = e2eEnabled ? describe : describe.skip;

describeIfE2E('Settlement API Execution Integration Test', () => {
  let accountManager: AccountManager;
  let settlementMonitor: SettlementMonitor;
  let tigerBeetleClient: TigerBeetleClient;
  let logger: pino.Logger;
  let app: Express;

  // Check prerequisites before running tests
  let dockerAvailable = false;
  let tigerBeetleAvailable = false;

  beforeAll(async () => {
    dockerAvailable = await isDockerAvailable();

    if (!dockerAvailable) {
      console.log('Docker not available, skipping integration test');
      return;
    }

    tigerBeetleAvailable = await isTigerBeetleAccessible();

    if (!tigerBeetleAvailable) {
      console.log('TigerBeetle not accessible on port 3000');
      console.log('To run this test:');
      console.log('1. Expose TigerBeetle port in docker-compose.yml:');
      console.log('   tigerbeetle:');
      console.log('     ports:');
      console.log('       - "3000:3000"');
      console.log('2. Run: docker-compose up -d tigerbeetle');
      return;
    }

    // Create test logger
    logger = pino({ level: 'info' });

    // Create TigerBeetle client
    tigerBeetleClient = new TigerBeetleClient(
      {
        clusterId: 0,
        replicaAddresses: ['127.0.0.1:3000'],
        connectionTimeout: 3000,
        operationTimeout: 3000,
      },
      logger
    );

    await tigerBeetleClient.initialize();

    // Create AccountManager with low settlement threshold
    accountManager = new AccountManager(
      {
        nodeId: 'test-connector',
        defaultLedger: 1,
        creditLimits: {
          defaultLimit: 1000n, // High credit limit (won't be hit)
        },
      },
      tigerBeetleClient,
      logger
    );

    // Create SettlementMonitor with low threshold (100 units)
    settlementMonitor = new SettlementMonitor(
      {
        thresholds: {
          defaultThreshold: 100n, // Low threshold for testing
          pollingInterval: 2000, // 2 seconds for fast detection
        },
        peers: ['peer-b'],
        tokenIds: ['ILP'],
      },
      accountManager,
      logger
    );

    // Create Express app with Settlement API
    const config: SettlementAPIConfig = {
      accountManager,
      settlementMonitor,
      logger,
      authToken: 'test-integration-token',
    };

    app = express();
    app.use(createSettlementRouter(config));

    // Start settlement monitor
    await settlementMonitor.start();
  });

  afterAll(async () => {
    if (tigerBeetleAvailable) {
      await settlementMonitor.stop();
      await tigerBeetleClient.close();
    }
  });

  test('should skip if Docker not available', () => {
    if (!dockerAvailable) {
      expect(true).toBe(true);
    }
  });

  test('should skip if TigerBeetle not accessible', () => {
    if (!tigerBeetleAvailable) {
      expect(true).toBe(true);
    }
  });

  test('should execute settlement via API and reduce balance to zero', async () => {
    if (!dockerAvailable || !tigerBeetleAvailable) {
      return;
    }

    // Create peer accounts
    await accountManager.createPeerAccounts('peer-b', 'ILP');

    // Record transfers to simulate packet forwarding
    // Send 3 packets (50, 50, 50) to exceed threshold (total = 150)
    // Generate unique transfer IDs
    const transferId1 = BigInt(Date.now()) * 1000000n;
    const transferId2 = transferId1 + 1n;
    await accountManager.recordPacketTransfers(
      'peer-a', // From peer
      'peer-b', // To peer
      'ILP',
      50n, // Incoming amount
      50n, // Outgoing amount
      transferId1,
      transferId2,
      1, // Ledger
      0 // Code (packet transfer)
    );

    const transferId3 = transferId2 + 1n;
    const transferId4 = transferId3 + 1n;
    await accountManager.recordPacketTransfers(
      'peer-a',
      'peer-b',
      'ILP',
      50n,
      50n,
      transferId3,
      transferId4,
      1,
      0
    );

    const transferId5 = transferId4 + 1n;
    const transferId6 = transferId5 + 1n;
    await accountManager.recordPacketTransfers(
      'peer-a',
      'peer-b',
      'ILP',
      50n,
      50n,
      transferId5,
      transferId6,
      1,
      0
    );

    // Verify balance before settlement
    const balanceBefore = await accountManager.getAccountBalance('peer-b', 'ILP');
    expect(balanceBefore.creditBalance).toBe(150n);

    // Call Settlement API to execute settlement
    const response = await request(app)
      .post('/settlement/execute')
      .set('Authorization', 'Bearer test-integration-token')
      .send({ peerId: 'peer-b', tokenId: 'ILP' })
      .expect(200);

    // Verify response
    expect(response.body).toMatchObject({
      success: true,
      peerId: 'peer-b',
      tokenId: 'ILP',
      previousBalance: '150',
      newBalance: '0',
      settledAmount: '150',
    });
    expect(response.body.timestamp).toBeDefined();

    // Verify balance actually reduced in TigerBeetle
    const balanceAfter = await accountManager.getAccountBalance('peer-b', 'ILP');
    expect(balanceAfter.creditBalance).toBe(0n);

    // Verify settlement state reset to IDLE
    const state = settlementMonitor.getSettlementState('peer-b', 'ILP');
    expect(state).toBe(SettlementState.IDLE);
  });

  test('should reject settlement API call with invalid auth token', async () => {
    if (!dockerAvailable || !tigerBeetleAvailable) {
      return;
    }

    // Verify balance before (should still be 0 from previous test)
    const balanceBefore = await accountManager.getAccountBalance('peer-b', 'ILP');

    // Call Settlement API with wrong token
    const response = await request(app)
      .post('/settlement/execute')
      .set('Authorization', 'Bearer wrong-token')
      .send({ peerId: 'peer-b', tokenId: 'ILP' })
      .expect(403);

    expect(response.body.error).toContain('Invalid token');

    // Verify balance unchanged
    const balanceAfter = await accountManager.getAccountBalance('peer-b', 'ILP');
    expect(balanceAfter.creditBalance).toBe(balanceBefore.creditBalance);
  });

  test('should reject settlement API call with missing auth token', async () => {
    if (!dockerAvailable || !tigerBeetleAvailable) {
      return;
    }

    // Call Settlement API without Authorization header
    const response = await request(app)
      .post('/settlement/execute')
      .send({ peerId: 'peer-b', tokenId: 'ILP' })
      .expect(401);

    expect(response.body.error).toContain('Bearer token required');
  });

  test('should automatically execute settlement when threshold exceeded', async () => {
    if (!dockerAvailable || !tigerBeetleAvailable) {
      return;
    }

    // Create new peer account for automatic settlement test
    await accountManager.createPeerAccounts('peer-c', 'ILP');

    // Record transfers to exceed threshold (120 > 100)
    const transferId7 = BigInt(Date.now()) * 1000000n + 7n;
    const transferId8 = transferId7 + 1n;
    await accountManager.recordPacketTransfers(
      'peer-a',
      'peer-c',
      'ILP',
      60n,
      60n,
      transferId7,
      transferId8,
      1,
      0
    );

    const transferId9 = transferId8 + 1n;
    const transferId10 = transferId9 + 1n;
    await accountManager.recordPacketTransfers(
      'peer-a',
      'peer-c',
      'ILP',
      60n,
      60n,
      transferId9,
      transferId10,
      1,
      0
    );

    // Verify balance before automatic settlement
    const balanceBefore = await accountManager.getAccountBalance('peer-c', 'ILP');
    expect(balanceBefore.creditBalance).toBe(120n);

    // Wait for settlement monitor polling cycle + settlement execution
    // Polling interval: 2 seconds, settlement delay: 100ms
    // Add buffer: 5 seconds total
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Verify balance automatically reduced to zero
    const balanceAfter = await accountManager.getAccountBalance('peer-c', 'ILP');
    expect(balanceAfter.creditBalance).toBe(0n);

    // Verify settlement state reset to IDLE
    const state = settlementMonitor.getSettlementState('peer-c', 'ILP');
    expect(state).toBe(SettlementState.IDLE);
  });

  test('should query settlement status via API', async () => {
    if (!dockerAvailable || !tigerBeetleAvailable) {
      return;
    }

    // Create peer account
    await accountManager.createPeerAccounts('peer-d', 'ILP');

    // Record transfer (below threshold)
    const transferId11 = BigInt(Date.now()) * 1000000n + 11n;
    const transferId12 = transferId11 + 1n;
    await accountManager.recordPacketTransfers(
      'peer-a',
      'peer-d',
      'ILP',
      50n,
      50n,
      transferId11,
      transferId12,
      1,
      0
    );

    // Query settlement status via API
    const response = await request(app)
      .get('/settlement/status/peer-d')
      .query({ tokenId: 'ILP' })
      .set('Authorization', 'Bearer test-integration-token')
      .expect(200);

    // Verify response
    expect(response.body).toMatchObject({
      peerId: 'peer-d',
      tokenId: 'ILP',
      currentBalance: '50',
      settlementState: 'IDLE', // Below threshold, no settlement triggered
    });
    expect(response.body.timestamp).toBeDefined();
  });
});
