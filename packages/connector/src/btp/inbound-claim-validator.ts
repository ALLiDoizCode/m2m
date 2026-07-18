/**
 * Inbound Claim Validator
 *
 * Validates that inbound BTP packets carrying ILP PREPARE contain a valid
 * per-packet payment channel claim before they are forwarded to the packet handler.
 *
 * This is a security gate that prevents unpaid writes: without a valid signed claim,
 * the packet is rejected with F06 (Unexpected Payment) and never reaches the
 * local delivery handler or event store.
 *
 * @module inbound-claim-validator
 * @see RFC-0023 - Bilateral Transfer Protocol (BTP)
 */

import type { BTPProtocolData } from './btp-types';
import {
  BTP_CLAIM_PROTOCOL,
  validateClaimMessage,
  isEVMClaim,
  isSolanaClaim,
  isMinaClaim,
} from './btp-claim-types';
import type {
  BTPClaimMessage,
  EVMClaimMessage,
  SolanaClaimMessage,
  MinaClaimMessage,
  BlockchainType,
} from './btp-claim-types';
import {
  type NIP59ClaimWrapper,
  BTP_WRAPPED_CLAIM_PROTOCOL,
  deserializeWrappedClaim,
} from '../settlement/privacy/nip59-claim-wrapper';
import type { ILPPreparePacket, ILPRejectPacket } from '@toon-protocol/shared';
import { PacketType, ILPErrorCode } from '@toon-protocol/shared';
import type { BalanceProof } from '@toon-protocol/shared';
import type { PaymentChannelSDK } from '../settlement/payment-channel-sdk';
import type { ChainProviderRegistry } from '../settlement/provider/chain-provider-registry';
import type {
  PaymentChannelProvider,
  VerifyBalanceProofParams,
} from '../settlement/provider/payment-channel-provider';
import type { ChannelManager } from '../settlement/channel-manager';
import type { PeerRelation } from '../config/types';
import type { Logger } from '../utils/logger';

/**
 * Resolves the ILP peering relationship for an authenticated inbound peer.
 *
 * Backed by the forwarding path's single source of truth (the PacketHandler's
 * peer-relation map), so inbound claim validation stays consistent with the
 * outbound `requiresSettlementClaim` decision. Returns `undefined` for an
 * unregistered peer.
 */
export type PeerRelationResolver = (peerId: string) => PeerRelation | undefined;

/**
 * Reads the received-claim nonce watermark for a (peer, blockchain, channel)
 * tuple — the latest claim this connector has VERIFIED from that peer on that
 * channel. Backed by the ClaimReceiver's `received_claims` store
 * (`ClaimReceiver.getReceivedClaimWatermark`): a LOCAL DB read, never a chain
 * RPC, so consulting it keeps the per-packet hot path RPC-free.
 * Returns `null` when the channel has no verified claim yet.
 */
export type ReceivedClaimWatermarkLookup = (
  peerId: string,
  blockchain: BlockchainType,
  channelId: string
) => Promise<BTPClaimMessage | null>;

/**
 * Resolves the authoritative flat PRICE of a locally-terminated route for an
 * ILP destination — the connector's operator-configured `RouteTermination.price`
 * (decimal atomic-unit string, e.g. nano-USDC), used to bind a claim's value to
 * what the request costs (issue #359).
 *
 * Backed by the in-memory `RouteTerminationRegistry.match(destination)` (a LOCAL
 * map lookup keyed on ILP-address prefix, never a chain RPC), so consulting it
 * keeps the per-packet hot path RPC-free.
 *
 * Returns `null` when the destination is NOT a locally-terminated priced route
 * — a forwarded packet this connector merely relays, or a destination with no
 * termination registered. In those cases this connector is not the pricing
 * authority (the terminating node enforces its own price), so the value binding
 * does not apply and the gate falls back to freshness-only (issue #359 documents
 * this uncovered path explicitly).
 */
export type RoutePriceResolver = (destination: string) => string | null;

/**
 * Callback type for inbound claim validation.
 * Returns null if the packet should proceed, or an ILPRejectPacket to reject it.
 */
export type InboundClaimValidatorFn = (
  protocolData: BTPProtocolData[],
  ilpPacket: ILPPreparePacket,
  peerId: string
) => Promise<ILPRejectPacket | null>;

/**
 * InboundClaimValidator - Validates per-packet claims on inbound BTP packets
 *
 * Sits in the BTP server's message handling path, before the packet handler.
 * Ensures every ILP PREPARE arriving via BTP carries a valid signed payment
 * channel claim. Rejects packets without valid claims immediately.
 */
export class InboundClaimValidator {
  private readonly logger: Logger;
  private readonly paymentChannelSDK?: PaymentChannelSDK;
  private readonly chainRegistry?: ChainProviderRegistry;
  private readonly channelManager?: ChannelManager;
  private readonly nodeId: string;

  private readonly nip59Wrapper?: NIP59ClaimWrapper;
  private readonly nip59PrivateKey?: Uint8Array;

  /**
   * Resolves the source peer's ILP relation, enabling the relation-aware
   * parent skip (issue #78). Optional: when absent, every value-bearing PREPARE
   * requires an inline claim, preserving the pre-issue-78 behavior.
   */
  private readonly getPeerRelation?: PeerRelationResolver;

