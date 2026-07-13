/**
 * Per-Packet Claim Service
 *
 * Generates signed payment channel claims for each outgoing ILP PREPARE packet.
 * Claims travel with packets via BTP protocolData, ensuring the receiving peer
 * always holds an up-to-date signed balance proof.
 *
 * On-chain settlement remains threshold-based (time or amount) via SettlementMonitor,
 * but claims flow per-packet so the counterparty can always settle with the latest proof.
 *
 * Key behaviors:
 * - Cumulative transferred amounts are tracked per channel
 * - Nonces are monotonically increasing per channel
 * - Claims are mandatory for peer-forwarded packets (PacketHandler rejects without them)
 * - Claims only generated for PREPARE direction (outgoing)
 * - Returns null if no channel exists for a peer (caller must handle as rejection)
 * - Delegates signing to chain-appropriate PaymentChannelProvider via ChainProviderRegistry
 *
 * ## Reject semantics — claims are issued at FORWARD time, not FULFILL time (issue #316)
 *
 * {@link generateClaimForPacket} is called by the PacketHandler *before* it forwards
 * the PREPARE to the next hop, and it unconditionally advances the channel's cumulative
 * amount + nonce, signs the balance proof, sets it as `latestClaim`, and persists it.
 * The signed claim then rides the forwarded PREPARE in BTP protocolData, so the
 * counterparty holds it the instant the PREPARE arrives (its ClaimReceiver records the
 * claim at ingest, independent of the eventual FULFILL/REJECT).
 *
 * There is therefore NO way to "un-issue" a claim if the forward later REJECTs: the
 * counterparty already holds a valid signed cumulative proof and can redeem it on-chain,
 * and this service's own `latestClaim` (read by SettlementExecutor's auto-drive) keeps
 * the rejected packet's δ folded into the settleable cumulative. This is a *deliberate*
 * property of the per-packet-claim model (issue #76): the payer pays for the forward
 * ATTEMPT so the receiving connector is never exposed to an unpaid forward. The only
 * state reset is {@link resetChannel}, and it is settlement-scoped (post cooperative
 * settle), never per-reject. A payer-side "void on reject" is intentionally absent —
 * it would be unsound (the peer already holds the proof) and would break channel
 * monotonicity (the peer's ClaimReceiver requires strictly increasing nonce + amount).
 * See docs/local-delivery-fulfillment-contract.md § "Reject semantics" and issue #316.
 *
 * @module settlement/per-packet-claim-service
 */

import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';
import type { ChainProviderRegistry } from './provider/chain-provider-registry';
import type { PaymentChannelProvider } from './provider/payment-channel-provider';
import type { BlockchainType } from '../btp/btp-claim-types';
import type { ChannelManager } from './channel-manager';
import {
  BTP_CLAIM_PROTOCOL,
  type BTPClaimMessage,
  type EVMClaimMessage,
  type SolanaClaimMessage,
  type MinaClaimMessage,
  isEVMClaim,
  isSolanaClaim,
  isMinaClaim,
} from '../btp/btp-claim-types';
import { EVMPaymentChannelProvider } from './provider/evm-payment-channel-provider';
import { SolanaPaymentChannelProvider } from './provider/solana-payment-channel-provider';
import { MinaPaymentChannelProvider } from './provider/mina-payment-channel-provider';
import {
  type NIP59ClaimWrapper,
  BTP_WRAPPED_CLAIM_PROTOCOL,
  serializeWrappedClaim,
} from './privacy/nip59-claim-wrapper';
import { randomBytes } from 'crypto';

/**
 * BTP protocol data entry for claim attachment
 */
export interface BTPProtocolData {
  protocolName: string;
  contentType: number;
  data: Buffer;
}

/**
 * Cached context for a payment channel, avoiding repeated lookups
 */
