/**
 * Tests for Story 32.7: Update Configuration Schema
 *
 * Tests verify multi-chain provider configuration, validation,
 * and backward compatibility.
 *
 * Tests cover:
 * - T-32.7-01: chainProviders section accepts array of valid provider configs (AC 1)
 * - T-32.7-02: Per-peer chain field references registered provider chainId (AC 2)
 * - T-32.7-03: Legacy config auto-creates EVM provider (AC 3)
 * - T-32.7-04: Validation rejects unknown chainType (AC 5)
 * - T-32.7-05: Validation rejects peer referencing unregistered chain (AC 7)
 * - T-32.7-06: Deprecation warning logged when legacy settlementInfra used (AC 3)
 * - T-32.7-07: settlementPreference accepts chain-specific values (AC 4)
 * - T-32.7-08: Duplicate chainId in chainProviders rejected (AC 6)
 * - T-32.7-09: EVM config entry validates required fields (AC 1)
 * - T-32.7-10: ChainProviderConfigEntry type compiles with ProviderConfig subtypes (AC 1)
 *
 * Epic 32 Story 32.7
 *
 * @module config/chain-provider-config.test
 */

import { validateChainProviders, ConnectorConfig, ChainProviderConfigEntry } from './types';
import type { PeerConfig as SettlementPeerConfig } from '../settlement/types';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/** Minimal valid ConnectorConfig for testing */
const baseConfig: Pick<
  ConnectorConfig,
  'nodeId' | 'btpServerPort' | 'peers' | 'routes' | 'environment'
> = {
  nodeId: 'test-node',
  btpServerPort: 3000,
  peers: [],
  routes: [],
  environment: 'development',
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// T-32.7-01: chainProviders section accepts array of valid provider configs
// ---------------------------------------------------------------------------

describe('chainProviders configuration (T-32.7-01)', () => {
  it('should accept an array of valid EVM provider configurations', () => {
    // Given a ConnectorConfig with a chainProviders section
    const config: ConnectorConfig = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'evm',
          chainId: 'evm:8453',
          rpcUrl: 'https://mainnet.base.org',
          registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
          keyId: 'evm-treasury-key',
        },
        {
          chainType: 'evm',
          chainId: 'evm:42161',
          rpcUrl: 'https://arb1.arbitrum.io/rpc',
          registryAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
          keyId: 'evm-arb-key',
        },
      ],
    };

    // Then validation should pass and config should have correct structure
    expect(() => validateChainProviders(config)).not.toThrow();
    expect(config.chainProviders).toHaveLength(2);
    expect(config.chainProviders![0]!.chainType).toBe('evm');
    expect(config.chainProviders![0]!.chainId).toBe('evm:8453');
    expect(config.chainProviders![1]!.chainId).toBe('evm:42161');
  });

  it('should accept mixed chain type provider configurations', () => {
    // Given a ConnectorConfig with multiple chain types
    const config: ConnectorConfig = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'evm',
          chainId: 'evm:8453',
          rpcUrl: 'https://mainnet.base.org',
          registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
          keyId: 'evm-treasury-key',
        },
        {
          chainType: 'solana',
          chainId: 'solana:mainnet',
          rpcUrl: 'https://api.mainnet-beta.solana.com',
          programId: 'PaymentChannel111111111111111111111111111',
        },
        {
          chainType: 'mina',
          chainId: 'mina:mainnet',
          graphqlUrl: 'https://graphql.minaprotocol.com/graphql',
          zkAppAddress: 'B62qkRodi7nj6W1geB12UuW2XAx2yidWZCcDthJvkf9G4A6G5GFasVQ',
        },
      ],
    };

    // Then validation should pass for all chain types
    expect(() => validateChainProviders(config)).not.toThrow();
    expect(config.chainProviders).toHaveLength(3);
    expect(config.chainProviders![0]!.chainType).toBe('evm');
    expect(config.chainProviders![1]!.chainType).toBe('solana');
    expect(config.chainProviders![2]!.chainType).toBe('mina');
  });
});

// ---------------------------------------------------------------------------
// T-32.7-02: Per-peer chain field references registered provider chainId
// ---------------------------------------------------------------------------

