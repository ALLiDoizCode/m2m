/**
 * Telemetry Event Type Definitions
 *
 * This module provides TypeScript type definitions for telemetry events emitted
 * by the connector to the dashboard for real-time visualization.
 *
 * Event types support settlement monitoring, account balance tracking, payment
 * channel lifecycle tracking, and network activity visualization.
 *
 * @packageDocumentation
 */

import {
  PaymentChannelOpenedEvent,
  PaymentChannelBalanceUpdateEvent,
  PaymentChannelSettledEvent,
} from './payment-channel-telemetry';

/**
 * Telemetry Event Type Discriminator
 *
 * Enumeration of all telemetry event types emitted by the connector.
 * Each event type corresponds to a specific telemetry event interface.
 */
export enum TelemetryEventType {
  /** Node status event - emitted on startup/shutdown/state change */
  NODE_STATUS = 'NODE_STATUS',
  /** Packet received event - emitted when ILP packet received */
  PACKET_RECEIVED = 'PACKET_RECEIVED',
  /** Packet forwarded event - emitted when ILP packet forwarded */
  PACKET_FORWARDED = 'PACKET_FORWARDED',
  /** Account balance event - emitted when account balance changes (Story 6.8) */
  ACCOUNT_BALANCE = 'ACCOUNT_BALANCE',
  /** Settlement triggered event - emitted when settlement threshold exceeded (Story 6.6) */
  SETTLEMENT_TRIGGERED = 'SETTLEMENT_TRIGGERED',
  /** Settlement completed event - emitted when settlement execution completes (Story 6.7) */
  SETTLEMENT_COMPLETED = 'SETTLEMENT_COMPLETED',
  /** Agent balance changed event - emitted when agent wallet balance changes (Story 11.3) */
  AGENT_BALANCE_CHANGED = 'AGENT_BALANCE_CHANGED',
  /** Agent wallet funded event - emitted when agent wallet receives initial funding (Story 11.4) */
  AGENT_WALLET_FUNDED = 'AGENT_WALLET_FUNDED',
  /** Funding rate limit exceeded event - emitted when rate limit hit (Story 11.4) */
  FUNDING_RATE_LIMIT_EXCEEDED = 'FUNDING_RATE_LIMIT_EXCEEDED',
  /** Funding transaction confirmed event - emitted when funding tx confirmed on-chain (Story 11.4) */
  FUNDING_TRANSACTION_CONFIRMED = 'FUNDING_TRANSACTION_CONFIRMED',
  /** Funding transaction failed event - emitted when funding tx fails (Story 11.4) */
  FUNDING_TRANSACTION_FAILED = 'FUNDING_TRANSACTION_FAILED',
  /** Agent wallet state changed event - emitted on wallet lifecycle state transitions (Story 11.5) */
  AGENT_WALLET_STATE_CHANGED = 'AGENT_WALLET_STATE_CHANGED',
  /** Payment channel opened event - emitted when payment channel created on-chain (Story 8.10) */
  PAYMENT_CHANNEL_OPENED = 'PAYMENT_CHANNEL_OPENED',
  /** Payment channel balance update event - emitted when off-chain balance proofs updated (Story 8.10) */
  PAYMENT_CHANNEL_BALANCE_UPDATE = 'PAYMENT_CHANNEL_BALANCE_UPDATE',
  /** Payment channel settled event - emitted when channel settlement completes on-chain (Story 8.10) */
  PAYMENT_CHANNEL_SETTLED = 'PAYMENT_CHANNEL_SETTLED',
  /** XRP payment channel opened event - emitted when XRP channel created on-ledger (Story 9.7) */
  XRP_CHANNEL_OPENED = 'XRP_CHANNEL_OPENED',
  /** XRP payment channel claimed event - emitted when XRP claim submitted to ledger (Story 9.7) */
  XRP_CHANNEL_CLAIMED = 'XRP_CHANNEL_CLAIMED',
  /** XRP payment channel closed event - emitted when XRP channel closure initiated (Story 9.7) */
  XRP_CHANNEL_CLOSED = 'XRP_CHANNEL_CLOSED',
}

/**
 * Settlement State Enumeration
 *
 * Tracks the current state of settlement for a peer account.
 * Used by SettlementMonitor (Story 6.6) to prevent duplicate settlement triggers.
 */
