//! The `[node]` section (ADR 0050, issue #1080): the facts about this node
//! that **no node can introspect about itself**.
//!
//! There are exactly three, and the section is named for what they are rather
//! than for a verb. It used to be called `[announce]` and to exist so
//! `connector announce` could put its contents in a kind:10032 `IlpPeerInfo`
//! event; ADR 0046 removed the announce outright (issue #1074) and ADR 0050
//! re-homed what survived. What survived is what a node genuinely cannot
//! learn from inside the process:
//!
//!   * its own PUBLIC ILP-over-HTTP and BTP endpoints -- the container sees
//!     `0.0.0.0:4000` and a private docker network, never
//!     `https://proxy.ario.devnet.toonprotocol.dev/ilp`;
//!   * which ILP addresses it answers to.
//!
//! Everything else a node says about itself is **derived**: the prices come
//! from `[[routes]]`, the settlement facts from the `[settlement.<chain>]`
//! backends that verified them against a chain at startup, the edge identity
//! from `[signer]`. Deriving them rather than declaring them is not tidiness.
//! `[announce].solana_chain_id` was a second declaration of a fact the Solana
//! backend already held, it defaulted to `solana:devnet`, nothing compared the
//! two, and a mainnet node therefore described itself as devnet (issue #981).
//! One authoritative document, projected from the backends, is what makes that
//! class of bug unreachable rather than merely detected (CF-26, ND-07).
//!
//! # What was removed, and why each key is still parsed
//!
//! `publish_to`, `publish_btp_url`, `pay_channel`, `relay_url`, `ttl_secs`,
//! `identity_key_file`, `route_publish`, `route_store`, `asset_code`,
//! `asset_scale`, `solana_chain_id` and the four `notice_*` fields all died
//! with the announce. Each is still **parsed, solely to be refused by name**
//! (ADR 0009, and the `peer_wire_addr`/`ceiling`/`[peer_sale]` precedent): the
//! devnet boxes bind-mount configs that lead the repo copies, so the message
//! that matters is the one an operator reads at 3am. A removed key never
//! silently drops.
//!
//! `relay_url` is the one worth naming twice. It asserted that a Nostr relay
//! for free reads sat behind this node -- an **application** fact, and the last
//! place ADR 0046's removed relay assumption survived. A connector is a paid
//! reverse proxy; what runs behind it is the app's business and the operator
//! advertises it elsewhere (ND-08).

use serde::Deserialize;

use crate::error::ConfigError;
use crate::peer::{PeerCarriage, PeerExposure};
use crate::route::is_valid_ilp_address;

/// The `[node]` section exactly as written. `deny_unknown_fields` for the
/// reason every other section has it (issue #542): a mistyped `addressess`
/// would otherwise be dropped silently and the node would describe itself
/// without the addresses it was configured with.
///
/// The tombstoned keys are `toml::Value` rather than their old types on
/// purpose: `ttl_secs = "600"` is still the removed key, and must be named as
/// such rather than reported as a type error about a field that no longer
/// means anything.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawNodeConfig {
    #[serde(default)]
    addresses: Vec<String>,
    #[serde(default)]
    http_endpoint: Option<String>,
    #[serde(default)]
    btp_endpoint: Option<String>,

    // ── removed with the announce (ADR 0046, issue #1074) ────────────────
    #[serde(default)]
    relay_url: Option<toml::Value>,
    #[serde(default)]
    publish_to: Option<toml::Value>,
    #[serde(default)]
    publish_btp_url: Option<toml::Value>,
    #[serde(default)]
    pay_channel: Option<toml::Value>,
    #[serde(default)]
    route_publish: Option<toml::Value>,
    #[serde(default)]
    route_store: Option<toml::Value>,
    #[serde(default)]
    asset_code: Option<toml::Value>,
    #[serde(default)]
    asset_scale: Option<toml::Value>,
    #[serde(default)]
    solana_chain_id: Option<toml::Value>,
    #[serde(default)]
    ttl_secs: Option<toml::Value>,
    #[serde(default)]
    identity_key_file: Option<toml::Value>,
    #[serde(default)]
    notice_id: Option<toml::Value>,
    #[serde(default)]
    notice_severity: Option<toml::Value>,
    #[serde(default)]
    notice_summary: Option<toml::Value>,
    #[serde(default)]
    notice_url: Option<toml::Value>,
}

