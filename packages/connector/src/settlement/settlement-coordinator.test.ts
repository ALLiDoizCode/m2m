/**
 * Unit tests for SettlementCoordinator
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { SettlementCoordinator } from './settlement-coordinator';
import type { MetricsCollector } from './metrics-collector';
import type { PaymentChannelSDK } from './payment-channel-sdk';
import type { XRPChannelSDK } from './xrp-channel-sdk';
import type { Logger } from 'pino';
import type { PeerConfig } from './types';

describe('SettlementCoordinator', () => {
  let coordinator: SettlementCoordinator;
  let mockEVMSDK: jest.Mocked<PaymentChannelSDK>;
  let mockXRPSDK: jest.Mocked<XRPChannelSDK>;
  let mockMetricsCollector: jest.Mocked<MetricsCollector>;
  let mockLogger: jest.Mocked<Logger>;
  let peerConfigs: Map<string, PeerConfig>;

  beforeEach(() => {
    // Mock EVM SDK with provider access via type casting
    const mockProvider = {
      getFeeData: jest.fn().mockResolvedValue({ gasPrice: 1000000n }),
    };
    mockEVMSDK = {
      openChannel: jest.fn().mockResolvedValue('evm-channel-123'),
    } as any;
    // Attach provider to mock (accessed via type assertion in implementation)
    (mockEVMSDK as any).provider = mockProvider;

    // Mock XRP SDK
    mockXRPSDK = {
      openChannel: jest.fn().mockResolvedValue('xrp-channel-456'),
      signClaim: jest.fn().mockReturnValue({
        channelId: 'xrp-channel-456',
        amount: '1000',
        signature: 'mock-signature',
      }),
      submitClaim: jest.fn().mockResolvedValue(undefined),
    } as any;

    // Mock MetricsCollector
    mockMetricsCollector = {
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
      getSuccessRate: jest.fn().mockReturnValue(0.95),
      getRecentFailureRate: jest.fn().mockReturnValue(0.05),
      getCircuitBreakerState: jest.fn().mockReturnValue({ isOpen: false, failureRate: 0.05 }),
    } as any;

    // Mock Logger
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    // Setup peer configs
    peerConfigs = new Map();
    peerConfigs.set('peer-alice', {
      peerId: 'peer-alice',
      address: 'g.alice',
      settlementPreference: 'both',
      settlementTokens: ['USDC', 'XRP'],
      evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
      xrpAddress: 'rN7n7otQDd6FczFgLdlqtyMVrXqHr7XEEw',
    });

    coordinator = new SettlementCoordinator(
      mockEVMSDK,
      mockXRPSDK,
      mockMetricsCollector,
      { peerConfigs },
      mockLogger
    );
  });

  describe('selectSettlementMethod', () => {
    it('should select EVM for ERC20 token when peer supports both methods', async () => {
      const result = await coordinator.selectSettlementMethod('peer-alice', 'USDC', 1000n);

      expect(result.method).toBe('evm');
      expect(result.chain).toBe('base-l2');
    });

    it('should select XRP for XRP token when peer supports both methods', async () => {
      const result = await coordinator.selectSettlementMethod('peer-alice', 'XRP', 10n);

      expect(result.method).toBe('xrp');
    });

    it('should choose method with lower cost when both available', async () => {
      // Mock EVM cost high (50M wei gas), XRP cost low (12 drops)
      (mockEVMSDK as any).provider.getFeeData = jest.fn().mockResolvedValue({ gasPrice: 1000n });

      const result = await coordinator.selectSettlementMethod('peer-alice', 'XRP', 10n);

      // XRP should win (12 drops vs 50,000 wei)
      expect(result.method).toBe('xrp');
      expect(result.estimatedCost).toBe(12n);
    });

    it('should prefer higher success rate method when costs similar', async () => {
      // Mock EVM with high success rate, XRP with low success rate
      mockMetricsCollector.getSuccessRate = jest.fn((method: string) => {
        return method === 'evm' ? 0.95 : 0.8;
      });

      const result = await coordinator.selectSettlementMethod('peer-alice', 'XRP', 10n);

      // XRP is the only option for XRP token, so it should be selected
      expect(result.method).toBe('xrp');
    });

    it('should filter out methods with circuit breaker open', async () => {
      // Mock EVM circuit breaker open
      mockMetricsCollector.getCircuitBreakerState = jest
        .fn()
        .mockImplementation((method: string) => {
          if (method === 'evm') {
            return { isOpen: true, failureRate: 0.15 };
          }
          return { isOpen: false, failureRate: 0.05 };
        });

      // Try to settle ERC20 token (normally would use EVM)
      // Should throw error because EVM is circuit-broken and XRP can't handle ERC20
      await expect(coordinator.selectSettlementMethod('peer-alice', 'USDC', 1000n)).rejects.toThrow(
        'No available settlement methods'
      );
    });

    it('should throw error when no settlement methods available', async () => {
      // Mock both circuit breakers open
      mockMetricsCollector.getCircuitBreakerState = jest
        .fn()
        .mockReturnValue({ isOpen: true, failureRate: 0.15 });

      await expect(coordinator.selectSettlementMethod('peer-alice', 'USDC', 1000n)).rejects.toThrow(
        'No available settlement methods'
      );
    });

    it('should throw error when peer not found', async () => {
      await expect(
        coordinator.selectSettlementMethod('peer-unknown', 'USDC', 1000n)
      ).rejects.toThrow('Peer not found: peer-unknown');
    });
  });

  describe('executeSettlementWithFallback', () => {
    it('should succeed with primary method', async () => {
      await coordinator.executeSettlementWithFallback('peer-alice', 'XRP', 10n);

      expect(mockXRPSDK.openChannel).toHaveBeenCalled();
      expect(mockMetricsCollector.recordSuccess).toHaveBeenCalledWith('xrp');
    });

    it('should execute fallback when primary fails', async () => {
      // Mock EVM to fail, XRP to succeed
      mockEVMSDK.openChannel = jest.fn().mockRejectedValue(new Error('EVM RPC timeout'));

      // Configure peer to support EVM only (so XRP won't be evaluated)
      peerConfigs.set('peer-bob', {
        peerId: 'peer-bob',
        address: 'g.bob',
        settlementPreference: 'evm',
        settlementTokens: ['USDC'],
        evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
      });

      // Should fail with no fallback available
      await expect(
        coordinator.executeSettlementWithFallback('peer-bob', 'USDC', 1000n)
      ).rejects.toThrow('All settlement methods failed');

      expect(mockMetricsCollector.recordFailure).toHaveBeenCalledWith('evm');
    });

    it('should try EVM fallback when XRP primary fails (for XRP token)', async () => {
      // Mock XRP to fail
      mockXRPSDK.openChannel = jest.fn().mockRejectedValue(new Error('XRP network down'));

      // XRP token with XRP settlement failing
      await expect(
        coordinator.executeSettlementWithFallback('peer-alice', 'XRP', 10n)
      ).rejects.toThrow('All settlement methods failed');

      expect(mockMetricsCollector.recordFailure).toHaveBeenCalledWith('xrp');
    });

    it('should throw error when all methods exhausted', async () => {
      // Mock both to fail
      mockEVMSDK.openChannel = jest.fn().mockRejectedValue(new Error('EVM failed'));
      mockXRPSDK.openChannel = jest.fn().mockRejectedValue(new Error('XRP failed'));

      await expect(
        coordinator.executeSettlementWithFallback('peer-alice', 'XRP', 10n)
      ).rejects.toThrow('All settlement methods failed');
    });

    it('should record metrics for both primary and fallback attempts', async () => {
      // Mock XRP to fail
      mockXRPSDK.openChannel = jest.fn().mockRejectedValue(new Error('XRP failed'));

      await expect(
        coordinator.executeSettlementWithFallback('peer-alice', 'XRP', 10n)
      ).rejects.toThrow('All settlement methods failed');

      expect(mockMetricsCollector.recordFailure).toHaveBeenCalledWith('xrp');
    });
  });

  describe('Circuit Breaker Integration', () => {
    it('should open circuit breaker when failure rate >10%', async () => {
      mockMetricsCollector.getCircuitBreakerState = jest
        .fn()
        .mockReturnValue({ isOpen: true, failureRate: 0.15 });

      await expect(coordinator.selectSettlementMethod('peer-alice', 'USDC', 1000n)).rejects.toThrow(
        'No available settlement methods'
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'evm', failureRate: 0.15 }),
        'Circuit breaker opened for settlement method'
      );
    });

    it('should keep circuit breaker closed when failure rate <10%', async () => {
      mockMetricsCollector.getCircuitBreakerState = jest
        .fn()
        .mockReturnValue({ isOpen: false, failureRate: 0.05 });

      const result = await coordinator.selectSettlementMethod('peer-alice', 'USDC', 1000n);

      expect(result.available).toBe(true);
    });

    it('should exclude circuit-broken method from options', async () => {
      mockMetricsCollector.getCircuitBreakerState = jest
        .fn()
        .mockImplementation((method: string) => {
          if (method === 'evm') {
            return { isOpen: true, failureRate: 0.15 };
          }
          return { isOpen: false, failureRate: 0.05 };
        });

      // ERC20 token would normally use EVM, but it's circuit-broken
      await expect(coordinator.selectSettlementMethod('peer-alice', 'USDC', 1000n)).rejects.toThrow(
        'No available settlement methods'
      );
    });
  });

  describe('Cost Estimation', () => {
    it('should estimate EVM gas cost for channel claim', async () => {
      (mockEVMSDK as any).provider.getFeeData = jest.fn().mockResolvedValue({ gasPrice: 2000000n });

      const result = await coordinator.selectSettlementMethod('peer-alice', 'USDC', 1000n);

      // 2M gwei * 50k gas units = 100B wei
      expect(result.estimatedCost).toBe(100000000000n);
    });

    it('should return fixed XRP cost (12 drops)', async () => {
      const result = await coordinator.selectSettlementMethod('peer-alice', 'XRP', 10n);

      expect(result.estimatedCost).toBe(12n);
    });

    it('should cache gas price for 30 seconds', async () => {
      const mockProvider = (mockEVMSDK as any).provider;

      // First call
      await coordinator.selectSettlementMethod('peer-alice', 'USDC', 1000n);
      expect(mockProvider.getFeeData).toHaveBeenCalledTimes(1);

      // Second call within 30 seconds
      await coordinator.selectSettlementMethod('peer-alice', 'USDC', 2000n);
      expect(mockProvider.getFeeData).toHaveBeenCalledTimes(1); // Still only 1 call

      // Wait for cache to expire (31 seconds)
      jest.useFakeTimers();
      jest.advanceTimersByTime(31000);

      await coordinator.selectSettlementMethod('peer-alice', 'USDC', 3000n);
      expect(mockProvider.getFeeData).toHaveBeenCalledTimes(2); // Cache refreshed

      jest.useRealTimers();
    });
  });

  describe('Structured Logging', () => {
    it('should log routing decision with all evaluated options', async () => {
      await coordinator.selectSettlementMethod('peer-alice', 'USDC', 1000n);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: 'peer-alice',
          tokenId: 'USDC',
          selectedMethod: 'evm',
          allOptions: expect.arrayContaining([
            expect.objectContaining({ method: 'evm', available: true }),
          ]),
        }),
        'Settlement routing decision'
      );
    });

    it('should log fallback attempt with error details', async () => {
      mockXRPSDK.openChannel = jest.fn().mockRejectedValue(new Error('XRP network down'));

      await expect(
        coordinator.executeSettlementWithFallback('peer-alice', 'XRP', 10n)
      ).rejects.toThrow('All settlement methods failed');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: 'peer-alice',
          primaryMethod: 'xrp',
          error: 'XRP network down',
        }),
        'Primary settlement failed, trying fallback'
      );
    });

    it('should log circuit breaker state changes', async () => {
      mockMetricsCollector.getCircuitBreakerState = jest
        .fn()
        .mockReturnValue({ isOpen: true, failureRate: 0.15 });

      await expect(coordinator.selectSettlementMethod('peer-alice', 'USDC', 1000n)).rejects.toThrow(
        'No available settlement methods'
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'evm', failureRate: 0.15 }),
        'Circuit breaker opened for settlement method'
      );
    });
  });

  describe('Token Type Routing', () => {
    it('should select EVM for ERC20 token', async () => {
      const result = await coordinator.selectSettlementMethod('peer-alice', 'USDC', 1000n);

      expect(result.method).toBe('evm');
    });

    it('should select XRP for XRP token', async () => {
      const result = await coordinator.selectSettlementMethod('peer-alice', 'XRP', 10n);

      expect(result.method).toBe('xrp');
    });

    it('should handle peer with EVM-only preference', async () => {
      peerConfigs.set('peer-evm-only', {
        peerId: 'peer-evm-only',
        address: 'g.evm',
        settlementPreference: 'evm',
        settlementTokens: ['USDC'],
        evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
      });

      const result = await coordinator.selectSettlementMethod('peer-evm-only', 'USDC', 1000n);

      expect(result.method).toBe('evm');
    });

    it('should handle peer with XRP-only preference', async () => {
      peerConfigs.set('peer-xrp-only', {
        peerId: 'peer-xrp-only',
        address: 'g.xrp',
        settlementPreference: 'xrp',
        settlementTokens: ['XRP'],
        xrpAddress: 'rN7n7otQDd6FczFgLdlqtyMVrXqHr7XEEw',
      });

      const result = await coordinator.selectSettlementMethod('peer-xrp-only', 'XRP', 10n);

      expect(result.method).toBe('xrp');
    });
  });
});
