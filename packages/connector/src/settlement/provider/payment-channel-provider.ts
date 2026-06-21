/**
 * Chain-Agnostic Payment Channel Provider Interface
 *
 * Defines the abstract interface that all blockchain-specific payment channel providers
 * must implement. This enables the settlement layer to interact with any supported chain
 * (EVM, Solana, Mina) through a unified API without chain-specific coupling.
 *
 * Epic 32 Story 32.1: Define PaymentChannelProvider Interface
 *
 * @module payment-channel-provider
 */

import type { BlockchainType } from '../../btp/btp-claim-types';

// ---------------------------------------------------------------------------
// Channel State
// ---------------------------------------------------------------------------

/**
 * Chain-agnostic representation of a payment channel's on-chain state.
 *
 * All amounts use `bigint` for precision. Participants are represented as
 * chain-native address strings (e.g., `0x...` for EVM, base58 for Solana).
 */
export interface ProviderChannelState {
  /** Unique identifier for the channel (chain-specific format) */
  channelId: string;
  /** Current lifecycle status of the channel */
  status: 'opened' | 'closed' | 'settled';
  /** Ordered list of channel participant addresses */
  participants: string[];
  /** Total deposit amount in the channel (native precision) */
  deposit: bigint;
}

// ---------------------------------------------------------------------------
// Event Types
// ---------------------------------------------------------------------------

/** Enumeration of on-chain events that providers can emit. */
export type ProviderEventType =
  | 'channel_opened'
  | 'channel_closed'
  | 'channel_settled'
  | 'channel_deposited'
  | 'channel_claimed';

/** Payload delivered to event subscribers. */
export interface ProviderEvent {
  /** The type of event that occurred */
  type: ProviderEventType;
  /** Channel associated with the event */
  channelId: string;
  /** Chain-specific transaction hash (if applicable) */
  txHash?: string;
  /** Arbitrary chain-specific metadata */
  data?: Record<string, unknown>;
}

/** Callback signature for event listeners. */
export type ProviderEventCallback = (event: ProviderEvent) => void;

/**
 * Handle returned by `subscribeToEvents` that allows callers to unsubscribe.
 *
 * Uses a simple callback pattern (not a full EventEmitter) for testability.
 */
export interface ProviderEventSubscription {
  /** Stop receiving events and clean up resources */
  unsubscribe(): void;
}

// ---------------------------------------------------------------------------
// Method Parameter / Result Types
// ---------------------------------------------------------------------------

/** Result of successfully opening a payment channel. */
export interface OpenChannelResult {
  /** The newly created channel identifier */
  channelId: string;
  /** Transaction hash of the on-chain open operation */
  txHash: string;
}

/** Generic result containing only a transaction hash. */
export interface TxResult {
  /** Transaction hash of the on-chain operation */
  txHash: string;
}

/** Parameters for signing a balance proof off-chain. */
export interface BalanceProofParams {
  /** Channel to sign the proof for */
  channelId: string;
  /** Monotonically increasing nonce */
  nonce: number;
  /** Cumulative transferred amount (string for bigint precision) */
  transferredAmount: string;
  /** Locked amount for pending transfers */
  lockedAmount: string;
  /** Merkle root of locked transfers */
  locksRoot: string;
  /**
   * Mina-only: revealed balance for participant B in the Poseidon balance
   * commitment `hash([balanceA, balanceB, salt])`, where `transferredAmount`
   * is participant A's balance. Required for true two-party (bidirectional)
   * settlement; defaults to `0n` (unidirectional) when omitted. Ignored by the
   * EVM and Solana providers.
   */
  balanceB?: string;
  /**
   * Mina-only: salt for the Poseidon balance commitment. Preserves the
   * commitment privacy the zkApp was designed for — a `0n` salt makes
   * `hash([balanceA, balanceB, 0])` trivially brute-forceable. Callers
   * settling real bidirectional channels MUST provide a non-zero salt.
   * Defaults to `0n` when omitted. Ignored by the EVM and Solana providers.
   */
  salt?: string;
  /**
   * Mina-only: participant B's signature for dual-party authorization. The
   * `signature` argument passed to {@link PaymentChannelProvider.claimFromChannel}
   * is participant A's signature; this is participant B's. Required for true
   * two-party Mina settlement — the zkApp verifies each signature against a
   * distinct participant key, so reusing one signature for both fails on-chain.
   * Ignored by the EVM and Solana providers.
   */
  signatureB?: string;
  /**
   * Mina-only: tokenId carried by the inbound `MinaClaimMessage` (#192). When
   * supplied, the Mina provider asserts it matches the channel's configured USDC
   * tokenId before claiming — the channel proof no longer binds token amounts, so
   * the SDK is the enforcement point against settling a claim for the wrong token.
   * Ignored by the EVM and Solana providers.
   */
  tokenId?: string;
  /**
   * Solana-only: base58 public key of the key that produced `signature`.
   * Ed25519 signatures are not public-key-recoverable, so the on-chain Ed25519
   * precompile must be told which key to verify against. For inbound peer claims
   * this is the counterparty's pubkey (the claim's `signerPublicKey`); omitting
   * it makes the precompile verify the signature against the submitting signer's
   * key and fail preflight. Ignored by the EVM and Mina providers.
   */
  signerPublicKey?: string;
}

