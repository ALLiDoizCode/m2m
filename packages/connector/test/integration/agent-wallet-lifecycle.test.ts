/**
 * Agent Wallet Lifecycle Integration Test
 * Story 11.5: Agent Wallet Lifecycle Management
 *
 * Integration test validating full lifecycle workflow (create → fund → transact → suspend → archive)
 * with real blockchain transactions using Anvil (EVM).
 *
 * Tests:
 * - Full lifecycle workflow with real blockchain transactions
 * - Multi-agent concurrent lifecycle operations
 * - Persistence and state restoration across restarts
 */

import { AgentWalletLifecycle, WalletState } from '../../src/wallet/agent-wallet-lifecycle';
import { AgentWalletDerivation } from '../../src/wallet/agent-wallet-derivation';
import { AgentBalanceTracker } from '../../src/wallet/agent-balance-tracker';
import { AgentWalletFunder, FundingConfig } from '../../src/wallet/agent-wallet-funder';
import { WalletSeedManager, MasterSeed } from '../../src/wallet/wallet-seed-manager';
import { TelemetryEmitter } from '../../src/telemetry/telemetry-emitter';
import { TreasuryWallet } from '../../src/wallet/treasury-wallet';
import { ethers } from 'ethers';
import { Client as XRPLClient } from 'xrpl';
import * as bip39 from 'bip39';
import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';
import pino from 'pino';

// Test mnemonic (deterministic for reproducibility)
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PASSWORD = 'TestLifecyclePass123!';

// Anvil configuration
const ANVIL_RPC_URL = 'http://127.0.0.1:8545';
const ANVIL_CHAIN_ID = 31337;

// Helper to create master seed
async function createTestMasterSeed(): Promise<MasterSeed> {
  const seed = await bip39.mnemonicToSeed(TEST_MNEMONIC);
  return {
    mnemonic: TEST_MNEMONIC,
    seed: Buffer.from(seed),
    createdAt: Date.now(),
  };
}

// Helper to start Anvil
function startAnvil(): child_process.ChildProcess {
  // Start Anvil with auto-mining enabled (instant mining by default)
  const anvil = child_process.spawn('anvil', ['--port', '8545'], {
    stdio: 'pipe',
  });

  // Log Anvil output for debugging
  anvil.stdout?.on('data', (data) => {
    // Only log the "Listening on" message
    const output = data.toString();
    if (output.includes('Listening on')) {
      // eslint-disable-next-line no-console
      console.log('Anvil:', output.trim());
    }
  });

  anvil.stderr?.on('data', (data) => {
    // eslint-disable-next-line no-console
    console.error('Anvil error:', data.toString());
  });

  return anvil;
}

// Helper to stop Anvil
function stopAnvil(anvil: child_process.ChildProcess): void {
  if (anvil && anvil.pid) {
    try {
      anvil.kill('SIGTERM');
    } catch (error) {
      // Ignore errors on cleanup
    }
  }
}

