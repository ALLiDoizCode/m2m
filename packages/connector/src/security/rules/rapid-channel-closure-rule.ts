import {
  FraudRule,
  FraudDetection,
  SettlementEvent,
  PacketEvent,
  ChannelEvent,
} from '../fraud-detector';

/**
 * Configuration for RapidChannelClosureRule
 */
export interface RapidChannelClosureConfig {
  /**
   * Maximum channel closures allowed within time window (default: 3)
   */
  maxClosures: number;

  /**
   * Time window in milliseconds for tracking closures (default: 3600000 = 1 hour)
   */
  timeWindow: number;
}

/**
 * Channel closure history entry
 */
interface ClosureHistory {
  peerId: string;
  closures: {
    channelId: string;
    timestamp: number;
  }[];
}

/**
 * Detects rapid channel closures indicating channel griefing attack
 *
 * High severity rule that triggers when more than 3 channel closures occur
 * within a 1-hour window. Channel griefing can exhaust resources.
 */
export class RapidChannelClosureRule implements FraudRule {
  public readonly name = 'RapidChannelClosureRule';
  public readonly severity = 'high' as const;

  private readonly config: RapidChannelClosureConfig;
  private readonly closureHistory: Map<string, ClosureHistory>;

  constructor(config: RapidChannelClosureConfig) {
    this.config = config;
    this.closureHistory = new Map();
  }

  /**
   * Check if channel closures exceed threshold within time window
   */
  public async check(event: SettlementEvent | PacketEvent | ChannelEvent): Promise<FraudDetection> {
    // Only monitor channel closure events
    if (event.type !== 'channel' || event.action !== 'close') {
      return { detected: false };
    }

    const channelEvent = event as ChannelEvent;
    const now = channelEvent.timestamp;

    // Get or initialize closure history for peer
    let history = this.closureHistory.get(channelEvent.peerId);
    if (!history) {
      history = {
        peerId: channelEvent.peerId,
        closures: [],
      };
      this.closureHistory.set(channelEvent.peerId, history);
    }

    // Add current closure to history
    history.closures.push({
      channelId: channelEvent.channelId,
      timestamp: now,
    });

    // Remove closures outside the time window
    this.cleanupOldClosures(history, now);

    // Check if closure count exceeds threshold
    if (history.closures.length > this.config.maxClosures) {
      const closureCount = history.closures.length;
      return {
        detected: true,
        peerId: channelEvent.peerId,
        details: {
          description: `Rapid channel closures detected: ${closureCount} closures in ${this.config.timeWindow / 1000}s (threshold: ${this.config.maxClosures})`,
          closureCount,
          maxClosures: this.config.maxClosures,
          timeWindow: this.config.timeWindow,
          channelIds: history.closures.map((c) => c.channelId),
        },
      };
    }

    return { detected: false };
  }

  /**
   * Remove closures outside the configured time window
   */
  private cleanupOldClosures(history: ClosureHistory, now: number): void {
    const cutoffTime = now - this.config.timeWindow;
    history.closures = history.closures.filter((closure) => closure.timestamp >= cutoffTime);
  }

  /**
   * Clear closure history (useful for testing)
   */
  public clearHistory(): void {
    this.closureHistory.clear();
  }
}
