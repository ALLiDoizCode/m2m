//! The configured half of the role decision: which peer ids this
//! connector has, what each authenticates with, and which of them are
//! channel-bound.
//!
//! This is the *whole* of what [`crate::decide_role`] is allowed to
//! consult. Its narrowness is the point — a policy holds three facts per
//! peer and none of them is a port, an address, an endpoint or a carriage,
//! so the decision cannot weight one (§1.3). A peer's `endpoint` in
//! particular is deliberately absent: §1.3 names "a hostname or endpoint
//! appearing in `[[peers]]`" as something role must not be inferred from,
//! and the cheapest way to honour that is to leave it somewhere the
//! decision cannot reach.

use std::collections::BTreeMap;

use connector_config::PeerCredential;

/// One configured peering, as the role decision sees it.
#[derive(Debug, Clone)]
pub(crate) struct PeerAuthEntry {
    /// The configured id, kept alongside the map key so a
    /// [`crate::PeerAuthRefusal`] can carry a peer id that came from
    /// **config** rather than from the interaction. An operator event
    /// whose subject is an attacker-chosen string is a log-injection
    /// surface; one whose subject is a configured id is not.
    pub(crate) id: String,
    pub(crate) credential: PeerCredential,
    /// P2: whether at least one `[[peer_channels]]` row names this peer.
    ///
    /// A bool rather than the rows themselves, because P2 asks only
    /// whether the peering is bound at all. Which channel a claim is
    /// judged against is `ClaimBook`'s question, downstream of the role,
    /// and answering it here would put claim state in the decision path
    /// -- §1.5's "role is decided before it decodes a claim, before it
    /// consults a watermark", inverted.
    pub(crate) channel_bound: bool,
}

/// Every configured peering, keyed by peer id.
///
/// Built from `[[peers]]` and `[[peer_channels]]` — in a wired connector,
/// straight off the loaded config:
///
/// ```ignore
/// let policy = PeerAuthPolicy::new(
///     config.peers().iter().map(|peer| (peer.id(), peer.credential())),
///     config.peer_channels().iter().map(|channel| channel.peer_id()),
/// );
/// ```
///
/// A policy is a value, not a service: it is built once from configuration
/// and read concurrently by however many interactions are in flight. It
/// does no I/O, holds no clock and has no interior mutability, so a
/// carriage can put one behind an `Arc` and be done.
#[derive(Debug, Clone, Default)]
pub struct PeerAuthPolicy {
    entries: BTreeMap<String, PeerAuthEntry>,
}

impl PeerAuthPolicy {
    /// A policy over the configured peerings and the set of peer ids that
    /// have at least one `[[peer_channels]]` row.
    ///
    /// The two axes are separate arguments because they are separate
    /// config tables and because their *disagreement* is the interesting
    /// case: a peer with no binding is P2's failure branch, which
    /// `Config::load` refuses outright
    /// ([`connector_config::ConfigError::PeerChannelUnbound`]) but which
    /// this decision must still get right. Config's refusal is one lock;
    /// this is the second on the same door, and it is the one that still
    /// holds if a policy is ever built from something other than a loaded
    /// config.
    ///
    /// Channel bindings naming a peer id this policy has no entry for are
    /// ignored — an orphaned row binds nothing, and `Config::load` refuses
    /// it as [`connector_config::ConfigError::PeerChannelOrphaned`]
    /// anyway.
    #[must_use]
    pub fn new<'a, P, C>(peers: P, channel_bindings: C) -> Self
    where
        P: IntoIterator<Item = (&'a str, &'a PeerCredential)>,
        C: IntoIterator<Item = &'a str>,
    {
        let mut entries: BTreeMap<String, PeerAuthEntry> = peers
            .into_iter()
            .map(|(id, credential)| {
                (
                    id.to_string(),
                    PeerAuthEntry {
                        id: id.to_string(),
                        credential: credential.clone(),
                        channel_bound: false,
                    },
                )
            })
            .collect();

        for peer_id in channel_bindings {
            if let Some(entry) = entries.get_mut(peer_id) {
                entry.channel_bound = true;
            }
        }

        PeerAuthPolicy { entries }
    }

    /// The configured peering an asserted peer id names, if any.
    ///
    /// Exact bytes. A peer id is a configured identifier, not a hostname,
    /// so there is no case folding, no trimming and no normalization to
    /// disagree about — three things that are each a way for two spellings
    /// to authenticate as one peering.
    pub(crate) fn entry(&self, asserted_peer_id: &str) -> Option<&PeerAuthEntry> {
        self.entries.get(asserted_peer_id)
    }

    /// How many peerings are configured. For operator surfaces and tests;
    /// the decision never counts.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether no peering is configured at all — the ordinary shape of a
    /// connector that serves only clients, on which every interaction is a
    /// client and nothing can be otherwise.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_peer_with_a_binding_is_bound_and_one_without_is_not() {
        let bound = PeerCredential::new("s1");
        let unbound = PeerCredential::new("s2");

        let policy = PeerAuthPolicy::new(
            vec![("store-box", &bound), ("relay-box", &unbound)],
            vec!["store-box"],
        );

        assert!(policy.entry("store-box").expect("configured").channel_bound);
        assert!(!policy.entry("relay-box").expect("configured").channel_bound);
        assert_eq!(policy.len(), 2);
        assert!(!policy.is_empty());
    }

    #[test]
    fn a_binding_naming_no_configured_peer_binds_nothing() {
        let credential = PeerCredential::new("s1");

        let policy = PeerAuthPolicy::new(vec![("store-box", &credential)], vec!["ghost-box"]);

        assert!(!policy.entry("store-box").expect("configured").channel_bound);
        assert!(policy.entry("ghost-box").is_none());
    }

    #[test]
    fn peer_ids_match_on_exact_bytes() {
        let credential = PeerCredential::new("s1");

        let policy = PeerAuthPolicy::new(vec![("store-box", &credential)], vec!["store-box"]);

        assert!(policy.entry("store-box").is_some());
        assert!(policy.entry("Store-Box").is_none());
        assert!(policy.entry(" store-box").is_none());
        assert!(policy.entry("store-box ").is_none());
    }

    #[test]
    fn an_empty_policy_knows_no_peers() {
        let policy = PeerAuthPolicy::default();

        assert!(policy.is_empty());
        assert_eq!(policy.len(), 0);
        assert!(policy.entry("store-box").is_none());
    }

    /// A policy is read by every in-flight interaction at once; it must be
    /// a plain value with no interior mutability for that to be safe
    /// without a lock.
    #[test]
    fn a_policy_is_shareable_across_threads() {
        fn assert_send_sync<T: Send + Sync>() {}

        assert_send_sync::<PeerAuthPolicy>();
    }
}