export enum SettlementState {
  /** No settlement in progress, normal operation */
  IDLE = 'IDLE',
  /** Settlement threshold exceeded, settlement queued */
  SETTLEMENT_PENDING = 'SETTLEMENT_PENDING',
  /** Settlement execution in progress */
  SETTLEMENT_IN_PROGRESS = 'SETTLEMENT_IN_PROGRESS',
}

/**
 * Account Balance Telemetry Event
 *
 * Emitted whenever an account balance changes due to packet forwarding or settlement.
 * Sent by AccountManager (Story 6.3) after recordPacketTransfers() or recordSettlement().
 *
 * **BigInt Serialization:** All balance fields are strings (bigint values serialized as
 * strings for JSON compatibility). Use `BigInt(value)` to convert back to bigint.
 *
 * **Emission Points:**
 * - After packet forward: AccountManager.recordPacketTransfers()
 * - After settlement: AccountManager.recordSettlement()
 *
 * **Dashboard Usage:**
 * - SettlementStatusPanel displays balance table with color-coded thresholds
 * - NetworkGraph shows balance badges on peer nodes
 * - SettlementTimeline tracks balance changes over time
 *
 * @example
 * ```typescript
 * const event: AccountBalanceEvent = {
 *   type: 'ACCOUNT_BALANCE',
 *   nodeId: 'connector-a',
 *   peerId: 'peer-b',
 *   tokenId: 'ILP',
 *   debitBalance: '0',
 *   creditBalance: '1000',
 *   netBalance: '-1000',
 *   creditLimit: '10000',
 *   settlementThreshold: '5000',
 *   settlementState: SettlementState.IDLE,
 *   timestamp: '2026-01-03T12:00:00.000Z'
 * };
 * ```
 */
export interface AccountBalanceEvent {
  /** Event type discriminator */
  type: 'ACCOUNT_BALANCE';
  /** Connector node ID emitting this event */
  nodeId: string;
  /** Peer account ID (connector peered with) */
  peerId: string;
  /** Token ID (e.g., 'ILP', 'ETH', 'XRP') */
  tokenId: string;
  /** Debit balance (amount we owe peer), bigint as string */
  debitBalance: string;
  /** Credit balance (amount peer owes us), bigint as string */
  creditBalance: string;
  /** Net balance (debitBalance - creditBalance), bigint as string */
  netBalance: string;
  /** Credit limit (max peer can owe us), bigint as string, optional */
  creditLimit?: string;
  /** Settlement threshold (balance triggers settlement), bigint as string, optional */
  settlementThreshold?: string;
  /** Current settlement state */
  settlementState: SettlementState;
  /** Event timestamp (ISO 8601 format) */
  timestamp: string;
}

/**
 * Settlement Triggered Telemetry Event
 *
 * Emitted when SettlementMonitor (Story 6.6) detects a settlement threshold crossing.
 * Indicates that a settlement has been queued for execution.
 *
 * **Trigger Conditions:**
 * - Threshold exceeded: creditBalance >= settlementThreshold
 * - Manual trigger: Operator manually triggers settlement via API
 *
 * **BigInt Serialization:** All balance fields are strings (bigint serialized for JSON).
 *
 * **Dashboard Usage:**
 * - SettlementTimeline shows trigger event with threshold details
 * - SettlementStatusPanel updates peer state to SETTLEMENT_PENDING
 *
 * @example
 * ```typescript
 * const event: SettlementTriggeredEvent = {
 *   type: 'SETTLEMENT_TRIGGERED',
 *   nodeId: 'connector-a',
 *   peerId: 'peer-b',
 *   tokenId: 'ILP',
 *   currentBalance: '5500',
 *   threshold: '5000',
 *   exceedsBy: '500',
 *   triggerReason: 'THRESHOLD_EXCEEDED',
 *   timestamp: '2026-01-03T12:00:00.000Z'
 * };
 * ```
 */
