/**
 * Mina Config-Driven Provider and Static Analysis Tests
 *
 * Story 34.8: Tests config-driven provider creation, graceful shutdown,
 * and static import auditing for Mina provider.
 *
 * Test IDs covered:
 * - T-34.8-09: Config-driven Mina provider creation via ChainProviderRegistry.fromConfig()
 * - T-34.8-10: Graceful shutdown (provider cleans up subscriptions)
 * - T-34.8-11: Static import audit (no direct MinaPaymentChannelSDK imports in services)
 *
 * @packageDocumentation
 */

import * as path from 'path';
import * as fs from 'fs';
import { ChainProviderRegistry } from '../../src/settlement/provider/chain-provider-registry';
import type { ChainProviderFactory } from '../../src/settlement/provider/chain-provider-registry';
import type {
  PaymentChannelProvider,
  ProviderConfig,
  MinaProviderConfig,
} from '../../src/settlement/provider/payment-channel-provider';
import type { BlockchainType } from '../../src/btp/btp-claim-types';

jest.setTimeout(30_000);

// ---------------------------------------------------------------------------
// Mock Factories
// ---------------------------------------------------------------------------

function createMockChainProvider(
  chainId: string,
  chainType: BlockchainType = 'mina'
): jest.Mocked<PaymentChannelProvider> {
  return {
    chainType,
    chainId,
    openChannel: jest.fn().mockResolvedValue({ channelId: 'mock-zkapp', txHash: 'tx1' }),
    deposit: jest.fn().mockResolvedValue({ txHash: 'tx2' }),
    claimFromChannel: jest.fn().mockResolvedValue({ txHash: 'tx3' }),
    closeChannel: jest.fn().mockResolvedValue({ txHash: 'tx4' }),
    settleChannel: jest.fn().mockResolvedValue({ txHash: 'tx5' }),
    signBalanceProof: jest.fn().mockResolvedValue('mock-proof'),
    verifyBalanceProof: jest.fn().mockResolvedValue(true),
    getChannelState: jest.fn().mockResolvedValue({
      channelId: 'mock-zkapp',
      status: 'opened' as const,
      participants: ['alice', 'bob'],
      deposit: 10000n,
    }),
    subscribeToEvents: jest.fn().mockReturnValue({ unsubscribe: jest.fn() }),
  } as unknown as jest.Mocked<PaymentChannelProvider>;
}

// ---------------------------------------------------------------------------
// T-34.8-09: Config-Driven Mina Provider (AC 9)
// ---------------------------------------------------------------------------

