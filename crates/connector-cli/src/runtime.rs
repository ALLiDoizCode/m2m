//! Builds the live [`Connector`] and its signer from a validated [`Config`],
//! and merges the client-edge and operator routers into the one
//! [`axum::Router`] the binary serves. Per ADR 0001 this is where every
//! construction decision lives -- `connector-bin` calls exactly
//! [`build`] and [`router`] and branches on neither.

use std::fmt;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;

use async_trait::async_trait;
use axum::Router;

use connector_client_edge::{
    ChannelLivenessPolicy, ChannelLookupFailed, ClientChannelRegistry, ClientChannelSource,
    ClientClaimGate, ClientPayoutLedger, DepositFloor, EvmChannel, PeerCarriages, SolanaChannel,
    UnresolvableLookupBudgetPolicy,
};
use connector_config::{
    ClientChannelConfig, Config, EvmSettlementConfig, PeerChannelConfig, SecretLocation,
    SettlementChain, SettlementConfig, SolanaSettlementConfig,
};
use connector_runtime::{
    ChannelDomain, Connector, FileJournal, HttpAppClient, InMemoryJournal, Journal, JournalError,
    PeerRoute, PeerRouteStore, PeerRouteStoreError, SystemClock,
};
use connector_settlement::{SettlementBackend, SettlementError};
use connector_settlement_evm::{
    ChannelIndexLookup, EvmChannelIndex, EvmChannelIndexSyncer, EvmSettlementBackend,
    DEFAULT_POLL_INTERVAL,
};
use connector_settlement_solana::SolanaSettlementBackend;
use connector_signer::{derive_evm_address, LocalSigner, Signer, SignerError};

use crate::peer_transport;
use ethers::types::U256;
use solana_sdk::pubkey::Pubkey;

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
    /// Issue #884's runtime peer/route table under `state_dir` exists but
    /// could not be read (unreadable, or corrupt JSON) -- refusing to
    /// start rather than serve with a table this node cannot vouch for,
    /// the same reasoning `JournalUnreplayable` applies to a claim
    /// journal.
    RuntimePeerRouteTableUnusable {
        path: PathBuf,
        source: PeerRouteStoreError,
    },
    /// The local EVM channel index's durable snapshot under `state_dir`
    /// exists but could not be read (unreadable, or corrupt JSON) -- issue
    /// #661, same reasoning as [`RuntimeError::RuntimePeerRouteTableUnusable`]:
    /// this index is rebuildable from chain, but a corrupt file on disk is
    /// still refused rather than silently discarded, so an operator sees
    /// the problem instead of an unexplained full re-backfill.
    EvmChannelIndexUnusable {
        path: PathBuf,
        source: connector_settlement_evm::EvmChannelIndexError,
    },
    /// A `[[peer_channels]]` row's `channel_id` is not a shape
    /// [`connector_runtime::ClaimBook`] can file a watermark under (issue
    /// #678). Unreachable through `Config::load`, which canonicalizes the
    /// id to `0x` + 64 lowercase hex before this code ever sees it -- kept
    /// as a named startup failure rather than an `expect` so a future
    /// widening of the config shape refuses to start instead of panicking
    /// on the first peer claim.
    PeerChannelUnusable { channel_id: String },
    /// `[announce] identity_key_file`'s path exists (config load already
    /// checked that) but could not be read.
    AnnounceIdentityKeyFileUnreadable {
        path: PathBuf,
        source: std::io::Error,
    },
    /// `[announce] identity_key_file`'s contents are neither 32 raw bytes
    /// nor 64 hex characters encoding 32 bytes.
    InvalidAnnounceIdentityKeyMaterial { path: PathBuf },
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
            RuntimeError::PeerChannelUnusable { channel_id } => write!(
                f,
                "the [[peer_channels]] row for channel '{channel_id}' names an id the claim \
                 ledger cannot file a watermark under -- a peer channel id must be the \
                 channel's on-chain bytes32"
            ),
            RuntimeError::JournalUnreplayable { path, source } => write!(
                f,
                "failed to replay the claim journal at {}: {source} -- the connector \
                 refuses to start rather than resume from watermarks it cannot vouch for",
                path.display()
            ),
            RuntimeError::RuntimePeerRouteTableUnusable { path, source } => write!(
                f,
                "failed to read the runtime peer/route table at {}: {source} -- the connector \
                 refuses to start rather than serve with a peer/route table it cannot vouch for",
                path.display()
            ),
            RuntimeError::EvmChannelIndexUnusable { path, source } => write!(
                f,
                "failed to read the local EVM channel index at {}: {source} -- the connector \
                 refuses to start rather than serve with a channel index it cannot vouch for. \
                 Since this index is rebuildable from chain, removing the file lets the node \
                 start and re-backfill from channel_index_from_block instead",
                path.display()
            ),
            RuntimeError::AnnounceIdentityKeyFileUnreadable { path, source } => write!(
                f,
                "failed to read [announce] identity_key_file at {}: {source}",
                path.display()
            ),
            RuntimeError::InvalidAnnounceIdentityKeyMaterial { path } => write!(
                f,
                "[announce] identity_key_file at {} must contain either 32 raw bytes or \
                 64 hex characters encoding a 32-byte secret key",
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

/// The raw 32-byte identity secret `[signer]` points at.
///
/// Exposed to the crate (issue #784) because a kind:10032 announce is signed
/// BIP-340 Schnorr over the event's own id, which needs the scalar itself
/// rather than a [`Signer`]'s recoverable-ECDSA `sign` -- see
/// `connector_signer::nostr`. Nothing outside this crate can call it: key
/// material stays behind `connector-signer` and the one function here that
/// already had to read it.
pub(crate) fn read_signer_secret(location: &SecretLocation) -> Result<[u8; 32], RuntimeError> {
    match location {
        SecretLocation::File(path) => {
            let bytes =
                std::fs::read(path).map_err(|source| RuntimeError::SignerKeyFileUnreadable {
                    path: path.clone(),
                    source,
                })?;
            decode_secret_key(&bytes)
                .ok_or_else(|| RuntimeError::InvalidSignerKeyMaterial { path: path.clone() })
        }
        SecretLocation::Kms { .. } => Err(RuntimeError::UnsupportedSignerLocation),
    }
}

/// The raw 32-byte secret `[announce] identity_key_file` points at (issue
/// #799): a durable Nostr identity carried over from wherever an operator
/// previously announced this node from -- typically the retired sidecar's
/// own `ANNOUNCER_IDENTITY_SECRET_KEY_FILE` -- so a genesis peer seed that
/// already pins that pubkey does not go stale the day the sidecar is
/// switched off in favour of `connector announce`.
///
/// Not `[signer]`'s own key, and read through this sibling function rather
/// than [`read_signer_secret`] on purpose: the two locations answer
/// different questions ("what does this node sign gift wraps and
/// `GET /ilp/identity` with" versus "what did the last publisher of this
/// node's announce sign with"), and an unreadable-file or bad-material
/// error must name the field that is actually misconfigured.
pub(crate) fn read_announce_identity_secret(path: &Path) -> Result<[u8; 32], RuntimeError> {
    let bytes =
        std::fs::read(path).map_err(|source| RuntimeError::AnnounceIdentityKeyFileUnreadable {
            path: path.to_path_buf(),
            source,
        })?;
    decode_secret_key(&bytes).ok_or_else(|| RuntimeError::InvalidAnnounceIdentityKeyMaterial {
        path: path.to_path_buf(),
    })
}

fn build_signer(location: &SecretLocation) -> Result<Arc<dyn Signer>, RuntimeError> {
    let secret = read_signer_secret(location)?;
    let signer = LocalSigner::from_secret_bytes("connector-signer", secret)?;
    Ok(Arc::new(signer))
}

/// Encode 32 raw bytes as 64 lowercase hex characters -- what
/// `ethers::signers::LocalWallet`'s `FromStr` impl expects,
/// [`EvmSettlementBackend::connect`]'s `private_key` argument.
fn hex_encode_32(bytes: [u8; 32]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Resolve the `[settlement.key]` section to the raw 32-byte secret key
/// material it points at -- the same "32 raw bytes or 64 hex characters"
/// key-file shape [`build_signer`] already reads for `[signer]`, since both
/// are just secret-key pointers. `EvmSettlementBackend` wants that hex
/// encoded ([`read_settlement_private_key`]); `SolanaSettlementBackend`
/// wants it as an ed25519 seed, raw (issue #630).
pub(crate) fn read_settlement_key_bytes(
    location: &SecretLocation,
) -> Result<[u8; 32], RuntimeError> {
    match location {
        SecretLocation::File(path) => {
            let bytes = std::fs::read(path).map_err(|source| {
                RuntimeError::SettlementKeyFileUnreadable {
                    path: path.clone(),
                    source,
                }
            })?;
            decode_secret_key(&bytes)
                .ok_or_else(|| RuntimeError::InvalidSettlementKeyMaterial { path: path.clone() })
        }
        SecretLocation::Kms { .. } => Err(RuntimeError::UnsupportedSettlementKeyLocation),
    }
}

/// Resolve the `[settlement.key]` section to the hex-encoded secp256k1
/// private key `EvmSettlementBackend` signs with.
fn read_settlement_private_key(location: &SecretLocation) -> Result<String, RuntimeError> {
    read_settlement_key_bytes(location).map(hex_encode_32)
}

/// Parse a `[settlement.solana]` base58 field (`program_id` or
/// `token_address`) into the `Pubkey` `SolanaSettlementBackend::connect`
/// wants. Refused -- naming the field and the value -- rather than
/// unwrapped: `connector-config` only checks these fields are non-empty
/// (issue #628), since a value that merely fails to parse as base58 is a
/// different failure from one that parses but names no executable program
/// or no SPL mint, and both must refuse startup rather than panic (issue
/// #630, ADR 0009).
fn parse_solana_pubkey(field: &'static str, value: &str) -> Result<Pubkey, RuntimeError> {
    Pubkey::from_str(value).map_err(|error| {
        RuntimeError::Settlement(SettlementError::Backend(format!(
            "[settlement.solana] {field} '{value}' is not a valid base58 Solana pubkey: {error}"
        )))
    })
}

/// Construct the settlement backend a `[settlement.evm]` (or legacy flat
/// `[settlement]`) table describes, connecting to the already-deployed
/// `TokenNetworkRegistry` it names (issue #576) -- `contract_address` -- and
/// resolving the `TokenNetwork` it actually drives through `token_address`,
/// rather than deploying a fresh one (issue #542).
///
/// Every field of the table reaches the chain here: `decimals` is handed to
/// [`EvmSettlementBackend::connect`], which refuses to connect when the
/// configured scale and the token's own `decimals()` disagree (issue #564).
/// An EVM table that names a scale the deployed token does not agree with is
/// a startup failure, not a line with no effect (ADR 0009).
async fn build_evm_settlement_backend(
    settlement: &EvmSettlementConfig,
) -> Result<Arc<EvmSettlementBackend>, RuntimeError> {
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

/// Construct the settlement backend a `[settlement.solana]` table
/// describes, binding to the already-deployed `payment-channel` program it
/// names (`program_id`) and settling in the SPL mint it names
/// (`token_address`) -- the fail-closed identity checks issue #630 wires
/// in: an unreachable RPC endpoint, a `program_id` naming no executable
/// account, a `token_address` not owned by the SPL Token program, or a
/// `decimals` the mint's own `decimals` field disagrees with are all a
/// startup failure here, not a line with no effect (the `#564` pattern,
/// Solana-flavored, ADR 0009).
async fn build_solana_settlement_backend(
    settlement: &SolanaSettlementConfig,
) -> Result<Arc<SolanaSettlementBackend>, RuntimeError> {
    let payer_seed = read_settlement_key_bytes(settlement.key())?;
    let program_id = parse_solana_pubkey("program_id", settlement.program_id())?;
    let token_mint = parse_solana_pubkey("token_address", settlement.token_address())?;
    let backend = SolanaSettlementBackend::connect(
        settlement.rpc_url(),
        &payer_seed,
        program_id,
        token_mint,
        settlement.decimals(),
    )
    .await?;
    Ok(Arc::new(backend))
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
        let resolved = self
            .backend
            .channel_counterparty_deposit(*channel_id)
            .await
            .map_err(|error| ChannelLookupFailed(error.to_string()))?;
        // The signing domain comes from the same deployment the
        // counterparty did (issue #556's open question): `TokenNetwork`
        // inherits OpenZeppelin's `EIP712("TokenNetwork", "1")`, whose
        // domain separator is built from `block.chainid` and
        // `address(this)`, so a per-entry config field for either could
        // only ever restate -- or contradict -- what the chain says.
        //
        // The deposit rides along for issue #646: a claim above what the
        // counterparty has actually deposited could never be redeemed
        // (`TokenNetwork.sol`'s `InsufficientChannelBalance`), so the
        // client edge refuses it rather than doing work it cannot be paid
        // for. `as_u64` saturates deliberately -- a deposit wider than a
        // claim's `u64` cumulative amount can never be exceeded by one, so
        // clamping to `u64::MAX` errs in the safe direction.
        Ok(resolved.map(|(counterparty, deposit)| EvmChannel {
            counterparty: counterparty.to_fixed_bytes(),
            chain_id: self.backend.chain_id(),
            token_network_address: self.backend.address().to_fixed_bytes(),
            deposit_floor: DepositFloor::AtLeast(saturating_u64(deposit)),
        }))
    }
}

/// Wraps [`SettlementChannelSource`] with the local EVM channel index
/// (issue #661): a channel the index has caught up to answers from a
/// `HashMap` probe -- no `eth_call` at all -- and a channel the index has
/// not caught up to (never opened, opened inside the confirmation window,
/// or the index's subscription is lagging/down) falls through to exactly
/// the direct chain read [`SettlementChannelSource`] always performed,
/// unchanged. This is what makes shipping the index safe incrementally: a
/// node whose sync has never once succeeded behaves byte-identically to a
/// node built before this issue landed.
///
/// `EvmChannel::chain_id`/`token_network_address` (the EIP-712 domain) come
/// from `self.fallback.backend` rather than from a field the index itself
/// stores per channel: every channel this index ever indexes belongs to the
/// one `TokenNetwork` this node's `[settlement.evm]` names, so the domain is
/// one constant for the whole index, not a per-channel fact -- storing it
/// once on the backend this source already holds is the same information,
/// without repeating an invariant on every record.
struct IndexedEvmChannelSource {
    index: Arc<EvmChannelIndex>,
    fallback: SettlementChannelSource,
}

impl fmt::Debug for IndexedEvmChannelSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IndexedEvmChannelSource")
            .field("fallback", &self.fallback)
            .field("index_last_indexed_block", &self.index.last_indexed_block())
            .finish()
    }
}

