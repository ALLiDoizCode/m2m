/**
 * Acceptance Tests for Story 32.4: Refactor PerPacketClaimService for Multi-Chain
 *
 * TDD RED PHASE: All tests are skipped and will fail until implementation is complete.
 *
 * These tests validate that PerPacketClaimService delegates to the chain-appropriate
 * PaymentChannelProvider via ChainProviderRegistry instead of directly using PaymentChannelSDK.
 *
 * Acceptance Criteria Covered:
 * - AC1: Claim generation delegates to provider for signing
 * - AC2: Claim message type determined by peer's chain
 * - AC3: Self-describing claim format includes blockchain discriminator
 * - AC4: Backward compatibility with existing claim generation
 * - AC5: No provider found for peer results in null return
 *
 * @module test/acceptance/story-32-4
 */

import { PerPacketClaimService } from '../../src/settlement/per-packet-claim-service';
import {
  BTP_CLAIM_PROTOCOL,
  type BTPClaimMessage,
  type EVMClaimMessage,
  isEVMClaim,
} from '../../src/btp/btp-claim-types';
import { EVMPaymentChannelProvider } from '../../src/settlement/provider/evm-payment-channel-provider';
import type { ChainProviderRegistry } from '../../src/settlement/provider/chain-provider-registry';
import type { ChannelManager } from '../../src/settlement/channel-manager';
import type { PaymentChannelSDK } from '../../src/settlement/payment-channel-sdk';
import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';

// ---------------------------------------------------------------------------
// Test Constants
// ---------------------------------------------------------------------------

const TEST_CHANNEL_ID = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const TEST_TOKEN_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const TEST_PEER_ID = 'connector-b';
const TEST_NODE_ID = 'connector-a';
const TEST_CHAIN_ID_STRING = 'evm:anvil:31337';
const TEST_CHAIN_ID_NUMERIC = 31337;
const TEST_TOKEN_NETWORK_ADDRESS = '0xTokenNetworkAddress1234567890abcdef';
const TEST_SIGNER_ADDRESS = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1';

// ---------------------------------------------------------------------------
// Mock Factories
// ---------------------------------------------------------------------------

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

const createMockSDK = (): jest.Mocked<
  Pick<
    PaymentChannelSDK,
    'signBalanceProof' | 'getChainId' | 'getTokenNetworkAddress' | 'getSignerAddress'
  >
> => ({
  signBalanceProof: jest.fn().mockResolvedValue('0xmocksignature'),
  getChainId: jest.fn().mockResolvedValue(TEST_CHAIN_ID_NUMERIC),
  getTokenNetworkAddress: jest.fn().mockResolvedValue(TEST_TOKEN_NETWORK_ADDRESS),
  getSignerAddress: jest.fn().mockResolvedValue(TEST_SIGNER_ADDRESS),
});

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
      chain: TEST_CHAIN_ID_STRING,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      status: 'opened',
    };
  }),
  ensureChannelExists: jest.fn().mockResolvedValue(undefined),
});

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

// ---------------------------------------------------------------------------
// AC1: Claim Generation Delegates to Provider for Signing
// ---------------------------------------------------------------------------

