//! A routing-table entry whose next hop is another connector rather than
//! this one's own app. Paired with `connector_config::StaticRoute` at the
//! [`crate::Connector`] level -- `connector_domain::select_route` picks the
//! most specific prefix across both kinds without caring which one it is.

use chrono::{DateTime, Utc};

/// A route whose traffic this connector forwards to a peer's connector for
/// the next hop, rather than terminating it at an app of its own.
///
/// Carries **one** number: `price`, what this connector's own client edge
/// charges a *client* for a packet to this prefix (ADR 0028), out of which
/// the rest of the path is paid. What this hop retains of it is the
/// peering's flat per-packet **fee** (ADR 0010), which is not here and
/// never was a property of the prefix -- this hop does the same work
/// whichever prefix the packet was addressed to, so the fee attaches to the
/// peering `peer_id` names (ADR 0061) and the packet path reads it through
/// `Connector::fee_for`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerRoute {
    prefix: String,
    peer_id: String,
    price: u64,
}

impl PeerRoute {
    /// A forwarded route that this connector's client edge serves for free
    /// -- `price` zero. The shape a leased route (which has no price field
    /// at all) always has, and the shorthand a test that is about carriage
    /// rather than charging wants.
    pub fn new(prefix: impl Into<String>, peer_id: impl Into<String>) -> PeerRoute {
        PeerRoute::new_priced(prefix, peer_id, 0)
    }

    /// A forwarded route with an explicit client-edge price (ADR 0028) --
    /// what `connector-cli` builds from a `[[routes]]` entry's own `price`,
    /// which config load requires to be written down.
    pub fn new_priced(
        prefix: impl Into<String>,
        peer_id: impl Into<String>,
        price: u64,
    ) -> PeerRoute {
        PeerRoute {
            prefix: prefix.into(),
            peer_id: peer_id.into(),
            price,
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

    /// The flat price this connector's client edge charges a client for a
    /// packet to this prefix (ADR 0028), greeted and gated on exactly the
    /// path a terminated route's price is. Zero on a leased route, which
    /// has no price field to carry.
    pub fn price(&self) -> u64 {
        self.price
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
        expires_at: DateTime<Utc>,
    ) -> LeasedRoute {
        LeasedRoute {
            route: PeerRoute::new(prefix, peer_id),
            expires_at,
        }
    }

    pub fn prefix(&self) -> &str {
        self.route.prefix()
    }

    pub fn peer_id(&self) -> &str {
        self.route.peer_id()
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
    fn exposes_prefix_peer_id_and_price() {
        let route = PeerRoute::new_priced("g.example.remote", "peer-b", 25);
        assert_eq!(route.prefix(), "g.example.remote");
        assert_eq!(route.peer_id(), "peer-b");
        assert_eq!(route.price(), 25);
    }

    #[test]
    fn leased_route_exposes_prefix_peer_id_and_expiry() {
        let expires_at = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();
        let route = LeasedRoute::new("g.example.remote", "peer-b", expires_at);
        assert_eq!(route.prefix(), "g.example.remote");
        assert_eq!(route.peer_id(), "peer-b");
        assert_eq!(route.expires_at(), expires_at);
    }
}
