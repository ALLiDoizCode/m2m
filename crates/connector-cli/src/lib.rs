//! CLI argument parsing and commands. See ADR 0001.

mod runtime;

use std::fmt;
use std::net::SocketAddr;
use std::path::Path;

use axum::Router;
use connector_config::{Config, ConfigError};
use connector_runtime::PeerWireServer;

pub use runtime::{build, router, RuntimeError};

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
    /// `peer_wire_addr` was configured but the socket could not be bound
    /// (e.g. the port is already in use).
    PeerWireBind(std::io::Error),
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CliError::Usage(message) => write!(f, "{message}"),
            CliError::Config(source) => write!(f, "{source}"),
            CliError::Runtime(source) => write!(f, "{source}"),
            CliError::PeerWireBind(source) => {
                write!(f, "failed to bind peer_wire_addr: {source}")
            }
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

/// Everything a running node needs beyond a bound client-edge socket:
/// [`connector_cli::run`] already binds the peer wire (if configured), so
/// `connector-bin` only has to hold [`RunningNode::peer_wire_server`] alive
/// for the process lifetime -- it never touches the connector or the peer
/// wire directly.
pub struct RunningNode {
    /// The merged client-edge (and, if configured, operator) router.
    pub router: Router,
    /// The socket address the client edge binds.
    pub client_edge_addr: SocketAddr,
    /// The peer wire's bound address, if `peer_wire_addr` was configured.
    pub peer_wire_addr: Option<SocketAddr>,
    /// The peer wire's accepting server, if `peer_wire_addr` was
    /// configured -- kept alive for as long as this value is held, and
    /// otherwise unused by the caller.
    pub peer_wire_server: Option<PeerWireServer>,
}

/// Everything between process arguments and a running node: load the
/// config, build the runtime it describes, merge its routers, and bind the
/// peer wire if `peer_wire_addr` is configured. The one function
/// `connector-bin` calls before binding the client-edge socket -- per ADR
/// 0001 the binary itself makes no decision beyond "did this fail".
pub async fn run<S: AsRef<str>>(args: &[S]) -> Result<RunningNode, CliError> {
    let config = load_config(args)?;
    let (connector, signer) = build(&config)?;
    let client_edge_addr = config.client_edge_addr();
    let router = router(connector.clone(), signer, &config);

    let peer_wire_server = match config.peer_wire_addr() {
        Some(addr) => Some(
            PeerWireServer::bind(addr, connector)
                .await
                .map_err(CliError::PeerWireBind)?,
        ),
        None => None,
    };
    let peer_wire_addr = peer_wire_server.as_ref().map(PeerWireServer::local_addr);

    Ok(RunningNode {
        router,
        client_edge_addr,
        peer_wire_addr,
        peer_wire_server,
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
    async fn run_with_no_peer_wire_addr_binds_no_peer_wire_server() {
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

        assert!(node.peer_wire_addr.is_none());
        assert!(node.peer_wire_server.is_none());
    }

    #[tokio::test]
    async fn run_with_a_peer_wire_addr_binds_a_real_listener() {
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

        let node = run(&[
            "connector".to_string(),
            config_file.path().display().to_string(),
        ])
        .await
        .expect("run");

        let addr = node.peer_wire_addr.expect("peer wire addr");
        assert!(node.peer_wire_server.is_some());
        // Port 0 was requested; the OS assigned a real one.
        assert_ne!(addr.port(), 0);
    }
}
