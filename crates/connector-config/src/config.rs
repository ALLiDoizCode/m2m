use std::net::SocketAddr;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use url::Url;

use crate::client_channel::{resolve_client_channels, ClientChannelConfig, RawClientChannel};
use crate::error::ConfigError;
use crate::operator::{resolve_operator, OperatorConfig, RawOperatorConfig};
use crate::peer::{parse_peer_exposure, resolve_peers, PeerConfig, PeerExposure, RawPeer};
use crate::peer_channel::{resolve_peer_channels, PeerChannelConfig, RawPeerChannel};
use crate::route::{resolve_routes, PeerRouteConfig, RawChild, RawRoute, StaticRoute};
use crate::secret::{RawSignerConfig, SecretLocation};
use crate::settlement::{resolve_settlement, RawSettlementSection, SettlementConfig};

/// The config file's shape exactly as written -- convenience forms
/// (`children`) intact, nothing yet validated. `deny_unknown_fields`
/// (issue #542): an unrecognized top-level key -- a typo, or a section
/// this connector doesn't understand -- fails config load loudly instead
/// of being parsed, silently dropped, and the node starting as if it had
/// never been written.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
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
    /// Removed with the raw-TCP peer wire (ADR 0027, issue #679). Still
    /// parsed, and only so that a stale config naming it fails at boot
    /// with [`ConfigError::PeerWireAddrRemoved`] rather than tripping the
    /// generic `deny_unknown_fields` message: the devnet boxes run
    /// bind-mounted configs that lead the repo copies, so the one that
    /// matters is the one an operator reads at 3am.
    #[serde(default)]
    peer_wire_addr: Option<toml::Value>,
    /// Which peer carriages this connector opens a listener for (issue
    /// #677, `peer-carriage-spec.md` §2.1): `"btp"`, `"http"`, `"both"` or
    /// `"neither"`. Absent means `"neither"` -- this connector dials out
    /// and accepts no peering, which is the NAT'd operator's case and the
    /// safe default, since opening a peer listener should be a line
    /// somebody wrote.
    ///
    /// Spelled as a top-level field rather than `[peers].expose` because
    /// TOML cannot hold both a `[peers]` table and a `[[peers]]` array of
    /// tables under one name; §11 leaves the spelling to this issue.
    #[serde(default)]
    peer_expose: Option<String>,
    /// Whether a `[[peers]].endpoint` may name a **plaintext** scheme --
    /// `ws://` or `http://` -- instead of the `wss://`/`https://` a peering
    /// carrying signed balance proofs otherwise requires (issue #678,
    /// gap 3).
    ///
    /// Absent and `false` are the same thing and are the production
    /// answer: a plaintext endpoint stays [`ConfigError::PeerEndpointScheme`],
    /// exactly as before this field existed. `true` is a **loopback and
    /// test** opt-in, for a harness that stands up two connectors on
    /// `127.0.0.1` with no TLS terminator between them; a node that sets it
    /// logs a `WARN` naming every plaintext peering at startup.
    ///
    /// Deliberately one top-level switch rather than a per-peer knob: a
    /// per-peer field reads as an ordinary property of that peering and
    /// would be copied into a production file one peer at a time, where
    /// this one is a single line an operator has to write about the whole
    /// node.
    #[serde(default)]
    peer_allow_plaintext_endpoints: Option<bool>,
    /// The peering relations this node has (issue #488; endpoint,
    /// credential and per-relation terms, issue #677). What used to be a
    /// dialed `SocketAddr` is now an `endpoint` URL whose **scheme**
    /// selects the carriage -- `wss://` BTP, `https://` ILP-over-HTTP (ADR
    /// 0027) -- or no endpoint at all, for a peering that dials in.
    #[serde(default)]
    peers: Vec<RawPeer>,
    /// The payment channels each peering relation's claims are judged
    /// against, and the EIP-712 domain they are signed under (issue #677,
    /// ADR 0024). This is the table whose absence made ADR 0024's
    /// peer-claim mechanism inert (#620 gap 3): a peering with no row here
    /// can never take the peer role at all.
    #[serde(default)]
    peer_channels: Vec<RawPeerChannel>,
    /// One or more real settlement backends to construct at startup (issue
    /// #542; per-chain tables, issue #628). Absent means channel operations
    /// keep degrading to `ChannelOperationError::NoSettlementBackend`, same
    /// as before this section existed.
    #[serde(default)]
    settlement: Option<RawSettlementSection>,
    /// The payment channels this node accepts client-edge claims on, and
    /// the counterparty whose signature it accepts on each (issue #558).
    /// Absent -- or empty -- means this node has a record of no channel,
    /// so every claim presented at its client edge is refused as unknown.
    #[serde(default)]
    client_channels: Vec<RawClientChannel>,
    /// The directory this node keeps its durable money state in (issue
    /// #605): the journals whose replay is what makes a claim watermark
    /// survive a restart. Absent means this node writes none -- allowed
    /// only for a node that cannot accept a claim in the first place,
    /// since a watermark held only in memory is not a replay defence.
    #[serde(default)]
    state_dir: Option<String>,
    /// How long this node may believe a chain-resolved channel's *mutable*
    /// facts -- that it has not settled, and that its token still matches
    /// -- before re-reading them (issue #649). Absent means the client
    /// edge's own default.
    ///
    /// An operator knob rather than a constant because the trade it makes
    /// is a deployment's to make: a node on a rate-limited public RPC
    /// endpoint wants it longer, and one that wants a settled channel
    /// noticed sooner wants it shorter. `0` re-verifies on every packet,
    /// which is correct and expensive, so it is refused at load rather
    /// than silently accepted as a way to melt an endpoint.
    #[serde(default)]
    channel_liveness_ttl_secs: Option<u64>,
    /// How long past `channel_liveness_ttl_secs` a channel's last good
    /// reading may still be *served* while the chain cannot be reached
    /// (issue #649). Absent means the client edge's own default; `0` means
    /// never -- a coherent fail-closed choice, unlike a zero TTL, since
    /// nothing about it costs an extra chain read.
    #[serde(default)]
    channel_serve_stale_secs: Option<u64>,
    /// The floor on how often one channel may provoke a chain lookup, in
    /// milliseconds. Absent means the client edge's own default. This is
    /// the knob an operator on a rate-limited endpoint reaches for, and
    /// `0` is refused for the same reason a zero TTL is: it is how one
    /// packet becomes one RPC.
    #[serde(default)]
    channel_reattempt_interval_ms: Option<u64>,
    /// The rate one self-declared signer's lookups for channels that do not
    /// resolve are shaped to, per window, once the node-wide drain below is
    /// in arrears (issue #613). Absent means the client edge's own default;
    /// `0` is refused, since a rate of nothing per window would refuse
    /// every unaffiliated buyer the moment the node got busy -- i.e. switch
    /// off the registration-free path #611 exists to provide, silently and
    /// only under load.
    #[serde(default)]
    unresolvable_lookup_budget_per_signer: Option<u32>,
    /// The rate this node's lookups for channels that do not resolve are
    /// shaped to per window in total, whoever asks (issue #613). This is
    /// the one a sender cannot raise by declaring a different signer, so it
    /// is the figure an operator on a metered settlement endpoint actually
    /// sets, and it should be derived from what that endpoint can absorb.
    /// Absent means the client edge's own default; `0` is refused for the
    /// same reason as above.
    #[serde(default)]
    unresolvable_lookup_budget_total: Option<u32>,
    /// The window both rates above are expressed over, and the burst either
    /// tolerates. Absent means the client edge's own default; `0` is
    /// refused, and it is the sharpest footgun of the four: a zero-length
    /// window makes both rates infinite and the bound nothing at all, while
    /// looking configured.
    #[serde(default)]
    unresolvable_lookup_budget_window_secs: Option<u64>,
    /// How long a lookup may wait for its slot before being refused
    /// instead (issue #613). Absent means the client edge's own default;
    /// `0` is refused, because a zero wait ceiling turns the shaper back
    /// into a dropper -- and a dropping bound hands any sender able to
    /// sustain `unresolvable_lookup_budget_total` requests per window a
    /// switch that turns the registration-free path off for every new
    /// buyer, which is a worse failure than the RPC spend it prevents.
    #[serde(default)]
    unresolvable_lookup_budget_max_wait_ms: Option<u64>,
    /// How many of one BTP session's frames may be past claim admission --
    /// waiting out the journal's group commit, being routed downstream,
    /// answering -- at once (issue #688). Claims are judged strictly in
    /// arrival order regardless; this bounds only the overlapped tail.
    /// Absent means the client edge's own default; `0` is refused, since a
    /// window of nothing is not a slower session, it is a session whose
    /// first paid frame waits forever while the file reads as configured.
    /// `1` is the original lockstep session.
    #[serde(default)]
    btp_session_window: Option<u32>,
}

