//! The `[announce]` section (issue #784): the facts about this node that
//! **no node can introspect about itself**, held so `connector announce`
//! can put them in a kind:10032 `IlpPeerInfo` event.
//!
//! Everything else in an announce is already knowable from inside the
//! process -- the prices come from `[[routes]]`, the settlement contracts
//! from the `[settlement.<chain>]` tables the node verified against a chain
//! at startup, the edge identity from `[signer]`. What is left here is the
//! short list a node behind a TLS terminator genuinely cannot learn:
//!
//!   * its own PUBLIC ILP-over-HTTP and BTP endpoints -- the container sees
//!     `0.0.0.0:4000` and a private docker network, never
//!     `https://proxy.ario.devnet.toonprotocol.dev/ilp`;
//!   * which ILP addresses the announce covers;
//!   * the Nostr relay URL clients should use for **free reads**, if this
//!     node fronts one at all.
//!
//! That last one is the field this module exists to get right. The
//! retired TypeScript builder's own header says the endpoint fields "were
//! always operator overrides, never inferred", and `relay_url` is the
//! sharpest case of it:
//!
//!   * it is **not** the relay this node publishes THROUGH. The through-URL
//!     is a per-invocation CLI argument, and the relay an operator chooses
//!     to be discovered on need not be one they serve reads from. On the
//!     devnet apex the two happen to coincide, and that coincidence is
//!     exactly what would make an inferred value look right until it wasn't;
//!   * it is **not** derivable from `[[routes]]` either. `g.toon.relay`'s
//!     `handler_url` is `http://relay:3100/write` -- the relay's PRIVATE
//!     write ingress on a container network, which is neither public nor a
//!     read surface;
//!   * it is **optional**, and a node that fronts no relay must leave it
//!     out. The devnet store box fronts none: its announce should say so by
//!     omitting the field, not by pointing at somebody else's relay and
//!     claiming reads it does not serve.
//!
//! An `http(s)://` value is therefore refused by name. That spelling is the
//! relay's private write ingress (`packages/announcer/src/publisher.ts`
//! documents the two surfaces), and advertising it for free reads publishes
//! an unauthenticated write door to the whole network.

use serde::Deserialize;

use crate::error::ConfigError;
use crate::route::is_valid_ilp_address;

/// The `[announce]` section exactly as written. `deny_unknown_fields` for
/// the reason every other section has it (issue #542): a mistyped
/// `relay_urls` would otherwise be dropped silently and the node would
/// announce without the field it was configured with.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawAnnounceConfig {
    #[serde(default)]
    addresses: Vec<String>,
    #[serde(default)]
    http_endpoint: Option<String>,
    #[serde(default)]
    btp_endpoint: Option<String>,
    #[serde(default)]
    relay_url: Option<String>,
    #[serde(default)]
    publish_to: Option<String>,
    #[serde(default)]
    route_publish: Option<String>,
    #[serde(default)]
    route_store: Option<String>,
    #[serde(default)]
    asset_code: Option<String>,
    #[serde(default)]
    asset_scale: Option<u8>,
    #[serde(default)]
    solana_chain_id: Option<String>,
    #[serde(default)]
    ttl_secs: Option<u64>,
}

/// `USDC` at 6 decimals is what every route on this fleet is priced in, and
/// what the retired sidecar defaulted to. Restated rather than required so
/// a config that says nothing about assets announces the same thing the
/// sidecar did.
const DEFAULT_ASSET_CODE: &str = "USDC";
const DEFAULT_ASSET_SCALE: u8 = 6;

/// The x402 greeting reports a bare `"solana"` chain -- a Solana backend
/// has no chain id to append, since the program id already names one
/// deployed instance. Core's kind:10032 schema wants a qualified 2-3
/// segment chain id, so an announce re-qualifies it; `solana:devnet` is
/// this fleet's only deployed cluster and the sidecar's own default.
const DEFAULT_SOLANA_CHAIN_ID: &str = "solana:devnet";

