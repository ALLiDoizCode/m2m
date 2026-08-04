//! CLI argument parsing and commands. See ADR 0001.

mod runtime;

use std::fmt;
use std::net::SocketAddr;
use std::path::Path;

use axum::Router;
use connector_config::{Config, ConfigError};

pub use runtime::{build, router, Runtime, RuntimeError};

/// Everything that can stop the connector from producing a validated,
/// running node.
#[derive(Debug)]
pub enum CliError {
    /// Argument parsing failed -- e.g. no config path was given.
    Usage(String),
    /// The config file itself failed to load or validate.
    Config(ConfigError),
    /// The config loaded but the runtime it describes could not be built
    /// (e.g. an unreadable or malformed signer key).
    Runtime(RuntimeError),
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CliError::Usage(message) => write!(f, "{message}"),
            CliError::Config(source) => write!(f, "{source}"),
            CliError::Runtime(source) => write!(f, "{source}"),
        }
    }
}

impl std::error::Error for CliError {}

impl From<ConfigError> for CliError {
    fn from(source: ConfigError) -> Self {
        CliError::Config(source)
    }
}

impl From<RuntimeError> for CliError {
    fn from(source: RuntimeError) -> Self {
        CliError::Runtime(source)
    }
}

/// Load and fully validate the connector's configuration from process
/// arguments (as `std::env::args()` yields them: `args[0]` is the program
/// name, `args[1]` is the path to the one typed configuration file).
///
/// Per ADR 0009, an `Err` here means the caller must exit non-zero
/// without having started anything else. [`build`] can also fail this
/// way once the config is loaded -- see [`RuntimeError`].
pub fn load_config<S: AsRef<str>>(args: &[S]) -> Result<Config, CliError> {
    let path = args
        .get(1)
        .ok_or_else(|| CliError::Usage("usage: connector <config-file>".to_string()))?;
    Config::load(Path::new(path.as_ref())).map_err(CliError::from)
}

/// Everything a running node needs beyond a bound client-edge socket.
///
/// A node used to also bind a second, peer-only listener here. ADR 0027
/// removed it: peers ride the carriages the client edge already serves
/// (BTP over `wss://`, ILP-over-HTTP over `https://`) and are told apart
/// from clients by authentication, not by port -- so there is one listener
/// again, and nothing for the binary to hold alive.
pub struct RunningNode {
    /// The merged client-edge (and, if configured, operator) router.
    pub router: Router,
    /// The socket address the client edge binds.
    pub client_edge_addr: SocketAddr,
}

/// Everything between process arguments and a running node: load the
/// config, build the runtime it describes, and merge its routers. The one
/// function `connector-bin` calls before binding the client-edge socket --
/// per ADR 0001 the binary itself makes no decision beyond "did this
/// fail".
pub async fn run<S: AsRef<str>>(args: &[S]) -> Result<RunningNode, CliError> {
    let config = load_config(args)?;
    let runtime = build(&config).await?;
    let client_edge_addr = config.client_edge_addr();
    let router = router(&runtime, &config)?;

    Ok(RunningNode {
        router,
        client_edge_addr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn missing_path_argument_is_a_usage_error() {
        let result = load_config(&["connector".to_string()]);
        assert!(matches!(result, Err(CliError::Usage(_))));
    }

    #[test]
    fn nonexistent_config_file_is_a_config_error() {
        let result = load_config(&[
            "connector".to_string(),
            "/nonexistent/path.toml".to_string(),
        ]);
        assert!(matches!(
            result,
            Err(CliError::Config(ConfigError::Io { .. }))
        ));
    }

    fn write_config(text: &str) -> tempfile::NamedTempFile {
        let mut config_file = tempfile::NamedTempFile::new().expect("temp config file");
        write!(config_file, "{text}").expect("write config file");
        config_file
    }

    fn write_raw_key_file() -> tempfile::NamedTempFile {
        let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
        key_file
            .write_all(&[7u8; 32])
            .expect("write raw 32-byte key");
        key_file
    }

    #[tokio::test]
    async fn run_produces_a_node_with_only_a_client_edge_listener() {
        let key_file = write_raw_key_file();
        let config_file = write_config(&format!(
            r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"
"#,
            key_file.path().display()
        ));

        let node = run(&[
            "connector".to_string(),
            config_file.path().display().to_string(),
        ])
        .await
        .expect("run");

        assert_eq!(node.client_edge_addr, "127.0.0.1:0".parse().unwrap());
    }

    /// ADR 0027 / issue #679: `peer_wire_addr` is gone, and a config that
    /// still sets it fails at boot by name -- the devnet boxes run
    /// bind-mounted configs that lead the repo copies, so a stale one must
    /// stop the node rather than quietly start it without peering.
    #[tokio::test]
    async fn run_with_a_stale_peer_wire_addr_fails_by_name() {
        let key_file = write_raw_key_file();
        let config_file = write_config(&format!(
            r#"
client_edge_addr = "127.0.0.1:0"
peer_wire_addr = "127.0.0.1:0"

[signer]
key_file = "{}"
"#,
            key_file.path().display()
        ));

        let result = run(&[
            "connector".to_string(),
            config_file.path().display().to_string(),
        ])
        .await;
        let Err(error) = result else {
            panic!("stale peer_wire_addr must fail config load");
        };

        assert!(matches!(
            error,
            CliError::Config(ConfigError::PeerWireAddrRemoved)
        ));
        assert!(error
            .to_string()
            .contains("docs/operators/btp-peer-transport-bringup.md"));
    }
}
