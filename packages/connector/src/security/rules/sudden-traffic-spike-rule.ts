import {
  FraudRule,
  FraudDetection,
  SettlementEvent,
  PacketEvent,
  ChannelEvent,
} from '../fraud-detector';

/**
 * Configuration for SuddenTrafficSpikeRule
 */
export interface SuddenTrafficSpikeConfig {
  /**
   * Multiplier threshold for detecting traffic spikes (e.g., 10 = 10x historical average)
   */
  spikeThreshold: number;

  /**
   * Time window in milliseconds for calculating traffic rates (default: 60000 = 60 seconds)
   */
  timeWindow: number;
}

/**
 * Traffic history entry for tracking packet rates
 */
interface TrafficHistory {
  peerId: string;
  packetCounts: number[];
  timestamps: number[];
  windowStart: number;
}

/**
 * Detects sudden traffic spikes exceeding historical average
 *
 * Medium severity rule that triggers when packet rate exceeds 10x (configurable)
 * the peer's historical average within a 60-second window.
 */
export class SuddenTrafficSpikeRule implements FraudRule {
  public readonly name = 'SuddenTrafficSpikeRule';
  public readonly severity = 'medium' as const;

  private readonly config: SuddenTrafficSpikeConfig;
  private readonly trafficHistory: Map<string, TrafficHistory>;

  constructor(config: SuddenTrafficSpikeConfig) {
    this.config = config;
    this.trafficHistory = new Map();
  }

  /**
   * Check if event represents a sudden traffic spike
   */
  public async check(event: SettlementEvent | PacketEvent | ChannelEvent): Promise<FraudDetection> {
    // Only monitor packet events for traffic spikes
    if (event.type !== 'packet') {
      return { detected: false };
    }

    const packetEvent = event as PacketEvent;
    const now = packetEvent.timestamp;

    // Get or initialize traffic history for peer
    let history = this.trafficHistory.get(packetEvent.peerId);
    if (!history) {
      history = {
        peerId: packetEvent.peerId,
        packetCounts: [],
        timestamps: [],
        windowStart: now,
      };
      this.trafficHistory.set(packetEvent.peerId, history);
    }

    // Add current packet count to history
    history.packetCounts.push(packetEvent.packetCount);
    history.timestamps.push(now);

    // Remove entries outside the time window
    this.cleanupOldEntries(history, now);

    // Calculate current rate and historical average
    const currentRate = this.calculateCurrentRate(history);
    const historicalAverage = this.calculateHistoricalAverage(history);

    // No spike detection if insufficient history (need at least 2 data points)
    if (history.packetCounts.length < 2 || historicalAverage === 0) {
      return { detected: false };
    }

    // Detect spike if current rate exceeds threshold * historical average
    const spikeMultiplier = currentRate / historicalAverage;
    if (spikeMultiplier >= this.config.spikeThreshold) {
      return {
        detected: true,
        peerId: packetEvent.peerId,
        details: {
          description: `Traffic spike detected: ${spikeMultiplier.toFixed(2)}x historical average`,
          currentRate,
          historicalAverage,
          spikeMultiplier,
          threshold: this.config.spikeThreshold,
          timeWindow: this.config.timeWindow,
        },
      };
    }

    return { detected: false };
  }

  /**
   * Remove entries outside the configured time window
   */
  private cleanupOldEntries(history: TrafficHistory, now: number): void {
    const cutoffTime = now - this.config.timeWindow;
    let firstValidIndex = 0;

    // Find first entry within time window
    for (let i = 0; i < history.timestamps.length; i++) {
      const timestamp = history.timestamps[i];
      if (timestamp !== undefined && timestamp >= cutoffTime) {
        firstValidIndex = i;
        break;
      }
    }

    // Remove old entries
    if (firstValidIndex > 0) {
      history.packetCounts = history.packetCounts.slice(firstValidIndex);
      history.timestamps = history.timestamps.slice(firstValidIndex);
    }
  }

  /**
   * Calculate current packet count (most recent observation)
   */
  private calculateCurrentRate(history: TrafficHistory): number {
    if (history.packetCounts.length === 0) {
      return 0;
    }

    // Use most recent packet count
    const recentPacketCount = history.packetCounts[history.packetCounts.length - 1];

    if (recentPacketCount === undefined) {
      return 0;
    }

    return recentPacketCount;
  }

  /**
   * Calculate historical average packet rate
   */
  private calculateHistoricalAverage(history: TrafficHistory): number {
    if (history.packetCounts.length < 2) {
      return 0;
    }

    // Calculate average excluding most recent data point to detect spikes
    const historicalCounts = history.packetCounts.slice(0, -1);
    const sum = historicalCounts.reduce((acc, count) => acc + count, 0);

    return sum / historicalCounts.length;
  }

  /**
   * Clear traffic history (useful for testing)
   */
  public clearHistory(): void {
    this.trafficHistory.clear();
  }
}