describe('Story 32.4 - AC1: Claim generation delegates to provider for signing', () => {
  it('[P0] [T-32.4-01] should delegate signing to provider.signBalanceProof with params object and string amounts', async () => {
    // Given: a PerPacketClaimService configured with a ChainProviderRegistry
    // And: peer "connector-b" is configured to settle on chain "evm:anvil:31337"
    const mockLogger = createMockLogger();
    const mockSDK = createMockSDK();
    const mockDb = createMockDb();
    const mockChannelManager = createMockChannelManager({
      [`${TEST_PEER_ID}:M2M`]: {
        channelId: TEST_CHANNEL_ID,
        tokenAddress: TEST_TOKEN_ADDRESS,
      },
    });

    // Create a real EVMPaymentChannelProvider with mocked SDK
    const evmProvider = new EVMPaymentChannelProvider(
      mockSDK as unknown as PaymentChannelSDK,
      TEST_CHAIN_ID_STRING,
      TEST_TOKEN_ADDRESS,
      mockLogger
    );
    const signSpy = jest.spyOn(evmProvider, 'signBalanceProof');

    // Create mock registry that returns the EVM provider
    const mockRegistry = {
      getProviderForPeer: jest
        .fn()
        .mockImplementation((peerConfig: { peerId: string; chain?: string }) => {
          if (peerConfig.chain === TEST_CHAIN_ID_STRING) return evmProvider;
          return undefined;
        }),
    } as unknown as ChainProviderRegistry;

    // When: PerPacketClaimService is constructed with the registry (not SDK directly)
    // This tests that the constructor accepts ChainProviderRegistry instead of PaymentChannelSDK
    // NOTE: Cast through unknown because constructor signature changes in this story
    const service = new PerPacketClaimService(
      mockRegistry as unknown as ChainProviderRegistry,
      mockChannelManager as unknown as ChannelManager,
      mockDb as unknown as Database,
      mockLogger,
      TEST_NODE_ID
    );

    // When: generateClaimForPacket is called
    const result = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);

    // Then: the service should have called provider.signBalanceProof with a params object
    expect(result).not.toBeNull();
    expect(signSpy).toHaveBeenCalledWith({
      channelId: TEST_CHANNEL_ID,
      nonce: 1,
      transferredAmount: '1000', // string, not bigint
      lockedAmount: '0', // string, not bigint
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
    });

    // And: the SDK's signBalanceProof should have been called through the provider
    expect(mockSDK.signBalanceProof).toHaveBeenCalled();
    expect((result!.claimMessage as EVMClaimMessage).signature).toBe('0xmocksignature');
  });

  it('[P0] [T-32.4-06] should cache channel context with provider reference', async () => {
    // Given: a PerPacketClaimService configured with a ChainProviderRegistry
    const mockLogger = createMockLogger();
    const mockSDK = createMockSDK();
    const mockDb = createMockDb();
    const mockChannelManager = createMockChannelManager({
      [`${TEST_PEER_ID}:M2M`]: {
        channelId: TEST_CHANNEL_ID,
        tokenAddress: TEST_TOKEN_ADDRESS,
      },
    });

    const evmProvider = new EVMPaymentChannelProvider(
      mockSDK as unknown as PaymentChannelSDK,
      TEST_CHAIN_ID_STRING,
      TEST_TOKEN_ADDRESS,
      mockLogger
    );

    const mockRegistry = {
      getProviderForPeer: jest.fn().mockReturnValue(evmProvider),
    } as unknown as ChainProviderRegistry;

    const service = new PerPacketClaimService(
      mockRegistry as unknown as ChainProviderRegistry,
      mockChannelManager as unknown as ChannelManager,
      mockDb as unknown as Database,
      mockLogger,
      TEST_NODE_ID
    );

    // When: generateClaimForPacket is called twice for the same peer
    await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 100n);
    await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 200n);

    // Then: ChannelManager should only be called once (caching works)
    expect(mockChannelManager.getChannelForPeer).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AC2: Claim Message Type Determined by Peer's Chain
// ---------------------------------------------------------------------------

describe("Story 32.4 - AC2: Claim message type determined by peer's chain", () => {
  it("[P0] [T-32.4-02] should set blockchain discriminator matching peer's provider.chainType", async () => {
    // Given: peer "connector-b" is configured for "evm"
    const mockLogger = createMockLogger();
    const mockSDK = createMockSDK();
    const mockDb = createMockDb();
    const mockChannelManager = createMockChannelManager({
      [`${TEST_PEER_ID}:M2M`]: {
        channelId: TEST_CHANNEL_ID,
        tokenAddress: TEST_TOKEN_ADDRESS,
      },
    });

    const evmProvider = new EVMPaymentChannelProvider(
      mockSDK as unknown as PaymentChannelSDK,
      TEST_CHAIN_ID_STRING,
      TEST_TOKEN_ADDRESS,
      mockLogger
    );

    const mockRegistry = {
      getProviderForPeer: jest.fn().mockReturnValue(evmProvider),
    } as unknown as ChainProviderRegistry;

    const service = new PerPacketClaimService(
      mockRegistry as unknown as ChainProviderRegistry,
      mockChannelManager as unknown as ChannelManager,
      mockDb as unknown as Database,
      mockLogger,
      TEST_NODE_ID
    );

    // When: generateClaimForPacket is called for EVM peer
    const result = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);

    // Then: the resulting claim has blockchain: 'evm'
    expect(result).not.toBeNull();
    expect(result!.claimMessage.blockchain).toBe('evm');
  });
});

