/**
 * Claim Receiver Module
 *
 * Receives and verifies payment channel claims from peers via BTP protocol.
 * Dispatches claim verification to the correct PaymentChannelProvider via
 * the ChainProviderRegistry based on the blockchain discriminator field.
 *
 * @module claim-receiver
 * @see RFC-0023 - Bilateral Transfer Protocol (BTP)
 * @see Epic 17 - BTP Off-Chain Claim Exchange Protocol
 * @see Epic 32 Story 32.6 - Refactor ClaimReceiver for multi-chain verification
 */

import { EventEmitter } from 'events';
import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';
import type { BTPServer } from '../btp/btp-server';
import type { BTPProtocolData, BTPMessage } from '../btp/btp-types';
import { isBTPData } from '../btp/btp-types';
import type { ChainProviderRegistry } from './provider/chain-provider-registry';
import type {
  PaymentChannelProvider,
  VerifyBalanceProofParams,
  ProviderChannelState,
} from './provider/payment-channel-provider';
import type { ChannelManager } from './channel-manager';
import {
  type BTPClaimMessage,
  type EVMClaimMessage,
  type BlockchainType,
  isEVMClaim,
  isSolanaClaim,
  validateClaimMessage,
} from '../btp/btp-claim-types';

/**
 * Event emitted after a claim is successfully validated and persisted.
 * Used by SettlementMonitor to trigger event-driven settlement checks.
 */
export interface ClaimReceivedEvent {
  /** Peer ID of the claim sender */
  peerId: string;
  /** Payment channel ID */
  channelId: string;
  /** Cumulative transferred amount from the claim (bigint) */
  cumulativeAmount: bigint;
}

/**
 * Error message constants for claim verification
 * Exported for consistent usage between implementation and tests.
 */
export const ERRORS = {
  MISSING_SELF_DESCRIBING_FIELDS:
    'Missing self-describing fields for unknown channel (chainId, tokenNetworkAddress, tokenAddress required)',
  CHANNEL_NOT_FOUND: 'Channel does not exist on-chain',
  CHANNEL_NOT_OPENED: 'Channel not in opened state',
  SIGNER_NOT_PARTICIPANT: 'Signer is not a channel participant',
  ON_CHAIN_VERIFICATION_FAILED: 'On-chain channel verification failed',
  INVALID_SIGNATURE: 'Invalid balance proof signature',
  NO_PROVIDER_REGISTERED: 'No provider registered for blockchain:',
} as const;

/**
 * Result of claim verification process
 */
export interface ClaimVerificationResult {
  /** Whether the claim passed verification */
  valid: boolean;
  /** Unique message ID of the claim */
  messageId: string;
  /** Error message if verification failed */
  error?: string;
}

/**
 * ClaimReceiver - Receives and verifies payment channel claims from peers
 *
 * Responsibilities:
 * - Register BTP protocol data handler for "payment-channel-claim" protocol
 * - Parse and validate incoming claim messages
 * - Dispatch claim verification to the correct PaymentChannelProvider via ChainProviderRegistry
 * - Enforce monotonicity checks (nonce/amount must increase)
 * - Persist verified claims to database for later redemption
 *
 * @example
 * ```typescript
 * const claimReceiver = new ClaimReceiver(
 *   db,
 *   chainProviderRegistry,
 *   logger
 * );
 *
 * claimReceiver.registerWithBTPServer(btpServer);
 * ```
 */
export class ClaimReceiver extends EventEmitter {
  constructor(
    private readonly db: Database,
    private readonly chainProviderRegistry: ChainProviderRegistry,
    private readonly logger: Logger,
    private readonly channelManager?: ChannelManager,
    private readonly peerIdToAddressMap?: Map<string, string>
  ) {
    super();
  }