describe('Per-peer chain field (T-32.7-02)', () => {
  it('should accept a peer with a chain field referencing a registered provider', () => {
    // Given a ConnectorConfig with chainProviders and a peer with chain field
    const config: ConnectorConfig = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'evm',
          chainId: 'evm:8453',
          rpcUrl: 'https://mainnet.base.org',
          registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
          keyId: 'evm-treasury-key',
        },
      ],
      peers: [
        {
          id: 'connector-a',
          url: 'ws://connector-a:3000',
          authToken: 'secret-a',
          chain: 'evm:8453',
          evmAddress: '0xabc0000000000000000000000000000000000001',
        },
      ],
    };

    // Then the peer's chain field should reference the provider's chainId
    expect(config.peers[0]!.chain).toBe('evm:8453');

    // And validation should pass (chain references a valid provider)
    expect(typeof validateChainProviders).toBe('function');
    expect(() => validateChainProviders(config)).not.toThrow();
  });

  it('should accept a peer without a chain field (defaults to legacy behavior)', () => {
    // Given a ConnectorConfig with a peer that has no chain field
    const config: ConnectorConfig = {
      ...baseConfig,
      peers: [
        {
          id: 'connector-a',
          url: 'ws://connector-a:3000',
          authToken: 'secret-a',
          evmAddress: '0xabc0000000000000000000000000000000000001',
        },
      ],
    };

    // Then the peer's chain field should be undefined
    expect(config.peers[0]!.chain).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T-32.7-03: Legacy config auto-creates EVM provider
// ---------------------------------------------------------------------------

describe('Legacy config backward compatibility (T-32.7-03)', () => {
  it('should accept legacy config with no chainProviders (only settlementInfra)', () => {
    // Given a config with settlementInfra but no chainProviders
    const config: ConnectorConfig = {
      ...baseConfig,
      settlementInfra: {
        enabled: true,
        rpcUrl: 'http://anvil:8545',
        registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
        privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        tokenAddress: '0x5678000000000000000000000000000000000001',
      },
    };

    // Then the config should be valid (no chainProviders needed)
    expect(config.chainProviders).toBeUndefined();
    expect(config.settlementInfra?.enabled).toBe(true);

    // And validateChainProviders should not throw (legacy mode is valid)
    expect(() => validateChainProviders(config)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// T-32.7-04: Validation rejects unknown chainType
// ---------------------------------------------------------------------------

describe('Validation rejects unknown chain types (T-32.7-04)', () => {
  it('should throw error for unknown chainType in chainProviders', () => {
    // Given a config with an unknown chainType
    const config = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'unknown',
          chainId: 'unknown:1',
          rpcUrl: 'https://example.com',
        },
      ],
    } as unknown as ConnectorConfig;

    // When validation runs, then it should throw with the correct error message
    expect(() => validateChainProviders(config)).toThrow('Unknown chain type: unknown');
  });
});

// ---------------------------------------------------------------------------
// T-32.7-05: Validation rejects peer referencing unregistered chain
// ---------------------------------------------------------------------------

describe('Validation rejects unregistered chain reference (T-32.7-05)', () => {
  it('should throw error when peer references a chain not in chainProviders', () => {
    // Given a config where a peer references a chain that is not registered
    const config: ConnectorConfig = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'evm',
          chainId: 'evm:8453',
          rpcUrl: 'https://mainnet.base.org',
          registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
          keyId: 'evm-treasury-key',
        },
      ],
      peers: [
        {
          id: 'connector-a',
          url: 'ws://connector-a:3000',
          authToken: 'secret-a',
          chain: 'evm:42161', // This chain is NOT in chainProviders
          evmAddress: '0xabc0000000000000000000000000000000000001',
        },
      ],
    };

    // When validation runs, then it should throw indicating the unregistered chain reference
    expect(() => validateChainProviders(config)).toThrow(/unregistered chain|not found|evm:42161/i);
  });

  it('should not throw when peer has no chain field and legacy settlementInfra is present', () => {
    // Given a config with no chainProviders but settlementInfra present
    // and a peer without a chain field
    const config: ConnectorConfig = {
      ...baseConfig,
      settlementInfra: {
        enabled: true,
        rpcUrl: 'http://anvil:8545',
        registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
        privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        tokenAddress: '0x5678000000000000000000000000000000000001',
      },
      peers: [
        {
          id: 'connector-a',
          url: 'ws://connector-a:3000',
          authToken: 'secret-a',
          // No chain field - defaults to legacy settlementInfra
        },
      ],
    };

    // When validation runs, then it should not throw (peer is covered by legacy path)
    expect(() => validateChainProviders(config)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// T-32.7-06: Deprecation warning logged when legacy settlementInfra used
// ---------------------------------------------------------------------------

describe('Deprecation warning for legacy settlementInfra (T-32.7-06)', () => {
  it('should log deprecation warning when settlementInfra is used without chainProviders', () => {
    // Given a config using legacy settlementInfra without chainProviders
    const config: ConnectorConfig = {
      ...baseConfig,
      settlementInfra: {
        enabled: true,
        rpcUrl: 'http://anvil:8545',
        registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
        privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        tokenAddress: '0x5678000000000000000000000000000000000001',
      },
    };

    // When the config is processed with a logger
    const mockLogger = {
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    };

    // Then a deprecation warning should be logged
    validateChainProviders(config, mockLogger);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'config_deprecation' }),
      expect.stringContaining('settlementInfra is deprecated')
    );
  });
});

// ---------------------------------------------------------------------------
// T-32.7-07: settlementPreference accepts chain-specific values
// ---------------------------------------------------------------------------

describe('settlementPreference chain-specific values (T-32.7-07)', () => {
  it('should accept "solana" as a valid settlementPreference', () => {
    // Given a settlement-level PeerConfig with settlementPreference 'solana'
    // Typed assignment verifies the union was extended
    const peerConfig: SettlementPeerConfig = {
      peerId: 'peer-alice',
      address: 'g.alice',
      settlementPreference: 'solana',
      settlementTokens: ['SOL'],
    };

    // Then the value should be accepted
    expect(peerConfig.settlementPreference).toBe('solana');
  });

  it('should accept "mina" as a valid settlementPreference', () => {
    // Given a settlement-level PeerConfig with settlementPreference 'mina'
    const peerConfig: SettlementPeerConfig = {
      peerId: 'peer-bob',
      address: 'g.bob',
      settlementPreference: 'mina',
      settlementTokens: ['MINA'],
    };

    // Then the value should be accepted
    expect(peerConfig.settlementPreference).toBe('mina');
  });

  it('should still accept existing values: evm, any, both', () => {
    // Given existing settlementPreference values — typed to verify backward compatibility
    const evmPeer: SettlementPeerConfig = {
      peerId: 'p1',
      address: 'g.p1',
      settlementPreference: 'evm',
      settlementTokens: [],
    };
    const anyPeer: SettlementPeerConfig = {
      peerId: 'p2',
      address: 'g.p2',
      settlementPreference: 'any',
      settlementTokens: [],
    };
    const bothPeer: SettlementPeerConfig = {
      peerId: 'p3',
      address: 'g.p3',
      settlementPreference: 'both',
      settlementTokens: [],
    };

    // Then all existing values should still be valid
    expect(evmPeer.settlementPreference).toBe('evm');
    expect(anyPeer.settlementPreference).toBe('any');
    expect(bothPeer.settlementPreference).toBe('both');
  });
});

// ---------------------------------------------------------------------------
// T-32.7-08: Duplicate chainId in chainProviders rejected
// ---------------------------------------------------------------------------

describe('Duplicate chainId validation (T-32.7-08)', () => {
  it('should throw error when chainProviders contains duplicate chainId values', () => {
    // Given a config with duplicate chainId entries
    const config: ConnectorConfig = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'evm',
          chainId: 'evm:8453',
          rpcUrl: 'https://mainnet.base.org',
          registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
          keyId: 'evm-treasury-key',
        },
        {
          chainType: 'evm',
          chainId: 'evm:8453', // DUPLICATE
          rpcUrl: 'https://other-rpc.base.org',
          registryAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
          keyId: 'evm-other-key',
        },
      ],
    };

    // When validation runs, then it should throw indicating the duplicate chainId
    expect(() => validateChainProviders(config)).toThrow('Duplicate chainId: evm:8453');
  });
});

