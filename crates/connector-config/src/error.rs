use std::net::AddrParseError;
use std::path::PathBuf;

use thiserror::Error;

/// Every way [`crate::Config::load`] can fail.
///
/// Each variant names the offending field and, where useful, the value the
/// operator wrote, so the error is actionable without opening the source.
#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("failed to read config file at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("config file at {path} is not valid TOML: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: Box<toml::de::Error>,
    },

    #[error("invalid client_edge_addr '{value}': {source}")]
    InvalidBindAddr {
        value: String,
        #[source]
        source: AddrParseError,
    },

    #[error("invalid {field} '{value}': not a valid ILP address")]
    InvalidAddress { field: &'static str, value: String },

    #[error(
        "invalid child name '{name}': must be a single ILP address label \
         (alphanumeric, '-', '_')"
    )]
    InvalidChildName { name: String },

    #[error("invalid handler_url '{value}' for route '{prefix}': {source}")]
    InvalidHandlerUrl {
        prefix: String,
        value: String,
        #[source]
        source: url::ParseError,
    },

    #[error("handler_url '{value}' for route '{prefix}' must be http or https")]
    UnsupportedUrlScheme { prefix: String, value: String },

    #[error("duplicate route prefix '{prefix}'")]
    DuplicatePrefix { prefix: String },

    #[error("children are configured but no apex is set: add a top-level 'apex' field")]
    MissingApex,

    #[error("signer config must set exactly one of 'key_file' or 'kms_key_id', but {reason}")]
    SignerLocationAmbiguous { reason: &'static str },

    #[error("signer key_file does not exist or is not a file: {0}")]
    SignerKeyFileNotFound(PathBuf),

    #[error("signer kms_key_id must not be empty")]
    SignerKmsIdEmpty,

    #[error(
        "the [operator] section is present but bearer_token is empty: \
         the operator surface would have no read authentication"
    )]
    OperatorMissingBearerToken,

    #[error(
        "the [operator] section is present but write_keys is empty: \
         the operator surface would accept writes from no one"
    )]
    OperatorNoWriteKeys,

    #[error(
        "invalid operator write_keys entry '{value}': must be 64 hex characters \
         (a 32-byte ed25519 public key)"
    )]
    OperatorInvalidWriteKey { value: String },

    #[error(
        "route '{prefix}' must set exactly one of 'handler_url' or 'peer_id', but neither is set"
    )]
    RouteMissingTarget { prefix: String },

    #[error(
        "route '{prefix}' must set exactly one of 'handler_url' or 'peer_id', but both are set"
    )]
    RouteTargetAmbiguous { prefix: String },

    #[error("route '{prefix}' has an empty 'peer_id'")]
    RoutePeerIdEmpty { prefix: String },

    #[error(
        "route '{prefix}' forwards to peer_id '{peer_id}', which no '[[peers]]' entry configures"
    )]
    UnknownPeerId { prefix: String, peer_id: String },

    #[error("peer entry has an empty 'id'")]
    PeerIdEmpty,

    #[error("duplicate peer id '{id}'")]
    DuplicatePeerId { id: String },

    #[error("invalid addr '{value}' for peer '{id}': {source}")]
    InvalidPeerAddr {
        id: String,
        value: String,
        #[source]
        source: AddrParseError,
    },

    #[error("invalid peer_wire_addr '{value}': {source}")]
    InvalidPeerWireAddr {
        value: String,
        #[source]
        source: AddrParseError,
    },

    #[error("client identity entry has an empty 'id'")]
    ClientIdentityIdEmpty,

    #[error("duplicate client identity id '{id}'")]
    DuplicateClientIdentityId { id: String },
}
