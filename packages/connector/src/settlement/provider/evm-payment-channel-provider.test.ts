/**
 * Tests for EVMPaymentChannelProvider
 *
 * Covers:
 * - Type compliance — TypeScript compiles (T-32.3-01)
 * - chainType and chainId properties (T-32.3-02)
 * - openChannel delegation (T-32.3-03)
 * - signBalanceProof delegation (T-32.3-04)
 * - verifyBalanceProof delegation (T-32.3-05)
 * - subscribeToEvents forwarding (T-32.3-06)
 * - unsubscribe cleanup (T-32.3-07)
 * - getChannelState translation (T-32.3-08)
 * - claimFromChannel delegation (T-32.3-09)
 * - closeChannel and settleChannel delegation (T-32.3-10)
 * - deposit delegation (T-32.3-11)
 * - createEVMProviderFactory (T-32.3-13)
 *
 * Epic 32 Story 32.3
 *
 * @module evm-payment-channel-provider.test
 */

import type {
  ChannelState,
  BalanceProof,
  ChannelOpenedEvent,
  ChannelClosedEvent,
  ChannelSettledEvent,
  ChannelCooperativeSettledEvent,
} from '@toon-protocol/shared';
import type { Logger } from '../../utils/logger';
import type {
  PaymentChannelProvider,
  ProviderChannelState,
  ProviderEventCallback,
  ProviderEventSubscription,
  OpenChannelResult,
  TxResult,
  BalanceProofParams,
  VerifyBalanceProofParams,
  EVMProviderConfig,
} from './payment-channel-provider';
import type { ChainProviderFactory } from './chain-provider-registry';
import type { PaymentChannelSDK } from '../payment-channel-sdk';
import {
  EVMPaymentChannelProvider,
  createEVMProviderFactory,
} from './evm-payment-channel-provider';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/** Minimal mock of Logger using pino silent level equivalent */
function createMockLogger(): Logger {
  const noop = jest.fn();
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: jest.fn().mockReturnThis(),
    level: 'silent',
  } as unknown as Logger;
}

/**
 * Creates a mock PaymentChannelSDK with jest.fn() stubs for all methods
 * used by EVMPaymentChannelProvider.
 */
function createMockSDK(): jest.Mocked<
  Pick<
    PaymentChannelSDK,
    | 'openChannel'
    | 'deposit'
    | 'claimFromChannel'
    | 'closeChannel'
    | 'settleChannel'
    | 'signBalanceProof'
    | 'verifyBalanceProof'
    | 'getChannelState'
    | 'onChannelOpened'
    | 'onChannelClosed'
    | 'onChannelSettled'
    | 'onChannelCooperativeSettled'
    | 'removeAllListeners'
  >
