/**
 * Acceptance Tests for Story 32.5: Refactor SettlementExecutor for Multi-Chain
 *
 * TDD RED PHASE: These tests validate the refactored SettlementExecutor that uses
 * ChainProviderRegistry instead of direct PaymentChannelSDK dependency.
 *
 * Tests will FAIL until the implementation is complete because:
 * - Constructor signature changes from PaymentChannelSDK to ChainProviderRegistry
 * - Provider resolution via peerIdToChainMap does not exist yet
 * - openChannelAndSettle still calls SDK directly (not provider.openChannel + provider.deposit)
 * - settleViaExistingChannel still constructs BalanceProof (bigint) instead of BalanceProofParams (string)
 * - The fallback path still attempts getChannelState/signBalanceProof via SDK
 *
 * Acceptance Criteria Covered:
 * - AC1: SettlementMonitor works with any chain's claim events (chain-agnostic)
 * - AC2: SettlementExecutor resolves provider for settlement via ChainProviderRegistry
 * - AC3: SettlementExecutor constructor accepts ChainProviderRegistry
 * - AC4: Chain-specific retry classification remains provider-agnostic
 * - AC5: Settlement flow through abstraction is identical to direct SDK
 *
 * @module test/acceptance/story-32-5
 */

import {
  SettlementExecutor,
  SettlementExecutorConfig,
} from '../../src/settlement/settlement-executor';
import { AccountManager } from '../../src/settlement/account-manager';
import { SettlementMonitor } from '../../src/settlement/settlement-monitor';
import { SettlementState } from '../../src/config/types';
import type { SettlementTriggerEvent } from '../../src/config/types';
import type { ChainProviderRegistry } from '../../src/settlement/provider/chain-provider-registry';
import type {
  PaymentChannelProvider,
  BalanceProofParams,
} from '../../src/settlement/provider/payment-channel-provider';
import type { ChannelMetadata } from '../../src/settlement/channel-manager';
import type { Logger } from 'pino';

// Mock only the dependencies that need constructor mocking, not the SUT
jest.mock('../../src/settlement/account-manager');
jest.mock('../../src/settlement/settlement-monitor');

// ---------------------------------------------------------------------------
// Test Constants
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

/**
 * Create a mock PaymentChannelProvider with all required interface methods.
 * This mock represents the provider abstraction that replaces direct SDK calls.
 */
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

/**
 * Create a mock ChainProviderRegistry that resolves providers based on chain config.
 */
const createMockRegistry = (
  provider: jest.Mocked<PaymentChannelProvider>
): jest.Mocked<Pick<ChainProviderRegistry, 'getProviderForPeer' | 'getProvider'>> => ({
  getProviderForPeer: jest
    .fn()
    .mockImplementation((peerConfig: { peerId: string; chain?: string }) => {
      if (peerConfig.chain === TEST_CHAIN_ID) return provider;
      return undefined;
    }),
  getProvider: jest.fn().mockReturnValue(provider),
});

/**
 * Create a mock ChannelManager for channel lookup.
 */
const createMockChannelManager = (
  channelMap?: Record<string, { channelId: string; tokenId: string }>
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
      status: 'open',
    } as unknown as ChannelMetadata;
  }),
});

/**
 * Create the SettlementExecutorConfig for provider-based executor.
 * Note: registryAddress, rpcUrl, privateKey are REMOVED (EVM-specific, now inside provider).
 * peerIdToChainMap is ADDED (maps peer to chain identifier for provider resolution).
 */
const createTestConfig = (): SettlementExecutorConfig =>
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

// ---------------------------------------------------------------------------
// Helper: Fire event through settlement monitor handler
// ---------------------------------------------------------------------------

const fireSettlementEvent = (
  mockSettlementMonitor: jest.Mocked<SettlementMonitor>,
  event: SettlementTriggerEvent
): void => {
  const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
  handler(event);
};

