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
    | 'updateBalance'
    | 'closeChannel'
    | 'settleChannel'
    | 'signBalanceProof'
    | 'verifyBalanceProofV2'
    | 'getChannelState'
    | 'onChannelOpened'
    | 'onChannelClosed'
    | 'onChannelSettled'
    | 'onChannelCooperativeSettled'
    | 'removeAllListeners'
    | 'getChainId'
    | 'getTokenNetworkAddress'
    | 'getSignerAddress'
  >
> {
  return {
    openChannel: jest.fn(),
    deposit: jest.fn(),
    updateBalance: jest.fn(),
    closeChannel: jest.fn(),
    settleChannel: jest.fn(),
    signBalanceProof: jest.fn(),
    verifyBalanceProofV2: jest.fn(),
    getChannelState: jest.fn(),
    onChannelOpened: jest.fn(),
    onChannelClosed: jest.fn(),
    onChannelSettled: jest.fn(),
    onChannelCooperativeSettled: jest.fn(),
    removeAllListeners: jest.fn(),
    getChainId: jest.fn().mockResolvedValue(31337),
    getTokenNetworkAddress: jest.fn().mockResolvedValue('0xTokenNetworkAddress1234567890abcdef'),
    getSignerAddress: jest.fn().mockResolvedValue('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1'),
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
      recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      chainId: 8453,
      verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    };

    const result = await provider.signBalanceProof(params);

    // v2: (channelId, nonce, cumulativeAmount, recipient, chainId, verifyingContract)
    expect(sdk.signBalanceProof).toHaveBeenCalledWith(
      CHANNEL_ID,
      5,
      BigInt('1000000000000000000'),
      '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      8453,
      '0x5FbDB2315678afecb367f032d93F642f64180aa3'
    );
    expect(result).toBe('0xSignature123abc');
  });
});

// ---------------------------------------------------------------------------
// T-32.3-05: verifyBalanceProof delegation
// ---------------------------------------------------------------------------

