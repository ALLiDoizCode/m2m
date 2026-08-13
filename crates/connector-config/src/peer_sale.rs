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
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawPeerSale {
    prefix: String,
    #[serde(default)]
    price: Option<u64>,
}

/// A fully validated `[peer_sale]` section. Constructed only by
/// [`resolve_peer_sale`], so a value that exists has already had its
/// prefix and price checked -- downstream code never re-validates either.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerSaleConfig {
    prefix: String,
    price: u64,
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
    Ok(Some(PeerSaleConfig {
        prefix: raw.prefix,
        price,
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
        }))
        .expect("resolve")
        .expect("some");
        assert_eq!(resolved.prefix(), "g.example.node.peer-sale");
        assert_eq!(resolved.price(), 1000);
    }

    #[test]
    fn a_missing_price_is_rejected_at_load() {
        let result = resolve_peer_sale(Some(RawPeerSale {
            prefix: "g.example.node.peer-sale".to_string(),
            price: None,
        }));
        assert!(matches!(
            result,
            Err(ConfigError::PeerSaleMissingPrice { .. })
        ));
    }

    #[test]
    fn an_invalid_prefix_is_rejected() {
        let result = resolve_peer_sale(Some(RawPeerSale {
            prefix: "g..bad".to_string(),
            price: Some(1000),
        }));
        assert!(matches!(result, Err(ConfigError::InvalidAddress { .. })));
    }
}
