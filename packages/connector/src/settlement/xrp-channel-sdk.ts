/**
 * XRP Channel SDK
 *
 * High-level SDK for XRP payment channel lifecycle management.
 * Consolidates XRPLClient, PaymentChannelManager, and ClaimSigner into unified API.
 *
 * This SDK provides:
 * - Channel lifecycle operations (open, fund, close)
 * - Off-chain claim signing and verification
 * - On-ledger claim submission
 * - Local channel state caching
 * - Automatic channel state refresh (30s interval)
 *
 * @module settlement/xrp-channel-sdk
 */

import type { Logger } from 'pino';
import type { XRPLClient } from './xrpl-client';
import type { ClaimSigner } from './xrp-claim-signer';
import type { PaymentChannelManager, XRPChannelState } from './xrp-channel-manager';
import type { XRPClaim } from './types';
import type { TelemetryEmitter } from '../telemetry/telemetry-emitter';

/**
 * XRPChannelSDK class
 *
 * High-level wrapper for XRP payment channel operations.
 * Abstracts low-level details (transaction construction, database queries, signature generation).
 *
 * @example
 * const sdk = new XRPChannelSDK(xrplClient, channelManager, claimSigner, logger);
 *
 * // Open channel
 * const channelId = await sdk.openChannel('rDestinationAddress', '1000000000', 86400);
 *
 * // Sign claim
 * const claim = sdk.signClaim(channelId, '500000000');
 *
 * // Submit claim
 * await sdk.submitClaim(claim);
 *
 * // Close channel
 * await sdk.closeChannel(channelId);
 *
 * // Start auto-refresh
 * sdk.startAutoRefresh();
 */
export class XRPChannelSDK {
  private channelStateCache: Map<string, XRPChannelState>;
  private refreshIntervalId?: NodeJS.Timeout;

  /**
   * Constructor
   *
   * @param xrplClient - XRPL client for ledger interactions
   * @param channelManager - Payment channel manager (database + channel ops)
   * @param claimSigner - Claim signer for off-chain signatures
   * @param logger - Pino logger instance
   * @param telemetryEmitter - Optional telemetry emitter for dashboard integration (Story 9.7)
   */
  constructor(
    private readonly xrplClient: XRPLClient,
    private readonly channelManager: PaymentChannelManager,
    private readonly claimSigner: ClaimSigner,
    private readonly logger: Logger,
    private readonly telemetryEmitter?: TelemetryEmitter
  ) {
    this.channelStateCache = new Map();
  }

  /**
   * Open new payment channel
   *
   * Creates PaymentChannelCreate transaction with destination, amount, and settle delay.
   * Generates channelId from transaction hash.
   * Stores channel in database and local cache.
   *
   * @param destination - Peer's XRP Ledger r-address
   * @param amount - Total XRP in channel (drops as string)
   * @param settleDelay - Settlement delay in seconds (minimum 3600 for production)
   * @param peerId - Optional peer identifier for telemetry (Story 9.7)
   * @returns Channel ID (64-char hex)
   *
   * @example
   * const channelId = await sdk.openChannel(
   *   'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN',
   *   '1000000000', // 1000 XRP
   *   86400 // 24 hours
   * );
   */
  async openChannel(
    destination: string,
    amount: string,
    settleDelay: number,
    peerId?: string
  ): Promise<string> {
    this.logger.info({ destination, amount, settleDelay }, 'Opening XRP payment channel...');

    // Delegate to PaymentChannelManager (Story 9.2)
    const channelId = await this.channelManager.createChannel(destination, amount, settleDelay);

    // Fetch channel state from ledger
    const channelState = await this.getChannelState(channelId);

    // Cache channel state locally
    this.channelStateCache.set(channelId, channelState);

    // Emit telemetry event (Story 9.7)
    try {
      this.telemetryEmitter?.emitXRPChannelOpened(channelState, peerId);
    } catch (error) {
      this.logger.error({ error }, 'Failed to emit XRP_CHANNEL_OPENED telemetry');
      // Do NOT rethrow - telemetry errors must not break channel operations
    }

    this.logger.info({ channelId }, 'XRP payment channel opened successfully');
    return channelId;
  }

  /**
   * Fund existing channel with additional XRP
   *
   * Submits PaymentChannelFund transaction to add XRP to existing channel.
   * Updates local cache with new channel amount.
   *
   * @param channelId - Channel ID to fund
   * @param additionalAmount - Additional XRP to deposit (drops)
   *
   * @example
   * await sdk.fundChannel(channelId, '500000000'); // Add 500 XRP
   */
  async fundChannel(channelId: string, additionalAmount: string): Promise<void> {
    this.logger.info({ channelId, additionalAmount }, 'Funding XRP payment channel...');

    // PaymentChannelFund transaction
    const tx = {
      TransactionType: 'PaymentChannelFund',
      Account: (this.xrplClient as unknown as { address: string }).address,
      Channel: channelId,
      Amount: additionalAmount,
    };

    await this.xrplClient.submitAndWait(tx as Record<string, unknown>);

    // Refresh channel state
    await this.refreshChannelState(channelId);

    this.logger.info({ channelId, additionalAmount }, 'XRP payment channel funded successfully');
  }

