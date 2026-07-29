//! Builds the live [`Connector`] and its signer from a validated [`Config`],
//! and merges the client-edge and operator routers into the one
//! [`axum::Router`] the binary serves. Per ADR 0001 this is where every
//! construction decision lives -- `connector-bin` calls exactly
//! [`build`] and [`router`] and branches on neither.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use axum::Router;

use connector_client_edge::{
    ChannelLookupFailed, ClientChannelRegistry, ClientChannelSource, ClientClaimGate, EvmChannel,
};
use connector_config::{Config, SecretLocation, SettlementChain, SettlementConfig};
use connector_runtime::{
    Connector, FileJournal, HttpAppClient, InMemoryJournal, Journal, JournalError,
    NetworkPeerTransport, PeerRoute, SystemClock,
};
use connector_settlement::{SettlementBackend, SettlementError};
use connector_settlement_evm::EvmSettlementBackend;
use connector_signer::{LocalSigner, Signer, SignerError};

/// Everything that can stop a validated [`Config`] from producing a live
/// [`Connector`]. Distinct from [`connector_config::ConfigError`]: the
/// config file itself was already valid TOML with well-formed fields --
/// these errors are about the world the config points at (a key file that
/// cannot be read, or a location this binary cannot yet resolve).
#[derive(Debug)]
pub enum RuntimeError {
    /// The signer's key file exists (config load already checked that) but
    /// could not be read.
    SignerKeyFileUnreadable {
        path: PathBuf,
        source: std::io::Error,
    },
    /// The signer's key file's contents are neither 32 raw bytes nor 64
    /// hex characters encoding 32 bytes.
    InvalidSignerKeyMaterial { path: PathBuf },
    /// `signer.kms_key_id` was configured, but no key management service
    /// backend is wired into this binary -- `connector-signer::KmsSigner`
    /// is a port over one, and `InMemoryKmsBackend` upholds its contract
    /// for tests, but no production backend exists in this workspace yet.
    /// Use `signer.key_file` instead.
    UnsupportedSignerLocation,
    /// The signer implementation itself rejected the key material (e.g.
    /// an all-zero secret key).
    Signer(SignerError),
    /// The `[settlement]` section's key file exists (config load already
    /// checked that) but could not be read.
    SettlementKeyFileUnreadable {
        path: PathBuf,
        source: std::io::Error,
    },
    /// The `[settlement]` section's key file's contents are neither 32
    /// raw bytes nor 64 hex characters encoding 32 bytes.
    InvalidSettlementKeyMaterial { path: PathBuf },
    /// `settlement.key.kms_key_id` was configured, but no key management
    /// service backend is wired into this binary yet -- same gap as
    /// `[signer]`'s own `kms_key_id`; use `settlement.key.key_file`
    /// instead.
    UnsupportedSettlementKeyLocation,
    /// Constructing the configured settlement backend failed -- e.g. the
    /// RPC endpoint was unreachable, or the contract address named in
    /// config has no code at it.
    Settlement(SettlementError),
    /// `state_dir` names a directory this node cannot create or write a
    /// journal file in (issue #605) -- typically a read-only mount, or a
    /// directory owned by another uid than the one the container runs as.
    /// A startup failure on purpose: the alternative is a node that serves
    /// happily and hands out free service after its next restart.
    StateDirUnusable {
        path: PathBuf,
        source: std::io::Error,
    },
    /// A journal under `state_dir` exists but could not be replayed --
    /// unreadable, or carrying a line this build cannot decode. Refusing
    /// to start is the whole point: the only other option is to start with
    /// watermarks this node cannot vouch for, which is exactly the defect
    /// issue #605 describes.
    JournalUnreplayable { path: PathBuf, source: JournalError },
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RuntimeError::SignerKeyFileUnreadable { path, source } => write!(
                f,
                "failed to read signer key_file at {}: {source}",
                path.display()
            ),
            RuntimeError::InvalidSignerKeyMaterial { path } => write!(
                f,
                "signer key_file at {} must contain either 32 raw bytes or \
                 64 hex characters encoding a 32-byte secret key",
                path.display()
            ),
            RuntimeError::UnsupportedSignerLocation => write!(
                f,
                "signer.kms_key_id is configured, but no key management \
                 service backend is wired into this binary yet -- use \
                 signer.key_file"
            ),
            RuntimeError::Signer(source) => write!(f, "{source}"),
            RuntimeError::SettlementKeyFileUnreadable { path, source } => write!(
                f,
                "failed to read settlement key_file at {}: {source}",
                path.display()
            ),
            RuntimeError::InvalidSettlementKeyMaterial { path } => write!(
                f,
                "settlement key_file at {} must contain either 32 raw bytes or \
                 64 hex characters encoding a 32-byte secret key",
                path.display()
            ),
            RuntimeError::UnsupportedSettlementKeyLocation => write!(
                f,
                "settlement.key.kms_key_id is configured, but no key management \
                 service backend is wired into this binary yet -- use \
                 settlement.key.key_file"
            ),
            RuntimeError::Settlement(source) => {
                write!(
                    f,
                    "failed to construct the configured settlement backend: {source}"
                )
            }
            RuntimeError::StateDirUnusable { path, source } => write!(
                f,
                "state_dir {} is not usable for this node's claim journals: {source} -- \
                 the connector refuses to start rather than keep claim watermarks only in \
                 memory, where a restart would make every already-spent claim replayable",
                path.display()
            ),
            RuntimeError::JournalUnreplayable { path, source } => write!(
                f,
                "failed to replay the claim journal at {}: {source} -- the connector \
                 refuses to start rather than resume from watermarks it cannot vouch for",
                path.display()
            ),
        }
    }
}

