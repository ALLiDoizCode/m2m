import pino from 'pino';
import { FraudMetricsCollector } from '../../../src/security/fraud-metrics';

describe('FraudMetricsCollector', () => {
  let metrics: FraudMetricsCollector;
  let logger: pino.Logger;

  beforeEach(() => {
    logger = pino({ level: 'silent' });
    metrics = new FraudMetricsCollector(logger);
  });

  afterEach(() => {
    metrics.clearAll();
  });

  describe('recordDetection', () => {
    it('should record fraud detection', () => {
      metrics.recordDetection('SuddenTrafficSpikeRule', 'medium');

      const byLabel = metrics.getDetectionsByLabel();
      expect(byLabel.get('SuddenTrafficSpikeRule:medium')).toBe(1);
    });

    it('should increment detection counter', () => {
      metrics.recordDetection('DoubleSpendRule', 'critical');
      metrics.recordDetection('DoubleSpendRule', 'critical');
      metrics.recordDetection('DoubleSpendRule', 'critical');

      const byLabel = metrics.getDetectionsByLabel();
      expect(byLabel.get('DoubleSpendRule:critical')).toBe(3);
    });

    it('should track different rule types separately', () => {
      metrics.recordDetection('Rule1', 'high');
      metrics.recordDetection('Rule2', 'medium');
      metrics.recordDetection('Rule1', 'high');

      const byLabel = metrics.getDetectionsByLabel();
      expect(byLabel.get('Rule1:high')).toBe(2);
      expect(byLabel.get('Rule2:medium')).toBe(1);
    });
  });

  describe('recordFalsePositive', () => {
    it('should record false positive', () => {
      metrics.recordFalsePositive('TestRule');

      expect(metrics.getFalsePositives()).toBe(1);
    });

    it('should increment false positive counter', () => {
      metrics.recordFalsePositive('Rule1');
      metrics.recordFalsePositive('Rule2');
      metrics.recordFalsePositive('Rule1');

      expect(metrics.getFalsePositives()).toBe(3);
    });
  });

  describe('recordBlockedTransaction', () => {
    it('should record blocked transaction', () => {
      metrics.recordBlockedTransaction('peer-123', 'DoubleSpendRule');

      expect(metrics.getBlockedTransactions()).toBe(1);
    });

    it('should increment blocked transaction counter', () => {
      metrics.recordBlockedTransaction('peer-1', 'Rule1');
      metrics.recordBlockedTransaction('peer-2', 'Rule2');
      metrics.recordBlockedTransaction('peer-1', 'Rule1');

      expect(metrics.getBlockedTransactions()).toBe(3);
    });

    it('should group blocked transactions by peer', () => {
      metrics.recordBlockedTransaction('peer-1', 'Rule1');
      metrics.recordBlockedTransaction('peer-1', 'Rule2');
      metrics.recordBlockedTransaction('peer-2', 'Rule1');

      const byPeer = metrics.getBlockedTransactionsByPeer();
      expect(byPeer.get('peer-1')).toBe(2);
      expect(byPeer.get('peer-2')).toBe(1);
    });
  });

  describe('recordAlert', () => {
    it('should record alert', () => {
      metrics.recordAlert('critical', 'email');

      const byLabel = metrics.getAlertsByLabel();
      expect(byLabel.get('critical:email')).toBe(1);
    });

    it('should track different alert channels separately', () => {
      metrics.recordAlert('critical', 'email');
      metrics.recordAlert('critical', 'slack');
      metrics.recordAlert('high', 'slack');

      const byLabel = metrics.getAlertsByLabel();
      expect(byLabel.get('critical:email')).toBe(1);
      expect(byLabel.get('critical:slack')).toBe(1);
      expect(byLabel.get('high:slack')).toBe(1);
    });
  });

  describe('getDetectionsPerHour', () => {
    it('should return 0 with no detections', () => {
      expect(metrics.getDetectionsPerHour()).toBe(0);
    });

    it('should count detections within last hour', () => {
      const now = Date.now();

      // Use private method to add detections with custom timestamps
      metrics['detections'].push({
        ruleType: 'Rule1',
        severity: 'medium',
        timestamp: now - 30 * 60 * 1000, // 30 minutes ago
      });

      metrics['detections'].push({
        ruleType: 'Rule2',
        severity: 'high',
        timestamp: now - 10 * 60 * 1000, // 10 minutes ago
      });

      expect(metrics.getDetectionsPerHour()).toBe(2);
    });

    it('should exclude detections older than 1 hour', () => {
      const now = Date.now();

      metrics['detections'].push({
        ruleType: 'Rule1',
        severity: 'medium',
        timestamp: now - 2 * 60 * 60 * 1000, // 2 hours ago
      });

      metrics['detections'].push({
        ruleType: 'Rule2',
        severity: 'high',
        timestamp: now - 30 * 60 * 1000, // 30 minutes ago
      });

      expect(metrics.getDetectionsPerHour()).toBe(1);
    });
  });

  describe('getDetectionsBySeverity', () => {
    it('should group detections by severity', () => {
      metrics.recordDetection('Rule1', 'critical');
      metrics.recordDetection('Rule2', 'critical');
      metrics.recordDetection('Rule3', 'high');
      metrics.recordDetection('Rule4', 'medium');

      const bySeverity = metrics.getDetectionsBySeverity();
      expect(bySeverity.get('critical')).toBe(2);
      expect(bySeverity.get('high')).toBe(1);
      expect(bySeverity.get('medium')).toBe(1);
    });
  });

  describe('exportPrometheusMetrics', () => {
    it('should export metrics in Prometheus format', () => {
      metrics.recordDetection('DoubleSpendRule', 'critical');
      metrics.recordDetection('TrafficSpikeRule', 'medium');
      metrics.recordFalsePositive('TrafficSpikeRule');
      metrics.recordBlockedTransaction('peer-123', 'DoubleSpendRule');

      const output = metrics.exportPrometheusMetrics();

      expect(output).toContain('# HELP fraud_detections_total');
      expect(output).toContain('# TYPE fraud_detections_total counter');
      expect(output).toContain(
        'fraud_detections_total{rule_type="DoubleSpendRule",severity="critical"} 1'
      );
      expect(output).toContain(
        'fraud_detections_total{rule_type="TrafficSpikeRule",severity="medium"} 1'
      );

      expect(output).toContain('# HELP fraud_false_positives_total');
      expect(output).toContain('fraud_false_positives_total{rule_type="TrafficSpikeRule"} 1');

      expect(output).toContain('# HELP fraud_blocked_transactions_total');
      expect(output).toContain('fraud_blocked_transactions_total{peer_id="peer-123"} 1');

      expect(output).toContain('# HELP fraud_detections_per_hour');
      expect(output).toContain('fraud_detections_per_hour');
    });

    it('should handle empty metrics', () => {
      const output = metrics.exportPrometheusMetrics();

      expect(output).toContain('# HELP fraud_detections_total');
      expect(output).toContain('# HELP fraud_false_positives_total');
      expect(output).toContain('# HELP fraud_blocked_transactions_total');
      expect(output).toContain('# HELP fraud_detections_per_hour');
      expect(output).toContain('fraud_detections_per_hour 0');
    });
  });

  describe('clearAll', () => {
    it('should clear all metrics', () => {
      metrics.recordDetection('Rule1', 'critical');
      metrics.recordFalsePositive('Rule1');
      metrics.recordBlockedTransaction('peer-1', 'Rule1');
      metrics.recordAlert('critical', 'email');

      metrics.clearAll();

      expect(metrics.getDetectionsPerHour()).toBe(0);
      expect(metrics.getFalsePositives()).toBe(0);
      expect(metrics.getBlockedTransactions()).toBe(0);
      expect(metrics.getDetectionsByLabel().size).toBe(0);
      expect(metrics.getAlertsByLabel().size).toBe(0);
    });
  });

  describe('async timeout patterns', () => {
    it('should complete metric recording within 50ms', () => {
      const startTime = Date.now();

      for (let i = 0; i < 100; i++) {
        metrics.recordDetection(`Rule${i}`, 'medium');
      }

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(50);
    });
  });
});
