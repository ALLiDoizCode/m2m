/**
 * ATDD Acceptance Tests for Story 32.6: Refactor ClaimReceiver for Multi-Chain Verification
 *
 * TDD GREEN PHASE: All tests are enabled. ClaimReceiver has been refactored
 * to use ChainProviderRegistry instead of PaymentChannelSDK.
 *
 * These tests validate:
 * - AC1: EVM claims verified via EVM provider (registry lookup + provider.verifyBalanceProof)
 * - AC2: Unknown blockchain type rejected with 'No provider registered' error
 * - AC3: Dynamic channel verification delegates to provider.getChannelState
 * - AC4: Backward compatibility with existing claim verification behavior
 * - AC5: ClaimReceiver constructor accepts ChainProviderRegistry, not PaymentChannelSDK
 *
 * To move to GREEN phase:
 * 1. Implement the ClaimReceiver refactoring (replace PaymentChannelSDK with ChainProviderRegistry)
 * 2. Remove .skip from all tests
 * 3. Run: npx jest packages/connector/src/settlement/claim-receiver.atdd.test.ts
 * 4. All tests should pass
 */

import { ClaimReceiver, ClaimReceivedEvent, ERRORS } from './claim-receiver';
import type { Database, Statement } from 'better-sqlite3';
import type { Logger } from 'pino';
import type { BTPServer } from '../btp/btp-server';
import type { BTPMessage, BTPData } from '../btp/btp-types';
import type { ChannelManager } from './channel-manager';
import type { EVMClaimMessage } from '../btp/btp-claim-types';
import type {
  PaymentChannelProvider,
  VerifyBalanceProofParams,
} from './provider/payment-channel-provider';
import type { ChainProviderRegistry } from './provider/chain-provider-registry';

// ---------------------------------------------------------------------------
// Test Data Constants
// ---------------------------------------------------------------------------

const TEST_CHANNEL_ID = '0x' + 'a'.repeat(64);
const TEST_SIGNER_ADDRESS = '0x' + 'c'.repeat(40);
const TEST_PARTICIPANT_1 = '0x' + 'c'.repeat(40); // matches signerAddress
const TEST_PARTICIPANT_2 = '0x' + 'd'.repeat(40);
const TEST_TOKEN_NETWORK_ADDRESS = '0x' + 'e'.repeat(40);
const TEST_TOKEN_ADDRESS = '0x' + 'f'.repeat(40);
const TEST_CHAIN_ID_STR = 'evm:31337';
// v2 RollingSwapChannel fields (connector#329 Phase 4b)
const TEST_RECIPIENT = '0x' + '7'.repeat(40);
const TEST_VERIFYING_CONTRACT = '0x' + 'e'.repeat(40);
// v2 buildVerifyParams always sends lockedAmount '0' and a zeroed locksRoot.
const V2_ZERO_LOCKS_ROOT = '0x' + '0'.repeat(64);

// ---------------------------------------------------------------------------
// Mock Factories
// ---------------------------------------------------------------------------

function createMockProvider(): jest.Mocked<PaymentChannelProvider> {
  return {
    verifyBalanceProof: jest.fn().mockResolvedValue(true),
    getChannelState: jest.fn().mockResolvedValue({
      channelId: TEST_CHANNEL_ID,
      status: 'opened' as const,
      participants: [TEST_PARTICIPANT_1, TEST_PARTICIPANT_2],
      deposit: 10000n,
    }),
    openChannel: jest.fn(),
    deposit: jest.fn(),
    claimFromChannel: jest.fn(),
    closeChannel: jest.fn(),
    settleChannel: jest.fn(),
    signBalanceProof: jest.fn(),
    subscribeToEvents: jest.fn(),
    chainType: 'evm' as const,
    chainId: TEST_CHAIN_ID_STR,
  };
}

function createMockRegistry(
  provider: jest.Mocked<PaymentChannelProvider>
): jest.Mocked<
  Pick<ChainProviderRegistry, 'getProvider' | 'getProviderForPeer' | 'getAllProviders'>
