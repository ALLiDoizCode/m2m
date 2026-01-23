/**
 * Settlement Executor Unit Tests
 *
 * Tests for automated on-chain settlement via payment channels.
 * Uses mocked dependencies (PaymentChannelSDK, AccountManager, SettlementMonitor).
 *
 * **Test Coverage:**
 * 1. Event listener registration and cleanup
 * 2. New channel opening and settlement
 * 3. Settlement via existing channel
 * 4. Channel deposit management
 * 5. Retry logic with exponential backoff
 * 6. Error handling and telemetry emission
 * 7. Settlement monitor state transitions
 *
 * Source: Epic 8 Story 8.8 - Settlement Engine Integration Tests
 */

import {
  SettlementExecutor,
  SettlementExecutorConfig,
  TelemetryEmitter,
} from './settlement-executor';
import { AccountManager } from './account-manager';
import { PaymentChannelSDK } from './payment-channel-sdk';
import { SettlementMonitor } from './settlement-monitor';
import { SettlementTriggerEvent, SettlementState } from '../config/types';
import { ChannelState } from '../../../shared/src/types/payment-channel';
import pino from 'pino';

// Mock dependencies
jest.mock('./account-manager');
jest.mock('./payment-channel-sdk');
jest.mock('./settlement-monitor');

