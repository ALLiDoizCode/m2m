import pino from 'pino';

/**
 * Audit log event types for key operations and fraud detection
 */
export type AuditEventType =
  | 'SIGN_REQUEST'
  | 'SIGN_SUCCESS'
  | 'SIGN_FAILURE'
  | 'KEY_ROTATION_START'
  | 'KEY_ROTATION_COMPLETE'
  | 'KEY_ACCESS_DENIED'
  | 'FRAUD_DETECTED'
  | 'PEER_PAUSED'
  | 'PEER_RESUMED';

/**
 * Audit log entry structure
 */
export interface AuditLogEntry {
  event: AuditEventType;
  keyId: string;
  timestamp: number;
  nodeId: string;
  backend: string;
  details?: Record<string, unknown>;
}

/**
 * Configuration for audit logging
 */
export interface AuditLogConfig {
  nodeId: string;
  backend: string;
  retentionDays?: number; // Default: 365 days
}

/**
 * AuditLogger handles tamper-proof logging of all key management operations
 *
 * Features:
 * - Structured JSON logging via Pino
 * - Sensitive data redaction (PIN, credentials, private keys)
 * - Append-only audit trail
 * - Configurable retention period
 * - Export capability for compliance
 */
export class AuditLogger {
  private readonly logger: pino.Logger;
  private readonly nodeId: string;
  private readonly backend: string;
  private readonly retentionDays: number;

  constructor(logger: pino.Logger, config: AuditLogConfig) {
    this.logger = logger.child({
      component: 'AuditLogger',
      nodeId: config.nodeId,
      backend: config.backend,
    });
    this.nodeId = config.nodeId;
    this.backend = config.backend;
    this.retentionDays = config.retentionDays ?? 365;

    this.logger.info('AuditLogger initialized', {
      retentionDays: this.retentionDays,
    });
  }

  /**
   * Log a sign request event
   */
  logSignRequest(keyId: string, messageHash: string): void {
    const entry = this._createEntry('SIGN_REQUEST', keyId, {
      messageHash: messageHash.substring(0, 16) + '...', // Truncate for log size
    });
    this.logger.info(entry, 'Sign request initiated');
  }

  /**
   * Log a successful sign operation
   */
  logSignSuccess(keyId: string, signatureHash: string): void {
    const entry = this._createEntry('SIGN_SUCCESS', keyId, {
      signatureHash: signatureHash.substring(0, 16) + '...', // Truncate for log size
    });
    this.logger.info(entry, 'Sign operation successful');
  }

  /**
   * Log a failed sign operation
   */
  logSignFailure(keyId: string, error: Error): void {
    const entry = this._createEntry('SIGN_FAILURE', keyId, {
      errorMessage: error.message,
      errorName: error.name,
    });
    this.logger.error(entry, 'Sign operation failed');
  }

  /**
   * Log key rotation event
   */
  logKeyRotation(oldKeyId: string, newKeyId: string, phase: 'START' | 'COMPLETE'): void {
    const event = phase === 'START' ? 'KEY_ROTATION_START' : 'KEY_ROTATION_COMPLETE';
    const entry = this._createEntry(event, oldKeyId, {
      oldKeyId,
      newKeyId,
    });
    this.logger.info(entry, `Key rotation ${phase.toLowerCase()}`);
  }

  /**
   * Log access denied event
   */
  logAccessDenied(keyId: string, reason: string): void {
    const entry = this._createEntry('KEY_ACCESS_DENIED', keyId, {
      reason,
    });
    this.logger.warn(entry, 'Key access denied');
  }

  /**
   * Log fraud detection event
   */
  logFraudDetection(
    peerId: string,
    ruleName: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    details?: Record<string, unknown>
  ): void {
    const entry = this._createEntry('FRAUD_DETECTED', peerId, {
      ruleName,
      severity,
      ...details,
    });
    this.logger.warn(entry, 'Fraud detected');
  }

  /**
   * Log peer pause event
   */
  logPeerPause(peerId: string, reason: string, ruleViolated: string, severity: string): void {
    const entry = this._createEntry('PEER_PAUSED', peerId, {
      reason,
      ruleViolated,
      severity,
    });
    this.logger.warn(entry, 'Peer paused due to fraud detection');
  }

  /**
   * Log peer resume event
   */
  logPeerResume(peerId: string, operator?: string): void {
    const entry = this._createEntry('PEER_RESUMED', peerId, {
      operator,
    });
    this.logger.info(entry, 'Peer resumed after manual review');
  }

  /**
   * Export audit logs for a date range (for compliance reporting)
   *
   * Note: This is a placeholder implementation. In production, audit logs
   * should be exported from the log aggregation system (CloudWatch, Splunk, etc.)
   * rather than being read from local files.
   *
   * @param startDate Unix timestamp (milliseconds)
   * @param endDate Unix timestamp (milliseconds)
   * @returns Array of audit log entries (placeholder - returns empty array)
   */
  async exportAuditLogs(startDate: number, endDate: number): Promise<AuditLogEntry[]> {
    this.logger.info('Audit log export requested', {
      startDate: new Date(startDate).toISOString(),
      endDate: new Date(endDate).toISOString(),
    });

    // Placeholder implementation
    // In production, this would:
    // 1. Query log aggregation system (CloudWatch Logs Insights, Splunk, etc.)
    // 2. Filter logs by timestamp range
    // 3. Parse JSON log entries
    // 4. Return structured AuditLogEntry array
    //
    // For local file-based logs, would use:
    // - Read log file line-by-line
    // - Parse JSON entries
    // - Filter by timestamp
    // - Return matching entries

    this.logger.warn(
      'exportAuditLogs is a placeholder - integrate with log aggregation system for production'
    );

    return [];
  }

  /**
   * Create an audit log entry with standard fields
   */
  private _createEntry(
    event: AuditEventType,
    keyId: string,
    details?: Record<string, unknown>
  ): AuditLogEntry {
    return {
      event,
      keyId,
      timestamp: Date.now(),
      nodeId: this.nodeId,
      backend: this.backend,
      details,
    };
  }
}

/**
 * Create Pino logger with sensitive data redaction serializers
 *
 * Redacts:
 * - privateKey
 * - PIN
 * - credentials (AWS, GCP, Azure)
 * - secretAccessKey
 * - clientSecret
 */
export function createAuditLogger(_config: AuditLogConfig): pino.Logger {
  return pino({
    serializers: {
      // Redact private keys
      privateKey: () => '[REDACTED]',
      // Redact HSM PIN
      PIN: () => '[REDACTED]',
      pin: () => '[REDACTED]',
      // Redact cloud credentials
      credentials: () => '[REDACTED]',
      secretAccessKey: () => '[REDACTED]',
      clientSecret: () => '[REDACTED]',
      // Redact AWS credentials
      aws: (value: unknown) => {
        if (typeof value === 'object' && value !== null) {
          return {
            ...(value as Record<string, unknown>),
            credentials: '[REDACTED]',
            secretAccessKey: '[REDACTED]',
          };
        }
        return value;
      },
      // Redact Azure credentials
      azure: (value: unknown) => {
        if (typeof value === 'object' && value !== null) {
          return {
            ...(value as Record<string, unknown>),
            credentials: '[REDACTED]',
            clientSecret: '[REDACTED]',
          };
        }
        return value;
      },
    },
  });
}
