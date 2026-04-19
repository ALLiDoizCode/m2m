/**
 * Tests for ChainProviderRegistry
 *
 * Covers:
 * - Register and retrieve provider by chainType + chainId (AC 1)
 * - Register multiple providers for different chains (AC 2)
 * - Duplicate registration throws (AC 3)
 * - Lookup provider by peer configuration (AC 4)
 * - Peer with unregistered or missing chain returns undefined (AC 5)
 * - Configuration-driven initialization (AC 6)
 * - Deregistration and cleanup (AC 7)
 * - Barrel export (AC 8)
 *
 * Epic 32 Story 32.2
 *
 * @module chain-provider-registry.test
 */

import type { BlockchainType } from '../../btp/btp-claim-types';
import type { PaymentChannelProvider, ProviderConfig } from './payment-channel-provider';
import {
  ChainProviderRegistry,
  ChainProviderAlreadyRegisteredError,
} from './chain-provider-registry';
import type { RegistryPeerConfig, ChainProviderFactory } from './chain-provider-registry';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function createMockProvider(chainType: BlockchainType, chainId: string): PaymentChannelProvider {
  return {
    chainType,
    chainId,
    openChannel: jest.fn(),
    deposit: jest.fn(),
    claimFromChannel: jest.fn(),
    closeChannel: jest.fn(),
    settleChannel: jest.fn(),
    signBalanceProof: jest.fn(),
    verifyBalanceProof: jest.fn(),
    getChannelState: jest.fn(),
    subscribeToEvents: jest.fn(),
  } as PaymentChannelProvider;
}

// ---------------------------------------------------------------------------
// T-32.2-01: Register and retrieve provider by chainType + chainId
// ---------------------------------------------------------------------------