export interface SettlementTriggeredEvent {
  /** Event type discriminator */
  type: 'SETTLEMENT_TRIGGERED';
  /** Connector node ID triggering settlement */
  nodeId: string;
  /** Peer account ID requiring settlement */
  peerId: string;
  /** Token ID */
  tokenId: string;
  /** Current balance when triggered, bigint as string */
  currentBalance: string;
  /** Settlement threshold that was exceeded, bigint as string */
  threshold: string;
  /** Amount over threshold (currentBalance - threshold), bigint as string */
  exceedsBy: string;
  /** Trigger reason: 'THRESHOLD_EXCEEDED' (automatic) or 'MANUAL' (operator-initiated) */
  triggerReason: string;
  /** Event timestamp (ISO 8601 format) */
  timestamp: string;
}

/**
 * Settlement Completed Telemetry Event
 *
 * Emitted when SettlementAPI (Story 6.7) completes settlement execution.
 * Reports the settlement outcome (success/failure) and balance changes.
 *
 * **Settlement Types:**
 * - 'MOCK': Mock settlement (Story 6.7) - TigerBeetle transfer only, no blockchain
 * - 'EVM': Ethereum settlement (Epic 7) - EVM blockchain payment
 * - 'XRP': XRP Ledger settlement (Epic 8) - XRP Ledger payment
 *
 * **BigInt Serialization:** All balance fields are strings (bigint serialized for JSON).
 *
 * **Dashboard Usage:**
 * - SettlementTimeline shows completion event with success/failure indicator
 * - SettlementStatusPanel updates peer balance to newBalance
 * - NetworkGraph updates balance badges to reflect settlement
 *
 * @example
 * ```typescript
 * // Successful settlement
 * const successEvent: SettlementCompletedEvent = {
 *   type: 'SETTLEMENT_COMPLETED',
 *   nodeId: 'connector-a',
 *   peerId: 'peer-b',
 *   tokenId: 'ILP',
 *   previousBalance: '5500',
 *   newBalance: '0',
 *   settledAmount: '5500',
 *   settlementType: 'MOCK',
 *   success: true,
 *   timestamp: '2026-01-03T12:01:00.000Z'
 * };
 *
 * // Failed settlement
 * const failureEvent: SettlementCompletedEvent = {
 *   type: 'SETTLEMENT_COMPLETED',
 *   nodeId: 'connector-a',
 *   peerId: 'peer-b',
 *   tokenId: 'ILP',
 *   previousBalance: '5500',
 *   newBalance: '5500',
 *   settledAmount: '0',
 *   settlementType: 'MOCK',
 *   success: false,
 *   errorMessage: 'TigerBeetle transfer failed: insufficient balance',
 *   timestamp: '2026-01-03T12:01:00.000Z'
 * };
 * ```
 */
export interface SettlementCompletedEvent {
  /** Event type discriminator */
  type: 'SETTLEMENT_COMPLETED';
  /** Connector node ID completing settlement */
  nodeId: string;
  /** Peer account ID settled with */
  peerId: string;
  /** Token ID */
  tokenId: string;
  /** Balance before settlement, bigint as string */
  previousBalance: string;
  /** Balance after settlement, bigint as string */
  newBalance: string;
  /** Amount settled (previousBalance - newBalance), bigint as string */
  settledAmount: string;
  /** Settlement type: 'MOCK' (Story 6.7), 'EVM' (Epic 7), 'XRP' (Epic 8) */
  settlementType: string;
  /** Settlement execution result: true=success, false=failure */
  success: boolean;
  /** Error message if success=false, undefined if success=true */
  errorMessage?: string;
  /** Event timestamp (ISO 8601 format) */
  timestamp: string;
}

/**
 * Agent Balance Changed Telemetry Event
 *
 * Emitted when AgentBalanceTracker (Story 11.3) detects a balance change for an agent wallet.
 * Indicates on-chain balance has increased or decreased.
 *
 * **BigInt Serialization:** All balance fields are strings (bigint serialized for JSON).
 *
 * **Dashboard Usage:**
 * - Story 11.7 dashboard displays real-time balance updates
 * - Story 11.4 funding logic subscribes to detect low balances
 *
 * @example
 * ```typescript
 * const event: AgentBalanceChangedEvent = {
 *   type: 'AGENT_BALANCE_CHANGED',
 *   agentId: 'agent-001',
 *   chain: 'evm',
 *   token: 'ETH',
 *   oldBalance: '1000000000000000000',
 *   newBalance: '2000000000000000000',
 *   change: '1000000000000000000',
 *   timestamp: 1704729600000
 * };
 * ```
 */