/// The facts a node cannot introspect about itself, fully validated.
/// Constructed only by [`resolve_node`], so a value that exists has at least
/// one syntactically valid ILP address (primary first), and each endpoint
/// that is present has a scheme that matches what it is for.
///
/// An endpoint is present **exactly when `peer_expose` exposes that
/// carriage** (issue #1220's owner decision): a node that opens no BTP peer
/// listener has no `btp_endpoint` to publish, and one that opens no HTTP peer
/// listener has no `http_endpoint`. `[node]` may still be `Some` with both
/// endpoints absent -- `peer_expose = "neither"` and an address list is a
/// legitimate, if unpeerable, self-description.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeConfig {
    addresses: Vec<String>,
    http_endpoint: Option<String>,
    btp_endpoint: Option<String>,
}

impl NodeConfig {
    /// Every ILP address this node answers to, primary first. Never empty.
    pub fn addresses(&self) -> &[String] {
        &self.addresses
    }

    /// The primary ILP address.
    pub fn primary_address(&self) -> &str {
        &self.addresses[0]
    }

    /// Where clients **pay this node** over ILP-over-HTTP. `None` unless
    /// `peer_expose` includes `"http"`.
    pub fn http_endpoint(&self) -> Option<&str> {
        self.http_endpoint.as_deref()
    }

    /// Where clients **pay this node** over BTP. `None` unless `peer_expose`
    /// includes `"btp"`.
    pub fn btp_endpoint(&self) -> Option<&str> {
        self.btp_endpoint.as_deref()
    }
}

/// Check one endpoint field's URL against the schemes that field can
/// legitimately name. Every one of these is a value a stranger will dial, so a
/// scheme naming the wrong surface is refused at load rather than published.
fn validate_endpoint(
    field: &'static str,
    value: String,
    allowed: &[&str],
) -> Result<String, ConfigError> {
    let url = url::Url::parse(&value).map_err(|source| ConfigError::NodeInvalidUrl {
        field,
        value: value.clone(),
        source,
    })?;
    if !allowed.contains(&url.scheme()) {
        return Err(ConfigError::NodeEndpointScheme {
            field,
            value,
            scheme: url.scheme().to_string(),
            allowed: allowed.join(", "),
        });
    }
    Ok(value)
}

/// Resolve one endpoint field against whether `peer_expose` exposes the
/// carriage it names (issue #1220). A carriage this node opens a listener
/// for must publish where it lives; a carriage it does not is refused a
/// published endpoint by name, rather than silently carrying a URL nobody
/// serves (ADR 0050's no-default rule, extended to no-orphan-either).
fn resolve_endpoint(
    carriage: PeerCarriage,
    field: &'static str,
    value: Option<String>,
    peer_expose: PeerExposure,
    allowed_schemes: &[&str],
) -> Result<Option<String>, ConfigError> {
    let exposed = peer_expose.exposes(carriage);
    match (value, exposed) {
        (Some(_), false) => Err(ConfigError::NodeEndpointNotExposed {
            field,
            peer_expose: peer_expose.name(),
        }),
        (Some(value), true) => Ok(Some(validate_endpoint(field, value, allowed_schemes)?)),
        (None, true) => Err(ConfigError::NodeMissingEndpoint {
            field,
            peer_expose: peer_expose.name(),
        }),
        (None, false) => Ok(None),
    }
}

