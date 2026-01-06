/**
 * Telemetry Event Type Definitions
 *
 * This module provides TypeScript type definitions for telemetry events emitted
 * by the connector to the dashboard for real-time visualization.
 *
 * Event types support settlement monitoring, account balance tracking, and
 * network activity visualization.
 *
 * @packageDocumentation
 */

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
  /** Payment channel opened event - emitted when channel successfully opened (Story 8.10) */
  PAYMENT_CHANNEL_OPENED = 'PAYMENT_CHANNEL_OPENED',
  /** Payment channel balance update event - emitted when balance proof signed (Story 8.10) */
  PAYMENT_CHANNEL_BALANCE_UPDATE = 'PAYMENT_CHANNEL_BALANCE_UPDATE',
  /** Payment channel settled event - emitted when channel settlement completes (Story 8.10) */
  PAYMENT_CHANNEL_SETTLED = 'PAYMENT_CHANNEL_SETTLED',
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
 * Payment Channel Opened Telemetry Event
 *
 * Emitted by ChannelManager (Story 8.9) when a payment channel is successfully opened
 * on-chain. Contains full channel configuration and initial deposit information.
 *
 * **Emission Point:** ChannelManager.trackChannel() after channel opening confirmed
 *
 * **BigInt Serialization:** initialDeposits values are strings (bigint serialized for JSON).
 *
 * **Dashboard Usage:**
 * - NetworkGraph displays channel indicator on peer edge
 * - PaymentChannelsPanel lists new channel in table
 * - Timeline shows channel opened event
 *
 * @example
 * ```typescript
 * const event: PaymentChannelOpenedEvent = {
 *   type: 'PAYMENT_CHANNEL_OPENED',
 *   timestamp: 1735992000000,
 *   nodeId: 'connector-a',
 *   channelId: '0x1234...5678',
 *   participants: ['0xabc...def', '0x123...456'],
 *   tokenAddress: '0x7f5c764cbc14f9669b88837ca1490cca17c31607',
 *   tokenSymbol: 'USDC',
 *   settlementTimeout: 86400,
 *   initialDeposits: {
 *     '0xabc...def': '1000000000',
 *     '0x123...456': '1000000000'
 *   }
 * };
 * ```
 */
export interface PaymentChannelOpenedEvent {
  /** Event type discriminator */
  type: 'PAYMENT_CHANNEL_OPENED';
  /** Event timestamp (Unix timestamp in milliseconds) */
  timestamp: number;
  /** Connector node ID emitting this event */
  nodeId: string;
  /** Channel identifier (bytes32 hex string from contract) */
  channelId: string;
  /** Ethereum addresses of both channel participants [participant1, participant2] */
  participants: [string, string];
  /** ERC20 token contract address */
  tokenAddress: string;
  /** Human-readable token symbol (e.g., "USDC") */
  tokenSymbol: string;
  /** Challenge period duration in seconds */
  settlementTimeout: number;
  /** Initial deposits keyed by participant address, bigint as string */
  initialDeposits: { [participant: string]: string };
}

/**
 * Payment Channel Balance Update Telemetry Event
 *
 * Emitted by SettlementExecutor (Story 8.8) after signing a balance proof.
 * Tracks cumulative transferred amounts and nonces for off-chain payment state.
 *
 * **Emission Point:** SettlementExecutor.signBalanceProof() after state update
 *
 * **BigInt Serialization:** myTransferred and theirTransferred are strings (bigint serialized).
 *
 * **Dashboard Usage:**
 * - PaymentChannelsPanel shows real-time transferred amounts and nonces
 * - Timeline displays balance update events
 * - NetworkGraph tooltip shows current balances
 *
 * @example
 * ```typescript
 * const event: PaymentChannelBalanceUpdateEvent = {
 *   type: 'PAYMENT_CHANNEL_BALANCE_UPDATE',
 *   timestamp: 1735992100000,
 *   nodeId: 'connector-a',
 *   channelId: '0x1234...5678',
 *   myNonce: 42,
 *   theirNonce: 38,
 *   myTransferred: '250000000',
 *   theirTransferred: '180000000'
 * };
 * ```
 */
export interface PaymentChannelBalanceUpdateEvent {
  /** Event type discriminator */
  type: 'PAYMENT_CHANNEL_BALANCE_UPDATE';
  /** Event timestamp (Unix timestamp in milliseconds) */
  timestamp: number;
  /** Connector node ID emitting this event */
  nodeId: string;
  /** Channel identifier */
  channelId: string;
  /** Our latest nonce (number of balance updates we've signed) */
  myNonce: number;
  /** Counterparty latest nonce (number of balance updates they've signed) */
  theirNonce: number;
  /** Cumulative amount we transferred (bigint as string) */
  myTransferred: string;
  /** Cumulative amount counterparty transferred (bigint as string) */
  theirTransferred: string;
}

/**
 * Payment Channel Settled Telemetry Event
 *
 * Emitted by ChannelManager (Story 8.9) when a payment channel settlement completes
 * on-chain. Reports final balances and settlement method used.
 *
 * **Emission Point:** ChannelManager after handleDisputedClosure() or closeIdleChannel()
 *
 * **Settlement Types:**
 * - 'cooperative': Both parties agreed to close channel
 * - 'unilateral': One party closed channel with latest balance proof
 * - 'disputed': Settlement challenged, resolved through dispute period
 *
 * **BigInt Serialization:** finalBalances values are strings (bigint serialized for JSON).
 *
 * **Dashboard Usage:**
 * - NetworkGraph removes channel indicator or shows as settled
 * - PaymentChannelsPanel updates channel status to 'settled'
 * - Timeline shows channel settlement event with settlement type
 *
 * @example
 * ```typescript
 * const event: PaymentChannelSettledEvent = {
 *   type: 'PAYMENT_CHANNEL_SETTLED',
 *   timestamp: 1735996000000,
 *   nodeId: 'connector-a',
 *   channelId: '0x1234...5678',
 *   finalBalances: {
 *     '0xabc...def': '750000000',
 *     '0x123...456': '1250000000'
 *   },
 *   settlementType: 'cooperative'
 * };
 * ```
 */
export interface PaymentChannelSettledEvent {
  /** Event type discriminator */
  type: 'PAYMENT_CHANNEL_SETTLED';
  /** Event timestamp (Unix timestamp in milliseconds) */
  timestamp: number;
  /** Connector node ID emitting this event */
  nodeId: string;
  /** Channel identifier */
  channelId: string;
  /** Final settlement balances keyed by participant address, bigint as string */
  finalBalances: { [participant: string]: string };
  /** Settlement method: cooperative, unilateral, or disputed */
  settlementType: 'cooperative' | 'unilateral' | 'disputed';
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
 *     case 'PAYMENT_CHANNEL_OPENED':
 *       console.log(`Channel opened: ${event.channelId}, token: ${event.tokenSymbol}`);
 *       break;
 *     case 'PAYMENT_CHANNEL_BALANCE_UPDATE':
 *       console.log(`Channel balance updated: ${event.channelId}, nonce: ${event.myNonce}`);
 *       break;
 *     case 'PAYMENT_CHANNEL_SETTLED':
 *       console.log(`Channel settled: ${event.channelId}, type: ${event.settlementType}`);
 *       break;
 *     default:
 *       console.log(`Unknown event type`);
 *   }
 * }
 * ```
 */
export type TelemetryEvent =
  | AccountBalanceEvent
  | SettlementTriggeredEvent
  | SettlementCompletedEvent
  | PaymentChannelOpenedEvent
  | PaymentChannelBalanceUpdateEvent
  | PaymentChannelSettledEvent;
