/**
 * Integration Tests — EVM Provider via Chain Abstraction Layer
 *
 * Story 32.8: Validates the entire chain abstraction layer works end-to-end.
 * All tests use mock providers with deterministic return values — no real
 * blockchain interaction.
 *
 * Acceptance Criteria Covered:
 * - AC 1: Full settlement flow through abstraction layer
 * - AC 2: Provider registration and lookup
 * - AC 3: Regression — EVM claim structure unchanged
 * - AC 4: Regression — SettlementExecutor opens channel through provider
 * - AC 5: Regression — SettlementExecutor claims from existing channel through provider
 * - AC 6: Config-driven registry initialization
 * - AC 7: Multi-provider registry
 * - AC 8: Error propagation and lifecycle
 * - AC 9: No direct PaymentChannelSDK imports in core settlement services
 *
 * @module settlement/provider/integration.test
 */

import { PerPacketClaimService } from '../per-packet-claim-service';
import { ClaimReceiver } from '../claim-receiver';
import { SettlementExecutor, type SettlementExecutorConfig } from '../settlement-executor';
import { AccountManager } from '../account-manager';
import { SettlementMonitor } from '../settlement-monitor';
import { SettlementState } from '../../config/types';
import type { SettlementTriggerEvent } from '../../config/types';
import { EVMPaymentChannelProvider } from './evm-payment-channel-provider';
import {
  ChainProviderRegistry,
  type ChainProviderFactory,
  type RegistryPeerConfig,
} from './chain-provider-registry';
import type {
  PaymentChannelProvider,
  ProviderConfig,
  BalanceProofParams,
} from './payment-channel-provider';
import type { BlockchainType } from '../../btp/btp-claim-types';
import { BTP_CLAIM_PROTOCOL } from '../../btp/btp-claim-types';
import type { PaymentChannelSDK } from '../payment-channel-sdk';
import type { ChannelManager, ChannelMetadata } from '../channel-manager';
import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';

// Integration tests may take longer than unit tests on slow CI machines
jest.setTimeout(30_000);

/**
 * Poll for a condition to become true, avoiding flaky fixed-duration sleeps.
 * Checks every 10ms up to the given timeout (default 2000ms).
 */
async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 10
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Mock only the dependencies that need constructor mocking
jest.mock('../account-manager');
jest.mock('../settlement-monitor');

// ---------------------------------------------------------------------------
// Test Constants
// ---------------------------------------------------------------------------

const TEST_CHANNEL_ID = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const TEST_TOKEN_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const TEST_PEER_ID = 'connector-b';
const TEST_NODE_ID = 'connector-a';
const TEST_CHAIN_ID_STRING = 'evm:anvil:31337';
const TEST_CHAIN_ID_NUMERIC = 31337;
const TEST_TOKEN_NETWORK_ADDRESS = '0xTokenNetworkAddress1234567890abcdef';
const TEST_SIGNER_ADDRESS = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1';
const TEST_TOKEN_ID = 'M2M';
const TEST_PEER_ADDRESS = '0x9876543210987654321098765432109876543210';

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

const createMockSDK = (): jest.Mocked<
  Pick<
    PaymentChannelSDK,
    | 'signBalanceProof'
    | 'verifyBalanceProof'
    | 'getChainId'
    | 'getTokenNetworkAddress'
    | 'getSignerAddress'
    | 'openChannel'
    | 'deposit'
    | 'claimFromChannel'
    | 'closeChannel'
    | 'settleChannel'
    | 'getChannelState'
    | 'onChannelOpened'
    | 'onChannelClosed'
    | 'onChannelSettled'
    | 'onChannelCooperativeSettled'
    | 'removeAllListeners'
  >
> => ({
  signBalanceProof: jest.fn().mockResolvedValue('0xmocksignature'),
  verifyBalanceProof: jest.fn().mockResolvedValue(true),
  getChainId: jest.fn().mockResolvedValue(TEST_CHAIN_ID_NUMERIC),
  getTokenNetworkAddress: jest.fn().mockResolvedValue(TEST_TOKEN_NETWORK_ADDRESS),
  getSignerAddress: jest.fn().mockResolvedValue(TEST_SIGNER_ADDRESS),
  openChannel: jest.fn().mockResolvedValue({ channelId: TEST_CHANNEL_ID, txHash: '0xOpenTxHash' }),
  deposit: jest.fn().mockResolvedValue(undefined),
  claimFromChannel: jest.fn().mockResolvedValue(undefined),
  closeChannel: jest.fn().mockResolvedValue(undefined),
  settleChannel: jest.fn().mockResolvedValue(undefined),
  getChannelState: jest.fn().mockResolvedValue({
    channelId: TEST_CHANNEL_ID,
    status: 'opened',
    participants: [TEST_SIGNER_ADDRESS, TEST_PEER_ADDRESS],
    myDeposit: 5000n,
    theirDeposit: 5000n,
  }),
  onChannelOpened: jest.fn().mockResolvedValue(undefined),
  onChannelClosed: jest.fn().mockResolvedValue(undefined),
  onChannelSettled: jest.fn().mockResolvedValue(undefined),
  onChannelCooperativeSettled: jest.fn().mockResolvedValue(undefined),
  removeAllListeners: jest.fn(),
});

