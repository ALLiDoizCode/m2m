use std::net::SocketAddr;
use std::path::Path;

use serde::Deserialize;

use crate::client_channel::{resolve_client_channels, ClientChannelConfig, RawClientChannel};
use crate::error::ConfigError;
use crate::operator::{resolve_operator, OperatorConfig, RawOperatorConfig};
use crate::peer::{resolve_peers, PeerConfig, RawPeer};
use crate::route::{resolve_routes, PeerRouteConfig, RawChild, RawRoute, StaticRoute};
use crate::secret::{RawSignerConfig, SecretLocation};
use crate::settlement::{resolve_settlement, RawSettlementConfig, SettlementConfig};

/// The config file's shape exactly as written -- convenience forms
/// (`children`) intact, nothing yet validated. `deny_unknown_fields`
/// (issue #542): an unrecognized top-level key -- a typo, or a section
/// this connector doesn't understand -- fails config load loudly instead
/// of being parsed, silently dropped, and the node starting as if it had
/// never been written.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    client_edge_addr: String,
    signer: RawSignerConfig,
    #[serde(default)]
    apex: Option<String>,
    #[serde(default)]
    routes: Vec<RawRoute>,
    #[serde(default)]
    children: Vec<RawChild>,
    #[serde(default)]
    operator: Option<RawOperatorConfig>,
    /// Bind address for the accepting side of the peer wire (issue #488).
    /// Absent means this node never accepts an inbound peer connection --
    /// same "not started at all" degradation as an absent `[operator]`.
    #[serde(default)]
    peer_wire_addr: Option<String>,
    /// Peers this node dials out to (issue #488). Peer addressing was
    /// deferred at #416 ("still constructed directly in tests") until a
    /// ticket actually needed it end to end; this is that ticket.
    #[serde(default)]
    peers: Vec<RawPeer>,
    /// A real settlement backend to construct at startup (issue #542).
    /// Absent means channel operations keep degrading to
    /// `ChannelOperationError::NoSettlementBackend`, same as before this
    /// section existed.
    #[serde(default)]
    settlement: Option<RawSettlementConfig>,
    /// The payment channels this node accepts client-edge claims on, and
    /// the counterparty whose signature it accepts on each (issue #558).
    /// Absent -- or empty -- means this node has a record of no channel,
    /// so every claim presented at its client edge is refused as unknown.
    #[serde(default)]
    client_channels: Vec<RawClientChannel>,
}

/// A fully loaded, fully validated, immutable connector configuration.
///
/// The only way to obtain one is [`Config::load`]: every field has already
/// been checked for presence, range and cross-field consistency (ADR 0009),
/// and convenience forms (`children`) have already been desugared into
/// ordinary [`StaticRoute`]s. Downstream code should never re-check a
/// [`Config`] value -- if it loaded, it is valid for the rest of the
/// process's life.
#[derive(Debug, Clone)]
pub struct Config {
    client_edge_addr: SocketAddr,
    signer_key: SecretLocation,
    routes: Vec<StaticRoute>,
    peer_routes: Vec<PeerRouteConfig>,
    peers: Vec<PeerConfig>,
    peer_wire_addr: Option<SocketAddr>,
    operator: Option<OperatorConfig>,
    settlement: Option<SettlementConfig>,
    client_channels: Vec<ClientChannelConfig>,
}

