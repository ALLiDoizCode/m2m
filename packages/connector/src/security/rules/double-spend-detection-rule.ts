import {
  FraudRule,
  FraudDetection,
  SettlementEvent,
  PacketEvent,
  ChannelEvent,
} from '../fraud-detector';

/**
 * Claim history entry for tracking claim amounts
 */
interface ClaimHistory {
  peerId: string;
  channelId: string;
  claims: {
    amount: number;
    timestamp: number;
  }[];
}

/**
 * Extended settlement event with claim data for double-spend detection
 */
export interface ClaimEvent extends SettlementEvent {
  claimAmount?: number;
}

/**
 * Detects double-spend attacks via claim amount regression
 *
 * Critical severity rule that triggers when a claim is submitted with a lower
 * amount than a previous claim for the same channel. This indicates an attempt
 * to reverse previous settlements.
 */
export class DoubleSpendDetectionRule implements FraudRule {
  public readonly name = 'DoubleSpendDetectionRule';
  public readonly severity = 'critical' as const;

  private readonly claimHistory: Map<string, ClaimHistory>;

  constructor() {
    this.claimHistory = new Map();
  }

  /**
   * Check if claim amount represents a double-spend attempt
   */
  public async check(event: SettlementEvent | PacketEvent | ChannelEvent): Promise<FraudDetection> {
    // Only monitor settlement events with claim data
    if (event.type !== 'settlement') {
      return { detected: false };
    }

    const settlementEvent = event as ClaimEvent;

    // Require channelId and claimAmount for double-spend detection
    if (!settlementEvent.channelId || settlementEvent.claimAmount === undefined) {
      return { detected: false };
    }

    const historyKey = `${settlementEvent.peerId}:${settlementEvent.channelId}`;

    // Get or initialize claim history for peer+channel
    let history = this.claimHistory.get(historyKey);
    if (!history) {
      history = {
        peerId: settlementEvent.peerId,
        channelId: settlementEvent.channelId,
        claims: [],
      };
      this.claimHistory.set(historyKey, history);
    }

    // Check if current claim amount is lower than previous claim
    const previousClaims = history.claims;
    if (previousClaims.length > 0) {
      const lastClaim = previousClaims[previousClaims.length - 1];
      if (lastClaim && settlementEvent.claimAmount < lastClaim.amount) {
        return {
          detected: true,
          peerId: settlementEvent.peerId,
          details: {
            description: `Double-spend attempt detected: Claim amount ${settlementEvent.claimAmount} is lower than previous claim ${lastClaim.amount}`,
            currentClaimAmount: settlementEvent.claimAmount,
            previousClaimAmount: lastClaim.amount,
            channelId: settlementEvent.channelId,
            timestamp: settlementEvent.timestamp,
            previousClaimTimestamp: lastClaim.timestamp,
          },
        };
      }
    }

    // Add current claim to history
    history.claims.push({
      amount: settlementEvent.claimAmount,
      timestamp: settlementEvent.timestamp,
    });

    return { detected: false };
  }

  /**
   * Clear claim history (useful for testing)
   */
  public clearHistory(): void {
    this.claimHistory.clear();
  }

  /**
   * Get claim history for a peer and channel (useful for testing)
   */
  public getClaimHistory(peerId: string, channelId: string): ClaimHistory | undefined {
    return this.claimHistory.get(`${peerId}:${channelId}`);
  }
}
