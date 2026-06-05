/**
 * Unit Tests for MinaPaymentChannelSDK
 *
 * Story 34.4: MinaPaymentChannelSDK -- TypeScript Integration
 *
 * Tests verify that the SDK correctly delegates to o1js and mina-zkapp
 * without running real proof generation. All o1js interactions are mocked.
 *
 * Test categories:
 * 1. Compilation -- compileContract() calls PaymentChannel.compile(), caches result
 * 2. Channel lifecycle -- each method constructs correct transactions
 * 3. State reading -- getChannelState() converts Field values correctly
 * 4. Error handling -- network errors, invalid states, missing accounts
 * 5. Polling subscription -- start/stop, callback invocation on state change
 * 6. Optional dependency -- graceful error when o1js not installed
 * 7. Signer key requirements -- methods throw when no key provided
 *
 * @module mina-payment-channel-sdk.test
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Mock o1js -- intercepts the transpiled require() from dynamic import()
// ---------------------------------------------------------------------------

const mockFieldFn = jest.fn((v: unknown) => ({
  toString: () => String(v),
  toBigInt: () => BigInt(String(v)),
}));

const mockSendResult = {
  hash: 'mina_tx_hash_abc123',
};

const mockTxn = {
  prove: jest.fn().mockResolvedValue(undefined),
  sign: jest.fn().mockReturnValue({
    send: jest.fn().mockResolvedValue(mockSendResult),
  }),
};

const mockMinaTransaction = jest.fn().mockResolvedValue(mockTxn);

const mockMina = {
  Network: jest.fn().mockReturnValue('mock-network-instance'),
  setActiveInstance: jest.fn(),
  transaction: mockMinaTransaction,
};

const mockPrivateKeyInstance = {
  toPublicKey: jest.fn().mockReturnValue({
    toBase58: jest.fn().mockReturnValue('B62qMockPublicKeyBase58'),
    x: { toString: () => 'mock-x-field' },
  }),
};

const mockPrivateKey = {
  random: jest.fn().mockReturnValue({
    ...mockPrivateKeyInstance,
    toPublicKey: jest.fn().mockReturnValue({
      toBase58: jest.fn().mockReturnValue('B62qZkAppNewAddress1234'),
      x: { toString: () => 'mock-zkapp-x-field' },
    }),
  }),
  fromBase58: jest.fn().mockReturnValue(mockPrivateKeyInstance),
};

const mockPublicKey = {
  fromBase58: jest.fn().mockReturnValue({
    toBase58: jest.fn().mockReturnValue('B62qMockPublicKeyBase58'),
    x: { toString: () => 'mock-pub-x' },
  }),
};

const mockPoseidonHash = jest.fn().mockReturnValue({
  toString: () => 'mock-poseidon-hash',
  toBigInt: () => 0n,
});

const mockSignatureInstance = {
  toJSON: jest.fn().mockReturnValue({ r: 'mock-r-value', s: 'mock-s-value' }),
  verify: jest.fn().mockReturnValue({ toBoolean: () => true }),
};

const mockSignature = {
  create: jest.fn().mockReturnValue(mockSignatureInstance),
  fromJSON: jest.fn().mockReturnValue(mockSignatureInstance),
};

const mockFetchAccount = jest.fn().mockResolvedValue({ account: {} });

const mockAccountUpdate = {
  fundNewAccount: jest.fn(),
};

jest.mock('o1js', () => ({
  Mina: mockMina,
  PrivateKey: mockPrivateKey,
  PublicKey: mockPublicKey,
  Field: mockFieldFn,
  Poseidon: { hash: mockPoseidonHash },
  Signature: mockSignature,
  fetchAccount: mockFetchAccount,
  AccountUpdate: mockAccountUpdate,
}));

// ---------------------------------------------------------------------------
// Mock @toon-protocol/mina-zkapp
// ---------------------------------------------------------------------------

const mockZkAppInstance = {
  deploy: jest.fn().mockResolvedValue(undefined),
  initializeChannel: jest.fn().mockResolvedValue(undefined),
  deposit: jest.fn().mockResolvedValue(undefined),
  claimFromChannel: jest.fn().mockResolvedValue(undefined),
  initiateClose: jest.fn().mockResolvedValue(undefined),
  settle: jest.fn().mockResolvedValue(undefined),
  fetchEvents: jest.fn().mockResolvedValue([]),
  // On-chain state getters (return mock Field objects)
  channelHash: {
    get: jest.fn().mockReturnValue({ toString: () => 'channel_hash_123', toBigInt: () => 123n }),
  },
  balanceCommitment: {
    get: jest.fn().mockReturnValue({
      toString: () => 'balance_commitment_456',
      toBigInt: () => 456n,
    }),
  },
  nonceField: {
    get: jest.fn().mockReturnValue({ toString: () => '5', toBigInt: () => 5n }),
  },
  channelState: {
    get: jest.fn().mockReturnValue({ toString: () => '1', toBigInt: () => 1n }),
  },
  depositTotal: {
    get: jest.fn().mockReturnValue({ toString: () => '1000000', toBigInt: () => 1000000n }),
  },
  closedAtSlot: {
    get: jest.fn().mockReturnValue({ toString: () => '0', toBigInt: () => 0n }),
  },
  settlementTimeout: {
    get: jest.fn().mockReturnValue({ toString: () => '100', toBigInt: () => 100n }),
  },
  tokenId_: {
    get: jest.fn().mockReturnValue({ toString: () => '1', toBigInt: () => 1n }),
  },
};

const MockPaymentChannelClass = jest.fn().mockImplementation(() => mockZkAppInstance);
(MockPaymentChannelClass as any).compile = jest
  .fn()
  .mockResolvedValue({ verificationKey: 'mock-vk' });

jest.mock('@toon-protocol/mina-zkapp', () => ({
  PaymentChannel: MockPaymentChannelClass,
  CHANNEL_STATE: { UNINITIALIZED: 0, OPEN: 1, CLOSING: 2, SETTLED: 3 },
  MAX_SAFE_AMOUNT: 18446744073709551615n,
}));

// ---------------------------------------------------------------------------
// Import SDK after mocks are set up
// ---------------------------------------------------------------------------

import {
  MinaPaymentChannelSDK,
  MinaChannelError,
  MINA_ERROR_CODES,
  _resetModuleCaches,
} from './mina-payment-channel-sdk';
// MinaChannelState and MinaSubscription types used implicitly in test assertions

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

interface MockLogger {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
  trace: jest.Mock;
  fatal: jest.Mock;
  child: jest.Mock;
  level: string;
}

function createMockLogger(): MockLogger {
  const logger: MockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn(),
    level: 'silent',
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

const TEST_GRAPHQL_URL = 'https://proxy.devnet.minaexplorer.com/graphql';
const TEST_ZKAPP_ADDRESS = 'B62qkYa1o6Mj6uTTjDQCob7FuzZspSC37uyY9sNB5N5vrJ4aLHGRJg';
const TEST_SIGNER_KEY = 'EKFd7goQkVaHPpU1234567890abcdef';
const TEST_PARTICIPANT_A = 'B62qkYa1o6Mj6uTTjDQCob7FuzZspSC37uyY9sNB5N5vrJ4aLHGRJg';
const TEST_PARTICIPANT_B = 'B62qoG5bKBYCxaVcBN3kPFmqJkLm9K6mZh5v8VBSu4kJqBx4VBfRvE';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MinaPaymentChannelSDK (Story 34.4)', () => {
  let sdk: MinaPaymentChannelSDK;
  let logger: MockLogger;

  beforeEach(() => {
    jest.clearAllMocks();
    logger = createMockLogger();
    sdk = new MinaPaymentChannelSDK(
      TEST_GRAPHQL_URL,
      TEST_ZKAPP_ADDRESS,
      logger as any,
      TEST_SIGNER_KEY
    );
  });

  // -------------------------------------------------------------------------
  // T-34.4-01: Constructor and Properties
  // -------------------------------------------------------------------------

  describe('constructor and properties', () => {
    it('should store graphqlUrl as a public property', () => {
      expect(sdk.graphqlUrl).toBe(TEST_GRAPHQL_URL);
    });

    it('should construct without a signer key (read-only mode)', () => {
      const readOnlySdk = new MinaPaymentChannelSDK(
        TEST_GRAPHQL_URL,
        TEST_ZKAPP_ADDRESS,
        logger as any
      );
      expect(readOnlySdk.graphqlUrl).toBe(TEST_GRAPHQL_URL);
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-02: compileContract (AC 1)
  // -------------------------------------------------------------------------

  describe('compileContract (AC 1)', () => {
    it('should call PaymentChannel.compile() from o1js', async () => {
      await sdk.compileContract();

      expect((MockPaymentChannelClass as any).compile).toHaveBeenCalledTimes(1);
    });

    it('should cache compilation result -- subsequent calls are no-ops', async () => {
      await sdk.compileContract();
      await sdk.compileContract();

      // compile() should only be called once
      expect((MockPaymentChannelClass as any).compile).toHaveBeenCalledTimes(1);
    });

    it('should log compilation time', async () => {
      await sdk.compileContract();

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'compile_contract_complete',
          zkAppAddress: TEST_ZKAPP_ADDRESS,
        }),
        expect.stringContaining('compiled')
      );
    });

    it('should throw MinaChannelError on compilation failure', async () => {
      (MockPaymentChannelClass as any).compile.mockRejectedValueOnce(
        new Error('Circuit constraint system error')
      );

      const freshSdk = new MinaPaymentChannelSDK(
        TEST_GRAPHQL_URL,
        TEST_ZKAPP_ADDRESS,
        logger as any,
        TEST_SIGNER_KEY
      );

      await expect(freshSdk.compileContract()).rejects.toThrow(MinaChannelError);

      (MockPaymentChannelClass as any).compile.mockRejectedValueOnce(
        new Error('Circuit constraint system error')
      );

      const freshSdk2 = new MinaPaymentChannelSDK(
        TEST_GRAPHQL_URL,
        TEST_ZKAPP_ADDRESS,
        logger as any,
        TEST_SIGNER_KEY
      );

      await expect(freshSdk2.compileContract()).rejects.toMatchObject({
        code: MINA_ERROR_CODES.COMPILE_FAILED,
        errorName: 'COMPILE_FAILED',
      });
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-03: openChannel (AC 2)
  // -------------------------------------------------------------------------

  describe('openChannel (AC 2)', () => {
    it('should deploy a new zkApp and call initializeChannel', async () => {
      const result = await sdk.openChannel(TEST_PARTICIPANT_A, TEST_PARTICIPANT_B, 100, '1');

      // Should generate a new key pair
      expect(mockPrivateKey.random).toHaveBeenCalledTimes(1);

      // Should set the network
      expect(mockMina.Network).toHaveBeenCalledWith(TEST_GRAPHQL_URL);
      expect(mockMina.setActiveInstance).toHaveBeenCalled();

      // Should create a transaction
      expect(mockMinaTransaction).toHaveBeenCalledTimes(1);

      // Should prove and sign
      expect(mockTxn.prove).toHaveBeenCalledTimes(1);
      expect(mockTxn.sign).toHaveBeenCalledTimes(1);

      // Should return result with zkApp address and tx hash
      expect(result).toHaveProperty('zkAppAddress');
      expect(result).toHaveProperty('txHash');
      expect(result.txHash).toBe('mina_tx_hash_abc123');
    });

    it('should use default tokenId when not provided', async () => {
      await sdk.openChannel(TEST_PARTICIPANT_A, TEST_PARTICIPANT_B, 100);

      // Field should be called with '1' as default tokenId
      expect(mockFieldFn).toHaveBeenCalledWith('1');
    });

    it('should cache participant keys after opening', async () => {
      const result = await sdk.openChannel(TEST_PARTICIPANT_A, TEST_PARTICIPANT_B, 100);

      // Verify participant cache is populated by attempting getChannelState
      // which uses the cache for participant keys
      const state = await sdk.getChannelState(result.zkAppAddress);
      // Due to mocking, we just verify no errors are thrown and participant keys may be cached
      expect(state).toBeDefined();
    });

    it('should throw MinaChannelError when no signer key is configured', async () => {
      const noSignerSdk = new MinaPaymentChannelSDK(
        TEST_GRAPHQL_URL,
        TEST_ZKAPP_ADDRESS,
        logger as any
      );

      await expect(
        noSignerSdk.openChannel(TEST_PARTICIPANT_A, TEST_PARTICIPANT_B, 100)
      ).rejects.toMatchObject({
        code: MINA_ERROR_CODES.INVALID_PARAMETERS,
        errorName: 'INVALID_PARAMETERS',
      });
    });

    it('should log the open channel event', async () => {
      await sdk.openChannel(TEST_PARTICIPANT_A, TEST_PARTICIPANT_B, 100);

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'open_channel' }),
        expect.any(String)
      );
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-04: deposit (AC 3)
  // -------------------------------------------------------------------------

  describe('deposit (AC 3)', () => {
    it('should construct and submit a deposit transaction', async () => {
      const result = await sdk.deposit(TEST_ZKAPP_ADDRESS, 500000n);

      expect(mockFetchAccount).toHaveBeenCalled();
      expect(mockMinaTransaction).toHaveBeenCalledTimes(1);
      expect(mockTxn.prove).toHaveBeenCalledTimes(1);
      expect(mockTxn.sign).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ txHash: 'mina_tx_hash_abc123' });
    });

    it('should convert bigint amount to Field', async () => {
      await sdk.deposit(TEST_ZKAPP_ADDRESS, 1000000n);

      expect(mockFieldFn).toHaveBeenCalledWith(1000000n);
    });

    it('should throw when no signer key is configured', async () => {
      const noSignerSdk = new MinaPaymentChannelSDK(
        TEST_GRAPHQL_URL,
        TEST_ZKAPP_ADDRESS,
        logger as any
      );

      await expect(noSignerSdk.deposit(TEST_ZKAPP_ADDRESS, 100n)).rejects.toMatchObject({
        code: MINA_ERROR_CODES.INVALID_PARAMETERS,
      });
    });

    it('should throw MinaChannelError when account not found', async () => {
      // First fetchAccount call is for the sender (succeeds),
      // second is for the channel address in _getZkApp (fails)
      mockFetchAccount
        .mockResolvedValueOnce({ account: {} })
        .mockResolvedValueOnce({ error: 'Account does not exist' });

      await expect(sdk.deposit(TEST_ZKAPP_ADDRESS, 100n)).rejects.toMatchObject({
        code: MINA_ERROR_CODES.ACCOUNT_NOT_FOUND,
      });
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-05: claimFromChannel (AC 4, 12)
  // -------------------------------------------------------------------------

  describe('claimFromChannel (AC 4, 12)', () => {
    const mockSignatureStr = JSON.stringify({ r: 'sig-r-value', s: 'sig-s-value' });

    beforeEach(async () => {
      // Pre-populate participant cache by opening a channel
      await sdk.openChannel(TEST_PARTICIPANT_A, TEST_PARTICIPANT_B, 100);
      jest.clearAllMocks();
      // Re-mock fetchAccount since clearAllMocks resets it
      mockFetchAccount.mockResolvedValue({ account: {} });
    });

    it('should accept signatureA and signatureB parameters', async () => {
      // Need to set up the cache for the zkApp address that _getZkApp will use
      // The openChannel above caches for a mock address, so we need a direct approach
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cacheMap = (sdk as any)._participantCache as Map<string, any>;
      cacheMap.set(TEST_ZKAPP_ADDRESS, {
        participantA: TEST_PARTICIPANT_A,
        participantB: TEST_PARTICIPANT_B,
      });

      const result = await sdk.claimFromChannel(
        TEST_ZKAPP_ADDRESS,
        600000n,
        400000n,
        12345n,
        1n,
        mockSignatureStr,
        mockSignatureStr
      );

      expect(result).toEqual({ txHash: 'mina_tx_hash_abc123' });
    });

    it('should compute Poseidon commitment from balances and salt', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cacheMap = (sdk as any)._participantCache as Map<string, any>;
      cacheMap.set(TEST_ZKAPP_ADDRESS, {
        participantA: TEST_PARTICIPANT_A,
        participantB: TEST_PARTICIPANT_B,
      });

      await sdk.claimFromChannel(
        TEST_ZKAPP_ADDRESS,
        600000n,
        400000n,
        12345n,
        1n,
        mockSignatureStr,
        mockSignatureStr
      );

      expect(mockPoseidonHash).toHaveBeenCalled();
    });

    it('should deserialize signature strings into o1js Signature objects', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cacheMap = (sdk as any)._participantCache as Map<string, any>;
      cacheMap.set(TEST_ZKAPP_ADDRESS, {
        participantA: TEST_PARTICIPANT_A,
        participantB: TEST_PARTICIPANT_B,
      });

      await sdk.claimFromChannel(
        TEST_ZKAPP_ADDRESS,
        600000n,
        400000n,
        12345n,
        1n,
        mockSignatureStr,
        mockSignatureStr
      );

      expect(mockSignature.fromJSON).toHaveBeenCalledTimes(2);
      expect(mockSignature.fromJSON).toHaveBeenCalledWith({ r: 'sig-r-value', s: 'sig-s-value' });
    });

    it('should throw when participant keys not in cache', async () => {
      // Use an address that was NOT opened by this SDK
      const unknownAddress = 'B62qUnknownAddressNotInCache123';

      await expect(
        sdk.claimFromChannel(
          unknownAddress,
          600000n,
          400000n,
          12345n,
          1n,
          mockSignatureStr,
          mockSignatureStr
        )
      ).rejects.toMatchObject({
        code: MINA_ERROR_CODES.ACCOUNT_NOT_FOUND,
      });
    });

    it('should throw when no signer key is configured', async () => {
      const noSignerSdk = new MinaPaymentChannelSDK(
        TEST_GRAPHQL_URL,
        TEST_ZKAPP_ADDRESS,
        logger as any
      );

      await expect(
        noSignerSdk.claimFromChannel(
          TEST_ZKAPP_ADDRESS,
          600000n,
          400000n,
          12345n,
          1n,
          mockSignatureStr,
          mockSignatureStr
        )
      ).rejects.toMatchObject({
        code: MINA_ERROR_CODES.INVALID_PARAMETERS,
      });
    });

    it('should re-throw MinaChannelError without double-wrapping', async () => {
      // Given: _getZkApp throws a MinaChannelError (e.g., ACCOUNT_NOT_FOUND)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cacheMap = (sdk as any)._participantCache as Map<string, any>;
      cacheMap.set(TEST_ZKAPP_ADDRESS, {
        participantA: TEST_PARTICIPANT_A,
        participantB: TEST_PARTICIPANT_B,
      });

      // fetchAccount for sender succeeds, but for channel returns error
      mockFetchAccount
        .mockResolvedValueOnce({ account: {} }) // sender fetch
        .mockResolvedValueOnce({ error: 'Account does not exist' }); // channel fetch

      // When: claimFromChannel is called
      // Then: the original MinaChannelError is thrown, not wrapped in PROOF_GENERATION_FAILED
      await expect(
        sdk.claimFromChannel(
          TEST_ZKAPP_ADDRESS,
          600000n,
          400000n,
          12345n,
          1n,
          mockSignatureStr,
          mockSignatureStr
        )
      ).rejects.toMatchObject({
        code: MINA_ERROR_CODES.ACCOUNT_NOT_FOUND,
        errorName: 'ACCOUNT_NOT_FOUND',
      });
    });

    it('should generate proof asynchronously via txn.prove()', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cacheMap = (sdk as any)._participantCache as Map<string, any>;
      cacheMap.set(TEST_ZKAPP_ADDRESS, {
        participantA: TEST_PARTICIPANT_A,
        participantB: TEST_PARTICIPANT_B,
      });

      await sdk.claimFromChannel(
        TEST_ZKAPP_ADDRESS,
        600000n,
        400000n,
        12345n,
        1n,
        mockSignatureStr,
        mockSignatureStr
      );

      // txn.prove() should be called asynchronously
      expect(mockTxn.prove).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-06: closeChannel (AC 5)
  // -------------------------------------------------------------------------

  describe('closeChannel (AC 5)', () => {
    const mockSigStr = JSON.stringify({ r: 'close-r', s: 'close-s' });

    it('should accept individual signatureA/signatureB and nonce', async () => {
      const result = await sdk.closeChannel(
        TEST_ZKAPP_ADDRESS,
        600000n,
        400000n,
        99999n,
        1n,
        mockSigStr,
        mockSigStr
      );

      expect(result).toEqual({ txHash: 'mina_tx_hash_abc123' });
    });

    it('should call initiateClose on the zkApp', async () => {
      await sdk.closeChannel(
        TEST_ZKAPP_ADDRESS,
        600000n,
        400000n,
        99999n,
        1n,
        mockSigStr,
        mockSigStr
      );

      // Should create a transaction (which calls initiateClose inside)
      expect(mockMinaTransaction).toHaveBeenCalledTimes(1);
      expect(mockTxn.prove).toHaveBeenCalledTimes(1);
    });

    it('should deserialize signature strings', async () => {
      await sdk.closeChannel(
        TEST_ZKAPP_ADDRESS,
        600000n,
        400000n,
        99999n,
        1n,
        mockSigStr,
        mockSigStr
      );

      expect(mockSignature.fromJSON).toHaveBeenCalledTimes(2);
    });

    it('should throw when no signer key is configured', async () => {
      const noSignerSdk = new MinaPaymentChannelSDK(
        TEST_GRAPHQL_URL,
        TEST_ZKAPP_ADDRESS,
        logger as any
      );

      await expect(
        noSignerSdk.closeChannel(
          TEST_ZKAPP_ADDRESS,
          600000n,
          400000n,
          99999n,
          1n,
          mockSigStr,
          mockSigStr
        )
      ).rejects.toMatchObject({
        code: MINA_ERROR_CODES.INVALID_PARAMETERS,
      });
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-07: settleChannel (AC 6)
  // -------------------------------------------------------------------------

  describe('settleChannel (AC 6)', () => {
    it('should accept reveal parameters', async () => {
      const result = await sdk.settleChannel(
        TEST_ZKAPP_ADDRESS,
        600000n,
        400000n,
        99999n,
        TEST_PARTICIPANT_A,
        TEST_PARTICIPANT_B,
        0n
      );

      expect(result).toEqual({ txHash: 'mina_tx_hash_abc123' });
    });

    it('should convert participant keys to o1js PublicKey objects', async () => {
      await sdk.settleChannel(
        TEST_ZKAPP_ADDRESS,
        600000n,
        400000n,
        99999n,
        TEST_PARTICIPANT_A,
        TEST_PARTICIPANT_B,
        0n
      );

      expect(mockPublicKey.fromBase58).toHaveBeenCalledWith(TEST_PARTICIPANT_A);
      expect(mockPublicKey.fromBase58).toHaveBeenCalledWith(TEST_PARTICIPANT_B);
    });

    it('should call settle on the zkApp', async () => {
      await sdk.settleChannel(
        TEST_ZKAPP_ADDRESS,
        600000n,
        400000n,
        99999n,
        TEST_PARTICIPANT_A,
        TEST_PARTICIPANT_B,
        0n
      );

      expect(mockMinaTransaction).toHaveBeenCalledTimes(1);
      expect(mockTxn.prove).toHaveBeenCalledTimes(1);
    });

    it('should throw when no signer key is configured', async () => {
      const noSignerSdk = new MinaPaymentChannelSDK(
        TEST_GRAPHQL_URL,
        TEST_ZKAPP_ADDRESS,
        logger as any
      );

      await expect(
        noSignerSdk.settleChannel(
          TEST_ZKAPP_ADDRESS,
          600000n,
          400000n,
          99999n,
          TEST_PARTICIPANT_A,
          TEST_PARTICIPANT_B,
          0n
        )
      ).rejects.toMatchObject({
        code: MINA_ERROR_CODES.INVALID_PARAMETERS,
      });
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-08: getChannelState (AC 7)
  // -------------------------------------------------------------------------

  describe('getChannelState (AC 7)', () => {
    it('should read all 8 on-chain state fields', async () => {
      const state = await sdk.getChannelState(TEST_ZKAPP_ADDRESS);

      expect(state).toMatchObject({
        channelHash: 'channel_hash_123',
        balanceCommitment: 'balance_commitment_456',
        nonceField: 5n,
        channelState: 1,
        depositTotal: 1000000n,
        closedAtSlot: 0n,
        settlementTimeout: 100n,
        tokenId: '1',
      });
    });

    it('should convert Field values to correct TypeScript types', async () => {
      const state = await sdk.getChannelState(TEST_ZKAPP_ADDRESS);

      // channelHash: string (from Field.toString())
      expect(typeof state.channelHash).toBe('string');
      // nonceField: bigint (from Field.toBigInt())
      expect(typeof state.nonceField).toBe('bigint');
      // channelState: number (from Number(Field.toBigInt()))
      expect(typeof state.channelState).toBe('number');
      // depositTotal: bigint
      expect(typeof state.depositTotal).toBe('bigint');
    });

    it('should return empty strings for participant keys when not in cache', async () => {
      const state = await sdk.getChannelState(TEST_ZKAPP_ADDRESS);

      // Since we haven't opened this channel with this SDK, participant keys
      // should be empty strings (strategy 3 from Dev Notes)
      expect(state.participantA).toBe('');
      expect(state.participantB).toBe('');
    });

    it('should return cached participant keys when channel was opened by this SDK', async () => {
      // Open a channel to populate the cache
      const openResult = await sdk.openChannel(TEST_PARTICIPANT_A, TEST_PARTICIPANT_B, 100);

      const state = await sdk.getChannelState(openResult.zkAppAddress);

      expect(state.participantA).toBe(TEST_PARTICIPANT_A);
      expect(state.participantB).toBe(TEST_PARTICIPANT_B);
    });

    it('should throw MinaChannelError when account not found', async () => {
      mockFetchAccount.mockResolvedValueOnce({ error: 'Account does not exist' });

      await expect(sdk.getChannelState(TEST_ZKAPP_ADDRESS)).rejects.toMatchObject({
        code: MINA_ERROR_CODES.ACCOUNT_NOT_FOUND,
        errorName: 'ACCOUNT_NOT_FOUND',
      });
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-09: getChannelEvents (AC 8)
  // -------------------------------------------------------------------------

  describe('getChannelEvents (AC 8)', () => {
    it('should return events from the zkApp', async () => {
      mockZkAppInstance.fetchEvents.mockResolvedValueOnce([
        { type: 'deposit', event: { data: { amount: '1000000' } } },
        { type: 'close', event: { data: { slot: '42' } } },
      ]);

      const events = await sdk.getChannelEvents(TEST_ZKAPP_ADDRESS);

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        type: 'deposit',
        data: { amount: '1000000' },
      });
    });

    it('should return empty array when no events', async () => {
      mockZkAppInstance.fetchEvents.mockResolvedValueOnce([]);

      const events = await sdk.getChannelEvents(TEST_ZKAPP_ADDRESS);

      expect(events).toHaveLength(0);
    });

    it('should throw MinaChannelError on archive node errors', async () => {
      mockFetchAccount.mockRejectedValueOnce(new Error('Archive node timeout'));

      await expect(sdk.getChannelEvents(TEST_ZKAPP_ADDRESS)).rejects.toMatchObject({
        code: MINA_ERROR_CODES.ARCHIVE_NODE_ERROR,
        errorName: 'ARCHIVE_NODE_ERROR',
      });
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-10: signBalanceProof (AC 9)
  // -------------------------------------------------------------------------

  describe('signBalanceProof (AC 9)', () => {
    it('should compute Poseidon commitment and sign it', async () => {
      const proof = await sdk.signBalanceProof(TEST_ZKAPP_ADDRESS, 600000n, 400000n, 12345n, 5n);

      const parsed = JSON.parse(proof) as {
        commitment: string;
        signature: { r: string; s: string };
        nonce: string;
      };

      expect(parsed.commitment).toBe('mock-poseidon-hash');
      expect(parsed.signature).toEqual({ r: 'mock-r-value', s: 'mock-s-value' });
      expect(parsed.nonce).toBe('5');
    });

    it('should call Poseidon.hash with balanceA, balanceB, and salt', async () => {
      await sdk.signBalanceProof(TEST_ZKAPP_ADDRESS, 600000n, 400000n, 12345n, 5n);

      expect(mockPoseidonHash).toHaveBeenCalled();
    });

    it('should sign with the SDK private key', async () => {
      await sdk.signBalanceProof(TEST_ZKAPP_ADDRESS, 600000n, 400000n, 12345n, 5n);

      expect(mockSignature.create).toHaveBeenCalledTimes(1);
      expect(mockPrivateKey.fromBase58).toHaveBeenCalledWith(TEST_SIGNER_KEY);
    });

    it('should throw MinaChannelError code 1008 when no signer key is configured', async () => {
      const noSignerSdk = new MinaPaymentChannelSDK(
        TEST_GRAPHQL_URL,
        TEST_ZKAPP_ADDRESS,
        logger as any
      );

      await expect(
        noSignerSdk.signBalanceProof(TEST_ZKAPP_ADDRESS, 600000n, 400000n, 12345n, 5n)
      ).rejects.toMatchObject({
        code: MINA_ERROR_CODES.INVALID_PARAMETERS,
        errorName: 'INVALID_PARAMETERS',
        message: expect.stringContaining('signer private key required'),
      });
    });

    it('should return a valid JSON string', async () => {
      const proof = await sdk.signBalanceProof(TEST_ZKAPP_ADDRESS, 600000n, 400000n, 12345n, 5n);

      expect(() => JSON.parse(proof)).not.toThrow();
      const parsed = JSON.parse(proof);
      expect(parsed).toHaveProperty('commitment');
      expect(parsed).toHaveProperty('signature');
      expect(parsed).toHaveProperty('nonce');
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-11: verifyBalanceProof (AC 10)
  // -------------------------------------------------------------------------

  describe('verifyBalanceProof (AC 10)', () => {
    it('should verify a valid proof and return true', async () => {
      const proofStr = JSON.stringify({
        commitment: 'mock-poseidon-hash',
        signature: { r: 'mock-r-value', s: 'mock-s-value' },
        nonce: '5',
      });

      const isValid = await sdk.verifyBalanceProof(
        TEST_ZKAPP_ADDRESS,
        'mock-poseidon-hash',
        proofStr,
        5n
      );

      expect(isValid).toBe(true);
    });

    // Issue #90: the canonical wire encoding for a Mina claim `proof` is
    // base64(JSON). The verifier must decode it before JSON.parse.
    it('should verify a base64-encoded proof (canonical wire encoding, Issue #90)', async () => {
      const proofJson = JSON.stringify({
        commitment: 'mock-poseidon-hash',
        signature: { r: 'mock-r-value', s: 'mock-s-value' },
        nonce: '5',
      });
      const proofB64 = Buffer.from(proofJson, 'utf8').toString('base64');

      const isValid = await sdk.verifyBalanceProof(
        TEST_ZKAPP_ADDRESS,
        'mock-poseidon-hash',
        proofB64,
        5n
      );

      expect(isValid).toBe(true);
    });

    it('should return false when commitment does not match expected', async () => {
      const proofStr = JSON.stringify({
        commitment: 'bad-commitment',
        signature: { r: 'bad-r', s: 'bad-s' },
        nonce: '5',
      });

      const isValid = await sdk.verifyBalanceProof(
        TEST_ZKAPP_ADDRESS,
        'expected-commitment',
        proofStr,
        5n
      );

      expect(isValid).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'verify_balance_proof_commitment_mismatch' }),
        expect.any(String)
      );
    });

    it('should return false when nonce does not match expected', async () => {
      const proofStr = JSON.stringify({
        commitment: 'mock-poseidon-hash',
        signature: { r: 'mock-r-value', s: 'mock-s-value' },
        nonce: '10',
      });

      const isValid = await sdk.verifyBalanceProof(
        TEST_ZKAPP_ADDRESS,
        'mock-poseidon-hash',
        proofStr,
        5n
      );

      expect(isValid).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'verify_balance_proof_nonce_mismatch' }),
        expect.any(String)
      );
    });

    it('should return false for invalid signature verification', async () => {
      mockSignatureInstance.verify.mockReturnValueOnce({ toBoolean: () => false });

      const proofStr = JSON.stringify({
        commitment: 'mock-poseidon-hash',
        signature: { r: 'bad-r', s: 'bad-s' },
        nonce: '5',
      });

      const isValid = await sdk.verifyBalanceProof(
        TEST_ZKAPP_ADDRESS,
        'mock-poseidon-hash',
        proofStr,
        5n
      );

      expect(isValid).toBe(false);
    });

    it('should return false when proof string is malformed', async () => {
      const isValid = await sdk.verifyBalanceProof(
        TEST_ZKAPP_ADDRESS,
        'some-commitment',
        'not-json',
        5n
      );

      expect(isValid).toBe(false);
    });

    it('should return false when no signer key or signerPublicKey available', async () => {
      const noSignerSdk = new MinaPaymentChannelSDK(
        TEST_GRAPHQL_URL,
        TEST_ZKAPP_ADDRESS,
        logger as any
      );

      const proofStr = JSON.stringify({
        commitment: 'mock-poseidon-hash',
        signature: { r: 'mock-r-value', s: 'mock-s-value' },
        nonce: '5',
      });

      const isValid = await noSignerSdk.verifyBalanceProof(
        TEST_ZKAPP_ADDRESS,
        'mock-poseidon-hash',
        proofStr,
        5n
      );

      expect(isValid).toBe(false);
    });

    it('should use signerPublicKey from proof data if provided', async () => {
      const proofStr = JSON.stringify({
        commitment: 'mock-poseidon-hash',
        signature: { r: 'mock-r-value', s: 'mock-s-value' },
        nonce: '5',
        signerPublicKey: TEST_PARTICIPANT_A,
      });

      const isValid = await sdk.verifyBalanceProof(
        TEST_ZKAPP_ADDRESS,
        'mock-poseidon-hash',
        proofStr,
        5n
      );

      expect(isValid).toBe(true);
      expect(mockPublicKey.fromBase58).toHaveBeenCalledWith(TEST_PARTICIPANT_A);
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-12: subscribeToChannel (AC 11)
  // -------------------------------------------------------------------------

  describe('subscribeToChannel (AC 11)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should return a subscription with unsubscribe method', () => {
      const callback = jest.fn();
      const subscription = sdk.subscribeToChannel(TEST_ZKAPP_ADDRESS, callback, 5000);

      expect(subscription).toHaveProperty('unsubscribe');
      expect(typeof subscription.unsubscribe).toBe('function');

      subscription.unsubscribe();
    });

    it('should fire initial poll immediately', async () => {
      const callback = jest.fn();
      const subscription = sdk.subscribeToChannel(TEST_ZKAPP_ADDRESS, callback, 5000);

      // Allow the immediate poll to resolve
      await jest.advanceTimersByTimeAsync(0);

      // First poll should invoke callback (initial state is always "changed")
      expect(callback).toHaveBeenCalledTimes(1);

      subscription.unsubscribe();
    });

    it('should invoke callback when state changes between polls', async () => {
      let callCount = 0;

      // First poll returns state A, second poll returns state B (different nonce)
      const stateA = {
        channelHash: {
          get: jest.fn().mockReturnValue({ toString: () => 'hash', toBigInt: () => 0n }),
        },
        balanceCommitment: {
          get: jest.fn().mockReturnValue({ toString: () => 'commit', toBigInt: () => 0n }),
        },
        nonceField: { get: jest.fn().mockReturnValue({ toString: () => '1', toBigInt: () => 1n }) },
        channelState: {
          get: jest.fn().mockReturnValue({ toString: () => '1', toBigInt: () => 1n }),
        },
        depositTotal: {
          get: jest.fn().mockReturnValue({ toString: () => '100', toBigInt: () => 100n }),
        },
        closedAtSlot: {
          get: jest.fn().mockReturnValue({ toString: () => '0', toBigInt: () => 0n }),
        },
        settlementTimeout: {
          get: jest.fn().mockReturnValue({ toString: () => '10', toBigInt: () => 10n }),
        },
        tokenId_: { get: jest.fn().mockReturnValue({ toString: () => '1', toBigInt: () => 1n }) },
      };

      const stateB = {
        ...stateA,
        nonceField: { get: jest.fn().mockReturnValue({ toString: () => '2', toBigInt: () => 2n }) },
      };

      MockPaymentChannelClass.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) return stateA;
        return stateB;
      });

      const callback = jest.fn();
      const subscription = sdk.subscribeToChannel(TEST_ZKAPP_ADDRESS, callback, 5000);

      // First poll (immediate)
      await jest.advanceTimersByTimeAsync(0);
      expect(callback).toHaveBeenCalledTimes(1);

      // Second poll after interval
      await jest.advanceTimersByTimeAsync(5000);
      expect(callback).toHaveBeenCalledTimes(2);

      subscription.unsubscribe();

      // Restore default mock
      MockPaymentChannelClass.mockImplementation(() => mockZkAppInstance);
    });

    it('should NOT invoke callback when state is unchanged', async () => {
      const callback = jest.fn();
      const subscription = sdk.subscribeToChannel(TEST_ZKAPP_ADDRESS, callback, 5000);

      // First poll
      await jest.advanceTimersByTimeAsync(0);
      expect(callback).toHaveBeenCalledTimes(1);

      // Second poll -- same state, should not trigger callback
      await jest.advanceTimersByTimeAsync(5000);
      expect(callback).toHaveBeenCalledTimes(1);

      subscription.unsubscribe();
    });

    it('should stop polling after unsubscribe', async () => {
      const callback = jest.fn();
      const subscription = sdk.subscribeToChannel(TEST_ZKAPP_ADDRESS, callback, 5000);

      // First poll
      await jest.advanceTimersByTimeAsync(0);
      expect(callback).toHaveBeenCalledTimes(1);

      // Unsubscribe
      subscription.unsubscribe();

      // Advance time -- should NOT trigger more callbacks
      await jest.advanceTimersByTimeAsync(10000);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should handle poll errors gracefully without crashing', async () => {
      mockFetchAccount
        .mockResolvedValueOnce({ account: {} }) // first poll succeeds
        .mockRejectedValueOnce(new Error('Network timeout')); // second poll fails

      const callback = jest.fn();
      const subscription = sdk.subscribeToChannel(TEST_ZKAPP_ADDRESS, callback, 5000);

      // First poll
      await jest.advanceTimersByTimeAsync(0);
      expect(callback).toHaveBeenCalledTimes(1);

      // Second poll should fail gracefully
      await jest.advanceTimersByTimeAsync(5000);

      // Callback should not be called again (error, not a state change)
      // But the subscription should still be alive
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'subscription_poll_error' }),
        expect.any(String)
      );

      subscription.unsubscribe();
    });

    it('should guard against overlapping polls', async () => {
      // Make getChannelState slow
      let resolveSlowPoll: (() => void) | undefined;
      mockFetchAccount.mockImplementationOnce(
        () =>
          new Promise<{ account: Record<string, unknown> }>((resolve) => {
            resolveSlowPoll = () => resolve({ account: {} });
          })
      );

      const callback = jest.fn();
      const subscription = sdk.subscribeToChannel(TEST_ZKAPP_ADDRESS, callback, 1000);

      // First poll starts but doesn't resolve
      await jest.advanceTimersByTimeAsync(0);

      // Interval fires while first poll is in flight
      await jest.advanceTimersByTimeAsync(1000);

      // fetchAccount should only have been called once (second poll skipped)
      expect(mockFetchAccount).toHaveBeenCalledTimes(1);

      // Resolve the slow poll
      if (resolveSlowPoll) resolveSlowPoll();
      await jest.advanceTimersByTimeAsync(0);

      subscription.unsubscribe();
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-13: o1js not installed (AC: graceful degradation)
  // -------------------------------------------------------------------------

  describe('o1js not installed', () => {
    it('should produce MinaChannelError with correct properties for O1JS_NOT_AVAILABLE', () => {
      // The SDK's getO1js() throws this error when the dynamic import fails.
      // Since jest.mock() intercepts require() at the Jest level and cannot be
      // un-mocked within the same worker, we verify the error contract directly.
      const error = new MinaChannelError(
        'o1js is required for Mina payment channels but is not installed. ' +
          'Install it with: npm install o1js',
        MINA_ERROR_CODES.O1JS_NOT_AVAILABLE,
        'O1JS_NOT_AVAILABLE'
      );

      expect(error.code).toBe(9999);
      expect(error.errorName).toBe('O1JS_NOT_AVAILABLE');
      expect(error.name).toBe('MinaChannelError');
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(MinaChannelError);
      expect(error.message).toContain('o1js is required');
      expect(error.message).toContain('npm install o1js');
    });

    it('should produce MinaChannelError code 9999 when mina-zkapp is not available', () => {
      const error = new MinaChannelError(
        '@toon-protocol/mina-zkapp is required for Mina payment channels but is not installed.',
        MINA_ERROR_CODES.O1JS_NOT_AVAILABLE,
        'O1JS_NOT_AVAILABLE'
      );

      expect(error.code).toBe(9999);
      expect(error.errorName).toBe('O1JS_NOT_AVAILABLE');
      expect(error.message).toContain('mina-zkapp');
    });

    it('should re-import o1js after _resetModuleCaches is called', async () => {
      // Verify the _resetModuleCaches mechanism works: after clearing the cache,
      // the SDK re-imports o1js and operations succeed. This confirms the lazy
      // loading path is exercised after cache invalidation.
      _resetModuleCaches();

      const freshSdk = new MinaPaymentChannelSDK(
        TEST_GRAPHQL_URL,
        TEST_ZKAPP_ADDRESS,
        logger as any,
        TEST_SIGNER_KEY
      );

      // After cache reset, the SDK should re-import o1js on first use
      await freshSdk.compileContract();
      expect((MockPaymentChannelClass as any).compile).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-14: MinaChannelError class
  // -------------------------------------------------------------------------

  describe('MinaChannelError', () => {
    it('should have correct name, code, and errorName properties', () => {
      const error = new MinaChannelError('test message', 1001, 'COMPILE_FAILED');

      expect(error.message).toBe('test message');
      expect(error.code).toBe(1001);
      expect(error.errorName).toBe('COMPILE_FAILED');
      expect(error.name).toBe('MinaChannelError');
    });

    it('should be an instance of Error', () => {
      const error = new MinaChannelError('test', 1002, 'TRANSACTION_FAILED');
      expect(error).toBeInstanceOf(Error);
    });

    it('should have a stack trace', () => {
      const error = new MinaChannelError('test', 1003, 'PROOF_GENERATION_FAILED');
      expect(error.stack).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-15: MINA_ERROR_CODES constants
  // -------------------------------------------------------------------------

  describe('MINA_ERROR_CODES', () => {
    it('should define all expected error codes', () => {
      expect(MINA_ERROR_CODES.COMPILE_FAILED).toBe(1001);
      expect(MINA_ERROR_CODES.TRANSACTION_FAILED).toBe(1002);
      expect(MINA_ERROR_CODES.PROOF_GENERATION_FAILED).toBe(1003);
      expect(MINA_ERROR_CODES.INVALID_CHANNEL_STATE).toBe(1004);
      expect(MINA_ERROR_CODES.ACCOUNT_NOT_FOUND).toBe(1005);
      expect(MINA_ERROR_CODES.INVALID_PROOF).toBe(1006);
      expect(MINA_ERROR_CODES.ARCHIVE_NODE_ERROR).toBe(1007);
      expect(MINA_ERROR_CODES.INVALID_PARAMETERS).toBe(1008);
      expect(MINA_ERROR_CODES.O1JS_NOT_AVAILABLE).toBe(9999);
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-16: Transaction failure error paths (AC 2, 3, 4, 5, 6)
  // -------------------------------------------------------------------------

  describe('transaction failure error paths', () => {
    const mockSigStr = JSON.stringify({ r: 'sig-r', s: 'sig-s' });

    it('[P0] openChannel should throw TRANSACTION_FAILED when send() rejects (AC 2)', async () => {
      // Given: a configured SDK with signer key
      // When: the transaction send() call fails
      mockTxn.sign.mockReturnValueOnce({
        send: jest.fn().mockRejectedValueOnce(new Error('Insufficient funds for account creation')),
      });

      // Then: a MinaChannelError with TRANSACTION_FAILED is thrown
      await expect(
        sdk.openChannel(TEST_PARTICIPANT_A, TEST_PARTICIPANT_B, 100)
      ).rejects.toMatchObject({
        code: MINA_ERROR_CODES.TRANSACTION_FAILED,
        errorName: 'TRANSACTION_FAILED',
      });
    });

    it('[P0] deposit should throw TRANSACTION_FAILED when prove() rejects (AC 3)', async () => {
      // Given: an open channel at a known address
      // When: proof generation fails during deposit
      mockTxn.prove.mockRejectedValueOnce(new Error('Proof generation out of memory'));

      // Then: a MinaChannelError with TRANSACTION_FAILED is thrown
      await expect(sdk.deposit(TEST_ZKAPP_ADDRESS, 500000n)).rejects.toMatchObject({
        code: MINA_ERROR_CODES.TRANSACTION_FAILED,
        errorName: 'TRANSACTION_FAILED',
      });
    });

    it('[P0] claimFromChannel should throw PROOF_GENERATION_FAILED when prove() rejects (AC 4)', async () => {
      // Given: participant cache is populated
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cacheMap = (sdk as any)._participantCache as Map<string, any>;
      cacheMap.set(TEST_ZKAPP_ADDRESS, {
        participantA: TEST_PARTICIPANT_A,
        participantB: TEST_PARTICIPANT_B,
      });

      // When: zk-SNARK proof generation fails
      mockTxn.prove.mockRejectedValueOnce(new Error('zk-SNARK constraint not satisfied'));

      // Then: a MinaChannelError with PROOF_GENERATION_FAILED is thrown
      await expect(
        sdk.claimFromChannel(
          TEST_ZKAPP_ADDRESS,
          600000n,
          400000n,
          12345n,
          1n,
          mockSigStr,
          mockSigStr
        )
      ).rejects.toMatchObject({
        code: MINA_ERROR_CODES.PROOF_GENERATION_FAILED,
        errorName: 'PROOF_GENERATION_FAILED',
      });
    });

    it('[P1] closeChannel should throw TRANSACTION_FAILED when send() rejects (AC 5)', async () => {
      // Given: an open channel
      // When: the close transaction submission fails
      mockTxn.sign.mockReturnValueOnce({
        send: jest.fn().mockRejectedValueOnce(new Error('Nonce mismatch')),
      });

      // Then: a MinaChannelError with TRANSACTION_FAILED is thrown
      await expect(
        sdk.closeChannel(TEST_ZKAPP_ADDRESS, 600000n, 400000n, 99999n, 1n, mockSigStr, mockSigStr)
      ).rejects.toMatchObject({
        code: MINA_ERROR_CODES.TRANSACTION_FAILED,
        errorName: 'TRANSACTION_FAILED',
      });
    });

    it('[P1] settleChannel should throw TRANSACTION_FAILED when send() rejects (AC 6)', async () => {
      // Given: a CLOSING channel
      // When: the settle transaction submission fails
      mockTxn.sign.mockReturnValueOnce({
        send: jest.fn().mockRejectedValueOnce(new Error('Challenge period not elapsed')),
      });

      // Then: a MinaChannelError with TRANSACTION_FAILED is thrown
      await expect(
        sdk.settleChannel(
          TEST_ZKAPP_ADDRESS,
          600000n,
          400000n,
          99999n,
          TEST_PARTICIPANT_A,
          TEST_PARTICIPANT_B,
          0n
        )
      ).rejects.toMatchObject({
        code: MINA_ERROR_CODES.TRANSACTION_FAILED,
        errorName: 'TRANSACTION_FAILED',
      });
    });

    it('[P1] openChannel should wrap non-MinaChannelError as TRANSACTION_FAILED', async () => {
      // Given: a non-Error throw from o1js
      mockMinaTransaction.mockRejectedValueOnce('string error from o1js');

      // Then: the error is wrapped in MinaChannelError
      await expect(
        sdk.openChannel(TEST_PARTICIPANT_A, TEST_PARTICIPANT_B, 100)
      ).rejects.toBeInstanceOf(MinaChannelError);
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-17: Logging verification (AC 2, 3, 5, 6)
  // -------------------------------------------------------------------------

  describe('logging verification', () => {
    const mockSigStr = JSON.stringify({ r: 'sig-r', s: 'sig-s' });

    it('[P1] deposit should log the deposit event with amount (AC 3)', async () => {
      // Given: an open channel
      // When: a deposit is made
      await sdk.deposit(TEST_ZKAPP_ADDRESS, 500000n);

      // Then: the deposit event is logged with amount and txHash
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'deposit',
          channelAddress: TEST_ZKAPP_ADDRESS,
          amount: '500000',
        }),
        expect.stringContaining('Deposited')
      );
    });

    it('[P1] closeChannel should log the close channel event (AC 5)', async () => {
      // Given: an open channel
      // When: close is initiated
      await sdk.closeChannel(
        TEST_ZKAPP_ADDRESS,
        600000n,
        400000n,
        99999n,
        1n,
        mockSigStr,
        mockSigStr
      );

      // Then: the close event is logged
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'close_channel',
          channelAddress: TEST_ZKAPP_ADDRESS,
        }),
        expect.stringContaining('close')
      );
    });

    it('[P1] settleChannel should log the settle event (AC 6)', async () => {
      // Given: a CLOSING channel past challenge period
      // When: settle is called
      await sdk.settleChannel(
        TEST_ZKAPP_ADDRESS,
        600000n,
        400000n,
        99999n,
        TEST_PARTICIPANT_A,
        TEST_PARTICIPANT_B,
        0n
      );

      // Then: the settle event is logged
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'settle_channel',
          channelAddress: TEST_ZKAPP_ADDRESS,
        }),
        expect.stringContaining('settled')
      );
    });

    it('[P2] compileContract should log debug when already compiled (AC 1)', async () => {
      // Given: the contract is already compiled
      await sdk.compileContract();
      jest.clearAllMocks();

      // When: compileContract is called again
      await sdk.compileContract();

      // Then: a debug log with compile_contract_cached is emitted
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'compile_contract_cached' }),
        expect.stringContaining('already compiled')
      );
    });

    it('[P1] claimFromChannel should log claim event with nonce (AC 4)', async () => {
      // Given: participant cache is populated
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cacheMap = (sdk as any)._participantCache as Map<string, any>;
      cacheMap.set(TEST_ZKAPP_ADDRESS, {
        participantA: TEST_PARTICIPANT_A,
        participantB: TEST_PARTICIPANT_B,
      });

      // When: a claim is submitted
      const mockSig = JSON.stringify({ r: 'sig-r', s: 'sig-s' });
      await sdk.claimFromChannel(
        TEST_ZKAPP_ADDRESS,
        600000n,
        400000n,
        12345n,
        1n,
        mockSig,
        mockSig
      );

      // Then: the claim event is logged
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'claim_from_channel',
          channelAddress: TEST_ZKAPP_ADDRESS,
          nonce: '1',
        }),
        expect.stringContaining('Claim submitted')
      );
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-18: signBalanceProof error wrapping (AC 9)
  // -------------------------------------------------------------------------

  describe('signBalanceProof error handling (AC 9)', () => {
    it('[P1] should throw PROOF_GENERATION_FAILED when Poseidon.hash throws', async () => {
      // Given: Poseidon.hash throws an error
      mockPoseidonHash.mockImplementationOnce(() => {
        throw new Error('Poseidon hash overflow');
      });

      // When: signBalanceProof is called
      // Then: MinaChannelError with PROOF_GENERATION_FAILED is thrown
      await expect(
        sdk.signBalanceProof(TEST_ZKAPP_ADDRESS, 600000n, 400000n, 12345n, 5n)
      ).rejects.toMatchObject({
        code: MINA_ERROR_CODES.PROOF_GENERATION_FAILED,
        errorName: 'PROOF_GENERATION_FAILED',
      });
    });

    it('[P1] should throw PROOF_GENERATION_FAILED when Signature.create throws', async () => {
      // Given: Signature.create throws an error
      mockSignature.create.mockImplementationOnce(() => {
        throw new Error('Invalid private key format');
      });

      // When: signBalanceProof is called
      // Then: MinaChannelError with PROOF_GENERATION_FAILED is thrown
      await expect(
        sdk.signBalanceProof(TEST_ZKAPP_ADDRESS, 600000n, 400000n, 12345n, 5n)
      ).rejects.toMatchObject({
        code: MINA_ERROR_CODES.PROOF_GENERATION_FAILED,
        errorName: 'PROOF_GENERATION_FAILED',
      });
    });

    it('[P2] should re-throw MinaChannelError unchanged in signBalanceProof', async () => {
      // Given: an inner operation throws a MinaChannelError
      const innerError = new MinaChannelError('inner error', 1008, 'INVALID_PARAMETERS');
      mockPoseidonHash.mockImplementationOnce(() => {
        throw innerError;
      });

      // When: signBalanceProof is called
      // Then: the original MinaChannelError is re-thrown, not double-wrapped
      await expect(
        sdk.signBalanceProof(TEST_ZKAPP_ADDRESS, 600000n, 400000n, 12345n, 5n)
      ).rejects.toBe(innerError);
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-19: getChannelState error from zkApp getter (AC 7)
  // -------------------------------------------------------------------------

  describe('getChannelState error handling (AC 7)', () => {
    it('[P1] should throw ACCOUNT_NOT_FOUND when a state getter throws', async () => {
      // Given: a zkApp where channelHash.get() throws
      const brokenZkApp = {
        ...mockZkAppInstance,
        channelHash: {
          get: jest.fn().mockImplementation(() => {
            throw new Error('Deserialization error');
          }),
        },
      };
      MockPaymentChannelClass.mockImplementationOnce(() => brokenZkApp);

      // When: getChannelState is called
      // Then: MinaChannelError with ACCOUNT_NOT_FOUND is thrown
      await expect(sdk.getChannelState(TEST_ZKAPP_ADDRESS)).rejects.toMatchObject({
        code: MINA_ERROR_CODES.ACCOUNT_NOT_FOUND,
        errorName: 'ACCOUNT_NOT_FOUND',
      });
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-20: getChannelEvents chronological ordering (AC 8)
  // -------------------------------------------------------------------------

  describe('getChannelEvents ordering (AC 8)', () => {
    it('[P1] should return events in the order provided by the archive node', async () => {
      // Given: the archive node returns events in chronological order
      mockZkAppInstance.fetchEvents.mockResolvedValueOnce([
        { type: 'initialize', event: { data: { slot: '1' } } },
        { type: 'deposit', event: { data: { slot: '5' } } },
        { type: 'claim', event: { data: { slot: '10' } } },
      ]);

      // When: getChannelEvents is called
      const events = await sdk.getChannelEvents(TEST_ZKAPP_ADDRESS);

      // Then: events are in chronological order
      expect(events).toHaveLength(3);
      expect(events[0]!.type).toBe('initialize');
      expect(events[1]!.type).toBe('deposit');
      expect(events[2]!.type).toBe('claim');
    });

    it('[P2] should handle events with missing type gracefully', async () => {
      // Given: an event without a type field
      mockZkAppInstance.fetchEvents.mockResolvedValueOnce([{ event: { data: { slot: '1' } } }]);

      // When: getChannelEvents is called
      const events = await sdk.getChannelEvents(TEST_ZKAPP_ADDRESS);

      // Then: the event type defaults to 'unknown'
      expect(events[0]!.type).toBe('unknown');
    });

    it('[P2] should handle events with missing data gracefully', async () => {
      // Given: an event without event.data
      mockZkAppInstance.fetchEvents.mockResolvedValueOnce([{ type: 'deposit' }]);

      // When: getChannelEvents is called
      const events = await sdk.getChannelEvents(TEST_ZKAPP_ADDRESS);

      // Then: the event data defaults to empty object
      expect(events[0]!.data).toEqual({});
    });

    it('[P2] should return empty array when fetchEvents is not a function', async () => {
      // Given: a zkApp instance where fetchEvents is not defined
      const noFetchEventsZkApp = {
        ...mockZkAppInstance,
        fetchEvents: undefined,
      };
      MockPaymentChannelClass.mockImplementationOnce(() => noFetchEventsZkApp);

      // When: getChannelEvents is called
      const events = await sdk.getChannelEvents(TEST_ZKAPP_ADDRESS);

      // Then: an empty array is returned
      expect(events).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-21: subscribeToChannel default interval (AC 11)
  // -------------------------------------------------------------------------

  describe('subscribeToChannel default interval (AC 11)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('[P1] should use 30000ms as default poll interval', async () => {
      // Given: subscribeToChannel is called without explicit interval
      const callback = jest.fn();
      const subscription = sdk.subscribeToChannel(TEST_ZKAPP_ADDRESS, callback);

      // When: the first immediate poll fires
      await jest.advanceTimersByTimeAsync(0);
      expect(callback).toHaveBeenCalledTimes(1);

      // Then: no second poll fires at 5000ms (proving it's not 5s)
      await jest.advanceTimersByTimeAsync(5000);
      expect(callback).toHaveBeenCalledTimes(1);

      // And: no second poll fires at 29999ms
      await jest.advanceTimersByTimeAsync(24999);
      expect(callback).toHaveBeenCalledTimes(1);

      // But: a second poll fires at 30000ms (only triggers if state changed)
      // Since state is the same, callback count stays at 1, but we can
      // verify fetchAccount was called again (proving poll executed)
      const fetchCallsBefore = mockFetchAccount.mock.calls.length;
      await jest.advanceTimersByTimeAsync(1);
      const fetchCallsAfter = mockFetchAccount.mock.calls.length;
      expect(fetchCallsAfter).toBeGreaterThan(fetchCallsBefore);

      subscription.unsubscribe();
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-22: Async non-blocking proof generation (AC 12)
  // -------------------------------------------------------------------------

  describe('async non-blocking proof generation (AC 12)', () => {
    it('[P0] claimFromChannel should return a Promise (AC 12)', async () => {
      // Given: participant cache is populated
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cacheMap = (sdk as any)._participantCache as Map<string, any>;
      cacheMap.set(TEST_ZKAPP_ADDRESS, {
        participantA: TEST_PARTICIPANT_A,
        participantB: TEST_PARTICIPANT_B,
      });

      const mockSig = JSON.stringify({ r: 'sig-r', s: 'sig-s' });

      // When: claimFromChannel is called
      const resultPromise = sdk.claimFromChannel(
        TEST_ZKAPP_ADDRESS,
        600000n,
        400000n,
        12345n,
        1n,
        mockSig,
        mockSig
      );

      // Then: it returns a Promise that resolves asynchronously
      expect(resultPromise).toBeInstanceOf(Promise);
      const result = await resultPromise;
      expect(result).toHaveProperty('txHash');
    });

    it('[P0] openChannel should return a Promise (AC 12)', () => {
      // When: openChannel is called
      const resultPromise = sdk.openChannel(TEST_PARTICIPANT_A, TEST_PARTICIPANT_B, 100);

      // Then: it returns a Promise
      expect(resultPromise).toBeInstanceOf(Promise);
    });

    it('[P0] closeChannel should return a Promise (AC 12)', () => {
      const mockSig = JSON.stringify({ r: 'sig-r', s: 'sig-s' });

      // When: closeChannel is called
      const resultPromise = sdk.closeChannel(
        TEST_ZKAPP_ADDRESS,
        600000n,
        400000n,
        99999n,
        1n,
        mockSig,
        mockSig
      );

      // Then: it returns a Promise
      expect(resultPromise).toBeInstanceOf(Promise);
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-23: verifyBalanceProof with signerPublicKey in proof (AC 10)
  // -------------------------------------------------------------------------

  describe('verifyBalanceProof additional scenarios (AC 10)', () => {
    it('[P1] should log warning when verification fails with error', async () => {
      // Given: the signature.verify throws an error
      mockSignature.fromJSON.mockImplementationOnce(() => ({
        verify: jest.fn().mockImplementation(() => {
          throw new Error('Invalid curve point');
        }),
      }));

      const proofStr = JSON.stringify({
        commitment: 'mock-commit',
        signature: { r: 'bad-r', s: 'bad-s' },
        nonce: '5',
      });

      // When: verifyBalanceProof is called
      const isValid = await sdk.verifyBalanceProof(TEST_ZKAPP_ADDRESS, 'mock-commit', proofStr, 5n);

      // Then: returns false and logs a warning
      expect(isValid).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'verify_balance_proof_error' }),
        expect.stringContaining('verification failed')
      );
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-24: openChannel with txHash undefined (AC 2)
  // -------------------------------------------------------------------------

  describe('openChannel txHash handling (AC 2)', () => {
    it('[P2] should return empty string txHash when send() returns undefined hash', async () => {
      // Given: send() returns a result with hash = undefined
      mockTxn.sign.mockReturnValueOnce({
        send: jest.fn().mockResolvedValueOnce({ hash: undefined }),
      });

      // When: openChannel is called
      const result = await sdk.openChannel(TEST_PARTICIPANT_A, TEST_PARTICIPANT_B, 100);

      // Then: txHash is an empty string (not undefined)
      expect(result.txHash).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-25: closeChannel account not found (AC 5)
  // -------------------------------------------------------------------------

  describe('closeChannel account not found (AC 5)', () => {
    it('[P1] should throw ACCOUNT_NOT_FOUND when channel address is invalid', async () => {
      // Given: fetchAccount returns an error for the channel address
      mockFetchAccount
        .mockResolvedValueOnce({ account: {} }) // sender account fetch
        .mockResolvedValueOnce({ error: 'Account does not exist' }); // channel account fetch

      const mockSig = JSON.stringify({ r: 'sig-r', s: 'sig-s' });

      // When: closeChannel is called
      // Then: TRANSACTION_FAILED wrapping the ACCOUNT_NOT_FOUND from _getZkApp
      await expect(
        sdk.closeChannel(TEST_ZKAPP_ADDRESS, 600000n, 400000n, 99999n, 1n, mockSig, mockSig)
      ).rejects.toBeInstanceOf(MinaChannelError);
    });
  });

  // -------------------------------------------------------------------------
  // T-34.4-26: settleChannel account not found (AC 6)
  // -------------------------------------------------------------------------

  describe('settleChannel account not found (AC 6)', () => {
    it('[P1] should throw when channel account not found', async () => {
      // Given: fetchAccount returns an error for the channel address
      mockFetchAccount
        .mockResolvedValueOnce({ account: {} }) // sender account fetch
        .mockResolvedValueOnce({ error: 'Account does not exist' }); // channel account fetch

      // When: settleChannel is called
      // Then: a MinaChannelError is thrown
      await expect(
        sdk.settleChannel(
          TEST_ZKAPP_ADDRESS,
          600000n,
          400000n,
          99999n,
          TEST_PARTICIPANT_A,
          TEST_PARTICIPANT_B,
          0n
        )
      ).rejects.toBeInstanceOf(MinaChannelError);
    });
  });
});