/// The client edge's own defaults for the unresolvable-lookup shaper
/// (issue #613), restated here so that [`Config::load`] can validate the
/// values an operator wrote against the ones that will actually be in
/// force.
///
/// Duplicating them is deliberate and is covered by a test: without them,
/// a cross-field rule can only fire when *both* fields are present, so
/// `unresolvable_lookup_budget_total = 5` on its own -- with the per-signer
/// rate defaulting to something larger -- loads with exactly the incoherent
/// configuration the rule exists to refuse. `connector-cli`'s
/// `the_config_layers_budget_defaults_match_the_client_edges` pins them to
/// `UnresolvableLookupBudgetPolicy::default()`, which is the authority at
/// runtime, so the two cannot drift unnoticed.
const DEFAULT_UNRESOLVABLE_LOOKUPS_PER_SIGNER: u32 = 20;
const DEFAULT_UNRESOLVABLE_LOOKUPS_TOTAL: u32 = 600;
const DEFAULT_UNRESOLVABLE_LOOKUP_WINDOW_SECS: u64 = 60;
const DEFAULT_UNRESOLVABLE_LOOKUP_MAX_WAIT_MS: u64 = 2_000;

/// The longest window the client edge will honour -- a day. Restated here
/// for the same reason the rates are, and pinned to
/// `MAX_UNRESOLVABLE_LOOKUP_WINDOW` by the same `connector-cli` test.
const MAX_UNRESOLVABLE_LOOKUP_WINDOW_SECS: u64 = 86_400;

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
    peer_routes: Vec<PeerRouteConfig>,
    peers: Vec<PeerConfig>,
    peer_expose: PeerExposure,
    peer_allow_plaintext_endpoints: bool,
    peer_channels: Vec<PeerChannelConfig>,
    operator: Option<OperatorConfig>,
    settlements: Vec<SettlementConfig>,
    client_channels: Vec<ClientChannelConfig>,
    state_dir: Option<PathBuf>,
    channel_liveness_ttl: Option<Duration>,
    channel_serve_stale: Option<Duration>,
    channel_reattempt_interval: Option<Duration>,
    unresolvable_lookups_per_signer: Option<u32>,
    unresolvable_lookups_total: Option<u32>,
    unresolvable_lookup_window: Option<Duration>,
    unresolvable_lookup_max_wait: Option<Duration>,
    btp_session_window: Option<NonZeroU32>,
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
        let (routes, peer_routes) = resolve_routes(raw.apex.as_deref(), raw.routes, raw.children)?;
        let peer_expose = parse_peer_exposure(raw.peer_expose)?;
        let peer_allow_plaintext_endpoints = raw.peer_allow_plaintext_endpoints.unwrap_or(false);
        let peers = resolve_peers(raw.peers, peer_expose, peer_allow_plaintext_endpoints)?;
        let peer_channels = resolve_peer_channels(raw.peer_channels)?;
        for peer_route in &peer_routes {
            let Some(peer) = peers.iter().find(|peer| peer.id() == peer_route.peer_id()) else {
                return Err(ConfigError::UnknownPeerId {
                    prefix: peer_route.prefix().to_string(),
                    peer_id: peer_route.peer_id().to_string(),
                });
            };
            // The intersection rule, in the one direction this connector's
            // own file can decide (`peer-carriage-spec.md` §2.2, §6.4(1)):
            // a route whose next hop is a peering this connector can never
            // originate to is a route that could only ever answer `T01`.
            // What the *far* side exposes is not knowable from here and
            // stays a runtime dial failure.
            if !peer.can_originate() {
                return Err(ConfigError::PeerRouteUndeliverable {
                    prefix: peer_route.prefix().to_string(),
                    peer_id: peer_route.peer_id().to_string(),
                });
            }
        }
        // Orphaned rows first, then unbound peers: a mistyped `peer_id`
        // produces both at once, and "this row names a peer that does not
        // exist" is the one that names the typo.
        for channel in &peer_channels {
            if !peers.iter().any(|peer| peer.id() == channel.peer_id()) {
                return Err(ConfigError::PeerChannelOrphaned {
                    peer_id: channel.peer_id().to_string(),
                });
            }
        }
        // P2 (§1.2): a peering with no channel binding can never take the
        // peer role, so its counterparty would be admitted as an ordinary
        // client and its claims judged in the wrong namespace. Refused at
        // load, because the runtime symptom is silence.
        for peer in &peers {
            if !peer_channels
                .iter()
                .any(|channel| channel.peer_id() == peer.id())
            {
                return Err(ConfigError::PeerChannelUnbound {
                    id: peer.id().to_string(),
                });
            }
        }
        if raw.peer_wire_addr.is_some() {
            return Err(ConfigError::PeerWireAddrRemoved);
        }
        let operator = resolve_operator(raw.operator)?;
        let settlements = resolve_settlement(raw.settlement)?;
        let client_channels = resolve_client_channels(raw.client_channels)?;
        // Namespace disjointness (`peer-carriage-spec.md` §1.8). Peer and
        // client watermarks are separate records by design, which is only
        // safe while no channel is in both: two namespaces over one
        // channel would let the same claim be counted as credit twice.
        // Both sides are canonicalized lowercase `0x` hex by their own
        // resolvers, so this compares like with like.
        for peer_channel in &peer_channels {
            let collides = client_channels.iter().any(|client_channel| {
                matches!(
                    client_channel,
                    ClientChannelConfig::Evm(evm) if evm.channel_id() == peer_channel.channel_id()
                )
            });
            if collides {
                return Err(ConfigError::ChannelInBothNamespaces {
                    value: peer_channel.channel_id().to_string(),
                });
            }
        }
        let state_dir = raw.state_dir.map(PathBuf::from);
        let channel_liveness_ttl = match raw.channel_liveness_ttl_secs {
            Some(0) => return Err(ConfigError::ZeroChannelLivenessTtl),
            other => other.map(Duration::from_secs),
        };
        // Zero is allowed here and refused above, and the asymmetry is the
        // point: a zero TTL means "re-read on every packet", which is how
        // an endpoint's budget is exhausted, while a zero stale window
        // means "never serve a reading I could not confirm", which costs
        // nothing extra and is a defensible thing to want.
        let channel_serve_stale = raw.channel_serve_stale_secs.map(Duration::from_secs);
        let channel_reattempt_interval = match raw.channel_reattempt_interval_ms {
            Some(0) => return Err(ConfigError::ZeroChannelReattemptInterval),
            other => other.map(Duration::from_millis),
        };
        // A stale window shorter than the TTL is not a stricter setting,
        // it is an incoherent one: an entry would pass out of "believed"
        // and out of "servable" at the same moment, so the window it names
        // could never be used. Refused rather than silently behaving as
        // zero, since an operator who wrote it meant something.
        if let (Some(ttl), Some(stale)) = (channel_liveness_ttl, channel_serve_stale) {
            if stale > Duration::ZERO && stale < ttl {
                return Err(ConfigError::ServeStaleShorterThanLivenessTtl {
                    serve_stale_secs: stale.as_secs(),
                    ttl_secs: ttl.as_secs(),
                });
            }
        }

        // The unresolvable-lookup budget (issue #613). Every one of these
        // is refused at zero, unlike `channel_serve_stale_secs` above:
        // there, zero names a coherent fail-closed choice that costs
        // nothing extra; here, each zero either switches the
        // registration-free path off entirely or switches the budget off
        // while leaving it configured, and neither is a thing an operator
        // could mean by writing a number down.
        let unresolvable_lookups_per_signer = match raw.unresolvable_lookup_budget_per_signer {
            Some(0) => {
                return Err(ConfigError::ZeroUnresolvableLookupBudget {
                    field: "per_signer",
                })
            }
            other => other,
        };
        let unresolvable_lookups_total = match raw.unresolvable_lookup_budget_total {
            Some(0) => return Err(ConfigError::ZeroUnresolvableLookupBudget { field: "total" }),
            other => other,
        };
        let unresolvable_lookup_window_secs = match raw.unresolvable_lookup_budget_window_secs {
            Some(0) => return Err(ConfigError::ZeroUnresolvableLookupWindow),
            Some(secs) if secs > MAX_UNRESOLVABLE_LOOKUP_WINDOW_SECS => {
                return Err(ConfigError::UnresolvableLookupWindowTooLong {
                    window_secs: secs,
                    max_secs: MAX_UNRESOLVABLE_LOOKUP_WINDOW_SECS,
                })
            }
            other => other,
        };
        let unresolvable_lookup_window = unresolvable_lookup_window_secs.map(Duration::from_secs);
        let unresolvable_lookup_max_wait_ms = match raw.unresolvable_lookup_budget_max_wait_ms {
            Some(0) => return Err(ConfigError::ZeroUnresolvableLookupMaxWait),
            other => other,
        };
        // The wait ceiling is not just a timeout: it *is* the size of the
        // waiting room, since a room drained at `total / window` and holding
        // requests for `max_wait` parks `max_wait * total / window` of them.
        // A ceiling longer than the window therefore parks more than a whole
        // window's worth of drain, which is both more memory than the bound
        // is worth and a wait no packet's own deadline could survive. It is
        // the one budget knob with a coherence rule rather than only a zero
        // check, and it needs one for exactly the reason the others do:
        // nothing else in the file would tell an operator they had written
        // a room ten thousand deep.
        let effective_window_secs =
            unresolvable_lookup_window_secs.unwrap_or(DEFAULT_UNRESOLVABLE_LOOKUP_WINDOW_SECS);
        let effective_max_wait_ms =
            unresolvable_lookup_max_wait_ms.unwrap_or(DEFAULT_UNRESOLVABLE_LOOKUP_MAX_WAIT_MS);
        if effective_max_wait_ms > effective_window_secs.saturating_mul(1_000) {
            return Err(ConfigError::UnresolvableLookupMaxWaitAboveWindow {
                max_wait_ms: effective_max_wait_ms,
                window_secs: effective_window_secs,
            });
        }
        let unresolvable_lookup_max_wait =
            unresolvable_lookup_max_wait_ms.map(Duration::from_millis);
        // The BTP session window (issue #688) is refused at zero for the
        // same species of reason as the budget knobs above, with a sharper
        // edge: zero is not a stricter setting, it is a session whose
        // first paid frame waits forever for an in-flight slot that does
        // not exist -- every BTP client hangs on connect while the file
        // reads as configured. (`1` is coherent: the original lockstep
        // session.)
        let btp_session_window = match raw.btp_session_window {
            Some(0) => return Err(ConfigError::ZeroBtpSessionWindow),
            other => other.and_then(NonZeroU32::new),
        };
        // A per-signer rate above the node-wide one is not a stricter
        // setting, it is an inert one: the node-wide drain saturates first,
        // every time, so the number written for the per-signer axis could
        // never be reached. Refused rather than silently ignored, on the
        // same principle as the stale-window check above -- an operator who
        // wrote it meant something by it.
        //
        // Compared against the values that will actually be **in force**,
        // defaults filled in, rather than only when both were written: a
        // rule that fires only on the both-present case leaves the two
        // one-sided spellings of the same incoherent configuration loading
        // quietly, which is the whole hazard it exists for.
        let effective_per_signer =
            unresolvable_lookups_per_signer.unwrap_or(DEFAULT_UNRESOLVABLE_LOOKUPS_PER_SIGNER);
        let effective_total =
            unresolvable_lookups_total.unwrap_or(DEFAULT_UNRESOLVABLE_LOOKUPS_TOTAL);
        if effective_per_signer > effective_total {
            return Err(ConfigError::UnresolvableLookupPerSignerAboveTotal {
                per_signer: effective_per_signer,
                total: effective_total,
            });
        }

        // A node that can accept a claim must be able to remember having
        // accepted it (issue #605). Refused here, at load, rather than at
        // the first claim: a node whose watermarks live only in memory
        // hands out free service after every restart, and it does so
        // silently -- there is nothing in a log to see, because from the
        // gate's point of view every replayed nonce genuinely is fresh.
        //
        // Tied to `[[client_channels]]` rather than demanded of every
        // node because a node with a record of no channel refuses every
        // claim outright (issue #558): it has no watermark to lose, so
        // requiring it to name a writable directory would be ceremony,
        // and ceremony is what gets configured with a path nobody checked.
        if let Some(path) = &state_dir {
            if path.exists() && !path.is_dir() {
                return Err(ConfigError::StateDirNotADirectory { path: path.clone() });
            }
        } else if !client_channels.is_empty() {
            return Err(ConfigError::ClientChannelsWithoutStateDir);
        } else if !peer_channels.is_empty() {
            // The peer half of the same rule: a peer claim's watermark is
            // no less a replay defence than a client claim's, and ADR
            // 0024's ledger is the record that has to outlive the process.
            return Err(ConfigError::PeerChannelsWithoutStateDir);
        }

        Ok(Config {
            client_edge_addr,
            signer_key,
            routes,
            peer_routes,
            peers,
            peer_expose,
            peer_allow_plaintext_endpoints,
            peer_channels,
            operator,
            settlements,
            client_channels,
            state_dir,
            channel_liveness_ttl,
            channel_serve_stale,
            channel_reattempt_interval,
            unresolvable_lookups_per_signer,
            unresolvable_lookups_total,
            unresolvable_lookup_window,
            unresolvable_lookup_max_wait,
            btp_session_window,
        })
    }

    /// How long a chain-resolved client channel's liveness may be believed
    /// before it is re-read (issue #649), or `None` to use the client
    /// edge's own default.
    pub fn channel_liveness_ttl(&self) -> Option<Duration> {
        self.channel_liveness_ttl
    }

    /// How long past [`Self::channel_liveness_ttl`] a channel's last good
    /// reading may still be served while the chain is unreachable, or
    /// `None` to use the client edge's own default.
    pub fn channel_serve_stale(&self) -> Option<Duration> {
        self.channel_serve_stale
    }

    /// The floor on how often one channel may provoke a chain lookup, or
    /// `None` to use the client edge's own default.
    pub fn channel_reattempt_interval(&self) -> Option<Duration> {
        self.channel_reattempt_interval
    }

    /// How many chain lookups for channels that do not resolve one declared
    /// signer may cause per window once this node's window is contended
    /// (issue #613), or `None` to use the client edge's own default.
    pub fn unresolvable_lookups_per_signer(&self) -> Option<u32> {
        self.unresolvable_lookups_per_signer
    }

    /// How many chain lookups for channels that do not resolve this node
    /// will perform per window in total, or `None` to use the client edge's
    /// own default.
    pub fn unresolvable_lookups_total(&self) -> Option<u32> {
        self.unresolvable_lookups_total
    }

    /// The window the two allowances above are counted over, or `None` to
    /// use the client edge's own default.
    pub fn unresolvable_lookup_window(&self) -> Option<Duration> {
        self.unresolvable_lookup_window
    }

    /// How long a lookup for a channel this node has never resolved may
    /// wait for its slot before being refused instead (issue #613), or
    /// `None` to use the client edge's own default.
    pub fn unresolvable_lookup_max_wait(&self) -> Option<Duration> {
        self.unresolvable_lookup_max_wait
    }

    /// How many of one BTP session's frames may be past claim admission at
    /// once (issue #688), or `None` to use the client edge's own default.
    /// `NonZeroU32` because zero was refused at load: the value in force is
    /// always a working window.
    pub fn btp_session_window(&self) -> Option<NonZeroU32> {
        self.btp_session_window
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

    /// The node's peer routes -- every `[[routes]]` entry that names a
    /// `peer_id` instead of a `handler_url`. Each one's `peer_id` is
    /// guaranteed to name an entry in [`Config::peers`] (`Config::load`
    /// refuses to return a value where it doesn't).
    pub fn peer_routes(&self) -> &[PeerRouteConfig] {
        &self.peer_routes
    }

    /// This node's peering relations. Every one is guaranteed to carry a
    /// non-empty credential and at least one [`Config::peer_channels`] row
    /// -- [`Config::load`] refuses to return a value where either is
    /// missing, because a peering short of either can never take the peer
    /// role (`peer-carriage-spec.md` §1.2).
    pub fn peers(&self) -> &[PeerConfig] {
        &self.peers
    }

    /// Which peer carriages this node opens a listener for
    /// (`peer-carriage-spec.md` §2.1). Independent of how any one peer is
    /// dialed: exposing BTP says nothing about how a peer is reached, and
    /// dialing a peer over HTTP says nothing about what this node listens
    /// on.
    pub fn peer_expose(&self) -> PeerExposure {
        self.peer_expose
    }

    /// Whether this node was told it may dial a **plaintext** peer
    /// endpoint (issue #678, gap 3). `false` on every production config,
    /// including every config that does not mention the field: `ws://` and
    /// `http://` are refused at load exactly as they were before it
    /// existed.
    ///
    /// `true` is loopback and test only. A caller that has one should say
    /// so loudly at startup -- [`Config::plaintext_peerings`] is the list
    /// to name.
    pub fn peer_allow_plaintext_endpoints(&self) -> bool {
        self.peer_allow_plaintext_endpoints
    }

    /// Every peering whose endpoint is plaintext, as `(peer id, endpoint)`
    /// -- what a node with [`Config::peer_allow_plaintext_endpoints`] set
    /// must name in its startup warning. Always empty when the switch is
    /// off, because such an endpoint could not have loaded.
    pub fn plaintext_peerings(&self) -> impl Iterator<Item = (&str, &Url)> {
        self.peers.iter().filter_map(|peer| {
            let endpoint = peer.endpoint()?;
            matches!(endpoint.scheme(), "ws" | "http").then_some((peer.id(), endpoint))
        })
    }

    /// The payment channels this node judges peer claims against (ADR
    /// 0024). Every row names a configured peer, no channel appears twice,
    /// and none of them appears in [`Config::client_channels`] either --
    /// the peer and client watermark namespaces are disjoint by
    /// construction (`peer-carriage-spec.md` §1.8).
    pub fn peer_channels(&self) -> &[PeerChannelConfig] {
        &self.peer_channels
    }

    /// The channels bound to one peering relation. Never empty for a
    /// configured peer: an unbound peering is refused at load.
    pub fn peer_channels_for<'a>(
        &'a self,
        peer_id: &'a str,
    ) -> impl Iterator<Item = &'a PeerChannelConfig> {
        self.peer_channels
            .iter()
            .filter(move |channel| channel.peer_id() == peer_id)
    }

    /// The operator surface's authentication, if the surface is enabled.
    /// `None` means the `[operator]` section was absent -- the surface is
    /// not started at all. A `Some` value is always fully authenticated
    /// (ADR 0008): [`Config::load`] refuses to return one that is missing
    /// a bearer token or a write-key allowlist.
    pub fn operator(&self) -> Option<&OperatorConfig> {
        self.operator.as_ref()
    }

    /// Every settlement backend the `[settlement]` section configures (issue
    /// #542; per-chain tables, issue #628) -- one node can name more than
    /// one chain. Empty means no backend is constructed at startup and every
    /// channel operation answers `ChannelOperationError::NoSettlementBackend`
    /// -- the same "not started at all" degradation an absent `[operator]`
    /// section already has. At most one entry per [`SettlementChain`].
    pub fn settlements(&self) -> &[SettlementConfig] {
        &self.settlements
    }

    /// The payment channels this node accepts client-edge claims on, and
    /// the counterparty whose signature it accepts on each (issue #558).
    /// Empty means this node has a record of no channel at all, so every
    /// claim presented at its client edge is refused as unknown rather
    /// than trusted about who signed it.
    pub fn client_channels(&self) -> &[ClientChannelConfig] {
        &self.client_channels
    }

    /// The directory this node keeps its durable money state in -- the
    /// claim journals whose replay is what makes a watermark survive a
    /// restart (issue #605). `None` means this node writes none, which
    /// [`Config::load`] permits only when `[[client_channels]]` is empty
    /// and so no claim can ever be accepted.
    ///
    /// The directory is not created or probed here: config load says what
    /// was asked for, and whether it can actually be written is
    /// `connector-cli`'s to find out at startup, loudly, before serving.
    pub fn state_dir(&self) -> Option<&Path> {
        self.state_dir.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::peer::PeerCarriage;
    use crate::route::TransportPolicy;
    use std::io::Write;
    use std::path::PathBuf;

    /// The operator doc every peer-schema error message must name -- a
    /// peering that does not come up produces no other evidence an
    /// operator can read, so "which field changed, and where is that
    /// written down" has to be in the message itself.
    const BRINGUP_DOC: &str = "docs/operators/btp-peer-transport-bringup.md";

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
price = 25

[[children]]
name = "billing"
handler_url = "http://localhost:4000"
price = 0
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
        let prices: Vec<u64> = config.routes().iter().map(|r| r.price()).collect();
        assert_eq!(prices, vec![25, 0]);
    }

    /// Issue #701: a route's `transport` field survives a real TOML file
    /// through `Config::load`, and a route that omits it defaults to
    /// accepting both -- matching the devnet shape (relay restricted to
    /// BTP, store left at the default).
    #[test]
    fn loads_a_route_restricted_to_btp_alongside_one_accepting_both() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[[routes]]