impl std::error::Error for RuntimeError {}

impl From<SignerError> for RuntimeError {
    fn from(source: SignerError) -> Self {
        RuntimeError::Signer(source)
    }
}

impl From<SettlementError> for RuntimeError {
    fn from(source: SettlementError) -> Self {
        RuntimeError::Settlement(source)
    }
}

/// Decode a signer key file's raw bytes into a 32-byte secret key: either
/// exactly 32 raw bytes, or 64 hex characters (surrounding whitespace
/// ignored) encoding 32 bytes. Both are legitimate ways to hand-author or
/// generate a key file, so both are accepted.
fn decode_secret_key(bytes: &[u8]) -> Option<[u8; 32]> {
    if let Ok(text) = std::str::from_utf8(bytes) {
        let trimmed = text.trim();
        if trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
            let mut out = [0u8; 32];
            for (i, byte) in out.iter_mut().enumerate() {
                *byte = u8::from_str_radix(&trimmed[i * 2..i * 2 + 2], 16).ok()?;
            }
            return Some(out);
        }
    }
    if bytes.len() == 32 {
        let mut out = [0u8; 32];
        out.copy_from_slice(bytes);
        return Some(out);
    }
    None
}

fn build_signer(location: &SecretLocation) -> Result<Arc<dyn Signer>, RuntimeError> {
    match location {
        SecretLocation::File(path) => {
            let bytes =
                std::fs::read(path).map_err(|source| RuntimeError::SignerKeyFileUnreadable {
                    path: path.clone(),
                    source,
                })?;
            let secret = decode_secret_key(&bytes)
                .ok_or_else(|| RuntimeError::InvalidSignerKeyMaterial { path: path.clone() })?;
            let signer = LocalSigner::from_secret_bytes("connector-signer", secret)?;
            Ok(Arc::new(signer))
        }
        SecretLocation::Kms { .. } => Err(RuntimeError::UnsupportedSignerLocation),
    }
}

