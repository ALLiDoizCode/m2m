/**
 * Account Manager Credit Limit Enforcement Tests
 *
 * Unit tests for credit limit validation functionality in AccountManager.
 * Tests credit limit hierarchy, ceiling application, and violation detection.
 *
 * @packageDocumentation
 */

import { AccountManager, AccountManagerConfig } from './account-manager';
import { ILedgerClient } from './ledger-client';
import { CreditLimitConfig } from '../config/types';
import pino from 'pino';
import { InMemoryLedgerClient } from './in-memory-ledger-client';
import { AccountLedgerCodes } from './types';

describe('AccountManager Credit Limit Enforcement', () => {
  let accountManager: AccountManager;
  let mockLedgerClient: jest.Mocked<ILedgerClient>;
  let mockLogger: pino.Logger;

  beforeEach(() => {
    // Create mock ILedgerClient
    mockLedgerClient = {
      initialize: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      createAccountsBatch: jest.fn().mockResolvedValue(undefined),
      createTransfersBatch: jest.fn().mockResolvedValue(undefined),
      getAccountBalance: jest.fn(),
      getAccountsBatch: jest.fn().mockResolvedValue(new Map()),
    } as jest.Mocked<ILedgerClient>;

    // Create mock logger
    mockLogger = pino({ level: 'silent' });

    // Clear all mocks
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('No Credit Limit Configured (Unlimited)', () => {
    it('should return null when no credit limit configured (unlimited)', async () => {
      // Arrange: AccountManager with no creditLimitConfig
      const config: AccountManagerConfig = {
        nodeId: 'test-node',
      };
      accountManager = new AccountManager(config, mockLedgerClient, mockLogger);

      // Mock getAccountsBatch to return balance
      mockLedgerClient.getAccountsBatch.mockResolvedValue(
        new Map([
          [123n, { debits: 500n, credits: 0n, balance: 500n }],
          [456n, { debits: 0n, credits: 300n, balance: 300n }],
        ])
      );

      // Act: Check credit limit with large amount
      const violation = await accountManager.checkCreditLimit('peer-a', 'M2M', 1000000n);

      // Assert: No violation (unlimited)
      expect(violation).toBeNull();
    });
  });

  describe('Credit Limit Below Threshold', () => {
    it('should return null when balance + amount is below credit limit', async () => {
      // Arrange: Current balance = 500n, limit = 1000n, amount = 300n → total 800n < 1000n
      const creditLimits: CreditLimitConfig = {
        defaultLimit: 1000n,
      };
      const config: AccountManagerConfig = {
        nodeId: 'test-node',
        creditLimits,
      };
      accountManager = new AccountManager(config, mockLedgerClient, mockLogger);

      // Mock getAccountsBatch to return current balance
      mockLedgerClient.getAccountsBatch.mockResolvedValue(
        new Map([
          [expect.any(BigInt), { debits: 500n, credits: 0n, balance: 500n }], // debitBalance
          [expect.any(BigInt), { debits: 0n, credits: 200n, balance: 200n }], // creditBalance
        ])
      );

      // Act: Check credit limit
      const violation = await accountManager.checkCreditLimit('peer-a', 'M2M', 300n);

      // Assert: No violation (800n < 1000n)
      expect(violation).toBeNull();
    });
  });

  describe('Credit Limit At Threshold', () => {
    it('should return null when balance + amount equals credit limit (at limit)', async () => {
      // Arrange: Current balance = 700n, limit = 1000n, amount = 300n → total 1000n = 1000n
      const creditLimits: CreditLimitConfig = {
        defaultLimit: 1000n,
      };
      const config: AccountManagerConfig = {
        nodeId: 'test-node',
        creditLimits,
      };
      accountManager = new AccountManager(config, mockLedgerClient, mockLogger);

      // Mock getAccountsBatch to return current balance
      mockLedgerClient.getAccountsBatch.mockResolvedValue(
        new Map([
          [expect.any(BigInt), { debits: 700n, credits: 0n, balance: 700n }], // debitBalance
          [expect.any(BigInt), { debits: 0n, credits: 0n, balance: 0n }], // creditBalance
        ])
      );

      // Act: Check credit limit
      const violation = await accountManager.checkCreditLimit('peer-a', 'M2M', 300n);

      // Assert: No violation (1000n = 1000n, allowed)
      expect(violation).toBeNull();
    });
  });

  describe('Credit Limit Exceeded', () => {
    it('should return violation when balance + amount exceeds credit limit', async () => {
      // Arrange: Current balance = 800n, limit = 1000n, amount = 300n → total 1100n > 1000n
      const creditLimits: CreditLimitConfig = {
        defaultLimit: 1000n,
      };
      const config: AccountManagerConfig = {
        nodeId: 'test-node',
        creditLimits,
      };
      accountManager = new AccountManager(config, mockLedgerClient, mockLogger);

      // Mock createAccountsBatch to succeed (accounts may need to be created)
      mockLedgerClient.createAccountsBatch.mockResolvedValue(undefined);

      // Mock getAccountsBatch to return current balance. Under the MVP
      // self-balancing transfer scheme, inbound volume shows up as
      // `credits_posted` on the CREDIT account (ids[1]), not the debit
      // account. Mirroring the real ledger's behaviour here so this test
      // catches regressions in checkCreditLimit (post-37.5 fix reads
      // creditBalance, not debitBalance).
      mockLedgerClient.getAccountsBatch.mockImplementation(async (ids: bigint[]) => {
        const resultMap = new Map();
        // Debit account: always ≤ 0 under current scheme (-800 here)
        resultMap.set(ids[0], { debits: 800n, credits: 0n, balance: -800n });
        // Credit account: carries the cumulative volume signal (+800)
        resultMap.set(ids[1], { debits: 0n, credits: 800n, balance: 800n });
        return resultMap;
      });

      // Act: Check credit limit
      const violation = await accountManager.checkCreditLimit('peer-a', 'M2M', 300n);

      // Assert: Violation returned
      expect(violation).not.toBeNull();
      expect(violation!.peerId).toBe('peer-a');
      expect(violation!.tokenId).toBe('M2M');
      expect(violation!.currentBalance).toBe(800n);
      expect(violation!.requestedAmount).toBe(300n);
      expect(violation!.creditLimit).toBe(1000n);
      expect(violation!.wouldExceedBy).toBe(100n); // (800 + 300) - 1000 = 100
    });
  });

  describe('Per-Peer Limit Override', () => {
    it('should use per-peer limit override instead of default limit', async () => {
      // Arrange: Default limit = 1000n, per-peer limit for 'peer-a' = 2000n
      const creditLimits: CreditLimitConfig = {
        defaultLimit: 1000n,
        perPeerLimits: new Map([['peer-a', 2000n]]),
      };
      const config: AccountManagerConfig = {
        nodeId: 'test-node',
        creditLimits,
      };
      accountManager = new AccountManager(config, mockLedgerClient, mockLogger);

      // Mock getAccountsBatch to return current balance
      mockLedgerClient.getAccountsBatch.mockResolvedValue(
        new Map([
          [expect.any(BigInt), { debits: 0n, credits: 0n, balance: 0n }], // debitBalance
          [expect.any(BigInt), { debits: 0n, credits: 0n, balance: 0n }], // creditBalance
        ])
      );

      // Act: Check credit limit with amount that would exceed default but not per-peer limit
      const violation = await accountManager.checkCreditLimit('peer-a', 'M2M', 1500n);

      // Assert: No violation (uses 2000n limit, not 1000n default)
      expect(violation).toBeNull();
    });

    it('should use default limit for peer without per-peer override', async () => {
      // Arrange: Default limit = 1000n, per-peer limit for 'peer-a' = 2000n
      const creditLimits: CreditLimitConfig = {
        defaultLimit: 1000n,
        perPeerLimits: new Map([['peer-a', 2000n]]),
      };
      const config: AccountManagerConfig = {
        nodeId: 'test-node',
        creditLimits,
      };
      accountManager = new AccountManager(config, mockLedgerClient, mockLogger);

      // Mock getAccountsBatch to return current balance
      mockLedgerClient.getAccountsBatch.mockResolvedValue(
        new Map([
          [expect.any(BigInt), { debits: 0n, credits: 0n, balance: 0n }], // debitBalance
          [expect.any(BigInt), { debits: 0n, credits: 0n, balance: 0n }], // creditBalance
        ])
      );

      // Act: Check credit limit for peer-b (no override) with amount exceeding default
      const violation = await accountManager.checkCreditLimit('peer-b', 'M2M', 1500n);

      // Assert: Violation (uses 1000n default limit)
      expect(violation).not.toBeNull();
      expect(violation!.creditLimit).toBe(1000n);
      expect(violation!.wouldExceedBy).toBe(500n);
    });
  });

  describe('Token-Specific Limit Override', () => {
    it('should use token-specific limit instead of per-peer limit', async () => {
      // Arrange: Per-peer limit = 1000n, token-specific limit for 'peer-a' + 'USDC' = 500n
      const creditLimits: CreditLimitConfig = {
        perPeerLimits: new Map([['peer-a', 1000n]]),
        perTokenLimits: new Map([['peer-a', new Map([['USDC', 500n]])]]),
      };
      const config: AccountManagerConfig = {
        nodeId: 'test-node',
        creditLimits,
      };
      accountManager = new AccountManager(config, mockLedgerClient, mockLogger);

      // Mock getAccountsBatch to return current balance
      mockLedgerClient.getAccountsBatch.mockResolvedValue(
        new Map([
          [expect.any(BigInt), { debits: 0n, credits: 0n, balance: 0n }], // debitBalance
          [expect.any(BigInt), { debits: 0n, credits: 0n, balance: 0n }], // creditBalance
        ])
      );

      // Act: Check credit limit with amount exceeding token-specific limit
      const violation = await accountManager.checkCreditLimit('peer-a', 'USDC', 600n);

      // Assert: Violation (uses 500n token-specific limit, not 1000n per-peer)
      expect(violation).not.toBeNull();
      expect(violation!.creditLimit).toBe(500n);
      expect(violation!.wouldExceedBy).toBe(100n);
    });

    it('should use per-peer limit for token without token-specific override', async () => {
      // Arrange: Per-peer limit = 1000n, token-specific limit for 'peer-a' + 'USDC' = 500n
      const creditLimits: CreditLimitConfig = {
        perPeerLimits: new Map([['peer-a', 1000n]]),
        perTokenLimits: new Map([['peer-a', new Map([['USDC', 500n]])]]),
      };
      const config: AccountManagerConfig = {
        nodeId: 'test-node',
        creditLimits,
      };
      accountManager = new AccountManager(config, mockLedgerClient, mockLogger);

      // Mock getAccountsBatch to return current balance
      mockLedgerClient.getAccountsBatch.mockResolvedValue(
        new Map([
          [expect.any(BigInt), { debits: 0n, credits: 0n, balance: 0n }], // debitBalance
          [expect.any(BigInt), { debits: 0n, credits: 0n, balance: 0n }], // creditBalance
        ])
      );

      // Act: Check credit limit for 'M2M' token (no token-specific override)
      const violation = await accountManager.checkCreditLimit('peer-a', 'M2M', 800n);

      // Assert: No violation (uses 1000n per-peer limit)
      expect(violation).toBeNull();
    });
  });

  describe('Global Ceiling Application', () => {
    it('should apply global ceiling to reduce configured limit', async () => {
      // Arrange: Per-peer limit = 10000n, global ceiling = 5000n → effective = 5000n
      const creditLimits: CreditLimitConfig = {
        perPeerLimits: new Map([['peer-a', 10000n]]),
        globalCeiling: 5000n,
      };
      const config: AccountManagerConfig = {
        nodeId: 'test-node',
        creditLimits,
      };
      accountManager = new AccountManager(config, mockLedgerClient, mockLogger);

      // Mock getAccountsBatch to return current balance
      mockLedgerClient.getAccountsBatch.mockResolvedValue(
        new Map([
          [expect.any(BigInt), { debits: 0n, credits: 0n, balance: 0n }], // debitBalance
          [expect.any(BigInt), { debits: 0n, credits: 0n, balance: 0n }], // creditBalance
        ])
      );

      // Act: Check credit limit with amount exceeding ceiling
      const violation = await accountManager.checkCreditLimit('peer-a', 'M2M', 6000n);

      // Assert: Violation (effective limit = 5000n due to ceiling)
      expect(violation).not.toBeNull();
      expect(violation!.creditLimit).toBe(5000n);
      expect(violation!.wouldExceedBy).toBe(1000n);
    });

    it('should not reduce limit when ceiling is higher than configured limit', async () => {
      // Arrange: Per-peer limit = 2000n, global ceiling = 5000n → effective = 2000n
      const creditLimits: CreditLimitConfig = {
        perPeerLimits: new Map([['peer-a', 2000n]]),
        globalCeiling: 5000n,
      };
      const config: AccountManagerConfig = {
        nodeId: 'test-node',
        creditLimits,
      };
      accountManager = new AccountManager(config, mockLedgerClient, mockLogger);

      // Mock getAccountsBatch to return current balance
      mockLedgerClient.getAccountsBatch.mockResolvedValue(
        new Map([
          [expect.any(BigInt), { debits: 0n, credits: 0n, balance: 0n }], // debitBalance
          [expect.any(BigInt), { debits: 0n, credits: 0n, balance: 0n }], // creditBalance
        ])
      );

      // Act: Check credit limit with amount exceeding configured limit
      const violation = await accountManager.checkCreditLimit('peer-a', 'M2M', 3000n);

      // Assert: Violation (effective limit = 2000n, ceiling doesn't reduce)
      expect(violation).not.toBeNull();
      expect(violation!.creditLimit).toBe(2000n);
      expect(violation!.wouldExceedBy).toBe(1000n);
    });
  });

  describe('Account Creation During Limit Check', () => {
    it('should create peer accounts if not found before checking limit', async () => {
      // Arrange: AccountManager with no cached accounts
      const creditLimits: CreditLimitConfig = {
        defaultLimit: 1000n,
      };
      const config: AccountManagerConfig = {
        nodeId: 'test-node',
        creditLimits,
      };
      accountManager = new AccountManager(config, mockLedgerClient, mockLogger);

      // Mock createAccountsBatch to succeed
      mockLedgerClient.createAccountsBatch.mockResolvedValue(undefined);

      // Mock getAccountsBatch to return balance
      mockLedgerClient.getAccountsBatch.mockResolvedValue(
        new Map([
          [expect.any(BigInt), { debits: 0n, credits: 0n, balance: 0n }], // debitBalance
          [expect.any(BigInt), { debits: 0n, credits: 0n, balance: 0n }], // creditBalance
        ])
      );

      // Act: Check credit limit for new peer
      const violation = await accountManager.checkCreditLimit('new-peer', 'M2M', 100n);

      // Assert: createAccountsBatch called, then balance queried
      expect(mockLedgerClient.createAccountsBatch).toHaveBeenCalled();
      expect(mockLedgerClient.getAccountsBatch).toHaveBeenCalled();
      expect(violation).toBeNull();
    });
  });

  describe('Logging', () => {
    it('should log warning when credit limit violated', async () => {
      // Arrange: Spy on logger.warn
      const logSpy = jest.spyOn(mockLogger, 'warn');
      const creditLimits: CreditLimitConfig = {
        defaultLimit: 1000n,
      };
      const config: AccountManagerConfig = {
        nodeId: 'test-node',
        creditLimits,
      };
      accountManager = new AccountManager(config, mockLedgerClient, mockLogger);

      // Mock createAccountsBatch to succeed
      mockLedgerClient.createAccountsBatch.mockResolvedValue(undefined);

      // Mock getAccountsBatch to return balance exceeding limit (volume
      // carried on credit account per actual ledger semantics; see 37.5).
      mockLedgerClient.getAccountsBatch.mockImplementation(async (ids: bigint[]) => {
        const resultMap = new Map();
        resultMap.set(ids[0], { debits: 900n, credits: 0n, balance: -900n });
        resultMap.set(ids[1], { debits: 0n, credits: 900n, balance: 900n });
        return resultMap;
      });

      // Act: Check credit limit
      await accountManager.checkCreditLimit('peer-a', 'M2M', 200n);

      // Assert: logger.warn called with violation details
      expect(logSpy).toHaveBeenCalled();
    });
  });

  describe('Convenience Method: wouldExceedCreditLimit', () => {
    it('should return true when limit would be exceeded', async () => {
      // Arrange: Balance would exceed limit
      const creditLimits: CreditLimitConfig = {
        defaultLimit: 1000n,
      };
      const config: AccountManagerConfig = {
        nodeId: 'test-node',
        creditLimits,
      };
      accountManager = new AccountManager(config, mockLedgerClient, mockLogger);

      // Mock createAccountsBatch to succeed
      mockLedgerClient.createAccountsBatch.mockResolvedValue(undefined);

      // Mock getAccountsBatch to return balance exceeding limit (volume
      // carried on credit account per actual ledger semantics; see 37.5).
      mockLedgerClient.getAccountsBatch.mockImplementation(async (ids: bigint[]) => {
        const resultMap = new Map();
        resultMap.set(ids[0], { debits: 900n, credits: 0n, balance: -900n });
        resultMap.set(ids[1], { debits: 0n, credits: 900n, balance: 900n });
        return resultMap;
      });

      // Act: Check if limit would be exceeded
      const wouldExceed = await accountManager.wouldExceedCreditLimit('peer-a', 'M2M', 200n);

      // Assert: Returns true
      expect(wouldExceed).toBe(true);
    });

    it('should return false when limit would not be exceeded', async () => {
      // Arrange: Balance below limit
      const creditLimits: CreditLimitConfig = {
        defaultLimit: 1000n,
      };
      const config: AccountManagerConfig = {
        nodeId: 'test-node',
        creditLimits,
      };
      accountManager = new AccountManager(config, mockLedgerClient, mockLogger);

      // Mock getAccountsBatch to return balance below limit
      mockLedgerClient.getAccountsBatch.mockResolvedValue(
        new Map([
          [expect.any(BigInt), { debits: 500n, credits: 0n, balance: 500n }], // debitBalance
          [expect.any(BigInt), { debits: 0n, credits: 0n, balance: 0n }], // creditBalance
        ])
      );

      // Act: Check if limit would be exceeded
      const wouldExceed = await accountManager.wouldExceedCreditLimit('peer-a', 'M2M', 300n);

      // Assert: Returns false
      expect(wouldExceed).toBe(false);
    });
  });
});

/**
 * Story 37.5 — Real-ledger regression suite.
 *
 * These tests do NOT mock `getAccountsBatch`; they seed volume via a real
 * `InMemoryLedgerClient` + `recordPacketTransfers()` and verify `checkCreditLimit`
 * trips against the actual ledger arithmetic. Prior to 37.5 the credit-limit
 * guard was silently disabled under the real ledger's `balance = credits - debits`
 * formula because `checkCreditLimit` read `debitBalance` (always ≤ 0 under the
 * MVP self-balancing scheme) and compared it to a positive limit.
 */
describe('AccountManager Credit Limits — Real Ledger (Story 37.5 regression)', () => {
  let realLedger: import('./in-memory-ledger-client').InMemoryLedgerClient;
  let realAccountManager: AccountManager;
  let silentLogger: pino.Logger;

  beforeEach(async () => {
    silentLogger = pino({ level: 'silent' });
    realLedger = new InMemoryLedgerClient(
      { snapshotPath: `/tmp/credit-limit-37-5-${Date.now()}-${Math.random()}.json` },
      silentLogger
    );
    await realLedger.initialize();

    realAccountManager = new AccountManager(
      {
        nodeId: 'test-connector',
        defaultLedger: AccountLedgerCodes.DEFAULT_LEDGER,
        creditLimits: { defaultLimit: 1000n },
      },
      realLedger,
      silentLogger
    );
  });

  afterEach(async () => {
    await realLedger.close();
  });

  it('[AC 1] trips the limit after real inbound packet volume seeded via recordPacketTransfers', async () => {
    // Arrange: peer-a has sent us 800n inbound volume via a real packet-forward.
    await realAccountManager.recordPacketTransfers(
      'peer-a', // fromPeer
      'peer-downstream', // toPeer (unused for this assertion but required)
      'M2M',
      800n,
      800n,
      1n,
      2n,
      AccountLedgerCodes.DEFAULT_LEDGER,
      1
    );

    // Act: propose a packet that would bring the total to 1100 (over the 1000 limit).
    const violation = await realAccountManager.checkCreditLimit('peer-a', 'M2M', 300n);

    // Assert: the limit trips.
    expect(violation).not.toBeNull();
    expect(violation!.peerId).toBe('peer-a');
    expect(violation!.currentBalance).toBe(800n);
    expect(violation!.requestedAmount).toBe(300n);
    expect(violation!.creditLimit).toBe(1000n);
    expect(violation!.wouldExceedBy).toBe(100n);
  });

  it('[AC 1] allows a packet that keeps the peer below the limit', async () => {
    await realAccountManager.recordPacketTransfers(
      'peer-b',
      'peer-downstream',
      'M2M',
      500n,
      500n,
      3n,
      4n,
      AccountLedgerCodes.DEFAULT_LEDGER,
      1
    );

    const violation = await realAccountManager.checkCreditLimit('peer-b', 'M2M', 300n);
    expect(violation).toBeNull();
  });

  it('[AC 2] settlement drain reduces the limit-applicable balance', async () => {
    // Seed 800n of inbound volume.
    await realAccountManager.recordPacketTransfers(
      'peer-c',
      'peer-downstream',
      'M2M',
      800n,
      800n,
      5n,
      6n,
      AccountLedgerCodes.DEFAULT_LEDGER,
      1
    );

    // Drain 400n via a recorded settlement. The symmetric reverse-transfer
    // should reduce credit-account balance from 800 → 400.
    await realAccountManager.recordSettlement('peer-c', 'M2M', 400n);

    // 400 + 400 = 800 ≤ 1000 → no violation.
    const below = await realAccountManager.checkCreditLimit('peer-c', 'M2M', 400n);
    expect(below).toBeNull();

    // 400 + 700 = 1100 > 1000 → violation.
    const above = await realAccountManager.checkCreditLimit('peer-c', 'M2M', 700n);
    expect(above).not.toBeNull();
    expect(above!.currentBalance).toBe(400n);
    expect(above!.wouldExceedBy).toBe(100n);
  });

  it('[AC 1] zero-activity peer below limit for any amount ≤ limit', async () => {
    // New peer, no packets yet.
    const violation = await realAccountManager.checkCreditLimit('fresh-peer', 'M2M', 1000n);
    expect(violation).toBeNull();

    const over = await realAccountManager.checkCreditLimit('fresh-peer', 'M2M', 1001n);
    expect(over).not.toBeNull();
  });
});