interface ChannelClaimContext {
  channelId: string;
  provider: PaymentChannelProvider;
  blockchain: BlockchainType;
  tokenAddress: string;
  // EVM-specific fields (populated only when blockchain === 'evm')
  chainId?: number;
  tokenNetworkAddress?: string;
  signerAddress?: string;
  // Solana-specific fields (populated only when blockchain === 'solana')
  programId?: string;
  channelAccount?: string; // PDA address (same as channelId for Solana)
  signerPublicKey?: string;
  cluster?: string;
  tokenMint?: string;
  // Mina-specific fields (populated only when blockchain === 'mina')
  zkAppAddress?: string;
  minaTokenId?: string;
  minaNetwork?: string;
  minaSalt?: string; // per-session random salt, generated on first claim
}

/**
 * Result of per-packet claim generation
 */
export interface PerPacketClaimResult {
  protocolData: BTPProtocolData;
  claimMessage: BTPClaimMessage;
  /** SHA-256 execution condition (32 bytes) when NIP-59 condition derivation is active */
  executionCondition?: Uint8Array;
}

/**
 * PerPacketClaimService generates signed claims for each outgoing ILP packet.
 *
 * Claims are attached to BTP messages via protocolData and accumulate
 * cumulative transferred amounts. The latest claim is always available
 * for on-chain settlement via getLatestClaim().
 */
export class PerPacketClaimService {
  private readonly logger: Logger;
  private readonly cumulativeTransferred: Map<string, bigint> = new Map();
  private readonly currentNonce: Map<string, number> = new Map();
  private readonly channelClaimCache: Map<string, ChannelClaimContext> = new Map();
  private readonly latestClaim: Map<string, BTPClaimMessage> = new Map();

  constructor(
    private readonly _registry: ChainProviderRegistry,
    private readonly channelManager: ChannelManager,
    private readonly db: Database,
    logger: Logger,
    private readonly nodeId: string,
    private readonly peerIdToChainMap?: Map<string, string>,
    private readonly _nip59Wrapper?: NIP59ClaimWrapper,
    private readonly _nodePrivateKey?: Uint8Array,
    private readonly _peerNip59PubKeys?: Map<string, Uint8Array>
  ) {
    this.logger = logger.child({ component: 'per-packet-claim-service' });
    this.recoverFromDb();
  }

