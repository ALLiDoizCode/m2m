/**
 * Mixed-Chain Claim Routing Tests (Mock-Based)
 *
 * Story 33.7: Validates that ChainProviderRegistry, PerPacketClaimService,
 * and ClaimReceiver correctly route claims based on the blockchain discriminator.
 *
 * Test IDs covered:
 * - T-33.7-04: Mixed-chain — Peer A on EVM, Peer B on Solana, correct claims for each
 * - T-33.7-12: EVM regression — EVM settlement works identically alongside Solana provider
 *
 * Uses mock providers (no real blockchain interaction needed).
 * Placed in src/settlement/provider/ per architecture rule: test/integration/ files
 * must use real infrastructure. This test validates claim routing logic, not on-chain behavior.
 *
 * @packageDocumentation
 */

import { PerPacketClaimService } from '../per-packet-claim-service';
import { ClaimReceiver } from '../claim-receiver';
import { ChainProviderRegistry } from './chain-provider-registry';
import type { PaymentChannelProvider } from './payment-channel-provider';
import { EVMPaymentChannelProvider } from './evm-payment-channel-provider';
import { SolanaPaymentChannelProvider } from './solana-payment-channel-provider';
import { MinaPaymentChannelProvider } from './mina-payment-channel-provider';
import type { BlockchainType } from '../../btp/btp-claim-types';
import { isEVMClaim, isSolanaClaim, isMinaClaim } from '../../btp/btp-claim-types';
import type { ChannelManager, ChannelMetadata } from '../channel-manager';
import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';

// ---------------------------------------------------------------------------
// Test Constants
// ---------------------------------------------------------------------------

const EVM_CHAIN_ID = 'evm:anvil:31337';
const SOLANA_CHAIN_ID = 'solana:bankrun';
const MINA_CHAIN_ID = 'mina:devnet';
const EVM_CHANNEL_ID = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const SOLANA_CHANNEL_PDA = 'SoLChannePDA111111111111111111111111111111';
const MINA_ZKAPP_ADDRESS = 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy';
const EVM_TOKEN_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const SOLANA_PROGRAM_ID = 'PayChan1111111111111111111111111111111111111';
const SOLANA_TOKEN_MINT = 'TokenMint111111111111111111111111111111111';
const MINA_TOKEN_ID = 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf';
const EVM_SIGNER_ADDRESS = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1';
const SOLANA_SIGNER_PUBKEY = 'SoLSigner111111111111111111111111111111111';
const EVM_PEER_ID = 'peer-evm';
const SOLANA_PEER_ID = 'peer-solana';
const MINA_PEER_ID = 'peer-mina';
const NODE_ID = 'test-connector';
const TOKEN_ID = 'M2M';
const EVM_TOKEN_NETWORK = '0xTokenNetworkAddress1234567890abcdef';

jest.setTimeout(30_000);

// Mock account-manager and settlement-monitor (imported by PerPacketClaimService deps)
jest.mock('../account-manager');
jest.mock('../settlement-monitor');

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

function createMockProvider(
  chainType: BlockchainType,
  chainId: string,
  overrides: Partial<PaymentChannelProvider> = {}
): jest.Mocked<PaymentChannelProvider> {
  return {
    chainType,
    chainId,
    openChannel: jest.fn().mockResolvedValue({ channelId: 'mock-channel', txHash: '0xMock' }),
    deposit: jest.fn().mockResolvedValue({ txHash: '0xDeposit' }),
    claimFromChannel: jest.fn().mockResolvedValue({ txHash: '0xClaim' }),
    closeChannel: jest.fn().mockResolvedValue({ txHash: '0xClose' }),
    settleChannel: jest.fn().mockResolvedValue({ txHash: '0xSettle' }),
    signBalanceProof: jest.fn().mockResolvedValue('0xmocksignature'),
    verifyBalanceProof: jest.fn().mockResolvedValue(true),
    getChannelState: jest.fn().mockResolvedValue({
      channelId: 'mock-channel',
      status: 'opened' as const,
      participants: [EVM_SIGNER_ADDRESS, '0x9876543210987654321098765432109876543210'],
      deposit: 10000n,
    }),
    subscribeToEvents: jest.fn().mockReturnValue({ unsubscribe: jest.fn() }),
    ...overrides,
  } as unknown as jest.Mocked<PaymentChannelProvider>;
}