  /**
   * Sign claim for off-chain settlement
   *
   * Generates ed25519 signature for claim message.
   * Stores claim in database for dispute resolution.
   * Returns XRPClaim object for peer delivery.
   *
   * @param channelId - Channel ID to claim from
   * @param amount - Cumulative XRP to claim (drops)
   * @returns XRPClaim object with signature
   *
   * @example
   * const claim = await sdk.signClaim(channelId, '500000000');
   * // Send claim to peer via BTP or other transport
   */
  async signClaim(channelId: string, amount: string): Promise<XRPClaim> {
    this.logger.info({ channelId, amount }, 'Signing XRP payment channel claim...');

    // Delegate to ClaimSigner (Story 9.3)
    const signature = await this.claimSigner.signClaim(channelId, amount);
    const publicKey = this.claimSigner.getPublicKey();

    return {
      channelId,
      amount,
      signature,
      publicKey,
    };
  }

  /**
   * Verify claim signature
   *
   * Validates ed25519 signature for XRP claim.
   * Checks signature matches channel's public key.
   * Validates amount doesn't exceed channel capacity.
   *
   * @param claim - XRPClaim object to verify
   * @returns true if claim is valid
   *
   * @example
   * const isValid = await sdk.verifyClaim(claim);
   * if (!isValid) {
   *   throw new Error('Invalid claim signature');
   * }
   */
  async verifyClaim(claim: XRPClaim): Promise<boolean> {
    return this.claimSigner.verifyClaim(
      claim.channelId,
      claim.amount,
      claim.signature,
      claim.publicKey
    );
  }

  /**
   * Submit claim to ledger
   *
   * Submits PaymentChannelClaim transaction to redeem XRP.
   * Updates channel balance in database.
   * Refreshes local cache with new channel state.
   *
   * @param claim - XRPClaim object to submit
   * @param peerId - Optional peer identifier for telemetry (Story 9.7)
   *
   * @example
   * await sdk.submitClaim(claim);
   */
  async submitClaim(claim: XRPClaim, peerId?: string): Promise<void> {
    this.logger.info({ claim }, 'Submitting XRP payment channel claim...');

    // Verify claim before submission
    if (!(await this.verifyClaim(claim))) {
      throw new Error(`Invalid claim signature for channel ${claim.channelId}`);
    }

    // Get channel state before claim for remaining balance calculation
    const channelStateBefore = this.channelStateCache.get(claim.channelId);

    // Delegate to PaymentChannelManager (Story 9.4)
    await this.channelManager.submitClaim(
      claim.channelId,
      claim.amount,
      claim.signature,
      claim.publicKey
    );

    // Refresh channel state
    await this.refreshChannelState(claim.channelId);

    // Calculate remaining balance (Story 9.7)
    const remainingBalance = channelStateBefore
      ? (BigInt(channelStateBefore.amount) - BigInt(claim.amount)).toString()
      : '0';

    // Emit telemetry event (Story 9.7)
    try {
      this.telemetryEmitter?.emitXRPChannelClaimed(
        claim.channelId,
        claim.amount,
        remainingBalance,
        peerId
      );
    } catch (error) {
      this.logger.error({ error }, 'Failed to emit XRP_CHANNEL_CLAIMED telemetry');
      // Do NOT rethrow - telemetry errors must not break channel operations
    }

    this.logger.info({ channelId: claim.channelId }, 'XRP claim submitted successfully');
  }

  /**
   * Close channel cooperatively
   *
   * Submits PaymentChannelClaim with tfClose flag.
   * Channel enters 'closing' status with settlement delay.
   * After settle delay, channel finalizes and is removed from ledger.
   *
   * @param channelId - Channel ID to close
   * @param peerId - Optional peer identifier for telemetry (Story 9.7)
   *
   * @example
   * await sdk.closeChannel(channelId);
   */
  async closeChannel(channelId: string, peerId?: string): Promise<void> {
    this.logger.info({ channelId }, 'Closing XRP payment channel...');

    // Get channel state before closure (for finalBalance)
    const channelStateBefore = this.channelStateCache.get(channelId);
    const finalBalance = channelStateBefore?.balance || '0';

    // Delegate to PaymentChannelManager (Story 9.4)
    await this.channelManager.closeChannel(channelId);

    // Refresh channel state (status changes to 'closing')
    await this.refreshChannelState(channelId);

    // Emit telemetry event (Story 9.7)
    try {
      this.telemetryEmitter?.emitXRPChannelClosed(channelId, finalBalance, 'cooperative', peerId);
    } catch (error) {
      this.logger.error({ error }, 'Failed to emit XRP_CHANNEL_CLOSED telemetry');
      // Do NOT rethrow - telemetry errors must not break channel operations
    }

    this.logger.info({ channelId }, 'XRP channel close initiated (settling after delay)');
  }