prefix = "g.example.relay"
handler_url = "http://localhost:5000"
price = 1000
transport = "btp"

[[routes]]
prefix = "g.example.store"
handler_url = "http://localhost:6000"
price = 1000
"#,
                key_path.display()
            )
        })
        .expect("load");

        let policies: Vec<TransportPolicy> = config
            .routes()
            .iter()
            .map(|r| r.transport_policy())
            .collect();
        assert_eq!(policies, vec![TransportPolicy::Btp, TransportPolicy::Both]);
    }

    #[test]
    fn rejects_a_terminated_route_with_no_price() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[[routes]]
prefix = "g.example.other"
handler_url = "http://localhost:5000"
"#,
                key_path.display()
            )
        });

        assert!(matches!(result, Err(ConfigError::RouteMissingPrice { .. })));
    }

    // -- The peer carriage config surface (issue #677,
    // `peer-carriage-spec.md` §11) --

    const PEER_CHANNEL: &str = "0xaaaabbbbccccddddeeeeffff00001111aaaabbbbccccddddeeeeffff00001111";
    const PEER_KEY: &str = "0x2222222222222222222222222222222222222222";
    const PEER_TOKEN_NETWORK: &str = "0x3333333333333333333333333333333333333333";

    /// A `[[peers]]`/`[[peer_channels]]` pair in its correct shape, the
    /// one an operator should be able to copy. Every negative test below
    /// spoils exactly one thing about it, so what each error is *about* is
    /// the diff between it and this.
    fn peering_config(key_path: &Path, state_dir: &Path, spoil: &str) -> String {
        let base = format!(
            r#"
client_edge_addr = "127.0.0.1:3000"
peer_expose = "btp"
state_dir = "{state_dir}"

[signer]
key_file = "{key_file}"

[[peers]]
id = "store"
endpoint = "wss://store.example:443/btp"
credential = {{ secret = "shared-secret" }}
ceiling = 1000000
flush_interval_ms = 5000

[[peer_channels]]
peer_id = "store"
channel_id = "{PEER_CHANNEL}"
counterparty_key = "{PEER_KEY}"
chain_id = 31337
token_network = "{PEER_TOKEN_NETWORK}"

[[routes]]
prefix = "g.example.store"
peer_id = "store"
fee = 3
"#,
            state_dir = state_dir.display(),
            key_file = key_path.display(),
        );
        format!("{base}{spoil}")
    }

    /// Load `peering_config` with `edit` applied to its text -- the
    /// spoil-one-thing helper the named-error tests share.
    fn load_peering(edit: impl Fn(String) -> String) -> Result<Config, ConfigError> {
        let state_dir = tempfile::tempdir().expect("temp state dir");
        let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
        key_file
            .write_all(b"not a real key")
            .expect("write key file");
        let text = edit(peering_config(key_file.path(), state_dir.path(), ""));
        Config::from_toml_str(&text, Path::new("test.toml"))
    }

    /// The whole surface round-trips from a real TOML file: the exposure
    /// set, the endpoint and the carriage its scheme selects, the
    /// credential, the per-relation terms and their defaults, and the
    /// channel binding that makes the peering a peering at all.
    #[test]
    fn loads_the_full_peer_and_peer_channels_shape() {
        let config = load_peering(|text| text).expect("load");

        assert_eq!(config.peer_expose(), PeerExposure::Btp);
        assert!(config.peer_expose().exposes(PeerCarriage::Btp));
        assert!(!config.peer_expose().exposes(PeerCarriage::Http));

        assert_eq!(config.peers().len(), 1);
        let peer = &config.peers()[0];
        assert_eq!(peer.id(), "store");
        assert_eq!(
            peer.endpoint().map(url::Url::as_str),
            Some("wss://store.example/btp")
        );
        assert_eq!(peer.dial(), Some(PeerCarriage::Btp));
        assert!(peer.credential().matches("shared-secret"));
        assert!(!peer.credential().matches("wrong"));
        assert_eq!(peer.ceiling(), Some(1_000_000));
        assert_eq!(peer.flush_interval_ms(), Some(5_000));
        assert_eq!(peer.claim_ack_timeout_ms(), 30_000);
        assert_eq!(peer.peer_answer_timeout_ms(), 30_000);
        assert!(peer.can_originate());

        assert_eq!(config.peer_channels().len(), 1);
        let channel = &config.peer_channels()[0];
        assert_eq!(channel.peer_id(), "store");
        assert_eq!(channel.channel_id(), PEER_CHANNEL);
        assert_eq!(channel.counterparty_key(), [0x22u8; 20]);
        assert_eq!(channel.chain_id(), 31_337);
        assert_eq!(channel.token_network(), [0x33u8; 20]);
        assert_eq!(config.peer_channels_for("store").count(), 1);
        assert_eq!(config.peer_channels_for("nobody").count(), 0);

        assert_eq!(config.peer_routes().len(), 1);
        assert_eq!(config.peer_routes()[0].peer_id(), "store");
        assert_eq!(config.peer_routes()[0].fee(), 3);
    }

    /// An `https://` peer rides the HTTP carriage instead -- the scheme is
    /// the *only* thing that decides it (§2.1).
    #[test]
    fn an_https_endpoint_selects_the_http_carriage() {
        let config = load_peering(|text| {
            text.replace("wss://store.example:443/btp", "https://store.example/ilp")
        })
        .expect("load");

        assert_eq!(config.peers()[0].dial(), Some(PeerCarriage::Http));
    }

    /// `peer_expose = "neither"` is the NAT'd operator: it exposes nothing
    /// and only dials, which is legal and must stay expressible.
    #[test]
    fn a_natd_operator_exposes_neither_carriage_and_still_loads() {
        let config =
            load_peering(|text| text.replace("peer_expose = \"btp\"", "peer_expose = \"neither\""))
                .expect("load");

        assert_eq!(config.peer_expose(), PeerExposure::Neither);
        assert!(config.peer_expose().is_empty());
        assert!(config.peers()[0].can_originate());
    }

    /// Omitting `peer_expose` entirely is the same as `"neither"`: a peer
    /// listener is opened only by a line somebody wrote.
    #[test]
    fn an_omitted_peer_expose_defaults_to_neither() {
        let config =
            load_peering(|text| text.replace("peer_expose = \"btp\"\n", "")).expect("load");

        assert_eq!(config.peer_expose(), PeerExposure::Neither);
    }

    /// §11 `PeerUndialable`: nothing to dial, and nothing to be dialed on.
    #[test]
    fn rejects_a_peering_that_can_never_establish() {
        let result = load_peering(|text| {
            text.replace("peer_expose = \"btp\"", "peer_expose = \"neither\"")
                .replace("endpoint = \"wss://store.example:443/btp\"\n", "")
        });

        let message = expect_error(
            result,
            |error| matches!(error, ConfigError::PeerUndialable { id } if id == "store"),
        );
        assert!(
            message.contains("can never establish") && message.contains(BRINGUP_DOC),
            "got: {message}"
        );
    }

    /// §11 `PeerEndpointScheme`: a scheme that names no carriage. `ws://`
    /// is the interesting spelling -- it is a real websocket scheme, just
    /// not a TLS one, and a peering carries signed balance proofs.
    #[test]
    fn rejects_an_endpoint_scheme_that_selects_no_carriage() {
        for (written, scheme) in [
            ("ws://store.example/btp", "ws"),
            ("http://store.example/ilp", "http"),
            ("tcp://store.example:4001", "tcp"),
        ] {
            let result = load_peering(|text| text.replace("wss://store.example:443/btp", written));

            let message = expect_error(result, |error| {
                matches!(error, ConfigError::PeerEndpointScheme { id, scheme: s, .. }
                    if id == "store" && s == scheme)
            });
            assert!(
                message.contains("selects no peer carriage")
                    && message.contains("wss://")
                    && message.contains(BRINGUP_DOC),
                "got: {message}"
            );
        }
    }

    /// The old shape was a `SocketAddr`, so URL parsing is new and its
    /// failures need a name of their own -- separate from the scheme
    /// error, because "you wrote a host:port" and "you wrote the wrong
    /// scheme" are different mistakes with different fixes.
    #[test]
    fn rejects_an_endpoint_that_is_not_a_url_at_all() {
        let result =
            load_peering(|text| text.replace("wss://store.example:443/btp", "127.0.0.1:4001"));

        let message = expect_error(
            result,
            |error| matches!(error, ConfigError::InvalidPeerEndpoint { id, .. } if id == "store"),
        );
        assert!(
            message.contains("is a URL") && message.contains(BRINGUP_DOC),
            "got: {message}"
        );
    }

    /// A `wss://` URL with no host is refused as an unparseable endpoint
    /// (the URL standard makes a host mandatory for both of our schemes),
    /// which is the same named error and the same message as any other
    /// malformed one.
    #[test]
    fn rejects_an_endpoint_with_no_host_to_dial() {
        let result =
            load_peering(|text| text.replace("wss://store.example:443/btp", "wss://:443/btp"));

        let message = expect_error(
            result,
            |error| matches!(error, ConfigError::InvalidPeerEndpoint { id, .. } if id == "store"),
        );
        assert!(message.contains("is a URL"), "got: {message}");
    }

    /// §11 `PeerCredentialMissing`, both spellings: no credential at all,
    /// and a credential whose secret is empty. The second is the sharper
    /// one -- an empty secret matches nothing, so the peering would look
    /// configured and admit its counterparty as an ordinary client.
    #[test]
    fn rejects_a_peer_with_no_credential() {
        let result =
            load_peering(|text| text.replace("credential = { secret = \"shared-secret\" }\n", ""));

        let message = expect_error(
            result,
            |error| matches!(error, ConfigError::PeerCredentialMissing { id } if id == "store"),
        );
        assert!(
            message.contains("empty secret matches nothing") && message.contains(BRINGUP_DOC),
            "got: {message}"
        );
    }

    #[test]
    fn rejects_a_peer_whose_configured_secret_is_empty() {
        let result = load_peering(|text| text.replace("\"shared-secret\"", "\"\""));

        assert!(matches!(
            result,
            Err(ConfigError::PeerCredentialMissing { ref id }) if id == "store"
        ));
    }

    /// §11 `PeerChannelUnbound`: P2 of the role rule. This is the exact
    /// defect that made ADR 0024 inert.
    #[test]
    fn rejects_a_peer_with_no_channel_binding() {
        let result = load_peering(|text| {
            let (head, rest) = text.split_once("[[peer_channels]]").expect("fixture");
            let (_, routes) = rest.split_once("[[routes]]").expect("fixture");
            format!("{head}[[routes]]{routes}")
        });

        let message = expect_error(
            result,
            |error| matches!(error, ConfigError::PeerChannelUnbound { id } if id == "store"),
        );
        assert!(
            message.contains("both a proven credential and a channel binding")
                && message.contains(BRINGUP_DOC),
            "got: {message}"
        );
    }

    /// §11 `PeerChannelOrphaned`: a binding to a peering that does not
    /// exist.
    #[test]
    fn rejects_a_peer_channel_naming_an_unconfigured_peer() {
        let result = load_peering(|text| {
            text.replace(
                "peer_id = \"store\"\nchannel_id",
                "peer_id = \"ghost\"\nchannel_id",
            )
        });

        let message = expect_error(
            result,
            |error| matches!(error, ConfigError::PeerChannelOrphaned { peer_id } if peer_id == "ghost"),
        );
        assert!(
            message.contains("no '[[peers]]' entry configures") && message.contains(BRINGUP_DOC),
            "got: {message}"
        );
    }

    /// §11 `ChannelInBothNamespaces` (§1.8): the check that stops a peer
    /// claim and a client claim describing the same money. Written in
    /// mixed case on one side to prove the comparison is over the
    /// canonical form, not the operator's spelling.
    #[test]
    fn rejects_one_channel_configured_in_both_namespaces() {
        let result = load_peering(|text| {
            format!(
                r#"{text}
[[client_channels]]
channel_id = "{}"
counterparty = "{PEER_KEY}"
chain_id = 31337
token_network_address = "{PEER_TOKEN_NETWORK}"
"#,
                PEER_CHANNEL.to_uppercase().replace("0X", "0x"),
            )
        });

        let message = expect_error(
            result,
            |error| matches!(error, ConfigError::ChannelInBothNamespaces { value } if value == PEER_CHANNEL),
        );
        assert!(
            message.contains("counted as credit twice") && message.contains(BRINGUP_DOC),
            "got: {message}"
        );
    }

    /// §11 `AcceptOnlyPeerWithoutCeiling` (§6.4(3)): the accept-only side
    /// has no other bound, so a defaulted ceiling there is an unowned
    /// credit decision.
    #[test]
    fn rejects_an_accept_only_peering_with_no_explicit_ceiling() {
        let result = load_peering(|text| {
            text.replace("endpoint = \"wss://store.example:443/btp\"\n", "")
                .replace("ceiling = 1000000\n", "")
        });

        let message = expect_error(
            result,
            |error| matches!(error, ConfigError::AcceptOnlyPeerWithoutCeiling { id } if id == "store"),
        );
        assert!(
            message.contains("only real bound") && message.contains(BRINGUP_DOC),
            "got: {message}"
        );
    }

    /// The same accept-only peering *with* a ceiling loads.
    #[test]
    fn an_accept_only_peering_with_an_explicit_ceiling_loads() {
        let config =
            load_peering(|text| text.replace("endpoint = \"wss://store.example:443/btp\"\n", ""))
                .expect("load");

        assert_eq!(config.peers()[0].dial(), None);
        assert_eq!(config.peers()[0].ceiling(), Some(1_000_000));
    }

    /// §11 `PeerRouteUndeliverable` (§2.2, §6.4(1)): accept-only, and this
    /// connector exposes only HTTP, so packets can only ever flow the
    /// other way -- the route could answer nothing but `T01`.
    #[test]
    fn rejects_a_route_to_a_peer_this_connector_can_never_originate_to() {
        let result = load_peering(|text| {
            text.replace("peer_expose = \"btp\"", "peer_expose = \"http\"")
                .replace("endpoint = \"wss://store.example:443/btp\"\n", "")
        });

        let message = expect_error(result, |error| {
            matches!(error, ConfigError::PeerRouteUndeliverable { prefix, peer_id }
                if prefix == "g.example.store" && peer_id == "store")
        });
        assert!(
            message.contains("can never originate to") && message.contains(BRINGUP_DOC),
            "got: {message}"
        );
    }

    /// §11 `DuplicatePeerId`.
    #[test]
    fn rejects_a_duplicate_peer_id() {
        let result = load_peering(|text| {
            text.replace(
                "[[peer_channels]]",
                "[[peers]]\nid = \"store\"\nendpoint = \"wss://other.example/btp\"\ncredential = { secret = \"s\" }\n\n[[peer_channels]]",
            )
        });

        let message = expect_error(
            result,
            |error| matches!(error, ConfigError::DuplicatePeerId { id } if id == "store"),
        );
        assert!(
            message.contains("unanswerable") && message.contains(BRINGUP_DOC),
            "got: {message}"
        );
    }

    /// §11's removed-field row, `[[peers]]` half: the boxes run
    /// bind-mounted configs that lead the repo, so a stale `addr` stops
    /// the node and says where to read about it.
    #[test]
    fn rejects_a_stale_peer_entry_that_still_sets_addr() {
        let result = load_peering(|text| {
            text.replace(
                "[[peers]]\nid = \"store\"\n",
                "[[peers]]\nid = \"store\"\naddr = \"127.0.0.1:5000\"\n",
            )
        });

        let message = expect_error(
            result,
            |error| matches!(error, ConfigError::PeerAddrRemoved { id } if id == "store"),
        );
        assert!(
            message.contains("removed with the raw-TCP peer wire")
                && message.contains("endpoint")
                && message.contains(BRINGUP_DOC),
            "got: {message}"
        );
    }

    /// §11's removed-field row, `peer_wire_addr` half. The *field* is
    /// still live on this branch -- deleting the listener it binds is PR
    /// #718 / issue #679's work, not this one's -- so what is asserted
    /// here is the error identity and its message, which #718 constructs.
    #[test]
    fn the_removed_peer_wire_addr_error_names_the_bringup_doc() {
        let message = ConfigError::PeerWireAddrRemoved.to_string();

        assert!(
            message.contains("peer_wire_addr")
                && message.contains("removed with the raw-TCP peer wire")
                && message.contains(BRINGUP_DOC),
            "got: {message}"
        );
    }

    /// A peer claim's watermark is no less a replay defence than a client
    /// claim's (issue #605).
    #[test]
    fn rejects_peer_channels_with_no_state_dir() {
        let result = load_peering(|text| {
            let start = text.find("state_dir = ").expect("fixture");
            let end = text[start..].find('\n').expect("fixture") + start + 1;
            format!("{}{}", &text[..start], &text[end..])
        });

        let message = expect_error(result, |error| {
            matches!(error, ConfigError::PeerChannelsWithoutStateDir)
        });
        assert!(message.contains("spendable again"), "got: {message}");
    }

    #[test]
    fn rejects_an_unrecognized_peer_expose_value() {
        let result =
            load_peering(|text| text.replace("peer_expose = \"btp\"", "peer_expose = \"tcp\""));

        let message = expect_error(
            result,
            |error| matches!(error, ConfigError::InvalidPeerExposure { value } if value == "tcp"),
        );
        assert!(message.contains("neither"), "got: {message}");
    }

    /// Assert `result` failed with the error `predicate` accepts, and hand
    /// back its rendered message -- so every named-error test can go on to
    /// assert what the operator actually reads, not merely that load
    /// failed.
    fn expect_error(
        result: Result<Config, ConfigError>,
        predicate: impl Fn(&ConfigError) -> bool,
    ) -> String {
        let error = result.expect_err("expected this config to be refused at load");
        assert!(predicate(&error), "wrong error variant: {error:?}");
        error.to_string()
    }

    #[test]
    fn a_config_with_no_peers_has_an_empty_list() {
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

        assert!(config.peers().is_empty());
        assert!(config.peer_routes().is_empty());
    }

    #[test]
    fn rejects_a_peer_route_naming_an_unconfigured_peer_id() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[[routes]]