  /**
   * Generate a signed claim for an outgoing packet.
   *
   * Returns null if no channel exists for the peer. PacketHandler treats
   * a null return as a rejection condition (T00_INTERNAL_ERROR).
   *
   * @param toPeerId - Destination peer ID
   * @param tokenId - Token identifier (e.g., 'M2M')
   * @param amount - Packet amount to add to cumulative total
   * @returns PerPacketClaimResult with protocolData and claim, or null if no channel
   */
  async generateClaimForPacket(
    toPeerId: string,
    tokenId: string,
    amount: bigint
  ): Promise<PerPacketClaimResult | null> {
    // Look up channel context (cached or fresh)
    const cacheKey = `${toPeerId}:${tokenId}`;
    let ctx = this.channelClaimCache.get(cacheKey);

    if (!ctx) {
      const builtCtx = await this.buildChannelContext(toPeerId, tokenId);
      if (!builtCtx) {
        return null; // No channel for this peer — caller handles as rejection
      }
      ctx = builtCtx;
      this.channelClaimCache.set(cacheKey, ctx);
    }

    const { channelId } = ctx;

    // Increment cumulative transferred and nonce (synchronous — safe under Node.js single thread).
    //
    // Issue #316: this advance is unconditional and happens at FORWARD time. If the
    // packet this claim is minted for is later REJECTed downstream, this δ is NOT rolled
    // back — the cumulative is monotonic, the peer already receives the signed proof on
    // the forwarded PREPARE, and `latestClaim` (below) drives on-chain settlement of the
    // rejected δ too. That is the intended per-packet-claim contract, not a leak to patch
    // here. See the module-level "Reject semantics" note and issue #316.
    const prevCumulative = this.cumulativeTransferred.get(channelId) ?? 0n;
    const newCumulative = prevCumulative + amount;
    this.cumulativeTransferred.set(channelId, newCumulative);

    const prevNonce = this.currentNonce.get(channelId) ?? 0;
    const newNonce = prevNonce + 1;

    // Guard against nonce exceeding Number.MAX_SAFE_INTEGER (2^53 - 1).
    // Beyond this threshold, integer arithmetic loses precision, which could
    // allow signature replay or nonce reuse in payment channel claims.
    if (!Number.isSafeInteger(newNonce)) {
      this.logger.error(
        { channelId, prevNonce },
        'Nonce overflow: channel nonce exceeded MAX_SAFE_INTEGER, refusing to generate claim'
      );
      return null;
    }

    this.currentNonce.set(channelId, newNonce);

    // Sign balance proof via the chain-appropriate provider.
    // lockedAmount and locksRoot are EVM-specific concepts; Solana providers ignore them
    // but the chain-agnostic SignBalanceProofParams interface requires them.
    const locksRoot = '0x0000000000000000000000000000000000000000000000000000000000000000';
    const signature = await ctx.provider.signBalanceProof({
      channelId,
      nonce: newNonce,
      transferredAmount: newCumulative.toString(),
      lockedAmount: '0',
      locksRoot,
    });

    // Construct self-describing claim message
    const messageId = `${ctx.blockchain}-${channelId.substring(0, 8)}-${newNonce}-${Date.now()}`;
    const timestamp = new Date().toISOString();

    let claimMessage: BTPClaimMessage;

    if (ctx.blockchain === 'evm') {
      // EVM claim construction (backward compatible)
      if (!ctx.signerAddress) {
        throw new Error(
          `EVM claim construction requires signerAddress but it was not populated for channel ${channelId}`
        );
      }
      const evmClaim: EVMClaimMessage = {
        version: '1.0',
        blockchain: 'evm',
        messageId,
        timestamp,
        senderId: this.nodeId,
        channelId,
        nonce: newNonce,
        transferredAmount: newCumulative.toString(),
        lockedAmount: '0',
        locksRoot,
        signature,
        signerAddress: ctx.signerAddress,
        chainId: ctx.chainId,
        tokenNetworkAddress: ctx.tokenNetworkAddress,
        tokenAddress: ctx.tokenAddress,
      };
      claimMessage = evmClaim;
    } else if (ctx.blockchain === 'solana') {
      // Solana claim construction (Story 33.6)
      if (!ctx.programId || !ctx.channelAccount || !ctx.signerPublicKey) {
        throw new Error(
          `Solana claim construction requires programId, channelAccount, and signerPublicKey ` +
            `but they were not populated for channel ${channelId}`
        );
      }
      const solanaClaim: SolanaClaimMessage = {
        version: '1.0',
        blockchain: 'solana',
        messageId,
        timestamp,
        senderId: this.nodeId,
        programId: ctx.programId,
        channelAccount: ctx.channelAccount,
        nonce: newNonce,
        transferredAmount: newCumulative.toString(),
        signature,
        signerPublicKey: ctx.signerPublicKey,
        ...(ctx.cluster !== undefined && { cluster: ctx.cluster }),
      };
      claimMessage = solanaClaim;
    } else if (ctx.blockchain === 'mina') {
      // Mina claim construction (Story 34.7)
      if (!ctx.zkAppAddress || !ctx.minaTokenId) {
        throw new Error(
          `Mina claim construction requires zkAppAddress and minaTokenId ` +
            `but they were not populated for channel ${channelId}`
        );
      }
      // Generate per-session salt on first claim and cache it
      if (!ctx.minaSalt) {
        ctx.minaSalt = randomBytes(16).toString('hex');
      }
      const minaClaim: MinaClaimMessage = {
        version: '1.0',
        blockchain: 'mina',
        messageId,
        timestamp,
        senderId: this.nodeId,
        zkAppAddress: ctx.zkAppAddress,
        tokenId: ctx.minaTokenId,
        // NOTE: balanceCommitment carries the plaintext cumulative amount here.
        // The Mina provider's signBalanceProof() internally computes the Poseidon
        // commitment from this value. The receiver verifies via the zk-SNARK proof.
        balanceCommitment: newCumulative.toString(),
        // transferredAmount carries participant A's plaintext cumulative balance
        // (the same value that feeds balanceCommitment). It drives the on-chain
        // claimFromChannel in SettlementExecutor. balanceB/signatureB are left
        // undefined here: the per-packet path is unidirectional; dual-party
        // fields only apply to true bidirectional channels.
        transferredAmount: newCumulative.toString(),
        nonce: newNonce,
        // signBalanceProof returns the serialized (raw-JSON) zk-SNARK proof.
        // The canonical wire encoding for a Mina claim `proof` is base64-encoded
        // JSON (Issue #90): the inbound validateMinaClaim gate requires base64,
        // and the settlement-side verifier base64-decodes before JSON.parse.
        // Encoding here keeps our own produced claims valid against that gate.
        proof: Buffer.from(signature, 'utf8').toString('base64'),
        salt: ctx.minaSalt,
        // Self-describing signer pubkey (Issue #114): lets the receiver verify the
        // signature against the correct key and resolve participant identity for
        // the on-chain claimFromChannel of an externally-opened channel.
        ...(ctx.signerAddress !== undefined && { signerPublicKey: ctx.signerAddress }),
        ...(ctx.minaNetwork !== undefined && { network: ctx.minaNetwork }),
      };
      claimMessage = minaClaim;
    } else {
      // Future chain claim types will be constructed here based on blockchain discriminator
      throw new Error(`Claim construction not implemented for blockchain: ${ctx.blockchain}`);
    }

    // Store as latest claim for SettlementExecutor
    this.latestClaim.set(channelId, claimMessage);

    // Persist to DB (non-blocking)
    this.persistClaim(toPeerId, claimMessage);

    // Serialize to BTP protocolData (optionally NIP-59 wrapped with condition derivation)
    let protocolData: BTPProtocolData;
    let executionCondition: Uint8Array | undefined;
    if (
      this._nip59Wrapper?.isEnabled() &&
      this._nodePrivateKey &&
      this._peerNip59PubKeys?.has(toPeerId)
    ) {
      const wrapResult = this._nip59Wrapper.wrapClaimWithCondition(
        claimMessage,
        this._nodePrivateKey,
        this._peerNip59PubKeys.get(toPeerId)!
      );
      if (wrapResult) {
        protocolData = {
          protocolName: BTP_WRAPPED_CLAIM_PROTOCOL.NAME,
          contentType: BTP_WRAPPED_CLAIM_PROTOCOL.CONTENT_TYPE,
          data: serializeWrappedClaim(wrapResult.wrapped),
        };
        executionCondition = wrapResult.executionCondition;
      } else {
        protocolData = {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: BTP_CLAIM_PROTOCOL.CONTENT_TYPE,
          data: Buffer.from(JSON.stringify(claimMessage), 'utf8'),
        };
      }
    } else {
      protocolData = {
        protocolName: BTP_CLAIM_PROTOCOL.NAME,
        contentType: BTP_CLAIM_PROTOCOL.CONTENT_TYPE,
        data: Buffer.from(JSON.stringify(claimMessage), 'utf8'),
      };
    }

    this.logger.debug(
      {
        channelId,
        nonce: newNonce,
        cumulative: newCumulative.toString(),
        peerId: toPeerId,
        blockchain: ctx.blockchain,
      },
      'Generated per-packet claim'
    );

    return { protocolData, claimMessage, executionCondition };
  }