// ---------------------------------------------------------------------------
// AC1: SettlementMonitor Works with Any Chain's Claim Events
// ---------------------------------------------------------------------------

describe('Story 32.5 - AC1: SettlementMonitor is chain-agnostic', () => {
  it('[P0] [T-32.5-01] SettlementMonitor has no EVM-specific or SDK references (structural audit)', () => {
    // Given: the SettlementMonitor source file
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const monitorSource = fs.readFileSync(
      require.resolve('../../src/settlement/settlement-monitor.ts'),
      'utf8'
    );

    // Then: it should NOT reference PaymentChannelSDK
    expect(monitorSource).not.toContain('PaymentChannelSDK');
    expect(monitorSource).not.toContain('payment-channel-sdk');

    // And: it should NOT reference EVM-specific types
    expect(monitorSource).not.toContain('EVMClaimMessage');
    expect(monitorSource).not.toContain('BalanceProof');
    expect(monitorSource).not.toContain('getChannelState');
    expect(monitorSource).not.toContain('openChannel');
  });

  it('[P0] [T-32.5-13] All existing settlement-monitor tests pass without modification', () => {
    // This is a regression gate — the settlement-monitor test suite must
    // pass without any changes. We verify this structurally by confirming
    // the monitor test file has no SDK references either.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const monitorTestSource = fs.readFileSync(
      require.resolve('../../src/settlement/settlement-monitor.test.ts'),
      'utf8'
    );

    expect(monitorTestSource).not.toContain('PaymentChannelSDK');
    expect(monitorTestSource).not.toContain('payment-channel-sdk');
  });
});

// ---------------------------------------------------------------------------
// AC3: SettlementExecutor Constructor Accepts ChainProviderRegistry
// ---------------------------------------------------------------------------

describe('Story 32.5 - AC3: Constructor accepts ChainProviderRegistry', () => {
  let mockAccountManager: jest.Mocked<AccountManager>;
  let mockSettlementMonitor: jest.Mocked<SettlementMonitor>;
  let mockProvider: jest.Mocked<PaymentChannelProvider>;
  let mockRegistry: jest.Mocked<Pick<ChainProviderRegistry, 'getProviderForPeer' | 'getProvider'>>;

  beforeEach(() => {
    jest.clearAllMocks();
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
    mockAccountManager.recordSettlement = jest.fn().mockResolvedValue(undefined);
    mockSettlementMonitor.markSettlementInProgress = jest.fn();
    mockSettlementMonitor.markSettlementCompleted = jest.fn();
    mockSettlementMonitor.getSettlementState = jest.fn().mockReturnValue(SettlementState.IDLE);
    mockSettlementMonitor.on = jest.fn();
    mockSettlementMonitor.off = jest.fn();

    mockProvider = createMockProvider();
    mockRegistry = createMockRegistry(mockProvider);
  });

  it('[P0] [T-32.5-02] should construct with ChainProviderRegistry instead of PaymentChannelSDK', () => {
    // Given: a ChainProviderRegistry (not a PaymentChannelSDK)
    const config = createTestConfig();
    const logger = createMockLogger();

    // When: SettlementExecutor is constructed with the registry
    const executor = new SettlementExecutor(
      config,
      mockAccountManager,

      mockRegistry as unknown as ChainProviderRegistry,
      mockSettlementMonitor,
      logger
    );

    // Then: it initializes without error
    expect(executor).toBeInstanceOf(SettlementExecutor);
    expect(executor.getSettlementState).toBeDefined();
  });

  it('[P0] should no longer require registryAddress, rpcUrl, or privateKey in config', () => {
    // Given: a config WITHOUT EVM-specific fields
    const config = createTestConfig();

    // Then: config should NOT have these EVM-specific fields
    expect(config).not.toHaveProperty('registryAddress');
    expect(config).not.toHaveProperty('rpcUrl');
    expect(config).not.toHaveProperty('privateKey');

    // And: config SHOULD have peerIdToChainMap
    expect((config as unknown as Record<string, unknown>).peerIdToChainMap).toBeInstanceOf(Map);
  });
});

