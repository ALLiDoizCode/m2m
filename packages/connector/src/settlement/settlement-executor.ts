/**
 * Settlement Executor - Automated On-Chain Settlement via Payment Channels
 *
 * This module implements the SettlementExecutor class which bridges Epic 6's
 * TigerBeetle accounting system with chain-agnostic payment channel providers via ChainProviderRegistry (Epic 32).
 *
 * **Functionality:**
 * - Listens to SETTLEMENT_REQUIRED events from SettlementMonitor (Epic 6 Story 6.6)
 * - Opens new payment channels when no channel exists for a peer
 * - Signs balance proofs and executes cooperative settlements via existing channels
 * - Updates TigerBeetle accounts after successful on-chain settlement
 * - Handles settlement failures with retry logic
 *
 * **Integration Points:**
 * - SettlementMonitor: Receives SETTLEMENT_REQUIRED events (Epic 6 Story 6.6)
 * - ChainProviderRegistry: Resolves chain-specific PaymentChannelProvider (Epic 32)
 * - PaymentChannelProvider: Executes blockchain operations via chain-agnostic interface
 * - AccountManager: Updates TigerBeetle balances (Epic 6 Story 6.4)
 *
 * Source: Epic 32 Story 32.5 - Refactor SettlementExecutor for Multi-Chain
 *
 * @module settlement/settlement-executor
 */

import EventEmitter from 'events';
import { Logger } from 'pino';
import { SettlementState, SettlementTriggerEvent } from '../config/types';
import { AccountManager } from './account-manager';
import { SettlementMonitor } from './settlement-monitor';
import type { PerPacketClaimService } from './per-packet-claim-service';
import { isEVMClaim, isSolanaClaim, isMinaClaim } from '../btp/btp-claim-types';
import type { BTPClaimMessage } from '../btp/btp-claim-types';
import type { ChainProviderRegistry } from './provider/chain-provider-registry';
import type {
  PaymentChannelProvider,
  BalanceProofParams,
} from './provider/payment-channel-provider';
import type { ChannelManager } from './channel-manager';
import type { ClaimReceiver } from './claim-receiver';

/**
 * Derive the on-chain channel identifier carried by a claim, used by the
 * non-EVM channel-id fallback when no ChannelManager is available.
 *
 * - EVM: `channelId` (bytes32)
 * - Solana: `channelAccount` (PDA, base58)
 * - Mina: `zkAppAddress` (B62 address)
 *
 * @param claim - A verified BTP claim message
 * @returns The on-chain channel identifier, or null if unrecognized
 */
function deriveOnChainChannelId(claim: BTPClaimMessage): string | null {
  if (isEVMClaim(claim)) return claim.channelId;
  if (isSolanaClaim(claim)) return claim.channelAccount;
  if (isMinaClaim(claim)) return claim.zkAppAddress;
  return null;
}

/**
 * Configuration interface for SettlementExecutor
 *
 * @interface SettlementExecutorConfig
 * @property nodeId - Our connector node ID
 * @property defaultSettlementTimeout - Default challenge period for new channels (seconds, e.g., 86400 = 24h)
 * @property initialDepositMultiplier - Channel initial deposit = threshold × multiplier (default: 10)
 * @property minDepositThreshold - Add funds when deposit < threshold × multiplier × minDepositThreshold (default: 0.5)
 * @property maxRetries - Maximum retry attempts for transient failures (default: 3)
 * @property retryDelayMs - Initial retry delay in milliseconds (default: 5000ms)
 * @property tokenAddressMap - Maps tokenId (e.g., "M2M", "USDC") to ERC20 contract address
 * @property peerIdToAddressMap - Maps peerId (e.g., "connector-b") to Ethereum address
 * @property peerIdToChainMap - Maps peerId to chain identifier (e.g., "evm:anvil:31337")
 */
export interface SettlementExecutorConfig {
  nodeId: string;
  defaultSettlementTimeout: number;
  initialDepositMultiplier: number;
  minDepositThreshold: number;
  maxRetries: number;
  retryDelayMs: number;
  tokenAddressMap: Map<string, string>;
  peerIdToAddressMap: Map<string, string>;
  peerIdToChainMap: Map<string, string>;
}