impl Config {
    /// Read, parse and fully validate the configuration file at `path`.
    ///
    /// This is the only startup work that may fail before the node runs:
    /// per ADR 0009, an `Err` here must stop the process before anything
    /// else starts, and an `Ok` value needs no further validation anywhere
    /// downstream.
    pub fn load(path: &Path) -> Result<Config, ConfigError> {
        let text = std::fs::read_to_string(path).map_err(|source| ConfigError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        Self::from_toml_str(&text, path)
    }

    fn from_toml_str(text: &str, path: &Path) -> Result<Config, ConfigError> {
        let raw: RawConfig = toml::from_str(text).map_err(|source| ConfigError::Parse {
            path: path.to_path_buf(),
            source: Box::new(source),
        })?;

        let client_edge_addr = raw
            .client_edge_addr
            .parse::<SocketAddr>()
            .map_err(|source| ConfigError::InvalidBindAddr {
                value: raw.client_edge_addr.clone(),
                source,
            })?;

        let signer_key = SecretLocation::resolve(raw.signer)?;
        let (routes, peer_routes) = resolve_routes(raw.apex.as_deref(), raw.routes, raw.children)?;
        let peers = resolve_peers(raw.peers)?;
        for peer_route in &peer_routes {
            if !peers.iter().any(|peer| peer.id() == peer_route.peer_id()) {
                return Err(ConfigError::UnknownPeerId {
                    prefix: peer_route.prefix().to_string(),
                    peer_id: peer_route.peer_id().to_string(),
                });
            }
        }
        let peer_wire_addr = raw
            .peer_wire_addr
            .map(|value| {
                value
                    .parse::<SocketAddr>()
                    .map_err(|source| ConfigError::InvalidPeerWireAddr { value, source })
            })
            .transpose()?;
        let operator = resolve_operator(raw.operator)?;
        let settlement = resolve_settlement(raw.settlement)?;
        let client_channels = resolve_client_channels(raw.client_channels)?;

        Ok(Config {
            client_edge_addr,
            signer_key,
            routes,
            peer_routes,
            peers,
            peer_wire_addr,
            operator,
            settlement,
            client_channels,
        })
    }

    /// The socket address the client edge binds.
    pub fn client_edge_addr(&self) -> SocketAddr {
        self.client_edge_addr
    }

    /// Where this node's signing key material lives.
    pub fn signer_key(&self) -> &SecretLocation {
        &self.signer_key
    }

    /// The node's static routes -- explicit `[[routes]]` entries plus every
    /// `[[children]]` entry already expanded under `apex`.
    pub fn routes(&self) -> &[StaticRoute] {
        &self.routes
    }

    /// The node's peer routes -- every `[[routes]]` entry that names a
    /// `peer_id` instead of a `handler_url`. Each one's `peer_id` is
    /// guaranteed to name an entry in [`Config::peers`] (`Config::load`
    /// refuses to return a value where it doesn't).
    pub fn peer_routes(&self) -> &[PeerRouteConfig] {
        &self.peer_routes
    }

    /// The peers this node dials out to.
    pub fn peers(&self) -> &[PeerConfig] {
        &self.peers
    }

    /// The bind address for the accepting side of the peer wire, if this
    /// node accepts inbound peer connections at all. `None` means the peer
    /// wire server is not started -- same "not started at all" degradation
    /// as an absent `[operator]` section.
    pub fn peer_wire_addr(&self) -> Option<SocketAddr> {
        self.peer_wire_addr
    }

    /// The operator surface's authentication, if the surface is enabled.
    /// `None` means the `[operator]` section was absent -- the surface is
    /// not started at all. A `Some` value is always fully authenticated
    /// (ADR 0008): [`Config::load`] refuses to return one that is missing
    /// a bearer token or a write-key allowlist.
    pub fn operator(&self) -> Option<&OperatorConfig> {
        self.operator.as_ref()
    }

    /// A configured settlement backend, if the `[settlement]` section is
    /// present (issue #542). `None` means no backend is constructed at
    /// startup and every channel operation answers
    /// `ChannelOperationError::NoSettlementBackend` -- the same "not
    /// started at all" degradation an absent `[operator]` section already
    /// has.
    pub fn settlement(&self) -> Option<&SettlementConfig> {
        self.settlement.as_ref()
    }

    /// The payment channels this node accepts client-edge claims on, and
    /// the counterparty whose signature it accepts on each (issue #558).
    /// Empty means this node has a record of no channel at all, so every
    /// claim presented at its client edge is refused as unknown rather
    /// than trusted about who signed it.
    pub fn client_channels(&self) -> &[ClientChannelConfig] {
        &self.client_channels
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    fn with_key_file(body: impl FnOnce(&Path) -> String) -> Result<Config, ConfigError> {
        let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
        key_file
            .write_all(b"not a real key")
            .expect("write key file");
        let text = body(key_file.path());
        Config::from_toml_str(&text, Path::new("test.toml"))
    }

    #[test]
    fn loads_a_minimal_valid_config() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"
"#,
                key_path.display()
            )
        })
        .expect("load");

        assert_eq!(
            config.client_edge_addr(),
            "127.0.0.1:3000".parse::<SocketAddr>().unwrap()
        );
        assert_eq!(config.routes().len(), 0);
    }

    #[test]
    fn loads_routes_and_expanded_children() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
