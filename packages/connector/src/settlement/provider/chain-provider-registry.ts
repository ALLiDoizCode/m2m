/**
 * Chain Provider Registry
 *
 * Manages payment channel provider instances by chain identifier with dynamic
 * registration and peer-based lookup. Any settlement service can resolve the
 * correct chain provider for a given peer without hardcoding provider references.
 *
 * Epic 32 Story 32.2: Create Chain Provider Registry
 *
 * @module chain-provider-registry
 */

import type { BlockchainType } from '../../btp/btp-claim-types';
import type { PaymentChannelProvider, ProviderConfig } from './payment-channel-provider';

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

/**
 * Thrown when attempting to register a provider for a chain ID that already
 * has a registered provider.
 */
export class ChainProviderAlreadyRegisteredError extends Error {
  constructor(chainId: string) {
    super(`Provider already registered for chain: ${chainId}`);
    this.name = 'ChainProviderAlreadyRegisteredError';
  }
}

// ---------------------------------------------------------------------------
// Peer Config Interface
// ---------------------------------------------------------------------------

/**
 * Minimal peer configuration interface used for provider lookup.
 *
 * Intentionally narrow to avoid coupling the registry to the full `PeerConfig`
 * type. The `chain` field references a registered provider's `chainId`.
 */
export interface RegistryPeerConfig {
  /** Peer identifier — included for structural compatibility and future logging. */
  peerId: string;
  /** Chain reference (e.g., `'evm:8453'`) mapping to a registered provider's `chainId`. */
  chain?: string;
}

// ---------------------------------------------------------------------------
// Factory Type
// ---------------------------------------------------------------------------

/**
 * Factory function that constructs a `PaymentChannelProvider` from a
 * `ProviderConfig`. Each chain type registers its own factory.
 */
export type ChainProviderFactory = (config: ProviderConfig) => PaymentChannelProvider;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Registry that manages `PaymentChannelProvider` instances keyed by their
 * `chainId` property (e.g., `'evm:8453'`).
 *
 * Supports:
 * - Registration and retrieval by chain type + chain ID
 * - Peer-based lookup via `RegistryPeerConfig`
 * - Configuration-driven initialization via `fromConfig`
 * - Idempotent deregistration
 */
export class ChainProviderRegistry {
  /** Internal storage keyed by provider `chainId`. */
  private readonly providers = new Map<string, PaymentChannelProvider>();

  /**
   * Register a provider instance.
   *
   * @param provider - The provider to register
   * @throws {ChainProviderAlreadyRegisteredError} If a provider is already registered for the
   *   provider's `chainId`
   */
  register(provider: PaymentChannelProvider): void {
    const { chainId } = provider;
    if (this.providers.has(chainId)) {
      throw new ChainProviderAlreadyRegisteredError(chainId);
    }
    this.providers.set(chainId, provider);
  }

  /**
   * Retrieve a provider by chain type and chain ID.
   *
   * Validates that the retrieved provider's `chainType` matches the requested
   * type as a safety check.
   *
   * @param chainType - The blockchain family to look up
   * @param chainId - The namespaced chain identifier (e.g., `'evm:8453'`)
   * @returns The registered provider, or `undefined` if not found or type mismatch
   */
  getProvider(chainType: BlockchainType, chainId: string): PaymentChannelProvider | undefined {
    const provider = this.providers.get(chainId);
    if (provider && provider.chainType !== chainType) {
      return undefined;
    }
    return provider;
  }

  /**
   * Return all registered providers.
   *
   * @returns Array of all registered `PaymentChannelProvider` instances
   */
  getAllProviders(): PaymentChannelProvider[] {
    return [...this.providers.values()];
  }

  /**
   * Idempotent removal of a provider by chain ID.
   *
   * Does not throw if no provider is registered for the given chain ID.
   *
   * @param chainId - The namespaced chain identifier to remove
   */
  deregister(chainId: string): void {
    this.providers.delete(chainId);
  }

  /**
   * Look up the provider for a given peer configuration.
   *
   * When the peer's `chain` field is `undefined`, returns `undefined`
   * immediately — this supports backward compatibility with legacy peers.
   *
   * @param peerConfig - Minimal peer configuration containing an optional `chain` reference
   * @returns The matching provider, or `undefined` if not found or `chain` is unset
   */
  getProviderForPeer(peerConfig: RegistryPeerConfig): PaymentChannelProvider | undefined {
    if (!peerConfig.chain) {
      return undefined;
    }
    return this.providers.get(peerConfig.chain);
  }

  /**
   * Create a registry from an array of provider configurations and a map of
   * chain-type-specific factory functions.
   *
   * @param providerConfigs - Array of provider configurations to instantiate
   * @param factories - Map from `BlockchainType` to factory function
   * @returns A fully populated `ChainProviderRegistry`
   * @throws {Error} If no factory is registered for a config's `chainType`
   */
  static fromConfig(
    providerConfigs: ProviderConfig[],
    factories: Map<BlockchainType, ChainProviderFactory>
  ): ChainProviderRegistry {
    const registry = new ChainProviderRegistry();

    for (const config of providerConfigs) {
      const factory = factories.get(config.chainType);
      if (!factory) {
        throw new Error(`No factory registered for chain type: ${config.chainType}`);
      }
      const provider = factory(config);
      registry.register(provider);
    }

    return registry;
  }
}