  /**
   * Get channel state from ledger
   *
   * Queries ledger for current channel state.
   * Returns XRPChannelState with latest balance, status, expiration.
   *
   * @param channelId - Channel ID to query
   * @returns XRPChannelState object
   *
   * @example
   * const state = await sdk.getChannelState(channelId);
   * console.log('Balance:', state.balance, 'Status:', state.status);
   */
  async getChannelState(channelId: string): Promise<XRPChannelState> {
    this.logger.debug({ channelId }, 'Querying XRP channel state from ledger...');

    // Query ledger entry for channel
    const ledgerEntry = await (
      this.xrplClient as unknown as {
        request: (
          req: Record<string, string>
        ) => Promise<{ result: { node: Record<string, unknown> } }>;
      }
    ).request({
      command: 'ledger_entry',
      payment_channel: channelId,
    });

    // Parse ledger response to XRPChannelState
    const channelState = this.parseChannelState(ledgerEntry.result.node);

    // Update local cache
    this.channelStateCache.set(channelId, channelState);

    return channelState;
  }

  /**
   * Get all channels for current account
   *
   * Queries ledger for all payment channels where we are the source.
   * Returns array of channel IDs.
   *
   * @returns Array of channel IDs (64-char hex)
   *
   * @example
   * const channels = await sdk.getMyChannels();
   * console.log('Found', channels.length, 'channels');
   */
  async getMyChannels(): Promise<string[]> {
    this.logger.debug('Querying all XRP channels for account...');

    const xrplClientWithProps = this.xrplClient as unknown as {
      address: string;
      request: (req: Record<string, string>) => Promise<{
        result: { channels: Array<{ channel_id: string }> };
      }>;
    };

    const accountChannels = await xrplClientWithProps.request({
      command: 'account_channels',
      account: xrplClientWithProps.address,
    });

    return accountChannels.result.channels.map((c) => c.channel_id);
  }

  /**
   * Start automatic channel refresh
   *
   * Polls ledger for channel state changes every 30 seconds.
   * Updates local cache with latest channel data.
   * Emits events when channel state changes.
   */
  startAutoRefresh(): void {
    if (this.refreshIntervalId) {
      this.logger.warn('Auto-refresh already started');
      return;
    }

    this.logger.info('Starting XRP channel auto-refresh (30s interval)');

    this.refreshIntervalId = setInterval(async () => {
      try {
        await this.refreshAllChannels();
      } catch (error) {
        this.logger.error({ error }, 'Error during channel auto-refresh');
      }
    }, 30000); // 30 seconds
  }

  /**
   * Stop automatic channel refresh
   *
   * Clears refresh interval timer.
   * Must be called before SDK disposal to avoid memory leaks.
   *
   * @example
   * // Cleanup when SDK no longer needed
   * sdk.stopAutoRefresh();
   */
  stopAutoRefresh(): void {
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
      this.refreshIntervalId = undefined;
      this.logger.info('XRP channel auto-refresh stopped');
    }
  }

  /**
   * Refresh single channel state (private helper)
   *
   * Queries ledger for latest channel state and updates cache.
   *
   * @param channelId - Channel ID to refresh
   */
  private async refreshChannelState(channelId: string): Promise<void> {
    try {
      const channelState = await this.getChannelState(channelId);
      this.channelStateCache.set(channelId, channelState);
    } catch (error) {
      this.logger.error({ error, channelId }, 'Failed to refresh channel state');
    }
  }

  /**
   * Refresh all channels in cache (private helper)
   *
   * Iterates through all cached channels and refreshes state.
   */
  private async refreshAllChannels(): Promise<void> {
    const channelIds = Array.from(this.channelStateCache.keys());
    this.logger.debug({ count: channelIds.length }, 'Refreshing all XRP channels...');

    await Promise.all(channelIds.map((id) => this.refreshChannelState(id)));
  }

  /**
   * Parse ledger entry to XRPChannelState (private helper)
   *
   * Converts rippled JSON response to typed XRPChannelState object.
   *
   * @param node - Ledger entry node from rippled
   * @returns XRPChannelState object
   */
  private parseChannelState(node: Record<string, unknown>): XRPChannelState {
    return {
      channelId: node.ChannelID as string,
      account: node.Account as string,
      destination: node.Destination as string,
      amount: node.Amount as string,
      balance: (node.Balance as string) || '0',
      settleDelay: node.SettleDelay as number,
      publicKey: node.PublicKey as string,
      cancelAfter: node.CancelAfter as number | undefined,
      expiration: node.Expiration as number | undefined,
      status: node.Expiration ? 'closing' : 'open',
    };
  }
}
