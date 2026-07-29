use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use url::Url;

use crate::error::ConfigError;

/// Maximum length of an ILP address, per RFC 0015.
const MAX_ILP_ADDRESS_LEN: usize = 1023;

/// A single label between dots is alphanumeric plus `-`/`_`, matching RFC
/// 0015 and the existing TypeScript connector's `isValidILPAddress`.
fn is_valid_label(label: &str) -> bool {
    !label.is_empty()
        && label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// An ILP address is one or more valid labels joined by dots -- no leading,
/// trailing, or consecutive dots, and no characters outside the label set.
fn is_valid_ilp_address(address: &str) -> bool {
    !address.is_empty()
        && address.len() <= MAX_ILP_ADDRESS_LEN
        && address.split('.').all(is_valid_label)
}

/// A `[[routes]]` entry as written in the config file: forwards to the app
/// at `handler_url`, or to the peer named `peer_id` -- exactly one of the
/// two must be set. `fee` is only meaningful alongside `peer_id` (ADR
/// 0010) and defaults to zero there; `price` is only meaningful alongside
/// `handler_url` (issue #520) and is required there -- see
/// [`ConfigError::RouteMissingPrice`].
///
/// Neither field is silently ignored on the branch it does not belong to
/// (issue #556): `fee` is an `Option` rather than a defaulted `u64`
/// precisely so [`resolve_routes`] can tell "written as zero" from "not
/// written", and refuse the former on a terminated route
/// ([`ConfigError::TerminatedRouteHasFee`]) exactly as it refuses a `price`
/// on a peer route ([`ConfigError::PeerRouteHasPrice`]). Before that, a
/// `peer_id` route with `price = 100` charged nothing and a `handler_url`
/// route with `fee = 5` earned nothing, and neither was an error.
///
/// `deny_unknown_fields` closes the same hole for every other key: a
/// mistyped `pefix` or `handler_ur` is a refuse-to-start error, not a route
/// quietly resolved from the fields that happened to spell correctly.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawRoute {
    prefix: String,
    #[serde(default)]
    handler_url: Option<String>,
    #[serde(default)]
    peer_id: Option<String>,
    #[serde(default)]
    fee: Option<u64>,
    #[serde(default)]
    price: Option<u64>,
}

/// A `[[children]]` entry: a convenience form that desugars into a
/// [`RawRoute`] at `<apex>.<name>` once the file is loaded (mirroring the
/// existing TypeScript `child-expander`), so the runtime never sees anything
/// but ordinary routes. Always terminates locally, so `price` is required
/// exactly like an explicit `[[routes]]` entry with a `handler_url`.
///
/// `deny_unknown_fields` (issue #556): a child always terminates locally,
/// so it has no `fee` field at all -- writing one used to vanish silently,
/// and now fails config load, matching what an explicit `[[routes]]` entry
/// with a `handler_url` does with the same key.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawChild {
    name: String,
    handler_url: String,
    #[serde(default)]
    price: Option<u64>,
}

/// A static route that terminates at this connector: packets matching
/// `prefix` are delivered to the app at `handler_url`, which charges
/// `price` for the work it does -- distinct from a peer route's `fee`,
/// which buys carriage rather than the terminating app's work (issue
/// #520). A route is never silently free: [`resolve_routes`] refuses to
/// return one with no configured price, so `price == 0` always means the
/// operator wrote it deliberately.
///
/// Constructed only by [`resolve_routes`], so a value that exists has
/// already had its prefix, URL and price validated -- downstream code
/// never re-checks any of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaticRoute {
    prefix: String,
    handler_url: Url,
    price: u64,
}

impl StaticRoute {
    /// Construct and fully validate a single static route directly, priced
    /// at zero -- the same validation [`resolve_routes`] applies, exposed
    /// for a caller that already has a prefix and handler URL in hand
    /// (tests, and any future operator-surface route creation) rather than
    /// a whole config file. Unlike the config-file path there is no
    /// load-time gate here to make a zero price silent, so a caller that
    /// cares about pricing should use [`StaticRoute::new_priced`] instead.
    pub fn new(
        prefix: impl Into<String>,
        handler_url: impl Into<String>,
    ) -> Result<StaticRoute, ConfigError> {
        build_route(prefix.into(), handler_url.into(), Some(0))
    }