impl IndexedEvmChannelSource {
    /// What the index alone says about `channel_id` -- every one of the
    /// three reads below starts here, and all three ask it about the same
    /// address: this node's own signing address, which is what lets an
    /// `Active` answer name the *other* participant as the counterparty.
    fn lookup(&self, channel_id: &[u8; 32]) -> ChannelIndexLookup {
        self.index
            .lookup(channel_id, self.fallback.backend.own_address())
    }
}

#[async_trait]
impl ClientChannelSource for IndexedEvmChannelSource {
    async fn evm_channel(
        &self,
        channel_id: &[u8; 32],
    ) -> Result<Option<EvmChannel>, ChannelLookupFailed> {
        match self.lookup(channel_id) {
            ChannelIndexLookup::Active {
                counterparty,
                deposit,
            } => Ok(Some(EvmChannel {
                counterparty: counterparty.to_fixed_bytes(),
                chain_id: self.fallback.backend.chain_id(),
                token_network_address: self.fallback.backend.address().to_fixed_bytes(),
                deposit_floor: DepositFloor::AtLeast(saturating_u64(deposit)),
            })),
            // Reported `None` here -- "not a channel this connector can be
            // paid on" -- and refined to a distinguishable refusal by
            // `evm_channel_terminal` below, which the registry consults
            // only after seeing this `None`. Never falls through to the
            // chain: the index has already seen the terminal log, so a
            // chain read could only confirm what is already known.
            ChannelIndexLookup::Terminal => Ok(None),
            // The one case that costs an RPC, exactly as it always has:
            // this index has nothing to say, one way or the other.
            ChannelIndexLookup::Miss => self.fallback.evm_channel(channel_id).await,
        }
    }

    /// A breach re-read (issue #661's follow-up finding): the indexed
    /// deposit lags the chain by the confirmation depth, so `Active` is
    /// exactly the answer a breach exists to distrust -- a top-up (or a
    /// `ChannelNewDeposit` younger than the confirmation window) is real on
    /// chain before this index will admit it. The chain is asked directly,
    /// as it would have been before this index existed, so a claim main
    /// would honour is honoured here on the same submission. `Terminal`
    /// stays answered from the index: settlement is monotone and the index
    /// only applies confirmed logs, so a chain read could only repeat it.
    async fn evm_channel_fresh(
        &self,
        channel_id: &[u8; 32],
    ) -> Result<Option<EvmChannel>, ChannelLookupFailed> {
        match self.lookup(channel_id) {
            ChannelIndexLookup::Terminal => Ok(None),
            ChannelIndexLookup::Active { .. } | ChannelIndexLookup::Miss => {
                self.fallback.evm_channel(channel_id).await
            }
        }
    }

    async fn evm_channel_terminal(&self, channel_id: &[u8; 32]) -> bool {
        matches!(self.lookup(channel_id), ChannelIndexLookup::Terminal)
    }
}

/// A `U256` narrowed to `u64`, clamped rather than wrapped or panicking
/// (`ethers`' own `U256::as_u64` panics on overflow). Only ever used for a
/// deposit that bounds a `u64` claim amount from above, where clamping to
/// `u64::MAX` is indistinguishable from the true value: no `u64` cumulative
/// amount can exceed either.
fn saturating_u64(value: U256) -> u64 {
    if value > U256::from(u64::MAX) {
        u64::MAX
    } else {
        value.as_u64()
    }
}

/// The Solana twin of [`SettlementChannelSource`] (issue #631): the client
/// edge's channel records for a Solana channel nothing was declared for,
/// read from the same deployed payment-channel program the
/// `[settlement.solana]` section already names. Epic #627's remaining
/// piece from #630's own note -- "Solana channel resolution from chain ...
/// [is] epic #627's remaining children" -- this is that child.
struct SolanaChannelSource {
    backend: Arc<SolanaSettlementBackend>,
}

/// Hand-written for the same reason [`SettlementChannelSource`]'s is:
/// [`SolanaSettlementBackend`] holds an RPC client that is not `Debug`.
impl fmt::Debug for SolanaChannelSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SolanaChannelSource")
            .field("own_pubkey", &self.backend.own_pubkey())
            .finish()
    }
}

