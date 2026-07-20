import { ChannelManager, ChannelManagerConfig } from './channel-manager';
import { PaymentChannelSDK } from './payment-channel-sdk';
import { SettlementExecutor } from './settlement-executor';
import { ChainProviderRegistry } from './provider/chain-provider-registry';
import type { PaymentChannelProvider } from './provider/payment-channel-provider';
import { EventEmitter } from 'events';
import pino from 'pino';

describe('ChannelManager', () => {
  let channelManager: ChannelManager;
  let mockPaymentChannelSDK: jest.Mocked<PaymentChannelSDK>;
  let mockSettlementExecutor: jest.Mocked<SettlementExecutor>;
  let mockLogger: pino.Logger;
  let config: ChannelManagerConfig;

  beforeEach(() => {
    // Create mock instances
    mockPaymentChannelSDK = {
      openChannel: jest.fn(),
      getChannelState: jest.fn(),
      closeChannel: jest.fn(),
      signBalanceProof: jest.fn(),
      settleChannel: jest.fn(),
      getMyChannels: jest.fn(),
      deposit: jest.fn(),
    } as unknown as jest.Mocked<PaymentChannelSDK>;

    mockSettlementExecutor = new EventEmitter() as jest.Mocked<SettlementExecutor>;

    mockLogger = pino({ level: 'silent' });

    // Default mock for getChannelState (can be overridden in individual tests)
    mockPaymentChannelSDK.getChannelState.mockResolvedValue({
      channelId: '0xChannelId123',
      participants: ['0xMyAddress', '0xPeerAddress'],
      myDeposit: BigInt(10000000000000000000),
      theirDeposit: BigInt(0),
      myNonce: 0,
      theirNonce: 0,
      myTransferred: BigInt(0),
      theirTransferred: BigInt(0),
      status: 'opened',
      settlementTimeout: 86400,
      openedAt: Date.now(),
    });

    // Create config
    config = {
      nodeId: 'test-node',
      defaultSettlementTimeout: 86400,
      initialDepositMultiplier: 10,
      idleChannelThreshold: 86400,
      minDepositThreshold: 0.5,
      idleCheckInterval: 3600,
      tokenAddressMap: new Map([['TEST_TOKEN', '0xTokenAddress']]),
      peerIdToAddressMap: new Map([['peer-a', '0xPeerAddress']]),
      registryAddress: '0xRegistryAddress',
      rpcUrl: 'http://localhost:8545',
      privateKey: '0xPrivateKey',
    };

    // Create ChannelManager instance
    channelManager = new ChannelManager(
      config,
      mockPaymentChannelSDK,
      mockSettlementExecutor,
      mockLogger
    );
  });

  afterEach(() => {
    // Stop channel manager to clear timers
    channelManager.stop();
  });

  describe('constructor', () => {
    it('should initialize all properties correctly', () => {
      expect(channelManager).toBeDefined();
      expect(channelManager.getAllChannels()).toEqual([]);
    });
  });

  describe('ensureChannelExists', () => {
    it('should create new channel when none exists', async () => {
      const mockChannelId = '0xChannelId123';
      mockPaymentChannelSDK.openChannel.mockResolvedValue({
        channelId: mockChannelId,
        txHash: '0xMockTxHash',
      });

      const channelId = await channelManager.ensureChannelExists('peer-a', 'TEST_TOKEN');

      expect(channelId).toBe(mockChannelId);
      expect(mockPaymentChannelSDK.openChannel).toHaveBeenCalledWith(
        '0xPeerAddress',
        '0xTokenAddress',
        86400,
        expect.any(BigInt)
      );

      const metadata = channelManager.getChannelById(mockChannelId);
      expect(metadata).toBeDefined();
      expect(metadata?.peerId).toBe('peer-a');
      expect(metadata?.tokenId).toBe('TEST_TOKEN');
      expect(metadata?.status).toBe('open');
    });

    it('should reuse existing channel', async () => {
      const mockChannelId = '0xChannelId123';
      mockPaymentChannelSDK.openChannel.mockResolvedValue({
        channelId: mockChannelId,
        txHash: '0xMockTxHash',
      });

      // First call creates channel
      await channelManager.ensureChannelExists('peer-a', 'TEST_TOKEN');

      // Second call reuses existing
      const channelId = await channelManager.ensureChannelExists('peer-a', 'TEST_TOKEN');

      expect(channelId).toBe(mockChannelId);
      expect(mockPaymentChannelSDK.openChannel).toHaveBeenCalledTimes(1);
    });
  });

  describe('multi-chain channel open (issue #86)', () => {
    // Minimal mock PaymentChannelProvider — only openChannel/deposit are exercised
    // by ChannelManager.openChannelForPeer's provider path.
    function createMockProvider(
      chainId: string,
      overrides: Partial<jest.Mocked<PaymentChannelProvider>> = {}
    ): jest.Mocked<PaymentChannelProvider> {
      return {
        chainType: 'solana',
        chainId,
        openChannel: jest.fn().mockResolvedValue({ channelId: 'SoLPDA', txHash: 'sig' }),
        deposit: jest.fn().mockResolvedValue({ txHash: 'sig2' }),
        claimFromChannel: jest.fn(),
        closeChannel: jest.fn(),
        settleChannel: jest.fn(),
        signBalanceProof: jest.fn(),
        verifyBalanceProof: jest.fn(),
        getChannelState: jest.fn(),
        subscribeToEvents: jest.fn(),
        ...overrides,
      } as unknown as jest.Mocked<PaymentChannelProvider>;
    }

    const SOL_ADDR = 'So1anaPeerAddress11111111111111111111111111';

    it('opens a Solana channel when peer.chain=solana:devnet', async () => {
      const provider = createMockProvider('solana:devnet');
      const registry = new ChainProviderRegistry();
      registry.register(provider);

      const solConfig: ChannelManagerConfig = {
        ...config,
        // Solana peer address is base58 (not in the default EVM map)
        peerIdToAddressMap: new Map([['peer-sol', SOL_ADDR]]),
      };

      const cm = new ChannelManager(
        solConfig,
        mockPaymentChannelSDK,
        mockSettlementExecutor,
        mockLogger,
        registry,
        new Map([['peer-sol', 'solana:devnet']])
      );

      // tokenId 'M2M' is intentionally absent from the EVM tokenAddressMap — the
      // provider path must not require a map hit (dual-chain tokenAddressMap gap).
      const channelId = await cm.ensureChannelExists('peer-sol', 'M2M', {
        chain: 'solana:devnet',
      });

      expect(channelId).toBe('SoLPDA');
      // openChannel called with (base58Addr, settlementTimeout) — no token/deposit args
      expect(provider.openChannel).toHaveBeenCalledWith(SOL_ADDR, 86400);
      // deposit called with (channelId, initialDeposit string)
      const expectedDeposit = (1000000n * BigInt(config.initialDepositMultiplier)).toString();
      expect(provider.deposit).toHaveBeenCalledWith('SoLPDA', expectedDeposit);
      // The EVM SDK path was NOT taken
      expect(mockPaymentChannelSDK.openChannel).not.toHaveBeenCalled();

      const metadata = cm.getChannelById('SoLPDA');
      expect(metadata?.chain).toBe('solana:devnet');
      expect(metadata?.peerId).toBe('peer-sol');
      expect(metadata?.status).toBe('open');

      cm.stop();
    });

    it('still opens EVM channel when no chain / evm (regression)', async () => {
      const provider = createMockProvider('solana:devnet');
      const registry = new ChainProviderRegistry();
      registry.register(provider);

      mockPaymentChannelSDK.openChannel.mockResolvedValue({
        channelId: '0xEvmChannel',
        txHash: '0xTx',
      });

      const cm = new ChannelManager(
        config,
        mockPaymentChannelSDK,
        mockSettlementExecutor,
        mockLogger,
        registry,
        // peer-a has no chain entry → EVM path
        new Map()
      );

      const channelId = await cm.ensureChannelExists('peer-a', 'TEST_TOKEN');

      expect(channelId).toBe('0xEvmChannel');
      expect(mockPaymentChannelSDK.openChannel).toHaveBeenCalledWith(
        '0xPeerAddress',
        '0xTokenAddress',
        86400,
        expect.any(BigInt)
      );
      // The registry provider was NOT touched for an EVM peer
      expect(provider.openChannel).not.toHaveBeenCalled();
      expect(provider.deposit).not.toHaveBeenCalled();

      cm.stop();
    });

    it('throws if the Solana provider is missing from the registry', async () => {
      const emptyRegistry = new ChainProviderRegistry();

      const solConfig: ChannelManagerConfig = {
        ...config,
        peerIdToAddressMap: new Map([['peer-sol', SOL_ADDR]]),
      };

      const cm = new ChannelManager(
        solConfig,
        mockPaymentChannelSDK,
        mockSettlementExecutor,
        mockLogger,
        emptyRegistry,
        new Map([['peer-sol', 'solana:devnet']])
      );

      await expect(
        cm.ensureChannelExists('peer-sol', 'M2M', { chain: 'solana:devnet' })
      ).rejects.toThrow('No provider registered for chain solana:devnet');

      expect(mockPaymentChannelSDK.openChannel).not.toHaveBeenCalled();

      cm.stop();
    });

    it('does not register a funded channel when deposit fails after open', async () => {
      const provider = createMockProvider('solana:devnet', {
        deposit: jest.fn().mockRejectedValue(new Error('deposit reverted')),
      });
      const registry = new ChainProviderRegistry();
      registry.register(provider);

      const solConfig: ChannelManagerConfig = {
        ...config,
        peerIdToAddressMap: new Map([['peer-sol', SOL_ADDR]]),
      };

      const cm = new ChannelManager(
        solConfig,
        mockPaymentChannelSDK,
        mockSettlementExecutor,
        mockLogger,
        registry,
        new Map([['peer-sol', 'solana:devnet']])
      );

      await expect(
        cm.ensureChannelExists('peer-sol', 'M2M', { chain: 'solana:devnet' })
      ).rejects.toThrow('deposit reverted');

      // openChannel succeeded but deposit threw → channel must NOT be registered
      expect(provider.openChannel).toHaveBeenCalled();
      expect(cm.getChannelById('SoLPDA')).toBeNull();
      expect(cm.getChannelForPeer('peer-sol', 'M2M')).toBeNull();

      cm.stop();
    });
  });

  describe('getChannelById', () => {
    it('should return channel metadata when found', async () => {
      const mockChannelId = '0xChannelId123';
      mockPaymentChannelSDK.openChannel.mockResolvedValue({
        channelId: mockChannelId,
        txHash: '0xMockTxHash',
      });

      await channelManager.ensureChannelExists('peer-a', 'TEST_TOKEN');

      const metadata = channelManager.getChannelById(mockChannelId);
      expect(metadata).toBeDefined();
      expect(metadata?.channelId).toBe(mockChannelId);
    });

    it('should return null when channel not found', () => {
      const metadata = channelManager.getChannelById('0xNonExistent');
      expect(metadata).toBeNull();
    });
  });

  describe('getChannelForPeer', () => {
    it('should return channel metadata for peer and token', async () => {
      const mockChannelId = '0xChannelId123';
      mockPaymentChannelSDK.openChannel.mockResolvedValue({
        channelId: mockChannelId,
        txHash: '0xMockTxHash',
      });

      await channelManager.ensureChannelExists('peer-a', 'TEST_TOKEN');

      const metadata = channelManager.getChannelForPeer('peer-a', 'TEST_TOKEN');
      expect(metadata).toBeDefined();
      expect(metadata?.channelId).toBe(mockChannelId);
      expect(metadata?.peerId).toBe('peer-a');
      expect(metadata?.tokenId).toBe('TEST_TOKEN');
    });

    it('should return null when no channel exists for peer', () => {
      const metadata = channelManager.getChannelForPeer('peer-unknown', 'TEST_TOKEN');
      expect(metadata).toBeNull();
    });
  });

  describe('getChannelsForPeer (#92)', () => {
    it('should return all channels for a peer regardless of indexed tokenId', () => {
      // A non-EVM external channel is indexed under a program-derived tokenId that
      // never matches the EVM settlement tokenId. getChannelsForPeer ignores the
      // tokenId key so the executor can locate it via the chain fallback.
      const programTokenId = 'EdJxYPDxGvaJuu57DSUptf4soLv8enpdyQJJhHDLiydG';
      channelManager.registerExternalChannel({
        channelId: 'SolChannelPDA111',
        peerId: 'peer-dyn',
        tokenAddress: programTokenId, // no tokenAddressMap match → tokenId = raw program id
        status: 'open',
        chain: 'solana:devnet',
      });

      const channels = channelManager.getChannelsForPeer('peer-dyn');
      expect(channels).toHaveLength(1);
      const [channel] = channels;
      expect(channel?.channelId).toBe('SolChannelPDA111');
      expect(channel?.tokenId).toBe(programTokenId);
      expect(channel?.chain).toBe('solana:devnet');

      // The tokenId-keyed lookup with the EVM settlement tokenId misses...
      expect(channelManager.getChannelForPeer('peer-dyn', 'TEST_TOKEN')).toBeNull();
      // ...but getChannelsForPeer still surfaces it.
    });

    it('should return an empty array for an unknown peer', () => {
      expect(channelManager.getChannelsForPeer('peer-unknown')).toEqual([]);
    });
  });

  describe('registerExternalChannel', () => {
    const externalChannelParams = {
      channelId: '0xExternalChannel123',
      peerId: 'peer-external',
      tokenAddress: '0xTokenAddress',
      tokenNetworkAddress: '0xTokenNetworkAddress',
      chainId: 31337,
      status: 'open' as const,
    };

    it('should register external channel in both channelMetadata and peerChannelIndex', () => {
      const metadata = channelManager.registerExternalChannel(externalChannelParams);

      expect(metadata.channelId).toBe(externalChannelParams.channelId);
      expect(metadata.peerId).toBe(externalChannelParams.peerId);
      expect(metadata.tokenAddress).toBe(externalChannelParams.tokenAddress);
      expect(metadata.chain).toBe('evm:31337');
      expect(metadata.status).toBe('open');
      expect(metadata.tokenId).toBe('TEST_TOKEN'); // reverse-lookup matched

      // Verify accessible via getChannelById
      const byId = channelManager.getChannelById(externalChannelParams.channelId);
      expect(byId).toBe(metadata);

      // Verify accessible via getChannelForPeer
      const byPeer = channelManager.getChannelForPeer('peer-external', 'TEST_TOKEN');
      expect(byPeer).toBe(metadata);
    });

    it('should be idempotent -- duplicate registration returns existing', () => {
      const first = channelManager.registerExternalChannel(externalChannelParams);
      const second = channelManager.registerExternalChannel(externalChannelParams);

      expect(second).toBe(first);
      expect(channelManager.getAllChannels()).toHaveLength(1);
    });

    it('should handle token address reverse-lookup fallback', () => {
      const unknownTokenParams = {
        ...externalChannelParams,
        tokenAddress: '0xUnknownToken',
      };

      const metadata = channelManager.registerExternalChannel(unknownTokenParams);

      // Falls back to raw token address as tokenId
      expect(metadata.tokenId).toBe('0xUnknownToken');
    });
  });

  describe('markChannelActivity', () => {
    it('should update lastActivityAt timestamp', async () => {
      const mockChannelId = '0xChannelId123';
      mockPaymentChannelSDK.openChannel.mockResolvedValue({
        channelId: mockChannelId,
        txHash: '0xMockTxHash',
      });

      await channelManager.ensureChannelExists('peer-a', 'TEST_TOKEN');

      const metadata = channelManager.getChannelById(mockChannelId);
      const oldTimestamp = metadata?.lastActivityAt;

      // Wait 10ms
      await new Promise((resolve) => setTimeout(resolve, 10));

      channelManager.markChannelActivity(mockChannelId);

      const updatedMetadata = channelManager.getChannelById(mockChannelId);
      expect(updatedMetadata?.lastActivityAt.getTime()).toBeGreaterThan(
        oldTimestamp?.getTime() || 0
      );
    });
  });

  describe('isChannelIdle', () => {
    it('should detect idle channel', async () => {
      const mockChannelId = '0xChannelId123';
      mockPaymentChannelSDK.openChannel.mockResolvedValue({
        channelId: mockChannelId,
        txHash: '0xMockTxHash',
      });

      await channelManager.ensureChannelExists('peer-a', 'TEST_TOKEN');

      const metadata = channelManager.getChannelById(mockChannelId);
      if (!metadata) throw new Error('Metadata not found');

      // Set lastActivityAt to 25 hours ago
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
      metadata.lastActivityAt = oldDate;

      // Access private method via type assertion
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isIdle = (channelManager as any).isChannelIdle(metadata);
      expect(isIdle).toBe(true);
    });

    it('should not detect active channel as idle', async () => {
      const mockChannelId = '0xChannelId123';
      mockPaymentChannelSDK.openChannel.mockResolvedValue({
        channelId: mockChannelId,
        txHash: '0xMockTxHash',
      });

      await channelManager.ensureChannelExists('peer-a', 'TEST_TOKEN');

      const metadata = channelManager.getChannelById(mockChannelId);
      if (!metadata) throw new Error('Metadata not found');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isIdle = (channelManager as any).isChannelIdle(metadata);
      expect(isIdle).toBe(false);
    });
  });

  describe('start and stop', () => {
    it('should start and stop idle check timer', () => {
      channelManager.start();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((channelManager as any).idleCheckTimer).toBeDefined();

      channelManager.stop();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((channelManager as any).idleCheckTimer).toBeUndefined();
    });
  });

  describe('close idle channel', () => {
    it('should close idle channel and set status to closing', async () => {
      const mockChannelId = '0xChannelId123';
      mockPaymentChannelSDK.openChannel.mockResolvedValue({
        channelId: mockChannelId,
        txHash: '0xMockTxHash',
      });

      mockPaymentChannelSDK.closeChannel.mockResolvedValue();

      await channelManager.ensureChannelExists('peer-a', 'TEST_TOKEN');

      const metadata = channelManager.getChannelById(mockChannelId);
      if (!metadata) throw new Error('Metadata not found');

      // Set as idle
      metadata.lastActivityAt = new Date(Date.now() - 25 * 60 * 60 * 1000);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (channelManager as any).closeIdleChannel(mockChannelId);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockPaymentChannelSDK.closeChannel).toHaveBeenCalledWith(
        mockChannelId,
        '0xTokenAddress'
      );
      expect(metadata.status).toBe('closing');
    });

    it('should revert status to open if closeChannel fails', async () => {
      const mockChannelId = '0xChannelId123';
      mockPaymentChannelSDK.openChannel.mockResolvedValue({
        channelId: mockChannelId,
        txHash: '0xMockTxHash',
      });

      mockPaymentChannelSDK.closeChannel.mockRejectedValue(new Error('Close channel failed'));

      await channelManager.ensureChannelExists('peer-a', 'TEST_TOKEN');

      const metadata = channelManager.getChannelById(mockChannelId);
      if (!metadata) throw new Error('Metadata not found');

      // Set as idle
      metadata.lastActivityAt = new Date(Date.now() - 25 * 60 * 60 * 1000);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect((channelManager as any).closeIdleChannel(mockChannelId)).rejects.toThrow(
        'Close channel failed'
      );

      expect(metadata.status).toBe('open');
    });
  });

  describe('settlement activity tracking', () => {
    it('should update channel activity when settlement occurs', async () => {
      const mockChannelId = '0xChannelId123';
      mockPaymentChannelSDK.openChannel.mockResolvedValue({
        channelId: mockChannelId,
        txHash: '0xMockTxHash',
      });

      await channelManager.ensureChannelExists('peer-a', 'TEST_TOKEN');

      const metadata = channelManager.getChannelById(mockChannelId);
      const oldTimestamp = metadata?.lastActivityAt;

      // Wait 10ms
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate settlement activity event
      mockSettlementExecutor.emit('CHANNEL_ACTIVITY', { channelId: mockChannelId });

      const updatedMetadata = channelManager.getChannelById(mockChannelId);
      expect(updatedMetadata?.lastActivityAt.getTime()).toBeGreaterThan(
        oldTimestamp?.getTime() || 0
      );
    });
  });

  /**
   * ATDD Acceptance Tests for Story 33.6: registerExternalChannel Solana Support
   *
   * TDD RED PHASE: All tests use it.skip() because registerExternalChannel()
   * currently requires EVM-specific params (chainId: number, tokenNetworkAddress: string)
   * and hardcodes `evm:${chainId}` for the chain field. Solana channels need:
   * - Optional tokenNetworkAddress and chainId (they are EVM-only)
   * - A `chain` string parameter (e.g., 'solana:devnet')
   * - Case-sensitive token address comparison for base58 addresses
   *
   * To move to GREEN phase:
   * 1. Extend registerExternalChannel to accept optional chain string
   * 2. Make tokenNetworkAddress and chainId optional
   * 3. Add case-sensitive comparison path for non-EVM chains
   * 4. Remove .skip from all tests
   * 5. Run: npx jest packages/connector/src/settlement/channel-manager.test.ts
   */
  describe('registerExternalChannel Solana support (Story 33.6)', () => {
    it('[P0] should register Solana channel with chain: solana:devnet (T-33.6-22)', () => {
      const solanaParams = {
        channelId: 'AbCdEfGh11111111111111111111111111111111111',
        peerId: 'peer-solana',
        tokenAddress: 'SoLtOkEn1111111111111111111111111111111111',
        chain: 'solana:devnet',
        status: 'open' as const,
      };

      const metadata = channelManager.registerExternalChannel(solanaParams);

      expect(metadata.channelId).toBe(solanaParams.channelId);
      expect(metadata.peerId).toBe(solanaParams.peerId);
      expect(metadata.tokenAddress).toBe(solanaParams.tokenAddress);
      expect(metadata.chain).toBe('solana:devnet');
      expect(metadata.status).toBe('open');

      // Verify accessible via getChannelById
      const byId = channelManager.getChannelById(solanaParams.channelId);
      expect(byId).toBe(metadata);
    });

    it('[P0] should remain backward compatible -- EVM channels still use evm: prefix (T-33.6-23)', () => {
      const evmParams = {
        channelId: '0xExternalChannel456',
        peerId: 'peer-evm',
        tokenAddress: '0xTokenAddress',
        tokenNetworkAddress: '0xTokenNetworkAddress',
        chainId: 31337,
        status: 'open' as const,
      };

      const metadata = channelManager.registerExternalChannel(evmParams);

      // EVM channels should still use the legacy evm: prefix format
      expect(metadata.chain).toBe('evm:31337');
      expect(metadata.tokenAddress).toBe(evmParams.tokenAddress);
    });

    it('[P1] should use case-sensitive comparison for Solana token mint reverse-lookup (T-33.6-24)', () => {
      // Add a Solana token mint to the config map (case-sensitive base58)
      config.tokenAddressMap.set('SOL_TOKEN', 'SoLtOkEn1111111111111111111111111111111111');

      // Recreate channel manager with updated config
      const cmWithSolana = new ChannelManager(
        config,
        mockPaymentChannelSDK,
        mockSettlementExecutor,
        mockLogger
      );

      const solanaParams = {
        channelId: 'SolChannel111111111111111111111111111111111',
        peerId: 'peer-solana-token',
        tokenAddress: 'SoLtOkEn1111111111111111111111111111111111', // Exact case match
        chain: 'solana:devnet',
        status: 'open' as const,
      };

      const metadata = cmWithSolana.registerExternalChannel(solanaParams);

      // Should match by case-sensitive comparison (not toLowerCase)
      expect(metadata.tokenId).toBe('SOL_TOKEN');

      cmWithSolana.stop();
    });

    it('[P1] should NOT match Solana token with different case (case-sensitive base58)', () => {
      config.tokenAddressMap.set('SOL_TOKEN', 'SoLtOkEn1111111111111111111111111111111111');

      const cmWithSolana = new ChannelManager(
        config,
        mockPaymentChannelSDK,
        mockSettlementExecutor,
        mockLogger
      );

      const solanaParams = {
        channelId: 'SolChannel222222222222222222222222222222222',
        peerId: 'peer-solana-case',
        tokenAddress: 'soltoken1111111111111111111111111111111111', // Wrong case!
        chain: 'solana:devnet',
        status: 'open' as const,
      };

      const metadata = cmWithSolana.registerExternalChannel(solanaParams);

      // Should NOT match -- falls back to raw token address as tokenId
      expect(metadata.tokenId).toBe('soltoken1111111111111111111111111111111111');

      cmWithSolana.stop();
    });

    it('[P0] should not require tokenNetworkAddress for Solana channels', () => {
      const solanaParams = {
        channelId: 'SolChannel333333333333333333333333333333333',
        peerId: 'peer-solana-no-tn',
        tokenAddress: 'SoLtOkEn1111111111111111111111111111111111',
        chain: 'solana:devnet',
        status: 'open' as const,
        // tokenNetworkAddress intentionally omitted (EVM-only field)
        // chainId intentionally omitted (EVM-only field)
      };

      // Should not throw when tokenNetworkAddress and chainId are omitted
      expect(() => {
        channelManager.registerExternalChannel(solanaParams);
      }).not.toThrow();

      const metadata = channelManager.getChannelById(solanaParams.channelId);
      expect(metadata).not.toBeNull();
      expect(metadata!.chain).toBe('solana:devnet');
    });
  });
});