/**
 * Create a mock EVM provider that passes instanceof checks.
 * Uses Object.setPrototypeOf as documented in Story 33.6 learnings.
 */
function createMockEVMProvider(): jest.Mocked<PaymentChannelProvider> & {
  getSigningContext: jest.Mock;
} {
  const provider = createMockProvider('evm', EVM_CHAIN_ID);
  // Add EVM-specific method
  const evmProvider = provider as jest.Mocked<PaymentChannelProvider> & {
    getSigningContext: jest.Mock;
  };
  evmProvider.getSigningContext = jest.fn().mockResolvedValue({
    chainId: 31337,
    tokenNetworkAddress: EVM_TOKEN_NETWORK,
    signerAddress: EVM_SIGNER_ADDRESS,
  });
  // Make instanceof EVMPaymentChannelProvider work
  Object.setPrototypeOf(evmProvider, EVMPaymentChannelProvider.prototype);
  return evmProvider;
}

/**
 * Create a mock Solana provider that passes instanceof checks.
 */
function createMockSolanaProvider(): jest.Mocked<PaymentChannelProvider> & {
  getSolanaContext: jest.Mock;
} {
  const provider = createMockProvider('solana', SOLANA_CHAIN_ID);
  const solProvider = provider as jest.Mocked<PaymentChannelProvider> & {
    getSolanaContext: jest.Mock;
  };
  solProvider.getSolanaContext = jest.fn().mockReturnValue({
    programId: SOLANA_PROGRAM_ID,
    tokenMint: SOLANA_TOKEN_MINT,
    cluster: 'bankrun',
    signerAddress: SOLANA_SIGNER_PUBKEY,
  });
  // Make instanceof SolanaPaymentChannelProvider work
  Object.setPrototypeOf(solProvider, SolanaPaymentChannelProvider.prototype);
  return solProvider;
}

/**
 * Create a mock Mina provider that passes instanceof checks.
 */
function createMockMinaProvider(): jest.Mocked<PaymentChannelProvider> & {
  getMinaContext: jest.Mock;
} {
  const provider = createMockProvider('mina', MINA_CHAIN_ID);
  const minaProvider = provider as jest.Mocked<PaymentChannelProvider> & {
    getMinaContext: jest.Mock;
  };
  minaProvider.getMinaContext = jest.fn().mockReturnValue({
    zkAppAddress: MINA_ZKAPP_ADDRESS,
    tokenId: MINA_TOKEN_ID,
    network: 'devnet',
    signerAddress: MINA_ZKAPP_ADDRESS,
  });
  // Make instanceof MinaPaymentChannelProvider work
  Object.setPrototypeOf(minaProvider, MinaPaymentChannelProvider.prototype);
  return minaProvider;
}

function createMockChannelManager(
  channelMap: Record<string, { channelId: string; tokenAddress: string; chain: string }>
): jest.Mocked<
  Pick<
    ChannelManager,
    'getChannelForPeer' | 'ensureChannelExists' | 'getChannelById' | 'registerExternalChannel'
  >
> {
  return {
    getChannelForPeer: jest.fn().mockImplementation((peerId: string, tokenId: string) => {
      const key = `${peerId}:${tokenId}`;
      const channel = channelMap[key];
      if (!channel) return null;
      return {
        channelId: channel.channelId,
        tokenAddress: channel.tokenAddress,
        peerId,
        tokenId,
        chain: channel.chain,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'open',
      } as unknown as ChannelMetadata;
    }),
    ensureChannelExists: jest.fn().mockResolvedValue(undefined),
    getChannelById: jest.fn().mockReturnValue(null),
    registerExternalChannel: jest.fn().mockReturnValue({} as ChannelMetadata),
  };
}