/// Validate an optional `[node]` section against the carriages
/// `peer_expose` opens a listener for. Absence of the whole section means
/// this node was told none of the three facts it cannot introspect: it
/// still serves, and its self-description simply omits them, exactly as an
/// absent `[operator]` section means the operator surface is not started.
pub(crate) fn resolve_node(
    raw: Option<RawNodeConfig>,
    peer_expose: PeerExposure,
) -> Result<Option<NodeConfig>, ConfigError> {
    let Some(raw) = raw else {
        return Ok(None);
    };

    // Refused by name, before anything else in the section is judged: an
    // operator whose file still writes one of these is an operator whose file
    // believes it decides something, and the fastest useful answer is which
    // key is gone.
    for (field, present) in [
        ("relay_url", raw.relay_url.is_some()),
        ("publish_to", raw.publish_to.is_some()),
        ("publish_btp_url", raw.publish_btp_url.is_some()),
        ("pay_channel", raw.pay_channel.is_some()),
        ("route_publish", raw.route_publish.is_some()),
        ("route_store", raw.route_store.is_some()),
        ("asset_code", raw.asset_code.is_some()),
        ("asset_scale", raw.asset_scale.is_some()),
        ("solana_chain_id", raw.solana_chain_id.is_some()),
        ("ttl_secs", raw.ttl_secs.is_some()),
        ("identity_key_file", raw.identity_key_file.is_some()),
        ("notice_id", raw.notice_id.is_some()),
        ("notice_severity", raw.notice_severity.is_some()),
        ("notice_summary", raw.notice_summary.is_some()),
        ("notice_url", raw.notice_url.is_some()),
    ] {
        if present {
            return Err(ConfigError::AnnounceKeyRemoved { field });
        }
    }

    if raw.addresses.is_empty() {
        return Err(ConfigError::NodeNoAddresses);
    }
    for address in &raw.addresses {
        if !is_valid_ilp_address(address) {
            return Err(ConfigError::InvalidAddress {
                field: "node.addresses",
                value: address.clone(),
            });
        }
    }

    // Neither endpoint is ever defaulted. The retired sidecar defaulted them
    // and those compiled-in literals still named `/rust/ilp`, a path that
    // answers 410 Gone on both devnet boxes. A default here would reintroduce
    // exactly that: a node publishing a dead URL to whoever asks, the day
    // somebody drops an env line. Which endpoints are even LEGAL to declare
    // is `peer_expose`'s call, not this section's own -- required exactly
    // when the carriage is exposed, refused by name otherwise (issue #1220).
    let http_endpoint = resolve_endpoint(
        PeerCarriage::Http,
        "http_endpoint",
        raw.http_endpoint,
        peer_expose,
        &["https", "http"],
    )?;
    let btp_endpoint = resolve_endpoint(
        PeerCarriage::Btp,
        "btp_endpoint",
        raw.btp_endpoint,
        peer_expose,
        &["wss", "ws"],
    )?;

    Ok(Some(NodeConfig {
        addresses: raw.addresses,
        http_endpoint,
        btp_endpoint,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw() -> RawNodeConfig {
        RawNodeConfig {
            addresses: vec!["g.toon.ario".to_string()],
            http_endpoint: Some("https://proxy.ario.example/ilp".to_string()),
            btp_endpoint: Some("wss://proxy.ario.example/ilp/btp".to_string()),
            relay_url: None,
            publish_to: None,
            publish_btp_url: None,
            pay_channel: None,
            route_publish: None,
            route_store: None,
            asset_code: None,
            asset_scale: None,
            solana_chain_id: None,
            ttl_secs: None,
            identity_key_file: None,
            notice_id: None,
            notice_severity: None,
            notice_summary: None,
            notice_url: None,
        }
    }

    #[test]
    fn the_three_surviving_fields_load() {
        let node = resolve_node(Some(raw()), PeerExposure::Both)
            .expect("load")
            .expect("present");

        assert_eq!(node.addresses(), ["g.toon.ario".to_string()]);
        assert_eq!(node.primary_address(), "g.toon.ario");
        assert_eq!(node.http_endpoint(), Some("https://proxy.ario.example/ilp"));
        assert_eq!(
            node.btp_endpoint(),
            Some("wss://proxy.ario.example/ilp/btp")
        );
    }

    /// Neither endpoint defaults, unlike the retired sidecar's -- whose
    /// compiled-in fallbacks still name a `/rust/ilp` prefix that answers 410.
    /// Exercised with `peer_expose = "both"` so a missing endpoint is the
    /// only thing wrong -- the exposed-but-undeclared case, not the
    /// unexposed-but-declared one below.
    #[test]
    fn an_exposed_carriage_with_no_endpoint_is_refused_naming_it() {
        let mut without_http = raw();
        without_http.http_endpoint = None;
        assert!(matches!(
            resolve_node(Some(without_http), PeerExposure::Both),
            Err(ConfigError::NodeMissingEndpoint { field, peer_expose })
                if field == "http_endpoint" && peer_expose == "both"
        ));

        let mut without_btp = raw();
        without_btp.btp_endpoint = None;
        assert!(matches!(
            resolve_node(Some(without_btp), PeerExposure::Both),
            Err(ConfigError::NodeMissingEndpoint { field, peer_expose })
                if field == "btp_endpoint" && peer_expose == "both"
        ));
    }

    /// The other half of issue #1220's rule: a carriage `peer_expose` does
    /// NOT open a listener for gets no endpoint published for it either,
    /// even though the value itself would otherwise be a perfectly valid
    /// URL -- a node with `peer_expose = "http"` has nothing to dial its
    /// BTP endpoint over, so publishing one is a URL nobody serves.
    #[test]
    fn an_unexposed_carriage_with_an_endpoint_is_refused_naming_it() {
        assert!(matches!(
            resolve_node(Some(raw()), PeerExposure::Http),
            Err(ConfigError::NodeEndpointNotExposed { field, peer_expose })
                if field == "btp_endpoint" && peer_expose == "http"
        ));
        assert!(matches!(
            resolve_node(Some(raw()), PeerExposure::Btp),
            Err(ConfigError::NodeEndpointNotExposed { field, peer_expose })
                if field == "http_endpoint" && peer_expose == "btp"
        ));

        let mut both_but_neither_exposed = raw();
        both_but_neither_exposed.http_endpoint = None;
        assert!(matches!(
            resolve_node(Some(both_but_neither_exposed), PeerExposure::Neither),
            Err(ConfigError::NodeEndpointNotExposed { field, peer_expose })
                if field == "btp_endpoint" && peer_expose == "neither"
        ));
    }

    /// The two carriages resolve independently: an HTTP-only node (issue
    /// #1220's motivating case) publishes exactly `http_endpoint`, and its
    /// `btp_endpoint` is simply absent -- not an error, not a default.
    #[test]
    fn an_http_only_node_publishes_only_its_http_endpoint() {
        let mut http_only = raw();
        http_only.btp_endpoint = None;
        let node = resolve_node(Some(http_only), PeerExposure::Http)
            .expect("load")
            .expect("present");

        assert_eq!(node.http_endpoint(), Some("https://proxy.ario.example/ilp"));
        assert_eq!(node.btp_endpoint(), None);
    }

    /// `peer_expose = "neither"` (the default) is the NAT'd operator: a
    /// `[node]` section may still exist, for the addresses alone, with
    /// both endpoints simply absent.
    #[test]
    fn a_node_exposing_neither_carriage_may_omit_both_endpoints() {
        let mut neither = raw();
        neither.http_endpoint = None;
        neither.btp_endpoint = None;
        let node = resolve_node(Some(neither), PeerExposure::Neither)
            .expect("load")
            .expect("present");

        assert_eq!(node.http_endpoint(), None);
        assert_eq!(node.btp_endpoint(), None);
    }

    /// A `wss://` in the HTTP slot -- or an `https://` in the BTP slot -- is
    /// caught at load rather than handed to whoever asks for this node's
    /// description. Checked once both carriages are exposed, so the scheme
    /// is the only thing wrong with either field.
    #[test]
    fn each_endpoint_field_refuses_the_other_field_s_scheme() {
        let mut swapped = raw();
        swapped.http_endpoint = Some("wss://proxy.example/ilp/btp".to_string());
        assert!(matches!(
            resolve_node(Some(swapped), PeerExposure::Both),
            Err(ConfigError::NodeEndpointScheme { field, .. }) if field == "http_endpoint"
        ));

        let mut swapped = raw();
        swapped.btp_endpoint = Some("https://proxy.example/ilp".to_string());
        assert!(matches!(
            resolve_node(Some(swapped), PeerExposure::Both),
            Err(ConfigError::NodeEndpointScheme { field, .. }) if field == "btp_endpoint"
        ));
    }

    #[test]
    fn a_node_section_with_no_addresses_is_refused() {
        let mut empty = raw();
        empty.addresses = Vec::new();
        assert!(matches!(
            resolve_node(Some(empty), PeerExposure::Both),
            Err(ConfigError::NodeNoAddresses)
        ));
    }

    #[test]
    fn a_malformed_address_is_refused_by_field_name() {
        let mut bad = raw();
        bad.addresses = vec!["g.toon..ario".to_string()];
        assert!(matches!(
            resolve_node(Some(bad), PeerExposure::Both),
            Err(ConfigError::InvalidAddress { field, .. }) if field == "node.addresses"
        ));
    }

    /// Writes one removed key into an otherwise valid raw section, so the
    /// table below can pair each key's name with the act of setting it.
    type WriteRemovedKey = fn(&mut RawNodeConfig);

    /// Every announce-only key is refused **by name**. A file that still
    /// writes one is a file whose author believes it decides something, and
    /// silently dropping it is how a node ends up describing itself with a
    /// field its operator thinks is set (ADR 0009).
    #[test]
    fn every_announce_only_key_is_refused_by_name() {
        let removed: [(&str, WriteRemovedKey); 15] = [
            ("relay_url", |raw| {
                raw.relay_url = Some(toml::Value::String("wss://relay.example".into()))
            }),
            ("publish_to", |raw| {
                raw.publish_to = Some(toml::Value::String("g.toon.relay".into()))
            }),
            ("publish_btp_url", |raw| {
                raw.publish_btp_url =
                    Some(toml::Value::String("wss://relay.example/ilp/btp".into()))
            }),
            ("pay_channel", |raw| {
                raw.pay_channel = Some(toml::Value::String("ab".repeat(32)))
            }),
            ("route_publish", |raw| {
                raw.route_publish = Some(toml::Value::String("g.toon.relay".into()))
            }),
            ("route_store", |raw| {
                raw.route_store = Some(toml::Value::String("g.toon.store".into()))
            }),
            ("asset_code", |raw| {
                raw.asset_code = Some(toml::Value::String("USDC".into()))
            }),
            ("asset_scale", |raw| {
                raw.asset_scale = Some(toml::Value::Integer(6))
            }),
            ("solana_chain_id", |raw| {
                raw.solana_chain_id = Some(toml::Value::String("solana:devnet".into()))
            }),
            ("ttl_secs", |raw| {
                raw.ttl_secs = Some(toml::Value::Integer(600))
            }),
            ("identity_key_file", |raw| {
                raw.identity_key_file = Some(toml::Value::String("announce.key".into()))
            }),
            ("notice_id", |raw| {
                raw.notice_id = Some(toml::Value::String("id".into()))
            }),
            ("notice_severity", |raw| {
                raw.notice_severity = Some(toml::Value::String("info".into()))
            }),
            ("notice_summary", |raw| {
                raw.notice_summary = Some(toml::Value::String("summary".into()))
            }),
            ("notice_url", |raw| {
                raw.notice_url = Some(toml::Value::String("https://example.com".into()))
            }),
        ];

        for (name, set) in removed {
            let mut written = raw();
            set(&mut written);
            let error = resolve_node(Some(written), PeerExposure::Both).expect_err(name);
            assert!(
                matches!(error, ConfigError::AnnounceKeyRemoved { field } if field == name),
                "{name} must be refused by its own name, got: {error}"
            );
        }
    }

    /// A removed key of the wrong TOML *type* is still the removed key -- the
    /// reason each is `toml::Value` rather than its old type, which would have
    /// surfaced "invalid type" instead of naming the key that is gone.
    #[test]
    fn a_removed_key_of_any_toml_type_is_still_named() {
        let mut written = raw();
        written.ttl_secs = Some(toml::Value::String("600".into()));

        assert!(matches!(
            resolve_node(Some(written), PeerExposure::Both),
            Err(ConfigError::AnnounceKeyRemoved { field }) if field == "ttl_secs"
        ));
    }

    /// The removed keys are refused before the section's own validity is
    /// judged, so an operator migrating a stale `[announce]` block is told
    /// which key died rather than which address is missing.
    #[test]
    fn a_removed_key_is_named_even_when_the_rest_of_the_section_is_invalid() {
        let mut written = raw();
        written.addresses = Vec::new();
        written.relay_url = Some(toml::Value::String("wss://relay.example".into()));

        assert!(matches!(
            resolve_node(Some(written), PeerExposure::Both),
            Err(ConfigError::AnnounceKeyRemoved { field }) if field == "relay_url"
        ));
    }
}
