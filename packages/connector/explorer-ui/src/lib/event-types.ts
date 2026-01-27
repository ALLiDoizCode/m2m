/**
 * Telemetry event types for Explorer UI
 *
 * Mirrors key types from @m2m/shared for frontend use
 */

/**
 * Complete enumeration of all telemetry event types.
 * Mirrors TelemetryEventType enum from @m2m/shared.
 */
export type TelemetryEventType =
  // Node lifecycle events
  | 'NODE_STATUS'
  // Packet flow events
  | 'PACKET_RECEIVED'
  | 'PACKET_FORWARDED'
  // Account and settlement events
  | 'ACCOUNT_BALANCE'
  | 'SETTLEMENT_TRIGGERED'
  | 'SETTLEMENT_COMPLETED'
  // Agent wallet events
  | 'AGENT_BALANCE_CHANGED'
  | 'AGENT_WALLET_FUNDED'
  | 'AGENT_WALLET_STATE_CHANGED'
  | 'FUNDING_RATE_LIMIT_EXCEEDED'
  | 'FUNDING_TRANSACTION_CONFIRMED'
  | 'FUNDING_TRANSACTION_FAILED'
  // EVM payment channel events
  | 'PAYMENT_CHANNEL_OPENED'
  | 'PAYMENT_CHANNEL_BALANCE_UPDATE'
  | 'PAYMENT_CHANNEL_SETTLED'
  // XRP payment channel events
  | 'XRP_CHANNEL_OPENED'
  | 'XRP_CHANNEL_CLAIMED'
  | 'XRP_CHANNEL_CLOSED'
  // Agent channel events
  | 'AGENT_CHANNEL_OPENED'
  | 'AGENT_CHANNEL_PAYMENT_SENT'
  | 'AGENT_CHANNEL_BALANCE_UPDATE'
  | 'AGENT_CHANNEL_CLOSED'
  // Security events
  | 'WALLET_BALANCE_MISMATCH'
  | 'SUSPICIOUS_ACTIVITY_DETECTED'
  | 'RATE_LIMIT_EXCEEDED';

/**
 * Base telemetry event interface
 */
export interface TelemetryEvent {
  type: TelemetryEventType;
  nodeId?: string;
  timestamp: string | number;
  peerId?: string;
  [key: string]: unknown;
}

/**
 * Stored event from EventStore API
 */
export interface StoredEvent {
  id: number;
  event_type: string;
  timestamp: number;
  node_id: string;
  direction: string | null;
  peer_id: string | null;
  packet_id: string | null;
  amount: string | null;
  destination: string | null;
  packet_type: string | null;
  from_address: string | null;
  to_address: string | null;
  payload: TelemetryEvent;
}

/**
 * ILP Packet types for display
 */
export type IlpPacketType = 'prepare' | 'fulfill' | 'reject';

/**
 * Packet type color mapping
 */
export const PACKET_TYPE_COLORS: Record<string, string> = {
  prepare: 'bg-blue-500',
  fulfill: 'bg-green-500',
  reject: 'bg-red-500',
};

/**
 * Response from GET /api/events
 */
