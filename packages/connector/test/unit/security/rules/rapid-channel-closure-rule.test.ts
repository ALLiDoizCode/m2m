import { RapidChannelClosureRule } from '../../../../src/security/rules/rapid-channel-closure-rule';
import { ChannelEvent } from '../../../../src/security/fraud-detector';

describe('RapidChannelClosureRule', () => {
  let rule: RapidChannelClosureRule;
  const peerId = 'test-peer-123';

  beforeEach(() => {
    // Initialize rule with 3 closure threshold and 1-hour window
    rule = new RapidChannelClosureRule({
      maxClosures: 3,
      timeWindow: 3600000, // 1 hour
    });
  });

  afterEach(() => {
    rule.clearHistory();
  });

  describe('check', () => {
    it('should not detect fraud with single closure', async () => {
      const event: ChannelEvent = {
        type: 'channel',
        peerId,
        action: 'close',
        channelId: 'channel-1',
        timestamp: Date.now(),
      };

      const result = await rule.check(event);

      expect(result.detected).toBe(false);
    });

    it('should not detect fraud with 3 closures (at threshold)', async () => {
      const now = Date.now();

      await rule.check({
        type: 'channel',
        peerId,
        action: 'close',
        channelId: 'channel-1',
        timestamp: now - 10000,
      });

      await rule.check({
        type: 'channel',
        peerId,
        action: 'close',
        channelId: 'channel-2',
        timestamp: now - 5000,
      });

      const result = await rule.check({
        type: 'channel',
        peerId,
        action: 'close',
        channelId: 'channel-3',
        timestamp: now,
      });

      expect(result.detected).toBe(false);
    });

    it('should detect fraud with 4 closures (exceeds threshold)', async () => {
      const now = Date.now();

      await rule.check({
        type: 'channel',
        peerId,
        action: 'close',
        channelId: 'channel-1',
        timestamp: now - 15000,
      });

      await rule.check({
        type: 'channel',
        peerId,
        action: 'close',
        channelId: 'channel-2',
        timestamp: now - 10000,
      });

      await rule.check({
        type: 'channel',
        peerId,
        action: 'close',
        channelId: 'channel-3',
        timestamp: now - 5000,
      });

      const result = await rule.check({
        type: 'channel',
        peerId,
        action: 'close',
        channelId: 'channel-4',
        timestamp: now,
      });

      expect(result.detected).toBe(true);
      expect(result.peerId).toBe(peerId);
      expect(result.details?.description).toContain('Rapid channel closures detected');
      expect(result.details?.closureCount).toBe(4);
      expect(result.details?.maxClosures).toBe(3);
    });

    it('should detect fraud with 5 closures', async () => {
      const now = Date.now();

      for (let i = 0; i < 5; i++) {
        await rule.check({
          type: 'channel',
          peerId,
          action: 'close',
          channelId: `channel-${i}`,
          timestamp: now - (20000 - i * 5000),
        });
      }

      const result = await rule.check({
        type: 'channel',
        peerId,
        action: 'close',
        channelId: 'channel-5',
        timestamp: now,
      });

      expect(result.detected).toBe(true);
      expect(result.details?.closureCount).toBeGreaterThan(3);
    });

    it('should detect fraud with 10 closures', async () => {
      const now = Date.now();

      for (let i = 0; i < 10; i++) {
        await rule.check({
          type: 'channel',
          peerId,
          action: 'close',
          channelId: `channel-${i}`,
          timestamp: now - (50000 - i * 5000),
        });
      }

      const result = await rule.check({
        type: 'channel',
        peerId,
        action: 'close',
        channelId: 'channel-10',
        timestamp: now,
      });

      expect(result.detected).toBe(true);
      expect(result.details?.closureCount).toBeGreaterThan(3);
    });

    it('should ignore closures outside time window', async () => {
      const now = Date.now();

      // Old closures (outside 1-hour window)
      await rule.check({
        type: 'channel',
        peerId,
        action: 'close',
        channelId: 'channel-1',
        timestamp: now - 4000000,
      });

      await rule.check({
        type: 'channel',
        peerId,
        action: 'close',
        channelId: 'channel-2',
        timestamp: now - 3800000,
      });

      // Recent closures (within window)
      await rule.check({
        type: 'channel',
        peerId,
        action: 'close',
        channelId: 'channel-3',
        timestamp: now - 10000,
      });

      const result = await rule.check({
        type: 'channel',
        peerId,
        action: 'close',
        channelId: 'channel-4',
        timestamp: now,
      });

      // Should not detect fraud because old closures are excluded
      expect(result.detected).toBe(false);
    });

    it('should track separate histories for different peers', async () => {
      const now = Date.now();
      const peer1 = 'peer-1';
      const peer2 = 'peer-2';

      // Peer 1: Normal closure rate
      await rule.check({
        type: 'channel',
        peerId: peer1,
        action: 'close',
        channelId: 'channel-1',
        timestamp: now,
      });

      // Peer 2: Rapid closures
      for (let i = 0; i < 4; i++) {
        await rule.check({
          type: 'channel',
          peerId: peer2,
          action: 'close',
          channelId: `channel-${i}`,
          timestamp: now - (15000 - i * 5000),
        });
      }

      const result = await rule.check({
        type: 'channel',
        peerId: peer2,
        action: 'close',
        channelId: 'channel-4',
        timestamp: now,
      });

      expect(result.detected).toBe(true);
      expect(result.peerId).toBe(peer2);
    });

    it('should ignore channel open events', async () => {
      const result = await rule.check({
        type: 'channel',
        peerId,
        action: 'open',
        channelId: 'channel-1',
        timestamp: Date.now(),
      });

      expect(result.detected).toBe(false);
    });

    it('should ignore non-channel events', async () => {
      const result = await rule.check({
        type: 'settlement',
        peerId,
        amount: 1000,
        timestamp: Date.now(),
      });

      expect(result.detected).toBe(false);
    });

    it('should include channel IDs in detection details', async () => {
      const now = Date.now();

      for (let i = 0; i < 4; i++) {
        await rule.check({
          type: 'channel',
          peerId,
          action: 'close',
          channelId: `channel-${i}`,
          timestamp: now - (15000 - i * 5000),
        });
      }

      const result = await rule.check({
        type: 'channel',
        peerId,
        action: 'close',
        channelId: 'channel-4',
        timestamp: now,
      });

      expect(result.detected).toBe(true);
      expect(result.details?.channelIds).toBeDefined();
      expect(Array.isArray(result.details?.channelIds)).toBe(true);
    });

    it('should complete closure check within 50ms timeout', async () => {
      const now = Date.now();

      for (let i = 0; i < 4; i++) {
        await rule.check({
          type: 'channel',
          peerId,
          action: 'close',
          channelId: `channel-${i}`,
          timestamp: now - (15000 - i * 5000),
        });
      }

      const startTime = Date.now();
      await rule.check({
        type: 'channel',
        peerId,
        action: 'close',
        channelId: 'channel-4',
        timestamp: now,
      });
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(50);
    });
  });
});
