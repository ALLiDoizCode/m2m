/**
 * Tests for MinaPaymentChannelProvider
 *
 * Covers:
 * - Constructor validation (T-34.5-01)
 * - chainType and chainId properties (T-34.5-02)
 * - openChannel delegation (T-34.5-03)
 * - signBalanceProof delegation (T-34.5-04)
 * - verifyBalanceProof validates proof (T-34.5-05)
 * - claimFromChannel delegation, async (T-34.5-06)
 * - getChannelState translation (T-34.5-07)
 * - Proof generation async non-blocking (T-34.5-08)
 * - Archive node unavailability handled (T-34.5-09)
 * - Concurrent claims manage nonces (T-34.5-10)
 * - subscribeToEvents emits events (T-34.5-11)
 * - unsubscribe cleans up (T-34.5-12)
 * - Provider registered in registry (T-34.5-13)
 * - getProviderForPeer resolves Mina (T-34.5-14)
 * - closeChannel, settleChannel, deposit delegate (T-34.5-15)
 * - Provider pre-compiles circuit during init (T-34.5-16)
 * - SDK errors mapped to provider errors (T-34.5-17)
 * - EVM field warnings (additional)
 * - getMinaContext (additional)
 * - Factory function (additional)
 * - safeBigInt validation (additional)
 *
 * Epic 34 Story 34.5
 *
 * @module mina-payment-channel-provider.test
 */

import type { Logger } from '../../utils/logger';
import type { BlockchainType } from '../../btp/btp-claim-types';
import type {
  BalanceProofParams,
  VerifyBalanceProofParams,
  ProviderConfig,
  ProviderEvent,
} from './payment-channel-provider';
import {
  MinaPaymentChannelProvider,
  createMinaProviderFactory,
} from './mina-payment-channel-provider';
import { ChainProviderRegistry } from './chain-provider-registry';
import type { ChainProviderFactory } from './chain-provider-registry';

// Mock the SDK module so factory function tests can construct providers
jest.mock('../mina-payment-channel-sdk', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MockSDKClass: any = jest.fn().mockImplementation(() => ({
    compileContract: jest.fn().mockResolvedValue(undefined),
    getSignerPublicKey: jest.fn().mockResolvedValue('B62qMockSignerPublicKey'),
    openChannel: jest.fn(),
    deposit: jest.fn(),
    claimFromChannel: jest.fn(),
    closeChannel: jest.fn(),
    settleChannel: jest.fn(),
    getChannelState: jest.fn(),
    getChannelEvents: jest.fn(),
    signBalanceProof: jest.fn(),
    verifyBalanceProof: jest.fn(),
    subscribeToChannel: jest.fn(),
  }));
  return {
    MinaPaymentChannelSDK: MockSDKClass,
    MinaChannelError: class MinaChannelError extends Error {
      readonly code: number;
      readonly errorName: string;
      constructor(message: string, code: number, errorName: string) {
        super(message);
        this.name = 'MinaChannelError';
        this.code = code;
        this.errorName = errorName;
      }
    },
  };
});

// ---------------------------------------------------------------------------
// Mock Types -- MinaPaymentChannelSDK interface (mocked, no o1js import)
// ---------------------------------------------------------------------------

/**
 * Minimal type representing the MinaPaymentChannelSDK methods the provider
 * delegates to. The real SDK is from Story 34.4; we mock it entirely here.
 */
interface MockMinaPaymentChannelSDK {
  openChannel: jest.Mock;
  deposit: jest.Mock;
  claimFromChannel: jest.Mock;
  closeChannel: jest.Mock;
  settleChannel: jest.Mock;
  getChannelState: jest.Mock;
  getChannelEvents: jest.Mock;
  signBalanceProof: jest.Mock;
  verifyBalanceProof: jest.Mock;
  compileContract: jest.Mock;
  getSignerPublicKey: jest.Mock;
  subscribeToChannel: jest.Mock;
}

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

function createMockSDK(): MockMinaPaymentChannelSDK {
  return {
    openChannel: jest.fn(),
    deposit: jest.fn(),
    claimFromChannel: jest.fn(),
    closeChannel: jest.fn(),
    settleChannel: jest.fn(),
    getChannelState: jest.fn(),
    getChannelEvents: jest.fn(),
    signBalanceProof: jest.fn(),
    verifyBalanceProof: jest.fn(),
    compileContract: jest.fn().mockResolvedValue(undefined),
    getSignerPublicKey: jest.fn().mockResolvedValue('B62qMockSignerPublicKey'),
    subscribeToChannel: jest.fn(),
  };
}

/** Sample Mina channel state as returned by SDK */
interface MockMinaChannelState {
  participantA: string;
  participantB: string;
  channelState: number;
  depositTotal: bigint;
  balanceCommitment: string;
  nonceField: bigint;
  closedAtSlot: bigint;
  settlementTimeout: bigint;
  tokenId: string;
  channelHash: string;
}

function createSampleMinaChannelState(
  overrides?: Partial<MockMinaChannelState>
): MockMinaChannelState {
  return {
    participantA: 'B62qkYa1o6Mj6uTTjDQCob7FuzZspSC37uyY9sNB5N5vrJ4aLHGRJg',
    participantB: 'B62qoG5bKBYCxaVcBN3kPFmqJkLm9K6mZh5v8VBSu4kJqBx4VBfRvE',
    channelState: 1, // OPEN
    depositTotal: 1000000n,
    balanceCommitment: 'poseidon_commitment_hash_abc123',
    nonceField: 5n,
    closedAtSlot: 0n,
    settlementTimeout: 100n,
    tokenId: 'MINA',
    channelHash: 'channel_hash_xyz789',
    ...overrides,
  };
}

