/**
 * Mina Payment Channel SDK
 *
 * Provides a TypeScript abstraction over the Mina zkApp payment channel contract.
 * All o1js interactions are encapsulated here so the connector package does NOT
 * import o1js directly.
 *
 * Epic 34 Story 34.4: MinaPaymentChannelSDK
 *
 * @remarks
 * This is a stub implementation. The full SDK will be implemented in Story 34.4.
 * The provider (Story 34.5) wraps this SDK; unit tests mock it entirely.
 *
 * @module mina-payment-channel-sdk
 */

import type { Logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Channel State
// ---------------------------------------------------------------------------

/**
 * Mina channel state as read from the zkApp on-chain state.
 *
 * Field names match the zkApp's `PaymentChannel` state fields.
 */
export interface MinaChannelState {
  /** Base58 public key of participant A */
  participantA: string;
  /** Base58 public key of participant B */
  participantB: string;
  /** Channel state enum: 0=UNINITIALIZED, 1=OPEN, 2=CLOSING, 3=SETTLED */
  channelState: number;
  /** Total deposit amount in the channel */
  depositTotal: bigint;
  /** Poseidon hash of the balance commitment */
  balanceCommitment: string;
  /** Monotonic claim nonce */
  nonceField: bigint;
  /** Slot at which the channel was closed (0 if not closed) */
  closedAtSlot: bigint;
  /** Settlement timeout in slots */
  settlementTimeout: bigint;
  /** Token identifier */
  tokenId: string;
  /** Poseidon hash of channel parameters */
  channelHash: string;
}

// ---------------------------------------------------------------------------
// Error Type
// ---------------------------------------------------------------------------

/**
 * Custom error type for Mina payment channel SDK operations.
 */
export class MinaChannelError extends Error {
  readonly code: number;
  readonly errorName: string;

  constructor(message: string, code: number, errorName: string) {
    super(message);
    this.name = 'MinaChannelError';
    this.code = code;
    this.errorName = errorName;
    Error.captureStackTrace(this, MinaChannelError);
  }
}

// ---------------------------------------------------------------------------
// SDK Open Channel Result
// ---------------------------------------------------------------------------

/** Result of opening a Mina payment channel. */
export interface MinaOpenChannelResult {
  /** zkApp address for the newly created channel */
  zkAppAddress: string;
  /** Transaction hash */
  txHash: string;
}

/** Generic Mina transaction result. */
export interface MinaTxResult {
  /** Transaction hash */
  txHash: string;
}

/** Event subscription handle. */
export interface MinaSubscription {
  /** Stop receiving events and clean up resources */
  unsubscribe(): void;
}

// ---------------------------------------------------------------------------
// SDK Class
// ---------------------------------------------------------------------------

/**
 * TypeScript wrapper for the Mina zkApp payment channel contract.
 *
 * All o1js-dependent operations (Poseidon hashing, proof generation,
 * circuit compilation) are encapsulated here.
 *
 * @remarks
 * This is a stub for Story 34.4. The provider (Story 34.5) wraps this SDK
 * and all unit tests mock it entirely — no o1js is imported at test time.
 */
export class MinaPaymentChannelSDK {
  /** Mina GraphQL endpoint for RPC communication */
  readonly graphqlUrl: string;

  constructor(
    graphqlUrl: string,
    private readonly _zkAppAddress: string,
    private readonly _logger: Logger
  ) {
    this.graphqlUrl = graphqlUrl;
  }

  /**
   * Pre-compile the zkApp proof circuit.
   * Must be called before any proof-generating operations.
   */
  async compileContract(): Promise<void> {
    this._logger.info(
      { event: 'compile_contract', zkAppAddress: this._zkAppAddress },
      'Compiling Mina zkApp circuit'
    );
    // Stub -- full implementation in Story 34.4
    throw new Error('MinaPaymentChannelSDK.compileContract() not yet implemented (Story 34.4)');
  }

  /**
   * Open a new payment channel.
   */
  async openChannel(
    _participantA: string,
    _participantB: string,
    _timeout: number,
    _tokenId?: string
  ): Promise<MinaOpenChannelResult> {
    throw new Error('MinaPaymentChannelSDK.openChannel() not yet implemented (Story 34.4)');
  }

  /**
   * Deposit funds into a channel.
   */
  async deposit(_channelAddress: string, _amount: bigint): Promise<MinaTxResult> {
    throw new Error('MinaPaymentChannelSDK.deposit() not yet implemented (Story 34.4)');
  }

  /**
   * Submit a claim with a balance proof.
   */
  async claimFromChannel(
    _channelAddress: string,
    _newBalanceA: bigint,
    _newBalanceB: bigint,
    _salt: bigint,
    _nonce: bigint,
    _signature: string
  ): Promise<MinaTxResult> {
    throw new Error('MinaPaymentChannelSDK.claimFromChannel() not yet implemented (Story 34.4)');
  }

  /**
   * Initiate channel closure.
   */
  async closeChannel(
    _channelAddress: string,
    _finalBalanceA?: bigint,
    _finalBalanceB?: bigint,
    _salt?: bigint,
    _signatures?: string[]
  ): Promise<MinaTxResult> {
    throw new Error('MinaPaymentChannelSDK.closeChannel() not yet implemented (Story 34.4)');
  }

  /**
   * Settle a closed channel after the challenge period.
   */
  async settleChannel(_channelAddress: string): Promise<MinaTxResult> {
    throw new Error('MinaPaymentChannelSDK.settleChannel() not yet implemented (Story 34.4)');
  }

  /**
   * Query the current on-chain state of a channel.
   */
  async getChannelState(_channelAddress: string): Promise<MinaChannelState> {
    throw new Error('MinaPaymentChannelSDK.getChannelState() not yet implemented (Story 34.4)');
  }

  /**
   * Get channel events from the archive node.
   */
  async getChannelEvents(
    _channelAddress: string
  ): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
    throw new Error('MinaPaymentChannelSDK.getChannelEvents() not yet implemented (Story 34.4)');
  }

  /**
   * Sign a balance proof using Poseidon commitment.
   *
   * @returns Serialized Poseidon commitment + proof string
   */
  async signBalanceProof(
    _channelAddress: string,
    _balanceA: bigint,
    _balanceB: bigint,
    _salt: bigint,
    _nonce: bigint
  ): Promise<string> {
    throw new Error('MinaPaymentChannelSDK.signBalanceProof() not yet implemented (Story 34.4)');
  }

  /**
   * Verify a balance proof / zk-SNARK proof.
   *
   * @returns `true` if the proof is valid, `false` otherwise
   */
  async verifyBalanceProof(
    _channelAddress: string,
    _balanceCommitment: string,
    _proof: string,
    _nonce: bigint
  ): Promise<boolean> {
    throw new Error('MinaPaymentChannelSDK.verifyBalanceProof() not yet implemented (Story 34.4)');
  }

  /**
   * Subscribe to channel state changes via polling.
   *
   * @param channelAddress - zkApp address to monitor
   * @param callback - Function called with updated state on each poll
   * @returns Subscription handle with `unsubscribe()` method
   */
  subscribeToChannel(
    _channelAddress: string,
    _callback: (state: MinaChannelState) => void
  ): MinaSubscription {
    throw new Error('MinaPaymentChannelSDK.subscribeToChannel() not yet implemented (Story 34.4)');
  }
}
