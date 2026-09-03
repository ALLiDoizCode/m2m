//! The configured half of the role decision: which channels this connector
//! has bound to which peering relation.
//!
//! This is the *whole* of what [`crate::decide_role`] is allowed to
//! consult. Its narrowness is the point — a policy holds one fact per
//! configured peer channel, and none of them is a port, an address, an
//! endpoint or a carriage, so the decision cannot weight one (§1.3). A
//! peer's `endpoint` in particular is deliberately absent: §1.3 names "a
//! hostname or endpoint appearing in `[[peers]]`" as something role must
//! not be inferred from, and the cheapest way to honour that is to leave it
//! somewhere the decision cannot reach.

use std::collections::{BTreeMap, BTreeSet};

/// One configured `[[peer_channels]]` binding, as the role decision sees
/// it: the channel a claim may name, and the peering relation it belongs
/// to.
///
/// P3 "resolves to exactly one relation" because config makes it so
/// (§1.2): a `channel_id` may appear in at most one `[[peer_channels]]`
/// row (`connector_config::ConfigError::PeerChannelDuplicate`) and never
/// also in `[[client_channels]]`
/// (`connector_config::ConfigError::ChannelInBothNamespaces`, §1.8). A
/// verified claim therefore names one channel, one row and one peer id,
/// with no ambiguity for a caller to resolve and none for an attacker to
/// manufacture.
#[derive(Debug, Clone)]
pub(crate) struct PeerChannelBinding {
    /// The configured peer id this channel belongs to, kept so a
    /// [`crate::PeerAuthRefusal`] can carry a peer id that came from
    /// **config** rather than from the interaction. An operator event
    /// whose subject is an attacker-chosen string is a log-injection
    /// surface; one whose subject is a configured id is not.
    pub(crate) peer_id: String,
}

/// Every configured peer channel, keyed by the channel identifier a claim
/// names it by.
///
/// Built from `[[peers]]` and `[[peer_channels]]` — in a wired connector,
/// straight off the loaded config:
///
/// ```ignore
/// let policy = PeerAuthPolicy::new(
///     config.peers().iter().map(PeerConfig::id),
///     config
///         .peer_channels()
///         .iter()
///         .map(|channel| (channel.channel_identifier(), channel.peer_id())),
/// );
/// ```
///
/// A policy is a value, not a service: it is built once from configuration
/// and read concurrently by however many interactions are in flight. It
/// does no I/O, holds no clock and has no interior mutability, so a
/// carriage can put one behind an `Arc` and be done.
#[derive(Debug, Clone, Default)]
pub struct PeerAuthPolicy {
    channels: BTreeMap<String, PeerChannelBinding>,
}

impl PeerAuthPolicy {
    /// A policy over the configured peer ids and the `[[peer_channels]]`
    /// rows that bind channels to them.
    ///
    /// The two axes are separate arguments because they are separate config
    /// tables and because their *disagreement* is the interesting case: a
    /// channel row naming a peer no `[[peers]]` entry configures binds
    /// nothing, and is dropped here. `Config::load` refuses that shape
    /// outright (`connector_config::ConfigError::PeerChannelOrphaned`);
    /// this is the second lock on the same door, the one that still holds
    /// if a policy is ever built from something other than a loaded config.
    #[must_use]
    pub fn new<'a, P, C>(peers: P, channel_bindings: C) -> Self
    where
        P: IntoIterator<Item = &'a str>,
        C: IntoIterator<Item = (&'a str, &'a str)>,
    {
        let configured: BTreeSet<&str> = peers.into_iter().collect();
        let channels = channel_bindings
            .into_iter()
            .filter(|(_, peer_id)| configured.contains(peer_id))
            .map(|(channel_id, peer_id)| {
                (
                    channel_id.to_string(),
                    PeerChannelBinding {
                        peer_id: peer_id.to_string(),
                    },
                )
            })
            .collect();

        PeerAuthPolicy { channels }
    }

    /// A policy straight off a loaded [`connector_config::Config`] — the
    /// one every wired node builds, so the mapping from config tables to
    /// this policy is written once rather than at each carriage.
    #[must_use]
    pub fn from_config(
        peers: &[connector_config::PeerConfig],
        peer_channels: &[connector_config::PeerChannelConfig],
    ) -> Self {
        PeerAuthPolicy::new(
            peers.iter().map(connector_config::PeerConfig::id),
            peer_channels
                .iter()
                .map(|channel| (channel.channel_identifier(), channel.peer_id())),
        )
    }

    /// The peering relation a claim's `channel_id` names, if this
    /// connector has one bound.
    ///
    /// Exact bytes. A channel identifier is canonicalized once, at config
    /// load (lowercase `0x` hex for EVM, base58 for Solana), and a claim is
    /// canonicalized to that same spelling before it reaches here — so
    /// there is no case folding, no trimming and no normalization to
    /// disagree about at this point, three things that are each a way for
    /// two spellings to resolve to one peering.
    pub(crate) fn binding(&self, channel_id: &str) -> Option<&PeerChannelBinding> {
        self.channels.get(channel_id)
    }

    /// How many peer channels are bound. For operator surfaces and tests;
    /// the decision never counts.
    #[must_use]
    pub fn len(&self) -> usize {
        self.channels.len()
    }

    /// Whether no peer channel is bound at all — the ordinary shape of a
    /// connector that serves only clients, on which every interaction is a
    /// client and nothing can be otherwise.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.channels.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHANNEL: &str = "0xaa";
    const OTHER: &str = "0xbb";

    #[test]
    fn a_channel_resolves_to_the_peering_its_row_names() {
        let policy = PeerAuthPolicy::new(
            vec!["store-box", "relay-box"],
            vec![(CHANNEL, "store-box"), (OTHER, "relay-box")],
        );

        assert_eq!(policy.binding(CHANNEL).expect("bound").peer_id, "store-box");
        assert_eq!(policy.binding(OTHER).expect("bound").peer_id, "relay-box");
        assert_eq!(policy.len(), 2);
        assert!(!policy.is_empty());
    }

    #[test]
    fn a_row_naming_no_configured_peer_binds_nothing() {
        let policy = PeerAuthPolicy::new(vec!["store-box"], vec![(CHANNEL, "ghost-box")]);

        assert!(policy.binding(CHANNEL).is_none());
        assert!(policy.is_empty());
    }

    #[test]
    fn channel_ids_match_on_exact_bytes() {
        let policy = PeerAuthPolicy::new(vec!["store-box"], vec![(CHANNEL, "store-box")]);

        assert!(policy.binding(CHANNEL).is_some());
        assert!(policy.binding("0xAA").is_none());
        assert!(policy.binding(" 0xaa").is_none());
        assert!(policy.binding("0xaa ").is_none());
    }

    #[test]
    fn an_empty_policy_knows_no_channels() {
        let policy = PeerAuthPolicy::default();

        assert!(policy.is_empty());
        assert_eq!(policy.len(), 0);
        assert!(policy.binding(CHANNEL).is_none());
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
