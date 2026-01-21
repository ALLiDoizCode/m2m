/**
 * Unit Tests for UnifiedSettlementExecutor
 *
 * Tests dual-chain settlement routing logic for EVM and XRP payment channels.
 * Verifies settlement method selection based on peer configuration and token type.
 *
 * Source: Epic 9 Story 9.5 - Dual-Settlement Support (EVM + XRP)
 *
 * @module settlement/unified-settlement-executor.test
 */

import { UnifiedSettlementExecutor } from './unified-settlement-executor';
import type { PaymentChannelSDK } from './payment-channel-sdk';
import type { PaymentChannelManager } from './xrp-channel-manager';
import type { ClaimSigner } from './xrp-claim-signer';
import type { SettlementMonitor } from './settlement-monitor';
import type { AccountManager } from './account-manager';
import type { Logger } from 'pino';
import type { UnifiedSettlementExecutorConfig, SettlementRequiredEvent } from './types';

describe('UnifiedSettlementExecutor', () => {
  let executor: UnifiedSettlementExecutor;
  let mockEVMChannelSDK: jest.Mocked<PaymentChannelSDK>;
  let mockXRPChannelManager: jest.Mocked<PaymentChannelManager>;
  let mockXRPClaimSigner: jest.Mocked<ClaimSigner>;
  let mockSettlementMonitor: jest.Mocked<SettlementMonitor>;
  let mockAccountManager: jest.Mocked<AccountManager>;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    // Create fresh mock instances (Anti-Pattern 3 solution)
    mockEVMChannelSDK = {
      openChannel: jest.fn().mockResolvedValue('0xabc123'),
      signBalanceProof: jest.fn().mockResolvedValue('0xsignature'),
      getChannelState: jest.fn(),
      closeChannel: jest.fn(),
      cooperativeSettle: jest.fn(),
      deposit: jest.fn(),
      getMyChannels: jest.fn(),
      settleChannel: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
      removeAllListeners: jest.fn(),
    } as unknown as jest.Mocked<PaymentChannelSDK>;

    mockXRPChannelManager = {
      createChannel: jest.fn().mockResolvedValue('A'.repeat(64)),
      submitClaim: jest.fn().mockResolvedValue({}),
      closeChannel: jest.fn(),
      getChannelState: jest.fn(),
    } as unknown as jest.Mocked<PaymentChannelManager>;

    mockXRPClaimSigner = {
      signClaim: jest.fn().mockResolvedValue('B'.repeat(128)),
      getPublicKey: jest.fn().mockReturnValue('ED' + 'C'.repeat(64)),
      verifyClaim: jest.fn(),
    } as unknown as jest.Mocked<ClaimSigner>;

    mockSettlementMonitor = {
      on: jest.fn(),
      off: jest.fn(),
      emit: jest.fn(),
      listenerCount: jest.fn().mockReturnValue(0),
      removeAllListeners: jest.fn(),
    } as unknown as jest.Mocked<SettlementMonitor>;

    mockAccountManager = {
      recordSettlement: jest.fn().mockResolvedValue(undefined),
      getAccountBalance: jest.fn(),
      getPeerAccountPair: jest.fn(),
      recordPacketForward: jest.fn(),
      recordPacketReceive: jest.fn(),
    } as unknown as jest.Mocked<AccountManager>;

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
      fatal: jest.fn(),
      trace: jest.fn(),
      level: 'info',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const config: UnifiedSettlementExecutorConfig = {
      peers: new Map([
        [
          'peer-alice',
          {
            peerId: 'peer-alice',
            address: 'g.alice',
            settlementPreference: 'evm',
            settlementTokens: ['USDC', 'DAI'],
            evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
          },
        ],
        [
          'peer-bob',
          {
            peerId: 'peer-bob',
            address: 'g.bob',
            settlementPreference: 'xrp',
            settlementTokens: ['XRP'],
            xrpAddress: 'rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW',
          },
        ],
        [
          'peer-charlie',
          {
            peerId: 'peer-charlie',
            address: 'g.charlie',
            settlementPreference: 'both',
            settlementTokens: ['USDC', 'XRP'],
            evmAddress: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
            xrpAddress: 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN',
          },
        ],
      ]),
      defaultPreference: 'both',
      enabled: true,
    };

    executor = new UnifiedSettlementExecutor(
      config,
      mockEVMChannelSDK,
      mockXRPChannelManager,
      mockXRPClaimSigner,
      mockSettlementMonitor,
      mockAccountManager,
      mockLogger
    );
  });

  afterEach(() => {
    // Ensure cleanup on test failure (Anti-Pattern 5 solution)
    executor.stop();
  });

  describe('Event Listener Cleanup', () => {
    it('should register listener on start', () => {
      executor.start();
      expect(mockSettlementMonitor.on).toHaveBeenCalledWith(
        'SETTLEMENT_REQUIRED',
        expect.any(Function)
      );
    });

    it('should unregister listener on stop', () => {
      executor.start();
      executor.stop();
      expect(mockSettlementMonitor.off).toHaveBeenCalledWith(
        'SETTLEMENT_REQUIRED',
        expect.any(Function)
      );
    });

    it('should log startup and shutdown messages', () => {
      executor.start();
      expect(mockLogger.info).toHaveBeenCalledWith('Starting UnifiedSettlementExecutor...');
      expect(mockLogger.info).toHaveBeenCalledWith('UnifiedSettlementExecutor started');

      executor.stop();
      expect(mockLogger.info).toHaveBeenCalledWith('Stopping UnifiedSettlementExecutor...');
      expect(mockLogger.info).toHaveBeenCalledWith('UnifiedSettlementExecutor stopped');
    });
  });

  describe('EVM Settlement Routing', () => {
    it('should route USDC settlement to EVM for peer with evm preference', async () => {
      executor.start();

      const event: SettlementRequiredEvent = {
        peerId: 'peer-alice',
        balance: '1000000000', // 1000 USDC
        tokenId: '0xUSDCAddress',
        timestamp: Date.now(),
      };

      // Manually invoke handler to simulate event emission
      // Note: We don't use mockSettlementMonitor.emit since we're testing the handler directly

      // Manually invoke handler to simulate event emission
      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      await handler(event);

      expect(mockEVMChannelSDK.openChannel).toHaveBeenCalledWith(
        '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        '0xUSDCAddress',
        86400,
        BigInt('1000000000')
      );
      expect(mockAccountManager.recordSettlement).toHaveBeenCalledWith(
        'peer-alice',
        '0xUSDCAddress',
        BigInt('1000000000')
      );
    });

    it('should route USDC settlement to EVM for peer with both preference', async () => {
      executor.start();

      const event: SettlementRequiredEvent = {
        peerId: 'peer-charlie',
        balance: '5000000000', // 5000 USDC
        tokenId: '0xUSDCAddress',
        timestamp: Date.now(),
      };

      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      await handler(event);

      expect(mockEVMChannelSDK.openChannel).toHaveBeenCalled();
      expect(mockAccountManager.recordSettlement).toHaveBeenCalledWith(
        'peer-charlie',
        '0xUSDCAddress',
        BigInt('5000000000')
      );
    });
  });

  describe('XRP Settlement Routing', () => {
    it('should route XRP settlement to XRP for peer with xrp preference', async () => {
      executor.start();

      const event: SettlementRequiredEvent = {
        peerId: 'peer-bob',
        balance: '10000000000', // 10,000 XRP drops
        tokenId: 'XRP',
        timestamp: Date.now(),
      };

      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      await handler(event);

      expect(mockXRPChannelManager.createChannel).toHaveBeenCalledWith(
        'rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW',
        '10000000000',
        86400
      );
      expect(mockXRPClaimSigner.signClaim).toHaveBeenCalled();
      expect(mockAccountManager.recordSettlement).toHaveBeenCalledWith(
        'peer-bob',
        'XRP',
        BigInt('10000000000')
      );
    });

    it('should route XRP settlement to XRP for peer with both preference', async () => {
      executor.start();

      const event: SettlementRequiredEvent = {
        peerId: 'peer-charlie',
        balance: '5000000000', // 5,000 XRP drops
        tokenId: 'XRP',
        timestamp: Date.now(),
      };

      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      await handler(event);

      expect(mockXRPChannelManager.createChannel).toHaveBeenCalled();
      expect(mockXRPClaimSigner.signClaim).toHaveBeenCalled();
      expect(mockAccountManager.recordSettlement).toHaveBeenCalledWith(
        'peer-charlie',
        'XRP',
        BigInt('5000000000')
      );
    });
  });

  describe('Error Handling', () => {
    it('should throw error for incompatible token and preference (XRP to evm peer)', async () => {
      executor.start();

      const event: SettlementRequiredEvent = {
        peerId: 'peer-alice', // evm preference
        balance: '1000000000',
        tokenId: 'XRP', // XRP token
        timestamp: Date.now(),
      };

      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];

      await expect(handler(event)).rejects.toThrow('No compatible settlement method');

      // Expect error logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: 'peer-alice',
          tokenId: 'XRP',
        }),
        'Settlement failed'
      );
    });

    it('should throw error for missing peer configuration', async () => {
      executor.start();

      const event: SettlementRequiredEvent = {
        peerId: 'unknown-peer',
        balance: '1000000000',
        tokenId: 'USDC',
        timestamp: Date.now(),
      };

      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];

      await expect(handler(event)).rejects.toThrow('Peer configuration not found');

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ peerId: 'unknown-peer' }),
        'Peer configuration not found'
      );
    });

    it('should throw error for missing evmAddress on EVM settlement', async () => {
      // Create config with peer missing evmAddress
      const configWithMissingAddress: UnifiedSettlementExecutorConfig = {
        peers: new Map([
          [
            'peer-incomplete',
            {
              peerId: 'peer-incomplete',
              address: 'g.incomplete',
              settlementPreference: 'evm',
              settlementTokens: ['USDC'],
              // evmAddress missing
            },
          ],
        ]),
        defaultPreference: 'both',
        enabled: true,
      };

      const executorIncomplete = new UnifiedSettlementExecutor(
        configWithMissingAddress,
        mockEVMChannelSDK,
        mockXRPChannelManager,
        mockXRPClaimSigner,
        mockSettlementMonitor,
        mockAccountManager,
        mockLogger
      );

      executorIncomplete.start();

      const event: SettlementRequiredEvent = {
        peerId: 'peer-incomplete',
        balance: '1000000000',
        tokenId: '0xUSDCAddress',
        timestamp: Date.now(),
      };

      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];

      await expect(handler(event)).rejects.toThrow('missing evmAddress');

      executorIncomplete.stop();
    });

    it('should throw error for missing xrpAddress on XRP settlement', async () => {
      // Create config with peer missing xrpAddress
      const configWithMissingAddress: UnifiedSettlementExecutorConfig = {
        peers: new Map([
          [
            'peer-incomplete',
            {
              peerId: 'peer-incomplete',
              address: 'g.incomplete',
              settlementPreference: 'xrp',
              settlementTokens: ['XRP'],
              // xrpAddress missing
            },
          ],
        ]),
        defaultPreference: 'both',
        enabled: true,
      };

      const executorIncomplete = new UnifiedSettlementExecutor(
        configWithMissingAddress,
        mockEVMChannelSDK,
        mockXRPChannelManager,
        mockXRPClaimSigner,
        mockSettlementMonitor,
        mockAccountManager,
        mockLogger
      );

      executorIncomplete.start();

      const event: SettlementRequiredEvent = {
        peerId: 'peer-incomplete',
        balance: '1000000000',
        tokenId: 'XRP',
        timestamp: Date.now(),
      };

      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];

      await expect(handler(event)).rejects.toThrow('missing xrpAddress');

      executorIncomplete.stop();
    });
  });

  describe('TigerBeetle Integration', () => {
    it('should update TigerBeetle accounts after successful EVM settlement', async () => {
      executor.start();

      const event: SettlementRequiredEvent = {
        peerId: 'peer-alice',
        balance: '1000000000',
        tokenId: '0xUSDCAddress',
        timestamp: Date.now(),
      };

      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      await handler(event);

      expect(mockAccountManager.recordSettlement).toHaveBeenCalledWith(
        'peer-alice',
        '0xUSDCAddress',
        BigInt('1000000000')
      );
    });

    it('should update TigerBeetle accounts after successful XRP settlement', async () => {
      executor.start();

      const event: SettlementRequiredEvent = {
        peerId: 'peer-bob',
        balance: '5000000000',
        tokenId: 'XRP',
        timestamp: Date.now(),
      };

      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      await handler(event);

      expect(mockAccountManager.recordSettlement).toHaveBeenCalledWith(
        'peer-bob',
        'XRP',
        BigInt('5000000000')
      );
    });

    it('should not update TigerBeetle accounts if settlement fails', async () => {
      // Mock EVM channel SDK to fail
      mockEVMChannelSDK.openChannel.mockRejectedValueOnce(new Error('Blockchain error'));

      executor.start();

      const event: SettlementRequiredEvent = {
        peerId: 'peer-alice',
        balance: '1000000000',
        tokenId: '0xUSDCAddress',
        timestamp: Date.now(),
      };

      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];

      await expect(handler(event)).rejects.toThrow('Blockchain error');

      // recordSettlement should NOT be called
      expect(mockAccountManager.recordSettlement).not.toHaveBeenCalled();
    });
  });

  describe('Logging', () => {
    it('should log settlement request details', async () => {
      executor.start();

      const event: SettlementRequiredEvent = {
        peerId: 'peer-alice',
        balance: '1000000000',
        tokenId: '0xUSDCAddress',
        timestamp: Date.now(),
      };

      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      await handler(event);

      expect(mockLogger.info).toHaveBeenCalledWith(
        { peerId: 'peer-alice', balance: '1000000000', tokenId: '0xUSDCAddress' },
        'Handling settlement request...'
      );
    });

    it('should log settlement completion', async () => {
      executor.start();

      const event: SettlementRequiredEvent = {
        peerId: 'peer-alice',
        balance: '1000000000',
        tokenId: '0xUSDCAddress',
        timestamp: Date.now(),
      };

      const handler = (mockSettlementMonitor.on as jest.Mock).mock.calls[0][1];
      await handler(event);

      expect(mockLogger.info).toHaveBeenCalledWith(
        { peerId: 'peer-alice', balance: '1000000000', tokenId: '0xUSDCAddress' },
        'Settlement completed successfully'
      );
    });
  });
});
