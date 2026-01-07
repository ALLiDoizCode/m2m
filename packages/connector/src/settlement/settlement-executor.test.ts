// Unit Tests for SettlementExecutor
// Epic 8 Story 8.8 - Settlement Engine Integration with Payment Channels

import { EventEmitter } from 'events';
import pino from 'pino';
import { SettlementExecutor } from './settlement-executor.js';
import { PaymentChannelSDK } from './payment-channel-sdk.js';
import { AccountManager } from './account-manager.js';
import { SettlementMonitor } from './settlement-monitor.js';
import { SettlementExecutorConfig } from './settlement-executor-types.js';
import { SettlementTriggerEvent } from '../config/types.js';
import { ChannelState } from './payment-channel-types.js';

// Mock PaymentChannelSDK
jest.mock('./payment-channel-sdk');
// Mock AccountManager
jest.mock('./account-manager');

/**
 * Test Timeout Guidelines:
 * - Basic operations: 50ms (single async event handler processing)
 * - Deposit operations: 100ms (3 sequential getChannelState calls)
 * - Retry operations: 500ms (exponential backoff with multiple attempts)
 *
 * Why timeouts are needed:
 * Async event handlers process settlement triggers asynchronously via EventEmitter.
 * Tests must await Promise chain completion before assertions. Timeouts ensure
 * all async operations (SDK calls, account updates, telemetry) complete before
 * verification.
 */