// ---------------------------------------------------------------------------
// T-32.7-09: EVM config entry validates required fields
// ---------------------------------------------------------------------------

describe('EVM config required field validation (T-32.7-09)', () => {
  it('should throw error when EVM config is missing registryAddress', () => {
    // Given an EVM config entry missing registryAddress
    const config = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'evm',
          chainId: 'evm:8453',
          rpcUrl: 'https://mainnet.base.org',
          // registryAddress: MISSING
          keyId: 'evm-treasury-key',
        },
      ],
    } as unknown as ConnectorConfig;

    // When validation runs, then it should throw
    expect(() => validateChainProviders(config)).toThrow(/registryAddress/i);
  });

  it('should throw error when EVM config is missing keyId', () => {
    // Given an EVM config entry missing keyId
    const config = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'evm',
          chainId: 'evm:8453',
          rpcUrl: 'https://mainnet.base.org',
          registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
          // keyId: MISSING
        },
      ],
    } as unknown as ConnectorConfig;

    // When validation runs, then it should throw
    expect(() => validateChainProviders(config)).toThrow(/keyId/i);
  });

  it('should throw error when EVM config is missing rpcUrl', () => {
    // Given an EVM config entry missing rpcUrl
    const config = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'evm',
          chainId: 'evm:8453',
          // rpcUrl: MISSING
          registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
          keyId: 'evm-treasury-key',
        },
      ],
    } as unknown as ConnectorConfig;

    // When validation runs, then it should throw
    expect(() => validateChainProviders(config)).toThrow(/rpcUrl/i);
  });

  it('should throw error when Solana config is missing programId', () => {
    // Given a Solana config entry missing programId
    const config = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'solana',
          chainId: 'solana:mainnet',
          rpcUrl: 'https://api.mainnet-beta.solana.com',
          // programId: MISSING
        },
      ],
    } as unknown as ConnectorConfig;

    // When validation runs, then it should throw
    expect(() => validateChainProviders(config)).toThrow(/programId/i);
  });

  it('should throw error when Solana config is missing rpcUrl', () => {
    // Given a Solana config entry missing rpcUrl
    const config = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'solana',
          chainId: 'solana:mainnet',
          // rpcUrl: MISSING
          programId: 'PaymentChannel111111111111111111111111111',
        },
      ],
    } as unknown as ConnectorConfig;

    // When validation runs, then it should throw
    expect(() => validateChainProviders(config)).toThrow(/rpcUrl/i);
  });

  it('should throw error when Mina config is missing graphqlUrl', () => {
    // Given a Mina config entry missing graphqlUrl
    const config = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'mina',
          chainId: 'mina:mainnet',
          // graphqlUrl: MISSING
          zkAppAddress: 'B62qkRodi7nj6W1geB12UuW2XAx2yidWZCcDthJvkf9G4A6G5GFasVQ',
        },
      ],
    } as unknown as ConnectorConfig;

    // When validation runs, then it should throw
    expect(() => validateChainProviders(config)).toThrow(/graphqlUrl/i);
  });

  it('should throw error when Mina config is missing zkAppAddress', () => {
    // Given a Mina config entry missing zkAppAddress
    const config = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'mina',
          chainId: 'mina:mainnet',
          graphqlUrl: 'https://graphql.minaprotocol.com/graphql',
          // zkAppAddress: MISSING
        },
      ],
    } as unknown as ConnectorConfig;

    // When validation runs, then it should throw
    expect(() => validateChainProviders(config)).toThrow(/zkAppAddress/i);
  });
});