// ---------------------------------------------------------------------------
// AC3: Self-Describing Claim Format Includes Blockchain Discriminator
// ---------------------------------------------------------------------------

describe('Story 32.4 - AC3: Self-describing claim format includes blockchain discriminator', () => {
  it('[P0] [T-32.4-03] should include blockchain, chainId, tokenNetworkAddress, tokenAddress in EVM claim', async () => {
    // Given: a generated claim for an EVM peer
    const mockLogger = createMockLogger();
    const mockSDK = createMockSDK();
    const mockDb = createMockDb();
    const mockChannelManager = createMockChannelManager({
      [`${TEST_PEER_ID}:M2M`]: {
        channelId: TEST_CHANNEL_ID,
        tokenAddress: TEST_TOKEN_ADDRESS,
      },
    });

    const evmProvider = new EVMPaymentChannelProvider(
      mockSDK as unknown as PaymentChannelSDK,
      TEST_CHAIN_ID_STRING,
      TEST_TOKEN_ADDRESS,
      mockLogger
    );

    const mockRegistry = {
      getProviderForPeer: jest.fn().mockReturnValue(evmProvider),
    } as unknown as ChainProviderRegistry;

    const service = new PerPacketClaimService(
      mockRegistry as unknown as ChainProviderRegistry,
      mockChannelManager as unknown as ChannelManager,
      mockDb as unknown as Database,
      mockLogger,
      TEST_NODE_ID
    );

    const result = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);

    // When: the claim is serialized to JSON
    const serialized = JSON.parse(result!.protocolData.data.toString('utf8'));

    // Then: it contains a 'blockchain' field with value 'evm'
    expect(serialized.blockchain).toBe('evm');

    // And: it contains chainId, tokenNetworkAddress, tokenAddress fields
    expect(serialized.chainId).toBe(TEST_CHAIN_ID_NUMERIC);
    expect(serialized.tokenNetworkAddress).toBe(TEST_TOKEN_NETWORK_ADDRESS);
    expect(serialized.tokenAddress).toBe(TEST_TOKEN_ADDRESS);
  });
});

// ---------------------------------------------------------------------------
// AC4: Backward Compatibility with Existing Claim Generation
// ---------------------------------------------------------------------------