  /**
   * Get the latest signed claim for a channel.
   * Used by SettlementExecutor for on-chain settlement submission.
   *
   * @param channelId - Payment channel ID
   * @returns Latest BTPClaimMessage or null if no claims generated
   */
  getLatestClaim(channelId: string): BTPClaimMessage | null {
    return this.latestClaim.get(channelId) ?? null;
  }

  /**
   * Reset tracking state for a channel after successful on-chain settlement.
   * Called by SettlementExecutor after cooperative settle completes.
   *
   * @param channelId - Payment channel ID to reset
   */
  resetChannel(channelId: string): void {
    this.cumulativeTransferred.delete(channelId);
    this.currentNonce.delete(channelId);
    this.latestClaim.delete(channelId);

    // Invalidate any cached contexts referencing this channel
    for (const [key, ctx] of this.channelClaimCache.entries()) {
      if (ctx.channelId === channelId) {
        this.channelClaimCache.delete(key);
      }
    }

    this.logger.info({ channelId }, 'Channel claim tracking reset after settlement');
  }

  /**
   * Build channel claim context by looking up channel metadata and resolving
   * the chain-appropriate provider via the registry.
   * Returns null if no channel or no provider exists for the peer.
   */
  private async buildChannelContext(
    peerId: string,
    tokenId: string
  ): Promise<ChannelClaimContext | null> {
    let metadata = this.channelManager.getChannelForPeer(peerId, tokenId);
    if (!metadata) {
      // On-demand channel creation: peer may have connected after startup
      try {
        const peerChain = this.peerIdToChainMap?.get(peerId);
        await this.channelManager.ensureChannelExists(
          peerId,
          tokenId,
          peerChain ? { chain: peerChain } : undefined
        );
        metadata = this.channelManager.getChannelForPeer(peerId, tokenId);
      } catch (error) {
        this.logger.warn(
          { peerId, tokenId, error: error instanceof Error ? error.message : String(error) },
          'On-demand channel creation failed'
        );
      }
      if (!metadata) {
        return null;
      }
    }

    // Resolve the chain-appropriate provider from the registry
    const provider = this._registry.getProviderForPeer({
      peerId,
      chain: metadata.chain,
    });

    if (!provider) {
      this.logger.warn(
        { peerId, tokenId, chain: metadata.chain },
        'No provider found for peer chain'
      );
      return null;
    }

    try {
      // For EVM providers: get signing context for self-describing claim fields
      let evmContext:
        | { chainId: number; tokenNetworkAddress: string; signerAddress: string }
        | undefined;
      if (provider instanceof EVMPaymentChannelProvider) {
        evmContext = await provider.getSigningContext();
      }

      // For Solana providers: get Solana-specific context (Story 33.6)
      let solanaContext:
        | { programId: string; tokenMint: string; cluster: string; signerAddress: string }
        | undefined;
      if (provider instanceof SolanaPaymentChannelProvider) {
        solanaContext = provider.getSolanaContext();
      }

      // For Mina providers: get Mina-specific context (Story 34.7)
      let minaContext:
        | { zkAppAddress: string; tokenId: string; network: string; signerAddress: string }
        | undefined;
      if (provider instanceof MinaPaymentChannelProvider) {
        minaContext = await provider.getMinaContext();
      }

      return {
        channelId: metadata.channelId,
        provider,
        blockchain: provider.chainType,
        tokenAddress: metadata.tokenAddress,
        ...(evmContext && {
          chainId: evmContext.chainId,
          tokenNetworkAddress: evmContext.tokenNetworkAddress,
          signerAddress: evmContext.signerAddress,
        }),
        ...(solanaContext && {
          programId: solanaContext.programId,
          channelAccount: metadata.channelId, // channelId IS the PDA for Solana
          signerPublicKey: solanaContext.signerAddress,
          cluster: solanaContext.cluster,
          tokenMint: solanaContext.tokenMint,
        }),
        ...(minaContext && {
          zkAppAddress: minaContext.zkAppAddress,
          minaTokenId: minaContext.tokenId,
          minaNetwork: minaContext.network,
          // signerAddress is the producer's Mina pubkey, emitted on the claim as
          // a self-describing `signerPublicKey` (Issue #114).
          signerAddress: minaContext.signerAddress,
          // minaSalt is generated on first claim, not here
        }),
      };
    } catch (error) {
      this.logger.error(
        { peerId, tokenId, error: error instanceof Error ? error.message : String(error) },
        'Failed to build channel claim context'
      );
      return null;
    }
  }