prefix = "g.peer-b"
peer_id = "peer-b"
"#,
                key_path.display()
            )
        });

        assert!(matches!(result, Err(ConfigError::UnknownPeerId { .. })));
    }

    /// ADR 0027 / issue #679: the raw-TCP peer wire is deleted, so a
    /// config still naming its bind address must stop the node by name.
    /// Silently ignoring it is the failure mode that matters -- the devnet
    /// boxes run bind-mounted configs that lead the repo copies, so a
    /// stale one would otherwise come up looking healthy and never peer.
    #[test]
    fn rejects_a_config_that_still_sets_peer_wire_addr() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
peer_wire_addr = "127.0.0.1:4001"

[signer]
key_file = "{}"
"#,
                key_path.display()
            )
        });

        let Err(error) = result else {
            panic!("expected a config error");
        };
        assert!(matches!(error, ConfigError::PeerWireAddrRemoved));
        assert!(error
            .to_string()
            .contains("docs/operators/btp-peer-transport-bringup.md"));
    }

    /// The `[[peers]]` half of the same removal.
    #[test]
    fn rejects_a_peer_that_still_sets_a_socket_addr() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[[peers]]
id = "peer-b"
addr = "127.0.0.1:5000"
"#,
                key_path.display()
            )
        });

        assert!(matches!(result, Err(ConfigError::PeerAddrRemoved { .. })));
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

    #[test]
    fn a_config_with_no_settlement_section_has_no_settlement_config() {
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

        assert!(config.settlements().is_empty());
    }

    #[test]
    fn a_fully_configured_settlement_section_loads() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[settlement]
