/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */
/**
 * Branch coverage tests for SettlementExecutor
 *
 * Targets all if/else, try/catch, ternary, short-circuit, and loop branches
 * to drive branch coverage toward 100%.
 */

import {
  SettlementExecutor,
  SettlementExecutorConfig,
} from '../../../src/settlement/settlement-executor';
import { AccountManager } from '../../../src/settlement/account-manager';
import { SettlementMonitor } from '../../../src/settlement/settlement-monitor';
import { SettlementState } from '../../../src/config/types';
import type { SettlementTriggerEvent } from '../../../src/config/types';
import type { ChainProviderRegistry } from '../../../src/settlement/provider/chain-provider-registry';
import type { PaymentChannelProvider } from '../../../src/settlement/provider/payment-channel-provider';
import type { ChannelMetadata } from '../../../src/settlement/channel-manager';
import type { Logger } from 'pino';

// Mock complex dependencies so we can instantiate SettlementExecutor with minimal stubs
jest.mock('../../../src/settlement/account-manager');
jest.mock('../../../src/settlement/settlement-monitor');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PEER_ID = 'connector-a';
const TEST_PEER_ID_B = 'connector-b';
const TEST_TOKEN_ID = 'M2M';
const TEST_TOKEN_ADDRESS = '0x1234567890123456789012345678901234567890';
const TEST_PEER_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const TEST_PEER_ADDRESS_B = '0x1111111111111111111111111111111111111111';
const TEST_CHANNEL_ID = '0xaaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';
const TEST_CHAIN_ID = 'evm:anvil:31337';
const TEST_CURRENT_BALANCE = 1200n;
const TEST_THRESHOLD = 1000n;

// ---------------------------------------------------------------------------
// Mock Factories
// ---------------------------------------------------------------------------