    /// Construct and fully validate a single static route with an explicit
    /// price (issue #520).
    pub fn new_priced(
        prefix: impl Into<String>,
        handler_url: impl Into<String>,
        price: u64,
    ) -> Result<StaticRoute, ConfigError> {
        build_route(prefix.into(), handler_url.into(), Some(price))
    }

    /// The destination prefix this route terminates.
    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    /// The app handler this route's traffic is delivered to.
    pub fn handler_url(&self) -> &Url {
        &self.handler_url
    }

    /// The flat price a claim must advance by to pay for this route (issue
    /// #520). Never emitted to a client -- ADR 0006 keeps this connector
    /// mechanism, not a discovery source. Charging it against a claim is
    /// out of scope for this ticket; the value is only loaded and read
    /// back here.
    pub fn price(&self) -> u64 {
        self.price
    }
}

/// A route whose traffic this connector forwards to a peer rather than
/// terminating at an app of its own. This is the config-file counterpart of
/// `connector_runtime::PeerRoute` -- kept as its own type here (rather than
/// depending on `connector-runtime`, which itself depends on this crate) --
/// `connector-cli` converts one into the other when it builds the runtime
/// `Connector`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerRouteConfig {
    prefix: String,
    peer_id: String,
    fee: u64,
}

impl PeerRouteConfig {
    /// The destination prefix this route forwards.
    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    /// The peer this route's traffic is forwarded to, by id -- matched
    /// against a `[[peers]]` entry's own `id`.
    pub fn peer_id(&self) -> &str {
        &self.peer_id
    }

    /// This peering relation's flat per-packet fee (ADR 0010).
    pub fn fee(&self) -> u64 {
        self.fee
    }
}

/// Validate a route's `prefix` field, shared by [`build_route`] and
/// [`build_peer_route`] since both kinds of route are keyed by the same
/// ILP address rules.
fn validate_prefix(prefix: String) -> Result<String, ConfigError> {
    if !is_valid_ilp_address(&prefix) {
        return Err(ConfigError::InvalidAddress {
            field: "prefix",
            value: prefix,
        });
    }
    Ok(prefix)
}

fn build_route(
    prefix: String,
    handler_url: String,
    price: Option<u64>,
) -> Result<StaticRoute, ConfigError> {
    let prefix = validate_prefix(prefix)?;
    let url = Url::parse(&handler_url).map_err(|source| ConfigError::InvalidHandlerUrl {
        prefix: prefix.clone(),
        value: handler_url.clone(),
        source,
    })?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(ConfigError::UnsupportedUrlScheme {
            prefix,
            value: handler_url,
        });
    }
    let price = price.ok_or_else(|| ConfigError::RouteMissingPrice {
        prefix: prefix.clone(),
        handler_url: url.to_string(),
    })?;
    Ok(StaticRoute {
        prefix,
        handler_url: url,
        price,
    })
}

/// Record `route`'s `(handler_url, price)` pair, refusing a second route
/// that reuses the same `handler_url` at a different price (issue #520):
/// the app behind that handler cannot tell which request arrived under
/// which price, so the cheaper one would always win.
fn insert_consistent_handler_price(
    seen: &mut HashMap<String, (String, u64)>,
    route: &StaticRoute,
) -> Result<(), ConfigError> {
    let handler_url = route.handler_url().to_string();
    match seen.get(&handler_url) {
        Some((first_prefix, first_price)) if *first_price != route.price() => {
            Err(ConfigError::ConflictingHandlerPrice {
                handler_url,
                first_prefix: first_prefix.clone(),
                first_price: *first_price,
                second_prefix: route.prefix().to_string(),
                second_price: route.price(),
            })
        }
        Some(_) => Ok(()),
        None => {
            seen.insert(handler_url, (route.prefix().to_string(), route.price()));
            Ok(())
        }
    }
}