chain = "evm"
rpc_url = "http://127.0.0.1:8545"
contract_address = "0x1234567890123456789012345678901234567890"
token_address = "0x49beE1Bca5d15Fb0963117923403F9498119a9Ce"
decimals = 6

[settlement.key]
key_file = "{}"
"#,
                key_path.display(),
                key_path.display()
            )
        })
        .expect("load");

        assert_eq!(config.settlements().len(), 1);
        let settlement = &config.settlements()[0];
        assert_eq!(settlement.chain(), crate::SettlementChain::Evm);
        let crate::SettlementConfig::Evm(evm) = settlement else {
            panic!("expected an evm settlement config");
        };
        assert_eq!(evm.rpc_url(), "http://127.0.0.1:8545");
        assert_eq!(evm.decimals(), 6);
    }

    /// The new keyed shape (issue #628): `[settlement.evm]` alone resolves
    /// the same facts the legacy flat shape does.
    #[test]
    fn a_keyed_evm_settlement_table_loads() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[settlement.evm]
rpc_url = "http://127.0.0.1:8545"
contract_address = "0x1234567890123456789012345678901234567890"
token_address = "0x49beE1Bca5d15Fb0963117923403F9498119a9Ce"
decimals = 6

[settlement.evm.key]
key_file = "{}"
"#,
                key_path.display(),
                key_path.display()
            )
        })
        .expect("load");

        assert_eq!(config.settlements().len(), 1);
        assert_eq!(config.settlements()[0].chain(), crate::SettlementChain::Evm);
    }

    /// AC: "A config declaring both [settlement.evm] and [settlement.solana]
    /// parses into typed per-chain settlement config".
    #[test]
    fn declaring_both_evm_and_solana_settlement_tables_loads_both() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{key_path}"

