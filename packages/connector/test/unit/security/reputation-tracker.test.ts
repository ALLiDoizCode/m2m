import pino from 'pino';
import { ReputationTracker, FraudDetectionEvent } from '../../../src/security/reputation-tracker';

describe('ReputationTracker', () => {
  let tracker: ReputationTracker;
  let logger: pino.Logger;
  const peerId = 'test-peer-123';

  beforeEach(() => {
    logger = pino({ level: 'silent' });
    tracker = new ReputationTracker(logger, {
      autoPauseThreshold: 50,
      decayRate: 1,
      maxScore: 100,
    });
  });

  afterEach(() => {
    tracker.clearAll();
  });

  describe('updateReputationScore', () => {
    it('should initialize peer with perfect score (100)', async () => {
      const event: FraudDetectionEvent = {
        ruleName: 'TestRule',
        severity: 'low',
        peerId,
        timestamp: Date.now(),
      };

      await tracker.updateReputationScore(event);

      const score = tracker.getReputationScore(peerId);
      expect(score).toBeDefined();
      expect(score?.score).toBe(99); // 100 - 1 (low penalty)
    });

    it('should apply low severity penalty (-1)', async () => {
      const event: FraudDetectionEvent = {
        ruleName: 'TestRule',
        severity: 'low',
        peerId,
        timestamp: Date.now(),
      };

      await tracker.updateReputationScore(event);

      const score = tracker.getReputationScore(peerId);
      expect(score?.score).toBe(99);
      expect(score?.violations).toHaveLength(1);
      expect(score?.violations[0]?.penaltyApplied).toBe(1);
    });

    it('should apply medium severity penalty (-5)', async () => {
      const event: FraudDetectionEvent = {
        ruleName: 'TestRule',
        severity: 'medium',
        peerId,
        timestamp: Date.now(),
      };

      await tracker.updateReputationScore(event);

      const score = tracker.getReputationScore(peerId);
      expect(score?.score).toBe(95);
      expect(score?.violations[0]?.penaltyApplied).toBe(5);
    });

    it('should apply high severity penalty (-10)', async () => {
      const event: FraudDetectionEvent = {
        ruleName: 'TestRule',
        severity: 'high',
        peerId,
        timestamp: Date.now(),
      };

      await tracker.updateReputationScore(event);

      const score = tracker.getReputationScore(peerId);
      expect(score?.score).toBe(90);
      expect(score?.violations[0]?.penaltyApplied).toBe(10);
    });

    it('should apply critical severity penalty (-25)', async () => {
      const event: FraudDetectionEvent = {
        ruleName: 'TestRule',
        severity: 'critical',
        peerId,
        timestamp: Date.now(),
      };

      await tracker.updateReputationScore(event);

      const score = tracker.getReputationScore(peerId);
      expect(score?.score).toBe(75);
      expect(score?.violations[0]?.penaltyApplied).toBe(25);
    });

    it('should accumulate multiple violations', async () => {
      const now = Date.now();

      await tracker.updateReputationScore({
        ruleName: 'Rule1',
        severity: 'low',
        peerId,
        timestamp: now - 10000,
      });

      await tracker.updateReputationScore({
        ruleName: 'Rule2',
        severity: 'medium',
        peerId,
        timestamp: now,
      });

      const score = tracker.getReputationScore(peerId);
      expect(score?.score).toBe(94); // 100 - 1 - 5 = 94
      expect(score?.violations).toHaveLength(2);
    });

    it('should not allow score to go below 0', async () => {
      const now = Date.now();

      // Apply penalties that would exceed 100 points
      for (let i = 0; i < 5; i++) {
        await tracker.updateReputationScore({
          ruleName: `Rule${i}`,
          severity: 'critical',
          peerId,
          timestamp: now + i * 1000,
        });
      }

      const score = tracker.getReputationScore(peerId);
      expect(score?.score).toBe(0);
    });

    it('should track violation history', async () => {
      const now = Date.now();

      await tracker.updateReputationScore({
        ruleName: 'SuddenTrafficSpikeRule',
        severity: 'medium',
        peerId,
        timestamp: now,
      });

      const score = tracker.getReputationScore(peerId);
      expect(score?.violations[0]?.ruleViolated).toBe('SuddenTrafficSpikeRule');
      expect(score?.violations[0]?.severity).toBe('medium');
      expect(score?.violations[0]?.timestamp).toBe(now);
    });
  });

  describe('applyScoreDecay', () => {
    it('should not apply decay within same day', () => {
      const now = Date.now();

      tracker['reputationScores'].set(peerId, {
        peerId,
        score: 80,
        lastUpdated: now - 10000, // 10 seconds ago
        violations: [],
      });

      tracker.applyScoreDecay(peerId, now);

      const score = tracker.getReputationScore(peerId);
      expect(score?.score).toBe(80);
    });

    it('should apply decay after 1 day (+1 point)', () => {
      const now = Date.now();
      const oneDayAgo = now - 24 * 60 * 60 * 1000;

      tracker['reputationScores'].set(peerId, {
        peerId,
        score: 80,
        lastUpdated: oneDayAgo,
        violations: [],
      });

      tracker.applyScoreDecay(peerId, now);

      const score = tracker.getReputationScore(peerId);
      expect(score?.score).toBe(81);
    });

    it('should apply decay after 5 days (+5 points)', () => {
      const now = Date.now();
      const fiveDaysAgo = now - 5 * 24 * 60 * 60 * 1000;

      tracker['reputationScores'].set(peerId, {
        peerId,
        score: 70,
        lastUpdated: fiveDaysAgo,
        violations: [],
      });

      tracker.applyScoreDecay(peerId, now);

      const score = tracker.getReputationScore(peerId);
      expect(score?.score).toBe(75);
    });

    it('should cap decay at max score (100)', () => {
      const now = Date.now();
      const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

      tracker['reputationScores'].set(peerId, {
        peerId,
        score: 95,
        lastUpdated: tenDaysAgo,
        violations: [],
      });

      tracker.applyScoreDecay(peerId, now);

      const score = tracker.getReputationScore(peerId);
      expect(score?.score).toBe(100);
    });
  });

  describe('shouldAutoPause', () => {
    it('should not auto-pause new peer', () => {
      const shouldPause = tracker.shouldAutoPause(peerId);
      expect(shouldPause).toBe(false);
    });

    it('should not auto-pause peer with score >= 50', () => {
      tracker['reputationScores'].set(peerId, {
        peerId,
        score: 50,
        lastUpdated: Date.now(),
        violations: [],
      });

      const shouldPause = tracker.shouldAutoPause(peerId);
      expect(shouldPause).toBe(false);
    });

    it('should auto-pause peer with score < 50', () => {
      tracker['reputationScores'].set(peerId, {
        peerId,
        score: 49,
        lastUpdated: Date.now(),
        violations: [],
      });

      const shouldPause = tracker.shouldAutoPause(peerId);
      expect(shouldPause).toBe(true);
    });

    it('should auto-pause peer with score = 0', () => {
      tracker['reputationScores'].set(peerId, {
        peerId,
        score: 0,
        lastUpdated: Date.now(),
        violations: [],
      });

      const shouldPause = tracker.shouldAutoPause(peerId);
      expect(shouldPause).toBe(true);
    });
  });

  describe('getAllReputationScores', () => {
    it('should return empty map initially', () => {
      const scores = tracker.getAllReputationScores();
      expect(scores.size).toBe(0);
    });

    it('should return all peer scores', async () => {
      await tracker.updateReputationScore({
        ruleName: 'Rule1',
        severity: 'low',
        peerId: 'peer-1',
        timestamp: Date.now(),
      });

      await tracker.updateReputationScore({
        ruleName: 'Rule2',
        severity: 'medium',
        peerId: 'peer-2',
        timestamp: Date.now(),
      });

      const scores = tracker.getAllReputationScores();
      expect(scores.size).toBe(2);
      expect(scores.has('peer-1')).toBe(true);
      expect(scores.has('peer-2')).toBe(true);
    });
  });

  describe('async timeout patterns', () => {
    it('should complete reputation update within 50ms', async () => {
      const event: FraudDetectionEvent = {
        ruleName: 'TestRule',
        severity: 'critical',
        peerId,
        timestamp: Date.now(),
      };

      const startTime = Date.now();
      await tracker.updateReputationScore(event);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(50);
    });
  });
});