  /**
   * Recover nonce and cumulative state from the sent_claims DB table on startup.
   * Ensures claim continuity across connector restarts.
   */
  private recoverFromDb(): void {
    try {
      // Query recent claims from sent_claims (all blockchain types), ordered newest first.
      // We only need the latest claim per channel for state recovery. The LIMIT caps memory
      // usage on startup — with few active channels, the latest claim per channel appears
      // within the first few hundred rows even under heavy traffic.
      const rows = this.db
        .prepare(
          `
          SELECT claim_data FROM sent_claims
          ORDER BY sent_at DESC
          LIMIT 1000
        `
        )
        .all() as Array<{ claim_data: string }>;

      const recoveredChannels = new Set<string>();

      for (const row of rows) {
        try {
          const claim = JSON.parse(row.claim_data) as BTPClaimMessage;

          // EVM claims have channelId, nonce, transferredAmount for state recovery
          if (isEVMClaim(claim)) {
            // Validate required recovery fields exist before using them
            if (
              typeof claim.channelId !== 'string' ||
              typeof claim.nonce !== 'number' ||
              typeof claim.transferredAmount !== 'string'
            ) {
              continue; // Skip structurally invalid claims
            }
            // Only recover the latest per channel (first seen since ordered DESC)
            if (!recoveredChannels.has(claim.channelId)) {
              recoveredChannels.add(claim.channelId);
              this.currentNonce.set(claim.channelId, claim.nonce);
              this.cumulativeTransferred.set(claim.channelId, BigInt(claim.transferredAmount));
              this.latestClaim.set(claim.channelId, claim);
            }
          }
          // Solana claims: recover nonce and cumulative state (Story 33.6)
          else if (isSolanaClaim(claim)) {
            if (
              typeof claim.channelAccount !== 'string' ||
              typeof claim.nonce !== 'number' ||
              typeof claim.transferredAmount !== 'string'
            ) {
              continue; // Skip structurally invalid claims
            }
            if (!recoveredChannels.has(claim.channelAccount)) {
              recoveredChannels.add(claim.channelAccount);
              this.currentNonce.set(claim.channelAccount, claim.nonce);
              this.cumulativeTransferred.set(claim.channelAccount, BigInt(claim.transferredAmount));
              this.latestClaim.set(claim.channelAccount, claim);
            }
          }
          // Mina claims: recover nonce state (Story 34.7)
          // Mina uses commitment-based balances, so cumulative is not recoverable from the claim.
          // Use BigInt(0) and rely on the provider's internal state for actual balances.
          else if (isMinaClaim(claim)) {
            if (typeof claim.zkAppAddress !== 'string' || typeof claim.nonce !== 'number') {
              continue; // Skip structurally invalid claims
            }
            if (!recoveredChannels.has(claim.zkAppAddress)) {
              recoveredChannels.add(claim.zkAppAddress);
              this.currentNonce.set(claim.zkAppAddress, claim.nonce);
              this.cumulativeTransferred.set(claim.zkAppAddress, BigInt(0));
              this.latestClaim.set(claim.zkAppAddress, claim);
            }
          }
          // Non-EVM/Solana/Mina claims: nonce/cumulative recovery is chain-specific and
          // deferred to future implementations (no storage in latestClaim until then)
        } catch {
          // Skip malformed claim data
        }
      }

      if (recoveredChannels.size > 0) {
        this.logger.info(
          { channelCount: recoveredChannels.size },
          'Recovered per-packet claim state from database'
        );
      }
    } catch (error) {
      // DB recovery failure is not fatal — we start fresh
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to recover claim state from database, starting fresh'
      );
    }
  }

  /**
   * Persist a sent claim to the database (non-blocking).
   */
  private persistClaim(peerId: string, claim: BTPClaimMessage): void {
    try {
      this.db
        .prepare(
          `
          INSERT INTO sent_claims (
            message_id, peer_id, blockchain, claim_data, sent_at
          ) VALUES (?, ?, ?, ?, ?)
        `
        )
        .run(claim.messageId, peerId, claim.blockchain, JSON.stringify(claim), Date.now());
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        this.logger.warn({ messageId: claim.messageId }, 'Duplicate claim message ID, skipping');
      } else {
        this.logger.error(
          { error, messageId: claim.messageId },
          'Failed to persist claim to database'
        );
      }
    }
  }
}
