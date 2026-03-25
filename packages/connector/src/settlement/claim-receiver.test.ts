/**
 * Unit tests for ClaimReceiver
 *
 * Tests claim reception, validation, provider-based signature verification,
 * monotonicity checks, and database persistence.
 *
 * Epic 30 Story 30.4: Removed XRP/Aptos claim handling tests (EVM-only settlement).
 * Epic 32 Story 32.6: Refactored from PaymentChannelSDK to ChainProviderRegistry.
 */

import { ClaimReceiver, ClaimReceivedEvent, ERRORS } from './claim-receiver';
import type { Database, Statement } from 'better-sqlite3';
import type { Logger } from 'pino';
import type { BTPServer } from '../btp/btp-server';
import type { BTPProtocolData, BTPMessage, BTPData } from '../btp/btp-types';
import type { ChainProviderRegistry } from './provider/chain-provider-registry';
import type { PaymentChannelProvider } from './provider/payment-channel-provider';
import type { ChannelManager } from './channel-manager';
import type { EVMClaimMessage } from '../btp/btp-claim-types';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Create a mock PaymentChannelProvider for EVM.
 */
function createMockProvider(): jest.Mocked<PaymentChannelProvider> {
  return {
    verifyBalanceProof: jest.fn().mockResolvedValue(true),
    getChannelState: jest.fn().mockResolvedValue({
      channelId: '0x' + 'a'.repeat(64),
      status: 'opened' as const,
      participants: ['0x' + 'c'.repeat(40), '0x' + 'd'.repeat(40)],
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
    chainId: 'evm:31337',
  } as unknown as jest.Mocked<PaymentChannelProvider>;
}

/**
 * Create a mock ChainProviderRegistry.
 */
function createMockRegistry(
  provider: jest.Mocked<PaymentChannelProvider>
): jest.Mocked<
  Pick<ChainProviderRegistry, 'getProvider' | 'getProviderForPeer' | 'getAllProviders'>
> {
  return {
    getProvider: jest.fn().mockImplementation((_chainType: string, chainId: string) => {
      if (chainId === 'evm:31337') return provider;
      return undefined;
    }),
    getProviderForPeer: jest.fn().mockReturnValue(provider),
    getAllProviders: jest.fn().mockReturnValue([provider]),
  };
}

describe('ClaimReceiver', () => {
  let claimReceiver: ClaimReceiver;
  let mockDb: jest.Mocked<Database>;
  let mockLogger: jest.Mocked<Logger>;
  let mockBTPServer: jest.Mocked<BTPServer>;
  let mockProvider: jest.Mocked<PaymentChannelProvider>;
  let mockRegistry: jest.Mocked<
    Pick<ChainProviderRegistry, 'getProvider' | 'getProviderForPeer' | 'getAllProviders'>
  >;
  let mockStatement: jest.Mocked<Statement>;
  let btpMessageHandler: ((peerId: string, message: BTPMessage) => void) | null;

  beforeEach(() => {
    jest.clearAllMocks();
    btpMessageHandler = null;

    // Mock Database
    mockStatement = {
      run: jest.fn(),
      get: jest.fn(),
    } as unknown as jest.Mocked<Statement>;

    mockDb = {
      prepare: jest.fn().mockReturnValue(mockStatement),
      exec: jest.fn(),
    } as unknown as jest.Mocked<Database>;

    // Mock Logger
    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
    } as unknown as jest.Mocked<Logger>;

    // Mock BTPServer
    mockBTPServer = {
      onMessage: jest.fn((handler) => {
        btpMessageHandler = handler;
      }),
    } as unknown as jest.Mocked<BTPServer>;

    // Mock Provider and Registry
    mockProvider = createMockProvider();
    mockRegistry = createMockRegistry(mockProvider);

    // Create ClaimReceiver instance with ChainProviderRegistry
    claimReceiver = new ClaimReceiver(
      mockDb,
      mockRegistry as unknown as ChainProviderRegistry,
      mockLogger
    );
  });

  describe('registerWithBTPServer', () => {
    it('should register message handler with BTP server', () => {
      claimReceiver.registerWithBTPServer(mockBTPServer);

      expect(mockBTPServer.onMessage).toHaveBeenCalledTimes(1);
      expect(mockBTPServer.onMessage).toHaveBeenCalledWith(expect.any(Function));
      expect(mockLogger.info).toHaveBeenCalledWith('ClaimReceiver registered with BTP server');
    });
  });

  // XRP claim handling removed in Epic 30 Story 30.4 - EVM-only settlement

  describe('handleClaimMessage - EVM Claims', () => {
    let validEVMClaim: EVMClaimMessage;
    let protocolData: BTPProtocolData;
    let btpMessage: BTPMessage;

    beforeEach(() => {
      validEVMClaim = {
        version: '1.0',
        blockchain: 'evm',
        messageId: 'evm-0xabc123-5-1706889600000',
        timestamp: '2026-02-02T12:00:00.000Z',
        senderId: 'peer-bob',
        channelId: '0x' + 'a'.repeat(64),
        nonce: 5,
        transferredAmount: '1000000000000000000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
        signature: '0x' + 'b'.repeat(130),
        signerAddress: '0x' + 'c'.repeat(40),
      };

      protocolData = {
        protocolName: 'payment-channel-claim',
        contentType: 1,
        data: Buffer.from(JSON.stringify(validEVMClaim), 'utf8'),
      };

      btpMessage = {
        type: 6,
        requestId: 1,
        data: {
          protocolData: [protocolData],
          transfer: {
            amount: '0',
            expiresAt: new Date(Date.now() + 30000).toISOString(),
          },
        } as BTPData,
      };
    });

    it('should verify valid EVM claim and store with verified=true', async () => {
      mockProvider.verifyBalanceProof.mockResolvedValue(true);
      mockStatement.get.mockReturnValue(undefined); // No previous claim

      claimReceiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-bob', btpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify balance proof verification via provider (single object with string amounts)
      expect(mockProvider.verifyBalanceProof).toHaveBeenCalledWith({
        channelId: validEVMClaim.channelId,
        nonce: validEVMClaim.nonce,
        transferredAmount: validEVMClaim.transferredAmount,
        lockedAmount: validEVMClaim.lockedAmount,
        locksRoot: validEVMClaim.locksRoot,
        signature: validEVMClaim.signature,
        signerAddress: validEVMClaim.signerAddress,
      });

      // Verify database insert with verified=true
      expect(mockStatement.run).toHaveBeenCalledWith(
        validEVMClaim.messageId,
        'peer-bob',
        'evm',
        validEVMClaim.channelId,
        JSON.stringify(validEVMClaim),
        1, // verified=true
        expect.any(Number),
        null,
        null
      );
    });

    it('should emit CLAIM_RECEIVED event after successful verification', async () => {
      mockProvider.verifyBalanceProof.mockResolvedValue(true);
      mockStatement.get.mockReturnValue(undefined); // No previous claim

      const claimReceivedListener = jest.fn();
      claimReceiver.on('CLAIM_RECEIVED', claimReceivedListener);

      claimReceiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-bob', btpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify CLAIM_RECEIVED event emitted with correct data
      expect(claimReceivedListener).toHaveBeenCalledTimes(1);
      const emittedEvent: ClaimReceivedEvent = claimReceivedListener.mock.calls[0][0];
      expect(emittedEvent.peerId).toBe('peer-bob');
      expect(emittedEvent.channelId).toBe(validEVMClaim.channelId);
      expect(emittedEvent.cumulativeAmount).toBe(BigInt(validEVMClaim.transferredAmount));
    });

    it('should NOT emit CLAIM_RECEIVED event when verification fails', async () => {
      mockProvider.verifyBalanceProof.mockResolvedValue(false);

      const claimReceivedListener = jest.fn();
      claimReceiver.on('CLAIM_RECEIVED', claimReceivedListener);

      claimReceiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-bob', btpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // CLAIM_RECEIVED should NOT be emitted for failed verification
      expect(claimReceivedListener).not.toHaveBeenCalled();
    });

    it('should reject EVM claim with invalid EIP-712 signature', async () => {
      mockProvider.verifyBalanceProof.mockResolvedValue(false);

      claimReceiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-bob', btpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify database insert with verified=false
      expect(mockStatement.run).toHaveBeenCalledWith(
        validEVMClaim.messageId,
        'peer-bob',
        'evm',
        validEVMClaim.channelId,
        JSON.stringify(validEVMClaim),
        0, // verified=false
        expect.any(Number),
        null,
        null
      );
    });

    it('should reject EVM claim with non-increasing nonce (monotonicity check)', async () => {
      mockProvider.verifyBalanceProof.mockResolvedValue(true);

      // Mock previous claim with same nonce
      const previousClaim: EVMClaimMessage = {
        ...validEVMClaim,
        nonce: 5, // Same nonce
      };

      mockStatement.get.mockReturnValue({
        claim_data: JSON.stringify(previousClaim),
      });

      claimReceiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-bob', btpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify database insert with verified=false
      expect(mockStatement.run).toHaveBeenCalledWith(
        validEVMClaim.messageId,
        'peer-bob',
        'evm',
        validEVMClaim.channelId,
        JSON.stringify(validEVMClaim),
        0, // verified=false
        expect.any(Number),
        null,
        null
      );
    });

    it('should handle Solana claim with no registered provider', async () => {
      // Solana claims now pass structural validation but no Solana provider is registered
      const solanaClaim = {
        version: '1.0',
        blockchain: 'solana',
        messageId: 'solana-test-1',
        timestamp: '2026-02-02T12:00:00.000Z',
        senderId: 'peer-bob',
        programId: '11111111111111111111111111111111',
        channelAccount: '22222222222222222222222222222222',
        nonce: 1,
        transferredAmount: '1000000',
        signature: 'c2lnbmF0dXJlLWRhdGE=',
        signerPublicKey: '33333333333333333333333333333333',
      };

      const solanaProtocolData: BTPProtocolData = {
        protocolName: 'payment-channel-claim',
        contentType: 1,
        data: Buffer.from(JSON.stringify(solanaClaim), 'utf8'),
      };

      const solanaBtpMessage: BTPMessage = {
        type: 6,
        requestId: 1,
        data: {
          protocolData: [solanaProtocolData],
          transfer: {
            amount: '0',
            expiresAt: new Date(Date.now() + 30000).toISOString(),
          },
        } as BTPData,
      };

      claimReceiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-bob', solanaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // No Solana provider registered — claim persisted as unverified
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'solana-test-1', blockchain: 'solana' }),
        expect.stringContaining('No provider registered')
      );
    });
  });

  // Aptos claim handling removed in Epic 30 Story 30.4 - EVM-only settlement

  describe('Error Handling', () => {
    it('should handle invalid JSON parsing gracefully', async () => {
      const protocolData: BTPProtocolData = {
        protocolName: 'payment-channel-claim',
        contentType: 1,
        data: Buffer.from('invalid json', 'utf8'),
      };

      const btpMessage: BTPMessage = {
        type: 6,
        requestId: 1,
        data: {
          protocolData: [protocolData],
          transfer: {
            amount: '0',
            expiresAt: new Date(Date.now() + 30000).toISOString(),
          },
        } as BTPData,
      };

      claimReceiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-bob', btpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify error logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        { error: expect.any(Error) },
        'Failed to parse claim message'
      );

      // Verify no database insert
      expect(mockStatement.run).not.toHaveBeenCalled();
    });

    it('should handle database persistence failure gracefully', async () => {
      const validEVMClaim: EVMClaimMessage = {
        version: '1.0',
        blockchain: 'evm',
        messageId: 'evm-test-123',
        timestamp: '2026-02-02T12:00:00.000Z',
        senderId: 'peer-bob',
        channelId: '0x' + 'a'.repeat(64),
        nonce: 1,
        transferredAmount: '1000000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
        signature: '0x' + 'b'.repeat(130),
        signerAddress: '0x' + 'c'.repeat(40),
      };

      const protocolData: BTPProtocolData = {
        protocolName: 'payment-channel-claim',
        contentType: 1,
        data: Buffer.from(JSON.stringify(validEVMClaim), 'utf8'),
      };

      const btpMessage: BTPMessage = {
        type: 6,
        requestId: 1,
        data: {
          protocolData: [protocolData],
          transfer: {
            amount: '0',
            expiresAt: new Date(Date.now() + 30000).toISOString(),
          },
        } as BTPData,
      };

      mockProvider.verifyBalanceProof.mockResolvedValue(true);
      mockStatement.get.mockReturnValue(undefined);
      mockStatement.run.mockImplementation(() => {
        throw new Error('Database error');
      });

      claimReceiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-bob', btpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify error logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        { error: expect.any(Error) },
        'Failed to persist claim to database'
      );
    });

    it('should handle duplicate message IDs gracefully (idempotency)', async () => {
      const validEVMClaim: EVMClaimMessage = {
        version: '1.0',
        blockchain: 'evm',
        messageId: 'evm-test-123',
        timestamp: '2026-02-02T12:00:00.000Z',
        senderId: 'peer-bob',
        channelId: '0x' + 'a'.repeat(64),
        nonce: 1,
        transferredAmount: '1000000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
        signature: '0x' + 'b'.repeat(130),
        signerAddress: '0x' + 'c'.repeat(40),
      };

      const protocolData: BTPProtocolData = {
        protocolName: 'payment-channel-claim',
        contentType: 1,
        data: Buffer.from(JSON.stringify(validEVMClaim), 'utf8'),
      };

      const btpMessage: BTPMessage = {
        type: 6,
        requestId: 1,
        data: {
          protocolData: [protocolData],
          transfer: {
            amount: '0',
            expiresAt: new Date(Date.now() + 30000).toISOString(),
          },
        } as BTPData,
      };

      mockProvider.verifyBalanceProof.mockResolvedValue(true);
      mockStatement.get.mockReturnValue(undefined);
      mockStatement.run.mockImplementation(() => {
        const error = new Error('UNIQUE constraint failed: received_claims.message_id');
        throw error;
      });

      claimReceiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-bob', btpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify warning logged for duplicate
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { messageId: validEVMClaim.messageId },
        'Duplicate claim message ignored (idempotency)'
      );
    });
  });

  describe('dynamic on-chain verification (Epic 31.2)', () => {
    let dynamicReceiver: ClaimReceiver;
    let mockChannelManager: jest.Mocked<ChannelManager>;
    let dynamicBtpHandler: ((peerId: string, message: BTPMessage) => void) | null;
    let dynamicBTPServer: jest.Mocked<BTPServer>;

    const mockChannelId = '0x' + 'a'.repeat(64);
    const mockSignerAddress = '0x' + 'c'.repeat(40);
    const mockParticipant1 = '0x' + 'c'.repeat(40); // matches signerAddress
    const mockParticipant2 = '0x' + 'd'.repeat(40);
    const mockTokenNetworkAddress = '0x' + 'e'.repeat(40);
    const mockTokenAddress = '0x' + 'f'.repeat(40);

    function makeClaimWithSelfDescribing(
      overrides: Partial<EVMClaimMessage> = {}
    ): EVMClaimMessage {
      return {
        version: '1.0',
        blockchain: 'evm',
        messageId: 'evm-dynamic-test-1',
        timestamp: '2026-03-07T12:00:00.000Z',
        senderId: 'peer-new',
        channelId: mockChannelId,
        nonce: 1,
        transferredAmount: '1000000000000000000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
        signature: '0x' + 'b'.repeat(130),
        signerAddress: mockSignerAddress,
        chainId: 31337,
        tokenNetworkAddress: mockTokenNetworkAddress,
        tokenAddress: mockTokenAddress,
        ...overrides,
      };
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

    beforeEach(() => {
      dynamicBtpHandler = null;

      mockChannelManager = {
        getChannelById: jest.fn().mockReturnValue(null), // unknown channel by default
        registerExternalChannel: jest.fn().mockReturnValue({
          channelId: mockChannelId,
          peerId: 'peer-new',
          tokenId: mockTokenAddress,
          tokenAddress: mockTokenAddress,
          chain: 'evm:31337',
          createdAt: new Date(),
          lastActivityAt: new Date(),
          status: 'open',
        }),
      } as unknown as jest.Mocked<ChannelManager>;

      // Reset provider mocks for dynamic verification
      mockProvider.getChannelState.mockResolvedValue({
        channelId: mockChannelId,
        status: 'opened' as const,
        participants: [mockParticipant1, mockParticipant2],
        deposit: 10000n,
      });
      mockProvider.verifyBalanceProof.mockResolvedValue(true);

      dynamicBTPServer = {
        onMessage: jest.fn((handler) => {
          dynamicBtpHandler = handler;
        }),
      } as unknown as jest.Mocked<BTPServer>;

      dynamicReceiver = new ClaimReceiver(
        mockDb,
        mockRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        mockChannelManager
      );

      dynamicReceiver.registerWithBTPServer(dynamicBTPServer);
    });

    it('should accept unknown channel with valid on-chain state and register it', async () => {
      const claim = makeClaimWithSelfDescribing();
      mockStatement.get.mockReturnValue(undefined); // No previous claim

      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify on-chain query via provider
      expect(mockProvider.getChannelState).toHaveBeenCalledWith(mockChannelId);

      // Verify signature via provider (single object with string amounts)
      expect(mockProvider.verifyBalanceProof).toHaveBeenCalledWith({
        channelId: mockChannelId,
        nonce: claim.nonce,
        transferredAmount: claim.transferredAmount,
        lockedAmount: claim.lockedAmount,
        locksRoot: claim.locksRoot,
        signature: claim.signature,
        signerAddress: claim.signerAddress,
      });

      // Verify channel registered
      expect(mockChannelManager.registerExternalChannel).toHaveBeenCalledWith({
        channelId: mockChannelId,
        peerId: 'peer-new',
        tokenAddress: mockTokenAddress,
        tokenNetworkAddress: mockTokenNetworkAddress,
        chainId: 31337,
        status: 'open',
      });

      // Verify claim stored as verified
      expect(mockStatement.run).toHaveBeenCalledWith(
        claim.messageId,
        'peer-new',
        'evm',
        mockChannelId,
        JSON.stringify(claim),
        1, // verified=true
        expect.any(Number),
        null,
        null
      );
    });

    it('should reject unknown channel with non-existent channel (provider throws)', async () => {
      mockProvider.getChannelState.mockRejectedValueOnce(new Error('Channel not found'));

      const claim = makeClaimWithSelfDescribing();
      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: mockChannelId,
        }),
        ERRORS.ON_CHAIN_VERIFICATION_FAILED
      );
    });

    it('should reject unknown channel with closed channel', async () => {
      mockProvider.getChannelState.mockResolvedValueOnce({
        channelId: mockChannelId,
        status: 'closed' as const,
        participants: [mockParticipant1, mockParticipant2],
        deposit: 10000n,
      });

      const claim = makeClaimWithSelfDescribing();
      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: mockChannelId,
        }),
        ERRORS.CHANNEL_NOT_OPENED
      );
    });

    it('should reject unknown channel where signerAddress is not participant', async () => {
      mockProvider.getChannelState.mockResolvedValueOnce({
        channelId: mockChannelId,
        status: 'opened' as const,
        participants: ['0x' + '1'.repeat(40), '0x' + '2'.repeat(40)],
        deposit: 10000n,
      });

      const claim = makeClaimWithSelfDescribing();
      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: mockChannelId,
        }),
        ERRORS.SIGNER_NOT_PARTICIPANT
      );
    });

    it('should skip RPC for second claim on same channel (caching)', async () => {
      // First claim: unknown channel -> RPC
      mockStatement.get.mockReturnValue(undefined);

      const claim1 = makeClaimWithSelfDescribing({ nonce: 1 });
      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim1));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockProvider.getChannelState).toHaveBeenCalledTimes(1);

      // Second claim: channel now known -> no RPC
      mockChannelManager.getChannelById.mockReturnValue({
        channelId: mockChannelId,
        peerId: 'peer-new',
        tokenId: mockTokenAddress,
        tokenAddress: mockTokenAddress,
        chain: 'evm:31337',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      });
      mockProvider.verifyBalanceProof.mockResolvedValue(true);

      const claim2 = makeClaimWithSelfDescribing({
        nonce: 2,
        messageId: 'evm-dynamic-test-2',
      });
      // Return nonce-1 claim for monotonicity check
      mockStatement.get.mockReturnValue({
        claim_data: JSON.stringify(claim1),
      });
      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim2));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // getChannelState should NOT have been called again
      expect(mockProvider.getChannelState).toHaveBeenCalledTimes(1);
      // verifyBalanceProof used for known channel
      expect(mockProvider.verifyBalanceProof).toHaveBeenCalled();
    });

    it('should reject unknown channel missing self-describing fields', async () => {
      // Missing chainId
      const claim1 = makeClaimWithSelfDescribing({ chainId: undefined });
      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim1));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: mockChannelId,
        }),
        ERRORS.MISSING_SELF_DESCRIBING_FIELDS
      );

      // Missing tokenNetworkAddress
      jest.clearAllMocks();
      mockChannelManager.getChannelById.mockReturnValue(null);
      // Reset provider mocks after clearAllMocks
      mockProvider.getChannelState.mockResolvedValue({
        channelId: mockChannelId,
        status: 'opened' as const,
        participants: [mockParticipant1, mockParticipant2],
        deposit: 10000n,
      });
      mockProvider.verifyBalanceProof.mockResolvedValue(true);
      mockRegistry.getProvider.mockImplementation((_chainType: string, chainId: string) => {
        if (chainId === 'evm:31337') return mockProvider;
        return undefined;
      });
      mockRegistry.getAllProviders.mockReturnValue([mockProvider]);
      const claim2 = makeClaimWithSelfDescribing({ tokenNetworkAddress: undefined });
      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim2));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: mockChannelId,
        }),
        ERRORS.MISSING_SELF_DESCRIBING_FIELDS
      );

      // Missing tokenAddress
      jest.clearAllMocks();
      mockChannelManager.getChannelById.mockReturnValue(null);
      // Reset provider mocks after clearAllMocks
      mockProvider.getChannelState.mockResolvedValue({
        channelId: mockChannelId,
        status: 'opened' as const,
        participants: [mockParticipant1, mockParticipant2],
        deposit: 10000n,
      });
      mockProvider.verifyBalanceProof.mockResolvedValue(true);
      mockRegistry.getProvider.mockImplementation((_chainType: string, chainId: string) => {
        if (chainId === 'evm:31337') return mockProvider;
        return undefined;
      });
      mockRegistry.getAllProviders.mockReturnValue([mockProvider]);
      const claim3 = makeClaimWithSelfDescribing({ tokenAddress: undefined });
      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim3));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: mockChannelId,
        }),
        ERRORS.MISSING_SELF_DESCRIBING_FIELDS
      );
    });

    it('should reject on RPC failure during verification', async () => {
      mockProvider.getChannelState.mockRejectedValueOnce(new Error('network timeout'));

      const claim = makeClaimWithSelfDescribing();
      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: mockChannelId,
        }),
        ERRORS.ON_CHAIN_VERIFICATION_FAILED
      );
    });

    it('should reject when provider.verifyBalanceProof throws an error', async () => {
      mockProvider.verifyBalanceProof.mockRejectedValueOnce(new Error('Provider internal error'));

      const claim = makeClaimWithSelfDescribing();
      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verification failed — claim stored as unverified
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: claim.messageId, error: 'Provider internal error' }),
        'Claim verification failed'
      );

      // Channel should NOT be registered
      expect(mockChannelManager.registerExternalChannel).not.toHaveBeenCalled();
    });

    it('should reject when EIP-712 signature verification fails for unknown channel', async () => {
      mockProvider.verifyBalanceProof.mockResolvedValueOnce(false);

      const claim = makeClaimWithSelfDescribing();
      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Claim should be stored as unverified
      expect(mockStatement.run).toHaveBeenCalledWith(
        claim.messageId,
        'peer-new',
        'evm',
        mockChannelId,
        expect.any(String),
        0, // verified=false
        expect.any(Number),
        null,
        null
      );

      // Channel should NOT be registered if signature fails
      expect(mockChannelManager.registerExternalChannel).not.toHaveBeenCalled();
    });

    it('should register peer EVM address in peerIdToAddressMap after successful self-describing claim', async () => {
      const peerIdToAddressMap = new Map<string, string>();
      const receiverWithMap = new ClaimReceiver(
        mockDb,
        mockRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        mockChannelManager,
        peerIdToAddressMap
      );

      const mapBTPServer = {
        onMessage: jest.fn((handler) => {
          dynamicBtpHandler = handler;
        }),
      } as unknown as jest.Mocked<BTPServer>;
      receiverWithMap.registerWithBTPServer(mapBTPServer);

      const claim = makeClaimWithSelfDescribing();
      mockStatement.get.mockReturnValue(undefined);

      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify peer address was registered
      expect(peerIdToAddressMap.get('peer-new')).toBe(mockSignerAddress);
    });

    it('should NOT overwrite pre-existing static config entry in peerIdToAddressMap', async () => {
      const existingAddress = '0x' + '9'.repeat(40);
      const peerIdToAddressMap = new Map<string, string>([['peer-new', existingAddress]]);
      const receiverWithMap = new ClaimReceiver(
        mockDb,
        mockRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        mockChannelManager,
        peerIdToAddressMap
      );

      const mapBTPServer = {
        onMessage: jest.fn((handler) => {
          dynamicBtpHandler = handler;
        }),
      } as unknown as jest.Mocked<BTPServer>;
      receiverWithMap.registerWithBTPServer(mapBTPServer);

      const claim = makeClaimWithSelfDescribing();
      mockStatement.get.mockReturnValue(undefined);

      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify pre-existing entry was NOT overwritten
      expect(peerIdToAddressMap.get('peer-new')).toBe(existingAddress);
    });

    it('should work without error when peerIdToAddressMap is not provided', async () => {
      // dynamicReceiver is created without peerIdToAddressMap (uses the beforeEach setup)
      const claim = makeClaimWithSelfDescribing();
      mockStatement.get.mockReturnValue(undefined);

      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify claim still processed successfully (stored as verified)
      expect(mockStatement.run).toHaveBeenCalledWith(
        claim.messageId,
        'peer-new',
        'evm',
        mockChannelId,
        JSON.stringify(claim),
        1, // verified=true
        expect.any(Number),
        null,
        null
      );
    });

    it('should work with pre-registered channel without self-describing fields (backward compat)', async () => {
      // Channel is already known
      mockChannelManager.getChannelById.mockReturnValue({
        channelId: mockChannelId,
        peerId: 'peer-new',
        tokenId: 'TEST_TOKEN',
        tokenAddress: mockTokenAddress,
        chain: 'evm:31337',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      });
      mockProvider.verifyBalanceProof.mockResolvedValue(true);
      mockStatement.get.mockReturnValue(undefined);

      // Claim WITHOUT self-describing fields
      const claim = makeClaimWithSelfDescribing({
        chainId: undefined,
        tokenNetworkAddress: undefined,
        tokenAddress: undefined,
      });

      await dynamicBtpHandler!('peer-new', makeBTPMessage(claim));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should use provider.verifyBalanceProof, not the dynamic path
      expect(mockProvider.verifyBalanceProof).toHaveBeenCalled();
      expect(mockProvider.getChannelState).not.toHaveBeenCalled();

      // Should store as verified
      expect(mockStatement.run).toHaveBeenCalledWith(
        claim.messageId,
        'peer-new',
        'evm',
        mockChannelId,
        expect.any(String),
        1, // verified
        expect.any(Number),
        null,
        null
      );
    });
  });

  describe('AC-2: No provider registered rejection (T-32.6-02)', () => {
    let registeredReceiver: ClaimReceiver;
    let noProviderBtpHandler: ((peerId: string, message: BTPMessage) => void) | null;

    beforeEach(() => {
      noProviderBtpHandler = null;

      // Create a registry that returns NO provider for any chain
      const emptyRegistry = {
        getProvider: jest.fn().mockReturnValue(undefined),
        getProviderForPeer: jest.fn().mockReturnValue(undefined),
        getAllProviders: jest.fn().mockReturnValue([]),
      };

      registeredReceiver = new ClaimReceiver(
        mockDb,
        emptyRegistry as unknown as ChainProviderRegistry,
        mockLogger
      );

      const noProviderBTPServer = {
        onMessage: jest.fn((handler) => {
          noProviderBtpHandler = handler;
        }),
      } as unknown as jest.Mocked<BTPServer>;

      registeredReceiver.registerWithBTPServer(noProviderBTPServer);
    });

    it('should reject EVM claim with NO_PROVIDER_REGISTERED error when registry has no provider', async () => {
      const evmClaim: EVMClaimMessage = {
        version: '1.0',
        blockchain: 'evm',
        messageId: 'evm-no-provider-1',
        timestamp: '2026-02-02T12:00:00.000Z',
        senderId: 'peer-bob',
        channelId: '0x' + 'a'.repeat(64),
        nonce: 1,
        transferredAmount: '1000000000000000000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
        signature: '0x' + 'b'.repeat(130),
        signerAddress: '0x' + 'c'.repeat(40),
      };

      const protocolData: BTPProtocolData = {
        protocolName: 'payment-channel-claim',
        contentType: 1,
        data: Buffer.from(JSON.stringify(evmClaim), 'utf8'),
      };

      const btpMessage: BTPMessage = {
        type: 6,
        requestId: 1,
        data: {
          protocolData: [protocolData],
          transfer: {
            amount: '0',
            expiresAt: new Date(Date.now() + 30000).toISOString(),
          },
        } as BTPData,
      };

      await noProviderBtpHandler!('peer-bob', btpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify warning logged with NO_PROVIDER_REGISTERED error
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: evmClaim.messageId,
          blockchain: 'evm',
        }),
        `${ERRORS.NO_PROVIDER_REGISTERED} evm`
      );

      // Verify claim persisted with verified: false
      expect(mockStatement.run).toHaveBeenCalledWith(
        evmClaim.messageId,
        'peer-bob',
        'evm',
        evmClaim.channelId,
        JSON.stringify(evmClaim),
        0, // verified=false
        expect.any(Number),
        null,
        null
      );
    });

    it('should not emit CLAIM_RECEIVED event when no provider is registered', async () => {
      const evmClaim: EVMClaimMessage = {
        version: '1.0',
        blockchain: 'evm',
        messageId: 'evm-no-provider-2',
        timestamp: '2026-02-02T12:00:00.000Z',
        senderId: 'peer-bob',
        channelId: '0x' + 'a'.repeat(64),
        nonce: 1,
        transferredAmount: '1000000000000000000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
        signature: '0x' + 'b'.repeat(130),
        signerAddress: '0x' + 'c'.repeat(40),
      };

      const protocolData: BTPProtocolData = {
        protocolName: 'payment-channel-claim',
        contentType: 1,
        data: Buffer.from(JSON.stringify(evmClaim), 'utf8'),
      };

      const btpMessage: BTPMessage = {
        type: 6,
        requestId: 1,
        data: {
          protocolData: [protocolData],
          transfer: {
            amount: '0',
            expiresAt: new Date(Date.now() + 30000).toISOString(),
          },
        } as BTPData,
      };

      const claimReceivedListener = jest.fn();
      registeredReceiver.on('CLAIM_RECEIVED', claimReceivedListener);

      await noProviderBtpHandler!('peer-bob', btpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(claimReceivedListener).not.toHaveBeenCalled();
    });
  });

  describe('AC-5: No direct PaymentChannelSDK dependency (T-32.6-06)', () => {
    it('should not import PaymentChannelSDK in claim-receiver.ts source', () => {
      const sourceFile = path.join(__dirname, 'claim-receiver.ts');
      const sourceCode = fs.readFileSync(sourceFile, 'utf8');

      // The source file should not contain any import of PaymentChannelSDK
      expect(sourceCode).not.toContain('PaymentChannelSDK');
    });

    it('should accept ChainProviderRegistry in constructor (not PaymentChannelSDK)', () => {
      // Verify ClaimReceiver can be constructed with a mock registry
      const receiver = new ClaimReceiver(
        mockDb,
        mockRegistry as unknown as ChainProviderRegistry,
        mockLogger
      );
      expect(receiver).toBeInstanceOf(ClaimReceiver);
    });
  });

  describe('dynamic verification: settled channel status (T-32.6-09 extended)', () => {
    let dynamicReceiver: ClaimReceiver;
    let mockChannelManager: jest.Mocked<ChannelManager>;
    let dynamicBtpHandler: ((peerId: string, message: BTPMessage) => void) | null;

    const mockChannelId = '0x' + 'a'.repeat(64);
    const mockSignerAddress = '0x' + 'c'.repeat(40);
    const mockTokenNetworkAddress = '0x' + 'e'.repeat(40);
    const mockTokenAddress = '0x' + 'f'.repeat(40);

    beforeEach(() => {
      dynamicBtpHandler = null;

      mockChannelManager = {
        getChannelById: jest.fn().mockReturnValue(null),
        registerExternalChannel: jest.fn(),
      } as unknown as jest.Mocked<ChannelManager>;

      dynamicReceiver = new ClaimReceiver(
        mockDb,
        mockRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        mockChannelManager
      );

      const btpServer = {
        onMessage: jest.fn((handler) => {
          dynamicBtpHandler = handler;
        }),
      } as unknown as jest.Mocked<BTPServer>;

      dynamicReceiver.registerWithBTPServer(btpServer);
    });

    it('should reject unknown channel with settled status', async () => {
      mockProvider.getChannelState.mockResolvedValueOnce({
        channelId: mockChannelId,
        status: 'settled' as const,
        participants: [mockSignerAddress, '0x' + 'd'.repeat(40)],
        deposit: 10000n,
      });

      const claim: EVMClaimMessage = {
        version: '1.0',
        blockchain: 'evm',
        messageId: 'evm-settled-test-1',
        timestamp: '2026-03-07T12:00:00.000Z',
        senderId: 'peer-new',
        channelId: mockChannelId,
        nonce: 1,
        transferredAmount: '1000000000000000000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
        signature: '0x' + 'b'.repeat(130),
        signerAddress: mockSignerAddress,
        chainId: 31337,
        tokenNetworkAddress: mockTokenNetworkAddress,
        tokenAddress: mockTokenAddress,
      };

      const btpMessage: BTPMessage = {
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

      await dynamicBtpHandler!('peer-new', btpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Settled channels should be rejected with CHANNEL_NOT_OPENED
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: mockChannelId,
        }),
        ERRORS.CHANNEL_NOT_OPENED
      );

      // Claim should be stored as unverified
      expect(mockStatement.run).toHaveBeenCalledWith(
        claim.messageId,
        'peer-new',
        'evm',
        mockChannelId,
        expect.any(String),
        0, // verified=false
        expect.any(Number),
        null,
        null
      );
    });
  });

  describe('known channel provider resolution via chain metadata (T-32.6-11)', () => {
    let knownChannelReceiver: ClaimReceiver;
    let mockChannelManager: jest.Mocked<ChannelManager>;
    let knownBtpHandler: ((peerId: string, message: BTPMessage) => void) | null;

    const mockChannelId = '0x' + 'a'.repeat(64);

    beforeEach(() => {
      knownBtpHandler = null;

      mockChannelManager = {
        getChannelById: jest.fn().mockReturnValue({
          channelId: mockChannelId,
          peerId: 'peer-bob',
          tokenId: 'TEST_TOKEN',
          tokenAddress: '0x' + 'f'.repeat(40),
          chain: 'evm:31337',
          createdAt: new Date(),
          lastActivityAt: new Date(),
          status: 'open',
        }),
        registerExternalChannel: jest.fn(),
      } as unknown as jest.Mocked<ChannelManager>;

      knownChannelReceiver = new ClaimReceiver(
        mockDb,
        mockRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        mockChannelManager
      );

      const btpServer = {
        onMessage: jest.fn((handler) => {
          knownBtpHandler = handler;
        }),
      } as unknown as jest.Mocked<BTPServer>;

      knownChannelReceiver.registerWithBTPServer(btpServer);
    });

    it('should resolve provider using channel chain metadata for known channels', async () => {
      mockProvider.verifyBalanceProof.mockResolvedValue(true);
      mockStatement.get.mockReturnValue(undefined);

      const claim: EVMClaimMessage = {
        version: '1.0',
        blockchain: 'evm',
        messageId: 'evm-known-chain-1',
        timestamp: '2026-03-07T12:00:00.000Z',
        senderId: 'peer-bob',
        channelId: mockChannelId,
        nonce: 1,
        transferredAmount: '1000000000000000000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
        signature: '0x' + 'b'.repeat(130),
        signerAddress: '0x' + 'c'.repeat(40),
      };

      const btpMessage: BTPMessage = {
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

      await knownBtpHandler!('peer-bob', btpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify registry.getProvider was called with the channel's chain metadata
      expect(mockRegistry.getProvider).toHaveBeenCalledWith('evm', 'evm:31337');

      // Verify provider.verifyBalanceProof was called (known channel path)
      expect(mockProvider.verifyBalanceProof).toHaveBeenCalledWith({
        channelId: mockChannelId,
        nonce: claim.nonce,
        transferredAmount: claim.transferredAmount,
        lockedAmount: claim.lockedAmount,
        locksRoot: claim.locksRoot,
        signature: claim.signature,
        signerAddress: claim.signerAddress,
      });

      // Verify getChannelState was NOT called (known channel skips on-chain check)
      expect(mockProvider.getChannelState).not.toHaveBeenCalled();

      // Verified claim stored
      expect(mockStatement.run).toHaveBeenCalledWith(
        claim.messageId,
        'peer-bob',
        'evm',
        mockChannelId,
        expect.any(String),
        1, // verified=true
        expect.any(Number),
        null,
        null
      );
    });
  });

  describe('getLatestVerifiedClaim', () => {
    it('should return latest verified claim for peer and channel', async () => {
      const storedClaim: EVMClaimMessage = {
        version: '1.0',
        blockchain: 'evm',
        messageId: 'evm-test-123',
        timestamp: '2026-02-02T12:00:00.000Z',
        senderId: 'peer-bob',
        channelId: '0x' + 'a'.repeat(64),
        nonce: 1,
        transferredAmount: '1000000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
        signature: '0x' + 'b'.repeat(130),
        signerAddress: '0x' + 'c'.repeat(40),
      };

      mockStatement.get.mockReturnValue({
        claim_data: JSON.stringify(storedClaim),
      });

      const result = await claimReceiver.getLatestVerifiedClaim(
        'peer-bob',
        'evm',
        '0x' + 'a'.repeat(64)
      );

      expect(result).toEqual(storedClaim);
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT claim_data'));
      expect(mockStatement.get).toHaveBeenCalledWith('peer-bob', 'evm', '0x' + 'a'.repeat(64));
    });

    it('should return null if no verified claim found', async () => {
      mockStatement.get.mockReturnValue(undefined);

      const result = await claimReceiver.getLatestVerifiedClaim(
        'peer-bob',
        'evm',
        '0x' + 'a'.repeat(64)
      );

      expect(result).toBeNull();
    });

    it('should return null and log error on database failure', async () => {
      mockStatement.get.mockImplementation(() => {
        throw new Error('Database error');
      });

      const result = await claimReceiver.getLatestVerifiedClaim(
        'peer-bob',
        'evm',
        '0x' + 'a'.repeat(64)
      );

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        { error: expect.any(Error) },
        'Failed to query latest verified claim'
      );
    });
  });
});