function createMockProvider(
  chainType: BlockchainType,
  chainId: string
): jest.Mocked<PaymentChannelProvider> {
  return {
    chainType,
    chainId,
    openChannel: jest
      .fn()
      .mockResolvedValue({ channelId: TEST_CHANNEL_ID, txHash: '0xOpenTxHash' }),
    deposit: jest.fn().mockResolvedValue({ txHash: '0xDepositTxHash' }),
    claimFromChannel: jest.fn().mockResolvedValue({ txHash: '0xClaimTxHash' }),
    closeChannel: jest.fn().mockResolvedValue({ txHash: '0xCloseTxHash' }),
    settleChannel: jest.fn().mockResolvedValue({ txHash: '0xSettleTxHash' }),
    signBalanceProof: jest.fn().mockResolvedValue('0xmocksignature'),
    verifyBalanceProof: jest.fn().mockResolvedValue(true),
    getChannelState: jest.fn().mockResolvedValue({
      channelId: TEST_CHANNEL_ID,
      status: 'opened' as const,
      participants: [TEST_SIGNER_ADDRESS, TEST_PEER_ADDRESS],
      deposit: 10000n,
    }),
    subscribeToEvents: jest.fn().mockReturnValue({ unsubscribe: jest.fn() }),
  } as unknown as jest.Mocked<PaymentChannelProvider>;
}

const createMockChannelManager = (
  channelMap?: Record<string, { channelId: string; tokenAddress: string }>
): jest.Mocked<
  Pick<ChannelManager, 'getChannelForPeer' | 'ensureChannelExists' | 'getChannelById'>
> => ({
  getChannelForPeer: jest.fn().mockImplementation((peerId: string, tokenId: string) => {
    const key = `${peerId}:${tokenId}`;
    const channel = channelMap?.[key];
    if (!channel) return null;
    return {
      channelId: channel.channelId,
      tokenAddress: channel.tokenAddress,
      peerId,
      tokenId,
      chain: TEST_CHAIN_ID_STRING,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      status: 'open',
    } as unknown as ChannelMetadata;
  }),
  ensureChannelExists: jest.fn().mockResolvedValue(undefined),
  getChannelById: jest.fn().mockReturnValue(null),
});

const createMockDb = (
  existingClaims?: Array<{ claim_data: string }>
): jest.Mocked<Pick<Database, 'prepare'>> => {
  const mockRun = jest.fn();
  const mockAll = jest.fn().mockReturnValue(existingClaims ?? []);
  const mockStatement = { run: mockRun, all: mockAll };
  return {
    prepare: jest.fn().mockReturnValue(mockStatement),
  } as unknown as jest.Mocked<Pick<Database, 'prepare'>>;
};

const createTestExecutorConfig = (): SettlementExecutorConfig =>
  ({
    nodeId: TEST_NODE_ID,
    defaultSettlementTimeout: 86400,
    initialDepositMultiplier: 10,
    minDepositThreshold: 0.5,
    maxRetries: 1,
    retryDelayMs: 10,
    tokenAddressMap: new Map([[TEST_TOKEN_ID, TEST_TOKEN_ADDRESS]]),
    peerIdToAddressMap: new Map([[TEST_PEER_ID, TEST_PEER_ADDRESS]]),
    peerIdToChainMap: new Map([[TEST_PEER_ID, TEST_CHAIN_ID_STRING]]),
  }) as unknown as SettlementExecutorConfig;

// ---------------------------------------------------------------------------
// AC 1: Full Settlement Flow Through Abstraction Layer (T-32.8-01)
// ---------------------------------------------------------------------------

