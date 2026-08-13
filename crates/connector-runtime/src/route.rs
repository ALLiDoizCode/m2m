//! A routing-table entry whose next hop is another connector rather than
//! this one's own app. Paired with `connector_config::StaticRoute` at the
//! [`crate::Connector`] level -- `connector_domain::select_route` picks the
//! most specific prefix across both kinds without caring which one it is.

use chrono::{DateTime, Duration, Utc};

/// A route whose traffic this connector forwards to a peer's connector for
/// the next hop, rather than terminating it at an app of its own.
///
/// The two numbers answer different questions (ADR 0028). `fee` is this
/// peering relation's flat per-packet fee (ADR 0010) -- what this hop
/// *retains*, charged once per forwarded packet, agreed bilaterally, and
/// never a share of the amount being carried. `price` is what this
/// connector's own client edge charges a *client* for a packet to this
/// prefix, out of which the rest of the path is paid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerRoute {
    prefix: String,
    peer_id: String,
    fee: u64,
    price: u64,
}

impl PeerRoute {
    /// A forwarded route that this connector's client edge serves for free
    /// -- `price` zero. The shape a leased route (which has no price field
    /// at all) always has, and the shorthand a test that is about carriage
    /// rather than charging wants.
    pub fn new(prefix: impl Into<String>, peer_id: impl Into<String>, fee: u64) -> PeerRoute {
        PeerRoute::new_priced(prefix, peer_id, fee, 0)
    }

    /// A forwarded route with an explicit client-edge price (ADR 0028) --
    /// what `connector-cli` builds from a `[[routes]]` entry's own `price`,
    /// which config load requires to be written down.
    pub fn new_priced(
        prefix: impl Into<String>,
        peer_id: impl Into<String>,
        fee: u64,
        price: u64,
    ) -> PeerRoute {
        PeerRoute {
            prefix: prefix.into(),
            peer_id: peer_id.into(),
            fee,
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

    /// This peering relation's flat per-packet fee (ADR 0010) -- what this
    /// hop retains, not what a client is charged.
    pub fn fee(&self) -> u64 {
        self.fee
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

/// The single priced route that, when paid, buys peering with this
/// connector (issue #885, part of #867 "sell peering"): its effect on
/// payment is inserting the payer into the runtime peer/route table
/// (issue #884, `Connector::upsert_runtime_peer`/`upsert_runtime_peer_route`)
/// rather than terminating at an app or forwarding to a configured peer.
/// Priced exactly like a terminated route (issue #520) -- `price` is what
/// this connector's client edge charges to buy peering, greeted and gated
/// on the same path -- and carries no `fee`, since it is not itself
/// carriage: the peer-forwarding route it causes to be inserted carries
/// its own `fee`/`price`, negotiated at purchase time.
///
/// `lease` (issue #886) is what the purchase actually buys alongside the
/// table write: the peer and route rows a purchase inserts expire this
/// long after the purchase clears (or after the most recent renewal --
/// see `Connector::upsert_runtime_peer_purchase`), unlike a config-file
/// `[[peers]]`/`[[routes]]` row or an operator-added runtime one via
/// `POST /peers`, neither of which ever carries a lease at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerSaleRoute {
    prefix: String,
    price: u64,
    lease: Duration,
}

impl PeerSaleRoute {
    pub fn new(prefix: impl Into<String>, price: u64, lease: Duration) -> PeerSaleRoute {
        PeerSaleRoute {
            prefix: prefix.into(),
            price,
            lease,
        }
    }

    /// The destination prefix that, when paid, buys peering with this node.
    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    /// The flat price a claim must advance by to buy peering.
    pub fn price(&self) -> u64 {
        self.price
    }

    /// How long a purchase leases peering for, from the moment it clears
    /// (or extends from the current expiry, on a renewal).
    pub fn lease(&self) -> Duration {
        self.lease
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
    fn peer_sale_route_exposes_prefix_price_and_lease() {
        let sale = PeerSaleRoute::new("g.example.node.peer-sale", 1000, Duration::seconds(3600));
        assert_eq!(sale.prefix(), "g.example.node.peer-sale");
        assert_eq!(sale.price(), 1000);
        assert_eq!(sale.lease(), Duration::seconds(3600));
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
