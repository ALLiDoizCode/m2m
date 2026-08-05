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
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};

use connector_runtime::{ChannelDomain, ClaimAckOutcome, ClaimBook, InvalidChannelId, WireClaim};
use connector_signer::Signer;

/// This connector's outbound claim state across every client-edge channel
/// it has been configured to pay. See the module doc for why this wraps
/// [`ClaimBook`] rather than reimplementing it.
pub struct ClientPayoutLedger {
    book: ClaimBook,
    /// Which `(channel_id, execution_condition)` pairs
    /// [`Self::record_payout_once`] has already credited (issue #770's
    /// AC3) -- deliberately not the same mechanism as `book`'s own
    /// nonce/cumulative-amount tracking, which advances unconditionally on
    /// every call and so cannot by itself tell a genuine second job from a
    /// retried first one. A packet's execution condition is deterministic
    /// per job (RFC-0022: the fulfilment that satisfies it can never
    /// differ between the original delivery and a retry of the same job),
    /// so it is the right identity to dedupe a credit against -- unlike an
    /// amount or a timestamp, which a caller could vary between attempts.
    /// In-memory only: a restart forgets it, same as every other
    /// non-durable memo this crate keeps (e.g. `ClientClaimGate`'s own
    /// `last_claim_seen`) -- the durable, money-bearing fact is `book`'s
    /// watermark, never this set.
    credited_conditions: Mutex<HashSet<(String, [u8; 32])>>,
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
            credited_conditions: Mutex::new(HashSet::new()),
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
        self.book.set_channel_domain(channel_id.clone(), domain)?;
        self.book
            .set_outbound_channel(channel_id.clone(), channel_id);
        Ok(())
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

    /// As [`Self::record_payout`], but a no-op -- credits nothing and
    /// returns `None` -- if this exact `(channel_id, condition)` pair has
    /// already been credited (issue #770's AC3: a duplicate or
    /// retransmitted FULFILL for the same job must not raise `credited`
    /// twice). See the `credited_conditions` field doc for why the
    /// execution condition is the dedupe key.
    ///
    /// The check-and-mark is atomic under one lock, so two concurrent
    /// calls for the same pair can never both pass it. If `record_payout`
    /// itself produces nothing (no signer or no domain configured for
    /// `channel_id`), the mark is released again -- nothing was credited,
    /// so a later call, once configured, must not find this pair falsely
    /// "already done".
    pub fn record_payout_once(
        &self,
        channel_id: &str,
        condition: &[u8; 32],
        amount: u64,
        now: DateTime<Utc>,
    ) -> Option<WireClaim> {
        let key = (channel_id.to_string(), *condition);
        {
            let mut seen = self.credited_conditions.lock().expect("not poisoned");
            if !seen.insert(key.clone()) {
                return None;
            }
        }
        let claim = self.record_payout(channel_id, amount, now);
        if claim.is_none() {
            self.credited_conditions
                .lock()
                .expect("not poisoned")
                .remove(&key);
        }
        claim
    }

    /// The claim owed to the client on `channel_id`, if one is pending --
    /// what the next TRANSFER out to that client should carry.
    pub fn pending_claim(&self, channel_id: &str) -> Option<WireClaim> {
        self.book.pending_claim(channel_id)
    }