// Helper to wait for Anvil to be ready
async function waitForAnvil(provider: ethers.Provider, maxAttempts = 30): Promise<void> {
  // Give Anvil a moment to start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  for (let i = 0; i < maxAttempts; i++) {
    try {
      await provider.getBlockNumber();
      // eslint-disable-next-line no-console
      console.log('Anvil is ready!');
      return;
    } catch (error) {
      // Wait between attempts
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Anvil not ready after ${maxAttempts} attempts`);
}

// These tests require Anvil (Foundry's local Ethereum node)
// Skip in CI unless explicitly enabled with ANVIL_TESTS=true
const anvilTestsEnabled = process.env.ANVIL_TESTS === 'true';
const isCI = process.env.CI === 'true';
const describeIfAnvil = anvilTestsEnabled || !isCI ? describe : describe.skip;

describeIfAnvil('Agent Wallet Lifecycle Integration', () => {
  let seedManager: WalletSeedManager;
  let walletDerivation: AgentWalletDerivation;
  let balanceTracker: AgentBalanceTracker;
  let walletFunder: AgentWalletFunder;
  let lifecycle: AgentWalletLifecycle;
  let evmProvider: ethers.Provider;
  let mockXrplClient: jest.Mocked<XRPLClient>;
  let telemetryEmitter: TelemetryEmitter;
  let testDbPath: string;
  let testStoragePath: string;
  let anvilProcess: child_process.ChildProcess | null = null;

  beforeAll(async () => {
    // Start Anvil for EVM transactions
    anvilProcess = startAnvil();

    // Create provider and wait for Anvil to be ready
    evmProvider = new ethers.JsonRpcProvider(ANVIL_RPC_URL, ANVIL_CHAIN_ID);
    await waitForAnvil(evmProvider);
  }, 60000); // Increased timeout for CI environments

  afterAll(() => {
    if (anvilProcess) {
      stopAnvil(anvilProcess);
    }
  });

  beforeEach(async () => {
    // Generate unique paths for test isolation
    const testId = Math.random().toString(36).substring(7);
    testDbPath = path.join(process.cwd(), 'data', 'wallet', `test-lifecycle-${testId}.db`);
    testStoragePath = path.join(
      process.cwd(),
      'packages',
      'connector',
      'test',
      'integration',
      '.test-wallet-storage',
      testId
    );

    // Create test directories
    const dbDir = path.dirname(testDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    if (!fs.existsSync(testStoragePath)) {
      fs.mkdirSync(testStoragePath, { recursive: true });
    }

    // Initialize seed manager
    seedManager = new WalletSeedManager(undefined, {
      storageBackend: 'filesystem',
      storagePath: testStoragePath,
    });
    await seedManager.initialize();

    // Generate and store test master seed
    const masterSeed = await createTestMasterSeed();
    await seedManager.encryptAndStore(masterSeed, TEST_PASSWORD);

    // Initialize wallet derivation
    walletDerivation = new AgentWalletDerivation(seedManager, TEST_PASSWORD, testDbPath);

    // Mock XRPL client (full XRP integration deferred)
    mockXrplClient = {
      request: jest.fn().mockResolvedValue({
        result: {
          account_data: {
            Balance: '10000000', // 10 XRP in drops
          },
        },
      }),
    } as unknown as jest.Mocked<XRPLClient>;

    // Initialize telemetry emitter
    const logger = pino({ name: 'test-lifecycle' });
    telemetryEmitter = new TelemetryEmitter('ws://localhost:9000', 'test-node', logger);

    // Initialize balance tracker
    balanceTracker = new AgentBalanceTracker(
      walletDerivation,
      evmProvider,
      mockXrplClient,
      telemetryEmitter,
      { pollingInterval: 5000, erc20Tokens: [] },
      testDbPath
    );

    // Initialize treasury wallet with Anvil default account
    const anvilDefaultPrivateKey =
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    // Valid XRP test secret (generated for testing)
    const validXrpSecret = 'sEdSJQT8JvGdeJ1P7i1ygnJjPbfH3wo';

    const treasuryWallet = new TreasuryWallet(
      anvilDefaultPrivateKey,
      validXrpSecret,
      evmProvider,
      mockXrplClient
    );

    // Initialize wallet funder
    const fundingConfig: FundingConfig = {
      evm: {
        initialETH: ethers.parseEther('0.1'),
        initialTokens: {},
      },
      xrp: {
        initialXRP: 10000000n, // 10 XRP in drops
      },
      rateLimits: {
        maxFundingsPerAgent: 10,
        maxFundingsPerHour: 100,
      },
      strategy: 'fixed',
    };

    walletFunder = new AgentWalletFunder(
      fundingConfig,
      walletDerivation,
      treasuryWallet,
      telemetryEmitter,
      evmProvider,
      mockXrplClient
    );

    // Initialize lifecycle manager
    lifecycle = new AgentWalletLifecycle(
      walletDerivation,
      walletFunder,
      balanceTracker,
      telemetryEmitter,
      { inactivityDays: 90, autoArchive: false }, // Disable auto-archive for tests
      testDbPath
    );
  }, 30000);

  afterEach(async () => {
    // Stop services
    if (lifecycle) {
      lifecycle.close();
    }
    if (balanceTracker) {
      balanceTracker.stop();
    }
    if (walletDerivation) {
      walletDerivation.close();
    }

    // Clean up test files
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    if (fs.existsSync(testStoragePath)) {
      try {
        fs.rmSync(testStoragePath, { recursive: true, force: true });
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  });

  it('should execute full lifecycle workflow: create → fund → transact → suspend → archive', async () => {
    const agentId = 'agent-lifecycle-001';

    // Step 1: Create agent wallet (PENDING → ACTIVE after funding)
    const record = await lifecycle.createAgentWallet(agentId);

    // Verify wallet activated (auto-funding completes)
    expect(record.state).toBe(WalletState.ACTIVE);
    expect(record.activatedAt).toBeDefined();

    // Wait for balance tracking to update
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Step 2: Verify funding on-chain
    const wallet = await walletDerivation.getAgentWallet(agentId);
    expect(wallet).toBeDefined();

    const balance = await evmProvider.getBalance(wallet!.evmAddress);
    expect(balance).toBeGreaterThan(0n); // Wallet funded

    // Step 3: Record transaction activity
    await lifecycle.recordTransaction(agentId, 'ETH', 1000000000000000000n); // 1 ETH

    const recordAfterTx = await lifecycle.getLifecycleRecord(agentId);
    expect(recordAfterTx.totalTransactions).toBe(1);
    expect(recordAfterTx.totalVolume['ETH']).toBe(1000000000000000000n);
    expect(recordAfterTx.lastActivity).toBeDefined();

    // Step 4: Suspend wallet
    await lifecycle.suspendWallet(agentId, 'Test suspension for integration test');

    const recordAfterSuspend = await lifecycle.getLifecycleRecord(agentId);
    expect(recordAfterSuspend.state).toBe(WalletState.SUSPENDED);
    expect(recordAfterSuspend.suspensionReason).toBe('Test suspension for integration test');

    // Step 5: Reactivate wallet
    await lifecycle.reactivateWallet(agentId);

    const recordAfterReactivate = await lifecycle.getLifecycleRecord(agentId);
    expect(recordAfterReactivate.state).toBe(WalletState.ACTIVE);
    expect(recordAfterReactivate.suspensionReason).toBeUndefined();

    // Step 6: Archive wallet
    const archive = await lifecycle.archiveWallet(agentId);

    expect(archive.agentId).toBe(agentId);
    expect(archive.wallet).toBeDefined();
    expect(archive.balances).toBeDefined();
    expect(archive.lifecycleRecord.state).toBe(WalletState.ARCHIVED);
    expect(archive.archivedAt).toBeDefined();

    // Verify wallet removed from active tracking
    await expect(lifecycle.getLifecycleRecord(agentId)).rejects.toThrow(
      'No lifecycle record for agent'
    );

    // Verify archive persisted and retrievable
    const retrievedArchive = await lifecycle.getWalletArchive(agentId);
    expect(retrievedArchive).toBeDefined();
    expect(retrievedArchive?.agentId).toBe(agentId);
    expect(retrievedArchive?.lifecycleRecord.state).toBe(WalletState.ARCHIVED);
  }, 60000);

  it('should handle concurrent lifecycle operations for multiple agents', async () => {
    const AGENT_COUNT = 5;
    const agents = Array.from({ length: AGENT_COUNT }, (_, i) => `agent-concurrent-${i}`);

    // Create all agents concurrently
    const creationPromises = agents.map((agentId) => lifecycle.createAgentWallet(agentId));
    const records = await Promise.all(creationPromises);

    // Verify all agents activated successfully
    for (const record of records) {
      expect(record.state).toBe(WalletState.ACTIVE);
      expect(record.activatedAt).toBeDefined();
    }

    // Wait for balance tracking and transaction confirmations
    // Check each wallet's balance with retries since concurrent transactions may take time to mine
    for (const agentId of agents) {
      const wallet = await walletDerivation.getAgentWallet(agentId);

      // Retry balance check up to 15 times (15 seconds total)
      let balance = 0n;
      for (let i = 0; i < 15; i++) {
        balance = await evmProvider.getBalance(wallet!.evmAddress);
        if (balance > 0n) {
          // eslint-disable-next-line no-console
          console.log(`${agentId}: Balance confirmed (${balance.toString()} wei)`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      if (balance === 0n) {
        // eslint-disable-next-line no-console
        console.error(
          `${agentId}: Still has 0 balance after 15 retries (address: ${wallet!.evmAddress})`
        );
      }

      expect(balance).toBeGreaterThan(0n);
    }

    // Archive all agents concurrently
    const archivePromises = agents.map((agentId) => lifecycle.archiveWallet(agentId));
    const archives = await Promise.all(archivePromises);

    // Verify all archives created successfully
    expect(archives).toHaveLength(AGENT_COUNT);
    for (const archive of archives) {
      expect(archive.lifecycleRecord.state).toBe(WalletState.ARCHIVED);
      expect(archive.wallet).toBeDefined();
      expect(archive.balances).toBeDefined();
    }

    // Verify all agents removed from active tracking
    for (const agentId of agents) {
      await expect(lifecycle.getLifecycleRecord(agentId)).rejects.toThrow(
        'No lifecycle record for agent'
      );
    }
  }, 120000);

  it('should persist lifecycle state across restarts', async () => {
    const agentId = 'agent-persistence-001';

    // Create and activate wallet
    await lifecycle.createAgentWallet(agentId);

    // Record transaction
    await lifecycle.recordTransaction(agentId, 'ETH', 5000000000000000000n); // 5 ETH

    const recordBefore = await lifecycle.getLifecycleRecord(agentId);
    expect(recordBefore.state).toBe(WalletState.ACTIVE);
    expect(recordBefore.totalTransactions).toBe(1);
    expect(recordBefore.totalVolume['ETH']).toBe(5000000000000000000n);

    // Close lifecycle manager (simulating restart)
    lifecycle.close();

    // Create new lifecycle manager with same database
    const newLifecycle = new AgentWalletLifecycle(
      walletDerivation,
      walletFunder,
      balanceTracker,
      telemetryEmitter,
      { inactivityDays: 90, autoArchive: false },
      testDbPath
    );

    // Verify state restored
    const recordAfter = await newLifecycle.getLifecycleRecord(agentId);
    expect(recordAfter.state).toBe(WalletState.ACTIVE);
    expect(recordAfter.totalTransactions).toBe(1);
    expect(recordAfter.totalVolume['ETH']).toBe(5000000000000000000n);
    expect(recordAfter.activatedAt).toBe(recordBefore.activatedAt);
    expect(recordAfter.createdAt).toBe(recordBefore.createdAt);

    // Clean up
    newLifecycle.close();
  }, 60000);

  it('should emit telemetry events for all state transitions', async () => {
    const agentId = 'agent-telemetry-001';

    // Spy on telemetry emitter
    const emitSpy = jest.spyOn(telemetryEmitter, 'emit');

    // Execute full lifecycle
    await lifecycle.createAgentWallet(agentId);
    await lifecycle.suspendWallet(agentId, 'Test suspension');
    await lifecycle.reactivateWallet(agentId);
    await lifecycle.archiveWallet(agentId);

    // Verify telemetry events emitted
    const emittedEvents = emitSpy.mock.calls.map((call) => call[0]);

    // Expect: PENDING, ACTIVE, SUSPENDED, ACTIVE, ARCHIVED
    const stateChangeEvents = emittedEvents.filter(
      (event) => event.type === 'AGENT_WALLET_STATE_CHANGED'
    );

    expect(stateChangeEvents.length).toBeGreaterThanOrEqual(4); // At least 4 state transitions

    // Verify state transition sequence
    const states = stateChangeEvents.map((event: { newState: string }) => event.newState);
    expect(states).toContain('pending');
    expect(states).toContain('active');
    expect(states).toContain('suspended');
    expect(states).toContain('archived');
  }, 60000);
});