describe('Story 32.4 - AC4: Backward compatibility with existing claim generation', () => {
  it('[P0] [T-32.4-05] should preserve nonce increment and cumulative amount accumulation', async () => {
    // Given: a PerPacketClaimService with registry-based construction
    const mockLogger = createMockLogger();
    const mockSDK = createMockSDK();
    const mockDb = createMockDb();
    const mockChannelManager = createMockChannelManager({
      [`${TEST_PEER_ID}:M2M`]: {
        channelId: TEST_CHANNEL_ID,
        tokenAddress: TEST_TOKEN_ADDRESS,
      },
    });

    const evmProvider = new EVMPaymentChannelProvider(
      mockSDK as unknown as PaymentChannelSDK,
      TEST_CHAIN_ID_STRING,
      TEST_TOKEN_ADDRESS,
      mockLogger
    );

    const mockRegistry = {
      getProviderForPeer: jest.fn().mockReturnValue(evmProvider),
    } as unknown as ChainProviderRegistry;

    const service = new PerPacketClaimService(
      mockRegistry as unknown as ChainProviderRegistry,
      mockChannelManager as unknown as ChannelManager,
      mockDb as unknown as Database,
      mockLogger,
      TEST_NODE_ID
    );

    // When: three sequential packets are sent
    const result1 = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 100n);
    const result2 = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 200n);
    const result3 = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 300n);

    // Then: nonces increment
    expect((result1!.claimMessage as EVMClaimMessage).nonce).toBe(1);
    expect((result2!.claimMessage as EVMClaimMessage).nonce).toBe(2);
    expect((result3!.claimMessage as EVMClaimMessage).nonce).toBe(3);

    // And: cumulative amounts accumulate
    expect((result1!.claimMessage as EVMClaimMessage).transferredAmount).toBe('100');
    expect((result2!.claimMessage as EVMClaimMessage).transferredAmount).toBe('300');
    expect((result3!.claimMessage as EVMClaimMessage).transferredAmount).toBe('600');
  });

  it('[P0] should produce identical EVM claim structure with version, protocol, and required fields', async () => {
    // Given: registry-based service
    const mockLogger = createMockLogger();
    const mockSDK = createMockSDK();
    const mockDb = createMockDb();
    const mockChannelManager = createMockChannelManager({
      [`${TEST_PEER_ID}:M2M`]: {
        channelId: TEST_CHANNEL_ID,
        tokenAddress: TEST_TOKEN_ADDRESS,
      },
    });

    const evmProvider = new EVMPaymentChannelProvider(
      mockSDK as unknown as PaymentChannelSDK,
      TEST_CHAIN_ID_STRING,
      TEST_TOKEN_ADDRESS,
      mockLogger
    );

    const mockRegistry = {
      getProviderForPeer: jest.fn().mockReturnValue(evmProvider),
    } as unknown as ChainProviderRegistry;

    const service = new PerPacketClaimService(
      mockRegistry as unknown as ChainProviderRegistry,
      mockChannelManager as unknown as ChannelManager,
      mockDb as unknown as Database,
      mockLogger,
      TEST_NODE_ID
    );

    const result = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);

    // Then: claim structure is backward compatible
    expect(result).not.toBeNull();
    expect(result!.protocolData.protocolName).toBe(BTP_CLAIM_PROTOCOL.NAME);
    expect(result!.protocolData.contentType).toBe(BTP_CLAIM_PROTOCOL.CONTENT_TYPE);

    const claim = result!.claimMessage;
    expect(claim.version).toBe('1.0');
    expect(claim.blockchain).toBe('evm');
    const evmClaim = claim as EVMClaimMessage;
    expect(evmClaim.channelId).toBe(TEST_CHANNEL_ID);
    expect(evmClaim.nonce).toBe(1);
    expect(evmClaim.transferredAmount).toBe('1000');
    expect(evmClaim.lockedAmount).toBe('0');
    expect(evmClaim.signature).toBe('0xmocksignature');
    expect(evmClaim.senderId).toBe(TEST_NODE_ID);
    expect(evmClaim.tokenAddress).toBe(TEST_TOKEN_ADDRESS);
  });

  it('[P1] [T-32.4-08] should reset channel state (type-agnostic behavior preserved)', async () => {
    // Given: a service with a generated claim
    const mockLogger = createMockLogger();
    const mockSDK = createMockSDK();
    const mockDb = createMockDb();
    const mockChannelManager = createMockChannelManager({
      [`${TEST_PEER_ID}:M2M`]: {
        channelId: TEST_CHANNEL_ID,
        tokenAddress: TEST_TOKEN_ADDRESS,
      },
    });

    const evmProvider = new EVMPaymentChannelProvider(
      mockSDK as unknown as PaymentChannelSDK,
      TEST_CHAIN_ID_STRING,
      TEST_TOKEN_ADDRESS,
      mockLogger
    );

    const mockRegistry = {
      getProviderForPeer: jest.fn().mockReturnValue(evmProvider),
    } as unknown as ChainProviderRegistry;

    const service = new PerPacketClaimService(
      mockRegistry as unknown as ChainProviderRegistry,
      mockChannelManager as unknown as ChannelManager,
      mockDb as unknown as Database,
      mockLogger,
      TEST_NODE_ID
    );

    await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);
    expect(service.getLatestClaim(TEST_CHANNEL_ID)).not.toBeNull();

    // When: resetChannel is called
    service.resetChannel(TEST_CHANNEL_ID);

    // Then: latest claim is cleared
    expect(service.getLatestClaim(TEST_CHANNEL_ID)).toBeNull();

    // And: next claim starts fresh
    const result = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 50n);
    expect((result!.claimMessage as EVMClaimMessage).nonce).toBe(1);
    expect((result!.claimMessage as EVMClaimMessage).transferredAmount).toBe('50');
  });
});