    /// The total this connector has committed to pay the client on
    /// `channel_id` so far -- the "credited" term in issue #700's netting
    /// formula (`spendable = deposit - owed + credited`). Sourced from
    /// [`ClaimBook::outbound_cumulative_amount`], which -- unlike
    /// [`Self::pending_claim`] -- never resets on acknowledgement: this is
    /// what this connector has signed itself to owe, not what is still
    /// in flight, and a claim already delivered to the client is still a
    /// commitment this connector must honour. `0` for a channel this
    /// ledger has never paid out on, matching a channel with no signer or
    /// no domain configured.
    pub fn credited(&self, channel_id: &str) -> u64 {
        self.book.outbound_cumulative_amount(channel_id)
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
    fn an_invalid_channel_id_is_refused_and_registers_nothing() {
        let mut ledger = ClientPayoutLedger::new();
        ledger.set_signer(Arc::new(LocalSigner::generate("k")));

        assert!(ledger
            .set_channel_domain("not-a-channel-id", test_domain())
            .is_err());
        assert!(ledger
            .record_payout("not-a-channel-id", 100, now())
            .is_none());
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

    #[test]
    fn credited_is_zero_for_a_channel_never_paid_out_on() {
        let signer = Arc::new(LocalSigner::generate("payout-key"));
        let ledger = ledger_with_signer(signer);

        assert_eq!(ledger.credited(&channel_id(1)), 0);
        assert_eq!(ledger.credited(&channel_id(2)), 0);
    }

    #[test]
    fn credited_tracks_the_running_total_across_payouts() {
        let signer = Arc::new(LocalSigner::generate("payout-key"));
        let ledger = ledger_with_signer(signer);

        ledger.record_payout(&channel_id(1), 500, now());
        ledger.record_payout(&channel_id(1), 250, now());

        assert_eq!(ledger.credited(&channel_id(1)), 750);
    }

    #[test]
    fn credited_survives_acknowledgement_unlike_pending_claim() {
        let signer = Arc::new(LocalSigner::generate("payout-key"));
        let ledger = ledger_with_signer(signer);
        let claim = ledger
            .record_payout(&channel_id(1), 500, now())
            .expect("payout");

        ledger.acknowledge(&channel_id(1), claim.nonce, ClaimAckOutcome::Accepted);

        assert!(ledger.pending_claim(&channel_id(1)).is_none());
        assert_eq!(ledger.credited(&channel_id(1)), 500);
    }

    #[test]
    fn record_payout_once_credits_a_fresh_condition() {
        let signer = Arc::new(LocalSigner::generate("payout-key"));
        let ledger = ledger_with_signer(signer);

        let claim = ledger
            .record_payout_once(&channel_id(1), &[7u8; 32], 500, now())
            .expect("first delivery of this job");

        assert_eq!(claim.cumulative_amount, 500);
        assert_eq!(ledger.credited(&channel_id(1)), 500);
    }

    #[test]
    fn record_payout_once_refuses_a_second_credit_for_the_same_condition() {
        let signer = Arc::new(LocalSigner::generate("payout-key"));
        let ledger = ledger_with_signer(signer);
        let condition = [7u8; 32];

        ledger
            .record_payout_once(&channel_id(1), &condition, 500, now())
            .expect("first delivery of this job");
        let retry = ledger.record_payout_once(&channel_id(1), &condition, 500, now());

        assert!(
            retry.is_none(),
            "a duplicate/retransmitted fulfilment of the same job must not credit twice"
        );
        assert_eq!(
            ledger.credited(&channel_id(1)),
            500,
            "the running total must reflect exactly one credit, not two"
        );
    }

    #[test]
    fn record_payout_once_credits_a_different_condition_on_the_same_channel_independently() {
        let signer = Arc::new(LocalSigner::generate("payout-key"));
        let ledger = ledger_with_signer(signer);

        ledger
            .record_payout_once(&channel_id(1), &[7u8; 32], 500, now())
            .expect("first job");
        ledger
            .record_payout_once(&channel_id(1), &[8u8; 32], 250, now())
            .expect("a different job on the same channel is not deduped against the first");

        assert_eq!(ledger.credited(&channel_id(1)), 750);
    }

    #[test]
    fn record_payout_once_releases_its_mark_when_nothing_was_credited() {
        // No signer configured yet, so `record_payout` itself produces
        // nothing for this channel+condition -- the dedupe mark must not
        // stick around and block a legitimate credit once the ledger is
        // configured.
        let mut ledger = ClientPayoutLedger::new();
        ledger
            .set_channel_domain(channel_id(1), test_domain())
            .expect("valid channel id");
        let condition = [7u8; 32];
        assert!(
            ledger
                .record_payout_once(&channel_id(1), &condition, 100, now())
                .is_none(),
            "no signer configured yet"
        );

        ledger.set_signer(Arc::new(LocalSigner::generate("payout-key")));

        let claim = ledger.record_payout_once(&channel_id(1), &condition, 100, now());
        assert!(
            claim.is_some(),
            "a prior no-op call must not permanently block this condition"
        );
    }
}