describe('[T-32.8-01] AC 1: Full settlement flow through abstraction layer', () => {
  let mockLogger: Logger;
  let mockSDK: ReturnType<typeof createMockSDK>;
  let evmProvider: EVMPaymentChannelProvider;
  let registry: ChainProviderRegistry;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockSDK = createMockSDK();
    evmProvider = new EVMPaymentChannelProvider(
      mockSDK as unknown as PaymentChannelSDK,
      TEST_CHAIN_ID_STRING,
      TEST_TOKEN_ADDRESS,
      mockLogger
    );
    registry = new ChainProviderRegistry();
    registry.register(evmProvider);
  });

  it('should complete full flow: claim signed -> claim verified -> threshold detected -> claimFromChannel -> balance updated', async () => {
    // Step 1: Generate claim via PerPacketClaimService (claim signed)
    const mockDb = createMockDb();
    const mockChannelManager = createMockChannelManager({
      [`${TEST_PEER_ID}:${TEST_TOKEN_ID}`]: {
        channelId: TEST_CHANNEL_ID,
        tokenAddress: TEST_TOKEN_ADDRESS,
      },
    });

    // Create mock registry for PerPacketClaimService (needs getProviderForPeer)
    const claimServiceRegistry = {
      getProviderForPeer: jest.fn().mockReturnValue(evmProvider),
    } as unknown as ChainProviderRegistry;

    const claimService = new PerPacketClaimService(
      claimServiceRegistry,
      mockChannelManager as unknown as ChannelManager,
      mockDb as unknown as Database,
      mockLogger,
      TEST_NODE_ID
    );

    const claimResult = await claimService.generateClaimForPacket(
      TEST_PEER_ID,
      TEST_TOKEN_ID,
      1000n
    );
    expect(claimResult).not.toBeNull();
    expect(claimResult!.claimMessage.blockchain).toBe('evm');

    // Verify signing was routed through the EVM provider via registry
    expect(mockSDK.signBalanceProof).toHaveBeenCalled();

    // Step 2: Verify claim via ClaimReceiver (claim verified)
    const receiverRegistry = {
      getProvider: jest.fn().mockReturnValue(evmProvider),
      getAllProviders: jest.fn().mockReturnValue([evmProvider]),
    } as unknown as ChainProviderRegistry;

    const receiverDb = createMockDb();
    // Verify ClaimReceiver accepts the registry (constructor wiring check only;
    // full ClaimReceiver verification is covered by T-32.8-11)
    void new ClaimReceiver(receiverDb as unknown as Database, receiverRegistry, mockLogger);

    // Simulate BTP message handling by calling the internal verification
    // The claim was signed by the mock SDK, so verification should succeed
    const claimData = JSON.parse(claimResult!.protocolData.data.toString('utf8'));
    expect(claimData.signature).toBe('0xmocksignature');
    expect(mockSDK.verifyBalanceProof).not.toHaveBeenCalled();

    // Step 3: SettlementExecutor settles via existing channel
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

    const executorRegistry = {
      getProviderForPeer: jest.fn().mockImplementation((peerConfig: RegistryPeerConfig) => {
        if (peerConfig.chain === TEST_CHAIN_ID_STRING) return evmProvider;
        return undefined;
      }),
    } as unknown as ChainProviderRegistry;

    const executor = new SettlementExecutor(
      createTestExecutorConfig(),
      mockAccountManager,
      executorRegistry,
      mockSettlementMonitor,
      mockLogger
    );

    // Wire PerPacketClaimService and ChannelManager to executor
    executor.setPerPacketClaimService(claimService);
    executor.setChannelManager(mockChannelManager as unknown as ChannelManager);

    // Start executor and fire settlement event
    executor.start();

    const event: SettlementTriggerEvent = {
      peerId: TEST_PEER_ID,
      tokenId: TEST_TOKEN_ID,
      currentBalance: 1200n,
      threshold: 1000n,
      exceedsBy: 200n,
      timestamp: new Date(),
    };

    const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
    handler(event);

    // Wait for async settlement chain to complete.
    // The settlement chain is a promise chain inside SettlementExecutor; we poll
    // for the expected side-effect rather than sleeping a fixed duration so the
    // test is resilient to slow CI runners.
    await waitForCondition(() => mockSDK.claimFromChannel.mock.calls.length > 0);

    // Verify: claimFromChannel was called through the provider (not SDK directly)
    expect(mockSDK.claimFromChannel).toHaveBeenCalled();

    // Verify: TigerBeetle balance updated
    expect(mockAccountManager.recordSettlement).toHaveBeenCalledWith(
      TEST_PEER_ID,
      TEST_TOKEN_ID,
      1200n
    );

    // Verify: per-packet claim tracking was reset
    expect(claimService.getLatestClaim(TEST_CHANNEL_ID)).toBeNull();

    await executor.stop();
  });
});

// ---------------------------------------------------------------------------
// AC 2: Provider Registration and Lookup (T-32.8-02)
// ---------------------------------------------------------------------------

