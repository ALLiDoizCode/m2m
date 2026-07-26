//! CLI argument parsing and commands. See ADR 0001.

mod runtime;

use std::fmt;
use std::net::SocketAddr;
use std::path::Path;

use axum::Router;
use connector_config::{Config, ConfigError};

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
/// Per ADR 0009, this is the only startup work that can fail before the
/// node is fully up: an `Err` here means the caller must exit non-zero
/// without having started anything else.
pub fn load_config<S: AsRef<str>>(args: &[S]) -> Result<Config, CliError> {
    let path = args
        .get(1)
        .ok_or_else(|| CliError::Usage("usage: connector <config-file>".to_string()))?;
    Config::load(Path::new(path.as_ref())).map_err(CliError::from)
}

/// Everything between process arguments and a servable [`Router`]: load
/// the config, build the runtime it describes, and merge its routers.
/// The one function `connector-bin` calls before binding a socket -- per
/// ADR 0001 the binary itself makes no decision beyond "did this fail".
pub fn run<S: AsRef<str>>(args: &[S]) -> Result<(Router, SocketAddr), CliError> {
    let config = load_config(args)?;
    let (connector, signer) = build(&config)?;
    let addr = config.client_edge_addr();
    Ok((router(connector, signer, &config), addr))
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