> {
  return {
    getProvider: jest.fn().mockImplementation((_chainType: string, chainId: string) => {
      if (chainId === TEST_CHAIN_ID_STR) return provider;
      return undefined;
    }),
    getProviderForPeer: jest.fn().mockReturnValue(provider),
    getAllProviders: jest.fn().mockReturnValue([provider]),
  };
}

function createValidEVMClaim(overrides: Partial<EVMClaimMessage> = {}): EVMClaimMessage {
  return {
    version: '2.0',
    blockchain: 'evm',
    messageId: 'evm-0xabc123-5-1706889600000',
    timestamp: '2026-03-25T12:00:00.000Z',
    senderId: 'peer-bob',
    channelId: TEST_CHANNEL_ID,
    nonce: 5,
    cumulativeAmount: '1000000000000000000',
    recipient: TEST_RECIPIENT,
    signature: '0x' + 'b'.repeat(130),
    signerAddress: TEST_SIGNER_ADDRESS,
    chainId: 8453,
    verifyingContract: TEST_VERIFYING_CONTRACT,
    ...overrides,
  };
}

function createSelfDescribingClaim(overrides: Partial<EVMClaimMessage> = {}): EVMClaimMessage {
  return createValidEVMClaim({
    messageId: 'evm-dynamic-test-1',
    senderId: 'peer-new',
    nonce: 1,
    chainId: 31337,
    verifyingContract: TEST_TOKEN_NETWORK_ADDRESS,
    tokenAddress: TEST_TOKEN_ADDRESS,
    ...overrides,
  });
}

function makeBTPMessage(claim: EVMClaimMessage): BTPMessage {
  return {
    type: 6,
    requestId: 1,
    data: {
      protocolData: [
        {
          protocolName: 'payment-channel-claim',
          contentType: 1,
          data: Buffer.from(JSON.stringify(claim), 'utf8'),
        },
      ],
      transfer: {
        amount: '0',
        expiresAt: new Date(Date.now() + 30000).toISOString(),
      },
    } as BTPData,
  };
}

// ---------------------------------------------------------------------------
// Helper: Create ClaimReceiver with registry (uses `any` cast during RED phase
// because the constructor still expects PaymentChannelSDK; after refactoring,
// change the cast to use the real ChainProviderRegistry type)
// ---------------------------------------------------------------------------

function createReceiverWithRegistry(
  db: Database,
  registry: Pick<ChainProviderRegistry, 'getProvider' | 'getProviderForPeer' | 'getAllProviders'>,
  logger: Logger,
  channelManager?: ChannelManager,
  peerIdToAddressMap?: Map<string, string>
): ClaimReceiver {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ClaimReceiver(db, registry as any, logger, channelManager, peerIdToAddressMap);
}

// ---------------------------------------------------------------------------
// ATDD Tests - Story 32.6
// ---------------------------------------------------------------------------

