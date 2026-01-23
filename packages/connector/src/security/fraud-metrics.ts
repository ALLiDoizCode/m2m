import { Logger } from 'pino';

/**
 * Metrics interface for fraud detection monitoring
 */
export interface FraudMetrics {
  recordDetection(ruleType: string, severity: string): void;
  recordFalsePositive(ruleType: string): void;
  recordBlockedTransaction(peerId: string, ruleType: string): void;
  recordAlert(severity: string, channel: string): void;
  getDetectionsPerHour(): number;
  getFalsePositives(): number;
  getBlockedTransactions(): number;
}

/**
 * Detection tracking entry
 */
interface DetectionEntry {
  ruleType: string;
  severity: string;
  timestamp: number;
}

/**
 * Blocked transaction entry
 */
interface BlockedTransactionEntry {
  peerId: string;
  ruleType: string;
  timestamp: number;
}

/**
 * FraudMetricsCollector implements Prometheus-compatible metrics for fraud detection
 *
 * Metrics exposed:
 * - fraud_detections_total: Counter by rule type and severity
 * - fraud_false_positives_total: Counter by rule type
 * - fraud_blocked_transactions_total: Counter by peer and rule type
 * - fraud_alerts_total: Counter by severity and channel
 */
export class FraudMetricsCollector implements FraudMetrics {
  private readonly logger: Logger;

  // In-memory metric storage (replace with Prometheus client in production)
  private readonly detections: DetectionEntry[];
  private readonly falsePositives: Map<string, number>;
  private readonly blockedTransactions: BlockedTransactionEntry[];
  private readonly alerts: Map<string, number>;

  // Metric counters by label
  private readonly detectionCounters: Map<string, number>;
  private readonly alertCounters: Map<string, number>;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'FraudMetricsCollector' });
    this.detections = [];
    this.falsePositives = new Map();
    this.blockedTransactions = [];
    this.alerts = new Map();
    this.detectionCounters = new Map();
    this.alertCounters = new Map();

    this.logger.info('FraudMetricsCollector initialized');
  }

  /**
   * Record a fraud detection
   */
  public recordDetection(ruleType: string, severity: string): void {
    this.detections.push({
      ruleType,
      severity,
      timestamp: Date.now(),
    });

    // Update labeled counter
    const label = `${ruleType}:${severity}`;
    const currentCount = this.detectionCounters.get(label) ?? 0;
    this.detectionCounters.set(label, currentCount + 1);

    this.logger.debug('Fraud detection recorded', { ruleType, severity });
  }

  /**
   * Record a false positive
   */
  public recordFalsePositive(ruleType: string): void {
    const currentCount = this.falsePositives.get(ruleType) ?? 0;
    this.falsePositives.set(ruleType, currentCount + 1);

    this.logger.debug('False positive recorded', { ruleType });
  }

  /**
   * Record a blocked transaction
   */
  public recordBlockedTransaction(peerId: string, ruleType: string): void {
    this.blockedTransactions.push({
      peerId,
      ruleType,
      timestamp: Date.now(),
    });

    this.logger.debug('Blocked transaction recorded', { peerId, ruleType });
  }

  /**
   * Record an alert sent
   */
  public recordAlert(severity: string, channel: string): void {
    const label = `${severity}:${channel}`;
    const currentCount = this.alertCounters.get(label) ?? 0;
    this.alertCounters.set(label, currentCount + 1);

    this.logger.debug('Alert recorded', { severity, channel });
  }

  /**
   * Calculate detections per hour (rolling 1-hour window)
   */
  public getDetectionsPerHour(): number {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const recentDetections = this.detections.filter((d) => d.timestamp >= oneHourAgo);
    return recentDetections.length;
  }

  /**
   * Get total false positives
   */
  public getFalsePositives(): number {
    let total = 0;
    for (const count of Array.from(this.falsePositives.values())) {
      total += count;
    }
    return total;
  }

  /**
   * Get total blocked transactions
   */
  public getBlockedTransactions(): number {
    return this.blockedTransactions.length;
  }

  /**
   * Get detections by rule type and severity (Prometheus-style)
   */
  public getDetectionsByLabel(): Map<string, number> {
    return new Map(this.detectionCounters);
  }

  /**
   * Get alerts by severity and channel (Prometheus-style)
   */
  public getAlertsByLabel(): Map<string, number> {
    return new Map(this.alertCounters);
  }

  /**
   * Get detections grouped by severity
   */
  public getDetectionsBySeverity(): Map<string, number> {
    const bySeverity = new Map<string, number>();

    for (const detection of this.detections) {
      const currentCount = bySeverity.get(detection.severity) ?? 0;
      bySeverity.set(detection.severity, currentCount + 1);
    }

    return bySeverity;
  }

  /**
   * Get blocked transactions grouped by peer
   */
  public getBlockedTransactionsByPeer(): Map<string, number> {
    const byPeer = new Map<string, number>();

    for (const blocked of this.blockedTransactions) {
      const currentCount = byPeer.get(blocked.peerId) ?? 0;
      byPeer.set(blocked.peerId, currentCount + 1);
    }

    return byPeer;
  }

  /**
   * Export metrics in Prometheus format (simplified)
   */
  public exportPrometheusMetrics(): string {
    let output = '';

    // fraud_detections_total
    output += '# HELP fraud_detections_total Total number of fraud detections\n';
    output += '# TYPE fraud_detections_total counter\n';
    for (const [label, count] of Array.from(this.detectionCounters)) {
      const [ruleType, severity] = label.split(':');
      output += `fraud_detections_total{rule_type="${ruleType}",severity="${severity}"} ${count}\n`;
    }

    // fraud_false_positives_total
    output += '# HELP fraud_false_positives_total Total number of false positives\n';
    output += '# TYPE fraud_false_positives_total counter\n';
    for (const [ruleType, count] of Array.from(this.falsePositives)) {
      output += `fraud_false_positives_total{rule_type="${ruleType}"} ${count}\n`;
    }

    // fraud_blocked_transactions_total
    output += '# HELP fraud_blocked_transactions_total Total number of blocked transactions\n';
    output += '# TYPE fraud_blocked_transactions_total counter\n';
    const byPeer = this.getBlockedTransactionsByPeer();
    for (const [peerId, count] of Array.from(byPeer)) {
      output += `fraud_blocked_transactions_total{peer_id="${peerId}"} ${count}\n`;
    }

    // fraud_detections_per_hour
    output += '# HELP fraud_detections_per_hour Fraud detections in the last hour\n';
    output += '# TYPE fraud_detections_per_hour gauge\n';
    output += `fraud_detections_per_hour ${this.getDetectionsPerHour()}\n`;

    return output;
  }

  /**
   * Clear all metrics (useful for testing)
   */
  public clearAll(): void {
    this.detections.length = 0;
    this.falsePositives.clear();
    this.blockedTransactions.length = 0;
    this.alerts.clear();
    this.detectionCounters.clear();
    this.alertCounters.clear();
  }
}