#[async_trait]
impl ClientChannelSource for SolanaChannelSource {
    async fn solana_channel(
        &self,
        channel_account: &[u8; 32],
    ) -> Result<Option<SolanaChannel>, ChannelLookupFailed> {
        // The deposit costs nothing extra here (issue #646): it is decoded
        // out of the very same channel account the counterparty comes from,
        // on the one `getAccountInfo` this lookup already performs -- it
        // was simply thrown away before.
        let resolved = self
            .backend
            .channel_counterparty_deposit(Pubkey::new_from_array(*channel_account))
            .await
            .map_err(|error| ChannelLookupFailed(error.to_string()))?;
        Ok(resolved.map(|(counterparty, deposit)| SolanaChannel {
            counterparty: counterparty.to_bytes(),
            deposit_floor: DepositFloor::AtLeast(deposit),
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
const PEER_CLAIM_JOURNAL: &str = "peer-claims.log";
const CLIENT_EDGE_JOURNAL: &str = "client-edge-claims.log";
/// Issue #884's runtime peer/route table -- a whole-table JSON snapshot,
/// not an append-only journal line format like the two above (see
/// `connector_runtime::PeerRouteStore`'s own docs for why).
const RUNTIME_PEER_ROUTE_TABLE: &str = "runtime-peers.json";
/// Issue #661's local EVM channel index -- a whole-table JSON snapshot for
/// the same reason [`RUNTIME_PEER_ROUTE_TABLE`] is one rather than an
/// append-only log: a settled channel is marked terminal in place, not
/// appended over (see `connector_settlement_evm::channel_index`'s own doc).
const EVM_CHANNEL_INDEX: &str = "evm-channel-index.json";

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

/// Open the local EVM channel index's durable snapshot under `state_dir`
/// (issue #661), or start an in-memory-only index when this node names no
/// `state_dir` at all -- the same degrade issue #884's runtime peer/route
/// table already established (ADR 0034): a node with no `state_dir` still
/// saves every RPC call the index avoids within a run, it just re-backfills
/// from `channel_index_from_block` on every restart rather than resuming
/// from a checkpoint.
fn open_evm_channel_index(state_dir: Option<&Path>) -> Result<Arc<EvmChannelIndex>, RuntimeError> {
    let path = state_dir.map(|state_dir| state_dir.join(EVM_CHANNEL_INDEX));
    let index = EvmChannelIndex::open(path.as_deref()).map_err(|source| {
        RuntimeError::EvmChannelIndexUnusable {
            path: path.unwrap_or_default(),
            source,
        }
    })?;
    Ok(Arc::new(index))
}

/// Name every plaintext peering at startup, loudly (issue #678, gap 3).
///
/// `peer_allow_plaintext_endpoints` is a loopback-and-test opt-in and
/// nothing else: a peering carries signed balance proofs (ADR 0004), so
/// `ws://` and `http://` remain a hard `PeerEndpointScheme` load error on
/// every config that does not set it. A node that *did* set it is one whose
/// peer credentials and claims cross the wire in the clear, and the only
/// thing worse than that in a test harness is that in production with
/// nobody noticing.
fn warn_about_plaintext_peerings(config: &Config) {
    for (peer_id, endpoint) in config.plaintext_peerings() {
        tracing::warn!(
            peer_id,
            %endpoint,
            "peer_allow_plaintext_endpoints is set and this peering is dialed in the clear -- \
             the credential and every claim on it are readable on the wire. This is a loopback \
             and test setting; see docs/operators/btp-peer-transport-bringup.md"
        );
    }
}

/// The key this node signs outbound **peer** claims with (ADR 0024), and
/// the EVM address it derives -- the `senderId`/`signerAddress` every claim
/// this node emits carries (`peer-carriage-spec.md` §4).
type PeerClaimIdentity = (Arc<dyn Signer>, [u8; 20]);

/// The key this node signs outbound **peer** claims with, and the EVM
/// address that key derives -- `None` for a node with no `[settlement.evm]`
/// table (ADR 0024's balance proof has no meaning without one).
///
/// It is the settlement key rather than `[signer]`'s identity key because a
/// peer claim is redeemed on chain by the counterparty against the
/// `TokenNetwork` this node is a channel participant in, and the participant
/// is the settlement address. The two keys are separate on purpose (ADR
/// 0022's two audiences); conflating them would produce claims that verify
/// nowhere.
fn peer_claim_identity(config: &Config) -> Result<Option<PeerClaimIdentity>, RuntimeError> {
    let Some(evm) = config
        .settlements()
        .iter()
        .find_map(|settlement| match settlement {
            SettlementConfig::Evm(evm) => Some(evm),
            SettlementConfig::Solana(_) => None,
        })
    else {
        return Ok(None);
    };
    let secret = read_settlement_key_bytes(evm.key())?;
    let signer = LocalSigner::from_secret_bytes("peer-claim-signer", secret)?;
    let address = derive_evm_address(&signer.public_key()?);
    Ok(Some((Arc::new(signer), address)))
}

/// Wire every `[[peer_channels]]` row into the claim ledger (issue #678,
/// `peer-carriage-spec.md` §11): which channel this node claims against
/// when it owes a peer, whose signature it accepts on a claim naming that
/// channel, and the EIP-712 domain both are judged under (ADR 0024).
///
/// A peering with several rows claims against the **first**: an outbound
/// ledger is per peer, so there is exactly one channel this node can owe on,
/// and picking the last would make the answer depend on file order. Every
/// row is still accepted *inbound* -- a counterparty may legitimately claim
/// on any channel the two of them have bound.
///
/// EVM rows only: a Solana `[[peer_channels]]` row (issue #759) is
/// validated by `Config::load` and reaches claim *rendering* (its
/// `program_id` reaches `PeerRelation::from_config` in
/// `connector-peer-btp`/`connector-peer-http`), but `ClaimBook` has no
/// `Connector` builder to accept a Solana verification key or signer from
/// config yet -- that is the config/CLI identity wiring issue #742/#757
/// left as a named follow-up, not this issue's job. A Solana row is
/// therefore skipped here rather than wired into a method that does not
/// exist.
fn wire_peer_channels(
    mut connector: Connector,
    config: &Config,
) -> Result<Connector, RuntimeError> {
    let mut claiming_against: Vec<&str> = Vec::new();
    for channel in config.peer_channels() {
        let PeerChannelConfig::Evm(channel) = channel else {
            continue;
        };
        if !claiming_against.contains(&channel.peer_id()) {
            claiming_against.push(channel.peer_id());
            connector = connector.with_peer_claim_channel(channel.peer_id(), channel.channel_id());
        }
        connector = connector
            .with_channel_verification_key(channel.channel_id(), channel.counterparty_key());
        connector = connector
            .with_channel_domain(
                channel.channel_id(),
                ChannelDomain {
                    chain_id: channel.chain_id(),
                    token_network_address: channel.token_network(),
                },
            )
            .map_err(|_| RuntimeError::PeerChannelUnusable {
                channel_id: channel.channel_id().to_string(),
            })?;
    }
    Ok(connector)
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
    /// Where the client edge resolves an undeclared EVM payment channel
    /// (issue #556) -- `Some` exactly when `[settlement.evm]` (or the
    /// legacy `[settlement] chain = "evm"`) is configured, since the
    /// deployed `TokenNetwork` it names is what holds the answer. `None`
    /// leaves the client edge with only `[[client_channels]]` to go on for
    /// EVM claims, which is what a node with no EVM settlement backend has.
    pub client_channel_source_evm: Option<Arc<dyn ClientChannelSource>>,
    /// The Solana twin of [`Self::client_channel_source_evm`] (issue #631)
    /// -- `Some` exactly when `[settlement.solana]` is configured.
    pub client_channel_source_solana: Option<Arc<dyn ClientChannelSource>>,
    /// The channel-opening facts the x402 greeting carries (issue #617) --
    /// `Some` exactly when `[settlement.evm]` (or the legacy flat
    /// `[settlement]`) is configured, composed here in `build` because that
    /// is the one place the config's own values and the facts the chain
    /// connection proved (chain id, the resolved `TokenNetwork`, the
    /// backend's signing address) are both in scope.
    pub settlement_terms: Option<connector_client_edge::X402SettlementTerms>,
    /// Every configured chain's channel-opening facts (issue #632), additive
    /// beside [`settlement_terms`](Self::settlement_terms): one entry per
    /// `[settlement.<chain>]` table this node has, so a node settling on N
    /// chains (epic #627) advertises all N in the x402 greeting's
    /// `extra.settlements` rather than only the EVM leg.
    pub settlements: Vec<connector_client_edge::X402ChainSettlementTerms>,
}

/// Construct the live [`Connector`] and [`Signer`] a validated [`Config`]
/// describes. Every `peer_id`-targeted `[[routes]]` entry becomes a
/// [`PeerRoute`] alongside the terminated
/// [`connector_config::StaticRoute`]s -- though nothing can currently
/// traverse one: ADR 0027 / issue #679 deleted the raw-TCP peer wire that
/// was the only [`connector_runtime::PeerTransport`] a built node held,
/// and the carriages replacing it (BTP over `wss://`, ILP-over-HTTP over
/// `https://`) are issue #676. Until one lands this node holds an empty
/// [`InProcessPeerTransport`], so a packet routed to a peer is answered
/// `T01 peer unreachable` rather than dropped. Every configured
/// `[settlement.<chain>]` table's real chain-backed [`SettlementBackend`]
/// is connected and attached under its own chain via
/// [`Connector::with_settlement`] (issues #542, #630 -- a node with both
/// tables holds both backends, and operator channel ops route per chain) --
/// those connections are why this function is `async` at all; an
/// unconfigured node still builds with no settlement backend, same as
/// before this section existed.
///
/// That same connection is handed to [`router`] as a
/// [`ClientChannelSource`] (issue #556): one chain connection, used both
/// to move value and to read who a channel belongs to.
///
/// A node that names a `state_dir` also has its peer claim journal armed
/// here (issue #605), so the watermarks `ClaimBook` keeps outlive the
/// process exactly as the client edge's do. That ledger sits *above* the
/// peer transport port and was untouched by #679's deletion.
pub async fn build(config: &Config) -> Result<Runtime, RuntimeError> {
    let signer = build_signer(config.signer_key())?;
    // Issue #678 gap 3, said once and loudly. A plaintext peering could not
    // have loaded unless somebody wrote `peer_allow_plaintext_endpoints`,
    // and the whole point of a loopback-and-test opt-in is that a node that
    // took it says so where an operator will see it.
    warn_about_plaintext_peerings(config);
    // The claim identity of this node's peerings (ADR 0024): the EVM
    // settlement key, because an outbound peer claim is an EIP-712 balance
    // proof the counterparty's `TokenNetwork` verifies against the channel
    // participant this node *is* on chain -- which is the settlement
    // address, never `[signer]`'s identity key (that one opens gift wraps
    // and answers `GET /ilp/identity`). A node with no `[settlement.evm]`
    // table has no such identity, emits no claim, and says so here rather
    // than signing one under a key nothing would accept.
    let peer_claim_identity = peer_claim_identity(config)?;
    let peer_signer_address = peer_claim_identity
        .as_ref()
        .map(|(_, address)| *address)
        .unwrap_or([0u8; 20]);
    // Issue #678 gap 2: the dial side, built from `[[peers]]` and
    // `[[peer_channels]]`. A node with no dialable peering still holds an
    // empty `InProcessPeerTransport`, so a packet routed to a peer is
    // answered `T01 peer unreachable` rather than silently dropped.
    let peer_transport =
        peer_transport::build_peer_transport(config, peer_signer_address, Arc::new(SystemClock));
    let peer_routes = config
        .peer_routes()
        .iter()
        // ADR 0028: a forwarded route carries the client-edge `price` its
        // config entry names, alongside the `fee` this hop retains. Built
        // with `new_priced` rather than `new` so a route that loses its
        // price on the way into the runtime is a compile error, not a
        // silently free gateway.
        .map(|route| {
            PeerRoute::new_priced(route.prefix(), route.peer_id(), route.fee(), route.price())
        })
        .collect();
    let mut connector = Connector::new(
        config.routes().to_vec(),
        peer_routes,
        Arc::new(HttpAppClient::new()),
        peer_transport,
        Arc::new(SystemClock),
    )
    .with_identity_signer(signer.clone())
    // Issue #884: the routing table IS the relationship set enforced at
    // load (`connector-config`'s `UnknownPeerId` check), so a runtime
    // write must never be able to add, update or remove a peer id the
    // config file already owns. `Connector` needs every config peer id
    // to enforce that, even though it stores nothing else about a
    // config peer (see `PeerView`'s own docs).
    .with_config_peer_ids(config.peers().iter().map(|peer| peer.id().to_string()));
    // Issue #885: the single priced route that buys peering with this
    // node, if this operator sells one -- an absent `[peer_sale]` leaves
    // the connector exactly as it was before this section existed. Issue
    // #886: the lease a purchase actually buys, alongside the price.
    if let Some(peer_sale) = config.peer_sale() {
        connector = connector.with_peer_sale(
            peer_sale.prefix(),
            peer_sale.price(),
            chrono::Duration::seconds(peer_sale.lease_seconds() as i64),
        );
    }
    // `[[peer_channels]]` reaching `ClaimBook` at last (§11: "it MUST
    // actually wire `ClaimBook`'s signer, verification key and EIP-712
    // domain, with no code-only setters left on the config path"). Before
    // this, the table loaded, validated, and reached nothing -- so every
    // peer claim was refused `unknown_channel` and none was ever signed,
    // which is #620's gap 3 surviving into the bring-up.
    if let Some((claim_signer, _)) = peer_claim_identity {
        connector = connector.with_signer(claim_signer);
    }
    connector = wire_peer_channels(connector, config)?;
    let mut client_channel_source_evm: Option<Arc<dyn ClientChannelSource>> = None;
    let mut client_channel_source_solana: Option<Arc<dyn ClientChannelSource>> = None;
    let mut settlement_terms: Option<connector_client_edge::X402SettlementTerms> = None;
    let mut settlements: Vec<connector_client_edge::X402ChainSettlementTerms> = Vec::new();
    for settlement in config.settlements() {
        match settlement {
            SettlementConfig::Evm(evm) => {
                let backend = build_evm_settlement_backend(evm).await?;
                // The greeting's channel-opening facts (issue #617).
                // Addresses the chain connection proved (`own_address`, the
                // resolved `TokenNetwork`, the live chain id) come from the
                // backend; the registry, token and scale come from the very
                // config lines `connect` just verified against that chain
                // (issues #564/#576).
                let evm_terms = connector_client_edge::X402SettlementTerms {
                    chain: format!("evm:{}", backend.chain_id()),
                    settlement_address: format!("{:#x}", backend.own_address()),
                    token_network_registry: format!("{:#x}", backend.registry_address()),
                    token_network: format!("{:#x}", backend.address()),
                    token_address: format!(
                        "{:#x}",
                        ethers::types::Address::from(evm.token_address())
                    ),
                    decimals: evm.decimals(),
                };
                settlement_terms = Some(evm_terms.clone());
                settlements.push(connector_client_edge::X402ChainSettlementTerms::Evm(
                    evm_terms,
                ));
                // Issue #661: the local channel index answers a resolution
                // from a `HashMap` probe once it has caught up to a
                // channel, and falls through to exactly the direct chain
                // read `SettlementChannelSource` always performed for
                // everything it has not (see `IndexedEvmChannelSource`'s
                // own doc). Opened -- and, on a durable failure, refused --
                // before any traffic is served, same as every other
                // `state_dir`-scoped store (ADR 0009).
                let channel_index = open_evm_channel_index(config.state_dir())?;
                let syncer = EvmChannelIndexSyncer::new(
                    evm.rpc_url(),
                    backend.address(),
                    evm.channel_index_confirmations(),
                    evm.channel_index_from_block(),
                )
                .map_err(|source| {
                    RuntimeError::Settlement(SettlementError::Backend(source.to_string()))
                })?;
                // Backfill-then-poll runs for the life of the process,
                // never blocking startup (issue #661's own acceptance
                // criterion) -- a lagging or never-connecting sync logs at
                // `warn` (`EvmChannelIndexSyncer::run`'s own doc) and the
                // fallback below keeps serving exactly as it does today.
                tokio::spawn(syncer.run(Arc::clone(&channel_index), DEFAULT_POLL_INTERVAL));
                client_channel_source_evm = Some(Arc::new(IndexedEvmChannelSource {
                    index: channel_index,
                    fallback: SettlementChannelSource {
                        backend: backend.clone(),
                    },
                }));
                connector = connector
                    .with_settlement(SettlementChain::Evm, backend as Arc<dyn SettlementBackend>);
            }
            SettlementConfig::Solana(solana) => {
                // Constructed and attached exactly as the EVM leg is (issue
                // #630) -- `SolanaSettlementBackend::connect`'s own
                // fail-closed identity checks (program reachable,
                // executable and proven to behave like the deployed
                // payment-channel program, mint owned by the SPL Token
                // program, configured decimals agreeing with the mint's
                // own) run before this node serves any traffic.
                // `ClientChannelSource` now covers Solana too (issue #631),
                // and the greeting's per-chain settlement facts are
                // composed here as well (issue #632) -- epic #627's
                // remaining children, together.
                let backend = build_solana_settlement_backend(solana).await?;
                client_channel_source_solana = Some(Arc::new(SolanaChannelSource {
                    backend: backend.clone(),
                }));
                settlements.push(connector_client_edge::X402ChainSettlementTerms::Solana(
                    connector_client_edge::X402SolanaSettlementTerms {
                        chain: "solana".to_string(),
                        settlement_address: backend.own_pubkey().to_string(),
                        program_id: backend.program_id().to_string(),
                        token_address: backend.token_mint().to_string(),
                        decimals: solana.decimals(),
                    },
                ));
                connector = connector.with_settlement(
                    SettlementChain::Solana,
                    backend as Arc<dyn SettlementBackend>,
                );
            }
        }
    }
    // The peer wire's own claim watermarks, made durable by the same
    // `state_dir` the client edge's are (issue #605, and #556's
    // reconciliation row "Journal: `ClaimBook::new(None, ..)` installs the
    // in-memory journal ... watermarks reset on restart; spent nonces
    // respend"). Both surfaces are the same sentence -- a watermark must
    // outlive the process -- so they get the same answer rather than two,
    // and arming one while leaving the other in memory would mean shipping
    // the fix and the bug side by side.
    if let Some(state_dir) = config.state_dir() {
        let journal = open_journal(state_dir, PEER_CLAIM_JOURNAL)?;
        connector = connector.with_journal(journal).map_err(|source| {
            RuntimeError::JournalUnreplayable {
                path: state_dir.join(PEER_CLAIM_JOURNAL),
                source,
            }
        })?;
        // Issue #884: replay this node's durable runtime peer/route table,
        // and arm the connector to persist future writes back to the same
        // file -- the same `state_dir` scoping as the two journals above,
        // so an operator restoring a node from `state_dir` alone restores
        // this table too. `open_journal` just created `state_dir` itself,
        // so a node with nowhere writable has already failed above with
        // the path in the message.
        let table_path = state_dir.join(RUNTIME_PEER_ROUTE_TABLE);
        let (store, runtime_peers, runtime_peer_routes) = PeerRouteStore::open(&table_path)
            .map_err(|source| RuntimeError::RuntimePeerRouteTableUnusable {
                path: table_path,
                source,
            })?;
        connector =
            connector.with_runtime_peer_route_store(store, runtime_peers, runtime_peer_routes);
    }
    let connector = Arc::new(connector);
    // Issue #886: a purchased peering's lease is enforced immediately at
    // routing time regardless of this loop (`Connector::select_configured_route`
    // stops matching a lapsed lease's route the instant the clock passes
    // it), but the durable row behind it is only ever removed here --
    // otherwise it rots in `runtime-peers.json` forever, the "slow leak on
    // a long-lived box" issue #886's own rationale names. Spawned once,
    // never awaited on the startup path, mirroring
    // `EvmChannelIndexSyncer::run`'s own periodic-sweep shape.
    tokio::spawn(reap_expired_peer_leases_periodically(Arc::clone(
        &connector,
    )));
    Ok(Runtime {
        connector,
        signer,
        client_channel_source_evm,
        client_channel_source_solana,
        settlement_terms,
        settlements,
    })
}

/// How often [`build`]'s spawned loop sweeps for lapsed peer-sale leases
/// (issue #886) -- frequent enough that a durable dead row does not sit
/// around for long, infrequent enough that it costs nothing worth naming
/// on a box with no peer-sale purchases at all (`Connector::reap_expired_peer_leases`
/// is a cheap no-op when nothing has lapsed).
const PEER_LEASE_REAP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

/// Sweep `connector`'s durable runtime peer table for lapsed peer-sale
/// leases every [`PEER_LEASE_REAP_INTERVAL`], forever. Never returns, so
/// it is spawned rather than awaited; a sweep that cannot persist logs and
/// leaves the table alone, so a failure costs a cycle rather than the
/// loop.
async fn reap_expired_peer_leases_periodically(connector: Arc<Connector>) {
    let mut interval = tokio::time::interval(PEER_LEASE_REAP_INTERVAL);
    loop {
        interval.tick().await;
        connector.reap_expired_peer_leases();
    }
}

/// The channels this node accepts client-edge claims on, and whose
/// counterparty each claim's signature must recover to (issues #558,
/// #556, #631): everything `[[client_channels]]` declares, plus -- when
/// `[settlement.evm]`/`[settlement.solana]` is configured -- that chain's
/// own deployed contract/program, for any channel the config file does not
/// mention.
///
/// The two compose rather than replace each other. A declared channel is
/// still answered from config without touching a chain, so a node with no
/// settlement backend still declares its channels and a node whose RPC
/// endpoint is down still serves the channels it wrote down. What a source
/// adds is the case `[[client_channels]]` cannot express: a buyer this
/// operator has never heard of, who opened a channel on chain and wants to
/// pay for a write (issue #502).
///
/// A node with neither still has a record of no channel and refuses every
/// claim -- deliberately, since the only alternative to "no record of this
/// channel" is trusting what the claim says about its own signer, which is
/// exactly the hole #558 closes.
fn client_channels(
    config: &Config,
    evm_source: Option<Arc<dyn ClientChannelSource>>,
    solana_source: Option<Arc<dyn ClientChannelSource>>,
) -> ClientChannelRegistry {
    let mut channels = ClientChannelRegistry::new();
    for channel in config.client_channels() {
        match channel {
            ClientChannelConfig::Evm(evm) => {
                channels
                    .record_evm(
                        evm.channel_id(),
                        EvmChannel {
                            counterparty: evm.counterparty(),
                            chain_id: evm.chain_id(),
                            token_network_address: evm.token_network_address(),
                            // `[[client_channels]]` declares a
                            // counterparty and a domain, never an amount,
                            // and a node with no settlement backend has no
                            // chain to ask -- so a declared channel is
                            // exempt from the collateral cap (issue #646),
                            // deliberately: hand-declaring a channel is
                            // itself the operator's policy decision,
                            // correctly located in config.
                            deposit_floor: DepositFloor::Unknown,
                        },
                    )
                    .expect(
                        "config load already validated every channel_id as a 32-byte identifier",
                    );
            }
            ClientChannelConfig::Solana(solana) => {
                channels
                    .record_solana(solana.channel_account(), solana.counterparty())
                    .expect("config load already validated both fields as base58 32-byte accounts");
            }
        }
    }
    if let Some(source) = evm_source {
        channels = channels.with_source(source);
    }
    if let Some(source) = solana_source {
        channels = channels.with_solana_source(source);
    }
    // The liveness knobs a config file turns (issue #649): how long a
    // chain-resolved channel's mutable facts may be believed, how long its
    // last good reading may still be served while the chain is
    // unreachable, and how often one channel may make this node read the
    // chain at all. Each absent field leaves the client edge's own
    // default, which is what every node that has not thought about it
    // should have -- an operator whose RPC endpoint is rate-limited is the
    // one who needs the levers, and they now have them without a rebuild.
    let defaults = ChannelLivenessPolicy::default();
    channels = channels.with_liveness_policy(ChannelLivenessPolicy {
        refresh_after: config
            .channel_liveness_ttl()
            .unwrap_or(defaults.refresh_after),
        serve_stale_until: config
            .channel_serve_stale()
            .unwrap_or(defaults.serve_stale_until),
        min_reattempt_interval: config
            .channel_reattempt_interval()
            .unwrap_or(defaults.min_reattempt_interval),
    });
    // The shaper on lookups for channels that never resolve (issue #613) --
    // the bound the liveness knobs above structurally cannot provide, since
    // each of them reads a memo entry and an unresolvable channel leaves
    // none. Same shape as the knobs above and for the same reason: what a
    // node can afford to spend discovering channels that turn out not to
    // exist depends on the settlement endpoint it is paying for, which is a
    // deployment fact rather than a protocol constant.
    let budget = UnresolvableLookupBudgetPolicy::default();
    channels = channels.with_lookup_budget(UnresolvableLookupBudgetPolicy {
        per_signer: config
            .unresolvable_lookups_per_signer()
            .unwrap_or(budget.per_signer),
        total: config.unresolvable_lookups_total().unwrap_or(budget.total),
        window: config.unresolvable_lookup_window().unwrap_or(budget.window),
        max_wait: config
            .unresolvable_lookup_max_wait()
            .unwrap_or(budget.max_wait),
    });
    channels
}

/// The client edge's claim gate: the channels this node accepts claims on,
/// resumed from the watermarks its journal already records (issue #605).
///
/// A node with no `state_dir` gets an in-memory journal, which is sound
/// only because [`Config::load`] has already refused any config that both
/// omits `state_dir` and configures a channel to accept claims on: such a
/// gate refuses every claim as unknown, so it has no watermark to lose.
///
/// `evm_source`/`solana_source` are threaded straight through to
/// [`client_channels`] (issues #556, #631): a gate resolves an undeclared
/// channel from the chain and journals its watermark like any other, so
/// the unaffiliated buyer's claims are exactly as replay-proof across a
/// restart as a declared buyer's are.
///
/// Bound to [`client_payout_ledger`] (issue #770) before it is returned:
/// without this, a node's own outbound crediting is netted against nothing
/// (`ClientClaimGate::credited_evm`'s pre-#770 default), which is exactly
/// the production gap issue #770 closes -- the gate and the ledger it nets
/// against must never be assembled separately again.
fn client_claim_gate(
    config: &Config,
    signer: Arc<dyn Signer>,
    evm_source: Option<Arc<dyn ClientChannelSource>>,
    solana_source: Option<Arc<dyn ClientChannelSource>>,
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
    let gate =
        ClientClaimGate::restore(client_channels(config, evm_source, solana_source), journal)
            .map_err(|source| RuntimeError::JournalUnreplayable { path, source })?;
    Ok(gate.with_payout_ledger(client_payout_ledger(config, signer)))
}

/// This connector's own outbound claim ledger for the client edge (issue
/// #770): every EVM `[[client_channels]]` entry, registered under the same
/// signer that already signs this connector's identity and its peer-wire
/// outbound claims (`Connector::with_identity_signer`) -- one signing key
/// for everything this connector owes, not a second one minted for this
/// edge alone. A session earning against an undeclared (chain-resolved)
/// channel is not covered here: crediting one requires knowing which
/// domain to sign under, and only a declared `[[client_channels]]` entry
/// carries that -- the same reason `client_channels` above resolves an
/// *inbound* claim's channel from the chain but a payout ledger cannot
/// mirror it for the outbound direction.
///
/// Solana channels are skipped: [`ClientPayoutLedger`] wraps
/// `connector_runtime::ClaimBook`, which only ever signs an EVM balance
/// proof (issue #742's own scope note) -- a Solana client channel nets
/// nothing yet, matching `ClientClaimGate::credited`'s existing "Solana
/// channel nets 0" rule.
fn client_payout_ledger(config: &Config, signer: Arc<dyn Signer>) -> Arc<ClientPayoutLedger> {
    let mut ledger = ClientPayoutLedger::new();
    ledger.set_signer(signer);
    for channel in config.client_channels() {
        if let ClientChannelConfig::Evm(evm) = channel {
            ledger
                .set_channel_domain(
                    evm.channel_id(),
                    ChannelDomain {
                        chain_id: evm.chain_id(),
                        token_network_address: evm.token_network_address(),
                    },
                )
                .expect("config load already validated every channel_id as a 32-byte identifier");
        }
    }
    Arc::new(ledger)
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
    // Issue #556: a privacy-wrapped claim
    // (`ILP-Payment-Channel-Claim-Wrapped`, client-edge-spec.md §1.3) is
    // opened with this node's `[signer]` key, not with a second receiver
    // key of its own. `connector-config/src/announce.rs` states the rule:
    // `GET /ilp/identity` and every gift wrap this node opens both use
    // `[signer]` -- and since that endpoint is the only surface publishing
    // a receiver public key, a sender can wrap to no other one. No new
    // config section exists or is needed for this.
    let wrap_receiver_secret = Some(read_signer_secret(config.signer_key())?);
    let app = connector_client_edge::router_with_bootstrap_identity(
        connector.clone(),
        signer.clone(),
        wrap_receiver_secret,
        client_claim_gate(
            config,
            signer.clone(),
            runtime.client_channel_source_evm.clone(),
            runtime.client_channel_source_solana.clone(),
        )?,
        runtime.settlement_terms.clone(),
        runtime.settlements.clone(),
        config
            .btp_session_window()
            .unwrap_or(connector_client_edge::DEFAULT_BTP_SESSION_WINDOW),
        // Issue #678 gap 1: the accept side. There is no second listener --
        // the peer carriages ride the `POST /ilp` and `GET /ilp/btp` this
        // router already serves, and role is decided by authentication
        // (`peer-carriage-spec.md` §1.3), never by the port. `None` for a
        // node whose `peer_expose` is `"neither"`, which is the default.
        PeerCarriages::from_config(
            connector.clone(),
            config.peers(),
            config.peer_channels(),
            config.peer_expose(),
        ),
        // Issue #807: `[announce]` is the one config section that already
        // holds this node's own ILP address(es) and BTP endpoint (they
        // cannot be introspected -- `connector_config::announce`'s own
        // module doc explains why). `None` for a node that does not
        // configure it, in which case the greeting still broadens (issue
        // #807's core fix) but carries no `ilpAddresses`/`btpEndpoint`.
        config
            .announce()
            .map(|announce| connector_client_edge::BootstrapIdentity {
                ilp_addresses: announce.addresses().to_vec(),
                btp_endpoint: announce.btp_endpoint().to_string(),
            }),
        // Issue #502: every `[[client_identities]]` entry, as the
        // `id`/`secret` pair `resolve_identity` authenticates an
        // `ILP-Peer-Id` against. Empty is every node before this config
        // section existed -- every request is anonymous or, if it presents
        // an `ILP-Peer-Id`, refused `401`.
        config
            .client_identities()
            .iter()
            .map(|identity| connector_domain::identity::ConfiguredIdentity {
                id: identity.id().to_string(),
                secret: identity.secret().to_string(),
            })
            .collect(),
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

    /// A throwaway signer for a [`client_claim_gate`] call whose test is
    /// about channel resolution or journal behaviour, never about payout
    /// signing (issue #770 gave the function a signer parameter it did not
    /// have before).
    fn test_signer() -> Arc<dyn Signer> {
        Arc::new(LocalSigner::generate("connector-cli-runtime-test"))
    }

    /// Load a minimal config with `extra` spliced in at the top level, and
    /// hand back the *result* rather than unwrapping it -- for a test whose
    /// subject is whether a configuration loads at all.
    fn raw_config_result(extra: &str) -> Result<Config, connector_config::ConfigError> {
        let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
        key_file
            .write_all(&[7u8; 32])
            .expect("write raw 32-byte key");
        let key_path = key_file.into_temp_path();
        let mut config_file = tempfile::NamedTempFile::new().expect("temp config file");
        write!(
            config_file,
            r#"
client_edge_addr = "127.0.0.1:0"
{extra}

[signer]
key_file = "{}"
"#,
            key_path.display()
        )
        .expect("write config file");
        Config::load(config_file.path())
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

    /// `peer-carriage-spec.md` §11, and #620's gap 3 closed at last: the
    /// `[[peer_channels]]` table must **actually wire `ClaimBook`'s
    /// verification key and EIP-712 domain**, "with no code-only setters
    /// left on the config path".
    ///
    /// Before issue #678 the table loaded, validated and reached nothing,
    /// so every peer claim was refused `unknown_channel` and none was ever
    /// signed. `recognizes_channel` is the observable end of that wiring:
    /// it is true exactly when a counterparty address has been recorded
    /// for the channel, which is the record a peer claim's signature is
    /// recovered against.
    #[tokio::test]
    async fn peer_channels_reach_the_claim_ledger() {
        let state_dir = tempfile::tempdir().expect("temp state dir");
        let channel = format!("0x{}", "cd".repeat(32));
        let (config, _key_path) = config_with_raw_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:0"
state_dir = "{state_dir}"
peer_expose = "btp"

[signer]
key_file = "{key_file}"

[[peers]]
id = "store"
endpoint = "wss://store.example:443/ilp/btp"

[peers.credential]
secret = "a-real-peering-secret"

[[peer_channels]]
peer_id = "store"
channel_id = "{channel}"
counterparty_key = "0x00000000000000000000000000000000000000aa"
chain_id = 31337
token_network = "0x00000000000000000000000000000000000000bb"
"#,
                state_dir = state_dir.path().display(),
                key_file = key_path.display(),
            )
        });

        let runtime = build(&config).await.expect("build");

        assert!(
            runtime.connector.recognizes_channel(&channel),
            "the [[peer_channels]] row must reach ClaimBook's verification key, or every \
             peer claim on it is refused `unknown_channel` however correctly it was signed"
        );
        assert!(
            !runtime
                .connector
                .recognizes_channel(&format!("0x{}", "ee".repeat(32))),
            "and only that row -- a channel nobody configured is still unknown"
        );
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
        //
        // `/metrics` and `/admin/metrics.json` are asserted alongside it for
        // a reason `/routes` does not carry (issue #753). When the devnet cut
        // over to this connector the public demo dashboard lost the
        // TypeScript `/admin/metrics.json` it polled, and the obvious repair
        // -- serve a counter snapshot from the always-mounted client edge, so
        // no `[operator]` section is needed -- is exactly what ADR 0014
        // refused: the metrics surface is five decided names, in Prometheus
        // text, behind the operator surface's bearer token, "avoid[ing]
        // introducing a second, differently-authenticated (or
        // unauthenticated) HTTP surface". A node that configures no operator
        // therefore exposes no metrics AT ALL, which is the property this
        // asserts. `/admin/metrics.json` is named literally because that is
        // the path a future shim would be tempted to reintroduce.
        for path in ["/routes", "/metrics", "/admin/metrics.json"] {
            let request = Request::builder().uri(path).body(Body::empty()).unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::NOT_FOUND,
                "{path} must not be served without an [operator] section"
            );
        }
    }

    /// Issue #502, wired end to end: `router` reads `[[client_identities]]`
    /// off the same [`Config`] `build` validated and threads it into the
    /// client edge, so a request presenting an `ILP-Peer-Id` this node
    /// configures but the wrong secret is refused `401` by the router this
    /// crate actually serves -- not just the library-level unit tests in
    /// `connector-client-edge` that construct a `ConfiguredIdentity` by
    /// hand.
    #[tokio::test]
    async fn router_refuses_an_unauthenticated_client_identity() {
        let (config, _key_path) = config_with_raw_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"

[[client_identities]]
id = "peer-a"
secret = "s3cr3t"
"#,
                key_path.display()
            )
        });
        let runtime = build(&config).await.expect("build");
        let app = router(&runtime, &config).expect("router");

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .header("ilp-peer-id", "peer-a")
            .header("authorization", "Bearer wrong")
            .body(Body::from(vec![0u8; 4]))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    /// Issue #807, wired end to end: `router` reads `[announce]` off the
    /// same [`Config`] `build` validated and threads it into the client
    /// edge's [`connector_client_edge::BootstrapIdentity`], so a
    /// zero-condition PREPARE -- `packages/announcer/src/edge-client.ts`'s
    /// `fetchGreeting` probe shape -- answered by the router this crate
    /// actually serves carries this node's own `ilpAddresses`/`btpEndpoint`,
    /// not just the library-level unit tests in `connector-client-edge`
    /// that construct a [`connector_client_edge::BootstrapIdentity`] by
    /// hand.
    #[tokio::test]
    async fn router_answers_a_zero_condition_greeting_with_the_announce_configured_bootstrap_identity(
    ) {
        let (config, _key_path) = config_with_raw_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"

[announce]
addresses = ["g.toon.apex"]
http_endpoint = "https://apex.example/ilp"
btp_endpoint = "wss://apex.example/ilp/btp"
"#,
                key_path.display()
            )
        });
        let runtime = build(&config).await.expect("build");
        let app = router(&runtime, &config).expect("router");

        // A well-formed, zero-amount PREPARE with an all-zero execution
        // condition, addressed to this node's own configured address --
        // exactly the shape a client with no other way to learn
        // `ilpAddresses`/`btpEndpoint` sends when probing the edge it can
        // reach but has never bootstrapped against.
        let prepare = connector_domain::Prepare {
            amount: 0,
            expires_at: chrono::Utc::now() + chrono::Duration::seconds(30),
            execution_condition: [0u8; 32],
            destination: "g.toon.apex".to_string(),
            data: Vec::new(),
        };
        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(prepare.encode()))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let terms: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let extra = &terms["accepts"][0]["extra"];
        assert_eq!(extra["ilpAddresses"], serde_json::json!(["g.toon.apex"]));
        assert_eq!(extra["btpEndpoint"], "wss://apex.example/ilp/btp");
    }

    /// A structurally-valid EVM claim naming a channel this node has no
    /// record of -- built once and reused both plaintext and wrapped, so
    /// the only difference between the two requests below is the header
    /// carrying it.
    fn undeclared_channel_claim_json() -> String {
        format!(
            r#"{{
                "version": "1.0",
                "blockchain": "evm",
                "messageId": "msg-1",
                "timestamp": "2026-02-02T12:00:00.000Z",
                "senderId": "peer-bob",
                "channelId": "0x{channel}",
                "nonce": 1,
                "transferredAmount": "0",
                "lockedAmount": "0",
                "locksRoot": "0x{zeros}",
                "signature": "0xabcdef",
                "signerAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1"
            }}"#,
            channel = "ab".repeat(32),
            zeros = "0".repeat(64),
        )
    }

    fn hex_encode_bytes(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn base64_encode_bytes(bytes: &[u8]) -> String {
        use base64::engine::general_purpose::STANDARD as BASE64;
        use base64::Engine;
        BASE64.encode(bytes)
    }

    /// A well-formed `ILP-Payment-Channel-Claim-Wrapped` envelope, NIP-59
    /// sealing `claim_json` to `receiver_public`.
    fn wrapped_claim_header_value(claim_json: &str, receiver_public: &[u8; 65]) -> String {
        use libsecp256k1::SecretKey;

        let sender_secret = SecretKey::parse(&[3u8; 32]).expect("valid secret key");
        let wrapped =
            connector_signer::wrap_claim(claim_json.as_bytes(), &sender_secret, receiver_public)
                .expect("wrap claim");
        let envelope_json = format!(
            r#"{{"ephemeralPublicKey":"{}","encryptedPayload":"{}","timestamp":0,"version":"1.0"}}"#,
            hex_encode_bytes(&wrapped.ephemeral_public_key),
            base64_encode_bytes(&wrapped.encrypted_payload),
        );
        base64_encode_bytes(envelope_json.as_bytes())
    }

    fn unmatched_destination_prepare_body() -> Vec<u8> {
        connector_domain::Prepare {
            amount: 0,
            expires_at: chrono::Utc::now() + chrono::Duration::seconds(30),
            execution_condition: [1u8; 32],
            destination: "g.example.unmatched".to_string(),
            data: Vec::new(),
        }
        .encode()
    }

    /// Issue #556, item 1: `router` now passes the `[signer]` key as
    /// `wrap_receiver_secret` instead of `None`, so a claim wrapped to this
    /// node's own signer key is unwrapped rather than refused
    /// `WrapUnsupported` -- and then runs the exact same client-edge gate a
    /// plaintext claim runs, unwrapping granting no exemption at the step
    /// that follows it. Proven by wrapping a claim that names a channel
    /// this node has no record of, and getting back the identical
    /// `UnknownChannel` rejection a plaintext claim for the same channel
    /// gets -- see the next test.
    #[tokio::test]
    async fn router_unwraps_a_claim_wrapped_to_the_signer_key_and_runs_the_identical_gate() {
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
        let receiver_public = runtime.signer.public_key().expect("signer public key");
        let app = router(&runtime, &config).expect("router");

        let claim_json = undeclared_channel_claim_json();
        let wrapped_header = wrapped_claim_header_value(&claim_json, &receiver_public);

        let plaintext_request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .header(
                "ilp-payment-channel-claim",
                base64_encode_bytes(claim_json.as_bytes()),
            )
            .body(Body::from(unmatched_destination_prepare_body()))
            .unwrap();
        let plaintext_response = app.clone().oneshot(plaintext_request).await.unwrap();
        assert_eq!(plaintext_response.status(), StatusCode::OK);
        let plaintext_bytes = hyper::body::to_bytes(plaintext_response.into_body())
            .await
            .unwrap();
        let plaintext_reject =
            connector_domain::Reject::decode(&plaintext_bytes).expect("decode reject");

        let wrapped_request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .header("ilp-payment-channel-claim-wrapped", wrapped_header)
            .body(Body::from(unmatched_destination_prepare_body()))
            .unwrap();
        let wrapped_response = app.oneshot(wrapped_request).await.unwrap();
        assert_eq!(wrapped_response.status(), StatusCode::OK);
        let wrapped_bytes = hyper::body::to_bytes(wrapped_response.into_body())
            .await
            .unwrap();
        let wrapped_reject =
            connector_domain::Reject::decode(&wrapped_bytes).expect("decode reject");

        assert!(
            wrapped_reject.message.contains("no record of"),
            "expected an UnknownChannel rejection, got {wrapped_reject:?}"
        );
        assert_eq!(
            wrapped_reject.code, plaintext_reject.code,
            "a wrapped claim must run the identical gate a plaintext claim runs"
        );
        assert_eq!(
            wrapped_reject.message, plaintext_reject.message,
            "unwrapping must grant no exemption -- the same claim rejected the same way \
             whichever header carried it"
        );
    }

    /// Issue #556's other acceptance criterion for the receiver key: a wrap
    /// addressed to a key that is not this node's `[signer]` key fails to
    /// unwrap -- refused `WrapFailed` -- distinguishably both from a
    /// malformed wrap (`Malformed`) and from the plaintext `UnknownChannel`
    /// rejection the previous test established.
    #[tokio::test]
    async fn router_refuses_a_wrap_addressed_to_a_different_receiver_distinguishably() {
        use libsecp256k1::{PublicKey, SecretKey};

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

        // A key that is deliberately NOT this node's own [signer] key.
        let other_receiver_secret = SecretKey::parse(&[9u8; 32]).expect("valid secret key");
        let other_receiver_public = PublicKey::from_secret_key(&other_receiver_secret).serialize();
        let claim_json = undeclared_channel_claim_json();
        let wrong_receiver_header = wrapped_claim_header_value(&claim_json, &other_receiver_public);

        let wrong_receiver_request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .header("ilp-payment-channel-claim-wrapped", wrong_receiver_header)
            .body(Body::from(unmatched_destination_prepare_body()))
            .unwrap();
        let wrong_receiver_response = app.clone().oneshot(wrong_receiver_request).await.unwrap();
        assert_eq!(wrong_receiver_response.status(), StatusCode::OK);
        let wrong_receiver_bytes = hyper::body::to_bytes(wrong_receiver_response.into_body())
            .await
            .unwrap();
        let wrong_receiver_reject =
            connector_domain::Reject::decode(&wrong_receiver_bytes).expect("decode reject");
        assert!(
            wrong_receiver_reject
                .message
                .contains("failed to unwrap claim"),
            "expected a WrapFailed rejection, got {wrong_receiver_reject:?}"
        );

        let malformed_request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .header("ilp-payment-channel-claim-wrapped", "not-valid-base64!!")
            .body(Body::from(unmatched_destination_prepare_body()))
            .unwrap();
        let malformed_response = app.oneshot(malformed_request).await.unwrap();
        assert_eq!(malformed_response.status(), StatusCode::OK);
        let malformed_bytes = hyper::body::to_bytes(malformed_response.into_body())
            .await
            .unwrap();
        let malformed_reject =
            connector_domain::Reject::decode(&malformed_bytes).expect("decode reject");

        assert_ne!(
            wrong_receiver_reject.message, malformed_reject.message,
            "a wrap addressed to the wrong receiver is a different failure from a malformed wrap"
        );
        assert_ne!(
            wrong_receiver_reject.message,
            // The gate's own wording, not a copy of it: a reworded
            // `UnknownChannel` must not quietly make this assertion vacuous.
            connector_client_edge::ClaimIngestRejection::UnknownChannel.message(),
            "a wrap addressed to the wrong receiver must fail to unwrap, not fall through to an \
             UnknownChannel rejection"
        );
    }

    /// The one narrowing in this crate that guards a false-accept boundary
    /// (issue #646): an on-chain deposit is a `uint256` and a claim's
    /// cumulative amount is a `u64`, so the deposit has to be narrowed to
    /// be compared -- and narrowing the wrong way round would turn a huge
    /// deposit into a tiny cap (refusing good claims) or, far worse, a
    /// wrapped small number into a huge one. `ethers`' own `U256::as_u64`
    /// panics above the range; this clamps, which is sound *only* because
    /// the value is an upper bound on a `u64`: no `u64` can exceed
    /// `u64::MAX`, so a deposit wider than that and a deposit of exactly
    /// `u64::MAX` cap identically.
    #[test]
    fn a_deposit_wider_than_u64_clamps_rather_than_wrapping_or_panicking() {
        assert_eq!(saturating_u64(U256::zero()), 0);
        assert_eq!(saturating_u64(U256::from(1_000u64)), 1_000);
        assert_eq!(saturating_u64(U256::from(u64::MAX)), u64::MAX);
        assert_eq!(
            saturating_u64(U256::from(u64::MAX) + U256::one()),
            u64::MAX,
            "one past the boundary clamps rather than wrapping to 0"
        );
        assert_eq!(
            saturating_u64(U256::MAX),
            u64::MAX,
            "a deposit no u64 claim could ever exceed caps at the largest one that could"
        );
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

        assert!(client_channels(&config, None, None).is_empty());
    }

    /// The liveness knobs reach the registry rather than stopping at the
    /// config struct (issue #649, and the availability review of #654):
    /// an operator who widens the re-attempt floor because their RPC
    /// endpoint is rate-limited has to actually get a widened floor.
    ///
    /// Asserted through behaviour rather than a getter, since the registry
    /// deliberately exposes none: with the interval set to ten minutes, a
    /// second lookup on the same channel inside that window must not reach
    /// the source at all.
    #[tokio::test]
    async fn the_configured_liveness_knobs_reach_the_registry() {
        use connector_client_edge::{ChannelLookupFailed, DepositFloor, EvmChannel};
        use std::sync::atomic::{AtomicUsize, Ordering};

        #[derive(Debug, Default)]
        struct CountingSource {
            lookups: AtomicUsize,
        }

        #[async_trait]
        impl ClientChannelSource for CountingSource {
            async fn evm_channel(
                &self,
                _channel_id: &[u8; 32],
            ) -> Result<Option<EvmChannel>, ChannelLookupFailed> {
                self.lookups.fetch_add(1, Ordering::SeqCst);
                Ok(Some(EvmChannel {
                    counterparty: [0x11; 20],
                    chain_id: 8453,
                    token_network_address: [0x42; 20],
                    deposit_floor: DepositFloor::AtLeast(1_000),
                }))
            }
        }

        let (config, _key_path) = config_with_raw_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:0"
channel_liveness_ttl_secs = 1
channel_serve_stale_secs = 600
channel_reattempt_interval_ms = 600000

[signer]
key_file = "{}"
"#,
                key_path.display()
            )
        });

        let source = Arc::new(CountingSource::default());
        let channels = client_channels(&config, Some(source.clone()), None);
        let gate = ClientClaimGate::restore(channels, Arc::new(InMemoryJournal::new()))
            .expect("a fresh in-memory journal has nothing to replay");

        // Two claims on the same channel, either side of the one-second
        // ttl. Both are refused for their signature -- what matters is how
        // many times the source was consulted.
        let claim = |nonce: u64| {
            format!(
                r#"{{
                    "version": "1.0",
                    "blockchain": "evm",
                    "messageId": "msg-{nonce}",
                    "timestamp": "2026-02-02T12:00:00.000Z",
                    "senderId": "peer-bob",
                    "channelId": "0x{id}",
                    "nonce": {nonce},
                    "transferredAmount": "10",
                    "lockedAmount": "0",
                    "locksRoot": "0x{zeros}",
                    "signature": "0x{sig}",
                    "signerAddress": "0x1111111111111111111111111111111111111111"
                }}"#,
                id = "ab".repeat(32),
                zeros = "0".repeat(64),
                sig = "cd".repeat(65),
            )
        };
        let _ = gate.ingest(&claim(1), 0).await;
        tokio::time::sleep(std::time::Duration::from_millis(1_200)).await;
        let _ = gate.ingest(&claim(2), 0).await;

        assert_eq!(
            source.lookups.load(Ordering::SeqCst),
            1,
            "the entry aged out, but the configured ten-minute re-attempt floor still binds"
        );
    }

    /// The unresolvable-lookup budget's knobs reach the registry too
    /// (issue #613). Asserted through behaviour for the same reason as
    /// above: with a node-wide allowance of two, a sender walking channel
    /// ids reaches the source twice and no more, however many claims they
    /// present.
    #[tokio::test]
    async fn the_configured_lookup_budget_reaches_the_registry() {
        use connector_client_edge::{ChannelLookupFailed, EvmChannel};
        use std::sync::atomic::{AtomicUsize, Ordering};

        /// A chain that knows about no channel at all -- which is what a
        /// walk of the id space looks like from the connector's side.
        #[derive(Debug, Default)]
        struct EmptyCountingSource {
            lookups: AtomicUsize,
        }

        #[async_trait]
        impl ClientChannelSource for EmptyCountingSource {
            async fn evm_channel(
                &self,
                _channel_id: &[u8; 32],
            ) -> Result<Option<EvmChannel>, ChannelLookupFailed> {
                self.lookups.fetch_add(1, Ordering::SeqCst);
                Ok(None)
            }
        }

        let (config, _key_path) = config_with_raw_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:0"
unresolvable_lookup_budget_per_signer = 2
unresolvable_lookup_budget_total = 2
unresolvable_lookup_budget_window_secs = 600
unresolvable_lookup_budget_max_wait_ms = 1

[signer]
key_file = "{}"
"#,
                key_path.display()
            )
        });

        let source = Arc::new(EmptyCountingSource::default());
        let channels = client_channels(&config, Some(source.clone()), None);
        let gate = ClientClaimGate::restore(channels, Arc::new(InMemoryJournal::new()))
            .expect("a fresh in-memory journal has nothing to replay");

        // A fresh channel id per claim, which is the whole shape of the
        // attack: nothing this connector has ever seen, and nothing it ever
        // will resolve.
        let claim = |nonce: u64| {
            format!(
                r#"{{
                    "version": "1.0",
                    "blockchain": "evm",
                    "messageId": "msg-{nonce}",
                    "timestamp": "2026-02-02T12:00:00.000Z",
                    "senderId": "peer-bob",
                    "channelId": "0x{nonce:064x}",
                    "nonce": {nonce},
                    "transferredAmount": "10",
                    "lockedAmount": "0",
                    "locksRoot": "0x{zeros}",
                    "signature": "0x{sig}",
                    "signerAddress": "0x1111111111111111111111111111111111111111"
                }}"#,
                zeros = "0".repeat(64),
                sig = "cd".repeat(65),
            )
        };
        let mut budgeted = 0;
        for nonce in 1..=20 {
            if matches!(
                gate.ingest(&claim(nonce), 0).await,
                Err(connector_client_edge::ClaimIngestRejection::LookupBudgetExhausted { .. })
            ) {
                budgeted += 1;
            }
        }

        assert_eq!(
            source.lookups.load(Ordering::SeqCst),
            2,
            "twenty claims on twenty channels cost the configured allowance and no more"
        );
        assert_eq!(
            budgeted, 18,
            "and every claim past it says why it was refused"
        );
    }

    /// `connector-config` restates the client edge's own budget defaults so
    /// that it can validate a one-sided configuration against the values
    /// that will actually be in force (issue #613's review). Restating them
    /// is only safe if they cannot drift, and this is the only crate that
    /// can see both.
    #[test]
    fn the_config_layers_budget_defaults_match_the_client_edges() {
        use connector_client_edge::MAX_UNRESOLVABLE_LOOKUP_WINDOW;

        let edge = UnresolvableLookupBudgetPolicy::default();

        // A configuration naming *only* the node-wide rate, set to exactly
        // the client edge's own default per-signer rate. If the config
        // layer's copy of that default agrees, this is coherent and loads;
        // if the two had drifted in either direction, one of the four
        // assertions here would fail.
        assert!(
            raw_config_result(&format!(
                "unresolvable_lookup_budget_total = {}",
                edge.per_signer
            ))
            .is_ok(),
            "per_signer == total is coherent, so the config layer's default per-signer rate is \
             not above {}",
            edge.per_signer
        );
        assert!(
            raw_config_result(&format!(
                "unresolvable_lookup_budget_total = {}",
                edge.per_signer - 1
            ))
            .is_err(),
            "...and not below it either"
        );

        // The node-wide default, checked from the other side.
        assert!(raw_config_result(&format!(
            "unresolvable_lookup_budget_per_signer = {}",
            edge.total
        ))
        .is_ok());
        assert!(raw_config_result(&format!(
            "unresolvable_lookup_budget_per_signer = {}",
            edge.total + 1
        ))
        .is_err());

        // ...and the window and wait ceiling, by the same trick: a ceiling
        // exactly equal to the default window is coherent, one millisecond
        // past it is not.
        assert!(raw_config_result(&format!(
            "unresolvable_lookup_budget_max_wait_ms = {}",
            edge.window.as_millis()
        ))
        .is_ok());
        assert!(raw_config_result(&format!(
            "unresolvable_lookup_budget_max_wait_ms = {}",
            edge.window.as_millis() + 1
        ))
        .is_err());

        // And the cap the client edge clamps a window to is the one the
        // config layer refuses above.
        assert!(raw_config_result(&format!(
            "unresolvable_lookup_budget_window_secs = {}",
            MAX_UNRESOLVABLE_LOOKUP_WINDOW.as_secs()
        ))
        .is_ok());
        assert!(raw_config_result(&format!(
            "unresolvable_lookup_budget_window_secs = {}",
            MAX_UNRESOLVABLE_LOOKUP_WINDOW.as_secs() + 1
        ))
        .is_err());
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

        let channels = client_channels(&config, None, None);
        assert!(!channels.is_empty());
        let ClientChannelConfig::Evm(evm) = &config.client_channels()[0] else {
            panic!("expected an EVM client channel");
        };
        assert_eq!(evm.chain_id(), 8453);
        assert_eq!(evm.counterparty()[19], 0xaa);
    }

    /// The Solana twin of the above (issue #630): a declared Solana channel
    /// reaches the client edge's registry the same way a declared EVM one
    /// does, through [`ClientChannelRegistry::record_solana`].
    #[test]
    fn every_configured_solana_client_channel_is_recorded() {
        let state_dir = tempfile::tempdir().expect("temp state dir");
        let account = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
        let counterparty = "8pM1DN3RiT8vbom5u1sNryaNT1nyL8CTTW3b5PwWXRBH";
        let (config, _key_path) = config_with_raw_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:0"
state_dir = "{state_dir}"

[signer]
key_file = "{key_path}"

[[client_channels]]
channel_account = "{account}"
counterparty = "{counterparty}"
"#,
                key_path = key_path.display(),
                state_dir = state_dir.path().display(),
            )
        });

        let channels = client_channels(&config, None, None);
        assert!(!channels.is_empty());
        let ClientChannelConfig::Solana(solana) = &config.client_channels()[0] else {
            panic!("expected a Solana client channel");
        };
        assert_eq!(solana.channel_account(), account);
        assert_eq!(solana.counterparty(), counterparty);
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

        client_claim_gate(&config, test_signer(), None, None)
            .expect("a writable state_dir produces a gate");
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

        let Err(error) = client_claim_gate(&config, test_signer(), None, None) else {
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

        let Err(error) = client_claim_gate(&config, test_signer(), None, None) else {
            panic!("a corrupt journal must not produce a gate");
        };
        assert!(matches!(error, RuntimeError::JournalUnreplayable { .. }));
    }

    /// The peer wire's own journal is armed off the same `state_dir`
    /// (issue #605, #556's "Journal" row): one answer for both surfaces,
    /// not a fix for the client edge and the same bug left standing on the
    /// wire between connectors.
    #[tokio::test]
    async fn a_configured_state_dir_also_arms_the_peer_claim_journal() {
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
        assert!(state_dir.path().join(PEER_CLAIM_JOURNAL).exists());
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
        use connector_settlement_evm::{ChannelIndexEvent, OrderedChannelIndexEvent};
        use connector_settlement_solana::test_support::{
            fund, require_solana_test_validator, SolanaValidator, LOCAL_TEST_PROGRAM_ID,
        };
        use connector_settlement_solana::SolanaSettlementBackend;
        use ethers::signers::Signer as EvmSigner;
        use solana_rpc_client::nonblocking::rpc_client::RpcClient;
        use solana_sdk::commitment_config::CommitmentConfig;
        use solana_sdk::signature::{Keypair, Signer as SolanaSigner};

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

        /// A `[settlement.solana]` (or `[settlement.solana.key]`) key file
        /// carrying `seed` as 32 raw bytes -- the ed25519 seed
        /// [`SolanaSettlementBackend::connect`] signs with, the Solana
        /// twin of [`key_file_with`]'s hex-encoded secp256k1 key.
        fn raw_key_file(seed: [u8; 32]) -> tempfile::TempPath {
            let mut file = tempfile::NamedTempFile::new().expect("temp key file");
            file.write_all(&seed).expect("write raw key file");
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
                .open_channel(None, counterparty, Duration::seconds(3600))
                .await
                .expect("a settlement backend was constructed and attached");
            assert_eq!(opened.deposited, 0);
        }

        /// The raw 32 bytes behind a `ChannelId`'s `0x`-prefixed 64-hex
        /// string -- what every on-chain-facing type in these tests keys a
        /// channel by.
        fn channel_id_bytes(id: &str) -> [u8; 32] {
            let hex_digits = id.trim_start_matches("0x");
            let mut out = [0u8; 32];
            for (i, byte) in out.iter_mut().enumerate() {
                *byte = u8::from_str_radix(&hex_digits[i * 2..i * 2 + 2], 16)
                    .expect("channel id is 0x-prefixed 64-hex");
            }
            out
        }

        /// Issue #661's own acceptance criterion, proven at the seam
        /// `connector-cli` actually wires: "an EVM channel the index holds
        /// resolves with zero RPC calls on the packet path -- asserted by a
        /// test that counts provider calls, not by inspection". Rather than
        /// build a call-counting RPC proxy, this kills the fallback's own
        /// path to the chain outright (the anvil process backing it is
        /// dropped) after the index has been populated -- if
        /// `IndexedEvmChannelSource::evm_channel` ever consulted the
        /// fallback for this channel, the lookup would fail with a
        /// connection error instead of answering correctly.
        #[tokio::test]
        async fn an_index_resolved_channel_answers_correctly_with_the_chain_unreachable() {
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
            let backend = EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, token)
                .await
                .expect("deploy a TokenNetwork through a fresh registry");

            let counterparty_address =
                ethers::signers::LocalWallet::new(&mut ethers::core::rand::thread_rng()).address();
            let channel = backend
                .open(
                    counterparty_address.as_bytes().to_vec(),
                    Duration::seconds(3601),
                )
                .await
                .expect("open a channel");
            backend.fund(&channel, 750).await.expect("fund the channel");

            let channel_id = channel_id_bytes(&channel.0);
            let index = Arc::new(EvmChannelIndex::open(None).expect("open in-memory index"));
            index
                .apply(
                    vec![
                        OrderedChannelIndexEvent {
                            block_number: 1,
                            log_index: 0,
                            event: ChannelIndexEvent::Opened {
                                channel_id,
                                participant1: backend.own_address(),
                                participant2: counterparty_address,
                            },
                        },
                        OrderedChannelIndexEvent {
                            block_number: 2,
                            log_index: 0,
                            event: ChannelIndexEvent::NewDeposit {
                                channel_id,
                                participant: counterparty_address,
                                total_deposit: ethers::types::U256::from(750u64),
                            },
                        },
                    ],
                    2,
                )
                .expect("apply");

            let source = IndexedEvmChannelSource {
                index,
                fallback: SettlementChannelSource {
                    backend: Arc::new(backend),
                },
            };

            // Kill the chain the fallback would otherwise read from -- a
            // subsequent `eth_call` through it fails with a connection
            // error, so a wrong answer here (or an error) proves the
            // index was bypassed.
            drop(anvil);

            let resolved = source
                .evm_channel(&channel_id)
                .await
                .expect("the index answered without touching the (now-dead) chain")
                .expect("the channel is active in the index");
            assert_eq!(resolved.counterparty, counterparty_address.to_fixed_bytes());
            assert_eq!(resolved.deposit_floor, DepositFloor::AtLeast(750));
        }

        /// The follow-up finding on issue #661's PR: an indexed deposit
        /// lags the chain by the confirmation depth, so a channel whose
        /// `ChannelOpened` is confirmed but whose `ChannelNewDeposit` is
        /// not answers `Active` with a floor of zero -- and a breach
        /// re-read served from the same index would refuse a claim the
        /// chain honours. `evm_channel_fresh` must bypass the index and
        /// read the chain, exactly as a node on `main` would have.
        #[tokio::test]
        async fn a_breach_re_read_bypasses_the_index_and_reads_the_chain() {
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
            let backend = EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, token)
                .await
                .expect("deploy a TokenNetwork through a fresh registry");

            let counterparty_address =
                ethers::signers::LocalWallet::new(&mut ethers::core::rand::thread_rng()).address();
            let channel = backend
                .open(
                    counterparty_address.as_bytes().to_vec(),
                    Duration::seconds(3601),
                )
                .await
                .expect("open a channel");
            backend.fund(&channel, 750).await.expect("fund the channel");

            // The index has seen the open but not the deposit -- the
            // "confirmed `ChannelOpened`, unconfirmed `ChannelNewDeposit`"
            // window the finding describes.
            let channel_id = channel_id_bytes(&channel.0);
            let index = Arc::new(EvmChannelIndex::open(None).expect("open in-memory index"));
            index
                .apply(
                    vec![OrderedChannelIndexEvent {
                        block_number: 1,
                        log_index: 0,
                        event: ChannelIndexEvent::Opened {
                            channel_id,
                            participant1: backend.own_address(),
                            participant2: counterparty_address,
                        },
                    }],
                    1,
                )
                .expect("apply");

            let source = IndexedEvmChannelSource {
                index: index.clone(),
                fallback: SettlementChannelSource {
                    backend: Arc::new(backend),
                },
            };

            // The ordinary read answers from the index: floor zero.
            let cached = source
                .evm_channel(&channel_id)
                .await
                .expect("index lookup")
                .expect("active in the index");
            assert_eq!(cached.deposit_floor, DepositFloor::AtLeast(0));

            // The breach read reaches the chain and finds the real 750.
            let fresh = source
                .evm_channel_fresh(&channel_id)
                .await
                .expect("chain lookup")
                .expect("active on chain");
            assert_eq!(fresh.deposit_floor, DepositFloor::AtLeast(750));

            // A terminal record, though, stays answered from the index
            // even on a breach: settlement is monotone and the index only
            // applies confirmed logs, so the chain could only repeat it.
            // Proven the same way as the lookup test above: with the chain
            // dead, an answer at all is proof the index answered.
            index
                .apply(
                    vec![OrderedChannelIndexEvent {
                        block_number: 2,
                        log_index: 0,
                        event: ChannelIndexEvent::Settled { channel_id },
                    }],
                    2,
                )
                .expect("apply the settlement");
            drop(anvil);
            assert_eq!(
                source
                    .evm_channel_fresh(&channel_id)
                    .await
                    .expect("the terminal answer needs no chain"),
                None
            );
        }

        /// Issue #632's EVM-only acceptance criterion: "EVM-only node:
        /// greeting unchanged apart from the additive one-entry list" --
        /// `build` composes both the legacy singular `settlement_terms` and
        /// the new `settlements` list from the same EVM backend, and the
        /// two agree.
        #[tokio::test]
        async fn an_evm_only_node_composes_the_legacy_terms_and_a_one_entry_settlements_list() {
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
            let terms = runtime
                .settlement_terms
                .clone()
                .expect("an EVM settlement section composes the legacy greeting terms");
            assert_eq!(
                runtime.settlements,
                vec![connector_client_edge::X402ChainSettlementTerms::Evm(terms)],
                "an EVM-only node's settlements list is a one-entry list matching the legacy terms verbatim"
            );
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
                .open_channel(
                    None,
                    b"no-settlement-peer".to_vec(),
                    Duration::seconds(3600),
                )
                .await;
            assert!(matches!(
                result,
                Err(connector_runtime::ChannelOperationError::NoSettlementBackend)
            ));
        }

        /// AC (issue #630): "Node with `[settlement.solana]` starts against
        /// the devnet validator" -- driven end to end through `build`
        /// reading a config file (no backend injected directly), the
        /// Solana twin of
        /// `a_configured_settlement_section_is_constructed_and_attached`
        /// above: a real, disposable `solana-test-validator` running the
        /// real `packages/solana-program` artifact, and the resulting
        /// `Connector` opens a real channel through it.
        #[tokio::test]
        async fn a_solana_only_settlement_section_is_constructed_and_attached() {
            if !require_solana_test_validator() {
                return;
            }

            let validator = SolanaValidator::spawn().await;
            let program_id =
                Pubkey::from_str(LOCAL_TEST_PROGRAM_ID).expect("valid local test program id");
            let deployed = SolanaSettlementBackend::deploy(&validator.rpc_url, program_id)
                .await
                .expect("bind to the genesis-loaded payment-channel program");
            let token_mint = deployed.token_mint();
            drop(deployed);

            let seed = [11u8; 32];
            let payer =
                solana_sdk::signer::keypair::keypair_from_seed(&seed).expect("derive keypair");
            let rpc = RpcClient::new_with_commitment(
                validator.rpc_url.clone(),
                CommitmentConfig::confirmed(),
            );
            fund(&rpc, &payer.pubkey()).await;

            let key_path = raw_key_file(seed);
            let config = load_config(&format!(
                r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{key_path}"

[settlement.solana]
rpc_url = "{rpc_url}"
program_id = "{program_id}"
token_address = "{token_mint}"
decimals = 6

[settlement.solana.key]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
                rpc_url = validator.rpc_url,
            ));

            let runtime = build(&config).await.expect("build");
            let connector = runtime.connector.clone();
            // A real 32-byte Solana pubkey (issue #567's `open` accepts
            // nothing else): a fresh identity this test holds no key for,
            // exactly as `a_configured_settlement_section_is_constructed_and_attached`
            // generates an arbitrary EVM counterparty above.
            let counterparty = Keypair::new().pubkey().to_bytes().to_vec();
            let opened = connector
                .open_channel(None, counterparty, Duration::seconds(3600))
                .await
                .expect("a solana settlement backend was constructed and attached");
            assert_eq!(opened.deposited, 0);
        }

        /// AC (issue #630): "... decimals/asset-scale mismatch refuses
        /// startup with a clear error" -- the Solana twin of
        /// `settlement_decimals_the_token_disagrees_with_refuses_to_build`
        /// above. `deploy` mints a fresh 6-decimal SPL mint; a config file
        /// claiming `decimals = 9` against it must fail to build rather
        /// than load clean and settle at a scale nobody consults.
        #[tokio::test]
        async fn solana_decimals_the_mint_disagrees_with_refuses_to_build() {
            if !require_solana_test_validator() {
                return;
            }

            let validator = SolanaValidator::spawn().await;
            let program_id =
                Pubkey::from_str(LOCAL_TEST_PROGRAM_ID).expect("valid local test program id");
            let deployed = SolanaSettlementBackend::deploy(&validator.rpc_url, program_id)
                .await
                .expect("bind to the genesis-loaded payment-channel program");
            let token_mint = deployed.token_mint();
            drop(deployed);

            let seed = [12u8; 32];
            let payer =
                solana_sdk::signer::keypair::keypair_from_seed(&seed).expect("derive keypair");
            let rpc = RpcClient::new_with_commitment(
                validator.rpc_url.clone(),
                CommitmentConfig::confirmed(),
            );
            fund(&rpc, &payer.pubkey()).await;

            let key_path = raw_key_file(seed);
            let config = load_config(&format!(
                r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{key_path}"

[settlement.solana]
rpc_url = "{rpc_url}"
program_id = "{program_id}"
token_address = "{token_mint}"
decimals = 9

[settlement.solana.key]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
                rpc_url = validator.rpc_url,
            ));

            let error = build(&config)
                .await
                .err()
                .expect("a decimals the mint disagrees with refuses to build");
            let message = error.to_string();
            assert!(
                message.contains("decimals is 9") && message.contains("decimals = 6"),
                "the failure must name both the configured and the on-chain decimals: {message}"
            );
        }

        /// A config naming both `[settlement.evm]` and `[settlement.solana]`
        /// constructs both real backends and the built `Connector` holds
        /// *both*, each reachable on its own chain (issue #630, and its
        /// review's merge blocker: `Connector`'s settlement slot was
        /// last-one-wins, so on exactly this config every operator channel
        /// op silently targeted Solana -- an EVM `open_channel` here
        /// answered "a packages/solana-program counterparty must be a
        /// 32-byte Solana pubkey, got 20 bytes"). Driven end to end
        /// through `build` reading a config file: an EVM operator op lands
        /// on the EVM backend (a real channel opens on the anvil chain), a
        /// Solana one on the Solana backend, and per-channel-id ops route
        /// each id to its own chain.
        #[tokio::test]
        async fn a_both_chains_config_attaches_and_routes_both_backends() {
            if !anvil_available() {
                eprintln!(
                    "skipping: `anvil` not found on PATH (install via https://getfoundry.sh)"
                );
                return;
            }
            if !require_solana_test_validator() {
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

            let validator = SolanaValidator::spawn().await;
            let program_id =
                Pubkey::from_str(LOCAL_TEST_PROGRAM_ID).expect("valid local test program id");
            let deployed = SolanaSettlementBackend::deploy(&validator.rpc_url, program_id)
                .await
                .expect("bind to the genesis-loaded payment-channel program");
            let token_mint = deployed.token_mint();
            drop(deployed);

            let seed = [13u8; 32];
            let payer =
                solana_sdk::signer::keypair::keypair_from_seed(&seed).expect("derive keypair");
            let rpc = RpcClient::new_with_commitment(
                validator.rpc_url.clone(),
                CommitmentConfig::confirmed(),
            );
            fund(&rpc, &payer.pubkey()).await;

            let evm_key_path = key_file_with(DEPLOYER_PRIVATE_KEY);
            let solana_key_path = raw_key_file(seed);
            let config = load_config(&format!(
                r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{evm_key_path}"

[settlement.evm]
rpc_url = "{evm_rpc_url}"
contract_address = "{registry_address:?}"
token_address = "{token:?}"
decimals = 6

[settlement.evm.key]
key_file = "{evm_key_path}"

[settlement.solana]
rpc_url = "{solana_rpc_url}"
program_id = "{program_id}"
token_address = "{token_mint}"
decimals = 6

[settlement.solana.key]
key_file = "{solana_key_path}"
"#,
                evm_key_path = evm_key_path.display(),
                solana_key_path = solana_key_path.display(),
                evm_rpc_url = anvil.rpc_url,
                solana_rpc_url = validator.rpc_url,
                registry_address = registry_address,
                token = token,
            ));

            let runtime = build(&config)
                .await
                .expect("both legs construct and attach without either refusing startup");
            let connector = runtime.connector.clone();

            // The regression op: an EVM channel open on a both-chains node
            // must reach the EVM backend. On the last-one-wins slot this
            // exact call hit the Solana backend and refused the 20-byte
            // counterparty.
            let evm_counterparty =
                ethers::signers::LocalWallet::new(&mut ethers::core::rand::thread_rng())
                    .address()
                    .as_bytes()
                    .to_vec();
            let evm_channel = connector
                .open_channel(
                    Some(SettlementChain::Evm),
                    evm_counterparty,
                    Duration::seconds(3600),
                )
                .await
                .expect("an EVM open on a both-chains node reaches the EVM backend");
            assert!(
                evm_channel.id.starts_with("0x"),
                "a TokenNetwork bytes32 channel id, not a Solana account: {}",
                evm_channel.id
            );

            // The Solana twin.
            let solana_counterparty = Keypair::new().pubkey().to_bytes().to_vec();
            let solana_channel = connector
                .open_channel(
                    Some(SettlementChain::Solana),
                    solana_counterparty,
                    Duration::seconds(3600),
                )
                .await
                .expect("a Solana open on a both-chains node reaches the Solana backend");
            assert!(
                Pubkey::from_str(&solana_channel.id).is_ok(),
                "a channel PDA account address, not a TokenNetwork bytes32: {}",
                solana_channel.id
            );

            // Both backends are attached and reachable: the operator's
            // channel list reports each channel fresh from its own chain.
            let channels = connector.channels().await;
            assert_eq!(channels.len(), 2);
            assert!(channels.iter().any(|view| view.id == evm_channel.id));
            assert!(channels.iter().any(|view| view.id == solana_channel.id));

            // Per-channel-id ops route by the id's own namespace: closing
            // each channel lands on the chain that opened it (on the
            // last-one-wins slot, closing the EVM id asked Solana, which
            // knows no such channel).
            connector
                .close_channel(&evm_channel.id)
                .await
                .expect("closing the EVM channel routes to the EVM backend");
            connector
                .close_channel(&solana_channel.id)
                .await
                .expect("closing the Solana channel routes to the Solana backend");

            // And an open that names no chain is ambiguous here, not
            // silently resolved to either backend.
            let ambiguous = connector
                .open_channel(
                    None,
                    Keypair::new().pubkey().to_bytes().to_vec(),
                    Duration::seconds(3600),
                )
                .await;
            assert!(matches!(
                ambiguous,
                Err(connector_runtime::ChannelOperationError::AmbiguousSettlementChain)
            ));
        }

        /// Issue #632's two-chain acceptance criterion: "Two-chain node:
        /// greeting carries both chains' entries in `settlements`; legacy
        /// `settlement` object unchanged". Driven through the same real
        /// anvil + solana-test-validator harness
        /// `a_both_chains_config_attaches_and_routes_both_backends` uses,
        /// so both chains' facts genuinely came from live `connect()` calls
        /// rather than a fixture.
        #[tokio::test]
        async fn a_both_chains_config_composes_both_chains_greeting_facts() {
            if !anvil_available() {
                eprintln!(
                    "skipping: `anvil` not found on PATH (install via https://getfoundry.sh)"
                );
                return;
            }
            if !require_solana_test_validator() {
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

            let validator = SolanaValidator::spawn().await;
            let program_id =
                Pubkey::from_str(LOCAL_TEST_PROGRAM_ID).expect("valid local test program id");
            let deployed = SolanaSettlementBackend::deploy(&validator.rpc_url, program_id)
                .await
                .expect("bind to the genesis-loaded payment-channel program");
            let token_mint = deployed.token_mint();
            drop(deployed);

            let seed = [17u8; 32];
            let payer =
                solana_sdk::signer::keypair::keypair_from_seed(&seed).expect("derive keypair");
            let rpc = RpcClient::new_with_commitment(
                validator.rpc_url.clone(),
                CommitmentConfig::confirmed(),
            );
            fund(&rpc, &payer.pubkey()).await;

            let evm_key_path = key_file_with(DEPLOYER_PRIVATE_KEY);
            let solana_key_path = raw_key_file(seed);
            let config = load_config(&format!(
                r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{evm_key_path}"

[settlement.evm]
rpc_url = "{evm_rpc_url}"
contract_address = "{registry_address:?}"
token_address = "{token:?}"
decimals = 6

[settlement.evm.key]
key_file = "{evm_key_path}"

[settlement.solana]
rpc_url = "{solana_rpc_url}"
program_id = "{program_id}"
token_address = "{token_mint}"
decimals = 6

[settlement.solana.key]
key_file = "{solana_key_path}"
"#,
                evm_key_path = evm_key_path.display(),
                solana_key_path = solana_key_path.display(),
                evm_rpc_url = anvil.rpc_url,
                solana_rpc_url = validator.rpc_url,
                registry_address = registry_address,
                token = token,
            ));

            let runtime = build(&config)
                .await
                .expect("both legs construct and attach without either refusing startup");

            let evm_terms = runtime
                .settlement_terms
                .clone()
                .expect("the EVM leg composes the legacy greeting terms");
            assert_eq!(
                evm_terms.token_address,
                format!("{token:#x}"),
                "the legacy settlement object names the EVM leg alone, unaffected by the Solana leg"
            );

            assert_eq!(
                runtime.settlements.len(),
                2,
                "both configured chains carry an entry: {:?}",
                runtime.settlements
            );
            assert!(
                runtime.settlements.contains(
                    &connector_client_edge::X402ChainSettlementTerms::Evm(evm_terms)
                ),
                "the settlements list carries the same EVM entry as the legacy object"
            );
            let solana_entry = runtime
                .settlements
                .iter()
                .find_map(|entry| match entry {
                    connector_client_edge::X402ChainSettlementTerms::Solana(terms) => {
                        Some(terms.clone())
                    }
                    _ => None,
                })
                .expect("the settlements list carries a Solana entry");
            assert_eq!(solana_entry.chain, "solana");
            assert_eq!(solana_entry.program_id, program_id.to_string());
            assert_eq!(solana_entry.token_address, token_mint.to_string());
            assert_eq!(solana_entry.decimals, 6);
        }

        /// Issue #630's review, finding 2: a `[settlement.solana]`
        /// `program_id` that names a real, executable program which is
        /// *not* the deployed payment-channel program (here: SPL Token
        /// itself, executable on every cluster) must refuse startup naming
        /// the program id -- not pass a mere "exists and is executable"
        /// check and fail lazily at the first settle.
        #[tokio::test]
        async fn a_solana_program_id_naming_some_other_program_refuses_to_build() {
            if !require_solana_test_validator() {
                return;
            }

            let validator = SolanaValidator::spawn().await;
            let program_id =
                Pubkey::from_str(LOCAL_TEST_PROGRAM_ID).expect("valid local test program id");
            let deployed = SolanaSettlementBackend::deploy(&validator.rpc_url, program_id)
                .await
                .expect("bind to the genesis-loaded payment-channel program");
            let token_mint = deployed.token_mint();
            drop(deployed);

            let seed = [14u8; 32];
            let payer =
                solana_sdk::signer::keypair::keypair_from_seed(&seed).expect("derive keypair");
            let rpc = RpcClient::new_with_commitment(
                validator.rpc_url.clone(),
                CommitmentConfig::confirmed(),
            );
            fund(&rpc, &payer.pubkey()).await;

            let key_path = raw_key_file(seed);
            let wrong_program_id = spl_token_program_id();
            let config = load_config(&format!(
                r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{key_path}"

[settlement.solana]
rpc_url = "{rpc_url}"
program_id = "{wrong_program_id}"
token_address = "{token_mint}"
decimals = 6

[settlement.solana.key]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
                rpc_url = validator.rpc_url,
            ));

            let error = build(&config)
                .await
                .err()
                .expect("a program_id naming some other executable program refuses to build");
            let message = error.to_string();
            assert!(
                message.contains(&wrong_program_id.to_string()),
                "the failure must name the configured program id: {message}"
            );
        }

        /// Issue #631's security review, finding 1 (mint binding), full
        /// stack: the deployed program lets any payer open a channel with
        /// ANY mint, and the balance-proof signature does not cover the
        /// mint, so without `channel_counterparty`'s mint check a claim on
        /// a channel funded with a worthless SPL token would buy
        /// USDC-priced writes. Here the wrong-mint channel is genuinely
        /// opened and funded on a real validator, the claim's signature is
        /// genuinely valid -- and the claim gate, resolving through the
        /// same [`SolanaChannelSource`] `build` wires up, still refuses it
        /// as an unknown channel. The control at the end accepts the
        /// byte-identical claim through a backend configured with the
        /// channel's own mint, proving the refusal was the mint binding
        /// and nothing else.
        #[tokio::test]
        async fn a_validly_signed_claim_on_a_wrong_mint_channel_is_refused_as_unknown() {
            use base64::engine::general_purpose::STANDARD as BASE64;
            use base64::Engine;

            if !require_solana_test_validator() {
                return;
            }

            let validator = SolanaValidator::spawn().await;
            let program_id =
                Pubkey::from_str(LOCAL_TEST_PROGRAM_ID).expect("valid local test program id");

            // A real, open, funded channel on the junk mint, with this
            // node's own identity as a participant.
            let opener = SolanaSettlementBackend::deploy(&validator.rpc_url, program_id)
                .await
                .expect("bind to the genesis-loaded payment-channel program");
            let junk_mint = opener.token_mint();
            let counterparty = opener
                .test_counterparty_pubkey()
                .expect("deploy() holds a counterparty key");
            let channel = opener
                .open(counterparty.clone(), Duration::seconds(3600))
                .await
                .expect("open a channel on the junk mint");
            opener
                .fund(&channel, 1_000)
                .await
                .expect("fund the junk-mint channel with a real on-chain deposit");

            // A genuinely valid claim on it, signed by the channel's real
            // counterparty key.
            let signature = opener
                .test_sign_claim(&channel, 1, 100)
                .expect("deploy() holds the counterparty key to sign with");
            let counterparty_base58 = Pubkey::try_from(counterparty.as_slice())
                .expect("32-byte pubkey")
                .to_string();
            let claim_json = format!(
                r#"{{
                    "version": "1.0",
                    "blockchain": "solana",
                    "messageId": "msg-1",
                    "timestamp": "2026-02-02T12:00:00.000Z",
                    "senderId": "peer-mallory",
                    "programId": "{program_id}",
                    "channelAccount": "{channel_account}",
                    "nonce": 1,
                    "transferredAmount": "100",
                    "signature": "{signature}",
                    "signerPublicKey": "{counterparty_base58}"
                }}"#,
                channel_account = channel.0,
                signature = BASE64.encode(&signature),
            );

            // The node under test: the SAME on-chain identity, configured
            // to settle in a DIFFERENT (real) mint.
            let other = SolanaSettlementBackend::deploy(&validator.rpc_url, program_id)
                .await
                .expect("deploy a second backend for its fresh mint");
            let configured_mint = other.token_mint();
            assert_ne!(junk_mint, configured_mint);
            drop(other);
            let node_backend = SolanaSettlementBackend::connect(
                &validator.rpc_url,
                &opener.test_payer_seed(),
                program_id,
                configured_mint,
                6,
            )
            .await
            .expect("connect under the opener's identity, bound to the configured mint");

            let key_path = key_file_with(DEPLOYER_PRIVATE_KEY);
            let config = load_config(&format!(
                r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            ));

            let gate = client_claim_gate(
                &config,
                test_signer(),
                None,
                Some(Arc::new(SolanaChannelSource {
                    backend: Arc::new(node_backend),
                })),
            )
            .expect("a config with no state_dir produces an in-memory gate");
            let rejection = gate
                .ingest(&claim_json, 100)
                .await
                .expect_err("a claim on a wrong-mint channel must be refused");
            assert!(
                matches!(
                    rejection,
                    connector_client_edge::ClaimIngestRejection::UnknownChannel
                ),
                "refused as an unknown channel, not any other reason: {}",
                rejection.message()
            );

            // Control: the byte-identical claim is accepted through a
            // backend configured with the channel's own mint.
            let matching_backend = SolanaSettlementBackend::connect(
                &validator.rpc_url,
                &opener.test_payer_seed(),
                program_id,
                junk_mint,
                6,
            )
            .await
            .expect("connect under the opener's identity, bound to the channel's own mint");
            let gate = client_claim_gate(
                &config,
                test_signer(),
                None,
                Some(Arc::new(SolanaChannelSource {
                    backend: Arc::new(matching_backend),
                })),
            )
            .expect("a config with no state_dir produces an in-memory gate");
            gate.ingest(&claim_json, 100)
                .await
                .expect("the identical claim is valid and accepted when the mint matches");
        }

        /// Issue #646's EVM half, through the same [`SettlementChannelSource`]
        /// `build` wires up: the deposit is not in `channels(id)` at all
        /// (`TokenNetwork.sol:73-77` keeps it in
        /// `participants[channelId][counterparty]`), so this is the one
        /// extra `eth_call` the cap costs -- paid once, when the channel is
        /// first seen, and memoised after.
        ///
        /// A claim one base unit above a genuinely deposited 1_000 is
        /// refused, and the byte-identical claim is honoured after a real
        /// `setTotalDeposit` covers it.
        #[tokio::test]
        async fn a_claim_above_an_evm_channels_on_chain_deposit_is_refused_until_it_is_funded() {
            use connector_settlement_evm::test_support::DEPLOYER_PRIVATE_KEY as EVM_DEPLOYER;
            use connector_signer::{
                derive_evm_address, evm_balance_proof_digest, to_hex, EvmBalanceProof,
            };
            use libsecp256k1::{Message, PublicKey, SecretKey};

            if !anvil_available() {
                eprintln!(
                    "skipping: `anvil` not found on PATH (install via https://getfoundry.sh)"
                );
                return;
            }

            let anvil = Anvil::spawn(ANVIL_BASE_PORT).await;
            let token =
                EvmSettlementBackend::deploy_mock_token(&anvil.rpc_url, EVM_DEPLOYER, 1_000_000)
                    .await
                    .expect("deploy mock USDC");
            let backend = Arc::new(
                EvmSettlementBackend::deploy(&anvil.rpc_url, EVM_DEPLOYER, token)
                    .await
                    .expect("deploy a TokenNetwork through a fresh registry"),
            );

            // A real counterparty whose key this test holds, so the claim
            // below is one `TokenNetwork.claimFromChannel` would recover.
            let secret = SecretKey::parse(&[11u8; 32]).expect("valid secret key");
            let counterparty = derive_evm_address(&PublicKey::from_secret_key(&secret).serialize());
            let channel = backend
                .open(counterparty.to_vec(), Duration::seconds(3600))
                .await
                .expect("open a real channel");
            let state = backend
                .fund(&channel, 1_000)
                .await
                .expect("fund the channel with real ERC-20 value");
            assert_eq!(state.deposited, 1_000);

            let claim_json = |nonce: u64, transferred_amount: u64| {
                let channel_id = channel_id_bytes(&channel.0);
                let proof = EvmBalanceProof {
                    channel_id,
                    nonce,
                    transferred_amount: u128::from(transferred_amount),
                    locked_amount: 0,
                    locks_root: [0u8; 32],
                    chain_id: backend.chain_id(),
                    token_network_address: backend.address().to_fixed_bytes(),
                };
                let message = Message::parse(&evm_balance_proof_digest(&proof));
                let (signature, recovery_id) = libsecp256k1::sign(&message, &secret);
                let mut bytes = signature.serialize().to_vec();
                let recovery_byte: u8 = recovery_id.into();
                bytes.push(recovery_byte + 27);
                format!(
                    r#"{{
                        "version": "1.0",
                        "blockchain": "evm",
                        "messageId": "msg-{nonce}",
                        "timestamp": "2026-02-02T12:00:00.000Z",
                        "senderId": "peer-mallory",
                        "channelId": "{channel_id_hex}",
                        "nonce": {nonce},
                        "transferredAmount": "{transferred_amount}",
                        "lockedAmount": "0",
                        "locksRoot": "0x{zeros}",
                        "signature": "0x{signature}",
                        "signerAddress": "{signer}"
                    }}"#,
                    channel_id_hex = channel.0,
                    zeros = "0".repeat(64),
                    signature = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>(),
                    signer = to_hex(&counterparty),
                )
            };

            let key_path = key_file_with(DEPLOYER_PRIVATE_KEY);
            let config = load_config(&format!(
                r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            ));
            let gate = client_claim_gate(
                &config,
                test_signer(),
                Some(Arc::new(SettlementChannelSource {
                    backend: backend.clone(),
                })),
                None,
            )
            .expect("a config with no state_dir produces an in-memory gate");

            let rejection = gate
                .ingest(&claim_json(1, 1_001), 100)
                .await
                .expect_err("a claim above the on-chain deposit must be refused");
            assert_eq!(
                rejection,
                connector_client_edge::ClaimIngestRejection::Undercollateralized {
                    claimed: 1_001,
                    deposited: 1_000,
                },
                "{}",
                rejection.message()
            );

            let topped_up = backend
                .fund(&channel, 1)
                .await
                .expect("a real second setTotalDeposit");
            assert_eq!(topped_up.deposited, 1_001);

            // The identical claim, at the identical nonce, once the chain
            // says it can be redeemed.
            accepted_within_the_reattempt_interval(&gate, &claim_json(1, 1_001), 100).await;
        }

        /// Present `claim_json` until it is accepted, or give up.
        ///
        /// A refused undercollateralized claim is expected to become good
        /// once the deposit lands, but not necessarily on the very next
        /// submission: the re-read that notices the deposit is rate-limited
        /// per channel (`ChannelLivenessPolicy::min_reattempt_interval`),
        /// because a refusal that consumes no nonce could otherwise be
        /// re-presented as an unlimited free chain read. Retrying here is
        /// the point rather than a workaround -- it is what proves the
        /// interval is a delay of seconds and not a wall, under the very
        /// policy a production node runs.
        async fn accepted_within_the_reattempt_interval(
            gate: &ClientClaimGate,
            claim_json: &str,
            price: u64,
        ) {
            for _ in 0..40 {
                match gate.ingest(claim_json, price).await {
                    Ok(_) => return,
                    Err(connector_client_edge::ClaimIngestRejection::Undercollateralized {
                        ..
                    }) => {
                        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    }
                    Err(other) => panic!("unexpected refusal: {}", other.message()),
                }
            }
            panic!(
                "the deposit landed on chain, so the identical claim must become good once the \
                 per-channel re-attempt interval has passed -- it never did"
            );
        }

        /// A Solana claim JSON on `channel`, signed by the channel's real
        /// on-chain counterparty through `opener`'s held key -- the same
        /// shape the wrong-mint test above builds by hand, factored out
        /// because the collateral tests below need several.
        fn solana_claim_json(
            opener: &SolanaSettlementBackend,
            channel: &connector_settlement::ChannelId,
            program_id: Pubkey,
            counterparty: &[u8],
            nonce: u64,
            transferred_amount: u64,
        ) -> String {
            use base64::engine::general_purpose::STANDARD as BASE64;
            use base64::Engine;

            let signature = opener
                .test_sign_claim(channel, nonce, u128::from(transferred_amount))
                .expect("deploy() holds the counterparty key to sign with");
            let counterparty_base58 = Pubkey::try_from(counterparty)
                .expect("32-byte pubkey")
                .to_string();
            format!(
                r#"{{
                    "version": "1.0",
                    "blockchain": "solana",
                    "messageId": "msg-{nonce}",
                    "timestamp": "2026-02-02T12:00:00.000Z",
                    "senderId": "peer-mallory",
                    "programId": "{program_id}",
                    "channelAccount": "{channel_account}",
                    "nonce": {nonce},
                    "transferredAmount": "{transferred_amount}",
                    "signature": "{signature}",
                    "signerPublicKey": "{counterparty_base58}"
                }}"#,
                channel_account = channel.0,
                signature = BASE64.encode(&signature),
            )
        }

        /// Issue #646 on the chain it was actually observed on, end to end
        /// through the same [`SolanaChannelSource`] `build` wires up: the
        /// literal #633 scenario is a real channel PDA opened with a **zero**
        /// USDC deposit, whose validly-signed claims the connector accepted
        /// (nonce 6, 6000 base units) against a vault holding nothing. Every
        /// one of those claims would have reverted
        /// `TransferredAmountExceedsDeposit` at redemption
        /// (`packages/solana-program/src/processor.rs:781-788`).
        ///
        /// The second half proves the refusal is a bound and not a wall: a
        /// real on-chain `Deposit` makes the byte-identical claim, at the
        /// identical nonce, good -- which is exactly what that program's own
        /// comment promises ("a participant who intends to spend more can
        /// deposit first and resubmit the claim").
        #[tokio::test]
        async fn a_claim_above_a_solana_channels_zero_deposit_is_refused_until_it_is_funded() {
            if !require_solana_test_validator() {
                return;
            }

            let validator = SolanaValidator::spawn().await;
            let program_id =
                Pubkey::from_str(LOCAL_TEST_PROGRAM_ID).expect("valid local test program id");

            let opener = SolanaSettlementBackend::deploy(&validator.rpc_url, program_id)
                .await
                .expect("bind to the genesis-loaded payment-channel program");
            let token_mint = opener.token_mint();
            let counterparty = opener
                .test_counterparty_pubkey()
                .expect("deploy() holds a counterparty key");
            // Opened and never funded -- the #633 channel exactly.
            let channel = opener
                .open(counterparty.clone(), Duration::seconds(3600))
                .await
                .expect("open a channel with no deposit at all");

            let node_backend = SolanaSettlementBackend::connect(
                &validator.rpc_url,
                &opener.test_payer_seed(),
                program_id,
                token_mint,
                6,
            )
            .await
            .expect("connect under the opener's identity, bound to the channel's own mint");

            let key_path = key_file_with(DEPLOYER_PRIVATE_KEY);
            let config = load_config(&format!(
                r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            ));
            let gate = client_claim_gate(
                &config,
                test_signer(),
                None,
                Some(Arc::new(SolanaChannelSource {
                    backend: Arc::new(node_backend),
                })),
            )
            .expect("a config with no state_dir produces an in-memory gate");

            let claim_json =
                solana_claim_json(&opener, &channel, program_id, &counterparty, 6, 6_000);
            let rejection = gate
                .ingest(&claim_json, 100)
                .await
                .expect_err("an uncollateralized claim must be refused");
            assert_eq!(
                rejection,
                connector_client_edge::ClaimIngestRejection::Undercollateralized {
                    claimed: 6_000,
                    deposited: 0,
                },
                "refused for what it is, not as a bad signature or an underpayment: {}",
                rejection.message()
            );

            // A real deposit, from the counterparty's own key, into the
            // channel's own vault.
            let funded = opener
                .fund(&channel, 6_000)
                .await
                .expect("deposit real SPL value into the channel vault");
            assert_eq!(funded.deposited, 6_000);

            // The byte-identical claim redeems now, so the gate accepts it
            // now: the memoised floor was a lower bound and the breach
            // re-read it.
            accepted_within_the_reattempt_interval(&gate, &claim_json, 100).await;
        }

        /// Issue #649 against a real validator: a channel resolved while it
        /// was payable, then genuinely closed and settled on chain, must
        /// stop buying writes. The deployed program zeroes the channel PDA
        /// on settlement (`processor.rs:635-647`), so the chain's answer
        /// afterwards is "no such channel" -- but a resolution cache that is
        /// never invalidated goes on answering from the reading it took
        /// while the channel was open, for the life of the process.
        ///
        /// The registry re-verifies liveness on expiry through the same
        /// refresh path the deposit floor uses; `Duration::ZERO` here makes
        /// that observable without the test sleeping.
        #[tokio::test]
        async fn a_solana_channel_settled_after_resolution_stops_being_accepted() {
            if !require_solana_test_validator() {
                return;
            }

            let validator = SolanaValidator::spawn().await;
            let program_id =
                Pubkey::from_str(LOCAL_TEST_PROGRAM_ID).expect("valid local test program id");

            let opener = SolanaSettlementBackend::deploy(&validator.rpc_url, program_id)
                .await
                .expect("bind to the genesis-loaded payment-channel program");
            let token_mint = opener.token_mint();
            let counterparty = opener
                .test_counterparty_pubkey()
                .expect("deploy() holds a counterparty key");
            // A zero-length challenge period, so this test can settle the
            // channel for real without waiting one out.
            let channel = opener
                .open(counterparty.clone(), Duration::zero())
                .await
                .expect("open an instantly-settleable channel");
            opener
                .fund(&channel, 1_000)
                .await
                .expect("a real on-chain deposit, so the claim below is genuinely collateralized");

            let node_backend = SolanaSettlementBackend::connect(
                &validator.rpc_url,
                &opener.test_payer_seed(),
                program_id,
                token_mint,
                6,
            )
            .await
            .expect("connect under the opener's identity, bound to the channel's own mint");

            let gate = ClientClaimGate::restore(
                ClientChannelRegistry::new()
                    .with_solana_source(Arc::new(SolanaChannelSource {
                        backend: Arc::new(node_backend),
                    }))
                    // Re-verify on every lookup, so the settlement below is
                    // noticed without this test waiting out a refresh
                    // interval. What is under test is that the settled
                    // channel stops resolving at all, not how long that
                    // takes.
                    .with_liveness_policy(
                        connector_client_edge::ChannelLivenessPolicy::reverify_every_lookup(),
                    ),
                Arc::new(InMemoryJournal::new()),
            )
            .expect("a fresh in-memory journal has nothing to replay");

            gate.ingest(
                &solana_claim_json(&opener, &channel, program_id, &counterparty, 1, 100),
                100,
            )
            .await
            .expect("payable while the channel is open and funded");

            // Genuinely settled on chain: closed, then settled, which the
            // program completes by zeroing the channel account.
            opener.close(&channel).await.expect("close the channel");
            let settled = opener.settle(&channel).await.expect("settle the channel");
            assert_eq!(settled.status, connector_settlement::ChannelStatus::Settled);

            let rejection = gate
                .ingest(
                    &solana_claim_json(&opener, &channel, program_id, &counterparty, 2, 200),
                    100,
                )
                .await
                .expect_err("a claim on a settled channel can never be redeemed");
            assert_eq!(
                rejection,
                connector_client_edge::ClaimIngestRejection::UnknownChannel,
                "the settled-channel refusal must not be bypassed by a stale cache: {}",
                rejection.message()
            );
        }

        /// The SPL Token program id -- a program that exists, is
        /// executable, and is definitely not the payment-channel program,
        /// on every Solana cluster including a fresh test validator.
        fn spl_token_program_id() -> Pubkey {
            Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
                .expect("the canonical SPL Token program id")
        }
    }
}
