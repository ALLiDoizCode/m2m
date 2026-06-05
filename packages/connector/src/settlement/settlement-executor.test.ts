/**
 * Settlement Executor Unit Tests
 *
 * Tests for automated on-chain settlement via payment channels.
 * Uses mocked dependencies (ChainProviderRegistry, PaymentChannelProvider,
 * AccountManager, SettlementMonitor).
 *
 * **Test Coverage:**
 * 1. Event listener registration and cleanup
 * 2. New channel opening and settlement (two-step: open + deposit)
 * 3. Settlement via existing channel using per-packet claims
 * 4. Provider resolution via ChainProviderRegistry
 * 5. Retry logic with exponential backoff
 * 6. Error handling (no provider, no claim, permanent failures)
 * 7. Settlement monitor state transitions
 * 8. Settlement serialization and graceful shutdown
 *
 * Source: Epic 32 Story 32.5 - SettlementExecutor Multi-Chain Refactor
 */

import { SettlementExecutor, SettlementExecutorConfig } from './settlement-executor';
import { AccountManager } from './account-manager';
import { SettlementMonitor } from './settlement-monitor';
import { SettlementTriggerEvent, SettlementState } from '../config/types';
import type {
  PaymentChannelProvider,
  BalanceProofParams,
} from './provider/payment-channel-provider';
import type { ChainProviderRegistry } from './provider/chain-provider-registry';
import type { ChannelManager, ChannelMetadata } from './channel-manager';
import pino from 'pino';

// Mock dependencies
jest.mock('./account-manager');
jest.mock('./settlement-monitor');

// Test data
const testPeerId = 'connector-a';
const testTokenId = 'M2M';
const testTokenAddress = '0x1234567890123456789012345678901234567890';
const testPeerAddress = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const testChannelId = '0xaaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';
const testCurrentBalance = 1200n;
const testThreshold = 1000n;
const testChainId = 'evm:anvil:31337';

/**
 * Create a mock PaymentChannelProvider
 */
function createMockProvider(): jest.Mocked<PaymentChannelProvider> {
  return {
    openChannel: jest.fn().mockResolvedValue({ channelId: testChannelId, txHash: '0xMockTxHash' }),
    deposit: jest.fn().mockResolvedValue({ txHash: '0xDepositTxHash' }),
    claimFromChannel: jest.fn().mockResolvedValue({ txHash: '0xClaimTxHash' }),
    closeChannel: jest.fn().mockResolvedValue({ txHash: '0xCloseTxHash' }),
    settleChannel: jest.fn().mockResolvedValue({ txHash: '0xSettleTxHash' }),
    signBalanceProof: jest.fn().mockResolvedValue('0xsignature'),
    verifyBalanceProof: jest.fn().mockResolvedValue(true),
    getChannelState: jest.fn().mockResolvedValue({
      channelId: testChannelId,
      status: 'opened' as const,
      participants: [testPeerAddress.toLowerCase(), '0x9876543210987654321098765432109876543210'],
      deposit: 10000n,
    }),
    subscribeToEvents: jest.fn().mockReturnValue({ unsubscribe: jest.fn() }),
    chainType: 'evm' as const,
    chainId: testChainId,
  };
}

/**
 * Create a mock ChainProviderRegistry
 */
function createMockRegistry(
  provider: jest.Mocked<PaymentChannelProvider>
): jest.Mocked<
  Pick<ChainProviderRegistry, 'getProviderForPeer' | 'getProvider' | 'getAllProviders'>
> {
  return {
    getProviderForPeer: jest
      .fn()
      .mockImplementation((peerConfig: { peerId: string; chain?: string }) => {
        if (peerConfig.chain === testChainId) return provider;
        return undefined;
      }),
    getProvider: jest.fn().mockReturnValue(provider),
    getAllProviders: jest.fn().mockReturnValue([provider]),
  };
}

/**
 * Create a mock ChannelManager
 */
function createMockChannelManager(): jest.Mocked<
  Pick<ChannelManager, 'getChannelForPeer' | 'getChannelById' | 'getChannelsForPeer'>
> {
  return {
    getChannelForPeer: jest.fn().mockReturnValue(null),
    getChannelById: jest.fn().mockReturnValue(null),
    getChannelsForPeer: jest.fn().mockReturnValue([]),
  };
}

