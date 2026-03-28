/**
 * Mixed-Chain Three-Way Settlement Tests
 *
 * Story 34.8: Validates that EVM, Solana, and Mina providers coexist correctly
 * in a single ChainProviderRegistry, and that claims route to the correct provider
 * based on the blockchain discriminator.
 *
 * Test IDs covered:
 * - T-34.8-06: Three-chain routing (EVM + Solana + Mina claims routed correctly)
 * - T-34.8-12: EVM regression (EVM works alongside Mina provider)
 * - T-34.8-13: Solana regression (Solana works alongside Mina provider)
 *
 * @packageDocumentation
 */

import { ChainProviderRegistry } from '../../src/settlement/provider/chain-provider-registry';
import type { PaymentChannelProvider } from '../../src/settlement/provider/payment-channel-provider';
import type {
  BlockchainType,
  MinaClaimMessage,
  EVMClaimMessage,
  SolanaClaimMessage,
} from '../../src/btp/btp-claim-types';
import {
  isEVMClaim,
  isSolanaClaim,
  isMinaClaim,
  validateClaimMessage,
} from '../../src/btp/btp-claim-types';

jest.setTimeout(60_000);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVM_CHAIN_ID = 'evm:8453';
const SOLANA_CHAIN_ID = 'solana:devnet';
const MINA_CHAIN_ID = 'mina:devnet';

// ---------------------------------------------------------------------------
// Mock Factories
// ---------------------------------------------------------------------------

function createMockProvider(
  chainType: BlockchainType,
  chainId: string
): jest.Mocked<PaymentChannelProvider> {
  return {
    chainType,
    chainId,
    openChannel: jest.fn().mockResolvedValue({ channelId: `ch-${chainType}`, txHash: 'tx1' }),
    deposit: jest.fn().mockResolvedValue({ txHash: 'tx2' }),
    claimFromChannel: jest.fn().mockResolvedValue({ txHash: 'tx3' }),
    closeChannel: jest.fn().mockResolvedValue({ txHash: 'tx4' }),
    settleChannel: jest.fn().mockResolvedValue({ txHash: 'tx5' }),
    signBalanceProof: jest.fn().mockResolvedValue(`sig-${chainType}`),
    verifyBalanceProof: jest.fn().mockResolvedValue(true),
    getChannelState: jest.fn().mockResolvedValue({
      channelId: `ch-${chainType}`,
      status: 'opened' as const,
      participants: ['addr1', 'addr2'],
      deposit: 10000n,
    }),
    subscribeToEvents: jest.fn().mockReturnValue({ unsubscribe: jest.fn() }),
  } as unknown as jest.Mocked<PaymentChannelProvider>;
}

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function createEVMClaimFixture(): EVMClaimMessage {
  return {
    version: '1.0',
    blockchain: 'evm',
    messageId: 'claim-evm-001',
    timestamp: '2026-03-28T12:00:00.000Z',
    senderId: 'peer-evm',
    channelId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    nonce: 1,
    transferredAmount: '5000',
    lockedAmount: '0',
    locksRoot: '0x' + '0'.repeat(64),
    signature: '0x' + 'ab'.repeat(65),
    signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
  };
}

function createSolanaClaimFixture(): SolanaClaimMessage {
  return {
    version: '1.0',
    blockchain: 'solana',
    messageId: 'claim-sol-001',
    timestamp: '2026-03-28T12:00:00.000Z',
    senderId: 'peer-solana',
    programId: 'PayChan1111111111111111111111111111111111111',
    channelAccount: 'SoLChannePDA111111111111111111111111111111',
    nonce: 1,
    transferredAmount: '5000',
    signature: 'c29sYW5hLXNpZw==',
    signerPublicKey: 'SoLSigner111111111111111111111111111111111',
    cluster: 'devnet',
  };
}

function createMinaClaimFixture(): MinaClaimMessage {
  return {
    version: '1.0',
    blockchain: 'mina',
    messageId: 'claim-mina-001',
    timestamp: '2026-03-28T12:00:00.000Z',
    senderId: 'peer-mina',
    zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
    tokenId: 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf',
    balanceCommitment: '12345678901234567890123456789012345678901234567890',
    nonce: 1,
    proof: 'eyJwcm9vZiI6InRlc3QifQ==',
    salt: 'abcdef1234567890',
    network: 'devnet',
  };
}

// ---------------------------------------------------------------------------
// T-34.8-06: Three-Chain Routing (AC 6)
// ---------------------------------------------------------------------------