> {
  return {
    openChannel: jest.fn(),
    deposit: jest.fn(),
    claimFromChannel: jest.fn(),
    closeChannel: jest.fn(),
    settleChannel: jest.fn(),
    signBalanceProof: jest.fn(),
    verifyBalanceProof: jest.fn(),
    getChannelState: jest.fn(),
    onChannelOpened: jest.fn(),
    onChannelClosed: jest.fn(),
    onChannelSettled: jest.fn(),
    onChannelCooperativeSettled: jest.fn(),
    removeAllListeners: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Global Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

// Constants used across tests
const CHAIN_ID = 'evm:8453';
const TOKEN_ADDRESS = '0xTokenAddress1234567890abcdef';
const CHANNEL_ID = '0xChannelId000000000000000000000000000000000000000000000000000001';
const PEER_ADDRESS = '0xPeerAddress1234567890abcdef1234567890abcdef';

function createProvider(sdk: ReturnType<typeof createMockSDK>): EVMPaymentChannelProvider {
  const logger = createMockLogger();
  return new EVMPaymentChannelProvider(
    sdk as unknown as PaymentChannelSDK,
    CHAIN_ID,
    TOKEN_ADDRESS,
    logger
  );
}

// ---------------------------------------------------------------------------
// T-32.3-01: TypeScript compile check
// ---------------------------------------------------------------------------

describe('EVMPaymentChannelProvider type compliance (T-32.3-01)', () => {
  it('should implement PaymentChannelProvider interface', () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    // Assignment proves structural compatibility at compile time
    const typedProvider: PaymentChannelProvider = provider;
    expect(typedProvider).toBeDefined();
    expect(typeof typedProvider.openChannel).toBe('function');
    expect(typeof typedProvider.deposit).toBe('function');
    expect(typeof typedProvider.claimFromChannel).toBe('function');
    expect(typeof typedProvider.closeChannel).toBe('function');
    expect(typeof typedProvider.settleChannel).toBe('function');
    expect(typeof typedProvider.signBalanceProof).toBe('function');
    expect(typeof typedProvider.verifyBalanceProof).toBe('function');
    expect(typeof typedProvider.getChannelState).toBe('function');
    expect(typeof typedProvider.subscribeToEvents).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// T-32.3-02: chainType and chainId
// ---------------------------------------------------------------------------

describe('chainType and chainId (T-32.3-02)', () => {
  it('should return chainType as evm', () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    expect(provider.chainType).toBe('evm');
  });

  it('should return the configured chainId', () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    expect(provider.chainId).toBe('evm:8453');
  });
});

// ---------------------------------------------------------------------------
// T-32.3-03: openChannel delegation
// ---------------------------------------------------------------------------

describe('openChannel delegation (T-32.3-03)', () => {
  it('should delegate to sdk.openChannel with tokenAddress and zero initialDeposit', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    const expectedResult = { channelId: CHANNEL_ID, txHash: '0xTxHash123' };
    sdk.openChannel.mockResolvedValue(expectedResult);

    const result: OpenChannelResult = await provider.openChannel(PEER_ADDRESS, 500);

    expect(sdk.openChannel).toHaveBeenCalledWith(PEER_ADDRESS, TOKEN_ADDRESS, 500, 0n);
    expect(result).toEqual({ channelId: CHANNEL_ID, txHash: '0xTxHash123' });
  });
});

// ---------------------------------------------------------------------------
// T-32.3-04: signBalanceProof delegation
// ---------------------------------------------------------------------------

describe('signBalanceProof delegation (T-32.3-04)', () => {
  it('should delegate to sdk.signBalanceProof converting string amounts to bigint', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    const expectedSignature = '0xSignature123abc';
    sdk.signBalanceProof.mockResolvedValue(expectedSignature);

    const params: BalanceProofParams = {
      channelId: CHANNEL_ID,
      nonce: 5,
      transferredAmount: '1000000000000000000',
      lockedAmount: '500000000000000000',
      locksRoot: '0xLocksRoot000000000000000000000000000000000000000000000000000001',
    };

    const result = await provider.signBalanceProof(params);

    expect(sdk.signBalanceProof).toHaveBeenCalledWith(
      CHANNEL_ID,
      5,
      BigInt('1000000000000000000'),
      BigInt('500000000000000000'),
      '0xLocksRoot000000000000000000000000000000000000000000000000000001'
    );
    expect(result).toBe('0xSignature123abc');
  });
});

// ---------------------------------------------------------------------------
// T-32.3-05: verifyBalanceProof delegation
// ---------------------------------------------------------------------------

describe('verifyBalanceProof delegation (T-32.3-05)', () => {
  it('should construct BalanceProof from params and delegate to sdk.verifyBalanceProof', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    sdk.verifyBalanceProof.mockResolvedValue(true);

    const params: VerifyBalanceProofParams = {
      channelId: CHANNEL_ID,
      nonce: 3,
      transferredAmount: '2000000000000000000',
      lockedAmount: '0',
      locksRoot: '0xLocksRoot000000000000000000000000000000000000000000000000000002',
      signature: '0xSignatureToVerify',
      signerAddress: '0xSignerAddress123',
    };

    const result = await provider.verifyBalanceProof(params);

    const expectedBalanceProof: BalanceProof = {
      channelId: CHANNEL_ID,
      nonce: 3,
      transferredAmount: BigInt('2000000000000000000'),
      lockedAmount: BigInt('0'),
      locksRoot: '0xLocksRoot000000000000000000000000000000000000000000000000000002',
    };
    expect(sdk.verifyBalanceProof).toHaveBeenCalledWith(
      expectedBalanceProof,
      '0xSignatureToVerify',
      '0xSignerAddress123'
    );
    expect(result).toBe(true);
  });

  it('should return false for invalid signatures', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    sdk.verifyBalanceProof.mockResolvedValue(false);

    const params: VerifyBalanceProofParams = {
      channelId: CHANNEL_ID,
      nonce: 1,
      transferredAmount: '100',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xInvalidSignature',
      signerAddress: '0xWrongSigner',
    };

    const result = await provider.verifyBalanceProof(params);

    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-32.3-06: subscribeToEvents forwarding
// ---------------------------------------------------------------------------

describe('subscribeToEvents forwarding (T-32.3-06)', () => {
  it('should return a ProviderEventSubscription with unsubscribe method', () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    sdk.onChannelOpened.mockResolvedValue(undefined);
    sdk.onChannelClosed.mockResolvedValue(undefined);
    sdk.onChannelSettled.mockResolvedValue(undefined);
    sdk.onChannelCooperativeSettled.mockResolvedValue(undefined);

    const callback: ProviderEventCallback = jest.fn();

    const subscription: ProviderEventSubscription = provider.subscribeToEvents(
      CHANNEL_ID,
      callback
    );

    expect(subscription).toBeDefined();
    expect(typeof subscription.unsubscribe).toBe('function');
  });

  it('should register SDK event listeners for all four event types', () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    sdk.onChannelOpened.mockResolvedValue(undefined);
    sdk.onChannelClosed.mockResolvedValue(undefined);
    sdk.onChannelSettled.mockResolvedValue(undefined);
    sdk.onChannelCooperativeSettled.mockResolvedValue(undefined);

    const callback: ProviderEventCallback = jest.fn();

    provider.subscribeToEvents(CHANNEL_ID, callback);

    expect(sdk.onChannelOpened).toHaveBeenCalledWith(TOKEN_ADDRESS, expect.any(Function));
    expect(sdk.onChannelClosed).toHaveBeenCalledWith(TOKEN_ADDRESS, expect.any(Function));
    expect(sdk.onChannelSettled).toHaveBeenCalledWith(TOKEN_ADDRESS, expect.any(Function));
    expect(sdk.onChannelCooperativeSettled).toHaveBeenCalledWith(
      TOKEN_ADDRESS,
      expect.any(Function)
    );
  });

  it('should forward ChannelOpened events matching channelId as ProviderEvent', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    let capturedCallback: ((event: ChannelOpenedEvent) => void) | undefined;
    sdk.onChannelOpened.mockImplementation(
      async (_tokenAddr: string, cb: (event: ChannelOpenedEvent) => void) => {
        capturedCallback = cb;
      }
    );
    sdk.onChannelClosed.mockResolvedValue(undefined);
    sdk.onChannelSettled.mockResolvedValue(undefined);
    sdk.onChannelCooperativeSettled.mockResolvedValue(undefined);

    const callback: ProviderEventCallback = jest.fn();
    provider.subscribeToEvents(CHANNEL_ID, callback);

    // Allow async registration to settle
    await new Promise((resolve) => setImmediate(resolve));

    // Fire a ChannelOpened event for the subscribed channelId
    expect(capturedCallback).toBeDefined();
    capturedCallback!({
      type: 'ChannelOpened',
      channelId: CHANNEL_ID,
      participant1: '0xParticipant1',
      participant2: PEER_ADDRESS,
      settlementTimeout: 500,
    });

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'channel_opened',
        channelId: CHANNEL_ID,
      })
    );
  });

  it('should filter out events for non-matching channelIds', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    let capturedCallback: ((event: ChannelOpenedEvent) => void) | undefined;
    sdk.onChannelOpened.mockImplementation(
      async (_tokenAddr: string, cb: (event: ChannelOpenedEvent) => void) => {
        capturedCallback = cb;
      }
    );
    sdk.onChannelClosed.mockResolvedValue(undefined);
    sdk.onChannelSettled.mockResolvedValue(undefined);
    sdk.onChannelCooperativeSettled.mockResolvedValue(undefined);

    const callback: ProviderEventCallback = jest.fn();
    provider.subscribeToEvents(CHANNEL_ID, callback);

    await new Promise((resolve) => setImmediate(resolve));

    // Fire an event for a DIFFERENT channelId
    capturedCallback!({
      type: 'ChannelOpened',
      channelId: '0xDifferentChannelId',
      participant1: '0xOther1',
      participant2: '0xOther2',
      settlementTimeout: 300,
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it('should forward ChannelClosed events matching channelId as ProviderEvent', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    let capturedCallback: ((event: ChannelClosedEvent) => void) | undefined;
    sdk.onChannelOpened.mockResolvedValue(undefined);
    sdk.onChannelClosed.mockImplementation(
      async (_tokenAddr: string, cb: (event: ChannelClosedEvent) => void) => {
        capturedCallback = cb;
      }
    );
    sdk.onChannelSettled.mockResolvedValue(undefined);
    sdk.onChannelCooperativeSettled.mockResolvedValue(undefined);

    const callback: ProviderEventCallback = jest.fn();
    provider.subscribeToEvents(CHANNEL_ID, callback);

    await new Promise((resolve) => setImmediate(resolve));

    expect(capturedCallback).toBeDefined();
    capturedCallback!({
      type: 'ChannelClosed',
      channelId: CHANNEL_ID,
      closingParticipant: PEER_ADDRESS,
      nonce: 5,
      balanceHash: '0xBalanceHash',
    });

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'channel_closed',
        channelId: CHANNEL_ID,
        data: expect.objectContaining({
          closingParticipant: PEER_ADDRESS,
        }),
      })
    );
  });

  it('should forward ChannelSettled events matching channelId as ProviderEvent', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    let capturedCallback: ((event: ChannelSettledEvent) => void) | undefined;
    sdk.onChannelOpened.mockResolvedValue(undefined);
    sdk.onChannelClosed.mockResolvedValue(undefined);
    sdk.onChannelSettled.mockImplementation(
      async (_tokenAddr: string, cb: (event: ChannelSettledEvent) => void) => {
        capturedCallback = cb;
      }
    );
    sdk.onChannelCooperativeSettled.mockResolvedValue(undefined);

    const callback: ProviderEventCallback = jest.fn();
    provider.subscribeToEvents(CHANNEL_ID, callback);

    await new Promise((resolve) => setImmediate(resolve));

    expect(capturedCallback).toBeDefined();
    capturedCallback!({
      type: 'ChannelSettled',
      channelId: CHANNEL_ID,
      participant1Amount: 1000000000000000000n,
      participant2Amount: 2000000000000000000n,
    });

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'channel_settled',
        channelId: CHANNEL_ID,
        data: expect.objectContaining({
          participant1Amount: '1000000000000000000',
          participant2Amount: '2000000000000000000',
        }),
      })
    );
  });

  it('should forward ChannelCooperativeSettled events as channel_settled with cooperative flag', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    let capturedCallback: ((event: ChannelCooperativeSettledEvent) => void) | undefined;
    sdk.onChannelOpened.mockResolvedValue(undefined);
    sdk.onChannelClosed.mockResolvedValue(undefined);
    sdk.onChannelSettled.mockResolvedValue(undefined);
    sdk.onChannelCooperativeSettled.mockImplementation(
      async (_tokenAddr: string, cb: (event: ChannelCooperativeSettledEvent) => void) => {
        capturedCallback = cb;
      }
    );

    const callback: ProviderEventCallback = jest.fn();
    provider.subscribeToEvents(CHANNEL_ID, callback);

    await new Promise((resolve) => setImmediate(resolve));

    expect(capturedCallback).toBeDefined();
    capturedCallback!({
      type: 'ChannelCooperativeSettled',
      channelId: CHANNEL_ID,
      participant1Amount: 500n,
      participant2Amount: 700n,
    });

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'channel_settled',
        channelId: CHANNEL_ID,
        data: expect.objectContaining({
          participant1Amount: '500',
          participant2Amount: '700',
          cooperative: true,
        }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// T-32.3-07: unsubscribe cleanup
// ---------------------------------------------------------------------------

describe('unsubscribe cleanup (T-32.3-07)', () => {
  it('should call sdk.removeAllListeners when unsubscribe is called', () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    sdk.onChannelOpened.mockResolvedValue(undefined);
    sdk.onChannelClosed.mockResolvedValue(undefined);
    sdk.onChannelSettled.mockResolvedValue(undefined);
    sdk.onChannelCooperativeSettled.mockResolvedValue(undefined);

    const callback: ProviderEventCallback = jest.fn();
    const subscription = provider.subscribeToEvents(CHANNEL_ID, callback);

    subscription.unsubscribe();

    expect(sdk.removeAllListeners).toHaveBeenCalled();
  });

  it('should stop forwarding events after unsubscribe', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    let capturedCallback: ((event: ChannelOpenedEvent) => void) | undefined;
    sdk.onChannelOpened.mockImplementation(
      async (_tokenAddr: string, cb: (event: ChannelOpenedEvent) => void) => {
        capturedCallback = cb;
      }
    );
    sdk.onChannelClosed.mockResolvedValue(undefined);
    sdk.onChannelSettled.mockResolvedValue(undefined);
    sdk.onChannelCooperativeSettled.mockResolvedValue(undefined);

    const callback: ProviderEventCallback = jest.fn();
    const subscription = provider.subscribeToEvents(CHANNEL_ID, callback);

    await new Promise((resolve) => setImmediate(resolve));

    // Unsubscribe first
    subscription.unsubscribe();

    // Then fire event — should NOT be forwarded
    capturedCallback!({
      type: 'ChannelOpened',
      channelId: CHANNEL_ID,
      participant1: '0xA',
      participant2: '0xB',
      settlementTimeout: 300,
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it('should log a warning when SDK event registration fails', async () => {
    const sdk = createMockSDK();
    const logger = createMockLogger();
    const provider = new EVMPaymentChannelProvider(
      sdk as unknown as PaymentChannelSDK,
      CHAIN_ID,
      TOKEN_ADDRESS,
      logger
    );

    sdk.onChannelOpened.mockRejectedValue(new Error('contract not found'));
    sdk.onChannelClosed.mockResolvedValue(undefined);
    sdk.onChannelSettled.mockResolvedValue(undefined);
    sdk.onChannelCooperativeSettled.mockResolvedValue(undefined);

    const callback: ProviderEventCallback = jest.fn();
    provider.subscribeToEvents(CHANNEL_ID, callback);

    // Allow async rejection to propagate through .catch()
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.warn).toHaveBeenCalledWith(
      'EVMPaymentChannelProvider: event registration failed',
      expect.objectContaining({
        eventName: 'ChannelOpened',
        error: 'contract not found',
      })
    );
  });
});

// ---------------------------------------------------------------------------
// T-32.3-08: getChannelState translation
// ---------------------------------------------------------------------------

describe('getChannelState translation (T-32.3-08)', () => {
  it('should translate EVM ChannelState to ProviderChannelState with correct deposit', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    const sdkChannelState: ChannelState = {
      channelId: CHANNEL_ID,
      participants: ['0xParticipant1', '0xParticipant2'],
      myDeposit: 1000000000000000000n,
      theirDeposit: 2000000000000000000n,
      myNonce: 3,
      theirNonce: 2,
      myTransferred: 500000000000000000n,
      theirTransferred: 300000000000000000n,
      status: 'opened',
      settlementTimeout: 500,
      openedAt: 1700000000,
    };
    sdk.getChannelState.mockResolvedValue(sdkChannelState);

    const result: ProviderChannelState = await provider.getChannelState(CHANNEL_ID);

    expect(sdk.getChannelState).toHaveBeenCalledWith(CHANNEL_ID, TOKEN_ADDRESS);
    expect(result.channelId).toBe(CHANNEL_ID);
    expect(result.status).toBe('opened');
    expect(result.participants).toEqual(['0xParticipant1', '0xParticipant2']);
    // deposit = myDeposit + theirDeposit
    expect(result.deposit).toBe(3000000000000000000n);
  });

  it('should translate closed channel state correctly', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    const sdkChannelState: ChannelState = {
      channelId: CHANNEL_ID,
      participants: ['0xA', '0xB'],
      myDeposit: 100n,
      theirDeposit: 200n,
      myNonce: 1,
      theirNonce: 1,
      myTransferred: 50n,
      theirTransferred: 30n,
      status: 'closed',
      settlementTimeout: 300,
      openedAt: 1700000000,
      closedAt: 1700001000,
    };
    sdk.getChannelState.mockResolvedValue(sdkChannelState);

    const result = await provider.getChannelState(CHANNEL_ID);

    expect(result.status).toBe('closed');
    expect(result.deposit).toBe(300n);
  });

  it('should copy participants array (no shared reference)', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    const originalParticipants: [string, string] = ['0xA', '0xB'];
    const sdkChannelState: ChannelState = {
      channelId: CHANNEL_ID,
      participants: originalParticipants,
      myDeposit: 0n,
      theirDeposit: 0n,
      myNonce: 0,
      theirNonce: 0,
      myTransferred: 0n,
      theirTransferred: 0n,
      status: 'settled',
      settlementTimeout: 100,
      openedAt: 1700000000,
    };
    sdk.getChannelState.mockResolvedValue(sdkChannelState);

    const result = await provider.getChannelState(CHANNEL_ID);

    expect(result.participants).toEqual(['0xA', '0xB']);
    expect(result.participants).not.toBe(originalParticipants);
  });
});