/// Twice the sidecar's 300 s refresh, which is what its own `ttlSeconds`
/// defaulted to -- an announce that outlives one missed refresh but not two.
/// A `connector announce` is an operator action rather than a loop, so this
/// is the "until somebody announces again" window and an operator who wants
/// a longer one should write it down.
const DEFAULT_TTL_SECS: u64 = 600;

/// The facts a node cannot introspect about itself, fully validated.
/// Constructed only by [`resolve_announce`], so a value that exists has at
/// least one syntactically valid ILP address (primary first), endpoints
/// whose schemes match what they are for, and -- if it names a `relay_url`
/// at all -- one that is a WebSocket read surface rather than a relay's
/// private write ingress.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnnounceConfig {
    addresses: Vec<String>,
    http_endpoint: String,
    btp_endpoint: String,
    relay_url: Option<String>,
    publish_to: Option<String>,
    route_publish: String,
    route_store: String,
    asset_code: String,
    asset_scale: u8,
    solana_chain_id: String,
    ttl_secs: u64,
}

impl AnnounceConfig {
    /// Every ILP address this announce covers, primary first. Never empty.
    pub fn addresses(&self) -> &[String] {
        &self.addresses
    }

    /// The primary ILP address -- the announce's `ilpAddress`.
    pub fn primary_address(&self) -> &str {
        &self.addresses[0]
    }

    /// Where clients **pay this node** over ILP-over-HTTP. Never inferred:
    /// a node behind TLS termination cannot know its own public name.
    pub fn http_endpoint(&self) -> &str {
        &self.http_endpoint
    }

    /// Where clients **pay this node** over BTP.
    pub fn btp_endpoint(&self) -> &str {
        &self.btp_endpoint
    }

    /// Where clients **read this node's relay for free**, or `None` for a
    /// node that fronts no relay -- in which case the announce omits the
    /// field entirely rather than naming somebody else's.
    pub fn relay_url(&self) -> Option<&str> {
        self.relay_url.as_deref()
    }

    /// The ILP address `connector announce` publishes TO when the command
    /// line does not name one. Not one of the three URLs and deliberately
    /// separate from all of them: it is the address of the route that
    /// terminates at the chosen relay's write ingress (`g.toon.relay` on
    /// this fleet), which is a fact about somebody else's node.
    pub fn publish_to(&self) -> Option<&str> {
        self.publish_to.as_deref()
    }

    /// The address a client should PUBLISH (Nostr writes) to at this node.
    pub fn route_publish(&self) -> &str {
        &self.route_publish
    }

    /// The address a client should STORE (blob uploads) to at this node.
    pub fn route_store(&self) -> &str {
        &self.route_store
    }

    pub fn asset_code(&self) -> &str {
        &self.asset_code
    }

    pub fn asset_scale(&self) -> u8 {
        self.asset_scale
    }

    /// The qualified chain id a bare `"solana"` in the greeting is
    /// re-spelled as for the announce.
    pub fn solana_chain_id(&self) -> &str {
        &self.solana_chain_id
    }

    /// The NIP-40 `expiration` tag's distance from `created_at`, in
    /// seconds. Never zero: an announce with no expiry lingers on every
    /// relay that ever saw it, long after the node it describes is gone.
    pub fn ttl_secs(&self) -> u64 {
        self.ttl_secs
    }
}