/** Parameters for verifying a balance proof off-chain. */
export interface VerifyBalanceProofParams {
  /** Channel the proof is associated with */
  channelId: string;
  /** Monotonically increasing nonce */
  nonce: number;
  /** Cumulative transferred amount (string for bigint precision) */
  transferredAmount: string;
  /** Locked amount for pending transfers */
  lockedAmount: string;
  /** Merkle root of locked transfers */
  locksRoot: string;
  /** Signature to verify */
  signature: string;
  /** Address of the expected signer */
  signerAddress: string;
}

// ---------------------------------------------------------------------------
// Provider Interface
// ---------------------------------------------------------------------------

/**
 * Chain-agnostic payment channel provider interface.
 *
 * All settlement services delegate to this interface, allowing any supported
 * blockchain to be plugged in without changing higher-level orchestration logic.
 *
 * Method signatures mirror the existing `PaymentChannelSDK` to minimize
 * Story 32.3 adapter complexity.
 */
export interface PaymentChannelProvider {
  /** The blockchain family this provider targets (e.g., `'evm'`, `'solana'`, `'mina'`). */
  readonly chainType: BlockchainType;

  /**
   * Namespaced chain identifier (e.g., `'evm:8453'`, `'solana:mainnet'`).
   * Supports multi-chain deployments where the same `chainType` may appear
   * multiple times with different networks.
   */
  readonly chainId: string;

  /**
   * Open a new payment channel between two participants.
   *
   * @param participant - Address of the counterparty
   * @param settlementTimeout - Timeout period (chain-specific units)
   * @returns Channel identifier and transaction hash
   */
  openChannel(participant: string, settlementTimeout: number): Promise<OpenChannelResult>;

  /**
   * Deposit funds into an existing channel.
   *
   * @param channelId - Target channel identifier
   * @param amount - Amount to deposit (string for bigint precision)
   * @returns Transaction hash
   */
  deposit(channelId: string, amount: string): Promise<TxResult>;

  /**
   * Submit a balance proof to claim funds from a channel.
   *
   * @param channelId - Target channel identifier
   * @param balanceProof - The balance proof parameters
   * @param signature - Signed balance proof
   * @returns Transaction hash
   */
  claimFromChannel(
    channelId: string,
    balanceProof: BalanceProofParams,
    signature: string
  ): Promise<TxResult>;

  /**
   * Initiate cooperative or unilateral channel closure.
   *
   * @param channelId - Channel to close
   * @returns Transaction hash
   */
  closeChannel(channelId: string): Promise<TxResult>;

  /**
   * Settle a closed channel after the challenge period expires.
   *
   * @param channelId - Channel to settle
   * @returns Transaction hash
   */
  settleChannel(channelId: string): Promise<TxResult>;

  /**
   * Sign a balance proof off-chain without submitting a transaction.
   *
   * @param params - Balance proof parameters to sign
   * @returns Hex-encoded signature string
   */
  signBalanceProof(params: BalanceProofParams): Promise<string>;

  /**
   * Verify an off-chain balance proof signature.
   *
   * @param params - Parameters including the signature to verify
   * @returns `true` if the signature is valid, `false` otherwise
   */
  verifyBalanceProof(params: VerifyBalanceProofParams): Promise<boolean>;

  /**
   * Query the current on-chain state of a channel.
   *
   * @param channelId - Channel to query
   * @returns Chain-agnostic channel state
   */
  getChannelState(channelId: string): Promise<ProviderChannelState>;

  /**
   * Subscribe to on-chain events for a specific channel.
   *
   * @param channelId - Channel to watch
   * @param callback - Function invoked when an event occurs
   * @returns Subscription handle with an `unsubscribe()` method
   */
  subscribeToEvents(channelId: string, callback: ProviderEventCallback): ProviderEventSubscription;
}

