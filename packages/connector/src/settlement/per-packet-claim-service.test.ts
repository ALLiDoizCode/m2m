/**
 * Per-Packet Claim Service Unit Tests
 *
 * Tests claim generation, nonce tracking, cumulative amounts,
 * startup recovery, and graceful degradation.
 *
 * Refactored for Story 32.4: uses ChainProviderRegistry + EVMPaymentChannelProvider
 * instead of direct PaymentChannelSDK dependency.
 */

import { PerPacketClaimService } from './per-packet-claim-service';
import {
  BTP_CLAIM_PROTOCOL,
  type EVMClaimMessage,
  type SolanaClaimMessage,
  type MinaClaimMessage,
  isEVMClaim,
  isSolanaClaim,
  isMinaClaim,
} from '../btp/btp-claim-types';
import type { ChainProviderRegistry } from './provider/chain-provider-registry';
import type { ChannelManager } from './channel-manager';
import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';
import type { PaymentChannelSDK } from './payment-channel-sdk';
import { EVMPaymentChannelProvider } from './provider/evm-payment-channel-provider';
import { SolanaPaymentChannelProvider } from './provider/solana-payment-channel-provider';
import { MinaPaymentChannelProvider } from './provider/mina-payment-channel-provider';

// Mock logger
const createMockLogger = (): Logger =>
  ({
    child: jest.fn().mockReturnThis(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
  }) as unknown as Logger;

// Mock PaymentChannelSDK (used to construct a real EVMPaymentChannelProvider)
const createMockSDK = (): jest.Mocked<
  Pick<
    PaymentChannelSDK,
    | 'signBalanceProof'
    | 'getChainId'
    | 'getTokenNetworkAddress'
    | 'getSignerAddress'
    | 'openChannel'
    | 'deposit'
    | 'claimFromChannel'
    | 'closeChannel'
    | 'settleChannel'
    | 'verifyBalanceProof'
    | 'getChannelState'
    | 'onChannelOpened'
    | 'onChannelClosed'
    | 'onChannelSettled'
    | 'onChannelCooperativeSettled'
    | 'removeAllListeners'
  >
> => ({
  signBalanceProof: jest.fn().mockResolvedValue('0xmocksignature'),
  getChainId: jest.fn().mockResolvedValue(31337),
  getTokenNetworkAddress: jest.fn().mockResolvedValue('0xTokenNetworkAddress1234567890abcdef'),
  getSignerAddress: jest.fn().mockResolvedValue('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1'),
  openChannel: jest.fn(),
  deposit: jest.fn(),
  claimFromChannel: jest.fn(),
  closeChannel: jest.fn(),
  settleChannel: jest.fn(),
  verifyBalanceProof: jest.fn(),
  getChannelState: jest.fn(),
  onChannelOpened: jest.fn(),
  onChannelClosed: jest.fn(),
  onChannelSettled: jest.fn(),
  onChannelCooperativeSettled: jest.fn(),
  removeAllListeners: jest.fn(),
});

// Create a real EVMPaymentChannelProvider with a mocked SDK
const createMockEVMProvider = (
  sdk: ReturnType<typeof createMockSDK>
): EVMPaymentChannelProvider => {
  const providerLogger = createMockLogger() as unknown as import('../utils/logger').Logger;
  return new EVMPaymentChannelProvider(
    sdk as unknown as PaymentChannelSDK,
    'evm:anvil:31337',
    '0xTokenAddress',
    providerLogger
  );
};

// Mock ChainProviderRegistry
const createMockRegistry = (
  provider: EVMPaymentChannelProvider
): jest.Mocked<Pick<ChainProviderRegistry, 'getProviderForPeer'>> => ({
  getProviderForPeer: jest
    .fn()
    .mockImplementation((peerConfig: { peerId: string; chain?: string }) => {
      if (peerConfig.chain === 'evm:anvil:31337') return provider;
      return undefined;
    }),
});

// Mock ChannelManager
const createMockChannelManager = (
  channelMap?: Record<string, { channelId: string; tokenAddress: string }>
): jest.Mocked<Pick<ChannelManager, 'getChannelForPeer' | 'ensureChannelExists'>> => ({
  getChannelForPeer: jest.fn().mockImplementation((peerId: string, tokenId: string) => {
    const key = `${peerId}:${tokenId}`;
    const channel = channelMap?.[key];
    if (!channel) return null;
    return {
      channelId: channel.channelId,
      tokenAddress: channel.tokenAddress,
      peerId,
      tokenId,
      chain: 'evm:anvil:31337',
      createdAt: new Date(),
      lastActivityAt: new Date(),
      status: 'open',
    };
  }),
  ensureChannelExists: jest.fn().mockResolvedValue(undefined),
});

// Mock SQLite Database
const createMockDb = (
  existingClaims?: Array<{ claim_data: string }>
): jest.Mocked<Pick<Database, 'prepare'>> => {
  const mockRun = jest.fn();
  const mockAll = jest.fn().mockReturnValue(existingClaims ?? []);
  const mockStatement = { run: mockRun, all: mockAll };
  return {
    prepare: jest.fn().mockReturnValue(mockStatement),
  } as unknown as jest.Mocked<Pick<Database, 'prepare'>>;
};

describe('PerPacketClaimService', () => {
  let service: PerPacketClaimService;
  let mockSDK: ReturnType<typeof createMockSDK>;
  let mockProvider: EVMPaymentChannelProvider;
  let mockRegistry: ReturnType<typeof createMockRegistry>;
  let mockChannelManager: ReturnType<typeof createMockChannelManager>;
  let mockDb: ReturnType<typeof createMockDb>;
  let mockLogger: Logger;

  const TEST_CHANNEL_ID = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const TEST_TOKEN_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const TEST_PEER_ID = 'connector-b';
  const TEST_NODE_ID = 'connector-a';

  beforeEach(() => {
    jest.clearAllMocks();

    mockSDK = createMockSDK();
    mockProvider = createMockEVMProvider(mockSDK);
    mockRegistry = createMockRegistry(mockProvider);
    mockChannelManager = createMockChannelManager({
      [`${TEST_PEER_ID}:M2M`]: {
        channelId: TEST_CHANNEL_ID,
        tokenAddress: TEST_TOKEN_ADDRESS,
      },
    });
    mockDb = createMockDb();
    mockLogger = createMockLogger();

    service = new PerPacketClaimService(
      mockRegistry as unknown as ChainProviderRegistry,
      mockChannelManager as unknown as ChannelManager,
      mockDb as unknown as Database,
      mockLogger,
      TEST_NODE_ID
    );
  });

  describe('generateClaimForPacket', () => {
    it('should generate a valid claim for a packet', async () => {
      const result = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);

      expect(result).not.toBeNull();
      expect(result!.protocolData.protocolName).toBe(BTP_CLAIM_PROTOCOL.NAME);
      expect(result!.protocolData.contentType).toBe(BTP_CLAIM_PROTOCOL.CONTENT_TYPE);

      const claim = result!.claimMessage;
      expect(isEVMClaim(claim)).toBe(true);
      const evmClaim = claim as EVMClaimMessage;
      expect(evmClaim.version).toBe('1.0');
      expect(evmClaim.blockchain).toBe('evm');
      expect(evmClaim.channelId).toBe(TEST_CHANNEL_ID);
      expect(evmClaim.nonce).toBe(1);
      expect(evmClaim.transferredAmount).toBe('1000');
      expect(evmClaim.lockedAmount).toBe('0');
      expect(evmClaim.signature).toBe('0xmocksignature');
      expect(evmClaim.senderId).toBe(TEST_NODE_ID);
      expect(evmClaim.chainId).toBe(31337);
      expect(evmClaim.tokenAddress).toBe(TEST_TOKEN_ADDRESS);
    });

    it('should increment nonce for sequential packets', async () => {
      const result1 = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 100n);
      const result2 = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 200n);
      const result3 = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 300n);

      expect((result1!.claimMessage as EVMClaimMessage).nonce).toBe(1);
      expect((result2!.claimMessage as EVMClaimMessage).nonce).toBe(2);
      expect((result3!.claimMessage as EVMClaimMessage).nonce).toBe(3);
    });

    it('should accumulate cumulative transferred amounts', async () => {
      const result1 = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 100n);
      const result2 = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 200n);
      const result3 = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 300n);

      expect((result1!.claimMessage as EVMClaimMessage).transferredAmount).toBe('100');
      expect((result2!.claimMessage as EVMClaimMessage).transferredAmount).toBe('300'); // 100 + 200
      expect((result3!.claimMessage as EVMClaimMessage).transferredAmount).toBe('600'); // 100 + 200 + 300
    });

    it('should return null when no channel exists for peer', async () => {
      const result = await service.generateClaimForPacket('unknown-peer', 'M2M', 1000n);
      expect(result).toBeNull();
    });

    it('should cache channel context after first lookup', async () => {
      await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 100n);
      await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 200n);

      // ChannelManager should only be called once due to caching
      expect(mockChannelManager.getChannelForPeer).toHaveBeenCalledTimes(1);
    });

    it('should call provider.signBalanceProof with correct parameters', async () => {
      const signSpy = jest.spyOn(mockProvider, 'signBalanceProof');

      await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 500n);

      expect(signSpy).toHaveBeenCalledWith({
        channelId: TEST_CHANNEL_ID,
        nonce: 1,
        transferredAmount: '500',
        lockedAmount: '0',
        locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      });
    });

    it('should persist claim to database', async () => {
      await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);

      // The DB prepare should have been called for INSERT
      expect(mockDb.prepare).toHaveBeenCalled();
    });

    it('should serialize claim as JSON in protocolData', async () => {
      const result = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);

      const parsed = JSON.parse(result!.protocolData.data.toString('utf8'));
      expect(parsed.channelId).toBe(TEST_CHANNEL_ID);
      expect(parsed.nonce).toBe(1);
      expect(parsed.transferredAmount).toBe('1000');
    });

    it('should return null when no provider found for peer (T-32.4-04)', async () => {
      // Peer has a channel but chain doesn't match any registered provider
      const noProviderChannelManager = createMockChannelManager({
        [`unknown-chain-peer:M2M`]: {
          channelId: TEST_CHANNEL_ID,
          tokenAddress: TEST_TOKEN_ADDRESS,
        },
      });
      // Override to return a different chain that has no provider
      noProviderChannelManager.getChannelForPeer.mockImplementation(
        (peerId: string, _tokenId: string) => {
          if (peerId === 'unknown-chain-peer') {
            return {
              channelId: TEST_CHANNEL_ID,
              tokenAddress: TEST_TOKEN_ADDRESS,
              peerId,
              tokenId: 'M2M',
              chain: 'solana:mainnet',
              createdAt: new Date(),
              lastActivityAt: new Date(),
              status: 'open' as const,
            };
          }
          return null;
        }
      );

      const svc = new PerPacketClaimService(
        mockRegistry as unknown as ChainProviderRegistry,
        noProviderChannelManager as unknown as ChannelManager,
        mockDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      const result = await svc.generateClaimForPacket('unknown-chain-peer', 'M2M', 1000n);
      expect(result).toBeNull();
    });

    it('should set blockchain discriminator matching peer chain type (T-32.4-02)', async () => {
      const result = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);

      expect(result).not.toBeNull();
      expect(result!.claimMessage.blockchain).toBe('evm');
    });

    it('should include tokenNetworkAddress, signerAddress, and chainId in EVM claim (T-32.4-03)', async () => {
      const result = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);

      expect(result).not.toBeNull();
      const evmClaim = result!.claimMessage as EVMClaimMessage;
      expect(evmClaim.tokenNetworkAddress).toBe('0xTokenNetworkAddress1234567890abcdef');
      expect(evmClaim.signerAddress).toBe('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1');
      expect(evmClaim.chainId).toBe(31337);
      expect(evmClaim.tokenAddress).toBe(TEST_TOKEN_ADDRESS);
    });

    it('should include blockchain discriminator in serialized JSON (AC3)', async () => {
      const result = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);

      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!.protocolData.data.toString('utf8'));
      expect(parsed.blockchain).toBe('evm');
      expect(parsed.chainId).toBe(31337);
      expect(parsed.tokenNetworkAddress).toBe('0xTokenNetworkAddress1234567890abcdef');
      expect(parsed.tokenAddress).toBe(TEST_TOKEN_ADDRESS);
      expect(parsed.signerAddress).toBe('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1');
    });
  });

  describe('getLatestClaim', () => {
    it('should return null when no claims generated', () => {
      expect(service.getLatestClaim(TEST_CHANNEL_ID)).toBeNull();
    });

    it('should return latest claim after generation', async () => {
      await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 100n);
      await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 200n);

      const latest = service.getLatestClaim(TEST_CHANNEL_ID);
      expect(latest).not.toBeNull();
      expect(isEVMClaim(latest!)).toBe(true);
      const evmLatest = latest as EVMClaimMessage;
      expect(evmLatest.nonce).toBe(2);
      expect(evmLatest.transferredAmount).toBe('300');
    });
  });

  describe('resetChannel', () => {
    it('should clear all tracking state for a channel', async () => {
      await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);
      expect(service.getLatestClaim(TEST_CHANNEL_ID)).not.toBeNull();

      service.resetChannel(TEST_CHANNEL_ID);

      expect(service.getLatestClaim(TEST_CHANNEL_ID)).toBeNull();
    });

    it('should restart nonce and cumulative after reset', async () => {
      await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 100n);
      await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 200n);

      service.resetChannel(TEST_CHANNEL_ID);

      // Need to clear cache so context is re-fetched
      const result = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 50n);
      expect((result!.claimMessage as EVMClaimMessage).nonce).toBe(1);
      expect((result!.claimMessage as EVMClaimMessage).transferredAmount).toBe('50');
    });
  });

  describe('startup recovery', () => {
    it('should recover nonce and cumulative from database', () => {
      const existingClaims = [
        {
          claim_data: JSON.stringify({
            channelId: TEST_CHANNEL_ID,
            nonce: 5,
            transferredAmount: '5000',
            blockchain: 'evm',
          }),
        },
      ];

      const recoveryDb = createMockDb(existingClaims);

      const recoveredService = new PerPacketClaimService(
        mockRegistry as unknown as ChainProviderRegistry,
        mockChannelManager as unknown as ChannelManager,
        recoveryDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      // Latest claim should be restored
      const latest = recoveredService.getLatestClaim(TEST_CHANNEL_ID);
      expect(latest).not.toBeNull();
      expect((latest as EVMClaimMessage).nonce).toBe(5);
    });

    it('should continue from recovered nonce', async () => {
      const existingClaims = [
        {
          claim_data: JSON.stringify({
            channelId: TEST_CHANNEL_ID,
            nonce: 10,
            transferredAmount: '10000',
            blockchain: 'evm',
          }),
        },
      ];

      const recoveryDb = createMockDb(existingClaims);

      const recoveredService = new PerPacketClaimService(
        mockRegistry as unknown as ChainProviderRegistry,
        mockChannelManager as unknown as ChannelManager,
        recoveryDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      const result = await recoveredService.generateClaimForPacket(TEST_PEER_ID, 'M2M', 500n);
      expect((result!.claimMessage as EVMClaimMessage).nonce).toBe(11); // continues from 10
      expect((result!.claimMessage as EVMClaimMessage).transferredAmount).toBe('10500'); // 10000 + 500
    });

    it('should handle malformed DB data gracefully', () => {
      const existingClaims = [{ claim_data: 'not-valid-json' }];
      const recoveryDb = createMockDb(existingClaims);

      // Should not throw
      expect(
        () =>
          new PerPacketClaimService(
            mockRegistry as unknown as ChainProviderRegistry,
            mockChannelManager as unknown as ChannelManager,
            recoveryDb as unknown as Database,
            mockLogger,
            TEST_NODE_ID
          )
      ).not.toThrow();
    });

    it('should handle DB query failure gracefully', () => {
      const failingDb = {
        prepare: jest.fn().mockReturnValue({
          all: jest.fn().mockImplementation(() => {
            throw new Error('DB read error');
          }),
          run: jest.fn(),
        }),
      } as unknown as Database;

      expect(
        () =>
          new PerPacketClaimService(
            mockRegistry as unknown as ChainProviderRegistry,
            mockChannelManager as unknown as ChannelManager,
            failingDb,
            mockLogger,
            TEST_NODE_ID
          )
      ).not.toThrow();
    });

    it('should recover claims without blockchain=evm filter (T-32.4-07)', () => {
      // Verify that claims of any blockchain type are recovered from DB
      const existingClaims = [
        {
          claim_data: JSON.stringify({
            channelId: TEST_CHANNEL_ID,
            nonce: 3,
            transferredAmount: '3000',
            blockchain: 'evm',
          }),
        },
        {
          // Non-EVM claim — should not crash recovery but won't populate nonce/cumulative
          claim_data: JSON.stringify({
            blockchain: 'solana',
            messageId: 'solana-claim-1',
            programId: 'SolanaProgram123',
            channelAccount: 'SolanaAccount123',
            signature: 'solana-sig',
          }),
        },
      ];

      const recoveryDb = createMockDb(existingClaims);

      // Should not throw even with non-EVM claims
      const recoveredService = new PerPacketClaimService(
        mockRegistry as unknown as ChainProviderRegistry,
        mockChannelManager as unknown as ChannelManager,
        recoveryDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      // EVM claim should be recovered
      const latest = recoveredService.getLatestClaim(TEST_CHANNEL_ID);
      expect(latest).not.toBeNull();
      expect((latest as EVMClaimMessage).nonce).toBe(3);
    });
  });

  describe('error handling', () => {
    it('should return null when buildChannelContext fails', async () => {
      mockSDK.getChainId.mockRejectedValueOnce(new Error('RPC failure'));

      // Channel exists but context building fails
      const result = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);
      expect(result).toBeNull();
    });

    it('should propagate signBalanceProof errors', async () => {
      // First, build context successfully
      await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 100n);

      // Then fail on sign
      mockSDK.signBalanceProof.mockRejectedValueOnce(new Error('Signing failed'));

      await expect(service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 200n)).rejects.toThrow(
        'Signing failed'
      );
    });
  });

  describe('on-demand channel creation', () => {
    it('should attempt ensureChannelExists when getChannelForPeer returns null initially', async () => {
      const onDemandChannelManager = createMockChannelManager();
      // First call returns null, second call (after ensureChannelExists) returns the channel
      let callCount = 0;
      onDemandChannelManager.getChannelForPeer.mockImplementation(
        (peerId: string, tokenId: string) => {
          callCount++;
          if (callCount === 1) return null;
          return {
            channelId: TEST_CHANNEL_ID,
            tokenAddress: TEST_TOKEN_ADDRESS,
            peerId,
            tokenId,
            chain: 'evm:anvil:31337',
            createdAt: new Date(),
            lastActivityAt: new Date(),
            status: 'open' as const,
          };
        }
      );

      const svc = new PerPacketClaimService(
        mockRegistry as unknown as ChainProviderRegistry,
        onDemandChannelManager as unknown as ChannelManager,
        mockDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      const result = await svc.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);
      expect(result).not.toBeNull();
      expect(onDemandChannelManager.ensureChannelExists).toHaveBeenCalledWith(
        TEST_PEER_ID,
        'M2M',
        undefined
      );
    });

    it('should return null when ensureChannelExists fails and no channel available', async () => {
      const failingChannelManager = createMockChannelManager();
      failingChannelManager.getChannelForPeer.mockReturnValue(null);
      failingChannelManager.ensureChannelExists.mockRejectedValue(
        new Error('Channel creation failed')
      );

      const svc = new PerPacketClaimService(
        mockRegistry as unknown as ChainProviderRegistry,
        failingChannelManager as unknown as ChannelManager,
        mockDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      const result = await svc.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);
      expect(result).toBeNull();
    });
  });

  describe('multi-peer isolation', () => {
    it('should track nonces and cumulative amounts independently per peer-channel', async () => {
      const PEER_B_CHANNEL_ID =
        '0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321';
      const multiPeerChannelManager = createMockChannelManager({
        [`${TEST_PEER_ID}:M2M`]: {
          channelId: TEST_CHANNEL_ID,
          tokenAddress: TEST_TOKEN_ADDRESS,
        },
        ['connector-c:M2M']: {
          channelId: PEER_B_CHANNEL_ID,
          tokenAddress: TEST_TOKEN_ADDRESS,
        },
      });

      const svc = new PerPacketClaimService(
        mockRegistry as unknown as ChainProviderRegistry,
        multiPeerChannelManager as unknown as ChannelManager,
        mockDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      // Generate claims for two different peers
      const resultA1 = await svc.generateClaimForPacket(TEST_PEER_ID, 'M2M', 100n);
      const resultB1 = await svc.generateClaimForPacket('connector-c', 'M2M', 500n);
      const resultA2 = await svc.generateClaimForPacket(TEST_PEER_ID, 'M2M', 200n);

      // Peer A: nonce 1 (100), nonce 2 (300 cumulative)
      expect((resultA1!.claimMessage as EVMClaimMessage).nonce).toBe(1);
      expect((resultA1!.claimMessage as EVMClaimMessage).transferredAmount).toBe('100');
      expect((resultA2!.claimMessage as EVMClaimMessage).nonce).toBe(2);
      expect((resultA2!.claimMessage as EVMClaimMessage).transferredAmount).toBe('300');

      // Peer B: nonce 1 (500) — independent from Peer A
      expect((resultB1!.claimMessage as EVMClaimMessage).nonce).toBe(1);
      expect((resultB1!.claimMessage as EVMClaimMessage).transferredAmount).toBe('500');
    });
  });

  describe('persistClaim error handling', () => {
    it('should handle duplicate claim message ID gracefully', async () => {
      // Set up DB to throw UNIQUE constraint error on INSERT
      const dupDb = {
        prepare: jest.fn().mockImplementation((sql: string) => {
          if (sql.includes('INSERT')) {
            return {
              run: jest.fn().mockImplementation(() => {
                throw new Error('UNIQUE constraint failed: sent_claims.message_id');
              }),
            };
          }
          // SELECT for recovery
          return { all: jest.fn().mockReturnValue([]), run: jest.fn() };
        }),
      } as unknown as Database;

      const svc = new PerPacketClaimService(
        mockRegistry as unknown as ChainProviderRegistry,
        mockChannelManager as unknown as ChannelManager,
        dupDb,
        mockLogger,
        TEST_NODE_ID
      );

      // Should not throw — duplicate is logged as warning, not an error
      const result = await svc.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);
      expect(result).not.toBeNull();
    });

    it('should log error for non-duplicate DB failures on persist', async () => {
      const failDb = {
        prepare: jest.fn().mockImplementation((sql: string) => {
          if (sql.includes('INSERT')) {
            return {
              run: jest.fn().mockImplementation(() => {
                throw new Error('disk I/O error');
              }),
            };
          }
          return { all: jest.fn().mockReturnValue([]), run: jest.fn() };
        }),
      } as unknown as Database;

      const svc = new PerPacketClaimService(
        mockRegistry as unknown as ChainProviderRegistry,
        mockChannelManager as unknown as ChannelManager,
        failDb,
        mockLogger,
        TEST_NODE_ID
      );

      // Should not throw — persist errors are logged, not propagated
      const result = await svc.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);
      expect(result).not.toBeNull();
      // Logger.error should have been called
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  /**
   * Acceptance Tests for Story 33.6: Solana Claim Message Types & Serialization
   *
   * Tests Solana claim construction, context population, nonce tracking,
   * cumulative amounts, serialization, and EVM backward compatibility.
   */
  describe('Solana claim construction (Story 33.6)', () => {
    const SOLANA_CHANNEL_ACCOUNT = 'AbCdEfGh11111111111111111111111111111111111';
    const SOLANA_PROGRAM_ID = 'PayChan11111111111111111111111111111111111';
    const SOLANA_TOKEN_MINT = 'SoLtOkEn1111111111111111111111111111111111';
    const SOLANA_SIGNER_PUBKEY = 'SiGnEr111111111111111111111111111111111111';
    const SOLANA_PEER_ID = 'connector-solana';
    const SOLANA_CLUSTER = 'devnet';

    // Mock SolanaPaymentChannelProvider
    const createMockSolanaProvider = (): jest.Mocked<SolanaPaymentChannelProvider> => {
      const provider = {
        signBalanceProof: jest.fn().mockResolvedValue('c29sYW5hLXNpZ25hdHVyZS1kYXRh'),
        verifyBalanceProof: jest.fn().mockResolvedValue(true),
        getChannelState: jest.fn(),
        openChannel: jest.fn(),
        deposit: jest.fn(),
        claimFromChannel: jest.fn(),
        closeChannel: jest.fn(),
        settleChannel: jest.fn(),
        subscribeToEvents: jest.fn(),
        chainType: 'solana' as const,
        chainId: 'solana:devnet',
        getSolanaContext: jest.fn().mockReturnValue({
          programId: SOLANA_PROGRAM_ID,
          tokenMint: SOLANA_TOKEN_MINT,
          cluster: SOLANA_CLUSTER,
          signerAddress: SOLANA_SIGNER_PUBKEY,
        }),
      } as unknown as jest.Mocked<SolanaPaymentChannelProvider>;
      // Set prototype so that `instanceof SolanaPaymentChannelProvider` checks pass
      Object.setPrototypeOf(provider, SolanaPaymentChannelProvider.prototype);
      return provider;
    };

    // Registry that returns Solana provider for Solana chain
    const createSolanaRegistry = (
      solanaProvider: jest.Mocked<SolanaPaymentChannelProvider>,
      evmProvider?: EVMPaymentChannelProvider
    ): jest.Mocked<Pick<ChainProviderRegistry, 'getProviderForPeer'>> => ({
      getProviderForPeer: jest
        .fn()
        .mockImplementation((peerConfig: { peerId: string; chain?: string }) => {
          if (peerConfig.chain?.startsWith('solana:')) return solanaProvider;
          if (peerConfig.chain?.startsWith('evm:') && evmProvider) return evmProvider;
          return undefined;
        }),
    });

    // Channel manager that returns Solana channel metadata
    const createSolanaChannelManager = (): jest.Mocked<
      Pick<ChannelManager, 'getChannelForPeer' | 'ensureChannelExists'>
    > => ({
      getChannelForPeer: jest.fn().mockImplementation((peerId: string, _tokenId: string) => {
        if (peerId === SOLANA_PEER_ID) {
          return {
            channelId: SOLANA_CHANNEL_ACCOUNT,
            tokenAddress: SOLANA_TOKEN_MINT,
            peerId,
            tokenId: 'SOL',
            chain: 'solana:devnet',
            createdAt: new Date(),
            lastActivityAt: new Date(),
            status: 'open' as const,
          };
        }
        return null;
      }),
      ensureChannelExists: jest.fn().mockResolvedValue(undefined),
    });

    it('[P0] should construct SolanaClaimMessage for Solana peer (T-33.6-01)', async () => {
      const solanaProvider = createMockSolanaProvider();
      const solanaRegistry = createSolanaRegistry(solanaProvider);
      const solanaChannelManager = createSolanaChannelManager();

      const svc = new PerPacketClaimService(
        solanaRegistry as unknown as ChainProviderRegistry,
        solanaChannelManager as unknown as ChannelManager,
        mockDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      const result = await svc.generateClaimForPacket(SOLANA_PEER_ID, 'SOL', 1000n);

      expect(result).not.toBeNull();
      expect(isSolanaClaim(result!.claimMessage)).toBe(true);

      const solanaClaim = result!.claimMessage as SolanaClaimMessage;
      expect(solanaClaim.blockchain).toBe('solana');
      expect(solanaClaim.version).toBe('1.0');
      expect(solanaClaim.senderId).toBe(TEST_NODE_ID);
    });

    it('[P0] should populate correct Solana fields from getSolanaContext (T-33.6-02)', async () => {
      const solanaProvider = createMockSolanaProvider();
      const solanaRegistry = createSolanaRegistry(solanaProvider);
      const solanaChannelManager = createSolanaChannelManager();

      const svc = new PerPacketClaimService(
        solanaRegistry as unknown as ChainProviderRegistry,
        solanaChannelManager as unknown as ChannelManager,
        mockDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      const result = await svc.generateClaimForPacket(SOLANA_PEER_ID, 'SOL', 1000n);

      const solanaClaim = result!.claimMessage as SolanaClaimMessage;
      expect(solanaClaim.programId).toBe(SOLANA_PROGRAM_ID);
      expect(solanaClaim.channelAccount).toBe(SOLANA_CHANNEL_ACCOUNT);
      expect(solanaClaim.signerPublicKey).toBe(SOLANA_SIGNER_PUBKEY);
      expect(solanaClaim.cluster).toBe(SOLANA_CLUSTER);
    });

    it('[P0] should increment Solana claim nonce per packet (T-33.6-03)', async () => {
      const solanaProvider = createMockSolanaProvider();
      const solanaRegistry = createSolanaRegistry(solanaProvider);
      const solanaChannelManager = createSolanaChannelManager();

      const svc = new PerPacketClaimService(
        solanaRegistry as unknown as ChainProviderRegistry,
        solanaChannelManager as unknown as ChannelManager,
        mockDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      const result1 = await svc.generateClaimForPacket(SOLANA_PEER_ID, 'SOL', 100n);
      const result2 = await svc.generateClaimForPacket(SOLANA_PEER_ID, 'SOL', 200n);
      const result3 = await svc.generateClaimForPacket(SOLANA_PEER_ID, 'SOL', 300n);

      expect((result1!.claimMessage as SolanaClaimMessage).nonce).toBe(1);
      expect((result2!.claimMessage as SolanaClaimMessage).nonce).toBe(2);
      expect((result3!.claimMessage as SolanaClaimMessage).nonce).toBe(3);
    });

    it('[P0] should accumulate Solana claim transferredAmount cumulatively (T-33.6-04)', async () => {
      const solanaProvider = createMockSolanaProvider();
      const solanaRegistry = createSolanaRegistry(solanaProvider);
      const solanaChannelManager = createSolanaChannelManager();

      const svc = new PerPacketClaimService(
        solanaRegistry as unknown as ChainProviderRegistry,
        solanaChannelManager as unknown as ChannelManager,
        mockDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      const result1 = await svc.generateClaimForPacket(SOLANA_PEER_ID, 'SOL', 100n);
      const result2 = await svc.generateClaimForPacket(SOLANA_PEER_ID, 'SOL', 200n);
      const result3 = await svc.generateClaimForPacket(SOLANA_PEER_ID, 'SOL', 300n);

      expect((result1!.claimMessage as SolanaClaimMessage).transferredAmount).toBe('100');
      expect((result2!.claimMessage as SolanaClaimMessage).transferredAmount).toBe('300'); // 100 + 200
      expect((result3!.claimMessage as SolanaClaimMessage).transferredAmount).toBe('600'); // 100 + 200 + 300
    });

    it('[P0] should call getSolanaContext during buildChannelContext (T-33.6-05)', async () => {
      const solanaProvider = createMockSolanaProvider();
      const solanaRegistry = createSolanaRegistry(solanaProvider);
      const solanaChannelManager = createSolanaChannelManager();

      const svc = new PerPacketClaimService(
        solanaRegistry as unknown as ChainProviderRegistry,
        solanaChannelManager as unknown as ChannelManager,
        mockDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      await svc.generateClaimForPacket(SOLANA_PEER_ID, 'SOL', 1000n);

      expect(solanaProvider.getSolanaContext).toHaveBeenCalledTimes(1);
    });

    it('[P0] should serialize Solana claim to valid JSON in BTP protocolData (T-33.6-02/AC2)', async () => {
      const solanaProvider = createMockSolanaProvider();
      const solanaRegistry = createSolanaRegistry(solanaProvider);
      const solanaChannelManager = createSolanaChannelManager();

      const svc = new PerPacketClaimService(
        solanaRegistry as unknown as ChainProviderRegistry,
        solanaChannelManager as unknown as ChannelManager,
        mockDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      const result = await svc.generateClaimForPacket(SOLANA_PEER_ID, 'SOL', 5000n);

      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!.protocolData.data.toString('utf8'));
      expect(parsed.blockchain).toBe('solana');
      expect(parsed.programId).toBe(SOLANA_PROGRAM_ID);
      expect(parsed.channelAccount).toBe(SOLANA_CHANNEL_ACCOUNT);
      expect(parsed.signerPublicKey).toBe(SOLANA_SIGNER_PUBKEY);
      expect(parsed.cluster).toBe(SOLANA_CLUSTER);
      expect(parsed.nonce).toBe(1);
      expect(parsed.transferredAmount).toBe('5000');
      expect(parsed.signature).toBe('c29sYW5hLXNpZ25hdHVyZS1kYXRh');

      // AC5: tokenMint must NOT be serialized in the claim message
      // (it is stored in ChannelClaimContext for logging/validation only)
      expect(parsed).not.toHaveProperty('tokenMint');
    });

    it('[P1] should throw when Solana context fields are missing (AC5 guard)', async () => {
      const badSolanaProvider = createMockSolanaProvider();
      // Return incomplete context (missing programId)
      badSolanaProvider.getSolanaContext.mockReturnValue({
        programId: '',
        tokenMint: SOLANA_TOKEN_MINT,
        cluster: SOLANA_CLUSTER,
        signerAddress: SOLANA_SIGNER_PUBKEY,
      });
      const solanaRegistry = createSolanaRegistry(badSolanaProvider);
      const solanaChannelManager = createSolanaChannelManager();

      const svc = new PerPacketClaimService(
        solanaRegistry as unknown as ChainProviderRegistry,
        solanaChannelManager as unknown as ChannelManager,
        mockDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      await expect(svc.generateClaimForPacket(SOLANA_PEER_ID, 'SOL', 1000n)).rejects.toThrow(
        /programId/
      );
    });

    it('[P0] should NOT break EVM claim construction (AC1/AC4 regression)', async () => {
      // Verify EVM claims still work when Solana support is wired in
      const result = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);

      expect(result).not.toBeNull();
      expect(isEVMClaim(result!.claimMessage)).toBe(true);
      const evmClaim = result!.claimMessage as EVMClaimMessage;
      expect(evmClaim.blockchain).toBe('evm');
      expect(evmClaim.channelId).toBe(TEST_CHANNEL_ID);
      expect(evmClaim.nonce).toBe(1);
      expect(evmClaim.transferredAmount).toBe('1000');
    });
  });

  describe('Solana claim recovery from DB (Story 33.6)', () => {
    it('[P0] should recover Solana claim state from database on startup (T-33.6-06)', () => {
      const SOLANA_CHANNEL = 'AbCdEfGh11111111111111111111111111111111111';
      const existingClaims = [
        {
          claim_data: JSON.stringify({
            blockchain: 'solana',
            messageId: 'solana-AbCdEfGh-5-1706889600000',
            programId: 'PayChan11111111111111111111111111111111111',
            channelAccount: SOLANA_CHANNEL,
            nonce: 5,
            transferredAmount: '50000',
            signature: 'c29sYW5hLXNpZw==',
            signerPublicKey: 'SiGnEr111111111111111111111111111111111111',
            cluster: 'devnet',
          }),
        },
      ];

      const recoveryDb = createMockDb(existingClaims);

      const recoveredService = new PerPacketClaimService(
        mockRegistry as unknown as ChainProviderRegistry,
        mockChannelManager as unknown as ChannelManager,
        recoveryDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      const latest = recoveredService.getLatestClaim(SOLANA_CHANNEL);
      expect(latest).not.toBeNull();
      expect(isSolanaClaim(latest!)).toBe(true);
      expect((latest as SolanaClaimMessage).nonce).toBe(5);
      expect((latest as SolanaClaimMessage).transferredAmount).toBe('50000');
      expect((latest as SolanaClaimMessage).channelAccount).toBe(SOLANA_CHANNEL);
    });

    it('[P0] should continue Solana claim generation from recovered state (T-33.6-06 cont.)', async () => {
      const SOLANA_CHANNEL = 'AbCdEfGh11111111111111111111111111111111111';
      const existingClaims = [
        {
          claim_data: JSON.stringify({
            blockchain: 'solana',
            messageId: 'solana-AbCdEfGh-10-1706889600000',
            programId: 'PayChan11111111111111111111111111111111111',
            channelAccount: SOLANA_CHANNEL,
            nonce: 10,
            transferredAmount: '100000',
            signature: 'c29sYW5hLXNpZw==',
            signerPublicKey: 'SiGnEr111111111111111111111111111111111111',
            cluster: 'devnet',
          }),
        },
      ];

      const recoveryDb = createMockDb(existingClaims);

      const solanaProvider = {
        signBalanceProof: jest.fn().mockResolvedValue('bmV3LXNpZw=='),
        chainType: 'solana' as const,
        chainId: 'solana:devnet',
        getSolanaContext: jest.fn().mockReturnValue({
          programId: 'PayChan11111111111111111111111111111111111',
          tokenMint: 'SoLtOkEn1111111111111111111111111111111111',
          cluster: 'devnet',
          signerAddress: 'SiGnEr111111111111111111111111111111111111',
        }),
      } as unknown as jest.Mocked<SolanaPaymentChannelProvider>;
      Object.setPrototypeOf(solanaProvider, SolanaPaymentChannelProvider.prototype);

      const solanaRegistry = {
        getProviderForPeer: jest.fn().mockReturnValue(solanaProvider),
      };

      const solanaChannelManager = {
        getChannelForPeer: jest.fn().mockReturnValue({
          channelId: SOLANA_CHANNEL,
          tokenAddress: 'SoLtOkEn1111111111111111111111111111111111',
          peerId: 'connector-solana',
          tokenId: 'SOL',
          chain: 'solana:devnet',
          createdAt: new Date(),
          lastActivityAt: new Date(),
          status: 'open' as const,
        }),
        ensureChannelExists: jest.fn(),
      };

      const recoveredService = new PerPacketClaimService(
        solanaRegistry as unknown as ChainProviderRegistry,
        solanaChannelManager as unknown as ChannelManager,
        recoveryDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      const result = await recoveredService.generateClaimForPacket('connector-solana', 'SOL', 500n);
      expect(result).not.toBeNull();
      expect((result!.claimMessage as SolanaClaimMessage).nonce).toBe(11); // continues from 10
      expect((result!.claimMessage as SolanaClaimMessage).transferredAmount).toBe('100500'); // 100000 + 500
    });

    it('[P1] should skip structurally invalid Solana claims during recovery (T-33.6-06 guard)', () => {
      const existingClaims = [
        {
          claim_data: JSON.stringify({
            blockchain: 'solana',
            messageId: 'solana-bad-claim',
            // Missing channelAccount, nonce, transferredAmount
            programId: 'PayChan11111111111111111111111111111111111',
          }),
        },
      ];

      const recoveryDb = createMockDb(existingClaims);

      // Should not throw
      expect(
        () =>
          new PerPacketClaimService(
            mockRegistry as unknown as ChainProviderRegistry,
            mockChannelManager as unknown as ChannelManager,
            recoveryDb as unknown as Database,
            mockLogger,
            TEST_NODE_ID
          )
      ).not.toThrow();
    });
  });

  /**
   * Acceptance Tests for Story 34.7: Mina Claim Message Types & Serialization
   *
   * Tests Mina claim construction, context population, nonce tracking,
   * serialization, and DB recovery for Mina claims.
   */
  describe('Mina claim construction (Story 34.7)', () => {
    const MINA_ZKAPP_ADDRESS = 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy';
    const MINA_TOKEN_ID = 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf';
    const MINA_NETWORK = 'devnet';
    const MINA_PEER_ID = 'connector-mina';

    // Mock MinaPaymentChannelProvider
    const createMockMinaProvider = (): jest.Mocked<MinaPaymentChannelProvider> => {
      const provider = {
        signBalanceProof: jest.fn().mockResolvedValue('eyJwcm9vZiI6InRlc3QifQ=='),
        verifyBalanceProof: jest.fn().mockResolvedValue(true),
        getChannelState: jest.fn(),
        openChannel: jest.fn(),
        deposit: jest.fn(),
        claimFromChannel: jest.fn(),
        closeChannel: jest.fn(),
        settleChannel: jest.fn(),
        subscribeToEvents: jest.fn(),
        chainType: 'mina' as const,
        chainId: 'mina:devnet',
        getMinaContext: jest.fn().mockResolvedValue({
          zkAppAddress: MINA_ZKAPP_ADDRESS,
          tokenId: MINA_TOKEN_ID,
          network: MINA_NETWORK,
          signerAddress: MINA_ZKAPP_ADDRESS,
        }),
      } as unknown as jest.Mocked<MinaPaymentChannelProvider>;
      // Set prototype so that `instanceof MinaPaymentChannelProvider` checks pass
      Object.setPrototypeOf(provider, MinaPaymentChannelProvider.prototype);
      return provider;
    };

    // Registry that returns Mina provider for Mina chain
    const createMinaRegistry = (
      minaProvider: jest.Mocked<MinaPaymentChannelProvider>
    ): jest.Mocked<Pick<ChainProviderRegistry, 'getProviderForPeer'>> => ({
      getProviderForPeer: jest
        .fn()
        .mockImplementation((peerConfig: { peerId: string; chain?: string }) => {
          if (peerConfig.chain?.startsWith('mina:')) return minaProvider;
          return undefined;
        }),
    });

    // Channel manager that returns Mina channel metadata
    const createMinaChannelManager = (): jest.Mocked<
      Pick<ChannelManager, 'getChannelForPeer' | 'ensureChannelExists'>
    > => ({
      getChannelForPeer: jest.fn().mockImplementation((peerId: string, _tokenId: string) => {
        if (peerId === MINA_PEER_ID) {
          return {
            channelId: MINA_ZKAPP_ADDRESS,
            tokenAddress: MINA_TOKEN_ID,
            peerId,
            tokenId: 'MINA',
            chain: 'mina:devnet',
            createdAt: new Date(),
            lastActivityAt: new Date(),
            status: 'open' as const,
          };
        }
        return null;
      }),
      ensureChannelExists: jest.fn().mockResolvedValue(undefined),
    });

    it('[P0] should construct MinaClaimMessage for Mina peer (T-34.7-17)', async () => {
      const minaProvider = createMockMinaProvider();
      const minaRegistry = createMinaRegistry(minaProvider);
      const minaChannelManager = createMinaChannelManager();

      const svc = new PerPacketClaimService(
        minaRegistry as unknown as ChainProviderRegistry,
        minaChannelManager as unknown as ChannelManager,
        mockDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      const result = await svc.generateClaimForPacket(MINA_PEER_ID, 'MINA', 1000n);

      expect(result).not.toBeNull();
      expect(isMinaClaim(result!.claimMessage)).toBe(true);

      const minaClaim = result!.claimMessage as MinaClaimMessage;
      expect(minaClaim.blockchain).toBe('mina');
      expect(minaClaim.version).toBe('1.0');
      expect(minaClaim.senderId).toBe(TEST_NODE_ID);
      expect(minaClaim.zkAppAddress).toBe(MINA_ZKAPP_ADDRESS);
      expect(minaClaim.tokenId).toBe(MINA_TOKEN_ID);
      expect(minaClaim.network).toBe(MINA_NETWORK);
      expect(minaClaim.proof).toBe('eyJwcm9vZiI6InRlc3QifQ==');
      expect(minaClaim.salt).toBeDefined();
      expect(minaClaim.salt.length).toBeGreaterThan(0);
    });

    it('[P0] should populate correct Mina fields from getMinaContext (T-34.7-17)', async () => {
      const minaProvider = createMockMinaProvider();
      const minaRegistry = createMinaRegistry(minaProvider);
      const minaChannelManager = createMinaChannelManager();

      const svc = new PerPacketClaimService(
        minaRegistry as unknown as ChainProviderRegistry,
        minaChannelManager as unknown as ChannelManager,
        mockDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      const result = await svc.generateClaimForPacket(MINA_PEER_ID, 'MINA', 1000n);

      expect(minaProvider.getMinaContext).toHaveBeenCalledTimes(1);
      const minaClaim = result!.claimMessage as MinaClaimMessage;
      expect(minaClaim.zkAppAddress).toBe(MINA_ZKAPP_ADDRESS);
      expect(minaClaim.tokenId).toBe(MINA_TOKEN_ID);
      expect(minaClaim.network).toBe(MINA_NETWORK);
    });

    it('[P0] should increment Mina claim nonce per packet (T-34.7-18)', async () => {
      const minaProvider = createMockMinaProvider();
      const minaRegistry = createMinaRegistry(minaProvider);
      const minaChannelManager = createMinaChannelManager();

      const svc = new PerPacketClaimService(
        minaRegistry as unknown as ChainProviderRegistry,
        minaChannelManager as unknown as ChannelManager,
        mockDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      const result1 = await svc.generateClaimForPacket(MINA_PEER_ID, 'MINA', 100n);
      const result2 = await svc.generateClaimForPacket(MINA_PEER_ID, 'MINA', 200n);
      const result3 = await svc.generateClaimForPacket(MINA_PEER_ID, 'MINA', 300n);

      expect((result1!.claimMessage as MinaClaimMessage).nonce).toBe(1);
      expect((result2!.claimMessage as MinaClaimMessage).nonce).toBe(2);
      expect((result3!.claimMessage as MinaClaimMessage).nonce).toBe(3);
    });

    it('[P0] should use same salt across multiple claims in same session (T-34.7-18)', async () => {
      const minaProvider = createMockMinaProvider();
      const minaRegistry = createMinaRegistry(minaProvider);
      const minaChannelManager = createMinaChannelManager();

      const svc = new PerPacketClaimService(
        minaRegistry as unknown as ChainProviderRegistry,
        minaChannelManager as unknown as ChannelManager,
        mockDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      const result1 = await svc.generateClaimForPacket(MINA_PEER_ID, 'MINA', 100n);
      const result2 = await svc.generateClaimForPacket(MINA_PEER_ID, 'MINA', 200n);

      const salt1 = (result1!.claimMessage as MinaClaimMessage).salt;
      const salt2 = (result2!.claimMessage as MinaClaimMessage).salt;
      expect(salt1).toBe(salt2); // Same salt across session
    });

    it('[P0] should serialize Mina claim to valid JSON in BTP protocolData (T-34.7-18)', async () => {
      const minaProvider = createMockMinaProvider();
      const minaRegistry = createMinaRegistry(minaProvider);
      const minaChannelManager = createMinaChannelManager();

      const svc = new PerPacketClaimService(
        minaRegistry as unknown as ChainProviderRegistry,
        minaChannelManager as unknown as ChannelManager,
        mockDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      const result = await svc.generateClaimForPacket(MINA_PEER_ID, 'MINA', 5000n);

      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!.protocolData.data.toString('utf8'));
      expect(parsed.blockchain).toBe('mina');
      expect(parsed.zkAppAddress).toBe(MINA_ZKAPP_ADDRESS);
      expect(parsed.tokenId).toBe(MINA_TOKEN_ID);
      expect(parsed.network).toBe(MINA_NETWORK);
      expect(parsed.nonce).toBe(1);
      expect(parsed.proof).toBe('eyJwcm9vZiI6InRlc3QifQ==');
      expect(typeof parsed.salt).toBe('string');
      expect(typeof parsed.balanceCommitment).toBe('string');
    });

    it('[P1] should throw when Mina context fields are missing (guard)', async () => {
      const badMinaProvider = createMockMinaProvider();
      badMinaProvider.getMinaContext.mockResolvedValue({
        zkAppAddress: '',
        tokenId: MINA_TOKEN_ID,
        network: MINA_NETWORK,
        signerAddress: MINA_ZKAPP_ADDRESS,
      });
      const minaRegistry = createMinaRegistry(badMinaProvider);
      const minaChannelManager = createMinaChannelManager();

      const svc = new PerPacketClaimService(
        minaRegistry as unknown as ChainProviderRegistry,
        minaChannelManager as unknown as ChannelManager,
        mockDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      await expect(svc.generateClaimForPacket(MINA_PEER_ID, 'MINA', 1000n)).rejects.toThrow(
        /zkAppAddress/
      );
    });

    it('[P0] should NOT break EVM claim construction (regression)', async () => {
      const result = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);

      expect(result).not.toBeNull();
      expect(isEVMClaim(result!.claimMessage)).toBe(true);
      const evmClaim = result!.claimMessage as EVMClaimMessage;
      expect(evmClaim.blockchain).toBe('evm');
      expect(evmClaim.channelId).toBe(TEST_CHANNEL_ID);
    });
  });

  describe('Mina claim recovery from DB (Story 34.7)', () => {
    it('[P0] should recover Mina claim state from database on startup (T-34.7-19)', () => {
      const existingClaims = [
        {
          claim_data: JSON.stringify({
            blockchain: 'mina',
            messageId: 'mina-B62qre3e-5-1706889600000',
            zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
            tokenId: 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf',
            balanceCommitment: '50000',
            nonce: 5,
            proof: 'eyJwcm9vZiI6InRlc3QifQ==',
            salt: 'abcdef1234567890',
            network: 'devnet',
          }),
        },
      ];

      const recoveryDb = createMockDb(existingClaims);

      const recoveredService = new PerPacketClaimService(
        mockRegistry as unknown as ChainProviderRegistry,
        mockChannelManager as unknown as ChannelManager,
        recoveryDb as unknown as Database,
        mockLogger,
        TEST_NODE_ID
      );

      const MINA_ZKAPP = 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy';
      const latest = recoveredService.getLatestClaim(MINA_ZKAPP);
      expect(latest).not.toBeNull();
      expect(isMinaClaim(latest!)).toBe(true);
      expect((latest as MinaClaimMessage).nonce).toBe(5);
      expect((latest as MinaClaimMessage).zkAppAddress).toBe(MINA_ZKAPP);
    });

    it('[P1] should skip structurally invalid Mina claims during recovery (T-34.7-19 guard)', () => {
      const existingClaims = [
        {
          claim_data: JSON.stringify({
            blockchain: 'mina',
            messageId: 'mina-bad-claim',
            // Missing zkAppAddress, nonce
            proof: 'eyJwcm9vZiI6InRlc3QifQ==',
          }),
        },
      ];

      const recoveryDb = createMockDb(existingClaims);

      // Should not throw
      expect(
        () =>
          new PerPacketClaimService(
            mockRegistry as unknown as ChainProviderRegistry,
            mockChannelManager as unknown as ChannelManager,
            recoveryDb as unknown as Database,
            mockLogger,
            TEST_NODE_ID
          )
      ).not.toThrow();
    });
  });
});
