import {
  FraudRule,
  FraudDetection,
  SettlementEvent,
  PacketEvent,
  ChannelEvent,
} from '../fraud-detector';

/**
 * Extended settlement event with balance data
 */
export interface BalanceEvent extends SettlementEvent {
  previousBalance?: number;
  newBalance?: number;
}

/**
 * Balance history entry for tracking balance changes
 */
interface BalanceHistory {
  peerId: string;
  balances: {
    balance: number;
    timestamp: number;
  }[];
}

/**
 * Detects balance manipulation attempts
 *
 * Critical severity rule that triggers when:
 * - Negative balance attempts are detected
 * - Unexpected balance decreases occur without legitimate settlement
 */
export class BalanceManipulationRule implements FraudRule {
  public readonly name = 'BalanceManipulationRule';
  public readonly severity = 'critical' as const;

  private readonly balanceHistory: Map<string, BalanceHistory>;

  constructor() {
    this.balanceHistory = new Map();
  }

  /**
   * Check if balance change represents manipulation attempt
   */
  public async check(event: SettlementEvent | PacketEvent | ChannelEvent): Promise<FraudDetection> {
    // Only monitor settlement events with balance data
    if (event.type !== 'settlement') {
      return { detected: false };
    }

    const balanceEvent = event as BalanceEvent;

    // Require balance data for manipulation detection
    if (balanceEvent.newBalance === undefined) {
      return { detected: false };
    }

    // Check for negative balance attempt
    if (balanceEvent.newBalance < 0) {
      return {
        detected: true,
        peerId: balanceEvent.peerId,
        details: {
          description: `Negative balance attempt detected: ${balanceEvent.newBalance}`,
          newBalance: balanceEvent.newBalance,
          previousBalance: balanceEvent.previousBalance,
          timestamp: balanceEvent.timestamp,
        },
      };
    }

    // Track balance history for unexpected decrease detection
    if (balanceEvent.previousBalance !== undefined) {
      // Get or initialize balance history for peer
      let history = this.balanceHistory.get(balanceEvent.peerId);
      if (!history) {
        history = {
          peerId: balanceEvent.peerId,
          balances: [],
        };
        this.balanceHistory.set(balanceEvent.peerId, history);
      }

      // Check for unexpected balance decrease (larger than settlement amount)
      const balanceDecrease = balanceEvent.previousBalance - balanceEvent.newBalance;
      if (balanceDecrease > 0 && balanceDecrease !== balanceEvent.amount) {
        return {
          detected: true,
          peerId: balanceEvent.peerId,
          details: {
            description: `Unexpected balance decrease detected: ${balanceDecrease} units (expected: ${balanceEvent.amount})`,
            previousBalance: balanceEvent.previousBalance,
            newBalance: balanceEvent.newBalance,
            expectedDecrease: balanceEvent.amount,
            actualDecrease: balanceDecrease,
            timestamp: balanceEvent.timestamp,
          },
        };
      }

      // Add current balance to history
      history.balances.push({
        balance: balanceEvent.newBalance,
        timestamp: balanceEvent.timestamp,
      });
    }

    return { detected: false };
  }

  /**
   * Clear balance history (useful for testing)
   */
  public clearHistory(): void {
    this.balanceHistory.clear();
  }

  /**
   * Get balance history for a peer (useful for testing)
   */
  public getBalanceHistory(peerId: string): BalanceHistory | undefined {
    return this.balanceHistory.get(peerId);
  }
}