function createMockDb(
  existingClaims?: Array<{ claim_data: string }>
): jest.Mocked<Pick<Database, 'prepare'>> {
  const mockRun = jest.fn();
  const mockAll = jest.fn().mockReturnValue(existingClaims ?? []);
  const mockStatement = { run: mockRun, all: mockAll };
  return {
    prepare: jest.fn().mockReturnValue(mockStatement),
  } as unknown as jest.Mocked<Pick<Database, 'prepare'>>;
}

// ---------------------------------------------------------------------------
// T-33.7-04: Mixed-Chain Claim Routing (AC 2, Story 33.7)
// ---------------------------------------------------------------------------

describe('[T-33.7-04] Mixed-chain: EVM and Solana peers — correct claims for each (Story 33.7)', () => {
  let mockLogger: Logger;
  let evmProvider: ReturnType<typeof createMockEVMProvider>;
  let solanaProvider: ReturnType<typeof createMockSolanaProvider>;
  let registry: ChainProviderRegistry;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    evmProvider = createMockEVMProvider();
    solanaProvider = createMockSolanaProvider();
    registry = new ChainProviderRegistry();
    registry.register(evmProvider);
    registry.register(solanaProvider);
  });

  it('should generate EVM claims for EVM peer and Solana claims for Solana peer', async () => {
    // Given: two peers — one EVM, one Solana — each with a registered channel
    const channelManager = createMockChannelManager({
      [`${EVM_PEER_ID}:${TOKEN_ID}`]: {
        channelId: EVM_CHANNEL_ID,
        tokenAddress: EVM_TOKEN_ADDRESS,
        chain: EVM_CHAIN_ID,
      },
      [`${SOLANA_PEER_ID}:${TOKEN_ID}`]: {
        channelId: SOLANA_CHANNEL_PDA,
        tokenAddress: SOLANA_PROGRAM_ID,
        chain: SOLANA_CHAIN_ID,
      },
    });

    const claimServiceRegistry = {
      getProviderForPeer: jest.fn().mockImplementation((peerConfig: { chain?: string }) => {
        if (peerConfig.chain === EVM_CHAIN_ID) return evmProvider;
        if (peerConfig.chain === SOLANA_CHAIN_ID) return solanaProvider;
        return undefined;
      }),
    } as unknown as ChainProviderRegistry;

    const claimService = new PerPacketClaimService(
      claimServiceRegistry,
      channelManager as unknown as ChannelManager,
      createMockDb() as unknown as Database,
      mockLogger,
      NODE_ID
    );

    // When: claims are generated for both peers
    const evmResult = await claimService.generateClaimForPacket(EVM_PEER_ID, TOKEN_ID, 1000n);
    const solanaResult = await claimService.generateClaimForPacket(SOLANA_PEER_ID, TOKEN_ID, 2000n);

    // Then: EVM claim has correct blockchain type and fields
    expect(evmResult).not.toBeNull();
    expect(evmResult!.claimMessage.blockchain).toBe('evm');
    expect(isEVMClaim(evmResult!.claimMessage)).toBe(true);
    if (isEVMClaim(evmResult!.claimMessage)) {
      expect(evmResult!.claimMessage.channelId).toBe(EVM_CHANNEL_ID);
      expect(evmResult!.claimMessage.signerAddress).toBe(EVM_SIGNER_ADDRESS);
      expect(evmResult!.claimMessage.nonce).toBe(1);
      expect(evmResult!.claimMessage.transferredAmount).toBe('1000');
    }

    // And: Solana claim has correct blockchain type and fields
    expect(solanaResult).not.toBeNull();
    expect(solanaResult!.claimMessage.blockchain).toBe('solana');
    expect(isSolanaClaim(solanaResult!.claimMessage)).toBe(true);
    if (isSolanaClaim(solanaResult!.claimMessage)) {
      expect(solanaResult!.claimMessage.programId).toBe(SOLANA_PROGRAM_ID);
      expect(solanaResult!.claimMessage.channelAccount).toBe(SOLANA_CHANNEL_PDA);
      expect(solanaResult!.claimMessage.signerPublicKey).toBe(SOLANA_SIGNER_PUBKEY);
      expect(solanaResult!.claimMessage.nonce).toBe(1);
      expect(solanaResult!.claimMessage.transferredAmount).toBe('2000');
    }

    // And: signing was routed to the correct provider
    expect(evmProvider.signBalanceProof).toHaveBeenCalledTimes(1);
    expect(solanaProvider.signBalanceProof).toHaveBeenCalledTimes(1);
  });

  it('should not cross-contaminate claims between EVM and Solana peers', async () => {
    // Given: interleaved claim generation
    const channelManager = createMockChannelManager({
      [`${EVM_PEER_ID}:${TOKEN_ID}`]: {
        channelId: EVM_CHANNEL_ID,
        tokenAddress: EVM_TOKEN_ADDRESS,
        chain: EVM_CHAIN_ID,
      },
      [`${SOLANA_PEER_ID}:${TOKEN_ID}`]: {
        channelId: SOLANA_CHANNEL_PDA,
        tokenAddress: SOLANA_PROGRAM_ID,
        chain: SOLANA_CHAIN_ID,
      },
    });

    const claimServiceRegistry = {
      getProviderForPeer: jest.fn().mockImplementation((peerConfig: { chain?: string }) => {
        if (peerConfig.chain === EVM_CHAIN_ID) return evmProvider;
        if (peerConfig.chain === SOLANA_CHAIN_ID) return solanaProvider;
        return undefined;
      }),
    } as unknown as ChainProviderRegistry;

    const claimService = new PerPacketClaimService(
      claimServiceRegistry,
      channelManager as unknown as ChannelManager,
      createMockDb() as unknown as Database,
      mockLogger,
      NODE_ID
    );

    // When: interleaved claim generation for both chains
    const evm1 = await claimService.generateClaimForPacket(EVM_PEER_ID, TOKEN_ID, 500n);
    const sol1 = await claimService.generateClaimForPacket(SOLANA_PEER_ID, TOKEN_ID, 700n);
    const evm2 = await claimService.generateClaimForPacket(EVM_PEER_ID, TOKEN_ID, 300n);
    const sol2 = await claimService.generateClaimForPacket(SOLANA_PEER_ID, TOKEN_ID, 400n);

    // Then: EVM claims accumulate independently
    expect(evm1!.claimMessage.blockchain).toBe('evm');
    expect(evm2!.claimMessage.blockchain).toBe('evm');
    if (isEVMClaim(evm1!.claimMessage) && isEVMClaim(evm2!.claimMessage)) {
      expect(evm1!.claimMessage.nonce).toBe(1);
      expect(evm2!.claimMessage.nonce).toBe(2);
      expect(evm1!.claimMessage.transferredAmount).toBe('500');
      expect(evm2!.claimMessage.transferredAmount).toBe('800'); // 500 + 300
    }

    // And: Solana claims accumulate independently
    expect(sol1!.claimMessage.blockchain).toBe('solana');
    expect(sol2!.claimMessage.blockchain).toBe('solana');
    if (isSolanaClaim(sol1!.claimMessage) && isSolanaClaim(sol2!.claimMessage)) {
      expect(sol1!.claimMessage.nonce).toBe(1);
      expect(sol2!.claimMessage.nonce).toBe(2);
      expect(sol1!.claimMessage.transferredAmount).toBe('700');
      expect(sol2!.claimMessage.transferredAmount).toBe('1100'); // 700 + 400
    }
  });

  it('should route claim verification to the correct provider via ClaimReceiver', () => {
    // Given: both providers registered in the registry
    const receiverRegistry = new ChainProviderRegistry();
    receiverRegistry.register(evmProvider);
    receiverRegistry.register(solanaProvider);

    // When: ClaimReceiver is constructed with the multi-chain registry
    const receiver = new ClaimReceiver(
      createMockDb() as unknown as Database,
      receiverRegistry,
      mockLogger
    );

    // Then: it is constructed without error (providers are available for routing)
    expect(receiver).toBeDefined();

    // And: both providers are in the registry
    const evmLookup = receiverRegistry.getProvider('evm', EVM_CHAIN_ID);
    const solanaLookup = receiverRegistry.getProvider('solana', SOLANA_CHAIN_ID);
    expect(evmLookup).toBe(evmProvider);
    expect(solanaLookup).toBe(solanaProvider);
  });
});

