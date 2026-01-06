/**
 * TypeScript type definitions for Payment Channel SDK (Story 8.7)
 *
 * This file contains types for:
 * - SDK configuration (PaymentChannelSDKConfig)
 * - Local channel state cache (ChannelState)
 * - Off-chain balance proofs (BalanceProof)
 * - Event listeners (ChannelEventListener)
 * - Blockchain events (ChannelOpenedEvent, ChannelClosedEvent, etc.)
 *
 * Source: Epic 8 Story 8.7, docs/architecture/coding-standards.md TypeScript standards
 */

/**
 * Configuration interface for PaymentChannelSDK
 *
 * @property rpcUrl - Base L2 RPC endpoint (e.g., http://localhost:8545 for Anvil)
 * @property privateKey - Connector's private key for signing transactions (hex string with 0x prefix)
 * @property registryAddress - TokenNetworkRegistry contract address from Story 8.2 deployment
 * @property chainId - Chain ID: 1 (Ethereum mainnet), 8453 (Base mainnet), 84532 (Base Sepolia), 31337 (Anvil)
 * @property confirmations - Block confirmations to wait (default: 1 for Anvil, 3 for mainnet)
 *
 * Source: Epic 8 Story 8.7 SDK Interface lines 425-427, Story 8.1 environment configuration
 */
export interface PaymentChannelSDKConfig {
  rpcUrl: string;
  privateKey: string;
  registryAddress: string;
  chainId: number;
  confirmations?: number;
}

/**
 * Local channel state cache structure
 *
 * This interface represents the SDK's in-memory representation of a payment channel,
 * combining on-chain contract state with local metadata for performance optimization.
 *
 * Source: Epic 8 Story 8.7 SDK Interface lines 412-423
 */
export interface ChannelState {
  /** Channel identifier (bytes32 as hex string with 0x prefix) */
  channelId: string;

  /** Channel participants [participant1, participant2] Ethereum addresses */
  participants: [string, string];

  /** Connector's total deposit in the channel (wei) */
  myDeposit: bigint;

  /** Counterparty's total deposit in the channel (wei) */
  theirDeposit: bigint;

  /** Connector's latest nonce (monotonically increasing) */
  myNonce: number;

  /** Counterparty's latest nonce (monotonically increasing) */
  theirNonce: number;

  /** Cumulative amount connector sent to counterparty (wei) */
  myTransferred: bigint;

  /** Cumulative amount counterparty sent to connector (wei) */
  theirTransferred: bigint;

  /** Channel lifecycle status */
  status: 'opened' | 'closed' | 'settled';

  /** ERC20 token contract address */
  tokenAddress: string;

  /** TokenNetwork contract address */
  tokenNetworkAddress: string;

  /** Settlement challenge period timeout in seconds (e.g., 3600 for 1 hour) */
  settlementTimeout: number;

  /** Unix timestamp (milliseconds) when channel was closed (undefined if not closed) */
  closedAt?: number;
}

/**
 * Off-chain balance proof structure for EIP-712 signing
 *
 * This matches the Solidity BalanceProof struct from Story 8.4.
 * Used for off-chain payment authorization and settlement disputes.
 *
 * Source: Epic 8 Story 8.4 BalanceProof structure lines 209-216
 */
export interface BalanceProof {
  /** Channel identifier (bytes32 hex with 0x prefix) */
  channelId: string;

  /** Nonce - monotonically increasing counter to prevent replay attacks */
  nonce: number;

  /** Cumulative amount transferred to counterparty (wei) */
  transferredAmount: bigint;

  /** Amount locked in pending HTLCs (wei, 0n for MVP - no hash-locked transfers) */
  lockedAmount: bigint;

  /** Merkle root of pending locks (bytes32 hex, "0x" + "0".repeat(64) for MVP) */
  locksRoot: string;
}

/**
 * Event listener callback interface for blockchain events
 *
 * Allows SDK users to register callbacks for real-time channel state updates
 * from on-chain events (ChannelOpened, ChannelClosed, etc.).
 *
 * Source: Epic 8 Story 8.7 AC 9, Story 8.3 TokenNetwork events
 */
export interface ChannelEventListener {
  /** Called when a new channel is opened on-chain */
  onChannelOpened?: (event: ChannelOpenedEvent) => void;

  /** Called when a channel is closed on-chain */
  onChannelClosed?: (event: ChannelClosedEvent) => void;

  /** Called when a channel is settled on-chain */
  onChannelSettled?: (event: ChannelSettledEvent) => void;

  /** Called when a deposit is made to a channel */
  onChannelDeposit?: (event: ChannelDepositEvent) => void;
}

/**
 * ChannelOpened event data
 *
 * Emitted when TokenNetwork.openChannel() succeeds on-chain.
 *
 * Source: Story 8.3 TokenNetwork events, ethers.js event parsing
 */
export interface ChannelOpenedEvent {
  /** Channel identifier generated on-chain (bytes32 hex) */
  channelId: string;

  /** First participant Ethereum address */
  participant1: string;

  /** Second participant Ethereum address */
  participant2: string;

  /** ERC20 token contract address for this channel */
  tokenAddress: string;

  /** Block number where event was emitted */
  blockNumber: number;

  /** Transaction hash of the openChannel transaction */
  transactionHash: string;
}

/**
 * ChannelClosed event data
 *
 * Emitted when TokenNetwork.closeChannel() succeeds on-chain.
 * Marks the start of the settlement challenge period.
 *
 * Source: Story 8.4 channel closure events, challenge period triggering
 */
export interface ChannelClosedEvent {
  /** Channel identifier (bytes32 hex) */
  channelId: string;

  /** Participant who initiated the channel closure */
  closingParticipant: string;

  /** Nonce from the submitted balance proof */
  nonce: number;

  /** Block number where event was emitted */
  blockNumber: number;

  /** Transaction hash of the closeChannel transaction */
  transactionHash: string;
}

/**
 * ChannelSettled event data
 *
 * Emitted when TokenNetwork.settleChannel() succeeds on-chain.
 * Final balances are calculated and tokens distributed.
 *
 * Source: Story 8.4 settlement events, channel lifecycle completion
 */
export interface ChannelSettledEvent {
  /** Channel identifier (bytes32 hex) */
  channelId: string;

  /** Final balance for participant1 (wei) */
  participant1Balance: bigint;

  /** Final balance for participant2 (wei) */
  participant2Balance: bigint;

  /** Block number where event was emitted */
  blockNumber: number;

  /** Transaction hash of the settleChannel transaction */
  transactionHash: string;
}

/**
 * ChannelDeposit event data
 *
 * Emitted when TokenNetwork.setTotalDeposit() succeeds on-chain.
 * Tracks deposit changes from both participants.
 *
 * Source: Story 8.3 deposit tracking, channel balance monitoring
 */
export interface ChannelDepositEvent {
  /** Channel identifier (bytes32 hex) */
  channelId: string;

  /** Participant who made the deposit */
  participant: string;

  /** New total deposit for this participant (wei) */
  totalDeposit: bigint;

  /** Block number where event was emitted */
  blockNumber: number;

  /** Transaction hash of the setTotalDeposit transaction */
  transactionHash: string;
}