/**
 * SettlementExecutor Class
 *
 * Executes automated on-chain settlements via payment channels when
 * TigerBeetle balances exceed configured thresholds.
 *
 * **Settlement Flow:**
 * 1. Receive SETTLEMENT_REQUIRED event from SettlementMonitor
 * 2. Mark settlement as IN_PROGRESS in SettlementMonitor
 * 3. Check if payment channel exists for peer
 * 4a. If no channel: Open new channel with initial deposit
 * 4b. If channel exists: Generate balance proof and cooperative settle
 * 5. Update TigerBeetle accounts after on-chain confirmation
 * 6. Mark settlement as COMPLETED in SettlementMonitor
 * 7. Log settlement outcome
 *
 * **Error Handling:**
 * - Transient errors (network failures, gas spikes): Retry with exponential backoff
 * - Permanent errors (insufficient funds, channel closed): Log error, halt
 * - Settlement failures leave state as IN_PROGRESS for manual intervention
 *
 * @class SettlementExecutor
 * @extends EventEmitter
 */
export class SettlementExecutor extends EventEmitter {
  private readonly config: SettlementExecutorConfig;
  private readonly accountManager: AccountManager;
  private readonly chainProviderRegistry: ChainProviderRegistry;
  private readonly settlementMonitor: SettlementMonitor;
  private readonly logger: Logger;
  private readonly boundHandleSettlement: (event: SettlementTriggerEvent) => void;
  private perPacketClaimService: PerPacketClaimService | null = null;
  private claimReceiver: ClaimReceiver | null = null;
  private channelManager: ChannelManager | null = null;

  /**
   * Settlement chain serializes all on-chain operations to prevent nonce collisions.
   * Each settlement is chained onto this promise so they execute sequentially.
   */
  private settlementChain: Promise<void> = Promise.resolve();

  /**
   * Flag to reject new settlements during shutdown.
   * Set to true in stop() before awaiting in-flight settlements.
   */
  private stopping = false;

  /**
   * Constructor
   *
   * Initializes the settlement executor with required dependencies.
   * Binds event handler ONCE in constructor to enable proper cleanup.
   *
   * @param config - Settlement executor configuration
   * @param accountManager - TigerBeetle account manager
   * @param chainProviderRegistry - Chain provider registry for resolving blockchain providers
   * @param settlementMonitor - Settlement threshold monitor
   * @param logger - Pino logger instance
   */
  constructor(
    config: SettlementExecutorConfig,
    accountManager: AccountManager,
    chainProviderRegistry: ChainProviderRegistry,
    settlementMonitor: SettlementMonitor,
    logger: Logger
  ) {
    super();
    this.config = config;
    this.accountManager = accountManager;
    this.chainProviderRegistry = chainProviderRegistry;
    this.settlementMonitor = settlementMonitor;

    // Create child logger with component context
    this.logger = logger.child({ component: 'settlement-executor' });

    // CRITICAL: Bind event handler ONCE in constructor for proper cleanup
    // Source: docs/architecture/test-strategy-and-standards.md Anti-Pattern 1
    this.boundHandleSettlement = this.handleSettlement.bind(this);

    this.logger.info(
      {
        nodeId: config.nodeId,
        defaultSettlementTimeout: config.defaultSettlementTimeout,
      },
      'Settlement executor initialized'
    );
  }

  /**
   * Set PerPacketClaimService for using latest per-packet claims in on-chain settlement
   * @param service - PerPacketClaimService instance
   */
  setPerPacketClaimService(service: PerPacketClaimService): void {
    this.perPacketClaimService = service;
    this.logger.info('PerPacketClaimService set for on-chain settlement');
  }

  /**
   * Set ClaimReceiver so the executor can resolve claims received over BTP when
   * this node is the claimer (credit side) calling claimFromChannel on-chain.
   *
   * @param receiver - ClaimReceiver instance
   */
  setClaimReceiver(receiver: ClaimReceiver): void {
    this.claimReceiver = receiver;
    this.logger.info('ClaimReceiver set for on-chain settlement');
  }

