/**
 * Unit Tests: XRPChannelLifecycleManager
 *
 * Tests automatic XRP payment channel lifecycle management:
 * - Channel opening when settlement needed
 * - Channel funding when balance low
 * - Idle channel detection and closure
 * - Expiration-based channel closure
 * - Start/stop lifecycle manager
 */

import { XRPChannelLifecycleManager, XRPChannelLifecycleConfig } from './xrp-channel-lifecycle';
import type { XRPChannelSDK } from './xrp-channel-sdk';
import type { Logger } from 'pino';

describe('XRPChannelLifecycleManager', () => {
  let manager: XRPChannelLifecycleManager;
  let mockXRPChannelSDK: jest.Mocked<XRPChannelSDK>;
  let mockLogger: jest.Mocked<Logger>;
  let config: XRPChannelLifecycleConfig;

  beforeEach(() => {
    // Create fresh mock instances
    mockXRPChannelSDK = {
      openChannel: jest.fn().mockResolvedValue('A'.repeat(64)), // 64-char hex channel ID
      fundChannel: jest.fn().mockResolvedValue(undefined),
      closeChannel: jest.fn().mockResolvedValue(undefined),
      getChannelState: jest.fn().mockResolvedValue({
        channelId: 'A'.repeat(64),
        account: 'rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW',
        destination: 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN',
        amount: '10000000000',
        balance: '0',
        settleDelay: 86400,
        publicKey: 'ED' + 'C'.repeat(64),
        status: 'open',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    config = {
      enabled: true,
      initialChannelAmount: '10000000000', // 10,000 XRP
      defaultSettleDelay: 86400, // 24 hours
      idleChannelThreshold: 86400, // 24 hours
      minBalanceThreshold: 0.3, // 30%
      cancelAfter: 2592000, // 30 days
    };

    manager = new XRPChannelLifecycleManager(config, mockXRPChannelSDK, mockLogger);
  });

  afterEach(() => {
    // Clean up timers
    manager.stop();
  });

  describe('getOrCreateChannel', () => {
    it('should create new XRP channel for peer (AC: 3)', async () => {
      const channelId = await manager.getOrCreateChannel(
        'peer-bob',
        'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN'
      );

      expect(mockXRPChannelSDK.openChannel).toHaveBeenCalledWith(
        'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN',
        '10000000000',
        86400,
        'peer-bob'
      );
      expect(channelId).toBe('A'.repeat(64));
    });

    it('should return existing channel ID for peer (AC: 2)', async () => {
      // Create channel first
      const channelId1 = await manager.getOrCreateChannel(
        'peer-bob',
        'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN'
      );

      // Call again - should return existing channel
      const channelId2 = await manager.getOrCreateChannel(
        'peer-bob',
        'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN'
      );

      expect(mockXRPChannelSDK.openChannel).toHaveBeenCalledTimes(1); // Only called once
      expect(channelId1).toBe(channelId2);
    });

    it('should configure initial amount from config (AC: 4)', async () => {
      config.initialChannelAmount = '50000000000'; // 50,000 XRP
      manager = new XRPChannelLifecycleManager(config, mockXRPChannelSDK, mockLogger);

      await manager.getOrCreateChannel('peer-bob', 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');

      expect(mockXRPChannelSDK.openChannel).toHaveBeenCalledWith(
        expect.any(String),
        '50000000000',
        expect.any(Number),
        expect.any(String)
      );
    });
  });

  describe('updateChannelActivity', () => {
    it('should update last activity timestamp (AC: 6)', async () => {
      await manager.getOrCreateChannel('peer-bob', 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');

      const before = Date.now();
      manager.updateChannelActivity('peer-bob', '5000000000');
      const after = Date.now();

      const channel = manager.getChannelForPeer('peer-bob');
      expect(channel).toBeDefined();
      expect(channel!.lastActivityAt).toBeGreaterThanOrEqual(before);
      expect(channel!.lastActivityAt).toBeLessThanOrEqual(after);
    });

    it('should update channel balance (AC: 2)', async () => {
      await manager.getOrCreateChannel('peer-bob', 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');

      manager.updateChannelActivity('peer-bob', '5000000000');

      const channel = manager.getChannelForPeer('peer-bob');
      expect(channel!.balance).toBe('5000000000');
    });

    it('should log warning if channel not found', () => {
      manager.updateChannelActivity('peer-unknown', '5000000000');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { peerId: 'peer-unknown' },
        'Cannot update activity: channel not found'
      );
    });
  });

  describe('needsFunding', () => {
    it('should return true when balance below threshold (AC: 5)', async () => {
      await manager.getOrCreateChannel('peer-bob', 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');

      // Simulate 75% claimed (7.5k XRP out of 10k XRP)
      // Remaining: 2.5k XRP < 30% threshold (3k XRP)
      manager.updateChannelActivity('peer-bob', '7500000000');

      expect(manager.needsFunding('peer-bob')).toBe(true);
    });

    it('should return false when balance above threshold', async () => {
      await manager.getOrCreateChannel('peer-bob', 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');

      // Simulate 50% claimed (5k XRP out of 10k XRP)
      // Remaining: 5k XRP > 30% threshold (3k XRP)
      manager.updateChannelActivity('peer-bob', '5000000000');

      expect(manager.needsFunding('peer-bob')).toBe(false);
    });

    it('should return false if channel not found', () => {
      expect(manager.needsFunding('peer-unknown')).toBe(false);
    });

    it('should return false if channel status is not open', async () => {
      await manager.getOrCreateChannel('peer-bob', 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');

      // Close the channel
      await manager.closeChannel('peer-bob', 'manual');

      // Should return false because channel is closing
      expect(manager.needsFunding('peer-bob')).toBe(false);
    });
  });

  describe('fundChannel', () => {
    it('should fund channel with additional amount (AC: 5)', async () => {
      await manager.getOrCreateChannel('peer-bob', 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');

      await manager.fundChannel('peer-bob', '5000000000'); // Add 5,000 XRP

      expect(mockXRPChannelSDK.fundChannel).toHaveBeenCalledWith('A'.repeat(64), '5000000000');
    });

    it('should update tracked channel amount', async () => {
      await manager.getOrCreateChannel('peer-bob', 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');

      await manager.fundChannel('peer-bob', '5000000000');

      const channel = manager.getChannelForPeer('peer-bob');
      expect(channel!.amount).toBe('15000000000'); // 10k + 5k XRP
    });

    it('should throw error if channel not found', async () => {
      await expect(manager.fundChannel('peer-unknown', '5000000000')).rejects.toThrow(
        'Cannot fund channel: peer peer-unknown not found'
      );
    });

    it('should throw error if channel status is not open', async () => {
      await manager.getOrCreateChannel('peer-bob', 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');

      // Close the channel
      await manager.closeChannel('peer-bob', 'manual');

      // Try to fund - should throw
      await expect(manager.fundChannel('peer-bob', '5000000000')).rejects.toThrow(
        /Cannot fund channel: channel .* status is closing/
      );
    });
  });

  describe('closeChannel', () => {
    it('should close idle channel (AC: 7)', async () => {
      await manager.getOrCreateChannel('peer-bob', 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');

      await manager.closeChannel('peer-bob', 'idle');

      expect(mockXRPChannelSDK.closeChannel).toHaveBeenCalledWith('A'.repeat(64), 'peer-bob');
    });

    it('should update channel status to closing', async () => {
      await manager.getOrCreateChannel('peer-bob', 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');

      await manager.closeChannel('peer-bob', 'idle');

      const channel = manager.getChannelForPeer('peer-bob');
      expect(channel!.status).toBe('closing');
    });

    it('should not close channel if already closing', async () => {
      await manager.getOrCreateChannel('peer-bob', 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');
      await manager.closeChannel('peer-bob', 'idle');

      // Try to close again
      await manager.closeChannel('peer-bob', 'idle');

      expect(mockXRPChannelSDK.closeChannel).toHaveBeenCalledTimes(1); // Only called once
    });

    it('should log warning if channel not found', async () => {
      await manager.closeChannel('peer-unknown', 'manual');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { peerId: 'peer-unknown' },
        'Cannot close channel: not found'
      );
    });

    it('should support all closure reasons', async () => {
      // Test idle reason
      await manager.getOrCreateChannel('peer-alice', 'rAlice');
      await manager.closeChannel('peer-alice', 'idle');

      // Test expiration reason
      await manager.getOrCreateChannel('peer-bob', 'rBob');
      await manager.closeChannel('peer-bob', 'expiration');

      // Test manual reason
      await manager.getOrCreateChannel('peer-charlie', 'rCharlie');
      await manager.closeChannel('peer-charlie', 'manual');

      expect(mockXRPChannelSDK.closeChannel).toHaveBeenCalledTimes(3);
    });
  });

  describe('detectIdleChannels', () => {
    it('should close channels idle for threshold duration (AC: 6, 7)', async () => {
      // Create channel
      await manager.getOrCreateChannel('peer-bob', 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');

      // Manually set last activity to 25 hours ago (exceeds 24h threshold)
      const channel = manager.getChannelForPeer('peer-bob')!;
      channel.lastActivityAt = Date.now() - 25 * 3600 * 1000;

      // Trigger idle detection
      await manager['detectIdleChannels']();

      expect(mockXRPChannelSDK.closeChannel).toHaveBeenCalledWith('A'.repeat(64), 'peer-bob');
    });

    it('should not close active channels', async () => {
      await manager.getOrCreateChannel('peer-bob', 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');

      // Channel activity is recent (just created)
      await manager['detectIdleChannels']();

      expect(mockXRPChannelSDK.closeChannel).not.toHaveBeenCalled();
    });

    it('should skip channels that are not open', async () => {
      await manager.getOrCreateChannel('peer-bob', 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');

      // Close the channel
      await manager.closeChannel('peer-bob', 'manual');

      // Set last activity to long time ago
      const channel = manager.getChannelForPeer('peer-bob')!;
      channel.lastActivityAt = Date.now() - 48 * 3600 * 1000;

      // Clear mock call history
      mockXRPChannelSDK.closeChannel.mockClear();

      // Trigger idle detection - should not try to close again
      await manager['detectIdleChannels']();

      expect(mockXRPChannelSDK.closeChannel).not.toHaveBeenCalled();
    });
  });

  describe('detectExpiringChannels', () => {
    it('should close channels expiring within buffer time (AC: 8)', async () => {
      await manager.getOrCreateChannel('peer-bob', 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');

      // Manually set cancelAfter to 30 minutes from now (within 1 hour buffer)
      const channel = manager.getChannelForPeer('peer-bob')!;
      channel.cancelAfter = Math.floor(Date.now() / 1000) + 1800; // 30 minutes

      // Trigger expiration detection
      await manager['detectExpiringChannels']();

      expect(mockXRPChannelSDK.closeChannel).toHaveBeenCalledWith('A'.repeat(64), 'peer-bob');
    });

    it('should not close channels with sufficient time until expiration', async () => {
      await manager.getOrCreateChannel('peer-bob', 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');

      // CancelAfter already set by constructor (30 days from now)
      await manager['detectExpiringChannels']();

      expect(mockXRPChannelSDK.closeChannel).not.toHaveBeenCalled();
    });

    it('should skip channels without cancelAfter', async () => {
      // Create config without cancelAfter
      config.cancelAfter = undefined;
      manager = new XRPChannelLifecycleManager(config, mockXRPChannelSDK, mockLogger);

      await manager.getOrCreateChannel('peer-bob', 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');

      // Trigger expiration detection
      await manager['detectExpiringChannels']();

      expect(mockXRPChannelSDK.closeChannel).not.toHaveBeenCalled();
    });

    it('should skip channels that are not open', async () => {
      await manager.getOrCreateChannel('peer-bob', 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');

      // Close the channel
      await manager.closeChannel('peer-bob', 'manual');

      // Set cancelAfter to near expiration
      const channel = manager.getChannelForPeer('peer-bob')!;
      channel.cancelAfter = Math.floor(Date.now() / 1000) + 1800; // 30 minutes

      // Clear mock call history
      mockXRPChannelSDK.closeChannel.mockClear();

      // Trigger expiration detection - should not try to close again
      await manager['detectExpiringChannels']();

      expect(mockXRPChannelSDK.closeChannel).not.toHaveBeenCalled();
    });
  });

  describe('start and stop', () => {
    it('should start idle channel check timer', async () => {
      jest.useFakeTimers();

      await manager.start();

      expect(mockLogger.info).toHaveBeenCalledWith('XRP channel lifecycle manager started');

      // Verify timer is set (detectIdleChannels called periodically)
      jest.advanceTimersByTime(3600000); // 1 hour

      jest.useRealTimers();
    });

    it('should stop idle channel check timer', async () => {
      jest.useFakeTimers();

      await manager.start();
      manager.stop();

      expect(mockLogger.info).toHaveBeenCalledWith('XRP channel lifecycle manager stopped');

      // Advance time - timer should not fire
      jest.advanceTimersByTime(3600000);

      jest.useRealTimers();
    });

    it('should not start if disabled in config', async () => {
      config.enabled = false;
      manager = new XRPChannelLifecycleManager(config, mockXRPChannelSDK, mockLogger);

      await manager.start();

      expect(mockLogger.info).toHaveBeenCalledWith('XRP channel lifecycle manager disabled');
    });

    it('should call both detectIdleChannels and detectExpiringChannels on timer', async () => {
      jest.useFakeTimers();

      const detectIdleSpy = jest.spyOn(
        manager as unknown as { detectIdleChannels: () => Promise<void> },
        'detectIdleChannels'
      );
      const detectExpiringSpy = jest.spyOn(
        manager as unknown as { detectExpiringChannels: () => Promise<void> },
        'detectExpiringChannels'
      );

      await manager.start();

      // Advance time to trigger timer
      jest.advanceTimersByTime(3600000); // 1 hour

      // Wait for async callbacks
      await Promise.resolve();

      expect(detectIdleSpy).toHaveBeenCalled();
      expect(detectExpiringSpy).toHaveBeenCalled();

      jest.useRealTimers();
    });
  });

  describe('getChannelForPeer', () => {
    it('should return channel state for peer (AC: 2)', async () => {
      await manager.getOrCreateChannel('peer-bob', 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');

      const channel = manager.getChannelForPeer('peer-bob');

      expect(channel).toBeDefined();
      expect(channel!.peerId).toBe('peer-bob');
      expect(channel!.channelId).toBe('A'.repeat(64));
      expect(channel!.destination).toBe('rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN');
      expect(channel!.amount).toBe('10000000000');
      expect(channel!.balance).toBe('0');
      expect(channel!.status).toBe('open');
    });

    it('should return null if channel not found', () => {
      const channel = manager.getChannelForPeer('peer-unknown');
      expect(channel).toBeNull();
    });
  });
});