/// Encode 32 raw bytes as 64 lowercase hex characters -- what
/// `ethers::signers::LocalWallet`'s `FromStr` impl expects,
/// [`EvmSettlementBackend::connect`]'s `private_key` argument.
fn hex_encode_32(bytes: [u8; 32]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Resolve the `[settlement.key]` section to the hex-encoded secp256k1
/// private key `EvmSettlementBackend` signs with -- the same "32 raw bytes
/// or 64 hex characters" key-file shape [`build_signer`] already reads for
/// `[signer]`, since both are just secret-key pointers.
fn read_settlement_private_key(location: &SecretLocation) -> Result<String, RuntimeError> {
    match location {
        SecretLocation::File(path) => {
            let bytes = std::fs::read(path).map_err(|source| {
                RuntimeError::SettlementKeyFileUnreadable {
                    path: path.clone(),
                    source,
                }
            })?;
            let secret = decode_secret_key(&bytes)
                .ok_or_else(|| RuntimeError::InvalidSettlementKeyMaterial { path: path.clone() })?;
            Ok(hex_encode_32(secret))
        }
        SecretLocation::Kms { .. } => Err(RuntimeError::UnsupportedSettlementKeyLocation),
    }
}

/// Construct the settlement backend a `[settlement]` section describes,
/// connecting to the already-deployed `TokenNetworkRegistry` it names
/// (issue #576) -- `contract_address` -- and resolving the `TokenNetwork`
/// it actually drives through `token_address`, rather than deploying a
/// fresh one (issue #542) -- only [`SettlementChain::Evm`] is constructible
/// today, matching the one chain `connector-config` accepts at load time.
///
/// Every field of the section reaches the chain here: `decimals` is handed
/// to [`EvmSettlementBackend::connect`], which refuses to connect when the
/// configured scale and the token's own `decimals()` disagree (issue #564).
/// A `[settlement]` section that names a scale the deployed token does not
/// agree with is a startup failure, not a line with no effect (ADR 0009).
async fn build_settlement_backend(
    settlement: &SettlementConfig,
) -> Result<Arc<EvmSettlementBackend>, RuntimeError> {
    match settlement.chain() {
        SettlementChain::Evm => {
            let private_key = read_settlement_private_key(settlement.key())?;
            let registry_address = ethers::types::Address::from(settlement.contract_address());
            let token_address = ethers::types::Address::from(settlement.token_address());
            let backend = EvmSettlementBackend::connect(
                settlement.rpc_url(),
                &private_key,
                registry_address,
                token_address,
                settlement.decimals(),
            )
            .await?;
            Ok(Arc::new(backend))
        }
    }
}

/// The client edge's channel records, read from the same deployed
/// `TokenNetwork` the `[settlement]` section already names (issue #556).
///
/// This is the seam issue #607 left for this work. Before it, the only
/// source of a channel's counterparty was the `[[client_channels]]` config
/// section, so a node whose operator had not written a buyer's channel
/// down by hand refused that buyer's every claim -- which contradicts
/// issue #502's *"anonymity is a first-class path, not a fallback: it is
/// how an unaffiliated buyer pays for a terminated route without
/// registering with the operator first"*. A buyer registers on chain
/// instead, and this reads that registration.
///
/// A newtype rather than an `impl` on [`EvmSettlementBackend`] itself
/// because both the trait and the type are foreign to this crate; keeping
/// the adapter here also keeps `connector-settlement-evm` free of any
/// dependency on the HTTP edge, and matches ADR 0001's rule that
/// construction decisions live in `connector-cli`.
struct SettlementChannelSource {
    backend: Arc<EvmSettlementBackend>,
}

/// Hand-written because [`EvmSettlementBackend`] holds contract handles
/// and a signing client that are not `Debug`, and
/// [`ClientChannelSource`] requires it so a registry can name its source
/// in a log line. Names the deployment rather than dumping the client.
impl fmt::Debug for SettlementChannelSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SettlementChannelSource")
            .field("token_network", &self.backend.address())
            .field("chain_id", &self.backend.chain_id())
            .finish()
    }
}

#[async_trait]
impl ClientChannelSource for SettlementChannelSource {
    async fn evm_channel(
        &self,
        channel_id: &[u8; 32],
    ) -> Result<Option<EvmChannel>, ChannelLookupFailed> {
        let counterparty = self
            .backend
            .channel_counterparty(*channel_id)
            .await
            .map_err(|error| ChannelLookupFailed(error.to_string()))?;
        // The signing domain comes from the same deployment the
        // counterparty did (issue #556's open question): `TokenNetwork`
        // inherits OpenZeppelin's `EIP712("TokenNetwork", "1")`, whose
        // domain separator is built from `block.chainid` and
        // `address(this)`, so a per-entry config field for either could
        // only ever restate -- or contradict -- what the chain says.
        Ok(counterparty.map(|counterparty| EvmChannel {
            counterparty: counterparty.to_fixed_bytes(),
            chain_id: self.backend.chain_id(),
            token_network_address: self.backend.address().to_fixed_bytes(),
        }))
    }
}

/// The two journal files a node keeps under its `state_dir` (issue #605).
/// Two files rather than one because they are two different books --
/// `ClaimBook`'s channel ids are peer-wire channels, the client edge's are
/// chain-namespaced client channels -- and because each is replayed by a
/// different owner at startup; sharing one file would mean each replaying
/// the other's entries and each holding a second writer's file handle on
/// the same path.
const PEER_WIRE_JOURNAL: &str = "peer-claims.log";
const CLIENT_EDGE_JOURNAL: &str = "client-edge-claims.log";

/// Open `name` under this node's configured `state_dir`, creating the
/// directory if it is not there yet.
///
/// Opening happens at startup, before anything is served, precisely so a
/// node with nowhere writable fails here -- with the path in the message --
/// rather than at the first claim, hours later, on a packet path where the
/// only honest answer left is to refuse the claim (issue #605).
fn open_journal(state_dir: &Path, name: &str) -> Result<Arc<dyn Journal>, RuntimeError> {
    std::fs::create_dir_all(state_dir).map_err(|source| RuntimeError::StateDirUnusable {
        path: state_dir.to_path_buf(),
        source,
    })?;
    let path = state_dir.join(name);
    let journal = FileJournal::open(&path).map_err(|source| match source {
        JournalError::Io(source) => RuntimeError::StateDirUnusable {
            path: path.clone(),
            source,
        },
        source => RuntimeError::JournalUnreplayable {
            path: path.clone(),
            source,
        },
    })?;
    Ok(Arc::new(journal))
}