[settlement.evm]
rpc_url = "http://127.0.0.1:8545"
contract_address = "0x1234567890123456789012345678901234567890"
token_address = "0x49beE1Bca5d15Fb0963117893403F9498119a9Ce"
decimals = 6

[settlement.evm.key]
key_file = "{key_path}"

[settlement.solana]
rpc_url = "http://127.0.0.1:8899"
program_id = "TokenNetworkProgram11111111111111111111111"
token_address = "SoLMint11111111111111111111111111111111111"
decimals = 6

[settlement.solana.key]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        })
        .expect("load");

        assert_eq!(config.settlements().len(), 2);
        assert!(config
            .settlements()
            .iter()
            .any(|s| s.chain() == crate::SettlementChain::Evm));
        assert!(config
            .settlements()
            .iter()
            .any(|s| s.chain() == crate::SettlementChain::Solana));
    }

    /// AC: "[settlement.solana] alone: config loads" -- construction refusal
    /// is `connector-cli`'s to enforce (epic #627's fail-closed-per-chain),
    /// not config load's.
    #[test]
    fn a_solana_only_settlement_section_still_loads() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{key_path}"

[settlement.solana]
rpc_url = "http://127.0.0.1:8899"
program_id = "TokenNetworkProgram11111111111111111111111"
token_address = "SoLMint11111111111111111111111111111111111"
decimals = 6

[settlement.solana.key]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        })
        .expect("load");

        assert_eq!(config.settlements().len(), 1);
        assert_eq!(
            config.settlements()[0].chain(),
            crate::SettlementChain::Solana
        );
    }

    #[test]
    fn a_settlement_section_that_cannot_be_satisfied_refuses_to_load() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[settlement]
chain = "made-up-chain"
rpc_url = "http://127.0.0.1:8545"
contract_address = "0x1234567890123456789012345678901234567890"
token_address = "0x49beE1Bca5d15Fb0963117923403F9498119a9Ce"
decimals = 6

[settlement.key]
key_file = "{}"
"#,
                key_path.display(),
                key_path.display()
            )
        });

        assert!(matches!(
            result,
            Err(ConfigError::SettlementUnknownChain { .. })
        ));
    }

    #[test]
    fn an_unknown_top_level_key_is_rejected_rather_than_silently_ignored() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
made_up_top_level_field = "oops"

[signer]
key_file = "{}"
"#,
                key_path.display()
            )
        });

        assert!(matches!(result, Err(ConfigError::Parse { .. })));
    }

    /// Issue #556's parse-layer spine: `deny_unknown_fields` on
    /// `RawConfig` alone only guards the top level. A typo *inside* a
    /// section was still parsed, dropped, and the node started as if the
    /// key had never been written -- so a misspelled `bearer_tokn` read as
    /// an unauthenticated operator surface and a misspelled `key_fle` read
    /// as a signer with no location at all. Each of these now fails at the
    /// parse stage, and the message names the offending key.
    fn assert_names_the_unknown_key(result: Result<Config, ConfigError>, key: &str) {
        let Err(ConfigError::Parse { source, .. }) = result else {
            panic!("expected a parse error naming {key}, got {result:?}");
        };
        let message = source.to_string();
        assert!(
            message.contains(key),
            "parse error should name the offending key {key}, got: {message}"
        );
    }

    #[test]
    fn an_unknown_key_in_the_signer_section_is_rejected() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"
