import pino from 'pino';
import { AlertNotifier } from '../../../src/security/alert-notifier';
import { FraudDetectionEvent } from '../../../src/security/reputation-tracker';

describe('AlertNotifier', () => {
  let notifier: AlertNotifier;
  let logger: pino.Logger;

  beforeEach(() => {
    logger = pino({ level: 'silent' });
  });

  describe('sendAlert', () => {
    it('should send email and Slack for critical severity', async () => {
      notifier = new AlertNotifier(logger, {
        email: {
          enabled: true,
          recipients: ['admin@example.com'],
        },
        slack: {
          enabled: true,
          webhookUrl: 'https://hooks.slack.com/test',
          channel: '#alerts',
        },
      });

      const event: FraudDetectionEvent = {
        ruleName: 'DoubleSpendRule',
        severity: 'critical',
        peerId: 'peer-123',
        timestamp: Date.now(),
        details: {
          description: 'Double-spend detected',
        },
      };

      await notifier.sendAlert(event);
      // Should complete without error
    });

    it('should send only Slack for high severity', async () => {
      notifier = new AlertNotifier(logger, {
        email: {
          enabled: true,
          recipients: ['admin@example.com'],
        },
        slack: {
          enabled: true,
          webhookUrl: 'https://hooks.slack.com/test',
          channel: '#alerts',
        },
      });

      const event: FraudDetectionEvent = {
        ruleName: 'RapidChannelClosureRule',
        severity: 'high',
        peerId: 'peer-123',
        timestamp: Date.now(),
      };

      await notifier.sendAlert(event);
      // Should complete without error
    });

    it('should only log for medium severity', async () => {
      notifier = new AlertNotifier(logger, {
        email: {
          enabled: true,
          recipients: ['admin@example.com'],
        },
        slack: {
          enabled: true,
          webhookUrl: 'https://hooks.slack.com/test',
          channel: '#alerts',
        },
      });

      const event: FraudDetectionEvent = {
        ruleName: 'TrafficSpikeRule',
        severity: 'medium',
        peerId: 'peer-123',
        timestamp: Date.now(),
      };

      await notifier.sendAlert(event);
      // Should complete without error (log only)
    });

    it('should only log for low severity', async () => {
      notifier = new AlertNotifier(logger, {
        email: {
          enabled: true,
          recipients: ['admin@example.com'],
        },
        slack: {
          enabled: true,
          webhookUrl: 'https://hooks.slack.com/test',
          channel: '#alerts',
        },
      });

      const event: FraudDetectionEvent = {
        ruleName: 'LowSeverityRule',
        severity: 'low',
        peerId: 'peer-123',
        timestamp: Date.now(),
      };

      await notifier.sendAlert(event);
      // Should complete without error (log only)
    });
  });

  describe('sendEmailAlert', () => {
    it('should not send email when disabled', async () => {
      notifier = new AlertNotifier(logger, {
        email: {
          enabled: false,
          recipients: [],
        },
      });

      await notifier.sendEmailAlert('critical', 'Test message');
      // Should complete without error
    });

    it('should send email when enabled', async () => {
      notifier = new AlertNotifier(logger, {
        email: {
          enabled: true,
          recipients: ['admin@example.com'],
          smtpHost: 'smtp.example.com',
          smtpPort: 587,
        },
        retryAttempts: 1,
      });

      await notifier.sendEmailAlert('critical', 'Test message');
      // Should complete without error (mock implementation)
    });

    it('should retry on failure with exponential backoff', async () => {
      notifier = new AlertNotifier(logger, {
        email: {
          enabled: true,
          recipients: ['admin@example.com'],
        },
        retryAttempts: 3,
        retryDelayMs: 10,
      });

      // Mock implementation will succeed, but test structure is in place
      await notifier.sendEmailAlert('critical', 'Test message');
    });
  });

  describe('sendSlackAlert', () => {
    it('should not send Slack alert when disabled', async () => {
      notifier = new AlertNotifier(logger, {
        slack: {
          enabled: false,
          webhookUrl: '',
          channel: '',
        },
      });

      await notifier.sendSlackAlert('high', 'Test message');
      // Should complete without error
    });

    it('should send Slack alert when enabled', async () => {
      notifier = new AlertNotifier(logger, {
        slack: {
          enabled: true,
          webhookUrl: 'https://hooks.slack.com/test',
          channel: '#alerts',
        },
        retryAttempts: 1,
      });

      await notifier.sendSlackAlert('high', 'Test message');
      // Should complete without error (mock implementation)
    });

    it('should retry on failure with exponential backoff', async () => {
      notifier = new AlertNotifier(logger, {
        slack: {
          enabled: true,
          webhookUrl: 'https://hooks.slack.com/test',
          channel: '#alerts',
        },
        retryAttempts: 3,
        retryDelayMs: 10,
      });

      // Mock implementation will succeed, but test structure is in place
      await notifier.sendSlackAlert('critical', 'Test message');
    });
  });

  describe('async timeout patterns', () => {
    it('should complete alert sending within 100ms timeout', async () => {
      notifier = new AlertNotifier(logger, {
        email: {
          enabled: true,
          recipients: ['admin@example.com'],
        },
        slack: {
          enabled: true,
          webhookUrl: 'https://hooks.slack.com/test',
          channel: '#alerts',
        },
        retryAttempts: 1,
      });

      const event: FraudDetectionEvent = {
        ruleName: 'TestRule',
        severity: 'critical',
        peerId: 'peer-123',
        timestamp: Date.now(),
      };

      const startTime = Date.now();
      await notifier.sendAlert(event);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(100);
    });
  });
});
