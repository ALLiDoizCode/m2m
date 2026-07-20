/**
 * Tests for SolanaPaymentChannelProvider
 *
 * Covers:
 * - Constructor validation (T-33.5-01)
 * - chainType and chainId properties (T-33.5-02)
 * - openChannel delegation (T-33.5-03)
 * - deposit delegation with ATA derivation (T-33.5-04, T-33.5-20)
 * - claimFromChannel delegation (T-33.5-05)
 * - closeChannel delegation (T-33.5-06)
 * - settleChannel delegation with ATA derivation (T-33.5-07, T-33.5-21)
 * - signBalanceProof delegation (T-33.5-08, T-33.5-22)
 * - verifyBalanceProof Ed25519 verification (T-33.5-09)
 * - getChannelState mapping (T-33.5-10)
 * - subscribeToEvents state diffing (T-33.5-11 through T-33.5-14)
 * - Error mapping (T-33.5-15)
 * - Factory function (T-33.5-16, T-33.5-17)
 * - EVM field warnings (T-33.5-18)
 * - getSolanaContext (T-33.5-19)
 *
 * Epic 33 Story 33.5
 *
 * @module solana-payment-channel-provider.test
 */

import type { Logger } from '../../utils/logger';
import type {
  BalanceProofParams,
  VerifyBalanceProofParams,
  SolanaProviderConfig,
  ProviderConfig,
} from './payment-channel-provider';
import type { SolanaChannelState } from '../solana-payment-channel-sdk';
import { SolanaPaymentChannelSDK, SolanaChannelError } from '../solana-payment-channel-sdk';
import {
  SolanaPaymentChannelProvider,
  createSolanaProviderFactory,
} from './solana-payment-channel-provider';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../solana-payment-channel-sdk', () => {
  const actual = jest.requireActual('../solana-payment-channel-sdk') as Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MockSDKClass: any = jest.fn().mockImplementation(() => ({}));
  // Preserve real SolanaChannelError for instanceof checks
  // but mock static methods on SDK
  MockSDKClass.signBalanceProof = jest.fn();
  MockSDKClass._buildBalanceProofMessage = jest.fn();
  MockSDKClass.deriveChannelPDA = jest.fn();
  MockSDKClass.deriveVaultPDA = jest.fn();
  return {
    ...actual,
    SolanaPaymentChannelSDK: MockSDKClass,
  };
});
jest.mock('@solana-program/token', () => ({
  findAssociatedTokenPda: jest
    .fn()
    .mockResolvedValue(['MockATA11111111111111111111111111111111111' as unknown, 255]),
}));
jest.mock('@solana/kit', () => ({
  address: jest.fn((addr: string) => addr),
  getAddressEncoder: jest.fn(() => ({
    encode: jest.fn(() => new Uint8Array(32).fill(0)),
  })),
}));

// Import mocked modules for assertion
import { findAssociatedTokenPda } from '@solana-program/token';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function createMockLogger(): Logger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
    level: 'silent',
  } as unknown as Logger;
}

/** Mock KeyPairSigner with address and keyPair */
function createMockSigner(): {
  address: string;
  keyPair: { publicKey: unknown; privateKey: unknown };
} {
  return {
    address: 'SignerAddress111111111111111111111111111111',
    keyPair: {
      publicKey: { type: 'mock-public-key' },
      privateKey: { type: 'mock-private-key' },
    },
  };
}

function createMockSDK(): jest.Mocked<
  Pick<
    SolanaPaymentChannelSDK,
    | 'openChannel'
    | 'deposit'
    | 'claimFromChannel'
    | 'closeChannel'
    | 'settleChannel'
    | 'getChannelState'
    | 'subscribeToChannel'
  >
> {
  return {
    openChannel: jest.fn(),
    deposit: jest.fn(),
    claimFromChannel: jest.fn(),
    closeChannel: jest.fn(),
    settleChannel: jest.fn(),
    getChannelState: jest.fn(),
    subscribeToChannel: jest.fn(),
  };
}

function createSampleChannelState(overrides?: Partial<SolanaChannelState>): SolanaChannelState {
  return {
    participantA: 'ParticipantA1111111111111111111111111111111',
    participantB: 'ParticipantB1111111111111111111111111111111',
    tokenMint: 'TokenMint111111111111111111111111111111111',
    depositA: 1000000n,
    depositB: 500000n,
    transferredAmountA: 100000n,
    transferredAmountB: 50000n,
    nonceA: 5n,
    nonceB: 3n,
    challengeDuration: 3600n,
    state: 'opened',
    closeTimestamp: 0n,
    bump: 255,
    ...overrides,
  };
}