/// Derive the publish/store route hints, mirroring the retired sidecar's
/// `deriveRouteHints` suffix heuristic (`.relay` -> publish, `.store` /
/// `.ario` -> store) exactly, with explicit overrides always winning.
///
/// Ported rather than redesigned: this is what every kind:10032 consumer on
/// the network already reads, and a node whose `routes` differ from what the
/// sidecar published for the same addresses would look like a different node
/// to a client that cached the old answer.
fn derive_route_hints(
    addresses: &[String],
    override_publish: Option<String>,
    override_store: Option<String>,
) -> (String, String) {
    let primary = addresses[0].clone();
    let relay = addresses.iter().find(|a| a.ends_with(".relay")).cloned();
    let store = addresses
        .iter()
        .find(|a| a.ends_with(".store"))
        .or_else(|| addresses.iter().find(|a| a.ends_with(".ario")))
        .cloned();

    let mut publish = override_publish.or(relay);
    let mut store_addr = override_store.or(store);

    if publish.is_none() {
        publish = store_addr.as_ref().map(|store| {
            store
                .strip_suffix(".store")
                .map(|stem| format!("{stem}.relay"))
                .unwrap_or_else(|| store.clone())
        });
    }
    if store_addr.is_none() {
        store_addr = publish.as_ref().map(|publish| {
            publish
                .strip_suffix(".relay")
                .map(|stem| format!("{stem}.store"))
                .unwrap_or_else(|| publish.clone())
        });
    }

    (
        publish.unwrap_or_else(|| primary.clone()),
        store_addr.unwrap_or(primary),
    )
}

/// Check one endpoint field's URL against the schemes that field can
/// legitimately name. Every announce endpoint is a value a stranger will
/// dial, so a scheme that names the wrong surface is refused at load
/// rather than broadcast to the network.
fn validate_endpoint(
    field: &'static str,
    value: String,
    allowed: &[&str],
) -> Result<String, ConfigError> {
    let url = url::Url::parse(&value).map_err(|source| ConfigError::AnnounceInvalidUrl {
        field,
        value: value.clone(),
        source,
    })?;
    if !allowed.contains(&url.scheme()) {
        return Err(ConfigError::AnnounceEndpointScheme {
            field,
            value,
            scheme: url.scheme().to_string(),
            allowed: allowed.join(", "),
        });
    }
    Ok(value)
}

