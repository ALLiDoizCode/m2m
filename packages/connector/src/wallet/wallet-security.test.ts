/**
 * Wallet Security Manager Tests
 * Story 11.9: Security Hardening for Agent Wallets
 */

import {
  WalletSecurityManager,
  SpendingLimits,
  SecurityConfig,
  FraudDetector,
} from './wallet-security';
import pino from 'pino';
import Database from 'better-sqlite3';

describe('WalletSecurityManager', () => {
  let securityManager: WalletSecurityManager;
  let mockFraudDetector: jest.Mocked<FraudDetector>;
  let mockLogger: pino.Logger;
  let mockDb: Database.Database;

  const defaultConfig: SecurityConfig = {
    authentication: {
      method: 'password',
      passwordMinLength: 16,
      totpEnabled: false,
    },
    rateLimits: {
      walletCreation: 100,
      fundingRequests: 50,
    },
    spendingLimits: {
      default: {
        maxTransactionSize: BigInt(1000_000000), // 1000 USDC (6 decimals)
        dailyLimit: BigInt(5000_000000), // 5000 USDC
        monthlyLimit: BigInt(50000_000000), // 50000 USDC
      },
      perAgent: {},
    },
    fraudDetection: {
      rapidFundingThreshold: 5,
      unusualTransactionStdDev: 3,
    },
  };

  beforeEach(() => {
    // Create mock fraud detector
    mockFraudDetector = {
      analyzeTransaction: jest.fn().mockResolvedValue({ detected: false }),
    };

    // Create mock logger (Pino)
    mockLogger = pino({ level: 'silent' }); // Silent mode for tests

    // Create mock database
    mockDb = {
      prepare: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue({ total: 0 }),
      }),
    } as unknown as Database.Database;

    // Initialize security manager
    securityManager = new WalletSecurityManager(
      defaultConfig,
      mockFraudDetector,
      mockLogger,
      mockDb
    );
  });

  describe('sanitizeWalletData', () => {
    it('should remove privateKey from wallet object', () => {
      const wallet = {
        agentId: 'agent-001',
        evmAddress: '0x1234567890123456789012345678901234567890',
        privateKey: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      };

      const sanitized = securityManager.sanitizeWalletData(wallet);

      expect(sanitized.agentId).toBe('agent-001');
      expect(sanitized.evmAddress).toBe('0x1234567890123456789012345678901234567890');
      expect(sanitized.privateKey).toBeUndefined();
    });

    it('should remove mnemonic from wallet object', () => {
      const wallet = {
        agentId: 'agent-001',
        mnemonic:
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      };

      const sanitized = securityManager.sanitizeWalletData(wallet);

      expect(sanitized.agentId).toBe('agent-001');
      expect(sanitized.mnemonic).toBeUndefined();
    });

    it('should remove seed from wallet object', () => {
      const wallet = {
        agentId: 'agent-001',
        seed: Buffer.from('some-secret-seed'),
      };

      const sanitized = securityManager.sanitizeWalletData(wallet);

      expect(sanitized.agentId).toBe('agent-001');
      expect(sanitized.seed).toBeUndefined();
    });

    it('should remove encryptionKey from wallet object', () => {
      const wallet = {
        agentId: 'agent-001',
        encryptionKey: Buffer.from('some-encryption-key'),
      };

      const sanitized = securityManager.sanitizeWalletData(wallet);

      expect(sanitized.agentId).toBe('agent-001');
      expect(sanitized.encryptionKey).toBeUndefined();
    });

    it('should remove secret from wallet object', () => {
      const wallet = {
        agentId: 'agent-001',
        secret: 'some-secret-value',
      };

      const sanitized = securityManager.sanitizeWalletData(wallet);

      expect(sanitized.agentId).toBe('agent-001');
      expect(sanitized.secret).toBeUndefined();
    });

    it('should remove privateKey from nested signer object', () => {
      const wallet = {
        agentId: 'agent-001',
        signer: {
          address: '0x1234567890123456789012345678901234567890',
          privateKey: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        },
      };

      const sanitized = securityManager.sanitizeWalletData(wallet);

      expect(sanitized.agentId).toBe('agent-001');
      expect((sanitized.signer as Record<string, unknown>).address).toBe(
        '0x1234567890123456789012345678901234567890'
      );
      expect((sanitized.signer as Record<string, unknown>).privateKey).toBeUndefined();
    });

    it('should handle null wallet gracefully', () => {
      const sanitized = securityManager.sanitizeWalletData(null);
      expect(sanitized).toBeNull();
    });

    it('should handle undefined wallet gracefully', () => {
      const sanitized = securityManager.sanitizeWalletData(undefined);
      expect(sanitized).toBeUndefined();
    });

    it('should handle non-object wallet gracefully', () => {
      const sanitized = securityManager.sanitizeWalletData('some-string');
      expect(sanitized).toBe('some-string');
    });

    it('should not mutate original wallet object', () => {
      const wallet = {
        agentId: 'agent-001',
        privateKey: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      };

      const originalPrivateKey = wallet.privateKey;
      securityManager.sanitizeWalletData(wallet);

      // Original wallet should still have privateKey
      expect(wallet.privateKey).toBe(originalPrivateKey);
    });
  });

  describe('getSpendingLimits', () => {
    it('should return default spending limits for unknown agent', async () => {
      const limits = await securityManager.getSpendingLimits('agent-unknown');

      expect(limits).toEqual(defaultConfig.spendingLimits.default);
    });

    it('should return custom spending limits for configured agent', async () => {
      const customLimits: SpendingLimits = {
        maxTransactionSize: BigInt(500_000000), // 500 USDC
        dailyLimit: BigInt(2000_000000), // 2000 USDC
        monthlyLimit: BigInt(20000_000000), // 20000 USDC
      };

      const customConfig: SecurityConfig = {
        ...defaultConfig,
        spendingLimits: {
          default: defaultConfig.spendingLimits.default,
          perAgent: {
            'agent-vip': customLimits,
          },
        },
      };

      const customSecurityManager = new WalletSecurityManager(
        customConfig,
        mockFraudDetector,
        mockLogger,
        mockDb
      );

      const limits = await customSecurityManager.getSpendingLimits('agent-vip');
      expect(limits).toEqual(customLimits);
    });
  });

  describe('getDailySpending', () => {
    it('should return 0 when no database configured', async () => {
      const noDatabaseSecurityManager = new WalletSecurityManager(
        defaultConfig,
        mockFraudDetector,
        mockLogger
        // No database provided
      );

      const dailySpending = await noDatabaseSecurityManager.getDailySpending('agent-001', 'USDC');
      expect(dailySpending).toBe(0n);
    });

    it('should query database for daily spending', async () => {
      const mockGet = jest.fn().mockReturnValue({ total: 1000_000000 }); // 1000 USDC
      (mockDb.prepare as jest.Mock).mockReturnValue({ get: mockGet });

      const dailySpending = await securityManager.getDailySpending('agent-001', 'USDC');

      expect(dailySpending).toBe(BigInt(1000_000000));
      expect(mockDb.prepare).toHaveBeenCalled();
      expect(mockGet).toHaveBeenCalledWith('agent-001', expect.any(Number), 'USDC');
    });

    it('should return 0 on database query error', async () => {
      (mockDb.prepare as jest.Mock).mockImplementation(() => {
        throw new Error('Database error');
      });

      const dailySpending = await securityManager.getDailySpending('agent-001', 'USDC');
      expect(dailySpending).toBe(0n);
    });
  });

  describe('getMonthlySpending', () => {
    it('should return 0 when no database configured', async () => {
      const noDatabaseSecurityManager = new WalletSecurityManager(
        defaultConfig,
        mockFraudDetector,
        mockLogger
        // No database provided
      );

      const monthlySpending = await noDatabaseSecurityManager.getMonthlySpending(
        'agent-001',
        'USDC'
      );
      expect(monthlySpending).toBe(0n);
    });

    it('should query database for monthly spending', async () => {
      const mockGet = jest.fn().mockReturnValue({ total: 10000_000000 }); // 10000 USDC
      (mockDb.prepare as jest.Mock).mockReturnValue({ get: mockGet });

      const monthlySpending = await securityManager.getMonthlySpending('agent-001', 'USDC');

      expect(monthlySpending).toBe(BigInt(10000_000000));
      expect(mockDb.prepare).toHaveBeenCalled();
      expect(mockGet).toHaveBeenCalledWith('agent-001', expect.any(Number), 'USDC');
    });

    it('should return 0 on database query error', async () => {
      (mockDb.prepare as jest.Mock).mockImplementation(() => {
        throw new Error('Database error');
      });

      const monthlySpending = await securityManager.getMonthlySpending('agent-001', 'USDC');
      expect(monthlySpending).toBe(0n);
    });
  });

  describe('validateTransaction', () => {
    it('should return true for valid transaction within all limits', async () => {
      const valid = await securityManager.validateTransaction(
        'agent-001',
        BigInt(100_000000),
        'USDC'
      ); // 100 USDC

      expect(valid).toBe(true);
      expect(mockFraudDetector.analyzeTransaction).toHaveBeenCalledWith({
        agentId: 'agent-001',
        amount: BigInt(100_000000),
        token: 'USDC',
        timestamp: expect.any(Number),
      });
    });

    it('should return false for transaction exceeding max transaction size', async () => {
      const valid = await securityManager.validateTransaction(
        'agent-001',
        BigInt(2000_000000),
        'USDC'
      ); // 2000 USDC (exceeds 1000 limit)

      expect(valid).toBe(false);
    });

    it('should return false for transaction exceeding daily limit', async () => {
      // Mock daily spending at 4900 USDC
      const mockGet = jest.fn().mockReturnValue({ total: 4900_000000 });
      (mockDb.prepare as jest.Mock).mockReturnValue({ get: mockGet });

      // Attempt transaction for 200 USDC (total 5100, exceeds 5000 limit)
      const valid = await securityManager.validateTransaction(
        'agent-001',
        BigInt(200_000000),
        'USDC'
      );

      expect(valid).toBe(false);
    });

    it('should return false for transaction exceeding monthly limit', async () => {
      // Mock monthly spending at 49800 USDC
      const mockGet = jest.fn().mockReturnValue({ total: 49800_000000 });
      (mockDb.prepare as jest.Mock).mockReturnValue({ get: mockGet });

      // Attempt transaction for 300 USDC (total 50100, exceeds 50000 limit)
      const valid = await securityManager.validateTransaction(
        'agent-001',
        BigInt(300_000000),
        'USDC'
      );

      expect(valid).toBe(false);
    });

    it('should return false when fraud detected', async () => {
      mockFraudDetector.analyzeTransaction.mockResolvedValue({
        detected: true,
        reason: 'Suspicious transaction pattern',
        score: 85,
      });

      const valid = await securityManager.validateTransaction(
        'agent-001',
        BigInt(100_000000),
        'USDC'
      );

      expect(valid).toBe(false);
      expect(mockFraudDetector.analyzeTransaction).toHaveBeenCalled();
    });

    it('should return false on validation error', async () => {
      mockFraudDetector.analyzeTransaction.mockRejectedValue(new Error('Fraud detector error'));

      const valid = await securityManager.validateTransaction(
        'agent-001',
        BigInt(100_000000),
        'USDC'
      );

      expect(valid).toBe(false); // Fail closed on error
    });

    it('should call fraud detector with correct parameters', async () => {
      const timestamp = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(timestamp);

      await securityManager.validateTransaction('agent-001', BigInt(100_000000), 'USDC');

      expect(mockFraudDetector.analyzeTransaction).toHaveBeenCalledWith({
        agentId: 'agent-001',
        amount: BigInt(100_000000),
        token: 'USDC',
        timestamp,
      });
    });
  });
});