fn build_peer_route(
    prefix: String,
    peer_id: String,
    fee: u64,
) -> Result<PeerRouteConfig, ConfigError> {
    let prefix = validate_prefix(prefix)?;
    if peer_id.trim().is_empty() {
        return Err(ConfigError::RoutePeerIdEmpty { prefix });
    }
    Ok(PeerRouteConfig {
        prefix,
        peer_id,
        fee,
    })
}

fn insert_unique_prefix(seen: &mut HashSet<String>, prefix: &str) -> Result<(), ConfigError> {
    if !seen.insert(prefix.to_string()) {
        return Err(ConfigError::DuplicatePrefix {
            prefix: prefix.to_string(),
        });
    }
    Ok(())
}

/// Resolve `routes` and desugar `children` (under `apex`) into fully
/// validated, deduplicated route tables -- app routes and peer routes,
/// sharing one prefix namespace (a peer route and an app route can never
/// claim the same prefix). `children` always desugars into app routes,
/// matching its role as a convenience form for this node's own apps.
pub(crate) fn resolve_routes(
    apex: Option<&str>,
    raw_routes: Vec<RawRoute>,
    raw_children: Vec<RawChild>,
) -> Result<(Vec<StaticRoute>, Vec<PeerRouteConfig>), ConfigError> {
    let mut seen = HashSet::with_capacity(raw_routes.len() + raw_children.len());
    let mut handler_prices = HashMap::new();
    let mut routes = Vec::with_capacity(raw_routes.len());
    let mut peer_routes = Vec::new();

    for raw in raw_routes {
        match (raw.handler_url, raw.peer_id) {
            (Some(handler_url), None) => {
                // A terminated route buys the app's work, priced by
                // `price`; `fee` buys carriage over a peering relation
                // this route has none of (ADR 0010). Refused rather than
                // read and discarded (issue #556).
                if let Some(fee) = raw.fee {
                    return Err(ConfigError::TerminatedRouteHasFee {
                        prefix: raw.prefix,
                        fee,
                    });
                }
                let route = build_route(raw.prefix, handler_url, raw.price)?;
                insert_unique_prefix(&mut seen, route.prefix())?;
                insert_consistent_handler_price(&mut handler_prices, &route)?;
                routes.push(route);
            }
            (None, Some(peer_id)) => {
                // Mirror image: a forwarded route has no terminating app
                // whose work a `price` could pay for.
                if let Some(price) = raw.price {
                    return Err(ConfigError::PeerRouteHasPrice {
                        prefix: raw.prefix,
                        price,
                    });
                }
                let route = build_peer_route(raw.prefix, peer_id, raw.fee.unwrap_or(0))?;
                insert_unique_prefix(&mut seen, route.prefix())?;
                peer_routes.push(route);
            }
            (None, None) => {
                return Err(ConfigError::RouteMissingTarget { prefix: raw.prefix });
            }
            (Some(_), Some(_)) => {
                return Err(ConfigError::RouteTargetAmbiguous { prefix: raw.prefix });
            }
        }
    }

    if raw_children.is_empty() {
        return Ok((routes, peer_routes));
    }

    let apex = apex.ok_or(ConfigError::MissingApex)?;
    if !is_valid_ilp_address(apex) {
        return Err(ConfigError::InvalidAddress {
            field: "apex",
            value: apex.to_string(),
        });
    }

    for child in raw_children {
        if !is_valid_label(&child.name) {
            return Err(ConfigError::InvalidChildName { name: child.name });
        }
        let prefix = format!("{apex}.{}", child.name);
        let route = build_route(prefix, child.handler_url, child.price)?;
        insert_unique_prefix(&mut seen, route.prefix())?;
        insert_consistent_handler_price(&mut handler_prices, &route)?;
        routes.push(route);
    }

    Ok((routes, peer_routes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(prefix: &str, handler_url: &str) -> RawRoute {
        priced_route(prefix, handler_url, 0)
    }

    fn priced_route(prefix: &str, handler_url: &str, price: u64) -> RawRoute {
        RawRoute {
            prefix: prefix.to_string(),
            handler_url: Some(handler_url.to_string()),
            peer_id: None,
            fee: None,
            price: Some(price),
        }
    }

    fn peer_route(prefix: &str, peer_id: &str, fee: u64) -> RawRoute {
        RawRoute {
            prefix: prefix.to_string(),
            handler_url: None,
            peer_id: Some(peer_id.to_string()),
            fee: Some(fee),
            price: None,
        }
    }

    fn child(name: &str, handler_url: &str) -> RawChild {
        RawChild {
            name: name.to_string(),
            handler_url: handler_url.to_string(),
            price: Some(0),
        }
    }

    #[test]
    fn static_route_new_validates_like_resolve_routes() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").expect("new");
        assert_eq!(route.prefix(), "g.example.app");
        assert_eq!(route.price(), 0);

        let result = StaticRoute::new("g..app", "http://localhost:4000");
        assert!(matches!(result, Err(ConfigError::InvalidAddress { .. })));
    }

    #[test]
    fn static_route_new_priced_carries_the_given_price() {
        let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 42)
            .expect("new_priced");
        assert_eq!(route.price(), 42);
    }

    #[test]
    fn resolves_explicit_routes() {
        let (routes, peer_routes) = resolve_routes(
            None,
            vec![priced_route("g.example.app", "http://localhost:4000", 25)],
            vec![],
        )
        .expect("resolve");

        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].prefix(), "g.example.app");
        assert_eq!(routes[0].handler_url().as_str(), "http://localhost:4000/");
        assert_eq!(routes[0].price(), 25);
        assert!(peer_routes.is_empty());
    }

    #[test]
    fn a_terminated_route_with_no_price_is_rejected_at_load() {
        let result = resolve_routes(
            None,
            vec![RawRoute {
                prefix: "g.example.app".to_string(),
                handler_url: Some("http://localhost:4000".to_string()),
                peer_id: None,
                fee: None,
                price: None,
            }],
            vec![],
        );
        assert!(matches!(result, Err(ConfigError::RouteMissingPrice { .. })));
    }

    /// Issue #556: `fee` was read only on the `peer_id` branch, so a
    /// terminated route that wrote one earned nothing from it and nothing
    /// said so. A field written down is honoured or refused, never dropped.
    #[test]
    fn a_terminated_route_that_sets_a_fee_is_rejected_rather_than_ignored() {
        let result = resolve_routes(
            None,
            vec![RawRoute {
                prefix: "g.example.app".to_string(),
                handler_url: Some("http://localhost:4000".to_string()),
                peer_id: None,
                fee: Some(5),
                price: Some(100),
            }],
            vec![],
        );
        assert!(matches!(
            result,
            Err(ConfigError::TerminatedRouteHasFee { fee: 5, .. })
        ));
    }

    /// `fee = 0` on a terminated route is refused too: the point is that
    /// the key was written at all, not that its value was non-zero --
    /// `fee` is an `Option` precisely so this case is visible.
    #[test]
    fn a_terminated_route_that_sets_a_zero_fee_is_still_rejected() {
        let result = resolve_routes(
            None,
            vec![RawRoute {
                prefix: "g.example.app".to_string(),
                handler_url: Some("http://localhost:4000".to_string()),
                peer_id: None,
                fee: Some(0),
                price: Some(100),
            }],
            vec![],
        );
        assert!(matches!(
            result,
            Err(ConfigError::TerminatedRouteHasFee { fee: 0, .. })
        ));
    }

    /// The mirror image: `price` was read only on the `handler_url`
    /// branch, so a peer route that wrote `price = 100` charged nothing.
    #[test]
    fn a_peer_route_that_sets_a_price_is_rejected_rather_than_ignored() {
        let result = resolve_routes(
            None,
            vec![RawRoute {
                prefix: "g.example.store".to_string(),
                handler_url: None,
                peer_id: Some("store".to_string()),
                fee: Some(3),
                price: Some(100),
            }],
            vec![],
        );
        assert!(matches!(
            result,
            Err(ConfigError::PeerRouteHasPrice { price: 100, .. })
        ));
    }

    /// The counterweight to both: each field on the branch it belongs to
    /// is still read and still honoured.
    #[test]
    fn each_field_is_honoured_on_the_branch_it_belongs_to() {
        let (routes, peer_routes) = resolve_routes(
            None,
            vec![
                priced_route("g.example.app", "http://localhost:4000", 100),
                peer_route("g.example.store", "store", 3),
            ],
            vec![],
        )
        .expect("resolve");

        assert_eq!(routes[0].price(), 100);
        assert_eq!(peer_routes[0].fee(), 3);
    }

    /// A peer route that omits `fee` entirely still defaults to zero --
    /// unlike a terminated route's `price`, carriage has never been
    /// required to be written down (ADR 0010), and #556 does not change
    /// that.
    #[test]
    fn a_peer_route_with_no_fee_still_defaults_to_zero() {
        let (_, peer_routes) = resolve_routes(
            None,
            vec![RawRoute {
                prefix: "g.example.store".to_string(),
                handler_url: None,
                peer_id: Some("store".to_string()),
                fee: None,
                price: None,
            }],
            vec![],
        )
        .expect("resolve");

        assert_eq!(peer_routes[0].fee(), 0);
    }

    #[test]
    fn a_terminated_route_priced_zero_is_deliberately_free_not_rejected() {
        let (routes, _) = resolve_routes(
            None,
            vec![priced_route("g.example.app", "http://localhost:4000", 0)],
            vec![],
        )
        .expect("resolve");
        assert_eq!(routes[0].price(), 0);
    }

    #[test]
    fn a_peer_route_needs_no_price() {
        let (_, peer_routes) =
            resolve_routes(None, vec![peer_route("g.peer-b", "peer-b", 5)], vec![])
                .expect("resolve");
        assert_eq!(peer_routes[0].fee(), 5);
    }

    #[test]
    fn a_child_with_no_price_is_rejected_at_load() {
        let result = resolve_routes(
            Some("g.example.connector"),
            vec![],
            vec![RawChild {
                name: "billing".to_string(),
                handler_url: "http://localhost:4001".to_string(),
                price: None,
            }],
        );
        assert!(matches!(result, Err(ConfigError::RouteMissingPrice { .. })));
    }

    #[test]
    fn two_routes_sharing_a_handler_at_the_same_price_both_load() {
        let (routes, _) = resolve_routes(
            None,
            vec![
                priced_route("g.example.a", "http://localhost:4000", 10),
                priced_route("g.example.b", "http://localhost:4000", 10),
            ],
            vec![],
        )
        .expect("resolve");
        assert_eq!(routes.len(), 2);
    }

    #[test]
    fn two_routes_sharing_a_handler_at_different_prices_are_rejected() {
        let result = resolve_routes(
            None,
            vec![
                priced_route("g.example.a", "http://localhost:4000", 10),
                priced_route("g.example.b", "http://localhost:4000", 20),
            ],
            vec![],
        );
        assert!(matches!(
            result,
            Err(ConfigError::ConflictingHandlerPrice { .. })
        ));
    }

    #[test]
    fn a_route_and_a_child_sharing_a_handler_at_different_prices_are_rejected() {
        let result = resolve_routes(
            Some("g.example.connector"),
            vec![priced_route("g.example.other", "http://localhost:4000", 10)],
            vec![RawChild {
                name: "billing".to_string(),
                handler_url: "http://localhost:4000".to_string(),
                price: Some(20),
            }],
        );
        assert!(matches!(
            result,
            Err(ConfigError::ConflictingHandlerPrice { .. })
        ));
    }

    #[test]
    fn resolves_explicit_peer_routes() {
        let (routes, peer_routes) =
            resolve_routes(None, vec![peer_route("g.peer-b", "peer-b", 5)], vec![])
                .expect("resolve");

        assert!(routes.is_empty());
        assert_eq!(peer_routes.len(), 1);
        assert_eq!(peer_routes[0].prefix(), "g.peer-b");
        assert_eq!(peer_routes[0].peer_id(), "peer-b");
        assert_eq!(peer_routes[0].fee(), 5);
    }

    #[test]
    fn rejects_a_route_with_neither_handler_url_nor_peer_id() {
        let result = resolve_routes(
            None,
            vec![RawRoute {
                prefix: "g.example.app".to_string(),
                handler_url: None,
                peer_id: None,
                fee: None,
                price: None,
            }],
            vec![],
        );
        assert!(matches!(
            result,
            Err(ConfigError::RouteMissingTarget { .. })
        ));
    }

    #[test]
    fn rejects_a_route_with_both_handler_url_and_peer_id() {
        let result = resolve_routes(
            None,
            vec![RawRoute {
                prefix: "g.example.app".to_string(),
                handler_url: Some("http://localhost:4000".to_string()),
                peer_id: Some("peer-b".to_string()),
                fee: None,
                price: None,
            }],
            vec![],
        );
        assert!(matches!(
            result,
            Err(ConfigError::RouteTargetAmbiguous { .. })
        ));
    }

    #[test]
    fn rejects_a_peer_route_with_an_empty_peer_id() {
        let result = resolve_routes(None, vec![peer_route("g.peer-b", "   ", 0)], vec![]);
        assert!(matches!(result, Err(ConfigError::RoutePeerIdEmpty { .. })));
    }

    #[test]
    fn a_peer_route_colliding_with_an_app_route_is_a_duplicate() {
        let result = resolve_routes(
            None,
            vec![
                route("g.example.app", "http://localhost:4000"),
                peer_route("g.example.app", "peer-b", 0),
            ],
            vec![],
        );
        assert!(matches!(result, Err(ConfigError::DuplicatePrefix { .. })));
    }

    #[test]
    fn rejects_an_invalid_prefix() {
        let result = resolve_routes(None, vec![route("g..app", "http://localhost:4000")], vec![]);
        assert!(matches!(result, Err(ConfigError::InvalidAddress { .. })));
    }

    #[test]
    fn rejects_a_non_http_handler_url() {
        let result = resolve_routes(None, vec![route("g.example.app", "not a url")], vec![]);
        assert!(matches!(result, Err(ConfigError::InvalidHandlerUrl { .. })));
    }

    #[test]
    fn rejects_a_non_http_scheme() {
        let result = resolve_routes(
            None,
            vec![route("g.example.app", "ftp://localhost:4000")],
            vec![],
        );
        assert!(matches!(
            result,
            Err(ConfigError::UnsupportedUrlScheme { .. })
        ));
    }

    #[test]
    fn rejects_duplicate_prefixes() {
        let result = resolve_routes(
            None,
            vec![
                route("g.example.app", "http://localhost:4000"),
                route("g.example.app", "http://localhost:5000"),
            ],
            vec![],
        );
        assert!(matches!(result, Err(ConfigError::DuplicatePrefix { .. })));
    }

    #[test]
    fn expands_children_under_the_apex() {
        let (routes, peer_routes) = resolve_routes(
            Some("g.example.connector"),
            vec![],
            vec![child("billing", "http://localhost:4001")],
        )
        .expect("resolve");

        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].prefix(), "g.example.connector.billing");
        assert!(peer_routes.is_empty());
    }

    #[test]
    fn children_without_an_apex_is_a_specific_error() {
        let result = resolve_routes(
            None,
            vec![],
            vec![child("billing", "http://localhost:4001")],
        );
        assert!(matches!(result, Err(ConfigError::MissingApex)));
    }

    #[test]
    fn rejects_a_child_name_with_a_dot() {
        let result = resolve_routes(
            Some("g.example.connector"),
            vec![],
            vec![child("billing.sub", "http://localhost:4001")],
        );
        assert!(matches!(result, Err(ConfigError::InvalidChildName { .. })));
    }

    #[test]
    fn a_child_colliding_with_an_explicit_route_is_a_duplicate() {
        let result = resolve_routes(
            Some("g.example.connector"),
            vec![route(
                "g.example.connector.billing",
                "http://localhost:9000",
            )],
            vec![child("billing", "http://localhost:4001")],
        );
        assert!(matches!(result, Err(ConfigError::DuplicatePrefix { .. })));
    }
}