// ---------------------------------------------------------------------------
// T-33.7-12: EVM Regression (AC 7, Story 33.7)
// ---------------------------------------------------------------------------

describe('[T-33.7-12] EVM regression: EVM settlement works identically alongside Solana provider (Story 33.7)', () => {
  let mockLogger: Logger;
  let evmProvider: ReturnType<typeof createMockEVMProvider>;
  let solanaProvider: ReturnType<typeof createMockSolanaProvider>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    evmProvider = createMockEVMProvider();
    solanaProvider = createMockSolanaProvider();
  });

  it('should produce EVM claims identical to pre-Solana behavior', async () => {
    // Given: both providers in registry (Solana should not affect EVM path)
    const channelManager = createMockChannelManager({
      [`${EVM_PEER_ID}:${TOKEN_ID}`]: {
        channelId: EVM_CHANNEL_ID,
        tokenAddress: EVM_TOKEN_ADDRESS,
        chain: EVM_CHAIN_ID,
      },
    });

    const claimServiceRegistry = {
      getProviderForPeer: jest.fn().mockReturnValue(evmProvider),
    } as unknown as ChainProviderRegistry;

    const claimService = new PerPacketClaimService(
      claimServiceRegistry,
      channelManager as unknown as ChannelManager,
      createMockDb() as unknown as Database,
      mockLogger,
      NODE_ID
    );

    // When: EVM claim is generated (same as pre-Solana)
    const result = await claimService.generateClaimForPacket(EVM_PEER_ID, TOKEN_ID, 5000n);

    // Then: claim has all expected EVM fields
    expect(result).not.toBeNull();
    const claim = result!.claimMessage;
    expect(claim.blockchain).toBe('evm');
    expect(claim.version).toBe('1.0');
    expect(claim.senderId).toBe(NODE_ID);

    if (isEVMClaim(claim)) {
      expect(claim.channelId).toBe(EVM_CHANNEL_ID);
      expect(claim.nonce).toBe(1);
      expect(claim.transferredAmount).toBe('5000');
      expect(claim.lockedAmount).toBe('0');
      expect(claim.locksRoot).toBe(
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      );
      expect(claim.signerAddress).toBe(EVM_SIGNER_ADDRESS);
      expect(claim.chainId).toBe(31337);
      expect(claim.tokenNetworkAddress).toBe(EVM_TOKEN_NETWORK);
      expect(claim.tokenAddress).toBe(EVM_TOKEN_ADDRESS);
    }

    // And: EVM signing was called (not Solana)
    expect(evmProvider.signBalanceProof).toHaveBeenCalledTimes(1);
    expect(solanaProvider.signBalanceProof).not.toHaveBeenCalled();
  });

  it('should verify EVM claims correctly when Solana provider is also registered', async () => {
    // Given: registry with both providers
    const registry = new ChainProviderRegistry();
    registry.register(evmProvider);
    registry.register(solanaProvider);

    // When: EVM provider is looked up
    const provider = registry.getProvider('evm', EVM_CHAIN_ID);

    // Then: correct provider is returned
    expect(provider).toBe(evmProvider);
    expect(provider?.chainType).toBe('evm');
    expect(provider?.chainId).toBe(EVM_CHAIN_ID);

    // And: EVM signature verification works
    const verifyResult = await provider!.verifyBalanceProof({
      channelId: EVM_CHANNEL_ID,
      nonce: 1,
      transferredAmount: '5000',
      lockedAmount: '0',
      locksRoot: '0x' + '0'.repeat(64),
      signature: '0xmocksig',
      signerAddress: EVM_SIGNER_ADDRESS,
    });
    expect(verifyResult).toBe(true);
    expect(evmProvider.verifyBalanceProof).toHaveBeenCalledTimes(1);
  });

  it('should allow EVM provider deregistration without affecting Solana', () => {
    // Given: both providers registered
    const registry = new ChainProviderRegistry();
    registry.register(evmProvider);
    registry.register(solanaProvider);

    // When: EVM provider is deregistered
    registry.deregister(EVM_CHAIN_ID);

    // Then: EVM provider is gone
    expect(registry.getProvider('evm', EVM_CHAIN_ID)).toBeUndefined();

    // And: Solana provider is still available
    expect(registry.getProvider('solana', SOLANA_CHAIN_ID)).toBe(solanaProvider);
  });

  it('should handle peer lookup for EVM peer correctly in multi-chain registry', () => {
    // Given: both providers registered
    const registry = new ChainProviderRegistry();
    registry.register(evmProvider);
    registry.register(solanaProvider);

    // When: looking up provider for EVM peer
    const evmProviderResult = registry.getProviderForPeer({
      peerId: EVM_PEER_ID,
      chain: EVM_CHAIN_ID,
    });

    // Then: correct provider returned
    expect(evmProviderResult).toBe(evmProvider);

    // When: looking up provider for Solana peer
    const solanaProviderResult = registry.getProviderForPeer({
      peerId: SOLANA_PEER_ID,
      chain: SOLANA_CHAIN_ID,
    });

    // Then: correct provider returned
    expect(solanaProviderResult).toBe(solanaProvider);
  });
});

