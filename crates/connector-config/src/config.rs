use std::net::SocketAddr;
use std::path::Path;

use serde::Deserialize;

use crate::error::ConfigError;
use crate::operator::{resolve_operator, OperatorConfig, RawOperatorConfig};
use crate::route::{resolve_routes, RawChild, RawRoute, StaticRoute};
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
    operator: Option<OperatorConfig>,
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
        let routes = resolve_routes(raw.apex.as_deref(), raw.routes, raw.children)?;
        let operator = resolve_operator(raw.operator)?;

        Ok(Config {
            client_edge_addr,
            signer_key,
            routes,
            operator,
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

    /// The operator surface's authentication, if the surface is enabled.
    /// `None` means the `[operator]` section was absent -- the surface is
    /// not started at all. A `Some` value is always fully authenticated
    /// (ADR 0008): [`Config::load`] refuses to return one that is missing
    /// a bearer token or a write-key allowlist.
    pub fn operator(&self) -> Option<&OperatorConfig> {
        self.operator.as_ref()
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
}
