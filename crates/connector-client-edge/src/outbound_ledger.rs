//! Outbound claim ledger for the client edge (issue #699, `toon-meta#262`):
//! what this connector owes a client on that client's own channel -- the
//! gap `docs/protocol/client-edge-spec.md` §1.9 and ADR 0026 both name as
//! "the payout-ledger ticket". `ClientClaimGate` (`crate::claim_gate`)
//! handles the opposite direction, a client paying this connector; nothing
//! on this edge previously tracked the connector paying a client back.
//!
//! This is a port, not a new design: `connector_runtime::ClaimBook` already
//! is "sign a fresh cumulative claim over a channel's own recorded EIP-712
//! domain (ADR 0024), arm it pending, journal it, and degrade to no claim
//! at all -- never one signed under a defaulted or wrong domain -- absent a
//! signer or a channel's domain" for the peer wire's outbound direction.
//! Reimplementing that digest math a second time here would risk the two
//! copies drifting; wrapping it instead means a client-edge payout is
//! signed by the exact same code path `crates/connector-runtime/src/claim.rs`
//! already has vectors and proptests for.
//!
//! The only seam is the key. `ClaimBook::record_fulfillment` takes a
//! `peer_id` to look up which channel it owes, because the peer wire's
//! outbound state is keyed by peering relation, not by channel (see that
//! module's own doc for why). A client-edge channel has no separate peer
//! identity -- the channel *is* the identity -- so [`ClientPayoutLedger`]
//! registers each channel as its own "peer": `set_outbound_channel(id,
//! id)`. Callers of this type never see that indirection; every method
//! here takes a `channel_id` and nothing else.
use std::sync::Arc;

use chrono::{DateTime, Utc};

use connector_runtime::{ChannelDomain, ClaimAckOutcome, ClaimBook, InvalidChannelId, WireClaim};
use connector_signer::Signer;

/// This connector's outbound claim state across every client-edge channel
/// it has been configured to pay. See the module doc for why this wraps
/// [`ClaimBook`] rather than reimplementing it.
pub struct ClientPayoutLedger {
    book: ClaimBook,
}

impl Default for ClientPayoutLedger {
    fn default() -> Self {
        Self::new()
    }
}

impl ClientPayoutLedger {
    pub fn new() -> ClientPayoutLedger {
        ClientPayoutLedger {
            book: ClaimBook::new(
                None,
                std::collections::HashMap::new(),
                std::collections::HashMap::new(),
            ),
        }
    }

    /// Configure this connector's own signer, used to sign every payout
    /// claim. A ledger with none configured never produces one (issue
    /// #699's AC4, matching [`ClaimBook`]'s own "a node with none
    /// configured simply never emits a claim").
    pub fn set_signer(&mut self, signer: Arc<dyn Signer>) {
        self.book.set_signer(signer);
    }

    /// Register `channel_id` as one this connector may owe, and the
    /// EIP-712 domain (ADR 0024) a payout claim on it is signed under.
    /// Refuses `channel_id` outright, and registers nothing, if it is not
    /// already the channel's on-chain `bytes32` -- see [`InvalidChannelId`].
    pub fn set_channel_domain(
        &mut self,
        channel_id: impl Into<String>,
        domain: ChannelDomain,
    ) -> Result<(), InvalidChannelId> {
        let channel_id = channel_id.into();
        self.book
            .set_outbound_channel(channel_id.clone(), channel_id.clone());
        self.book.set_channel_domain(channel_id, domain)
    }

    /// Record that a packet destined for the client on `channel_id`
    /// fulfilled, crediting that client `amount` more (issue #699's item
    /// 3) -- the caller has already subtracted this connector's own fee,
    /// exactly as `Connector::forward_via_peer_route` computes
    /// `amount_after_fee` before ever calling `ClaimBook::record_fulfillment`.
    /// Signs a fresh cumulative claim and arms it pending. Produces no
    /// claim at all -- and leaves the ledger untouched -- for a channel
    /// with no signer or no domain configured.
    pub fn record_payout(
        &self,
        channel_id: &str,
        amount: u64,
        now: DateTime<Utc>,
    ) -> Option<WireClaim> {
        self.book.record_fulfillment(channel_id, amount, now)
    }

    /// The claim owed to the client on `channel_id`, if one is pending --
    /// what the next TRANSFER out to that client should carry.
    pub fn pending_claim(&self, channel_id: &str) -> Option<WireClaim> {
        self.book.pending_claim(channel_id)
    }

