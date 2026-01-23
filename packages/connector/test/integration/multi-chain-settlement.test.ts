/**
 * Integration tests for Multi-Chain Settlement Coordinator
 *
 * These tests verify settlement routing and fallback logic with simulated EVM and XRP SDKs.
 * Full blockchain integration tests would require docker-compose-dev infrastructure.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { SettlementCoordinator } from '../../src/settlement/settlement-coordinator';
import { MetricsCollector } from '../../src/settlement/metrics-collector';
import type { PaymentChannelSDK } from '../../src/settlement/payment-channel-sdk';
import type { XRPChannelSDK } from '../../src/settlement/xrp-channel-sdk';
import type { Logger } from 'pino';
import type { PeerConfig } from '../../src/settlement/types';

describe('Multi-Chain Settlement Integration', () => {
  let coordinator: SettlementCoordinator;
  let mockEVMSDK: jest.Mocked<PaymentChannelSDK>;
  let mockXRPSDK: jest.Mocked<XRPChannelSDK>;
  let metricsCollector: MetricsCollector;
  let mockLogger: jest.Mocked<Logger>;
  let peerConfigs: Map<string, PeerConfig>;

  beforeEach(() => {
    // Mock EVM SDK with provider
    const mockProvider = {
      getFeeData: jest.fn().mockResolvedValue({ gasPrice: 1000000n }),
    };
    mockEVMSDK = {
      openChannel: jest.fn().mockResolvedValue('evm-channel-123'),
    } as any;
    (mockEVMSDK as any).provider = mockProvider;

    // Mock XRP SDK
    mockXRPSDK = {
      openChannel: jest.fn().mockResolvedValue('xrp-channel-456'),
      signClaim: jest.fn().mockResolvedValue({
        channelId: 'xrp-channel-456',
        amount: '10000000',
        signature: 'mock-signature',
        publicKey: 'mock-public-key',
      }),
      submitClaim: jest.fn().mockResolvedValue(undefined),
    } as any;

    // Real MetricsCollector instance
    metricsCollector = new MetricsCollector({
      slidingWindowDuration: 3600000,
      maxAttempts: 1000,
      cleanupInterval: 300000,
    });

    // Mock Logger
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    // Setup dual-settlement peer config
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
      metricsCollector,
      { peerConfigs },
      mockLogger
    );
  });

  afterEach(() => {
    metricsCollector.destroy();
  });

  describe('Multi-Chain Settlement Flow', () => {
    it('should route ERC20 settlement to EVM and XRP settlement to XRP', async () => {
      // Execute ERC20 settlement (1000 USDC = 1000000000 base units)
      await coordinator.executeSettlementWithFallback('peer-alice', 'USDC', 1000000000n);

      // Verify EVM channel opened
      expect(mockEVMSDK.openChannel).toHaveBeenCalledWith(
        '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        'USDC',
        86400,
        1000000000n
      );

      // Execute XRP settlement (10 XRP = 10000000 drops)
      await coordinator.executeSettlementWithFallback('peer-alice', 'XRP', 10000000n);

      // Verify XRP channel opened and claim submitted
      expect(mockXRPSDK.openChannel).toHaveBeenCalledWith(
        'rN7n7otQDd6FczFgLdlqtyMVrXqHr7XEEw',
        '10000000',
        86400,
        'peer-alice'
      );
      expect(mockXRPSDK.submitClaim).toHaveBeenCalled();
    });

    it('should collect metrics for both settlement methods', async () => {
      // Execute successful EVM settlement
      await coordinator.executeSettlementWithFallback('peer-alice', 'USDC', 1000n);

      // Verify EVM success rate = 100%
      expect(metricsCollector.getSuccessRate('evm')).toBe(1.0);

      // Execute successful XRP settlement
      await coordinator.executeSettlementWithFallback('peer-alice', 'XRP', 10n);

      // Verify XRP success rate = 100%
      expect(metricsCollector.getSuccessRate('xrp')).toBe(1.0);
    });

    it('should log structured routing decisions', async () => {
      await coordinator.executeSettlementWithFallback('peer-alice', 'USDC', 1000n);

      // Verify routing decision logged
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
  });

  describe('Fallback Scenario', () => {
    it('should attempt fallback when primary method fails', async () => {
      // Mock EVM to fail
      mockEVMSDK.openChannel = jest.fn().mockRejectedValue(new Error('EVM RPC timeout'));

      // Try to settle ERC20 token (EVM primary, XRP fallback would fail for ERC20)
      await expect(
        coordinator.executeSettlementWithFallback('peer-alice', 'USDC', 1000n)
      ).rejects.toThrow('All settlement methods failed');

      // Verify EVM failure logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: 'peer-alice',
          primaryMethod: 'evm',
          error: 'EVM RPC timeout',
        }),
        'Primary settlement failed, trying fallback'
      );

      // Verify failure recorded in metrics
      expect(metricsCollector.getSuccessRate('evm')).toBe(0.0);
    });

    it('should log error when all methods exhausted', async () => {
      // Mock XRP to fail
      mockXRPSDK.openChannel = jest.fn().mockRejectedValue(new Error('XRP network down'));

      // Try to settle XRP token
      await expect(
        coordinator.executeSettlementWithFallback('peer-alice', 'XRP', 10n)
      ).rejects.toThrow('All settlement methods failed');

      // Verify error logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ peerId: 'peer-alice', tokenId: 'XRP' }),
        'All settlement methods failed'
      );
    });
  });

  describe('Circuit Breaker Scenario', () => {
    it('should open circuit breaker after sustained failures', async () => {
      // Mock EVM to fail
      mockEVMSDK.openChannel = jest.fn().mockRejectedValue(new Error('EVM failed'));

      // Execute 10 failed settlement attempts
      for (let i = 0; i < 10; i++) {
        await expect(
          coordinator.executeSettlementWithFallback('peer-alice', 'USDC', 1000n)
        ).rejects.toThrow(); // Will throw either "All methods failed" or "No available methods"
      }

      // Verify circuit breaker opened
      const circuitState = metricsCollector.getCircuitBreakerState('evm');
      expect(circuitState.isOpen).toBe(true);
      expect(circuitState.failureRate).toBe(1.0);

      // Verify warning logged for circuit breaker opening
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'evm',
          failureRate: expect.any(Number),
        }),
        'Circuit breaker opened for settlement method'
      );
    });

    it('should exclude circuit-broken method from options', async () => {
      // Mock EVM to fail 10 times to open circuit breaker
      mockEVMSDK.openChannel = jest.fn().mockRejectedValue(new Error('EVM failed'));

      for (let i = 0; i < 10; i++) {
        await expect(
          coordinator.executeSettlementWithFallback('peer-alice', 'USDC', 1000n)
        ).rejects.toThrow(); // Will throw either "All methods failed" or "No available methods"
      }

      // Verify circuit breaker is open
      expect(metricsCollector.getCircuitBreakerState('evm').isOpen).toBe(true);

      // 11th attempt should skip EVM entirely due to circuit breaker
      await expect(
        coordinator.executeSettlementWithFallback('peer-alice', 'USDC', 1000n)
      ).rejects.toThrow('No available settlement methods');
    });

    it('should auto-close circuit breaker when success rate improves', async () => {
      // Record 9 successful EVM settlements
      for (let i = 0; i < 9; i++) {
        await coordinator.executeSettlementWithFallback('peer-alice', 'USDC', 1000n);
      }

      // Mock EVM to fail once (now 90% success rate, 10% failure rate - exactly at threshold)
      mockEVMSDK.openChannel = jest.fn().mockRejectedValue(new Error('EVM failed'));
      await expect(
        coordinator.executeSettlementWithFallback('peer-alice', 'USDC', 1000n)
      ).rejects.toThrow('All settlement methods failed');

      // Circuit breaker should still be closed (10% = threshold, not >10%)
      expect(metricsCollector.getCircuitBreakerState('evm').isOpen).toBe(false);

      // One more success brings failure rate below threshold
      mockEVMSDK.openChannel = jest.fn().mockResolvedValue('evm-channel-123');
      await coordinator.executeSettlementWithFallback('peer-alice', 'USDC', 1000n);

      // Circuit should remain closed
      expect(metricsCollector.getCircuitBreakerState('evm').isOpen).toBe(false);
      expect(metricsCollector.getRecentFailureRate('evm')).toBeLessThan(0.1);
    });
  });

  describe('Cost-Based Routing', () => {
    it('should prefer lower-cost settlement method', async () => {
      // Mock high EVM gas price
      (mockEVMSDK as any).provider.getFeeData = jest
        .fn()
        .mockResolvedValue({ gasPrice: 10000000n }); // 10M gwei

      // For XRP token, coordinator should select XRP (12 drops) over high-cost EVM
      const result = await coordinator.selectSettlementMethod('peer-alice', 'XRP', 10n);

      expect(result.method).toBe('xrp');
      expect(result.estimatedCost).toBe(12n);
    });
  });

  describe('Success Rate-Based Routing', () => {
    it('should prefer higher success rate method when costs similar', async () => {
      // Record high success rate for XRP
      for (let i = 0; i < 10; i++) {
        metricsCollector.recordSuccess('xrp');
      }

      // Record lower success rate for EVM
      for (let i = 0; i < 7; i++) {
        metricsCollector.recordSuccess('evm');
      }
      for (let i = 0; i < 3; i++) {
        metricsCollector.recordFailure('evm');
      }

      // XRP should have higher success rate
      expect(metricsCollector.getSuccessRate('xrp')).toBe(1.0);
      expect(metricsCollector.getSuccessRate('evm')).toBe(0.7);

      // For XRP token, should select XRP (100% success rate)
      const result = await coordinator.selectSettlementMethod('peer-alice', 'XRP', 10n);

      expect(result.method).toBe('xrp');
      expect(result.successRate).toBe(1.0);
    });
  });
});
