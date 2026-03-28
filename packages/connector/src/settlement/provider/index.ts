/**
 * Settlement Provider Barrel Export
 *
 * Re-exports all public types and classes from the settlement provider module.
 *
 * @module settlement/provider
 */

export {
  type PaymentChannelProvider,
  type ProviderChannelState,
  type ProviderEventType,
  type ProviderEvent,
  type ProviderEventCallback,
  type ProviderEventSubscription,
  type OpenChannelResult,
  type TxResult,
  type BalanceProofParams,
  type VerifyBalanceProofParams,
  type ProviderConfig,
  type EVMProviderConfig,
  type SolanaProviderConfig,
  type MinaProviderConfig,
} from './payment-channel-provider';

export {
  ChainProviderRegistry,
  ChainProviderAlreadyRegisteredError,
  type RegistryPeerConfig,
  type ChainProviderFactory,
} from './chain-provider-registry';

export {
  EVMPaymentChannelProvider,
  createEVMProviderFactory,
} from './evm-payment-channel-provider';

export {
  SolanaPaymentChannelProvider,
  createSolanaProviderFactory,
} from './solana-payment-channel-provider';

export {
  MinaPaymentChannelProvider,
  createMinaProviderFactory,
  type MinaProviderOptions,
} from './mina-payment-channel-provider';