export interface AgentBalanceChangedEvent {
  /** Event type discriminator */
  type: 'AGENT_BALANCE_CHANGED';
  /** Agent identifier */
  agentId: string;
  /** Blockchain ('evm' or 'xrp') */
  chain: string;
  /** Token identifier ('ETH', ERC20 address, or 'XRP') */
  token: string;
  /** Previous balance, bigint as string */
  oldBalance: string;
  /** New balance, bigint as string */
  newBalance: string;
  /** Balance change (newBalance - oldBalance), bigint as string */
  change: string;
  /** Event timestamp (ISO 8601 format) */
  timestamp: string;
}

/**
 * Funding Transaction Interface
 *
 * Represents a single funding transaction (ETH, ERC20, or XRP).
 * Used by AgentWalletFundedEvent (Story 11.4).
 */
export interface FundingTransaction {
  /** Blockchain ('evm' or 'xrp') */
  chain: 'evm' | 'xrp';
  /** Token identifier ('ETH', ERC20 address, or 'XRP') */
  token: string;
  /** Recipient address */
  to: string;
  /** Amount as string (bigint serialized) */
  amount: string;
  /** Transaction hash for on-chain lookup */
  txHash: string;
  /** Transaction status */
  status: 'pending' | 'confirmed' | 'failed';
}

/**
 * Agent Wallet Funded Telemetry Event
 *
 * Emitted when AgentWalletFunder (Story 11.4) successfully funds a new agent wallet.
 * Indicates agent received initial ETH, ERC20 tokens, and XRP funding.
 *
 * **BigInt Serialization:** All amount fields in transactions are strings (bigint serialized for JSON).
 *
 * **Dashboard Usage:**
 * - Story 11.7 dashboard displays funding events in real-time
 * - Funding history panel shows transaction details
 *
 * @example
 * ```typescript
 * const event: AgentWalletFundedEvent = {
 *   type: 'AGENT_WALLET_FUNDED',
 *   agentId: 'agent-001',
 *   evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
 *   xrpAddress: 'rN7n7otQDd6FczFgLdlqtyMVrn3WnFBrJT',
 *   transactions: [
 *     { chain: 'evm', token: 'ETH', to: '0x742d35Cc...', amount: '10000000000000000', txHash: '0xabc...', status: 'pending' },
 *     { chain: 'xrp', token: 'XRP', to: 'rN7n7otQDd...', amount: '15000000', txHash: 'ABC123...', status: 'pending' }
 *   ],
 *   timestamp: '2026-01-08T12:00:00.000Z'
 * };
 * ```
 */
export interface AgentWalletFundedEvent {
  /** Event type discriminator */
  type: 'AGENT_WALLET_FUNDED';
  /** Agent identifier */
  agentId: string;
  /** Agent EVM address */
  evmAddress: string;
  /** Agent XRP address */
  xrpAddress: string;
  /** List of funding transactions */
  transactions: FundingTransaction[];
  /** Event timestamp (ISO 8601 format) */
  timestamp: string;
}

/**
 * Funding Rate Limit Exceeded Telemetry Event
 *
 * Emitted when AgentWalletFunder (Story 11.4) denies funding due to rate limit.
 * Indicates potential abuse or misconfiguration.
 *
 * @example
 * ```typescript
 * const event: FundingRateLimitExceededEvent = {
 *   type: 'FUNDING_RATE_LIMIT_EXCEEDED',
 *   agentId: 'agent-001',
 *   violatedLimit: 'per_agent',
 *   timestamp: '2026-01-08T12:00:00.000Z'
 * };
 * ```
 */
export interface FundingRateLimitExceededEvent {
  /** Event type discriminator */
  type: 'FUNDING_RATE_LIMIT_EXCEEDED';
  /** Agent identifier */
  agentId: string;
  /** Which rate limit was violated */
  violatedLimit: 'per_agent' | 'per_hour';
  /** Event timestamp (ISO 8601 format) */
  timestamp: string;
}