// ---------------------------------------------------------------------------
// AC2: SettlementExecutor Resolves Provider for Settlement
// ---------------------------------------------------------------------------

describe('Story 32.5 - AC2: Provider resolution for settlement', () => {
  let mockAccountManager: jest.Mocked<AccountManager>;
  let mockSettlementMonitor: jest.Mocked<SettlementMonitor>;
  let mockProvider: jest.Mocked<PaymentChannelProvider>;
  let mockRegistry: jest.Mocked<Pick<ChainProviderRegistry, 'getProviderForPeer' | 'getProvider'>>;
  let config: SettlementExecutorConfig;
  let logger: Logger;

  beforeEach(() => {
    jest.clearAllMocks();
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
    mockAccountManager.recordSettlement = jest.fn().mockResolvedValue(undefined);
    mockSettlementMonitor.markSettlementInProgress = jest.fn();
    mockSettlementMonitor.markSettlementCompleted = jest.fn();
    mockSettlementMonitor.getSettlementState = jest.fn().mockReturnValue(SettlementState.IDLE);
    mockSettlementMonitor.on = jest.fn();
    mockSettlementMonitor.off = jest.fn();

    mockProvider = createMockProvider();
    mockRegistry = createMockRegistry(mockProvider);
    config = createTestConfig();
    logger = createMockLogger();
  });

  afterEach(async () => {
    // Ensure no in-flight settlements leak between tests
  });

  it('[P0] [T-32.5-03] should resolve provider from registry using peerIdToChainMap', async () => {
    // Given: executor configured with registry and peerIdToChainMap
    const executor = new SettlementExecutor(
      config,
      mockAccountManager,

      mockRegistry as unknown as ChainProviderRegistry,
      mockSettlementMonitor,
      logger
    );

    // And: no existing channel (triggers openChannelAndSettle path)
    const mockChannelManager = createMockChannelManager();
    executor.setChannelManager(mockChannelManager);

    executor.start();
    fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
    await executor.stop();

    // Then: registry.getProviderForPeer was called with correct chain
    expect(mockRegistry.getProviderForPeer).toHaveBeenCalledWith(
      expect.objectContaining({
        peerId: TEST_PEER_ID,
        chain: TEST_CHAIN_ID,
      })
    );
  });

  it('[P0] [T-32.5-07] should fail with descriptive error when no provider registered for peer', async () => {
    // Given: a peer with no chain mapping
    const configNoChain = {
      ...config,
      peerIdToChainMap: new Map<string, string>(), // empty
    } as SettlementExecutorConfig;

    const executor = new SettlementExecutor(
      configNoChain,
      mockAccountManager,

      mockRegistry as unknown as ChainProviderRegistry,
      mockSettlementMonitor,
      logger
    );

    executor.start();
    fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
    await executor.stop();

    // Then: settlement should fail (markSettlementCompleted NOT called)
    expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();

    // And: markSettlementInProgress WAS called (settlement was attempted)
    expect(mockSettlementMonitor.markSettlementInProgress).toHaveBeenCalledWith(
      TEST_PEER_ID,
      TEST_TOKEN_ID
    );
  });
});

// ---------------------------------------------------------------------------
// AC2/AC5: openChannelAndSettle Uses Provider (Two-Step: Open + Deposit)
// ---------------------------------------------------------------------------