describe('EVM config missing chainId validation', () => {
  it('should throw error when config entry is missing chainId', () => {
    // Given a config entry missing the chainId field
    const config = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'evm',
          // chainId: MISSING
          rpcUrl: 'https://mainnet.base.org',
          registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
          keyId: 'evm-treasury-key',
        },
      ],
    } as unknown as ConnectorConfig;

    // When validation runs, then it should throw
    expect(() => validateChainProviders(config)).toThrow(/chainId/i);
  });
});

// ---------------------------------------------------------------------------
// T-32.7-10: ChainProviderConfigEntry type compiles with ProviderConfig subtypes
// ---------------------------------------------------------------------------

describe('ChainProviderConfigEntry type compilation (T-32.7-10)', () => {
  it('should export validateChainProviders from config/types', () => {
    // validateChainProviders is imported at the top of this file
    expect(typeof validateChainProviders).toBe('function');
  });

  it('should compile ChainProviderConfigEntry with EVMProviderConfig subtype', () => {
    // Given an EVM config entry matching ChainProviderConfigEntry shape
    const evmEntry = {
      chainType: 'evm' as const,
      chainId: 'evm:8453',
      rpcUrl: 'https://mainnet.base.org',
      registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
      keyId: 'evm-treasury-key',
    };

    // Then it should satisfy ChainProviderConfigEntry constraints
    expect(evmEntry.chainType).toBe('evm');
    expect(evmEntry.chainId).toBeDefined();
  });

  it('should compile ChainProviderConfigEntry with SolanaProviderConfig subtype', () => {
    // Given a Solana config entry matching ChainProviderConfigEntry shape
    const solanaEntry = {
      chainType: 'solana' as const,
      chainId: 'solana:mainnet',
      rpcUrl: 'https://api.mainnet-beta.solana.com',
      programId: 'PaymentChannel111111111111111111111111111',
    };

    // Then it should satisfy ChainProviderConfigEntry constraints
    expect(solanaEntry.chainType).toBe('solana');
    expect(solanaEntry.chainId).toBeDefined();
  });

  it('should compile ChainProviderConfigEntry with MinaProviderConfig subtype', () => {
    // Given a Mina config entry matching ChainProviderConfigEntry shape
    const minaEntry = {
      chainType: 'mina' as const,
      chainId: 'mina:mainnet',
      graphqlUrl: 'https://graphql.minaprotocol.com/graphql',
      zkAppAddress: 'B62qkRodi7nj6W1geB12UuW2XAx2yidWZCcDthJvkf9G4A6G5GFasVQ',
    };

    // Then it should satisfy ChainProviderConfigEntry constraints
    expect(minaEntry.chainType).toBe('mina');
    expect(minaEntry.chainId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Gap-fill tests: additional AC coverage
// ---------------------------------------------------------------------------

describe('AC 1: validateChainProviders passes for valid multi-provider configs', () => {
  it('should pass validation for an array of valid EVM provider configs', () => {
    const config: ConnectorConfig = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'evm',
          chainId: 'evm:8453',
          rpcUrl: 'https://mainnet.base.org',
          registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
          keyId: 'evm-treasury-key',
        },
        {
          chainType: 'evm',
          chainId: 'evm:42161',
          rpcUrl: 'https://arb1.arbitrum.io/rpc',
          registryAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
          keyId: 'evm-arb-key',
        },
      ],
    };

    expect(() => validateChainProviders(config)).not.toThrow();
  });

  it('should pass validation for mixed chain type provider configs', () => {
    const config: ConnectorConfig = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'evm',
          chainId: 'evm:8453',
          rpcUrl: 'https://mainnet.base.org',
          registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
          keyId: 'evm-treasury-key',
        },
        {
          chainType: 'solana',
          chainId: 'solana:mainnet',
          rpcUrl: 'https://api.mainnet-beta.solana.com',
          programId: 'PaymentChannel111111111111111111111111111',
        },
        {
          chainType: 'mina',
          chainId: 'mina:mainnet',
          graphqlUrl: 'https://graphql.minaprotocol.com/graphql',
          zkAppAddress: 'B62qkRodi7nj6W1geB12UuW2XAx2yidWZCcDthJvkf9G4A6G5GFasVQ',
        },
      ],
    };

    expect(() => validateChainProviders(config)).not.toThrow();
  });

  it('should pass validation for a single valid Solana provider config', () => {
    const config: ConnectorConfig = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'solana',
          chainId: 'solana:mainnet',
          rpcUrl: 'https://api.mainnet-beta.solana.com',
          programId: 'PaymentChannel111111111111111111111111111',
        },
      ],
    };

    expect(() => validateChainProviders(config)).not.toThrow();
  });

  it('should pass validation for a single valid Mina provider config', () => {
    const config: ConnectorConfig = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'mina',
          chainId: 'mina:mainnet',
          graphqlUrl: 'https://graphql.minaprotocol.com/graphql',
          zkAppAddress: 'B62qkRodi7nj6W1geB12UuW2XAx2yidWZCcDthJvkf9G4A6G5GFasVQ',
        },
      ],
    };

    expect(() => validateChainProviders(config)).not.toThrow();
  });
});

