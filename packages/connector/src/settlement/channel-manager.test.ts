/**
 * Unit tests for ChannelManager
 * Tests channel lifecycle management with mocked dependencies
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { ChannelManager } from './channel-manager';
import { ChannelManagerConfig } from './channel-manager-types';
import { PaymentChannelSDK } from './payment-channel-sdk';
import { SettlementExecutor } from './settlement-executor';
import pino from 'pino';

// Mock dependencies
jest.mock('./payment-channel-sdk');
jest.mock('./settlement-executor');

describe('ChannelManager', () => {
  let channelManager: ChannelManager;
  let mockConfig: ChannelManagerConfig;
  let mockSDK: jest.Mocked<PaymentChannelSDK>;
  let mockSettlementExecutor: jest.Mocked<SettlementExecutor>;
  let logger: pino.Logger;

  beforeEach(() => {
    // Create silent logger for tests
    logger = pino({ level: 'silent' });

    // Mock config
    mockConfig = {
      enabled: true,
      initialDepositMultiplier: 10,
      minDepositThreshold: 0.5,
      idleChannelThresholdMs: 86400000, // 24 hours
      closeIdleChannels: true,
      disputeTimeoutMs: 300000, // 5 minutes
      depositMonitoringIntervalMs: 300000, // 5 minutes
    };

    // Create mocks
    mockSDK = {} as jest.Mocked<PaymentChannelSDK>;
    mockSettlementExecutor = {} as jest.Mocked<SettlementExecutor>;

    // Create ChannelManager instance
    channelManager = new ChannelManager(mockConfig, mockSettlementExecutor, mockSDK, logger);
  });

  describe('trackChannel', () => {
    it('should add channel to registry and peer index', () => {
      const channelId = '0xabc123';
      const peerId = 'peer-a';
      const tokenAddress = '0xtoken';
      const initialDeposit = 10000n;

      channelManager.trackChannel(channelId, peerId, tokenAddress, initialDeposit);

      const channelInfo = channelManager.getChannelInfo(channelId);
      expect(channelInfo).toBeDefined();
      expect(channelInfo?.channelId).toBe(channelId);
      expect(channelInfo?.peerId).toBe(peerId);
      expect(channelInfo?.status).toBe('active');

      const peerChannels = channelManager.getChannelsForPeer(peerId);
      expect(peerChannels).toHaveLength(1);
      expect(peerChannels[0]?.channelId).toBe(channelId);
    });

    it('should set initial timestamps correctly', () => {
      const channelId = '0xabc123';
      const peerId = 'peer-a';
      const tokenAddress = '0xtoken';
      const initialDeposit = 10000n;

      const before = Date.now();
      channelManager.trackChannel(channelId, peerId, tokenAddress, initialDeposit);
      const after = Date.now();

      const channelInfo = channelManager.getChannelInfo(channelId);
      expect(channelInfo?.openedAt).toBeGreaterThanOrEqual(before);
      expect(channelInfo?.openedAt).toBeLessThanOrEqual(after);
      expect(channelInfo?.lastActivityAt).toBeGreaterThanOrEqual(before);
      expect(channelInfo?.lastActivityAt).toBeLessThanOrEqual(after);
    });
  });

  describe('shouldOpenChannel', () => {
    it('should return true when no active channel exists', () => {
      const peerId = 'peer-a';
      const tokenAddress = '0xtoken';

      const result = channelManager.shouldOpenChannel(peerId, tokenAddress);

      expect(result).toBe(true);
    });

    it('should return false when active channel exists', () => {
      const channelId = '0xabc123';
      const peerId = 'peer-a';
      const tokenAddress = '0xtoken';
      const initialDeposit = 10000n;

      channelManager.trackChannel(channelId, peerId, tokenAddress, initialDeposit);

      const result = channelManager.shouldOpenChannel(peerId, tokenAddress);

      expect(result).toBe(false);
    });

    it('should return true for different token even with existing channel', () => {
      const channelId = '0xabc123';
      const peerId = 'peer-a';
      const tokenAddress1 = '0xtoken1';
      const tokenAddress2 = '0xtoken2';
      const initialDeposit = 10000n;

      channelManager.trackChannel(channelId, peerId, tokenAddress1, initialDeposit);

      const result = channelManager.shouldOpenChannel(peerId, tokenAddress2);

      expect(result).toBe(true);
    });
  });

  describe('calculateInitialDeposit', () => {
    it('should calculate deposit based on threshold and multiplier', () => {
      const peerId = 'peer-a';
      const tokenId = '0xtoken';
      const currentBalance = 500n;

      const result = channelManager.calculateInitialDeposit(peerId, tokenId, currentBalance);

      // Default threshold 1000000, multiplier 10 = 10000000
      expect(result).toBe(10000000n);
    });

    it('should ensure deposit covers current balance', () => {
      const peerId = 'peer-a';
      const tokenId = '0xtoken';
      const currentBalance = 20000000n; // Larger than threshold * multiplier

      const result = channelManager.calculateInitialDeposit(peerId, tokenId, currentBalance);

      expect(result).toBe(currentBalance);
    });
  });

  describe('updateChannelActivity', () => {
    it('should update lastActivityAt timestamp', () => {
      const channelId = '0xabc123';
      const peerId = 'peer-a';
      const tokenAddress = '0xtoken';
      const initialDeposit = 10000n;

      channelManager.trackChannel(channelId, peerId, tokenAddress, initialDeposit);

      const originalTimestamp = channelManager.getChannelInfo(channelId)!.lastActivityAt;

      // Wait a bit
      const delay = (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));
      return delay(10).then(() => {
        channelManager.updateChannelActivity(channelId);

        const updatedTimestamp = channelManager.getChannelInfo(channelId)!.lastActivityAt;
        expect(updatedTimestamp).toBeGreaterThan(originalTimestamp);
      });
    });
  });

  describe('getChannelsForPeer', () => {
    it('should return all channels for a peer', () => {
      const peerId = 'peer-a';
      const channelId1 = '0xabc123';
      const channelId2 = '0xdef456';
      const tokenAddress = '0xtoken';
      const initialDeposit = 10000n;

      channelManager.trackChannel(channelId1, peerId, tokenAddress, initialDeposit);
      channelManager.trackChannel(channelId2, peerId, tokenAddress, initialDeposit);

      const channels = channelManager.getChannelsForPeer(peerId);

      expect(channels).toHaveLength(2);
      expect(channels.map((c) => c.channelId)).toContain(channelId1);
      expect(channels.map((c) => c.channelId)).toContain(channelId2);
    });

    it('should return empty array for unknown peer', () => {
      const channels = channelManager.getChannelsForPeer('unknown-peer');

      expect(channels).toEqual([]);
    });
  });

  describe('getAllChannels', () => {
    it('should return all tracked channels', () => {
      const peerId1 = 'peer-a';
      const peerId2 = 'peer-b';
      const channelId1 = '0xabc123';
      const channelId2 = '0xdef456';
      const tokenAddress = '0xtoken';
      const initialDeposit = 10000n;

      channelManager.trackChannel(channelId1, peerId1, tokenAddress, initialDeposit);
      channelManager.trackChannel(channelId2, peerId2, tokenAddress, initialDeposit);

      const channels = channelManager.getAllChannels();

      expect(channels).toHaveLength(2);
    });
  });

  describe('monitorDepositLevels', () => {
    it('should trigger top-up when deposit below threshold', async () => {
      // Create spy functions
      const getChannelStateSpy = jest.fn().mockResolvedValue({
        myDeposit: 4000n, // Below 50% of initial 10000n
      } as never);
      const depositSpy = jest.fn() as jest.Mock;

      // Assign spies to mockSDK
      (mockSDK as any).getChannelState = getChannelStateSpy;
      (mockSDK as any).deposit = depositSpy;

      const channelId = '0xabc123';
      const peerId = 'peer-a';
      const tokenAddress = '0xtoken';
      const initialDeposit = 10000n;

      channelManager.trackChannel(channelId, peerId, tokenAddress, initialDeposit);

      // Access private method via type assertion
      await (channelManager as any)['monitorDepositLevels']();

      expect(depositSpy).toHaveBeenCalledWith(channelId, 6000n); // Top up to restore initial
    });

    it('should not top-up when deposit above threshold', async () => {
      const getChannelStateSpy = jest.fn().mockResolvedValue({
        myDeposit: 8000n, // Above 50% threshold
      } as never);
      const depositSpy = jest.fn();

      (mockSDK as any).getChannelState = getChannelStateSpy;
      (mockSDK as any).deposit = depositSpy;

      const channelId = '0xabc123';
      const peerId = 'peer-a';
      const tokenAddress = '0xtoken';
      const initialDeposit = 10000n;

      channelManager.trackChannel(channelId, peerId, tokenAddress, initialDeposit);

      await (channelManager as any)['monitorDepositLevels']();

      expect(depositSpy).not.toHaveBeenCalled();
    });
  });

  describe('detectIdleChannels', () => {
    it('should identify idle channels', async () => {
      const channelId = '0xabc123';
      const peerId = 'peer-a';
      const tokenAddress = '0xtoken';
      const initialDeposit = 10000n;

      channelManager.trackChannel(channelId, peerId, tokenAddress, initialDeposit);

      // Manually set lastActivityAt to 25 hours ago
      const channelInfo = channelManager.getChannelInfo(channelId);
      if (channelInfo) {
        channelInfo.lastActivityAt = Date.now() - 25 * 60 * 60 * 1000;
      }

      const idleChannels = await (channelManager as any)['detectIdleChannels']();

      expect(idleChannels).toHaveLength(1);
      expect(idleChannels[0]?.channelId).toBe(channelId);
    });

    it('should skip active channels', async () => {
      const channelId = '0xabc123';
      const peerId = 'peer-a';
      const tokenAddress = '0xtoken';
      const initialDeposit = 10000n;

      channelManager.trackChannel(channelId, peerId, tokenAddress, initialDeposit);

      // lastActivityAt is recent (within 24 hours)
      const idleChannels = await (channelManager as any)['detectIdleChannels']();

      expect(idleChannels).toHaveLength(0);
    });

    it('should skip closing channels', async () => {
      const channelId = '0xabc123';
      const peerId = 'peer-a';
      const tokenAddress = '0xtoken';
      const initialDeposit = 10000n;

      channelManager.trackChannel(channelId, peerId, tokenAddress, initialDeposit);

      // Set channel to closing status and old lastActivityAt
      const channelInfo = channelManager.getChannelInfo(channelId);
      if (channelInfo) {
        channelInfo.lastActivityAt = Date.now() - 25 * 60 * 60 * 1000;
        channelInfo.status = 'closing';
      }

      const idleChannels = await (channelManager as any)['detectIdleChannels']();

      expect(idleChannels).toHaveLength(0);
    });
  });

  describe('closeIdleChannel', () => {
    it('should initiate closure for idle channel', async () => {
      const closeChannelSpy = jest.fn() as jest.Mock;
      (mockSDK as any).closeChannel = closeChannelSpy;

      const channelId = '0xabc123';
      const peerId = 'peer-a';
      const tokenAddress = '0xtoken';
      const initialDeposit = 10000n;

      channelManager.trackChannel(channelId, peerId, tokenAddress, initialDeposit);

      const channelInfo = channelManager.getChannelInfo(channelId);
      if (channelInfo) {
        channelInfo.lastActivityAt = Date.now() - 25 * 60 * 60 * 1000;
      }

      await (channelManager as any)['closeIdleChannel'](channelInfo);

      expect(channelInfo?.status).toBe('closing');
      expect(closeChannelSpy).toHaveBeenCalled();
    });

    it('should skip closure if channel no longer idle', async () => {
      const closeChannelSpy = jest.fn();
      (mockSDK as any).closeChannel = closeChannelSpy;

      const channelId = '0xabc123';
      const peerId = 'peer-a';
      const tokenAddress = '0xtoken';
      const initialDeposit = 10000n;

      channelManager.trackChannel(channelId, peerId, tokenAddress, initialDeposit);

      const channelInfo = channelManager.getChannelInfo(channelId);

      // Channel is recent (not idle)
      await (channelManager as any)['closeIdleChannel'](channelInfo);

      expect(closeChannelSpy).not.toHaveBeenCalled();
    });
  });

  describe('handleDisputedClosure', () => {
    it('should initiate unilateral close', async () => {
      const closeChannelSpy = jest.fn() as jest.Mock;
      (mockSDK as any).closeChannel = closeChannelSpy;

      const channelId = '0xabc123';
      const peerId = 'peer-a';
      const tokenAddress = '0xtoken';
      const initialDeposit = 10000n;

      channelManager.trackChannel(channelId, peerId, tokenAddress, initialDeposit);

      const channelInfo = channelManager.getChannelInfo(channelId);

      await (channelManager as any)['handleDisputedClosure'](channelInfo);

      expect(channelInfo?.status).toBe('closing');
      expect(channelInfo?.closedAt).toBeDefined();
      expect(closeChannelSpy).toHaveBeenCalledWith(
        channelId,
        expect.objectContaining({
          channelId,
          nonce: 0,
          transferredAmount: 0n,
          lockedAmount: 0n,
        }),
        '0x'
      );
    });
  });

  describe('monitorDepositLevels error handling', () => {
    it('should handle getChannelState errors gracefully', async () => {
      const getChannelStateSpy = jest
        .fn<() => Promise<never>>()
        .mockRejectedValue(new Error('RPC connection error'));
      (mockSDK as any).getChannelState = getChannelStateSpy;

      const channelId = '0xabc123';
      const peerId = 'peer-a';
      const tokenAddress = '0xtoken';
      const initialDeposit = 10000n;

      channelManager.trackChannel(channelId, peerId, tokenAddress, initialDeposit);

      // Should not throw
      await expect((channelManager as any)['monitorDepositLevels']()).resolves.not.toThrow();
    });

    it('should handle deposit errors and continue monitoring', async () => {
      const getChannelStateSpy = jest
        .fn<() => Promise<{ myDeposit: bigint }>>()
        .mockResolvedValue({ myDeposit: 4000n });
      const depositSpy = jest
        .fn<() => Promise<never>>()
        .mockRejectedValue(new Error('Insufficient gas'));

      (mockSDK as any).getChannelState = getChannelStateSpy;
      (mockSDK as any).deposit = depositSpy;

      const channelId = '0xabc123';
      const peerId = 'peer-a';
      const tokenAddress = '0xtoken';
      const initialDeposit = 10000n;

      channelManager.trackChannel(channelId, peerId, tokenAddress, initialDeposit);

      // Should not throw, error logged but monitoring continues
      await expect((channelManager as any)['monitorDepositLevels']()).resolves.not.toThrow();
    });
  });

  describe('topUpChannel error handling', () => {
    it('should handle SDK deposit failures', async () => {
      const depositSpy = jest
        .fn<() => Promise<never>>()
        .mockRejectedValue(new Error('Transaction failed'));
      (mockSDK as any).deposit = depositSpy;

      const channelId = '0xabc123';
      const peerId = 'peer-a';
      const tokenAddress = '0xtoken';
      const initialDeposit = 10000n;

      channelManager.trackChannel(channelId, peerId, tokenAddress, initialDeposit);
      const channelInfo = channelManager.getChannelInfo(channelId)!;

      await expect(
        (channelManager as any)['topUpChannel'](channelId, channelInfo, 5000n)
      ).rejects.toThrow('Transaction failed');
    });
  });

  describe('checkIdleChannels error handling', () => {
    it('should handle closeIdleChannel errors gracefully', async () => {
      const closeChannelSpy = jest
        .fn<() => Promise<never>>()
        .mockRejectedValue(new Error('Close failed'));
      (mockSDK as any).closeChannel = closeChannelSpy;

      const channelId = '0xabc123';
      const peerId = 'peer-a';
      const tokenAddress = '0xtoken';
      const initialDeposit = 10000n;

      channelManager.trackChannel(channelId, peerId, tokenAddress, initialDeposit);

      const channelInfo = channelManager.getChannelInfo(channelId);
      if (channelInfo) {
        channelInfo.lastActivityAt = Date.now() - 25 * 60 * 60 * 1000;
      }

      // Should not throw, continues with other channels
      await expect((channelManager as any)['checkIdleChannels']()).resolves.not.toThrow();
    });
  });

  describe('start and stop lifecycle', () => {
    it('should start monitoring intervals', () => {
      channelManager.start();

      // Access private fields to verify intervals started
      const depositInterval = (channelManager as any)['depositMonitorInterval'];
      const idleInterval = (channelManager as any)['idleDetectionInterval'];

      expect(depositInterval).toBeDefined();
      expect(idleInterval).toBeDefined();

      // Cleanup
      channelManager.stop();
    });

    it('should stop monitoring intervals', () => {
      channelManager.start();

      const depositInterval = (channelManager as any)['depositMonitorInterval'];
      const idleInterval = (channelManager as any)['idleDetectionInterval'];

      expect(depositInterval).toBeDefined();
      expect(idleInterval).toBeDefined();

      channelManager.stop();

      // Intervals should be cleared
      const depositIntervalAfter = (channelManager as any)['depositMonitorInterval'];
      const idleIntervalAfter = (channelManager as any)['idleDetectionInterval'];

      expect(depositIntervalAfter).toBeUndefined();
      expect(idleIntervalAfter).toBeUndefined();
    });

    it('should handle stop when not started', () => {
      // Should not throw
      expect(() => channelManager.stop()).not.toThrow();
    });
  });

  describe('token-specific multiplier overrides', () => {
    it('should use token-specific multiplier when configured', () => {
      const configWithOverrides: ChannelManagerConfig = {
        ...mockConfig,
        tokenOverrides: {
          '0xUSDC': { initialDepositMultiplier: 5 },
        },
      };

      const managerWithOverrides = new ChannelManager(
        configWithOverrides,
        mockSettlementExecutor,
        mockSDK,
        logger
      );

      const peerId = 'peer-a';
      const tokenId = '0xUSDC';
      const currentBalance = 500n;

      const result = managerWithOverrides.calculateInitialDeposit(peerId, tokenId, currentBalance);

      // Should use override multiplier of 5 instead of default 10
      // Default threshold 1000000 * 5 = 5000000
      expect(result).toBe(5000000n);
    });

    it('should fallback to default multiplier for unconfigured tokens', () => {
      const configWithOverrides: ChannelManagerConfig = {
        ...mockConfig,
        tokenOverrides: {
          '0xUSDC': { initialDepositMultiplier: 5 },
        },
      };

      const managerWithOverrides = new ChannelManager(
        configWithOverrides,
        mockSettlementExecutor,
        mockSDK,
        logger
      );

      const peerId = 'peer-a';
      const tokenId = '0xETH'; // Not in overrides
      const currentBalance = 500n;

      const result = managerWithOverrides.calculateInitialDeposit(peerId, tokenId, currentBalance);

      // Should use default multiplier of 10
      expect(result).toBe(10000000n);
    });
  });

  describe('telemetry emission', () => {
    it('should emit telemetry on initial deposit calculation', () => {
      const mockTelemetryEmitter = {
        emit: jest.fn(),
      };

      const managerWithTelemetry = new ChannelManager(
        mockConfig,
        mockSettlementExecutor,
        mockSDK,
        logger,
        mockTelemetryEmitter as any
      );

      const peerId = 'peer-a';
      const tokenId = '0xtoken';
      const currentBalance = 500n;

      managerWithTelemetry.calculateInitialDeposit(peerId, tokenId, currentBalance);

      expect(mockTelemetryEmitter.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'INITIAL_DEPOSIT_CALCULATED',
        })
      );
    });

    it('should handle telemetry errors gracefully', () => {
      const mockTelemetryEmitter = {
        emit: jest.fn().mockImplementation(() => {
          throw new Error('Telemetry service unavailable');
        }),
      };

      const managerWithTelemetry = new ChannelManager(
        mockConfig,
        mockSettlementExecutor,
        mockSDK,
        logger,
        mockTelemetryEmitter as any
      );

      const peerId = 'peer-a';
      const tokenId = '0xtoken';
      const currentBalance = 500n;

      // Should not throw even if telemetry fails
      expect(() =>
        managerWithTelemetry.calculateInitialDeposit(peerId, tokenId, currentBalance)
      ).not.toThrow();
    });
  });

  describe('calculateInitialDeposit edge cases', () => {
    it('should cap deposit at 100x threshold', () => {
      const peerId = 'peer-a';
      const tokenId = '0xtoken';
      const currentBalance = 5000000000n; // Very large balance

      const result = channelManager.calculateInitialDeposit(peerId, tokenId, currentBalance);

      // Should cap at 100 * threshold (100 * 1000000 = 100000000)
      expect(result).toBe(100000000n);
    });

    it('should handle zero current balance', () => {
      const peerId = 'peer-a';
      const tokenId = '0xtoken';
      const currentBalance = 0n;

      const result = channelManager.calculateInitialDeposit(peerId, tokenId, currentBalance);

      // Should use threshold * multiplier
      expect(result).toBe(10000000n);
    });
  });

  describe('getChannelInfo edge cases', () => {
    it('should return undefined for non-existent channel', () => {
      const result = channelManager.getChannelInfo('0xnonexistent');

      expect(result).toBeUndefined();
    });
  });

  describe('closeIdleChannels config check', () => {
    it('should skip closure when closeIdleChannels is false', async () => {
      const configNoAutoClose: ChannelManagerConfig = {
        ...mockConfig,
        closeIdleChannels: false,
      };

      const managerNoAutoClose = new ChannelManager(
        configNoAutoClose,
        mockSettlementExecutor,
        mockSDK,
        logger
      );

      const closeChannelSpy = jest.fn();
      (mockSDK as any).closeChannel = closeChannelSpy;

      const channelId = '0xabc123';
      const peerId = 'peer-a';
      const tokenAddress = '0xtoken';
      const initialDeposit = 10000n;

      managerNoAutoClose.trackChannel(channelId, peerId, tokenAddress, initialDeposit);

      const channelInfo = managerNoAutoClose.getChannelInfo(channelId);
      if (channelInfo) {
        channelInfo.lastActivityAt = Date.now() - 25 * 60 * 60 * 1000;
      }

      await (managerNoAutoClose as any)['checkIdleChannels']();

      // Should NOT close channel when closeIdleChannels is false
      expect(closeChannelSpy).not.toHaveBeenCalled();
    });
  });
});