describe('SettlementExecutor', () => {
  let executor: SettlementExecutor;
  let mockAccountManager: jest.Mocked<AccountManager>;
  let mockSettlementMonitor: jest.Mocked<SettlementMonitor>;
  let mockProvider: jest.Mocked<PaymentChannelProvider>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRegistry: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockChannelManager: any;
  let logger: pino.Logger;
  let config: SettlementExecutorConfig;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create fresh mock instances
    /* eslint-disable @typescript-eslint/no-explicit-any */
    mockAccountManager = new AccountManager(
      {} as any,
      {} as any,
      {} as any
    ) as jest.Mocked<AccountManager>;
    mockSettlementMonitor = new SettlementMonitor(
      {} as any,
      {} as any
    ) as jest.Mocked<SettlementMonitor>;
    /* eslint-enable @typescript-eslint/no-explicit-any */

    // Setup mock implementations
    mockAccountManager.recordSettlement = jest.fn().mockResolvedValue(undefined);
    mockSettlementMonitor.markSettlementInProgress = jest.fn();
    mockSettlementMonitor.markSettlementCompleted = jest.fn();
    mockSettlementMonitor.getSettlementState = jest.fn().mockReturnValue(SettlementState.IDLE);
    mockSettlementMonitor.on = jest.fn();
    mockSettlementMonitor.off = jest.fn();

    // Create provider and registry mocks
    mockProvider = createMockProvider();
    mockRegistry = createMockRegistry(mockProvider);
    mockChannelManager = createMockChannelManager();

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
      peerIdToChainMap: new Map([[testPeerId, testChainId]]),
    };

    // Create executor instance
    executor = new SettlementExecutor(
      config,
      mockAccountManager,
      mockRegistry,
      mockSettlementMonitor,
      logger
    );
    executor.setChannelManager(mockChannelManager);
  });

  afterEach(async () => {
    // Cleanup: Stop executor to remove listeners and drain in-flight settlements
    await executor.stop();
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
    it('should open new channel then deposit when no existing channel', async () => {
      // Mock: No existing channel via ChannelManager
      mockChannelManager.getChannelForPeer.mockReturnValue(null);

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

      // Simulate settlement event — handler enqueues onto settlement chain
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);

      // Drain the settlement chain by stopping the executor
      await executor.stop();

      // Verify: provider resolved from registry
      expect(mockRegistry.getProviderForPeer).toHaveBeenCalledWith({
        peerId: testPeerId,
        chain: testChainId,
      });

      // Verify: openChannel called with correct parameters (no tokenAddress, no deposit)
      expect(mockProvider.openChannel).toHaveBeenCalledWith(
        testPeerAddress,
        config.defaultSettlementTimeout
      );

      // Verify: deposit called separately after openChannel
      expect(mockProvider.deposit).toHaveBeenCalledWith(
        testChannelId,
        (testCurrentBalance * BigInt(config.initialDepositMultiplier)).toString()
      );

      // Verify: recordSettlement called after channel open + deposit
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
    });
  });

  describe('Settlement via Existing Channel', () => {
    it('should use provider.claimFromChannel with BalanceProofParams when channel exists', async () => {
      // Mock: Existing channel found via ChannelManager
      mockChannelManager.getChannelForPeer.mockReturnValue({
        channelId: testChannelId,
        peerId: testPeerId,
        tokenId: testTokenId,
        tokenAddress: testTokenAddress,
        chain: testChainId,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      } as ChannelMetadata);

      // Create executor with per-packet claim service
      const mockPerPacketClaimService = {
        getLatestClaim: jest.fn().mockReturnValue({
          blockchain: 'evm',
          channelId: testChannelId,
          nonce: 5,
          transferredAmount: '5000',
          lockedAmount: '0',
          locksRoot: '0x' + '0'.repeat(64),
          signature: '0xperpacketsignature',
        }),
        resetChannel: jest.fn(),
        start: jest.fn(),
        stop: jest.fn(),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      executor.setPerPacketClaimService(mockPerPacketClaimService as any);

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

      // Simulate settlement event — handler enqueues onto settlement chain
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);

      // Drain the settlement chain by stopping the executor
      await executor.stop();

      // Verify: claimFromChannel called with BalanceProofParams (string amounts)
      expect(mockProvider.claimFromChannel).toHaveBeenCalledWith(
        testChannelId,
        expect.objectContaining({
          channelId: testChannelId,
          nonce: 5,
          transferredAmount: '5000',
          lockedAmount: '0',
          locksRoot: '0x' + '0'.repeat(64),
        } as BalanceProofParams),
        '0xperpacketsignature'
      );

      // Verify: markSettlementCompleted called
      expect(mockSettlementMonitor.markSettlementCompleted).toHaveBeenCalledWith(
        testPeerId,
        testTokenId
      );
    });
  });

  describe('Channel Lookup Token-Id Fallback (#92)', () => {
    it('should reuse the verified channel via chain fallback when the tokenId-keyed lookup misses', async () => {
      // Issue #92: a non-EVM external channel is indexed in the ChannelManager
      // under a tokenId derived from its on-chain program/token id (e.g. a Solana
      // programId). The SettlementMonitor fires with the EVM-derived settlement
      // tokenId ('M2M'), so the direct tokenId-keyed lookup misses. The executor
      // must fall back to the peer+chain scan and claimFromChannel the existing
      // verified channel — NOT wrongly open a brand-new one.
      const solanaProgramTokenId = 'EdJxYPDxGvaJuu57DSUptf4soLv8enpdyQJJhHDLiydG';

      // Direct lookup by the monitor's tokenId ('M2M') misses...
      mockChannelManager.getChannelForPeer.mockReturnValue(null);
      // ...but the peer has an open channel indexed under the program-derived tokenId.
      mockChannelManager.getChannelsForPeer.mockReturnValue([
        {
          channelId: testChannelId,
          peerId: testPeerId,
          tokenId: solanaProgramTokenId,
          tokenAddress: solanaProgramTokenId,
          chain: testChainId,
          createdAt: new Date(),
          lastActivityAt: new Date(),
          status: 'open',
        } as ChannelMetadata,
      ]);

      // Verified inbound claim used to build the balance proof for claimFromChannel.
      const verifiedClaim = {
        blockchain: 'evm',
        channelId: testChannelId,
        nonce: 7,
        transferredAmount: '5000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
        signature: '0xverifiedclaimsignature',
      };
      const mockClaimReceiver = {
        getLatestVerifiedClaimForPeer: jest.fn().mockResolvedValue(verifiedClaim),
        getLatestVerifiedClaimForChannel: jest.fn().mockResolvedValue(verifiedClaim),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      executor.setClaimReceiver(mockClaimReceiver as any);

      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      executor.start();
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);
      await executor.stop();

      // Verify: claimFromChannel used the verified channel; no new channel opened.
      expect(mockChannelManager.getChannelsForPeer).toHaveBeenCalledWith(testPeerId);
      expect(mockProvider.claimFromChannel).toHaveBeenCalledWith(
        testChannelId,
        expect.objectContaining({ channelId: testChannelId, nonce: 7 }),
        '0xverifiedclaimsignature'
      );
      expect(mockProvider.openChannel).not.toHaveBeenCalled();
      expect(mockSettlementMonitor.markSettlementCompleted).toHaveBeenCalledWith(
        testPeerId,
        testTokenId
      );
    });

    it('should not match a channel on a different chain in the fallback scan', async () => {
      // The fallback is chain-scoped: an open channel on a different chain must not
      // be claimed for a settlement resolved to testChainId.
      mockChannelManager.getChannelForPeer.mockReturnValue(null);
      mockChannelManager.getChannelsForPeer.mockReturnValue([
        {
          channelId: testChannelId,
          peerId: testPeerId,
          tokenId: 'SomeOtherToken',
          tokenAddress: 'SomeOtherToken',
          chain: 'solana:devnet', // different from the peer's resolved chain (testChainId)
          createdAt: new Date(),
          lastActivityAt: new Date(),
          status: 'open',
        } as ChannelMetadata,
      ]);

      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      executor.start();
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);
      await executor.stop();

      // Verify: no chain match → opens a new channel (does not claim the mismatched one).
      expect(mockProvider.claimFromChannel).not.toHaveBeenCalled();
      expect(mockProvider.openChannel).toHaveBeenCalled();
    });
  });

  describe('Per-Packet Claim Integration', () => {
    it('should reset per-packet claim tracking after successful claim', async () => {
      // Mock: Existing channel found via ChannelManager
      mockChannelManager.getChannelForPeer.mockReturnValue({
        channelId: testChannelId,
        peerId: testPeerId,
        tokenId: testTokenId,
        tokenAddress: testTokenAddress,
        chain: testChainId,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      } as ChannelMetadata);

      // Create executor with per-packet claim service
      const mockPerPacketClaimService = {
        getLatestClaim: jest.fn().mockReturnValue({
          blockchain: 'evm',
          channelId: testChannelId,
          nonce: 5,
          transferredAmount: '5000',
          lockedAmount: '0',
          locksRoot: '0x' + '0'.repeat(64),
          signature: '0xperpacketsignature',
        }),
        resetChannel: jest.fn(),
        start: jest.fn(),
        stop: jest.fn(),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      executor.setPerPacketClaimService(mockPerPacketClaimService as any);

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

      // Simulate settlement event — handler enqueues onto settlement chain
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);

      // Drain the settlement chain by stopping the executor
      await executor.stop();

      // Verify: per-packet claim tracking reset after successful claim
      expect(mockPerPacketClaimService.resetChannel).toHaveBeenCalledWith(testChannelId);

      // Verify: resetChannel called AFTER claimFromChannel (correct ordering)
      const claimOrder =
        (mockProvider.claimFromChannel as jest.Mock).mock.invocationCallOrder[0] || 0;
      const resetOrder =
        (mockPerPacketClaimService.resetChannel as jest.Mock).mock.invocationCallOrder[0] || 0;
      expect(claimOrder).toBeLessThan(resetOrder);
    });

    it('should fail when no per-packet claim available (fallback path deprecated)', async () => {
      // Mock: Existing channel found via ChannelManager
      mockChannelManager.getChannelForPeer.mockReturnValue({
        channelId: testChannelId,
        peerId: testPeerId,
        tokenId: testTokenId,
        tokenAddress: testTokenAddress,
        chain: testChainId,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      } as ChannelMetadata);

      // No per-packet claim service set — latestClaim will be null

      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      executor.start();

      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);

      await executor.stop();

      // Verify: settlement fails — markSettlementCompleted NOT called
      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();

      // Verify: claimFromChannel NOT called (no claim to submit)
      expect(mockProvider.claimFromChannel).not.toHaveBeenCalled();
    });
  });

  describe('Channel Lookup with Non-Open Status', () => {
    it('should open new channel when existing channel has closed status', async () => {
      // Mock: Channel exists but is closed
      mockChannelManager.getChannelForPeer.mockReturnValue({
        channelId: testChannelId,
        peerId: testPeerId,
        tokenId: testTokenId,
        tokenAddress: testTokenAddress,
        chain: testChainId,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'closed',
      } as ChannelMetadata);

      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      executor.start();
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);
      await executor.stop();

      // Verify: falls through to openChannel because channel status is not 'open'/'opened'
      expect(mockProvider.openChannel).toHaveBeenCalledWith(
        testPeerAddress,
        config.defaultSettlementTimeout
      );
      expect(mockSettlementMonitor.markSettlementCompleted).toHaveBeenCalledWith(
        testPeerId,
        testTokenId
      );
    });
  });

  describe('Deposit Failure After Successful Open', () => {
    it('should fail settlement when deposit fails after successful openChannel', async () => {
      // Mock: No existing channel
      mockChannelManager.getChannelForPeer.mockReturnValue(null);

      // Mock: openChannel succeeds but deposit fails permanently
      mockProvider.openChannel.mockResolvedValue({
        channelId: testChannelId,
        txHash: '0xOpenTxHash',
      });
      mockProvider.deposit.mockRejectedValue(new Error('insufficient funds for gas'));

      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      executor.start();
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);
      await executor.stop();

      // Verify: openChannel was called and succeeded
      expect(mockProvider.openChannel).toHaveBeenCalledTimes(1);

      // Verify: deposit was attempted
      expect(mockProvider.deposit).toHaveBeenCalledTimes(1);

      // Verify: settlement fails (channel exists but unfunded)
      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();

      // Verify: TigerBeetle NOT updated (settlement incomplete)
      expect(mockAccountManager.recordSettlement).not.toHaveBeenCalled();
    });
  });

  describe('CHANNEL_ACTIVITY Event Emission', () => {
    it('should emit CHANNEL_ACTIVITY after successful new channel settlement', async () => {
      // Mock: No existing channel
      mockChannelManager.getChannelForPeer.mockReturnValue(null);

      const channelActivityEvents: { channelId: string }[] = [];
      executor.on('CHANNEL_ACTIVITY', (data) => channelActivityEvents.push(data));

      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      executor.start();
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);
      await executor.stop();

      // Verify: CHANNEL_ACTIVITY emitted with channelId
      expect(channelActivityEvents).toHaveLength(1);
      expect(channelActivityEvents[0]).toEqual({ channelId: testChannelId });
    });

    it('should emit CHANNEL_ACTIVITY after successful existing channel settlement', async () => {
      // Mock: Existing channel found
      mockChannelManager.getChannelForPeer.mockReturnValue({
        channelId: testChannelId,
        peerId: testPeerId,
        tokenId: testTokenId,
        tokenAddress: testTokenAddress,
        chain: testChainId,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      } as ChannelMetadata);

      const mockPerPacketClaimService = {
        getLatestClaim: jest.fn().mockReturnValue({
          blockchain: 'evm',
          channelId: testChannelId,
          nonce: 5,
          transferredAmount: '5000',
          lockedAmount: '0',
          locksRoot: '0x' + '0'.repeat(64),
          signature: '0xsig',
        }),
        resetChannel: jest.fn(),
        start: jest.fn(),
        stop: jest.fn(),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      executor.setPerPacketClaimService(mockPerPacketClaimService as any);

      const channelActivityEvents: { channelId: string }[] = [];
      executor.on('CHANNEL_ACTIVITY', (data) => channelActivityEvents.push(data));

      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      executor.start();
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);
      await executor.stop();

      // Verify: CHANNEL_ACTIVITY emitted with channelId
      expect(channelActivityEvents).toHaveLength(1);
      expect(channelActivityEvents[0]).toEqual({ channelId: testChannelId });
    });
  });

  describe('Provider Resolution', () => {
    it('should fail with descriptive error when no chain configured for peer', async () => {
      // Config with empty peerIdToChainMap
      const noChainConfig = {
        ...config,
        peerIdToChainMap: new Map<string, string>(),
      };

      const noChainExecutor = new SettlementExecutor(
        noChainConfig,
        mockAccountManager,
        mockRegistry,
        mockSettlementMonitor,
        logger
      );

      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      noChainExecutor.start();
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);
      await noChainExecutor.stop();

      // Verify: settlement fails — markSettlementCompleted NOT called
      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
      expect(mockProvider.openChannel).not.toHaveBeenCalled();
    });

    it('should resolve chain from the channel record for a dynamic inbound peer (#88)', async () => {
      // Dynamically-connected (anonymous HS) inbound BTP peer: its peer id is
      // minted at dial time and cannot be pre-listed in static `peers:` config,
      // so peerIdToChainMap has no entry. The chain is still carried by the
      // channel record (the field /admin/channels surfaces).
      const dynamicPeerId = '0x1FB9F4A1c6cA8Ef6Fc05F1F6e0d89c242d61f3b2';
      const dynamicConfig = {
        ...config,
        peerIdToChainMap: new Map<string, string>(), // no static entry for the peer
        peerIdToAddressMap: new Map([[dynamicPeerId, testPeerAddress]]),
      };

      const dynamicExecutor = new SettlementExecutor(
        dynamicConfig,
        mockAccountManager,
        mockRegistry,
        mockSettlementMonitor,
        logger
      );
      dynamicExecutor.setChannelManager(mockChannelManager);

      // Channel record carries the chain (status not 'open' → opens a new channel).
      mockChannelManager.getChannelForPeer.mockReturnValue({
        channelId: testChannelId,
        peerId: dynamicPeerId,
        tokenId: testTokenId,
        tokenAddress: testTokenAddress,
        chain: testChainId,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'closed',
      } as ChannelMetadata);

      const event: SettlementTriggerEvent = {
        peerId: dynamicPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      dynamicExecutor.start();
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);
      await dynamicExecutor.stop();

      // Verify: chain resolved from the channel record → settlement proceeds.
      expect(mockRegistry.getProviderForPeer).toHaveBeenCalledWith({
        peerId: dynamicPeerId,
        chain: testChainId,
      });
      expect(mockProvider.openChannel).toHaveBeenCalled();
      expect(mockSettlementMonitor.markSettlementCompleted).toHaveBeenCalledWith(
        dynamicPeerId,
        testTokenId
      );
    });

    it('should resolve chain from the latest verified claim when no ChannelManager (#88)', async () => {
      // Standalone non-EVM node: no ChannelManager, no static chain mapping.
      // The chain is derived from the latest verified inbound claim's blockchain.
      const dynamicPeerId = '0x1FB9F4A1c6cA8Ef6Fc05F1F6e0d89c242d61f3b2';
      const claimConfig = {
        ...config,
        peerIdToChainMap: new Map<string, string>(),
        peerIdToAddressMap: new Map([[dynamicPeerId, testPeerAddress]]),
      };

      const claimExecutor = new SettlementExecutor(
        claimConfig,
        mockAccountManager,
        mockRegistry,
        mockSettlementMonitor,
        logger
      );
      // Intentionally NOT calling setChannelManager() — standalone node.

      const evmClaim = {
        blockchain: 'evm',
        channelId: testChannelId,
        nonce: 5,
        transferredAmount: '5000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
        signature: '0xperpacketsignature',
      };
      const mockClaimReceiver = {
        getLatestVerifiedClaimForPeer: jest.fn().mockResolvedValue(evmClaim),
        getLatestVerifiedClaimForChannel: jest.fn().mockResolvedValue(evmClaim),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      claimExecutor.setClaimReceiver(mockClaimReceiver as any);

      const event: SettlementTriggerEvent = {
        peerId: dynamicPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      claimExecutor.start();
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);
      await claimExecutor.stop();

      // Verify: chain derived from the claim's blockchain → settlement proceeds.
      expect(mockRegistry.getProviderForPeer).toHaveBeenCalledWith({
        peerId: dynamicPeerId,
        chain: testChainId,
      });
      expect(mockSettlementMonitor.markSettlementCompleted).toHaveBeenCalledWith(
        dynamicPeerId,
        testTokenId
      );
    });

    it('should fail with descriptive error when no provider registered for chain', async () => {
      // Mock registry returns undefined for this peer's chain
      mockRegistry.getProviderForPeer.mockReturnValue(undefined);

      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      executor.start();
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);
      await executor.stop();

      // Verify: settlement fails — markSettlementCompleted NOT called
      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
      expect(mockProvider.openChannel).not.toHaveBeenCalled();
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
        mockRegistry,
        mockSettlementMonitor,
        logger
      );
      fastRetryExecutor.setChannelManager(mockChannelManager);

      // Mock: First 2 calls fail with retryable error, 3rd succeeds
      mockProvider.openChannel
        .mockRejectedValueOnce(new Error('Network timeout'))
        .mockRejectedValueOnce(new Error('Network timeout'))
        .mockResolvedValueOnce({ channelId: testChannelId, txHash: '0xMockTxHash' });

      // Mock: No existing channel
      mockChannelManager.getChannelForPeer.mockReturnValue(null);

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

      // Simulate settlement event — handler enqueues onto settlement chain
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);

      // Drain the settlement chain (retries complete within the chain)
      await fastRetryExecutor.stop();

      // Verify: openChannel called 3 times (2 failures + 1 success)
      expect(mockProvider.openChannel).toHaveBeenCalledTimes(3);

      // Verify: Settlement eventually succeeds
      expect(mockSettlementMonitor.markSettlementCompleted).toHaveBeenCalledWith(
        testPeerId,
        testTokenId
      );
    });
  });

  describe('Error Handling', () => {
    it('should NOT mark completed on permanent failure', async () => {
      // Mock: Permanent failure (insufficient funds)
      mockProvider.openChannel.mockRejectedValue(new Error('Insufficient funds'));

      // Mock: No existing channel
      mockChannelManager.getChannelForPeer.mockReturnValue(null);

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

      // Simulate settlement event — handler enqueues onto settlement chain
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);

      // Drain the settlement chain
      await executor.stop();

      // Verify: markSettlementCompleted NOT called
      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
    });

    it('should classify "nonce too low" as retryable and retry the operation', async () => {
      // Create config with fast retries for testing
      const fastRetryConfig = {
        ...config,
        retryDelayMs: 10,
        maxRetries: 3,
      };

      const retryExecutor = new SettlementExecutor(
        fastRetryConfig,
        mockAccountManager,
        mockRegistry,
        mockSettlementMonitor,
        logger
      );
      retryExecutor.setChannelManager(mockChannelManager);

      // Mock: No existing channel
      mockChannelManager.getChannelForPeer.mockReturnValue(null);

      // Mock: First call fails with "nonce too low" (retryable), second succeeds
      mockProvider.openChannel
        .mockRejectedValueOnce(new Error('nonce too low'))
        .mockResolvedValueOnce({ channelId: testChannelId, txHash: '0xMockTxHash' });

      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      retryExecutor.start();
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);
      await retryExecutor.stop();

      // Verify: openChannel called twice (1 retry + 1 success)
      expect(mockProvider.openChannel).toHaveBeenCalledTimes(2);
      // Verify: settlement succeeded after retry
      expect(mockSettlementMonitor.markSettlementCompleted).toHaveBeenCalledWith(
        testPeerId,
        testTokenId
      );
    });

    it('should classify "insufficient funds" as non-retryable and fail immediately', async () => {
      // Create config with fast retries
      const fastRetryConfig = {
        ...config,
        retryDelayMs: 10,
        maxRetries: 3,
      };

      const retryExecutor = new SettlementExecutor(
        fastRetryConfig,
        mockAccountManager,
        mockRegistry,
        mockSettlementMonitor,
        logger
      );
      retryExecutor.setChannelManager(mockChannelManager);

      // Mock: No existing channel
      mockChannelManager.getChannelForPeer.mockReturnValue(null);

      // Mock: Fails with non-retryable error
      mockProvider.openChannel.mockRejectedValue(new Error('insufficient funds for gas'));

      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      retryExecutor.start();
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);
      await retryExecutor.stop();

      // Verify: openChannel called only once (no retries for non-retryable errors)
      expect(mockProvider.openChannel).toHaveBeenCalledTimes(1);
      // Verify: settlement failed
      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
    });
  });

  describe('Channel Lookup without ChannelManager', () => {
    it('should open new channel when ChannelManager is not set', async () => {
      // Create executor WITHOUT setting ChannelManager
      const noChannelMgrExecutor = new SettlementExecutor(
        config,
        mockAccountManager,
        mockRegistry,
        mockSettlementMonitor,
        logger
      );
      // Intentionally NOT calling setChannelManager()

      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      noChannelMgrExecutor.start();
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);
      await noChannelMgrExecutor.stop();

      // Verify: falls through to openChannel because findChannelForPeer returns null
      expect(mockProvider.openChannel).toHaveBeenCalledWith(
        testPeerAddress,
        config.defaultSettlementTimeout
      );
      // Verify: settlement completed successfully via new channel
      expect(mockSettlementMonitor.markSettlementCompleted).toHaveBeenCalledWith(
        testPeerId,
        testTokenId
      );
    });
  });

  describe('Settlement Monitor State Transitions', () => {
    it('should call markSettlementInProgress immediately and markSettlementCompleted after success', async () => {
      // Mock: No existing channel
      mockChannelManager.getChannelForPeer.mockReturnValue(null);

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

      // Simulate settlement event — handler enqueues onto settlement chain
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);

      // Drain the settlement chain
      await executor.stop();

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
      mockProvider.openChannel.mockRejectedValue(new Error('Insufficient funds'));
      mockChannelManager.getChannelForPeer.mockReturnValue(null);

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

      // Simulate settlement event — handler enqueues onto settlement chain
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);

      // Drain the settlement chain
      await executor.stop();

      // Verify: markSettlementInProgress called
      expect(mockSettlementMonitor.markSettlementInProgress).toHaveBeenCalledWith(
        testPeerId,
        testTokenId
      );

      // Verify: markSettlementCompleted NOT called
      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
    });
  });

  describe('Settlement Serialization', () => {
    it('should serialize concurrent settlement events to prevent nonce collisions', async () => {
      // Track execution order
      const executionOrder: string[] = [];

      // Mock: No existing channels
      mockChannelManager.getChannelForPeer.mockReturnValue(null);

      // Mock: openChannel records execution order with a delay
      mockProvider.openChannel.mockImplementation(async (participant2: string) => {
        const peerId = participant2 === testPeerAddress ? 'peer-a' : 'peer-b';
        executionOrder.push(`start-${peerId}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        executionOrder.push(`end-${peerId}`);
        return { channelId: testChannelId, txHash: '0xMockTxHash' };
      });

      // Setup second peer
      const secondPeerAddress = '0x1111111111111111111111111111111111111111';
      config.peerIdToAddressMap.set('connector-b', secondPeerAddress);
      config.peerIdToChainMap.set('connector-b', testChainId);

      // Recreate executor with updated config
      const serialExecutor = new SettlementExecutor(
        config,
        mockAccountManager,
        mockRegistry,
        mockSettlementMonitor,
        logger
      );
      serialExecutor.setChannelManager(mockChannelManager);

      serialExecutor.start();

      // Fire two settlement events concurrently
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler({
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      });
      handler({
        peerId: 'connector-b',
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      });

      // Drain all settlements
      await serialExecutor.stop();

      // Verify: settlements executed sequentially (no interleaving)
      expect(executionOrder[0]).toBe('start-peer-a');
      expect(executionOrder[1]).toBe('end-peer-a');
      expect(executionOrder[2]).toBe('start-peer-b');
      expect(executionOrder[3]).toBe('end-peer-b');
    });
  });

  describe('Graceful Shutdown', () => {
    it('should ignore new settlement events after stop() is called', async () => {
      // Start executor
      executor.start();

      // Stop executor first
      await executor.stop();

      // Try to fire a settlement event after stop
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler({
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      });

      // Give time for any async operations
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify: No settlement operations were attempted
      expect(mockSettlementMonitor.markSettlementInProgress).not.toHaveBeenCalled();
      expect(mockProvider.openChannel).not.toHaveBeenCalled();
    });

    it('should await in-flight settlement before stop() resolves', async () => {
      let settlementResolved = false;

      // Mock: openChannel with a delay to simulate in-flight settlement
      mockChannelManager.getChannelForPeer.mockReturnValue(null);
      mockProvider.openChannel.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        settlementResolved = true;
        return { channelId: testChannelId, txHash: '0xMockTxHash' };
      });

      // Start executor
      executor.start();

      // Fire settlement event
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler({
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      });

      // Stop executor — should await the in-flight settlement
      await executor.stop();

      // Verify: settlement completed before stop() resolved
      expect(settlementResolved).toBe(true);
      expect(mockSettlementMonitor.markSettlementCompleted).toHaveBeenCalled();
    });
  });

  describe('Dynamic Peer Address Resolution', () => {
    it('should fail settlement when peer address is missing from peerIdToAddressMap', async () => {
      // Start with an empty peerIdToAddressMap
      const emptyMapConfig = {
        ...config,
        peerIdToAddressMap: new Map<string, string>(),
        maxRetries: 0,
      };

      const emptyMapExecutor = new SettlementExecutor(
        emptyMapConfig,
        mockAccountManager,
        mockRegistry,
        mockSettlementMonitor,
        logger
      );
      emptyMapExecutor.setChannelManager(mockChannelManager);

      mockChannelManager.getChannelForPeer.mockReturnValue(null);

      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      emptyMapExecutor.start();
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);
      await emptyMapExecutor.stop();

      // Settlement should fail because peer address is not in the map
      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
      expect(mockProvider.openChannel).not.toHaveBeenCalled();
    });

    it('should succeed after peer address is dynamically added to shared peerIdToAddressMap', async () => {
      // Shared mutable map — starts empty, then gets populated (simulating ClaimReceiver write)
      const sharedMap = new Map<string, string>();
      const dynamicConfig = {
        ...config,
        peerIdToAddressMap: sharedMap,
      };

      // Simulate ClaimReceiver dynamically registering the peer address
      sharedMap.set(testPeerId, testPeerAddress);

      mockChannelManager.getChannelForPeer.mockReturnValue(null);

      const dynamicExecutor = new SettlementExecutor(
        dynamicConfig,
        mockAccountManager,
        mockRegistry,
        mockSettlementMonitor,
        logger
      );
      dynamicExecutor.setChannelManager(mockChannelManager);

      const event: SettlementTriggerEvent = {
        peerId: testPeerId,
        tokenId: testTokenId,
        currentBalance: testCurrentBalance,
        threshold: testThreshold,
        exceedsBy: testCurrentBalance - testThreshold,
        timestamp: new Date(),
      };

      dynamicExecutor.start();
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      handler(event);
      await dynamicExecutor.stop();

      // Settlement should succeed with the dynamically added address
      expect(mockProvider.openChannel).toHaveBeenCalledWith(
        testPeerAddress,
        dynamicConfig.defaultSettlementTimeout
      );
      expect(mockSettlementMonitor.markSettlementCompleted).toHaveBeenCalledWith(
        testPeerId,
        testTokenId
      );
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
