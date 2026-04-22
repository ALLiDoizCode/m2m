/**
 * Sent Claims Query Helpers
 *
 * Pure read-side queries over the shared `sent_claims` SQLite table written by
 * both `ClaimSender` (deprecated) and `PerPacketClaimService` (live).
 *
 * Decoupled from either writer service so that consumers — notably the admin
 * API's /admin/earnings.json endpoint (Story 37.7) — can depend on queries
 * without dragging in either writer's BTP / lifecycle surface.
 *
 * The inbound equivalent (`ClaimReceiver.getCumulativeInboundByAsset` +
 * `getRecentClaims`) is a method on `ClaimReceiver` because that class owns
 * the writer path end-to-end. The outbound equivalent is standalone because
 * the writer ownership is split across two services.
 *
 * @module settlement/sent-claims-queries
 */

import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';
import {
  type BTPClaimMessage,
  type BlockchainType,
  isEVMClaim,
  isSolanaClaim,
  isMinaClaim,
} from '../btp/btp-claim-types';

export class SentClaimsQueries {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger
  ) {}

  /**
   * Compute cumulative outbound claim amounts per (blockchain, tokenAddress)
   * for a peer — mirrors `ClaimReceiver.getCumulativeInboundByAsset()`.
   *
   * For each distinct channel to the peer, takes the claim with the highest
   * `nonce` (our latest signed cumulative balance proof) and sums the
   * `transferredAmount` values across channels belonging to the same asset.
   *
   * Used by `/admin/earnings.json` (Story 37.7) to populate `claimsSentTotal`.
   * This is the authoritative source for "how much have we paid this peer"
   * — we only sign outbound claims from our side, so only outbound claims
   * land in the `sent_claims` table.
   *
   * @param peerId - Peer connector ID
   * @returns Map keyed by `${blockchain}:${tokenAddress}` with cumulative
   *   amount (bigint) and latest claim timestamp (epoch ms).
   */
  async getCumulativeOutboundByAsset(
    peerId: string
  ): Promise<
    Map<string, { blockchain: BlockchainType; tokenAddress: string; total: bigint; lastAt: number }>
  > {
    const out = new Map<
      string,
      { blockchain: BlockchainType; tokenAddress: string; total: bigint; lastAt: number }
    >();

    try {
      // sent_claims does not carry channel_id as a column; it's inside the
      // JSON blob. Fetch all rows for the peer and reduce in JS. Bounded by
      // peer-level fan-out; same cost-profile argument as the inbound side
      // (see ClaimReceiver.getCumulativeInboundByAsset).
      const stmt = this.db.prepare(`
        SELECT blockchain, claim_data, sent_at
        FROM sent_claims
        WHERE peer_id = ?
      `);
      const rows = stmt.all(peerId) as Array<{
        blockchain: string;
        claim_data: string;
        sent_at: number;
      }>;

      const latestByChannel = new Map<
        string,
        {
          blockchain: BlockchainType;
          tokenAddress: string;
          amount: bigint;
          nonce: number;
          sentAt: number;
        }
      >();

      for (const row of rows) {
        let claim: BTPClaimMessage;
        try {
          claim = JSON.parse(row.claim_data) as BTPClaimMessage;
        } catch {
          continue;
        }
        let channelId = '';
        let tokenAddress = '';
        let amount = 0n;
        let nonce = 0;
        if (isEVMClaim(claim)) {
          channelId = claim.channelId;
          tokenAddress = claim.tokenAddress ?? '';
          try {
            amount = BigInt(claim.transferredAmount ?? '0');
          } catch {
            amount = 0n;
          }
          nonce = claim.nonce ?? 0;
        } else if (isSolanaClaim(claim)) {
          channelId = claim.channelAccount;
          tokenAddress = claim.programId;
          try {
            amount = BigInt(claim.transferredAmount ?? '0');
          } catch {
            amount = 0n;
          }
          nonce = claim.nonce ?? 0;
        } else if (isMinaClaim(claim)) {
          // Mina claims carry a commitment, not a plaintext amount.
          channelId = claim.zkAppAddress;
          tokenAddress = claim.tokenId ?? '';
          amount = 0n;
          nonce = claim.nonce ?? 0;
        }
        if (!tokenAddress || !channelId) continue;

        const key = `${row.blockchain}:${channelId}`;
        const existing = latestByChannel.get(key);
        if (!existing || nonce > existing.nonce) {
          latestByChannel.set(key, {
            blockchain: row.blockchain as BlockchainType,
            tokenAddress,
            amount,
            nonce,
            sentAt: row.sent_at,
          });
        }
      }

      for (const entry of latestByChannel.values()) {
        const assetKey = `${entry.blockchain}:${entry.tokenAddress}`;
        const bucket = out.get(assetKey);
        if (bucket) {
          bucket.total += entry.amount;
          if (entry.sentAt > bucket.lastAt) bucket.lastAt = entry.sentAt;
        } else {
          out.set(assetKey, {
            blockchain: entry.blockchain,
            tokenAddress: entry.tokenAddress,
            total: entry.amount,
            lastAt: entry.sentAt,
          });
        }
      }
    } catch (error) {
      this.logger.error({ error, peerId }, 'Failed to compute cumulative outbound claims');
    }

    return out;
  }

  /**
   * Return the most recent sent claims across all peers + channels, newest
   * first. Mirrors `ClaimReceiver.getRecentClaims()`. Used by
   * `/admin/earnings.json` (Story 37.7) to populate outbound rows in the
   * `recentClaims` ticker.
   *
   * @param limit - Maximum rows to return (default 50)
   */
  async getRecentSentClaims(limit: number = 50): Promise<
    Array<{
      messageId: string;
      peerId: string;
      blockchain: BlockchainType;
      channelId: string;
      claimData: BTPClaimMessage;
      sentAt: number;
    }>
  > {
    try {
      const stmt = this.db.prepare(`
        SELECT message_id, peer_id, blockchain, claim_data, sent_at
        FROM sent_claims
        ORDER BY sent_at DESC
        LIMIT ?
      `);
      const rows = stmt.all(limit) as Array<{
        message_id: string;
        peer_id: string;
        blockchain: string;
        claim_data: string;
        sent_at: number;
      }>;
      return rows.map((row) => {
        const claim = JSON.parse(row.claim_data) as BTPClaimMessage;
        let channelId = '';
        if (isEVMClaim(claim)) channelId = claim.channelId;
        else if (isSolanaClaim(claim)) channelId = claim.channelAccount;
        else if (isMinaClaim(claim)) channelId = claim.zkAppAddress;
        return {
          messageId: row.message_id,
          peerId: row.peer_id,
          blockchain: row.blockchain as BlockchainType,
          channelId,
          claimData: claim,
          sentAt: row.sent_at,
        };
      });
    } catch (error) {
      this.logger.error({ error }, 'Failed to query recent sent claims');
      return [];
    }
  }
}