describe('ClaimReceiver ATDD - Story 32.6: Multi-Chain Verification', () => {
  let mockDb: jest.Mocked<Database>;
  let mockLogger: jest.Mocked<Logger>;
  let mockStatement: jest.Mocked<Statement>;
  let mockProvider: jest.Mocked<PaymentChannelProvider>;
  let mockRegistry: jest.Mocked<
    Pick<ChainProviderRegistry, 'getProvider' | 'getProviderForPeer' | 'getAllProviders'>
  >;
  let mockBTPServer: jest.Mocked<BTPServer>;
  let btpMessageHandler: ((peerId: string, message: BTPMessage) => void) | null;

  beforeEach(() => {
    jest.clearAllMocks();
    btpMessageHandler = null;

    mockStatement = {
      run: jest.fn(),
      get: jest.fn(),
    } as unknown as jest.Mocked<Statement>;

    mockDb = {
      prepare: jest.fn().mockReturnValue(mockStatement),
      exec: jest.fn(),
    } as unknown as jest.Mocked<Database>;

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
    } as unknown as jest.Mocked<Logger>;

    mockBTPServer = {
      onMessage: jest.fn((handler) => {
        btpMessageHandler = handler;
      }),
    } as unknown as jest.Mocked<BTPServer>;

    mockProvider = createMockProvider();
    mockRegistry = createMockRegistry(mockProvider);
  });

  // ---------------------------------------------------------------------------
  // AC5: ClaimReceiver constructor accepts ChainProviderRegistry
  // ---------------------------------------------------------------------------

  describe('AC5: Constructor accepts ChainProviderRegistry', () => {
    it('[P1] should accept ChainProviderRegistry instead of PaymentChannelSDK', () => {
      // Given: A ChainProviderRegistry mock (not PaymentChannelSDK)
      // When: ClaimReceiver is instantiated with registry
      const receiver = createReceiverWithRegistry(mockDb, mockRegistry, mockLogger);

      // Then: Instance is created successfully
      expect(receiver).toBeInstanceOf(ClaimReceiver);
    });

    it('[P1] should accept registry with channelManager and peerIdToAddressMap', () => {
      // Given: A registry and optional dependencies
      const mockChannelManager = {
        getChannelById: jest.fn(),
        registerExternalChannel: jest.fn(),
      } as unknown as jest.Mocked<ChannelManager>;
      const peerIdToAddressMap = new Map<string, string>();

      // When: ClaimReceiver is instantiated with all params
      const receiver = createReceiverWithRegistry(
        mockDb,
        mockRegistry,
        mockLogger,
        mockChannelManager,
        peerIdToAddressMap
      );

      // Then: Instance is created successfully
      expect(receiver).toBeInstanceOf(ClaimReceiver);
    });
  });

  // ---------------------------------------------------------------------------
  // AC1: EVM claims verified via EVM provider
  // ---------------------------------------------------------------------------

  describe('AC1: EVM claims verified via provider', () => {
    it('[P0] should verify valid EVM claim via provider.verifyBalanceProof and store verified=true', async () => {
      // Given: A ClaimReceiver with registry containing EVM provider
      const receiver = createReceiverWithRegistry(mockDb, mockRegistry, mockLogger);
      receiver.registerWithBTPServer(mockBTPServer);

      mockProvider.verifyBalanceProof.mockResolvedValue(true);
      mockStatement.get.mockReturnValue(undefined); // No previous claim

      const claim = createValidEVMClaim();

      // When: An EVM claim message is received
      await btpMessageHandler!('peer-bob', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Then: Provider.verifyBalanceProof is called with VerifyBalanceProofParams object
      expect(mockProvider.verifyBalanceProof).toHaveBeenCalledWith({
        channelId: claim.channelId,
        nonce: claim.nonce,
        transferredAmount: claim.cumulativeAmount, // string, carries v2 cumulative
        lockedAmount: '0', // string, not bigint (legacy slot, always '0' for v2)
        locksRoot: V2_ZERO_LOCKS_ROOT,
        signature: claim.signature,
        signerAddress: claim.signerAddress,
        recipient: claim.recipient,
        chainId: claim.chainId,
        verifyingContract: claim.verifyingContract,
      } satisfies VerifyBalanceProofParams);

      // And: Claim is persisted with verified=true
      expect(mockStatement.run).toHaveBeenCalledWith(
        claim.messageId,
        'peer-bob',
        'evm',
        claim.channelId,
        JSON.stringify(claim),
        1, // verified=true
        expect.any(Number),
        null,
        null
      );
    });

    it('[P0] should emit CLAIM_RECEIVED event after successful provider verification', async () => {
      // Given: A ClaimReceiver with registry
      const receiver = createReceiverWithRegistry(mockDb, mockRegistry, mockLogger);
      receiver.registerWithBTPServer(mockBTPServer);

      mockProvider.verifyBalanceProof.mockResolvedValue(true);
      mockStatement.get.mockReturnValue(undefined);

      const claimReceivedListener = jest.fn();
      receiver.on('CLAIM_RECEIVED', claimReceivedListener);

      const claim = createValidEVMClaim();

      // When: A valid EVM claim is received and verified
      await btpMessageHandler!('peer-bob', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Then: CLAIM_RECEIVED event is emitted with correct data
      expect(claimReceivedListener).toHaveBeenCalledTimes(1);
      const emittedEvent: ClaimReceivedEvent = claimReceivedListener.mock.calls[0][0];
      expect(emittedEvent.peerId).toBe('peer-bob');
      expect(emittedEvent.channelId).toBe(claim.channelId);
      expect(emittedEvent.cumulativeAmount).toBe(BigInt(claim.cumulativeAmount));
    });

    it('[P0] should persist claim with verified=false when provider rejects signature', async () => {
      // Given: Provider rejects the balance proof
      const receiver = createReceiverWithRegistry(mockDb, mockRegistry, mockLogger);
      receiver.registerWithBTPServer(mockBTPServer);

      mockProvider.verifyBalanceProof.mockResolvedValue(false);

      const claim = createValidEVMClaim();

      // When: An EVM claim with invalid signature is received
      await btpMessageHandler!('peer-bob', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Then: Claim is persisted with verified=false
      expect(mockStatement.run).toHaveBeenCalledWith(
        claim.messageId,
        'peer-bob',
        'evm',
        claim.channelId,
        JSON.stringify(claim),
        0, // verified=false
        expect.any(Number),
        null,
        null
      );
    });

    it('[P0] should NOT emit CLAIM_RECEIVED event when provider rejects signature', async () => {
      // Given: Provider rejects the balance proof
      const receiver = createReceiverWithRegistry(mockDb, mockRegistry, mockLogger);
      receiver.registerWithBTPServer(mockBTPServer);

      mockProvider.verifyBalanceProof.mockResolvedValue(false);

      const claimReceivedListener = jest.fn();
      receiver.on('CLAIM_RECEIVED', claimReceivedListener);

      const claim = createValidEVMClaim();

      // When: An EVM claim with invalid signature is received
      await btpMessageHandler!('peer-bob', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Then: CLAIM_RECEIVED event is NOT emitted
      expect(claimReceivedListener).not.toHaveBeenCalled();
    });

    it('[P0] should use VerifyBalanceProofParams with string amounts (not bigint)', async () => {
      // Given: A ClaimReceiver with registry
      const receiver = createReceiverWithRegistry(mockDb, mockRegistry, mockLogger);
      receiver.registerWithBTPServer(mockBTPServer);

      mockProvider.verifyBalanceProof.mockResolvedValue(true);
      mockStatement.get.mockReturnValue(undefined);

      const claim = createValidEVMClaim({
        cumulativeAmount: '5000000000000000000',
      });

      // When: Claim is received
      await btpMessageHandler!('peer-bob', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Then: Provider receives string amounts, not bigint
      const calledParams = mockProvider.verifyBalanceProof.mock
        .calls[0]![0] as VerifyBalanceProofParams;
      expect(typeof calledParams.transferredAmount).toBe('string');
      expect(typeof calledParams.lockedAmount).toBe('string');
      // v2: transferredAmount carries the cumulative; lockedAmount is a legacy '0' slot.
      expect(calledParams.transferredAmount).toBe('5000000000000000000');
      expect(calledParams.lockedAmount).toBe('0');
    });
  });

  // ---------------------------------------------------------------------------
  // AC2: Unknown blockchain type rejected
  // ---------------------------------------------------------------------------

  describe('AC2: Unknown blockchain type rejected', () => {
    it('[P0] should reject claim with unregistered blockchain type', async () => {
      // Given: Registry has no Solana provider
      const receiver = createReceiverWithRegistry(mockDb, mockRegistry, mockLogger);
      receiver.registerWithBTPServer(mockBTPServer);

      // Create a claim pretending to be Solana (will fail validateClaimMessage for now,
      // but the error path for 'no provider registered' is what we test)
      // For this test, we simulate a blockchain type that has no provider
      const claim = createValidEVMClaim();
      // Override the registry to return undefined for this claim's chain lookup
      mockRegistry.getProvider.mockReturnValue(undefined);
      mockRegistry.getAllProviders.mockReturnValue([]);

      // When: The claim is received
      await btpMessageHandler!('peer-bob', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Then: Claim is persisted with verified=false
      expect(mockStatement.run).toHaveBeenCalledWith(
        claim.messageId,
        'peer-bob',
        'evm',
        claim.channelId,
        JSON.stringify(claim),
        0, // verified=false
        expect.any(Number),
        null,
        null
      );
    });

    it('[P0] should include blockchain name in rejection error message', async () => {
      // Given: A claim that expects ERRORS.NO_PROVIDER_REGISTERED constant to exist
      // Then: The ERRORS object contains the NO_PROVIDER_REGISTERED key
      // Note: This property will be added as part of the Story 32.6 implementation
      const errors = ERRORS as Record<string, string>;
      expect(errors['NO_PROVIDER_REGISTERED']).toBeDefined();
      expect(errors['NO_PROVIDER_REGISTERED']).toContain('No provider registered for blockchain:');
    });
  });

  // ---------------------------------------------------------------------------
  // AC4: Nonce monotonicity (chain-agnostic, unchanged)
  // ---------------------------------------------------------------------------

  describe('AC4: Nonce monotonicity remains chain-agnostic', () => {
    it('[P0] should reject EVM claim with non-increasing nonce', async () => {
      // Given: A previous claim exists with nonce=5
      const receiver = createReceiverWithRegistry(mockDb, mockRegistry, mockLogger);
      receiver.registerWithBTPServer(mockBTPServer);

      mockProvider.verifyBalanceProof.mockResolvedValue(true);

      const previousClaim = createValidEVMClaim({ nonce: 5 });
      mockStatement.get.mockReturnValue({
        claim_data: JSON.stringify(previousClaim),
      });

      const claim = createValidEVMClaim({ nonce: 5 }); // Same nonce - should fail

      // When: A claim with non-increasing nonce arrives
      await btpMessageHandler!('peer-bob', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Then: Claim is stored as unverified
      expect(mockStatement.run).toHaveBeenCalledWith(
        claim.messageId,
        'peer-bob',
        'evm',
        claim.channelId,
        JSON.stringify(claim),
        0, // verified=false
        expect.any(Number),
        null,
        null
      );
    });
  });

  // ---------------------------------------------------------------------------
  // AC3: Dynamic channel verification via provider
  // ---------------------------------------------------------------------------

  describe('AC3: Dynamic channel verification via provider', () => {
    let mockChannelManager: jest.Mocked<ChannelManager>;
    let dynamicBtpHandler: ((peerId: string, message: BTPMessage) => void) | null;

    beforeEach(() => {
      dynamicBtpHandler = null;

      mockChannelManager = {
        getChannelById: jest.fn().mockReturnValue(null), // Unknown channel
        registerExternalChannel: jest.fn().mockReturnValue({
          channelId: TEST_CHANNEL_ID,
          peerId: 'peer-new',
          tokenId: TEST_TOKEN_ADDRESS,
          tokenAddress: TEST_TOKEN_ADDRESS,
          chain: TEST_CHAIN_ID_STR,
          createdAt: new Date(),
          lastActivityAt: new Date(),
          status: 'open',
        }),
      } as unknown as jest.Mocked<ChannelManager>;

      const dynamicBTPServer = {
        onMessage: jest.fn((handler) => {
          dynamicBtpHandler = handler;
        }),
      } as unknown as jest.Mocked<BTPServer>;

      const receiver = createReceiverWithRegistry(
        mockDb,
        mockRegistry,
        mockLogger,
        mockChannelManager
      );
      receiver.registerWithBTPServer(dynamicBTPServer);
    });

    it('[P1] should delegate on-chain state check to provider.getChannelState', async () => {
      // Given: An unknown channel with self-describing fields
      const claim = createSelfDescribingClaim();
      mockStatement.get.mockReturnValue(undefined);

      // When: The claim is received
      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Then: provider.getChannelState is called (not SDK.getChannelStateByNetwork)
      expect(mockProvider.getChannelState).toHaveBeenCalledWith(claim.channelId);
    });

    it('[P1] should reject when provider.getChannelState throws (channel non-existent)', async () => {
      // Given: Provider throws when channel doesn't exist on-chain
      mockProvider.getChannelState.mockRejectedValueOnce(new Error('Channel not found'));

      const claim = createSelfDescribingClaim();

      // When: The claim is received
      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Then: Claim is persisted as unverified
      expect(mockStatement.run).toHaveBeenCalledWith(
        claim.messageId,
        'peer-new',
        'evm',
        TEST_CHANNEL_ID,
        expect.any(String),
        0, // verified=false
        expect.any(Number),
        null,
        null
      );
    });

    it('[P1] should reject when channel status is not opened', async () => {
      // Given: Provider returns channel with 'closed' status
      mockProvider.getChannelState.mockResolvedValueOnce({
        channelId: TEST_CHANNEL_ID,
        status: 'closed', // Not 'opened'
        participants: [TEST_PARTICIPANT_1, TEST_PARTICIPANT_2],
        deposit: 10000n,
      });

      const claim = createSelfDescribingClaim();

      // When: The claim is received
      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Then: Claim is rejected with CHANNEL_NOT_OPENED
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: TEST_CHANNEL_ID }),
        ERRORS.CHANNEL_NOT_OPENED
      );
    });

    it('[P1] should reject when signer is not in participants array', async () => {
      // Given: Provider returns channel with different participants
      mockProvider.getChannelState.mockResolvedValueOnce({
        channelId: TEST_CHANNEL_ID,
        status: 'opened',
        participants: ['0x' + '1'.repeat(40), '0x' + '2'.repeat(40)], // Neither matches signerAddress
        deposit: 10000n,
      });

      const claim = createSelfDescribingClaim();

      // When: The claim is received
      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Then: Claim is rejected with SIGNER_NOT_PARTICIPANT
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: TEST_CHANNEL_ID }),
        ERRORS.SIGNER_NOT_PARTICIPANT
      );
    });

    it('[P1] should use provider.verifyBalanceProof for dynamic verification (not verifyBalanceProofWithDomain)', async () => {
      // Given: A valid unknown channel with self-describing fields
      const claim = createSelfDescribingClaim();
      mockStatement.get.mockReturnValue(undefined);

      // When: The claim is received and passes on-chain checks
      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Then: provider.verifyBalanceProof is called with VerifyBalanceProofParams
      expect(mockProvider.verifyBalanceProof).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: claim.channelId,
          nonce: claim.nonce,
          transferredAmount: claim.cumulativeAmount,
          lockedAmount: '0',
          locksRoot: V2_ZERO_LOCKS_ROOT,
          signature: claim.signature,
          signerAddress: claim.signerAddress,
          recipient: claim.recipient,
          chainId: claim.chainId,
          verifyingContract: claim.verifyingContract,
        })
      );
    });

    it('[P1] should register external channel on successful dynamic verification', async () => {
      // Given: A valid unknown channel
      const claim = createSelfDescribingClaim();
      mockStatement.get.mockReturnValue(undefined);

      // When: The claim passes all verification
      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Then: Channel is registered via channelManager
      expect(mockChannelManager.registerExternalChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: TEST_CHANNEL_ID,
          peerId: 'peer-new',
        })
      );
    });

    it('[P1] should resolve provider using claim chainId for dynamic verification', async () => {
      // Given: A claim with chainId=31337
      const claim = createSelfDescribingClaim({ chainId: 31337 });
      mockStatement.get.mockReturnValue(undefined);

      // When: The claim is received
      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Then: Registry.getProvider is called with constructed chain key
      expect(mockRegistry.getProvider).toHaveBeenCalledWith('evm', 'evm:31337');
    });
  });

  // ---------------------------------------------------------------------------
  // AC4: Backward compatibility
  // ---------------------------------------------------------------------------

  describe('AC4: Backward compatibility', () => {
    it('[P0] should handle known channel with pre-registered metadata (no dynamic verification)', async () => {
      // Given: Channel is already known in channelManager
      const mockChannelManager = {
        getChannelById: jest.fn().mockReturnValue({
          channelId: TEST_CHANNEL_ID,
          peerId: 'peer-bob',
          tokenId: 'TEST_TOKEN',
          tokenAddress: TEST_TOKEN_ADDRESS,
          chain: TEST_CHAIN_ID_STR,
          createdAt: new Date(),
          lastActivityAt: new Date(),
          status: 'open',
        }),
        registerExternalChannel: jest.fn(),
      } as unknown as jest.Mocked<ChannelManager>;

      const receiver = createReceiverWithRegistry(
        mockDb,
        mockRegistry,
        mockLogger,
        mockChannelManager
      );

      const knownBTPServer = {
        onMessage: jest.fn((handler) => {
          btpMessageHandler = handler;
        }),
      } as unknown as jest.Mocked<BTPServer>;
      receiver.registerWithBTPServer(knownBTPServer);

      mockProvider.verifyBalanceProof.mockResolvedValue(true);
      mockStatement.get.mockReturnValue(undefined);

      const claim = createValidEVMClaim();

      // When: A claim arrives for a known channel
      await btpMessageHandler!('peer-bob', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Then: provider.verifyBalanceProof is called (not getChannelState)
      expect(mockProvider.verifyBalanceProof).toHaveBeenCalled();
      expect(mockProvider.getChannelState).not.toHaveBeenCalled();

      // And: Claim is stored as verified
      expect(mockStatement.run).toHaveBeenCalledWith(
        claim.messageId,
        'peer-bob',
        'evm',
        claim.channelId,
        expect.any(String),
        1, // verified=true
        expect.any(Number),
        null,
        null
      );
    });

    it('[P0] should handle duplicate message IDs gracefully (idempotency)', async () => {
      // Given: ClaimReceiver with registry
      const receiver = createReceiverWithRegistry(mockDb, mockRegistry, mockLogger);
      receiver.registerWithBTPServer(mockBTPServer);

      mockProvider.verifyBalanceProof.mockResolvedValue(true);
      mockStatement.get.mockReturnValue(undefined);
      mockStatement.run.mockImplementation(() => {
        const error = new Error('UNIQUE constraint failed: received_claims.message_id');
        throw error;
      });

      const claim = createValidEVMClaim();

      // When: A duplicate claim message arrives
      await btpMessageHandler!('peer-bob', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Then: Warning is logged for duplicate
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { messageId: claim.messageId },
        'Duplicate claim message ignored (idempotency)'
      );
    });

    it('[P0] should handle invalid JSON parsing gracefully', async () => {
      // Given: ClaimReceiver with registry
      const receiver = createReceiverWithRegistry(mockDb, mockRegistry, mockLogger);
      receiver.registerWithBTPServer(mockBTPServer);

      const btpMessage: BTPMessage = {
        type: 6,
        requestId: 1,
        data: {
          protocolData: [
            {
              protocolName: 'payment-channel-claim',
              contentType: 1,
              data: Buffer.from('invalid json', 'utf8'),
            },
          ],
          transfer: {
            amount: '0',
            expiresAt: new Date(Date.now() + 30000).toISOString(),
          },
        } as BTPData,
      };

      // When: Invalid JSON is received
      await btpMessageHandler!('peer-bob', btpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Then: Error is logged, no DB insert
      expect(mockLogger.error).toHaveBeenCalledWith(
        { error: expect.any(Error) },
        'Failed to parse claim message'
      );
      expect(mockStatement.run).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // AC1/AC3: peerIdToAddressMap handling
  // ---------------------------------------------------------------------------

  describe('peerIdToAddressMap with registry', () => {
    it('[P1] should register peer address from self-describing claim', async () => {
      // Given: peerIdToAddressMap is provided
      const peerIdToAddressMap = new Map<string, string>();
      const mockChannelManager = {
        getChannelById: jest.fn().mockReturnValue(null),
        registerExternalChannel: jest.fn().mockReturnValue({
          channelId: TEST_CHANNEL_ID,
          peerId: 'peer-new',
          tokenId: TEST_TOKEN_ADDRESS,
          tokenAddress: TEST_TOKEN_ADDRESS,
          chain: TEST_CHAIN_ID_STR,
          createdAt: new Date(),
          lastActivityAt: new Date(),
          status: 'open',
        }),
      } as unknown as jest.Mocked<ChannelManager>;

      const receiver = createReceiverWithRegistry(
        mockDb,
        mockRegistry,
        mockLogger,
        mockChannelManager,
        peerIdToAddressMap
      );

      const mapBTPServer = {
        onMessage: jest.fn((handler) => {
          btpMessageHandler = handler;
        }),
      } as unknown as jest.Mocked<BTPServer>;
      receiver.registerWithBTPServer(mapBTPServer);

      const claim = createSelfDescribingClaim();
      mockStatement.get.mockReturnValue(undefined);

      // When: A self-describing claim is received
      await btpMessageHandler!('peer-new', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Then: Peer address is registered
      expect(peerIdToAddressMap.get('peer-new')).toBe(TEST_SIGNER_ADDRESS);
    });

    it('[P1] should NOT overwrite existing peer address in peerIdToAddressMap', async () => {
      // Given: peerIdToAddressMap already has an entry for this peer
      const existingAddress = '0x' + '9'.repeat(40);
      const peerIdToAddressMap = new Map<string, string>([['peer-new', existingAddress]]);
      const mockChannelManager = {
        getChannelById: jest.fn().mockReturnValue(null),
        registerExternalChannel: jest.fn().mockReturnValue({
          channelId: TEST_CHANNEL_ID,
          peerId: 'peer-new',
          tokenId: TEST_TOKEN_ADDRESS,
          tokenAddress: TEST_TOKEN_ADDRESS,
          chain: TEST_CHAIN_ID_STR,
          createdAt: new Date(),
          lastActivityAt: new Date(),
          status: 'open',
        }),
      } as unknown as jest.Mocked<ChannelManager>;

      const receiver = createReceiverWithRegistry(
        mockDb,
        mockRegistry,
        mockLogger,
        mockChannelManager,
        peerIdToAddressMap
      );

      const mapBTPServer = {
        onMessage: jest.fn((handler) => {
          btpMessageHandler = handler;
        }),
      } as unknown as jest.Mocked<BTPServer>;
      receiver.registerWithBTPServer(mapBTPServer);

      const claim = createSelfDescribingClaim();
      mockStatement.get.mockReturnValue(undefined);

      // When: A self-describing claim is received
      await btpMessageHandler!('peer-new', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Then: Existing entry is NOT overwritten
      expect(peerIdToAddressMap.get('peer-new')).toBe(existingAddress);
    });
  });

  // ---------------------------------------------------------------------------
  // getLatestVerifiedClaim (unchanged, but ensure chain-agnostic)
  // ---------------------------------------------------------------------------

  describe('getLatestVerifiedClaim with registry-based receiver', () => {
    it('[P0] should return latest verified claim', async () => {
      // Given: A ClaimReceiver with registry
      const receiver = createReceiverWithRegistry(mockDb, mockRegistry, mockLogger);

      const storedClaim = createValidEVMClaim({ nonce: 1 });
      mockStatement.get.mockReturnValue({
        claim_data: JSON.stringify(storedClaim),
      });

      // When: getLatestVerifiedClaim is called
      const result = await receiver.getLatestVerifiedClaim('peer-bob', 'evm', TEST_CHANNEL_ID);

      // Then: The stored claim is returned
      expect(result).toEqual(storedClaim);
    });
  });
});
