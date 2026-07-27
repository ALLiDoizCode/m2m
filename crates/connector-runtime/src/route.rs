//! A routing-table entry whose next hop is another connector rather than
//! this one's own app. Paired with `connector_config::StaticRoute` at the
//! [`crate::Connector`] level -- `connector_domain::select_route` picks the
//! most specific prefix across both kinds without caring which one it is.

use chrono::{DateTime, Utc};

/// A route whose traffic this connector forwards to a peer's connector for
/// the next hop, rather than terminating it at an app of its own. `fee` is
/// this peering relation's flat per-packet fee (ADR 0010) -- charged once
/// per forwarded packet, agreed bilaterally, and never a share of the
/// amount being carried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerRoute {
    prefix: String,
    peer_id: String,
    fee: u64,
}

impl PeerRoute {
    pub fn new(prefix: impl Into<String>, peer_id: impl Into<String>, fee: u64) -> PeerRoute {
        PeerRoute {
            prefix: prefix.into(),
            peer_id: peer_id.into(),
            fee,
        }
    }

    /// The destination prefix this route forwards.
    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    /// The peer this route's traffic is forwarded to, by id -- resolved to
    /// an actual peer connection through the [`crate::PeerTransport`] port.
    pub fn peer_id(&self) -> &str {
        &self.peer_id
    }

    /// This peering relation's flat per-packet fee (ADR 0010).
    pub fn fee(&self) -> u64 {
        self.fee
    }
}

/// A [`PeerRoute`] pushed onto this connector's routing table by a
/// controller outside it, with a time limit (ADR 0006, issue #427): it
/// lapses unless renewed before `expires_at`, preserving the
/// withdrawal-safety property route learning used to provide -- a route to
/// a peer that can no longer deliver stops being used on its own, rather
/// than rotting until a human notices. Unlike a [`PeerRoute`] from
/// configuration, this exists only in memory and does not survive a
/// restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeasedRoute {
    route: PeerRoute,
    expires_at: DateTime<Utc>,
}

impl LeasedRoute {
    pub fn new(
        prefix: impl Into<String>,
        peer_id: impl Into<String>,
        fee: u64,
        expires_at: DateTime<Utc>,
    ) -> LeasedRoute {
        LeasedRoute {
            route: PeerRoute::new(prefix, peer_id, fee),
            expires_at,
        }
    }

    pub fn prefix(&self) -> &str {
        self.route.prefix()
    }

    pub fn peer_id(&self) -> &str {
        self.route.peer_id()
    }

    pub fn fee(&self) -> u64 {
        self.route.fee()
    }

    /// The instant, as this connector's injected clock reports it, past
    /// which this lease has lapsed.
    pub fn expires_at(&self) -> DateTime<Utc> {
        self.expires_at
    }

    /// This lease's route, borrowed as a plain [`PeerRoute`] (issue #452):
    /// once a lease has been selected for a packet it forwards exactly like
    /// a peer route from configuration, and this hands that shared
    /// forwarding behaviour a reference into the snapshot already being
    /// held rather than a fresh clone.
    pub fn as_peer_route(&self) -> &PeerRoute {
        &self.route
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn exposes_prefix_peer_id_and_fee() {
        let route = PeerRoute::new("g.example.remote", "peer-b", 5);
        assert_eq!(route.prefix(), "g.example.remote");
        assert_eq!(route.peer_id(), "peer-b");
        assert_eq!(route.fee(), 5);
    }

    #[test]
    fn leased_route_exposes_prefix_peer_id_fee_and_expiry() {
        let expires_at = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();
        let route = LeasedRoute::new("g.example.remote", "peer-b", 5, expires_at);
        assert_eq!(route.prefix(), "g.example.remote");
        assert_eq!(route.peer_id(), "peer-b");
        assert_eq!(route.fee(), 5);
        assert_eq!(route.expires_at(), expires_at);
    }
}
