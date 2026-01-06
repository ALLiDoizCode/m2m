/**
 * TypeScript type definitions for ChannelManager
 * Defines configuration, channel tracking metadata, and lifecycle states
 */

/**
 * Channel lifecycle status
 */
export type ChannelStatus = 'opening' | 'active' | 'closing' | 'settled' | 'disputed';

/**
 * ChannelManager configuration interface
 */
export interface ChannelManagerConfig {
  /** Enable/disable automatic channel management */
  enabled: boolean;

  /** Multiplier for threshold (default: 10 = 10x threshold amount) */
  initialDepositMultiplier: number;

  /** Fraction of initial deposit that triggers top-up (e.g., 0.5 = 50%, default: 0.5) */
  minDepositThreshold: number;

  /** Milliseconds since last activity to consider channel idle (default: 86400000 = 24 hours) */
  idleChannelThresholdMs: number;

  /** Enable/disable automatic idle channel closure (default: true) */
  closeIdleChannels: boolean;

  /** Milliseconds to wait for counterparty response before unilateral close (default: 300000 = 5 minutes) */
  disputeTimeoutMs: number;

  /** Monitoring interval for deposit levels in milliseconds (default: 300000 = 5 minutes) */
  depositMonitoringIntervalMs?: number;

  /** Token-specific configuration overrides */
  tokenOverrides?: Record<
    string,
    {
      /** Token-specific initial deposit multiplier */
      initialDepositMultiplier?: number;
    }
  >;
}

/**
 * Channel tracking metadata
 * Used to track channel state and metadata for lifecycle management
 */
export interface ChannelInfo {
  /** Channel identifier (bytes32 hex string) */
  channelId: string;

  /** Peer identifier from connector config */
  peerId: string;

  /** ERC20 token address */
  tokenAddress: string;

  /** Current channel lifecycle status */
  status: ChannelStatus;

  /** Unix timestamp ms when channel opened */
  openedAt: number;

  /** Unix timestamp ms of last settlement or balance proof */
  lastActivityAt: number;

  /** Initial deposit amount in token units */
  initialDeposit: bigint;

  /** Current deposit balance, updated after top-ups */
  currentDeposit: bigint;

  /** Unix timestamp ms when channel closed (if applicable) */
  closedAt?: number;
}
