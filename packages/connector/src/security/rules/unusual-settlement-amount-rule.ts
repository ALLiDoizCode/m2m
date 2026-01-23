import {
  FraudRule,
  FraudDetection,
  SettlementEvent,
  PacketEvent,
  ChannelEvent,
} from '../fraud-detector';

/**
 * Configuration for UnusualSettlementAmountRule
 */
export interface UnusualSettlementAmountConfig {
  /**
   * Maximum settlement amount threshold (default: 1000000 units)
   */
  maxSettlementAmount: number;
}

/**
 * Detects settlement amounts exceeding configured threshold
 *
 * High severity rule that triggers when settlement amount exceeds 1M units
 * (configurable). Helps detect unauthorized large transfers.
 */
export class UnusualSettlementAmountRule implements FraudRule {
  public readonly name = 'UnusualSettlementAmountRule';
  public readonly severity = 'high' as const;

  private readonly config: UnusualSettlementAmountConfig;

  constructor(config: UnusualSettlementAmountConfig) {
    this.config = config;
  }

  /**
   * Check if settlement amount exceeds threshold
   */
  public async check(event: SettlementEvent | PacketEvent | ChannelEvent): Promise<FraudDetection> {
    // Only monitor settlement events
    if (event.type !== 'settlement') {
      return { detected: false };
    }

    const settlementEvent = event as SettlementEvent;

    // Check if amount exceeds threshold
    if (settlementEvent.amount > this.config.maxSettlementAmount) {
      return {
        detected: true,
        peerId: settlementEvent.peerId,
        details: {
          description: `Unusual settlement amount: ${settlementEvent.amount} units exceeds threshold of ${this.config.maxSettlementAmount} units`,
          settlementAmount: settlementEvent.amount,
          threshold: this.config.maxSettlementAmount,
          channelId: settlementEvent.channelId,
          timestamp: settlementEvent.timestamp,
        },
      };
    }

    return { detected: false };
  }
}