apex = "g.example.connector"

[signer]
key_file = "{}"

[[routes]]
prefix = "g.example.other"
handler_url = "http://localhost:5000"
price = 25

[[children]]
name = "billing"
handler_url = "http://localhost:4000"
price = 0
"#,
                key_path.display()
            )
        })
        .expect("load");

        let prefixes: Vec<&str> = config.routes().iter().map(|r| r.prefix()).collect();
        assert_eq!(
            prefixes,
            vec!["g.example.other", "g.example.connector.billing"]
        );
        let prices: Vec<u64> = config.routes().iter().map(|r| r.price()).collect();
        assert_eq!(prices, vec![25, 0]);
    }

    #[test]
    fn rejects_a_terminated_route_with_no_price() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[[routes]]
prefix = "g.example.other"
handler_url = "http://localhost:5000"
"#,
                key_path.display()
            )
        });

        assert!(matches!(result, Err(ConfigError::RouteMissingPrice { .. })));
    }

    #[test]
    fn loads_peers_and_peer_routes() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
peer_wire_addr = "127.0.0.1:4001"

[signer]
key_file = "{}"

[[peers]]
id = "peer-b"
addr = "127.0.0.1:5000"

[[routes]]
prefix = "g.peer-b"
peer_id = "peer-b"
fee = 3
"#,
                key_path.display()
            )
        })
        .expect("load");

        assert_eq!(
            config.peer_wire_addr(),
            Some("127.0.0.1:4001".parse().unwrap())
        );
        assert_eq!(config.peers().len(), 1);
        assert_eq!(config.peers()[0].id(), "peer-b");
        assert_eq!(config.peers()[0].addr(), "127.0.0.1:5000".parse().unwrap());
        assert_eq!(config.peer_routes().len(), 1);
        assert_eq!(config.peer_routes()[0].prefix(), "g.peer-b");
        assert_eq!(config.peer_routes()[0].peer_id(), "peer-b");
        assert_eq!(config.peer_routes()[0].fee(), 3);
    }

    #[test]
    fn a_config_with_no_peer_wire_addr_or_peers_has_none_and_empty() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"
"#,
                key_path.display()
            )
        })
        .expect("load");

        assert_eq!(config.peer_wire_addr(), None);
        assert!(config.peers().is_empty());
        assert!(config.peer_routes().is_empty());
    }

    #[test]
    fn rejects_a_peer_route_naming_an_unconfigured_peer_id() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[[routes]]
prefix = "g.peer-b"
peer_id = "peer-b"
"#,
                key_path.display()
            )
        });

        assert!(matches!(result, Err(ConfigError::UnknownPeerId { .. })));
    }

    #[test]
    fn rejects_an_invalid_peer_wire_addr() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
peer_wire_addr = "not-an-address"

[signer]
key_file = "{}"
"#,
                key_path.display()
            )
        });

        assert!(matches!(
            result,
            Err(ConfigError::InvalidPeerWireAddr { .. })
        ));
    }

    #[test]
    fn rejects_a_duplicate_peer_id() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[[peers]]
id = "peer-b"
addr = "127.0.0.1:5000"