describe('verifyBalanceProof delegation (T-32.3-05)', () => {
  it('should construct v2 params and delegate to sdk.verifyBalanceProofV2', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    sdk.verifyBalanceProofV2.mockReturnValue(true);

    const params: VerifyBalanceProofParams = {
      channelId: CHANNEL_ID,
      nonce: 3,
      transferredAmount: '2000000000000000000',
      lockedAmount: '0',
      locksRoot: '0xLocksRoot000000000000000000000000000000000000000000000000000002',
      signature: '0xSignatureToVerify',
      signerAddress: '0xSignerAddress123',
      recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      chainId: 8453,
      verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    };

    const result = await provider.verifyBalanceProof(params);

    // v2: cumulativeAmount carried by transferredAmount; recipient/chainId/
    // verifyingContract rebuild the v2 EIP-712 digest.
    expect(sdk.verifyBalanceProofV2).toHaveBeenCalledWith(
      {
        channelId: CHANNEL_ID,
        cumulativeAmount: '2000000000000000000',
        nonce: 3,
        recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        chainId: 8453,
        verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      },
      '0xSignatureToVerify',
      '0xSignerAddress123'
    );
    expect(result).toBe(true);
  });

  it('should return false for invalid signatures', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    sdk.verifyBalanceProofV2.mockReturnValue(false);

    const params: VerifyBalanceProofParams = {
      channelId: CHANNEL_ID,
      nonce: 1,
      transferredAmount: '100',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xInvalidSignature',
      signerAddress: '0xWrongSigner',
      recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      chainId: 8453,
      verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    };

    const result = await provider.verifyBalanceProof(params);

    expect(result).toBe(false);
  });

  it('should return false (fail closed) when v2 domain fields are missing', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    const params: VerifyBalanceProofParams = {
      channelId: CHANNEL_ID,
      nonce: 1,
      transferredAmount: '100',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xSig',
      signerAddress: '0xSigner',
      // recipient / chainId / verifyingContract intentionally omitted
    };

    const result = await provider.verifyBalanceProof(params);

    expect(result).toBe(false);
    expect(sdk.verifyBalanceProofV2).not.toHaveBeenCalled();
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
  it('should convert BalanceProofParams to v2 args and delegate to sdk.updateBalance', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    sdk.updateBalance.mockResolvedValue(undefined);

    const balanceProofParams: BalanceProofParams = {
      channelId: CHANNEL_ID,
      nonce: 7,
      transferredAmount: '5000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    };
    const signature = '0xClaimSignature';

    const result: TxResult = await provider.claimFromChannel(
      CHANNEL_ID,
      balanceProofParams,
      signature
    );

    // v2 redeem: (verifyingContract, channelId, cumulativeAmount, nonce, recipient, signature)
    expect(sdk.updateBalance).toHaveBeenCalledWith(
      '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      CHANNEL_ID,
      BigInt('5000000000000000000'),
      7,
      '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      signature
    );

    expect(result).toHaveProperty('txHash');
    expect(typeof result.txHash).toBe('string');
  });

  it('should throw when recipient or verifyingContract is missing on the balance proof', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    const balanceProofParams: BalanceProofParams = {
      channelId: CHANNEL_ID,
      nonce: 7,
      transferredAmount: '5000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      // recipient / verifyingContract intentionally omitted
    };

    await expect(
      provider.claimFromChannel(CHANNEL_ID, balanceProofParams, '0xSig')
    ).rejects.toThrow(/requires recipient and verifyingContract/i);
    expect(sdk.updateBalance).not.toHaveBeenCalled();
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
// T-32.4-11: getSigningContext
// ---------------------------------------------------------------------------

describe('getSigningContext (T-32.4-11)', () => {
  it('should return SDK values for chainId, verifyingContract, and signerAddress', async () => {
    const sdk = createMockSDK();
    sdk.getChainId = jest.fn().mockResolvedValue(31337);
    sdk.getTokenNetworkAddress = jest
      .fn()
      .mockResolvedValue('0xTokenNetworkAddress1234567890abcdef');
    sdk.getSignerAddress = jest
      .fn()
      .mockResolvedValue('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1');

    const provider = createProvider(sdk);
    const ctx = await provider.getSigningContext();

    expect(ctx).toEqual({
      chainId: 31337,
      verifyingContract: '0xTokenNetworkAddress1234567890abcdef',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    });

    expect(sdk.getChainId).toHaveBeenCalledTimes(1);
    expect(sdk.getTokenNetworkAddress).toHaveBeenCalledWith(TOKEN_ADDRESS);
    expect(sdk.getSignerAddress).toHaveBeenCalledTimes(1);
  });

  it('should propagate SDK errors', async () => {
    const sdk = createMockSDK();
    sdk.getChainId = jest.fn().mockRejectedValue(new Error('RPC failure'));

    const provider = createProvider(sdk);

    await expect(provider.getSigningContext()).rejects.toThrow('RPC failure');
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
      tokenAddress: '0x5678000000000000000000000000000000000001',
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
      keyId: 'solana-key',
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
      tokenAddress: '0x5678000000000000000000000000000000000001',
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
      recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      chainId: 8453,
      verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
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

    sdk.updateBalance.mockRejectedValue(new Error('SDK: claim failed'));

    const balanceProofParams: BalanceProofParams = {
      channelId: CHANNEL_ID,
      nonce: 1,
      transferredAmount: '100',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
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

  it('should throw a descriptive error for non-numeric cumulativeAmount in signBalanceProof', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    const params: BalanceProofParams = {
      channelId: CHANNEL_ID,
      nonce: 1,
      transferredAmount: 'invalid',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      chainId: 8453,
      verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    };

    await expect(provider.signBalanceProof(params)).rejects.toThrow(
      /Invalid cumulativeAmount.*invalid/
    );
  });

  it('should throw a descriptive error for non-numeric cumulativeAmount in claimFromChannel', async () => {
    const sdk = createMockSDK();
    const provider = createProvider(sdk);

    const balanceProofParams: BalanceProofParams = {
      channelId: CHANNEL_ID,
      nonce: 1,
      transferredAmount: 'bad',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    };

    await expect(
      provider.claimFromChannel(CHANNEL_ID, balanceProofParams, '0xSig')
    ).rejects.toThrow(/Invalid cumulativeAmount.*bad/);
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
      tokenAddress: '0x5678000000000000000000000000000000000001',
    };

    expect(() => factory(config)).toThrow(/invalid keyId/i);
  });
});