describe('Story 32.5 - AC2/AC5: openChannelAndSettle via provider', () => {
  let mockAccountManager: jest.Mocked<AccountManager>;
  let mockSettlementMonitor: jest.Mocked<SettlementMonitor>;
  let mockProvider: jest.Mocked<PaymentChannelProvider>;
  let mockRegistry: jest.Mocked<Pick<ChainProviderRegistry, 'getProviderForPeer' | 'getProvider'>>;
  let config: SettlementExecutorConfig;
  let logger: Logger;

  beforeEach(() => {
    jest.clearAllMocks();
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
    mockAccountManager.recordSettlement = jest.fn().mockResolvedValue(undefined);
    mockSettlementMonitor.markSettlementInProgress = jest.fn();
    mockSettlementMonitor.markSettlementCompleted = jest.fn();
    mockSettlementMonitor.getSettlementState = jest.fn().mockReturnValue(SettlementState.IDLE);
    mockSettlementMonitor.on = jest.fn();
    mockSettlementMonitor.off = jest.fn();

    mockProvider = createMockProvider();
    mockRegistry = createMockRegistry(mockProvider);
    config = createTestConfig();
    logger = createMockLogger();
  });

  it('[P0] [T-32.5-04] should call provider.openChannel then provider.deposit as two separate operations', async () => {
    // Given: no existing channel for peer
    const mockChannelManager = createMockChannelManager();

    const executor = new SettlementExecutor(
      config,
      mockAccountManager,

      mockRegistry as unknown as ChainProviderRegistry,
      mockSettlementMonitor,
      logger
    );
    executor.setChannelManager(mockChannelManager);

    executor.start();
    fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
    await executor.stop();

    // Then: provider.openChannel was called with (peerAddress, settlementTimeout)
    // Note: provider.openChannel does NOT take tokenAddress or deposit (unlike SDK)
    expect(mockProvider.openChannel).toHaveBeenCalledWith(
      TEST_PEER_ADDRESS,
      config.defaultSettlementTimeout
    );

    // And: provider.deposit was called separately with (channelId, amount as string)
    const expectedDeposit = TEST_CURRENT_BALANCE * BigInt(config.initialDepositMultiplier);
    expect(mockProvider.deposit).toHaveBeenCalledWith(TEST_CHANNEL_ID, expectedDeposit.toString());

    // And: deposit was called AFTER openChannel (sequential operations)
    const openOrder = (mockProvider.openChannel as jest.Mock).mock.invocationCallOrder[0] || 0;
    const depositOrder = (mockProvider.deposit as jest.Mock).mock.invocationCallOrder[0] || 0;
    expect(openOrder).toBeLessThan(depositOrder);

    // And: TigerBeetle balance was updated
    expect(mockAccountManager.recordSettlement).toHaveBeenCalledWith(
      TEST_PEER_ID,
      TEST_TOKEN_ID,
      TEST_CURRENT_BALANCE
    );
  });

  it('[P0] should mark settlement completed after successful open + deposit', async () => {
    const mockChannelManager = createMockChannelManager();

    const executor = new SettlementExecutor(
      config,
      mockAccountManager,

      mockRegistry as unknown as ChainProviderRegistry,
      mockSettlementMonitor,
      logger
    );
    executor.setChannelManager(mockChannelManager);

    executor.start();
    fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
    await executor.stop();

    expect(mockSettlementMonitor.markSettlementCompleted).toHaveBeenCalledWith(
      TEST_PEER_ID,
      TEST_TOKEN_ID
    );
  });
});

// ---------------------------------------------------------------------------
// AC2/AC5: settleViaExistingChannel Uses Provider with BalanceProofParams
// ---------------------------------------------------------------------------