describe('AC 2: multiple peers with different chain fields pass validation', () => {
  it('should pass validation when each peer references a different valid chain', () => {
    const config: ConnectorConfig = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'evm',
          chainId: 'evm:8453',
          rpcUrl: 'https://mainnet.base.org',
          registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
          keyId: 'evm-treasury-key',
        },
        {
          chainType: 'evm',
          chainId: 'evm:42161',
          rpcUrl: 'https://arb1.arbitrum.io/rpc',
          registryAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
          keyId: 'evm-arb-key',
        },
      ],
      peers: [
        {
          id: 'connector-a',
          url: 'ws://connector-a:3000',
          authToken: 'secret-a',
          chain: 'evm:8453',
          evmAddress: '0xabc0000000000000000000000000000000000001',
        },
        {
          id: 'connector-b',
          url: 'ws://connector-b:3001',
          authToken: 'secret-b',
          chain: 'evm:42161',
          evmAddress: '0xdef0000000000000000000000000000000000002',
        },
      ],
    };

    expect(() => validateChainProviders(config)).not.toThrow();
    // Each peer maps to a different chain
    expect(config.peers[0]!.chain).toBe('evm:8453');
    expect(config.peers[1]!.chain).toBe('evm:42161');
  });
});

describe('AC 3: backward compatibility — peers without chain field when chainProviders is present', () => {
  it('should pass validation when peers lack chain field even with chainProviders present', () => {
    // Peers without chain field are valid — they default to primary EVM at runtime
    const config: ConnectorConfig = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'evm',
          chainId: 'evm:8453',
          rpcUrl: 'https://mainnet.base.org',
          registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
          keyId: 'evm-treasury-key',
        },
      ],
      peers: [
        {
          id: 'connector-a',
          url: 'ws://connector-a:3000',
          authToken: 'secret-a',
          // No chain field — should default to primary EVM provider at runtime
          evmAddress: '0xabc0000000000000000000000000000000000001',
        },
      ],
    };

    expect(() => validateChainProviders(config)).not.toThrow();
    expect(config.peers[0]!.chain).toBeUndefined();
  });

  it('should treat empty chainProviders array as legacy mode', () => {
    const config: ConnectorConfig = {
      ...baseConfig,
      chainProviders: [],
      settlementInfra: {
        enabled: true,
        rpcUrl: 'http://anvil:8545',
        registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
        privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        tokenAddress: '0x5678000000000000000000000000000000000001',
      },
    };

    const mockLogger = {
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    };

    // Empty chainProviders should behave like absent — trigger deprecation warning
    validateChainProviders(config, mockLogger);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'config_deprecation' }),
      expect.stringContaining('settlementInfra is deprecated')
    );
  });
});

