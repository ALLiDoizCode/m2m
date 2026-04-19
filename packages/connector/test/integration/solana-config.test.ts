/**
 * Solana Config-Driven and Static Analysis Tests
 *
 * Story 33.7: Tests config-driven provider creation and static import auditing.
 *
 * Test IDs covered:
 * - T-33.7-09: Solana provider created from YAML config via ChainProviderRegistry.fromConfig()
 * - T-33.7-11: Static import audit — no direct SolanaPaymentChannelSDK imports in settlement services
 *
 * No infrastructure required — these tests use config validation and filesystem inspection.
 *
 * @packageDocumentation
 */

import * as path from 'path';
import * as fs from 'fs';
import {
  ChainProviderRegistry,
  type ChainProviderFactory,
} from '../../src/settlement/provider/chain-provider-registry';
import type {
  PaymentChannelProvider,
  ProviderConfig,
  SolanaProviderConfig,
} from '../../src/settlement/provider/payment-channel-provider';
import type { BlockchainType } from '../../src/btp/btp-claim-types';

jest.setTimeout(30_000);

// ---------------------------------------------------------------------------
// Mock Factories
// ---------------------------------------------------------------------------

function createMockSolanaProvider(chainId: string): jest.Mocked<PaymentChannelProvider> {
  return {
    chainType: 'solana' as BlockchainType,
    chainId,
    openChannel: jest.fn().mockResolvedValue({ channelId: 'mock-pda', txHash: 'sig1' }),
    deposit: jest.fn().mockResolvedValue({ txHash: 'sig2' }),
    claimFromChannel: jest.fn().mockResolvedValue({ txHash: 'sig3' }),
    closeChannel: jest.fn().mockResolvedValue({ txHash: 'sig4' }),
    settleChannel: jest.fn().mockResolvedValue({ txHash: 'sig5' }),
    signBalanceProof: jest.fn().mockResolvedValue('mocksig'),
    verifyBalanceProof: jest.fn().mockResolvedValue(true),
    getChannelState: jest.fn().mockResolvedValue({
      channelId: 'mock-pda',
      status: 'opened' as const,
      participants: ['addr1', 'addr2'],
      deposit: 10000n,
    }),
    subscribeToEvents: jest.fn().mockReturnValue({ unsubscribe: jest.fn() }),
  } as unknown as jest.Mocked<PaymentChannelProvider>;
}

// ---------------------------------------------------------------------------
// T-33.7-09: Config-Driven Solana Provider (AC 8, Story 33.7)
// ---------------------------------------------------------------------------

describe('[T-33.7-09] Config-driven: Solana provider from config via ChainProviderRegistry.fromConfig() (Story 33.7)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should create a Solana provider from a SolanaProviderConfig via factory', () => {
    // Given: a Solana provider config matching YAML config structure
    const solanaConfig: SolanaProviderConfig = {
      chainType: 'solana',
      rpcUrl: 'http://127.0.0.1:8899',
      wsUrl: 'ws://127.0.0.1:8900',
      programId: 'PayChan1111111111111111111111111111111111111',
      keyId: 'solana-treasury-key',
      cluster: 'devnet',
    };

    // And: a factory that creates mock providers
    const solanaFactory: ChainProviderFactory = (config: ProviderConfig) => {
      expect(config.chainType).toBe('solana');
      const solConfig = config as SolanaProviderConfig;
      const cluster = solConfig.cluster ?? 'devnet';
      return createMockSolanaProvider(`solana:${cluster}`);
    };

    const factories = new Map<BlockchainType, ChainProviderFactory>();
    factories.set('solana', solanaFactory);

    // When: registry is created from config
    const registry = ChainProviderRegistry.fromConfig([solanaConfig], factories);

    // Then: the Solana provider is registered
    const provider = registry.getProvider('solana', 'solana:devnet');
    expect(provider).toBeDefined();
    expect(provider!.chainType).toBe('solana');
    expect(provider!.chainId).toBe('solana:devnet');
  });

  it('should create multiple providers from mixed EVM + Solana configs', () => {
    // Given: both EVM and Solana configs
    const configs: ProviderConfig[] = [
      {
        chainType: 'evm',
        rpcUrl: 'http://127.0.0.1:8545',
        registryAddress: '0x1234567890123456789012345678901234567890',
        keyId: 'evm-key',
        tokenAddress: '0x5678000000000000000000000000000000000001',
      },
      {
        chainType: 'solana',
        rpcUrl: 'http://127.0.0.1:8899',
        programId: 'PayChan1111111111111111111111111111111111111',
        keyId: 'solana-key',
        cluster: 'bankrun',
      },
    ];

    // And: factories for both chain types
    const evmFactory: ChainProviderFactory = (_config: ProviderConfig) => {
      const provider = createMockSolanaProvider('evm:anvil:31337');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).chainType = 'evm';
      return provider;
    };

    const solanaFactory: ChainProviderFactory = (config: ProviderConfig) => {
      const solConfig = config as SolanaProviderConfig;
      return createMockSolanaProvider(`solana:${solConfig.cluster ?? 'devnet'}`);
    };

    const factories = new Map<BlockchainType, ChainProviderFactory>();
    factories.set('evm', evmFactory);
    factories.set('solana', solanaFactory);

    // When: registry is created
    const registry = ChainProviderRegistry.fromConfig(configs, factories);

    // Then: both providers are registered
    const allProviders = registry.getAllProviders();
    expect(allProviders).toHaveLength(2);

    const evmProvider = registry.getProvider('evm', 'evm:anvil:31337');
    const solanaProvider = registry.getProvider('solana', 'solana:bankrun');
    expect(evmProvider).toBeDefined();
    expect(solanaProvider).toBeDefined();
  });

  it('should throw when no factory is registered for a chain type', () => {
    // Given: a Solana config but no Solana factory
    const solanaConfig: SolanaProviderConfig = {
      chainType: 'solana',
      rpcUrl: 'http://127.0.0.1:8899',
      programId: 'PayChan1111111111111111111111111111111111111',
      keyId: 'solana-key',
    };

    const factories = new Map<BlockchainType, ChainProviderFactory>();
    // No solana factory registered

    // When/Then: fromConfig throws
    expect(() => {
      ChainProviderRegistry.fromConfig([solanaConfig], factories);
    }).toThrow('No factory registered for chain type: solana');
  });

  it('should support peer lookup after config-driven creation', () => {
    // Given: a config-driven registry with a Solana provider
    const solanaConfig: SolanaProviderConfig = {
      chainType: 'solana',
      rpcUrl: 'http://127.0.0.1:8899',
      programId: 'PayChan1111111111111111111111111111111111111',
      keyId: 'solana-key',
      cluster: 'devnet',
    };

    const factories = new Map<BlockchainType, ChainProviderFactory>();
    factories.set('solana', (_config: ProviderConfig) => {
      return createMockSolanaProvider('solana:devnet');
    });

    const registry = ChainProviderRegistry.fromConfig([solanaConfig], factories);

    // When: looking up by peer config
    const provider = registry.getProviderForPeer({
      peerId: 'peer-solana',
      chain: 'solana:devnet',
    });

    // Then: the correct provider is returned
    expect(provider).toBeDefined();
    expect(provider!.chainId).toBe('solana:devnet');
  });
});