  /**
   * Set ChannelManager for chain-agnostic channel lookup
   * @param channelManager - ChannelManager instance
   */
  setChannelManager(channelManager: ChannelManager): void {
    this.channelManager = channelManager;
    this.logger.info('ChannelManager set for channel lookup');
  }

  /**
   * Start listening for settlement events
   *
   * Registers event listener for SETTLEMENT_REQUIRED events from SettlementMonitor.
   * Uses stored bound handler reference for proper cleanup in stop().
   *
   * Source: docs/architecture/test-strategy-and-standards.md Anti-Pattern 1
   */
  start(): void {
    this.stopping = false;
    this.settlementChain = Promise.resolve();
    this.settlementMonitor.on('SETTLEMENT_REQUIRED', this.boundHandleSettlement);
    this.logger.info('Settlement executor started');
  }

  /**
   * Stop listening for settlement events and await in-flight settlements
   *
   * 1. Sets stopping flag to reject new settlement events
   * 2. Unregisters event listener to prevent future events
   * 3. Awaits the settlement chain to drain all in-flight operations
   *
   * This ensures no settlement is left partially completed on shutdown,
   * preventing on-chain/off-chain balance mismatches.
   *
   * Source: docs/architecture/test-strategy-and-standards.md Anti-Pattern 1
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.settlementMonitor.off('SETTLEMENT_REQUIRED', this.boundHandleSettlement);

    // Await all in-flight settlements to complete before returning
    await this.settlementChain;
    this.logger.info('Settlement executor stopped (all in-flight settlements drained)');
  }

  /**
   * Handle settlement event
   *
   * Enqueues the settlement onto the serial settlement chain.
   * This ensures all on-chain transactions from the same wallet execute
   * sequentially, preventing nonce collisions on L2/mainnet.
   *
   * Events received after stop() is called are silently dropped.
   *
   * @param event - Settlement trigger event from SettlementMonitor
   * @private
   */
  private handleSettlement(event: SettlementTriggerEvent): void {
    if (this.stopping) {
      this.logger.warn(
        { peerId: event.peerId, tokenId: event.tokenId },
        'Settlement event ignored during shutdown'
      );
      return;
    }

    // Chain this settlement onto the queue — serializes all on-chain operations
    // to prevent nonce collisions from concurrent EVM transactions.
    this.settlementChain = this.settlementChain.then(() => this._processSettlement(event));
  }

  /**
   * Process a single settlement event
   *
   * Inner implementation that handles state transitions, execution,
   * and error handling for a single settlement.
   *
   * **State Transitions:**
   * 1. Mark settlement IN_PROGRESS immediately
   * 2. Execute settlement (open channel or cooperative settle)
   * 3. On success: Mark settlement COMPLETED
   * 4. On error: Log error, leave state IN_PROGRESS
   *
   * Source: Epic 6 Story 6.6 Settlement Monitor state machine
   *
   * @param event - Settlement trigger event from SettlementMonitor
   * @private
   */
  private async _processSettlement(event: SettlementTriggerEvent): Promise<void> {
    this.logger.info(
      {
        peerId: event.peerId,
        tokenId: event.tokenId,
        currentBalance: event.currentBalance.toString(),
        threshold: event.threshold.toString(),
        exceedsBy: event.exceedsBy.toString(),
      },
      'Settlement event received'
    );

    // Mark settlement IN_PROGRESS immediately
    // Source: Epic 6 Story 6.6 SettlementMonitor.markSettlementInProgress
    this.settlementMonitor.markSettlementInProgress(event.peerId, event.tokenId);
    this.logger.info(
      { peerId: event.peerId, tokenId: event.tokenId },
      'Marked settlement in progress'
    );

    try {
      // Execute settlement logic
      await this.executeSettlement(event);

      // Mark settlement COMPLETED after success
      this.settlementMonitor.markSettlementCompleted(event.peerId, event.tokenId);
      this.logger.info(
        { peerId: event.peerId, tokenId: event.tokenId },
        'Settlement completed, state reset to IDLE'
      );
    } catch (error) {
      // Log error but do NOT call markSettlementCompleted
      // State remains IN_PROGRESS for manual intervention
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      this.logger.error(
        {
          errorMessage,
          errorStack,
          errorType: error?.constructor?.name,
          peerId: event.peerId,
          tokenId: event.tokenId,
        },
        'Settlement failed'
      );
    }
  }

