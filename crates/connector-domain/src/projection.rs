//! Balances and exposure as a projection over a durable journal (ADR 0005,
//! `docs/protocol/peer-wire-spec.md` §5.3, issue #424). Pure, no I/O -- the
//! journal itself (a file, in `connector-runtime`) is an infrastructure
//! concern; folding its entries into a balance/exposure figure is not, so it
//! lives here where it can be property-tested without a filesystem.
//!
//! [`JournalEntry`] is deliberately the exact alphabet named in the issue's
//! own acceptance criteria -- "claims sent, claims received with their
//! watermarks, and fulfilments not yet covered by a claim" -- and nothing
//! more. Balances are never themselves an entry: per ADR 0005 they are
//! arithmetic on the entries above, recomputed by [`Projection::apply`]
//! rather than stored.

use std::collections::BTreeMap;

use thiserror::Error;

/// One durably-recorded fact about money state (ADR 0005). Everything else
/// -- a peer's owed balance, a channel's exposure -- is re-derived by
/// folding a sequence of these with [`Projection::apply`], never stored
/// directly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JournalEntry {
    /// This connector signed an outbound claim owed to `peer_id` on
    /// `channel_id`, whose cumulative amount now stands at
    /// `cumulative_amount` (`ClaimBook::record_fulfillment`, ADR 0004's
    /// "sending connector pays the next hop"). Superseding rather than
    /// additive: the latest entry for a `peer_id` is the whole of what is
    /// owed, exactly like the claim it was signed from.
    OutboundClaimSigned {
        peer_id: String,
        channel_id: String,
        nonce: u64,
        cumulative_amount: u64,
    },
    /// A signed claim on `channel_id` was verified and accepted, advancing
    /// that channel's watermark to `nonce`/`cumulative_amount`
    /// (`ClaimBook::accept_inbound`, peer-wire-spec.md §3.4). `signature` is
    /// carried through opaque (chain- and scheme-specific verification
    /// already happened before this entry is ever appended) and durably
    /// retained rather than discarded once accepted: on-chain redemption
    /// (issue #425) needs the actual claim, not just its watermark, and per
    /// ADR 0005 what is signed is exactly what this journal exists to keep.
    InboundClaimAccepted {
        channel_id: String,
        nonce: u64,
        cumulative_amount: u64,
        signature: Vec<u8>,
    },
    /// A packet arriving on `channel_id` fulfilled for `amount`, extending
    /// this connector's exposure to that channel's counterparty until a
    /// covering claim is accepted (`CONTEXT.md` "Exposure",
    /// peer-wire-spec.md §5.3). Additive: exposure accumulates across every
    /// such entry since the last accepted claim.
    InboundFulfillmentRecorded { channel_id: String, amount: u64 },
}

/// A rebuild found the projection disagreeing with the claims it derives
/// from (issue #424's acceptance criteria: "reports divergence rather than
/// absorbing it"). The one invariant checkable from this journal alone: a
/// channel's accepted claim can never assert more was delivered than this
/// connector's own journal ever recorded fulfilling on that channel -- if it
/// does, either a fulfilment failed to journal before its claim did, or a
/// counterparty's claim was accepted beyond what was actually owed.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProjectionDivergence {
    #[error(
        "channel {channel_id}: accepted claim cumulative {claimed} exceeds this connector's own recorded fulfilled total {fulfilled}"
    )]
    ClaimedExceedsFulfilled {
        channel_id: String,
        claimed: u64,
        fulfilled: u64,
    },
}

/// Balances and exposure, derived in memory by folding a journal (ADR
/// 0005). Never a source of truth, always rebuildable from
/// [`Projection::from_entries`] -- the same result whether folded
/// incrementally as entries occur or all at once after a restart.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Projection {
    /// `peer_id` -> the cumulative amount this connector's latest signed
    /// claim owes that peer.
    outbound_owed: BTreeMap<String, u64>,
    /// `channel_id` -> the cumulative amount of the highest accepted claim
    /// on that channel.
    inbound_claimed: BTreeMap<String, u64>,
    /// `channel_id` -> the signature of that same highest accepted claim,
    /// kept alongside `inbound_claimed` rather than as a separate source of
    /// truth -- both fields are written from, and only from, the same
    /// `InboundClaimAccepted` entry (issue #425: what a redemption submits).
    inbound_claim_signature: BTreeMap<String, Vec<u8>>,
    /// `channel_id` -> the running total this connector has itself recorded
    /// fulfilling on that channel.
    inbound_fulfilled: BTreeMap<String, u64>,
}