/// Everything [`build`] produced from a validated [`Config`], and
/// everything [`router`] needs from it. A struct rather than a tuple
/// because the third member is the kind of thing that only ever grows: as
/// issue #556 arms more of the node, more of what `build` connects has to
/// reach the routers without being reconstructed (and, for a chain
/// connection, without being connected twice).
pub struct Runtime {
    pub connector: Arc<Connector>,
    pub signer: Arc<dyn Signer>,
    /// Where the client edge resolves a payment channel nothing declared
    /// (issue #556) -- `Some` exactly when `[settlement]` is configured,
    /// since the deployed `TokenNetwork` it names is what holds the
    /// answer. `None` leaves the client edge with only `[[client_channels]]`
    /// to go on, which is what a node with no settlement backend has.
    pub client_channel_source: Option<Arc<dyn ClientChannelSource>>,
}

/// Construct the live [`Connector`] and [`Signer`] a validated [`Config`]
/// describes. Every configured `[[peers]]` entry is dialed lazily through a
/// [`NetworkPeerTransport`] (issue #488 -- peer addressing finally has a
/// config-file representation, closing the gap #416 deferred), and every
/// `peer_id`-targeted `[[routes]]` entry becomes a [`PeerRoute`] alongside
/// the terminated [`connector_config::StaticRoute`]s. If `[settlement]` is
/// configured, this connects a real chain-backed [`SettlementBackend`] and
/// attaches it via [`Connector::with_settlement`] (issue #542) -- that
/// connection is why this function is `async` at all; an unconfigured node
/// still builds with no settlement backend, same as before this section
/// existed.
///
/// That same connection is handed to [`router`] as a
/// [`ClientChannelSource`] (issue #556): one chain connection, used both
/// to move value and to read who a channel belongs to.
///
/// A node that names a `state_dir` also has its peer-wire claim journal
/// armed here (issue #605), so the watermarks that wire's `ClaimBook`
/// keeps outlive the process exactly as the client edge's do.
pub async fn build(config: &Config) -> Result<Runtime, RuntimeError> {
    let signer = build_signer(config.signer_key())?;
    let mut peer_transport = NetworkPeerTransport::new();
    for peer in config.peers() {
        peer_transport.add_peer(peer.id().to_string(), peer.addr());
    }
    let peer_routes = config
        .peer_routes()
        .iter()
        .map(|route| PeerRoute::new(route.prefix(), route.peer_id(), route.fee()))
        .collect();
    let mut connector = Connector::new(
        config.routes().to_vec(),
        peer_routes,
        Arc::new(HttpAppClient::new()),
        Arc::new(peer_transport),
        Arc::new(SystemClock),
    )
    .with_identity_signer(signer.clone());
    let mut client_channel_source: Option<Arc<dyn ClientChannelSource>> = None;
    if let Some(settlement) = config.settlement() {
        let backend = build_settlement_backend(settlement).await?;
        client_channel_source = Some(Arc::new(SettlementChannelSource {
            backend: backend.clone(),
        }));
        connector = connector.with_settlement(backend as Arc<dyn SettlementBackend>);
    }
    // The peer wire's own claim watermarks and exposure, made durable by
    // the same `state_dir` the client edge's are (issue #605, and #556's
    // reconciliation row "Journal: `ClaimBook::new(None, ..)` installs the
    // in-memory journal ... watermarks reset on restart; spent nonces
    // respend"). Both surfaces are the same sentence -- a watermark must
    // outlive the process -- so they get the same answer rather than two,
    // and arming one while leaving the other in memory would mean shipping
    // the fix and the bug side by side.
    if let Some(state_dir) = config.state_dir() {
        let journal = open_journal(state_dir, PEER_WIRE_JOURNAL)?;
        let (armed, divergences) = connector.with_journal(journal).map_err(|source| {
            RuntimeError::JournalUnreplayable {
                path: state_dir.join(PEER_WIRE_JOURNAL),
                source,
            }
        })?;
        connector = armed;
        for divergence in divergences {
            // Reported, never absorbed (issue #424). Not fatal: a
            // divergence is an accounting disagreement inside a journal
            // that replayed fine, not a journal this node cannot trust to
            // have replayed at all.
            tracing::error!(%divergence, "replaying the peer-wire journal found a divergence");
        }
    }
    Ok(Runtime {
        connector: Arc::new(connector),
        signer,
        client_channel_source,
    })
}