  /**
   * Received-claim watermark lookup (issue #353). When wired, every inbound
   * claim must STRICTLY advance the last verified claim's nonce for its
   * (peer, channel) before any cryptographic verification runs — closing the
   * replay hole where a stale-but-validly-signed claim passed the gate
   * forever. Optional: when absent the gate is crypto-only, preserving the
   * pre-#353 behavior for deployments without a ClaimReceiver store.
   */
  private readonly getReceivedClaimWatermark?: ReceivedClaimWatermarkLookup;

  /**
   * Route-price resolver (issue #359). When wired, an inbound claim on a
   * locally-terminated priced route must advance the received-claim cumulative
   * amount by AT LEAST that route's flat `price` — binding the claim's VALUE to
   * the request's PRICE, so a minimal fresh claim can no longer pay for an
   * expensive job (the operator-underpayment hole #359 flagged after #358 closed
   * the freshness/replay hole). Optional: when absent the gate is
   * freshness+crypto only, preserving the pre-#359 behavior. Enforced only for
   * chains whose claim carries a plaintext cumulative amount (EVM / Solana);
   * Mina's opaque `balanceCommitment` is a documented deferred path.
   */
  private readonly resolveRoutePrice?: RoutePriceResolver;

  /**
   * Mina value-binding migration switch (issue #359 / toon-meta#168).
   *
   * Mina claim VALUE is bound to route PRICE by opening the claim's plaintext
   * balance preimage against its signature-bound Poseidon commitment (Option B).
   * A claim that PRESENTS a preimage (carries `balanceB`) which does NOT open
   * the commitment is ALWAYS rejected — that is a tamper signal, regardless of
   * this flag. This flag governs only the migration-sensitive cases where the
   * preimage is ABSENT (an old client that predates the `balanceB` emit, or a
   * proof carrying no parseable commitment):
   * - `false` (default) → fail-open-and-log (`inbound_claim_value_unenforceable`,
   *   freshness-only), preserving #360's Mina posture during the client-rollout
   *   window so a wire/version gap never blackholes paid Mina traffic.
   * - `true` (post-rollout) → reject such claims (`inbound_claim_value_unopenable`).
   */
  private readonly minaValueBindingStrict: boolean;

  constructor(
    paymentChannelSDK: PaymentChannelSDK | undefined,
    nodeId: string,
    logger: Logger,
    channelManager?: ChannelManager,
    nip59Wrapper?: NIP59ClaimWrapper,
    nip59PrivateKey?: Uint8Array,
    getPeerRelation?: PeerRelationResolver,
    chainRegistry?: ChainProviderRegistry,
    getReceivedClaimWatermark?: ReceivedClaimWatermarkLookup,
    resolveRoutePrice?: RoutePriceResolver,
    minaValueBindingStrict = false
  ) {
    this.paymentChannelSDK = paymentChannelSDK;
    this.nodeId = nodeId;
    this.logger = logger.child({ component: 'InboundClaimValidator' });
    this.channelManager = channelManager;
    this.nip59Wrapper = nip59Wrapper;
    this.nip59PrivateKey = nip59PrivateKey;
    this.getPeerRelation = getPeerRelation;
    this.chainRegistry = chainRegistry;
    this.getReceivedClaimWatermark = getReceivedClaimWatermark;
    this.resolveRoutePrice = resolveRoutePrice;
    this.minaValueBindingStrict = minaValueBindingStrict;
  }

