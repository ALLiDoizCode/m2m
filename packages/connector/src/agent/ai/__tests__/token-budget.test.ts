import { TokenBudget, type TokenBudgetTelemetryEvent } from '../token-budget';

describe('TokenBudget', () => {
  let budget: TokenBudget;

  beforeEach(() => {
    budget = new TokenBudget({
      maxTokensPerWindow: 1000,
      windowMs: 60000, // 1 minute for tests
    });
  });

  describe('canSpend', () => {
    it('should allow spending when budget is available', () => {
      expect(budget.canSpend()).toBe(true);
    });

    it('should allow spending with estimated tokens within budget', () => {
      expect(budget.canSpend(500)).toBe(true);
    });

    it('should deny spending when estimated tokens exceed budget', () => {
      expect(budget.canSpend(1001)).toBe(false);
    });

    it('should deny spending when budget is exhausted', () => {
      budget.recordUsage({ promptTokens: 500, completionTokens: 500, totalTokens: 1000 });
      expect(budget.canSpend()).toBe(false);
    });

    it('should account for previous usage', () => {
      budget.recordUsage({ promptTokens: 400, completionTokens: 400, totalTokens: 800 });
      expect(budget.canSpend(100)).toBe(true);
      expect(budget.canSpend(201)).toBe(false);
    });
  });

  describe('recordUsage', () => {
    it('should record token usage', () => {
      budget.recordUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
      const status = budget.getStatus();
      expect(status.tokensUsedInWindow).toBe(150);
    });

    it('should accumulate multiple usage records', () => {
      budget.recordUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
      budget.recordUsage({ promptTokens: 200, completionTokens: 100, totalTokens: 300 });
      expect(budget.getStatus().tokensUsedInWindow).toBe(450);
    });
  });

  describe('getStatus', () => {
    it('should return correct initial status', () => {
      const status = budget.getStatus();
      expect(status.tokensUsedInWindow).toBe(0);
      expect(status.maxTokensPerWindow).toBe(1000);
      expect(status.remainingTokens).toBe(1000);
      expect(status.usagePercent).toBe(0);
      expect(status.isExhausted).toBe(false);
      expect(status.requestCount).toBe(0);
    });

    it('should show exhausted when budget fully used', () => {
      budget.recordUsage({ promptTokens: 500, completionTokens: 500, totalTokens: 1000 });
      const status = budget.getStatus();
      expect(status.isExhausted).toBe(true);
      expect(status.remainingTokens).toBe(0);
      expect(status.usagePercent).toBe(100);
    });

    it('should calculate usage percentage', () => {
      budget.recordUsage({ promptTokens: 250, completionTokens: 250, totalTokens: 500 });
      expect(budget.getStatus().usagePercent).toBe(50);
    });
  });

  describe('getRemainingBudget', () => {
    it('should return full budget initially', () => {
      expect(budget.getRemainingBudget()).toBe(1000);
    });

    it('should decrease after usage', () => {
      budget.recordUsage({ promptTokens: 100, completionTokens: 100, totalTokens: 200 });
      expect(budget.getRemainingBudget()).toBe(800);
    });

    it('should not go below zero', () => {
      budget.recordUsage({ promptTokens: 600, completionTokens: 600, totalTokens: 1200 });
      expect(budget.getRemainingBudget()).toBe(0);
    });
  });

  describe('reset', () => {
    it('should clear all records', () => {
      budget.recordUsage({ promptTokens: 100, completionTokens: 100, totalTokens: 200 });
      budget.reset();
      expect(budget.getStatus().tokensUsedInWindow).toBe(0);
      expect(budget.getStatus().requestCount).toBe(0);
    });
  });

  describe('rolling window', () => {
    it('should expire old records', () => {
      // Create budget with very short window
      const shortBudget = new TokenBudget({
        maxTokensPerWindow: 1000,
        windowMs: 50, // 50ms window
      });

      shortBudget.recordUsage({ promptTokens: 500, completionTokens: 500, totalTokens: 1000 });
      expect(shortBudget.canSpend()).toBe(false);

      // Wait for window to expire
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(shortBudget.canSpend()).toBe(true);
          expect(shortBudget.getStatus().tokensUsedInWindow).toBe(0);
          resolve();
        }, 100);
      });
    });
  });

  describe('telemetry', () => {
    it('should emit AI_TOKEN_USAGE on each recordUsage', () => {
      const events: TokenBudgetTelemetryEvent[] = [];
      budget.onTelemetry = (event) => events.push(event);

      budget.recordUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('AI_TOKEN_USAGE');
      expect(events[0]!.tokensUsed).toBe(150);
    });

    it('should emit AI_BUDGET_WARNING at 80% usage', () => {
      const events: TokenBudgetTelemetryEvent[] = [];
      budget.onTelemetry = (event) => events.push(event);

      budget.recordUsage({ promptTokens: 400, completionTokens: 400, totalTokens: 800 });

      const warningEvents = events.filter((e) => e.type === 'AI_BUDGET_WARNING');
      expect(warningEvents.length).toBe(1);
      expect(warningEvents[0]!.usagePercent).toBe(80);
    });

    it('should emit AI_BUDGET_WARNING at 95% usage', () => {
      const events: TokenBudgetTelemetryEvent[] = [];
      budget.onTelemetry = (event) => events.push(event);

      budget.recordUsage({ promptTokens: 475, completionTokens: 475, totalTokens: 950 });

      const warningEvents = events.filter((e) => e.type === 'AI_BUDGET_WARNING');
      expect(warningEvents.length).toBe(1);
      expect(warningEvents[0]!.usagePercent).toBe(95);
    });

    it('should emit AI_BUDGET_EXHAUSTED when fully used', () => {
      const events: TokenBudgetTelemetryEvent[] = [];
      budget.onTelemetry = (event) => events.push(event);

      budget.recordUsage({ promptTokens: 500, completionTokens: 500, totalTokens: 1000 });

      const exhaustedEvents = events.filter((e) => e.type === 'AI_BUDGET_EXHAUSTED');
      expect(exhaustedEvents.length).toBe(1);
    });

    it('should not throw if telemetry callback throws', () => {
      budget.onTelemetry = () => {
        throw new Error('telemetry error');
      };

      // Should not throw
      expect(() => {
        budget.recordUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
      }).not.toThrow();
    });
  });
});