export interface EventsResponse {
  events: StoredEvent[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Response from GET /api/health
 */
export interface HealthResponse {
  status: 'healthy' | 'degraded';
  nodeId: string;
  uptime: number;
  explorer: {
    eventCount: number;
    databaseSizeBytes: number;
    wsConnections: number;
  };
  timestamp: string;
}

/**
 * Event type color mapping for badges.
 * Uses Tailwind CSS color classes (included in default Tailwind palette).
 */
export const EVENT_TYPE_COLORS: Record<string, string> = {
  // Node lifecycle - gray (neutral)
  NODE_STATUS: 'bg-gray-500',
  // Packet flow - blue shades
  PACKET_RECEIVED: 'bg-blue-400',
  PACKET_FORWARDED: 'bg-blue-600',
  // Account and settlement - green/yellow
  ACCOUNT_BALANCE: 'bg-blue-500',
  SETTLEMENT_TRIGGERED: 'bg-yellow-500',
  SETTLEMENT_COMPLETED: 'bg-green-500',
  // Agent wallet - purple/indigo
  AGENT_BALANCE_CHANGED: 'bg-purple-500',
  AGENT_WALLET_FUNDED: 'bg-indigo-500',
  AGENT_WALLET_STATE_CHANGED: 'bg-cyan-500',
  FUNDING_RATE_LIMIT_EXCEEDED: 'bg-amber-500',
  FUNDING_TRANSACTION_CONFIRMED: 'bg-lime-500',
  FUNDING_TRANSACTION_FAILED: 'bg-rose-500',
  // EVM payment channels - emerald/teal
  PAYMENT_CHANNEL_OPENED: 'bg-emerald-500',
  PAYMENT_CHANNEL_BALANCE_UPDATE: 'bg-teal-500',
  PAYMENT_CHANNEL_SETTLED: 'bg-green-600',
  // XRP channels - orange
  XRP_CHANNEL_OPENED: 'bg-orange-500',
  XRP_CHANNEL_CLAIMED: 'bg-orange-400',
  XRP_CHANNEL_CLOSED: 'bg-orange-600',
  // Agent channels - violet
  AGENT_CHANNEL_OPENED: 'bg-violet-500',
  AGENT_CHANNEL_PAYMENT_SENT: 'bg-violet-400',
  AGENT_CHANNEL_BALANCE_UPDATE: 'bg-violet-500',
  AGENT_CHANNEL_CLOSED: 'bg-violet-600',
  // Security events - red shades
  WALLET_BALANCE_MISMATCH: 'bg-red-500',
  SUSPICIOUS_ACTIVITY_DETECTED: 'bg-red-600',
  RATE_LIMIT_EXCEEDED: 'bg-red-400',
};

/**
 * Format relative timestamp (e.g., "2s ago")
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 1000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(timestamp).toLocaleString();
}

// ============================================================================
// Story 14.6: Account and Settlement Types
// ============================================================================

/**
 * Settlement state enumeration
 * Mirrors SettlementState from @m2m/shared
 */
export type SettlementState = 'IDLE' | 'SETTLEMENT_PENDING' | 'SETTLEMENT_IN_PROGRESS';

/**
 * Balance history entry for tracking changes over time
 */
export interface BalanceHistoryEntry {
  timestamp: number;
  balance: bigint;
}

/**
 * Account state for frontend state management (Story 14.6)
 * Used by useAccountBalances hook to track peer account state
 */
export interface AccountState {
  peerId: string;
  tokenId: string;
  debitBalance: bigint;
  creditBalance: bigint;
  netBalance: bigint;
  creditLimit?: bigint;
  settlementThreshold?: bigint;
  settlementState: SettlementState;
  balanceHistory: BalanceHistoryEntry[];
  hasActiveChannel?: boolean;
  channelType?: 'evm' | 'xrp';
  lastUpdated: number;
}

/**
 * Channel state for frontend (Story 14.6)
 * Mirrors DashboardChannelState from @m2m/shared
 */
export interface ChannelState {
  channelId: string;
  nodeId: string;
  peerId: string;
  participants: [string, string];
  tokenAddress: string;
  tokenSymbol: string;
  settlementTimeout: number;
  deposits: Record<string, string>;
  myNonce: number;
  theirNonce: number;
  myTransferred: string;
  theirTransferred: string;
  status: 'opening' | 'active' | 'closing' | 'settling' | 'settled';
  openedAt: string;
  settledAt?: string;
  lastActivityAt: string;
  // XRP-specific fields
  settlementMethod?: 'evm' | 'xrp';
  xrpAccount?: string;
  xrpDestination?: string;
  xrpAmount?: string;
  xrpBalance?: string;
  xrpSettleDelay?: number;
  xrpPublicKey?: string;
}

/**
 * Settlement event types for filtering (Story 14.6)
 * Used by FilterBar "Settlement" quick filter preset
 */
export const SETTLEMENT_EVENT_TYPES = [
  'ACCOUNT_BALANCE',
  'SETTLEMENT_TRIGGERED',
  'SETTLEMENT_COMPLETED',
  'PAYMENT_CHANNEL_OPENED',
  'PAYMENT_CHANNEL_BALANCE_UPDATE',
  'PAYMENT_CHANNEL_SETTLED',
  'XRP_CHANNEL_OPENED',
  'XRP_CHANNEL_CLAIMED',
  'XRP_CHANNEL_CLOSED',
  'AGENT_CHANNEL_OPENED',
  'AGENT_CHANNEL_BALANCE_UPDATE',
  'AGENT_CHANNEL_CLOSED',
] as const;

/**
 * Check if an event type is settlement-related (Story 14.6)
 */
export function isSettlementEvent(type: TelemetryEventType): boolean {
  return SETTLEMENT_EVENT_TYPES.includes(type as (typeof SETTLEMENT_EVENT_TYPES)[number]);
}

// ============================================================================
// On-Chain Wallet Balance Types
// ============================================================================

/**
 * EVM payment channel from /api/balances
 */
export interface WalletEvmChannel {
  channelId: string;
  peerAddress: string;
  deposit: string;
  transferredAmount: string;
  status: string;
}

/**
 * XRP payment channel from /api/balances
 */
export interface WalletXrpChannel {
  channelId: string;
  destination: string;
  amount: string;
  balance: string;
  status: string;
}

/**
 * Response from GET /api/balances
 */
export interface WalletBalances {
  agentId: string;
  evmAddress: string;
  xrpAddress: string | null;
  ethBalance: string | null;
  agentTokenBalance: string | null;
  xrpBalance: string | null;
  evmChannels: WalletEvmChannel[];
  xrpChannels: WalletXrpChannel[];
}
