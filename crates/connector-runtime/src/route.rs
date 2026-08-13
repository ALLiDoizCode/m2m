//! A routing-table entry whose next hop is another connector rather than
//! this one's own app. Paired with `connector_config::StaticRoute` at the
//! [`crate::Connector`] level -- `connector_domain::select_route` picks the
//! most specific prefix across both kinds without caring which one it is.

use chrono::{DateTime, Duration, Utc};
use connector_config::{
    DEFAULT_MAX_PREFIX_LENGTH, DEFAULT_MAX_PURCHASED_ROWS, DEFAULT_MAX_ROUTES_PER_PAYER,
    DEFAULT_PURCHASE_RATE_LIMIT, DEFAULT_PURCHASE_RATE_WINDOW_SECONDS,
};

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

/// Abuse bounds on a purchased peering (issue #887, C4, part of #867 "sell
/// peering"). `Default` gives every bound a value even on a node that
/// never overrides one -- the same "fails closed" shape
/// `connector_runtime::Connector`'s probe rate limiter already takes,
/// since a purchase pays a stranger into this node's routing table and a
/// forgotten limit should not mean an unbounded one.
///
/// `max_purchased_rows` and `max_routes_per_payer` bound two different
/// tables, deliberately. A "peer row" is an entry in the runtime *peer*
/// table -- one per distinct payer, since a channel can only ever buy
/// itself one peer identity (`peer_id` IS the channel key that paid, ADR
/// 0037). A per-payer cap on *that* table would always be 0 or 1 and mean
/// nothing, so [`Self::max_purchased_rows`] bounds it globally instead:
/// how many distinct payers may hold a purchased peering at once. What a
/// single payer *can* grow without bound is how many *routes* (prefixes)
/// forward to the one peer id it bought -- that is what
/// [`Self::max_routes_per_payer`] counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerSaleBounds {
    max_purchased_rows: u64,
    max_routes_per_payer: u64,
    max_prefix_length: usize,
    purchase_rate_limit: u32,
    purchase_rate_window: Duration,
}

impl PeerSaleBounds {
    pub fn new(
        max_purchased_rows: u64,
        max_routes_per_payer: u64,
        max_prefix_length: usize,
        purchase_rate_limit: u32,
        purchase_rate_window: Duration,
    ) -> PeerSaleBounds {
        PeerSaleBounds {
            max_purchased_rows,
            max_routes_per_payer,
            max_prefix_length,
            purchase_rate_limit,
            purchase_rate_window,
        }
    }

    /// The total number of distinct payers this node will hold a
    /// purchased peering for at once.
    pub fn max_purchased_rows(&self) -> u64 {
        self.max_purchased_rows
    }

    /// The number of purchased routes (prefixes) a single payer's peer id
    /// may have inserted at once.
    pub fn max_routes_per_payer(&self) -> u64 {
        self.max_routes_per_payer
    }

    /// The longest a purchased prefix may be, in bytes.
    pub fn max_prefix_length(&self) -> usize {
        self.max_prefix_length
    }

    /// The number of purchase attempts, successful or not, a single payer
    /// may make within [`Self::purchase_rate_window`].
    pub fn purchase_rate_limit(&self) -> u32 {
        self.purchase_rate_limit
    }

    /// The window [`Self::purchase_rate_limit`] is counted over.
    pub fn purchase_rate_window(&self) -> Duration {
        self.purchase_rate_window
    }
}

impl Default for PeerSaleBounds {
    /// Reads `connector_config`'s own `[peer_sale]` defaults rather than
    /// restating them, so a node with no `[peer_sale]` section is bounded
    /// exactly like one whose section leaves every bound unwritten. This
    /// is what a `Connector` starts with before any section is read, and
    /// what `with_peer_sale_bounds` overrides from that section's fields
    /// precisely like price and lease already are.
    fn default() -> PeerSaleBounds {
        PeerSaleBounds {
            max_purchased_rows: DEFAULT_MAX_PURCHASED_ROWS,
            max_routes_per_payer: DEFAULT_MAX_ROUTES_PER_PAYER,
            max_prefix_length: DEFAULT_MAX_PREFIX_LENGTH as usize,
            purchase_rate_limit: DEFAULT_PURCHASE_RATE_LIMIT,
            purchase_rate_window: Duration::seconds(DEFAULT_PURCHASE_RATE_WINDOW_SECONDS as i64),
        }
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
    fn peer_sale_bounds_exposes_every_field() {
        let bounds = PeerSaleBounds::new(2, 1, 16, 3, Duration::seconds(30));
        assert_eq!(bounds.max_purchased_rows(), 2);
        assert_eq!(bounds.max_routes_per_payer(), 1);
        assert_eq!(bounds.max_prefix_length(), 16);
        assert_eq!(bounds.purchase_rate_limit(), 3);
        assert_eq!(bounds.purchase_rate_window(), Duration::seconds(30));
    }

    #[test]
    fn peer_sale_bounds_default_is_tight_but_nonzero() {
        let bounds = PeerSaleBounds::default();
        assert_eq!(bounds.max_purchased_rows(), 32);
        assert_eq!(bounds.max_routes_per_payer(), 4);
        assert_eq!(bounds.max_prefix_length(), 128);
        assert_eq!(bounds.purchase_rate_limit(), 5);
        assert_eq!(bounds.purchase_rate_window(), Duration::seconds(60));
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
