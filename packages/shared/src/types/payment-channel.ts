/**
 * Payment Channel Types
 * TypeScript definitions for off-chain payment channel operations
 * Source: Epic 8 Story 8.7 - Off-Chain Payment Channel SDK
 */

/**
 * Channel lifecycle states
 * Maps to TokenNetwork.sol ChannelState enum
 */
export type ChannelStatus = 'opened' | 'closed' | 'settled';

/**
 * Channel state representation
 * Source: Epic 8 Story 8.3 - Channel State Structure
 */
export interface ChannelState {
  channelId: string; // bytes32 channel identifier
  participants: [string, string]; // Participant addresses (lexicographically ordered)
  myDeposit: bigint; // My total deposited amount
  theirDeposit: bigint; // Counterparty total deposited amount
  myNonce: number; // My balance proof nonce (monotonic)
  theirNonce: number; // Their balance proof nonce (monotonic)
  myTransferred: bigint; // Cumulative amount I've sent to them
  theirTransferred: bigint; // Cumulative amount they've sent to me
  status: ChannelStatus; // Channel lifecycle status
  settlementTimeout: number; // Challenge period duration (seconds)
  closedAt?: number; // Block timestamp when closed (if status='closed')
  openedAt: number; // Block timestamp when opened
}

/**
 * Off-chain balance proof structure
 * Source: Epic 8 Story 8.4 - Balance Proof Structure
 */
export interface BalanceProof {
  channelId: string; // bytes32 - Channel identifier
  nonce: number; // uint256 - Monotonically increasing state counter
  transferredAmount: bigint; // uint256 - Cumulative amount sent to counterparty
  lockedAmount: bigint; // uint256 - Amount in pending conditional transfers
  locksRoot: string; // bytes32 - Merkle root of hash-locked transfers
}

/**
 * Event emitted when a channel is opened
 * Source: TokenNetwork.sol ChannelOpened event
 */
export interface ChannelOpenedEvent {
  type: 'ChannelOpened';
  channelId: string;
  participant1: string;
  participant2: string;
  settlementTimeout: number;
}

/**
 * Event emitted when a channel is closed
 * Source: TokenNetwork.sol ChannelClosed event
 */
export interface ChannelClosedEvent {
  type: 'ChannelClosed';
  channelId: string;
  closingParticipant: string;
  nonce: number;
  balanceHash: string;
}

/**
 * Event emitted when a channel is settled
 * Source: TokenNetwork.sol ChannelSettled event
 */
export interface ChannelSettledEvent {
  type: 'ChannelSettled';
  channelId: string;
  participant1Amount: bigint;
  participant2Amount: bigint;
}

/**
 * Event emitted when a cooperative settlement occurs
 * Source: TokenNetwork.sol ChannelCooperativeSettled event
 */
export interface ChannelCooperativeSettledEvent {
  type: 'ChannelCooperativeSettled';
  channelId: string;
  participant1Amount: bigint;
  participant2Amount: bigint;
}

/**
 * Union type of all channel events
 */
export type ChannelEvent =
  | ChannelOpenedEvent
  | ChannelClosedEvent
  | ChannelSettledEvent
  | ChannelCooperativeSettledEvent;
