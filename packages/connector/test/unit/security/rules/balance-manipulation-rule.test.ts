import {
  BalanceManipulationRule,
  BalanceEvent,
} from '../../../../src/security/rules/balance-manipulation-rule';

describe('BalanceManipulationRule', () => {
  let rule: BalanceManipulationRule;
  const peerId = 'test-peer-123';

  beforeEach(() => {
    rule = new BalanceManipulationRule();
  });

  afterEach(() => {
    rule.clearHistory();
  });

  describe('check', () => {
    it('should detect negative balance attempt', async () => {
      const event: BalanceEvent = {
        type: 'settlement',
        peerId,
        amount: 1000,
        timestamp: Date.now(),
        previousBalance: 500,
        newBalance: -500,
      };

      const result = await rule.check(event);

      expect(result.detected).toBe(true);
      expect(result.peerId).toBe(peerId);
      expect(result.details?.description).toContain('Negative balance attempt detected');
      expect(result.details?.newBalance).toBe(-500);
    });

    it('should not detect fraud with positive balance', async () => {
      const event: BalanceEvent = {
        type: 'settlement',
        peerId,
        amount: 1000,
        timestamp: Date.now(),
        previousBalance: 2000,
        newBalance: 1000,
      };

      const result = await rule.check(event);

      expect(result.detected).toBe(false);
    });

    it('should not detect fraud with zero balance', async () => {
      const event: BalanceEvent = {
        type: 'settlement',
        peerId,
        amount: 1000,
        timestamp: Date.now(),
        previousBalance: 1000,
        newBalance: 0,
      };

      const result = await rule.check(event);

      expect(result.detected).toBe(false);
    });

    it('should detect unexpected balance decrease', async () => {
      const event: BalanceEvent = {
        type: 'settlement',
        peerId,
        amount: 500, // Expected decrease: 500
        timestamp: Date.now(),
        previousBalance: 2000,
        newBalance: 1000, // Actual decrease: 1000
      };

      const result = await rule.check(event);

      expect(result.detected).toBe(true);
      expect(result.details?.description).toContain('Unexpected balance decrease detected');
      expect(result.details?.expectedDecrease).toBe(500);
      expect(result.details?.actualDecrease).toBe(1000);
    });

    it('should not detect fraud with expected balance decrease', async () => {
      const event: BalanceEvent = {
        type: 'settlement',
        peerId,
        amount: 1000,
        timestamp: Date.now(),
        previousBalance: 2000,
        newBalance: 1000,
      };

      const result = await rule.check(event);

      expect(result.detected).toBe(false);
    });

    it('should not detect fraud with balance increase', async () => {
      const event: BalanceEvent = {
        type: 'settlement',
        peerId,
        amount: 1000,
        timestamp: Date.now(),
        previousBalance: 1000,
        newBalance: 2000,
      };

      const result = await rule.check(event);

      expect(result.detected).toBe(false);
    });

    it('should ignore events without newBalance', async () => {
      const event = {
        type: 'settlement' as const,
        peerId,
        amount: 1000,
        timestamp: Date.now(),
        // No newBalance
      };

      const result = await rule.check(event);

      expect(result.detected).toBe(false);
    });

    it('should ignore events without previousBalance for unexpected decrease detection', async () => {
      const event: BalanceEvent = {
        type: 'settlement',
        peerId,
        amount: 1000,
        timestamp: Date.now(),
        newBalance: 500,
        // No previousBalance
      };

      const result = await rule.check(event);

      // Should only check for negative balance, not unexpected decrease
      expect(result.detected).toBe(false);
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

    it('should track balance history', async () => {
      const now = Date.now();

      await rule.check({
        type: 'settlement',
        peerId,
        amount: 500,
        timestamp: now - 10000,
        previousBalance: 2000,
        newBalance: 1500,
      } as BalanceEvent);

      await rule.check({
        type: 'settlement',
        peerId,
        amount: 500,
        timestamp: now,
        previousBalance: 1500,
        newBalance: 1000,
      } as BalanceEvent);

      const history = rule.getBalanceHistory(peerId);

      expect(history).toBeDefined();
      expect(history?.balances).toHaveLength(2);
      expect(history?.balances[0]?.balance).toBe(1500);
      expect(history?.balances[1]?.balance).toBe(1000);
    });

    it('should detect very large negative balance', async () => {
      const event: BalanceEvent = {
        type: 'settlement',
        peerId,
        amount: 1000,
        timestamp: Date.now(),
        previousBalance: 500,
        newBalance: -1000000,
      };

      const result = await rule.check(event);

      expect(result.detected).toBe(true);
      expect(result.details?.newBalance).toBe(-1000000);
    });

    it('should complete balance manipulation check within 50ms timeout', async () => {
      const event: BalanceEvent = {
        type: 'settlement',
        peerId,
        amount: 1000,
        timestamp: Date.now(),
        previousBalance: 2000,
        newBalance: -500,
      };

      const startTime = Date.now();
      await rule.check(event);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(50);
    });

    it('should handle boundary condition at zero balance', async () => {
      const event: BalanceEvent = {
        type: 'settlement',
        peerId,
        amount: 1000,
        timestamp: Date.now(),
        previousBalance: 1000,
        newBalance: 0,
      };

      const result = await rule.check(event);

      expect(result.detected).toBe(false);
    });

    it('should detect boundary condition at -1 balance', async () => {
      const event: BalanceEvent = {
        type: 'settlement',
        peerId,
        amount: 1000,
        timestamp: Date.now(),
        previousBalance: 999,
        newBalance: -1,
      };

      const result = await rule.check(event);

      expect(result.detected).toBe(true);
    });

    it('should include timestamp in detection details', async () => {
      const now = Date.now();

      const event: BalanceEvent = {
        type: 'settlement',
        peerId,
        amount: 500,
        timestamp: now,
        previousBalance: 2000,
        newBalance: 1000,
      };

      const result = await rule.check(event);

      if (result.detected) {
        expect(result.details?.timestamp).toBe(now);
      }
    });
  });
});