/**
 * Funding Transaction Confirmed Telemetry Event
 *
 * Emitted when AgentWalletFunder (Story 11.4) confirms funding transaction on-chain.
 *
 * @example
 * ```typescript
 * const event: FundingTransactionConfirmedEvent = {
 *   type: 'FUNDING_TRANSACTION_CONFIRMED',
 *   agentId: 'agent-001',
 *   txHash: '0xabc123...',
 *   chain: 'evm',
 *   status: 'confirmed',
 *   timestamp: '2026-01-08T12:01:00.000Z'
 * };
 * ```
 */
export interface FundingTransactionConfirmedEvent {
  /** Event type discriminator */
  type: 'FUNDING_TRANSACTION_CONFIRMED';
  /** Agent identifier */
  agentId: string;
  /** Transaction hash */
  txHash: string;
  /** Blockchain ('evm' or 'xrp') */
  chain: string;
  /** Transaction status */
  status: 'confirmed';
  /** Event timestamp (ISO 8601 format) */
  timestamp: string;
}

/**
 * Funding Transaction Failed Telemetry Event
 *
 * Emitted when AgentWalletFunder (Story 11.4) detects funding transaction failure.
 *
 * @example
 * ```typescript
 * const event: FundingTransactionFailedEvent = {
 *   type: 'FUNDING_TRANSACTION_FAILED',
 *   agentId: 'agent-001',
 *   txHash: '0xabc123...',
 *   chain: 'evm',
 *   error: 'Transaction reverted',
 *   timestamp: '2026-01-08T12:01:00.000Z'
 * };
 * ```
 */
export interface FundingTransactionFailedEvent {
  /** Event type discriminator */
  type: 'FUNDING_TRANSACTION_FAILED';
  /** Agent identifier */
  agentId: string;
  /** Transaction hash */
  txHash: string;
  /** Blockchain ('evm' or 'xrp') */
  chain: string;
  /** Error message */
  error: string;
  /** Event timestamp (ISO 8601 format) */
  timestamp: string;
}

/**
 * Agent Wallet State Changed Telemetry Event
 *
 * Emitted when AgentWalletLifecycle (Story 11.5) transitions wallet state.
 * Indicates wallet lifecycle progression (PENDING → ACTIVE → SUSPENDED → ARCHIVED).
 *
 * **Dashboard Usage:**
 * - Story 11.7 dashboard displays lifecycle state badges on agent wallet cards
 * - Real-time state transition visualization
 *
 * @example
 * ```typescript
 * const event: AgentWalletStateChangedEvent = {
 *   type: 'AGENT_WALLET_STATE_CHANGED',
 *   agentId: 'agent-001',
 *   oldState: 'pending',
 *   newState: 'active',
 *   timestamp: 1704729600000
 * };
 * ```
 */
export interface AgentWalletStateChangedEvent {
  /** Event type discriminator */
  type: 'AGENT_WALLET_STATE_CHANGED';
  /** Agent identifier */
  agentId: string;
  /** Previous state (null if newly created) */
  oldState: string | null;
  /** New state */
  newState: string;
  /** Event timestamp (Unix milliseconds) */
  timestamp: number;
}

/**
 * XRP Channel Opened Telemetry Event
 *
 * Emitted when XRPChannelSDK.openChannel() successfully creates payment channel.
 * Indicates XRP payment channel has been created on the XRP Ledger.
 *
 * **BigInt Serialization:** All XRP amount fields are strings (bigint serialized for JSON).
 * XRP amounts stored in "drops" (1 XRP = 1,000,000 drops).
 *
 * **Dashboard Usage:**
 * - PaymentChannelsPanel displays XRP channels with orange badge
 * - ChannelTimeline shows channel opened event
 * - NetworkGraph displays XRP channel indicator
 *
 * @example
 * ```typescript
 * const event: XRPChannelOpenedEvent = {
 *   type: 'XRP_CHANNEL_OPENED',
 *   timestamp: '2026-01-12T12:00:00.000Z',
 *   nodeId: 'connector-a',
 *   channelId: 'A1B2C3D4E5F6789...',
 *   account: 'rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW',
 *   destination: 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN',
 *   amount: '10000000000',
 *   settleDelay: 86400,
 *   publicKey: 'ED01234567890ABCDEF...',
 *   peerId: 'peer-bob'
 * };
 * ```
 */
export interface XRPChannelOpenedEvent {
  /**
   * Event type discriminator
   */
  type: 'XRP_CHANNEL_OPENED';

