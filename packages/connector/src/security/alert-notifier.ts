import { Logger } from 'pino';
import { FraudDetectionEvent } from './reputation-tracker';

/**
 * Email alert configuration
 */
export interface EmailAlertConfig {
  enabled: boolean;
  recipients: string[];
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPassword?: string;
}

/**
 * Slack alert configuration
 */
export interface SlackAlertConfig {
  enabled: boolean;
  webhookUrl: string;
  channel: string;
}

/**
 * Alert configuration combining email and Slack
 */
export interface AlertConfig {
  email?: EmailAlertConfig;
  slack?: SlackAlertConfig;
  /**
   * Retry configuration for alert delivery failures
   */
  retryAttempts?: number;
  retryDelayMs?: number;
}

/**
 * AlertNotifier sends fraud detection alerts via email and Slack
 *
 * Severity-based routing:
 * - Critical: All configured channels (email + Slack)
 * - High: Slack only
 * - Medium/Low: Log only (no external alerts)
 */
export class AlertNotifier {
  private readonly logger: Logger;
  private readonly config: AlertConfig;

  constructor(logger: Logger, config: AlertConfig) {
    this.logger = logger.child({ component: 'AlertNotifier' });
    this.config = {
      retryAttempts: 3,
      retryDelayMs: 1000,
      ...config,
    };

    this.logger.info('AlertNotifier initialized', {
      emailEnabled: config.email?.enabled ?? false,
      slackEnabled: config.slack?.enabled ?? false,
    });
  }

  /**
   * Send alert for fraud detection event
   */
  public async sendAlert(event: FraudDetectionEvent): Promise<void> {
    const { severity, ruleName, peerId, details } = event;

    // Severity-based routing
    if (severity === 'critical') {
      // Critical: Send to all configured channels
      await Promise.allSettled([
        this.sendEmailAlert(severity, this.formatAlertMessage(event)),
        this.sendSlackAlert(severity, this.formatAlertMessage(event)),
      ]);
    } else if (severity === 'high') {
      // High: Send to Slack only
      await this.sendSlackAlert(severity, this.formatAlertMessage(event));
    } else {
      // Medium/Low: Log only
      this.logger.info('Fraud alert (log only)', {
        severity,
        ruleName,
        peerId,
        details,
      });
    }
  }

  /**
   * Send email alert with retry logic
   */
  public async sendEmailAlert(severity: string, message: string): Promise<void> {
    if (!this.config.email?.enabled) {
      return;
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < (this.config.retryAttempts ?? 3); attempt++) {
      try {
        await this.sendEmailAlertInternal(severity, message);
        this.logger.info('Email alert sent successfully', { severity, attempt });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn('Email alert delivery failed, retrying', {
          severity,
          attempt,
          error: lastError.message,
        });

        // Exponential backoff
        const delay = (this.config.retryDelayMs ?? 1000) * Math.pow(2, attempt);
        await this.sleep(delay);
      }
    }

    // Alert delivery failure: log error, retry with exponential backoff
    this.logger.error('Failed to send email alert after retries', {
      severity,
      attempts: this.config.retryAttempts,
      error: lastError?.message,
    });
  }

  /**
   * Internal email alert implementation (to be replaced with actual SMTP integration)
   */
  private async sendEmailAlertInternal(severity: string, message: string): Promise<void> {
    if (!this.config.email?.enabled) {
      return;
    }

    // Mock implementation - replace with actual SMTP integration
    this.logger.debug('Email alert would be sent', {
      severity,
      recipients: this.config.email.recipients,
      message,
      smtpHost: this.config.email.smtpHost,
    });

    // Simulate network delay
    await this.sleep(10);

    // For now, just log the alert
    // TODO: Implement actual SMTP integration using nodemailer or similar
  }

  /**
   * Send Slack alert with retry logic
   */
  public async sendSlackAlert(severity: string, message: string): Promise<void> {
    if (!this.config.slack?.enabled) {
      return;
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < (this.config.retryAttempts ?? 3); attempt++) {
      try {
        await this.sendSlackAlertInternal(severity, message);
        this.logger.info('Slack alert sent successfully', { severity, attempt });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn('Slack alert delivery failed, retrying', {
          severity,
          attempt,
          error: lastError.message,
        });

        // Exponential backoff
        const delay = (this.config.retryDelayMs ?? 1000) * Math.pow(2, attempt);
        await this.sleep(delay);
      }
    }

    // Alert delivery failure: log error, retry with exponential backoff
    this.logger.error('Failed to send Slack alert after retries', {
      severity,
      attempts: this.config.retryAttempts,
      error: lastError?.message,
    });
  }

  /**
   * Internal Slack alert implementation (to be replaced with actual webhook POST)
   */
  private async sendSlackAlertInternal(severity: string, message: string): Promise<void> {
    if (!this.config.slack?.enabled) {
      return;
    }

    // Mock implementation - replace with actual webhook POST
    this.logger.debug('Slack alert would be sent', {
      severity,
      webhookUrl: this.config.slack.webhookUrl,
      channel: this.config.slack.channel,
      message,
    });

    // Simulate network delay
    await this.sleep(10);

    // For now, just log the alert
    // TODO: Implement actual webhook POST using fetch or axios
  }

  /**
   * Format alert message from fraud detection event
   */
  private formatAlertMessage(event: FraudDetectionEvent): string {
    const { severity, ruleName, peerId, timestamp, details } = event;
    const date = new Date(timestamp).toISOString();

    let message = `🚨 FRAUD ALERT [${severity.toUpperCase()}]\n`;
    message += `Rule: ${ruleName}\n`;
    message += `Peer: ${peerId}\n`;
    message += `Time: ${date}\n`;

    if (details?.description) {
      message += `\nDetails: ${details.description}\n`;
    }

    return message;
  }

  /**
   * Sleep helper for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