describe('SettlementExecutor', () => {
  let executor: SettlementExecutor;
  let mockAccountManager: jest.Mocked<AccountManager>;
  let mockPaymentChannelSDK: jest.Mocked<PaymentChannelSDK>;
  let mockSettlementMonitor: jest.Mocked<SettlementMonitor>;
  let mockTelemetryEmitter: jest.Mocked<TelemetryEmitter>;
  let logger: pino.Logger;
  let config: SettlementExecutorConfig;

  // Test data
  const testPeerId = 'connector-a';
  const testTokenId = 'ILP';
  const testTokenAddress = '0x1234567890123456789012345678901234567890';
  const testPeerAddress = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const testChannelId = '0xaaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';
  const testCurrentBalance = 1200n;
  const testThreshold = 1000n;

  beforeEach(() => {
    // Create fresh mock instances
    /* eslint-disable @typescript-eslint/no-explicit-any */
    mockAccountManager = new AccountManager(
      {} as any,
      {} as any,
      {} as any
    ) as jest.Mocked<AccountManager>;
    mockPaymentChannelSDK = new PaymentChannelSDK(
      {} as any,
      {} as any,
      '0x1234',
      {} as any,
      {} as any
    ) as jest.Mocked<PaymentChannelSDK>;
    mockSettlementMonitor = new SettlementMonitor(
      {} as any,
      {} as any,
      {} as any
    ) as jest.Mocked<SettlementMonitor>;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    mockTelemetryEmitter = {
      emit: jest.fn(),
    };

    // Setup mock implementations
    mockAccountManager.recordSettlement = jest.fn().mockResolvedValue(undefined);
    mockPaymentChannelSDK.getMyChannels = jest.fn().mockResolvedValue([]);
    mockPaymentChannelSDK.getChannelState = jest.fn().mockResolvedValue({
      channelId: testChannelId,
      participants: [testPeerAddress.toLowerCase(), '0x9876543210987654321098765432109876543210'],
      myDeposit: 10000n,
      theirDeposit: 10000n,
      myNonce: 1,
      theirNonce: 1,
      myTransferred: 0n,
      theirTransferred: 0n,
      status: 'opened' as const,
      settlementTimeout: 86400,
      openedAt: Math.floor(Date.now() / 1000),
    } as ChannelState);
    mockPaymentChannelSDK.openChannel = jest.fn().mockResolvedValue(testChannelId);
    mockPaymentChannelSDK.deposit = jest.fn().mockResolvedValue(undefined);
    mockPaymentChannelSDK.signBalanceProof = jest.fn().mockResolvedValue('0xsignature');
    mockPaymentChannelSDK.cooperativeSettle = jest.fn().mockResolvedValue(undefined);
    mockSettlementMonitor.markSettlementInProgress = jest.fn();
    mockSettlementMonitor.markSettlementCompleted = jest.fn();
    mockSettlementMonitor.getSettlementState = jest.fn().mockReturnValue(SettlementState.IDLE);
    mockSettlementMonitor.on = jest.fn();
    mockSettlementMonitor.off = jest.fn();

    // Create logger
    logger = pino({ level: 'silent' }); // Silent logger for tests

    // Create config
    config = {
      nodeId: 'connector-b',
      defaultSettlementTimeout: 86400,
      initialDepositMultiplier: 10,
      minDepositThreshold: 0.5,
      maxRetries: 3,
      retryDelayMs: 5000,
      tokenAddressMap: new Map([[testTokenId, testTokenAddress]]),
      peerIdToAddressMap: new Map([[testPeerId, testPeerAddress]]),
      registryAddress: '0xregistry1234567890123456789012345678901234',
      rpcUrl: 'http://localhost:8545',
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    };

    // Create executor instance
    executor = new SettlementExecutor(
      config,
      mockAccountManager,
      mockPaymentChannelSDK,
      mockSettlementMonitor,
      logger,
      mockTelemetryEmitter
    );
  });

  afterEach(() => {
    // Cleanup: Stop executor to remove listeners
    executor.stop();
  });

  describe('Constructor', () => {
    it('should initialize all properties correctly', () => {
      expect(executor).toBeInstanceOf(SettlementExecutor);
      expect(executor.getSettlementState).toBeDefined();
    });
  });

  describe('Event Listener Registration', () => {
    it('should register listener on start() and unregister on stop()', () => {
      // Start executor
      executor.start();

      // Verify listener registered
      expect(mockSettlementMonitor.on).toHaveBeenCalledWith(
        'SETTLEMENT_REQUIRED',
        expect.any(Function)
      );

      // Stop executor
      executor.stop();

      // Verify listener unregistered
      expect(mockSettlementMonitor.off).toHaveBeenCalledWith(
        'SETTLEMENT_REQUIRED',
        expect.any(Function)
      );

      // Verify same handler reference used for both on() and off()
      const onHandler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      const offHandler = (mockSettlementMonitor.off as jest.Mock).mock.calls[0][1];
      expect(onHandler).toBe(offHandler);
    });
  });

  describe('Settlement via New Channel', () => {
    it('should open new channel and settle when no existing channel', async () => {
      // Mock: No existing channel
      mockPaymentChannelSDK.getMyChannels.mockResolvedValue([]);

      // Create settlement event
      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      // Start executor
      executor.start();

      // Simulate settlement event
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      const settlementPromise = handler(event);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));
      await settlementPromise;

      // Verify: openChannel called with correct parameters
      expect(mockPaymentChannelSDK.openChannel).toHaveBeenCalledWith(
        testPeerAddress,
        testTokenAddress,
        config.defaultSettlementTimeout,
        testCurrentBalance * BigInt(config.initialDepositMultiplier)
      );

      // Verify: recordSettlement called after channel open
      expect(mockAccountManager.recordSettlement).toHaveBeenCalledWith(
        testPeerId,
        testTokenId,
        testCurrentBalance
      );

      // Verify: markSettlementInProgress called
      expect(mockSettlementMonitor.markSettlementInProgress).toHaveBeenCalledWith(
        testPeerId,
        testTokenId
      );

      // Verify: markSettlementCompleted called
      expect(mockSettlementMonitor.markSettlementCompleted).toHaveBeenCalledWith(
        testPeerId,
        testTokenId
      );

      // Verify: Telemetry emitted
      expect(mockTelemetryEmitter.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SETTLEMENT_STARTED',
          nodeId: config.nodeId,
          peerId: testPeerId,
          tokenId: testTokenId,
        })
      );
      expect(mockTelemetryEmitter.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SETTLEMENT_COMPLETED',
          nodeId: config.nodeId,
          peerId: testPeerId,
          tokenId: testTokenId,
        })
      );
    });
  });

  describe('Settlement via Existing Channel', () => {
    it('should sign balance proof and cooperative settle when channel exists', async () => {
      // Mock: Existing channel found
      mockPaymentChannelSDK.getMyChannels.mockResolvedValue([testChannelId]);

      // Create settlement event
      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      // Start executor
      executor.start();

      // Simulate settlement event
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      const settlementPromise = handler(event);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 50));
      await settlementPromise;

      // Verify: signBalanceProof called with incremented nonce
      expect(mockPaymentChannelSDK.signBalanceProof).toHaveBeenCalledWith(
        testChannelId,
        2, // myNonce + 1
        testCurrentBalance, // myTransferred + amount
        0n,
        '0x' + '0'.repeat(64)
      );

      // Verify: cooperativeSettle called
      expect(mockPaymentChannelSDK.cooperativeSettle).toHaveBeenCalledWith(
        testChannelId,
        testTokenAddress,
        expect.objectContaining({
          channelId: testChannelId,
          nonce: 2,
          transferredAmount: testCurrentBalance,
          lockedAmount: 0n,
          locksRoot: '0x' + '0'.repeat(64),
        }),
        '0xsignature',
        expect.objectContaining({
          channelId: testChannelId,
        }),
        '0xsignature'
      );

      // Verify: markSettlementCompleted called
      expect(mockSettlementMonitor.markSettlementCompleted).toHaveBeenCalledWith(
        testPeerId,
        testTokenId
      );
    });
  });

  describe('Channel Deposit Management', () => {
    it('should add deposit when channel deposit is low', async () => {
      // Mock: Existing channel with low deposit
      mockPaymentChannelSDK.getMyChannels.mockResolvedValue([testChannelId]);

      // Mock state sequence (4 calls total):
      // 1. findChannelForPeer check
      // 2. settleViaExistingChannel initial check
      // 3. depositAdditionalFunds internal check
      // 4. settleViaExistingChannel refresh after deposit
      mockPaymentChannelSDK.getChannelState
        .mockResolvedValueOnce({
          channelId: testChannelId,
          participants: [
            testPeerAddress.toLowerCase(),
            '0x9876543210987654321098765432109876543210',
          ],
          myDeposit: 100n, // Low deposit (findChannelForPeer)
          theirDeposit: 10000n,
          myNonce: 1,
          theirNonce: 1,
          myTransferred: 0n,
          theirTransferred: 0n,
          status: 'opened' as const,
          settlementTimeout: 86400,
          openedAt: Math.floor(Date.now() / 1000),
        } as ChannelState)
        .mockResolvedValueOnce({
          channelId: testChannelId,
          participants: [
            testPeerAddress.toLowerCase(),
            '0x9876543210987654321098765432109876543210',
          ],
          myDeposit: 100n, // Low deposit (settleViaExistingChannel check)
          theirDeposit: 10000n,
          myNonce: 1,
          theirNonce: 1,
          myTransferred: 0n,
          theirTransferred: 0n,
          status: 'opened' as const,
          settlementTimeout: 86400,
          openedAt: Math.floor(Date.now() / 1000),
        } as ChannelState)
        .mockResolvedValueOnce({
          channelId: testChannelId,
          participants: [
            testPeerAddress.toLowerCase(),
            '0x9876543210987654321098765432109876543210',
          ],
          myDeposit: 100n, // Low deposit (depositAdditionalFunds check)
          theirDeposit: 10000n,
          myNonce: 1,
          theirNonce: 1,
          myTransferred: 0n,
          theirTransferred: 0n,
          status: 'opened' as const,
          settlementTimeout: 86400,
          openedAt: Math.floor(Date.now() / 1000),
        } as ChannelState)
        .mockResolvedValueOnce({
          channelId: testChannelId,
          participants: [
            testPeerAddress.toLowerCase(),
            '0x9876543210987654321098765432109876543210',
          ],
          myDeposit: 12000n, // High deposit after adding funds (refresh)
          theirDeposit: 10000n,
          myNonce: 1,
          theirNonce: 1,
          myTransferred: 0n,
          theirTransferred: 0n,
          status: 'opened' as const,
          settlementTimeout: 86400,
          openedAt: Math.floor(Date.now() / 1000),
        } as ChannelState);

      // Create settlement event
      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      // Start executor
      executor.start();

      // Simulate settlement event
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      const settlementPromise = handler(event);

      // Wait for async processing (deposit operation takes longer)
      await new Promise((resolve) => setTimeout(resolve, 100));
      await settlementPromise;

      // Verify: deposit called with additional funds
      expect(mockPaymentChannelSDK.deposit).toHaveBeenCalled();

      // Verify: signBalanceProof called after deposit
      expect(mockPaymentChannelSDK.signBalanceProof).toHaveBeenCalled();
    });
  });

  describe('Retry Logic', () => {
    it('should retry on transient failures with exponential backoff', async () => {
      // Create custom config with fast retry delays for testing
      const fastRetryConfig = {
        ...config,
        retryDelayMs: 10, // Fast retries for test: 10ms, 20ms, 40ms
      };

      // Create executor with fast retry config
      const fastRetryExecutor = new SettlementExecutor(
        fastRetryConfig,
        mockAccountManager,
        mockPaymentChannelSDK,
        mockSettlementMonitor,
        logger,
        mockTelemetryEmitter
      );

      // Mock: First 2 calls fail with retryable error, 3rd succeeds
      mockPaymentChannelSDK.openChannel
        .mockRejectedValueOnce(new Error('Network timeout'))
        .mockRejectedValueOnce(new Error('Network timeout'))
        .mockResolvedValueOnce(testChannelId);

      // Mock: No existing channel
      mockPaymentChannelSDK.getMyChannels.mockResolvedValue([]);

      // Create settlement event
      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      // Start executor
      fastRetryExecutor.start();

      // Simulate settlement event
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      const settlementPromise = handler(event);

      // Wait for retry operations (100ms sufficient for fast retries: 10ms + 20ms + 40ms + overhead)
      await new Promise((resolve) => setTimeout(resolve, 100));
      await settlementPromise;

      // Cleanup
      fastRetryExecutor.stop();

      // Verify: openChannel called 3 times (2 failures + 1 success)
      expect(mockPaymentChannelSDK.openChannel).toHaveBeenCalledTimes(3);

      // Verify: Settlement eventually succeeds
      expect(mockSettlementMonitor.markSettlementCompleted).toHaveBeenCalledWith(
        testPeerId,
        testTokenId
      );
    });
  });

  describe('Error Handling', () => {
    it('should emit telemetry on permanent failure and NOT mark completed', async () => {
      // Mock: Permanent failure (insufficient funds)
      mockPaymentChannelSDK.openChannel.mockRejectedValue(new Error('Insufficient funds'));

      // Mock: No existing channel
      mockPaymentChannelSDK.getMyChannels.mockResolvedValue([]);

      // Create settlement event
      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      // Start executor
      executor.start();

      // Simulate settlement event
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      const settlementPromise = handler(event);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 50));
      await settlementPromise;

      // Verify: SETTLEMENT_FAILED telemetry emitted
      expect(mockTelemetryEmitter.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SETTLEMENT_FAILED',
          nodeId: config.nodeId,
          peerId: testPeerId,
          tokenId: testTokenId,
          error: 'Insufficient funds',
        })
      );

      // Verify: markSettlementCompleted NOT called
      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
    });
  });

  describe('Telemetry Events', () => {
    it('should emit telemetry events for all settlement outcomes', async () => {
      // Mock: No existing channel
      mockPaymentChannelSDK.getMyChannels.mockResolvedValue([]);

      // Create settlement event
      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      // Start executor
      executor.start();

      // Simulate settlement event
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      const settlementPromise = handler(event);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));
      await settlementPromise;

      // Verify: SETTLEMENT_STARTED emitted
      expect(mockTelemetryEmitter.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SETTLEMENT_STARTED',
        })
      );

      // Verify: SETTLEMENT_COMPLETED emitted
      expect(mockTelemetryEmitter.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SETTLEMENT_COMPLETED',
        })
      );

      // Verify: All events include timestamp
      const calls = (mockTelemetryEmitter.emit as jest.Mock).mock.calls;
      calls.forEach((call) => {
        expect(call[0]).toHaveProperty('timestamp');
      });
    });
  });

  describe('Settlement Monitor State Transitions', () => {
    it('should call markSettlementInProgress immediately and markSettlementCompleted after success', async () => {
      // Mock: No existing channel
      mockPaymentChannelSDK.getMyChannels.mockResolvedValue([]);

      // Create settlement event
      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      // Start executor
      executor.start();

      // Simulate settlement event
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      const settlementPromise = handler(event);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));
      await settlementPromise;

      // Verify: markSettlementInProgress called first
      expect(mockSettlementMonitor.markSettlementInProgress).toHaveBeenCalledWith(
        testPeerId,
        testTokenId
      );

      // Verify: markSettlementCompleted called after success
      expect(mockSettlementMonitor.markSettlementCompleted).toHaveBeenCalledWith(
        testPeerId,
        testTokenId
      );

      // Verify: markSettlementInProgress called before markSettlementCompleted
      const inProgressCall =
        (mockSettlementMonitor.markSettlementInProgress as jest.Mock).mock.invocationCallOrder[0] ||
        0;
      const completedCall =
        (mockSettlementMonitor.markSettlementCompleted as jest.Mock).mock.invocationCallOrder[0] ||
        0;
      expect(inProgressCall).toBeLessThan(completedCall);
    });

    it('should NOT call markSettlementCompleted when error occurs', async () => {
      // Mock: Permanent failure
      mockPaymentChannelSDK.openChannel.mockRejectedValue(new Error('Insufficient funds'));
      mockPaymentChannelSDK.getMyChannels.mockResolvedValue([]);

      // Create settlement event
      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      // Start executor
      executor.start();

      // Simulate settlement event
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      const settlementPromise = handler(event);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 50));
      await settlementPromise;

      // Verify: markSettlementInProgress called
      expect(mockSettlementMonitor.markSettlementInProgress).toHaveBeenCalledWith(
        testPeerId,
        testTokenId
      );

      // Verify: markSettlementCompleted NOT called
      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
    });
  });

  describe('getSettlementState', () => {
    it('should delegate to settlementMonitor.getSettlementState', () => {
      mockSettlementMonitor.getSettlementState.mockReturnValue(SettlementState.SETTLEMENT_PENDING);

      const state = executor.getSettlementState(testPeerId, testTokenId);

      expect(state).toBe(SettlementState.SETTLEMENT_PENDING);
      expect(mockSettlementMonitor.getSettlementState).toHaveBeenCalledWith(
        testPeerId,
        testTokenId
      );
    });
  });
});
