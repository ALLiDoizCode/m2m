/**
 * Suspicious Activity Detector
 * Story 11.9: Security Hardening for Agent Wallets
 *
 * Detects suspicious patterns: rapid funding requests, unusual transaction amounts
 */

import type { Logger } from 'pino';

/**
 * Detection configuration
 */
export interface DetectionConfig {
  rapidFundingThreshold: number; // Funding requests/hour before flagging (default: 5)
  unusualTransactionStdDev: number; // Std deviations from mean to flag (default: 3)
}

/**
 * Transaction history entry
 */
export interface TransactionHistoryEntry {
  amount: bigint;
  token: string;
  timestamp: number;
}

/**
 * Suspicious Activity Detector
 * Detects fraud patterns in wallet operations
 */
export class SuspiciousActivityDetector {
  private config: DetectionConfig;
  private logger: Logger;
  private fundingHistory: Map<string, number[]>; // Map<agentId, timestamps[]>
  private transactionHistory: Map<string, TransactionHistoryEntry[]>; // Map<agentId, transactions[]>

  // Time window for rapid funding detection (1 hour)
  private static readonly FUNDING_WINDOW_MS = 60 * 60 * 1000;

  // History retention (30 days for statistical analysis)
  private static readonly HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

  constructor(config: DetectionConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.fundingHistory = new Map();
    this.transactionHistory = new Map();
  }

  /**
   * Detect rapid funding requests
   * @param agentId - Agent identifier
   * @returns True if suspicious rapid funding detected
   * @remarks
   * Flags if >5 funding requests in last hour (configurable threshold)
   */
  detectRapidFunding(agentId: string): boolean {
    const now = Date.now();
    const windowStart = now - SuspiciousActivityDetector.FUNDING_WINDOW_MS;

    // Get funding timestamps for this agent
    let timestamps = this.fundingHistory.get(agentId) || [];

    // Filter to current window
    timestamps = timestamps.filter((ts) => ts > windowStart);

    // Check threshold
    const isSuspicious = timestamps.length >= this.config.rapidFundingThreshold;

    if (isSuspicious) {
      this.logger.warn(
        {
          agentId,
          fundingCount: timestamps.length,
          threshold: this.config.rapidFundingThreshold,
          windowHours: 1,
        },
        'Rapid funding detected'
      );
    }

    return isSuspicious;
  }

  /**
   * Detect unusual transaction patterns
   * @param agentId - Agent identifier
   * @param amount - Transaction amount
   * @param token - Token symbol
   * @returns True if unusual transaction detected
   * @remarks
   * Flags if transaction is >3 standard deviations from agent's mean transaction size
   * or if token is not previously used by agent
   */
  detectUnusualTransactions(agentId: string, amount: bigint, token: string): boolean {
    const transactions = this.transactionHistory.get(agentId) || [];

    // Check for new token (not previously used)
    const usedTokens = new Set(transactions.map((tx) => tx.token));
    if (!usedTokens.has(token) && transactions.length > 0) {
      this.logger.warn(
        {
          agentId,
          token,
          amount: amount.toString(),
        },
        'Unusual transaction: new token for agent'
      );
      return true;
    }

    // Need at least 10 transactions for statistical analysis
    if (transactions.length < 10) {
      return false; // Not enough data
    }

    // Filter transactions for same token
    const tokenTransactions = transactions.filter((tx) => tx.token === token);

    if (tokenTransactions.length < 10) {
      return false; // Not enough token-specific data
    }

    // Calculate mean and standard deviation
    const amounts = tokenTransactions.map((tx) => Number(tx.amount));
    const mean = amounts.reduce((sum, val) => sum + val, 0) / amounts.length;
    const variance =
      amounts.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / amounts.length;
    const stdDev = Math.sqrt(variance);

    // Check if transaction is outlier (>3 std deviations from mean)
    const amountNum = Number(amount);
    const deviations = Math.abs(amountNum - mean) / (stdDev || 1); // Avoid division by zero

    const isOutlier = deviations > this.config.unusualTransactionStdDev;

    if (isOutlier) {
      this.logger.warn(
        {
          agentId,
          amount: amount.toString(),
          token,
          mean: mean.toFixed(2),
          stdDev: stdDev.toFixed(2),
          deviations: deviations.toFixed(2),
        },
        'Unusual transaction: statistical outlier'
      );
    }

    return isOutlier;
  }

  /**
   * Record funding request
   * @param agentId - Agent identifier
   * @remarks
   * Stores timestamp for rapid funding detection
   */
  recordFundingRequest(agentId: string): void {
    const now = Date.now();
    const windowStart = now - SuspiciousActivityDetector.FUNDING_WINDOW_MS;

    let timestamps = this.fundingHistory.get(agentId) || [];

    // Filter to current window
    timestamps = timestamps.filter((ts) => ts > windowStart);

    // Add current timestamp
    timestamps.push(now);

    this.fundingHistory.set(agentId, timestamps);
  }

  /**
   * Record transaction
   * @param agentId - Agent identifier
   * @param amount - Transaction amount
   * @param token - Token symbol
   * @remarks
   * Stores transaction for statistical analysis
   */
  recordTransaction(agentId: string, amount: bigint, token: string): void {
    const now = Date.now();
    const retentionCutoff = now - SuspiciousActivityDetector.HISTORY_RETENTION_MS;

    let transactions = this.transactionHistory.get(agentId) || [];

    // Filter to retention window (30 days)
    transactions = transactions.filter((tx) => tx.timestamp > retentionCutoff);

    // Add current transaction
    transactions.push({
      amount,
      token,
      timestamp: now,
    });

    this.transactionHistory.set(agentId, transactions);
  }

  /**
   * Clear all detection history
   * @remarks
   * Used for testing or manual reset
   */
  clear(): void {
    this.fundingHistory.clear();
    this.transactionHistory.clear();
    this.logger.info('Suspicious activity detection history cleared');
  }
}