// ---------------------------------------------------------------------------
// AC5: No Provider Found for Peer Results in Null Return
// ---------------------------------------------------------------------------

describe('Story 32.4 - AC5: No provider found for peer results in null return', () => {
  it("[P0] [T-32.4-04] should return null when no provider is registered for the peer's chain", async () => {
    // Given: a peer "unknown-peer" with no configured chain provider
    const mockLogger = createMockLogger();
    const mockDb = createMockDb();

    // Channel exists but no provider for its chain
    const mockChannelManager = createMockChannelManager({
      ['unknown-peer:M2M']: {
        channelId: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        tokenAddress: TEST_TOKEN_ADDRESS,
      },
    });

    const mockRegistry = {
      getProviderForPeer: jest.fn().mockReturnValue(undefined),
    } as unknown as ChainProviderRegistry;

    const service = new PerPacketClaimService(
      mockRegistry as unknown as ChainProviderRegistry,
      mockChannelManager as unknown as ChannelManager,
      mockDb as unknown as Database,
      mockLogger,
      TEST_NODE_ID
    );

    // When: generateClaimForPacket is called for the unknown peer
    const result = await service.generateClaimForPacket('unknown-peer', 'M2M', 1000n);

    // Then: null is returned
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Additional Coverage: EVMPaymentChannelProvider.getSigningContext()
// ---------------------------------------------------------------------------

describe('Story 32.4 - EVMPaymentChannelProvider.getSigningContext()', () => {
  it('[P0] [T-32.4-11] should return chainId, tokenNetworkAddress, signerAddress from SDK', async () => {
    // Given: an EVMPaymentChannelProvider with a mocked SDK
    const mockLogger = createMockLogger();
    const mockSDK = createMockSDK();

    const provider = new EVMPaymentChannelProvider(
      mockSDK as unknown as PaymentChannelSDK,
      TEST_CHAIN_ID_STRING,
      TEST_TOKEN_ADDRESS,
      mockLogger
    );

    // When: getSigningContext() is called
    const context = await (
      provider as unknown as { getSigningContext: () => Promise<Record<string, string>> }
    ).getSigningContext();

    // Then: it returns SDK values
    expect(context).toEqual({
      chainId: TEST_CHAIN_ID_NUMERIC,
      tokenNetworkAddress: TEST_TOKEN_NETWORK_ADDRESS,
      signerAddress: TEST_SIGNER_ADDRESS,
    });

    // And: SDK methods were called
    expect(mockSDK.getChainId).toHaveBeenCalled();
    expect(mockSDK.getTokenNetworkAddress).toHaveBeenCalledWith(TEST_TOKEN_ADDRESS);
    expect(mockSDK.getSignerAddress).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Additional Coverage: recoverFromDb multi-chain
// ---------------------------------------------------------------------------

describe('Story 32.4 - recoverFromDb multi-chain support', () => {
  it('[P1] [T-32.4-07] should recover claims without blockchain=evm filter', () => {
    // Given: database contains claims from multiple blockchain types
    const mockLogger = createMockLogger();
    const mockSDK = createMockSDK();

    const evmClaim = {
      channelId: TEST_CHANNEL_ID,
      nonce: 5,
      transferredAmount: '5000',
      blockchain: 'evm',
      version: '1.0',
      messageId: 'test-msg-1',
      timestamp: new Date().toISOString(),
      senderId: TEST_NODE_ID,
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xsig',
      signerAddress: TEST_SIGNER_ADDRESS,
    };

    const existingClaims = [{ claim_data: JSON.stringify(evmClaim) }];
    const recoveryDb = createMockDb(existingClaims);

    const mockChannelManager = createMockChannelManager();
    const evmProvider = new EVMPaymentChannelProvider(
      mockSDK as unknown as PaymentChannelSDK,
      TEST_CHAIN_ID_STRING,
      TEST_TOKEN_ADDRESS,
      mockLogger
    );

    const mockRegistry = {
      getProviderForPeer: jest.fn().mockReturnValue(evmProvider),
    } as unknown as ChainProviderRegistry;

    // When: PerPacketClaimService is constructed (triggers recoverFromDb)
    const service = new PerPacketClaimService(
      mockRegistry as unknown as ChainProviderRegistry,
      mockChannelManager as unknown as ChannelManager,
      recoveryDb as unknown as Database,
      mockLogger,
      TEST_NODE_ID
    );

    // Then: the SQL query should NOT include WHERE blockchain = 'evm'
    const prepareCall = recoveryDb.prepare.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('SELECT claim_data')
    );
    expect(prepareCall).toBeDefined();
    const sqlQuery = prepareCall![0] as string;
    expect(sqlQuery).not.toContain("blockchain = 'evm'");

    // And: EVM claim is recovered correctly
    const latest = service.getLatestClaim(TEST_CHANNEL_ID);
    expect(latest).not.toBeNull();
    expect((latest as EVMClaimMessage).nonce).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Additional Coverage: Error Handling
// ---------------------------------------------------------------------------

describe('Story 32.4 - Error handling', () => {
  it('[P1] [T-32.4-09] should return null when buildChannelContext fails', async () => {
    // Given: a provider whose getSigningContext throws
    const mockLogger = createMockLogger();
    const mockSDK = createMockSDK();
    mockSDK.getChainId.mockRejectedValueOnce(new Error('RPC failure'));

    const mockDb = createMockDb();
    const mockChannelManager = createMockChannelManager({
      [`${TEST_PEER_ID}:M2M`]: {
        channelId: TEST_CHANNEL_ID,
        tokenAddress: TEST_TOKEN_ADDRESS,
      },
    });

    const evmProvider = new EVMPaymentChannelProvider(
      mockSDK as unknown as PaymentChannelSDK,
      TEST_CHAIN_ID_STRING,
      TEST_TOKEN_ADDRESS,
      mockLogger
    );

    const mockRegistry = {
      getProviderForPeer: jest.fn().mockReturnValue(evmProvider),
    } as unknown as ChainProviderRegistry;

    const service = new PerPacketClaimService(
      mockRegistry as unknown as ChainProviderRegistry,
      mockChannelManager as unknown as ChannelManager,
      mockDb as unknown as Database,
      mockLogger,
      TEST_NODE_ID
    );

    // When: context building fails
    const result = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);

    // Then: null is returned
    expect(result).toBeNull();
  });

  it('[P1] [T-32.4-10] should propagate signBalanceProof errors from provider', async () => {
    // Given: a provider whose signBalanceProof throws
    const mockLogger = createMockLogger();
    const mockSDK = createMockSDK();
    const mockDb = createMockDb();
    const mockChannelManager = createMockChannelManager({
      [`${TEST_PEER_ID}:M2M`]: {
        channelId: TEST_CHANNEL_ID,
        tokenAddress: TEST_TOKEN_ADDRESS,
      },
    });

    const evmProvider = new EVMPaymentChannelProvider(
      mockSDK as unknown as PaymentChannelSDK,
      TEST_CHAIN_ID_STRING,
      TEST_TOKEN_ADDRESS,
      mockLogger
    );

    const mockRegistry = {
      getProviderForPeer: jest.fn().mockReturnValue(evmProvider),
    } as unknown as ChainProviderRegistry;

    const service = new PerPacketClaimService(
      mockRegistry as unknown as ChainProviderRegistry,
      mockChannelManager as unknown as ChannelManager,
      mockDb as unknown as Database,
      mockLogger,
      TEST_NODE_ID
    );

    // First call succeeds to build context
    await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 100n);

    // Then mock signBalanceProof to fail
    mockSDK.signBalanceProof.mockRejectedValueOnce(new Error('Signing failed'));

    // When: second call triggers signing failure
    // Then: error propagates
    await expect(service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 200n)).rejects.toThrow(
      'Signing failed'
    );
  });
});

// ---------------------------------------------------------------------------
// Widened Return Types
// ---------------------------------------------------------------------------

describe('Story 32.4 - Widened return types for multi-chain', () => {
  it('[P0] should return BTPClaimMessage type from getLatestClaim (not EVMClaimMessage)', async () => {
    // Given: a service with a generated claim
    const mockLogger = createMockLogger();
    const mockSDK = createMockSDK();
    const mockDb = createMockDb();
    const mockChannelManager = createMockChannelManager({
      [`${TEST_PEER_ID}:M2M`]: {
        channelId: TEST_CHANNEL_ID,
        tokenAddress: TEST_TOKEN_ADDRESS,
      },
    });

    const evmProvider = new EVMPaymentChannelProvider(
      mockSDK as unknown as PaymentChannelSDK,
      TEST_CHAIN_ID_STRING,
      TEST_TOKEN_ADDRESS,
      mockLogger
    );

    const mockRegistry = {
      getProviderForPeer: jest.fn().mockReturnValue(evmProvider),
    } as unknown as ChainProviderRegistry;

    const service = new PerPacketClaimService(
      mockRegistry as unknown as ChainProviderRegistry,
      mockChannelManager as unknown as ChannelManager,
      mockDb as unknown as Database,
      mockLogger,
      TEST_NODE_ID
    );

    await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);

    // When: getLatestClaim is called
    const latest: BTPClaimMessage | null = service.getLatestClaim(TEST_CHANNEL_ID);

    // Then: it returns a BTPClaimMessage (widened from EVMClaimMessage)
    expect(latest).not.toBeNull();

    // And: isEVMClaim type guard works
    if (latest && isEVMClaim(latest)) {
      expect(latest.channelId).toBe(TEST_CHANNEL_ID);
      expect(latest.blockchain).toBe('evm');
    }
  });

  it('[P0] should use BTPClaimMessage type for PerPacketClaimResult.claimMessage', async () => {
    // Given: a service with registry-based construction
    const mockLogger = createMockLogger();
    const mockSDK = createMockSDK();
    const mockDb = createMockDb();
    const mockChannelManager = createMockChannelManager({
      [`${TEST_PEER_ID}:M2M`]: {
        channelId: TEST_CHANNEL_ID,
        tokenAddress: TEST_TOKEN_ADDRESS,
      },
    });

    const evmProvider = new EVMPaymentChannelProvider(
      mockSDK as unknown as PaymentChannelSDK,
      TEST_CHAIN_ID_STRING,
      TEST_TOKEN_ADDRESS,
      mockLogger
    );

    const mockRegistry = {
      getProviderForPeer: jest.fn().mockReturnValue(evmProvider),
    } as unknown as ChainProviderRegistry;

    const service = new PerPacketClaimService(
      mockRegistry as unknown as ChainProviderRegistry,
      mockChannelManager as unknown as ChannelManager,
      mockDb as unknown as Database,
      mockLogger,
      TEST_NODE_ID
    );

    // When: generateClaimForPacket is called
    const result = await service.generateClaimForPacket(TEST_PEER_ID, 'M2M', 1000n);

    // Then: claimMessage field should be typed as BTPClaimMessage
    // This is a compile-time check: the assignment below should work without casting
    const claimAsBase: BTPClaimMessage = result!.claimMessage;
    expect(claimAsBase.blockchain).toBe('evm');
  });
});