describe('AC 4: settlementPreference type compatibility with settlement PeerConfig', () => {
  it('should allow "solana" as settlementPreference on settlement PeerConfig', () => {
    // Verify the actual SettlementPeerConfig type accepts 'solana'
    const peer: SettlementPeerConfig = {
      peerId: 'peer-alice',
      address: 'g.alice',
      settlementPreference: 'solana',
      settlementTokens: ['SOL'],
    };
    expect(peer.settlementPreference).toBe('solana');
  });

  it('should allow "mina" as settlementPreference on settlement PeerConfig', () => {
    const peer: SettlementPeerConfig = {
      peerId: 'peer-bob',
      address: 'g.bob',
      settlementPreference: 'mina',
      settlementTokens: ['MINA'],
    };
    expect(peer.settlementPreference).toBe('mina');
  });

  it('should allow "evm" as settlementPreference on settlement PeerConfig', () => {
    const peer: SettlementPeerConfig = {
      peerId: 'peer-charlie',
      address: 'g.charlie',
      settlementPreference: 'evm',
      settlementTokens: ['USDC'],
    };
    expect(peer.settlementPreference).toBe('evm');
  });

  it('should allow "any" as settlementPreference on settlement PeerConfig', () => {
    const peer: SettlementPeerConfig = {
      peerId: 'peer-dave',
      address: 'g.dave',
      settlementPreference: 'any',
      settlementTokens: ['USDC', 'SOL'],
    };
    expect(peer.settlementPreference).toBe('any');
  });

  it('should allow deprecated "both" as settlementPreference on settlement PeerConfig', () => {
    const peer: SettlementPeerConfig = {
      peerId: 'peer-eve',
      address: 'g.eve',
      settlementPreference: 'both',
      settlementTokens: [],
    };
    expect(peer.settlementPreference).toBe('both');
  });
});

describe('AC 5/6: additional validation edge cases', () => {
  it('should throw for first unknown chainType when multiple entries have errors', () => {
    const config = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'bitcoin',
          chainId: 'bitcoin:mainnet',
          rpcUrl: 'https://rpc.bitcoin.example.com',
        },
      ],
    } as unknown as ConnectorConfig;

    expect(() => validateChainProviders(config)).toThrow('Unknown chain type: bitcoin');
  });

  it('should throw for duplicate chainId even across different chain types', () => {
    // Hypothetical: same chainId used for different chain types
    const config = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'evm',
          chainId: 'chain:1',
          rpcUrl: 'https://rpc.example.com',
          registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
          keyId: 'key-1',
        },
        {
          chainType: 'solana',
          chainId: 'chain:1', // DUPLICATE despite different chainType
          rpcUrl: 'https://api.solana.com',
          programId: 'Program111111111111111111111111111111111',
        },
      ],
    } as unknown as ConnectorConfig;

    expect(() => validateChainProviders(config)).toThrow('Duplicate chainId: chain:1');
  });
});

