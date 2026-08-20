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
        "the [operator] section is present but names no bearer token, or an empty one: the \
         operator surface would have no read authentication. Set exactly one of \
         'bearer_token_file = \"/app/data/…\"' (what a deployed node should use -- this \
         repository is public, so a committed config must not carry the literal) or \
         'bearer_token = \"…\"'"
    )]
    OperatorMissingBearerToken,

    #[error(
        "the [operator] section is present but names no write keys: the operator surface \
         would accept writes from no one. Set exactly one of 'write_keys_file = \
         \"/app/data/…\"' (the deployed form -- a file an operator can edit to revoke, which \
         a committed literal is not) or 'write_keys = [\"…\"]'"
    )]
    OperatorNoWriteKeys,

    #[error(
        "invalid operator write_keys entry '{value}': must be 64 hex characters \
         (a 32-byte ed25519 public key)"
    )]
    OperatorInvalidWriteKey { value: String },

    #[error(
        "the [operator] section sets both '{literal}' and '{file}': exactly one of them says \
         where this setting's value comes from, and two answers is not a merge -- it is an \
         unanswerable question about which one gates the operator surface, with the losing \
         value left in the file looking authoritative. Keep '{file}' (the deployed form -- \
         this repository is public, so a committed config must not carry the literal) and \
         delete '{literal}'; see docs/operators/key-rotation-runbook.md"
    )]
    OperatorSettingAmbiguous {
        literal: &'static str,
        file: &'static str,
    },

    #[error(
        "the [operator] section sets '{setting} = {path}', which does not exist or is not a \
         file: an operator surface that cannot read its own authentication authenticates \
         nobody, so this is refused at load rather than becoming a surface that is enabled \
         and quietly rejects every request. The path is resolved the same way '[signer] \
         key_file' is -- relative to the process's working directory, so write an absolute \
         path; see docs/operators/key-rotation-runbook.md"
    )]
    OperatorFileNotFound {
        setting: &'static str,
        path: PathBuf,
    },

    #[error(
        "the [operator] section sets '{setting} = {path}', which could not be read as text: \
         {source} -- check the file's permissions inside the container (a secret file is \
         usually mode 600 and must be owned by the uid the connector runs as); see \
         docs/operators/key-rotation-runbook.md"
    )]
    OperatorFileUnreadable {
        setting: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error(
        "the [operator] section sets '{setting} = {path}', which carries nothing once \
         whitespace and comments are stripped: an empty file is the same unauthenticated \
         surface an empty literal would be, and a truncated or half-written file is the usual \
         cause -- rewrite it; see docs/operators/key-rotation-runbook.md"
    )]
    OperatorFileEmpty {
        setting: &'static str,
        path: PathBuf,
    },

    #[error(
        "invalid operator write_keys_file entry at {path}:{line}: '{value}' must be 64 hex \
         characters (a 32-byte ed25519 public key). One key per line, '#' starts a comment; \
         see docs/operators/key-rotation-runbook.md"
    )]
    OperatorWriteKeysFileInvalidKey {
        path: PathBuf,
        line: usize,
        value: String,
    },

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
        "route '{prefix}' forwards to peer '{peer_id}' but sets no 'price': a forwarded route \
         is never silently free either (ADR 0028) -- 'price' is what this connector's client \
         edge charges a client for a packet to this prefix, and 'fee' is only what this hop \
         retains of it. Set 'price = 0' if free carriage is deliberate"
    )]
    PeerRouteMissingPrice { prefix: String, peer_id: String },

    #[error(
        "route '{prefix}' forwards to a peer and sets 'transport = \"{value}\"', which this \
         connector does not yet apply to a forwarded route (issue #701, ADR 0028) -- such a \
         route accepts both client transports. Remove the 'transport' field"
    )]
    PeerRouteHasTransport { prefix: String, value: String },

    #[error(
        "route '{prefix}' sets transport = '{value}', which this connector does not recognize \
         -- only 'http', 'btp' or 'both' are valid (issue #701). Omit the field for the \
         default ('both'), or set one of those three"
    )]
    InvalidTransportPolicy { prefix: String, value: String },

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

    #[error(
        "duplicate peer id '{id}': two '[[peers]]' entries name it, so which credential and \
         endpoint apply to it is unanswerable -- see \
         docs/operators/btp-peer-transport-bringup.md"
    )]
    DuplicatePeerId { id: String },

    // -- The peer carriage config surface (issue #677, peer-carriage-spec
    // §11). Every message names the bring-up doc, because a peering that
    // does not come up produces no other evidence an operator can read.
    #[error(
        "invalid peer_expose value '{value}': a connector exposes 'btp', 'http', 'both' or \
         'neither' peer carriage (peer-carriage-spec.md §2.1) -- 'neither' is the NAT'd \
         operator, who exposes nothing and only dials out. Omit the field for the default \
         ('neither'); see docs/operators/btp-peer-transport-bringup.md"
    )]
    InvalidPeerExposure { value: String },

    /// Issue #883 (B6): the migration knob, spelled wrong. A mistyped value
    /// must not silently read as the default -- see
    /// [`crate::peer::ClaimEnforcement`]'s own documentation for why the
    /// field is temporary.
    #[error(
        "invalid claim_enforcement value '{value}' for peer '{id}': a peer sets 'enforce' \
         (refuse an uncovered peer PREPARE, the default) or 'observe' (admit and log it -- the \
         rollout's own migration-only canary step, issue #883). Omit the field for the default \
         ('enforce'); see docs/operators/claim-policy-rollout.md"
    )]
    InvalidClaimEnforcement { id: String, value: String },

    /// ADR 0042's cap, written as `0`. A cap of zero refuses every packet
    /// this peering could carry, so it is a peering that silently does
    /// nothing -- and there is deliberately no spelling that turns the cap
    /// off, since the whole point of the rule is that a bound always
    /// exists.
    #[error(
        "max_packet_amount = 0 for peer '{id}': the cap is the largest amount this connector \
         will forward to a peer in ONE packet (ADR 0042), so zero refuses every packet that \
         peering could ever carry. Write a positive amount in the settlement asset's base \
         units, or omit the field for the default"
    )]
    PeerMaxPacketAmountZero { id: String },

    #[error(
        "invalid endpoint '{value}' for peer '{id}': {source} -- a peer endpoint is a URL \
         ('wss://host:port/path' for BTP, 'https://host:port/path' for ILP-over-HTTP), not a \
         host:port pair; see docs/operators/btp-peer-transport-bringup.md"
    )]
    InvalidPeerEndpoint {
        id: String,
        value: String,
        #[source]
        source: url::ParseError,
    },

    #[error(
        "endpoint '{value}' for peer '{id}' has scheme '{scheme}', which selects no peer \
         carriage: 'wss://' selects BTP and 'https://' selects ILP-over-HTTP, and there is no \
         third one (ADR 0027 deleted the raw-TCP transport). Both are TLS-only because a \
         peering carries signed balance proofs (ADR 0004), so 'ws://' and 'http://' are not \
         accepted either; see docs/operators/btp-peer-transport-bringup.md"
    )]
    PeerEndpointScheme {
        id: String,
        value: String,
        scheme: String,
    },

    #[error(
        "peer '{id}' configures no credential, or an empty one: role is decided by \
         authentication (peer-carriage-spec.md §1.2), and an empty secret matches nothing -- \
         so this peering could only ever admit its counterparty as an ordinary client, \
         silently. Set exactly one of 'credential = {{ secret_file = \"/app/data/…\" }}' (what a \
         deployed node should use -- this repository is public, so a committed config must not \
         carry the literal) or 'credential = {{ secret = \"…\" }}'; see \
         docs/operators/btp-peer-transport-bringup.md"
    )]
    PeerCredentialMissing { id: String },

    #[error(
        "peer '{id}' sets both 'secret' and 'secret_file' on its credential: exactly one of \
         them says where this peering's shared secret comes from, and two answers is not a \
         merge -- it is an unanswerable question about which one authenticates the peering. \
         Keep 'secret_file' (the deployed form) and delete the literal; see \
         docs/operators/btp-peer-transport-bringup.md"
    )]
    PeerCredentialAmbiguous { id: String },

    #[error(
        "peer '{id}' sets 'secret_file = {path}', which does not exist or is not a file: a \
         peering whose secret cannot be read authenticates nobody, so this is refused at load \
         rather than becoming a peering that silently admits its counterparty as an ordinary \
         client. The path is resolved the same way '[signer] key_file' is -- relative to the \
         process's working directory, so write an absolute path; see \
         docs/operators/btp-peer-transport-bringup.md"
    )]
    PeerSecretFileNotFound { id: String, path: PathBuf },

    #[error(
        "peer '{id}' sets 'secret_file = {path}', which could not be read as text: {source} -- \
         check the file's permissions inside the container (a secret file is usually mode 600 \
         and must be owned by the uid the connector runs as); see \
         docs/operators/btp-peer-transport-bringup.md"
    )]
    PeerSecretFileUnreadable {
        id: String,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error(
        "peer '{id}' sets 'secret_file = {path}', which is empty once trailing whitespace is \
         trimmed: an empty secret matches nothing (peer-carriage-spec.md §1.2), so this is the \
         same silent non-peering 'secret = \"\"' would be. A truncated file is the usual cause \
         -- regenerate it, e.g. 'openssl rand -hex 32 > {path}'; see \
         docs/operators/btp-peer-transport-bringup.md"
    )]
    PeerSecretFileEmpty { id: String, path: PathBuf },

    #[error(
        "peer '{id}' has no '[[peer_channels]]' entry: a peer role needs both a proven \
         credential and a channel binding (peer-carriage-spec.md §1.2 P2), so without one this \
         peering can never take the peer role and its claims would be judged as a stranger's. \
         This is the surface whose absence made ADR 0024 inert (issue #620); see \
         docs/operators/btp-peer-transport-bringup.md"
    )]
    PeerChannelUnbound { id: String },

    #[error(
        "'[[peer_channels]]' names peer_id '{peer_id}', which no '[[peers]]' entry configures \
         -- a channel bound to a peering that does not exist binds nothing; see \
         docs/operators/btp-peer-transport-bringup.md"
    )]
    PeerChannelOrphaned { peer_id: String },

    #[error(
        "channel '{value}' is configured in both '[[peer_channels]]' and \
         '[[client_channels]]': peer and client claim watermarks are separate records, so one \
         channel in both namespaces lets the same money be counted as credit twice \
         (peer-carriage-spec.md §1.8). Keep the namespaces disjoint -- see \
         docs/operators/btp-peer-transport-bringup.md"
    )]
    ChannelInBothNamespaces { value: String },

    // -- `[[pay_channels]]` (ADR 0042 item 2, issue #881): the channel this
    // node PAYS a next hop from, as an ordinary client of it. See
    // `crate::pay_channel`'s module header for why this is a third table
    // rather than a row in either of the two above.
    #[error(
        "'[[pay_channels]]' names peer_id '{peer_id}', which no '[[peers]]' entry configures -- \
         a channel that pays a peering that does not exist pays nobody. This table is how this \
         node covers every PREPARE it forwards to a hop (ADR 0042); the hop is named by the \
         same '[[peers]]' id a route's peer_id names"
    )]
    PayChannelOrphaned { peer_id: String },

    #[error(
        "'[[pay_channels]]' for peer '{peer_id}' names channel '{value}', which is not a \
         32-byte on-chain channel id: it must be 64 hex characters, optionally '0x'-prefixed. \
         This is the channel this node PAYS that hop from as an ordinary client of it"
    )]
    PayChannelInvalidId { peer_id: String, value: String },

    #[error(
        "'[[pay_channels]]' for peer '{peer_id}' has an invalid {field} '{value}': it must be a \
         20-byte EVM address, optionally '0x'-prefixed. It is half of the EIP-712 domain the \
         covering claim is signed under, and a claim signed under the wrong domain recovers to \
         a different address and is refused at the far gate"
    )]
    PayChannelInvalidAddress {
        peer_id: String,
        field: &'static str,
        value: String,
    },

    #[error(
        "'[[pay_channels]]' for peer '{peer_id}' has an unusable client_edge_url '{value}': \
         {source}. It is that hop's own 'POST /ilp' endpoint -- where this node arrives as an \
         ordinary buyer, and where 'POST /ilp/claim-state' (issue #693) answers where this \
         node's claims on the channel stand"
    )]
    PayChannelInvalidClientEdgeUrl {
        peer_id: String,
        value: String,
        #[source]
        source: url::ParseError,
    },

    #[error(
        "'[[pay_channels]]' for peer '{peer_id}' has client_edge_url '{value}', whose scheme \
         '{scheme}' is not one this node may ask a channel's claim state over: it must be \
         'https://' (or 'http://' with peer_allow_plaintext_endpoints, which is a loopback and \
         test setting). The ask carries a signed EIP-712 challenge -- a capability to read a \
         channel's state -- so it is TLS-only by default. A peering's own 'wss://' endpoint is \
         not this URL and is never turned into it by swapping scheme and appending a path \
         (ADR 0030)"
    )]
    PayChannelClientEdgeUrlScheme {
        peer_id: String,
        value: String,
        scheme: String,
    },

    #[error(
        "'[[pay_channels]]' names peer '{peer_id}' twice: the outbound client ledger keeps one \
         nonce line per next hop, so a second row would be a second channel for one line and \
         which one signed would depend on file order"
    )]
    PayChannelDuplicatePeer { peer_id: String },

    #[error(
        "channel '{value}' is named by two '[[pay_channels]]' rows: one channel paid from by \
         two next hops is one channel carrying two nonce lines, and the far gate resolves that \
         by refusing one of them as a replay"
    )]
    PayChannelDuplicate { value: String },

    #[error(
        "channel '{value}' is configured in both '[[pay_channels]]' and '[[client_channels]]': \
         '[[client_channels]]' is channels this node RECEIVES claims on and '[[pay_channels]]' \
         is one it PAYS from, so one channel in both roles is the same double-count \
         'ChannelInBothNamespaces' refuses between the peer and client books (ADR 0030, \
         peer-carriage-spec.md §1.8)"
    )]
    PayChannelIsAlsoAClientChannel { value: String },

    #[error(
        "'[[pay_channels]]' names peer '{peer_id}' but this node has no '[settlement.evm]' \
         table: a covering claim is an EIP-712 balance proof signed by the channel's on-chain \
         participant, which IS this node's settlement address -- the same key ADR 0024's \
         outbound peer claims use. There is no second key to configure and none is invented \
         (ADR 0030)"
    )]
    PayChannelWithoutEvmSettlement { peer_id: String },

    #[error(
        "'[[pay_channels]]' is configured but 'state_dir' is not: the outbound client ledger \
         keeps the highest nonce it has ever ISSUED to each next hop, and it has to outlive the \
         process -- a restart that reissued a nonce would fork this node's own outbound nonce \
         line and the far gate would refuse one of the two claims as a replay"
    )]
    PayChannelsWithoutStateDir,

    #[error(
        "route '{prefix}' forwards to peer '{peer_id}', which this connector can never \
         originate to: the peering configures no 'endpoint' (so this connector never dials it) \
         and peer_expose does not include 'btp' (so it can never be reached back over a dialed \
         session either) -- packets flow only in the dialing direction on HTTP \
         (peer-carriage-spec.md §6.4). Give the peer a 'wss://' or 'https://' endpoint, or set \
         peer_expose to include 'btp'; see docs/operators/btp-peer-transport-bringup.md"
    )]
    PeerRouteUndeliverable { prefix: String, peer_id: String },

    #[error(
        "peer '{id}' has no 'endpoint' and this connector's peer_expose is 'neither': it dials \
         nothing and accepts nothing, so this peering can never establish and no amount of \
         retrying changes that (peer-carriage-spec.md §2.2). Give it an endpoint, or expose a \
         carriage for it to dial; see docs/operators/btp-peer-transport-bringup.md"
    )]
    PeerUndialable { id: String },

    #[error(
        "invalid [[peer_channels]] channel_id '{value}': must be 64 hex characters \
         (an on-chain 32-byte channel identifier), optionally '0x'-prefixed"
    )]
    PeerChannelInvalidId { value: String },

    #[error(
        "invalid [[peer_channels]] {field} '{value}': must be 40 hex characters \
         (a 20-byte EVM address), optionally '0x'-prefixed"
    )]
    PeerChannelInvalidAddress { field: &'static str, value: String },

    #[error("[[peer_channels]] names channel '{value}' more than once")]
    PeerChannelDuplicate { value: String },

    #[error(
        "invalid [[peer_channels]] {field} '{value}': must be base58 encoding a 32-byte \
         Solana account"
    )]
    PeerChannelInvalidSolanaAccount { field: &'static str, value: String },

    #[error(
        "peer '{peer_id}' names a Solana '[[peer_channels]]' row with no 'program_id': a \
         rendered outbound Solana claim's 'programId' is a required wire field \
         (client-edge-spec.md §1.3), not an optional domain the way an EVM claim's 'chainId' \
         is, so there is no configuration this connector could fall back to render without one \
         (issue #759). Set 'program_id' to the base58 address of the deployed payment-channel \
         program this channel was opened under"
    )]
    PeerChannelMissingSolanaProgramId { peer_id: String },

    #[error(
        "[[peer_channels]] is configured but 'state_dir' is not: this node would accept peer \
         claims and keep their replay watermarks only in memory, so every claim a peer has \
         already spent becomes spendable again the next time this process restarts (issue \
         #605). Set a top-level state_dir to a directory this node can write, and mount it so \
         it outlives the container"
    )]
    PeerChannelsWithoutStateDir,

    #[error(
        "peer '{id}' sets 'addr', which was removed with the raw-TCP transport (ADR 0027, \
         issue #679) -- a peer is reached by 'endpoint' (a wss:// or https:// URL) instead; \
         see docs/operators/btp-peer-transport-bringup.md"
    )]
    PeerAddrRemoved { id: String },

    /// §11's removed-field row, `ceiling` half (ADR 0033, issue #882):
    /// nothing tracks trailing exposure any more, so there is nothing for a
    /// ceiling to bound. Cites the record that removed the machinery, not the
    /// reasoning behind it (issue #1068) -- ADR 0042's covering-claim rule is
    /// a target record whose forwarded half is unbuilt, and a boot error must
    /// not depend on it.
    #[error(
        "peer '{id}' sets 'ceiling', which was removed when the exposure machinery was retired \
         (ADR 0033, issue #882) -- nothing tracks trailing exposure, so there is nothing for a \
         ceiling to bound. Delete the key rather than replace it; see \
         docs/operators/btp-peer-transport-bringup.md"
    )]
    PeerCeilingRemoved { id: String },

    /// §11's removed-field row, `flush_interval_ms` half (ADR 0033, issue
    /// #882): a claim no longer trails the fulfilment it covers, so there is
    /// nothing left to flush.
    #[error(
        "peer '{id}' sets 'flush_interval_ms', which was removed for the same reason 'ceiling' \
         was (ADR 0033, issue #882): nothing tracks trailing exposure, so there is no pending \
         claim for a timer to flush. Delete the key rather than replace it; see \
         docs/operators/btp-peer-transport-bringup.md"
    )]
    PeerFlushIntervalRemoved { id: String },

    /// The other half of §11's removed-field row, spelled and worded
    /// exactly as PR #718 (`feat/delete-peer-role`) spells it.
    ///
    /// **Defined here, constructed there.** #718 owns the deletion of the
    /// raw-TCP transport itself (issue #679), including the top-level
    /// `peer_wire_addr` field, the listener `connector-cli` binds from it
    /// and the infra configs that still name it. This branch does not
    /// touch that listener, so on this branch alone the field still binds
    /// one; when the two land, #718's `if raw.peer_wire_addr.is_some()`
    /// meets this variant and the pair is complete.
    #[error(
        "'peer_wire_addr' was removed with the raw-TCP transport (ADR 0027, issue #679) -- \
         peer carriages are exposed on the connector's own listeners, not a separate socket; \
         see docs/operators/btp-peer-transport-bringup.md"
    )]
    PeerWireAddrRemoved,

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
        "the [settlement.evm] section's channel_index_confirmations is 0: applying a log at \
         chain head has nothing to fall back on if the head reorgs, and issue #661 deliberately \
         ships no unwind logic for that case -- a channel inside the confirmation window is \
         meant to fall through to a direct chain read instead. Omit the field for the default \
         confirmation depth, or set a depth of at least 1 block"
    )]
    SettlementChannelIndexConfirmationsZero,

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

    #[error("[[client_identities]] entry has an empty 'id'")]
    ClientIdentityIdEmpty,

    #[error("[[client_identities]] names identity '{id}' more than once")]
    DuplicateClientIdentityId { id: String },

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
        "btp_session_window is 0: a BTP session's first paid frame would wait forever for an \
         in-flight slot that does not exist, hanging every client on connect (issue #688). Omit \
         the field for the default, set 1 for the original lockstep session, or set how many of \
         one session's frames may be past claim admission at once"
    )]
    ZeroBtpSessionWindow,

    #[error(
        "unresolvable_lookup_budget_per_signer is {per_signer} but \
         unresolvable_lookup_budget_total is {total}: the node-wide allowance would refuse first \
         every time, so the per-signer number could never be reached and means nothing. Set it \
         to at most the total (issue #613)"
    )]
    UnresolvableLookupPerSignerAboveTotal { per_signer: u32, total: u32 },

    #[error(
        "unresolvable_lookup_budget_max_wait_ms is 0: this node would refuse a lookup outright \
         the moment its discovery drain saturated, rather than holding it for a slot. That hands \
         any sender able to sustain unresolvable_lookup_budget_total requests per window a switch \
         that turns the registration-free path of issue #611 off for every new buyer -- a worse \
         failure than the RPC spend the bound exists to prevent (issue #613). Omit the field for \
         the default, or set the milliseconds a lookup may wait for its turn"
    )]
    ZeroUnresolvableLookupMaxWait,

    #[error(
        "unresolvable_lookup_budget_max_wait_ms is {max_wait_ms} but \
         unresolvable_lookup_budget_window_secs is {window_secs} (either as written or by \
         default): the wait ceiling is the size of the waiting room, not just a timeout -- a \
         room drained at the configured rate and holding a lookup for {max_wait_ms} ms parks \
         more than a whole window's worth of them, which is more memory than the bound is worth \
         and a wait no packet's own deadline would survive (issue #613). Set it to at most the \
         window"
    )]
    UnresolvableLookupMaxWaitAboveWindow { max_wait_ms: u64, window_secs: u64 },

    #[error(
        "unresolvable_lookup_budget_window_secs is {window_secs}, above the {max_secs} s this \
         node will honour: a rate limit whose window outlives the process running it is not a \
         rate limit, and the arithmetic over it stops fitting an instant (issue #613)"
    )]
    UnresolvableLookupWindowTooLong { window_secs: u64, max_secs: u64 },

    // -- The `[announce]` section (issue #784) --
    //
    // Every one of these refuses a value that would otherwise be
    // BROADCAST to the whole network in a kind:10032 event. That is what
    // makes them load errors rather than warnings: an announce is read by
    // strangers, cached, and acted on, and the node that published it has
    // no way to take it back before its NIP-40 expiry.
    #[error(
        "[announce] names no addresses: an announce with no `addresses` describes no node at \
         all. Set `addresses = [\"g.your.node\"]` (primary first) -- see \
         docs/operators/announcing-a-node.md (issue #784)"
    )]
    AnnounceNoAddresses,

    #[error(
        "[announce] {field} is not set: a node behind TLS termination cannot learn its own \
         public name, so this is an operator fact and there is deliberately no default. The \
         retired sidecar DID default it, and its compiled-in fallback still names a `/rust/ilp` \
         path that answers 410 Gone on both devnet boxes -- a default here is how a node ends up \
         broadcasting a dead URL to the network (issue #784)"
    )]
    AnnounceMissingEndpoint { field: &'static str },

    #[error("[announce] {field} '{value}' is not a URL: {source}")]
    AnnounceInvalidUrl {
        field: &'static str,
        value: String,
        #[source]
        source: url::ParseError,
    },

    #[error(
        "[announce] {field} '{value}' has scheme '{scheme}', but this field must name one of: \
         {allowed}. The three URLs an announce carries are different things and conflating any \
         two is the bug: `http_endpoint`/`btp_endpoint` are where clients PAY this node, and \
         `relay_url` is where they READ it for FREE over a Nostr WebSocket. An `http(s)://` \
         `relay_url` in particular is the relay's PRIVATE write ingress -- announcing it \
         publishes an unauthenticated write door to every client on the network (issue #784)"
    )]
    AnnounceEndpointScheme {
        field: &'static str,
        value: String,
        scheme: String,
        allowed: String,
    },

    #[error(
        "[announce] ttl_secs is 0: a NIP-40 `expiration` tag of `created_at + 0` is already \
         expired when it is signed, so every relay honouring the tag drops the announce while \
         this file reads as configured. Omit the field for the default, or set how many seconds \
         the announce should stay live (issue #784)"
    )]
    AnnounceZeroTtl,

    #[error(
        "[announce] pay_channel '{value}' is not a 32-byte on-chain channel id: it must be 64 \
         hex characters, optionally `0x`-prefixed. This is the channel this node PAYS an \
         announce from as an ordinary client of the relay's connector -- not a \
         [[client_channels]] row, which is a channel this node RECEIVES on (issue #784)"
    )]
    AnnounceInvalidPayChannel { value: String },

    #[error("[announce] identity_key_file does not exist or is not a file: {0}")]
    AnnounceIdentityKeyFileNotFound(PathBuf),

    #[error(
        "[announce] notice_id, notice_summary and notice_url must all be set together (or none \
         at all) to configure an operator notice; notice_severity is optional and defaults to \
         \"info\" (issue #912)"
    )]
    AnnounceNoticeIncomplete,

    #[error(
        "[announce] notice_severity must be \"info\" or \"action-required\", got \"{value}\" \
         (issue #912)"
    )]
    AnnounceNoticeInvalidSeverity { value: String },

    /// The removed-section trap for purchasable peering (ADR 0043), the
    /// same shape [`ConfigError::PeerWireAddrRemoved`] and
    /// [`ConfigError::PeerCeilingRemoved`] already take: the section is
    /// still parsed so a stale config naming it stops the node by name
    /// rather than being silently dropped by `deny_unknown_fields`.
    ///
    /// One variant covers the whole table -- `prefix`, `price`,
    /// `lease_seconds` and every abuse bound -- because there is no
    /// surviving `[peer_sale]` for any of them to be written into: the
    /// fix is always to delete the section, never to correct a field.
    #[error(
        "'[peer_sale]' was removed with purchasable peering (ADR 0043) -- a peering cannot be \
         bought at all, so 'prefix', 'price', 'lease_seconds', 'max_purchased_rows', \
         'max_routes_per_payer', 'max_prefix_length', 'purchase_rate_limit' and \
         'purchase_rate_window_seconds' have nothing left to configure. Delete the whole \
         section; an operator still adds a peer and its route directly, over the operator \
         surface (POST /peers, POST /routes/peers) or in the config file"
    )]
    PeerSaleRemoved,
}