/// The channels this node accepts client-edge claims on, and whose
/// counterparty each claim's signature must recover to (issues #558,
/// #556): everything `[[client_channels]]` declares, plus -- when
/// `[settlement]` is configured -- the deployed `TokenNetwork` itself, for
/// any channel the config file does not mention.
///
/// The two compose rather than replace each other. A declared channel is
/// still answered from config without touching a chain, so a node with no
/// settlement backend still declares its channels and a node whose RPC
/// endpoint is down still serves the channels it wrote down. What the
/// source adds is the case `[[client_channels]]` cannot express: a buyer
/// this operator has never heard of, who opened a channel on chain and
/// wants to pay for a write (issue #502).
///
/// A node with neither still has a record of no channel and refuses every
/// claim -- deliberately, since the only alternative to "no record of this
/// channel" is trusting what the claim says about its own signer, which is
/// exactly the hole #558 closes.
fn client_channels(
    config: &Config,
    source: Option<Arc<dyn ClientChannelSource>>,
) -> ClientChannelRegistry {
    let mut channels = ClientChannelRegistry::new();
    for channel in config.client_channels() {
        channels
            .record_evm(
                channel.channel_id(),
                EvmChannel {
                    counterparty: channel.counterparty(),
                    chain_id: channel.chain_id(),
                    token_network_address: channel.token_network_address(),
                },
            )
            .expect("config load already validated every channel_id as a 32-byte identifier");
    }
    match source {
        Some(source) => channels.with_source(source),
        None => channels,
    }
}

/// The client edge's claim gate: the channels this node accepts claims on,
/// resumed from the watermarks its journal already records (issue #605).
///
/// A node with no `state_dir` gets an in-memory journal, which is sound
/// only because [`Config::load`] has already refused any config that both
/// omits `state_dir` and configures a channel to accept claims on: such a
/// gate refuses every claim as unknown, so it has no watermark to lose.
///
/// `source` is threaded straight through to [`client_channels`] (issue
/// #556): a gate resolves an undeclared channel from the chain and
/// journals its watermark like any other, so the unaffiliated buyer's
/// claims are exactly as replay-proof across a restart as a declared
/// buyer's are.
fn client_claim_gate(
    config: &Config,
    source: Option<Arc<dyn ClientChannelSource>>,
) -> Result<ClientClaimGate, RuntimeError> {
    let (journal, path) = match config.state_dir() {
        Some(state_dir) => (
            open_journal(state_dir, CLIENT_EDGE_JOURNAL)?,
            state_dir.join(CLIENT_EDGE_JOURNAL),
        ),
        None => (
            Arc::new(InMemoryJournal::new()) as Arc<dyn Journal>,
            PathBuf::from(CLIENT_EDGE_JOURNAL),
        ),
    };
    ClientClaimGate::restore(client_channels(config, source), journal)
        .map_err(|source| RuntimeError::JournalUnreplayable { path, source })
}