describe('AC 7: peer chain reference edge cases', () => {
  it('should throw when one peer references a valid chain and another references invalid', () => {
    const config: ConnectorConfig = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'evm',
          chainId: 'evm:8453',
          rpcUrl: 'https://mainnet.base.org',
          registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
          keyId: 'evm-treasury-key',
        },
      ],
      peers: [
        {
          id: 'connector-a',
          url: 'ws://connector-a:3000',
          authToken: 'secret-a',
          chain: 'evm:8453', // Valid
          evmAddress: '0xabc0000000000000000000000000000000000001',
        },
        {
          id: 'connector-b',
          url: 'ws://connector-b:3001',
          authToken: 'secret-b',
          chain: 'evm:99999', // Invalid — not registered
          evmAddress: '0xdef0000000000000000000000000000000000002',
        },
      ],
    };

    expect(() => validateChainProviders(config)).toThrow(/connector-b.*evm:99999/);
  });

  it('should allow mix of peers with and without chain field when chainProviders is present', () => {
    const config: ConnectorConfig = {
      ...baseConfig,
      chainProviders: [
        {
          chainType: 'evm',
          chainId: 'evm:8453',
          rpcUrl: 'https://mainnet.base.org',
          registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
          keyId: 'evm-treasury-key',
        },
      ],
      peers: [
        {
          id: 'connector-a',
          url: 'ws://connector-a:3000',
          authToken: 'secret-a',
          chain: 'evm:8453', // Explicit chain
          evmAddress: '0xabc0000000000000000000000000000000000001',
        },
        {
          id: 'connector-b',
          url: 'ws://connector-b:3001',
          authToken: 'secret-b',
          // No chain — defaults at runtime
        },
      ],
    };

    expect(() => validateChainProviders(config)).not.toThrow();
  });
});

describe('Bare config with no settlement configuration', () => {
  it('should pass validation when neither chainProviders nor settlementInfra is present', () => {
    // Given a config with no settlement configuration at all
    const config: ConnectorConfig = {
      ...baseConfig,
    };

    // Then validation should pass (no chain config to validate)
    expect(() => validateChainProviders(config)).not.toThrow();
  });

  it('should not log deprecation warning when neither chainProviders nor settlementInfra is present', () => {
    const config: ConnectorConfig = {
      ...baseConfig,
    };

    const mockLogger = {
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    };

    validateChainProviders(config, mockLogger);
    // No settlementInfra means no deprecation warning
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

describe('ChainProviderConfigEntry type assignability', () => {
  it('should be assignable from a well-typed EVM config with chainId', () => {
    // Compile-time type check: ChainProviderConfigEntry accepts EVM shape
    const entry: ChainProviderConfigEntry = {
      chainType: 'evm',
      chainId: 'evm:8453',
      rpcUrl: 'https://mainnet.base.org',
      registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
      keyId: 'evm-treasury-key',
    };
    expect(entry.chainId).toBe('evm:8453');
    expect(entry.chainType).toBe('evm');
  });

  it('should be assignable from a well-typed Solana config with chainId', () => {
    const entry: ChainProviderConfigEntry = {
      chainType: 'solana',
      chainId: 'solana:mainnet',
      rpcUrl: 'https://api.mainnet-beta.solana.com',
      programId: 'PaymentChannel111111111111111111111111111',
    };
    expect(entry.chainId).toBe('solana:mainnet');
    expect(entry.chainType).toBe('solana');
  });

  it('should be assignable from a well-typed Mina config with chainId', () => {
    const entry: ChainProviderConfigEntry = {
      chainType: 'mina',
      chainId: 'mina:mainnet',
      graphqlUrl: 'https://graphql.minaprotocol.com/graphql',
      zkAppAddress: 'B62qkRodi7nj6W1geB12UuW2XAx2yidWZCcDthJvkf9G4A6G5GFasVQ',
    };
    expect(entry.chainId).toBe('mina:mainnet');
    expect(entry.chainType).toBe('mina');
  });
});