  /**
   * Register claim message handler with BTP server
   *
   * Sets up callback to receive BTP messages with protocol name "payment-channel-claim"
   * and routes them to handleClaimMessage for processing.
   *
   * @param btpServer - BTP server instance to register with
   */
  registerWithBTPServer(btpServer: BTPServer): void {
    // Register message callback with BTP server
    btpServer.onMessage(async (peerId: string, message: BTPMessage) => {
      // Only process data messages (not error messages)
      if (!isBTPData(message)) {
        return;
      }

      // TypeScript now knows message.data is BTPData, not BTPErrorData
      // Iterate through protocol data array
      for (const protocolData of message.data.protocolData) {
        // Filter for claim protocol
        if (protocolData.protocolName === 'payment-channel-claim') {
          await this.handleClaimMessage(peerId, protocolData);
        }
      }
    });

    this.logger.info('ClaimReceiver registered with BTP server');
  }

  /**
   * Handle incoming claim message from BTP peer
   *
   * @param peerId - Peer ID of sender
   * @param protocolData - BTP protocol data containing claim message
   * @private
   */
  private async handleClaimMessage(peerId: string, protocolData: BTPProtocolData): Promise<void> {
    const childLogger = this.logger.child({ peerId, protocol: 'claim-receiver' });

    try {
      // Parse JSON claim message
      const claimMessage = JSON.parse(protocolData.data.toString('utf8')) as BTPClaimMessage;

      // Validate claim message structure
      validateClaimMessage(claimMessage);

      const messageId = claimMessage.messageId;
      const blockchain = claimMessage.blockchain;

      childLogger.info({ messageId, blockchain }, 'Received claim message');

      // Resolve the appropriate provider for this claim's blockchain type
      const provider = this.resolveProvider(claimMessage);

      if (!provider) {
        // No provider registered for this blockchain type — reject
        const errorMsg = `${ERRORS.NO_PROVIDER_REGISTERED} ${blockchain}`;
        childLogger.warn({ messageId, blockchain }, errorMsg);
        this._persistReceivedClaim(peerId, claimMessage, false);
        return;
      }

      const verificationResult = await this.verifyClaim(claimMessage, peerId, provider);

      // Persist verified claim
      if (verificationResult.valid) {
        this._persistReceivedClaim(peerId, claimMessage, true);
        childLogger.info({ messageId }, 'Claim verified and stored');

        // Emit event for event-driven settlement monitoring
        if (isEVMClaim(claimMessage)) {
          const event: ClaimReceivedEvent = {
            peerId,
            channelId: claimMessage.channelId,
            cumulativeAmount: BigInt(claimMessage.transferredAmount),
          };
          this.emit('CLAIM_RECEIVED', event);
          childLogger.debug(
            { channelId: event.channelId, cumulativeAmount: event.cumulativeAmount.toString() },
            'CLAIM_RECEIVED event emitted'
          );
        } else if (isSolanaClaim(claimMessage)) {
          const event: ClaimReceivedEvent = {
            peerId,
            channelId: claimMessage.channelAccount,
            cumulativeAmount: BigInt(claimMessage.transferredAmount),
          };
          this.emit('CLAIM_RECEIVED', event);
          childLogger.debug(
            {
              channelAccount: event.channelId,
              cumulativeAmount: event.cumulativeAmount.toString(),
            },
            'CLAIM_RECEIVED event emitted (Solana)'
          );
        }
      } else {
        this._persistReceivedClaim(peerId, claimMessage, false);
        childLogger.warn(
          { messageId, error: verificationResult.error },
          'Claim verification failed'
        );
      }
    } catch (error) {
      childLogger.error({ error }, 'Failed to parse claim message');
    }
  }

