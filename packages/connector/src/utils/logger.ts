/**
 * Logger Configuration Module - Pino structured logging for ILP connector
 * @packageDocumentation
 * @remarks
 * Provides structured JSON logging with correlation IDs for packet tracking.
 * Outputs to stdout for Docker container log aggregation.
 * Optionally emits log entries as telemetry events to dashboard.
 */

import pino from 'pino';
import { randomBytes } from 'crypto';
import { createTelemetryTransport } from '../telemetry/pino-telemetry-transport';
import type { TelemetryEmitter } from '../telemetry/telemetry-emitter';

/**
 * Logger type interface - wraps Pino logger
 * @remarks
 * Supports DEBUG, INFO, WARN, ERROR log levels with structured field logging.
 * Usage: logger.info({ field1, field2 }, 'message')
 */
export type Logger = pino.Logger;

/**
 * Valid log levels for the logger
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Default log level when LOG_LEVEL environment variable not set
 */
const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/**
 * Validate and normalize log level from environment variable
 * @param envLevel - Log level from environment variable (case-insensitive)
 * @returns Normalized log level or default if invalid
 * @remarks
 * Converts to lowercase and validates against allowed values.
 * Returns default 'info' level if invalid value provided.
 */
function getValidLogLevel(envLevel?: string): LogLevel {
  if (!envLevel) {
    return DEFAULT_LOG_LEVEL;
  }

  const normalized = envLevel.toLowerCase();
  const validLevels: LogLevel[] = ['debug', 'info', 'warn', 'error'];

  if (validLevels.includes(normalized as LogLevel)) {
    return normalized as LogLevel;
  }

  return DEFAULT_LOG_LEVEL;
}

/**
 * Serializer for sanitizing wallet objects in logs
 * @param wallet - Wallet object (may contain sensitive data)
 * @returns Sanitized wallet object safe for logging
 * @remarks
 * Removes: privateKey, mnemonic, seed, encryptionKey, secret
 * CRITICAL: Prevents private key leakage in logs
 */
export function sanitizeWalletForLogs(wallet: Record<string, unknown>): Record<string, unknown> {
  if (!wallet || typeof wallet !== 'object') {
    return wallet;
  }

  // Create shallow copy to avoid mutating original
  const sanitized = { ...wallet };

  // Remove all sensitive fields
  sanitized.privateKey = '[REDACTED]';
  sanitized.mnemonic = '[REDACTED]';
  sanitized.seed = '[REDACTED]';
  sanitized.encryptionKey = '[REDACTED]';
  sanitized.secret = '[REDACTED]';

  // Also handle nested objects (e.g., wallet.signer.privateKey)
  if (sanitized.signer && typeof sanitized.signer === 'object') {
    sanitized.signer = { ...(sanitized.signer as Record<string, unknown>) };
    (sanitized.signer as Record<string, unknown>).privateKey = '[REDACTED]';
    (sanitized.signer as Record<string, unknown>).secret = '[REDACTED]';
  }

  return sanitized;
}

/**
 * Create configured Pino logger instance with node ID context
 * @param nodeId - Connector node ID to include in all log entries
 * @param logLevel - Optional log level override (defaults to LOG_LEVEL env var or 'info')
 * @param telemetryEmitter - Optional TelemetryEmitter for sending logs to dashboard
 * @returns Configured Pino logger instance with nodeId as base context
 *
 * @example
 * ```typescript
 * const logger = createLogger('connector-a');
 * logger.info({ correlationId: 'pkt_abc123', destination: 'g.dest' }, 'Packet received');
 * // Output: {"level":"info","time":1703620800000,"nodeId":"connector-a","correlationId":"pkt_abc123","destination":"g.dest","msg":"Packet received"}
 * ```
 *
 * @example With telemetry
 * ```typescript
 * const telemetryEmitter = new TelemetryEmitter('ws://dashboard:9000', 'connector-a', logger);
 * const logger = createLogger('connector-a', 'info', telemetryEmitter);
 * logger.info('Packet received'); // Logged to stdout AND sent to dashboard
 * ```
 *
 * @remarks
 * - Outputs JSON to stdout for Docker log aggregation
 * - Log level configurable via LOG_LEVEL environment variable (DEBUG, INFO, WARN, ERROR)
 * - Default level: INFO if LOG_LEVEL not set
 * - All log entries include nodeId field for multi-node differentiation
 * - Uses child logger pattern to inject nodeId context
 * - If telemetryEmitter provided, log entries are also sent to dashboard as LOG telemetry events
 * - Telemetry emission is non-blocking and will not impact logging performance
 * - Wallet data serializers automatically redact sensitive cryptographic material
 */
export function createLogger(
  nodeId: string,
  logLevel?: string,
  telemetryEmitter?: TelemetryEmitter
): Logger {
  // Get log level from parameter, environment variable, or default
  const level = logLevel ? getValidLogLevel(logLevel) : getValidLogLevel(process.env.LOG_LEVEL);

  // Create base Pino logger with JSON output to stdout
  let baseLogger: pino.Logger;

  // Configure serializers to redact sensitive wallet data
  const serializers = {
    wallet: sanitizeWalletForLogs,
    masterSeed: () => '[REDACTED]',
    privateKey: () => '[REDACTED]',
    mnemonic: () => '[REDACTED]',
    seed: () => '[REDACTED]',
    encryptionKey: () => '[REDACTED]',
    secret: () => '[REDACTED]',
  };

  if (telemetryEmitter) {
    // Create telemetry transport for LOG emission
    const transport = createTelemetryTransport((logEntry) => {
      telemetryEmitter.emitLog(logEntry);
    });

    // Create logger with multistream: stdout + telemetry
    baseLogger = pino(
      {
        level,
        serializers,
      },
      pino.multistream([
        { stream: process.stdout }, // Primary output to stdout
        { stream: transport }, // Secondary output to telemetry
      ])
    );
  } else {
    // Create standard logger without telemetry
    baseLogger = pino({
      level,
      serializers,
    });
  }

  // Return child logger with nodeId context
  // All logs from this logger will include nodeId field
  return baseLogger.child({ nodeId });
}

/**
 * Generate unique correlation ID for packet tracking
 * @returns Correlation ID in format: pkt_{16-character-hex-string}
 *
 * @example
 * ```typescript
 * const correlationId = generateCorrelationId();
 * // Returns: "pkt_abc123def4567890"
 * ```
 *
 * @remarks
 * Used to track ILP packets through multi-hop flows across log entries.
 * Format: 'pkt_' prefix + 16-character hex string from 8 random bytes.
 * Each call generates a unique ID using cryptographically secure randomness.
 */
export function generateCorrelationId(): string {
  return `pkt_${randomBytes(8).toString('hex')}`;
}