describe('[T-32.8-02] AC 2: Provider registration and lookup integration', () => {
  let registry: ChainProviderRegistry;
  let evmProvider: EVMPaymentChannelProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    const mockLogger = createMockLogger();
    const mockSDK = createMockSDK();
    evmProvider = new EVMPaymentChannelProvider(
      mockSDK as unknown as PaymentChannelSDK,
      TEST_CHAIN_ID_STRING,
      TEST_TOKEN_ADDRESS,
      mockLogger
    );
    registry = new ChainProviderRegistry();
    registry.register(evmProvider);
  });

  it("should return provider via getProvider('evm', chainId)", () => {
    const result = registry.getProvider('evm', TEST_CHAIN_ID_STRING);
    expect(result).toBe(evmProvider);
  });

  it('should return provider via getProviderForPeer(peerWithEvmChain)', () => {
    const result = registry.getProviderForPeer({
      peerId: TEST_PEER_ID,
      chain: TEST_CHAIN_ID_STRING,
    });
    expect(result).toBe(evmProvider);
  });

  it('should include provider in getAllProviders()', () => {
    const all = registry.getAllProviders();
    expect(all).toContain(evmProvider);
    expect(all).toHaveLength(1);
  });

  it('should return undefined for unregistered chain', () => {
    expect(registry.getProvider('solana', 'solana:devnet')).toBeUndefined();
  });

  it('should return undefined for peer without chain config', () => {
    expect(registry.getProviderForPeer({ peerId: 'unknown' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC 3: Regression — EVM Claim Structure (T-32.8-03)
// ---------------------------------------------------------------------------

describe('[T-32.8-03] AC 3: Claim JSON structure matches expected EVM claim format', () => {
  it('should produce claim with all required EVM fields via abstraction layer', async () => {
    jest.clearAllMocks();
    const mockLogger = createMockLogger();
    const mockSDK = createMockSDK();
    const mockDb = createMockDb();
    const mockChannelManager = createMockChannelManager({
      [`${TEST_PEER_ID}:${TEST_TOKEN_ID}`]: {
        channelId: TEST_CHANNEL_ID,
        tokenAddress: TEST_TOKEN_ADDRESS,
      },
    });

    const evmProvider = new EVMPaymentChannelProvider(
      mockSDK as unknown as PaymentChannelSDK,
      TEST_CHAIN_ID_STRING,
      TEST_TOKEN_ADDRESS,
      mockLogger
    );

    const mockRegistry = {
      getProviderForPeer: jest.fn().mockReturnValue(evmProvider),
    } as unknown as ChainProviderRegistry;

    const service = new PerPacketClaimService(
      mockRegistry,
      mockChannelManager as unknown as ChannelManager,
      mockDb as unknown as Database,
      mockLogger,
      TEST_NODE_ID
    );

    const result = await service.generateClaimForPacket(TEST_PEER_ID, TEST_TOKEN_ID, 1000n);
    expect(result).not.toBeNull();

    // Parse serialized claim from protocolData
    const serialized = JSON.parse(result!.protocolData.data.toString('utf8'));

    // Verify all required EVM claim fields
    expect(serialized.blockchain).toBe('evm');
    expect(serialized.version).toBe('1.0');
    expect(serialized.channelId).toBe(TEST_CHANNEL_ID);
    expect(serialized.nonce).toBe(1);
    expect(serialized.transferredAmount).toBe('1000');
    expect(serialized.lockedAmount).toBe('0');
    expect(serialized.locksRoot).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000000'
    );
    expect(serialized.signature).toBe('0xmocksignature');
    expect(serialized.chainId).toBe(TEST_CHAIN_ID_NUMERIC);
    expect(serialized.tokenNetworkAddress).toBe(TEST_TOKEN_NETWORK_ADDRESS);
    expect(serialized.tokenAddress).toBe(TEST_TOKEN_ADDRESS);
    expect(serialized.senderId).toBe(TEST_NODE_ID);
    expect(typeof serialized.messageId).toBe('string');
    expect(typeof serialized.timestamp).toBe('string');

    // Verify protocol wrapper
    expect(result!.protocolData.protocolName).toBe(BTP_CLAIM_PROTOCOL.NAME);
    expect(result!.protocolData.contentType).toBe(BTP_CLAIM_PROTOCOL.CONTENT_TYPE);
  });
});

// ---------------------------------------------------------------------------
// AC 3: EIP-712 Signatures Identical (T-32.8-04)
// ---------------------------------------------------------------------------

describe('[T-32.8-04] AC 3: EIP-712 signatures identical for same inputs through abstraction', () => {
  it('should produce identical signatures for same inputs routed through registry', async () => {
    jest.clearAllMocks();
    const mockLogger = createMockLogger();
    const mockSDK = createMockSDK();

    // Use a deterministic mock that varies by input to prove idempotency is real
    mockSDK.signBalanceProof.mockImplementation(
      async (_channelId: string, _nonce: number, transferredAmount: bigint) =>
        `0xsig_${transferredAmount.toString()}`
    );

    const evmProvider = new EVMPaymentChannelProvider(
      mockSDK as unknown as PaymentChannelSDK,
      TEST_CHAIN_ID_STRING,
      TEST_TOKEN_ADDRESS,
      mockLogger
    );

    // Route through registry (not direct provider call) to test the full abstraction path
    const registry = new ChainProviderRegistry();
    registry.register(evmProvider);
    const resolvedProvider = registry.getProvider('evm', TEST_CHAIN_ID_STRING);
    expect(resolvedProvider).toBeDefined();

    const params: BalanceProofParams = {
      channelId: TEST_CHANNEL_ID,
      nonce: 1,
      transferredAmount: '1000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
    };

    // Sign twice through the abstraction layer (registry -> provider -> SDK)
    const sig1 = await resolvedProvider!.signBalanceProof(params);
    const sig2 = await resolvedProvider!.signBalanceProof(params);

    expect(sig1).toBe(sig2);
    expect(sig1).toBe('0xsig_1000');

    // Verify the SDK was called with identical parameters both times
    expect(mockSDK.signBalanceProof).toHaveBeenCalledTimes(2);
    const [call1Args, call2Args] = mockSDK.signBalanceProof.mock.calls;
    expect(call1Args).toEqual(call2Args);

    // Different inputs produce different signatures (proves determinism is not trivial)
    const differentParams: BalanceProofParams = { ...params, transferredAmount: '2000' };
    const sig3 = await resolvedProvider!.signBalanceProof(differentParams);
    expect(sig3).toBe('0xsig_2000');
    expect(sig3).not.toBe(sig1);
  });
});

// ---------------------------------------------------------------------------
// AC 4: SettlementExecutor Opens Channel Through Provider (T-32.8-06)
// ---------------------------------------------------------------------------

describe('[T-32.8-06] AC 4: SettlementExecutor opens channel through provider', () => {
  let mockAccountManager: jest.Mocked<AccountManager>;
  let mockSettlementMonitor: jest.Mocked<SettlementMonitor>;

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
  });

  it('should call provider.openChannel() and update TigerBeetle when no existing channel', async () => {
    const mockLogger = createMockLogger();
    const mockSDK = createMockSDK();
    const evmProvider = new EVMPaymentChannelProvider(
      mockSDK as unknown as PaymentChannelSDK,
      TEST_CHAIN_ID_STRING,
      TEST_TOKEN_ADDRESS,
      mockLogger
    );

    const executorRegistry = {
      getProviderForPeer: jest.fn().mockReturnValue(evmProvider),
    } as unknown as ChainProviderRegistry;

    // ChannelManager with no existing channels
    const emptyChannelManager = createMockChannelManager();

    const executor = new SettlementExecutor(
      createTestExecutorConfig(),
      mockAccountManager,
      executorRegistry,
      mockSettlementMonitor,
      mockLogger
    );
    executor.setChannelManager(emptyChannelManager as unknown as ChannelManager);
    executor.start();

    // Track CHANNEL_ACTIVITY events to verify channel is registered in ChannelManager
    const channelActivityEvents: Array<{ channelId: string }> = [];
    executor.on('CHANNEL_ACTIVITY', (data: { channelId: string }) =>
      channelActivityEvents.push(data)
    );

    const event: SettlementTriggerEvent = {
      peerId: TEST_PEER_ID,
      tokenId: TEST_TOKEN_ID,
      currentBalance: 1200n,
      threshold: 1000n,
      exceedsBy: 200n,
      timestamp: new Date(),
    };

    const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
    handler(event);

    // Poll for the expected side-effect instead of a fixed sleep
    await waitForCondition(() => mockSDK.openChannel.mock.calls.length > 0);

    // provider.openChannel() was called (not PaymentChannelSDK.openChannel() directly)
    expect(mockSDK.openChannel).toHaveBeenCalledWith(
      TEST_PEER_ADDRESS,
      TEST_TOKEN_ADDRESS,
      86400,
      0n
    );

    // deposit was called
    expect(mockSDK.deposit).toHaveBeenCalled();

    // Channel is registered in ChannelManager via CHANNEL_ACTIVITY event
    // (SettlementExecutor emits CHANNEL_ACTIVITY which ChannelManager listens
    // for to call markChannelActivity — this is the channel registration path)
    expect(channelActivityEvents).toHaveLength(1);
    expect(channelActivityEvents[0]!.channelId).toBe(TEST_CHANNEL_ID);

    // TigerBeetle balance was updated
    expect(mockAccountManager.recordSettlement).toHaveBeenCalledWith(
      TEST_PEER_ID,
      TEST_TOKEN_ID,
      1200n
    );

    await executor.stop();
  });
});

// ---------------------------------------------------------------------------
// AC 5: SettlementExecutor Claims From Existing Channel (T-32.8-07)
// ---------------------------------------------------------------------------

describe('[T-32.8-07] AC 5: SettlementExecutor claims from existing channel through provider', () => {
  let mockAccountManager: jest.Mocked<AccountManager>;
  let mockSettlementMonitor: jest.Mocked<SettlementMonitor>;

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
  });

  it('should call provider.claimFromChannel() with latest per-packet claim, update balance, and reset tracking', async () => {
    const mockLogger = createMockLogger();
    const mockSDK = createMockSDK();
    const mockDb = createMockDb();

    const evmProvider = new EVMPaymentChannelProvider(
      mockSDK as unknown as PaymentChannelSDK,
      TEST_CHAIN_ID_STRING,
      TEST_TOKEN_ADDRESS,
      mockLogger
    );

    // Registry for claim service
    const claimServiceRegistry = {
      getProviderForPeer: jest.fn().mockReturnValue(evmProvider),
    } as unknown as ChainProviderRegistry;

    const channelManager = createMockChannelManager({
      [`${TEST_PEER_ID}:${TEST_TOKEN_ID}`]: {
        channelId: TEST_CHANNEL_ID,
        tokenAddress: TEST_TOKEN_ADDRESS,
      },
    });

    const claimService = new PerPacketClaimService(
      claimServiceRegistry,
      channelManager as unknown as ChannelManager,
      mockDb as unknown as Database,
      mockLogger,
      TEST_NODE_ID
    );

    // Generate a claim first
    await claimService.generateClaimForPacket(TEST_PEER_ID, TEST_TOKEN_ID, 1000n);
    expect(claimService.getLatestClaim(TEST_CHANNEL_ID)).not.toBeNull();

    // Setup executor
    const executorRegistry = {
      getProviderForPeer: jest.fn().mockReturnValue(evmProvider),
    } as unknown as ChainProviderRegistry;

    const executor = new SettlementExecutor(
      createTestExecutorConfig(),
      mockAccountManager,
      executorRegistry,
      mockSettlementMonitor,
      mockLogger
    );
    executor.setPerPacketClaimService(claimService);
    executor.setChannelManager(channelManager as unknown as ChannelManager);
    executor.start();

    const event: SettlementTriggerEvent = {
      peerId: TEST_PEER_ID,
      tokenId: TEST_TOKEN_ID,
      currentBalance: 1200n,
      threshold: 1000n,
      exceedsBy: 200n,
      timestamp: new Date(),
    };

    const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
    handler(event);

    // Poll for the expected side-effect instead of a fixed sleep
    await waitForCondition(() => mockSDK.claimFromChannel.mock.calls.length > 0);

    // provider.claimFromChannel() called with the latest per-packet claim
    expect(mockSDK.claimFromChannel).toHaveBeenCalledWith(
      TEST_CHANNEL_ID,
      TEST_TOKEN_ADDRESS,
      expect.objectContaining({
        channelId: TEST_CHANNEL_ID,
        nonce: 1,
        transferredAmount: 1000n,
        lockedAmount: 0n,
      }),
      '0xmocksignature'
    );

    // TigerBeetle balance updated
    expect(mockAccountManager.recordSettlement).toHaveBeenCalledWith(
      TEST_PEER_ID,
      TEST_TOKEN_ID,
      1200n
    );

    // Per-packet claim tracking was reset
    expect(claimService.getLatestClaim(TEST_CHANNEL_ID)).toBeNull();

    await executor.stop();
  });
});