  /**
   * Resolve the appropriate PaymentChannelProvider for a claim message.
   *
   * For known channels, uses the channel's chain metadata to look up the provider.
   * For unknown channels (dynamic verification), constructs a chain key from the
   * claim's self-describing fields.
   *
   * @param claim - The validated BTP claim message
   * @returns The matching provider, or undefined if none found
   * @private
   */
  private resolveProvider(claim: BTPClaimMessage): PaymentChannelProvider | undefined {
    // EVM claims: try known channel first, then self-describing fields
    if (isEVMClaim(claim)) {
      if (this.channelManager) {
        const knownChannel = this.channelManager.getChannelById(claim.channelId);
        if (knownChannel && knownChannel.chain) {
          return this.chainProviderRegistry.getProvider(claim.blockchain, knownChannel.chain);
        }
      }

      if (claim.chainId !== undefined) {
        const chainKey = `${claim.blockchain}:${claim.chainId}`;
        return this.chainProviderRegistry.getProvider(claim.blockchain, chainKey);
      }
    }

    // Solana claims: try known channel first, then cluster-based lookup
    if (isSolanaClaim(claim)) {
      if (this.channelManager) {
        const knownChannel = this.channelManager.getChannelById(claim.channelAccount);
        if (knownChannel && knownChannel.chain) {
          return this.chainProviderRegistry.getProvider(claim.blockchain, knownChannel.chain);
        }
      }

      if (claim.cluster !== undefined) {
        const chainKey = `${claim.blockchain}:${claim.cluster}`;
        return this.chainProviderRegistry.getProvider(claim.blockchain, chainKey);
      }
    }

    // Fallback: try the first registered provider for this blockchain type
    const allProviders = this.chainProviderRegistry.getAllProviders();
    return allProviders.find((p) => p.chainType === claim.blockchain);
  }