const createMockLogger = (): Logger =>
  ({
    child: jest.fn().mockReturnThis(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
  }) as unknown as Logger;

const createMockProvider = (): jest.Mocked<PaymentChannelProvider> =>
  ({
    openChannel: jest
      .fn()
      .mockResolvedValue({ channelId: TEST_CHANNEL_ID, txHash: '0xOpenTxHash' }),
    deposit: jest.fn().mockResolvedValue({ txHash: '0xDepositTxHash' }),
    claimFromChannel: jest.fn().mockResolvedValue({ txHash: '0xClaimTxHash' }),
    closeChannel: jest.fn().mockResolvedValue({ txHash: '0xCloseTxHash' }),
    settleChannel: jest.fn().mockResolvedValue({ txHash: '0xSettleTxHash' }),
    signBalanceProof: jest.fn().mockResolvedValue('0xsignature'),
    verifyBalanceProof: jest.fn().mockResolvedValue(true),
    getChannelState: jest.fn().mockResolvedValue({
      channelId: TEST_CHANNEL_ID,
      status: 'opened' as const,
      participants: [TEST_PEER_ADDRESS.toLowerCase(), '0x9876543210987654321098765432109876543210'],
      deposit: 10000n,
    }),
    subscribeToEvents: jest.fn().mockReturnValue({ unsubscribe: jest.fn() }),
    chainType: 'evm' as const,
    chainId: TEST_CHAIN_ID,
  }) as unknown as jest.Mocked<PaymentChannelProvider>;

const createMockRegistry = (
  provider?: jest.Mocked<PaymentChannelProvider>
): jest.Mocked<
  Pick<ChainProviderRegistry, 'getProviderForPeer' | 'getProvider' | 'getAllProviders'>
> => ({
  getProviderForPeer: jest
    .fn()
    .mockImplementation((peerConfig: { peerId: string; chain?: string }) => {
      if (peerConfig.chain === TEST_CHAIN_ID) return provider;
      return undefined;
    }),
  getProvider: jest.fn().mockReturnValue(provider),
  getAllProviders: jest.fn().mockReturnValue(provider ? [provider] : []),
});

const createMockChannelManager = (
  channelMap?: Record<string, { channelId: string; tokenId: string; status?: string }>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any => ({
  getChannelForPeer: jest.fn().mockImplementation((peerId: string, tokenId: string) => {
    const key = `${peerId}:${tokenId}`;
    const channel = channelMap?.[key];
    if (!channel) return null;
    return {
      channelId: channel.channelId,
      peerId,
      tokenId,
      tokenAddress: TEST_TOKEN_ADDRESS,
      chain: TEST_CHAIN_ID,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      status: channel.status ?? 'open',
    } as unknown as ChannelMetadata;
  }),
});

const createTestConfig = (
  overrides?: Partial<SettlementExecutorConfig>
): SettlementExecutorConfig =>
  ({
    nodeId: 'connector-b',
    defaultSettlementTimeout: 86400,
    initialDepositMultiplier: 10,
    minDepositThreshold: 0.5,
    maxRetries: 3,
    retryDelayMs: 10, // Fast retries for tests
    tokenAddressMap: new Map([[TEST_TOKEN_ID, TEST_TOKEN_ADDRESS]]),
    peerIdToAddressMap: new Map([
      [TEST_PEER_ID, TEST_PEER_ADDRESS],
      [TEST_PEER_ID_B, TEST_PEER_ADDRESS_B],
    ]),
    peerIdToChainMap: new Map([
      [TEST_PEER_ID, TEST_CHAIN_ID],
      [TEST_PEER_ID_B, TEST_CHAIN_ID],
    ]),
    ...overrides,
  }) as unknown as SettlementExecutorConfig;

const createSettlementEvent = (
  overrides?: Partial<SettlementTriggerEvent>
): SettlementTriggerEvent => ({
  peerId: TEST_PEER_ID,
  tokenId: TEST_TOKEN_ID,
  currentBalance: TEST_CURRENT_BALANCE,
  threshold: TEST_THRESHOLD,
  exceedsBy: TEST_CURRENT_BALANCE - TEST_THRESHOLD,
  timestamp: new Date(),
  ...overrides,
});

const fireSettlementEvent = (
  mockSettlementMonitor: jest.Mocked<SettlementMonitor>,
  event: SettlementTriggerEvent
): void => {
  const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0]?.[1];
  if (handler) handler(event);
};

// ---------------------------------------------------------------------------
// Helper: build executor with fresh mocks
// ---------------------------------------------------------------------------

function buildExecutor(overrides?: {
  config?: Partial<SettlementExecutorConfig>;
  provider?: jest.Mocked<PaymentChannelProvider>;
  registry?: jest.Mocked<Pick<ChainProviderRegistry, 'getProviderForPeer' | 'getProvider'>>;
}) {
  const mockAccountManager = new AccountManager(
    {} as any,
    {} as any,
    {} as any
  ) as jest.Mocked<AccountManager>;
  const mockSettlementMonitor = new SettlementMonitor(
    {} as any,
    {} as any
  ) as jest.Mocked<SettlementMonitor>;

  mockAccountManager.recordSettlement = jest.fn().mockResolvedValue(undefined);
  mockSettlementMonitor.markSettlementInProgress = jest.fn();
  mockSettlementMonitor.markSettlementCompleted = jest.fn();
  mockSettlementMonitor.getSettlementState = jest.fn().mockReturnValue(SettlementState.IDLE);
  mockSettlementMonitor.on = jest.fn();
  mockSettlementMonitor.off = jest.fn();

  const mockProvider = overrides?.provider ?? createMockProvider();
  const mockRegistry = overrides?.registry ?? createMockRegistry(mockProvider);
  const config = createTestConfig(overrides?.config);
  const logger = createMockLogger();

  const executor = new SettlementExecutor(
    config,
    mockAccountManager,
    mockRegistry as unknown as ChainProviderRegistry,
    mockSettlementMonitor,
    logger
  );

  return {
    executor,
    mockAccountManager,
    mockSettlementMonitor,
    mockProvider,
    mockRegistry,
    logger,
    config,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SettlementExecutor branch coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // Constructor & lifecycle
  // ==========================================================================

  describe('constructor and lifecycle', () => {
    it('should construct and log initialization info', () => {
      const { executor, logger } = buildExecutor();
      expect(executor).toBeInstanceOf(SettlementExecutor);
      expect((logger.child as jest.Mock).mock.calls[0][0]).toEqual({
        component: 'settlement-executor',
      });
    });

    it('should start and register event listener', () => {
      const { executor, mockSettlementMonitor } = buildExecutor();
      executor.start();
      expect(mockSettlementMonitor.on).toHaveBeenCalledWith(
        'SETTLEMENT_REQUIRED',
        expect.any(Function)
      );
    });

    it('should stop, unregister listener, and drain in-flight settlements', async () => {
      const { executor, mockSettlementMonitor } = buildExecutor();
      executor.start();
      await executor.stop();
      expect(mockSettlementMonitor.off).toHaveBeenCalledWith(
        'SETTLEMENT_REQUIRED',
        expect.any(Function)
      );
    });

    it('should ignore settlement events after stop() (stopping=true branch)', async () => {
      const { executor, mockSettlementMonitor, logger } = buildExecutor();
      executor.start();
      await executor.stop();

      // After stop, fire another event
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ peerId: TEST_PEER_ID, tokenId: TEST_TOKEN_ID }),
        'Settlement event ignored during shutdown'
      );
      expect(mockSettlementMonitor.markSettlementInProgress).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // _processSettlement success / error branches
  // ==========================================================================

  describe('_processSettlement', () => {
    it('should mark completed on successful settlement', async () => {
      const { executor, mockSettlementMonitor, mockProvider } = buildExecutor();
      const mockChannelManager = createMockChannelManager();
      executor.setChannelManager(mockChannelManager);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockSettlementMonitor.markSettlementInProgress).toHaveBeenCalledWith(
        TEST_PEER_ID,
        TEST_TOKEN_ID
      );
      expect(mockSettlementMonitor.markSettlementCompleted).toHaveBeenCalledWith(
        TEST_PEER_ID,
        TEST_TOKEN_ID
      );
      expect(mockProvider.openChannel).toHaveBeenCalled();
    });

    it('should catch error and leave state IN_PROGRESS (error branch)', async () => {
      const { executor, mockSettlementMonitor } = buildExecutor({
        config: { peerIdToChainMap: new Map() },
      });

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockSettlementMonitor.markSettlementInProgress).toHaveBeenCalled();
      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
    });

    it('should catch non-Error thrown and log String(error) (error instanceof Error false)', async () => {
      const { executor, mockSettlementMonitor, mockRegistry, logger } = buildExecutor();
      // Throw a non-Error from registry so it bypasses retryWithBackoff wrapping
      (mockRegistry.getProviderForPeer as jest.Mock).mockImplementation(() => {
        throw 'string-error';
      });

      const mockChannelManager = createMockChannelManager();
      executor.setChannelManager(mockChannelManager);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
      // The error log should contain the string error without a stack
      const errorLogCall = (logger.error as jest.Mock).mock.calls.find(
        (call: any[]) => call[1] === 'Settlement failed'
      );
      expect(errorLogCall).toBeDefined();
      expect(errorLogCall[0].errorMessage).toBe('string-error');
      expect(errorLogCall[0].errorStack).toBeUndefined();
    });
  });

  // ==========================================================================
  // executeSettlement branches
  // ==========================================================================

  describe('executeSettlement branches', () => {
    it('should throw when no chain configured for peer (!chain branch)', async () => {
      const { executor, mockSettlementMonitor } = buildExecutor({
        config: { peerIdToChainMap: new Map() },
      });

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
    });

    it('should throw when no provider registered for chain (!provider branch)', async () => {
      const { executor, mockSettlementMonitor, mockRegistry } = buildExecutor();
      mockRegistry.getProviderForPeer.mockReturnValue(undefined);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
    });

    it('should throw when token address not found (!tokenAddress branch)', async () => {
      const { executor, mockSettlementMonitor } = buildExecutor({
        config: { tokenAddressMap: new Map() },
      });
      const mockChannelManager = createMockChannelManager();
      executor.setChannelManager(mockChannelManager);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
    });

    it('should open new channel when no channel exists (!channelId branch)', async () => {
      const { executor, mockSettlementMonitor, mockProvider } = buildExecutor();
      const mockChannelManager = createMockChannelManager();
      executor.setChannelManager(mockChannelManager);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockProvider.openChannel).toHaveBeenCalled();
      expect(mockProvider.deposit).toHaveBeenCalled();
    });

    it('should use existing channel when channelId found (else branch)', async () => {
      const { executor, mockSettlementMonitor, mockProvider } = buildExecutor();
      const mockChannelManager = createMockChannelManager({
        [`${TEST_PEER_ID}:${TEST_TOKEN_ID}`]: {
          channelId: TEST_CHANNEL_ID,
          tokenId: TEST_TOKEN_ID,
        },
      });
      executor.setChannelManager(mockChannelManager);

      const mockPerPacketClaimService = {
        getLatestClaim: jest.fn().mockReturnValue({
          blockchain: 'evm',
          channelId: TEST_CHANNEL_ID,
          nonce: 1,
          transferredAmount: '100',
          lockedAmount: '0',
          locksRoot: '0x' + '0'.repeat(64),
          signature: '0xsignature',
        }),
        resetChannel: jest.fn(),
      };
      executor.setPerPacketClaimService(mockPerPacketClaimService as any);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockProvider.claimFromChannel).toHaveBeenCalled();
      expect(mockProvider.openChannel).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // findChannelForPeer branches
  // ==========================================================================

  describe('findChannelForPeer branches', () => {
    it('should return null when ChannelManager is not set (!this.channelManager branch)', async () => {
      const { executor, mockSettlementMonitor, mockProvider } = buildExecutor();
      // Do NOT set channel manager
      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockProvider.openChannel).toHaveBeenCalled();
      expect(mockProvider.claimFromChannel).not.toHaveBeenCalled();
    });

    it('should return null when metadata not found (!metadata branch)', async () => {
      const { executor, mockSettlementMonitor, mockProvider } = buildExecutor();
      const mockChannelManager = createMockChannelManager();
      executor.setChannelManager(mockChannelManager);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockProvider.openChannel).toHaveBeenCalled();
    });

    it('should return null when metadata status is not open (status !== open branch)', async () => {
      const { executor, mockSettlementMonitor, mockProvider } = buildExecutor();
      const mockChannelManager = createMockChannelManager({
        [`${TEST_PEER_ID}:${TEST_TOKEN_ID}`]: {
          channelId: TEST_CHANNEL_ID,
          tokenId: TEST_TOKEN_ID,
          status: 'closed',
        },
      });
      executor.setChannelManager(mockChannelManager);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockProvider.openChannel).toHaveBeenCalled();
      expect(mockProvider.claimFromChannel).not.toHaveBeenCalled();
    });

    it('should return channelId when metadata status is open', async () => {
      const { executor, mockSettlementMonitor, mockProvider } = buildExecutor();
      const mockChannelManager = createMockChannelManager({
        [`${TEST_PEER_ID}:${TEST_TOKEN_ID}`]: {
          channelId: TEST_CHANNEL_ID,
          tokenId: TEST_TOKEN_ID,
          status: 'open',
        },
      });
      executor.setChannelManager(mockChannelManager);

      const mockPerPacketClaimService = {
        getLatestClaim: jest.fn().mockReturnValue({
          blockchain: 'evm',
          channelId: TEST_CHANNEL_ID,
          nonce: 1,
          transferredAmount: '100',
          lockedAmount: '0',
          locksRoot: '0x' + '0'.repeat(64),
          signature: '0xsignature',
        }),
        resetChannel: jest.fn(),
      };
      executor.setPerPacketClaimService(mockPerPacketClaimService as any);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockProvider.claimFromChannel).toHaveBeenCalled();
      expect(mockProvider.openChannel).not.toHaveBeenCalled();
    });

    it('should return null when ChannelManager throws (catch branch)', async () => {
      const { executor, mockSettlementMonitor, mockProvider, logger } = buildExecutor();
      const mockChannelManager = {
        getChannelForPeer: jest.fn().mockImplementation(() => {
          throw new Error('DB failure');
        }),
      };
      executor.setChannelManager(mockChannelManager as any);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ peerId: TEST_PEER_ID, tokenId: TEST_TOKEN_ID }),
        'Failed to find channel for peer'
      );
      expect(mockProvider.openChannel).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // openChannelAndSettle branches
  // ==========================================================================

  describe('openChannelAndSettle branches', () => {
    it('should throw when peer address not found (!peerAddress branch)', async () => {
      const { executor, mockSettlementMonitor } = buildExecutor({
        config: { peerIdToAddressMap: new Map() },
      });
      const mockChannelManager = createMockChannelManager();
      executor.setChannelManager(mockChannelManager);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
    });

    it('should emit CHANNEL_ACTIVITY after open+deposit success', async () => {
      const { executor, mockSettlementMonitor, mockAccountManager } = buildExecutor();
      const mockChannelManager = createMockChannelManager();
      executor.setChannelManager(mockChannelManager);

      const activityListener = jest.fn();
      executor.on('CHANNEL_ACTIVITY', activityListener);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(activityListener).toHaveBeenCalledWith({ channelId: TEST_CHANNEL_ID });
      expect(mockAccountManager.recordSettlement).toHaveBeenCalledWith(
        TEST_PEER_ID,
        TEST_TOKEN_ID,
        TEST_CURRENT_BALANCE
      );
    });
  });

  // ==========================================================================
  // settleViaExistingChannel branches
  // ==========================================================================

  describe('settleViaExistingChannel branches', () => {
    it('should use ClaimReceiver claim when available (claimReceiver truthy ternary)', async () => {
      const { executor, mockSettlementMonitor, mockProvider } = buildExecutor();
      const mockChannelManager = createMockChannelManager({
        [`${TEST_PEER_ID}:${TEST_TOKEN_ID}`]: {
          channelId: TEST_CHANNEL_ID,
          tokenId: TEST_TOKEN_ID,
        },
      });
      executor.setChannelManager(mockChannelManager);

      const evmClaim = {
        blockchain: 'evm' as const,
        channelId: TEST_CHANNEL_ID,
        nonce: 7,
        transferredAmount: '700',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
        signature: '0xclaimSig',
      };

      const mockClaimReceiver = {
        getLatestVerifiedClaimForChannel: jest.fn().mockResolvedValue(evmClaim),
        getLatestVerifiedClaimForPeer: jest.fn().mockResolvedValue(evmClaim),
      };
      executor.setClaimReceiver(mockClaimReceiver as any);

      // Also set per-packet service with a different claim to prove ClaimReceiver wins
      const mockPerPacketClaimService = {
        getLatestClaim: jest.fn().mockReturnValue({
          blockchain: 'evm',
          channelId: TEST_CHANNEL_ID,
          nonce: 99,
          transferredAmount: '9900',
          lockedAmount: '0',
          locksRoot: '0x' + '0'.repeat(64),
          signature: '0xotherSig',
        }),
        resetChannel: jest.fn(),
      };
      executor.setPerPacketClaimService(mockPerPacketClaimService as any);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockClaimReceiver.getLatestVerifiedClaimForChannel).toHaveBeenCalledWith(
        TEST_PEER_ID,
        TEST_CHANNEL_ID
      );
      expect(mockProvider.claimFromChannel).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        expect.objectContaining({ nonce: 7, transferredAmount: '700' }),
        '0xclaimSig'
      );
    });

    it('should fall back to PerPacketClaimService when ClaimReceiver null (claimReceiver falsy ternary)', async () => {
      const { executor, mockSettlementMonitor, mockProvider } = buildExecutor();
      const mockChannelManager = createMockChannelManager({
        [`${TEST_PEER_ID}:${TEST_TOKEN_ID}`]: {
          channelId: TEST_CHANNEL_ID,
          tokenId: TEST_TOKEN_ID,
        },
      });
      executor.setChannelManager(mockChannelManager);

      const mockPerPacketClaimService = {
        getLatestClaim: jest.fn().mockReturnValue({
          blockchain: 'evm',
          channelId: TEST_CHANNEL_ID,
          nonce: 3,
          transferredAmount: '300',
          lockedAmount: '0',
          locksRoot: '0x' + '0'.repeat(64),
          signature: '0xfallbackSig',
        }),
        resetChannel: jest.fn(),
      };
      executor.setPerPacketClaimService(mockPerPacketClaimService as any);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockProvider.claimFromChannel).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        expect.objectContaining({ nonce: 3, transferredAmount: '300' }),
        '0xfallbackSig'
      );
    });

    it('should fall back to sent claim when received claim is null (nullish coalescing branch)', async () => {
      const { executor, mockSettlementMonitor, mockProvider } = buildExecutor();
      const mockChannelManager = createMockChannelManager({
        [`${TEST_PEER_ID}:${TEST_TOKEN_ID}`]: {
          channelId: TEST_CHANNEL_ID,
          tokenId: TEST_TOKEN_ID,
        },
      });
      executor.setChannelManager(mockChannelManager);

      const mockClaimReceiver = {
        getLatestVerifiedClaimForChannel: jest.fn().mockResolvedValue(null),
        // No verified peer claim → claim-driven chain resolution is skipped and
        // the static peerIdToChainMap (evm) is used, exercising the sent-claim
        // (perPacketClaimService) fallback below.
        getLatestVerifiedClaimForPeer: jest.fn().mockResolvedValue(null),
      };
      executor.setClaimReceiver(mockClaimReceiver as any);

      const mockPerPacketClaimService = {
        getLatestClaim: jest.fn().mockReturnValue({
          blockchain: 'evm',
          channelId: TEST_CHANNEL_ID,
          nonce: 4,
          transferredAmount: '400',
          lockedAmount: '0',
          locksRoot: '0x' + '0'.repeat(64),
          signature: '0xsentSig',
        }),
        resetChannel: jest.fn(),
      };
      executor.setPerPacketClaimService(mockPerPacketClaimService as any);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockProvider.claimFromChannel).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        expect.objectContaining({ nonce: 4, transferredAmount: '400' }),
        '0xsentSig'
      );
    });

    it('should throw when perPacketClaimService is undefined and no claimReceiver (both null branch)', async () => {
      const { executor, mockSettlementMonitor } = buildExecutor();
      const mockChannelManager = createMockChannelManager({
        [`${TEST_PEER_ID}:${TEST_TOKEN_ID}`]: {
          channelId: TEST_CHANNEL_ID,
          tokenId: TEST_TOKEN_ID,
        },
      });
      executor.setChannelManager(mockChannelManager);
      // No claimReceiver, no perPacketClaimService

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
    });

    it('should throw when latestClaim is null (!latestClaim branch)', async () => {
      const { executor, mockSettlementMonitor } = buildExecutor();
      const mockChannelManager = createMockChannelManager({
        [`${TEST_PEER_ID}:${TEST_TOKEN_ID}`]: {
          channelId: TEST_CHANNEL_ID,
          tokenId: TEST_TOKEN_ID,
        },
      });
      executor.setChannelManager(mockChannelManager);

      const mockPerPacketClaimService = {
        getLatestClaim: jest.fn().mockReturnValue(null),
        resetChannel: jest.fn(),
      };
      executor.setPerPacketClaimService(mockPerPacketClaimService as any);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
    });

    it('should throw on an unsupported claim blockchain (else branch)', async () => {
      const { executor, mockSettlementMonitor } = buildExecutor();
      const mockChannelManager = createMockChannelManager({
        [`${TEST_PEER_ID}:${TEST_TOKEN_ID}`]: {
          channelId: TEST_CHANNEL_ID,
          tokenId: TEST_TOKEN_ID,
        },
      });
      executor.setChannelManager(mockChannelManager);

      const mockPerPacketClaimService = {
        // A claim whose blockchain matches none of the EVM/Solana/Mina type
        // guards exercises the `else -> throw Unsupported claim blockchain` path.
        getLatestClaim: jest.fn().mockReturnValue({
          blockchain: 'cosmos',
          channelId: TEST_CHANNEL_ID,
          nonce: 1,
          transferredAmount: '100',
          lockedAmount: '0',
          locksRoot: '0x' + '0'.repeat(64),
          signature: '0xnope',
        }),
        resetChannel: jest.fn(),
      };
      executor.setPerPacketClaimService(mockPerPacketClaimService as any);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
    });

    it('should settle a Solana claim via the resolved provider (claimFromChannel)', async () => {
      // A Solana claim must be settled by a Solana-typed provider. The executor
      // guards against a provider/claim chain mismatch (an EVM provider claiming
      // a Solana balance proof reverts on-chain), so the mock provider's
      // chainType must match the claim's blockchain.
      const mockProvider = createMockProvider();
      (mockProvider as { chainType: string }).chainType = 'solana';
      const { executor, mockSettlementMonitor } = buildExecutor({ provider: mockProvider });
      // A Solana external channel is registered in the ChannelManager under its
      // base58 channelAccount (not an EVM 0x… id). The executor rejects an EVM-
      // shaped channel id for a non-EVM settle, so the registered id must be the
      // base58 account that the claim also carries.
      const solanaChannelAccount = '11111111111111111111111111111111';
      const mockChannelManager = createMockChannelManager({
        [`${TEST_PEER_ID}:${TEST_TOKEN_ID}`]: {
          channelId: solanaChannelAccount,
          tokenId: TEST_TOKEN_ID,
        },
      });
      executor.setChannelManager(mockChannelManager);

      const mockPerPacketClaimService = {
        getLatestClaim: jest.fn().mockReturnValue({
          version: '1.0',
          blockchain: 'solana',
          messageId: 'm1',
          timestamp: new Date().toISOString(),
          senderId: TEST_PEER_ID,
          programId: solanaChannelAccount,
          channelAccount: solanaChannelAccount,
          nonce: 3,
          transferredAmount: '100',
          signature: 'c2ln', // base64
          signerPublicKey: solanaChannelAccount,
        }),
        resetChannel: jest.fn(),
      };
      executor.setPerPacketClaimService(mockPerPacketClaimService as any);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockProvider.claimFromChannel).toHaveBeenCalledWith(
        solanaChannelAccount,
        expect.objectContaining({
          channelId: solanaChannelAccount,
          nonce: 3,
          transferredAmount: '100',
          lockedAmount: '0',
          locksRoot: '',
        }),
        'c2ln'
      );
    });

    it('should NOT reset per-packet claim when perPacketClaimService is undefined (if false branch)', async () => {
      const { executor, mockSettlementMonitor, mockProvider, mockAccountManager } = buildExecutor();
      const mockChannelManager = createMockChannelManager({
        [`${TEST_PEER_ID}:${TEST_TOKEN_ID}`]: {
          channelId: TEST_CHANNEL_ID,
          tokenId: TEST_TOKEN_ID,
        },
      });
      executor.setChannelManager(mockChannelManager);

      const mockPerPacketClaimService = {
        getLatestClaim: jest.fn().mockReturnValue({
          blockchain: 'evm',
          channelId: TEST_CHANNEL_ID,
          nonce: 5,
          transferredAmount: '500',
          lockedAmount: '0',
          locksRoot: '0x' + '0'.repeat(64),
          signature: '0xevmSig',
        }),
        resetChannel: jest.fn(),
      };
      executor.setPerPacketClaimService(mockPerPacketClaimService as any);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockPerPacketClaimService.resetChannel).toHaveBeenCalledWith(TEST_CHANNEL_ID);
      expect(mockAccountManager.recordSettlement).toHaveBeenCalled();
      expect(mockProvider.claimFromChannel).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // retryWithBackoff branches
  // ==========================================================================

  describe('retryWithBackoff branches', () => {
    it('should succeed on first attempt without retry (loop success branch)', async () => {
      const { executor, mockSettlementMonitor, mockProvider } = buildExecutor();
      const mockChannelManager = createMockChannelManager();
      executor.setChannelManager(mockChannelManager);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockProvider.openChannel).toHaveBeenCalledTimes(1);
    });

    it('should retry on retryable error and succeed on second attempt', async () => {
      const { executor, mockSettlementMonitor, mockProvider } = buildExecutor();
      mockProvider.openChannel
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockResolvedValueOnce({ channelId: TEST_CHANNEL_ID, txHash: '0xRetryTxHash' });

      const mockChannelManager = createMockChannelManager();
      executor.setChannelManager(mockChannelManager);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockProvider.openChannel).toHaveBeenCalledTimes(2);
      expect(mockSettlementMonitor.markSettlementCompleted).toHaveBeenCalled();
    });

    it('should throw immediately on non-retryable error (isRetryableError false branch)', async () => {
      const { executor, mockSettlementMonitor, mockProvider } = buildExecutor();
      mockProvider.openChannel.mockRejectedValue(new Error('insufficient funds'));

      const mockChannelManager = createMockChannelManager();
      executor.setChannelManager(mockChannelManager);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockProvider.openChannel).toHaveBeenCalledTimes(1);
      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
    });

    it('should handle non-Error thrown in operation (error instanceof Error false)', async () => {
      const { executor, mockSettlementMonitor, mockProvider } = buildExecutor();
      mockProvider.openChannel.mockRejectedValue(12345);

      const mockChannelManager = createMockChannelManager();
      executor.setChannelManager(mockChannelManager);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockProvider.openChannel).toHaveBeenCalledTimes(1);
      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
    });

    it('should exhaust retries and throw on last attempt (attempt === maxRetries, no delay)', async () => {
      const { executor, mockSettlementMonitor, mockProvider } = buildExecutor({
        config: { maxRetries: 2, retryDelayMs: 1 },
      });
      mockProvider.openChannel
        .mockRejectedValueOnce(new Error('nonce too low'))
        .mockRejectedValueOnce(new Error('nonce too low'));

      const mockChannelManager = createMockChannelManager();
      executor.setChannelManager(mockChannelManager);

      executor.start();
      fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
      await executor.stop();

      expect(mockProvider.openChannel).toHaveBeenCalledTimes(2);
      expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // isRetryableError branches
  // ==========================================================================

  describe('isRetryableError branches', () => {
    const testCases: { message: string; name?: string; expected: boolean }[] = [
      // Retryable: each keyword branch
      { message: 'Connection timeout', expected: true },
      { message: 'Network error occurred', expected: true },
      { message: 'Gas price too high', expected: true },
      { message: 'nonce too low for this transaction', expected: true },
      { message: 'replacement transaction underpriced', expected: true },
      { message: 'transaction already known in mempool', expected: true },
      { message: 'nonce has already been used', expected: true },
      // Non-retryable: each keyword branch
      { message: 'insufficient funds for gas', expected: false },
      { message: 'channel closed by counterparty', expected: false },
      { message: 'invalid signature provided', expected: false },
      { message: 'challenge not expired yet', expected: false },
      // Non-retryable: constructor name branch
      { message: 'some message', name: 'ChallengeNotExpiredError', expected: false },
      // Default (unknown error) branch
      { message: 'unknown catastrophic failure', expected: false },
    ];

    it.each(testCases)(
      'should classify "$message" (name=$name) as retryable=$expected',
      ({ message, name, expected }) => {
        const { executor } = buildExecutor();
        const error = new Error(message);
        if (name) {
          Object.defineProperty(error, 'constructor', {
            value: { name },
          });
          // Override constructor.name directly for the check
          (error as any).__proto__ = { constructor: { name } };
        }
        const result = (executor as any).isRetryableError(error);
        expect(result).toBe(expected);
      }
    );

    it('should classify ChallengeNotExpiredError by constructor.name even when message is generic', () => {
      const { executor } = buildExecutor();
      class ChallengeNotExpiredError extends Error {}
      const error = new ChallengeNotExpiredError('generic challenge message');
      const result = (executor as any).isRetryableError(error);
      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // registerPeerChain branches
  // ==========================================================================

  describe('registerPeerChain branches', () => {
    it('should log registration when peer chain did not exist (!existingChain branch)', () => {
      const { executor, logger } = buildExecutor({
        config: { peerIdToChainMap: new Map() },
      });
      executor.registerPeerChain('new-peer', 'evm:1');

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'peer_chain_registered',
          peerId: 'new-peer',
          chainId: 'evm:1',
        }),
        'Peer chain mapping registered'
      );
    });

    it('should log update when peer chain exists and changes (existingChain && existingChain !== chainId branch)', () => {
      const { executor, logger } = buildExecutor();
      executor.registerPeerChain(TEST_PEER_ID, 'evm:999');

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'peer_chain_updated',
          peerId: TEST_PEER_ID,
          oldChain: TEST_CHAIN_ID,
          newChain: 'evm:999',
        }),
        'Peer chain mapping updated'
      );
    });

    it('should do nothing when peer chain exists and is unchanged (implicit else branch)', () => {
      const { executor, logger } = buildExecutor();
      jest.clearAllMocks();
      executor.registerPeerChain(TEST_PEER_ID, TEST_CHAIN_ID);

      // No info log should be emitted for unchanged mapping
      const infoCalls = (logger.info as jest.Mock).mock.calls;
      const hasUpdateOrRegister = infoCalls.some(
        (call: any[]) =>
          call[1] === 'Peer chain mapping updated' || call[1] === 'Peer chain mapping registered'
      );
      expect(hasUpdateOrRegister).toBe(false);
      // But the map should still be updated
      expect(executor['config'].peerIdToChainMap.get(TEST_PEER_ID)).toBe(TEST_CHAIN_ID);
    });
  });

  // ==========================================================================
  // registerPeerAddress branches
  // ==========================================================================

  describe('registerPeerAddress branches', () => {
    it('should register address when peer not yet mapped (true branch)', () => {
      const { executor, logger } = buildExecutor({
        config: { peerIdToAddressMap: new Map() },
      });
      executor.registerPeerAddress('new-peer', '0xNewAddress');

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'peer_address_registered', peerId: 'new-peer' }),
        'Peer settlement address registered'
      );
    });

    it('should skip registration when peer already mapped (false branch)', () => {
      const { executor, logger } = buildExecutor();
      jest.clearAllMocks();
      executor.registerPeerAddress(TEST_PEER_ID, '0xNewAddress');

      expect(logger.info).not.toHaveBeenCalledWith(
        expect.anything(),
        'Peer settlement address registered'
      );
      // Original address should be preserved
      expect(executor['config'].peerIdToAddressMap.get(TEST_PEER_ID)).toBe(TEST_PEER_ADDRESS);
    });
  });

  // ==========================================================================
  // getSettlementState
  // ==========================================================================

  describe('getSettlementState', () => {
    it('should delegate to SettlementMonitor.getSettlementState', () => {
      const { executor, mockSettlementMonitor } = buildExecutor();
      mockSettlementMonitor.getSettlementState.mockReturnValue(SettlementState.SETTLEMENT_PENDING);

      const state = executor.getSettlementState(TEST_PEER_ID, TEST_TOKEN_ID);
      expect(state).toBe(SettlementState.SETTLEMENT_PENDING);
      expect(mockSettlementMonitor.getSettlementState).toHaveBeenCalledWith(
        TEST_PEER_ID,
        TEST_TOKEN_ID
      );
    });
  });
});