kms_key_di = "transposed"
"#,
                key_path.display()
            )
        });

        assert_names_the_unknown_key(result, "kms_key_di");
    }

    #[test]
    fn an_unknown_key_in_the_operator_section_is_rejected() {
        let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[operator]
bearer_token = "operator-secret"
write_keys = ["{key}"]
bearer_tokn = "typo"
"#,
                key_path.display()
            )
        });

        assert_names_the_unknown_key(result, "bearer_tokn");
    }

    #[test]
    fn an_unknown_key_in_a_peer_entry_is_rejected() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[[peers]]
id = "store"
adrr = "127.0.0.1:4002"
"#,
                key_path.display()
            )
        });

        assert_names_the_unknown_key(result, "adrr");
    }

    #[test]
    fn an_unknown_key_in_a_route_entry_is_rejected() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{}"

[[routes]]
prefix = "g.example.app"
handler_url = "http://localhost:4000"
price = 100
pirce = 5
"#,
                key_path.display()
            )
        });

        assert_names_the_unknown_key(result, "pirce");
    }

    /// A `[[children]]` entry has no `fee` field at all, so the same
    /// mistake a `[[routes]]` entry now refuses used to vanish entirely
    /// here.
    #[test]
    fn an_unknown_key_in_a_child_entry_is_rejected() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
apex = "g.example"

[signer]
key_file = "{}"

[[children]]
name = "app"
handler_url = "http://localhost:4000"
price = 100
fee = 5
"#,
                key_path.display()
            )
        });

        assert_names_the_unknown_key(result, "fee");
    }

    /// The counterweight: a config file using every section this build
    /// supports, with no unknown key anywhere, still loads. Without this
    /// the tests above are satisfied by a config crate that refuses
    /// everything.
    #[test]
    fn a_config_using_every_supported_section_still_loads() {
        let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
peer_expose = "both"
apex = "g.example"
state_dir = "{state_dir}"

[signer]
key_file = "{key_file}"

[[peers]]
id = "store"
endpoint = "wss://store.example:443/btp"
credential = {{ secret = "shared-secret" }}

[[peer_channels]]
peer_id = "store"
channel_id = "{PEER_CHANNEL}"
counterparty_key = "{PEER_KEY}"
chain_id = 31337
token_network = "{PEER_TOKEN_NETWORK}"

[[routes]]
prefix = "g.example.app"
handler_url = "http://localhost:4000"
price = 100

[[routes]]
prefix = "g.example.store"
peer_id = "store"
fee = 3

[[children]]
name = "child"
handler_url = "http://localhost:4100"
price = 7

[operator]
bearer_token = "operator-secret"
write_keys = ["{key}"]
"#,
                key_file = key_path.display(),
                state_dir = std::env::temp_dir()
                    .join("connector-config-every-section-state")
                    .display(),
            )
        })
        .expect("load");

        assert_eq!(config.routes().len(), 2);
        assert_eq!(config.peer_routes().len(), 1);
        assert_eq!(config.peers().len(), 1);
        assert_eq!(config.peer_channels().len(), 1);
        assert_eq!(config.peer_expose(), PeerExposure::Both);
        assert!(config.operator().is_some());
    }

    // -- state_dir (issue #605) --

    /// A node that can accept claims but has nowhere durable to record
    /// them is refused at load. Without this it starts, serves, and hands
    /// out free service after every restart -- silently, because a
    /// forgotten watermark makes every replayed nonce look fresh.
    #[test]
    fn client_channels_without_a_state_dir_is_refused_at_load() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{key_path}"

[[client_channels]]
channel_id = "0x{channel}"
counterparty = "0x00000000000000000000000000000000000000aa"
chain_id = 8453
token_network_address = "0x00000000000000000000000000000000000000bb"
"#,
                key_path = key_path.display(),
                channel = "ab".repeat(32),
            )
        });

        assert!(matches!(
            result,
            Err(ConfigError::ClientChannelsWithoutStateDir)
        ));
        // The message has to tell the operator what to do about it, since
        // this refusal is the first they will hear of the requirement.
        let message = result.unwrap_err().to_string();
        assert!(message.contains("state_dir"), "{message}");
    }

    /// The same config with a `state_dir` loads, and reports it.
    #[test]
    fn client_channels_with_a_state_dir_loads() {
        let state_dir = tempfile::tempdir().expect("temp state dir");
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
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
        })
        .expect("load");

        assert_eq!(config.state_dir(), Some(state_dir.path()));
    }

    /// A node with no channels needs no `state_dir`: it refuses every
    /// claim as unknown (issue #558), so it has no watermark to lose. The
    /// requirement follows the capability, not the ceremony.
    #[test]
    fn no_client_channels_needs_no_state_dir() {
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

        assert_eq!(config.state_dir(), None);
    }

    /// Issue #649: how long a chain-resolved channel's liveness may be
    /// believed is an operator knob, because the trade it makes -- RPC
    /// load against how quickly a settled channel stops being paid on --
    /// belongs to a deployment and not to a constant in this repository.
    #[test]
    fn a_channel_liveness_ttl_is_read_from_config() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
channel_liveness_ttl_secs = 15

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        })
        .expect("a config naming a liveness ttl loads");

        assert_eq!(
            config.channel_liveness_ttl(),
            Some(std::time::Duration::from_secs(15))
        );
    }

    /// Absent means "whatever the client edge's own default is" -- not
    /// zero, which is the one value that would turn every packet into a
    /// chain read.
    #[test]
    fn an_absent_channel_liveness_ttl_is_the_edges_own_default() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        })
        .expect("a config naming no liveness ttl loads");

        assert_eq!(config.channel_liveness_ttl(), None);
    }

    /// Zero is refused rather than obeyed: it reads as "always fresh" and
    /// behaves as "one chain read per packet", which is how an operator
    /// exhausts an RPC endpoint's budget and takes their own paid writes
    /// down with it.
    #[test]
    fn a_zero_channel_liveness_ttl_is_refused_at_load() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
channel_liveness_ttl_secs = 0

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        });

        assert!(matches!(result, Err(ConfigError::ZeroChannelLivenessTtl)));
    }

    /// The other two liveness knobs (the availability review of #654): an
    /// operator on a rate-limited public RPC endpoint is exactly who needs
    /// to widen the stale window and the re-attempt floor, and before this
    /// they had no lever short of a rebuild.
    #[test]
    fn the_stale_window_and_reattempt_interval_are_read_from_config() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
channel_liveness_ttl_secs = 30
channel_serve_stale_secs = 1800
channel_reattempt_interval_ms = 5000

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        })
        .expect("a config naming all three liveness knobs loads");

        assert_eq!(
            config.channel_liveness_ttl(),
            Some(std::time::Duration::from_secs(30))
        );
        assert_eq!(
            config.channel_serve_stale(),
            Some(std::time::Duration::from_secs(1800))
        );
        assert_eq!(
            config.channel_reattempt_interval(),
            Some(std::time::Duration::from_millis(5000))
        );
    }

    /// The BTP session window (issue #688): how many of one session's
    /// frames may be past claim admission at once. Read as written when
    /// non-zero, `None` when absent (the client edge's default applies).
    #[test]
    fn the_btp_session_window_is_read_from_config() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
btp_session_window = 4

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        })
        .expect("a config naming the window loads");

        assert_eq!(
            config.btp_session_window(),
            std::num::NonZeroU32::new(4),
            "the configured window is in force"
        );
    }

    /// An absent window is `None` -- the client edge's own default applies
    /// -- never a guessed number of this crate's own.
    #[test]
    fn an_absent_btp_session_window_defers_to_the_client_edge() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        })
        .expect("a config not naming the window loads");
        assert_eq!(config.btp_session_window(), None);
    }

    /// A zero window is refused at load (issue #688): it is not a slower
    /// session, it is a session whose first paid frame waits forever for
    /// an in-flight slot that does not exist -- every BTP client hangs on
    /// connect while the file reads as configured.
    #[test]
    fn a_zero_btp_session_window_is_refused_at_load() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
btp_session_window = 0

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        });

        assert!(matches!(result, Err(ConfigError::ZeroBtpSessionWindow)));
    }

    /// The unresolvable-lookup budget (issue #613): what a node will spend
    /// discovering channels that turn out not to exist, per declared signer
    /// and in total. An operator on a metered settlement endpoint is
    /// exactly who needs to set the second one.
    #[test]
    fn the_unresolvable_lookup_budget_is_read_from_config() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
