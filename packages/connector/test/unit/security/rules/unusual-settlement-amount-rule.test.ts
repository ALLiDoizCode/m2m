import { UnusualSettlementAmountRule } from '../../../../src/security/rules/unusual-settlement-amount-rule';
import { SettlementEvent } from '../../../../src/security/fraud-detector';

describe('UnusualSettlementAmountRule', () => {
  let rule: UnusualSettlementAmountRule;
  const peerId = 'test-peer-123';

  beforeEach(() => {
    // Initialize rule with 1M unit threshold
    rule = new UnusualSettlementAmountRule({
      maxSettlementAmount: 1000000,
    });
  });

  describe('check', () => {
    it('should not detect fraud for settlement below threshold', async () => {
      const event: SettlementEvent = {
        type: 'settlement',
        peerId,
        amount: 500000,
        timestamp: Date.now(),
      };

      const result = await rule.check(event);

      expect(result.detected).toBe(false);
    });

    it('should not detect fraud for settlement at threshold', async () => {
      const event: SettlementEvent = {
        type: 'settlement',
        peerId,
        amount: 1000000,
        timestamp: Date.now(),
      };

      const result = await rule.check(event);

      expect(result.detected).toBe(false);
    });

    it('should detect fraud for settlement exceeding threshold', async () => {
      const event: SettlementEvent = {
        type: 'settlement',
        peerId,
        amount: 1000001,
        timestamp: Date.now(),
      };

      const result = await rule.check(event);

      expect(result.detected).toBe(true);
      expect(result.peerId).toBe(peerId);
      expect(result.details?.description).toContain('Unusual settlement amount');
      expect(result.details?.settlementAmount).toBe(1000001);
      expect(result.details?.threshold).toBe(1000000);
    });

    it('should detect fraud for very large settlement', async () => {
      const event: SettlementEvent = {
        type: 'settlement',
        peerId,
        amount: 10000000,
        timestamp: Date.now(),
      };

      const result = await rule.check(event);

      expect(result.detected).toBe(true);
      expect(result.details?.settlementAmount).toBe(10000000);
    });

    it('should include channelId in detection details when present', async () => {
      const event: SettlementEvent = {
        type: 'settlement',
        peerId,
        amount: 2000000,
        timestamp: Date.now(),
        channelId: 'channel-abc-123',
      };

      const result = await rule.check(event);

      expect(result.detected).toBe(true);
      expect(result.details?.channelId).toBe('channel-abc-123');
    });

    it('should ignore non-settlement events', async () => {
      const result = await rule.check({
        type: 'packet',
        peerId,
        packetCount: 100,
        timestamp: Date.now(),
      });

      expect(result.detected).toBe(false);
    });

    it('should complete settlement amount check within 50ms timeout', async () => {
      const event: SettlementEvent = {
        type: 'settlement',
        peerId,
        amount: 5000000,
        timestamp: Date.now(),
      };

      const startTime = Date.now();
      await rule.check(event);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(50);
    });

    it('should work with different threshold configurations', async () => {
      const customRule = new UnusualSettlementAmountRule({
        maxSettlementAmount: 500000,
      });

      const event: SettlementEvent = {
        type: 'settlement',
        peerId,
        amount: 600000,
        timestamp: Date.now(),
      };

      const result = await customRule.check(event);

      expect(result.detected).toBe(true);
      expect(result.details?.threshold).toBe(500000);
    });

    it('should handle boundary condition at threshold - 1', async () => {
      const event: SettlementEvent = {
        type: 'settlement',
        peerId,
        amount: 999999,
        timestamp: Date.now(),
      };

      const result = await rule.check(event);

      expect(result.detected).toBe(false);
    });

    it('should handle boundary condition at threshold + 1', async () => {
      const event: SettlementEvent = {
        type: 'settlement',
        peerId,
        amount: 1000001,
        timestamp: Date.now(),
      };

      const result = await rule.check(event);

      expect(result.detected).toBe(true);
    });
  });
});