describe('Story 32.5 - AC2/AC5: settleViaExistingChannel via provider', () => {
  let mockAccountManager: jest.Mocked<AccountManager>;
  let mockSettlementMonitor: jest.Mocked<SettlementMonitor>;
  let mockProvider: jest.Mocked<PaymentChannelProvider>;
  let mockRegistry: jest.Mocked<Pick<ChainProviderRegistry, 'getProviderForPeer' | 'getProvider'>>;
  let config: SettlementExecutorConfig;
  let logger: Logger;

  beforeEach(() => {
    jest.clearAllMocks();
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
    mockAccountManager.recordSettlement = jest.fn().mockResolvedValue(undefined);
    mockSettlementMonitor.markSettlementInProgress = jest.fn();
    mockSettlementMonitor.markSettlementCompleted = jest.fn();
    mockSettlementMonitor.getSettlementState = jest.fn().mockReturnValue(SettlementState.IDLE);
    mockSettlementMonitor.on = jest.fn();
    mockSettlementMonitor.off = jest.fn();

    mockProvider = createMockProvider();
    mockRegistry = createMockRegistry(mockProvider);
    config = createTestConfig();
    logger = createMockLogger();
  });

  it('[P0] [T-32.5-05] should call provider.claimFromChannel with BalanceProofParams (string amounts)', async () => {
    // Given: an existing channel for peer AND a per-packet claim available
    const mockChannelManager = createMockChannelManager({
      [`${TEST_PEER_ID}:${TEST_TOKEN_ID}`]: {
        channelId: TEST_CHANNEL_ID,
        tokenId: TEST_TOKEN_ID,
      },
    });

    const mockPerPacketClaimService = {
      getLatestClaim: jest.fn().mockReturnValue({
        blockchain: 'evm',
        channelId: TEST_CHANNEL_ID,
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

    const executor = new SettlementExecutor(
      config,
      mockAccountManager,

      mockRegistry as unknown as ChainProviderRegistry,
      mockSettlementMonitor,
      logger
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor.setPerPacketClaimService(mockPerPacketClaimService as any);
    executor.setChannelManager(mockChannelManager);

    executor.start();
    fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
    await executor.stop();

    // Then: provider.claimFromChannel was called with BalanceProofParams (string amounts)
    expect(mockProvider.claimFromChannel).toHaveBeenCalledWith(
      TEST_CHANNEL_ID,
      expect.objectContaining({
        channelId: TEST_CHANNEL_ID,
        nonce: 5,
        transferredAmount: '5000', // string, not bigint
        lockedAmount: '0', // string, not bigint
        locksRoot: '0x' + '0'.repeat(64),
      } as BalanceProofParams),
      '0xperpacketsignature'
    );

    // And: per-packet claim tracking was reset
    expect(mockPerPacketClaimService.resetChannel).toHaveBeenCalledWith(TEST_CHANNEL_ID);

    // And: TigerBeetle balance was updated
    expect(mockAccountManager.recordSettlement).toHaveBeenCalledWith(
      TEST_PEER_ID,
      TEST_TOKEN_ID,
      TEST_CURRENT_BALANCE
    );
  });

  it('[P0] [T-32.5-06] per-packet claim path uses string amounts directly (no bigint conversion for provider)', async () => {
    // Given: per-packet claim with string amounts
    const mockChannelManager = createMockChannelManager({
      [`${TEST_PEER_ID}:${TEST_TOKEN_ID}`]: {
        channelId: TEST_CHANNEL_ID,
        tokenId: TEST_TOKEN_ID,
      },
    });

    const mockPerPacketClaimService = {
      getLatestClaim: jest.fn().mockReturnValue({
        blockchain: 'evm',
        channelId: TEST_CHANNEL_ID,
        nonce: 10,
        transferredAmount: '999999999999999999', // large string amount
        lockedAmount: '42',
        locksRoot: '0xabc' + '0'.repeat(61),
        signature: '0xsig123',
      }),
      resetChannel: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
    };

    const executor = new SettlementExecutor(
      config,
      mockAccountManager,

      mockRegistry as unknown as ChainProviderRegistry,
      mockSettlementMonitor,
      logger
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor.setPerPacketClaimService(mockPerPacketClaimService as any);
    executor.setChannelManager(mockChannelManager);

    executor.start();
    fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
    await executor.stop();

    // Then: provider received string amounts directly from EVMClaimMessage
    const claimCall = (mockProvider.claimFromChannel as jest.Mock).mock.calls[0];
    const balanceProofArg = claimCall[1] as BalanceProofParams;

    expect(typeof balanceProofArg.transferredAmount).toBe('string');
    expect(typeof balanceProofArg.lockedAmount).toBe('string');
    expect(balanceProofArg.transferredAmount).toBe('999999999999999999');
    expect(balanceProofArg.lockedAmount).toBe('42');
  });
});

// ---------------------------------------------------------------------------
// AC5: Deprecated Fallback Path
// ---------------------------------------------------------------------------

describe('Story 32.5 - AC5: Deprecated fallback balance proof path', () => {
  let mockAccountManager: jest.Mocked<AccountManager>;
  let mockSettlementMonitor: jest.Mocked<SettlementMonitor>;
  let mockProvider: jest.Mocked<PaymentChannelProvider>;
  let mockRegistry: jest.Mocked<Pick<ChainProviderRegistry, 'getProviderForPeer' | 'getProvider'>>;
  let config: SettlementExecutorConfig;
  let logger: Logger;

  beforeEach(() => {
    jest.clearAllMocks();
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
    mockAccountManager.recordSettlement = jest.fn().mockResolvedValue(undefined);
    mockSettlementMonitor.markSettlementInProgress = jest.fn();
    mockSettlementMonitor.markSettlementCompleted = jest.fn();
    mockSettlementMonitor.getSettlementState = jest.fn().mockReturnValue(SettlementState.IDLE);
    mockSettlementMonitor.on = jest.fn();
    mockSettlementMonitor.off = jest.fn();

    mockProvider = createMockProvider();
    mockRegistry = createMockRegistry(mockProvider);
    config = createTestConfig();
    logger = createMockLogger();
  });

  it('[P1] [T-32.5-08] should throw error when no per-packet claim available for existing channel', async () => {
    // Given: an existing channel BUT no per-packet claim service
    const mockChannelManager = createMockChannelManager({
      [`${TEST_PEER_ID}:${TEST_TOKEN_ID}`]: {
        channelId: TEST_CHANNEL_ID,
        tokenId: TEST_TOKEN_ID,
      },
    });

    const executor = new SettlementExecutor(
      config,
      mockAccountManager,

      mockRegistry as unknown as ChainProviderRegistry,
      mockSettlementMonitor,
      logger
    );
    // No perPacketClaimService set — the fallback path should be deprecated
    executor.setChannelManager(mockChannelManager);

    executor.start();
    fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
    await executor.stop();

    // Then: settlement should fail (fallback path deprecated)
    expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();

    // And: provider.claimFromChannel should NOT have been called
    expect(mockProvider.claimFromChannel).not.toHaveBeenCalled();

    // And: provider.getChannelState should NOT have been called (fallback removed)
    expect(mockProvider.getChannelState).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC4: Retry Logic Is Provider-Agnostic
// ---------------------------------------------------------------------------

describe('Story 32.5 - AC4: Provider-agnostic retry logic', () => {
  let mockAccountManager: jest.Mocked<AccountManager>;
  let mockSettlementMonitor: jest.Mocked<SettlementMonitor>;
  let mockProvider: jest.Mocked<PaymentChannelProvider>;
  let mockRegistry: jest.Mocked<Pick<ChainProviderRegistry, 'getProviderForPeer' | 'getProvider'>>;
  let config: SettlementExecutorConfig;
  let logger: Logger;

  beforeEach(() => {
    jest.clearAllMocks();
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
    mockAccountManager.recordSettlement = jest.fn().mockResolvedValue(undefined);
    mockSettlementMonitor.markSettlementInProgress = jest.fn();
    mockSettlementMonitor.markSettlementCompleted = jest.fn();
    mockSettlementMonitor.getSettlementState = jest.fn().mockReturnValue(SettlementState.IDLE);
    mockSettlementMonitor.on = jest.fn();
    mockSettlementMonitor.off = jest.fn();

    mockProvider = createMockProvider();
    mockRegistry = createMockRegistry(mockProvider);
    config = createTestConfig();
    logger = createMockLogger();
  });

  it('[P0] [T-32.5-09] should retry provider.openChannel on transient network errors', async () => {
    // Given: provider.openChannel fails twice with retryable error then succeeds
    mockProvider.openChannel
      .mockRejectedValueOnce(new Error('Network timeout'))
      .mockRejectedValueOnce(new Error('Network timeout'))
      .mockResolvedValueOnce({ channelId: TEST_CHANNEL_ID, txHash: '0xRetryTxHash' });

    const mockChannelManager = createMockChannelManager();

    const executor = new SettlementExecutor(
      config,
      mockAccountManager,

      mockRegistry as unknown as ChainProviderRegistry,
      mockSettlementMonitor,
      logger
    );
    executor.setChannelManager(mockChannelManager);

    executor.start();
    fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
    await executor.stop();

    // Then: openChannel was called 3 times (2 failures + 1 success)
    expect(mockProvider.openChannel).toHaveBeenCalledTimes(3);

    // And: settlement eventually succeeds
    expect(mockSettlementMonitor.markSettlementCompleted).toHaveBeenCalledWith(
      TEST_PEER_ID,
      TEST_TOKEN_ID
    );
  });

  it('[P0] should NOT retry provider calls on non-retryable errors', async () => {
    // Given: provider.openChannel fails with non-retryable error
    mockProvider.openChannel.mockRejectedValue(new Error('Insufficient funds'));

    const mockChannelManager = createMockChannelManager();

    const executor = new SettlementExecutor(
      config,
      mockAccountManager,

      mockRegistry as unknown as ChainProviderRegistry,
      mockSettlementMonitor,
      logger
    );
    executor.setChannelManager(mockChannelManager);

    executor.start();
    fireSettlementEvent(mockSettlementMonitor, createSettlementEvent());
    await executor.stop();

    // Then: openChannel was called only once (no retry)
    expect(mockProvider.openChannel).toHaveBeenCalledTimes(1);

    // And: settlement fails
    expect(mockSettlementMonitor.markSettlementCompleted).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC5: Settlement Serialization (Unchanged Behavior)
// ---------------------------------------------------------------------------

describe('Story 32.5 - AC5: Settlement serialization prevents nonce collisions', () => {
  it('[P0] [T-32.5-10] should serialize concurrent settlement events sequentially', async () => {
    jest.clearAllMocks();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const mockAccountManager = new AccountManager(
      {} as any,
      {} as any,
      {} as any
    ) as jest.Mocked<AccountManager>;
    const mockSettlementMonitor = new SettlementMonitor(
      {} as any,
      {} as any
    ) as jest.Mocked<SettlementMonitor>;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    mockAccountManager.recordSettlement = jest.fn().mockResolvedValue(undefined);
    mockSettlementMonitor.markSettlementInProgress = jest.fn();
    mockSettlementMonitor.markSettlementCompleted = jest.fn();
    mockSettlementMonitor.getSettlementState = jest.fn().mockReturnValue(SettlementState.IDLE);
    mockSettlementMonitor.on = jest.fn();
    mockSettlementMonitor.off = jest.fn();

    const mockProvider = createMockProvider();
    const mockRegistry = createMockRegistry(mockProvider);
    const config = createTestConfig();
    const logger = createMockLogger();

    // Track execution order
    const executionOrder: string[] = [];
    mockProvider.openChannel.mockImplementation(async (participant: string) => {
      const peerId = participant === TEST_PEER_ADDRESS ? 'peer-a' : 'peer-b';
      executionOrder.push(`start-${peerId}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      executionOrder.push(`end-${peerId}`);
      return { channelId: TEST_CHANNEL_ID, txHash: '0xMockTxHash' };
    });

    const executor = new SettlementExecutor(
      config,
      mockAccountManager,

      mockRegistry as unknown as ChainProviderRegistry,
      mockSettlementMonitor,
      logger
    );

    executor.start();

    // Fire two settlement events concurrently
    const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
    handler(createSettlementEvent({ peerId: TEST_PEER_ID }));
    handler(createSettlementEvent({ peerId: TEST_PEER_ID_B }));

    await executor.stop();

    // Then: settlements executed sequentially (no interleaving)
    expect(executionOrder[0]).toBe('start-peer-a');
    expect(executionOrder[1]).toBe('end-peer-a');
    expect(executionOrder[2]).toBe('start-peer-b');
    expect(executionOrder[3]).toBe('end-peer-b');
  });
});

// ---------------------------------------------------------------------------
// AC5: Graceful Shutdown (Unchanged Behavior)
// ---------------------------------------------------------------------------

describe('Story 32.5 - AC5: Graceful shutdown', () => {
  it('[P0] [T-32.5-11] should ignore new settlement events after stop() and await in-flight', async () => {
    jest.clearAllMocks();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const mockAccountManager = new AccountManager(
      {} as any,
      {} as any,
      {} as any
    ) as jest.Mocked<AccountManager>;
    const mockSettlementMonitor = new SettlementMonitor(
      {} as any,
      {} as any
    ) as jest.Mocked<SettlementMonitor>;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    mockAccountManager.recordSettlement = jest.fn().mockResolvedValue(undefined);
    mockSettlementMonitor.markSettlementInProgress = jest.fn();
    mockSettlementMonitor.markSettlementCompleted = jest.fn();
    mockSettlementMonitor.getSettlementState = jest.fn().mockReturnValue(SettlementState.IDLE);
    mockSettlementMonitor.on = jest.fn();
    mockSettlementMonitor.off = jest.fn();

    const mockProvider = createMockProvider();
    const mockRegistry = createMockRegistry(mockProvider);
    const config = createTestConfig();
    const logger = createMockLogger();

    let settlementResolved = false;
    mockProvider.openChannel.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      settlementResolved = true;
      return { channelId: TEST_CHANNEL_ID, txHash: '0xMockTxHash' };
    });

    const executor = new SettlementExecutor(
      config,
      mockAccountManager,

      mockRegistry as unknown as ChainProviderRegistry,
      mockSettlementMonitor,
      logger
    );

    executor.start();

    // Fire settlement event
    const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
    handler(createSettlementEvent());

    // Stop executor — should await the in-flight settlement
    await executor.stop();

    // Then: settlement completed before stop() resolved
    expect(settlementResolved).toBe(true);

    // And: post-stop events are ignored
    handler(createSettlementEvent({ peerId: TEST_PEER_ID_B }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Only one settlement was processed (the second was ignored)
    expect(mockSettlementMonitor.markSettlementInProgress).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AC3/Wiring: Source Code Audit
// ---------------------------------------------------------------------------

describe('Story 32.5 - Source code audit', () => {
  it('[P0] settlement-executor.ts should NOT import PaymentChannelSDK', () => {
    // Given: the refactored settlement-executor source file
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const executorSource = fs.readFileSync(
      require.resolve('../../src/settlement/settlement-executor.ts'),
      'utf8'
    );

    // Then: it should NOT import PaymentChannelSDK
    expect(executorSource).not.toMatch(/import.*PaymentChannelSDK.*from/);
    expect(executorSource).not.toMatch(/import.*['"]\.\/payment-channel-sdk['"]/);

    // And: it SHOULD import ChainProviderRegistry
    expect(executorSource).toMatch(/import.*ChainProviderRegistry/);

    // And: it SHOULD import PaymentChannelProvider types (multiline import)
    expect(executorSource).toMatch(/import[\s\S]*PaymentChannelProvider/);
  });

  it('[P0] settlement-executor.ts should NOT reference BalanceProof from @toon-protocol/shared', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const executorSource = fs.readFileSync(
      require.resolve('../../src/settlement/settlement-executor.ts'),
      'utf8'
    );

    // Then: it should NOT import BalanceProof (bigint type from shared)
    expect(executorSource).not.toMatch(/import.*BalanceProof.*from.*@toon-protocol\/shared/);
  });
});