  /**
   * Verify a claim using the resolved PaymentChannelProvider.
   *
   * Delegates signature verification and on-chain state checks to the provider.
   * Maintains chain-agnostic nonce monotonicity checking.
   *
   * @param claim - Validated BTP claim message
   * @param peerId - Peer ID of sender
   * @param provider - The resolved PaymentChannelProvider
   * @returns Verification result
   * @private
   */
  private async verifyClaim(
    claim: BTPClaimMessage,
    peerId: string,
    provider: PaymentChannelProvider
  ): Promise<ClaimVerificationResult> {
    try {
      // Dispatch verification based on blockchain type
      // NOTE: `return await` is intentional — `return promise` inside try/catch
      // does NOT catch rejections; the promise bypasses the catch block.
      if (isEVMClaim(claim)) {
        return await this.verifyEVMClaim(claim, peerId, provider);
      }

      // Solana claims: structural validation passed but provider-based
      // signature verification is deferred to Epic 33.
      if (isSolanaClaim(claim)) {
        // Check nonce monotonicity for Solana claims
        const latestClaim = await this.getLatestVerifiedClaim(
          peerId,
          claim.blockchain,
          claim.channelAccount
        );

        if (latestClaim && isSolanaClaim(latestClaim)) {
          if (claim.nonce <= latestClaim.nonce) {
            return {
              valid: false,
              messageId: claim.messageId,
              error: 'Nonce not monotonically increasing',
            };
          }
        }

        // Solana provider verification will be wired in Epic 33
        // For now, accept structurally valid claims for storage
        this.logger.info(
          { channelAccount: claim.channelAccount, blockchain: claim.blockchain },
          'Solana claim structurally valid — full provider verification deferred to Epic 33'
        );
        return { valid: true, messageId: claim.messageId };
      }

      // Unsupported blockchain type
      return {
        valid: false,
        messageId: claim.messageId,
        error: `Verification not supported for blockchain: ${claim.blockchain}`,
      };
    } catch (error) {
      return {
        valid: false,
        messageId: claim.messageId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Verify an EVM claim with on-chain state checks and signature verification.
   *
   * @param claim - Validated EVM claim message
   * @param peerId - Peer ID of sender
   * @param provider - The resolved PaymentChannelProvider
   * @returns Verification result
   * @private
   */
  private async verifyEVMClaim(
    claim: EVMClaimMessage,
    peerId: string,
    provider: PaymentChannelProvider
  ): Promise<ClaimVerificationResult> {
    this.logger.debug({ channelId: claim.channelId }, 'Checking channel existence in metadata');

    // Check if channel is known (pre-registered or previously verified)
    const knownChannel = this.channelManager?.getChannelById(claim.channelId);

    if (!knownChannel && this.channelManager) {
      // Unknown channel -- attempt dynamic on-chain verification
      this.logger.info(
        { channelId: claim.channelId },
        'Unknown channel detected, starting on-chain verification'
      );

      // Require all self-describing fields
      if (claim.chainId === undefined || !claim.tokenNetworkAddress || !claim.tokenAddress) {
        this.logger.warn(
          { channelId: claim.channelId, signerAddress: claim.signerAddress },
          ERRORS.MISSING_SELF_DESCRIBING_FIELDS
        );
        return {
          valid: false,
          messageId: claim.messageId,
          error: ERRORS.MISSING_SELF_DESCRIBING_FIELDS,
        };
      }

      // Query on-chain state via provider
      let channelState: ProviderChannelState;
      try {
        channelState = await provider.getChannelState(claim.channelId);
      } catch (error) {
        this.logger.warn(
          { channelId: claim.channelId, signerAddress: claim.signerAddress, error },
          ERRORS.ON_CHAIN_VERIFICATION_FAILED
        );
        return {
          valid: false,
          messageId: claim.messageId,
          error: ERRORS.ON_CHAIN_VERIFICATION_FAILED,
        };
      }

      // Verify channel is opened
      if (channelState.status !== 'opened') {
        const errorMsg =
          channelState.status === 'settled' || channelState.status === 'closed'
            ? ERRORS.CHANNEL_NOT_OPENED
            : ERRORS.CHANNEL_NOT_FOUND;
        this.logger.warn(
          { channelId: claim.channelId, signerAddress: claim.signerAddress },
          errorMsg
        );
        return {
          valid: false,
          messageId: claim.messageId,
          error: errorMsg,
        };
      }

      // Verify signerAddress is a channel participant
      const signerLower = claim.signerAddress.toLowerCase();
      if (!channelState.participants.some((p) => p.toLowerCase() === signerLower)) {
        this.logger.warn(
          { channelId: claim.channelId, signerAddress: claim.signerAddress },
          ERRORS.SIGNER_NOT_PARTICIPANT
        );
        return {
          valid: false,
          messageId: claim.messageId,
          error: ERRORS.SIGNER_NOT_PARTICIPANT,
        };
      }

      this.logger.info(
        {
          channelId: claim.channelId,
          participants: channelState.participants,
          status: channelState.status,
        },
        'On-chain channel verified successfully'
      );

      // Verify signature via provider (provider handles domain context internally)
      const verifyParams = this.buildVerifyParams(claim);
      const sigValid = await provider.verifyBalanceProof(verifyParams);

      if (!sigValid) {
        return {
          valid: false,
          messageId: claim.messageId,
          error: ERRORS.INVALID_SIGNATURE,
        };
      }

      // Register channel in ChannelManager
      this.channelManager.registerExternalChannel({
        channelId: claim.channelId,
        peerId,
        tokenAddress: claim.tokenAddress,
        tokenNetworkAddress: claim.tokenNetworkAddress,
        chainId: claim.chainId,
        status: 'open',
      });

      this.logger.info({ channelId: claim.channelId, peerId }, 'External channel registered');

      // Register peer's EVM address for SettlementExecutor lookup
      if (this.peerIdToAddressMap && !this.peerIdToAddressMap.has(peerId)) {
        this.peerIdToAddressMap.set(peerId, claim.signerAddress);
        this.logger.info(
          { peerId, signerAddress: claim.signerAddress },
          'Peer EVM address registered from self-describing claim'
        );
      }
    } else {
      // Known channel (pre-registered or previously verified) -- use provider verification
      const verifyParams = this.buildVerifyParams(claim);
      const isValid = await provider.verifyBalanceProof(verifyParams);

      if (!isValid) {
        return {
          valid: false,
          messageId: claim.messageId,
          error: ERRORS.INVALID_SIGNATURE,
        };
      }
    }

    // Check nonce monotonicity - nonce must strictly increase
    const latestClaim = await this.getLatestVerifiedClaim(
      peerId,
      claim.blockchain,
      claim.channelId
    );

    if (latestClaim && isEVMClaim(latestClaim)) {
      if (claim.nonce <= latestClaim.nonce) {
        return {
          valid: false,
          messageId: claim.messageId,
          error: 'Nonce not monotonically increasing',
        };
      }
    }

    return { valid: true, messageId: claim.messageId };
  }

  /**
   * Build VerifyBalanceProofParams from an EVM claim message.
   *
   * Extracted to avoid duplicating the parameter construction in both the
   * known-channel and unknown-channel verification paths.
   *
   * @param claim - The EVM claim message
   * @returns Parameters for provider.verifyBalanceProof()
   * @private
   */
  private buildVerifyParams(claim: EVMClaimMessage): VerifyBalanceProofParams {
    return {
      channelId: claim.channelId,
      nonce: claim.nonce,
      transferredAmount: claim.transferredAmount,
      lockedAmount: claim.lockedAmount,
      locksRoot: claim.locksRoot,
      signature: claim.signature,
      signerAddress: claim.signerAddress,
    };
  }

  /**
   * Persist received claim to database
   *
   * @param peerId - Peer ID of sender
   * @param claim - Claim message
   * @param verified - Whether claim passed verification
   * @private
   */
  private _persistReceivedClaim(peerId: string, claim: BTPClaimMessage, verified: boolean): void {
    try {
      // Extract channel identifier based on blockchain type
      let channelId = '';
      if (isEVMClaim(claim)) {
        channelId = claim.channelId;
      } else if (isSolanaClaim(claim)) {
        channelId = claim.channelAccount;
      }

      // Insert into database
      const stmt = this.db.prepare(`
        INSERT INTO received_claims (
          message_id,
          peer_id,
          blockchain,
          channel_id,
          claim_data,
          verified,
          received_at,
          redeemed_at,
          redemption_tx_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        claim.messageId,
        peerId,
        claim.blockchain,
        channelId,
        JSON.stringify(claim),
        verified ? 1 : 0,
        Date.now(),
        null,
        null
      );
    } catch (error) {
      // Non-blocking: Log error but don't throw
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        this.logger.warn(
          { messageId: claim.messageId },
          'Duplicate claim message ignored (idempotency)'
        );
      } else {
        this.logger.error({ error }, 'Failed to persist claim to database');
      }
    }
  }

  /**
   * Get latest verified claim for a specific peer and channel
   *
   * Used for monotonicity checks and future redemption.
   *
   * @param peerId - Peer ID
   * @param blockchain - Blockchain type
   * @param channelId - Channel or owner identifier
   * @returns Latest verified claim or null if none found
   */
  async getLatestVerifiedClaim(
    peerId: string,
    blockchain: BlockchainType,
    channelId: string
  ): Promise<BTPClaimMessage | null> {
    try {
      const stmt = this.db.prepare(`
        SELECT claim_data
        FROM received_claims
        WHERE peer_id = ?
          AND blockchain = ?
          AND channel_id = ?
          AND verified = 1
          AND redeemed_at IS NULL
        ORDER BY received_at DESC
        LIMIT 1
      `);

      const row = stmt.get(peerId, blockchain, channelId) as { claim_data: string } | undefined;

      if (!row) {
        return null;
      }

      return JSON.parse(row.claim_data) as BTPClaimMessage;
    } catch (error) {
      this.logger.error({ error }, 'Failed to query latest verified claim');
      return null;
    }
  }
}
