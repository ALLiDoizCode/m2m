use serde::Deserialize;

use crate::error::ConfigError;
use crate::route::is_valid_ilp_address;

/// The `[peer_sale]` section as written in the config file (issue #885,
/// part of #867 "sell peering"): the single ILP address that, when paid,
/// buys peering with this node -- inserting the payer into the runtime
/// peer/route table (issue #884) rather than requiring an out-of-band
/// `{peerId, secret}` exchange.
///
/// Unlike `[[routes]]`, this is a singleton table, not an array: a node
/// sells exactly one peering offer, at one price, discoverable at one
/// address. `deny_unknown_fields` (issue #556's principle): a mistyped
/// `pric` is a refuse-to-start error, not a route that silently resolves
/// with a price of nothing.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawPeerSale {
    prefix: String,
    #[serde(default)]
    price: Option<u64>,
    #[serde(default)]
    lease_seconds: Option<u64>,
    #[serde(default)]
    max_purchased_rows: Option<u64>,
    #[serde(default)]
    max_routes_per_payer: Option<u64>,
    #[serde(default)]
    max_prefix_length: Option<u32>,
    #[serde(default)]
    purchase_rate_limit: Option<u32>,
    #[serde(default)]
    purchase_rate_window_seconds: Option<u64>,
}

/// Issue #887 (C4, part of #867 "sell peering"): abuse-bound defaults,
/// used whenever `[peer_sale]` leaves the matching field unwritten. Tight
/// on purpose -- the issue's own instruction is "err toward tight
/// defaults; loosening later is easy" -- and sized for the 3-box devnet
/// fleet this ships to, not a production multi-tenant node.
///
/// Public so the runtime's own `PeerSaleBounds::default` reads the same
/// numbers rather than restating them: a connector that never sees a
/// `[peer_sale]` section is bounded exactly as one whose section leaves
/// every bound unwritten, and the two can never drift apart.
pub const DEFAULT_MAX_PURCHASED_ROWS: u64 = 32;
pub const DEFAULT_MAX_ROUTES_PER_PAYER: u64 = 4;
pub const DEFAULT_MAX_PREFIX_LENGTH: u32 = 128;
pub const DEFAULT_PURCHASE_RATE_LIMIT: u32 = 5;
pub const DEFAULT_PURCHASE_RATE_WINDOW_SECONDS: u64 = 60;

/// A fully validated `[peer_sale]` section. Constructed only by
/// [`resolve_peer_sale`], so a value that exists has already had its
/// prefix, price and lease checked -- downstream code never re-validates
/// any of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerSaleConfig {
    prefix: String,
    price: u64,
    lease_seconds: u64,
    max_purchased_rows: u64,
    max_routes_per_payer: u64,
    max_prefix_length: u32,
    purchase_rate_limit: u32,
    purchase_rate_window_seconds: u64,
}

impl PeerSaleConfig {
    /// The destination prefix that, when paid, buys peering with this node.
    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    /// The flat price a claim must advance by to buy peering (mirrors
    /// issue #520's terminated-route pricing) -- never zero by accident:
    /// [`resolve_peer_sale`] refuses an absent `price`, matching every
    /// other priced route in this file (issue #557's "never silently
    /// free").
    pub fn price(&self) -> u64 {
        self.price
    }

    /// How long a purchase leases peering for before it lapses and the
    /// peer row is demoted back to client role (issue #886), renewable by
    /// paying again before it runs out. Never absent by accident, for the
    /// same reason `price` is never absent: a purchase with no lease
    /// duration would silently be a permanent grant, exactly the defect
    /// issue #886 exists to close.
    pub fn lease_seconds(&self) -> u64 {
        self.lease_seconds
    }

    /// Issue #887: the total number of runtime-purchased peer rows (one
    /// per distinct payer -- a channel can only ever buy itself one peer
    /// identity, since `peer_id` IS the channel key, ADR 0037) this node
    /// will hold at once. A purchase from a new payer once this many are
    /// already leased is refused rather than accepted -- the row cap that
    /// bounds how much of this node's disk and routing table a purchaser
    /// can claim in total.
    pub fn max_purchased_rows(&self) -> u64 {
        self.max_purchased_rows
    }

    /// Issue #887: the number of purchased routes (prefixes) a single
    /// payer's peer id may have inserted at once. Unlike
    /// [`Self::max_purchased_rows`] (bounded to one per payer by
    /// construction), a payer can buy any number of distinct prefixes
    /// forwarding to the one peer id it holds -- this is the bound that
    /// stops one payer from claiming an unbounded slice of the prefix
    /// space.
    pub fn max_routes_per_payer(&self) -> u64 {
        self.max_routes_per_payer
    }

    /// Issue #887: the longest a purchased prefix may be, in bytes.
    /// Tighter than `connector_domain::is_valid_ilp_address`'s own
    /// 1023-byte RFC ceiling -- that check still applies to every ILP
    /// address; this one is this node's own choice about how much of that
    /// allowance a *purchase* gets to spend.
    pub fn max_prefix_length(&self) -> u32 {
        self.max_prefix_length
    }

    /// Issue #887: the number of purchase attempts a single payer may make
    /// within [`Self::purchase_rate_window_seconds`], successful or not --
    /// the "rate limit on purchase attempts per identity" the issue asks
    /// for.
    pub fn purchase_rate_limit(&self) -> u32 {
        self.purchase_rate_limit
    }