[[peers]]
id = "peer-b"
addr = "127.0.0.1:5001"
"#,
                key_path.display()
            )
        });

        assert!(matches!(result, Err(ConfigError::DuplicatePeerId { .. })));
    }

    #[test]
    fn loads_a_kms_signer_location() {
        let config = Config::from_toml_str(
            r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
kms_key_id = "arn:aws:kms:us-east-1:123:key/abc"
"#,
            Path::new("test.toml"),
        )
        .expect("load");

        assert_eq!(
            config.signer_key(),
            &SecretLocation::Kms {
                key_id: "arn:aws:kms:us-east-1:123:key/abc".to_string()
            }
        );
    }

    #[test]
    fn rejects_malformed_toml() {
        let result = Config::from_toml_str("this is not { valid toml", Path::new("test.toml"));
        assert!(matches!(result, Err(ConfigError::Parse { .. })));
    }

    #[test]
    fn rejects_an_invalid_bind_address() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "not-an-address"

[signer]
key_file = "{}"
"#,
                key_path.display()
            )
        });
        assert!(matches!(result, Err(ConfigError::InvalidBindAddr { .. })));
    }

    #[test]
    fn rejects_a_missing_signer_key_file() {
        let result = Config::from_toml_str(
            r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "/nonexistent/does-not-exist.key"
"#,
            Path::new("test.toml"),
        );
        assert!(matches!(result, Err(ConfigError::SignerKeyFileNotFound(_))));
    }

    #[test]
    fn load_reports_the_path_on_a_missing_file() {
        let result = Config::load(&PathBuf::from("/nonexistent/connector.toml"));
        assert!(matches!(result, Err(ConfigError::Io { .. })));
    }

    #[test]
    fn a_config_with_no_operator_section_has_no_operator_config() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"
"#,
                key_path.display()
            )
        })
        .expect("load");

        assert_eq!(config.operator(), None);
    }

    #[test]
    fn a_fully_configured_operator_section_loads() {
        let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[operator]
bearer_token = "secret-token"
write_keys = ["{key}"]
"#,
                key_path.display()
            )
        })
        .expect("load");

        let operator = config.operator().expect("operator config");
        assert_eq!(operator.bearer_token(), "secret-token");
        assert_eq!(operator.write_keys().len(), 1);
    }

    #[test]
    fn refuses_to_start_when_the_operator_surface_is_enabled_without_write_keys() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[operator]
bearer_token = "secret-token"
"#,
                key_path.display()
            )
        });

        assert!(matches!(result, Err(ConfigError::OperatorNoWriteKeys)));
    }

    #[test]
    fn refuses_to_start_when_the_operator_surface_is_enabled_without_a_bearer_token() {
        let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[operator]
write_keys = ["{key}"]
"#,
                key_path.display()
            )
        });

        assert!(matches!(
            result,
            Err(ConfigError::OperatorMissingBearerToken)
        ));
    }

    #[test]
    fn a_config_with_no_settlement_section_has_no_settlement_config() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"
"#,
                key_path.display()
            )
        })
        .expect("load");

        assert_eq!(config.settlement(), None);
    }

    #[test]
    fn a_fully_configured_settlement_section_loads() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[settlement]
chain = "evm"
rpc_url = "http://127.0.0.1:8545"
contract_address = "0x1234567890123456789012345678901234567890"
token_address = "0x49beE1Bca5d15Fb0963117923403F9498119a9Ce"
decimals = 6

[settlement.key]
key_file = "{}"
"#,
                key_path.display(),
                key_path.display()
            )
        })
        .expect("load");

        let settlement = config.settlement().expect("settlement config");
        assert_eq!(settlement.chain(), crate::SettlementChain::Evm);
        assert_eq!(settlement.rpc_url(), "http://127.0.0.1:8545");
        assert_eq!(settlement.decimals(), 6);
    }

    #[test]
    fn a_settlement_section_that_cannot_be_satisfied_refuses_to_load() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[settlement]
chain = "made-up-chain"
rpc_url = "http://127.0.0.1:8545"
contract_address = "0x1234567890123456789012345678901234567890"
token_address = "0x49beE1Bca5d15Fb0963117923403F9498119a9Ce"
decimals = 6