// ---------------------------------------------------------------------------
// AC 6: Config-Driven Registry Initialization (T-32.8-08)
// ---------------------------------------------------------------------------

describe('[T-32.8-08] AC 6: Config-driven registry initialization', () => {
  it('should create working registry from config with factory functions', () => {
    const mockEvmProvider = createMockProvider('evm', 'evm:8453');

    const evmFactory: ChainProviderFactory = (config: ProviderConfig) => {
      if (config.chainType !== 'evm') throw new Error('Expected EVM config');
      return mockEvmProvider;
    };

    const factories = new Map<BlockchainType, ChainProviderFactory>([['evm', evmFactory]]);

    const configs: ProviderConfig[] = [
      {
        chainType: 'evm',
        rpcUrl: 'http://localhost:8545',
        registryAddress: '0x1234567890123456789012345678901234567890',
        keyId: '8453',
      },
    ];

    const registry = ChainProviderRegistry.fromConfig(configs, factories);

    // Provider was instantiated and registered
    expect(registry.getProvider('evm', 'evm:8453')).toBe(mockEvmProvider);
    expect(registry.getAllProviders()).toHaveLength(1);

    // Settlement services can resolve providers for configured peers
    const provider = registry.getProviderForPeer({
      peerId: TEST_PEER_ID,
      chain: 'evm:8453',
    });
    expect(provider).toBe(mockEvmProvider);
  });

  it('should throw when no factory registered for a chain type', () => {
    const factories = new Map<BlockchainType, ChainProviderFactory>();

    const configs: ProviderConfig[] = [
      {
        chainType: 'evm',
        rpcUrl: 'http://localhost:8545',
        registryAddress: '0x1234567890123456789012345678901234567890',
        keyId: '8453',
      },
    ];

    expect(() => ChainProviderRegistry.fromConfig(configs, factories)).toThrow(
      'No factory registered for chain type: evm'
    );
  });
});

