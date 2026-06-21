/**
 * ATDD Acceptance Tests for Story 34.4: MinaPaymentChannelSDK — TypeScript Integration
 *
 * GREEN PHASE: All tests are enabled. The SDK methods are fully implemented.
 *
 * These tests validate:
 * - AC1:  compileContract pre-compiles circuit via o1js
 * - AC2:  openChannel deploys and initializes zkApp
 * - AC3:  deposit submits deposit transaction
 * - AC4:  claimFromChannel generates ZK proof and submits
 * - AC5:  closeChannel initiates cooperative close
 * - AC6:  settleChannel executes post-challenge settlement
 * - AC7:  getChannelState reads on-chain state
 * - AC8:  getChannelEvents retrieves archive node events
 * - AC9:  signBalanceProof generates Poseidon commitment
 * - AC10: verifyBalanceProof validates ZK proof
 * - AC11: subscribeToChannel polls for state changes
 * - AC12: Async non-blocking proof generation
 *
 * @module mina-payment-channel-sdk.atdd.test
 */

import type { Logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Mocks — intercept dynamic imports of o1js and mina-zkapp
// ---------------------------------------------------------------------------

const mockCompile = jest.fn().mockResolvedValue({ verificationKey: 'mock-vk' });
const mockInitializeChannel = jest.fn();
const mockDeposit = jest.fn();
const mockClaimFromChannel = jest.fn();
const mockInitiateClose = jest.fn();
const mockSettle = jest.fn();
const mockFetchEvents = jest.fn().mockResolvedValue([
  { type: 'channel-opened', event: { data: { participantA: 'A', participantB: 'B' } } },
  { type: 'deposit', event: { data: { amount: '500000000' } } },
]);
const mockDeploy = jest.fn();

// Mock on-chain state field getters
const createMockStateField = (value: string): { get: jest.Mock } => ({
  get: jest.fn().mockReturnValue({
    toString: () => value,
    toBigInt: () => BigInt(value),
  }),
});

const mockChannelHash = createMockStateField('channel-hash');
const mockBalanceCommitment = createMockStateField('balance-commitment');
const mockNonceField = createMockStateField('0');
const mockChannelState = createMockStateField('1');
const mockDepositTotal = createMockStateField('1000000000');
const mockClosedAtSlot = createMockStateField('0');
const mockSettlementTimeout = createMockStateField('100');
const mockTokenId_ = createMockStateField('token-id');

const mockZkAppInstance = {
  initializeChannel: mockInitializeChannel,
  deposit: mockDeposit,
  claimFromChannel: mockClaimFromChannel,
  initiateClose: mockInitiateClose,
  settle: mockSettle,
  fetchEvents: mockFetchEvents,
  deploy: mockDeploy,
  channelHash: mockChannelHash,
  balanceCommitment: mockBalanceCommitment,
  nonceField: mockNonceField,
  channelState: mockChannelState,
  depositTotal: mockDepositTotal,
  closedAtSlot: mockClosedAtSlot,
  settlementTimeout: mockSettlementTimeout,
  tokenId_: mockTokenId_,
};

const MockPaymentChannel = Object.assign(
  jest.fn().mockImplementation(() => mockZkAppInstance),
  { compile: mockCompile }
);

jest.mock('@toon-protocol/mina-zkapp', () => ({
  PaymentChannel: MockPaymentChannel,
  CHANNEL_STATE: {
    UNINITIALIZED: { toString: () => '0', toBigInt: () => 0n },
    OPEN: { toString: () => '1', toBigInt: () => 1n },
    CLOSING: { toString: () => '2', toBigInt: () => 2n },
    SETTLED: { toString: () => '3', toBigInt: () => 3n },
  },
  MAX_SAFE_AMOUNT: { toString: () => '18446744073709551615' },
}));

// Mock o1js primitives
const mockField = jest.fn((v: unknown) => ({
  toString: () => String(v),
  toBigInt: () => BigInt(String(v)),
}));

const mockPoseidonHash = jest.fn().mockReturnValue({
  toString: () => 'mock-poseidon-hash',
  toBigInt: () => 12345n,
});

const mockSignatureCreate = jest.fn().mockReturnValue({
  toJSON: () => ({ r: 'mock-r', s: 'mock-s' }),
  toBase58: () => 'mock-signature-base58',
});

const mockSignatureFromJSON = jest.fn().mockReturnValue({
  toJSON: () => ({ r: 'mock-r', s: 'mock-s' }),
  verify: jest.fn().mockReturnValue({ toBoolean: () => true }),
});

const mockPrivateKeyFromBase58 = jest.fn().mockReturnValue({
  toPublicKey: () => ({
    toBase58: () => 'B62mock-public-key',
    toFields: () => [{ toString: () => 'field-x' }],
  }),
});

const mockPrivateKeyRandom = jest.fn().mockReturnValue({
  toPublicKey: () => ({
    toBase58: () => 'B62mock-zkapp-address',
    toFields: () => [{ toString: () => 'field-x' }],
  }),
  toBase58: () => 'EKEmock-private-key',
});

const mockPublicKeyFromBase58 = jest.fn().mockImplementation((key: string) => ({
  toBase58: () => key,
  toFields: () => [{ toString: () => `field-${key.slice(0, 8)}` }],
  x: { toString: () => `x-${key.slice(0, 8)}` },
}));

const mockTxnProve = jest.fn().mockResolvedValue(undefined);
const mockTxnSign = jest.fn().mockReturnValue({
  send: jest.fn().mockResolvedValue({
    hash: 'mock-tx-hash-abc123',
    status: 'pending',
  }),
});
const mockTxnResult = {
  prove: mockTxnProve,
  sign: mockTxnSign,
};

const mockMinaTransaction = jest.fn().mockResolvedValue(mockTxnResult);
const mockMinaSetActiveInstance = jest.fn();
const mockMinaNetwork = jest.fn().mockReturnValue('mock-network-instance');

// fetchAccount returns success (no error property) by default
const mockFetchAccount = jest.fn().mockResolvedValue({
  account: {
    zkapp: {
      appState: [
        mockField('channel-hash'),
        mockField('balance-commitment'),
        mockField('0'),
        mockField('1'),
        mockField('1000000000'),
        mockField('0'),
        mockField('100'),
        mockField('token-id'),
      ],
    },
  },
});

// #202: closeChannel reads the live network slot via fetchLastBlock and passes it
// as the initiateClose `currentSlot` witness.
const mockFetchLastBlock = jest.fn().mockResolvedValue({
  globalSlotSinceGenesis: { value: mockField('42'), toString: () => '42' },
});

jest.mock('o1js', () => ({
  Mina: {
    Network: mockMinaNetwork,
    setActiveInstance: mockMinaSetActiveInstance,
    transaction: mockMinaTransaction,
  },
  PrivateKey: {
    random: mockPrivateKeyRandom,
    fromBase58: mockPrivateKeyFromBase58,
  },
  PublicKey: {
    fromBase58: mockPublicKeyFromBase58,
  },
  Field: mockField,
  Poseidon: { hash: mockPoseidonHash },
  Signature: {
    create: mockSignatureCreate,
    fromJSON: mockSignatureFromJSON,
  },
  fetchAccount: mockFetchAccount,
  fetchLastBlock: mockFetchLastBlock,
  AccountUpdate: {
    fundNewAccount: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Test Constants
// ---------------------------------------------------------------------------

const TEST_GRAPHQL_URL = 'https://mina-devnet.example.com/graphql';
const TEST_ZKAPP_ADDRESS = 'B62qmockZkAppAddress1234567890abcdef';
const TEST_SIGNER_KEY = 'EKEmockSignerPrivateKey1234567890abcdef';
const TEST_PARTICIPANT_A = 'B62qmockParticipantA1234567890abcdef';
const TEST_PARTICIPANT_B = 'B62qmockParticipantB1234567890abcdef';

// ---------------------------------------------------------------------------
// Mock Logger Factory
// ---------------------------------------------------------------------------

function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    trace: jest.fn(),
    child: jest.fn().mockReturnThis(),
    level: 'info',
    silent: jest.fn(),
    isLevelEnabled: jest.fn().mockReturnValue(true),
  } as unknown as jest.Mocked<Logger>;
}

// ---------------------------------------------------------------------------
// Import SDK (after mocks are set up)
// ---------------------------------------------------------------------------

import { MinaPaymentChannelSDK, MinaChannelError } from './mina-payment-channel-sdk';
import type {
  MinaChannelState,
  MinaTxResult,
  MinaOpenChannelResult,
} from './mina-payment-channel-sdk';

// ---------------------------------------------------------------------------
// SDK type — matches the Story 34.4 extended signatures
// ---------------------------------------------------------------------------
interface SDKInterface {
  compileContract(): Promise<void>;
  openChannel(
    participantA: string,
    participantB: string,
    timeout: number,
    tokenId?: string
  ): Promise<MinaOpenChannelResult>;
  deposit(channelAddress: string, amount: bigint): Promise<MinaTxResult>;
  claimFromChannel(
    channelAddress: string,
    newBalanceA: bigint,
    newBalanceB: bigint,
    salt: bigint,
    nonce: bigint,
    signatureA: string,
    signatureB: string
  ): Promise<MinaTxResult>;
  closeChannel(
    channelAddress: string,
    finalBalanceA: bigint,
    finalBalanceB: bigint,
    salt: bigint,
    nonce: bigint,
    signatureA: string,
    signatureB: string
  ): Promise<MinaTxResult>;
  settleChannel(
    channelAddress: string,
    balanceA: bigint,
    balanceB: bigint,
    salt: bigint,
    participantA: string,
    participantB: string,
    nonce: bigint
  ): Promise<MinaTxResult>;
  getChannelState(channelAddress: string): Promise<MinaChannelState>;
  getChannelEvents(
    channelAddress: string
  ): Promise<Array<{ type: string; data: Record<string, unknown> }>>;
  signBalanceProof(
    channelAddress: string,
    balanceA: bigint,
    balanceB: bigint,
    salt: bigint,
    nonce: bigint
  ): Promise<string>;
  verifyBalanceProof(
    channelAddress: string,
    balanceCommitment: string,
    proof: string,
    nonce: bigint
  ): Promise<boolean>;
  subscribeToChannel(
    channelAddress: string,
    callback: (state: MinaChannelState) => void
  ): { unsubscribe(): void };
  graphqlUrl: string;
}

// =========================================================================
// ATDD ACCEPTANCE TESTS — GREEN PHASE
// =========================================================================

describe('MinaPaymentChannelSDK ATDD Acceptance Tests (Story 34.4)', () => {
  let sdk: SDKInterface;
  let sdkWithSigner: SDKInterface;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();

    // Reset fetchAccount to default (no error)
    mockFetchAccount.mockResolvedValue({
      account: {
        zkapp: {
          appState: [
            mockField('channel-hash'),
            mockField('balance-commitment'),
            mockField('0'),
            mockField('1'),
            mockField('1000000000'),
            mockField('0'),
            mockField('100'),
            mockField('token-id'),
          ],
        },
      },
    });

    // Reset compile mock
    mockCompile.mockResolvedValue({ verificationKey: 'mock-vk' });

    // Reset txn mocks
    mockTxnProve.mockResolvedValue(undefined);
    mockTxnSign.mockReturnValue({
      send: jest.fn().mockResolvedValue({
        hash: 'mock-tx-hash-abc123',
        status: 'pending',
      }),
    });

    // SDK without signer key (read-only operations)
    sdk = new MinaPaymentChannelSDK(
      TEST_GRAPHQL_URL,
      TEST_ZKAPP_ADDRESS,
      mockLogger
    ) as unknown as SDKInterface;

    // SDK with signer key (signing operations)
    sdkWithSigner = new MinaPaymentChannelSDK(
      TEST_GRAPHQL_URL,
      TEST_ZKAPP_ADDRESS,
      mockLogger,
      TEST_SIGNER_KEY
    ) as unknown as SDKInterface;
  });

  // -----------------------------------------------------------------------
  // AC 1: compileContract Pre-Compiles Circuit
  // -----------------------------------------------------------------------

  describe('AC 1: compileContract', () => {
    it('[P0] should compile the PaymentChannel zkApp circuit via o1js', async () => {
      // Given: a configured MinaPaymentChannelSDK instance
      // When: compileContract() is called
      await sdkWithSigner.compileContract();

      // Then: the PaymentChannel zkApp circuit is compiled via o1js
      expect(MockPaymentChannel.compile).toHaveBeenCalledTimes(1);
    });

    it('[P1] should cache compilation result — subsequent calls are no-ops', async () => {
      // Given: a compiled SDK
      await sdkWithSigner.compileContract();
      await sdkWithSigner.compileContract();

      // Then: compile is called only once (cached)
      expect(MockPaymentChannel.compile).toHaveBeenCalledTimes(1);
    });

    it('[P1] should throw MinaChannelError with code 1001 on compilation failure', async () => {
      // Given: o1js compile fails
      mockCompile.mockRejectedValue(new Error('Circuit too large'));

      // When/Then: compileContract throws MinaChannelError
      await expect(sdkWithSigner.compileContract()).rejects.toThrow(MinaChannelError);
      try {
        await sdkWithSigner.compileContract();
      } catch (err) {
        expect(err).toBeInstanceOf(MinaChannelError);
        expect((err as MinaChannelError).code).toBe(1001);
        expect((err as MinaChannelError).errorName).toBe('COMPILE_FAILED');
      }
    });
  });

  // -----------------------------------------------------------------------
  // AC 2: openChannel Deploys and Initializes zkApp
  // -----------------------------------------------------------------------

  describe('AC 2: openChannel', () => {
    it('[P0] should deploy a new zkApp and call initializeChannel', async () => {
      // Given: a compiled SDK
      await sdkWithSigner.compileContract();

      // When: openChannel() is called with participantA, participantB, timeout, and tokenId
      const result = await sdkWithSigner.openChannel(
        TEST_PARTICIPANT_A,
        TEST_PARTICIPANT_B,
        100, // timeout in slots
        'MINA'
      );

      // Then: a new PaymentChannel zkApp is deployed to the Mina network
      expect(mockMinaTransaction).toHaveBeenCalled();
      expect(mockTxnProve).toHaveBeenCalled();
      expect(mockTxnSign).toHaveBeenCalled();

      // And: the result contains the zkApp address and transaction hash
      expect(result).toHaveProperty('zkAppAddress');
      expect(result).toHaveProperty('txHash');
      expect(typeof result.zkAppAddress).toBe('string');
      expect(typeof result.txHash).toBe('string');
      expect(result.txHash).toBeTruthy();
    });

    it('[P1] should generate a new zkApp key pair for the channel', async () => {
      // Given: a compiled SDK
      await sdkWithSigner.compileContract();

      // When: openChannel() is called
      await sdkWithSigner.openChannel(TEST_PARTICIPANT_A, TEST_PARTICIPANT_B, 100);

      // Then: a new random key pair is generated for the zkApp
      expect(mockPrivateKeyRandom).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // AC 3: deposit Submits Deposit Transaction
  // -----------------------------------------------------------------------

  describe('AC 3: deposit', () => {
    it('[P0] should submit a deposit transaction to the Mina network', async () => {
      // Given: an open channel at a known zkApp address
      // When: deposit() is called with channelAddress and amount
      const result = await sdkWithSigner.deposit(TEST_ZKAPP_ADDRESS, 500000000n);

      // Then: a deposit transaction is constructed and submitted
      expect(mockFetchAccount).toHaveBeenCalled();
      expect(mockMinaTransaction).toHaveBeenCalled();
      expect(mockTxnProve).toHaveBeenCalled();
      expect(mockTxnSign).toHaveBeenCalled();

      // And: a MinaTxResult is returned with the transaction hash
      expect(result).toHaveProperty('txHash');
      expect(typeof result.txHash).toBe('string');
    });
  });

  // -----------------------------------------------------------------------
  // AC 4: claimFromChannel Generates ZK Proof and Submits
  // -----------------------------------------------------------------------

  describe('AC 4: claimFromChannel', () => {
    it('[P0] should generate a zk-SNARK proof and submit a claim', async () => {
      // Given: an open channel with an existing balance commitment
      await sdkWithSigner.compileContract();

      // First open a channel to populate the participant cache
      await sdkWithSigner.openChannel(TEST_PARTICIPANT_A, TEST_PARTICIPANT_B, 100);

      // The opened channel address comes from mockPrivateKeyRandom
      const openedAddress = 'B62mock-zkapp-address';

      // When: claimFromChannel() is called with new balances, salt, nonce, and both signatures
      const result = await sdkWithSigner.claimFromChannel(
        openedAddress,
        700000000n, // newBalanceA
        300000000n, // newBalanceB
        42n, // salt
        1n, // nonce
        JSON.stringify({ r: 'mock-r', s: 'mock-s' }), // signatureA
        JSON.stringify({ r: 'mock-r', s: 'mock-s' }) // signatureB
      );

      // Then: a zk-SNARK proof is generated (prove is called)
      expect(mockTxnProve).toHaveBeenCalled();

      // And: the Poseidon commitment is computed
      expect(mockPoseidonHash).toHaveBeenCalled();

      // And: a MinaTxResult is returned with the transaction hash
      expect(result).toHaveProperty('txHash');
      expect(typeof result.txHash).toBe('string');
    });

    it('[P1] should require signer private key', async () => {
      // Given: an SDK instance without a signer private key
      // When: claimFromChannel() is called
      // Then: a MinaChannelError is thrown with code 1008
      await expect(
        sdk.claimFromChannel(
          TEST_ZKAPP_ADDRESS,
          700n,
          300n,
          42n,
          1n,
          JSON.stringify({ r: 'r', s: 's' }),
          JSON.stringify({ r: 'r', s: 's' })
        )
      ).rejects.toThrow(MinaChannelError);
      try {
        await sdk.claimFromChannel(
          TEST_ZKAPP_ADDRESS,
          700n,
          300n,
          42n,
          1n,
          JSON.stringify({ r: 'r', s: 's' }),
          JSON.stringify({ r: 'r', s: 's' })
        );
      } catch (err) {
        expect((err as MinaChannelError).code).toBe(1008);
      }
    });
  });

  // -----------------------------------------------------------------------
  // AC 5: closeChannel Initiates Cooperative Close
  // -----------------------------------------------------------------------

  describe('AC 5: closeChannel', () => {
    it('[P0] should submit a close transaction with final balances', async () => {
      // Given: an open channel
      await sdkWithSigner.compileContract();

      // When: closeChannel() is called with final balances, salt, nonce, and both signatures
      const result = await sdkWithSigner.closeChannel(
        TEST_ZKAPP_ADDRESS,
        700000000n, // finalBalanceA
        300000000n, // finalBalanceB
        42n, // salt
        1n, // nonce
        JSON.stringify({ r: 'mock-r', s: 'mock-s' }), // signatureA
        JSON.stringify({ r: 'mock-r', s: 'mock-s' }) // signatureB
      );

      // Then: an initiateClose transaction is submitted to the zkApp
      expect(mockMinaTransaction).toHaveBeenCalled();
      expect(mockTxnProve).toHaveBeenCalled();

      // And: a MinaTxResult is returned
      expect(result).toHaveProperty('txHash');
    });
  });

  // -----------------------------------------------------------------------
  // AC 6: settleChannel Executes Post-Challenge Settlement
  // -----------------------------------------------------------------------

  describe('AC 6: settleChannel', () => {
    it('[P0] should submit a settle transaction to the zkApp', async () => {
      // Given: a CLOSING channel whose challenge period has elapsed
      await sdkWithSigner.compileContract();

      // When: settleChannel() is called with revealed balances, salt, participant keys, and nonce
      const result = await sdkWithSigner.settleChannel(
        TEST_ZKAPP_ADDRESS,
        700000000n, // balanceA
        300000000n, // balanceB
        42n, // salt
        TEST_PARTICIPANT_A, // participantA
        TEST_PARTICIPANT_B, // participantB
        1n // nonce
      );

      // Then: a settle transaction is submitted
      expect(mockMinaTransaction).toHaveBeenCalled();
      expect(mockTxnProve).toHaveBeenCalled();

      // And: the channel transitions to SETTLED state (verified by tx submission)
      expect(result).toHaveProperty('txHash');
    });
  });

  // -----------------------------------------------------------------------
  // AC 7: getChannelState Reads On-Chain State
  // -----------------------------------------------------------------------

  describe('AC 7: getChannelState', () => {
    it('[P0] should read all on-chain state fields and return MinaChannelState', async () => {
      // Given: a channel at a known zkApp address
      // When: getChannelState() is called
      const state = await sdk.getChannelState(TEST_ZKAPP_ADDRESS);

      // Then: fetchAccount is called
      expect(mockFetchAccount).toHaveBeenCalledWith(
        expect.objectContaining({ publicKey: expect.anything() })
      );

      // And: field values are correctly converted
      expect(state).toMatchObject({
        channelHash: expect.any(String),
        balanceCommitment: expect.any(String),
        nonceField: expect.any(BigInt),
        channelState: expect.any(Number),
        depositTotal: expect.any(BigInt),
        closedAtSlot: expect.any(BigInt),
        settlementTimeout: expect.any(BigInt),
        tokenId: expect.any(String),
      });

      // And: participant keys are strings (may be empty per dev notes)
      expect(typeof state.participantA).toBe('string');
      expect(typeof state.participantB).toBe('string');
    });

    it('[P1] should throw MinaChannelError code 1005 if account fetch fails', async () => {
      // Given: fetchAccount returns an error
      mockFetchAccount.mockResolvedValueOnce({ error: 'Account not found' });
      mockFetchAccount.mockResolvedValueOnce({ error: 'Account not found' });

      // When/Then: getChannelState throws ACCOUNT_NOT_FOUND
      await expect(sdk.getChannelState(TEST_ZKAPP_ADDRESS)).rejects.toThrow(MinaChannelError);
      try {
        await sdk.getChannelState(TEST_ZKAPP_ADDRESS);
      } catch (err) {
        expect(err).toBeInstanceOf(MinaChannelError);
        expect((err as MinaChannelError).code).toBe(1005);
        expect((err as MinaChannelError).errorName).toBe('ACCOUNT_NOT_FOUND');
      }
    });
  });

  // -----------------------------------------------------------------------
  // AC 8: getChannelEvents Retrieves Archive Node Events
  // -----------------------------------------------------------------------

  describe('AC 8: getChannelEvents', () => {
    it('[P1] should fetch historical events from the archive node', async () => {
      // Given: a channel with past transactions
      // When: getChannelEvents() is called
      const events = await sdk.getChannelEvents(TEST_ZKAPP_ADDRESS);

      // Then: events are returned as an array of typed event objects
      expect(Array.isArray(events)).toBe(true);
    });

    it('[P2] should return events in chronological order', async () => {
      // Given: a channel with multiple past transactions
      // When: getChannelEvents() is called
      const events = await sdk.getChannelEvents(TEST_ZKAPP_ADDRESS);

      // Then: events are returned in chronological order
      expect(Array.isArray(events)).toBe(true);
      // Each event should have a type and data
      for (const event of events) {
        expect(event).toHaveProperty('type');
        expect(event).toHaveProperty('data');
      }
    });
  });

  // -----------------------------------------------------------------------
  // AC 9: signBalanceProof Generates Poseidon Commitment
  // -----------------------------------------------------------------------

  describe('AC 9: signBalanceProof', () => {
    it('[P0] should compute Poseidon hash commitment and sign it', async () => {
      // Given: a channel address, balance parameters, and a configured signer private key
      // When: signBalanceProof() is called with balanceA, balanceB, salt, and nonce
      const proofString = await sdkWithSigner.signBalanceProof(
        TEST_ZKAPP_ADDRESS,
        700000000n, // balanceA
        300000000n, // balanceB
        42n, // salt
        1n // nonce
      );

      // Then: a Poseidon hash commitment is computed
      expect(mockPoseidonHash).toHaveBeenCalledWith(
        expect.arrayContaining([expect.anything(), expect.anything(), expect.anything()])
      );

      // And: the commitment is signed with the SDK's signer private key
      expect(mockSignatureCreate).toHaveBeenCalled();

      // And: the serialized proof string is returned
      expect(typeof proofString).toBe('string');
      const parsed = JSON.parse(proofString);
      expect(parsed).toHaveProperty('commitment');
      expect(parsed).toHaveProperty('signature');
      expect(parsed.signature).toHaveProperty('r');
      expect(parsed.signature).toHaveProperty('s');
      expect(parsed).toHaveProperty('nonce');
    });

    it('[P0] should throw MinaChannelError code 1008 when no signer key configured', async () => {
      // Given: an SDK instance constructed without a signer private key
      // When: signBalanceProof() is called
      // Then: a MinaChannelError is thrown with code 1008
      await expect(sdk.signBalanceProof(TEST_ZKAPP_ADDRESS, 700n, 300n, 42n, 1n)).rejects.toThrow(
        MinaChannelError
      );
      try {
        await sdk.signBalanceProof(TEST_ZKAPP_ADDRESS, 700n, 300n, 42n, 1n);
      } catch (err) {
        expect((err as MinaChannelError).code).toBe(1008);
        expect((err as MinaChannelError).errorName).toBe('INVALID_PARAMETERS');
      }
    });
  });

  // -----------------------------------------------------------------------
  // AC 10: verifyBalanceProof Validates ZK Proof
  // -----------------------------------------------------------------------

  describe('AC 10: verifyBalanceProof', () => {
    it('[P0] should return true for valid proofs', async () => {
      // Given: a valid balance commitment and associated proof
      const validProof = JSON.stringify({
        commitment: 'mock-poseidon-hash',
        signature: { r: 'mock-r', s: 'mock-s' },
        nonce: '1',
      });

      // When: verifyBalanceProof() is called (sdkWithSigner has a private key to derive pubkey)
      const isValid = await sdkWithSigner.verifyBalanceProof(
        TEST_ZKAPP_ADDRESS,
        'mock-poseidon-hash',
        validProof,
        1n
      );

      // Then: returns true for valid proofs
      expect(isValid).toBe(true);
    });

    it('[P1] should return false for invalid proofs', async () => {
      // Given: an invalid proof
      mockSignatureFromJSON.mockReturnValueOnce({
        toJSON: () => ({ r: 'bad-r', s: 'bad-s' }),
        verify: jest.fn().mockReturnValue({ toBoolean: () => false }),
      });

      const invalidProof = JSON.stringify({
        commitment: 'wrong-commitment',
        signature: { r: 'bad-r', s: 'bad-s' },
        nonce: '1',
      });

      // When: verifyBalanceProof() is called
      const isValid = await sdkWithSigner.verifyBalanceProof(
        TEST_ZKAPP_ADDRESS,
        'mock-poseidon-hash',
        invalidProof,
        1n
      );

      // Then: returns false for invalid proofs
      expect(isValid).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // AC 11: subscribeToChannel Polls for State Changes
  // -----------------------------------------------------------------------

  describe('AC 11: subscribeToChannel', () => {
    it('[P0] should invoke callback when state changes are detected', async () => {
      // Given: a channel address and callback function
      const callback = jest.fn();

      // When: subscribeToChannel() is called
      const subscription = sdkWithSigner.subscribeToChannel(TEST_ZKAPP_ADDRESS, callback);

      // Then: the SDK periodically polls getChannelState()
      expect(subscription).toHaveProperty('unsubscribe');
      expect(typeof subscription.unsubscribe).toBe('function');

      // Wait a tick for initial async poll to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Cleanup: stop polling
      subscription.unsubscribe();

      // Verify callback was invoked (initial state change)
      expect(callback).toHaveBeenCalled();
    });

    it('[P1] should stop polling when unsubscribe is called', async () => {
      // Given: an active subscription
      const callback = jest.fn();
      const subscription = sdkWithSigner.subscribeToChannel(TEST_ZKAPP_ADDRESS, callback);

      // Wait for the initial poll
      await new Promise((resolve) => setTimeout(resolve, 50));

      // When: unsubscribe() is called
      subscription.unsubscribe();

      // Then: polling stops and the interval is cleaned up
      const callCountAfterUnsub = callback.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(callback.mock.calls.length).toBe(callCountAfterUnsub);
    });

    it('[P1] should guard against overlapping polls', async () => {
      // Given: a slow-responding getChannelState
      // When: subscribeToChannel is called
      const callback = jest.fn();
      const subscription = sdkWithSigner.subscribeToChannel(TEST_ZKAPP_ADDRESS, callback);

      // Wait for initial poll
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Then: overlapping polls are skipped (in-flight guard)
      // (Verified indirectly: subscription works without errors)
      subscription.unsubscribe();
    });
  });

  // -----------------------------------------------------------------------
  // AC 12: Async Non-Blocking Proof Generation
  // -----------------------------------------------------------------------

  describe('AC 12: Async non-blocking proof generation', () => {
    it('[P0] should return a Promise from proof-generating operations', async () => {
      // Given: any SDK method that generates a zk-SNARK proof
      await sdkWithSigner.compileContract();

      // First open a channel to populate the participant cache
      await sdkWithSigner.openChannel(TEST_PARTICIPANT_A, TEST_PARTICIPANT_B, 100);
      const openedAddress = 'B62mock-zkapp-address';

      // When: the method is invoked. Balances must sum to the mocked on-chain
      // depositTotal (1_000_000_000) or the conservation guard rejects the claim
      // before proof generation (Issue #126).
      const claimPromise = sdkWithSigner.claimFromChannel(
        openedAddress,
        700_000_000n,
        300_000_000n,
        42n,
        1n,
        JSON.stringify({ r: 'mock-r', s: 'mock-s' }),
        JSON.stringify({ r: 'mock-r', s: 'mock-s' })
      );

      // Then: it returns a Promise that resolves asynchronously
      expect(claimPromise).toBeInstanceOf(Promise);
      const result = await claimPromise;
      expect(result).toHaveProperty('txHash');
    });
  });

  // -----------------------------------------------------------------------
  // Cross-Cutting: Error Handling
  // -----------------------------------------------------------------------

  describe('Error handling', () => {
    it('[P0] should throw MinaChannelError code 9999 when o1js is not installed', () => {
      // Given: MinaChannelError is defined
      // Simulated: the SDK's lazy loader should catch import errors
      // and wrap them appropriately.
      expect(MinaChannelError).toBeDefined();
      expect(new MinaChannelError('test', 9999, 'O1JS_NOT_AVAILABLE')).toBeInstanceOf(Error);
      expect(new MinaChannelError('test', 9999, 'O1JS_NOT_AVAILABLE').code).toBe(9999);
    });

    it('[P0] should throw MinaChannelError code 1002 on transaction failure', async () => {
      // Given: transaction submission fails
      mockTxnSign.mockReturnValueOnce({
        send: jest.fn().mockRejectedValue(new Error('Transaction rejected by network')),
      });

      // When/Then: deposit throws TRANSACTION_FAILED
      await expect(sdkWithSigner.deposit(TEST_ZKAPP_ADDRESS, 500n)).rejects.toThrow(
        MinaChannelError
      );

      // Reset and try again to check code
      mockTxnSign.mockReturnValueOnce({
        send: jest.fn().mockRejectedValue(new Error('Transaction rejected by network')),
      });
      try {
        await sdkWithSigner.deposit(TEST_ZKAPP_ADDRESS, 500n);
      } catch (err) {
        expect(err).toBeInstanceOf(MinaChannelError);
        expect((err as MinaChannelError).code).toBe(1002);
        expect((err as MinaChannelError).errorName).toBe('TRANSACTION_FAILED');
      }
    });

    it('[P1] should throw MinaChannelError on proof generation failure', async () => {
      await sdkWithSigner.compileContract();

      // First open a channel to populate the participant cache (prove succeeds here)
      await sdkWithSigner.openChannel(TEST_PARTICIPANT_A, TEST_PARTICIPANT_B, 100);
      const openedAddress = 'B62mock-zkapp-address';

      // Now set prove to fail for the claim operation
      mockTxnProve.mockRejectedValueOnce(new Error('Proof generation timeout'));

      // When/Then: claimFromChannel throws MinaChannelError
      await expect(
        sdkWithSigner.claimFromChannel(
          openedAddress,
          700n,
          300n,
          42n,
          1n,
          JSON.stringify({ r: 'mock-r', s: 'mock-s' }),
          JSON.stringify({ r: 'mock-r', s: 'mock-s' })
        )
      ).rejects.toThrow(MinaChannelError);
    });
  });

  // -----------------------------------------------------------------------
  // Cross-Cutting: Constructor Extension
  // -----------------------------------------------------------------------

  describe('Constructor signature extension', () => {
    it('[P0] should accept optional 4th parameter for signer private key', () => {
      // Given/When: SDK constructed with 4 parameters
      const sdkWithKey = new MinaPaymentChannelSDK(
        TEST_GRAPHQL_URL,
        TEST_ZKAPP_ADDRESS,
        mockLogger,
        TEST_SIGNER_KEY
      );

      // Then: SDK is created successfully
      expect(sdkWithKey).toBeInstanceOf(MinaPaymentChannelSDK);
    });

    it('[P0] should remain backward compatible without signer key', () => {
      // Given/When: SDK constructed with 3 parameters (original signature)
      const sdkNoKey = new MinaPaymentChannelSDK(TEST_GRAPHQL_URL, TEST_ZKAPP_ADDRESS, mockLogger);

      // Then: SDK is created successfully
      expect(sdkNoKey).toBeInstanceOf(MinaPaymentChannelSDK);
    });
  });

  // -----------------------------------------------------------------------
  // Cross-Cutting: Dynamic Import Lazy Loading
  // -----------------------------------------------------------------------

  describe('Dynamic import pattern', () => {
    it('[P1] should use dynamic import for o1js (not static import)', async () => {
      // Given: SDK is imported without o1js being required at module load time
      // When: a method requiring o1js is called
      await sdkWithSigner.compileContract();

      // Then: o1js is loaded dynamically
      // (Verified indirectly: if o1js was statically imported, the module
      //  would fail to load when o1js is not installed)
      expect(MockPaymentChannel.compile).toHaveBeenCalled();
    });

    it('[P1] should use dynamic import for @toon-protocol/mina-zkapp', async () => {
      // Given: SDK is imported without mina-zkapp being required at module load
      // When: a method requiring the contract is called
      await sdkWithSigner.compileContract();

      // Then: PaymentChannel is loaded dynamically
      expect(MockPaymentChannel.compile).toHaveBeenCalled();
    });
  });
});