describe('SettlementExecutor', () => {
  let executor: SettlementExecutor;
  let mockSDK: jest.Mocked<PaymentChannelSDK>;
  let mockAccountManager: jest.Mocked<AccountManager>;
  let mockSettlementMonitor: SettlementMonitor;
  let logger: pino.Logger;
  let config: SettlementExecutorConfig;

  // Anvil pre-funded accounts for testing
  const ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const ACCOUNT_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

  beforeEach(() => {
    // Create silent logger for tests
    logger = pino({ level: 'silent' });

    // Create mock SettlementMonitor (using EventEmitter)
    mockSettlementMonitor = new EventEmitter() as SettlementMonitor;

    // Create mock config
    config = {
      enabled: true,
      paymentChannelSDKConfig: {
        rpcUrl: 'http://localhost:8545',
        privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        registryAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        chainId: 31337,
        confirmations: 1,
      },
      settlementTokenAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
      defaultInitialDeposit: 1000000n,
      defaultSettlementTimeout: 86400,
      retryAttempts: 3,
      retryDelayMs: 100, // Short delay for tests
      peerAddressMap: {
        'peer-a': '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        'peer-b': '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      },
      nodeId: 'test-node',
    };

    // Create mock AccountManager (minimal mock - no constructor)
    mockAccountManager = {
      recordSettlement: jest.fn().mockResolvedValue(undefined),
      getBalances: jest.fn().mockResolvedValue({ creditBalance: 0n, debitBalance: 0n }),
    } as any;

    // Create SettlementExecutor
    executor = new SettlementExecutor(config, mockAccountManager, mockSettlementMonitor, logger);

    // Get mock SDK instance
    mockSDK = (executor as any).sdk as jest.Mocked<PaymentChannelSDK>;

    // Setup default SDK mocks
    mockSDK.startEventPolling = jest.fn();
    mockSDK.stopEventPolling = jest.fn();
    mockSDK.openChannel = jest.fn().mockResolvedValue('0xabc123'); // Mock channel ID
    mockSDK.signBalanceProof = jest.fn().mockResolvedValue('0xsignature');
    mockSDK.getChannelState = jest.fn().mockResolvedValue({
      channelId: '0xabc123',
      participants: [config.peerAddressMap['peer-a'], config.settlementTokenAddress] as [
        string,
        string,
      ],
      myDeposit: 1000000n,
      theirDeposit: 0n,
      myNonce: 0,
      theirNonce: 0,
      myTransferred: 0n,
      theirTransferred: 0n,
      status: 'opened',
      tokenAddress: config.settlementTokenAddress,
      tokenNetworkAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      settlementTimeout: 86400,
    } as ChannelState);
  });

  describe('start and stop', () => {
    it('should start event polling and register listener', () => {
      executor.start();

      expect(mockSDK.startEventPolling).toHaveBeenCalledTimes(1);
      // Verify listener registered (EventEmitter has listener)
      expect(mockSettlementMonitor.listenerCount('SETTLEMENT_REQUIRED')).toBe(1);
    });

    it('should stop event polling and unregister listener', () => {
      executor.start();
      executor.stop();

      expect(mockSDK.stopEventPolling).toHaveBeenCalledTimes(1);
      expect(mockSettlementMonitor.listenerCount('SETTLEMENT_REQUIRED')).toBe(0);
    });
  });

  describe('handleSettlement - no existing channel', () => {
    it('should open new channel and sign initial balance proof', async () => {
      executor.start();

      const event: SettlementTriggerEvent = {
        peerId: 'peer-a',
        tokenId: 'ILP',
        currentBalance: 1000n,
        threshold: 500n,
        exceedsBy: 500n,
        timestamp: new Date(),
      };

      // Trigger settlement
      mockSettlementMonitor.emit('SETTLEMENT_REQUIRED', event);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify openChannel called
      expect(mockSDK.openChannel).toHaveBeenCalledWith(
        '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // peer-a address
        config.settlementTokenAddress,
        config.defaultSettlementTimeout,
        config.defaultInitialDeposit
      );

      // Verify signBalanceProof called with nonce=1
      expect(mockSDK.signBalanceProof).toHaveBeenCalledWith('0xabc123', 1, 1000n);

      // Verify TigerBeetle account updated
      expect(mockAccountManager.recordSettlement).toHaveBeenCalledWith('peer-a', 'ILP', 1000n);
    });

    it('should use 2x balance for initial deposit when balance exceeds default', async () => {
      executor.start();

      const event: SettlementTriggerEvent = {
        peerId: 'peer-a',
        tokenId: 'ILP',
        currentBalance: 2000000n, // Exceeds defaultInitialDeposit (1000000n)
        threshold: 500n,
        exceedsBy: 1999500n,
        timestamp: new Date(),
      };

      mockSettlementMonitor.emit('SETTLEMENT_REQUIRED', event);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify initial deposit is 2x balance
      expect(mockSDK.openChannel).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Number),
        4000000n // 2x 2000000n
      );
    });
  });

  describe('handleSettlement - existing channel', () => {
    it('should use existing channel and sign balance proof with incremented nonce', async () => {
      executor.start();

      // Mock existing channel state
      mockSDK.getChannelState.mockResolvedValue({
        channelId: '0xexisting',
        participants: [ACCOUNT_0, ACCOUNT_1] as [string, string],
        myDeposit: 10000n,
        theirDeposit: 0n,
        myNonce: 5,
        theirNonce: 0,
        myTransferred: 2000n,
        theirTransferred: 0n,
        status: 'opened',
        tokenAddress: config.settlementTokenAddress,
        tokenNetworkAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        settlementTimeout: 86400,
      } as ChannelState);

      // Manually cache channel (simulate previous opening)
      const peerChannelMap = (executor as any).peerChannelMap as Map<string, string>;
      peerChannelMap.set('peer-a', '0xexisting');

      const event: SettlementTriggerEvent = {
        peerId: 'peer-a',
        tokenId: 'ILP',
        currentBalance: 1000n,
        threshold: 500n,
        exceedsBy: 500n,
        timestamp: new Date(),
      };

      mockSettlementMonitor.emit('SETTLEMENT_REQUIRED', event);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify openChannel NOT called (channel exists)
      expect(mockSDK.openChannel).not.toHaveBeenCalled();

      // Verify signBalanceProof called with incremented nonce and cumulative transferred
      expect(mockSDK.signBalanceProof).toHaveBeenCalledWith(
        '0xexisting',
        6, // myNonce + 1
        3000n // myTransferred + 1000n
      );

      // Verify TigerBeetle account updated
      expect(mockAccountManager.recordSettlement).toHaveBeenCalledWith('peer-a', 'ILP', 1000n);
    });
  });

  describe('handleSettlement - insufficient deposit', () => {
    it('should deposit additional funds when transferred exceeds deposit', async () => {
      executor.start();

      // Mock channel state with low deposit
      // Need 3 mocks: findChannelForPeer, settleViaExistingChannel, then recursive settleViaExistingChannel
      const lowDepositState = {
        channelId: '0xexisting',
        participants: [ACCOUNT_0, ACCOUNT_1] as [string, string],
        myDeposit: 500n, // Low deposit
        theirDeposit: 0n,
        myNonce: 0,
        theirNonce: 0,
        myTransferred: 0n,
        theirTransferred: 0n,
        status: 'opened',
        tokenAddress: config.settlementTokenAddress,
        tokenNetworkAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        settlementTimeout: 86400,
      } as ChannelState;

      const highDepositState = {
        channelId: '0xexisting',
        participants: [ACCOUNT_0, ACCOUNT_1] as [string, string],
        myDeposit: 3600n, // After deposit
        theirDeposit: 0n,
        myNonce: 0,
        theirNonce: 0,
        myTransferred: 0n,
        theirTransferred: 0n,
        status: 'opened',
        tokenAddress: config.settlementTokenAddress,
        tokenNetworkAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        settlementTimeout: 86400,
      } as ChannelState;

      mockSDK.getChannelState
        .mockResolvedValueOnce(lowDepositState) // findChannelForPeer verification
        .mockResolvedValueOnce(lowDepositState) // settleViaExistingChannel before deposit
        .mockResolvedValueOnce(highDepositState); // settleViaExistingChannel after deposit

      mockSDK.deposit = jest.fn().mockResolvedValue(undefined);

      const peerChannelMap = (executor as any).peerChannelMap as Map<string, string>;
      peerChannelMap.set('peer-a', '0xexisting');

      const event: SettlementTriggerEvent = {
        peerId: 'peer-a',
        tokenId: 'ILP',
        currentBalance: 2500n, // Exceeds deposit (500n)
        threshold: 500n,
        exceedsBy: 2000n,
        timestamp: new Date(),
      };

      mockSettlementMonitor.emit('SETTLEMENT_REQUIRED', event);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify deposit called
      expect(mockSDK.deposit).toHaveBeenCalledWith(
        '0xexisting',
        expect.any(BigInt) // Should be ~3000n with 20% buffer
      );

      // Verify settlement proceeded after deposit
      expect(mockSDK.signBalanceProof).toHaveBeenCalled();
    });
  });

  describe('retry logic', () => {
    it('should retry on RPC error and eventually succeed', async () => {
      executor.start();

      // Mock signBalanceProof to fail twice, then succeed
      mockSDK.signBalanceProof
        .mockRejectedValueOnce(new Error('network error'))
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce('0xsignature');

      const event: SettlementTriggerEvent = {
        peerId: 'peer-a',
        tokenId: 'ILP',
        currentBalance: 1000n,
        threshold: 500n,
        exceedsBy: 500n,
        timestamp: new Date(),
      };

      mockSettlementMonitor.emit('SETTLEMENT_REQUIRED', event);
      await new Promise((resolve) => setTimeout(resolve, 500)); // Wait for retries

      // Verify called 3 times (2 failures + 1 success)
      expect(mockSDK.signBalanceProof).toHaveBeenCalledTimes(3);

      // Verify settlement eventually succeeded
      expect(mockAccountManager.recordSettlement).toHaveBeenCalled();
    });

    it('should fail after max retries', async () => {
      executor.start();

      // Mock signBalanceProof to always fail
      mockSDK.signBalanceProof.mockRejectedValue(new Error('persistent error'));

      const event: SettlementTriggerEvent = {
        peerId: 'peer-a',
        tokenId: 'ILP',
        currentBalance: 1000n,
        threshold: 500n,
        exceedsBy: 500n,
        timestamp: new Date(),
      };

      mockSettlementMonitor.emit('SETTLEMENT_REQUIRED', event);
      await new Promise((resolve) => setTimeout(resolve, 500)); // Wait for all retries

      // Verify attempted 3 times
      expect(mockSDK.signBalanceProof).toHaveBeenCalledTimes(3);

      // Verify settlement failed (TigerBeetle NOT updated)
      expect(mockAccountManager.recordSettlement).not.toHaveBeenCalled();
    });
  });

  describe('duplicate settlement prevention', () => {
    it('should skip settlement if already in progress for peer', async () => {
      executor.start();

      // Mock slow settlement
      mockSDK.signBalanceProof.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('0xsig'), 200))
      );

      const event: SettlementTriggerEvent = {
        peerId: 'peer-a',
        tokenId: 'ILP',
        currentBalance: 1000n,
        threshold: 500n,
        exceedsBy: 500n,
        timestamp: new Date(),
      };

      // Trigger first settlement
      mockSettlementMonitor.emit('SETTLEMENT_REQUIRED', event);

      // Trigger second settlement immediately
      await new Promise((resolve) => setTimeout(resolve, 10));
      mockSettlementMonitor.emit('SETTLEMENT_REQUIRED', event);

      // Wait for settlements to complete
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify only one settlement executed
      expect(mockSDK.openChannel).toHaveBeenCalledTimes(1);
    });
  });

  describe('TigerBeetle account updates', () => {
    it('should update TigerBeetle accounts after successful settlement', async () => {
      executor.start();

      const event: SettlementTriggerEvent = {
        peerId: 'peer-a',
        tokenId: 'ILP',
        currentBalance: 1000n,
        threshold: 500n,
        exceedsBy: 500n,
        timestamp: new Date(),
      };

      mockSettlementMonitor.emit('SETTLEMENT_REQUIRED', event);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify recordSettlement called
      expect(mockAccountManager.recordSettlement).toHaveBeenCalledWith('peer-a', 'ILP', 1000n);
    });
  });

  describe('telemetry emission', () => {
    it('should emit telemetry events throughout settlement lifecycle', async () => {
      const mockTelemetryEmitter = {
        emit: jest.fn(),
      };

      executor = new SettlementExecutor(
        config,
        mockAccountManager,
        mockSettlementMonitor,
        logger,
        mockTelemetryEmitter as any
      );

      mockSDK = (executor as any).sdk as jest.Mocked<PaymentChannelSDK>;
      mockSDK.startEventPolling = jest.fn();
      mockSDK.openChannel = jest.fn().mockResolvedValue('0xabc123');
      mockSDK.signBalanceProof = jest.fn().mockResolvedValue('0xsignature');
      mockSDK.getChannelState = jest.fn().mockResolvedValue({
        channelId: '0xabc123',
        participants: [ACCOUNT_0, ACCOUNT_1] as [string, string],
        myDeposit: 1000000n,
        theirDeposit: 0n,
        myNonce: 0,
        theirNonce: 0,
        myTransferred: 0n,
        theirTransferred: 0n,
        status: 'opened',
        tokenAddress: config.settlementTokenAddress,
        tokenNetworkAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        settlementTimeout: 86400,
      } as ChannelState);

      executor.start();

      const event: SettlementTriggerEvent = {
        peerId: 'peer-a',
        tokenId: 'ILP',
        currentBalance: 1000n,
        threshold: 500n,
        exceedsBy: 500n,
        timestamp: new Date(),
      };

      mockSettlementMonitor.emit('SETTLEMENT_REQUIRED', event);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify telemetry events emitted in order
      const emittedEvents = mockTelemetryEmitter.emit.mock.calls.map((call) => call[0].type);

      expect(emittedEvents).toContain('SETTLEMENT_PENDING');
      expect(emittedEvents).toContain('CHANNEL_OPENED');
      expect(emittedEvents).toContain('SETTLEMENT_COMPLETED');
      expect(emittedEvents).toContain('ACCOUNTS_UPDATED');
    });

    it('should not throw if telemetry emitter fails', async () => {
      const mockTelemetryEmitter = {
        emit: jest.fn().mockImplementation(() => {
          throw new Error('Telemetry failure');
        }),
      };

      // Create fresh mock for this test to ensure clean state
      const freshMockAccountManager = {
        recordSettlement: jest.fn().mockResolvedValue(undefined),
        getBalances: jest.fn().mockResolvedValue({ creditBalance: 0n, debitBalance: 0n }),
      } as any;

      executor = new SettlementExecutor(
        config,
        freshMockAccountManager,
        mockSettlementMonitor,
        logger,
        mockTelemetryEmitter as any
      );

      mockSDK = (executor as any).sdk as jest.Mocked<PaymentChannelSDK>;
      mockSDK.startEventPolling = jest.fn();
      mockSDK.openChannel = jest.fn().mockResolvedValue('0xabc123');
      mockSDK.signBalanceProof = jest.fn().mockResolvedValue('0xsignature');
      mockSDK.getChannelState = jest.fn().mockResolvedValue({
        channelId: '0xabc123',
        participants: [ACCOUNT_0, ACCOUNT_1] as [string, string],
        myDeposit: 1000000n,
        theirDeposit: 0n,
        myNonce: 0,
        theirNonce: 0,
        myTransferred: 0n,
        theirTransferred: 0n,
        status: 'opened',
        tokenAddress: config.settlementTokenAddress,
        tokenNetworkAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        settlementTimeout: 86400,
      } as ChannelState);

      executor.start();

      const event: SettlementTriggerEvent = {
        peerId: 'peer-a',
        tokenId: 'ILP',
        currentBalance: 1000n,
        threshold: 500n,
        exceedsBy: 500n,
        timestamp: new Date(),
      };

      // Should not throw
      mockSettlementMonitor.emit('SETTLEMENT_REQUIRED', event);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify settlement still succeeded
      expect(freshMockAccountManager.recordSettlement).toHaveBeenCalled();
    });
  });

  describe('error scenarios', () => {
    it('should throw error for unknown peer address', async () => {
      executor.start();

      const event: SettlementTriggerEvent = {
        peerId: 'unknown-peer',
        tokenId: 'ILP',
        currentBalance: 1000n,
        threshold: 500n,
        exceedsBy: 500n,
        timestamp: new Date(),
      };

      mockSettlementMonitor.emit('SETTLEMENT_REQUIRED', event);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify settlement failed (openChannel not called)
      expect(mockSDK.openChannel).not.toHaveBeenCalled();
    });

    it('should handle closed channel by removing from cache', async () => {
      executor.start();

      // Mock channel as closed
      mockSDK.getChannelState.mockResolvedValue({
        channelId: '0xexisting',
        participants: [ACCOUNT_0, ACCOUNT_1] as [string, string],
        myDeposit: 10000n,
        theirDeposit: 0n,
        myNonce: 5,
        theirNonce: 0,
        myTransferred: 2000n,
        theirTransferred: 0n,
        status: 'settled',
        tokenAddress: config.settlementTokenAddress,
        tokenNetworkAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        settlementTimeout: 86400,
        closedAt: Date.now(),
      } as ChannelState);

      // Manually cache channel
      const peerChannelMap = (executor as any).peerChannelMap as Map<string, string>;
      peerChannelMap.set('peer-a', '0xexisting');

      const event: SettlementTriggerEvent = {
        peerId: 'peer-a',
        tokenId: 'ILP',
        currentBalance: 1000n,
        threshold: 500n,
        exceedsBy: 500n,
        timestamp: new Date(),
      };

      mockSettlementMonitor.emit('SETTLEMENT_REQUIRED', event);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify channel removed from cache and new channel opened
      expect(peerChannelMap.has('peer-a')).toBe(true); // Re-cached with new channel
      expect(mockSDK.openChannel).toHaveBeenCalled();
    });
  });
});