  /**
   * Execute settlement logic
   *
   * Main settlement execution flow:
   * 1. Get token address from tokenId
   * 2. Find existing payment channel for peer
   * 3. If no channel: Open new channel and deposit
   * 4. If channel exists: Sign balance proof and cooperative settle
   * 5. Update TigerBeetle accounts
   *
   * @param event - Settlement trigger event
   * @private
   */
  private async executeSettlement(event: SettlementTriggerEvent): Promise<void> {
    const { peerId, tokenId, currentBalance } = event;

    this.logger.info(
      { peerId, tokenId, currentBalance: currentBalance.toString() },
      'Executing settlement'
    );

    // Resolve the chain provider for this peer
    const chain = await this.resolveChainForPeer(peerId, tokenId);
    if (!chain) {
      throw new Error(`No chain configured for peer: ${peerId}`);
    }
    const provider = this.chainProviderRegistry.getProviderForPeer({ peerId, chain });
    if (!provider) {
      throw new Error(`No provider registered for chain: ${chain} (peer: ${peerId})`);
    }

    // Get token address from configuration
    const tokenAddress = this.config.tokenAddressMap.get(tokenId);
    if (!tokenAddress) {
      this.logger.error(
        { tokenId, availableTokens: Array.from(this.config.tokenAddressMap.keys()) },
        'Token address not found'
      );
      throw new Error(`Token address not found for tokenId: ${tokenId}`);
    }

    this.logger.debug({ tokenId, tokenAddress, chain }, 'Token address resolved');

    // Find existing channel for peer
    this.logger.debug({ peerId, tokenId }, 'Searching for existing channel');
    let channelId = await this.findChannelForPeer(peerId, tokenId, chain);

    // Non-EVM channel-id fallback (#86): when there is no ChannelManager (e.g. a
    // standalone Solana/Mina node), findChannelForPeer returns null. In that case
    // a verified inbound claim carries the on-chain channel identifier
    // (Solana channelAccount / Mina zkAppAddress) we need to redeem. Derive it.
    if (!channelId && this.claimReceiver && !this.channelManager) {
      const peerClaim = await this.claimReceiver.getLatestVerifiedClaimForPeer(peerId);
      if (peerClaim) {
        const derived = deriveOnChainChannelId(peerClaim);
        if (derived) {
          this.logger.info(
            { peerId, tokenId, channelId: derived, blockchain: peerClaim.blockchain },
            'Derived on-chain channel id from latest verified claim (no ChannelManager)'
          );
          channelId = derived;
        }
      }
    }

    if (!channelId) {
      // No existing channel: Open new channel and deposit
      this.logger.info(
        { peerId, tokenId, tokenAddress },
        'No existing channel found, opening new channel'
      );
      await this.openChannelAndSettle(peerId, tokenId, tokenAddress, currentBalance, provider);
    } else {
      // Existing channel: Sign balance proof and cooperative settle
      this.logger.info({ peerId, tokenId, channelId }, 'Using existing channel for settlement');
      await this.settleViaExistingChannel(channelId, peerId, tokenId, currentBalance, provider);
    }
  }