[settlement.key]
key_file = "{}"
"#,
                key_path.display(),
                key_path.display()
            )
        });

        assert!(matches!(
            result,
            Err(ConfigError::SettlementUnknownChain { .. })
        ));
    }

    #[test]
    fn an_unknown_top_level_key_is_rejected_rather_than_silently_ignored() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
made_up_top_level_field = "oops"

[signer]
key_file = "{}"
"#,
                key_path.display()
            )
        });

        assert!(matches!(result, Err(ConfigError::Parse { .. })));
    }

    /// Issue #556's parse-layer spine: `deny_unknown_fields` on
    /// `RawConfig` alone only guards the top level. A typo *inside* a
    /// section was still parsed, dropped, and the node started as if the
    /// key had never been written -- so a misspelled `bearer_tokn` read as
    /// an unauthenticated operator surface and a misspelled `key_fle` read
    /// as a signer with no location at all. Each of these now fails at the
    /// parse stage, and the message names the offending key.
    fn assert_names_the_unknown_key(result: Result<Config, ConfigError>, key: &str) {
        let Err(ConfigError::Parse { source, .. }) = result else {
            panic!("expected a parse error naming {key}, got {result:?}");
        };
        let message = source.to_string();
        assert!(
            message.contains(key),
            "parse error should name the offending key {key}, got: {message}"
        );
    }

    #[test]
    fn an_unknown_key_in_the_signer_section_is_rejected() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"
kms_key_di = "transposed"
"#,
                key_path.display()
            )
        });

        assert_names_the_unknown_key(result, "kms_key_di");
    }

    #[test]
    fn an_unknown_key_in_the_operator_section_is_rejected() {
        let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[operator]
bearer_token = "operator-secret"
write_keys = ["{key}"]
bearer_tokn = "typo"
"#,
                key_path.display()
            )
        });

        assert_names_the_unknown_key(result, "bearer_tokn");
    }

    #[test]
    fn an_unknown_key_in_a_peer_entry_is_rejected() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[[peers]]
id = "store"
addr = "127.0.0.1:4001"
adrr = "127.0.0.1:4002"
"#,
                key_path.display()
            )
        });

        assert_names_the_unknown_key(result, "adrr");
    }

    #[test]
    fn an_unknown_key_in_a_route_entry_is_rejected() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[[routes]]
prefix = "g.example.app"
handler_url = "http://localhost:4000"
price = 100
pirce = 5
"#,
                key_path.display()
            )
        });

        assert_names_the_unknown_key(result, "pirce");
    }

    /// A `[[children]]` entry has no `fee` field at all, so the same
    /// mistake a `[[routes]]` entry now refuses used to vanish entirely
    /// here.
    #[test]
    fn an_unknown_key_in_a_child_entry_is_rejected() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
apex = "g.example"

[signer]
key_file = "{}"

[[children]]
name = "app"
handler_url = "http://localhost:4000"
price = 100
fee = 5
"#,
                key_path.display()
            )
        });

        assert_names_the_unknown_key(result, "fee");
    }

    /// The counterweight: a config file using every section this build
    /// supports, with no unknown key anywhere, still loads. Without this
    /// the tests above are satisfied by a config crate that refuses
    /// everything.
    #[test]
    fn a_config_using_every_supported_section_still_loads() {
        let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
peer_wire_addr = "127.0.0.1:4001"
apex = "g.example"

[signer]
key_file = "{}"

[[peers]]
id = "store"
addr = "127.0.0.1:4002"

[[routes]]
prefix = "g.example.app"
handler_url = "http://localhost:4000"
price = 100

[[routes]]
prefix = "g.example.store"
peer_id = "store"
fee = 3

[[children]]
name = "child"
handler_url = "http://localhost:4100"
price = 7

[operator]
bearer_token = "operator-secret"
write_keys = ["{key}"]
"#,
                key_path.display()
            )
        })
        .expect("load");

        assert_eq!(config.routes().len(), 2);
        assert_eq!(config.peer_routes().len(), 1);
        assert_eq!(config.peers().len(), 1);
        assert!(config.operator().is_some());
        assert!(config.peer_wire_addr().is_some());
    }
}