  /**
   * Event timestamp (ISO 8601 format)
   * Format: '2026-01-12T12:00:00.000Z'
   */
  timestamp: string;

  /**
   * Connector node ID emitting event
   * Example: 'connector-a'
   */
  nodeId: string;

  /**
   * XRP payment channel identifier (transaction hash)
   * Format: 64-character hex string
   * Example: 'A1B2C3D4E5F6...'
   */
  channelId: string;

  /**
   * Source account (channel sender, us)
   * Format: XRP Ledger r-address
   * Example: 'rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW'
   */
  account: string;

  /**
   * Destination account (channel recipient, peer)
   * Format: XRP Ledger r-address
   * Example: 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN'
   */
  destination: string;

  /**
   * Total XRP deposited in channel (drops)
   * Format: String for bigint precision
   * Example: '10000000000' = 10,000 XRP (1 XRP = 1,000,000 drops)
   */
  amount: string;

  /**
   * Settlement delay in seconds
   * Example: 86400 (24 hours)
   */
  settleDelay: number;

  /**
   * ed25519 public key for claim signature verification
   * Format: 66-character hex string (ED prefix + 64 hex)
   * Example: 'ED01234567890ABCDEF...'
   */
  publicKey: string;

  /**
   * Peer identifier from connector configuration
   * Example: 'peer-bob'
   */
  peerId?: string;
}

/**
 * XRP Channel Claimed Telemetry Event
 *
 * Emitted when XRPChannelSDK.submitClaim() redeems XRP from channel.
 * Indicates XRP has been claimed from the payment channel on the XRP Ledger.
 *
 * **BigInt Serialization:** All XRP amount fields are strings (bigint serialized for JSON).
 *
 * **Dashboard Usage:**
 * - ChannelTimeline shows claim submission event
 * - PaymentChannelsPanel updates XRP channel balance
 *
 * @example
 * ```typescript
 * const event: XRPChannelClaimedEvent = {
 *   type: 'XRP_CHANNEL_CLAIMED',
 *   timestamp: '2026-01-12T12:05:00.000Z',
 *   nodeId: 'connector-a',
 *   channelId: 'A1B2C3D4E5F6789...',
 *   claimAmount: '5000000000',
 *   remainingBalance: '5000000000',
 *   peerId: 'peer-bob'
 * };
 * ```
 */
export interface XRPChannelClaimedEvent {
  /**
   * Event type discriminator
   */
  type: 'XRP_CHANNEL_CLAIMED';

  /**
   * Event timestamp (ISO 8601 format)
   */
  timestamp: string;

  /**
   * Connector node ID emitting event
   */
  nodeId: string;

  /**
   * XRP payment channel identifier (transaction hash)
   * Format: 64-character hex string
   */
  channelId: string;

  /**
   * XRP claimed in this claim transaction (cumulative drops)
   * Format: String for bigint precision
   * Example: '5000000000' = 5,000 XRP claimed total
   */
  claimAmount: string;

  /**
   * XRP remaining in channel after claim (drops)
   * Format: String for bigint precision
   * Calculation: channel.amount - claimAmount
   * Example: '5000000000' = 5,000 XRP remaining
   */
  remainingBalance: string;

  /**
   * Peer identifier from connector configuration
   * Example: 'peer-bob'
   */
  peerId?: string;
}

/**
 * XRP Channel Closed Telemetry Event
 *
 * Emitted when XRPChannelSDK.closeChannel() initiates or finalizes closure.
 * Indicates XRP payment channel closure has been initiated on the XRP Ledger.
 *
 * **BigInt Serialization:** All XRP amount fields are strings (bigint serialized for JSON).
 *
 * **Dashboard Usage:**
 * - ChannelTimeline shows channel closed event
 * - PaymentChannelsPanel marks channel as settled
 *
 * @example
 * ```typescript
 * const event: XRPChannelClosedEvent = {
 *   type: 'XRP_CHANNEL_CLOSED',
 *   timestamp: '2026-01-12T12:10:00.000Z',
 *   nodeId: 'connector-a',
 *   channelId: 'A1B2C3D4E5F6789...',
 *   finalBalance: '5000000000',
 *   closeType: 'cooperative',
 *   peerId: 'peer-bob'
 * };
 * ```
 */
