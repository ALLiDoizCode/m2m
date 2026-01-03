/**
 * Settlement Threshold Detection Integration Test
 *
 * End-to-end test demonstrating settlement threshold detection with real TigerBeetle.
 * Sends packets to exceed threshold, verifies settlement trigger event emitted.
 *
 * Prerequisites:
 * - TigerBeetle container running with port 3000 exposed
 * - docker-compose up -d tigerbeetle
 *
 * Test Flow:
 * 1. Create AccountManager with low credit limit and threshold
 * 2. Create SettlementMonitor with low threshold (100 units)
 * 3. Manually record transfers to simulate packet forwarding
 * 4. Verify SETTLEMENT_REQUIRED event emitted when threshold exceeded
 *
 * @packageDocumentation
 */

import { AccountManager } from '../../src/settlement/account-manager';
import { SettlementMonitor } from '../../src/settlement/settlement-monitor';
import { TigerBeetleClient } from '../../src/settlement/tigerbeetle-client';
import { SettlementState, SettlementTriggerEvent } from '../../src/config/types';
import pino from 'pino';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Integration test timeout - 3 minutes for Docker + polling cycles
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

describeIfE2E('Settlement Threshold Detection Integration Test', () => {
  let accountManager: AccountManager;
  let settlementMonitor: SettlementMonitor;
  let tigerBeetleClient: TigerBeetleClient;
  let logger: pino.Logger;

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
      console.log('3. Run tests: npm test -- settlement-threshold-detection.test.ts');
      return;
    }

    // Initialize logger (silent for tests, but can enable for debugging)
    logger = pino({ level: 'silent' });

    // Initialize TigerBeetle client
    tigerBeetleClient = new TigerBeetleClient(
      {
        clusterId: 0,
        replicaAddresses: ['127.0.0.1:3000'],
        connectionTimeout: 5000,
        operationTimeout: 5000,
      },
      logger
    );

    await tigerBeetleClient.initialize();

    // Initialize AccountManager with unique node ID
    const nodeId = `threshold-test-${Date.now()}`;
    accountManager = new AccountManager({ nodeId }, tigerBeetleClient, logger);

    console.log('TigerBeetle client and AccountManager initialized for threshold test');
  });

  afterAll(async () => {
    // Stop settlement monitor
    if (settlementMonitor) {
      await settlementMonitor.stop();
    }

    // Close TigerBeetle client
    if (tigerBeetleClient) {
      await tigerBeetleClient.close();
    }
  });

  it('should detect threshold crossing and emit settlement trigger event', async () => {
    if (!dockerAvailable || !tigerBeetleAvailable) {
      console.log('Skipping test - prerequisites not met');
      return;
    }

    // Test Configuration
    const peerId = 'peer-test-a';
    const tokenId = 'ILP';
    const threshold = 100n; // Low threshold for fast test
    const pollingInterval = 2000; // 2 seconds for faster detection

    // Step 1: Create peer accounts
    await accountManager.createPeerAccounts(peerId, tokenId);

    // Verify initial balance is zero
    const initialBalance = await accountManager.getAccountBalance(peerId, tokenId);
    expect(initialBalance.creditBalance).toBe(0n);
    expect(initialBalance.debitBalance).toBe(0n);

    // Step 2: Create SettlementMonitor with low threshold
    settlementMonitor = new SettlementMonitor(
      {
        thresholds: {
          defaultThreshold: threshold,
          pollingInterval,
        },
        peers: [peerId],
        tokenIds: [tokenId],
      },
      accountManager,
      logger
    );

    // Step 3: Set up event listener
    const settlementEvents: SettlementTriggerEvent[] = [];

    settlementMonitor.on('SETTLEMENT_REQUIRED', (event: SettlementTriggerEvent) => {
      settlementEvents.push(event);
    });

    // Step 4: Start monitoring
    await settlementMonitor.start();

    // Verify initial state is IDLE
    expect(settlementMonitor.getSettlementState(peerId, tokenId)).toBe(SettlementState.IDLE);

    // Step 5: Simulate packet forwarding by recording transfers
    // Transfer 1: 50 units (below threshold)
    await accountManager.recordPacketTransfers({
      incomingPeerId: peerId,
      outgoingPeerId: 'peer-test-b',
      tokenId,
      originalAmount: 50n,
      forwardedAmount: 49n,
      connectorFee: 1n,
      transferIdSeed: BigInt(Date.now()),
      packetId: 'packet-1',
    });

    // Check balance after first transfer
    let balance = await accountManager.getAccountBalance(peerId, tokenId);
    expect(balance.creditBalance).toBe(50n); // Peer owes us 50

    // No event should be emitted yet (below threshold)
    expect(settlementEvents.length).toBe(0);
    expect(settlementMonitor.getSettlementState(peerId, tokenId)).toBe(SettlementState.IDLE);

    // Transfer 2: 40 units (total 90, still below threshold)
    await accountManager.recordPacketTransfers({
      incomingPeerId: peerId,
      outgoingPeerId: 'peer-test-b',
      tokenId,
      originalAmount: 40n,
      forwardedAmount: 40n,
      connectorFee: 0n,
      transferIdSeed: BigInt(Date.now() + 1),
      packetId: 'packet-2',
    });

    balance = await accountManager.getAccountBalance(peerId, tokenId);
    expect(balance.creditBalance).toBe(90n);

    // Still no event (below threshold)
    expect(settlementEvents.length).toBe(0);

    // Transfer 3: 30 units (total 120, EXCEEDS threshold of 100)
    await accountManager.recordPacketTransfers({
      incomingPeerId: peerId,
      outgoingPeerId: 'peer-test-b',
      tokenId,
      originalAmount: 30n,
      forwardedAmount: 30n,
      connectorFee: 0n,
      transferIdSeed: BigInt(Date.now() + 2),
      packetId: 'packet-3',
    });

    balance = await accountManager.getAccountBalance(peerId, tokenId);
    expect(balance.creditBalance).toBe(120n); // Exceeds threshold

    // Step 6: Wait for polling cycle to detect threshold crossing
    // Wait up to 10 seconds (5 polling cycles at 2s interval)
    await new Promise((resolve) => setTimeout(resolve, 10000));

    // Step 7: Verify settlement event emitted
    expect(settlementEvents.length).toBe(1);

    const event = settlementEvents[0];
    expect(event.peerId).toBe(peerId);
    expect(event.tokenId).toBe(tokenId);
    expect(event.currentBalance).toBe(120n);
    expect(event.threshold).toBe(100n);
    expect(event.exceedsBy).toBe(20n);
    expect(event.timestamp).toBeInstanceOf(Date);

    // Step 8: Verify state transitioned to SETTLEMENT_PENDING
    expect(settlementMonitor.getSettlementState(peerId, tokenId)).toBe(
      SettlementState.SETTLEMENT_PENDING
    );

    // Step 9: Verify no duplicate triggers
    // Send another packet while state is SETTLEMENT_PENDING
    await accountManager.recordPacketTransfers({
      incomingPeerId: peerId,
      outgoingPeerId: 'peer-test-b',
      tokenId,
      originalAmount: 10n,
      forwardedAmount: 10n,
      connectorFee: 0n,
      transferIdSeed: BigInt(Date.now() + 3),
      packetId: 'packet-4',
    });

    balance = await accountManager.getAccountBalance(peerId, tokenId);
    expect(balance.creditBalance).toBe(130n); // Balance increased further

    // Wait for another polling cycle
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Verify still only ONE event (no duplicate)
    expect(settlementEvents.length).toBe(1);
  });

  it('should reset state to IDLE when balance drops below threshold', async () => {
    if (!dockerAvailable || !tigerBeetleAvailable) {
      console.log('Skipping test - prerequisites not met');
      return;
    }

    // Test Configuration
    const peerId = 'peer-test-reset';
    const tokenId = 'ILP';
    const threshold = 100n;
    const pollingInterval = 2000;

    // Create peer accounts
    await accountManager.createPeerAccounts(peerId, tokenId);

    // Create monitor
    settlementMonitor = new SettlementMonitor(
      {
        thresholds: {
          defaultThreshold: threshold,
          pollingInterval,
        },
        peers: [peerId],
        tokenIds: [tokenId],
      },
      accountManager,
      logger
    );

    await settlementMonitor.start();

    // Record transfer exceeding threshold
    await accountManager.recordPacketTransfers({
      incomingPeerId: peerId,
      outgoingPeerId: 'peer-test-b',
      tokenId,
      originalAmount: 120n,
      forwardedAmount: 120n,
      connectorFee: 0n,
      transferIdSeed: BigInt(Date.now() + 10),
      packetId: 'packet-exceed',
    });

    // Wait for threshold detection
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Verify state is SETTLEMENT_PENDING
    expect(settlementMonitor.getSettlementState(peerId, tokenId)).toBe(
      SettlementState.SETTLEMENT_PENDING
    );

    // Simulate settlement by recording reverse transfer
    // (This would normally be done by SettlementAPI in Story 6.7)
    await accountManager.recordPacketTransfers({
      incomingPeerId: 'peer-test-b',
      outgoingPeerId: peerId,
      tokenId,
      originalAmount: 50n,
      forwardedAmount: 50n,
      connectorFee: 0n,
      transferIdSeed: BigInt(Date.now() + 11),
      packetId: 'packet-settlement',
    });

    // Balance should now be 70 (below threshold)
    const balance = await accountManager.getAccountBalance(peerId, tokenId);
    expect(balance.creditBalance).toBe(70n);

    // Wait for polling cycle to detect balance drop
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Verify state reset to IDLE
    expect(settlementMonitor.getSettlementState(peerId, tokenId)).toBe(SettlementState.IDLE);
  });
});
