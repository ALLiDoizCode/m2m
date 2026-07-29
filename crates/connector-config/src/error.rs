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
        "route '{prefix}' terminates locally at '{handler_url}' but sets no 'price': a \
         terminated route is never silently free -- set 'price = 0' if that is deliberate"
    )]
    RouteMissingPrice { prefix: String, handler_url: String },

    #[error(
        "route '{prefix}' terminates locally and sets 'fee = {fee}', which only a route \
         forwarding to a 'peer_id' can charge (ADR 0010) -- a terminating app's work is paid \
         for by 'price'. Remove the 'fee', or write 'price = {fee}' if that is what was meant"
    )]
    TerminatedRouteHasFee { prefix: String, fee: u64 },

    #[error(
        "route '{prefix}' forwards to a peer and sets 'price = {price}', which only a route \
         terminating at a 'handler_url' can charge (issue #520) -- carriage over a peering \
         relation is paid for by 'fee'. Remove the 'price', or write 'fee = {price}' if that \
         is what was meant"
    )]
    PeerRouteHasPrice { prefix: String, price: u64 },

    #[error(
        "handler_url '{handler_url}' is priced inconsistently: route '{first_prefix}' charges \
         {first_price} but route '{second_prefix}' charges {second_price} -- an app cannot tell \
         which request arrived under which price, so the cheaper one would always win"
    )]
    ConflictingHandlerPrice {
        handler_url: String,
        first_prefix: String,
        first_price: u64,
        second_prefix: String,
        second_price: u64,
    },

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

    #[error(
        "the [settlement] section names chain '{value}', which this connector does not \
         implement -- only 'evm' is recognized"
    )]
    SettlementUnknownChain { value: String },

    #[error("the [settlement] section's rpc_url is empty")]
    SettlementMissingRpcUrl,

    #[error("invalid settlement rpc_url '{value}': {source}")]
    SettlementInvalidRpcUrl {
        value: String,
        #[source]
        source: url::ParseError,
    },

    #[error("settlement rpc_url '{value}' must be http or https")]
    SettlementUnsupportedRpcScheme { value: String },

    #[error(
        "invalid settlement contract_address '{value}': must be 40 hex characters \
         (a 20-byte EVM address), optionally '0x'-prefixed"
    )]
    SettlementInvalidContractAddress { value: String },

    #[error(
        "invalid settlement token_address '{value}': must be 40 hex characters \
         (a 20-byte EVM address), optionally '0x'-prefixed"
    )]
    SettlementInvalidTokenAddress { value: String },

    #[error("the [settlement] section's decimals must not be zero")]
    SettlementZeroDecimals,

    #[error(
        "the [settlement] section's key must set exactly one of 'key_file' or 'kms_key_id', \
         but {reason}"
    )]
    SettlementKeyLocationAmbiguous { reason: &'static str },

    #[error("settlement key_file does not exist or is not a file: {0}")]
    SettlementKeyFileNotFound(PathBuf),

    #[error("settlement kms_key_id must not be empty")]
    SettlementKmsIdEmpty,

    #[error(
        "invalid [[client_channels]] channel_id '{value}': must be 64 hex characters \
         (an on-chain 32-byte channel identifier), optionally '0x'-prefixed"
    )]
    ClientChannelInvalidId { value: String },

    #[error(
        "invalid [[client_channels]] {field} '{value}': must be 40 hex characters \
         (a 20-byte EVM address), optionally '0x'-prefixed"
    )]
    ClientChannelInvalidAddress { field: &'static str, value: String },

    #[error("[[client_channels]] names channel '{value}' more than once")]
    ClientChannelDuplicate { value: String },
}
