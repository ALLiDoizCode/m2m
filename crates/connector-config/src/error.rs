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
        "the [settlement] section is present but names no chain at all -- add an \
         [settlement.evm] and/or [settlement.solana] table, or remove the section"
    )]
    SettlementSectionEmpty,

    #[error("the [settlement.solana] section's program_id is empty")]
    SettlementMissingProgramId,

    #[error("the [settlement.solana] section's token_address is empty")]
    SettlementMissingSolanaTokenAddress,

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

    #[error(
        "invalid [[client_channels]] {field} '{value}': must be base58 encoding a 32-byte \
         Solana account"
    )]
    ClientChannelInvalidSolanaAccount { field: &'static str, value: String },

    #[error(
        "[[client_channels]] is configured but 'state_dir' is not: this node would accept \
         claims and keep their replay watermarks only in memory, so every claim a client \
         has already spent becomes spendable again the next time this process restarts \
         (issue #605). Set a top-level state_dir to a directory this node can write, and \
         mount it so it outlives the container"
    )]
    ClientChannelsWithoutStateDir,

    #[error("state_dir '{path}' exists but is not a directory")]
    StateDirNotADirectory { path: PathBuf },

    #[error(
        "channel_liveness_ttl_secs is 0: this node would re-read the chain for every channel \
         on every packet rather than caching a resolution at all, which is a way to exhaust \
         an RPC endpoint's request budget and take the node's own paid writes down with it \
         (issue #649). Omit the field for the default, or set the number of seconds a \
         resolved channel's liveness may be believed for"
    )]
    ZeroChannelLivenessTtl,

    #[error(
        "channel_reattempt_interval_ms is 0: this node would put no floor at all on how often \
         one channel can make it read the chain, so a single client -- by sending packets, by \
         sending them at once, or by re-presenting one claim its channel cannot cover -- \
         becomes one RPC request each (issue #649). Omit the field for the default, or set the \
         milliseconds one channel must wait between lookups"
    )]
    ZeroChannelReattemptInterval,

    #[error(
        "channel_serve_stale_secs is {serve_stale_secs}s but channel_liveness_ttl_secs is \
         {ttl_secs}s: a resolved channel would stop being believed and stop being servable at \
         the same moment, so the stale window could never be used. Set it to at least the ttl, \
         or to 0 to never serve a reading this node could not confirm"
    )]
    ServeStaleShorterThanLivenessTtl {
        serve_stale_secs: u64,
        ttl_secs: u64,
    },

    #[error(
        "unresolvable_lookup_budget_{field} is 0: this node would never resolve a channel it \
         was not explicitly configured with, so an unaffiliated buyer who opened a channel on \
         chain could not pay it at all -- which is the registration-free path issue #611 exists \
         to provide, switched off by a number that reads as a tightening (issue #613). Omit the \
         field for the default, or set how many lookups for channels that do not resolve are \
         allowed per window"
    )]
    ZeroUnresolvableLookupBudget { field: &'static str },

    #[error(
        "unresolvable_lookup_budget_window_secs is 0: a zero-length window restarts on every \
         request, so both allowances are spendable in full by every request and the budget \
         bounds nothing at all while appearing to be configured (issue #613). Omit the field for \
         the default, or set the number of seconds the allowances are counted over"
    )]
    ZeroUnresolvableLookupWindow,

    #[error(
        "unresolvable_lookup_budget_per_signer is {per_signer} but \
         unresolvable_lookup_budget_total is {total}: the node-wide allowance would refuse first \
         every time, so the per-signer number could never be reached and means nothing. Set it \
         to at most the total (issue #613)"
    )]
    UnresolvableLookupPerSignerAboveTotal { per_signer: u32, total: u32 },
}