// ---------------------------------------------------------------------------
// Provider Config Discriminated Union
// ---------------------------------------------------------------------------

/**
 * EVM-specific provider configuration.
 */
export interface EVMProviderConfig {
  /** Discriminator */
  chainType: 'evm';
  /** JSON-RPC endpoint URL */
  rpcUrl: string;
  /** TokenNetworkRegistry contract address */
  registryAddress: string;
  /** Key identifier for signing operations (raw private key for env backend) */
  keyId: string;
  /** M2M token contract address */
  tokenAddress: string;
  /** Optional settlement tuning parameters */
  settlementOptions?: {
    threshold?: string;
    settlementTimeoutSecs?: number;
    initialDepositMultiplier?: number;
    pollingIntervalMs?: number;
    ledgerSnapshotPath?: string;
    ledgerPersistIntervalMs?: number;
  };
}

/**
 * Solana provider configuration.
 *
 * Configures a Solana payment channel provider for the chain abstraction layer.
 * Uses `@solana/kit` for RPC communication and Ed25519 signing.
 *
 * **Interface compatibility notes for PaymentChannelProvider:**
 * - `channelId` maps to PDA (program-derived address) of the channel state account
 * - `signBalanceProof` uses Ed25519 signatures (not EIP-712)
 * - `subscribeToEvents` maps to `onAccountChange` WebSocket subscriptions
 * - `getChannelState` deserializes Anchor/Borsh-encoded PDA account data
 * - `verifyBalanceProof` uses `@solana/kit` Ed25519 signature verification
 * - Amounts are in lamports (u64), serialized as string for bigint precision
 */
export interface SolanaProviderConfig {
  /** Discriminator */
  chainType: 'solana';
  /** Solana cluster RPC endpoint (HTTP) */
  rpcUrl: string;
  /** Solana WebSocket endpoint for account subscriptions (derived from rpcUrl if absent) */
  wsUrl?: string;
  /** Payment channel program ID (base58-encoded) */
  programId: string;
  /** Key identifier for Ed25519 signing operations */
  keyId: string;
  /** Solana cluster name for chain ID namespacing (e.g., 'mainnet-beta', 'devnet') */
  cluster?: string;
  /** SPL token mint address (base58-encoded) for the payment channel token */
  tokenMint?: string;
}

/**
 * Mina provider configuration.
 *
 * Configures a Mina payment channel provider for the chain abstraction layer.
 * Uses `MinaPaymentChannelSDK` for GraphQL communication and Poseidon-based signing.
 *
 * **Interface compatibility notes for PaymentChannelProvider:**
 * - `channelId` maps to zkApp address (base58-encoded public key)
 * - `signBalanceProof` uses Poseidon commitments (not EIP-712 or Ed25519)
 * - `subscribeToEvents` maps to interval-based polling with state-diffing
 * - `getChannelState` reads zkApp on-chain state via GraphQL
 * - `verifyBalanceProof` uses zk-SNARK proof verification
 * - Amounts are in nanomina, serialized as string for bigint precision
 */
export interface MinaProviderConfig {
  /** Discriminator */
  chainType: 'mina';
  /** Mina GraphQL endpoint */
  graphqlUrl: string;
  /** zkApp address for the payment channel contract */
  zkAppAddress: string;
  /** Key identifier for signing operations */
  keyId?: string;
  /** Mina token ID (native MINA or custom fungible token) */
  tokenId?: string;
  /**
   * Base58 address of the USDC token-owner (`UsdcChannelToken`) zkApp. When set,
   * the channel custodies the USDC custom token: the SDK composes the in-proof
   * `depositToChannel` / `settleFromChannel` owner methods on deposit/settle and
   * derives the channel's tokenId from this owner. Omit for legacy native-MINA
   * channels.
   */
  tokenAddress?: string;
  /** Mina network name for chain ID namespacing (e.g., 'devnet', 'mainnet') */
  network?: string;
  /**
   * Fee applied to state-changing zkApp transactions, in nanomina (decimal
   * string for bigint precision). Defaults to 0.1 MINA (100_000_000 nanomina)
   * when omitted; real networks reject zero-fee zkApp transactions (Issue #126).
   */
  txFeeNanomina?: string;
}

/**
 * Discriminated union of all supported provider configurations.
 *
 * Use the `chainType` field to narrow to a specific config subtype.
 */
export type ProviderConfig = EVMProviderConfig | SolanaProviderConfig | MinaProviderConfig;