unresolvable_lookup_budget_per_signer = 3
unresolvable_lookup_budget_total = 20
unresolvable_lookup_budget_window_secs = 30
unresolvable_lookup_budget_max_wait_ms = 750

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        })
        .expect("a config naming all four budget knobs loads");

        assert_eq!(config.unresolvable_lookups_per_signer(), Some(3));
        assert_eq!(config.unresolvable_lookups_total(), Some(20));
        assert_eq!(
            config.unresolvable_lookup_window(),
            Some(std::time::Duration::from_secs(30))
        );
        assert_eq!(
            config.unresolvable_lookup_max_wait(),
            Some(std::time::Duration::from_millis(750))
        );
    }

    /// Absent means the client edge's own default, the same as every other
    /// knob here -- a node that has not thought about this should get a
    /// bound rather than none.
    #[test]
    fn an_absent_unresolvable_lookup_budget_is_the_edges_own_default() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        })
        .expect("a config naming no budget loads");

        assert_eq!(config.unresolvable_lookups_per_signer(), None);
        assert_eq!(config.unresolvable_lookups_total(), None);
        assert_eq!(config.unresolvable_lookup_window(), None);
        assert_eq!(config.unresolvable_lookup_max_wait(), None);
    }

    /// Zero allowances are refused, and the reason is the mirror image of
    /// the zero ttl above: that one reads as strictness and melts an
    /// endpoint, this one reads as strictness and silently switches off the
    /// registration-free path #611 exists to provide.
    #[test]
    fn a_zero_unresolvable_lookup_allowance_is_refused_at_load() {
        for field in ["per_signer", "total"] {
            let result = with_key_file(|key_path| {
                format!(
                    r#"
client_edge_addr = "127.0.0.1:3000"
unresolvable_lookup_budget_{field} = 0

[signer]
key_file = "{key_path}"
"#,
                    key_path = key_path.display(),
                )
            });

            assert!(
                matches!(
                    result,
                    Err(ConfigError::ZeroUnresolvableLookupBudget { .. })
                ),
                "unresolvable_lookup_budget_{field} = 0 must not load"
            );
        }
    }

    /// A zero-length window is the sharpest of the three footguns: it
    /// restarts on every request, so both allowances are spendable in full
    /// by every request and the budget bounds nothing while looking like it
    /// is configured.
    #[test]
    fn a_zero_unresolvable_lookup_window_is_refused_at_load() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
unresolvable_lookup_budget_window_secs = 0

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        });

        assert!(matches!(
            result,
            Err(ConfigError::ZeroUnresolvableLookupWindow)
        ));
    }

    /// A zero wait ceiling is refused, and it is the one whose reason is
    /// least obvious from the field name: it does not tighten the bound, it
    /// converts it from a shaper into a dropper, and a dropping bound hands
    /// a flooder a switch that turns the registration-free path off for
    /// every new buyer.
    #[test]
    fn a_zero_unresolvable_lookup_wait_ceiling_is_refused_at_load() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
unresolvable_lookup_budget_max_wait_ms = 0

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        });

        assert!(matches!(
            result,
            Err(ConfigError::ZeroUnresolvableLookupMaxWait)
        ));
    }

    /// The wait ceiling is the size of the waiting room, not a timeout, so
    /// it needs a coherence rule and not only a zero check: a ceiling
    /// longer than the window parks more than a whole window's worth of
    /// drain. Issue #613's review, finding C -- it was the one budget knob
    /// with nothing but a zero check, and nothing else in the file would
    /// have told an operator they had written a room thousands deep.
    #[test]
    fn a_wait_ceiling_longer_than_the_window_is_refused_at_load() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
unresolvable_lookup_budget_window_secs = 60
unresolvable_lookup_budget_max_wait_ms = 600000

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        });

        assert!(matches!(
            result,
            Err(ConfigError::UnresolvableLookupMaxWaitAboveWindow {
                max_wait_ms: 600_000,
                window_secs: 60
            })
        ));
    }

    /// ...and against the *defaults* when only one side is written, for the
    /// same reason the rates are: a ceiling above the default window is the
    /// same incoherence spelled one-sidedly.
    #[test]
    fn a_one_sided_wait_ceiling_is_validated_against_the_default_window() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
unresolvable_lookup_budget_max_wait_ms = 90000

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        });

        assert!(matches!(
            result,
            Err(ConfigError::UnresolvableLookupMaxWaitAboveWindow { .. })
        ));
    }

    /// A window longer than the client edge will honour is refused rather
    /// than silently clamped: a rate limit whose window outlives the
    /// process is not a rate limit, and past a point the arithmetic over it
    /// stops fitting an instant. (The client edge clamps as well, since its
    /// policy struct is public and reachable without this check -- but a
    /// value that reached here was *written down*, and silently obeying
    /// something other than what an operator wrote is what this whole file
    /// exists not to do.)
    #[test]
    fn an_absurdly_long_unresolvable_lookup_window_is_refused_at_load() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
unresolvable_lookup_budget_window_secs = 9000000000000

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        });

        assert!(
            matches!(
                result,
                Err(ConfigError::UnresolvableLookupWindowTooLong {
                    max_secs: 86_400,
                    ..
                })
            ),
            "{result:?}"
        );
    }

    /// A per-signer rate above the node-wide one is inert rather than
    /// dangerous -- the drain saturates first every time -- and is refused
    /// for the same reason a stale window shorter than the ttl is: an
    /// operator who wrote a number meant something by it.
    #[test]
    fn a_per_signer_allowance_above_the_node_wide_one_is_refused_at_load() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
unresolvable_lookup_budget_per_signer = 1000
unresolvable_lookup_budget_total = 10

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        });

        assert!(matches!(
            result,
            Err(ConfigError::UnresolvableLookupPerSignerAboveTotal {
                per_signer: 1000,
                total: 10
            })
        ));
    }

    /// ...and the same rule fires when only *one* of the two is written,
    /// because it is compared against the values that will actually be in
    /// force. A rule that needed both present would let the two one-sided
    /// spellings of the same incoherent configuration load quietly, which
    /// is the whole hazard.
    #[test]
    fn a_one_sided_unresolvable_lookup_budget_is_validated_against_the_defaults() {
        // A node-wide rate below the *default* per-signer rate.
        let total_only = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
unresolvable_lookup_budget_total = 5

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        });
        assert!(
            matches!(
                total_only,
                Err(ConfigError::UnresolvableLookupPerSignerAboveTotal { total: 5, .. })
            ),
            "a total below the default per-signer rate is the same incoherence"
        );

        // ...and a per-signer rate above the *default* node-wide one.
        let per_signer_only = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
unresolvable_lookup_budget_per_signer = 10000

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        });
        assert!(matches!(
            per_signer_only,
            Err(ConfigError::UnresolvableLookupPerSignerAboveTotal {
                per_signer: 10000,
                ..
            })
        ));
    }

    /// Zero is refused for the re-attempt floor for the same reason it is
    /// refused for the ttl: it is the value that turns one packet into one
    /// RPC request.
    #[test]
    fn a_zero_reattempt_interval_is_refused_at_load() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
channel_reattempt_interval_ms = 0

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        });

        assert!(matches!(
            result,
            Err(ConfigError::ZeroChannelReattemptInterval)
        ));
    }

    /// ...but zero *is* allowed for the stale window, and the asymmetry is
    /// deliberate: "never serve a reading I could not confirm" is a
    /// defensible fail-closed choice that costs no extra chain read, which
    /// is precisely what a zero ttl or a zero interval would not be.
    #[test]
    fn a_zero_stale_window_is_allowed_because_it_costs_nothing() {
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
channel_serve_stale_secs = 0

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        })
        .expect("never serving a stale reading is a choice an operator may make");

        assert_eq!(
            config.channel_serve_stale(),
            Some(std::time::Duration::ZERO)
        );
    }

    /// A stale window shorter than the ttl names a window that could never
    /// be used -- an entry would stop being believed and stop being
    /// servable at the same moment. Refused rather than silently treated
    /// as zero, since whoever wrote it meant something else.
    #[test]
    fn a_stale_window_shorter_than_the_ttl_is_refused_at_load() {
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
channel_liveness_ttl_secs = 60
channel_serve_stale_secs = 30

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
            )
        });

        assert!(matches!(
            result,
            Err(ConfigError::ServeStaleShorterThanLivenessTtl {
                serve_stale_secs: 30,
                ttl_secs: 60,
            })
        ));
    }

    /// `state_dir` pointing at something that is not a directory is a
    /// load failure, not a surprise at the first journal write.
    #[test]
    fn a_state_dir_that_is_a_file_is_refused_at_load() {
        let not_a_dir = tempfile::NamedTempFile::new().expect("temp file");
        let result = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
state_dir = "{state_dir}"

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
                state_dir = not_a_dir.path().display(),
            )
        });

        assert!(matches!(
            result,
            Err(ConfigError::StateDirNotADirectory { .. })
        ));
    }

    /// A `state_dir` that does not exist yet is not a load failure:
    /// creating it is startup's job (`connector-cli`), and an operator
    /// mounting a fresh empty volume must not have to pre-create it.
    #[test]
    fn a_state_dir_that_does_not_exist_yet_still_loads() {
        let parent = tempfile::tempdir().expect("temp dir");
        let state_dir = parent.path().join("not-created-yet");
        let config = with_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:3000"
state_dir = "{state_dir}"

[signer]
key_file = "{key_path}"
"#,
                key_path = key_path.display(),
                state_dir = state_dir.display(),
            )
        })
        .expect("load");

        assert_eq!(config.state_dir(), Some(state_dir.as_path()));
    }
}