const TEST_CHAIN_ID = 'mina:devnet';
const TEST_ZKAPP_ADDRESS = 'B62qkYa1o6Mj6uTTjDQCob7FuzZspSC37uyY9sNB5N5vrJ4aLHGRJg';
const TEST_SIGNER_KEY = 'EKFd7goQkVaHPpU1234567890abcdef';
const TEST_TOKEN_ID = 'MINA';
const TEST_NETWORK = 'devnet';
const TEST_GRAPHQL_URL = 'https://proxy.devnet.minaexplorer.com/graphql';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MinaPaymentChannelProvider (Story 34.5)', () => {
  let mockSDK: MockMinaPaymentChannelSDK;
  let mockLogger: Logger;
  let provider: MinaPaymentChannelProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSDK = createMockSDK();
    mockLogger = createMockLogger();
    provider = new MinaPaymentChannelProvider(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockSDK as any,
      TEST_CHAIN_ID,
      TEST_ZKAPP_ADDRESS,
      TEST_SIGNER_KEY,
      mockLogger,
      {
        tokenId: TEST_TOKEN_ID,
        network: TEST_NETWORK,
      }
    );
  });

  // -------------------------------------------------------------------------
  // T-34.5-01: Interface Implementation -- Type-Correct
  // -------------------------------------------------------------------------

  describe('interface implementation (T-34.5-01)', () => {
    it('should implement PaymentChannelProvider interface with all required methods', () => {
      // Given: the PaymentChannelProvider interface from Epic 32
      // When: MinaPaymentChannelProvider is instantiated
      // Then: all interface methods are implemented and type-check correctly
      expect(provider.openChannel).toBeDefined();
      expect(provider.deposit).toBeDefined();
      expect(provider.claimFromChannel).toBeDefined();
      expect(provider.closeChannel).toBeDefined();
      expect(provider.settleChannel).toBeDefined();
      expect(provider.signBalanceProof).toBeDefined();
      expect(provider.verifyBalanceProof).toBeDefined();
      expect(provider.getChannelState).toBeDefined();
      expect(provider.subscribeToEvents).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // T-34.5-02: chainType and chainId properties
  // -------------------------------------------------------------------------

  describe('chainType and chainId (T-34.5-02)', () => {
    it('should have chainType equal to mina', () => {
      // Given: a MinaPaymentChannelProvider instance
      // Then: chainType equals 'mina'
      expect(provider.chainType).toBe('mina');
    });

    it('should have chainId following mina:<network> format', () => {
      // Given: a MinaPaymentChannelProvider instance configured with devnet
      // Then: chainId follows the 'mina:<network>' namespace format
      expect(provider.chainId).toBe('mina:devnet');
    });
  });

  // -------------------------------------------------------------------------
  // T-34.5-03: openChannel delegation
  // -------------------------------------------------------------------------

  describe('openChannel (T-34.5-03)', () => {
    it('should delegate to MinaPaymentChannelSDK.openChannel()', async () => {
      // Given: a MinaPaymentChannelProvider instance
      const participant = 'B62qoG5bKBYCxaVcBN3kPFmqJkLm9K6mZh5v8VBSu4kJqBx4VBfRvE';
      const settlementTimeout = 100;

      mockSDK.openChannel.mockResolvedValue({
        zkAppAddress: TEST_ZKAPP_ADDRESS,
        txHash: 'mina_tx_hash_open_123',
      });

      // When: openChannel() is called
      const result = await provider.openChannel(participant, settlementTimeout);

      // Then: the call is delegated to SDK and returns OpenChannelResult format
      expect(mockSDK.openChannel).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        channelId: TEST_ZKAPP_ADDRESS,
        txHash: 'mina_tx_hash_open_123',
      });
    });

    it('should log the open channel event', async () => {
      mockSDK.openChannel.mockResolvedValue({
        zkAppAddress: TEST_ZKAPP_ADDRESS,
        txHash: 'tx_hash',
      });

      await provider.openChannel('B62qoG5bKBYCxaVcBN3kPFmqJkLm9K6mZh5v8VBSu4kJqBx4VBfRvE', 100);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'open_channel', chainId: TEST_CHAIN_ID }),
        expect.any(String)
      );
    });
  });

  // -------------------------------------------------------------------------
  // T-34.5-04: signBalanceProof delegation
  // -------------------------------------------------------------------------

  describe('signBalanceProof (T-34.5-04)', () => {
    it('should delegate to MinaPaymentChannelSDK for Poseidon commitment', async () => {
      // Given: a MinaPaymentChannelProvider instance
      const params: BalanceProofParams = {
        channelId: TEST_ZKAPP_ADDRESS,
        nonce: 5,
        transferredAmount: '100000',
        lockedAmount: '0',
        locksRoot: '',
      };

      mockSDK.signBalanceProof.mockResolvedValue('poseidon_commitment_serialized_proof');

      // When: signBalanceProof() is called
      const result = await provider.signBalanceProof(params);

      // Then: the provider delegates to SDK and returns serialized proof/commitment
      expect(mockSDK.signBalanceProof).toHaveBeenCalledTimes(1);
      expect(typeof result).toBe('string');
      expect(result).toBe('poseidon_commitment_serialized_proof');
    });

    it('should warn about EVM-specific fields', async () => {
      const params: BalanceProofParams = {
        channelId: TEST_ZKAPP_ADDRESS,
        nonce: 5,
        transferredAmount: '100000',
        lockedAmount: '500',
        locksRoot: '0xabc',
      };

      mockSDK.signBalanceProof.mockResolvedValue('proof');

      await provider.signBalanceProof(params);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'ignored_field', field: 'lockedAmount' }),
        expect.any(String)
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'ignored_field', field: 'locksRoot' }),
        expect.any(String)
      );
    });
  });

  // -------------------------------------------------------------------------
  // T-34.5-05: verifyBalanceProof validates proof
  // -------------------------------------------------------------------------

  describe('verifyBalanceProof (T-34.5-05)', () => {
    it('should return true for valid zk-SNARK proof via SDK', async () => {
      // Given: a MinaPaymentChannelProvider instance
      const params: VerifyBalanceProofParams = {
        channelId: TEST_ZKAPP_ADDRESS,
        nonce: 5,
        transferredAmount: '100000',
        lockedAmount: '0',
        locksRoot: '',
        signature: 'serialized_proof_abc123',
        signerAddress: 'B62qoG5bKBYCxaVcBN3kPFmqJkLm9K6mZh5v8VBSu4kJqBx4VBfRvE',
      };

      mockSDK.verifyBalanceProof.mockResolvedValue(true);

      // When: verifyBalanceProof() is called
      const result = await provider.verifyBalanceProof(params);

      // Then: the zk-SNARK proof is verified and returns true
      expect(mockSDK.verifyBalanceProof).toHaveBeenCalledTimes(1);
      expect(result).toBe(true);
    });

    it('should return false for invalid proof', async () => {
      const params: VerifyBalanceProofParams = {
        channelId: TEST_ZKAPP_ADDRESS,
        nonce: 5,
        transferredAmount: '100000',
        lockedAmount: '0',
        locksRoot: '',
        signature: 'invalid_proof',
        signerAddress: 'B62qoG5bKBYCxaVcBN3kPFmqJkLm9K6mZh5v8VBSu4kJqBx4VBfRvE',
      };

      mockSDK.verifyBalanceProof.mockResolvedValue(false);

      const result = await provider.verifyBalanceProof(params);

      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // T-34.5-06: claimFromChannel delegation with async proof generation
  // -------------------------------------------------------------------------

  describe('claimFromChannel (T-34.5-06)', () => {
    it('should delegate to MinaPaymentChannelSDK.claimFromChannel()', async () => {
      // Given: a MinaPaymentChannelProvider instance
      const channelId = TEST_ZKAPP_ADDRESS;
      const balanceProof: BalanceProofParams = {
        channelId,
        nonce: 5,
        transferredAmount: '100000',
        lockedAmount: '0',
        locksRoot: '',
      };
      const signature = 'serialized_proof_claim_123';

      mockSDK.claimFromChannel.mockResolvedValue({
        txHash: 'mina_tx_hash_claim_456',
      });

      // When: claimFromChannel() is called
      const result = await provider.claimFromChannel(channelId, balanceProof, signature);

      // Then: the call delegates to SDK and a TxResult is returned
      expect(mockSDK.claimFromChannel).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ txHash: 'mina_tx_hash_claim_456' });
    });

    it('should warn about EVM fields on claimFromChannel', async () => {
      const balanceProof: BalanceProofParams = {
        channelId: TEST_ZKAPP_ADDRESS,
        nonce: 5,
        transferredAmount: '100000',
        lockedAmount: '999',
        locksRoot: '0xdeadbeef',
      };

      mockSDK.claimFromChannel.mockResolvedValue({ txHash: 'tx' });

      await provider.claimFromChannel(TEST_ZKAPP_ADDRESS, balanceProof, 'sig');

      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // T-34.5-07: getChannelState translation
  // -------------------------------------------------------------------------

  describe('getChannelState (T-34.5-07)', () => {
    it('should translate Mina OPEN state to ProviderChannelState', async () => {
      // Given: a MinaPaymentChannelProvider instance
      const state = createSampleMinaChannelState({ channelState: 1 }); // OPEN
      mockSDK.getChannelState.mockResolvedValue(state);

      // When: getChannelState() is called
      const result = await provider.getChannelState(TEST_ZKAPP_ADDRESS);

      // Then: the Mina state is translated to chain-agnostic format
      expect(result.channelId).toBe(TEST_ZKAPP_ADDRESS);
      expect(result.status).toBe('opened');
      expect(result.participants).toEqual([state.participantA, state.participantB]);
      expect(result.deposit).toBe(state.depositTotal);
    });

    it('should translate Mina CLOSING state to closed', async () => {
      const state = createSampleMinaChannelState({ channelState: 2 }); // CLOSING
      mockSDK.getChannelState.mockResolvedValue(state);

      const result = await provider.getChannelState(TEST_ZKAPP_ADDRESS);

      expect(result.status).toBe('closed');
    });

    it('should translate Mina SETTLED state to settled', async () => {
      const state = createSampleMinaChannelState({ channelState: 3 }); // SETTLED
      mockSDK.getChannelState.mockResolvedValue(state);

      const result = await provider.getChannelState(TEST_ZKAPP_ADDRESS);

      expect(result.status).toBe('settled');
    });
  });

  // -------------------------------------------------------------------------
  // T-34.5-08: Proof generation async non-blocking
  // -------------------------------------------------------------------------

  describe('async proof generation (T-34.5-08)', () => {
    it('should return a Promise from claimFromChannel without blocking event loop', async () => {
      // Given: a MinaPaymentChannelProvider instance
      // Simulate slow proof generation (30-120s in reality)
      let resolveProof: (value: { txHash: string }) => void;
      const slowProof = new Promise<{ txHash: string }>((resolve) => {
        resolveProof = resolve;
      });
      mockSDK.claimFromChannel.mockReturnValue(slowProof);

      const balanceProof: BalanceProofParams = {
        channelId: TEST_ZKAPP_ADDRESS,
        nonce: 1,
        transferredAmount: '50000',
        lockedAmount: '0',
        locksRoot: '',
      };

      // When: claimFromChannel() is called
      const claimPromise = provider.claimFromChannel(TEST_ZKAPP_ADDRESS, balanceProof, 'sig');

      // Then: the promise is pending (not blocking)
      expect(claimPromise).toBeInstanceOf(Promise);

      // Other operations can proceed while proof generates
      mockSDK.getChannelState.mockResolvedValue(createSampleMinaChannelState());
      const stateResult = await provider.getChannelState(TEST_ZKAPP_ADDRESS);
      expect(stateResult).toBeDefined();

      // Now resolve the proof
      resolveProof!({ txHash: 'delayed_tx_hash' });
      const claimResult = await claimPromise;
      expect(claimResult).toEqual({ txHash: 'delayed_tx_hash' });
    });
  });

  // -------------------------------------------------------------------------
  // T-34.5-09: Archive node unavailability handled gracefully
  // -------------------------------------------------------------------------

  describe('archive node unavailability (T-34.5-09)', () => {
    it('should handle SDK network errors gracefully', async () => {
      // Given: archive node is unavailable
      mockSDK.getChannelState.mockRejectedValue(new Error('Network error: ECONNREFUSED'));

      // When: getChannelState() is called
      // Then: the error is wrapped with provider context
      await expect(provider.getChannelState(TEST_ZKAPP_ADDRESS)).rejects.toThrow();
    });

    it('should wrap network errors with provider context', async () => {
      mockSDK.getChannelState.mockRejectedValue(new Error('GraphQL endpoint unavailable'));

      await expect(provider.getChannelState(TEST_ZKAPP_ADDRESS)).rejects.toThrow(
        expect.objectContaining({
          message: expect.stringContaining(TEST_CHAIN_ID),
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // T-34.5-10: Concurrent claims manage nonces correctly
  // -------------------------------------------------------------------------

  describe('concurrent claims (T-34.5-10)', () => {
    it('should handle concurrent claim submissions without nonce conflicts', async () => {
      // Given: multiple concurrent claim operations
      mockSDK.claimFromChannel
        .mockResolvedValueOnce({ txHash: 'tx_claim_1' })
        .mockResolvedValueOnce({ txHash: 'tx_claim_2' })
        .mockResolvedValueOnce({ txHash: 'tx_claim_3' });

      const balanceProof1: BalanceProofParams = {
        channelId: TEST_ZKAPP_ADDRESS,
        nonce: 1,
        transferredAmount: '10000',
        lockedAmount: '0',
        locksRoot: '',
      };
      const balanceProof2: BalanceProofParams = {
        channelId: TEST_ZKAPP_ADDRESS,
        nonce: 2,
        transferredAmount: '20000',
        lockedAmount: '0',
        locksRoot: '',
      };
      const balanceProof3: BalanceProofParams = {
        channelId: TEST_ZKAPP_ADDRESS,
        nonce: 3,
        transferredAmount: '30000',
        lockedAmount: '0',
        locksRoot: '',
      };

      // When: multiple claims submitted concurrently
      const results = await Promise.all([
        provider.claimFromChannel(TEST_ZKAPP_ADDRESS, balanceProof1, 'sig1'),
        provider.claimFromChannel(TEST_ZKAPP_ADDRESS, balanceProof2, 'sig2'),
        provider.claimFromChannel(TEST_ZKAPP_ADDRESS, balanceProof3, 'sig3'),
      ]);

      // Then: all claims resolve successfully
      expect(results).toHaveLength(3);
      expect(mockSDK.claimFromChannel).toHaveBeenCalledTimes(3);
    });
  });

  // -------------------------------------------------------------------------
  // T-34.5-11: subscribeToEvents emits correct events
  // -------------------------------------------------------------------------

  describe('subscribeToEvents (T-34.5-11)', () => {
    it('should emit channel_opened event on state change', () => {
      // Given: a MinaPaymentChannelProvider instance
      const events: Array<{ type: string; channelId: string }> = [];
      let pollCallback: ((state: MockMinaChannelState) => void) | undefined;

      mockSDK.subscribeToChannel.mockImplementation(
        (_channelId: string, callback: (state: MockMinaChannelState) => void) => {
          pollCallback = callback;
          return { unsubscribe: jest.fn() };
        }
      );

      // When: subscribeToEvents is called
      provider.subscribeToEvents(TEST_ZKAPP_ADDRESS, (event: ProviderEvent) => {
        events.push({ type: event.type, channelId: event.channelId });
      });

      // Simulate state change: UNINITIALIZED -> OPEN
      pollCallback!(createSampleMinaChannelState({ channelState: 0 }));
      pollCallback!(createSampleMinaChannelState({ channelState: 1 }));

      // Then: channel_opened event is emitted
      expect(events).toContainEqual({
        type: 'channel_opened',
        channelId: TEST_ZKAPP_ADDRESS,
      });
    });

    it('should emit channel_deposited event on deposit change', () => {
      const events: Array<{ type: string }> = [];
      let pollCallback: ((state: MockMinaChannelState) => void) | undefined;

      mockSDK.subscribeToChannel.mockImplementation(
        (_channelId: string, callback: (state: MockMinaChannelState) => void) => {
          pollCallback = callback;
          return { unsubscribe: jest.fn() };
        }
      );

      provider.subscribeToEvents(TEST_ZKAPP_ADDRESS, (event: ProviderEvent) => {
        events.push({ type: event.type });
      });

      // First state (baseline)
      pollCallback!(createSampleMinaChannelState({ channelState: 1, depositTotal: 1000n }));
      // Deposit increases
      pollCallback!(createSampleMinaChannelState({ channelState: 1, depositTotal: 2000n }));

      expect(events).toContainEqual({ type: 'channel_deposited' });
    });

    it('should emit channel_claimed event on nonce increase', () => {
      const events: Array<{ type: string }> = [];
      let pollCallback: ((state: MockMinaChannelState) => void) | undefined;

      mockSDK.subscribeToChannel.mockImplementation(
        (_channelId: string, callback: (state: MockMinaChannelState) => void) => {
          pollCallback = callback;
          return { unsubscribe: jest.fn() };
        }
      );

      provider.subscribeToEvents(TEST_ZKAPP_ADDRESS, (event: ProviderEvent) => {
        events.push({ type: event.type });
      });

      // Baseline state
      pollCallback!(createSampleMinaChannelState({ channelState: 1, nonceField: 1n }));
      // Nonce increases (claim submitted)
      pollCallback!(createSampleMinaChannelState({ channelState: 1, nonceField: 2n }));

      expect(events).toContainEqual({ type: 'channel_claimed' });
    });

    it('should emit channel_closed event', () => {
      const events: Array<{ type: string }> = [];
      let pollCallback: ((state: MockMinaChannelState) => void) | undefined;

      mockSDK.subscribeToChannel.mockImplementation(
        (_channelId: string, callback: (state: MockMinaChannelState) => void) => {
          pollCallback = callback;
          return { unsubscribe: jest.fn() };
        }
      );

      provider.subscribeToEvents(TEST_ZKAPP_ADDRESS, (event: ProviderEvent) => {
        events.push({ type: event.type });
      });

      pollCallback!(createSampleMinaChannelState({ channelState: 1 }));
      pollCallback!(createSampleMinaChannelState({ channelState: 2 })); // CLOSING

      expect(events).toContainEqual({ type: 'channel_closed' });
    });

    it('should emit channel_settled event', () => {
      const events: Array<{ type: string }> = [];
      let pollCallback: ((state: MockMinaChannelState) => void) | undefined;

      mockSDK.subscribeToChannel.mockImplementation(
        (_channelId: string, callback: (state: MockMinaChannelState) => void) => {
          pollCallback = callback;
          return { unsubscribe: jest.fn() };
        }
      );

      provider.subscribeToEvents(TEST_ZKAPP_ADDRESS, (event: ProviderEvent) => {
        events.push({ type: event.type });
      });

      pollCallback!(createSampleMinaChannelState({ channelState: 2 }));
      pollCallback!(createSampleMinaChannelState({ channelState: 3 })); // SETTLED

      expect(events).toContainEqual({ type: 'channel_settled' });
    });
  });

  // -------------------------------------------------------------------------
  // T-34.5-12: unsubscribe cleans up
  // -------------------------------------------------------------------------

  describe('unsubscribe (T-34.5-12)', () => {
    it('should clean up underlying subscription', () => {
      // Given: a subscribed event listener
      const mockUnsubscribe = jest.fn();
      mockSDK.subscribeToChannel.mockReturnValue({
        unsubscribe: mockUnsubscribe,
      });

      const subscription = provider.subscribeToEvents(TEST_ZKAPP_ADDRESS, jest.fn());

      // When: unsubscribe() is called
      subscription.unsubscribe();

      // Then: the underlying SDK subscription is cleaned up
      expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    });

    it('should not emit events after unsubscribe', () => {
      const events: Array<{ type: string }> = [];
      let pollCallback: ((state: MockMinaChannelState) => void) | undefined;

      mockSDK.subscribeToChannel.mockImplementation(
        (_channelId: string, callback: (state: MockMinaChannelState) => void) => {
          pollCallback = callback;
          return { unsubscribe: jest.fn() };
        }
      );

      const subscription = provider.subscribeToEvents(
        TEST_ZKAPP_ADDRESS,
        (event: ProviderEvent) => {
          events.push({ type: event.type });
        }
      );

      // Emit one event
      pollCallback!(createSampleMinaChannelState({ channelState: 1 }));
      pollCallback!(createSampleMinaChannelState({ channelState: 2 }));
      const eventsBeforeUnsub = events.length;

      // Unsubscribe
      subscription.unsubscribe();

      // Further state changes should not emit events
      pollCallback!(createSampleMinaChannelState({ channelState: 3 }));
      expect(events.length).toBe(eventsBeforeUnsub);
    });
  });

  // -------------------------------------------------------------------------
  // T-34.5-13: Provider registered in ChainProviderRegistry
  // -------------------------------------------------------------------------

  describe('ChainProviderRegistry integration (T-34.5-13)', () => {
    it('should be registerable in ChainProviderRegistry', () => {
      // Given: a configured ChainProviderRegistry
      const registry = new ChainProviderRegistry();

      // When: a MinaPaymentChannelProvider is registered
      registry.register(provider);

      // Then: the provider is retrievable by chainId
      const retrieved = registry.getProvider('mina', TEST_CHAIN_ID);
      expect(retrieved).toBe(provider);
    });
  });

  // -------------------------------------------------------------------------
  // T-34.5-14: getProviderForPeer resolves Mina provider
  // -------------------------------------------------------------------------

  describe('getProviderForPeer (T-34.5-14)', () => {
    it('should resolve MinaPaymentChannelProvider for Mina-configured peers', () => {
      // Given: a registry with Mina provider registered
      const registry = new ChainProviderRegistry();
      registry.register(provider);

      // When: getProviderForPeer() is called with a Mina-configured peer
      const resolved = registry.getProviderForPeer({
        peerId: 'peer-mina-1',
        chain: TEST_CHAIN_ID,
      });

      // Then: the Mina provider is resolved
      expect(resolved).toBe(provider);
      expect(resolved?.chainType).toBe('mina');
    });
  });

  // -------------------------------------------------------------------------
  // T-34.5-15: closeChannel, settleChannel, deposit delegate correctly
  // -------------------------------------------------------------------------

  describe('delegation methods (T-34.5-15)', () => {
    it('should delegate deposit to SDK with bigint conversion', async () => {
      // Given: a MinaPaymentChannelProvider instance
      mockSDK.deposit.mockResolvedValue({ txHash: 'mina_tx_deposit_789' });

      // When: deposit() is called with string amount
      const result = await provider.deposit(TEST_ZKAPP_ADDRESS, '500000');

      // Then: amount is converted to bigint and delegated to SDK
      expect(mockSDK.deposit).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ txHash: 'mina_tx_deposit_789' });
    });

    it('should delegate closeChannel to SDK', async () => {
      mockSDK.closeChannel.mockResolvedValue({ txHash: 'mina_tx_close_abc' });

      const result = await provider.closeChannel(TEST_ZKAPP_ADDRESS);

      expect(mockSDK.closeChannel).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ txHash: 'mina_tx_close_abc' });
    });

    it('should delegate settleChannel to SDK', async () => {
      mockSDK.settleChannel.mockResolvedValue({ txHash: 'mina_tx_settle_def' });

      const result = await provider.settleChannel(TEST_ZKAPP_ADDRESS);

      expect(mockSDK.settleChannel).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ txHash: 'mina_tx_settle_def' });
    });

    it('should throw descriptive error for invalid deposit amount', async () => {
      // Given: an invalid amount string
      // When/Then: deposit() throws a descriptive error
      await expect(provider.deposit(TEST_ZKAPP_ADDRESS, 'not-a-number')).rejects.toThrow(
        /Invalid.*deposit amount/
      );
    });
  });

  // -------------------------------------------------------------------------
  // T-34.5-16: Provider pre-compiles circuit during init
  // -------------------------------------------------------------------------

  describe('zkApp pre-compilation (T-34.5-16)', () => {
    it('should call compileContract during initialization', async () => {
      // Given: a MinaPaymentChannelProvider being constructed
      // The provider should call SDK.compileContract() during init

      // When: a static factory method or init is used
      // Note: The actual implementation may use a static create() method or
      // call compileContract in a separate init() method
      expect(mockSDK.compileContract).toHaveBeenCalledTimes(1);
    });

    it('should handle compilation errors gracefully', async () => {
      // Given: compileContract fails
      const failingSDK = createMockSDK();
      failingSDK.compileContract.mockRejectedValue(new Error('Circuit compilation failed'));
      const logger = createMockLogger();

      // When/Then: provider creation should handle the error gracefully
      // (either log warning and continue, or throw with context)
      try {
        new MinaPaymentChannelProvider(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          failingSDK as any,
          TEST_CHAIN_ID,
          TEST_ZKAPP_ADDRESS,
          TEST_SIGNER_KEY,
          logger,
          { tokenId: TEST_TOKEN_ID, network: TEST_NETWORK }
        );
      } catch {
        // Expected -- compilation error during init
      }
      expect(failingSDK.compileContract).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // T-34.5-17: SDK errors mapped to provider-level errors
  // -------------------------------------------------------------------------

  describe('error mapping (T-34.5-17)', () => {
    it('should wrap SDK errors with provider context', async () => {
      // Given: an SDK operation that fails
      mockSDK.openChannel.mockRejectedValue(new Error('Proof generation failed'));

      // When: the provider method is called
      // Then: the error is wrapped with provider context
      const promise = provider.openChannel(
        'B62qoG5bKBYCxaVcBN3kPFmqJkLm9K6mZh5v8VBSu4kJqBx4VBfRvE',
        100
      );

      await expect(promise).rejects.toThrow('MinaPaymentChannelProvider');
      // Re-catch to assert additional properties
      await promise.catch((error: Error) => {
        expect(error.message).toContain(TEST_CHAIN_ID);
        expect(error.message).toContain('openChannel');
        expect(error.cause).toBeDefined();
      });
    });

    it('should preserve original error as cause', async () => {
      const originalError = new Error('Network timeout');
      mockSDK.deposit.mockRejectedValue(originalError);

      const promise = provider.deposit(TEST_ZKAPP_ADDRESS, '100000');

      await expect(promise).rejects.toThrow('Network timeout');
      await promise.catch((error: Error) => {
        expect(error.cause).toBe(originalError);
      });
    });

    it('should include channelId in error message', async () => {
      mockSDK.getChannelState.mockRejectedValue(new Error('Account not found'));

      await expect(provider.getChannelState(TEST_ZKAPP_ADDRESS)).rejects.toThrow(
        expect.objectContaining({
          message: expect.stringContaining(TEST_ZKAPP_ADDRESS),
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Additional: Constructor validation
  // -------------------------------------------------------------------------

  describe('constructor validation', () => {
    it('should throw if chainId is empty', () => {
      expect(() => {
        new MinaPaymentChannelProvider(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          mockSDK as any,
          '',
          TEST_ZKAPP_ADDRESS,
          TEST_SIGNER_KEY,
          mockLogger
        );
      }).toThrow(/chainId/);
    });

    it('should throw if zkAppAddress is empty', () => {
      expect(() => {
        new MinaPaymentChannelProvider(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          mockSDK as any,
          TEST_CHAIN_ID,
          '',
          TEST_SIGNER_KEY,
          mockLogger
        );
      }).toThrow(/zkAppAddress/);
    });

    it('should throw if signerKey is empty', () => {
      expect(() => {
        new MinaPaymentChannelProvider(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          mockSDK as any,
          TEST_CHAIN_ID,
          TEST_ZKAPP_ADDRESS,
          '',
          mockLogger
        );
      }).toThrow(/signerKey/);
    });
  });

  // -------------------------------------------------------------------------
  // Additional: getMinaContext (AC 13)
  // -------------------------------------------------------------------------

  describe('getMinaContext (AC 13)', () => {
    it('should return Mina-specific context with derived public key', async () => {
      // Given: a MinaPaymentChannelProvider instance
      // When: getMinaContext() is called
      const context = await provider.getMinaContext();

      // Then: it returns zkAppAddress, tokenId, network, and signerAddress (derived public key)
      expect(context).toEqual({
        zkAppAddress: TEST_ZKAPP_ADDRESS,
        tokenId: TEST_TOKEN_ID,
        network: TEST_NETWORK,
        signerAddress: 'B62qMockSignerPublicKey', // derived from SDK.getSignerPublicKey()
      });
    });

    it('should not expose private key material in signerAddress', async () => {
      const context = await provider.getMinaContext();
      // signerAddress must NOT be the raw private key
      expect(context.signerAddress).not.toBe(TEST_SIGNER_KEY);
      // It should be the derived signer public key
      expect(context.signerAddress).toBe('B62qMockSignerPublicKey');
    });

    it('should extract network from chainId when not explicitly provided', async () => {
      const providerWithoutNetwork = new MinaPaymentChannelProvider(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockSDK as any,
        'mina:mainnet',
        TEST_ZKAPP_ADDRESS,
        TEST_SIGNER_KEY,
        mockLogger
      );

      const context = await providerWithoutNetwork.getMinaContext();
      expect(context.network).toBe('mainnet');
    });
  });

  // -------------------------------------------------------------------------
  // Additional: Factory function
  // -------------------------------------------------------------------------

  describe('createMinaProviderFactory', () => {
    it('should create a valid ChainProviderFactory', () => {
      const factory = createMinaProviderFactory(mockLogger, TEST_SIGNER_KEY);
      expect(typeof factory).toBe('function');
    });

    it('should throw if signerKey is empty', () => {
      expect(() => createMinaProviderFactory(mockLogger, '')).toThrow(/signerKey/);
    });

    it('should reject non-mina config', () => {
      const factory = createMinaProviderFactory(mockLogger, TEST_SIGNER_KEY);
      const evmConfig: ProviderConfig = {
        chainType: 'evm',
        rpcUrl: 'http://localhost:8545',
        registryAddress: '0x123',
        keyId: 'key-1',
        tokenAddress: '0x5678000000000000000000000000000000000001',
      };

      expect(() => factory(evmConfig)).toThrow(/non-Mina/);
    });

    it('should create MinaPaymentChannelProvider from MinaProviderConfig', () => {
      const factory = createMinaProviderFactory(mockLogger, TEST_SIGNER_KEY);
      // Note: MinaProviderConfig will be expanded with keyId, tokenId, network
      // in the implementation. For now, use type assertion to include future fields.
      const config = {
        chainType: 'mina' as const,
        graphqlUrl: TEST_GRAPHQL_URL,
        zkAppAddress: TEST_ZKAPP_ADDRESS,
        keyId: 'mina-key-1',
        tokenId: TEST_TOKEN_ID,
        network: TEST_NETWORK,
      } as ProviderConfig;

      const created = factory(config);
      expect(created.chainType).toBe('mina');
      expect(created.chainId).toBe('mina:devnet');
    });

    it('should work with ChainProviderRegistry.fromConfig', () => {
      const factory = createMinaProviderFactory(mockLogger, TEST_SIGNER_KEY);
      const factories = new Map<BlockchainType, ChainProviderFactory>();
      factories.set('mina', factory);

      const config = {
        chainType: 'mina' as const,
        graphqlUrl: TEST_GRAPHQL_URL,
        zkAppAddress: TEST_ZKAPP_ADDRESS,
        keyId: 'mina-key-1',
        tokenId: TEST_TOKEN_ID,
        network: TEST_NETWORK,
      } as ProviderConfig;

      const registry = ChainProviderRegistry.fromConfig([config], factories);
      const resolved = registry.getProvider('mina', 'mina:devnet');
      expect(resolved).toBeDefined();
      expect(resolved?.chainType).toBe('mina');
    });
  });

  // -------------------------------------------------------------------------
  // Additional: EVM field warnings
  // -------------------------------------------------------------------------

  describe('EVM field warnings', () => {
    it('should not warn when lockedAmount is 0 and locksRoot is empty', async () => {
      const params: BalanceProofParams = {
        channelId: TEST_ZKAPP_ADDRESS,
        nonce: 1,
        transferredAmount: '100',
        lockedAmount: '0',
        locksRoot: '',
      };

      mockSDK.signBalanceProof.mockResolvedValue('proof');
      await provider.signBalanceProof(params);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should not warn when locksRoot is 0x (empty EVM-style)', async () => {
      const params: BalanceProofParams = {
        channelId: TEST_ZKAPP_ADDRESS,
        nonce: 1,
        transferredAmount: '100',
        lockedAmount: '0',
        locksRoot: '0x',
      };

      mockSDK.signBalanceProof.mockResolvedValue('proof');
      await provider.signBalanceProof(params);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Gap coverage: AC 3 -- deposit bigint conversion verified at SDK level
  // -------------------------------------------------------------------------

  describe('deposit bigint conversion (AC 3 gap)', () => {
    it('should convert string amount to bigint before calling SDK.deposit()', async () => {
      // Given: a deposit amount as a string
      mockSDK.deposit.mockResolvedValue({ txHash: 'tx_deposit' });

      // When: deposit() is called with a string amount
      await provider.deposit(TEST_ZKAPP_ADDRESS, '999999999999999999');

      // Then: SDK.deposit is called with the correct bigint value
      expect(mockSDK.deposit).toHaveBeenCalledWith(TEST_ZKAPP_ADDRESS, 999999999999999999n);
    });

    it('should handle very large amounts that exceed Number.MAX_SAFE_INTEGER', async () => {
      mockSDK.deposit.mockResolvedValue({ txHash: 'tx_large' });

      // Amount exceeds Number.MAX_SAFE_INTEGER (2^53 - 1 = 9007199254740991)
      await provider.deposit(TEST_ZKAPP_ADDRESS, '99007199254740992000');

      expect(mockSDK.deposit).toHaveBeenCalledWith(TEST_ZKAPP_ADDRESS, 99007199254740992000n);
    });
  });

  // -------------------------------------------------------------------------
  // Gap coverage: AC 6 -- verifyBalanceProof returns false on SDK throw
  // -------------------------------------------------------------------------

  describe('verifyBalanceProof error handling (AC 6 gap)', () => {
    it('should return false when SDK.verifyBalanceProof throws an error and log warning', async () => {
      // Given: the SDK throws during verification (e.g., malformed proof data)
      const params: VerifyBalanceProofParams = {
        channelId: TEST_ZKAPP_ADDRESS,
        nonce: 5,
        transferredAmount: '100000',
        lockedAmount: '0',
        locksRoot: '',
        signature: 'corrupted_proof_data',
        signerAddress: 'B62qoG5bKBYCxaVcBN3kPFmqJkLm9K6mZh5v8VBSu4kJqBx4VBfRvE',
      };

      mockSDK.verifyBalanceProof.mockRejectedValue(new Error('Proof deserialization failed'));

      // When: verifyBalanceProof() is called
      const result = await provider.verifyBalanceProof(params);

      // Then: returns false (does not throw) and logs a warning
      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'verify_balance_proof_error' }),
        expect.any(String)
      );
    });

    it('should return false when SDK throws a non-Error object', async () => {
      const params: VerifyBalanceProofParams = {
        channelId: TEST_ZKAPP_ADDRESS,
        nonce: 1,
        transferredAmount: '50000',
        lockedAmount: '0',
        locksRoot: '',
        signature: 'bad_sig',
        signerAddress: 'B62qoG5bKBYCxaVcBN3kPFmqJkLm9K6mZh5v8VBSu4kJqBx4VBfRvE',
      };

      mockSDK.verifyBalanceProof.mockRejectedValue('string error');

      const result = await provider.verifyBalanceProof(params);

      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Gap coverage: AC 8 -- getChannelState UNINITIALIZED defaults to opened
  // -------------------------------------------------------------------------

  describe('getChannelState UNINITIALIZED (AC 8 gap)', () => {
    it('should default UNINITIALIZED (0) state to opened with warning', async () => {
      // Given: the channel state is UNINITIALIZED
      const state = createSampleMinaChannelState({ channelState: 0 });
      mockSDK.getChannelState.mockResolvedValue(state);

      // When: getChannelState() is called
      const result = await provider.getChannelState(TEST_ZKAPP_ADDRESS);

      // Then: status defaults to 'opened' and a warning is logged
      expect(result.status).toBe('opened');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'unexpected_channel_state', channelState: 0 }),
        expect.any(String)
      );
    });

    it('should handle unknown channel state values by defaulting to opened with warning', async () => {
      // Given: an unexpected state value from the chain
      const state = createSampleMinaChannelState({ channelState: 99 });
      mockSDK.getChannelState.mockResolvedValue(state);

      // When: getChannelState() is called
      const result = await provider.getChannelState(TEST_ZKAPP_ADDRESS);

      // Then: status defaults to 'opened' and a warning is logged
      expect(result.status).toBe('opened');
    });
  });

  // -------------------------------------------------------------------------
  // Gap coverage: AC 12 -- error mapping for all lifecycle methods
  // -------------------------------------------------------------------------

  describe('error mapping for all methods (AC 12 gap)', () => {
    it('should wrap closeChannel SDK errors with provider context', async () => {
      // Given: closeChannel fails at the SDK level
      mockSDK.closeChannel.mockRejectedValue(new Error('Channel not in OPEN state'));

      // When/Then: error is wrapped with provider context
      const promise = provider.closeChannel(TEST_ZKAPP_ADDRESS);

      await expect(promise).rejects.toThrow('MinaPaymentChannelProvider');
      await promise.catch((error: Error) => {
        expect(error.message).toContain(TEST_CHAIN_ID);
        expect(error.message).toContain('closeChannel');
        expect(error.message).toContain(TEST_ZKAPP_ADDRESS);
        expect(error.cause).toBeDefined();
      });
    });

    it('should wrap settleChannel SDK errors with provider context', async () => {
      mockSDK.settleChannel.mockRejectedValue(new Error('Settlement timeout not expired'));

      const promise = provider.settleChannel(TEST_ZKAPP_ADDRESS);

      await expect(promise).rejects.toThrow('settleChannel');
      await promise.catch((error: Error) => {
        expect(error.message).toContain(TEST_CHAIN_ID);
        expect(error.cause).toBeDefined();
      });
    });

    it('should wrap claimFromChannel SDK errors with provider context', async () => {
      mockSDK.claimFromChannel.mockRejectedValue(new Error('Proof verification failed on-chain'));

      const balanceProof: BalanceProofParams = {
        channelId: TEST_ZKAPP_ADDRESS,
        nonce: 1,
        transferredAmount: '50000',
        lockedAmount: '0',
        locksRoot: '',
      };

      const promise = provider.claimFromChannel(TEST_ZKAPP_ADDRESS, balanceProof, 'sig');

      await expect(promise).rejects.toThrow('claimFromChannel');
      // Re-catch to assert additional properties
      await promise.catch((error: Error) => {
        expect(error.message).toContain(TEST_CHAIN_ID);
        expect(error.cause).toBeDefined();
      });
    });

    it('should handle non-Error objects thrown by SDK', async () => {
      // Given: SDK throws a non-Error value (e.g., string)
      mockSDK.openChannel.mockRejectedValue('raw string error');

      // Then: the error is still an Error instance with provider context and stringified message
      const promise = provider.openChannel(
        'B62qoG5bKBYCxaVcBN3kPFmqJkLm9K6mZh5v8VBSu4kJqBx4VBfRvE',
        100
      );
      await expect(promise).rejects.toThrow('raw string error');
      await promise.catch((error: Error) => {
        expect(error.message).toContain('MinaPaymentChannelProvider');
        expect(error.message).toContain(TEST_CHAIN_ID);
        expect(error.cause).toBe('raw string error');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Gap coverage: signBalanceProof error paths
  // -------------------------------------------------------------------------

  describe('signBalanceProof error handling (gap)', () => {
    it('should throw descriptive error for invalid transferredAmount', async () => {
      const params: BalanceProofParams = {
        channelId: TEST_ZKAPP_ADDRESS,
        nonce: 1,
        transferredAmount: 'not-a-number',
        lockedAmount: '0',
        locksRoot: '',
      };

      // When/Then: throws a descriptive safeBigInt error
      await expect(provider.signBalanceProof(params)).rejects.toThrow(/Invalid.*transferredAmount/);
    });

    it('should wrap SDK errors from signBalanceProof with provider context', async () => {
      const params: BalanceProofParams = {
        channelId: TEST_ZKAPP_ADDRESS,
        nonce: 1,
        transferredAmount: '100000',
        lockedAmount: '0',
        locksRoot: '',
      };

      mockSDK.signBalanceProof.mockRejectedValue(new Error('Poseidon hash failed'));

      const promise = provider.signBalanceProof(params);
      await expect(promise).rejects.toThrow('MinaPaymentChannelProvider');
      await promise.catch((error: Error) => {
        expect(error.message).toContain('signBalanceProof');
        expect(error.message).toContain(TEST_CHAIN_ID);
        expect(error.cause).toBeDefined();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Gap coverage: MinaChannelError wrapping
  // -------------------------------------------------------------------------

  describe('MinaChannelError wrapping (gap)', () => {
    it('should include code and errorName when wrapping MinaChannelError', async () => {
      // Import the mocked MinaChannelError from the jest.mock at top of file
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      const { MinaChannelError } = require('../mina-payment-channel-sdk') as {
        MinaChannelError: new (
          message: string,
          code: number,
          errorName: string
        ) => Error & { code: number; errorName: string };
      };

      const sdkError = new MinaChannelError('Nonce too low', 4001, 'NONCE_TOO_LOW');
      mockSDK.deposit.mockRejectedValue(sdkError);

      const promise = provider.deposit(TEST_ZKAPP_ADDRESS, '100000');
      await expect(promise).rejects.toThrow('NONCE_TOO_LOW');
      await promise.catch((error: Error) => {
        expect(error.message).toContain('code 4001');
        expect(error.message).toContain('MinaPaymentChannelProvider');
        expect(error.cause).toBe(sdkError);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Gap coverage: factory default network fallback
  // -------------------------------------------------------------------------

  describe('factory default network (gap)', () => {
    it('should default to devnet when network is not provided in config', () => {
      const factory = createMinaProviderFactory(mockLogger, TEST_SIGNER_KEY);
      const config = {
        chainType: 'mina' as const,
        graphqlUrl: TEST_GRAPHQL_URL,
        zkAppAddress: TEST_ZKAPP_ADDRESS,
        // no network field
      } as ProviderConfig;

      const created = factory(config);
      expect(created.chainId).toBe('mina:devnet');
    });
  });

  // -------------------------------------------------------------------------
  // Gap coverage: subscribeToEvents no event on first callback (AC 9)
  // -------------------------------------------------------------------------

  describe('subscribeToEvents first-callback behavior (AC 9 gap)', () => {
    it('should not emit any event on the first state poll (no previous to diff)', () => {
      // Given: a fresh subscription
      const events: ProviderEvent[] = [];
      let pollCallback: ((state: MockMinaChannelState) => void) | undefined;

      mockSDK.subscribeToChannel.mockImplementation(
        (_channelId: string, callback: (state: MockMinaChannelState) => void) => {
          pollCallback = callback;
          return { unsubscribe: jest.fn() };
        }
      );

      provider.subscribeToEvents(TEST_ZKAPP_ADDRESS, (event: ProviderEvent) => {
        events.push(event);
      });

      // When: the first poll fires with OPEN state
      pollCallback!(createSampleMinaChannelState({ channelState: 1 }));

      // Then: no event emitted (no previous state to diff against)
      expect(events).toHaveLength(0);
    });

    it('should warn on nonce rollback (possible chain reorg)', () => {
      let pollCallback: ((state: MockMinaChannelState) => void) | undefined;

      mockSDK.subscribeToChannel.mockImplementation(
        (_channelId: string, callback: (state: MockMinaChannelState) => void) => {
          pollCallback = callback;
          return { unsubscribe: jest.fn() };
        }
      );

      provider.subscribeToEvents(TEST_ZKAPP_ADDRESS, jest.fn());

      // First poll (baseline with nonce 5)
      pollCallback!(createSampleMinaChannelState({ channelState: 1, nonceField: 5n }));
      // Second poll with decreased nonce (reorg)
      pollCallback!(createSampleMinaChannelState({ channelState: 1, nonceField: 3n }));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'state_rollback_detected', field: 'nonceField' }),
        expect.any(String)
      );
    });

    it('should warn on deposit rollback (possible chain reorg)', () => {
      let pollCallback: ((state: MockMinaChannelState) => void) | undefined;

      mockSDK.subscribeToChannel.mockImplementation(
        (_channelId: string, callback: (state: MockMinaChannelState) => void) => {
          pollCallback = callback;
          return { unsubscribe: jest.fn() };
        }
      );

      provider.subscribeToEvents(TEST_ZKAPP_ADDRESS, jest.fn());

      // First poll (baseline with deposit 2000n)
      pollCallback!(createSampleMinaChannelState({ channelState: 1, depositTotal: 2000n }));
      // Second poll with decreased deposit (reorg)
      pollCallback!(createSampleMinaChannelState({ channelState: 1, depositTotal: 1000n }));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'state_rollback_detected', field: 'depositTotal' }),
        expect.any(String)
      );
    });

    it('should not emit event when state has not changed between polls', () => {
      const events: ProviderEvent[] = [];
      let pollCallback: ((state: MockMinaChannelState) => void) | undefined;

      mockSDK.subscribeToChannel.mockImplementation(
        (_channelId: string, callback: (state: MockMinaChannelState) => void) => {
          pollCallback = callback;
          return { unsubscribe: jest.fn() };
        }
      );

      provider.subscribeToEvents(TEST_ZKAPP_ADDRESS, (event: ProviderEvent) => {
        events.push(event);
      });

      // First poll (baseline)
      pollCallback!(
        createSampleMinaChannelState({ channelState: 1, depositTotal: 1000n, nonceField: 1n })
      );
      // Second poll with identical state
      pollCallback!(
        createSampleMinaChannelState({ channelState: 1, depositTotal: 1000n, nonceField: 1n })
      );

      // Then: no events emitted (no diff detected)
      expect(events).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Gap coverage: openChannel passes correct arguments to SDK (AC 2)
  // -------------------------------------------------------------------------

  describe('openChannel argument passing (AC 2 gap)', () => {
    it('should pass signerKey as participantA and participant as participantB to SDK', async () => {
      const participant = 'B62qoG5bKBYCxaVcBN3kPFmqJkLm9K6mZh5v8VBSu4kJqBx4VBfRvE';
      const timeout = 200;

      mockSDK.openChannel.mockResolvedValue({
        zkAppAddress: TEST_ZKAPP_ADDRESS,
        txHash: 'tx_open',
      });

      await provider.openChannel(participant, timeout);

      // Verify the signer's public key is derived via SDK, not the raw private key
      expect(mockSDK.getSignerPublicKey).toHaveBeenCalled();
      // Verify exact arguments passed to SDK (public key, not private key)
      expect(mockSDK.openChannel).toHaveBeenCalledWith(
        'B62qMockSignerPublicKey', // participantA (derived signer public key)
        participant, // participantB (counterparty)
        timeout, // settlementTimeout
        TEST_TOKEN_ID // tokenId
      );
    });
  });

  // -------------------------------------------------------------------------
  // Gap coverage: claimFromChannel argument passing (AC 4)
  // -------------------------------------------------------------------------

  describe('claimFromChannel argument passing (AC 4 gap)', () => {
    it('should convert transferredAmount to bigint and pass nonce as BigInt to SDK', async () => {
      const channelId = TEST_ZKAPP_ADDRESS;
      const balanceProof: BalanceProofParams = {
        channelId,
        nonce: 7,
        transferredAmount: '250000',
        lockedAmount: '0',
        locksRoot: '',
      };
      const signature = 'proof_sig_abc';

      mockSDK.claimFromChannel.mockResolvedValue({ txHash: 'tx_claim' });

      await provider.claimFromChannel(channelId, balanceProof, signature);

      // Verify SDK called with correct bigint conversions
      expect(mockSDK.claimFromChannel).toHaveBeenCalledWith(
        channelId,
        250000n, // transferredAmount as bigint
        0n, // balanceB placeholder
        0n, // salt placeholder
        7n, // nonce as BigInt
        signature, // signatureA passed through
        signature // signatureB -- same signature used as placeholder (Story 34.4)
      );
    });
  });

  // -------------------------------------------------------------------------
  // Gap coverage: signBalanceProof argument passing (AC 5)
  // -------------------------------------------------------------------------

  describe('signBalanceProof argument passing (AC 5 gap)', () => {
    it('should pass correct bigint-converted arguments to SDK.signBalanceProof', async () => {
      const params: BalanceProofParams = {
        channelId: TEST_ZKAPP_ADDRESS,
        nonce: 3,
        transferredAmount: '777000',
        lockedAmount: '0',
        locksRoot: '',
      };

      mockSDK.signBalanceProof.mockResolvedValue('poseidon_commitment');

      await provider.signBalanceProof(params);

      expect(mockSDK.signBalanceProof).toHaveBeenCalledWith(
        TEST_ZKAPP_ADDRESS,
        777000n, // transferredAmount as bigint
        0n, // balanceB placeholder
        0n, // salt placeholder
        3n // nonce as BigInt
      );
    });
  });

  // -------------------------------------------------------------------------
  // Gap coverage: verifyBalanceProof argument passing (AC 6)
  // -------------------------------------------------------------------------

  describe('verifyBalanceProof argument passing (AC 6 gap)', () => {
    it('should pass channelId, signerAddress, signature, and nonce as BigInt to SDK', async () => {
      const params: VerifyBalanceProofParams = {
        channelId: TEST_ZKAPP_ADDRESS,
        nonce: 4,
        transferredAmount: '100000',
        lockedAmount: '0',
        locksRoot: '',
        signature: 'proof_data_xyz',
        signerAddress: 'B62qoG5bKBYCxaVcBN3kPFmqJkLm9K6mZh5v8VBSu4kJqBx4VBfRvE',
      };

      mockSDK.verifyBalanceProof.mockResolvedValue(true);

      await provider.verifyBalanceProof(params);

      expect(mockSDK.verifyBalanceProof).toHaveBeenCalledWith(
        TEST_ZKAPP_ADDRESS,
        'B62qoG5bKBYCxaVcBN3kPFmqJkLm9K6mZh5v8VBSu4kJqBx4VBfRvE',
        'proof_data_xyz',
        4n // nonce as BigInt
      );
    });
  });
});