impl Projection {
    /// Fold one more entry into this projection.
    pub fn apply(&mut self, entry: &JournalEntry) {
        match entry {
            JournalEntry::OutboundClaimSigned {
                peer_id,
                cumulative_amount,
                ..
            } => {
                self.outbound_owed
                    .insert(peer_id.clone(), *cumulative_amount);
            }
            JournalEntry::InboundClaimAccepted {
                channel_id,
                cumulative_amount,
                signature,
                ..
            } => {
                self.inbound_claimed
                    .insert(channel_id.clone(), *cumulative_amount);
                self.inbound_claim_signature
                    .insert(channel_id.clone(), signature.clone());
            }
            JournalEntry::InboundFulfillmentRecorded { channel_id, amount } => {
                let total = self
                    .inbound_fulfilled
                    .entry(channel_id.clone())
                    .or_insert(0);
                *total = total.saturating_add(*amount);
            }
        }
    }

    /// Rebuild a projection from scratch by folding `entries` in order --
    /// what a node does with its journal on start (issue #424's "rebuilt
    /// from the journal on start").
    pub fn from_entries<'a>(entries: impl IntoIterator<Item = &'a JournalEntry>) -> Projection {
        let mut projection = Projection::default();
        for entry in entries {
            projection.apply(entry);
        }
        projection
    }

    /// The cumulative amount this connector's latest signed claim owes
    /// `peer_id`, or 0 if none has ever been signed.
    pub fn outbound_owed(&self, peer_id: &str) -> u64 {
        self.outbound_owed.get(peer_id).copied().unwrap_or(0)
    }

    /// `channel_id`'s exposure: value this connector has delivered on that
    /// channel's counterparty's behalf but does not yet hold a covering
    /// claim for (`CONTEXT.md` "Exposure"). Never negative -- an accepted
    /// claim can only ever cover what was actually recorded fulfilled;
    /// [`Projection::divergences`] is where an accepted claim exceeding
    /// that is reported, not here.
    pub fn exposure(&self, channel_id: &str) -> u64 {
        let fulfilled = self.inbound_fulfilled.get(channel_id).copied().unwrap_or(0);
        let claimed = self.inbound_claimed.get(channel_id).copied().unwrap_or(0);
        fulfilled.saturating_sub(claimed)
    }

    /// Whether `channel_id`'s current exposure exceeds `ceiling`
    /// (peer-wire-spec.md §5.3) -- the pure predicate a connector checks
    /// before continuing to forward for that channel's counterparty.
    pub fn is_over_ceiling(&self, channel_id: &str, ceiling: u64) -> bool {
        self.exposure(channel_id) > ceiling
    }

    /// Every channel this projection has ever recorded a fulfilment or an
    /// accepted claim for, in a stable order -- what a caller enumerates to
    /// report exposure per channel (the operator surface's read model)
    /// without needing to already know every channel id in advance.
    pub fn known_channels(&self) -> Vec<String> {
        self.inbound_fulfilled
            .keys()
            .chain(self.inbound_claimed.keys())
            .cloned()
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    /// The highest-nonce claim ever accepted on `channel_id`, as
    /// `(cumulative_amount, signature)` -- exactly what an on-chain
    /// redemption submits (issue #425), and never a superseded one: this
    /// projection only ever retains the latest, so there is nothing else it
    /// could return. `None` before any claim has been accepted on this
    /// channel.
    pub fn latest_inbound_claim(&self, channel_id: &str) -> Option<(u64, Vec<u8>)> {
        let cumulative_amount = *self.inbound_claimed.get(channel_id)?;
        let signature = self.inbound_claim_signature.get(channel_id)?.clone();
        Some((cumulative_amount, signature))
    }

    /// Check this projection against the claims it derives from (issue
    /// #424's acceptance criteria), reporting every channel where an
    /// accepted claim asserts more than this connector ever recorded
    /// fulfilling on it -- a divergence between the journal and the claims
    /// replayed from it, rather than something a rebuild should silently
    /// absorb.
    pub fn divergences(&self) -> Vec<ProjectionDivergence> {
        self.inbound_claimed
            .iter()
            .filter_map(|(channel_id, &claimed)| {
                let fulfilled = self.inbound_fulfilled.get(channel_id).copied().unwrap_or(0);
                (claimed > fulfilled).then(|| ProjectionDivergence::ClaimedExceedsFulfilled {
                    channel_id: channel_id.clone(),
                    claimed,
                    fulfilled,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn signed(peer_id: &str, channel_id: &str, nonce: u64, cumulative_amount: u64) -> JournalEntry {
        JournalEntry::OutboundClaimSigned {
            peer_id: peer_id.to_string(),
            channel_id: channel_id.to_string(),
            nonce,
            cumulative_amount,
        }
    }

    fn accepted(channel_id: &str, nonce: u64, cumulative_amount: u64) -> JournalEntry {
        accepted_with_signature(channel_id, nonce, cumulative_amount, &[])
    }

    fn accepted_with_signature(
        channel_id: &str,
        nonce: u64,
        cumulative_amount: u64,
        signature: &[u8],
    ) -> JournalEntry {
        JournalEntry::InboundClaimAccepted {
            channel_id: channel_id.to_string(),
            nonce,
            cumulative_amount,
            signature: signature.to_vec(),
        }
    }

    fn fulfilled(channel_id: &str, amount: u64) -> JournalEntry {
        JournalEntry::InboundFulfillmentRecorded {
            channel_id: channel_id.to_string(),
            amount,
        }
    }

    #[test]
    fn an_empty_projection_owes_and_exposes_nothing() {
        let projection = Projection::default();
        assert_eq!(projection.outbound_owed("peer-b"), 0);
        assert_eq!(projection.exposure("channel-a"), 0);
        assert!(!projection.is_over_ceiling("channel-a", 0));
    }

    #[test]
    fn an_outbound_claim_signed_is_owed_its_cumulative_amount() {
        let projection = Projection::from_entries(&[signed("peer-b", "channel-a", 1, 100)]);
        assert_eq!(projection.outbound_owed("peer-b"), 100);
    }

    #[test]
    fn a_later_outbound_claim_supersedes_rather_than_adds() {
        let projection = Projection::from_entries(&[
            signed("peer-b", "channel-a", 1, 100),
            signed("peer-b", "channel-a", 2, 150),
        ]);
        assert_eq!(projection.outbound_owed("peer-b"), 150);
    }

    #[test]
    fn a_fulfilment_with_no_claim_yet_is_full_exposure() {
        let projection = Projection::from_entries(&[fulfilled("channel-a", 60)]);
        assert_eq!(projection.exposure("channel-a"), 60);
    }

    #[test]
    fn fulfilments_accumulate_across_entries() {
        let projection =
            Projection::from_entries(&[fulfilled("channel-a", 60), fulfilled("channel-a", 40)]);
        assert_eq!(projection.exposure("channel-a"), 100);
    }

    #[test]
    fn an_accepted_claim_covers_exposure_up_to_its_cumulative_amount() {
        let projection = Projection::from_entries(&[
            fulfilled("channel-a", 60),
            fulfilled("channel-a", 40),
            accepted("channel-a", 1, 100),
        ]);
        assert_eq!(projection.exposure("channel-a"), 0);
    }

    #[test]
    fn a_partial_claim_leaves_the_remainder_exposed() {
        let projection = Projection::from_entries(&[
            fulfilled("channel-a", 60),
            fulfilled("channel-a", 40),
            accepted("channel-a", 1, 70),
        ]);
        assert_eq!(projection.exposure("channel-a"), 30);
    }

    #[test]
    fn exposure_resumes_accumulating_after_a_claim_covers_it() {
        let projection = Projection::from_entries(&[
            fulfilled("channel-a", 60),
            accepted("channel-a", 1, 60),
            fulfilled("channel-a", 25),
        ]);
        assert_eq!(projection.exposure("channel-a"), 25);
    }

    #[test]
    fn exposure_over_the_ceiling_is_reported_as_such() {
        let projection = Projection::from_entries(&[fulfilled("channel-a", 101)]);
        assert!(projection.is_over_ceiling("channel-a", 100));
        assert!(!projection.is_over_ceiling("channel-a", 101));
        assert!(!projection.is_over_ceiling("channel-a", 200));
    }

    #[test]
    fn known_channels_lists_every_channel_seen_by_a_fulfilment_or_a_claim() {
        let projection = Projection::from_entries(&[
            fulfilled("channel-a", 10),
            accepted("channel-b", 1, 5),
            signed("peer-x", "channel-c", 1, 5),
        ]);
        assert_eq!(
            projection.known_channels(),
            vec!["channel-a".to_string(), "channel-b".to_string()]
        );
    }

    #[test]
    fn different_channels_and_peers_are_tracked_independently() {
        let projection = Projection::from_entries(&[
            signed("peer-b", "channel-a", 1, 100),
            fulfilled("channel-c", 30),
        ]);
        assert_eq!(projection.outbound_owed("peer-b"), 100);
        assert_eq!(projection.outbound_owed("peer-d"), 0);
        assert_eq!(projection.exposure("channel-c"), 30);
        assert_eq!(projection.exposure("channel-a"), 0);
    }

    #[test]
    fn a_claim_exceeding_recorded_fulfilments_is_a_divergence() {
        let projection =
            Projection::from_entries(&[fulfilled("channel-a", 40), accepted("channel-a", 1, 100)]);
        assert_eq!(
            projection.divergences(),
            vec![ProjectionDivergence::ClaimedExceedsFulfilled {
                channel_id: "channel-a".to_string(),
                claimed: 100,
                fulfilled: 40,
            }]
        );
    }

    #[test]
    fn a_claim_covered_by_recorded_fulfilments_has_no_divergence() {
        let projection =
            Projection::from_entries(&[fulfilled("channel-a", 100), accepted("channel-a", 1, 100)]);
        assert!(projection.divergences().is_empty());
    }

    #[test]
    fn no_claims_accepted_means_no_divergence_possible() {
        let projection = Projection::from_entries(&[fulfilled("channel-a", 100)]);
        assert!(projection.divergences().is_empty());
    }

    #[test]
    fn latest_inbound_claim_is_none_before_any_claim_is_accepted() {
        let projection = Projection::from_entries(&[fulfilled("channel-a", 100)]);
        assert_eq!(projection.latest_inbound_claim("channel-a"), None);
    }

    #[test]
    fn latest_inbound_claim_reports_the_highest_nonce_claims_amount_and_signature() {
        let projection = Projection::from_entries(&[
            accepted_with_signature("channel-a", 1, 100, &[1, 2, 3]),
            accepted_with_signature("channel-a", 2, 150, &[4, 5, 6]),
        ]);
        assert_eq!(
            projection.latest_inbound_claim("channel-a"),
            Some((150, vec![4, 5, 6]))
        );
    }

    fn arbitrary_entry() -> impl Strategy<Value = JournalEntry> {
        prop_oneof![
            (any::<u64>(), any::<u64>()).prop_map(|(nonce, amount)| signed(
                "peer-b",
                "channel-a",
                nonce,
                amount
            )),
            (
                any::<u64>(),
                any::<u64>(),
                proptest::collection::vec(any::<u8>(), 0..4)
            )
                .prop_map(|(nonce, amount, signature)| accepted_with_signature(
                    "channel-a",
                    nonce,
                    amount,
                    &signature
                )),
            any::<u64>().prop_map(|amount| fulfilled("channel-a", amount)),
        ]
    }

    proptest! {
        /// Issue #424's own acceptance criterion: a projection rebuilt from
        /// a journal equals the projection that produced it -- folding an
        /// arbitrary sequence of entries incrementally, one at a time as
        /// they would occur live, yields exactly the same projection as
        /// folding the same sequence all at once from scratch, the way a
        /// restart replays a journal.
        #[test]
        fn a_projection_rebuilt_from_a_journal_equals_the_projection_that_produced_it(
            entries in proptest::collection::vec(arbitrary_entry(), 0..64)
        ) {
            let mut incremental = Projection::default();
            for entry in &entries {
                incremental.apply(entry);
            }

            let rebuilt = Projection::from_entries(&entries);

            prop_assert_eq!(incremental, rebuilt);
        }

        /// Folding the same journal twice (e.g. a restart that replays an
        /// already-fully-applied journal once more) is idempotent: the
        /// exposure and owed figures it reports depend only on the journal
        /// content, not on how many times it has been rebuilt from.
        #[test]
        fn rebuilding_the_same_journal_twice_yields_the_same_projection(
            entries in proptest::collection::vec(arbitrary_entry(), 0..64)
        ) {
            let first = Projection::from_entries(&entries);
            let second = Projection::from_entries(&entries);
            prop_assert_eq!(first, second);
        }
    }
}