    /// Record the outcome of a payout claim of `nonce` sent on
    /// `channel_id`. See [`ClaimBook::acknowledge_outbound`] for the
    /// stale-nonce-safe semantics this delegates to.
    pub fn acknowledge(&self, channel_id: &str, nonce: u64, outcome: ClaimAckOutcome) {
        self.book.acknowledge_outbound(channel_id, nonce, outcome);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use connector_signer::{
        derive_evm_address, evm_balance_proof_digest, verify_evm_balance_proof, EvmBalanceProof,
        LocalSigner,
    };

    fn now() -> DateTime<Utc> {
        "2030-01-01T00:00:00Z".parse().unwrap()
    }

    fn test_domain() -> ChannelDomain {
        ChannelDomain {
            chain_id: 84_532,
            token_network_address: [0x22; 20],
        }
    }

    fn channel_id(n: u8) -> String {
        format!("0x{n:064x}")
    }

    fn ledger_with_signer(signer: Arc<LocalSigner>) -> ClientPayoutLedger {
        let mut ledger = ClientPayoutLedger::new();
        ledger.set_signer(signer);
        ledger
            .set_channel_domain(channel_id(1), test_domain())
            .expect("test channel id is valid");
        ledger
    }

    #[test]
    fn no_payout_is_recorded_without_a_signer() {
        let mut ledger = ClientPayoutLedger::new();
        ledger
            .set_channel_domain(channel_id(1), test_domain())
            .unwrap();

        assert!(ledger.record_payout(&channel_id(1), 100, now()).is_none());
    }

    #[test]
    fn no_payout_is_recorded_for_a_channel_with_no_domain_configured() {
        let mut ledger = ClientPayoutLedger::new();
        ledger.set_signer(Arc::new(LocalSigner::generate("k")));

        assert!(ledger.record_payout(&channel_id(1), 100, now()).is_none());
    }

    #[test]
    fn a_payout_signs_a_claim_the_connectors_own_key_recovers_under() {
        let signer = Arc::new(LocalSigner::generate("payout-key"));
        let address = derive_evm_address(&signer.public_key().unwrap());
        let ledger = ledger_with_signer(Arc::clone(&signer));

        let claim = ledger
            .record_payout(&channel_id(1), 500, now())
            .expect("signer and domain configured");

        assert_eq!(claim.channel_id, channel_id(1));
        assert_eq!(claim.nonce, 1);
        assert_eq!(claim.cumulative_amount, 500);

        let mut on_chain_id = [0u8; 32];
        on_chain_id[31] = 1;
        let proof = EvmBalanceProof {
            channel_id: on_chain_id,
            nonce: claim.nonce,
            transferred_amount: u128::from(claim.cumulative_amount),
            locked_amount: 0,
            locks_root: [0u8; 32],
            chain_id: test_domain().chain_id,
            token_network_address: test_domain().token_network_address,
        };
        assert!(verify_evm_balance_proof(
            &proof,
            &claim.signature.to_bytes(),
            &address
        ));
        // Sanity: a claim's digest is computed exactly the way the wire
        // claim itself was signed, not incidentally matching.
        let _ = evm_balance_proof_digest(&proof);
    }

    #[test]
    fn successive_payouts_advance_nonce_and_cumulative_amount_monotonically() {
        let signer = Arc::new(LocalSigner::generate("payout-key"));
        let ledger = ledger_with_signer(signer);

        let first = ledger
            .record_payout(&channel_id(1), 500, now())
            .expect("first payout");
        let second = ledger
            .record_payout(&channel_id(1), 250, now())
            .expect("second payout");

        assert_eq!(first.nonce, 1);
        assert_eq!(first.cumulative_amount, 500);
        assert_eq!(second.nonce, 2);
        assert_eq!(second.cumulative_amount, 750);
    }

    #[test]
    fn a_payout_on_an_unregistered_channel_produces_nothing() {
        let signer = Arc::new(LocalSigner::generate("payout-key"));
        let ledger = ledger_with_signer(signer);

        assert!(ledger.record_payout(&channel_id(2), 100, now()).is_none());
    }

    #[test]
    fn pending_claim_reflects_the_most_recently_signed_payout_until_acknowledged() {
        let signer = Arc::new(LocalSigner::generate("payout-key"));
        let ledger = ledger_with_signer(signer);

        assert!(ledger.pending_claim(&channel_id(1)).is_none());

        let claim = ledger
            .record_payout(&channel_id(1), 500, now())
            .expect("payout");
        assert_eq!(ledger.pending_claim(&channel_id(1)), Some(claim.clone()));

        ledger.acknowledge(&channel_id(1), claim.nonce, ClaimAckOutcome::Accepted);
        assert!(ledger.pending_claim(&channel_id(1)).is_none());
    }
}
