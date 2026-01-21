/**
 * Unit tests for Logger Configuration Module
 * @remarks
 * Tests Pino logger configuration and correlation ID generation.
 * Uses pino-test to capture log output for verification.
 */

import pino from 'pino';
import { createLogger, generateCorrelationId, Logger, sanitizeWalletForLogs } from './logger';

describe('Logger Configuration', () => {
  describe('createLogger', () => {
    it('should return a Pino logger instance', () => {
      // Arrange & Act
      const logger = createLogger('test-node');

      // Assert
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
    });

    it('should include nodeId in all log entries using child logger pattern', () => {
      // Arrange
      const logs: string[] = [];
      const mockWrite = (chunk: string): void => {
        logs.push(chunk);
      };

      // Create logger with custom stream to capture output
      const baseLogger = pino(
        { level: 'info' },
        {
          write: mockWrite,
        } as any // eslint-disable-line @typescript-eslint/no-explicit-any
      );
      const logger = baseLogger.child({ nodeId: 'test-node' });

      // Act
      logger.info({ testField: 'value' }, 'Test message');

      // Assert
      expect(logs.length).toBe(1);
      const logEntry = JSON.parse(logs[0]!);
      expect(logEntry.nodeId).toBe('test-node');
      expect(logEntry.testField).toBe('value');
      expect(logEntry.msg).toBe('Test message');
    });

    it('should use INFO level by default when LOG_LEVEL not set', () => {
      // Arrange
      const originalLogLevel = process.env.LOG_LEVEL;
      delete process.env.LOG_LEVEL;

      // Act
      const logger = createLogger('test-node');

      // Assert
      expect(logger.level).toBe('info');

      // Cleanup
      if (originalLogLevel) {
        process.env.LOG_LEVEL = originalLogLevel;
      }
    });

    it('should respect LOG_LEVEL environment variable', () => {
      // Arrange
      const originalLogLevel = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = 'debug';

      // Act
      const logger = createLogger('test-node');

      // Assert
      expect(logger.level).toBe('debug');

      // Cleanup
      if (originalLogLevel) {
        process.env.LOG_LEVEL = originalLogLevel;
      } else {
        delete process.env.LOG_LEVEL;
      }
    });

    it('should handle case-insensitive LOG_LEVEL values', () => {
      // Arrange
      const originalLogLevel = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = 'ERROR';

      // Act
      const logger = createLogger('test-node');

      // Assert
      expect(logger.level).toBe('error');

      // Cleanup
      if (originalLogLevel) {
        process.env.LOG_LEVEL = originalLogLevel;
      } else {
        delete process.env.LOG_LEVEL;
      }
    });

    it('should use INFO level for invalid LOG_LEVEL values', () => {
      // Arrange
      const originalLogLevel = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = 'invalid-level';

      // Act
      const logger = createLogger('test-node');

      // Assert
      expect(logger.level).toBe('info');

      // Cleanup
      if (originalLogLevel) {
        process.env.LOG_LEVEL = originalLogLevel;
      } else {
        delete process.env.LOG_LEVEL;
      }
    });

    it('should allow log level override via parameter', () => {
      // Arrange & Act
      const logger = createLogger('test-node', 'warn');

      // Assert
      expect(logger.level).toBe('warn');
    });
  });

  describe('generateCorrelationId', () => {
    it('should generate correlation ID with correct format (pkt_ prefix)', () => {
      // Arrange & Act
      const correlationId = generateCorrelationId();

      // Assert
      expect(correlationId).toMatch(/^pkt_[a-f0-9]{16}$/);
    });

    it('should generate unique correlation IDs on multiple calls', () => {
      // Arrange & Act
      const id1 = generateCorrelationId();
      const id2 = generateCorrelationId();
      const id3 = generateCorrelationId();

      // Assert
      expect(id1).not.toBe(id2);
      expect(id1).not.toBe(id3);
      expect(id2).not.toBe(id3);
    });

    it('should generate IDs with exactly 16 hex characters after prefix', () => {
      // Arrange & Act
      const correlationId = generateCorrelationId();
      const hexPart = correlationId.replace('pkt_', '');

      // Assert
      expect(hexPart.length).toBe(16);
      expect(hexPart).toMatch(/^[a-f0-9]+$/);
    });
  });

  describe('Logger Type Interface', () => {
    it('should support structured field logging', () => {
      // Arrange
      const logs: string[] = [];
      const mockWrite = (chunk: string): void => {
        logs.push(chunk);
      };

      const baseLogger = pino(
        { level: 'info' },
        {
          write: mockWrite,
        } as any // eslint-disable-line @typescript-eslint/no-explicit-any
      );
      const logger: Logger = baseLogger.child({ nodeId: 'test-node' });

      // Act
      logger.info(
        {
          correlationId: 'pkt_abc123',
          destination: 'g.connectorB',
          amount: '1000',
        },
        'Packet received'
      );

      // Assert
      expect(logs.length).toBe(1);
      const logEntry = JSON.parse(logs[0]!);
      expect(logEntry.correlationId).toBe('pkt_abc123');
      expect(logEntry.destination).toBe('g.connectorB');
      expect(logEntry.amount).toBe('1000');
      expect(logEntry.msg).toBe('Packet received');
    });

    it('should support all required log levels', () => {
      // Arrange
      const logs: string[] = [];
      const mockWrite = (chunk: string): void => {
        logs.push(chunk);
      };

      const baseLogger = pino(
        { level: 'debug' },
        {
          write: mockWrite,
        } as any // eslint-disable-line @typescript-eslint/no-explicit-any
      );
      const logger: Logger = baseLogger.child({ nodeId: 'test-node' });

      // Act
      logger.debug({ field: 'debug' }, 'Debug message');
      logger.info({ field: 'info' }, 'Info message');
      logger.warn({ field: 'warn' }, 'Warn message');
      logger.error({ field: 'error' }, 'Error message');

      // Assert
      expect(logs.length).toBe(4);
      const levels = logs.map((log) => JSON.parse(log).level);
      expect(levels).toContain(20); // debug
      expect(levels).toContain(30); // info
      expect(levels).toContain(40); // warn
      expect(levels).toContain(50); // error
    });
  });

  describe('Wallet Data Sanitization', () => {
    it('should redact privateKey from wallet objects', () => {
      // Arrange
      const wallet = {
        agentId: 'agent-001',
        evmAddress: '0x1234567890123456789012345678901234567890',
        privateKey: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      };

      // Act
      const sanitized = sanitizeWalletForLogs(wallet);

      // Assert
      expect(sanitized.agentId).toBe('agent-001');
      expect(sanitized.evmAddress).toBe('0x1234567890123456789012345678901234567890');
      expect(sanitized.privateKey).toBe('[REDACTED]');
    });

    it('should redact mnemonic from wallet objects', () => {
      // Arrange
      const wallet = {
        agentId: 'agent-001',
        mnemonic:
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      };

      // Act
      const sanitized = sanitizeWalletForLogs(wallet);

      // Assert
      expect(sanitized.agentId).toBe('agent-001');
      expect(sanitized.mnemonic).toBe('[REDACTED]');
    });

    it('should redact seed from wallet objects', () => {
      // Arrange
      const wallet = {
        agentId: 'agent-001',
        seed: Buffer.from('secret-seed'),
      };

      // Act
      const sanitized = sanitizeWalletForLogs(wallet);

      // Assert
      expect(sanitized.agentId).toBe('agent-001');
      expect(sanitized.seed).toBe('[REDACTED]');
    });

    it('should redact encryptionKey from wallet objects', () => {
      // Arrange
      const wallet = {
        agentId: 'agent-001',
        encryptionKey: Buffer.from('encryption-key'),
      };

      // Act
      const sanitized = sanitizeWalletForLogs(wallet);

      // Assert
      expect(sanitized.agentId).toBe('agent-001');
      expect(sanitized.encryptionKey).toBe('[REDACTED]');
    });

    it('should redact secret from wallet objects', () => {
      // Arrange
      const wallet = {
        agentId: 'agent-001',
        secret: 'some-secret-value',
      };

      // Act
      const sanitized = sanitizeWalletForLogs(wallet);

      // Assert
      expect(sanitized.agentId).toBe('agent-001');
      expect(sanitized.secret).toBe('[REDACTED]');
    });

    it('should redact privateKey from nested signer objects', () => {
      // Arrange
      const wallet = {
        agentId: 'agent-001',
        signer: {
          address: '0x1234567890123456789012345678901234567890',
          privateKey: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        },
      };

      // Act
      const sanitized = sanitizeWalletForLogs(wallet);

      // Assert
      expect(sanitized.agentId).toBe('agent-001');
      expect((sanitized.signer as Record<string, unknown>).address).toBe(
        '0x1234567890123456789012345678901234567890'
      );
      expect((sanitized.signer as Record<string, unknown>).privateKey).toBe('[REDACTED]');
    });

    it('should not mutate original wallet object', () => {
      // Arrange
      const wallet = {
        agentId: 'agent-001',
        privateKey: '0xabcdef1234567890',
      };

      const originalPrivateKey = wallet.privateKey;

      // Act
      sanitizeWalletForLogs(wallet);

      // Assert - original wallet should still have privateKey
      expect(wallet.privateKey).toBe(originalPrivateKey);
    });
  });
});