describe('Mixed-Chain Three-Way Settlement (Story 34.8)', () => {
  let registry: ChainProviderRegistry;
  let evmProvider: jest.Mocked<PaymentChannelProvider>;
  let solanaProvider: jest.Mocked<PaymentChannelProvider>;
  let minaProvider: jest.Mocked<PaymentChannelProvider>;

  beforeEach(() => {
    jest.clearAllMocks();

    registry = new ChainProviderRegistry();
    evmProvider = createMockProvider('evm', EVM_CHAIN_ID);
    solanaProvider = createMockProvider('solana', SOLANA_CHAIN_ID);
    minaProvider = createMockProvider('mina', MINA_CHAIN_ID);

    registry.register(evmProvider);
    registry.register(solanaProvider);
    registry.register(minaProvider);
  });

  describe('[T-34.8-06] Three-chain: EVM + Solana + Mina claims routed correctly', () => {
    it('should register all three providers with distinct chainIds', () => {
      // Then: all three providers are registered
      const allProviders = registry.getAllProviders();
      expect(allProviders).toHaveLength(3);

      expect(registry.getProvider('evm', EVM_CHAIN_ID)).toBe(evmProvider);
      expect(registry.getProvider('solana', SOLANA_CHAIN_ID)).toBe(solanaProvider);
      expect(registry.getProvider('mina', MINA_CHAIN_ID)).toBe(minaProvider);
    });

    it('should route each claim to the correct provider based on blockchain discriminator', () => {
      // Given: three peer configs, each referencing a different chain
      const peers = [
        { peerId: 'peer-evm', chain: EVM_CHAIN_ID },
        { peerId: 'peer-solana', chain: SOLANA_CHAIN_ID },
        { peerId: 'peer-mina', chain: MINA_CHAIN_ID },
      ];

      // When: looking up providers for each peer
      const resolvedProviders = peers.map((peer) => registry.getProviderForPeer(peer));

      // Then: each peer resolves to the correct provider
      expect(resolvedProviders[0]).toBe(evmProvider);
      expect(resolvedProviders[1]).toBe(solanaProvider);
      expect(resolvedProviders[2]).toBe(minaProvider);
    });

    it('should correctly detect claim types using type guards', () => {
      // Given: claims for each blockchain
      const evmClaim = createEVMClaimFixture();
      const solanaClaim = createSolanaClaimFixture();
      const minaClaim = createMinaClaimFixture();

      // Then: type guards correctly identify each claim
      expect(isEVMClaim(evmClaim)).toBe(true);
      expect(isSolanaClaim(evmClaim)).toBe(false);
      expect(isMinaClaim(evmClaim)).toBe(false);

      expect(isEVMClaim(solanaClaim)).toBe(false);
      expect(isSolanaClaim(solanaClaim)).toBe(true);
      expect(isMinaClaim(solanaClaim)).toBe(false);

      expect(isEVMClaim(minaClaim)).toBe(false);
      expect(isSolanaClaim(minaClaim)).toBe(false);
      expect(isMinaClaim(minaClaim)).toBe(true);
    });

    it('should have no cross-contamination between claim types', () => {
      // Given: claims validated by their respective type guards
      const evmClaim = createEVMClaimFixture();
      const solanaClaim = createSolanaClaimFixture();
      const minaClaim = createMinaClaimFixture();

      // When: all claims are validated
      expect(() => validateClaimMessage(evmClaim)).not.toThrow();
      expect(() => validateClaimMessage(solanaClaim)).not.toThrow();
      expect(() => validateClaimMessage(minaClaim)).not.toThrow();

      // Then: blockchain discriminators are correct and distinct
      expect(evmClaim.blockchain).toBe('evm');
      expect(solanaClaim.blockchain).toBe('solana');
      expect(minaClaim.blockchain).toBe('mina');

      // And: chain-specific fields are exclusive to their type
      expect('channelId' in evmClaim).toBe(true);
      expect('channelAccount' in solanaClaim).toBe(true);
      expect('zkAppAddress' in minaClaim).toBe(true);

      // And: no cross-fields
      expect('zkAppAddress' in evmClaim).toBe(false);
      expect('channelId' in solanaClaim).toBe(false);
      expect('programId' in minaClaim).toBe(false);
    });

    it('should allow independent signing and verification per provider', async () => {
      // When: each provider signs a balance proof
      const evmSig = await evmProvider.signBalanceProof({
        channelId: 'ch-evm',
        nonce: 1,
        transferredAmount: '1000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
      });

      const solanaSig = await solanaProvider.signBalanceProof({
        channelId: 'ch-solana',
        nonce: 1,
        transferredAmount: '1000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
      });

      const minaSig = await minaProvider.signBalanceProof({
        channelId: 'ch-mina',
        nonce: 1,
        transferredAmount: '1000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
      });

      // Then: each returns a valid signature string
      expect(evmSig).toBe('sig-evm');
      expect(solanaSig).toBe('sig-solana');
      expect(minaSig).toBe('sig-mina');

      // And: each provider's signBalanceProof was called once
      expect(evmProvider.signBalanceProof).toHaveBeenCalledTimes(1);
      expect(solanaProvider.signBalanceProof).toHaveBeenCalledTimes(1);
      expect(minaProvider.signBalanceProof).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // T-34.8-12: EVM Regression (AC 12)
  // -------------------------------------------------------------------------

  describe('[T-34.8-12] EVM regression: EVM works alongside Mina provider', () => {
    it('should process EVM claims unchanged with Mina provider registered', async () => {
      // Given: registry with both EVM and Mina providers

      // When: EVM provider is resolved via registry (not direct reference)
      const resolvedEvm = registry.getProviderForPeer({ peerId: 'peer-evm', chain: EVM_CHAIN_ID });
      expect(resolvedEvm).toBe(evmProvider);

      // And: EVM signing and verification are performed
      const sig = await evmProvider.signBalanceProof({
        channelId: '0x' + 'ab'.repeat(32),
        nonce: 5,
        transferredAmount: '50000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
      });
      expect(sig).toBe('sig-evm');

      const isValid = await evmProvider.verifyBalanceProof({
        channelId: '0x' + 'ab'.repeat(32),
        nonce: 5,
        transferredAmount: '50000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
        signature: sig,
        signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
      });
      expect(isValid).toBe(true);

      // Then: EVM operations succeed unchanged
      expect(evmProvider.signBalanceProof).toHaveBeenCalledTimes(1);
      expect(evmProvider.verifyBalanceProof).toHaveBeenCalledTimes(1);

      // And: Mina provider is untouched
      expect(minaProvider.signBalanceProof).not.toHaveBeenCalled();
      expect(minaProvider.verifyBalanceProof).not.toHaveBeenCalled();
    });

    it('should validate EVM claim serialization/deserialization unchanged', () => {
      // Given: an EVM claim
      const evmClaim = createEVMClaimFixture();

      // When: serialized and deserialized
      const json = JSON.stringify(evmClaim);
      const parsed = JSON.parse(json) as EVMClaimMessage;

      // Then: all fields survive the round-trip
      expect(parsed.blockchain).toBe('evm');
      expect(parsed.channelId).toBe(evmClaim.channelId);
      expect(parsed.nonce).toBe(evmClaim.nonce);
      expect(parsed.transferredAmount).toBe(evmClaim.transferredAmount);
      expect(parsed.signature).toBe(evmClaim.signature);
      expect(parsed.signerAddress).toBe(evmClaim.signerAddress);

      // And: validation passes
      expect(() => validateClaimMessage(parsed)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // T-34.8-13: Solana Regression (AC 13)
  // -------------------------------------------------------------------------

  describe('[T-34.8-13] Solana regression: Solana works alongside Mina provider', () => {
    it('should process Solana claims unchanged with Mina provider registered', async () => {
      // Given: registry with both Solana and Mina providers

      // When: Solana provider is resolved via registry (not direct reference)
      const resolvedSolana = registry.getProviderForPeer({
        peerId: 'peer-solana',
        chain: SOLANA_CHAIN_ID,
      });
      expect(resolvedSolana).toBe(solanaProvider);

      // And: Solana signing and verification are performed
      const sig = await solanaProvider.signBalanceProof({
        channelId: 'SoLChannePDA111111111111111111111111111111',
        nonce: 3,
        transferredAmount: '30000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
      });
      expect(sig).toBe('sig-solana');

      const isValid = await solanaProvider.verifyBalanceProof({
        channelId: 'SoLChannePDA111111111111111111111111111111',
        nonce: 3,
        transferredAmount: '30000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
        signature: sig,
        signerAddress: 'SoLSigner111111111111111111111111111111111',
      });
      expect(isValid).toBe(true);

      // Then: Solana operations succeed unchanged
      expect(solanaProvider.signBalanceProof).toHaveBeenCalledTimes(1);
      expect(solanaProvider.verifyBalanceProof).toHaveBeenCalledTimes(1);

      // And: Mina provider is untouched
      expect(minaProvider.signBalanceProof).not.toHaveBeenCalled();
      expect(minaProvider.verifyBalanceProof).not.toHaveBeenCalled();
    });

    it('should validate Solana claim serialization/deserialization unchanged', () => {
      // Given: a Solana claim
      const solanaClaim = createSolanaClaimFixture();

      // When: serialized and deserialized
      const json = JSON.stringify(solanaClaim);
      const parsed = JSON.parse(json) as SolanaClaimMessage;

      // Then: all fields survive the round-trip
      expect(parsed.blockchain).toBe('solana');
      expect(parsed.programId).toBe(solanaClaim.programId);
      expect(parsed.channelAccount).toBe(solanaClaim.channelAccount);
      expect(parsed.nonce).toBe(solanaClaim.nonce);
      expect(parsed.transferredAmount).toBe(solanaClaim.transferredAmount);
      expect(parsed.signature).toBe(solanaClaim.signature);
      expect(parsed.signerPublicKey).toBe(solanaClaim.signerPublicKey);

      // And: validation passes
      expect(() => validateClaimMessage(parsed)).not.toThrow();
    });
  });
});