  /**
   * Validate that an inbound BTP packet has a valid per-packet claim.
   *
   * @param protocolData - BTP protocol data array from the message
   * @param ilpPacket - Deserialized ILP PREPARE packet
   * @param peerId - Authenticated peer ID
   * @returns null if valid (proceed), or ILPRejectPacket to reject
   */
  async validate(
    protocolData: BTPProtocolData[],
    ilpPacket: ILPPreparePacket,
    peerId: string
  ): Promise<ILPRejectPacket | null> {
    // Zero-amount packets carry no value — skip claim validation
    if (ilpPacket.amount === 0n) {
      this.logger.debug(
        { event: 'inbound_claim_skip_zero', peerId, destination: ilpPacket.destination },
        'Skipping claim validation for zero-amount packet'
      );
      return null;
    }

    // Relation-aware skip (issue #78): a parent forwards value to its children
    // WITHOUT a per-packet claim — a child accrues a balance owed up and settles
    // it via its own up-claims, exactly mirroring the outbound
    // `requiresSettlementClaim(peerId) === false for 'child'` skip in the
    // PacketHandler. Requiring an inline claim here would F06-reject every paid
    // packet the parent forwards down. So when the source peer is our 'parent',
    // accept without an inline claim.
    if (this.getPeerRelation?.(peerId) === 'parent') {
      this.logger.debug(
        { event: 'inbound_claim_skip_parent', peerId, destination: ilpPacket.destination },
        'Skipping inbound claim requirement for packet forwarded by parent peer'
      );
      return null;
    }

    // Find claim in protocol data — check both plaintext and NIP-59 wrapped
    let claimData = protocolData.find((pd) => pd.protocolName === BTP_CLAIM_PROTOCOL.NAME);
    let isWrapped = false;
    if (!claimData) {
      claimData = protocolData.find((pd) => pd.protocolName === BTP_WRAPPED_CLAIM_PROTOCOL.NAME);
      isWrapped = !!claimData;
    }

    if (!claimData) {
      this.logger.warn(
        {
          event: 'inbound_claim_missing',
          peerId,
          destination: ilpPacket.destination,
        },
        'Rejecting ILP PREPARE: no payment channel claim attached'
      );
      return this.createReject('No payment channel claim attached to packet');
    }

    // Parse and validate claim structure
    let claim: BTPClaimMessage;
    try {
      let parsed: unknown;
      if (isWrapped && this.nip59Wrapper && this.nip59PrivateKey) {
        const wrapped = deserializeWrappedClaim(claimData.data);
        parsed = this.nip59Wrapper.unwrapClaim(wrapped, this.nip59PrivateKey);
      } else if (isWrapped) {
        return this.createReject('Received NIP-59 wrapped claim but unwrapping not configured');
      } else {
        parsed = JSON.parse(claimData.data.toString('utf8'));
      }
      validateClaimMessage(parsed);
      claim = parsed;
    } catch (error) {
      this.logger.warn(
        {
          event: 'inbound_claim_invalid_structure',
          peerId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Rejecting ILP PREPARE: invalid claim structure'
      );
      return this.createReject(
        `Invalid claim structure: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Watermark gate (issues #353 + #359): before any cryptographic
    // verification, a SINGLE local watermark read feeds two checks —
    //  (1) FRESHNESS (#353): the claim's nonce must STRICTLY advance the
    //      received-claim nonce watermark for its (peer, channel), else the
    //      replay is F06-rejected. A replayed stale claim carries a perfectly
    //      valid signature/proof, so a crypto-only gate admits it forever.
    //  (2) VALUE↔PRICE (#359): on a locally-terminated priced route the claim
    //      must advance the cumulative amount by at least the route's flat
    //      price, else the underpayment is F06-rejected. A minimal fresh claim
    //      must not buy an expensive job.
    // Running both first also means a replay/underpayment never pays the cost
    // of signature/zk verification, and the packet never reaches the backend.
    const gateReject = await this.checkClaimAgainstWatermark(claim, ilpPacket, peerId);
    if (gateReject) {
      return gateReject;
    }

    // Dispatch verification based on blockchain type
    if (isEVMClaim(claim)) {
      // EVM claims require the EVM PaymentChannelSDK for EIP-712 verification.
      // On a standalone non-EVM node there is no SDK, so reject gracefully
      // rather than dereferencing an undefined SDK.
      if (!this.paymentChannelSDK) {
        this.logger.warn(
          { event: 'inbound_claim_no_evm_sdk', peerId, blockchain: claim.blockchain },
          'Rejecting ILP PREPARE: EVM claim received but no EVM payment-channel SDK configured'
        );
        return this.createReject('EVM claim received but EVM settlement is not configured');
      }
      return this.verifyEVMClaim(claim, peerId);
    }

    // Non-EVM claims (Solana / Mina): resolve the settlement provider for the
    // claim's chain and verify the claim's signature / zk-SNARK proof at the
    // gate, mirroring the EVM path. The provider exposes a chain-agnostic
    // `verifyBalanceProof()` backed by the same primitives ClaimReceiver uses
    // downstream (Ed25519 for Solana, zk-SNARK for Mina) — so a forged claim is
    // F06-rejected before the packet ever reaches the local delivery handler.
    if (isSolanaClaim(claim) || isMinaClaim(claim)) {
      const chainId = isSolanaClaim(claim)
        ? `solana:${claim.cluster ?? 'devnet'}`
        : `mina:${claim.network ?? 'devnet'}`;
      const provider = this.chainRegistry?.getProvider(claim.blockchain, chainId);
      if (!provider) {
        this.logger.warn(
          {
            event: 'inbound_claim_unsupported_chain',
            peerId,
            blockchain: claim.blockchain,
            chainId,
          },
          'Rejecting ILP PREPARE: no settlement provider registered for this blockchain'
        );
        return this.createReject(
          `No settlement provider registered for blockchain: ${claim.blockchain}`
        );
      }

      return isSolanaClaim(claim)
        ? this.verifySolanaClaim(claim, peerId, provider)
        : this.verifyMinaClaim(claim, peerId, provider);
    }

    // Unreachable: the three type guards above are exhaustive over BTPClaimMessage.
    return this.createReject(
      `Unsupported claim blockchain: ${(claim as BTPClaimMessage).blockchain}`
    );
  }

  /**
   * The received-claim watermark gate: a single local watermark read backing
   * both the freshness/replay check (issue #353) and the claim-value↔price
   * binding (issue #359), run before any cryptographic verification.
   *
   * FRESHNESS (#353): reject a claim that does not STRICTLY advance the
   * received-claim nonce watermark for its (peer, channel) — a replayed
   * stale-nonce claim (validly signed, so it passed the crypto gate) otherwise
   * gets every job executed and FULFILLed for free while the ClaimReceiver's
   * replay verdict goes nowhere. EQUAL nonce (a byte-exact replay of the latest
   * verified claim) is rejected too: well-behaved clients sign a FRESH claim
   * (nonce+1, cumulative amount bumped) for every paid write, so an equal nonce
   * is always a replay, never a "retry with the same payment".
   *
   * VALUE↔PRICE (#359): once fresh, the claim must advance the cumulative
   * amount by at least the route's flat price (see {@link checkClaimValue}) —
   * closing the secondary hole where a minimal fresh claim FULFILLs an
   * arbitrarily-priced job.
   *
   * Fail-open posture (deliberate): no lookup wired, no watermark yet (first
   * claim), or a watermark read failure → `null` (proceed to the crypto gate,
   * which decides exactly as before these checks existed). A local DB hiccup
   * must not F06-blackhole legitimate paid traffic, and without the prior
   * cumulative the value delta cannot be computed soundly.
   *
   * Chain-agnostic: the watermark store keys on (peer, blockchain, channel).
   * All three claim types carry a numeric `nonce` (so freshness covers EVM /
   * Solana / Mina uniformly); value binding additionally requires a plaintext
   * cumulative, which EVM and Solana carry but Mina does not (deferred there).
   *
   * LOCAL data only (the ClaimReceiver's `received_claims` store + the
   * in-memory route registry); the per-packet hot path gains no chain RPC and
   * at most one DB read.
   *
   * @param claim - Structurally validated claim message
   * @param ilpPacket - The PREPARE (its `destination` keys the route price)
   * @param peerId - Authenticated (or claim-derived ephemeral) peer ID
   * @returns null to proceed to crypto verification, or an F06 reject
   * @private
   */
  private async checkClaimAgainstWatermark(
    claim: BTPClaimMessage,
    ilpPacket: ILPPreparePacket,
    peerId: string
  ): Promise<ILPRejectPacket | null> {
    if (!this.getReceivedClaimWatermark) {
      // No watermark store wired (routing-only mode): neither the freshness
      // reference (#353) nor the prior-cumulative baseline the value check
      // (#359) needs is available, so fall back to the crypto gate exactly as
      // before either check existed.
      return null;
    }

    const channelId = isEVMClaim(claim)
      ? claim.channelId
      : isSolanaClaim(claim)
        ? claim.channelAccount
        : claim.zkAppAddress;

    let watermark: BTPClaimMessage | null;
    try {
      watermark = await this.getReceivedClaimWatermark(peerId, claim.blockchain, channelId);
    } catch (error) {
      this.logger.error(
        {
          event: 'inbound_claim_watermark_read_failed',
          peerId,
          blockchain: claim.blockchain,
          channelId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Received-claim watermark read failed; falling back to cryptographic gate only'
      );
      // Fail-open on a local DB hiccup for BOTH checks (#353 & #359): a
      // transient read error must not F06-blackhole legitimate paid traffic,
      // and without the prior cumulative the value delta cannot be computed
      // soundly (a 0 baseline would OVER-count the delta and weaken the gate).
      return null;
    }

    // ── (1) Freshness / replay (issue #353) ──
    if (watermark && claim.nonce <= watermark.nonce) {
      this.logger.warn(
        {
          event: 'inbound_claim_stale_nonce',
          peerId,
          blockchain: claim.blockchain,
          channelId,
          claimNonce: claim.nonce,
          watermarkNonce: watermark.nonce,
        },
        'Rejecting ILP PREPARE: claim nonce does not advance the received-claim watermark (replay)'
      );
      return this.createReject(
        `Stale payment claim: nonce ${claim.nonce} does not advance the received-claim watermark (latest verified nonce ${watermark.nonce})`
      );
    }

    // ── (2) Claim value ↔ route price (issue #359) ──
    // `watermark` here is null (first claim → cumulative baseline 0) or the
    // strictly-older verified claim (its cumulative amount is the prior paid
    // total). Reusing the same read keeps the hot path to ONE local DB read.
    return this.checkClaimValue(claim, ilpPacket, watermark, channelId, peerId);
  }

  /**
   * Bind an inbound claim's VALUE to the request's PRICE (issue #359).
   *
   * After freshness (#353) proves the claim is fresh, this requires the claim
   * to advance the channel's cumulative paid amount by at least the route's
   * flat price — otherwise a validly-signed, strictly-advancing claim that
   * bumps the cumulative by a single base unit would still FULFILL an
   * arbitrarily expensive job, underpaying the operator (the secondary hole
   * #353 flagged and #358 scoped out).
   *
   *   claimDelta = cumulative(claim) − cumulative(watermark ?? 0)
   *   reject (F06) iff claimDelta < resolvedRoutePrice
   *
   * Scope & fail-open posture (all deliberate, all documented in #359/#168):
   * - **Not wired / no price resolver** → freshness-only (pre-#359 behavior).
   * - **Destination is not a locally-terminated priced route** (`resolveRoutePrice`
   *   returns `null`: a forwarded packet, or no termination registered) → this
   *   connector is not the pricing authority; the terminating node enforces its
   *   own price. Freshness still applied above. Enumerated uncovered path.
   * - **Free route** (price ≤ 0) → nothing to enforce.
   * - **EVM / Solana claim** → carries a plaintext cumulative `transferredAmount`
   *   the signature already binds; read it directly.
   * - **Mina claim** → the cumulative hides behind a Poseidon `balanceCommitment`.
   *   Option B (toon-meta#168): OPEN that commitment at the gate by recomputing
   *   `Poseidon([transferredAmount, balanceB, salt])` from the plaintext wire
   *   fields and requiring it to equal the signature-bound commitment. A present
   *   preimage that does NOT open → REJECT (tamper). An absent preimage (old
   *   client / pre-rollout) → migration policy (see {@link minaValueBindingStrict}).
   *
   * Local data + one Poseidon hash for Mina — no chain RPC, no extra DB read.
   *
   * @param claim - Structurally validated, freshness-passed claim
   * @param ilpPacket - The PREPARE (its `destination` keys the route price)
   * @param watermark - The prior verified claim (or null on the first claim)
   * @param channelId - Chain-appropriate channel identifier (for logs)
   * @param peerId - Authenticated peer ID (for logs)
   * @returns null to proceed, or an F06 reject on underpayment / tamper
   * @private
   */
  private async checkClaimValue(
    claim: BTPClaimMessage,
    ilpPacket: ILPPreparePacket,
    watermark: BTPClaimMessage | null,
    channelId: string,
    peerId: string
  ): Promise<ILPRejectPacket | null> {
    if (!this.resolveRoutePrice) {
      return null; // Value binding not wired → freshness-only (pre-#359).
    }

    const priceStr = this.resolveRoutePrice(ilpPacket.destination);
    if (priceStr === null) {
      // Forwarded / non-terminated destination: not this connector's price to
      // enforce. Documented uncovered path (#359).
      return null;
    }

    let priceUnits: bigint;
    try {
      priceUnits = BigInt(priceStr);
    } catch {
      // A malformed configured price must not blackhole traffic; treat as
      // unenforceable and fall back to freshness-only.
      this.logger.error(
        {
          event: 'inbound_claim_price_malformed',
          peerId,
          destination: ilpPacket.destination,
          priceStr,
        },
        'Route price is not a valid integer string; skipping claim-value binding for this packet'
      );
      return null;
    }

    if (priceUnits <= 0n) {
      return null; // Free route → no value to bind.
    }

    // Resolve the claim's TRUSTED cumulative channel amount.
    let cumulative: bigint;
    if (isMinaClaim(claim)) {
      // Mina: open the signature-bound commitment (Option B, #359/#168).
      const opened = await this.openMinaClaimCumulative(
        claim,
        ilpPacket,
        channelId,
        peerId,
        priceUnits
      );
      if (opened.reject) {
        return opened.reject; // tamper (mismatch) or strict-mode unopenable → F06
      }
      if (opened.cumulative === undefined) {
        return null; // unenforceable (fail-open cutover) → freshness-only
      }
      cumulative = opened.cumulative;
    } else {
      // EVM / Solana: plaintext `transferredAmount` the signature already binds.
      const plain = this.extractCumulativeAmount(claim);
      if (plain === null) {
        return null; // Defensive: validateClaimMessage guarantees a numeric amount.
      }
      cumulative = plain;
    }

    const prior = watermark ? (this.extractCumulativeAmount(watermark) ?? 0n) : 0n;
    const claimDelta = cumulative - prior;

    if (claimDelta < priceUnits) {
      this.logger.warn(
        {
          event: 'inbound_claim_underpaid',
          peerId,
          blockchain: claim.blockchain,
          channelId,
          destination: ilpPacket.destination,
          claimDelta: claimDelta.toString(),
          routePrice: priceUnits.toString(),
        },
        'Rejecting ILP PREPARE: claim value does not cover the route price (underpayment)'
      );
      return this.createReject(
        `Insufficient claim value: claim advances the channel by ${claimDelta} but route price is ${priceUnits} (destination ${ilpPacket.destination})`
      );
    }

    return null;
  }

  /**
   * Open a Mina claim's plaintext cumulative amount against its signature-bound
   * Poseidon commitment (Option B for issue #359, design toon-meta#168).
   *
   * The Mina claim carries the commitment preimage in plaintext on the wire
   * (`transferredAmount` = balanceA, `balanceB`, `salt`), and the Pallas-Schnorr
   * signature the crypto gate verifies is over `Poseidon([balanceA, balanceB,
   * salt])`. Recomputing that hash and requiring it to equal the proof's
   * signature-bound `commitment` makes `transferredAmount` TRUSTED plaintext: a
   * payer cannot present balances opening to a commitment other than the one
   * they signed (Poseidon is collision-resistant). RPC-free — one hash over
   * fields already in hand; the signature itself is still verified downstream by
   * the crypto gate, so VALUE (here) and AUTHENTICITY (crypto) both gate the
   * packet before it reaches the backend.
   *
   * Outcomes:
   * - **match** → returns `{ cumulative }` (trusted); caller enforces the delta.
   * - **mismatch** (present preimage that does NOT open) → returns `{ reject }`
   *   ALWAYS — a tamper/attack signal, independent of migration phase.
   * - **absent preimage / unopenable** → migration policy
   *   ({@link minaValueBindingStrict}): fail-open-and-log (default) or reject.
   *
   * `balanceB`'s presence is the rollout marker: the upgraded per-packet client
   * emits it (`'0'` for the unidirectional case) precisely so the gate can
   * reconstruct the preimage; a claim lacking it predates the value-binding
   * emit and is treated as an absent preimage, not a tamper.
   *
   * @private
   */
  private async openMinaClaimCumulative(
    claim: MinaClaimMessage,
    ilpPacket: ILPPreparePacket,
    channelId: string,
    peerId: string,
    routePrice: bigint
  ): Promise<{ cumulative?: bigint; reject?: ILPRejectPacket }> {
    // Absent preimage (old client, pre-`balanceB` emit): a migration artifact,
    // not a tamper. `transferredAmount` and `salt` are required to open, and
    // `balanceB` is the rollout marker.
    if (
      claim.transferredAmount === undefined ||
      claim.balanceB === undefined ||
      claim.salt === undefined
    ) {
      return this.minaValueUnenforceable(claim, ilpPacket, channelId, peerId, routePrice, 'absent');
    }

    const chainId = `mina:${claim.network ?? 'devnet'}`;
    const provider = this.chainRegistry?.getProvider('mina', chainId);
    if (!provider?.openBalanceCommitment) {
      // No provider (or a provider that cannot open commitments): cannot bind
      // value → migration policy, same as an absent preimage.
      return this.minaValueUnenforceable(
        claim,
        ilpPacket,
        channelId,
        peerId,
        routePrice,
        'no_provider'
      );
    }

    let result: 'match' | 'mismatch' | 'unopenable';
    try {
      result = await provider.openBalanceCommitment({
        proof: claim.proof,
        balanceA: claim.transferredAmount,
        balanceB: claim.balanceB,
        salt: claim.salt,
      });
    } catch (error) {
      this.logger.warn(
        {
          event: 'inbound_claim_value_open_error',
          peerId,
          blockchain: claim.blockchain,
          channelId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Opening Mina balance commitment threw; falling back to migration policy'
      );
      return this.minaValueUnenforceable(claim, ilpPacket, channelId, peerId, routePrice, 'error');
    }

    if (result === 'mismatch') {
      // PRESENT preimage that does NOT open the signed commitment → tampered or
      // malformed claim. Reject ALWAYS (the security crux), independent of the
      // migration flag — this is an attack signal, not a rollout artifact.
      this.logger.warn(
        {
          event: 'inbound_claim_value_binding_mismatch',
          peerId,
          blockchain: claim.blockchain,
          channelId,
          destination: ilpPacket.destination,
        },
        'Rejecting ILP PREPARE: Mina claim balance preimage does not open its signed commitment (tampered claim)'
      );
      return {
        reject: this.createReject(
          'Invalid Mina claim: the plaintext balance preimage does not open the signed balance commitment'
        ),
      };
    }

    if (result === 'unopenable') {
      // Proof carries no parseable commitment (or o1js unavailable): structural,
      // not a tamper → migration policy.
      return this.minaValueUnenforceable(
        claim,
        ilpPacket,
        channelId,
        peerId,
        routePrice,
        'unopenable'
      );
    }

    // match → trusted plaintext.
    try {
      return { cumulative: BigInt(claim.transferredAmount) };
    } catch {
      return this.minaValueUnenforceable(claim, ilpPacket, channelId, peerId, routePrice, 'error');
    }
  }

  /**
   * Handle a Mina claim whose value cannot be bound because the openable
   * preimage is ABSENT or structurally unavailable (NOT a tamper). Applies the
   * {@link minaValueBindingStrict} migration switch: fail-open-and-log by
   * default (freshness-only, matching #360's Mina posture during rollout), or
   * F06-reject once the operator has flipped to strict post-client-rollout.
   *
   * @private
   */
  private minaValueUnenforceable(
    claim: MinaClaimMessage,
    ilpPacket: ILPPreparePacket,
    channelId: string,
    peerId: string,
    routePrice: bigint,
    reason: 'absent' | 'no_provider' | 'unopenable' | 'error'
  ): { cumulative?: bigint; reject?: ILPRejectPacket } {
    if (this.minaValueBindingStrict) {
      this.logger.warn(
        {
          event: 'inbound_claim_value_unopenable',
          peerId,
          blockchain: claim.blockchain,
          channelId,
          destination: ilpPacket.destination,
          routePrice: routePrice.toString(),
          reason,
        },
        'Rejecting ILP PREPARE: Mina claim has no openable balance preimage and strict value binding is enabled'
      );
      return {
        reject: this.createReject(
          'Mina claim value not bindable to route price: no openable balance preimage (strict mode)'
        ),
      };
    }

    this.logger.warn(
      {
        event: 'inbound_claim_value_unenforceable',
        peerId,
        blockchain: claim.blockchain,
        channelId,
        destination: ilpPacket.destination,
        routePrice: routePrice.toString(),
        reason,
      },
      'Mina claim value not bindable to price (no openable preimage); freshness-only for this packet (migration cutover)'
    );
    return {};
  }

  /**
   * Extract a claim's PLAINTEXT cumulative channel amount as a bigint, or null
   * when unavailable (issue #359).
   *
   * EVM and Solana claims carry `transferredAmount` — the cumulative amount
   * transferred over the channel's lifetime, bound by the signature — as a
   * decimal string. Mina claims carry it too (plaintext), but for a Mina claim
   * this is trustworthy ONLY once the commitment is opened
   * ({@link openMinaClaimCumulative}); this helper reads it directly and is used
   * for EVM/Solana current claims and for the trusted local WATERMARK baseline
   * of any chain (the prior verified claim, not attacker-controlled input).
   *
   * @private
   */
  private extractCumulativeAmount(claim: BTPClaimMessage): bigint | null {
    try {
      if (isEVMClaim(claim) || isSolanaClaim(claim)) {
        return BigInt(claim.transferredAmount);
      }
      // Mina: plaintext cumulative when present (watermark baseline).
      if (claim.transferredAmount !== undefined) {
        return BigInt(claim.transferredAmount);
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Verify an EVM claim's EIP-712 signature.
   *
   * @param claim - Validated EVM claim message
   * @param peerId - Authenticated peer ID
   * @returns null if valid (proceed), or ILPRejectPacket to reject
   * @private
   */
  private async verifyEVMClaim(
    claim: EVMClaimMessage,
    peerId: string
  ): Promise<ILPRejectPacket | null> {
    // Callers (validate) guard this; re-assert here so the local SDK reference
    // is non-null for the verification calls below.
    const paymentChannelSDK = this.paymentChannelSDK;
    if (!paymentChannelSDK) {
      return this.createReject('EVM claim received but EVM settlement is not configured');
    }

    // Verify EIP-712 signature
    // BigInt() can throw on non-numeric strings; wrap in try/catch for defense-in-depth
    // even though validateClaimMessage() already validates the format.
    let balanceProof: BalanceProof;
    try {
      balanceProof = {
        channelId: claim.channelId,
        nonce: claim.nonce,
        transferredAmount: BigInt(claim.transferredAmount),
        lockedAmount: BigInt(claim.lockedAmount),
        locksRoot: claim.locksRoot,
      };
    } catch {
      this.logger.warn(
        {
          event: 'inbound_claim_invalid_amount',
          peerId,
          channelId: claim.channelId,
        },
        'Rejecting ILP PREPARE: invalid transferredAmount or lockedAmount for BigInt conversion'
      );
      return this.createReject('Invalid claim amounts');
    }

    let signatureValid: boolean;
    try {
      // Prefer self-describing claims with explicit domain (Epic 31)
      if (claim.chainId !== undefined && claim.tokenNetworkAddress) {
        signatureValid = await paymentChannelSDK.verifyBalanceProofWithDomain(
          balanceProof,
          claim.signature,
          claim.signerAddress,
          claim.chainId,
          claim.tokenNetworkAddress
        );
      } else {
        // Fall back to known-channel verification
        const knownChannel = this.channelManager?.getChannelById(claim.channelId);
        if (!knownChannel) {
          this.logger.warn(
            {
              event: 'inbound_claim_unknown_channel',
              peerId,
              channelId: claim.channelId,
            },
            'Rejecting ILP PREPARE: unknown channel and no self-describing fields'
          );
          return this.createReject(
            'Unknown channel: claim must include chainId and tokenNetworkAddress'
          );
        }
        signatureValid = await paymentChannelSDK.verifyBalanceProof(
          balanceProof,
          claim.signature,
          claim.signerAddress
        );
      }
    } catch (error) {
      this.logger.warn(
        {
          event: 'inbound_claim_signature_error',
          peerId,
          channelId: claim.channelId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Rejecting ILP PREPARE: signature verification error'
      );
      return this.createReject('Signature verification failed');
    }

    if (!signatureValid) {
      this.logger.warn(
        {
          event: 'inbound_claim_invalid_signature',
          peerId,
          channelId: claim.channelId,
          signerAddress: claim.signerAddress,
        },
        'Rejecting ILP PREPARE: invalid EIP-712 signature'
      );
      return this.createReject('Invalid EIP-712 signature on claim');
    }

    this.logger.debug(
      {
        event: 'inbound_claim_validated',
        peerId,
        channelId: claim.channelId,
        transferredAmount: claim.transferredAmount,
        nonce: claim.nonce,
      },
      'Inbound claim validated successfully'
    );

    return null; // Claim is valid, proceed to packet handler
  }

  /**
   * Verify a Solana claim's Ed25519 balance-proof signature via the provider.
   *
   * Delegates the actual cryptography to the resolved `PaymentChannelProvider`
   * (`SolanaPaymentChannelProvider.verifyBalanceProof`), which reconstructs the
   * 48-byte balance-proof message and verifies it against the signer's base58
   * public key — the same primitive ClaimReceiver uses for redemption. The gate
   * does not query on-chain state (the per-packet hot path stays RPC-free);
   * full on-chain channel-state validation remains ClaimReceiver's job.
   * Replay freshness is enforced BEFORE this method by the received-claim
   * watermark check (issue #353) — this method verifies cryptography only.
   *
   * @param claim - Validated Solana claim message
   * @param peerId - Authenticated peer ID
   * @param provider - Resolved Solana payment-channel provider
   * @returns null if valid (proceed), or ILPRejectPacket to reject
   * @private
   */
  private async verifySolanaClaim(
    claim: SolanaClaimMessage,
    peerId: string,
    provider: PaymentChannelProvider
  ): Promise<ILPRejectPacket | null> {
    const verifyParams: VerifyBalanceProofParams = {
      channelId: claim.channelAccount,
      nonce: claim.nonce,
      transferredAmount: claim.transferredAmount,
      lockedAmount: '0',
      locksRoot: '0x' + '0'.repeat(64),
      signature: claim.signature,
      signerAddress: claim.signerPublicKey,
    };

    let signatureValid: boolean;
    try {
      signatureValid = await provider.verifyBalanceProof(verifyParams);
    } catch (error) {
      this.logger.warn(
        {
          event: 'inbound_claim_signature_error',
          peerId,
          blockchain: claim.blockchain,
          channelId: claim.channelAccount,
          error: error instanceof Error ? error.message : String(error),
        },
        'Rejecting ILP PREPARE: signature verification error'
      );
      return this.createReject('Signature verification failed');
    }

    if (!signatureValid) {
      this.logger.warn(
        {
          event: 'inbound_claim_invalid_signature',
          peerId,
          blockchain: claim.blockchain,
          channelId: claim.channelAccount,
          signerAddress: claim.signerPublicKey,
        },
        'Rejecting ILP PREPARE: invalid Ed25519 signature'
      );
      return this.createReject('Invalid Ed25519 signature on claim');
    }

    this.logger.debug(
      {
        event: 'inbound_claim_validated',
        peerId,
        blockchain: claim.blockchain,
        channelId: claim.channelAccount,
        transferredAmount: claim.transferredAmount,
        nonce: claim.nonce,
      },
      'Inbound claim validated successfully'
    );

    return null; // Claim is valid, proceed to packet handler
  }

  /**
   * Verify a Mina claim's zk-SNARK balance-proof via the provider.
   *
   * Delegates the actual cryptography to the resolved `PaymentChannelProvider`
   * (`MinaPaymentChannelProvider.verifyBalanceProof`), which deserializes and
   * verifies the zk-SNARK proof — the same primitive ClaimReceiver uses for
   * redemption. (Note: the Mina provider's verifyBalanceProof also reads the
   * on-chain nonceField via getChannelState — an existing RPC that only gates
   * against the LAST-SETTLED nonce, so it cannot catch off-chain replays; the
   * received-claim watermark check that runs before this method (issue #353)
   * is the replay gate. Full on-chain channel-state validation remains
   * ClaimReceiver's job.)
   *
   * @param claim - Validated Mina claim message
   * @param peerId - Authenticated peer ID
   * @param provider - Resolved Mina payment-channel provider
   * @returns null if valid (proceed), or ILPRejectPacket to reject
   * @private
   */
  private async verifyMinaClaim(
    claim: MinaClaimMessage,
    peerId: string,
    provider: PaymentChannelProvider
  ): Promise<ILPRejectPacket | null> {
    // Mina maps the zk-SNARK proof into the chain-agnostic `signature` slot and
    // the zkApp address into both `channelId` and `signerAddress` — mirroring
    // ClaimReceiver.buildMinaVerifyParams so the provider sees identical input.
    const verifyParams: VerifyBalanceProofParams = {
      channelId: claim.zkAppAddress,
      nonce: claim.nonce,
      transferredAmount: claim.balanceCommitment,
      lockedAmount: '0',
      locksRoot: '0x' + '0'.repeat(64),
      signature: claim.proof,
      signerAddress: claim.zkAppAddress,
    };

    let proofValid: boolean;
    try {
      proofValid = await provider.verifyBalanceProof(verifyParams);
    } catch (error) {
      // o1js Errors carry a non-enumerable `message`, so logging the raw object
      // emits `error: {}` and hides the cause (Issue #95). Stringify explicitly.
      this.logger.warn(
        {
          event: 'inbound_claim_signature_error',
          peerId,
          blockchain: claim.blockchain,
          channelId: claim.zkAppAddress,
          error: error instanceof Error ? error.message : String(error),
        },
        'Rejecting ILP PREPARE: signature verification error'
      );
      return this.createReject('Signature verification failed');
    }

    if (!proofValid) {
      this.logger.warn(
        {
          event: 'inbound_claim_invalid_signature',
          peerId,
          blockchain: claim.blockchain,
          channelId: claim.zkAppAddress,
        },
        'Rejecting ILP PREPARE: invalid zk-SNARK proof'
      );
      return this.createReject('Invalid zk-SNARK proof on claim');
    }

    this.logger.debug(
      {
        event: 'inbound_claim_validated',
        peerId,
        blockchain: claim.blockchain,
        channelId: claim.zkAppAddress,
        nonce: claim.nonce,
      },
      'Inbound claim validated successfully'
    );

    return null; // Claim is valid, proceed to packet handler
  }

  private createReject(message: string): ILPRejectPacket {
    return {
      type: PacketType.REJECT,
      code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
      triggeredBy: this.nodeId,
      message,
      data: Buffer.alloc(0),
    };
  }
}