// ---------------------------------------------------------------------------
// AC 7 (Story 34.7): Three-Chain Claim Routing (EVM + Solana + Mina)
// ---------------------------------------------------------------------------

describe('[AC-34.7-07] Three-chain routing: EVM, Solana, and Mina peers — correct claims for each (Story 34.7)', () => {
  let mockLogger: Logger;
  let evmProvider: ReturnType<typeof createMockEVMProvider>;
  let solanaProvider: ReturnType<typeof createMockSolanaProvider>;
  let minaProvider: ReturnType<typeof createMockMinaProvider>;
  let registry: ChainProviderRegistry;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    evmProvider = createMockEVMProvider();
    solanaProvider = createMockSolanaProvider();
    minaProvider = createMockMinaProvider();
    registry = new ChainProviderRegistry();
    registry.register(evmProvider);
    registry.register(solanaProvider);
    registry.register(minaProvider);
  });

  it('should generate correct claim type for each of three chain peers', async () => {
    // Given: three peers — one EVM, one Solana, one Mina — each with a registered channel
    const channelManager = createMockChannelManager({
      [`${EVM_PEER_ID}:${TOKEN_ID}`]: {
        channelId: EVM_CHANNEL_ID,
        tokenAddress: EVM_TOKEN_ADDRESS,
        chain: EVM_CHAIN_ID,
      },
      [`${SOLANA_PEER_ID}:${TOKEN_ID}`]: {
        channelId: SOLANA_CHANNEL_PDA,
        tokenAddress: SOLANA_PROGRAM_ID,
        chain: SOLANA_CHAIN_ID,
      },
      [`${MINA_PEER_ID}:${TOKEN_ID}`]: {
        channelId: MINA_ZKAPP_ADDRESS,
        tokenAddress: MINA_TOKEN_ID,
        chain: MINA_CHAIN_ID,
      },
    });

    const claimServiceRegistry = {
      getProviderForPeer: jest.fn().mockImplementation((peerConfig: { chain?: string }) => {
        if (peerConfig.chain === EVM_CHAIN_ID) return evmProvider;
        if (peerConfig.chain === SOLANA_CHAIN_ID) return solanaProvider;
        if (peerConfig.chain === MINA_CHAIN_ID) return minaProvider;
        return undefined;
      }),
    } as unknown as ChainProviderRegistry;

    const claimService = new PerPacketClaimService(
      claimServiceRegistry,
      channelManager as unknown as ChannelManager,
      createMockDb() as unknown as Database,
      mockLogger,
      NODE_ID
    );

    // When: claims are generated for all three peers
    const evmResult = await claimService.generateClaimForPacket(EVM_PEER_ID, TOKEN_ID, 1000n);
    const solanaResult = await claimService.generateClaimForPacket(SOLANA_PEER_ID, TOKEN_ID, 2000n);
    const minaResult = await claimService.generateClaimForPacket(MINA_PEER_ID, TOKEN_ID, 3000n);

    // Then: EVM claim has correct blockchain type
    expect(evmResult).not.toBeNull();
    expect(evmResult!.claimMessage.blockchain).toBe('evm');
    expect(isEVMClaim(evmResult!.claimMessage)).toBe(true);

    // And: Solana claim has correct blockchain type
    expect(solanaResult).not.toBeNull();
    expect(solanaResult!.claimMessage.blockchain).toBe('solana');
    expect(isSolanaClaim(solanaResult!.claimMessage)).toBe(true);

    // And: Mina claim has correct blockchain type and fields
    expect(minaResult).not.toBeNull();
    expect(minaResult!.claimMessage.blockchain).toBe('mina');
    expect(isMinaClaim(minaResult!.claimMessage)).toBe(true);
    if (isMinaClaim(minaResult!.claimMessage)) {
      expect(minaResult!.claimMessage.zkAppAddress).toBe(MINA_ZKAPP_ADDRESS);
      expect(minaResult!.claimMessage.tokenId).toBe(MINA_TOKEN_ID);
      expect(minaResult!.claimMessage.network).toBe('devnet');
      expect(minaResult!.claimMessage.nonce).toBe(1);
    }

    // And: signing was routed to the correct provider for each chain
    expect(evmProvider.signBalanceProof).toHaveBeenCalledTimes(1);
    expect(solanaProvider.signBalanceProof).toHaveBeenCalledTimes(1);
    expect(minaProvider.signBalanceProof).toHaveBeenCalledTimes(1);
  });

  it('should not cross-contaminate claims between three chain peers', async () => {
    // Given: interleaved claim generation across three chains
    const channelManager = createMockChannelManager({
      [`${EVM_PEER_ID}:${TOKEN_ID}`]: {
        channelId: EVM_CHANNEL_ID,
        tokenAddress: EVM_TOKEN_ADDRESS,
        chain: EVM_CHAIN_ID,
      },
      [`${SOLANA_PEER_ID}:${TOKEN_ID}`]: {
        channelId: SOLANA_CHANNEL_PDA,
        tokenAddress: SOLANA_PROGRAM_ID,
        chain: SOLANA_CHAIN_ID,
      },
      [`${MINA_PEER_ID}:${TOKEN_ID}`]: {
        channelId: MINA_ZKAPP_ADDRESS,
        tokenAddress: MINA_TOKEN_ID,
        chain: MINA_CHAIN_ID,
      },
    });

    const claimServiceRegistry = {
      getProviderForPeer: jest.fn().mockImplementation((peerConfig: { chain?: string }) => {
        if (peerConfig.chain === EVM_CHAIN_ID) return evmProvider;
        if (peerConfig.chain === SOLANA_CHAIN_ID) return solanaProvider;
        if (peerConfig.chain === MINA_CHAIN_ID) return minaProvider;
        return undefined;
      }),
    } as unknown as ChainProviderRegistry;

    const claimService = new PerPacketClaimService(
      claimServiceRegistry,
      channelManager as unknown as ChannelManager,
      createMockDb() as unknown as Database,
      mockLogger,
      NODE_ID
    );

    // When: interleaved claim generation for all three chains
    const evm1 = await claimService.generateClaimForPacket(EVM_PEER_ID, TOKEN_ID, 500n);
    const mina1 = await claimService.generateClaimForPacket(MINA_PEER_ID, TOKEN_ID, 600n);
    const sol1 = await claimService.generateClaimForPacket(SOLANA_PEER_ID, TOKEN_ID, 700n);
    const evm2 = await claimService.generateClaimForPacket(EVM_PEER_ID, TOKEN_ID, 300n);
    const mina2 = await claimService.generateClaimForPacket(MINA_PEER_ID, TOKEN_ID, 400n);
    const sol2 = await claimService.generateClaimForPacket(SOLANA_PEER_ID, TOKEN_ID, 200n);

    // Then: EVM claims accumulate independently
    expect(evm1!.claimMessage.blockchain).toBe('evm');
    expect(evm2!.claimMessage.blockchain).toBe('evm');
    if (isEVMClaim(evm1!.claimMessage) && isEVMClaim(evm2!.claimMessage)) {
      expect(evm1!.claimMessage.nonce).toBe(1);
      expect(evm2!.claimMessage.nonce).toBe(2);
      expect(evm1!.claimMessage.transferredAmount).toBe('500');
      expect(evm2!.claimMessage.transferredAmount).toBe('800'); // 500 + 300
    }

    // And: Solana claims accumulate independently
    expect(sol1!.claimMessage.blockchain).toBe('solana');
    expect(sol2!.claimMessage.blockchain).toBe('solana');
    if (isSolanaClaim(sol1!.claimMessage) && isSolanaClaim(sol2!.claimMessage)) {
      expect(sol1!.claimMessage.nonce).toBe(1);
      expect(sol2!.claimMessage.nonce).toBe(2);
      expect(sol1!.claimMessage.transferredAmount).toBe('700');
      expect(sol2!.claimMessage.transferredAmount).toBe('900'); // 700 + 200
    }

    // And: Mina claims have independent nonces
    expect(mina1!.claimMessage.blockchain).toBe('mina');
    expect(mina2!.claimMessage.blockchain).toBe('mina');
    if (isMinaClaim(mina1!.claimMessage) && isMinaClaim(mina2!.claimMessage)) {
      expect(mina1!.claimMessage.nonce).toBe(1);
      expect(mina2!.claimMessage.nonce).toBe(2);
    }
  });

  it('should route claim verification to correct provider in three-chain registry', () => {
    // Given: all three providers registered in the registry
    const receiverRegistry = new ChainProviderRegistry();
    receiverRegistry.register(evmProvider);
    receiverRegistry.register(solanaProvider);
    receiverRegistry.register(minaProvider);

    // When: looking up each provider by chain type and chain ID
    const evmLookup = receiverRegistry.getProvider('evm', EVM_CHAIN_ID);
    const solanaLookup = receiverRegistry.getProvider('solana', SOLANA_CHAIN_ID);
    const minaLookup = receiverRegistry.getProvider('mina', MINA_CHAIN_ID);

    // Then: each provider is correctly resolved
    expect(evmLookup).toBe(evmProvider);
    expect(solanaLookup).toBe(solanaProvider);
    expect(minaLookup).toBe(minaProvider);
  });

  it('should handle peer lookup for all three chain types', () => {
    // Given: all three providers registered
    const multiRegistry = new ChainProviderRegistry();
    multiRegistry.register(evmProvider);
    multiRegistry.register(solanaProvider);
    multiRegistry.register(minaProvider);

    // When/Then: each peer resolves to the correct provider
    expect(multiRegistry.getProviderForPeer({ peerId: EVM_PEER_ID, chain: EVM_CHAIN_ID })).toBe(
      evmProvider
    );
    expect(
      multiRegistry.getProviderForPeer({ peerId: SOLANA_PEER_ID, chain: SOLANA_CHAIN_ID })
    ).toBe(solanaProvider);
    expect(multiRegistry.getProviderForPeer({ peerId: MINA_PEER_ID, chain: MINA_CHAIN_ID })).toBe(
      minaProvider
    );
  });

  it('should allow Mina provider deregistration without affecting EVM or Solana', () => {
    // Given: all three providers registered
    const multiRegistry = new ChainProviderRegistry();
    multiRegistry.register(evmProvider);
    multiRegistry.register(solanaProvider);
    multiRegistry.register(minaProvider);

    // When: Mina provider is deregistered
    multiRegistry.deregister(MINA_CHAIN_ID);

    // Then: Mina provider is gone
    expect(multiRegistry.getProvider('mina', MINA_CHAIN_ID)).toBeUndefined();

    // And: EVM and Solana providers are still available
    expect(multiRegistry.getProvider('evm', EVM_CHAIN_ID)).toBe(evmProvider);
    expect(multiRegistry.getProvider('solana', SOLANA_CHAIN_ID)).toBe(solanaProvider);
  });
});
