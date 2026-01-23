import { SuddenTrafficSpikeRule } from '../../../../src/security/rules/sudden-traffic-spike-rule';
import { PacketEvent } from '../../../../src/security/fraud-detector';

describe('SuddenTrafficSpikeRule', () => {
  let rule: SuddenTrafficSpikeRule;
  const peerId = 'test-peer-123';

  beforeEach(() => {
    // Initialize rule with 10x spike threshold and 60-second window
    rule = new SuddenTrafficSpikeRule({
      spikeThreshold: 10,
      timeWindow: 60000, // 60 seconds
    });
  });

  afterEach(() => {
    rule.clearHistory();
  });

  describe('check', () => {
    it('should not detect spike with insufficient history', async () => {
      const event: PacketEvent = {
        type: 'packet',
        peerId,
        packetCount: 100,
        timestamp: Date.now(),
      };

      const result = await rule.check(event);

      expect(result.detected).toBe(false);
    });

    it('should not detect spike when traffic is within normal range', async () => {
      const now = Date.now();

      // Establish baseline: 100 packets per event
      await rule.check({
        type: 'packet',
        peerId,
        packetCount: 100,
        timestamp: now - 5000,
      });

      await rule.check({
        type: 'packet',
        peerId,
        packetCount: 110,
        timestamp: now,
      });

      const result = await rule.check({
        type: 'packet',
        peerId,
        packetCount: 105,
        timestamp: now + 1000,
      });

      expect(result.detected).toBe(false);
    });

    it('should detect spike at 10x threshold', async () => {
      const now = Date.now();

      // Establish baseline: 100 packets average
      await rule.check({
        type: 'packet',
        peerId,
        packetCount: 100,
        timestamp: now - 10000,
      });

      await rule.check({
        type: 'packet',
        peerId,
        packetCount: 100,
        timestamp: now - 5000,
      });

      // Spike: 1000 packets = 10x baseline
      const result = await rule.check({
        type: 'packet',
        peerId,
        packetCount: 1000,
        timestamp: now,
      });

      expect(result.detected).toBe(true);
      expect(result.peerId).toBe(peerId);
      expect(result.details?.description).toContain('Traffic spike detected');
      expect(result.details?.spikeMultiplier).toBeGreaterThanOrEqual(10);
    });

    it('should detect spike at 50x threshold', async () => {
      const now = Date.now();

      // Establish baseline: 100 packets average
      await rule.check({
        type: 'packet',
        peerId,
        packetCount: 100,
        timestamp: now - 10000,
      });

      await rule.check({
        type: 'packet',
        peerId,
        packetCount: 100,
        timestamp: now - 5000,
      });

      // Spike: 5000 packets = 50x baseline
      const result = await rule.check({
        type: 'packet',
        peerId,
        packetCount: 5000,
        timestamp: now,
      });

      expect(result.detected).toBe(true);
      expect(result.details?.spikeMultiplier).toBeGreaterThanOrEqual(50);
    });

    it('should detect spike at 100x threshold', async () => {
      const now = Date.now();

      // Establish baseline: 100 packets average
      await rule.check({
        type: 'packet',
        peerId,
        packetCount: 100,
        timestamp: now - 10000,
      });

      await rule.check({
        type: 'packet',
        peerId,
        packetCount: 100,
        timestamp: now - 5000,
      });

      // Spike: 10000 packets = 100x baseline
      const result = await rule.check({
        type: 'packet',
        peerId,
        packetCount: 10000,
        timestamp: now,
      });

      expect(result.detected).toBe(true);
      expect(result.details?.spikeMultiplier).toBeGreaterThanOrEqual(100);
    });

    it('should ignore events outside time window', async () => {
      const now = Date.now();

      // Old baseline (outside 60-second window)
      await rule.check({
        type: 'packet',
        peerId,
        packetCount: 100,
        timestamp: now - 70000,
      });

      // Recent baseline
      await rule.check({
        type: 'packet',
        peerId,
        packetCount: 1000,
        timestamp: now - 5000,
      });

      // Current packet count similar to recent baseline
      const result = await rule.check({
        type: 'packet',
        peerId,
        packetCount: 1100,
        timestamp: now,
      });

      // Should not detect spike because old baseline is excluded
      expect(result.detected).toBe(false);
    });

    it('should track separate histories for different peers', async () => {
      const now = Date.now();
      const peer1 = 'peer-1';
      const peer2 = 'peer-2';

      // Peer 1: Normal traffic
      await rule.check({
        type: 'packet',
        peerId: peer1,
        packetCount: 100,
        timestamp: now - 5000,
      });

      await rule.check({
        type: 'packet',
        peerId: peer1,
        packetCount: 100,
        timestamp: now,
      });

      // Peer 2: Spike
      await rule.check({
        type: 'packet',
        peerId: peer2,
        packetCount: 100,
        timestamp: now - 5000,
      });

      const result = await rule.check({
        type: 'packet',
        peerId: peer2,
        packetCount: 1000,
        timestamp: now,
      });

      expect(result.detected).toBe(true);
      expect(result.peerId).toBe(peer2);
    });

    it('should ignore non-packet events', async () => {
      const result = await rule.check({
        type: 'settlement',
        peerId,
        amount: 1000,
        timestamp: Date.now(),
      });

      expect(result.detected).toBe(false);
    });

    it('should complete spike detection within 50ms timeout', async () => {
      const now = Date.now();

      // Establish baseline
      await rule.check({
        type: 'packet',
        peerId,
        packetCount: 100,
        timestamp: now - 5000,
      });

      const startTime = Date.now();
      await rule.check({
        type: 'packet',
        peerId,
        packetCount: 1000,
        timestamp: now,
      });
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(50);
    });
  });
});