// ---------------------------------------------------------------------------
// T-32.3-09: claimFromChannel delegation
// ---------------------------------------------------------------------------

describe('claimFromChannel delegation (T-32.3-09)', () => {
  it('should convert BalanceProofParams to BalanceProof and delegate to SDK', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    sdk.claimFromChannel.mockResolvedValue(undefined);

    const balanceProofParams: BalanceProofParams = {
      channelId: CHANNEL_ID,
      nonce: 7,
      transferredAmount: '5000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
    };
    const signature = '0xClaimSignature';

    const result: TxResult = await provider.claimFromChannel(
      CHANNEL_ID,
      balanceProofParams,
      signature
    );

    const expectedBalanceProof: BalanceProof = {
      channelId: CHANNEL_ID,
      nonce: 7,
      transferredAmount: BigInt('5000000000000000000'),
      lockedAmount: 0n,
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
    };
    expect(sdk.claimFromChannel).toHaveBeenCalledWith(
      CHANNEL_ID,
      TOKEN_ADDRESS,
      expectedBalanceProof,
      signature
    );

    expect(result).toHaveProperty('txHash');
    expect(typeof result.txHash).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// T-32.3-10: closeChannel and settleChannel delegation
// ---------------------------------------------------------------------------

describe('closeChannel and settleChannel delegation (T-32.3-10)', () => {
  it('should delegate closeChannel to SDK with tokenAddress', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    sdk.closeChannel.mockResolvedValue(undefined);

    const result: TxResult = await provider.closeChannel(CHANNEL_ID);

    expect(sdk.closeChannel).toHaveBeenCalledWith(CHANNEL_ID, TOKEN_ADDRESS);
    expect(result).toHaveProperty('txHash');
    expect(typeof result.txHash).toBe('string');
  });

  it('should delegate settleChannel to SDK with tokenAddress', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    sdk.settleChannel.mockResolvedValue(undefined);

    const result: TxResult = await provider.settleChannel(CHANNEL_ID);

    expect(sdk.settleChannel).toHaveBeenCalledWith(CHANNEL_ID, TOKEN_ADDRESS);
    expect(result).toHaveProperty('txHash');
    expect(typeof result.txHash).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// T-32.3-11: deposit delegation
// ---------------------------------------------------------------------------

describe('deposit delegation (T-32.3-11)', () => {
  it('should delegate deposit to SDK converting string amount to bigint', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    sdk.deposit.mockResolvedValue(undefined);

    const result: TxResult = await provider.deposit(CHANNEL_ID, '3000000000000000000');

    expect(sdk.deposit).toHaveBeenCalledWith(
      CHANNEL_ID,
      TOKEN_ADDRESS,
      BigInt('3000000000000000000')
    );
    expect(result).toHaveProperty('txHash');
    expect(typeof result.txHash).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// T-32.3-13: createEVMProviderFactory
// ---------------------------------------------------------------------------

describe('createEVMProviderFactory (T-32.3-13)', () => {
  it('should return a ChainProviderFactory function', () => {
    const sdk = createMockSDK();
    const logger = createMockLogger();

    const factory: ChainProviderFactory = createEVMProviderFactory(
      sdk as unknown as PaymentChannelSDK,
      logger
    );

    expect(typeof factory).toBe('function');
  });

  it('should create an EVMPaymentChannelProvider for EVM config', () => {
    const sdk = createMockSDK();
    const logger = createMockLogger();
    const factory = createEVMProviderFactory(sdk as unknown as PaymentChannelSDK, logger);

    const config: EVMProviderConfig = {
      chainType: 'evm',
      rpcUrl: 'https://mainnet.base.org',
      registryAddress: '0xRegistryAddress',
      keyId: '8453',
    };

    const provider: PaymentChannelProvider = factory(config);

    expect(provider).toBeInstanceOf(EVMPaymentChannelProvider);
    expect(provider.chainType).toBe('evm');
    expect(provider.chainId).toBe('evm:8453');
  });

  it('should throw for non-EVM config', () => {
    const sdk = createMockSDK();
    const logger = createMockLogger();
    const factory = createEVMProviderFactory(sdk as unknown as PaymentChannelSDK, logger);

    const solanaConfig = {
      chainType: 'solana' as const,
      rpcUrl: 'https://api.mainnet-beta.solana.com',
      programId: 'SolanaProgram123',
    };

    expect(() => factory(solanaConfig)).toThrow(/non-EVM/i);
  });

  it('should produce a provider that delegates to the original SDK', async () => {
    const sdk = createMockSDK();
    const logger = createMockLogger();
    const factory = createEVMProviderFactory(sdk as unknown as PaymentChannelSDK, logger);

    const config: EVMProviderConfig = {
      chainType: 'evm',
      rpcUrl: 'https://mainnet.base.org',
      registryAddress: '0xRegistryAddress',
      keyId: '8453',
    };

    const provider = factory(config);

    // Verify the provider uses registryAddress as tokenAddress placeholder
    // by checking that a delegation call passes it through
    sdk.closeChannel.mockResolvedValue(undefined);
    await provider.closeChannel(CHANNEL_ID);

    expect(sdk.closeChannel).toHaveBeenCalledWith(CHANNEL_ID, '0xRegistryAddress');
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

describe('error propagation from SDK', () => {
  it('should propagate SDK errors from openChannel', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    sdk.openChannel.mockRejectedValue(new Error('SDK: channel open failed'));

    await expect(provider.openChannel(PEER_ADDRESS, 500)).rejects.toThrow(
      'SDK: channel open failed'
    );
  });

  it('should propagate SDK errors from deposit', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    sdk.deposit.mockRejectedValue(new Error('SDK: deposit failed'));

    await expect(provider.deposit(CHANNEL_ID, '1000')).rejects.toThrow('SDK: deposit failed');
  });

  it('should propagate SDK errors from signBalanceProof', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    sdk.signBalanceProof.mockRejectedValue(new Error('SDK: signing failed'));

    const params: BalanceProofParams = {
      channelId: CHANNEL_ID,
      nonce: 1,
      transferredAmount: '100',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
    };

    await expect(provider.signBalanceProof(params)).rejects.toThrow('SDK: signing failed');
  });

  it('should propagate SDK errors from getChannelState', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    sdk.getChannelState.mockRejectedValue(new Error('SDK: state query failed'));

    await expect(provider.getChannelState(CHANNEL_ID)).rejects.toThrow('SDK: state query failed');
  });

  it('should propagate SDK errors from claimFromChannel', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    sdk.claimFromChannel.mockRejectedValue(new Error('SDK: claim failed'));

    const balanceProofParams: BalanceProofParams = {
      channelId: CHANNEL_ID,
      nonce: 1,
      transferredAmount: '100',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
    };

    await expect(
      provider.claimFromChannel(CHANNEL_ID, balanceProofParams, '0xSig')
    ).rejects.toThrow('SDK: claim failed');
  });

  it('should propagate SDK errors from closeChannel', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    sdk.closeChannel.mockRejectedValue(new Error('SDK: close failed'));

    await expect(provider.closeChannel(CHANNEL_ID)).rejects.toThrow('SDK: close failed');
  });

  it('should propagate SDK errors from settleChannel', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    sdk.settleChannel.mockRejectedValue(new Error('SDK: settle failed'));

    await expect(provider.settleChannel(CHANNEL_ID)).rejects.toThrow('SDK: settle failed');
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('input validation', () => {
  it('should throw if chainId is empty', () => {
    const sdk = createMockSDK();
    const logger = createMockLogger();

    expect(
      () =>
        new EVMPaymentChannelProvider(
          sdk as unknown as PaymentChannelSDK,
          '',
          TOKEN_ADDRESS,
          logger
        )
    ).toThrow('chainId must not be empty');
  });

  it('should throw if tokenAddress is empty', () => {
    const sdk = createMockSDK();
    const logger = createMockLogger();

    expect(
      () => new EVMPaymentChannelProvider(sdk as unknown as PaymentChannelSDK, CHAIN_ID, '', logger)
    ).toThrow('tokenAddress must not be empty');
  });

  it('should throw a descriptive error for non-numeric deposit amount', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    await expect(provider.deposit(CHANNEL_ID, 'not-a-number')).rejects.toThrow(
      /Invalid deposit amount.*not-a-number/
    );
  });

  it('should throw a descriptive error for non-numeric transferredAmount in signBalanceProof', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    const params: BalanceProofParams = {
      channelId: CHANNEL_ID,
      nonce: 1,
      transferredAmount: 'invalid',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
    };

    await expect(provider.signBalanceProof(params)).rejects.toThrow(
      /Invalid transferredAmount.*invalid/
    );
  });

  it('should throw a descriptive error for non-numeric lockedAmount in claimFromChannel', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    const balanceProofParams: BalanceProofParams = {
      channelId: CHANNEL_ID,
      nonce: 1,
      transferredAmount: '100',
      lockedAmount: 'bad',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
    };

    await expect(
      provider.claimFromChannel(CHANNEL_ID, balanceProofParams, '0xSig')
    ).rejects.toThrow(/Invalid lockedAmount.*bad/);
  });

  it('should truncate long invalid values in error messages to prevent info disclosure', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);
    const longValue = 'A'.repeat(100);

    await expect(provider.deposit(CHANNEL_ID, longValue)).rejects.toThrow(
      /Invalid deposit amount.*\.\.\."/
    );
    // Verify the full 100-char value is NOT in the error message
    await expect(provider.deposit(CHANNEL_ID, longValue)).rejects.not.toThrow(longValue);
  });

  it('should throw for factory with invalid keyId characters', () => {
    const sdk = createMockSDK();
    const logger = createMockLogger();
    const factory = createEVMProviderFactory(sdk as unknown as PaymentChannelSDK, logger);

    const config: EVMProviderConfig = {
      chainType: 'evm',
      rpcUrl: 'https://mainnet.base.org',
      registryAddress: '0xRegistryAddress',
      keyId: '../etc/passwd',
    };

    expect(() => factory(config)).toThrow(/invalid keyId/i);
  });
});