  /**
   * Resolve the settlement chain identifier for a peer.
   *
   * Lookup order:
   *   1. Static `peerIdToChainMap` (the normal path for peers listed in `peers:`
   *      config). Also serves as a cache for previously-resolved dynamic peers.
   *   2. The channel record for this peer (ChannelManager). A **dynamically
   *      connected (anonymous HS) inbound BTP peer** has a peer id minted at dial
   *      time that cannot be pre-listed in static config, so it never appears in
   *      `peerIdToChainMap`. Its chain *is* known from the channel record — the
   *      same `chain` field surfaced by `/admin/channels` (e.g. `solana:devnet`).
   *   3. The latest verified inbound claim (ClaimReceiver). Covers standalone
   *      non-EVM nodes that run without a ChannelManager: the claim's blockchain
   *      discriminator picks a registered provider for that chain family.
   *
   * On a fallback hit (2 or 3) the result is cached back into `peerIdToChainMap`
   * via {@link registerPeerChain} so subsequent settlements skip the lookup.
   *
   * Source: Issue #88 — settlement failed for dynamic inbound peers because the
   * executor only read static config and threw "No chain configured for peer".
   *
   * @param peerId - Peer connector ID
   * @param tokenId - Token identifier
   * @returns The resolved chain identifier, or undefined if none can be found
   * @private
   */
  private async resolveChainForPeer(peerId: string, tokenId: string): Promise<string | undefined> {
    // 1. Static peer config (and dynamic-peer cache).
    const configured = this.config.peerIdToChainMap.get(peerId);
    if (configured) {
      return configured;
    }

    // 2. Dynamic inbound peer: fall back to the channel record's chain.
    const channelChain = this.channelManager?.getChannelForPeer(peerId, tokenId)?.chain;
    if (channelChain) {
      this.logger.info(
        { peerId, tokenId, chain: channelChain },
        'Resolved settlement chain from channel record for dynamic inbound peer (#88)'
      );
      this.registerPeerChain(peerId, channelChain);
      return channelChain;
    }

    // 3. Standalone non-EVM node (no ChannelManager): derive from latest claim.
    if (this.claimReceiver) {
      const claim = await this.claimReceiver.getLatestVerifiedClaimForPeer(peerId);
      if (claim) {
        const provider = this.chainProviderRegistry
          .getAllProviders()
          .find((p) => p.chainType === claim.blockchain);
        if (provider) {
          this.logger.info(
            { peerId, tokenId, chain: provider.chainId, blockchain: claim.blockchain },
            'Resolved settlement chain from latest verified claim for dynamic inbound peer (#88)'
          );
          this.registerPeerChain(peerId, provider.chainId);
          return provider.chainId;
        }
      }
    }

    return undefined;
  }

  /**
   * Find existing payment channel for peer
   *
   * Uses ChannelManager's peer-channel index for chain-agnostic channel lookup,
   * then verifies on-chain status via the provider.
   *
   * The peer→channel index is keyed by tokenId. For EVM that key is the settlement
   * token symbol (e.g. `M2M`), the same value the SettlementMonitor emits. But a
   * non-EVM external channel is registered under a tokenId derived from its on-chain
   * token/program id (e.g. a Solana `programId`) — which never matches the
   * EVM-derived settlement tokenId. When the direct tokenId lookup misses, fall back
   * to scanning the peer's channels for an open one on the resolved `chain`, so the
   * already-verified channel is reused (`claimFromChannel`) instead of the executor
   * wrongly opening a brand-new channel (#92).
   *
   * @param peerId - Peer connector ID
   * @param tokenId - Token identifier
   * @param chain - Resolved settlement chain for the peer (used for the fallback scan)
   * @returns channelId if found, null otherwise
   * @private
   */
  private async findChannelForPeer(
    peerId: string,
    tokenId: string,
    chain?: string
  ): Promise<string | null> {
    try {
      if (!this.channelManager) {
        this.logger.warn({ peerId }, 'ChannelManager not set, cannot look up channels');
        return null;
      }

      // Trust ChannelManager's local state for channel lookup.
      // On-chain verification is deferred to the settlement operation itself.
      // ChannelManager normalizes all statuses to AdminChannelStatus ('open', 'closed', etc.)
      const metadata = this.channelManager.getChannelForPeer(peerId, tokenId);
      if (metadata) {
        return metadata.status === 'open' ? metadata.channelId : null;
      }

      // tokenId-keyed lookup missed — fall back to a peer+chain scan (#92).
      const candidate = this.channelManager
        .getChannelsForPeer(peerId)
        .find((c) => c.status === 'open' && (!chain || c.chain === chain));
      if (candidate) {
        this.logger.info(
          {
            peerId,
            tokenId,
            chain,
            channelId: candidate.channelId,
            channelTokenId: candidate.tokenId,
          },
          'Found open channel for peer via chain fallback (tokenId-keyed lookup missed) (#92)'
        );
        return candidate.channelId;
      }

      return null;
    } catch (error) {
      this.logger.error({ error, peerId, tokenId }, 'Failed to find channel for peer');
      return null; // Treat as no channel exists
    }
  }

