/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */

/**
 * Branch coverage tests for AccountManager
 *
 * Targets the gaps left by account-manager.test.ts and
 * account-manager-credit-limits.test.ts, specifically:
 *   - Constructor optional dependencies (batch writer, credit-limits + batching)
 *   - createPeerAccounts edge-case error messages
 *   - ensurePeerAccounts cache-vs-confirmed branches
 *   - getPeerVolumeTotals (entire method was uncovered)
 *   - recordSettlement with/without batch writer and error paths
 *   - shutdown / getBatchWriterStats branches
 *   - _createTransferFn success / error branches
 *   - _applyCeiling edge cases
 *   - checkCreditLimit cache-hit branch
 *
 * @module settlement/account-manager.coverage.test
 */

import { AccountManager, AccountManagerConfig } from './account-manager';
import { ILedgerClient } from './ledger-client';
import { TigerBeetleAccountError } from './tigerbeetle-errors';
import { AccountLedgerCodes } from './types';
import { Logger } from 'pino';

describe('AccountManager Branch Coverage', () => {
  let accountManager: AccountManager;
  let mockLedgerClient: jest.Mocked<ILedgerClient>;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
      fatal: jest.fn(),
      child: jest.fn().mockReturnThis(),
      level: 'silent',
      silent: jest.fn(),
    } as unknown as jest.Mocked<Logger>;

    mockLedgerClient = {
      initialize: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      createAccountsBatch: jest.fn().mockResolvedValue(undefined),
      createTransfersBatch: jest.fn().mockResolvedValue(undefined),
      getAccountBalance: jest.fn(),
      getAccountsBatch: jest.fn().mockResolvedValue(new Map()),
    } as jest.Mocked<ILedgerClient>;

    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 1. Constructor branches
  // ---------------------------------------------------------------------------
  describe('Constructor', () => {
    it('should initialize with batch writer config', () => {
      const config: AccountManagerConfig = {
        nodeId: 'bw-node',
        batchWriterConfig: { batchSize: 10, flushIntervalMs: 5 },
      };
      const am = new AccountManager(config, mockLedgerClient, mockLogger);

      expect(am).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: 'bw-node',
          batchingEnabled: true,
          creditLimitsEnabled: false,
        }),
        'AccountManager initialized (credit limits disabled - unlimited exposure)'
      );
    });

    it('should initialize with credit limits and batch writer together', () => {
      const config: AccountManagerConfig = {
        nodeId: 'cl-bw-node',
        creditLimits: { defaultLimit: 5000n },
        batchWriterConfig: { batchSize: 20, flushIntervalMs: 10 },
      };
      const am = new AccountManager(config, mockLedgerClient, mockLogger);

      expect(am).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: 'cl-bw-node',
          creditLimitsEnabled: true,
          batchingEnabled: true,
        }),
        'AccountManager initialized with credit limits enabled'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 2. createPeerAccounts error branches
  // ---------------------------------------------------------------------------
  describe('createPeerAccounts error handling', () => {
    beforeEach(() => {
      accountManager = new AccountManager({ nodeId: 'test-node' }, mockLedgerClient, mockLogger);
    });

    it('should handle exists_with_different_flags as idempotent', async () => {
      mockLedgerClient.createAccountsBatch.mockRejectedValue(
        new TigerBeetleAccountError('exists_with_different_flags', 1n)
      );

      const pair = await accountManager.createPeerAccounts('peer-dup-flags', 'USD');
      expect(pair.peerId).toBe('peer-dup-flags');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ peerId: 'peer-dup-flags' }),
        'Accounts already exist for peer (idempotent operation)'
      );
    });

    it('should handle linked_event_failed as idempotent', async () => {
      mockLedgerClient.createAccountsBatch.mockRejectedValue(
        new TigerBeetleAccountError('linked_event_failed', 1n)
      );

      const pair = await accountManager.createPeerAccounts('peer-dup-link', 'USD');
      expect(pair.peerId).toBe('peer-dup-link');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ peerId: 'peer-dup-link' }),
        'Accounts already exist for peer (idempotent operation)'
      );
    });

    it('should throw non-TigerBeetleAccountError directly', async () => {
      mockLedgerClient.createAccountsBatch.mockRejectedValue(new Error('database connection lost'));

      await expect(accountManager.createPeerAccounts('peer-err', 'USD')).rejects.toThrow(
        'database connection lost'
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ peerId: 'peer-err' }),
        'Failed to create peer account pair'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 3. ensurePeerAccounts branches
  // ---------------------------------------------------------------------------
  describe('ensurePeerAccounts', () => {
    beforeEach(() => {
      accountManager = new AccountManager({ nodeId: 'test-node' }, mockLedgerClient, mockLogger);
    });

    it('should return confirmed cached pair without re-creating', async () => {
      await accountManager.createPeerAccounts('peer-conf', 'USD');
      mockLedgerClient.createAccountsBatch.mockClear();

      const pair = await accountManager.ensurePeerAccounts('peer-conf', 'USD');
      expect(pair.peerId).toBe('peer-conf');
      expect(mockLedgerClient.createAccountsBatch).not.toHaveBeenCalled();
    });

    it('should re-create when confirmed set has key but cache is missing', async () => {
      await accountManager.createPeerAccounts('peer-miss', 'USD');

      // Remove from cache but leave in confirmed set
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (accountManager as any)._accountCache.delete('peer-miss:USD');
      mockLedgerClient.createAccountsBatch.mockClear();

      await accountManager.ensurePeerAccounts('peer-miss', 'USD');
      // Falls through to createPeerAccounts because cached pair is undefined
      expect(mockLedgerClient.createAccountsBatch).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. getPeerVolumeTotals
  // ---------------------------------------------------------------------------
  describe('getPeerVolumeTotals', () => {
    beforeEach(() => {
      accountManager = new AccountManager({ nodeId: 'test-node' }, mockLedgerClient, mockLogger);
    });

    it('should calculate incoming and outgoing volumes', async () => {
      const pair = accountManager.getPeerAccountPair('peer-vol', 'USD');
      mockLedgerClient.getAccountsBatch.mockResolvedValue(
        new Map([
          [pair.debitAccountId, { debits: 1000n, credits: 200n, balance: 800n }],
          [pair.creditAccountId, { debits: 300n, credits: 700n, balance: 400n }],
        ])
      );

      const volumes = await accountManager.getPeerVolumeTotals('peer-vol', 'USD');
      expect(volumes.incomingVolume).toBe(800n); // 1000 - 200
      expect(volumes.outgoingVolume).toBe(400n); // 700 - 300
    });

    it('should return zero volumes when accounts are not found', async () => {
      mockLedgerClient.getAccountsBatch.mockResolvedValue(new Map());

      const volumes = await accountManager.getPeerVolumeTotals('peer-empty', 'USD');
      expect(volumes.incomingVolume).toBe(0n);
      expect(volumes.outgoingVolume).toBe(0n);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. recordSettlement branches
  // ---------------------------------------------------------------------------
  describe('recordSettlement', () => {
    beforeEach(() => {
      accountManager = new AccountManager({ nodeId: 'test-node' }, mockLedgerClient, mockLogger);
    });

    it('should post settlement directly when batch writer is disabled', async () => {
      mockLedgerClient.createAccountsBatch.mockResolvedValue(undefined);
      mockLedgerClient.createTransfersBatch.mockResolvedValue(undefined);

      await accountManager.recordSettlement('peer-settle', 'USD', 100n);
      expect(mockLedgerClient.createTransfersBatch).toHaveBeenCalledTimes(1);
      const transferArg = mockLedgerClient.createTransfersBatch.mock.calls[0]![0] as Array<{
        debit_account_id: bigint;
        credit_account_id: bigint;
        amount: bigint;
      }>;
      expect(transferArg).toHaveLength(1);
      expect(transferArg[0]!.amount).toBe(100n);
    });

    it('should queue settlement when batch writer is enabled', async () => {
      const mockBatchWriter = {
        addTransfer: jest.fn().mockResolvedValue(undefined),
        shutdown: jest.fn().mockResolvedValue(undefined),
        getStats: jest.fn().mockReturnValue({
          pendingTransfers: 0,
          totalTransfersProcessed: 0,
          totalBatchesFlushed: 0,
          isFlushing: false,
        }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (accountManager as any)._batchWriter = mockBatchWriter;

      mockLedgerClient.createAccountsBatch.mockResolvedValue(undefined);

      await accountManager.recordSettlement('peer-bw', 'USD', 200n);
      expect(mockBatchWriter.addTransfer).toHaveBeenCalledTimes(1);
      expect(mockBatchWriter.addTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 200n,
          ledger: AccountLedgerCodes.DEFAULT_LEDGER,
          code: 1,
        })
      );
      expect(mockLogger.trace).toHaveBeenCalledWith(
        expect.objectContaining({ peerId: 'peer-bw', tokenId: 'USD' }),
        'Settlement transfer queued for batched write'
      );
    });

    it('should throw TigerBeetleAccountError on direct write failure', async () => {
      mockLedgerClient.createAccountsBatch.mockResolvedValue(undefined);
      mockLedgerClient.createTransfersBatch.mockRejectedValue(new Error('ledger full'));

      await expect(accountManager.recordSettlement('peer-fail', 'USD', 50n)).rejects.toThrow(
        TigerBeetleAccountError
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ peerId: 'peer-fail', tokenId: 'USD' }),
        'Settlement transfer failed'
      );
    });

    it('should handle non-Error rejection in direct write path', async () => {
      mockLedgerClient.createAccountsBatch.mockResolvedValue(undefined);
      mockLedgerClient.createTransfersBatch.mockRejectedValue('string-error');

      await expect(accountManager.recordSettlement('peer-str-err', 'USD', 50n)).rejects.toThrow(
        TigerBeetleAccountError
      );
      // The error message should contain 'Unknown error' because the rejection is not an Error instance
      await expect(accountManager.recordSettlement('peer-str-err', 'USD', 50n)).rejects.toThrow(
        'Settlement transfer failed for peer peer-str-err: Unknown error'
      );
    });

    it('should throw TigerBeetleAccountError on batch writer failure', async () => {
      const mockBatchWriter = {
        addTransfer: jest.fn().mockRejectedValue(new Error('queue overflow')),
        shutdown: jest.fn().mockResolvedValue(undefined),
        getStats: jest.fn(),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (accountManager as any)._batchWriter = mockBatchWriter;

      mockLedgerClient.createAccountsBatch.mockResolvedValue(undefined);

      await expect(accountManager.recordSettlement('peer-bw-fail', 'USD', 50n)).rejects.toThrow(
        TigerBeetleAccountError
      );
      expect(mockBatchWriter.addTransfer).toHaveBeenCalled();
    });

    it('should handle non-Error rejection in batch writer path', async () => {
      const mockBatchWriter = {
        addTransfer: jest.fn().mockRejectedValue({ code: 42 }),
        shutdown: jest.fn().mockResolvedValue(undefined),
        getStats: jest.fn(),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (accountManager as any)._batchWriter = mockBatchWriter;

      mockLedgerClient.createAccountsBatch.mockResolvedValue(undefined);

      await expect(accountManager.recordSettlement('peer-bw-obj-err', 'USD', 50n)).rejects.toThrow(
        'Settlement transfer failed for peer peer-bw-obj-err: Unknown error'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 6. shutdown / getBatchWriterStats
  // ---------------------------------------------------------------------------
  describe('shutdown and getBatchWriterStats', () => {
    beforeEach(() => {
      accountManager = new AccountManager({ nodeId: 'test-node' }, mockLedgerClient, mockLogger);
    });

    it('should shut down batch writer when present', async () => {
      const mockBatchWriter = {
        shutdown: jest.fn().mockResolvedValue(undefined),
        getStats: jest.fn(),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (accountManager as any)._batchWriter = mockBatchWriter;

      await accountManager.shutdown();
      expect(mockBatchWriter.shutdown).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith('Shutting down AccountManager batch writer');
    });

    it('should do nothing on shutdown when batch writer is absent', async () => {
      await expect(accountManager.shutdown()).resolves.toBeUndefined();
    });

    it('should return stats when batch writer is enabled', () => {
      const stats = {
        pendingTransfers: 3,
        totalTransfersProcessed: 42,
        totalBatchesFlushed: 5,
        isFlushing: false,
      };
      const mockBatchWriter = {
        getStats: jest.fn().mockReturnValue(stats),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (accountManager as any)._batchWriter = mockBatchWriter;

      expect(accountManager.getBatchWriterStats()).toEqual(stats);
    });

    it('should return undefined stats when batch writer is disabled', () => {
      expect(accountManager.getBatchWriterStats()).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 7. _createTransferFn branches
  // ---------------------------------------------------------------------------
  describe('_createTransferFn', () => {
    beforeEach(() => {
      accountManager = new AccountManager({ nodeId: 'test-node' }, mockLedgerClient, mockLogger);
    });

    it('should return empty errors on successful batch transfer', async () => {
      mockLedgerClient.createTransfersBatch.mockResolvedValue(undefined);

      const transfers = [
        {
          id: 1n,
          debitAccountId: 100n,
          creditAccountId: 200n,
          amount: 50n,
          ledger: 1,
          code: 1,
          flags: 0,
          timestamp: 0n,
          userData128: 0n,
          userData64: 0n,
          userData32: 0,
          timeout: 0,
        },
      ];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errors = await (accountManager as any)._createTransferFn(transfers);
      expect(errors).toEqual([]);
      expect(mockLedgerClient.createTransfersBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: 1n,
            debit_account_id: 100n,
            credit_account_id: 200n,
            amount: 50n,
          }),
        ])
      );
    });

    it('should return generic errors when batch transfer fails', async () => {
      mockLedgerClient.createTransfersBatch.mockRejectedValue(new Error('batch timeout'));

      const transfers = [
        {
          id: 2n,
          debitAccountId: 101n,
          creditAccountId: 201n,
          amount: 60n,
          ledger: 1,
          code: 1,
          flags: 0,
          timestamp: 0n,
          userData128: 0n,
          userData64: 0n,
          userData32: 0,
          timeout: 0,
        },
        {
          id: 3n,
          debitAccountId: 102n,
          creditAccountId: 202n,
          amount: 70n,
          ledger: 1,
          code: 1,
          flags: 0,
          timestamp: 0n,
          userData128: 0n,
          userData64: 0n,
          userData32: 0,
          timeout: 0,
        },
      ];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errors = await (accountManager as any)._createTransferFn(transfers);
      expect(errors).toHaveLength(2);
      expect(errors).toEqual([
        { index: 0, code: 1 },
        { index: 1, code: 1 },
      ]);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ transferCount: 2 }),
        'Batch transfer creation failed'
      );
    });

    it('should handle non-Error rejection in _createTransferFn', async () => {
      mockLedgerClient.createTransfersBatch.mockRejectedValue({ notAnError: true });

      const transfers = [
        {
          id: 4n,
          debitAccountId: 103n,
          creditAccountId: 203n,
          amount: 80n,
          ledger: 1,
          code: 1,
          flags: 0,
          timestamp: 0n,
          userData128: 0n,
          userData64: 0n,
          userData32: 0,
          timeout: 0,
        },
      ];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errors = await (accountManager as any)._createTransferFn(transfers);
      expect(errors).toHaveLength(1);
      expect(errors).toEqual([{ index: 0, code: 1 }]);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Unknown error', transferCount: 1 }),
        'Batch transfer creation failed'
      );
    });
  });

  describe('_convertToBatchWriterTransfer', () => {
    beforeEach(() => {
      accountManager = new AccountManager({ nodeId: 'test-node' }, mockLedgerClient, mockLogger);
    });

    it('should use default values for omitted optional fields', () => {
      const transfer = {
        id: 5n,
        debitAccountId: 104n,
        creditAccountId: 204n,
        amount: 90n,
        ledger: 1,
        code: 1,
        flags: 0,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (accountManager as any)._convertToBatchWriterTransfer(transfer);
      expect(result.user_data_128).toBe(0n);
      expect(result.user_data_64).toBe(0n);
      expect(result.user_data_32).toBe(0);
      expect(result.timeout).toBe(0);
      expect(result.timestamp).toBe(0n);
    });

    it('should use provided optional fields when defined', () => {
      const transfer = {
        id: 6n,
        debitAccountId: 105n,
        creditAccountId: 205n,
        amount: 95n,
        ledger: 1,
        code: 1,
        flags: 0,
        userData128: 123n,
        userData64: 456n,
        userData32: 78,
        timeout: 30,
        timestamp: 999n,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (accountManager as any)._convertToBatchWriterTransfer(transfer);
      expect(result.user_data_128).toBe(123n);
      expect(result.user_data_64).toBe(456n);
      expect(result.user_data_32).toBe(78);
      expect(result.timeout).toBe(30);
      expect(result.timestamp).toBe(999n);
    });

    it('should treat falsy but defined values as provided', () => {
      const transfer = {
        id: 7n,
        debitAccountId: 106n,
        creditAccountId: 206n,
        amount: 91n,
        ledger: 1,
        code: 1,
        flags: 0,
        userData128: 0n,
        userData64: 0n,
        userData32: 0,
        timeout: 0,
        timestamp: 0n,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (accountManager as any)._convertToBatchWriterTransfer(transfer);
      // 0n is falsy but defined; ?? returns the left operand for non-null/undefined
      expect(result.user_data_128).toBe(0n);
      expect(result.user_data_64).toBe(0n);
      expect(result.user_data_32).toBe(0);
      expect(result.timeout).toBe(0);
      expect(result.timestamp).toBe(0n);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. checkCreditLimit cache branch
  // ---------------------------------------------------------------------------
  describe('checkCreditLimit cache branch', () => {
    beforeEach(() => {
      accountManager = new AccountManager(
        {
          nodeId: 'test-node',
          creditLimits: { defaultLimit: 1000n },
        },
        mockLedgerClient,
        mockLogger
      );
    });

    it('should use cached account pair without creating accounts', async () => {
      // Pre-populate cache (but not confirmed set)
      accountManager.getPeerAccountPair('peer-cache', 'M2M');
      mockLedgerClient.getAccountsBatch.mockResolvedValue(
        new Map([
          [expect.any(BigInt), { debits: 0n, credits: 0n, balance: 0n }],
          [expect.any(BigInt), { debits: 0n, credits: 0n, balance: 0n }],
        ])
      );

      const violation = await accountManager.checkCreditLimit('peer-cache', 'M2M', 100n);
      expect(violation).toBeNull();
      // Should NOT have called createAccountsBatch because pair was in cache
      expect(mockLedgerClient.createAccountsBatch).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 9. _applyCeiling private branches
  // ---------------------------------------------------------------------------
  describe('_applyCeiling', () => {
    beforeEach(() => {
      accountManager = new AccountManager(
        { nodeId: 'test-node', creditLimits: { defaultLimit: 1000n } },
        mockLedgerClient,
        mockLogger
      );
    });

    it('should return undefined when input limit is undefined', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (accountManager as any)._applyCeiling(undefined);
      expect(result).toBeUndefined();
    });

    it('should return limit unchanged when no global ceiling is set', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (accountManager as any)._applyCeiling(750n);
      expect(result).toBe(750n);
    });

    it('should apply global ceiling when configured', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (accountManager as any)._creditLimitConfig = { globalCeiling: 500n };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((accountManager as any)._applyCeiling(750n)).toBe(500n);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((accountManager as any)._applyCeiling(300n)).toBe(300n);
    });
  });
});