    /// The window [`Self::purchase_rate_limit`] is counted over, in
    /// seconds.
    pub fn purchase_rate_window_seconds(&self) -> u64 {
        self.purchase_rate_window_seconds
    }
}

/// Validate the optional `[peer_sale]` section. `None` in, `None` out --
/// a node that writes nothing sells no peering, exactly as before this
/// section existed.
pub(crate) fn resolve_peer_sale(
    raw: Option<RawPeerSale>,
) -> Result<Option<PeerSaleConfig>, ConfigError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if !is_valid_ilp_address(&raw.prefix) {
        return Err(ConfigError::InvalidAddress {
            field: "peer_sale.prefix",
            value: raw.prefix,
        });
    }
    let price = raw.price.ok_or_else(|| ConfigError::PeerSaleMissingPrice {
        prefix: raw.prefix.clone(),
    })?;
    let lease_seconds = raw
        .lease_seconds
        .ok_or_else(|| ConfigError::PeerSaleMissingLease {
            prefix: raw.prefix.clone(),
        })?;
    Ok(Some(PeerSaleConfig {
        prefix: raw.prefix,
        price,
        lease_seconds,
        max_purchased_rows: raw.max_purchased_rows.unwrap_or(DEFAULT_MAX_PURCHASED_ROWS),
        max_routes_per_payer: raw
            .max_routes_per_payer
            .unwrap_or(DEFAULT_MAX_ROUTES_PER_PAYER),
        max_prefix_length: raw.max_prefix_length.unwrap_or(DEFAULT_MAX_PREFIX_LENGTH),
        purchase_rate_limit: raw
            .purchase_rate_limit
            .unwrap_or(DEFAULT_PURCHASE_RATE_LIMIT),
        purchase_rate_window_seconds: raw
            .purchase_rate_window_seconds
            .unwrap_or(DEFAULT_PURCHASE_RATE_WINDOW_SECONDS),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_section_resolves_to_none() {
        assert_eq!(resolve_peer_sale(None).expect("resolve"), None);
    }

    #[test]
    fn a_priced_section_resolves() {
        let resolved = resolve_peer_sale(Some(RawPeerSale {
            prefix: "g.example.node.peer-sale".to_string(),
            price: Some(1000),
            lease_seconds: Some(3600),
            ..Default::default()
        }))
        .expect("resolve")
        .expect("some");
        assert_eq!(resolved.prefix(), "g.example.node.peer-sale");
        assert_eq!(resolved.price(), 1000);
        assert_eq!(resolved.lease_seconds(), 3600);
        assert_eq!(resolved.max_purchased_rows(), DEFAULT_MAX_PURCHASED_ROWS);
        assert_eq!(
            resolved.max_routes_per_payer(),
            DEFAULT_MAX_ROUTES_PER_PAYER
        );
        assert_eq!(resolved.max_prefix_length(), DEFAULT_MAX_PREFIX_LENGTH);
        assert_eq!(resolved.purchase_rate_limit(), DEFAULT_PURCHASE_RATE_LIMIT);
        assert_eq!(
            resolved.purchase_rate_window_seconds(),
            DEFAULT_PURCHASE_RATE_WINDOW_SECONDS
        );
    }

    #[test]
    fn abuse_bounds_are_configurable_and_override_the_defaults() {
        let resolved = resolve_peer_sale(Some(RawPeerSale {
            prefix: "g.example.node.peer-sale".to_string(),
            price: Some(1000),
            lease_seconds: Some(3600),
            max_purchased_rows: Some(2),
            max_routes_per_payer: Some(1),
            max_prefix_length: Some(16),
            purchase_rate_limit: Some(3),
            purchase_rate_window_seconds: Some(30),
        }))
        .expect("resolve")
        .expect("some");
        assert_eq!(resolved.max_purchased_rows(), 2);
        assert_eq!(resolved.max_routes_per_payer(), 1);
        assert_eq!(resolved.max_prefix_length(), 16);
        assert_eq!(resolved.purchase_rate_limit(), 3);
        assert_eq!(resolved.purchase_rate_window_seconds(), 30);
    }

    #[test]
    fn a_missing_price_is_rejected_at_load() {
        let result = resolve_peer_sale(Some(RawPeerSale {
            prefix: "g.example.node.peer-sale".to_string(),
            price: None,
            lease_seconds: Some(3600),
            ..Default::default()
        }));
        assert!(matches!(
            result,
            Err(ConfigError::PeerSaleMissingPrice { .. })
        ));
    }

    #[test]
    fn a_missing_lease_is_rejected_at_load() {
        let result = resolve_peer_sale(Some(RawPeerSale {
            prefix: "g.example.node.peer-sale".to_string(),
            price: Some(1000),
            lease_seconds: None,
            ..Default::default()
        }));
        assert!(matches!(
            result,
            Err(ConfigError::PeerSaleMissingLease { .. })
        ));
    }

    #[test]
    fn an_invalid_prefix_is_rejected() {
        let result = resolve_peer_sale(Some(RawPeerSale {
            prefix: "g..bad".to_string(),
            price: Some(1000),
            lease_seconds: Some(3600),
            ..Default::default()
        }));
        assert!(matches!(result, Err(ConfigError::InvalidAddress { .. })));
    }
}
