import { Logger } from 'pino';
import { PeerReputationScore } from './fraud-detector';

/**
 * Severity penalties applied to reputation scores
 */
const SEVERITY_PENALTIES = {
  low: 1,
  medium: 5,
  high: 10,
  critical: 25,
} as const;

/**
 * Configuration for ReputationTracker
 */
export interface ReputationTrackerConfig {
  /**
   * Auto-pause threshold - peers with score below this value are auto-paused
   * (default: 50)
   */
  autoPauseThreshold: number;

  /**
   * Score decay rate - points added per day without violations (default: 1)
   */
  decayRate: number;

  /**
   * Maximum reputation score (default: 100)
   */
  maxScore: number;
}

/**
 * Fraud detection event emitted by FraudDetector
 */
export interface FraudDetectionEvent {
  ruleName: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  peerId: string;
  timestamp: number;
  details?: {
    [key: string]: unknown;
  };
}

/**
 * ReputationTracker manages peer reputation scores based on fraud violations
 *
 * - All peers initialize at score 100 (perfect reputation)
 * - Violations decrease score based on severity
 * - Score decays upward over time without violations
 * - Peers with score <50 are auto-paused
 */
export class ReputationTracker {
  private readonly logger: Logger;
  private readonly config: ReputationTrackerConfig;
  private readonly reputationScores: Map<string, PeerReputationScore>;

  constructor(logger: Logger, config: ReputationTrackerConfig) {
    this.logger = logger.child({ component: 'ReputationTracker' });
    this.config = config;
    this.reputationScores = new Map();

    this.logger.info('ReputationTracker initialized', {
      autoPauseThreshold: config.autoPauseThreshold,
      decayRate: config.decayRate,
      maxScore: config.maxScore,
    });
  }

  /**
   * Update reputation score after fraud detection
   */
  public async updateReputationScore(event: FraudDetectionEvent): Promise<void> {
    try {
      const { peerId, ruleName, severity, timestamp } = event;

      // Get or initialize peer reputation score
      let score = this.reputationScores.get(peerId);
      if (!score) {
        score = {
          peerId,
          score: this.config.maxScore, // Initialize at perfect score
          lastUpdated: timestamp,
          violations: [],
        };
        this.reputationScores.set(peerId, score);
      }

      // Apply penalty based on severity
      const penalty = SEVERITY_PENALTIES[severity];
      const newScore = Math.max(0, score.score - penalty);

      // Record violation
      score.violations.push({
        timestamp,
        ruleViolated: ruleName,
        severity,
        penaltyApplied: penalty,
      });

      score.score = newScore;
      score.lastUpdated = timestamp;

      this.logger.info('Reputation score updated', {
        peerId,
        previousScore: score.score + penalty,
        newScore,
        penalty,
        severity,
        ruleName,
        violationCount: score.violations.length,
      });
    } catch (error) {
      // Reputation score update failure: log error, continue monitoring
      this.logger.error('Failed to update reputation score', {
        peerId: event.peerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Apply score decay for peer (called periodically)
   *
   * @param peerId - Peer identifier
   * @param currentTime - Current timestamp
   */
  public applyScoreDecay(peerId: string, currentTime: number): void {
    const score = this.reputationScores.get(peerId);
    if (!score) {
      return;
    }

    // Calculate days elapsed since last update
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysElapsed = Math.floor((currentTime - score.lastUpdated) / msPerDay);

    if (daysElapsed === 0) {
      return; // No decay yet
    }

    // Apply decay: +1 point per day (configurable), capped at max score
    const decayAmount = daysElapsed * this.config.decayRate;
    const newScore = Math.min(this.config.maxScore, score.score + decayAmount);

    if (newScore !== score.score) {
      this.logger.debug('Score decay applied', {
        peerId,
        previousScore: score.score,
        newScore,
        daysElapsed,
        decayAmount,
      });

      score.score = newScore;
      score.lastUpdated = currentTime;
    }
  }

  /**
   * Apply score decay for all peers
   */
  public applyScoreDecayAll(currentTime: number): void {
    for (const [peerId] of Array.from(this.reputationScores)) {
      this.applyScoreDecay(peerId, currentTime);
    }
  }

  /**
   * Get reputation score for peer
   */
  public getReputationScore(peerId: string): PeerReputationScore | undefined {
    return this.reputationScores.get(peerId);
  }

  /**
   * Get all reputation scores
   */
  public getAllReputationScores(): Map<string, PeerReputationScore> {
    return new Map(this.reputationScores);
  }

  /**
   * Check if peer should be auto-paused based on reputation score
   */
  public shouldAutoPause(peerId: string): boolean {
    const score = this.reputationScores.get(peerId);
    if (!score) {
      return false; // New peer, no violations yet
    }

    return score.score < this.config.autoPauseThreshold;
  }

  /**
   * Clear all reputation scores (useful for testing)
   */
  public clearAll(): void {
    this.reputationScores.clear();
  }
}