/// Validate an optional `[announce]` section. Absence means this node has
/// nothing configured to announce -- `connector announce` refuses by name
/// and the serving path is unaffected, exactly as an absent `[operator]`
/// section means the operator surface is not started at all.
pub(crate) fn resolve_announce(
    raw: Option<RawAnnounceConfig>,
) -> Result<Option<AnnounceConfig>, ConfigError> {
    let Some(raw) = raw else {
        return Ok(None);
    };

    if raw.addresses.is_empty() {
        return Err(ConfigError::AnnounceNoAddresses);
    }
    for address in &raw.addresses {
        if !is_valid_ilp_address(address) {
            return Err(ConfigError::InvalidAddress {
                field: "announce.addresses",
                value: address.clone(),
            });
        }
    }

    // Both endpoints are required rather than defaulted. The sidecar
    // defaulted them (`config.ts`'s `DEFAULT_HTTP_ENDPOINT` /
    // `DEFAULT_BTP_ENDPOINT`) and those compiled-in literals still name
    // `/rust/ilp`, a path that now answers 410 Gone on both devnet boxes --
    // live only because the container overrides them by environment. A
    // default here would reintroduce exactly that: a node that broadcasts a
    // dead URL to the whole network the day somebody drops an env line.
    let http_endpoint = validate_endpoint(
        "http_endpoint",
        raw.http_endpoint
            .ok_or(ConfigError::AnnounceMissingEndpoint {
                field: "http_endpoint",
            })?,
        &["https", "http"],
    )?;
    let btp_endpoint = validate_endpoint(
        "btp_endpoint",
        raw.btp_endpoint
            .ok_or(ConfigError::AnnounceMissingEndpoint {
                field: "btp_endpoint",
            })?,
        &["wss", "ws"],
    )?;
    // `ws`/`wss` ONLY. An `http(s)://` here is the relay's private write
    // ingress, not a read surface -- see this module's header.
    let relay_url = raw
        .relay_url
        .map(|value| validate_endpoint("relay_url", value, &["wss", "ws"]))
        .transpose()?;

    for (field, value) in [
        ("publish_to", raw.publish_to.as_ref()),
        ("route_publish", raw.route_publish.as_ref()),
        ("route_store", raw.route_store.as_ref()),
    ] {
        if let Some(value) = value {
            if !is_valid_ilp_address(value) {
                return Err(ConfigError::InvalidAddress {
                    field,
                    value: value.clone(),
                });
            }
        }
    }

    let (route_publish, route_store) =
        derive_route_hints(&raw.addresses, raw.route_publish, raw.route_store);

    // Zero is refused rather than read as "never expires": a NIP-40 tag of
    // `created_at + 0` is already expired the moment it is signed, so the
    // announce would be dropped by every relay that honours the tag while
    // the file reads as configured. An operator who wants no expiry has to
    // say so by writing a long TTL, which is at least a number somebody
    // chose.
    let ttl_secs = match raw.ttl_secs {
        Some(0) => return Err(ConfigError::AnnounceZeroTtl),
        Some(secs) => secs,
        None => DEFAULT_TTL_SECS,
    };

    Ok(Some(AnnounceConfig {
        addresses: raw.addresses,
        http_endpoint,
        btp_endpoint,
        relay_url,
        publish_to: raw.publish_to,
        route_publish,
        route_store,
        asset_code: raw.asset_code.unwrap_or_else(|| DEFAULT_ASSET_CODE.into()),
        asset_scale: raw.asset_scale.unwrap_or(DEFAULT_ASSET_SCALE),
        solana_chain_id: raw
            .solana_chain_id
            .unwrap_or_else(|| DEFAULT_SOLANA_CHAIN_ID.into()),
        ttl_secs,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(relay_url: Option<&str>) -> RawAnnounceConfig {
        RawAnnounceConfig {
            addresses: vec!["g.toon.ario".to_string()],
            http_endpoint: Some("https://proxy.ario.example/ilp".to_string()),
            btp_endpoint: Some("wss://proxy.ario.example/ilp/btp".to_string()),
            relay_url: relay_url.map(str::to_string),
            publish_to: None,
            route_publish: None,
            route_store: None,
            asset_code: None,
            asset_scale: None,
            solana_chain_id: None,
            ttl_secs: None,
        }
    }

    /// A node that fronts no relay announces without the field. The store
    /// box is exactly this node, and the alternative -- pointing at the
    /// apex's relay -- would advertise reads it does not serve.
    #[test]
    fn a_node_fronting_no_relay_omits_relay_url_entirely() {
        let announce = resolve_announce(Some(raw(None)))
            .expect("load")
            .expect("present");

        assert_eq!(announce.relay_url(), None);
        assert_eq!(announce.primary_address(), "g.toon.ario");
        assert_eq!(announce.ttl_secs(), DEFAULT_TTL_SECS);
        assert_eq!(announce.asset_code(), "USDC");
        assert_eq!(announce.asset_scale(), 6);
    }

    /// The one refusal this module exists for: an `http(s)://` `relay_url`
    /// is the relay's PRIVATE write ingress, and announcing it for free
    /// reads publishes an unauthenticated write door to the network.
    #[test]
    fn an_http_relay_url_is_refused_because_that_spelling_is_the_write_ingress() {
        for written in ["http://relay:3100/write", "https://relay.example/write"] {
            let result = resolve_announce(Some(raw(Some(written))));
            let Err(error) = result else {
                panic!("{written} must not load as a free-read relay URL");
            };
            assert!(matches!(
                error,
                ConfigError::AnnounceEndpointScheme { field, .. }
                    if field == "relay_url"
            ));
            assert!(
                error.to_string().contains("READ it for FREE"),
                "the message must say what the field is for: {error}"
            );
        }
    }

    #[test]
    fn a_wss_relay_url_loads() {
        let announce = resolve_announce(Some(raw(Some("wss://relay.example"))))
            .expect("load")
            .expect("present");
        assert_eq!(announce.relay_url(), Some("wss://relay.example"));
    }

    /// Neither endpoint defaults, unlike the sidecar's -- whose compiled-in
    /// fallbacks still name a `/rust/ilp` prefix that answers 410 Gone.
    #[test]
    fn both_pay_endpoints_are_required_rather_than_defaulted() {
        let mut without_http = raw(None);
        without_http.http_endpoint = None;
        assert!(matches!(
            resolve_announce(Some(without_http)),
            Err(ConfigError::AnnounceMissingEndpoint { field }) if field == "http_endpoint"
        ));

        let mut without_btp = raw(None);
        without_btp.btp_endpoint = None;
        assert!(matches!(
            resolve_announce(Some(without_btp)),
            Err(ConfigError::AnnounceMissingEndpoint { field }) if field == "btp_endpoint"
        ));
    }

    /// A `wss://` in the HTTP slot (or an `https://` in the BTP slot) is
    /// the same class of mistake as the `relay_url` one, and is caught the
    /// same way rather than broadcast.
    #[test]
    fn each_endpoint_field_refuses_the_other_field_s_scheme() {
        let mut swapped = raw(None);
        swapped.http_endpoint = Some("wss://proxy.example/ilp/btp".to_string());
        assert!(matches!(
            resolve_announce(Some(swapped)),
            Err(ConfigError::AnnounceEndpointScheme { field, .. })
                if field == "http_endpoint"
        ));

        let mut swapped = raw(None);
        swapped.btp_endpoint = Some("https://proxy.example/ilp".to_string());
        assert!(matches!(
            resolve_announce(Some(swapped)),
            Err(ConfigError::AnnounceEndpointScheme { field, .. })
                if field == "btp_endpoint"
        ));
    }

    #[test]
    fn an_announce_with_no_addresses_is_refused() {
        let mut empty = raw(None);
        empty.addresses = Vec::new();
        assert!(matches!(
            resolve_announce(Some(empty)),
            Err(ConfigError::AnnounceNoAddresses)
        ));
    }

    #[test]
    fn a_malformed_address_is_refused_by_field_name() {
        let mut bad = raw(None);
        bad.addresses = vec!["g.toon..ario".to_string()];
        assert!(matches!(
            resolve_announce(Some(bad)),
            Err(ConfigError::InvalidAddress { field, .. }) if field == "announce.addresses"
        ));
    }

    #[test]
    fn a_zero_ttl_is_refused_rather_than_read_as_never_expires() {
        let mut zero = raw(None);
        zero.ttl_secs = Some(0);
        assert!(matches!(
            resolve_announce(Some(zero)),
            Err(ConfigError::AnnounceZeroTtl)
        ));
    }

    /// The sidecar's suffix heuristic, ported: `.relay` is where a client
    /// publishes, `.store` is where it uploads, and each is derived from the
    /// other when only one is named.
    #[test]
    fn route_hints_follow_the_sidecars_suffix_heuristic() {
        let cases: [(&[&str], (&str, &str)); 4] = [
            (
                &["g.toon", "g.toon.relay", "g.toon.store"],
                ("g.toon.relay", "g.toon.store"),
            ),
            (&["g.toon.relay"], ("g.toon.relay", "g.toon.store")),
            (&["g.toon.store"], ("g.toon.relay", "g.toon.store")),
            // The store box: one address, no `.relay` anywhere, so both
            // hints fall back to the `.ario` address itself. Announcing
            // somebody else's relay here would be the same mistake as
            // inferring `relay_url`.
            (&["g.toon.ario"], ("g.toon.ario", "g.toon.ario")),
        ];
        for (addresses, (publish, store)) in cases {
            let owned: Vec<String> = addresses.iter().map(|a| a.to_string()).collect();
            assert_eq!(
                derive_route_hints(&owned, None, None),
                (publish.to_string(), store.to_string()),
                "{addresses:?}"
            );
        }
    }

    #[test]
    fn explicit_route_overrides_always_win() {
        let mut overridden = raw(None);
        overridden.route_publish = Some("g.elsewhere.relay".to_string());
        overridden.route_store = Some("g.elsewhere.store".to_string());
        let announce = resolve_announce(Some(overridden))
            .expect("load")
            .expect("present");

        assert_eq!(announce.route_publish(), "g.elsewhere.relay");
        assert_eq!(announce.route_store(), "g.elsewhere.store");
    }
}
