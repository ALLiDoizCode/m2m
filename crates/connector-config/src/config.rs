use std::net::SocketAddr;
use std::path::Path;

use serde::Deserialize;

use crate::error::ConfigError;
use crate::identity::{resolve_client_identities, ClientIdentityConfig, RawClientIdentity};
use crate::operator::{resolve_operator, OperatorConfig, RawOperatorConfig};
use crate::peer::{resolve_peers, PeerConfig, RawPeer};
use crate::route::{resolve_routes, PeerRouteConfig, RawChild, RawRoute, StaticRoute};
use crate::secret::{RawSignerConfig, SecretLocation};

/// The config file's shape exactly as written -- convenience forms
/// (`children`) intact, nothing yet validated.
#[derive(Debug, Deserialize)]
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
    /// Client-edge identities this node authenticates over HTTP (issue
    /// #502, `docs/protocol/client-edge-spec.md` §1.2) -- distinct from
    /// `peers` above, which addresses peer-wire dial targets.
    #[serde(default)]
    client_identities: Vec<RawClientIdentity>,
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
    client_identities: Vec<ClientIdentityConfig>,
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
        let client_identities = resolve_client_identities(raw.client_identities)?;

        Ok(Config {
            client_edge_addr,
            signer_key,
            routes,
            peer_routes,
            peers,
            peer_wire_addr,
            operator,
            client_identities,
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

    /// The client-edge identities this node authenticates over HTTP
    /// (`docs/protocol/client-edge-spec.md` §1.2). A request naming none of
    /// these via `ILP-Peer-Id` is anonymous, not rejected -- anonymity is a
    /// first-class path, not the absence of one.
    pub fn client_identities(&self) -> &[ClientIdentityConfig] {
        &self.client_identities
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

[[children]]
name = "billing"
handler_url = "http://localhost:4000"
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
    fn a_config_with_no_client_identities_section_has_an_empty_list() {
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

        assert!(config.client_identities().is_empty());
    }

    #[test]
    fn loads_client_identities() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[[client_identities]]
id = "buyer-a"
secret = "s3cr3t"

[[client_identities]]
id = "buyer-b"
"#,
                key_path.display()
            )
        })
        .expect("load");

        assert_eq!(config.client_identities().len(), 2);
        assert_eq!(config.client_identities()[0].id(), "buyer-a");
        assert_eq!(config.client_identities()[0].secret(), "s3cr3t");
        assert_eq!(config.client_identities()[1].id(), "buyer-b");
        assert_eq!(config.client_identities()[1].secret(), "");
    }

    #[test]
    fn rejects_a_duplicate_client_identity_id() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[[client_identities]]
id = "buyer-a"
secret = "one"

[[client_identities]]
id = "buyer-a"
secret = "two"
"#,
                key_path.display()
            )
        });

        assert!(matches!(
            result,
            Err(ConfigError::DuplicateClientIdentityId { .. })
        ));
    }
}
