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
import type { EVMClaimMessage, SolanaClaimMessage, MinaClaimMessage } from '../btp/btp-claim-types';
import type { ProviderChannelState } from './provider/payment-channel-provider';
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

    it('should handle Mina claim with no registered provider', async () => {
      // Mina claims pass structural validation but no Mina provider is registered
      const minaClaim = {
        version: '1.0',
        blockchain: 'mina',
        messageId: 'mina-test-1',
        timestamp: '2026-02-02T12:00:00.000Z',
        senderId: 'peer-bob',
        zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
        tokenId: 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf',
        balanceCommitment: '12345678901234567890',
        nonce: 1,
        proof: 'eyJwcm9vZiI6InRlc3QifQ==',
        salt: 'abcdef1234567890',
        network: 'devnet',
      };

      const minaProtocolData: BTPProtocolData = {
        protocolName: 'payment-channel-claim',
        contentType: 1,
        data: Buffer.from(JSON.stringify(minaClaim), 'utf8'),
      };

      const minaBtpMessage: BTPMessage = {
        type: 6,
        requestId: 1,
        data: {
          protocolData: [minaProtocolData],
          transfer: {
            amount: '0',
            expiresAt: new Date(Date.now() + 30000).toISOString(),
          },
        } as BTPData,
      };

      claimReceiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-bob', minaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // No Mina provider registered — claim persisted as unverified
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'mina-test-1', blockchain: 'mina' }),
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

      // Verify channel registered with the resolved provider's canonical
      // chainId so subsequent claims hit the known-channel lookup path.
      expect(mockChannelManager.registerExternalChannel).toHaveBeenCalledWith({
        channelId: mockChannelId,
        peerId: 'peer-new',
        tokenAddress: mockTokenAddress,
        tokenNetworkAddress: mockTokenNetworkAddress,
        chainId: 31337,
        chain: 'evm:31337',
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

  // Issue #56: registry key format can differ between admin-opened channels
  // (e.g. `evm:base:31337` set by the Admin API) and the numeric form a
  // self-describing claim from an externally-opened channel carries
  // (`evm:31337`). Either side may be the registered key depending on the
  // operator's YAML, so resolveProvider must tolerate both directions.
  describe('chain-key lookup fallback (issue #56)', () => {
    const mockChannelId = '0x' + 'a'.repeat(64);
    const mockSignerAddress = '0x' + 'c'.repeat(40);
    const mockTokenNetworkAddress = '0x' + 'e'.repeat(40);
    const mockTokenAddress = '0x' + 'f'.repeat(40);

    function makeClaim(overrides: Partial<EVMClaimMessage> = {}): EVMClaimMessage {
      return {
        version: '1.0',
        blockchain: 'evm',
        messageId: 'evm-issue-56-1',
        timestamp: '2026-03-07T12:00:00.000Z',
        senderId: 'peer-bob',
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

    function makeReceiverWithRegisteredChainId(
      providerChainId: string,
      knownChannelChain?: string
    ): {
      receiver: ClaimReceiver;
      handler: () => (peerId: string, message: BTPMessage) => void;
      provider: jest.Mocked<PaymentChannelProvider>;
      registry: jest.Mocked<
        Pick<ChainProviderRegistry, 'getProvider' | 'getProviderForPeer' | 'getAllProviders'>
      >;
      channelManager: jest.Mocked<ChannelManager>;
    } {
      const provider = createMockProvider();
      // Override the provider's chainId to match the operator-configured form.
      Object.defineProperty(provider, 'chainId', { value: providerChainId, writable: false });
      provider.getChannelState.mockResolvedValue({
        channelId: mockChannelId,
        status: 'opened' as const,
        participants: [mockSignerAddress, '0x' + 'd'.repeat(40)],
        deposit: 10000n,
      });
      provider.verifyBalanceProof.mockResolvedValue(true);

      const registry = {
        getProvider: jest
          .fn()
          .mockImplementation((_chainType: string, chainId: string) =>
            chainId === providerChainId ? provider : undefined
          ),
        getProviderForPeer: jest.fn().mockReturnValue(provider),
        getAllProviders: jest.fn().mockReturnValue([provider]),
      } as jest.Mocked<
        Pick<ChainProviderRegistry, 'getProvider' | 'getProviderForPeer' | 'getAllProviders'>
      >;

      const channelManager = {
        getChannelById: jest.fn().mockReturnValue(
          knownChannelChain
            ? {
                channelId: mockChannelId,
                peerId: 'peer-bob',
                tokenId: mockTokenAddress,
                tokenAddress: mockTokenAddress,
                chain: knownChannelChain,
                createdAt: new Date(),
                lastActivityAt: new Date(),
                status: 'open',
              }
            : null
        ),
        registerExternalChannel: jest.fn().mockReturnValue({
          channelId: mockChannelId,
          peerId: 'peer-bob',
          tokenId: mockTokenAddress,
          tokenAddress: mockTokenAddress,
          chain: providerChainId,
          createdAt: new Date(),
          lastActivityAt: new Date(),
          status: 'open',
        }),
      } as unknown as jest.Mocked<ChannelManager>;

      let captured: ((peerId: string, message: BTPMessage) => void) | null = null;
      const btpServer = {
        onMessage: jest.fn((h) => {
          captured = h;
        }),
      } as unknown as jest.Mocked<BTPServer>;

      const receiver = new ClaimReceiver(
        mockDb,
        registry as unknown as ChainProviderRegistry,
        mockLogger,
        channelManager
      );
      receiver.registerWithBTPServer(btpServer);

      return {
        receiver,
        handler: () => captured!,
        provider,
        registry,
        channelManager,
      };
    }

    it('resolves provider via numeric-id suffix when registry is keyed evm:<network>:<id>', async () => {
      // Operator YAML uses `chainProviders[].chainId = 'evm:base:31337'` —
      // matches the Admin API's `evm:<network>:<chainId>` form.
      const { handler, provider, channelManager } =
        makeReceiverWithRegisteredChainId('evm:base:31337');
      mockStatement.get.mockReturnValue(undefined);

      // Externally-opened channel: claim arrives with numeric chainId only.
      await handler()('peer-bob', makeBTPMessage(makeClaim()));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Suffix match resolves the registered provider despite key-format
      // mismatch — getChannelState is reached, channel registers as known.
      expect(provider.getChannelState).toHaveBeenCalledWith(mockChannelId);
      expect(channelManager.registerExternalChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: mockChannelId,
          chainId: 31337,
          // Persisted with the resolved provider's canonical chainId so the
          // next claim hits the known-channel exact-match path directly.
          chain: 'evm:base:31337',
        })
      );
    });

    it('resolves provider for known channel stored as evm:<network>:<id> when registry is keyed evm:<id>', async () => {
      // Mirror direction: registered key is `evm:31337`, but the channel
      // metadata persisted by the Admin API uses `evm:base:31337`.
      const { handler, provider } = makeReceiverWithRegisteredChainId(
        'evm:31337',
        'evm:base:31337'
      );
      mockStatement.get.mockReturnValue(undefined);

      await handler()('peer-bob', makeBTPMessage(makeClaim()));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Known-channel exact lookup misses (`evm:base:31337` not registered),
      // self-describing chainId direct lookup hits (`evm:31337` is registered).
      // Provider resolves; signature path runs; claim verifies.
      expect(provider.verifyBalanceProof).toHaveBeenCalled();
      expect(mockStatement.run).toHaveBeenCalledWith(
        'evm-issue-56-1',
        'peer-bob',
        'evm',
        mockChannelId,
        expect.any(String),
        1,
        expect.any(Number),
        null,
        null
      );
    });

    it('falls back to chainType-only match when no key form matches', async () => {
      // Edge case: operator-registered key `evm:weird-alias:31337` doesn't
      // contain the numeric chainId at all. Suffix match misses, but the
      // chainType fallback still resolves since there's exactly one EVM
      // provider.
      const { handler, provider } = makeReceiverWithRegisteredChainId('evm:weird-alias');
      mockStatement.get.mockReturnValue(undefined);

      await handler()('peer-bob', makeBTPMessage(makeClaim()));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(provider.getChannelState).toHaveBeenCalledWith(mockChannelId);
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

  /**
   * Acceptance Tests for Story 33.6: Solana Claim Verification in ClaimReceiver
   *
   * Tests Ed25519 signature verification via provider, on-chain channel state checks,
   * case-sensitive participant validation, nonce monotonicity, challenge period acceptance,
   * dynamic channel registration, and CLAIM_RECEIVED event emission for Solana claims.
   */
  describe('Solana claim verification (Story 33.6)', () => {
    const SOLANA_PROGRAM_ID = 'PayChan11111111111111111111111111111111111';
    const SOLANA_CHANNEL_ACCOUNT = 'AbCdEfGh11111111111111111111111111111111111';
    const SOLANA_SIGNER_PUBKEY = 'SiGnEr111111111111111111111111111111111111';
    const SOLANA_PARTICIPANT_2 = 'PaRtIcIpAnT22222222222222222222222222222222';
    const SOLANA_SIGNATURE = 'c29sYW5hLXNpZ25hdHVyZS1kYXRh';

    let validSolanaClaim: SolanaClaimMessage;
    let solanaProtocolData: BTPProtocolData;
    let solanaBtpMessage: BTPMessage;

    // Create a mock Solana provider
    function createMockSolanaProvider(): jest.Mocked<PaymentChannelProvider> {
      return {
        verifyBalanceProof: jest.fn().mockResolvedValue(true),
        getChannelState: jest.fn().mockResolvedValue({
          channelId: SOLANA_CHANNEL_ACCOUNT,
          status: 'opened' as const,
          participants: [SOLANA_SIGNER_PUBKEY, SOLANA_PARTICIPANT_2],
          deposit: 1000000n,
        }),
        openChannel: jest.fn(),
        deposit: jest.fn(),
        claimFromChannel: jest.fn(),
        closeChannel: jest.fn(),
        settleChannel: jest.fn(),
        signBalanceProof: jest.fn(),
        subscribeToEvents: jest.fn(),
        chainType: 'solana' as const,
        chainId: 'solana:devnet',
      } as unknown as jest.Mocked<PaymentChannelProvider>;
    }

    // Registry that returns Solana provider
    function createSolanaRegistry(
      solanaProvider: jest.Mocked<PaymentChannelProvider>,
      evmProvider?: jest.Mocked<PaymentChannelProvider>
    ): jest.Mocked<
      Pick<ChainProviderRegistry, 'getProvider' | 'getProviderForPeer' | 'getAllProviders'>
    > {
      return {
        getProvider: jest.fn().mockImplementation((_chainType: string, chainId: string) => {
          if (chainId.startsWith('solana:')) return solanaProvider;
          if (chainId.startsWith('evm:') && evmProvider) return evmProvider;
          return undefined;
        }),
        getProviderForPeer: jest.fn().mockImplementation((peerId: string) => {
          // Return Solana provider for Solana peers
          if (peerId === 'peer-solana') return solanaProvider;
          if (evmProvider) return evmProvider;
          return undefined;
        }),
        getAllProviders: jest
          .fn()
          .mockReturnValue(evmProvider ? [solanaProvider, evmProvider] : [solanaProvider]),
      };
    }

    // Mock ChannelManager for Solana
    function createMockSolanaChannelManager(): jest.Mocked<
      Pick<ChannelManager, 'getChannelById' | 'registerExternalChannel'>
    > {
      return {
        getChannelById: jest.fn().mockReturnValue(null), // Unknown channel by default
        registerExternalChannel: jest.fn().mockImplementation((params) => ({
          channelId: params.channelId,
          peerId: params.peerId,
          tokenId: params.tokenAddress,
          tokenAddress: params.tokenAddress,
          chain: params.chain || `solana:devnet`,
          createdAt: new Date(),
          lastActivityAt: new Date(),
          status: 'open',
        })),
      } as unknown as jest.Mocked<
        Pick<ChannelManager, 'getChannelById' | 'registerExternalChannel'>
      >;
    }

    beforeEach(() => {
      validSolanaClaim = {
        version: '1.0',
        blockchain: 'solana',
        messageId: 'solana-AbCdEfGh-5-1706889600000',
        timestamp: '2026-02-02T12:00:00.000Z',
        senderId: 'peer-solana',
        programId: SOLANA_PROGRAM_ID,
        channelAccount: SOLANA_CHANNEL_ACCOUNT,
        nonce: 5,
        transferredAmount: '1000000',
        signature: SOLANA_SIGNATURE,
        signerPublicKey: SOLANA_SIGNER_PUBKEY,
        cluster: 'devnet',
      };

      solanaProtocolData = {
        protocolName: 'payment-channel-claim',
        contentType: 1,
        data: Buffer.from(JSON.stringify(validSolanaClaim), 'utf8'),
      };

      solanaBtpMessage = {
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
    });

    it('[P0] should verify valid Solana claim via provider.verifyBalanceProof (T-33.6-08)', async () => {
      const solanaProvider = createMockSolanaProvider();
      const solanaRegistry = createSolanaRegistry(solanaProvider);
      const solanaChannelManager = createMockSolanaChannelManager();
      const peerAddressMap = new Map<string, string>();

      const receiver = new ClaimReceiver(
        mockDb,
        solanaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        solanaChannelManager as unknown as ChannelManager,
        peerAddressMap
      );

      mockStatement.get.mockReturnValue(undefined); // No previous claim

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-solana', solanaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify provider.verifyBalanceProof was called with correct Solana params
      expect(solanaProvider.verifyBalanceProof).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: SOLANA_CHANNEL_ACCOUNT,
          nonce: 5,
          transferredAmount: '1000000',
          signature: SOLANA_SIGNATURE,
          signerAddress: SOLANA_SIGNER_PUBKEY,
        })
      );

      // Verify claim persisted as verified
      expect(mockStatement.run).toHaveBeenCalledWith(
        validSolanaClaim.messageId,
        'peer-solana',
        'solana',
        SOLANA_CHANNEL_ACCOUNT,
        JSON.stringify(validSolanaClaim),
        1, // verified=true
        expect.any(Number),
        null,
        null
      );
    });

    it('[P0] should reject Solana claim with invalid signature (T-33.6-09)', async () => {
      const solanaProvider = createMockSolanaProvider();
      solanaProvider.verifyBalanceProof.mockResolvedValue(false);
      const solanaRegistry = createSolanaRegistry(solanaProvider);
      const solanaChannelManager = createMockSolanaChannelManager();

      const receiver = new ClaimReceiver(
        mockDb,
        solanaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        solanaChannelManager as unknown as ChannelManager
      );

      mockStatement.get.mockReturnValue(undefined);

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-solana', solanaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify claim persisted as NOT verified
      expect(mockStatement.run).toHaveBeenCalledWith(
        validSolanaClaim.messageId,
        'peer-solana',
        'solana',
        SOLANA_CHANNEL_ACCOUNT,
        JSON.stringify(validSolanaClaim),
        0, // verified=false
        expect.any(Number),
        null,
        null
      );
    });

    it('[P0] should reject Solana claim with replayed nonce (T-33.6-10)', async () => {
      const solanaProvider = createMockSolanaProvider();
      const solanaRegistry = createSolanaRegistry(solanaProvider);
      const solanaChannelManager = createMockSolanaChannelManager();

      const receiver = new ClaimReceiver(
        mockDb,
        solanaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        solanaChannelManager as unknown as ChannelManager
      );

      // Mock previous claim with same nonce
      const previousClaim: SolanaClaimMessage = {
        ...validSolanaClaim,
        nonce: 5, // Same nonce as incoming claim
      };
      mockStatement.get.mockReturnValue({
        claim_data: JSON.stringify(previousClaim),
      });

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-solana', solanaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify claim persisted as NOT verified due to nonce replay
      expect(mockStatement.run).toHaveBeenCalledWith(
        validSolanaClaim.messageId,
        'peer-solana',
        'solana',
        SOLANA_CHANNEL_ACCOUNT,
        JSON.stringify(validSolanaClaim),
        0, // verified=false
        expect.any(Number),
        null,
        null
      );
    });

    it('[P0] should reject Solana claim from non-participant signer with case-sensitive comparison (T-33.6-11)', async () => {
      const solanaProvider = createMockSolanaProvider();
      // Channel participants do NOT include the signer
      solanaProvider.getChannelState.mockResolvedValue({
        channelId: SOLANA_CHANNEL_ACCOUNT,
        status: 'opened' as const,
        participants: ['DiFfErEnTsIgNeR1111111111111111111111111111', SOLANA_PARTICIPANT_2],
        deposit: 1000000n,
      } as ProviderChannelState);
      const solanaRegistry = createSolanaRegistry(solanaProvider);
      const solanaChannelManager = createMockSolanaChannelManager();

      const receiver = new ClaimReceiver(
        mockDb,
        solanaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        solanaChannelManager as unknown as ChannelManager
      );

      mockStatement.get.mockReturnValue(undefined);

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-solana', solanaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Signer not a participant -- claim should be rejected
      expect(mockStatement.run).toHaveBeenCalledWith(
        validSolanaClaim.messageId,
        'peer-solana',
        'solana',
        SOLANA_CHANNEL_ACCOUNT,
        JSON.stringify(validSolanaClaim),
        0, // verified=false
        expect.any(Number),
        null,
        null
      );
    });

    it('[P1] should accept Solana claim for closed channel during challenge period (T-33.6-12)', async () => {
      const solanaProvider = createMockSolanaProvider();
      solanaProvider.getChannelState.mockResolvedValue({
        channelId: SOLANA_CHANNEL_ACCOUNT,
        status: 'closed' as const, // Challenge period -- claims still accepted
        participants: [SOLANA_SIGNER_PUBKEY, SOLANA_PARTICIPANT_2],
        deposit: 1000000n,
      } as ProviderChannelState);
      const solanaRegistry = createSolanaRegistry(solanaProvider);
      const solanaChannelManager = createMockSolanaChannelManager();

      const receiver = new ClaimReceiver(
        mockDb,
        solanaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        solanaChannelManager as unknown as ChannelManager
      );

      mockStatement.get.mockReturnValue(undefined);

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-solana', solanaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Claim should be accepted (closed = challenge period)
      expect(mockStatement.run).toHaveBeenCalledWith(
        validSolanaClaim.messageId,
        'peer-solana',
        'solana',
        SOLANA_CHANNEL_ACCOUNT,
        JSON.stringify(validSolanaClaim),
        1, // verified=true
        expect.any(Number),
        null,
        null
      );
    });

    it('[P1] should reject Solana claim for settled channel (T-33.6-13)', async () => {
      const solanaProvider = createMockSolanaProvider();
      solanaProvider.getChannelState.mockResolvedValue({
        channelId: SOLANA_CHANNEL_ACCOUNT,
        status: 'settled' as const,
        participants: [SOLANA_SIGNER_PUBKEY, SOLANA_PARTICIPANT_2],
        deposit: 0n,
      } as ProviderChannelState);
      const solanaRegistry = createSolanaRegistry(solanaProvider);
      const solanaChannelManager = createMockSolanaChannelManager();

      const receiver = new ClaimReceiver(
        mockDb,
        solanaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        solanaChannelManager as unknown as ChannelManager
      );

      mockStatement.get.mockReturnValue(undefined);

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-solana', solanaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Settled channel -- claim should be rejected
      expect(mockStatement.run).toHaveBeenCalledWith(
        validSolanaClaim.messageId,
        'peer-solana',
        'solana',
        SOLANA_CHANNEL_ACCOUNT,
        JSON.stringify(validSolanaClaim),
        0, // verified=false
        expect.any(Number),
        null,
        null
      );
    });

    it('[P0] should reject Solana claim with tampered programId / PDA mismatch (T-33.6-21)', async () => {
      const solanaProvider = createMockSolanaProvider();
      // getChannelState fails because the PDA derivation from the tampered programId
      // does not match the provided channelAccount
      solanaProvider.getChannelState.mockRejectedValue(
        new Error('Account does not exist or has no data')
      );
      const solanaRegistry = createSolanaRegistry(solanaProvider);
      const solanaChannelManager = createMockSolanaChannelManager();

      const tamperedClaim: SolanaClaimMessage = {
        ...validSolanaClaim,
        programId: 'TaMpErEd1111111111111111111111111111111111', // Wrong program
      };

      const tamperedProtocolData: BTPProtocolData = {
        protocolName: 'payment-channel-claim',
        contentType: 1,
        data: Buffer.from(JSON.stringify(tamperedClaim), 'utf8'),
      };

      const tamperedBtpMessage: BTPMessage = {
        type: 6,
        requestId: 1,
        data: {
          protocolData: [tamperedProtocolData],
          transfer: {
            amount: '0',
            expiresAt: new Date(Date.now() + 30000).toISOString(),
          },
        } as BTPData,
      };

      const receiver = new ClaimReceiver(
        mockDb,
        solanaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        solanaChannelManager as unknown as ChannelManager
      );

      mockStatement.get.mockReturnValue(undefined);

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-solana', tamperedBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Claim with tampered programId should fail verification
      expect(mockStatement.run).toHaveBeenCalledWith(
        tamperedClaim.messageId,
        'peer-solana',
        'solana',
        SOLANA_CHANNEL_ACCOUNT,
        JSON.stringify(tamperedClaim),
        0, // verified=false
        expect.any(Number),
        null,
        null
      );
    });

    it('[P1] should register unknown Solana channel after successful on-chain verification (T-33.6-14)', async () => {
      const solanaProvider = createMockSolanaProvider();
      const solanaRegistry = createSolanaRegistry(solanaProvider);
      const solanaChannelManager = createMockSolanaChannelManager();

      const receiver = new ClaimReceiver(
        mockDb,
        solanaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        solanaChannelManager as unknown as ChannelManager
      );

      mockStatement.get.mockReturnValue(undefined);

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-solana', solanaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Channel should be registered via channelManager with correct params
      expect(solanaChannelManager.registerExternalChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: SOLANA_CHANNEL_ACCOUNT,
          peerId: 'peer-solana',
          tokenAddress: SOLANA_PROGRAM_ID,
          chain: 'solana:devnet',
          status: 'open',
        })
      );
    });

    it('[P1] should skip on-chain RPC for known Solana channel and verify signature directly', async () => {
      const solanaProvider = createMockSolanaProvider();
      const solanaRegistry = createSolanaRegistry(solanaProvider);
      const solanaChannelManager = createMockSolanaChannelManager();

      // Mark channel as already known
      solanaChannelManager.getChannelById.mockReturnValue({
        channelId: SOLANA_CHANNEL_ACCOUNT,
        peerId: 'peer-solana',
        tokenId: SOLANA_PROGRAM_ID,
        tokenAddress: SOLANA_PROGRAM_ID,
        chain: 'solana:devnet',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      });

      const receiver = new ClaimReceiver(
        mockDb,
        solanaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        solanaChannelManager as unknown as ChannelManager
      );

      mockStatement.get.mockReturnValue(undefined);

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-solana', solanaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // getChannelState should NOT be called (known channel skips on-chain check)
      expect(solanaProvider.getChannelState).not.toHaveBeenCalled();

      // verifyBalanceProof should still be called for signature verification
      expect(solanaProvider.verifyBalanceProof).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: SOLANA_CHANNEL_ACCOUNT,
          nonce: 5,
          transferredAmount: '1000000',
          signature: SOLANA_SIGNATURE,
          signerAddress: SOLANA_SIGNER_PUBKEY,
          lockedAmount: '0',
        })
      );

      // Channel should NOT be re-registered
      expect(solanaChannelManager.registerExternalChannel).not.toHaveBeenCalled();

      // Claim should be stored as verified
      expect(mockStatement.run).toHaveBeenCalledWith(
        validSolanaClaim.messageId,
        'peer-solana',
        'solana',
        SOLANA_CHANNEL_ACCOUNT,
        JSON.stringify(validSolanaClaim),
        1, // verified=true
        expect.any(Number),
        null,
        null
      );
    });

    it('[P1] should reject known Solana channel claim with invalid signature', async () => {
      const solanaProvider = createMockSolanaProvider();
      solanaProvider.verifyBalanceProof.mockResolvedValue(false); // Signature fails
      const solanaRegistry = createSolanaRegistry(solanaProvider);
      const solanaChannelManager = createMockSolanaChannelManager();

      // Mark channel as already known
      solanaChannelManager.getChannelById.mockReturnValue({
        channelId: SOLANA_CHANNEL_ACCOUNT,
        peerId: 'peer-solana',
        tokenId: SOLANA_PROGRAM_ID,
        tokenAddress: SOLANA_PROGRAM_ID,
        chain: 'solana:devnet',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      });

      const receiver = new ClaimReceiver(
        mockDb,
        solanaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        solanaChannelManager as unknown as ChannelManager
      );

      mockStatement.get.mockReturnValue(undefined);

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-solana', solanaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Known channel path: no on-chain check
      expect(solanaProvider.getChannelState).not.toHaveBeenCalled();

      // Claim should be stored as NOT verified
      expect(mockStatement.run).toHaveBeenCalledWith(
        validSolanaClaim.messageId,
        'peer-solana',
        'solana',
        SOLANA_CHANNEL_ACCOUNT,
        JSON.stringify(validSolanaClaim),
        0, // verified=false
        expect.any(Number),
        null,
        null
      );
    });

    it('[P0] should emit CLAIM_RECEIVED event with Solana channelId and cumulativeAmount (T-33.6-15)', async () => {
      const solanaProvider = createMockSolanaProvider();
      const solanaRegistry = createSolanaRegistry(solanaProvider);
      const solanaChannelManager = createMockSolanaChannelManager();

      const receiver = new ClaimReceiver(
        mockDb,
        solanaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        solanaChannelManager as unknown as ChannelManager
      );

      const claimReceivedListener = jest.fn();
      receiver.on('CLAIM_RECEIVED', claimReceivedListener);

      mockStatement.get.mockReturnValue(undefined);

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-solana', solanaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(claimReceivedListener).toHaveBeenCalledTimes(1);
      const emittedEvent: ClaimReceivedEvent = claimReceivedListener.mock.calls[0][0];
      expect(emittedEvent.peerId).toBe('peer-solana');
      expect(emittedEvent.channelId).toBe(SOLANA_CHANNEL_ACCOUNT);
      expect(emittedEvent.cumulativeAmount).toBe(BigInt(validSolanaClaim.transferredAmount));
    });

    it('[P0] should NOT break EVM claim verification path (T-33.6-16 regression)', async () => {
      // Verify EVM claims still work when Solana verification is wired in
      const evmClaim: EVMClaimMessage = {
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

      const evmProtocolData: BTPProtocolData = {
        protocolName: 'payment-channel-claim',
        contentType: 1,
        data: Buffer.from(JSON.stringify(evmClaim), 'utf8'),
      };

      const evmBtpMessage: BTPMessage = {
        type: 6,
        requestId: 1,
        data: {
          protocolData: [evmProtocolData],
          transfer: {
            amount: '0',
            expiresAt: new Date(Date.now() + 30000).toISOString(),
          },
        } as BTPData,
      };

      mockProvider.verifyBalanceProof.mockResolvedValue(true);
      mockStatement.get.mockReturnValue(undefined);

      claimReceiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-bob', evmBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // EVM verification should still work through provider
      expect(mockProvider.verifyBalanceProof).toHaveBeenCalled();
      expect(mockStatement.run).toHaveBeenCalledWith(
        evmClaim.messageId,
        'peer-bob',
        'evm',
        evmClaim.channelId,
        JSON.stringify(evmClaim),
        1, // verified=true
        expect.any(Number),
        null,
        null
      );
    });

    it('[P0] should register peer Solana address in peerIdToAddressMap after successful verification (AC6/Task 2.5)', async () => {
      const solanaProvider = createMockSolanaProvider();
      const solanaRegistry = createSolanaRegistry(solanaProvider);
      const solanaChannelManager = createMockSolanaChannelManager();
      const peerAddressMap = new Map<string, string>();

      const receiver = new ClaimReceiver(
        mockDb,
        solanaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        solanaChannelManager as unknown as ChannelManager,
        peerAddressMap
      );

      mockStatement.get.mockReturnValue(undefined);

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-solana', solanaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Peer's Solana address should be registered from signerPublicKey
      expect(peerAddressMap.get('peer-solana')).toBe(SOLANA_SIGNER_PUBKEY);
    });

    it('[P0] should NOT overwrite existing peer address in peerIdToAddressMap for Solana (AC6/Task 2.5)', async () => {
      const solanaProvider = createMockSolanaProvider();
      const solanaRegistry = createSolanaRegistry(solanaProvider);
      const solanaChannelManager = createMockSolanaChannelManager();
      const peerAddressMap = new Map<string, string>();
      // Pre-register a static config entry
      peerAddressMap.set('peer-solana', 'ExistingStaticAddress111111111111111111111');

      const receiver = new ClaimReceiver(
        mockDb,
        solanaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        solanaChannelManager as unknown as ChannelManager,
        peerAddressMap
      );

      mockStatement.get.mockReturnValue(undefined);

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-solana', solanaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should NOT overwrite the pre-existing static config entry
      expect(peerAddressMap.get('peer-solana')).toBe('ExistingStaticAddress111111111111111111111');
    });

    it('[P0] should deserialize Solana claim from BTP protocolData JSON (T-33.6-19/AC3)', async () => {
      const solanaProvider = createMockSolanaProvider();
      const solanaRegistry = createSolanaRegistry(solanaProvider);

      const receiver = new ClaimReceiver(
        mockDb,
        solanaRegistry as unknown as ChainProviderRegistry,
        mockLogger
      );

      mockStatement.get.mockReturnValue(undefined);

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-solana', solanaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The claim should have been parsed and routed to Solana verification
      // (not rejected as unsupported blockchain)
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ blockchain: 'solana' }),
        expect.stringContaining('No provider registered')
      );
    });
  });

  /**
   * Acceptance Tests for Story 34.7: Mina Claim Verification in ClaimReceiver
   *
   * Tests zk-SNARK proof verification via provider, on-chain channel state checks,
   * nonce monotonicity, dynamic channel registration, and CLAIM_RECEIVED event
   * emission for Mina claims.
   */
  describe('Mina claim verification (Story 34.7)', () => {
    const MINA_ZKAPP_ADDRESS = 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy';
    const MINA_TOKEN_ID = 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf';
    const MINA_PARTICIPANT_2 = 'B62qjSytpSK7aEauBprjXDSZwc9ai4YMv9tpmXLQK14Vm9rcFtErmFy';

    let validMinaClaim: MinaClaimMessage;
    let minaProtocolData: BTPProtocolData;
    let minaBtpMessage: BTPMessage;

    // Create a mock Mina provider
    function createMockMinaProvider(): jest.Mocked<PaymentChannelProvider> {
      return {
        verifyBalanceProof: jest.fn().mockResolvedValue(true),
        getChannelState: jest.fn().mockResolvedValue({
          channelId: MINA_ZKAPP_ADDRESS,
          status: 'opened' as const,
          participants: [MINA_ZKAPP_ADDRESS, MINA_PARTICIPANT_2],
          deposit: 1000000n,
        }),
        openChannel: jest.fn(),
        deposit: jest.fn(),
        claimFromChannel: jest.fn(),
        closeChannel: jest.fn(),
        settleChannel: jest.fn(),
        signBalanceProof: jest.fn(),
        subscribeToEvents: jest.fn(),
        chainType: 'mina' as const,
        chainId: 'mina:devnet',
      } as unknown as jest.Mocked<PaymentChannelProvider>;
    }

    // Registry that returns Mina provider
    function createMinaRegistry(
      minaProvider: jest.Mocked<PaymentChannelProvider>
    ): jest.Mocked<
      Pick<ChainProviderRegistry, 'getProvider' | 'getProviderForPeer' | 'getAllProviders'>
    > {
      return {
        getProvider: jest.fn().mockImplementation((_chainType: string, chainId: string) => {
          if (chainId.startsWith('mina:')) return minaProvider;
          return undefined;
        }),
        getProviderForPeer: jest.fn().mockReturnValue(minaProvider),
        getAllProviders: jest.fn().mockReturnValue([minaProvider]),
      };
    }

    // Mock ChannelManager for Mina
    function createMockMinaChannelManager(): jest.Mocked<
      Pick<ChannelManager, 'getChannelById' | 'registerExternalChannel'>
    > {
      return {
        getChannelById: jest.fn().mockReturnValue(null), // Unknown channel by default
        registerExternalChannel: jest.fn().mockImplementation((params) => ({
          channelId: params.channelId,
          peerId: params.peerId,
          tokenId: params.tokenAddress,
          tokenAddress: params.tokenAddress,
          chain: params.chain || 'mina:devnet',
          createdAt: new Date(),
          lastActivityAt: new Date(),
          status: 'open',
        })),
      } as unknown as jest.Mocked<
        Pick<ChannelManager, 'getChannelById' | 'registerExternalChannel'>
      >;
    }

    beforeEach(() => {
      validMinaClaim = {
        version: '1.0',
        blockchain: 'mina',
        messageId: 'mina-B62qre3e-5-1706889600000',
        timestamp: '2026-03-28T12:00:00.000Z',
        senderId: 'peer-mina',
        zkAppAddress: MINA_ZKAPP_ADDRESS,
        tokenId: MINA_TOKEN_ID,
        balanceCommitment: '12345678901234567890',
        nonce: 5,
        proof: 'eyJwcm9vZiI6InRlc3QifQ==',
        salt: 'abcdef1234567890',
        // Participant A's plaintext cumulative balance — drives on-chain
        // claimFromChannel (mirrors EVM/Solana transferredAmount). #116/#117.
        transferredAmount: '1000000000000',
        network: 'devnet',
      };

      minaProtocolData = {
        protocolName: 'payment-channel-claim',
        contentType: 1,
        data: Buffer.from(JSON.stringify(validMinaClaim), 'utf8'),
      };

      minaBtpMessage = {
        type: 6,
        requestId: 1,
        data: {
          protocolData: [minaProtocolData],
          transfer: {
            amount: '0',
            expiresAt: new Date(Date.now() + 30000).toISOString(),
          },
        } as BTPData,
      };
    });

    it('[P0] should verify valid Mina claim via provider.verifyBalanceProof (T-34.7-11)', async () => {
      const minaProvider = createMockMinaProvider();
      const minaRegistry = createMinaRegistry(minaProvider);
      const minaChannelManager = createMockMinaChannelManager();

      const receiver = new ClaimReceiver(
        mockDb,
        minaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        minaChannelManager as unknown as ChannelManager
      );

      mockStatement.get.mockReturnValue(undefined); // No previous claim

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-mina', minaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify provider.verifyBalanceProof was called with correct Mina params
      expect(minaProvider.verifyBalanceProof).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: MINA_ZKAPP_ADDRESS,
          nonce: 5,
          transferredAmount: validMinaClaim.balanceCommitment,
          signature: validMinaClaim.proof,
          signerAddress: MINA_ZKAPP_ADDRESS,
        })
      );

      // Verify claim persisted as verified
      expect(mockStatement.run).toHaveBeenCalledWith(
        validMinaClaim.messageId,
        'peer-mina',
        'mina',
        MINA_ZKAPP_ADDRESS,
        JSON.stringify(validMinaClaim),
        1, // verified=true
        expect.any(Number),
        null,
        null
      );
    });

    it('[P0] should reject Mina claim with invalid zk-SNARK proof (T-34.7-20)', async () => {
      const minaProvider = createMockMinaProvider();
      minaProvider.verifyBalanceProof.mockResolvedValue(false);
      const minaRegistry = createMinaRegistry(minaProvider);
      const minaChannelManager = createMockMinaChannelManager();

      const receiver = new ClaimReceiver(
        mockDb,
        minaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        minaChannelManager as unknown as ChannelManager
      );

      mockStatement.get.mockReturnValue(undefined);

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-mina', minaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify claim persisted as NOT verified
      expect(mockStatement.run).toHaveBeenCalledWith(
        validMinaClaim.messageId,
        'peer-mina',
        'mina',
        MINA_ZKAPP_ADDRESS,
        JSON.stringify(validMinaClaim),
        0, // verified=false
        expect.any(Number),
        null,
        null
      );
    });

    it('[P0] should reject Mina claim with replayed nonce (T-34.7-21)', async () => {
      const minaProvider = createMockMinaProvider();
      const minaRegistry = createMinaRegistry(minaProvider);
      const minaChannelManager = createMockMinaChannelManager();

      const receiver = new ClaimReceiver(
        mockDb,
        minaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        minaChannelManager as unknown as ChannelManager
      );

      // Mock previous claim with same nonce
      const previousClaim: MinaClaimMessage = {
        ...validMinaClaim,
        nonce: 5, // Same nonce as incoming claim
      };
      mockStatement.get.mockReturnValue({
        claim_data: JSON.stringify(previousClaim),
      });

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-mina', minaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify claim persisted as NOT verified due to nonce replay
      expect(mockStatement.run).toHaveBeenCalledWith(
        validMinaClaim.messageId,
        'peer-mina',
        'mina',
        MINA_ZKAPP_ADDRESS,
        JSON.stringify(validMinaClaim),
        0, // verified=false
        expect.any(Number),
        null,
        null
      );
    });

    it('[P1] should emit CLAIM_RECEIVED event with Mina zkAppAddress and real transferredAmount (T-34.7-22, #116/#117)', async () => {
      const minaProvider = createMockMinaProvider();
      const minaRegistry = createMinaRegistry(minaProvider);
      const minaChannelManager = createMockMinaChannelManager();

      const receiver = new ClaimReceiver(
        mockDb,
        minaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        minaChannelManager as unknown as ChannelManager
      );

      const claimReceivedListener = jest.fn();
      receiver.on('CLAIM_RECEIVED', claimReceivedListener);

      mockStatement.get.mockReturnValue(undefined);

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-mina', minaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(claimReceivedListener).toHaveBeenCalledTimes(1);
      const emittedEvent: ClaimReceivedEvent = claimReceivedListener.mock.calls[0][0];
      expect(emittedEvent.peerId).toBe('peer-mina');
      expect(emittedEvent.channelId).toBe(MINA_ZKAPP_ADDRESS);
      // Regression for #116/#117: Mina must carry the real cumulative amount
      // (not the old hardcoded 0), otherwise settlement-monitor's
      // `cumulativeAmount > threshold` check is always false and on-chain
      // claimFromChannel never auto-triggers — symmetric with EVM/Solana.
      expect(emittedEvent.cumulativeAmount).toBe(BigInt(validMinaClaim.transferredAmount!));
      expect(emittedEvent.cumulativeAmount).not.toBe(BigInt(0));
      // The amount must actually be able to cross a settlement threshold.
      const exampleThreshold = BigInt('1000000');
      expect(emittedEvent.cumulativeAmount > exampleThreshold).toBe(true);
    });

    it('[P2] should emit CLAIM_RECEIVED with cumulativeAmount 0 when Mina claim omits transferredAmount', async () => {
      const minaProvider = createMockMinaProvider();
      const minaRegistry = createMinaRegistry(minaProvider);
      const minaChannelManager = createMockMinaChannelManager();

      const receiver = new ClaimReceiver(
        mockDb,
        minaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        minaChannelManager as unknown as ChannelManager
      );

      // transferredAmount is optional on MinaClaimMessage; when absent the
      // event must still emit (no BigInt(undefined) throw) with a 0 amount.
      const claimWithoutAmount: MinaClaimMessage = { ...validMinaClaim };
      delete claimWithoutAmount.transferredAmount;
      const protocolDataNoAmount: BTPProtocolData = {
        protocolName: 'payment-channel-claim',
        contentType: 1,
        data: Buffer.from(JSON.stringify(claimWithoutAmount), 'utf8'),
      };
      const btpMessageNoAmount: BTPMessage = {
        type: 6,
        requestId: 1,
        data: {
          protocolData: [protocolDataNoAmount],
          transfer: {
            amount: '0',
            expiresAt: new Date(Date.now() + 30000).toISOString(),
          },
        } as BTPData,
      };

      const claimReceivedListener = jest.fn();
      receiver.on('CLAIM_RECEIVED', claimReceivedListener);

      mockStatement.get.mockReturnValue(undefined);

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-mina', btpMessageNoAmount);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(claimReceivedListener).toHaveBeenCalledTimes(1);
      const emittedEvent: ClaimReceivedEvent = claimReceivedListener.mock.calls[0][0];
      expect(emittedEvent.cumulativeAmount).toBe(BigInt(0));
    });

    it('[P1] should register unknown Mina channel after successful verification (T-34.7-22)', async () => {
      const minaProvider = createMockMinaProvider();
      const minaRegistry = createMinaRegistry(minaProvider);
      const minaChannelManager = createMockMinaChannelManager();

      const receiver = new ClaimReceiver(
        mockDb,
        minaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        minaChannelManager as unknown as ChannelManager
      );

      mockStatement.get.mockReturnValue(undefined);

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-mina', minaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(minaChannelManager.registerExternalChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: MINA_ZKAPP_ADDRESS,
          peerId: 'peer-mina',
          tokenAddress: MINA_TOKEN_ID,
          chain: 'mina:devnet',
          status: 'open',
        })
      );
    });

    it('[P1] should accept Mina claim for closed channel during challenge period', async () => {
      const minaProvider = createMockMinaProvider();
      minaProvider.getChannelState.mockResolvedValue({
        channelId: MINA_ZKAPP_ADDRESS,
        status: 'closed' as const,
        participants: [MINA_ZKAPP_ADDRESS, MINA_PARTICIPANT_2],
        deposit: 1000000n,
      } as ProviderChannelState);
      const minaRegistry = createMinaRegistry(minaProvider);
      const minaChannelManager = createMockMinaChannelManager();

      const receiver = new ClaimReceiver(
        mockDb,
        minaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        minaChannelManager as unknown as ChannelManager
      );

      mockStatement.get.mockReturnValue(undefined);

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-mina', minaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Claim should be accepted (closed = challenge period)
      expect(mockStatement.run).toHaveBeenCalledWith(
        validMinaClaim.messageId,
        'peer-mina',
        'mina',
        MINA_ZKAPP_ADDRESS,
        JSON.stringify(validMinaClaim),
        1, // verified=true
        expect.any(Number),
        null,
        null
      );
    });

    it('[P1] should reject Mina claim for settled channel', async () => {
      const minaProvider = createMockMinaProvider();
      minaProvider.getChannelState.mockResolvedValue({
        channelId: MINA_ZKAPP_ADDRESS,
        status: 'settled' as const,
        participants: [MINA_ZKAPP_ADDRESS, MINA_PARTICIPANT_2],
        deposit: 0n,
      } as ProviderChannelState);
      const minaRegistry = createMinaRegistry(minaProvider);
      const minaChannelManager = createMockMinaChannelManager();

      const receiver = new ClaimReceiver(
        mockDb,
        minaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        minaChannelManager as unknown as ChannelManager
      );

      mockStatement.get.mockReturnValue(undefined);

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-mina', minaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Settled channel -- claim should be rejected
      expect(mockStatement.run).toHaveBeenCalledWith(
        validMinaClaim.messageId,
        'peer-mina',
        'mina',
        MINA_ZKAPP_ADDRESS,
        JSON.stringify(validMinaClaim),
        0, // verified=false
        expect.any(Number),
        null,
        null
      );
    });

    it('[P0] should skip on-chain RPC for known Mina channel and verify proof directly', async () => {
      const minaProvider = createMockMinaProvider();
      const minaRegistry = createMinaRegistry(minaProvider);
      const minaChannelManager = createMockMinaChannelManager();

      // Mark channel as already known
      minaChannelManager.getChannelById.mockReturnValue({
        channelId: MINA_ZKAPP_ADDRESS,
        peerId: 'peer-mina',
        tokenId: MINA_TOKEN_ID,
        tokenAddress: MINA_TOKEN_ID,
        chain: 'mina:devnet',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      });

      const receiver = new ClaimReceiver(
        mockDb,
        minaRegistry as unknown as ChainProviderRegistry,
        mockLogger,
        minaChannelManager as unknown as ChannelManager
      );

      mockStatement.get.mockReturnValue(undefined);

      receiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-mina', minaBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // getChannelState should NOT be called (known channel skips on-chain check)
      expect(minaProvider.getChannelState).not.toHaveBeenCalled();

      // verifyBalanceProof should still be called
      expect(minaProvider.verifyBalanceProof).toHaveBeenCalled();

      // Channel should NOT be re-registered
      expect(minaChannelManager.registerExternalChannel).not.toHaveBeenCalled();

      // Claim should be stored as verified
      expect(mockStatement.run).toHaveBeenCalledWith(
        validMinaClaim.messageId,
        'peer-mina',
        'mina',
        MINA_ZKAPP_ADDRESS,
        JSON.stringify(validMinaClaim),
        1, // verified=true
        expect.any(Number),
        null,
        null
      );
    });

    it('[P0] should NOT break EVM claim verification path (T-34.7-12 regression)', async () => {
      const evmClaim: EVMClaimMessage = {
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

      const evmProtocolData: BTPProtocolData = {
        protocolName: 'payment-channel-claim',
        contentType: 1,
        data: Buffer.from(JSON.stringify(evmClaim), 'utf8'),
      };

      const evmBtpMessage: BTPMessage = {
        type: 6,
        requestId: 1,
        data: {
          protocolData: [evmProtocolData],
          transfer: {
            amount: '0',
            expiresAt: new Date(Date.now() + 30000).toISOString(),
          },
        } as BTPData,
      };

      mockProvider.verifyBalanceProof.mockResolvedValue(true);
      mockStatement.get.mockReturnValue(undefined);

      claimReceiver.registerWithBTPServer(mockBTPServer);
      await btpMessageHandler!('peer-bob', evmBtpMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // EVM verification should still work through provider
      expect(mockProvider.verifyBalanceProof).toHaveBeenCalled();
      expect(mockStatement.run).toHaveBeenCalledWith(
        evmClaim.messageId,
        'peer-bob',
        'evm',
        evmClaim.channelId,
        JSON.stringify(evmClaim),
        1, // verified=true
        expect.any(Number),
        null,
        null
      );
    });
  });
});