/// Merge the client edge and (if `[operator]` is configured) the operator
/// surface into the one router the binary serves. The operator router is
/// mounted only when [`Config::operator`] is `Some` -- absence means the
/// surface is not started at all, exactly as it means for
/// [`connector_operator::router`] itself.
///
/// Fallible since issue #605: the client edge's claim gate is restored from
/// a durable journal here, and a journal that will not replay must stop the
/// node starting rather than let it start at no watermarks.
pub fn router(runtime: &Runtime, config: &Config) -> Result<Router, RuntimeError> {
    let connector = runtime.connector.clone();
    let signer = runtime.signer.clone();
    let app = connector_client_edge::router_with_gate(
        connector.clone(),
        signer.clone(),
        None,
        client_claim_gate(config, runtime.client_channel_source.clone())?,
    );
    Ok(match config.operator() {
        Some(operator) => app.merge(connector_operator::router(
            connector,
            signer,
            operator.bearer_token().to_string(),
            operator.write_keys().to_vec(),
        )),
        None => app,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use std::io::Write;
    use tower::ServiceExt;

    fn load_config(text: &str) -> Config {
        let mut config_file = tempfile::NamedTempFile::new().expect("temp config file");
        write!(config_file, "{text}").expect("write config file");
        Config::load(config_file.path()).expect("load config")
    }

    /// Returns the loaded [`Config`] together with the [`tempfile::TempPath`]
    /// its `signer.key_file` points at -- the caller must keep the returned
    /// path alive (a binding, not `_`) for as long as anything still needs
    /// to read the key file, since [`build`] re-reads it rather than
    /// caching its bytes at config-load time.
    fn config_with_raw_key_file(
        body: impl FnOnce(&std::path::Path) -> String,
    ) -> (Config, tempfile::TempPath) {
        let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
        key_file
            .write_all(&[7u8; 32])
            .expect("write raw 32-byte key");
        let key_path = key_file.into_temp_path();
        let config = load_config(&body(&key_path));
        (config, key_path)
    }

    #[tokio::test]
    async fn builds_a_connector_from_a_raw_32_byte_key_file() {
        let (config, _key_path) = config_with_raw_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"
"#,
                key_path.display()
            )
        });

        let runtime = build(&config).await.expect("build");
        assert!(runtime.connector.routes().is_empty());
    }

    #[tokio::test]
    async fn builds_a_signer_from_a_hex_encoded_key_file() {
        let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
        key_file
            .write_all(b"0707070707070707070707070707070707070707070707070707070707070707")
            .expect("write hex key");
        let config = load_config(&format!(
            r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"
"#,
            key_file.path().display()
        ));

        let result = build(&config).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn rejects_key_material_that_is_neither_32_bytes_nor_64_hex_chars() {
        let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
        key_file
            .write_all(b"not real key material")
            .expect("write bad key");
        let config = load_config(&format!(
            r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"
"#,
            key_file.path().display()
        ));

        let result = build(&config).await;
        assert!(matches!(
            result,
            Err(RuntimeError::InvalidSignerKeyMaterial { .. })
        ));
    }

    #[tokio::test]
    async fn a_kms_location_is_an_explicit_unsupported_error_not_a_panic() {
        let config = load_config(
            r#"
client_edge_addr = "127.0.0.1:0"

[signer]
kms_key_id = "arn:aws:kms:us-east-1:123:key/abc"
"#,
        );

        let result = build(&config).await;
        assert!(matches!(
            result,
            Err(RuntimeError::UnsupportedSignerLocation)
        ));
    }

    #[tokio::test]
    async fn router_mounts_only_the_client_edge_when_no_operator_section_is_configured() {
        let (config, _key_path) = config_with_raw_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"
"#,
                key_path.display()
            )
        });
        let runtime = build(&config).await.expect("build");
        let app = router(&runtime, &config).expect("router");

        // No `[operator]` section: `/routes` (an operator-surface path)
        // 404s -- it was never merged in, rather than merged in and
        // rejecting for lack of a bearer token.
        let request = Request::builder()
            .uri("/routes")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    /// A node with no `[[client_channels]]` has a record of no channel, so
    /// its client edge refuses every claim rather than trusting a claim's
    /// own declared signer (issue #558).
    #[test]
    fn a_node_configuring_no_client_channels_has_a_record_of_none() {
        let (config, _key_path) = config_with_raw_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"
"#,
                key_path.display()
            )
        });

        assert!(client_channels(&config, None).is_empty());
    }

    /// Every configured channel reaches the client edge's registry, so a
    /// claim on it is verified against the counterparty the operator
    /// declared -- and a claim on any other channel is not (issue #558).
    #[test]
    fn every_configured_client_channel_is_recorded() {
        let state_dir = tempfile::tempdir().expect("temp state dir");
        let (config, _key_path) = config_with_raw_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:0"
state_dir = "{state_dir}"

[signer]
key_file = "{key_path}"

[[client_channels]]
channel_id = "0x{channel}"
counterparty = "0x00000000000000000000000000000000000000aa"
chain_id = 8453
token_network_address = "0x00000000000000000000000000000000000000bb"
"#,
                key_path = key_path.display(),
                state_dir = state_dir.path().display(),
                channel = "ab".repeat(32),
            )
        });

        let channels = client_channels(&config, None);
        assert!(!channels.is_empty());
        assert_eq!(config.client_channels()[0].chain_id(), 8453);
        assert_eq!(config.client_channels()[0].counterparty()[19], 0xaa);
    }

    /// Issue #605's startup half: a node that names a `state_dir` gets a
    /// real, on-disk claim gate, and the file it journals to is under that
    /// directory -- which is what an operator has to mount for the
    /// watermarks to outlive the container.
    #[test]
    fn a_configured_state_dir_is_where_the_client_edge_journals() {
        let state_dir = tempfile::tempdir().expect("temp state dir");
        let (config, _key_path) = config_with_raw_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:0"
state_dir = "{state_dir}"

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
                state_dir = state_dir.path().display(),
            )
        });

        client_claim_gate(&config, None).expect("a writable state_dir produces a gate");
        assert!(
            state_dir.path().join(CLIENT_EDGE_JOURNAL).exists(),
            "the journal file is created at startup, not lazily at the first claim"
        );
    }

    /// A `state_dir` this node cannot write is a startup failure naming the
    /// path -- not a node that serves happily and forgets every spent claim
    /// at its next restart (issue #605).
    #[test]
    fn a_state_dir_that_cannot_be_created_refuses_to_build_a_gate() {
        let blocker = tempfile::NamedTempFile::new().expect("temp file");
        // A regular file where a directory is asked for: `create_dir_all`
        // cannot make this into a directory, exactly as it cannot make a
        // directory under a read-only mount.
        let state_dir = blocker.path().join("state");
        let (config, _key_path) = config_with_raw_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:0"
state_dir = "{state_dir}"

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
                state_dir = state_dir.display(),
            )
        });

        let Err(error) = client_claim_gate(&config, None) else {
            panic!("an unusable state_dir must not produce a gate");
        };
        assert!(matches!(error, RuntimeError::StateDirUnusable { .. }));
        let message = error.to_string();
        assert!(
            message.contains(&state_dir.display().to_string()),
            "the failure must name the path an operator has to fix: {message}"
        );
    }

    /// A journal carrying a line this build cannot decode stops the node
    /// starting. The alternative -- skipping the line, or starting empty --
    /// is precisely the "silently start from zero" this ticket forbids.
    #[test]
    fn a_corrupt_client_edge_journal_refuses_to_build_a_gate() {
        let state_dir = tempfile::tempdir().expect("temp state dir");
        std::fs::write(
            state_dir.path().join(CLIENT_EDGE_JOURNAL),
            "not a journal entry\n",
        )
        .expect("write a corrupt journal");
        let (config, _key_path) = config_with_raw_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:0"
state_dir = "{state_dir}"

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
                state_dir = state_dir.path().display(),
            )
        });

        let Err(error) = client_claim_gate(&config, None) else {
            panic!("a corrupt journal must not produce a gate");
        };
        assert!(matches!(error, RuntimeError::JournalUnreplayable { .. }));
    }

    /// The peer wire's own journal is armed off the same `state_dir`
    /// (issue #605, #556's "Journal" row): one answer for both surfaces,
    /// not a fix for the client edge and the same bug left standing on the
    /// wire between connectors.
    #[tokio::test]
    async fn a_configured_state_dir_also_arms_the_peer_wire_journal() {
        let state_dir = tempfile::tempdir().expect("temp state dir");
        let (config, _key_path) = config_with_raw_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:0"
state_dir = "{state_dir}"

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
                state_dir = state_dir.path().display(),
            )
        });

        let _runtime = build(&config).await.expect("build");
        assert!(state_dir.path().join(PEER_WIRE_JOURNAL).exists());
    }

    /// A node with no `state_dir` still builds -- config load has already
    /// guaranteed it has no channel to accept a claim on, so it has no
    /// watermark a restart could lose.
    #[tokio::test]
    async fn a_node_with_no_state_dir_and_no_client_channels_still_builds() {
        let (config, _key_path) = config_with_raw_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"
"#,
                key_path.display()
            )
        });

        let runtime = build(&config).await.expect("build");
        assert!(router(&runtime, &config).is_ok());
    }

    #[tokio::test]
    async fn router_mounts_the_operator_surface_when_configured() {
        let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let (config, _key_path) = config_with_raw_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"

[operator]
bearer_token = "operator-secret"
write_keys = ["{key}"]
"#,
                key_path.display()
            )
        });
        let runtime = build(&config).await.expect("build");
        let app = router(&runtime, &config).expect("router");

        // The operator surface is mounted: `/routes` is a real path now,
        // rejecting for lack of a bearer token rather than 404ing.
        let request = Request::builder()
            .uri("/routes")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    mod settlement_construction {
        use super::*;
        use chrono::Duration;
        use connector_settlement_evm::test_support::{
            anvil_available, Anvil, DEPLOYER_PRIVATE_KEY,
        };
        use ethers::signers::Signer as EvmSigner;

        /// This test binary's own base port for [`Anvil::spawn`] -- distinct
        /// from other test binaries' bases (`connector-settlement-evm`'s own
        /// tests use 18_600; `connector-bin`'s use 18_500;
        /// `connector-cli`'s own `settlement_lifecycle` integration test
        /// uses 18_800) so that binaries running concurrently under `cargo
        /// test --workspace` don't contend for the same port range.
        const ANVIL_BASE_PORT: u16 = 18_700;

        fn key_file_with(contents: &str) -> tempfile::TempPath {
            let mut file = tempfile::NamedTempFile::new().expect("temp key file");
            file.write_all(contents.as_bytes()).expect("write key file");
            file.into_temp_path()
        }

        /// AC: "`connector-cli::runtime::build` constructs the configured
        /// backend and passes it to `Connector::with_settlement`, so a node
        /// with settlement configured never answers `NoSettlementBackend`" --
        /// driven against a real, disposable `anvil` chain end to end:
        /// `build` reads the `[settlement]` section from a config file (no
        /// backend injected directly), and the resulting `Connector` opens a
        /// real channel against a real, freshly deployed `TokenNetwork`,
        /// resolved through a freshly deployed registry.
        #[tokio::test]
        async fn a_configured_settlement_section_is_constructed_and_attached() {
            if !anvil_available() {
                eprintln!(
                    "skipping: `anvil` not found on PATH (install via https://getfoundry.sh)"
                );
                return;
            }

            let anvil = Anvil::spawn(ANVIL_BASE_PORT).await;
            let token = EvmSettlementBackend::deploy_mock_token(
                &anvil.rpc_url,
                DEPLOYER_PRIVATE_KEY,
                1_000_000,
            )
            .await
            .expect("deploy mock USDC");
            let settlement_backend =
                EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, token)
                    .await
                    .expect("deploy a TokenNetwork through a fresh registry");
            let registry_address = settlement_backend.registry_address();
            drop(settlement_backend);

            let key_path = key_file_with(DEPLOYER_PRIVATE_KEY);
            let config = load_config(&format!(
                r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{key_path}"

[settlement]
chain = "evm"
rpc_url = "{rpc_url}"
contract_address = "{registry_address:?}"
token_address = "{token:?}"
decimals = 6

[settlement.key]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
                rpc_url = anvil.rpc_url,
                registry_address = registry_address,
                token = token,
            ));

            let runtime = build(&config).await.expect("build");
            let connector = runtime.connector.clone();
            // A real 20-byte EVM address (issue #576): `TokenNetwork`
            // requires a counterparty able to sign balance proofs, not an
            // arbitrary peer name.
            let counterparty =
                ethers::signers::LocalWallet::new(&mut ethers::core::rand::thread_rng())
                    .address()
                    .as_bytes()
                    .to_vec();
            let opened = connector
                .open_channel(counterparty, Duration::seconds(3600))
                .await
                .expect("a settlement backend was constructed and attached");
            assert_eq!(opened.deposited, 0);
        }

        /// AC (issue #564): "`decimals` is honoured: ... startup compares
        /// it with the token contract's own `decimals()` and refuses to
        /// start when the two disagree, naming both". The mock USDC
        /// deployed below is 6-decimal, as every token in this fleet is
        /// (`docs/usdc-cross-chain-settlement.md`); a config file claiming
        /// `decimals = 18` against it must fail to build rather than load
        /// clean and settle at a scale nobody consults.
        #[tokio::test]
        async fn settlement_decimals_the_token_disagrees_with_refuses_to_build() {
            if !anvil_available() {
                eprintln!(
                    "skipping: `anvil` not found on PATH (install via https://getfoundry.sh)"
                );
                return;
            }

            let anvil = Anvil::spawn(ANVIL_BASE_PORT).await;
            let token = EvmSettlementBackend::deploy_mock_token(
                &anvil.rpc_url,
                DEPLOYER_PRIVATE_KEY,
                1_000_000,
            )
            .await
            .expect("deploy mock USDC");
            let settlement_backend =
                EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, token)
                    .await
                    .expect("deploy a TokenNetwork through a fresh registry");
            let registry_address = settlement_backend.registry_address();
            drop(settlement_backend);

            let key_path = key_file_with(DEPLOYER_PRIVATE_KEY);
            let config = load_config(&format!(
                r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{key_path}"

[settlement]
chain = "evm"
rpc_url = "{rpc_url}"
contract_address = "{registry_address:?}"
token_address = "{token:?}"
decimals = 18

[settlement.key]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
                rpc_url = anvil.rpc_url,
                registry_address = registry_address,
                token = token,
            ));

            let error = build(&config)
                .await
                .err()
                .expect("a decimals the token disagrees with refuses to build");
            let message = error.to_string();
            // Both values are named, so an operator reading the failure can
            // tell which side is wrong without opening a block explorer.
            assert!(
                message.contains("decimals is 18") && message.contains("decimals() = 6"),
                "the failure must name both the configured and the on-chain decimals: {message}"
            );
        }

        /// AC: "a node with no settlement section still starts and still
        /// serves, degrading exactly as an absent `[operator]` section
        /// does" -- no anvil needed here, since nothing should even try to
        /// connect to a chain.
        #[tokio::test]
        async fn no_settlement_section_still_builds_and_degrades_to_no_backend() {
            let (config, _key_path) = config_with_raw_key_file(|key_path| {
                format!(
                    r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"
"#,
                    key_path.display()
                )
            });

            let runtime = build(&config).await.expect("build");
            let result = runtime
                .connector
                .open_channel(b"no-settlement-peer".to_vec(), Duration::seconds(3600))
                .await;
            assert!(matches!(
                result,
                Err(connector_runtime::ChannelOperationError::NoSettlementBackend)
            ));
        }
    }
}