const TEST_CHAIN_ID = 'solana:devnet';
const TEST_TOKEN_MINT = 'TokenMint111111111111111111111111111111111';
const TEST_PROGRAM_ID = 'ProgramId111111111111111111111111111111111';
const TEST_CHANNEL_PDA = 'ChannelPDA1111111111111111111111111111111';
const MOCK_ATA = 'MockATA11111111111111111111111111111111111';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SolanaPaymentChannelProvider (Story 33.5)', () => {
  let mockSDK: ReturnType<typeof createMockSDK>;
  let mockLogger: Logger;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockSigner: any;
  let provider: SolanaPaymentChannelProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSDK = createMockSDK();
    mockLogger = createMockLogger();
    mockSigner = createMockSigner();
    provider = new SolanaPaymentChannelProvider(
      mockSDK as unknown as SolanaPaymentChannelSDK,
      TEST_CHAIN_ID,
      TEST_TOKEN_MINT,
      mockSigner,
      TEST_PROGRAM_ID,
      mockLogger
    );
  });

  // -------------------------------------------------------------------------
  // Constructor Validation (T-33.5-01)
  // -------------------------------------------------------------------------

  describe('constructor validation (T-33.5-01)', () => {
    it('should throw if chainId is empty', () => {
      expect(() => {
        new SolanaPaymentChannelProvider(
          mockSDK as unknown as SolanaPaymentChannelSDK,
          '',
          TEST_TOKEN_MINT,
          mockSigner,
          TEST_PROGRAM_ID,
          mockLogger
        );
      }).toThrow('SolanaPaymentChannelProvider: chainId must not be empty');
    });

    it('should throw if tokenMint is empty', () => {
      expect(() => {
        new SolanaPaymentChannelProvider(
          mockSDK as unknown as SolanaPaymentChannelSDK,
          TEST_CHAIN_ID,
          '',
          mockSigner,
          TEST_PROGRAM_ID,
          mockLogger
        );
      }).toThrow('SolanaPaymentChannelProvider: tokenMint must not be empty');
    });

    it('should throw if programId is empty', () => {
      expect(() => {
        new SolanaPaymentChannelProvider(
          mockSDK as unknown as SolanaPaymentChannelSDK,
          TEST_CHAIN_ID,
          TEST_TOKEN_MINT,
          mockSigner,
          '',
          mockLogger
        );
      }).toThrow('SolanaPaymentChannelProvider: programId must not be empty');
    });
  });

  // -------------------------------------------------------------------------
  // Type Properties (T-33.5-02)
  // -------------------------------------------------------------------------

  describe('type properties (T-33.5-02)', () => {
    it('should have chainType "solana"', () => {
      expect(provider.chainType).toBe('solana');
    });

    it('should have chainId matching constructor arg', () => {
      expect(provider.chainId).toBe(TEST_CHAIN_ID);
    });
  });

  // -------------------------------------------------------------------------
  // openChannel (T-33.5-03)
  // -------------------------------------------------------------------------

  describe('openChannel (T-33.5-03)', () => {
    const COUNTERPARTY = 'CounterpartyAddr111111111111111111111111111';

    beforeEach(() => {
      // The provider derives the sorted-pair PDA before deciding init-vs-adopt.
      (SolanaPaymentChannelSDK.deriveChannelPDA as jest.Mock).mockReturnValue({
        pda: TEST_CHANNEL_PDA,
        bump: 255,
      });
    });

    it('should INITIALIZE a fresh channel when none exists', async () => {
      mockSDK.getChannelState.mockRejectedValue(
        new Error(`Channel account not found: ${TEST_CHANNEL_PDA}`)
      );
      mockSDK.openChannel.mockResolvedValue({
        channelPDA: TEST_CHANNEL_PDA,
        txSignature: 'sig123',
      });

      const result = await provider.openChannel(COUNTERPARTY, 3600);

      expect(SolanaPaymentChannelSDK.deriveChannelPDA).toHaveBeenCalledWith(
        mockSigner.address,
        COUNTERPARTY,
        TEST_TOKEN_MINT,
        TEST_PROGRAM_ID
      );
      expect(mockSDK.openChannel).toHaveBeenCalledWith(
        mockSigner,
        mockSigner.address,
        COUNTERPARTY,
        TEST_TOKEN_MINT,
        3600n
      );
      expect(result).toEqual({ channelId: TEST_CHANNEL_PDA, txHash: 'sig123' });
    });

    it('should ADOPT an existing channel (skip initialize) when the pair already has one', async () => {
      // Counterparty already initialized the shared PDA.
      mockSDK.getChannelState.mockResolvedValue(createSampleChannelState());

      const result = await provider.openChannel(COUNTERPARTY, 3600);

      expect(mockSDK.getChannelState).toHaveBeenCalledWith(TEST_CHANNEL_PDA);
      expect(mockSDK.openChannel).not.toHaveBeenCalled();
      expect(result).toEqual({ channelId: TEST_CHANNEL_PDA, txHash: '' });
    });

    it('should ADOPT if initialize loses a race (channel appears after our check)', async () => {
      // First lookup: absent → we try to init. Init collides. Re-check: now present → adopt.
      mockSDK.getChannelState
        .mockRejectedValueOnce(new Error(`Channel account not found: ${TEST_CHANNEL_PDA}`))
        .mockResolvedValueOnce(createSampleChannelState());
      mockSDK.openChannel.mockRejectedValue(new Error('custom program error: 0x0'));

      const result = await provider.openChannel(COUNTERPARTY, 3600);

      expect(mockSDK.openChannel).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ channelId: TEST_CHANNEL_PDA, txHash: '' });
    });

    it('should NOT initialize on a transient lookup error (avoid duplicate-init collision)', async () => {
      mockSDK.getChannelState.mockRejectedValue(new Error('RPC timeout'));

      await expect(provider.openChannel(COUNTERPARTY, 3600)).rejects.toThrow();
      expect(mockSDK.openChannel).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // deposit (T-33.5-04, T-33.5-20)
  // -------------------------------------------------------------------------

  describe('deposit (T-33.5-04, T-33.5-20)', () => {
    it('should derive ATA, convert amount to bigint, and delegate to SDK', async () => {
      mockSDK.deposit.mockResolvedValue({ txSignature: 'depSig456' });

      const result = await provider.deposit(TEST_CHANNEL_PDA, '1000000');

      expect(findAssociatedTokenPda).toHaveBeenCalledWith({
        owner: mockSigner.address,
        mint: TEST_TOKEN_MINT,
        tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      });
      expect(mockSDK.deposit).toHaveBeenCalledWith(
        mockSigner,
        TEST_CHANNEL_PDA,
        MOCK_ATA,
        1000000n
      );
      expect(result).toEqual({ txHash: 'depSig456' });
    });

    it('should throw for invalid amount string', async () => {
      await expect(provider.deposit(TEST_CHANNEL_PDA, 'not-a-number')).rejects.toThrow(
        'Invalid deposit amount'
      );
    });
  });

  // -------------------------------------------------------------------------
  // claimFromChannel (T-33.5-05)
  // -------------------------------------------------------------------------

  describe('claimFromChannel (T-33.5-05)', () => {
    it('should decode base64 signature, extract nonce/amount, and delegate to SDK', async () => {
      mockSDK.claimFromChannel.mockResolvedValue({ txSignature: 'claimSig789' });
      const base64Sig = Buffer.from(new Uint8Array(64).fill(0xab)).toString('base64');

      const balanceProof: BalanceProofParams = {
        channelId: TEST_CHANNEL_PDA,
        nonce: 5,
        transferredAmount: '500000',
        lockedAmount: '0',
        locksRoot: '0x',
      };

      const result = await provider.claimFromChannel(TEST_CHANNEL_PDA, balanceProof, base64Sig);

      expect(mockSDK.claimFromChannel).toHaveBeenCalledWith(
        mockSigner,
        TEST_CHANNEL_PDA,
        5n,
        500000n,
        expect.any(Uint8Array),
        // No signerPublicKey on this balance proof => self-signed claim path
        undefined
      );
      // Verify the signature bytes match the original
      const passedSig = mockSDK.claimFromChannel.mock.calls[0]?.[4] as Uint8Array;
      expect(passedSig).toEqual(new Uint8Array(64).fill(0xab));
      expect(result).toEqual({ txHash: 'claimSig789' });
    });

    it('should forward the balance proof signerPublicKey to the SDK (inbound peer claim)', async () => {
      mockSDK.claimFromChannel.mockResolvedValue({ txSignature: 'claimSig789' });
      const base64Sig = Buffer.from(new Uint8Array(64).fill(0xab)).toString('base64');
      const peerPubkey = 'PeerSignerPubkey11111111111111111111111111';

      const balanceProof: BalanceProofParams = {
        channelId: TEST_CHANNEL_PDA,
        nonce: 5,
        transferredAmount: '500000',
        lockedAmount: '0',
        locksRoot: '0x',
        // Counterparty-signed claim: the Ed25519 precompile must verify against
        // the peer's key, not our own signer.
        signerPublicKey: peerPubkey,
      };

      await provider.claimFromChannel(TEST_CHANNEL_PDA, balanceProof, base64Sig);

      expect(mockSDK.claimFromChannel).toHaveBeenCalledWith(
        mockSigner,
        TEST_CHANNEL_PDA,
        5n,
        500000n,
        expect.any(Uint8Array),
        peerPubkey
      );
    });
  });

  // -------------------------------------------------------------------------
  // closeChannel (T-33.5-06)
  // -------------------------------------------------------------------------

  describe('closeChannel (T-33.5-06)', () => {
    it('should delegate to SDK with signer as closer', async () => {
      mockSDK.closeChannel.mockResolvedValue({ txSignature: 'closeSig' });

      const result = await provider.closeChannel(TEST_CHANNEL_PDA);

      expect(mockSDK.closeChannel).toHaveBeenCalledWith(mockSigner, TEST_CHANNEL_PDA);
      expect(result).toEqual({ txHash: 'closeSig' });
    });
  });

  // -------------------------------------------------------------------------
  // settleChannel (T-33.5-07, T-33.5-21)
  // -------------------------------------------------------------------------

  describe('settleChannel (T-33.5-07, T-33.5-21)', () => {
    it('should fetch state, derive ATAs for both participants, and delegate to SDK', async () => {
      const channelState = createSampleChannelState();
      mockSDK.getChannelState.mockResolvedValue(channelState);
      mockSDK.settleChannel.mockResolvedValue({ txSignature: 'settleSig' });

      const result = await provider.settleChannel(TEST_CHANNEL_PDA);

      expect(mockSDK.getChannelState).toHaveBeenCalledWith(TEST_CHANNEL_PDA);
      // findAssociatedTokenPda called twice: once for participantA, once for participantB
      expect(findAssociatedTokenPda).toHaveBeenCalledTimes(2);
      expect(mockSDK.settleChannel).toHaveBeenCalledWith(
        mockSigner,
        TEST_CHANNEL_PDA,
        MOCK_ATA, // participantA ATA
        MOCK_ATA, // participantB ATA
        mockSigner.address // rentRecipient
      );
      expect(result).toEqual({ txHash: 'settleSig' });
    });
  });

  // -------------------------------------------------------------------------
  // signBalanceProof (T-33.5-08, T-33.5-22)
  // -------------------------------------------------------------------------

  describe('signBalanceProof (T-33.5-08, T-33.5-22)', () => {
    it('should call SDK static method with keyPair and return base64 signature', async () => {
      const rawSig = new Uint8Array(64).fill(0xcd);
      (SolanaPaymentChannelSDK.signBalanceProof as jest.Mock).mockResolvedValue(rawSig);

      const params: BalanceProofParams = {
        channelId: TEST_CHANNEL_PDA,
        nonce: 10,
        transferredAmount: '1000000',
        lockedAmount: '0',
        locksRoot: '',
      };

      const result = await provider.signBalanceProof(params);

      expect(SolanaPaymentChannelSDK.signBalanceProof).toHaveBeenCalledWith(
        TEST_CHANNEL_PDA,
        10n,
        1000000n,
        mockSigner.keyPair // passes keyPair, not signer itself
      );
      expect(result).toBe(Buffer.from(rawSig).toString('base64'));
    });
  });

  // -------------------------------------------------------------------------
  // verifyBalanceProof (T-33.5-09)
  // -------------------------------------------------------------------------

  describe('verifyBalanceProof (T-33.5-09)', () => {
    it('should return false on verification error (graceful handling)', async () => {
      // _buildBalanceProofMessage is mocked via jest.mock so it will throw.
      // The method should catch any error and return false.
      (SolanaPaymentChannelSDK._buildBalanceProofMessage as jest.Mock).mockImplementation(() => {
        throw new Error('mock build error');
      });

      const params: VerifyBalanceProofParams = {
        channelId: TEST_CHANNEL_PDA,
        nonce: 5,
        transferredAmount: '500000',
        lockedAmount: '0',
        locksRoot: '',
        signature: Buffer.from(new Uint8Array(64)).toString('base64'),
        signerAddress: 'SomeSignerAddr111111111111111111111111111111',
      };

      const result = await provider.verifyBalanceProof(params);
      expect(result).toBe(false);
    });

    it('should call _buildBalanceProofMessage with correct params', async () => {
      const mockMessage = new Uint8Array(48).fill(0);
      (SolanaPaymentChannelSDK._buildBalanceProofMessage as jest.Mock).mockReturnValue(mockMessage);

      const params: VerifyBalanceProofParams = {
        channelId: TEST_CHANNEL_PDA,
        nonce: 5,
        transferredAmount: '500000',
        lockedAmount: '0',
        locksRoot: '',
        signature: Buffer.from(new Uint8Array(64)).toString('base64'),
        signerAddress: 'SomeSignerAddr111111111111111111111111111111',
      };

      // This will fail at crypto.subtle.importKey (not available in jest mocked env)
      // but we verify _buildBalanceProofMessage was called correctly
      const result = await provider.verifyBalanceProof(params);

      expect(SolanaPaymentChannelSDK._buildBalanceProofMessage).toHaveBeenCalledWith(
        TEST_CHANNEL_PDA,
        5n,
        500000n
      );
      // Returns false because crypto.subtle is not real in test environment
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getChannelState (T-33.5-10)
  // -------------------------------------------------------------------------

  describe('getChannelState (T-33.5-10)', () => {
    it('should map SolanaChannelState to ProviderChannelState correctly', async () => {
      const solanaState = createSampleChannelState();
      mockSDK.getChannelState.mockResolvedValue(solanaState);

      const result = await provider.getChannelState(TEST_CHANNEL_PDA);

      expect(mockSDK.getChannelState).toHaveBeenCalledWith(TEST_CHANNEL_PDA);
      expect(result).toEqual({
        channelId: TEST_CHANNEL_PDA,
        status: 'opened',
        participants: [solanaState.participantA, solanaState.participantB],
        deposit: 1500000n, // depositA + depositB = 1000000 + 500000
      });
    });
  });

  // -------------------------------------------------------------------------
  // subscribeToEvents (T-33.5-11 through T-33.5-14)
  // -------------------------------------------------------------------------

  describe('subscribeToEvents', () => {
    it('should detect claim (transferredAmount increase) and emit channel_claimed (T-33.5-11)', () => {
      const mockUnsubscribe = jest.fn();
      let sdkCallback: ((state: SolanaChannelState) => void) | undefined;

      mockSDK.subscribeToChannel.mockImplementation(
        (_channelPDA: string, cb: (state: SolanaChannelState) => void) => {
          sdkCallback = cb;
          return { unsubscribe: mockUnsubscribe };
        }
      );

      const eventCallback = jest.fn();
      provider.subscribeToEvents(TEST_CHANNEL_PDA, eventCallback);

      // First call: initial state (no event emitted)
      const initialState = createSampleChannelState({ transferredAmountA: 100000n });
      sdkCallback!(initialState);
      expect(eventCallback).not.toHaveBeenCalled();

      // Second call: transferredAmountA increased -> channel_claimed
      const claimedState = createSampleChannelState({ transferredAmountA: 200000n });
      sdkCallback!(claimedState);
      expect(eventCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'channel_claimed',
          channelId: TEST_CHANNEL_PDA,
        })
      );
    });

    it('should detect deposit and emit channel_deposited (T-33.5-12)', () => {
      let sdkCallback: ((state: SolanaChannelState) => void) | undefined;

      mockSDK.subscribeToChannel.mockImplementation(
        (_channelPDA: string, cb: (state: SolanaChannelState) => void) => {
          sdkCallback = cb;
          return { unsubscribe: jest.fn() };
        }
      );

      const eventCallback = jest.fn();
      provider.subscribeToEvents(TEST_CHANNEL_PDA, eventCallback);

      // Initial state
      sdkCallback!(createSampleChannelState({ depositA: 1000000n }));
      expect(eventCallback).not.toHaveBeenCalled();

      // Deposit increased
      sdkCallback!(createSampleChannelState({ depositA: 2000000n }));
      expect(eventCallback).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'channel_deposited' })
      );
    });

    it('should detect close and emit channel_closed (T-33.5-13)', () => {
      let sdkCallback: ((state: SolanaChannelState) => void) | undefined;

      mockSDK.subscribeToChannel.mockImplementation(
        (_channelPDA: string, cb: (state: SolanaChannelState) => void) => {
          sdkCallback = cb;
          return { unsubscribe: jest.fn() };
        }
      );

      const eventCallback = jest.fn();
      provider.subscribeToEvents(TEST_CHANNEL_PDA, eventCallback);

      // Initial state: opened
      sdkCallback!(createSampleChannelState({ state: 'opened' }));

      // State changed to closed
      sdkCallback!(createSampleChannelState({ state: 'closed' }));
      expect(eventCallback).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'channel_closed' })
      );
    });

    it('should detect settle and emit channel_settled (T-33.5-14)', () => {
      let sdkCallback: ((state: SolanaChannelState) => void) | undefined;

      mockSDK.subscribeToChannel.mockImplementation(
        (_channelPDA: string, cb: (state: SolanaChannelState) => void) => {
          sdkCallback = cb;
          return { unsubscribe: jest.fn() };
        }
      );

      const eventCallback = jest.fn();
      provider.subscribeToEvents(TEST_CHANNEL_PDA, eventCallback);

      // Initial state: closed
      sdkCallback!(createSampleChannelState({ state: 'closed' }));

      // State changed to settled
      sdkCallback!(createSampleChannelState({ state: 'settled' }));
      expect(eventCallback).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'channel_settled' })
      );
    });

    it('should stop emitting events after unsubscribe', () => {
      const mockUnsubscribe = jest.fn();
      let sdkCallback: ((state: SolanaChannelState) => void) | undefined;

      mockSDK.subscribeToChannel.mockImplementation(
        (_channelPDA: string, cb: (state: SolanaChannelState) => void) => {
          sdkCallback = cb;
          return { unsubscribe: mockUnsubscribe };
        }
      );

      const eventCallback = jest.fn();
      const subscription = provider.subscribeToEvents(TEST_CHANNEL_PDA, eventCallback);

      // Initial state
      sdkCallback!(createSampleChannelState({ state: 'opened' }));

      // Unsubscribe
      subscription.unsubscribe();
      expect(mockUnsubscribe).toHaveBeenCalled();

      // Subsequent callback should be ignored
      sdkCallback!(createSampleChannelState({ state: 'closed' }));
      expect(eventCallback).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Error Mapping (T-33.5-15)
  // -------------------------------------------------------------------------

  describe('error mapping (T-33.5-15)', () => {
    it('should wrap SolanaChannelError with provider context', async () => {
      const sdkError = new SolanaChannelError(
        'Solana payment channel program error: NonceNotMonotonic (code 6)',
        6,
        'NonceNotMonotonic'
      );
      mockSDK.closeChannel.mockRejectedValue(sdkError);

      await expect(provider.closeChannel(TEST_CHANNEL_PDA)).rejects.toThrow(
        `SolanaPaymentChannelProvider [${TEST_CHAIN_ID}] closeChannel channel ${TEST_CHANNEL_PDA}`
      );
      await expect(provider.closeChannel(TEST_CHANNEL_PDA)).rejects.toThrow('NonceNotMonotonic');
      await expect(provider.closeChannel(TEST_CHANNEL_PDA)).rejects.toThrow('code 6');
    });

    it('should pass through non-SolanaChannelError errors unchanged', async () => {
      (SolanaPaymentChannelSDK.deriveChannelPDA as jest.Mock).mockReturnValue({
        pda: TEST_CHANNEL_PDA,
        bump: 255,
      });
      mockSDK.getChannelState.mockRejectedValue(
        new Error(`Channel account not found: ${TEST_CHANNEL_PDA}`)
      );
      const genericError = new Error('Network timeout');
      mockSDK.openChannel.mockRejectedValue(genericError);

      await expect(
        provider.openChannel('CounterpartyAddr111111111111111111111111111', 3600)
      ).rejects.toThrow('Network timeout');
    });
  });

  // -------------------------------------------------------------------------
  // Factory Function (T-33.5-16, T-33.5-17)
  // -------------------------------------------------------------------------

  describe('createSolanaProviderFactory', () => {
    it('should reject non-solana config (T-33.5-16)', () => {
      const factory = createSolanaProviderFactory(mockLogger, mockSigner, TEST_TOKEN_MINT);
      const evmConfig = {
        chainType: 'evm' as const,
        rpcUrl: 'http://localhost:8545',
        registryAddress: '0x1234',
        keyId: 'key-1',
        tokenAddress: '0x5678000000000000000000000000000000000001',
      };

      expect(() => factory(evmConfig)).toThrow('Solana factory received non-Solana config: evm');
    });

    it('should return SolanaPaymentChannelProvider from valid config (T-33.5-17)', () => {
      const factory = createSolanaProviderFactory(mockLogger, mockSigner, TEST_TOKEN_MINT);
      const solanaConfig: SolanaProviderConfig = {
        chainType: 'solana',
        rpcUrl: 'http://localhost:8899',
        programId: TEST_PROGRAM_ID,
        keyId: 'solana-key-1',
        cluster: 'devnet',
      };

      const result = factory(solanaConfig as ProviderConfig);

      expect(result).toBeInstanceOf(SolanaPaymentChannelProvider);
      expect(result.chainType).toBe('solana');
      expect(result.chainId).toBe('solana:devnet');
    });

    it('should default cluster to devnet when not specified', () => {
      const factory = createSolanaProviderFactory(mockLogger, mockSigner, TEST_TOKEN_MINT);
      const solanaConfig: SolanaProviderConfig = {
        chainType: 'solana',
        rpcUrl: 'http://localhost:8899',
        programId: TEST_PROGRAM_ID,
        keyId: 'solana-key-1',
      };

      const result = factory(solanaConfig as ProviderConfig);
      expect(result.chainId).toBe('solana:devnet');
    });
  });

  // -------------------------------------------------------------------------
  // EVM Field Warnings (T-33.5-18)
  // -------------------------------------------------------------------------

  describe('EVM field warnings (T-33.5-18)', () => {
    it('should log warning when lockedAmount is non-zero', async () => {
      (SolanaPaymentChannelSDK.signBalanceProof as jest.Mock).mockResolvedValue(new Uint8Array(64));

      const params: BalanceProofParams = {
        channelId: TEST_CHANNEL_PDA,
        nonce: 1,
        transferredAmount: '100',
        lockedAmount: '500',
        locksRoot: '',
      };

      await provider.signBalanceProof(params);

      expect(mockLogger.warn as jest.Mock).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'ignored_field', field: 'lockedAmount' }),
        expect.stringContaining('lockedAmount is not supported')
      );
    });

    it('should log warning when locksRoot is non-empty', async () => {
      (SolanaPaymentChannelSDK.signBalanceProof as jest.Mock).mockResolvedValue(new Uint8Array(64));

      const params: BalanceProofParams = {
        channelId: TEST_CHANNEL_PDA,
        nonce: 1,
        transferredAmount: '100',
        lockedAmount: '0',
        locksRoot: '0xabcdef',
      };

      await provider.signBalanceProof(params);

      expect(mockLogger.warn as jest.Mock).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'ignored_field', field: 'locksRoot' }),
        expect.stringContaining('locksRoot is not supported')
      );
    });

    it('should log warning when verifyBalanceProof receives non-zero lockedAmount', async () => {
      // _buildBalanceProofMessage will throw in mocked env, but warning should fire before try
      (SolanaPaymentChannelSDK._buildBalanceProofMessage as jest.Mock).mockImplementation(() => {
        throw new Error('mock build error');
      });

      const params: VerifyBalanceProofParams = {
        channelId: TEST_CHANNEL_PDA,
        nonce: 1,
        transferredAmount: '100',
        lockedAmount: '500',
        locksRoot: '',
        signature: Buffer.from(new Uint8Array(64)).toString('base64'),
        signerAddress: 'SomeSignerAddr111111111111111111111111111111',
      };

      await provider.verifyBalanceProof(params);

      expect(mockLogger.warn as jest.Mock).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'ignored_field', field: 'lockedAmount' }),
        expect.stringContaining('lockedAmount is not supported')
      );
    });

    it('should not log warning when lockedAmount is zero and locksRoot is empty', async () => {
      (SolanaPaymentChannelSDK.signBalanceProof as jest.Mock).mockResolvedValue(new Uint8Array(64));

      const params: BalanceProofParams = {
        channelId: TEST_CHANNEL_PDA,
        nonce: 1,
        transferredAmount: '100',
        lockedAmount: '0',
        locksRoot: '',
      };

      await provider.signBalanceProof(params);

      expect(mockLogger.warn as jest.Mock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getSolanaContext (T-33.5-19)
  // -------------------------------------------------------------------------

  describe('getSolanaContext (T-33.5-19)', () => {
    it('should return programId, tokenMint, cluster, and signerAddress', () => {
      const context = provider.getSolanaContext();

      expect(context).toEqual({
        programId: TEST_PROGRAM_ID,
        tokenMint: TEST_TOKEN_MINT,
        cluster: 'devnet',
        signerAddress: mockSigner.address,
      });
    });

    it('should extract cluster from chainId', () => {
      const mainnetProvider = new SolanaPaymentChannelProvider(
        mockSDK as unknown as SolanaPaymentChannelSDK,
        'solana:mainnet-beta',
        TEST_TOKEN_MINT,
        mockSigner,
        TEST_PROGRAM_ID,
        mockLogger
      );

      const context = mainnetProvider.getSolanaContext();
      expect(context.cluster).toBe('mainnet-beta');
    });
  });

  // -------------------------------------------------------------------------
  // AC Gap Coverage: verifyBalanceProof positive path (AC 7)
  // -------------------------------------------------------------------------

  describe('verifyBalanceProof positive path (AC 7)', () => {
    let mockVerify: jest.Mock;
    let mockImportKey: jest.Mock;

    beforeEach(() => {
      mockVerify = jest.fn().mockResolvedValue(true);
      mockImportKey = jest.fn().mockResolvedValue({ type: 'public' });

      // Mock the Node.js crypto module's subtle property
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
      const cryptoModule = require('crypto') as any;
      jest.spyOn(cryptoModule.subtle, 'importKey').mockImplementation(mockImportKey);
      jest.spyOn(cryptoModule.subtle, 'verify').mockImplementation(mockVerify);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should return true when crypto.subtle.verify succeeds', async () => {
      const mockMessage = new Uint8Array(48).fill(0x01);
      (SolanaPaymentChannelSDK._buildBalanceProofMessage as jest.Mock).mockReturnValue(mockMessage);

      const params: VerifyBalanceProofParams = {
        channelId: TEST_CHANNEL_PDA,
        nonce: 5,
        transferredAmount: '500000',
        lockedAmount: '0',
        locksRoot: '',
        signature: Buffer.from(new Uint8Array(64).fill(0xab)).toString('base64'),
        signerAddress: 'SomeSignerAddr111111111111111111111111111111',
      };

      const result = await provider.verifyBalanceProof(params);

      expect(SolanaPaymentChannelSDK._buildBalanceProofMessage).toHaveBeenCalledWith(
        TEST_CHANNEL_PDA,
        5n,
        500000n
      );
      expect(mockImportKey).toHaveBeenCalledWith('raw', expect.any(Uint8Array), 'Ed25519', true, [
        'verify',
      ]);
      expect(mockVerify).toHaveBeenCalledWith(
        'Ed25519',
        { type: 'public' },
        expect.any(Uint8Array),
        mockMessage
      );
      expect(result).toBe(true);
    });

    it('should return false when crypto.subtle.verify returns false', async () => {
      mockVerify.mockResolvedValue(false);
      const mockMessage = new Uint8Array(48).fill(0x01);
      (SolanaPaymentChannelSDK._buildBalanceProofMessage as jest.Mock).mockReturnValue(mockMessage);

      const params: VerifyBalanceProofParams = {
        channelId: TEST_CHANNEL_PDA,
        nonce: 5,
        transferredAmount: '500000',
        lockedAmount: '0',
        locksRoot: '',
        signature: Buffer.from(new Uint8Array(64).fill(0xab)).toString('base64'),
        signerAddress: 'SomeSignerAddr111111111111111111111111111111',
      };

      const result = await provider.verifyBalanceProof(params);
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // AC Gap Coverage: error wrapping per method (AC 10)
  // -------------------------------------------------------------------------

  describe('error wrapping per method (AC 10 expanded)', () => {
    const sdkError = new SolanaChannelError(
      'Solana payment channel program error: ChannelNotOpen (code 3)',
      3,
      'ChannelNotOpen'
    );

    it('should wrap SolanaChannelError from openChannel', async () => {
      (SolanaPaymentChannelSDK.deriveChannelPDA as jest.Mock).mockReturnValue({
        pda: TEST_CHANNEL_PDA,
        bump: 255,
      });
      mockSDK.getChannelState.mockRejectedValue(
        new Error(`Channel account not found: ${TEST_CHANNEL_PDA}`)
      );
      mockSDK.openChannel.mockRejectedValue(sdkError);

      await expect(
        provider.openChannel('CounterpartyAddr111111111111111111111111111', 3600)
      ).rejects.toThrow(`SolanaPaymentChannelProvider [${TEST_CHAIN_ID}] openChannel channel new`);
    });

    it('should wrap SolanaChannelError from deposit', async () => {
      mockSDK.deposit.mockRejectedValue(sdkError);

      await expect(provider.deposit(TEST_CHANNEL_PDA, '1000000')).rejects.toThrow(
        `SolanaPaymentChannelProvider [${TEST_CHAIN_ID}] deposit channel ${TEST_CHANNEL_PDA}`
      );
    });

    it('should wrap SolanaChannelError from claimFromChannel', async () => {
      mockSDK.claimFromChannel.mockRejectedValue(sdkError);

      const balanceProof: BalanceProofParams = {
        channelId: TEST_CHANNEL_PDA,
        nonce: 1,
        transferredAmount: '100',
        lockedAmount: '0',
        locksRoot: '',
      };

      await expect(
        provider.claimFromChannel(
          TEST_CHANNEL_PDA,
          balanceProof,
          Buffer.from(new Uint8Array(64)).toString('base64')
        )
      ).rejects.toThrow(
        `SolanaPaymentChannelProvider [${TEST_CHAIN_ID}] claimFromChannel channel ${TEST_CHANNEL_PDA}`
      );
    });

    it('should wrap SolanaChannelError from settleChannel', async () => {
      mockSDK.getChannelState.mockResolvedValue(createSampleChannelState());
      mockSDK.settleChannel.mockRejectedValue(sdkError);

      await expect(provider.settleChannel(TEST_CHANNEL_PDA)).rejects.toThrow(
        `SolanaPaymentChannelProvider [${TEST_CHAIN_ID}] settleChannel channel ${TEST_CHANNEL_PDA}`
      );
    });

    it('should wrap SolanaChannelError from getChannelState', async () => {
      mockSDK.getChannelState.mockRejectedValue(sdkError);

      await expect(provider.getChannelState(TEST_CHANNEL_PDA)).rejects.toThrow(
        `SolanaPaymentChannelProvider [${TEST_CHAIN_ID}] getChannelState channel ${TEST_CHANNEL_PDA}`
      );
    });

    it('should preserve error name and code in wrapped message', async () => {
      mockSDK.closeChannel.mockRejectedValue(sdkError);

      await expect(provider.closeChannel(TEST_CHANNEL_PDA)).rejects.toThrow('ChannelNotOpen');
      await expect(provider.closeChannel(TEST_CHANNEL_PDA)).rejects.toThrow('code 3');
    });

    it('should wrap non-Error values as string errors', async () => {
      (SolanaPaymentChannelSDK.deriveChannelPDA as jest.Mock).mockReturnValue({
        pda: TEST_CHANNEL_PDA,
        bump: 255,
      });
      mockSDK.getChannelState.mockRejectedValue(
        new Error(`Channel account not found: ${TEST_CHANNEL_PDA}`)
      );
      mockSDK.openChannel.mockRejectedValue('some string error');

      await expect(
        provider.openChannel('CounterpartyAddr111111111111111111111111111', 3600)
      ).rejects.toThrow('some string error');
    });
  });

  // -------------------------------------------------------------------------
  // AC Gap Coverage: subscribeToEvents data payload and no-change (AC 9)
  // -------------------------------------------------------------------------

  describe('subscribeToEvents data payload and edge cases (AC 9 expanded)', () => {
    it('should include state data in emitted events', () => {
      let sdkCallback: ((state: SolanaChannelState) => void) | undefined;

      mockSDK.subscribeToChannel.mockImplementation(
        (_channelPDA: string, cb: (state: SolanaChannelState) => void) => {
          sdkCallback = cb;
          return { unsubscribe: jest.fn() };
        }
      );

      const eventCallback = jest.fn();
      provider.subscribeToEvents(TEST_CHANNEL_PDA, eventCallback);

      // Initial state
      sdkCallback!(createSampleChannelState({ state: 'opened', depositA: 1000000n }));

      // State changed to closed
      sdkCallback!(createSampleChannelState({ state: 'closed', depositA: 1000000n }));

      expect(eventCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'channel_closed',
          channelId: TEST_CHANNEL_PDA,
          data: expect.objectContaining({
            state: 'closed',
            depositA: '1000000',
            depositB: '500000',
            transferredAmountA: '100000',
            transferredAmountB: '50000',
          }),
        })
      );
    });

    it('should not emit event when state has not changed', () => {
      let sdkCallback: ((state: SolanaChannelState) => void) | undefined;

      mockSDK.subscribeToChannel.mockImplementation(
        (_channelPDA: string, cb: (state: SolanaChannelState) => void) => {
          sdkCallback = cb;
          return { unsubscribe: jest.fn() };
        }
      );

      const eventCallback = jest.fn();
      provider.subscribeToEvents(TEST_CHANNEL_PDA, eventCallback);

      const sameState = createSampleChannelState();

      // Initial state: no event
      sdkCallback!(sameState);
      expect(eventCallback).not.toHaveBeenCalled();

      // Same state again: no event
      sdkCallback!(sameState);
      expect(eventCallback).not.toHaveBeenCalled();
    });

    it('should detect transferredAmountB increase as channel_claimed', () => {
      let sdkCallback: ((state: SolanaChannelState) => void) | undefined;

      mockSDK.subscribeToChannel.mockImplementation(
        (_channelPDA: string, cb: (state: SolanaChannelState) => void) => {
          sdkCallback = cb;
          return { unsubscribe: jest.fn() };
        }
      );

      const eventCallback = jest.fn();
      provider.subscribeToEvents(TEST_CHANNEL_PDA, eventCallback);

      // Initial state
      sdkCallback!(createSampleChannelState({ transferredAmountB: 50000n }));

      // transferredAmountB increased
      sdkCallback!(createSampleChannelState({ transferredAmountB: 100000n }));
      expect(eventCallback).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'channel_claimed' })
      );
    });

    it('should detect depositB increase as channel_deposited', () => {
      let sdkCallback: ((state: SolanaChannelState) => void) | undefined;

      mockSDK.subscribeToChannel.mockImplementation(
        (_channelPDA: string, cb: (state: SolanaChannelState) => void) => {
          sdkCallback = cb;
          return { unsubscribe: jest.fn() };
        }
      );

      const eventCallback = jest.fn();
      provider.subscribeToEvents(TEST_CHANNEL_PDA, eventCallback);

      // Initial state
      sdkCallback!(createSampleChannelState({ depositB: 500000n }));

      // depositB increased
      sdkCallback!(createSampleChannelState({ depositB: 1000000n }));
      expect(eventCallback).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'channel_deposited' })
      );
    });

    it('should prioritize state transition over amount changes', () => {
      let sdkCallback: ((state: SolanaChannelState) => void) | undefined;

      mockSDK.subscribeToChannel.mockImplementation(
        (_channelPDA: string, cb: (state: SolanaChannelState) => void) => {
          sdkCallback = cb;
          return { unsubscribe: jest.fn() };
        }
      );

      const eventCallback = jest.fn();
      provider.subscribeToEvents(TEST_CHANNEL_PDA, eventCallback);

      // Initial state: opened with some amounts
      sdkCallback!(createSampleChannelState({ state: 'opened', transferredAmountA: 100000n }));

      // State changed to closed AND transferred amount increased
      sdkCallback!(createSampleChannelState({ state: 'closed', transferredAmountA: 200000n }));
      // Should emit channel_closed (state transition takes priority)
      expect(eventCallback).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'channel_closed' })
      );
      expect(eventCallback).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // AC Gap Coverage: claimFromChannel EVM field warnings (AC 4 expanded)
  // -------------------------------------------------------------------------

  describe('claimFromChannel EVM field warnings (AC 4 expanded)', () => {
    it('should warn about non-zero lockedAmount in balance proof', async () => {
      mockSDK.claimFromChannel.mockResolvedValue({ txSignature: 'claimSig' });

      const balanceProof: BalanceProofParams = {
        channelId: TEST_CHANNEL_PDA,
        nonce: 1,
        transferredAmount: '100',
        lockedAmount: '500',
        locksRoot: '',
      };

      await provider.claimFromChannel(
        TEST_CHANNEL_PDA,
        balanceProof,
        Buffer.from(new Uint8Array(64)).toString('base64')
      );

      expect(mockLogger.warn as jest.Mock).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'ignored_field', field: 'lockedAmount' }),
        expect.stringContaining('lockedAmount is not supported')
      );
    });
  });

  // -------------------------------------------------------------------------
  // AC Gap Coverage: safeBigInt edge cases
  // -------------------------------------------------------------------------

  describe('safeBigInt error handling', () => {
    it('should throw descriptive error for invalid transferredAmount in claimFromChannel', async () => {
      const balanceProof: BalanceProofParams = {
        channelId: TEST_CHANNEL_PDA,
        nonce: 1,
        transferredAmount: 'not-a-number',
        lockedAmount: '0',
        locksRoot: '',
      };

      await expect(
        provider.claimFromChannel(
          TEST_CHANNEL_PDA,
          balanceProof,
          Buffer.from(new Uint8Array(64)).toString('base64')
        )
      ).rejects.toThrow('Invalid transferredAmount');
    });

    it('should throw descriptive error for invalid transferredAmount in signBalanceProof', async () => {
      const params: BalanceProofParams = {
        channelId: TEST_CHANNEL_PDA,
        nonce: 1,
        transferredAmount: 'invalid',
        lockedAmount: '0',
        locksRoot: '',
      };

      await expect(provider.signBalanceProof(params)).rejects.toThrow('Invalid transferredAmount');
    });
  });

  // -------------------------------------------------------------------------
  // AC Gap Coverage: Factory function cluster variations (AC 11 expanded)
  // -------------------------------------------------------------------------

  describe('factory function cluster variations (AC 11 expanded)', () => {
    it('should use custom cluster from config', () => {
      const factory = createSolanaProviderFactory(mockLogger, mockSigner, TEST_TOKEN_MINT);
      const solanaConfig: SolanaProviderConfig = {
        chainType: 'solana',
        rpcUrl: 'http://mainnet.solana.com',
        programId: TEST_PROGRAM_ID,
        keyId: 'solana-key-1',
        cluster: 'mainnet-beta',
      };

      const result = factory(solanaConfig as ProviderConfig);
      expect(result.chainId).toBe('solana:mainnet-beta');
    });
  });
});