  /**
   * Open new channel and deposit initial funds
   *
   * Opens a new payment channel (zero deposit) then deposits initial funds
   * as a separate operation. Uses the chain-agnostic provider interface.
   *
   * After channel open + deposit, updates TigerBeetle to reduce creditBalance.
   *
   * @param peerId - Peer connector ID
   * @param tokenId - Token identifier
   * @param tokenAddress - ERC20 token contract address
   * @param amount - Amount to deposit (current balance from event)
   * @param provider - Resolved chain provider
   * @returns channelId of newly opened channel
   * @private
   */
  private async openChannelAndSettle(
    peerId: string,
    tokenId: string,
    tokenAddress: string,
    amount: bigint,
    provider: PaymentChannelProvider
  ): Promise<string> {
    // Calculate initial deposit
    const initialDeposit = amount * BigInt(this.config.initialDepositMultiplier);

    // Get peer address
    const peerAddress = this.config.peerIdToAddressMap.get(peerId);
    if (!peerAddress) {
      throw new Error(`Peer address not found for peerId: ${peerId}`);
    }

    this.logger.info(
      {
        peerId,
        tokenId,
        tokenAddress,
        peerAddress,
        initialDeposit: initialDeposit.toString(),
      },
      'Opening new payment channel'
    );

    // Step 1: Open channel (zero deposit via provider)
    const { channelId, txHash } = await this.retryWithBackoff(
      async () => await provider.openChannel(peerAddress, this.config.defaultSettlementTimeout),
      'openChannel',
      this.config.maxRetries
    );

    this.logger.info(
      {
        channelId,
        peerId,
        tokenId,
        txHash,
      },
      'Channel opened, depositing initial funds'
    );

    // Step 2: Deposit initial funds separately
    await this.retryWithBackoff(
      async () => await provider.deposit(channelId, initialDeposit.toString()),
      'deposit',
      this.config.maxRetries
    );

    this.logger.info(
      {
        channelId,
        peerId,
        tokenId,
        initialDeposit: initialDeposit.toString(),
      },
      'Channel funded for settlement'
    );

    // Update TigerBeetle: Record settlement to reduce creditBalance
    // We deposited funds into channel, so peer's debt to us decreases
    await this.accountManager.recordSettlement(peerId, tokenId, amount);

    this.logger.info(
      { peerId, tokenId, amount: amount.toString() },
      'TigerBeetle balance updated after channel deposit'
    );

    // Emit CHANNEL_ACTIVITY event for ChannelManager
    this.emit('CHANNEL_ACTIVITY', { channelId });

    return channelId;
  }