// ---------------------------------------------------------------------------
// T-33.7-11: Static Import Audit (AC 8, Story 33.7)
// ---------------------------------------------------------------------------

describe('[T-33.7-11] Static: no direct SolanaPaymentChannelSDK imports in settlement services (Story 33.7)', () => {
  it('should not have direct SolanaPaymentChannelSDK imports in core settlement services', () => {
    // Given: the settlement directory containing core services
    const settlementDir = path.resolve(__dirname, '../../src/settlement');

    // Get all .ts files in the settlement directory (excluding test files, the SDK itself, and provider/)
    const files = fs
      .readdirSync(settlementDir)
      .filter(
        (f) =>
          f.endsWith('.ts') &&
          !f.endsWith('.test.ts') &&
          !f.endsWith('.atdd.test.ts') &&
          f !== 'solana-payment-channel-sdk.ts'
      );

    expect(files.length).toBeGreaterThan(0);

    // When: imports are audited
    const violations: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(path.join(settlementDir, file), 'utf8');

      // Check for direct imports of the Solana SDK
      if (content.match(/from ['"]\.\/solana-payment-channel-sdk['"]/)) {
        violations.push(`${file}: imports from './solana-payment-channel-sdk'`);
      }
      if (content.match(/from ['"]\.\.\/settlement\/solana-payment-channel-sdk['"]/)) {
        violations.push(`${file}: imports from '../settlement/solana-payment-channel-sdk'`);
      }
      // Also check for require() patterns
      if (content.match(/require\(['"].*solana-payment-channel-sdk['"]\)/)) {
        violations.push(`${file}: requires solana-payment-channel-sdk`);
      }
    }

    // Then: no violations found
    expect(violations).toEqual([]);
  });

  it('should allow SolanaPaymentChannelSDK import only in provider/ subdirectory', () => {
    // Given: the provider directory where SDK imports are allowed
    const providerDir = path.resolve(__dirname, '../../src/settlement/provider');

    const providerFiles = fs
      .readdirSync(providerDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

    // When: checking provider files for SDK imports
    const filesImportingSDK: string[] = [];

    for (const file of providerFiles) {
      const content = fs.readFileSync(path.join(providerDir, file), 'utf8');
      if (content.match(/solana-payment-channel-sdk/)) {
        filesImportingSDK.push(file);
      }
    }

    // Then: only solana-payment-channel-provider.ts imports the SDK
    // (This verifies the architectural boundary is maintained)
    for (const file of filesImportingSDK) {
      expect(file).toBe('solana-payment-channel-provider.ts');
    }
  });

  it('should verify that per-packet-claim-service imports only the provider, not the SDK', () => {
    // Given: the per-packet-claim-service source
    const filePath = path.resolve(__dirname, '../../src/settlement/per-packet-claim-service.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    // Then: it imports SolanaPaymentChannelProvider (allowed)
    expect(content).toMatch(/SolanaPaymentChannelProvider/);

    // And: it does NOT import SolanaPaymentChannelSDK directly
    expect(content).not.toMatch(/from ['"]\.\/solana-payment-channel-sdk['"]/);
  });

  it('should verify that claim-receiver imports only the provider types, not the SDK', () => {
    // Given: the claim-receiver source
    const filePath = path.resolve(__dirname, '../../src/settlement/claim-receiver.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    // Then: it does NOT import SolanaPaymentChannelSDK directly
    expect(content).not.toMatch(/from ['"]\.\/solana-payment-channel-sdk['"]/);
    expect(content).not.toMatch(/SolanaPaymentChannelSDK/);
  });

  it('should verify that settlement-executor does not import the SDK directly', () => {
    // Given: the settlement-executor source
    const filePath = path.resolve(__dirname, '../../src/settlement/settlement-executor.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    // Then: it does NOT import SolanaPaymentChannelSDK directly
    expect(content).not.toMatch(/from ['"]\.\/solana-payment-channel-sdk['"]/);
  });
});