export interface XRPChannelClosedEvent {
  /**
   * Event type discriminator
   */
  type: 'XRP_CHANNEL_CLOSED';

  /**
   * Event timestamp (ISO 8601 format)
   */
  timestamp: string;

  /**
   * Connector node ID emitting event
   */
  nodeId: string;

  /**
   * XRP payment channel identifier (transaction hash)
   * Format: 64-character hex string
   */
  channelId: string;

  /**
   * Final XRP distributed when channel closed (drops)
   * Format: String for bigint precision
   * Example: '5000000000' = 5,000 XRP distributed to destination
   */
  finalBalance: string;

  /**
   * Channel closure method
   * - 'cooperative': Both parties agreed to close (closeChannel())
   * - 'expiration': Channel auto-expired via CancelAfter timestamp
   * - 'unilateral': One party closed during settle delay
   */
  closeType: 'cooperative' | 'expiration' | 'unilateral';

  /**
   * Peer identifier from connector configuration
   * Example: 'peer-bob'
   */
  peerId?: string;
}

/**
 * Telemetry Event Union Type
 *
 * Discriminated union of all telemetry event types.
 * Use `event.type` to narrow to specific event interface.
 *
 * @example
 * ```typescript
 * function handleTelemetryEvent(event: TelemetryEvent): void {
 *   switch (event.type) {
 *     case 'ACCOUNT_BALANCE':
 *       console.log(`Balance updated: ${event.peerId} = ${event.creditBalance}`);
 *       break;
 *     case 'SETTLEMENT_TRIGGERED':
 *       console.log(`Settlement triggered: ${event.peerId}, threshold exceeded by ${event.exceedsBy}`);
 *       break;
 *     case 'SETTLEMENT_COMPLETED':
 *       console.log(`Settlement ${event.success ? 'succeeded' : 'failed'}: ${event.peerId}`);
 *       break;
 *     case 'AGENT_BALANCE_CHANGED':
 *       console.log(`Agent balance changed: ${event.agentId} ${event.token} = ${event.newBalance}`);
 *       break;
 *     case 'AGENT_WALLET_FUNDED':
 *       console.log(`Agent wallet funded: ${event.agentId} with ${event.transactions.length} transactions`);
 *       break;
 *     case 'AGENT_WALLET_STATE_CHANGED':
 *       console.log(`Agent wallet state changed: ${event.agentId} ${event.oldState} → ${event.newState}`);
 *       break;
 *     case 'PAYMENT_CHANNEL_OPENED':
 *       console.log(`Payment channel opened: ${event.channelId} for peer ${event.peerId}`);
 *       break;
 *     case 'PAYMENT_CHANNEL_BALANCE_UPDATE':
 *       console.log(`Payment channel balance updated: ${event.channelId}`);
 *       break;
 *     case 'PAYMENT_CHANNEL_SETTLED':
 *       console.log(`Payment channel settled: ${event.channelId} via ${event.settlementType}`);
 *       break;
 *     case 'XRP_CHANNEL_OPENED':
 *       console.log(`XRP channel opened: ${event.channelId} to ${event.destination}`);
 *       break;
 *     case 'XRP_CHANNEL_CLAIMED':
 *       console.log(`XRP channel claimed: ${event.channelId} amount ${event.claimAmount}`);
 *       break;
 *     case 'XRP_CHANNEL_CLOSED':
 *       console.log(`XRP channel closed: ${event.channelId} via ${event.closeType}`);
 *       break;
 *     default:
 *       console.log(`Unknown event type: ${event.type}`);
 *   }
 * }
 * ```
 */
export type TelemetryEvent =
  | AccountBalanceEvent
  | SettlementTriggeredEvent
  | SettlementCompletedEvent
  | AgentBalanceChangedEvent
  | AgentWalletFundedEvent
  | FundingRateLimitExceededEvent
  | FundingTransactionConfirmedEvent
  | FundingTransactionFailedEvent
  | AgentWalletStateChangedEvent
  | PaymentChannelOpenedEvent
  | PaymentChannelBalanceUpdateEvent
  | PaymentChannelSettledEvent
  | XRPChannelOpenedEvent
  | XRPChannelClaimedEvent
  | XRPChannelClosedEvent;