  /**
   * Settle via existing payment channel
   *
   * Claims transferred funds from the channel using the sender's latest
   * per-packet signed balance proof. The channel remains open after claiming —
   * the sender can continue sending packets and funding the channel.
   *
   * @param channelId - Payment channel ID
   * @param peerId - Peer connector ID
   * @param tokenId - Token identifier
   * @param amount - Amount to settle
   * @param provider - Resolved chain provider
   * @private
   */
  private async settleViaExistingChannel(
    channelId: string,
    peerId: string,
    tokenId: string,
    amount: bigint,
    provider: PaymentChannelProvider
  ): Promise<void> {
    // claimFromChannel is invoked by the CREDIT side: we redeem using the
    // peer's signed balance proof received over BTP. Prefer ClaimReceiver
    // (received claims) and fall back to PerPacketClaimService (sent claims)
    // only for edge cases where this node also sent claims on the same channel.
    const receivedClaim = this.claimReceiver
      ? await this.claimReceiver.getLatestVerifiedClaimForChannel(peerId, channelId)
      : null;
    const sentClaim = this.perPacketClaimService?.getLatestClaim(channelId) ?? null;
    const latestClaim = receivedClaim ?? sentClaim;

    if (!latestClaim) {
      this.logger.error(
        { channelId, peerId },
        'No per-packet claim available for settlement — cannot compute balance proof without chain-specific state'
      );
      throw new Error(`No per-packet claim available for channel ${channelId}`);
    }

    // Per-packet claims already accumulated the correct cumulative state.
    // Build per-chain BalanceProofParams and resolve the on-chain channel id
    // from the claim itself (EVM uses the local channelId; non-EVM claims carry
    // their own on-chain account/zkApp address).
    let onChainChannelId: string;
    let balanceProofParams: BalanceProofParams;
    let claimSignature: string;

    if (isEVMClaim(latestClaim)) {
      onChainChannelId = channelId;
      balanceProofParams = {
        channelId,
        nonce: latestClaim.nonce,
        transferredAmount: latestClaim.transferredAmount,
        lockedAmount: latestClaim.lockedAmount,
        locksRoot: latestClaim.locksRoot,
      };
      claimSignature = latestClaim.signature;
    } else if (isSolanaClaim(latestClaim)) {
      onChainChannelId = latestClaim.channelAccount;
      balanceProofParams = {
        channelId: latestClaim.channelAccount,
        nonce: latestClaim.nonce,
        transferredAmount: latestClaim.transferredAmount,
        lockedAmount: '0',
        locksRoot: '',
        // The Ed25519 precompile must verify the signature against the key that
        // signed the balance proof (the counterparty for inbound claims), not
        // our own submitting signer. Ed25519 signatures are not recoverable, so
        // the signer pubkey must be supplied explicitly.
        signerPublicKey: latestClaim.signerPublicKey,
      };
      // Base64 Ed25519 signature; the Solana provider decodes it.
      claimSignature = latestClaim.signature;
    } else if (isMinaClaim(latestClaim)) {
      onChainChannelId = latestClaim.zkAppAddress;
      balanceProofParams = {
        channelId: latestClaim.zkAppAddress,
        nonce: latestClaim.nonce,
        // transferredAmount carries participant A's plaintext balance; fall back
        // to balanceCommitment (which also carries the plaintext amount).
        transferredAmount: latestClaim.transferredAmount ?? latestClaim.balanceCommitment,
        lockedAmount: '0',
        locksRoot: '',
        // Dual-party (#84) fields — undefined => unidirectional fallback (the
        // Mina provider already warns and reuses participant A's signature).
        balanceB: latestClaim.balanceB,
        salt: latestClaim.salt,
        signatureB: latestClaim.signatureB,
        // Counterparty pubkey (Issue #114): lets the provider resolve participant
        // identity for the on-chain claimFromChannel of an externally-opened
        // channel whose keys are not in the SDK's participant cache.
        signerPublicKey: latestClaim.signerPublicKey,
      };
      // Participant A's signature is carried in the claim's `proof` field.
      claimSignature = latestClaim.proof;
    } else {
      throw new Error(
        `Unsupported claim blockchain for settlement: ${(latestClaim as BTPClaimMessage).blockchain}`
      );
    }

    this.logger.info(
      {
        channelId: onChainChannelId,
        blockchain: latestClaim.blockchain,
        nonce: balanceProofParams.nonce,
        transferred: balanceProofParams.transferredAmount,
      },
      'Using latest per-packet claim for on-chain settlement (claimFromChannel)'
    );

    // Claim from channel — transfers delta tokens to us, channel stays open
    await this.retryWithBackoff(
      async () =>
        await provider.claimFromChannel(onChainChannelId, balanceProofParams, claimSignature),
      'claimFromChannel',
      this.config.maxRetries
    );

    this.logger.info(
      { channelId, amount: amount.toString() },
      'Claim from channel completed — channel remains open'
    );

    // Update TigerBeetle after successful on-chain claim
    await this.accountManager.recordSettlement(peerId, tokenId, amount);

    // Reset per-packet claim tracking after successful claim
    if (this.perPacketClaimService) {
      this.perPacketClaimService.resetChannel(channelId);
    }

    this.logger.info(
      { peerId, tokenId, amount: amount.toString() },
      'Accounting balance updated after claim'
    );

    // Emit CHANNEL_ACTIVITY event for ChannelManager
    this.emit('CHANNEL_ACTIVITY', { channelId });
  }

