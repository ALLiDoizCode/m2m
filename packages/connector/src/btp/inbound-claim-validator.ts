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
import type { BTPClaimMessage, EVMClaimMessage } from './btp-claim-types';
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

  constructor(
    paymentChannelSDK: PaymentChannelSDK | undefined,
    nodeId: string,
    logger: Logger,
    channelManager?: ChannelManager,
    nip59Wrapper?: NIP59ClaimWrapper,
    nip59PrivateKey?: Uint8Array,
    getPeerRelation?: PeerRelationResolver,
    chainRegistry?: ChainProviderRegistry
  ) {
    this.paymentChannelSDK = paymentChannelSDK;
    this.nodeId = nodeId;
    this.logger = logger.child({ component: 'InboundClaimValidator' });
    this.channelManager = channelManager;
    this.nip59Wrapper = nip59Wrapper;
    this.nip59PrivateKey = nip59PrivateKey;
    this.getPeerRelation = getPeerRelation;
    this.chainRegistry = chainRegistry;
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

    // Non-EVM claims (Solana / Mina): admit inbound when a provider is
    // registered for the claim's chain. The real cryptographic verification of
    // Solana/Mina claims happens downstream in ClaimReceiver (which performs the
    // provider-backed signature / zk-SNARK check before redemption). Here we
    // only gate on whether this node can settle the claim's chain at all.
    if (isSolanaClaim(claim) || isMinaClaim(claim)) {
      const chainId = isSolanaClaim(claim)
        ? `solana:${claim.cluster ?? 'devnet'}`
        : `mina:${claim.network ?? 'devnet'}`;
      const provider = this.chainRegistry?.getProvider(claim.blockchain, chainId);
      if (provider) {
        this.logger.debug(
          {
            event: 'inbound_claim_accept_nonevm',
            peerId,
            blockchain: claim.blockchain,
            chainId,
          },
          'Accepting inbound non-EVM claim; cryptographic verification deferred to ClaimReceiver'
        );
        return null;
      }

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

    // Unreachable: the three type guards above are exhaustive over BTPClaimMessage.
    return this.createReject(
      `Unsupported claim blockchain: ${(claim as BTPClaimMessage).blockchain}`
    );
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
