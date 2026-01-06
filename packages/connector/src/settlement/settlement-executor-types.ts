// Settlement Executor Type Definitions
// Epic 8 Story 8.8 - Settlement Engine Integration with Payment Channels

import { PaymentChannelSDKConfig } from './payment-channel-types.js';

/**
 * Configuration for SettlementExecutor
 * Controls settlement execution behavior and blockchain integration
 */
export interface SettlementExecutorConfig {
  /** Enable or disable settlement execution */
  enabled: boolean;

  /** Payment Channel SDK configuration (from Story 8.7) */
  paymentChannelSDKConfig: PaymentChannelSDKConfig;

  /** ERC20 token address for settlements (e.g., MockERC20) */
  settlementTokenAddress: string;

  /** Initial deposit when opening new channel (e.g., 1000000n for 1 token) */
  defaultInitialDeposit: bigint;

  /** Settlement timeout in seconds (challenge period, default: 86400 = 24 hours) */
  defaultSettlementTimeout: number;

  /** Maximum retry attempts for failed settlements (default: 3) */
  retryAttempts: number;

  /** Delay between retries in milliseconds (default: 5000) */
  retryDelayMs: number;

  /** Mapping of peerId to Ethereum address (e.g., {"connector-a": "0xf39Fd..."}) */
  peerAddressMap: Record<string, string>;

  /** Connector node ID for telemetry (optional) */
  nodeId?: string;
}

/**
 * Custom error for insufficient channel deposit scenarios
 * Thrown when transferred amount exceeds current deposit
 */
export class InsufficientDepositError extends Error {
  constructor(
    public readonly channelId: string,
    public readonly requiredDeposit: bigint,
    public readonly currentDeposit: bigint
  ) {
    super(
      `Insufficient deposit in channel ${channelId}: required ${requiredDeposit}, current ${currentDeposit}`
    );
    this.name = 'InsufficientDepositError';
    Object.setPrototypeOf(this, InsufficientDepositError.prototype);
  }
}

/**
 * Custom error for insufficient gas scenarios
 * Thrown when wallet has insufficient gas for transaction
 */
export class InsufficientGasError extends Error {
  constructor(public readonly originalError: Error) {
    super(`Insufficient gas for settlement transaction: ${originalError.message}`);
    this.name = 'InsufficientGasError';
    Object.setPrototypeOf(this, InsufficientGasError.prototype);
  }
}

/**
 * Custom error for channel dispute scenarios
 * Thrown when channel is closed or disputed unexpectedly
 */
export class ChannelDisputeError extends Error {
  constructor(
    public readonly channelId: string,
    public readonly reason: string
  ) {
    super(`Channel dispute detected for ${channelId}: ${reason}`);
    this.name = 'ChannelDisputeError';
    Object.setPrototypeOf(this, ChannelDisputeError.prototype);
  }
}

/**
 * Custom error for RPC connection failures
 * Thrown when blockchain RPC endpoint is unreachable
 */
export class RPCConnectionError extends Error {
  constructor(public readonly originalError: Error) {
    super(`RPC connection failed: ${originalError.message}`);
    this.name = 'RPCConnectionError';
    Object.setPrototypeOf(this, RPCConnectionError.prototype);
  }
}
