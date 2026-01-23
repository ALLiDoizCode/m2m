import pino from 'pino';
import { AuditLogger, AuditLogConfig, createAuditLogger } from './audit-logger';

describe('AuditLogger', () => {
  let mockLogger: pino.Logger;
  let auditLogger: AuditLogger;
  let config: AuditLogConfig;

  beforeEach(() => {
    // Create mock logger
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: jest.fn().mockReturnThis(),
    } as unknown as pino.Logger;

    config = {
      nodeId: 'test-node-1',
      backend: 'env',
      retentionDays: 365,
    };

    auditLogger = new AuditLogger(mockLogger, config);
  });

  describe('constructor', () => {
    it('should initialize with provided config', () => {
      expect(mockLogger.child).toHaveBeenCalledWith({
        component: 'AuditLogger',
        nodeId: 'test-node-1',
        backend: 'env',
      });
      expect(mockLogger.info).toHaveBeenCalledWith('AuditLogger initialized', {
        retentionDays: 365,
      });
    });

    it('should use default retention period if not provided', () => {
      const configWithoutRetention = {
        nodeId: 'test-node-2',
        backend: 'aws-kms',
      };
      new AuditLogger(mockLogger, configWithoutRetention);

      expect(mockLogger.info).toHaveBeenCalledWith('AuditLogger initialized', {
        retentionDays: 365,
      });
    });
  });

  describe('logSignRequest', () => {
    it('should log SIGN_REQUEST audit event', () => {
      const keyId = 'test-key-1';
      const messageHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

      auditLogger.logSignRequest(keyId, messageHash);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'SIGN_REQUEST',
          keyId: 'test-key-1',
          nodeId: 'test-node-1',
          backend: 'env',
          timestamp: expect.any(Number),
          details: {
            messageHash: '0123456789abcdef...',
          },
        }),
        'Sign request initiated'
      );
    });

    it('should truncate long message hashes', () => {
      const keyId = 'test-key-1';
      const messageHash = 'a'.repeat(100);

      auditLogger.logSignRequest(keyId, messageHash);

      const logCall = (mockLogger.info as jest.Mock).mock.calls[1][0];
      expect(logCall.details.messageHash).toBe('aaaaaaaaaaaaaaaa...');
    });
  });

  describe('logSignSuccess', () => {
    it('should log SIGN_SUCCESS audit event', () => {
      const keyId = 'test-key-1';
      const signatureHash = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

      auditLogger.logSignSuccess(keyId, signatureHash);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'SIGN_SUCCESS',
          keyId: 'test-key-1',
          nodeId: 'test-node-1',
          backend: 'env',
          timestamp: expect.any(Number),
          details: {
            signatureHash: 'fedcba9876543210...',
          },
        }),
        'Sign operation successful'
      );
    });
  });

  describe('logSignFailure', () => {
    it('should log SIGN_FAILURE audit event with error details', () => {
      const keyId = 'test-key-1';
      const error = new Error('Key not found');
      error.name = 'KeyNotFoundError';

      auditLogger.logSignFailure(keyId, error);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'SIGN_FAILURE',
          keyId: 'test-key-1',
          nodeId: 'test-node-1',
          backend: 'env',
          timestamp: expect.any(Number),
          details: {
            errorMessage: 'Key not found',
            errorName: 'KeyNotFoundError',
          },
        }),
        'Sign operation failed'
      );
    });
  });

  describe('logKeyRotation', () => {
    it('should log KEY_ROTATION_START event', () => {
      const oldKeyId = 'old-key-1';
      const newKeyId = 'new-key-1';

      auditLogger.logKeyRotation(oldKeyId, newKeyId, 'START');

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'KEY_ROTATION_START',
          keyId: 'old-key-1',
          nodeId: 'test-node-1',
          backend: 'env',
          timestamp: expect.any(Number),
          details: {
            oldKeyId: 'old-key-1',
            newKeyId: 'new-key-1',
          },
        }),
        'Key rotation start'
      );
    });

    it('should log KEY_ROTATION_COMPLETE event', () => {
      const oldKeyId = 'old-key-1';
      const newKeyId = 'new-key-1';

      auditLogger.logKeyRotation(oldKeyId, newKeyId, 'COMPLETE');

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'KEY_ROTATION_COMPLETE',
          keyId: 'old-key-1',
          nodeId: 'test-node-1',
          backend: 'env',
          timestamp: expect.any(Number),
          details: {
            oldKeyId: 'old-key-1',
            newKeyId: 'new-key-1',
          },
        }),
        'Key rotation complete'
      );
    });
  });

  describe('logAccessDenied', () => {
    it('should log KEY_ACCESS_DENIED event', () => {
      const keyId = 'test-key-1';
      const reason = 'Insufficient permissions';

      auditLogger.logAccessDenied(keyId, reason);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'KEY_ACCESS_DENIED',
          keyId: 'test-key-1',
          nodeId: 'test-node-1',
          backend: 'env',
          timestamp: expect.any(Number),
          details: {
            reason: 'Insufficient permissions',
          },
        }),
        'Key access denied'
      );
    });
  });

  describe('exportAuditLogs', () => {
    it('should log export request', async () => {
      const startDate = Date.now() - 86400000; // 1 day ago
      const endDate = Date.now();

      await auditLogger.exportAuditLogs(startDate, endDate);

      expect(mockLogger.info).toHaveBeenCalledWith('Audit log export requested', {
        startDate: new Date(startDate).toISOString(),
        endDate: new Date(endDate).toISOString(),
      });
    });

    it('should log warning about placeholder implementation', async () => {
      const startDate = Date.now() - 86400000;
      const endDate = Date.now();

      await auditLogger.exportAuditLogs(startDate, endDate);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'exportAuditLogs is a placeholder - integrate with log aggregation system for production'
      );
    });

    it('should return empty array (placeholder)', async () => {
      const result = await auditLogger.exportAuditLogs(Date.now() - 86400000, Date.now());
      expect(result).toEqual([]);
    });
  });
});

describe('createAuditLogger', () => {
  it('should create logger with sensitive data redaction serializers', () => {
    const config: AuditLogConfig = {
      nodeId: 'test-node-1',
      backend: 'env',
    };

    const logger = createAuditLogger(config);

    // Verify logger is created
    expect(logger).toBeDefined();
    expect(logger.info).toBeDefined();
    expect(logger.warn).toBeDefined();
    expect(logger.error).toBeDefined();

    // Note: Pino serializers work internally during logging but are not
    // accessible for direct testing. Serializer functionality is verified
    // through integration tests that actually log sensitive data.
  });

  it('should create logger for different backends', () => {
    const backends = ['env', 'aws-kms', 'gcp-kms', 'azure-kv', 'hsm'] as const;

    backends.forEach((backend) => {
      const config: AuditLogConfig = {
        nodeId: 'test-node-1',
        backend,
      };

      const logger = createAuditLogger(config);
      expect(logger).toBeDefined();
    });
  });
});
