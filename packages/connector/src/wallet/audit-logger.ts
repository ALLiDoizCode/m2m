/**
 * Audit Logger for Wallet Operations
 * Story 11.9: Security Hardening for Agent Wallets
 *
 * Comprehensive audit trail for all wallet operations (create, fund, transact, suspend)
 */

import type { Logger } from 'pino';
import Database from 'better-sqlite3';

/**
 * Audit log entry
 */
export interface AuditLogEntry {
  id?: number; // Auto-generated ID
  timestamp: number; // Unix timestamp
  operation: string; // Operation type (wallet_created, wallet_funded, payment_sent, etc.)
  agentId: string; // Agent ID affected by operation
  details: Record<string, unknown>; // Operation-specific details
  ip?: string; // IP address of request (if applicable)
  userAgent?: string; // User agent of request (if applicable)
  result: 'success' | 'failure'; // Operation result
}

/**
 * Audit Logger
 * Logs all wallet operations to database + Pino logs
 */
export class AuditLogger {
  private logger: Logger;
  private db?: Database.Database;

  constructor(logger: Logger, db?: Database.Database) {
    this.logger = logger;
    this.db = db;

    // Initialize database schema if provided
    if (this.db) {
      this.initializeSchema();
    }
  }

  /**
   * Initialize audit log database schema
   */
  private initializeSchema(): void {
    if (!this.db) return;

    // Create audit log table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wallet_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        operation TEXT NOT NULL,
        agentId TEXT NOT NULL,
        details TEXT NOT NULL,
        ip TEXT,
        userAgent TEXT,
        result TEXT NOT NULL CHECK(result IN ('success', 'failure'))
      )
    `);

    // Create indexes for common queries
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_audit_agentId ON wallet_audit_log(agentId)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_audit_operation ON wallet_audit_log(operation)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON wallet_audit_log(timestamp)');

    this.logger.debug('Audit log database schema initialized');
  }

  /**
   * Log wallet operation to audit trail
   * @param operation - Operation type
   * @param agentId - Agent ID
   * @param details - Operation-specific details
   * @param result - Operation result (default: 'success')
   * @param ip - IP address (optional)
   * @param userAgent - User agent (optional)
   */
  async auditLog(
    operation: string,
    agentId: string,
    details: Record<string, unknown>,
    result: 'success' | 'failure' = 'success',
    ip?: string,
    userAgent?: string
  ): Promise<void> {
    const timestamp = Date.now();

    // Log to Pino (real-time monitoring)
    this.logger.info(
      {
        audit: true,
        timestamp,
        operation,
        agentId,
        details,
        result,
        ip,
        userAgent,
      },
      `Wallet audit: ${operation}`
    );

    // Log to database (queryable persistence)
    if (this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO wallet_audit_log (timestamp, operation, agentId, details, result, ip, userAgent)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(timestamp, operation, agentId, JSON.stringify(details), result, ip, userAgent);
      } catch (error) {
        this.logger.error({ error, operation, agentId }, 'Failed to write audit log to database');
      }
    }
  }

  /**
   * Query audit log
   * @param agentId - Filter by agent ID (optional)
   * @param operation - Filter by operation type (optional)
   * @param startDate - Filter by start timestamp (optional)
   * @param endDate - Filter by end timestamp (optional)
   * @returns Audit log entries in reverse chronological order
   */
  async getAuditLog(
    agentId?: string,
    operation?: string,
    startDate?: number,
    endDate?: number
  ): Promise<AuditLogEntry[]> {
    if (!this.db) {
      this.logger.warn('Audit log query attempted but no database configured');
      return [];
    }

    try {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (agentId) {
        conditions.push('agentId = ?');
        params.push(agentId);
      }

      if (operation) {
        conditions.push('operation = ?');
        params.push(operation);
      }

      if (startDate) {
        conditions.push('timestamp >= ?');
        params.push(startDate);
      }

      if (endDate) {
        conditions.push('timestamp <= ?');
        params.push(endDate);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const stmt = this.db.prepare(`
        SELECT * FROM wallet_audit_log
        ${whereClause}
        ORDER BY timestamp DESC
        LIMIT 1000
      `);

      const rows = stmt.all(...params) as Record<string, unknown>[];

      return rows.map((row) => ({
        id: row.id as number,
        timestamp: row.timestamp as number,
        operation: row.operation as string,
        agentId: row.agentId as string,
        details: JSON.parse(row.details as string) as Record<string, unknown>,
        result: row.result as 'success' | 'failure',
        ip: row.ip as string | undefined,
        userAgent: row.userAgent as string | undefined,
      })) as AuditLogEntry[];
    } catch (error) {
      this.logger.error({ error }, 'Failed to query audit log');
      return [];
    }
  }

  /**
   * Clear all audit log data
   * @remarks
   * WARNING: This permanently deletes all audit records
   * Only use for testing or authorized data purging
   */
  clear(): void {
    if (!this.db) return;

    try {
      this.db.exec('DELETE FROM wallet_audit_log');
      this.logger.warn('Audit log cleared (all records deleted)');
    } catch (error) {
      this.logger.error({ error }, 'Failed to clear audit log');
    }
  }
}