  /**
   * Retry operation with exponential backoff
   *
   * Retries transient failures with exponential backoff delay.
   * Throws immediately on non-retryable errors.
   *
   * Retry delays: 5s, 10s, 20s (configurable via retryDelayMs)
   *
   * @param operation - Async operation to retry
   * @param operationName - Name for logging
   * @param maxRetries - Maximum retry attempts
   * @returns Result of operation
   * @throws Error if all retries exhausted or non-retryable error
   * @private
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxRetries: number
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if error is retryable
        if (!this.isRetryableError(lastError)) {
          this.logger.error({ error: lastError, operationName }, 'Non-retryable error, aborting');
          throw lastError;
        }

        if (attempt < maxRetries) {
          const delayMs = this.config.retryDelayMs * 2 ** (attempt - 1);
          this.logger.warn(
            { attempt, maxRetries, operationName, delayMs, error: lastError.message },
            'Retrying settlement operation'
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    this.logger.error({ operationName, maxRetries }, 'Max retries exhausted');
    throw lastError;
  }

  /**
   * Check if error is retryable
   *
   * Determines if an error is transient and should be retried.
   *
   * **Retryable errors:**
   * - Network timeouts
   * - Gas price too high
   * - Nonce too low (transaction pending)
   *
   * **Non-retryable errors:**
   * - Insufficient funds
   * - Channel closed
   * - Invalid signature
   * - ChallengeNotExpiredError (settlement timing)
   *
   * @param error - Error to check
   * @returns true if retryable, false otherwise
   * @private
   */
  private isRetryableError(error: Error): boolean {
    const errorMessage = error.message.toLowerCase();

    // Retryable errors
    if (
      errorMessage.includes('timeout') ||
      errorMessage.includes('network') ||
      errorMessage.includes('gas price') ||
      errorMessage.includes('nonce too low') ||
      errorMessage.includes('replacement') || // Transaction replacement errors
      errorMessage.includes('already known') || // Transaction already in mempool
      errorMessage.includes('nonce has already been used') // Nonce conflict
    ) {
      return true;
    }

    // Non-retryable errors
    if (
      errorMessage.includes('insufficient funds') ||
      errorMessage.includes('channel closed') ||
      errorMessage.includes('invalid signature') ||
      errorMessage.includes('challenge not expired') ||
      error.constructor.name === 'ChallengeNotExpiredError'
    ) {
      return false;
    }

    // Default: Treat unknown errors as non-retryable for safety
    return false;
  }

  /**
   * Register or update a peer's chain mapping at runtime.
   *
   * Supports mixed EVM+Solana deployments where peers may be discovered
   * dynamically via self-describing claims or peer discovery service.
   * Existing mappings are overwritten if chainId changes (e.g., peer migrates chains).
   *
   * @param peerId - Peer connector ID
   * @param chainId - Chain identifier (e.g., 'evm:8453', 'solana:mainnet-beta')
   */
  registerPeerChain(peerId: string, chainId: string): void {
    const existingChain = this.config.peerIdToChainMap.get(peerId);
    this.config.peerIdToChainMap.set(peerId, chainId);

    if (existingChain && existingChain !== chainId) {
      this.logger.info(
        { event: 'peer_chain_updated', peerId, oldChain: existingChain, newChain: chainId },
        'Peer chain mapping updated'
      );
    } else if (!existingChain) {
      this.logger.info(
        { event: 'peer_chain_registered', peerId, chainId },
        'Peer chain mapping registered'
      );
    }
  }

  /**
   * Register or update a peer's settlement address at runtime.
   *
   * @param peerId - Peer connector ID
   * @param address - On-chain address for this peer (format depends on chain)
   */
  registerPeerAddress(peerId: string, address: string): void {
    if (!this.config.peerIdToAddressMap.has(peerId)) {
      this.config.peerIdToAddressMap.set(peerId, address);
      this.logger.info(
        { event: 'peer_address_registered', peerId },
        'Peer settlement address registered'
      );
    }
  }

  /**
   * Get settlement state for peer-token pair
   *
   * Queries the SettlementMonitor for current settlement state.
   * Useful for debugging and monitoring.
   *
   * @param peerId - Peer connector ID
   * @param tokenId - Token identifier
   * @returns Current settlement state
   */
  getSettlementState(peerId: string, tokenId: string): SettlementState {
    return this.settlementMonitor.getSettlementState(peerId, tokenId);
  }
}