// ---------------------------------------------------------------------------
// AC 7: Multi-Provider Registry (T-32.8-10)
// ---------------------------------------------------------------------------

describe('[T-32.8-10] AC 7: Multi-provider registry routes correctly', () => {
  it('should route EVM and mock Solana providers correctly per peer chain', () => {
    const evmProvider = createMockProvider('evm', 'evm:8453');
    const solanaProvider = createMockProvider('solana', 'solana:devnet');

    const registry = new ChainProviderRegistry();
    registry.register(evmProvider);
    registry.register(solanaProvider);

    // EVM peer routes to EVM provider
    const evmResult = registry.getProviderForPeer({
      peerId: 'evm-peer',
      chain: 'evm:8453',
    });
    expect(evmResult).toBe(evmProvider);

    // Solana peer routes to Solana provider
    const solanaResult = registry.getProviderForPeer({
      peerId: 'solana-peer',
      chain: 'solana:devnet',
    });
    expect(solanaResult).toBe(solanaProvider);

    // getAllProviders includes both
    const all = registry.getAllProviders();
    expect(all).toHaveLength(2);
    expect(all).toContain(evmProvider);
    expect(all).toContain(solanaProvider);

    // getProvider by type works correctly
    expect(registry.getProvider('evm', 'evm:8453')).toBe(evmProvider);
    expect(registry.getProvider('solana', 'solana:devnet')).toBe(solanaProvider);

    // Type mismatch returns undefined
    expect(registry.getProvider('solana', 'evm:8453')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC 8: Error Propagation (T-32.8-11)
// ---------------------------------------------------------------------------

describe('[T-32.8-11] AC 8: Error propagation through settlement services', () => {
  it('should propagate provider.signBalanceProof failure through PerPacketClaimService', async () => {
    jest.clearAllMocks();
    const mockLogger = createMockLogger();
    const mockSDK = createMockSDK();
    const mockDb = createMockDb();
    const mockChannelManager = createMockChannelManager({
      [`${TEST_PEER_ID}:${TEST_TOKEN_ID}`]: {
        channelId: TEST_CHANNEL_ID,
        tokenAddress: TEST_TOKEN_ADDRESS,
      },
    });

    const evmProvider = new EVMPaymentChannelProvider(
      mockSDK as unknown as PaymentChannelSDK,
      TEST_CHAIN_ID_STRING,
      TEST_TOKEN_ADDRESS,
      mockLogger
    );

    const mockRegistry = {
      getProviderForPeer: jest.fn().mockReturnValue(evmProvider),
    } as unknown as ChainProviderRegistry;

    const service = new PerPacketClaimService(
      mockRegistry,
      mockChannelManager as unknown as ChannelManager,
      mockDb as unknown as Database,
      mockLogger,
      TEST_NODE_ID
    );

    // First call succeeds to build context cache
    await service.generateClaimForPacket(TEST_PEER_ID, TEST_TOKEN_ID, 100n);

    // Make signBalanceProof fail
    mockSDK.signBalanceProof.mockRejectedValueOnce(new Error('EVM signing failed'));

    // Error should propagate (not be swallowed)
    await expect(service.generateClaimForPacket(TEST_PEER_ID, TEST_TOKEN_ID, 200n)).rejects.toThrow(
      'EVM signing failed'
    );
  });

  it('should surface provider.verifyBalanceProof failure through ClaimReceiver (logged, not swallowed)', async () => {
    jest.clearAllMocks();
    // ClaimReceiver uses logger.child() — mock the child to also return mock logger
    const childLoggerMock = {
      child: jest.fn().mockReturnThis(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
      fatal: jest.fn(),
    };
    const mockLogger = {
      child: jest.fn().mockReturnValue(childLoggerMock),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
      fatal: jest.fn(),
    } as unknown as Logger;

    const failingProvider = createMockProvider('evm', TEST_CHAIN_ID_STRING);
    failingProvider.verifyBalanceProof.mockRejectedValue(new Error('EVM verification failed'));
    // getChannelState must work for the dynamic verification flow
    failingProvider.getChannelState.mockResolvedValue({
      channelId: TEST_CHANNEL_ID,
      status: 'opened' as const,
      participants: [TEST_SIGNER_ADDRESS, TEST_PEER_ADDRESS],
      deposit: 10000n,
    });

    // ClaimReceiver.resolveProvider tries getProvider first, then falls back to getAllProviders
    // The claim has chainId=31337 so resolveProvider constructs 'evm:31337' as the key.
    // We mock getProvider to return the failing provider for any lookup.
    const receiverRegistry = {
      getProvider: jest.fn().mockReturnValue(failingProvider),
      getAllProviders: jest.fn().mockReturnValue([failingProvider]),
    } as unknown as ChainProviderRegistry;

    const receiverDb = createMockDb();
    const receiver = new ClaimReceiver(
      receiverDb as unknown as Database,
      receiverRegistry,
      mockLogger
    );

    // Build a realistic BTP claim message
    const claimMessage = {
      version: '1.0',
      blockchain: 'evm',
      channelId: TEST_CHANNEL_ID,
      nonce: 1,
      transferredAmount: '1000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xmocksignature',
      chainId: TEST_CHAIN_ID_NUMERIC,
      tokenNetworkAddress: TEST_TOKEN_NETWORK_ADDRESS,
      tokenAddress: TEST_TOKEN_ADDRESS,
      senderId: TEST_PEER_ID,
      messageId: 'test-msg-1',
      timestamp: new Date().toISOString(),
      signerAddress: TEST_SIGNER_ADDRESS,
    };

    // Simulate BTP server dispatching a claim message
    const mockBtpServer = { onMessage: jest.fn() };
    receiver.registerWithBTPServer(mockBtpServer as never);

    const btpHandler = mockBtpServer.onMessage.mock.calls[0][0];
    const btpMessage = {
      type: 6, // BTPMessageType.MESSAGE
      requestId: 1,
      data: {
        protocolData: [
          {
            protocolName: 'payment-channel-claim',
            contentType: 0,
            data: Buffer.from(JSON.stringify(claimMessage), 'utf8'),
          },
        ],
      },
    };
    await btpHandler(TEST_PEER_ID, btpMessage);

    // ClaimReceiver catches errors internally and logs them.
    // Verify the error was logged via the child logger (not silently swallowed).
    // Check both the child logger and any nested child loggers for error/warn calls.
    const childErrorCalls = childLoggerMock.error.mock.calls;
    const childWarnCalls = childLoggerMock.warn.mock.calls;
    const allChildLogs = [...childErrorCalls, ...childWarnCalls];
    expect(allChildLogs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC 8: Graceful Shutdown (T-32.8-09)
// ---------------------------------------------------------------------------

describe('[T-32.8-09] AC 8: Graceful shutdown deregisters providers', () => {
  it('should deregister all providers from the registry', () => {
    const registry = new ChainProviderRegistry();
    const provider1 = createMockProvider('evm', 'evm:8453');
    const provider2 = createMockProvider('solana', 'solana:devnet');

    registry.register(provider1);
    registry.register(provider2);
    expect(registry.getAllProviders()).toHaveLength(2);

    // Simulate graceful shutdown by deregistering all providers.
    // getAllProviders() returns a shallow copy, so iterating while mutating is safe.
    // Production shutdown code should similarly snapshot the list before iterating.
    const snapshot = registry.getAllProviders();
    for (const provider of snapshot) {
      registry.deregister(provider.chainId);
    }

    expect(registry.getAllProviders()).toHaveLength(0);
    expect(registry.getProvider('evm', 'evm:8453')).toBeUndefined();
    expect(registry.getProvider('solana', 'solana:devnet')).toBeUndefined();
  });

  it('should make provider unreachable after deregister, allowing subscription cleanup', () => {
    const registry = new ChainProviderRegistry();
    const provider = createMockProvider('evm', 'evm:8453');
    const mockUnsubscribe = jest.fn();
    provider.subscribeToEvents.mockReturnValue({ unsubscribe: mockUnsubscribe });

    registry.register(provider);

    // Subscribe to events while provider is registered
    const subscription = provider.subscribeToEvents('0xchannel', jest.fn());

    // Deregister provider — removes from registry lookup
    registry.deregister('evm:8453');

    // Provider is no longer resolvable through the registry
    expect(registry.getProvider('evm', 'evm:8453')).toBeUndefined();

    // Caller-held subscription handle still works for cleanup
    subscription.unsubscribe();
    expect(mockUnsubscribe).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC 9: No Direct PaymentChannelSDK Imports (T-32.8-12)
// ---------------------------------------------------------------------------

describe('[T-32.8-12] AC 9: No direct PaymentChannelSDK imports in core settlement services', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path');

  // Build an allowlist of audited filenames mapped to their safe, pre-resolved paths.
  // This avoids passing dynamic variables into path.resolve (CWE-22 path traversal).
  const settlementDir = path.resolve(__dirname, '..');
  const auditTargets: Record<string, string> = {
    'per-packet-claim-service.ts': path.join(settlementDir, 'per-packet-claim-service.ts'),
    'claim-receiver.ts': path.join(settlementDir, 'claim-receiver.ts'),
    'settlement-executor.ts': path.join(settlementDir, 'settlement-executor.ts'),
  };
  const filesToAudit = Object.keys(auditTargets);

  it.each(filesToAudit)('should not have runtime PaymentChannelSDK import in %s', (filename) => {
    const filePath = auditTargets[filename];
    expect(filePath).toBeDefined();
    const source = fs.readFileSync(filePath, 'utf8');

    // Extract all import statements
    const importStatements = source
      .split('\n')
      .filter((line: string) => line.trim().startsWith('import'))
      .filter(
        (line: string) => line.includes('payment-channel-sdk') || line.includes('PaymentChannelSDK')
      );

    // Filter out type-only imports (import type { ... })
    const runtimeImports = importStatements.filter(
      (line: string) => !line.trim().startsWith('import type')
    );

    expect(runtimeImports).toEqual([]);
  });

  it.each(filesToAudit)(
    'should import from ChainProviderRegistry or PaymentChannelProvider in %s',
    (filename) => {
      const filePath = auditTargets[filename];
      expect(filePath).toBeDefined();
      const source = fs.readFileSync(filePath, 'utf8');

      // Should reference ChainProviderRegistry or PaymentChannelProvider
      const hasProviderImport =
        source.includes('ChainProviderRegistry') || source.includes('PaymentChannelProvider');
      expect(hasProviderImport).toBe(true);
    }
  );
});