describe('Register and retrieve provider (T-32.2-01)', () => {
  it('should register and retrieve a provider by chain type and chain ID', () => {
    const registry = new ChainProviderRegistry();
    const provider = createMockProvider('evm', 'evm:8453');

    registry.register(provider);

    expect(registry.getProvider('evm', 'evm:8453')).toBe(provider);
  });

  it('should return undefined for unregistered chain type', () => {
    const registry = new ChainProviderRegistry();
    const provider = createMockProvider('evm', 'evm:8453');

    registry.register(provider);

    expect(registry.getProvider('solana', 'solana:mainnet')).toBeUndefined();
  });

  it('should return undefined when chainType does not match the stored provider', () => {
    const registry = new ChainProviderRegistry();
    const provider = createMockProvider('evm', 'evm:8453');

    registry.register(provider);

    // Attempt to retrieve with wrong chainType but matching chainId
    expect(registry.getProvider('solana', 'evm:8453')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T-32.2-02: Register multiple providers for different chains/chainIds
// ---------------------------------------------------------------------------

describe('Register multiple providers (T-32.2-02)', () => {
  it('should register and retrieve multiple providers for different chain IDs', () => {
    const registry = new ChainProviderRegistry();
    const providerBase = createMockProvider('evm', 'evm:8453');
    const providerBaseSepolia = createMockProvider('evm', 'evm:84532');

    registry.register(providerBase);
    registry.register(providerBaseSepolia);

    expect(registry.getProvider('evm', 'evm:8453')).toBe(providerBase);
    expect(registry.getProvider('evm', 'evm:84532')).toBe(providerBaseSepolia);
  });

  it('should register providers for different chain types', () => {
    const registry = new ChainProviderRegistry();
    const evmProvider = createMockProvider('evm', 'evm:8453');
    const solanaProvider = createMockProvider('solana', 'solana:mainnet');

    registry.register(evmProvider);
    registry.register(solanaProvider);

    expect(registry.getProvider('evm', 'evm:8453')).toBe(evmProvider);
    expect(registry.getProvider('solana', 'solana:mainnet')).toBe(solanaProvider);
  });

  it('should return all providers via getAllProviders after registering multiple', () => {
    const registry = new ChainProviderRegistry();
    const providerBase = createMockProvider('evm', 'evm:8453');
    const providerBaseSepolia = createMockProvider('evm', 'evm:84532');

    registry.register(providerBase);
    registry.register(providerBaseSepolia);

    const all = registry.getAllProviders();
    expect(all).toHaveLength(2);
    expect(all).toContain(providerBase);
    expect(all).toContain(providerBaseSepolia);
  });
});

// ---------------------------------------------------------------------------
// T-32.2-03: Duplicate registration throws ChainProviderAlreadyRegisteredError
// ---------------------------------------------------------------------------

describe('Duplicate registration (T-32.2-03)', () => {
  it('should throw ChainProviderAlreadyRegisteredError on duplicate chainId', () => {
    const registry = new ChainProviderRegistry();
    const provider1 = createMockProvider('evm', 'evm:8453');
    const provider2 = createMockProvider('evm', 'evm:8453');

    registry.register(provider1);

    expect(() => registry.register(provider2)).toThrow(ChainProviderAlreadyRegisteredError);
    expect(() => registry.register(provider2)).toThrow(
      'Provider already registered for chain: evm:8453'
    );
  });

  it('should have correct error name', () => {
    const error = new ChainProviderAlreadyRegisteredError('evm:8453');
    expect(error.name).toBe('ChainProviderAlreadyRegisteredError');
    expect(error).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// T-32.2-04: getProvider returns undefined for unregistered chain
// ---------------------------------------------------------------------------

describe('getProvider returns undefined for unregistered chain (T-32.2-04)', () => {
  it('should return undefined when no providers are registered', () => {
    const registry = new ChainProviderRegistry();

    expect(registry.getProvider('evm', 'evm:8453')).toBeUndefined();
  });

  it('should return undefined for unregistered chainId', () => {
    const registry = new ChainProviderRegistry();
    registry.register(createMockProvider('evm', 'evm:8453'));

    expect(registry.getProvider('evm', 'evm:1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T-32.2-05: getProviderForPeer resolves correct provider from peer config
// ---------------------------------------------------------------------------

describe('getProviderForPeer (T-32.2-05)', () => {
  it('should resolve the correct provider from peer config', () => {
    const registry = new ChainProviderRegistry();
    const provider = createMockProvider('evm', 'evm:8453');
    registry.register(provider);

    const peerConfig: RegistryPeerConfig = {
      peerId: 'peer-alice',
      chain: 'evm:8453',
    };

    expect(registry.getProviderForPeer(peerConfig)).toBe(provider);
  });

  it('should resolve the correct provider when multiple providers are registered', () => {
    const registry = new ChainProviderRegistry();
    const evmProvider = createMockProvider('evm', 'evm:8453');
    const solanaProvider = createMockProvider('solana', 'solana:mainnet');
    registry.register(evmProvider);
    registry.register(solanaProvider);

    expect(registry.getProviderForPeer({ peerId: 'peer-alice', chain: 'evm:8453' })).toBe(
      evmProvider
    );
    expect(registry.getProviderForPeer({ peerId: 'peer-bob', chain: 'solana:mainnet' })).toBe(
      solanaProvider
    );
  });
});

// ---------------------------------------------------------------------------
// T-32.2-06: fromConfig factory creates providers from ProviderConfig array
// ---------------------------------------------------------------------------

describe('fromConfig factory (T-32.2-06)', () => {
  it('should create a registry from config and factories', () => {
    const providerConfigs: ProviderConfig[] = [
      {
        chainType: 'evm',
        rpcUrl: 'https://mainnet.base.org',
        registryAddress: '0x123',
        keyId: 'key-1',
        tokenAddress: '0x5678000000000000000000000000000000000001',
      },
    ];

    const mockProvider = createMockProvider('evm', 'evm:8453');
    const evmFactory: ChainProviderFactory = jest.fn().mockReturnValue(mockProvider);

    const factories = new Map<BlockchainType, ChainProviderFactory>();
    factories.set('evm', evmFactory);

    const registry = ChainProviderRegistry.fromConfig(providerConfigs, factories);

    expect(evmFactory).toHaveBeenCalledWith(providerConfigs[0]);
    expect(registry.getProvider('evm', 'evm:8453')).toBe(mockProvider);
  });

  it('should create an empty registry from empty config array', () => {
    const factories = new Map<BlockchainType, ChainProviderFactory>();
    const registry = ChainProviderRegistry.fromConfig([], factories);

    expect(registry.getAllProviders()).toEqual([]);
  });

  it('should create a registry with multiple providers from config', () => {
    const providerConfigs: ProviderConfig[] = [
      {
        chainType: 'evm',
        rpcUrl: 'https://mainnet.base.org',
        registryAddress: '0x123',
        keyId: 'key-1',
        tokenAddress: '0x5678000000000000000000000000000000000001',
      },
      {
        chainType: 'solana',
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        programId: 'prog1',
        keyId: 'sol-key',
      },
    ];

    const evmProvider = createMockProvider('evm', 'evm:8453');
    const solanaProvider = createMockProvider('solana', 'solana:mainnet');

    const factories = new Map<BlockchainType, ChainProviderFactory>();
    factories.set('evm', jest.fn().mockReturnValue(evmProvider));
    factories.set('solana', jest.fn().mockReturnValue(solanaProvider));

    const registry = ChainProviderRegistry.fromConfig(providerConfigs, factories);

    expect(registry.getProvider('evm', 'evm:8453')).toBe(evmProvider);
    expect(registry.getProvider('solana', 'solana:mainnet')).toBe(solanaProvider);
    expect(registry.getAllProviders()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// T-32.2-07: getAllProviders returns all registered providers
// ---------------------------------------------------------------------------

describe('getAllProviders (T-32.2-07)', () => {
  it('should return empty array when no providers registered', () => {
    const registry = new ChainProviderRegistry();

    expect(registry.getAllProviders()).toEqual([]);
  });

  it('should return all registered providers', () => {
    const registry = new ChainProviderRegistry();
    const provider1 = createMockProvider('evm', 'evm:8453');
    const provider2 = createMockProvider('evm', 'evm:84532');

    registry.register(provider1);
    registry.register(provider2);

    const all = registry.getAllProviders();
    expect(all).toHaveLength(2);
    expect(all).toContain(provider1);
    expect(all).toContain(provider2);
  });
});

// ---------------------------------------------------------------------------
// T-32.2-08: Deregistration removes provider and is idempotent
// ---------------------------------------------------------------------------

describe('Deregistration (T-32.2-08)', () => {
  it('should remove a registered provider', () => {
    const registry = new ChainProviderRegistry();
    const provider = createMockProvider('evm', 'evm:8453');
    registry.register(provider);

    registry.deregister('evm:8453');

    expect(registry.getProvider('evm', 'evm:8453')).toBeUndefined();
  });

  it('should be idempotent — calling deregister twice does not throw', () => {
    const registry = new ChainProviderRegistry();
    const provider = createMockProvider('evm', 'evm:8453');
    registry.register(provider);

    registry.deregister('evm:8453');

    expect(() => registry.deregister('evm:8453')).not.toThrow();
  });

  it('should not throw when deregistering a never-registered chain ID', () => {
    const registry = new ChainProviderRegistry();

    expect(() => registry.deregister('evm:9999')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// T-32.2-09: getProviderForPeer returns undefined when peer references unregistered chain
// ---------------------------------------------------------------------------

describe('getProviderForPeer with unregistered chain (T-32.2-09)', () => {
  it('should return undefined when peer references an unregistered chain', () => {
    const registry = new ChainProviderRegistry();
    registry.register(createMockProvider('evm', 'evm:8453'));

    const peerConfig: RegistryPeerConfig = {
      peerId: 'peer-bob',
      chain: 'solana:devnet',
    };

    expect(registry.getProviderForPeer(peerConfig)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T-32.2-10: getProviderForPeer returns undefined when peer chain field is undefined
// ---------------------------------------------------------------------------

describe('getProviderForPeer with undefined chain (T-32.2-10)', () => {
  it('should return undefined when peer has no chain field', () => {
    const registry = new ChainProviderRegistry();
    registry.register(createMockProvider('evm', 'evm:8453'));

    const peerConfig: RegistryPeerConfig = {
      peerId: 'peer-legacy',
    };

    expect(registry.getProviderForPeer(peerConfig)).toBeUndefined();
  });

  it('should return undefined when peer chain is explicitly undefined', () => {
    const registry = new ChainProviderRegistry();
    registry.register(createMockProvider('evm', 'evm:8453'));

    const peerConfig: RegistryPeerConfig = {
      peerId: 'peer-legacy',
      chain: undefined,
    };

    expect(registry.getProviderForPeer(peerConfig)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T-32.2-11: fromConfig throws descriptive error when no factory for chainType
// ---------------------------------------------------------------------------

describe('fromConfig with missing factory (T-32.2-11)', () => {
  it('should throw descriptive error when no factory exists for chain type', () => {
    const providerConfigs: ProviderConfig[] = [
      {
        chainType: 'solana',
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        programId: 'prog1',
        keyId: 'sol-key',
      },
    ];

    const factories = new Map<BlockchainType, ChainProviderFactory>();
    // No factory registered for 'solana'

    expect(() => ChainProviderRegistry.fromConfig(providerConfigs, factories)).toThrow(
      'No factory registered for chain type: solana'
    );
  });
});

// ---------------------------------------------------------------------------
// AC 8: Barrel export accessibility
// ---------------------------------------------------------------------------

describe('Barrel export (AC 8)', () => {
  it('should export ChainProviderRegistry and supporting types from barrel', async () => {
    // This test verifies that the barrel export works by importing from it
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const barrel = require('./index');

    expect(barrel.ChainProviderRegistry).toBe(ChainProviderRegistry);
    expect(barrel.ChainProviderAlreadyRegisteredError).toBe(ChainProviderAlreadyRegisteredError);
  });

  it('should re-export all expected symbols from the provider barrel', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const barrel = require('./index');

    // Runtime value exports (classes)
    expect(barrel.ChainProviderRegistry).toBeDefined();
    expect(barrel.ChainProviderAlreadyRegisteredError).toBeDefined();

    // Type-only exports are erased at runtime, so we verify by ensuring
    // the barrel module does not throw on import and has the expected
    // runtime exports. Type accessibility is verified at compile time by
    // the imports at the top of this file.
    expect(typeof barrel.ChainProviderRegistry).toBe('function');
    expect(typeof barrel.ChainProviderAlreadyRegisteredError).toBe('function');
  });
});