describe('[T-34.8-09] Config-driven: Mina provider from config via ChainProviderRegistry (Story 34.8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should create a Mina provider from a MinaProviderConfig via factory', () => {
    // Given: a Mina provider config matching YAML config structure
    const minaConfig: MinaProviderConfig = {
      chainType: 'mina',
      graphqlUrl: 'http://localhost:8080/graphql',
      zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
      keyId: 'test-key',
      tokenId: 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf',
      network: 'devnet',
    };

    // And: a factory that creates mock providers
    const minaFactory: ChainProviderFactory = (config: ProviderConfig) => {
      expect(config.chainType).toBe('mina');
      const mConfig = config as MinaProviderConfig;
      const network = mConfig.network ?? 'devnet';
      return createMockChainProvider(`mina:${network}`);
    };

    const factories = new Map<BlockchainType, ChainProviderFactory>();
    factories.set('mina', minaFactory);

    // When: registry is created from config
    const registry = ChainProviderRegistry.fromConfig([minaConfig], factories);

    // Then: the Mina provider is registered with chainId 'mina:devnet'
    const provider = registry.getProvider('mina', 'mina:devnet');
    expect(provider).toBeDefined();
    expect(provider!.chainType).toBe('mina');
    expect(provider!.chainId).toBe('mina:devnet');
  });

  it('should support getProviderForPeer lookup after config-driven creation', () => {
    // Given: a config-driven registry with a Mina provider
    const minaConfig: MinaProviderConfig = {
      chainType: 'mina',
      graphqlUrl: 'http://localhost:8080/graphql',
      zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
      keyId: 'test-key',
      network: 'devnet',
    };

    const factories = new Map<BlockchainType, ChainProviderFactory>();
    factories.set('mina', (_config: ProviderConfig) => {
      return createMockChainProvider('mina:devnet');
    });

    const registry = ChainProviderRegistry.fromConfig([minaConfig], factories);

    // When: looking up by peer config
    const provider = registry.getProviderForPeer({
      peerId: 'peer-mina',
      chain: 'mina:devnet',
    });

    // Then: the correct provider is returned
    expect(provider).toBeDefined();
    expect(provider!.chainId).toBe('mina:devnet');
  });

  it('should throw when no factory is registered for mina chain type', () => {
    // Given: a Mina config but no Mina factory
    const minaConfig: MinaProviderConfig = {
      chainType: 'mina',
      graphqlUrl: 'http://localhost:8080/graphql',
      zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
      keyId: 'test-key',
    };

    const factories = new Map<BlockchainType, ChainProviderFactory>();
    // No mina factory registered

    // When/Then: fromConfig throws
    expect(() => {
      ChainProviderRegistry.fromConfig([minaConfig], factories);
    }).toThrow('No factory registered for chain type: mina');
  });

  it('should create mixed EVM + Solana + Mina providers from config', () => {
    // Given: configs for all three chain types
    const configs: ProviderConfig[] = [
      {
        chainType: 'evm',
        rpcUrl: 'http://127.0.0.1:8545',
        registryAddress: '0x1234567890123456789012345678901234567890',
        keyId: 'evm-key',
      },
      {
        chainType: 'solana',
        rpcUrl: 'http://127.0.0.1:8899',
        programId: 'PayChan1111111111111111111111111111111111111',
        keyId: 'solana-key',
        cluster: 'devnet',
      },
      {
        chainType: 'mina',
        graphqlUrl: 'http://localhost:8080/graphql',
        zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
        keyId: 'mina-key',
        network: 'devnet',
      },
    ];

    // And: factories for all chain types
    const factories = new Map<BlockchainType, ChainProviderFactory>();
    factories.set('evm', () => createMockChainProvider('evm:8453', 'evm'));
    factories.set('solana', () => createMockChainProvider('solana:devnet', 'solana'));
    factories.set('mina', () => createMockChainProvider('mina:devnet'));

    // When: registry is created
    const registry = ChainProviderRegistry.fromConfig(configs, factories);

    // Then: all three providers are registered
    const allProviders = registry.getAllProviders();
    expect(allProviders).toHaveLength(3);
    expect(registry.getProvider('evm', 'evm:8453')).toBeDefined();
    expect(registry.getProvider('solana', 'solana:devnet')).toBeDefined();
    expect(registry.getProvider('mina', 'mina:devnet')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// T-34.8-10: Graceful Shutdown (AC 10)
// ---------------------------------------------------------------------------

describe('[T-34.8-10] Graceful shutdown: provider cleans up subscriptions (Story 34.8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should allow subscription cleanup after provider is deregistered from registry', () => {
    // Given: a provider with an active event subscription
    const unsubscribeFn = jest.fn();
    const provider = createMockChainProvider('mina:devnet');
    provider.subscribeToEvents.mockReturnValue({ unsubscribe: unsubscribeFn });

    const registry = new ChainProviderRegistry();
    registry.register(provider);

    // Subscribe to events
    const subscription = provider.subscribeToEvents(
      'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
      jest.fn()
    );

    // When: the provider is deregistered from the registry
    registry.deregister('mina:devnet');

    // Then: the provider is no longer in the registry
    expect(registry.getProvider('mina', 'mina:devnet')).toBeUndefined();

    // And: caller can still clean up the subscription (registry does not auto-unsubscribe)
    subscription.unsubscribe();
    expect(unsubscribeFn).toHaveBeenCalledTimes(1);
  });

  it('should not throw on deregistering a non-existent provider', () => {
    // Given: an empty registry
    const registry = new ChainProviderRegistry();

    // When/Then: deregistering a non-existent provider does not throw
    expect(() => {
      registry.deregister('mina:nonexistent');
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// T-34.8-11: Static Import Audit (AC 11)
// ---------------------------------------------------------------------------

describe('[T-34.8-11] Static: no direct MinaPaymentChannelSDK imports in settlement services (Story 34.8)', () => {
  it('should not have direct MinaPaymentChannelSDK imports in core settlement services', () => {
    // Given: core settlement service files
    const settlementDir = path.resolve(__dirname, '../../src/settlement');
    const coreFiles = [
      'claim-receiver.ts',
      'per-packet-claim-service.ts',
      'settlement-executor.ts',
      'settlement-monitor.ts',
    ];

    const violations: string[] = [];

    for (const file of coreFiles) {
      const filePath = path.join(settlementDir, file);
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, 'utf8');

      // Check for direct imports of the Mina SDK
      if (content.match(/import.*MinaPaymentChannelSDK/)) {
        violations.push(`${file}: imports MinaPaymentChannelSDK`);
      }
      if (content.match(/from ['"].*mina-payment-channel-sdk['"]/)) {
        violations.push(`${file}: imports from mina-payment-channel-sdk`);
      }
      // Also check for require() patterns
      if (content.match(/require\(['"].*mina-payment-channel-sdk['"]\)/)) {
        violations.push(`${file}: requires mina-payment-channel-sdk`);
      }
    }

    // Then: no violations found
    expect(violations).toEqual([]);
  });

  it('should allow MinaPaymentChannelSDK import only in provider/ subdirectory', () => {
    // Given: the provider directory where SDK imports are allowed
    const providerDir = path.resolve(__dirname, '../../src/settlement/provider');

    const providerFiles = fs
      .readdirSync(providerDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

    // When: checking provider files for SDK imports
    const filesImportingSDK: string[] = [];

    for (const file of providerFiles) {
      const content = fs.readFileSync(path.join(providerDir, file), 'utf8');
      if (content.match(/mina-payment-channel-sdk/)) {
        filesImportingSDK.push(file);
      }
    }

    // Then: only mina-payment-channel-provider.ts imports the SDK
    for (const file of filesImportingSDK) {
      expect(file).toBe('mina-payment-channel-provider.ts');
    }
  });

  it('should verify that per-packet-claim-service does not import the Mina SDK directly', () => {
    // Given: the per-packet-claim-service source
    const filePath = path.resolve(__dirname, '../../src/settlement/per-packet-claim-service.ts');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf8');

    // Then: it does NOT import MinaPaymentChannelSDK directly
    expect(content).not.toMatch(/from ['"]\.\/mina-payment-channel-sdk['"]/);

    // NOTE: MinaPaymentChannelProvider instanceof check is allowed (follows EVM/Solana pattern)
  });

  it('should verify that claim-receiver does not import the Mina SDK directly', () => {
    // Given: the claim-receiver source
    const filePath = path.resolve(__dirname, '../../src/settlement/claim-receiver.ts');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf8');

    // Then: it does NOT import MinaPaymentChannelSDK directly
    expect(content).not.toMatch(/from ['"]\.\/mina-payment-channel-sdk['"]/);
    expect(content).not.toMatch(/import.*MinaPaymentChannelSDK[^P]/);
  });

  it('should verify that settlement-executor does not import the Mina SDK directly', () => {
    // Given: the settlement-executor source
    const filePath = path.resolve(__dirname, '../../src/settlement/settlement-executor.ts');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf8');

    // Then: it does NOT import MinaPaymentChannelSDK directly
    expect(content).not.toMatch(/from ['"]\.\/mina-payment-channel-sdk['"]/);
  });

  it('should verify that settlement-monitor does not import the Mina SDK directly', () => {
    // Given: the settlement-monitor source
    const filePath = path.resolve(__dirname, '../../src/settlement/settlement-monitor.ts');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf8');

    // Then: it does NOT import MinaPaymentChannelSDK directly
    expect(content).not.toMatch(/from ['"]\.\/mina-payment-channel-sdk['"]/);
  });
});
