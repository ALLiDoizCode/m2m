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

  constructor(
    paymentChannelSDK: PaymentChannelSDK | undefined,
    nodeId: string,
    logger: Logger,
    channelManager?: ChannelManager,
    nip59Wrapper?: NIP59ClaimWrapper,
    nip59PrivateKey?: Uint8Array,
    getPeerRelation?: PeerRelationResolver,
    chainRegistry?: ChainProviderRegistry,
    getReceivedClaimWatermark?: ReceivedClaimWatermarkLookup
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

    // Freshness gate (issue #353): before any cryptographic verification,
    // require the claim to STRICTLY advance the received-claim nonce watermark
    // for its (peer, channel). A replayed stale claim carries a perfectly
    // valid signature/proof, so a crypto-only gate admits it forever — the
    // watermark (the ClaimReceiver's own monotonicity reference) is the only
    // thing that distinguishes a replay from a fresh payment. Running it first
    // also means a replay never pays the cost of signature/zk verification.
    const staleReject = await this.checkClaimFreshness(claim, peerId);
    if (staleReject) {
      return staleReject;
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
   * Reject a claim that does not STRICTLY advance the received-claim nonce
   * watermark for its (peer, channel) — the fix for issue #353, where a
   * replayed stale-nonce claim (validly signed, so it passed the crypto gate)
   * got every job executed and FULFILLed for free while the ClaimReceiver's
   * replay verdict went nowhere.
   *
   * Semantics:
   * - No lookup wired, no watermark yet (first claim on this channel), or a
   *   watermark read failure → `null` (proceed to the cryptographic gate,
   *   which decides exactly as before this check existed). Fail-open on read
   *   errors is deliberate: a local DB hiccup must not F06-blackhole
   *   legitimate paid traffic — the crypto gate still stands.
   * - `claim.nonce <= watermark.nonce` → F06 reject. EQUAL nonce (a byte-exact
   *   replay of the latest verified claim) is deliberately rejected too:
   *   well-behaved clients sign a FRESH claim (nonce+1, cumulative amount
   *   bumped) for every paid write, so an equal nonce is always a replay,
   *   never a "retry with the same payment".
   * - Chain-agnostic: the watermark store keys on (peer, blockchain, channel),
   *   and all three claim types (EVM / Solana / Mina) carry a numeric `nonce`,
   *   so EVM and Solana get the same replay protection as Mina.
   *
   * This is a LOCAL DB read (the ClaimReceiver's `received_claims` store); the
   * per-packet hot path gains no chain RPC. The deeper per-chain checks — and
   * the Mina provider's on-chain-nonce comparison inside `verifyBalanceProof`,
   * which still covers the no-watermark case — are unchanged and run after
   * this gate.
   *
   * @param claim - Structurally validated claim message
   * @param peerId - Authenticated (or claim-derived ephemeral) peer ID
   * @returns null to proceed to crypto verification, or an F06 reject
   * @private
   */
  private async checkClaimFreshness(
    claim: BTPClaimMessage,
    peerId: string
  ): Promise<ILPRejectPacket | null> {
    if (!this.getReceivedClaimWatermark) {
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
      return null;
    }

    if (!watermark) {
      return null; // First claim on this channel → the crypto gate decides.
    }

    if (claim.nonce <= watermark.nonce) {
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

    return null;
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
