//! Client-edge router, mountable rather than a server. See ADR 0001, ADR
//! 0003, and `docs/protocol/client-edge-spec.md` -- this implements §1.1
//! (transport and framing: `POST /ilp`, OER-encoded PREPARE in, OER-encoded
//! FULFILL/REJECT out, always HTTP 200 for an ILP-level outcome), all four
//! steps of §1.3 (payment claims, issues #504, #522 and #506/#544): a
//! present claim is parsed, structurally validated, checked for
//! freshness/watermark, checked to advance value by at least the
//! destination's matched app route's price, and -- last -- cryptographically
//! verified against the counterparty this connector records for the channel
//! the claim names (`ClientClaimGate` over a `ClientChannelRegistry`, issue
//! #558 -- a claim's own declared signer carries no authority, and a claim
//! naming an unrecorded channel is refused outright),
//! all before the packet is routed; and, as of issue #526, §1.4 (the x402
//! greeting) and the answering half of identity: `GET /ilp/identity`
//! reports the public key a sender seals a packet to (ADR 0018), and an
//! unpaid request to a route this connector terminates and prices is
//! answered with that route's terms (ADR 0020, ADR 0022) instead of being
//! routed at all. `GET /ilp/routes/price` answers what a given destination
//! would cost. Both live under `/ilp` (matching §3.2's `GET /ilp/versions`
//! precedent for an unauthenticated, client-edge-facing answer) rather than
//! at the bare path, since the operator surface already owns a bearer-gated
//! `GET /identity` of its own (issue #420) and the two routers are merged
//! onto one port whenever the operator surface is enabled. None of this
//! pushes anything into a network unprompted (ADR 0022) -- each is a reply
//! to a request that reached this connector's own client edge, and changes
//! no state. A request presenting no claim header and addressing an
//! unpriced (or unmatched) destination still passes through unchanged,
//! exactly as it always has, and pay-to-write is absolute for a priced
//! route -- there is no configuration, flag or build profile that disables
//! any of §1.3's checks. Identity (§1.2, beyond the key answer) remains
//! unimplemented.
//!
//! As of issue #548 this edge also implements §1.6, cost discovery: every
//! REJECT it answers with carries the running cost total in a
//! `TOON-Accumulated-Cost` header beside the unchanged OER body (ADR 0011 --
//! a reject reports what the path would have charged, rather than a quoting
//! protocol answering about a path the packet never took), and `POST
//! /ilp/probe` is the ingress a sender uses to raise one deliberately,
//! gated by [`Connector::handle_probe`]'s channel and rate-limit checks.
//!
//! Per ADR 0001, `handle_ilp` deserializes, calls exactly one method on
//! [`Connector`], and serializes; the `match` below is that serialization
//! step, not a routing or delivery decision -- those live entirely in
//! [`Connector::handle_prepare`]. `identity` and `route_price` answer
//! directly from this connector's own configuration and never touch
//! [`Connector::handle_prepare`] at all.
//!
//! As of issue #693, `POST /ilp/claim-state` (§1.10, `claim_state` module)
//! answers a bulk, owner-authenticated read of claim state -- deposit
//! total, cumulative claimed, available balance, nonce, last-claim time --
//! for every channel a caller can prove it controls with a per-channel
//! signature over a domain-separated challenge, distinct from a real
//! claim's signature. Also purely a read against existing state
//! ([`ClientClaimGate::watermark`], [`ClientClaimGate::channels`],
//! [`ClientClaimGate::last_claim_time`]); it never calls `ingest`/`admit`,
//! so it adds nothing to the packet admission path #686/#688/#690 spent
//! this edge's history keeping cheap.

use std::num::NonZeroU32;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};

use connector_config::TransportPolicy;
use connector_domain::{PacketResponse, Prepare, Reject, RejectCode};
use connector_runtime::{Connector, ProbeDenied};
use connector_signer::nip59::{unwrap_claim, WrappedClaim};
use connector_signer::{PublicKeyBytes, Signer};

mod btp;
mod channels;
mod claim_gate;
mod claim_state;
mod lookup_budget;
mod outbound_ledger;
mod peer;
mod session_registry;
mod session_route;
pub use channels::{
    ChannelLivenessPolicy, ChannelLookupFailed, ChannelResolutionError, ClientChannelRegistry,
    ClientChannelSource, DepositFloor, EvmChannel, InvalidChannelIdentifier, SolanaChannel,
    DEFAULT_LIVENESS_TTL, DEFAULT_MIN_REATTEMPT_INTERVAL, DEFAULT_SERVE_STALE_UNTIL,
};
pub use claim_gate::{ClaimIngestRejection, ClientClaimGate};
pub use lookup_budget::{
    LookupBudgetBound, LookupBudgetExhausted, UnresolvableLookupBudget,
    UnresolvableLookupBudgetPolicy, DEFAULT_UNRESOLVABLE_LOOKUPS_PER_SIGNER,
    DEFAULT_UNRESOLVABLE_LOOKUPS_TOTAL, DEFAULT_UNRESOLVABLE_LOOKUP_MAX_WAIT,
    DEFAULT_UNRESOLVABLE_LOOKUP_WINDOW, MAX_UNRESOLVABLE_LOOKUP_WINDOW,
};
pub use outbound_ledger::ClientPayoutLedger;
pub use peer::PeerCarriages;
pub use session_registry::SESSION_LEASE_BACKSTOP_TTL;

/// The BTP carriage's default per-session in-flight window (issue #688):
/// how many of one session's frames may be past claim admission at once.
/// `16` clears the measured ~125-150 ev/s per-session wall by an order of
/// magnitude on a ~7 ms downstream (window/latency ≈ 2 000/s) while keeping
/// a session's queued work bounded and modest; the config file's
/// `btp_session_window` overrides it.
pub const DEFAULT_BTP_SESSION_WINDOW: NonZeroU32 = match NonZeroU32::new(16) {
    Some(window) => window,
    None => unreachable!(),
};

const OCTET_STREAM: &str = "application/octet-stream";
/// The one declaration, read rather than re-spelled (spec I2): the peer
/// carriage's HTTP claim header *is* this one, because ADR 0027 reuses the
/// claim carriage verbatim rather than minting a second decoder
/// (`peer-carriage-spec.md` §12.1).
const CLAIM_HEADER: &str = connector_btp::CLAIM_HEADER;
const CLAIM_WRAPPED_HEADER: &str = "ilp-payment-channel-claim-wrapped";
const PAYMENT_REQUIRED_HEADER: &str = "payment-required";
/// client-edge-spec.md §1.6: a REJECT's running cost total rides beside the
/// OER body in this header rather than inside it, since RFC-0027's REJECT
/// `data` is reserved for an application-level reject's own diagnostic
/// payload. Decimal `uint64`, present on every REJECT this edge answers
/// with (issue #548).
const ACCUMULATED_COST_HEADER: &str = connector_btp::ACCUMULATED_COST_HEADER;

struct ClientEdgeState {
    connector: Arc<Connector>,
    signer: Arc<dyn Signer>,
    claim_gate: ClientClaimGate,
    /// This connector's own NIP-59 receiver key, used to unwrap a
    /// privacy-wrapped claim (client-edge-spec.md §1.3). `None` means this
    /// instance is not configured to receive wrapped claims -- one is
    /// refused with [`ClaimIngestRejection::WrapUnsupported`] rather than
    /// silently accepted unwrapped or left to panic.
    wrap_receiver_secret: Option<[u8; 32]>,
    /// This node's channel-opening facts, carried in every x402 greeting
    /// (issue #617). `None` on a node with no settlement backend.
    settlement_terms: Option<X402SettlementTerms>,
    /// Every configured chain's channel-opening facts (issue #632), carried
    /// in `extra.settlements` beside [`settlement_terms`](Self::settlement_terms).
    /// Empty on a node with no settlement backend.
    settlements: Vec<X402ChainSettlementTerms>,
    /// How many of one BTP session's frames may be past claim admission --
    /// waiting out the journal's group commit, being routed downstream, or
    /// answering -- at once (issue #688). Claims themselves are still
    /// judged strictly in arrival order; this bounds only the overlapped
    /// tail. See `btp::btp_session`.
    btp_session_window: NonZeroU32,
    /// The client session registry (issue #698, toon-meta#262 decision
    /// 12): which address's BTP session is live right now, fenced by a
    /// monotonic generation so a reconnect can never be raced by the
    /// session it replaced. Shared by every session `btp::btp_session`
    /// serves -- bound at auth, cleared on close -- so a reconnect on a
    /// different socket is visible to every other session immediately.
    session_registry: Arc<session_registry::SessionRegistry>,
    /// The peer carriages this node exposes (issue #678, ADR 0027,
    /// `peer-carriage-spec.md` §1). `None` -- the default, and every node
    /// whose `peer_expose` is `"neither"` -- means this edge serves clients
    /// only and every interaction on it is a client's, exactly as it was
    /// before the carriages existed.
    ///
    /// Peer traffic rides *these* listeners rather than a second socket
    /// (`docs/operators/btp-peer-transport-bringup.md`), so this field is
    /// what makes `POST /ilp` and `GET /ilp/btp` serve two audiences; §1.3
    /// forbids the listener itself deciding which, and it does not --
    /// `peer::PeerCarriages` decides by credential alone.
    peers: Option<Arc<PeerCarriages>>,
}

/// Mount the client edge at `connector`, signing/answering identity with
/// `signer`: `POST /ilp` per `docs/protocol/client-edge-spec.md` §1.1, plus
/// `GET /ilp/identity` and `GET /ilp/routes/price` (§1.2/§1.4, issue #526),
/// with no configured NIP-59 receiver key -- a privacy-wrapped claim is
/// refused rather than accepted -- and a record of no payment channel at
/// all, so every claim presented to it is refused as
/// [`ClaimIngestRejection::UnknownChannel`] (issue #558). Use
/// [`router_with_wrap_key`] to accept wrapped claims, and
/// [`router_with_gate`] to give this edge the channels whose claims it
/// should accept.
pub fn router(connector: Arc<Connector>, signer: Arc<dyn Signer>) -> Router {
    router_with_wrap_key(connector, signer, None)
}

/// As [`router`], but able to unwrap a privacy-wrapped claim
/// (client-edge-spec.md §1.3) using `wrap_receiver_secret` as this
/// connector's own NIP-59 receiver key.
pub fn router_with_wrap_key(
    connector: Arc<Connector>,
    signer: Arc<dyn Signer>,
    wrap_receiver_secret: Option<[u8; 32]>,
) -> Router {
    // A gate with a record of no channel accepts nothing, so it has no
    // watermark a restart could lose and needs no durable journal (issue
    // #605). A node that means to accept claims goes through
    // `router_with_gate` and supplies a gate built over a real one.
    let gate = ClientClaimGate::restore(
        ClientChannelRegistry::new(),
        Arc::new(connector_runtime::InMemoryJournal::new()),
    )
    .expect("a fresh in-memory journal has nothing to replay");
    router_with_gate(connector, signer, wrap_receiver_secret, gate)
}

/// As [`router_with_wrap_key`], but with a fully built [`ClientClaimGate`]
/// -- the channels whose claims this edge accepts (issue #558) *and* the
/// durable journal their watermarks survive a restart in (issue #605).
///
/// The gate is passed in rather than assembled here on purpose: building
/// one can fail (a journal that will not replay), and that failure has to
/// stop the node starting, which a function returning a [`Router`] cannot
/// do. This is also the seam a node's startup arming (issue #556)
/// populates: the [`ClientChannelRegistry`] the gate was built over
/// carries both sources of a channel's record -- whatever the node
/// declared (`[[client_channels]]`) and, optionally, a
/// [`ClientChannelSource`] resolving anything else against the chain
/// ([`ClientChannelRegistry::with_source`]), which is what lets an
/// unaffiliated buyer who has opened a channel on chain pay without the
/// operator editing config first (issue #502). A registry with neither
/// refuses every claim.
pub fn router_with_gate(
    connector: Arc<Connector>,
    signer: Arc<dyn Signer>,
    wrap_receiver_secret: Option<[u8; 32]>,
    claim_gate: ClientClaimGate,
) -> Router {
    router_with_gate_and_terms(
        connector,
        signer,
        wrap_receiver_secret,
        claim_gate,
        None,
        Vec::new(),
    )
}

/// As [`router_with_gate`], but with the node's channel-opening facts to
/// carry in every x402 greeting: `settlement_terms` is the legacy
/// EVM-shaped single object (issue #617), `settlements` is the additive
/// per-chain list (issue #632) -- every chain this node settles on,
/// including the same EVM entry `settlement_terms` already carries. `None`
/// and an empty list together -- the plain [`router_with_gate`] -- is a
/// node with no settlement backend, whose greeting keeps its pre-#617 shape
/// exactly.
pub fn router_with_gate_and_terms(
    connector: Arc<Connector>,
    signer: Arc<dyn Signer>,
    wrap_receiver_secret: Option<[u8; 32]>,
    claim_gate: ClientClaimGate,
    settlement_terms: Option<X402SettlementTerms>,
    settlements: Vec<X402ChainSettlementTerms>,
) -> Router {
    router_with_gate_terms_and_btp_window(
        connector,
        signer,
        wrap_receiver_secret,
        claim_gate,
        settlement_terms,
        settlements,
        DEFAULT_BTP_SESSION_WINDOW,
    )
}

/// As [`router_with_gate_and_terms`], but naming the BTP carriage's
/// per-session in-flight window (issue #688): how many of one session's
/// frames may be past claim admission -- waiting out the journal's group
/// commit, being routed downstream, answering -- at once. Claims are still
/// judged strictly in arrival order whatever the window; `1` reproduces the
/// original lockstep session exactly. `NonZeroU32` because a window of `0`
/// is not a slower configuration, it is a session whose first paid frame
/// waits forever -- the config layer refuses it before this signature is
/// ever reached (`btp_session_window = 0`), and the type refuses it here
/// for every caller that skips the config layer.
#[allow(clippy::too_many_arguments)]
pub fn router_with_gate_terms_and_btp_window(
    connector: Arc<Connector>,
    signer: Arc<dyn Signer>,
    wrap_receiver_secret: Option<[u8; 32]>,
    claim_gate: ClientClaimGate,
    settlement_terms: Option<X402SettlementTerms>,
    settlements: Vec<X402ChainSettlementTerms>,
    btp_session_window: NonZeroU32,
) -> Router {
    router_with_peer_carriages(
        connector,
        signer,
        wrap_receiver_secret,
        claim_gate,
        settlement_terms,
        settlements,
        btp_session_window,
        None,
    )
}

/// As [`router_with_gate_terms_and_btp_window`], but also mounting this
/// node's **peer carriages** on the listeners it already serves (issue
/// #678, ADR 0027).
///
/// `peers` is [`PeerCarriages::from_config`]'s value -- `None` for a node
/// whose `peer_expose` is `"neither"` or that configures no peering, which
/// is every node this router served before the carriages existed and is
/// byte-identical to what it served then.
///
/// There is no second listener and no second port
/// (`docs/operators/btp-peer-transport-bringup.md`: peer carriages *"ride
/// this node's own listeners"*). A peer PREPARE is the same OER encoding
/// `POST /ilp` already carries (`peer-carriage-spec.md` §3.1), and what
/// tells a peer interaction from a client one is
/// [`connector_peer_auth::decide_role`] -- never the carriage, the
/// listener, the port or the bind address (§1.3).
#[allow(clippy::too_many_arguments)]
pub fn router_with_peer_carriages(
    connector: Arc<Connector>,
    signer: Arc<dyn Signer>,
    wrap_receiver_secret: Option<[u8; 32]>,
    claim_gate: ClientClaimGate,
    settlement_terms: Option<X402SettlementTerms>,
    settlements: Vec<X402ChainSettlementTerms>,
    btp_session_window: NonZeroU32,
    peers: Option<Arc<PeerCarriages>>,
) -> Router {
    let state = Arc::new(ClientEdgeState {
        connector,
        signer,
        claim_gate,
        wrap_receiver_secret,
        settlement_terms,
        settlements,
        btp_session_window,
        session_registry: Arc::new(session_registry::SessionRegistry::new()),
        peers,
    });
    Router::new()
        .route("/ilp", post(handle_ilp))
        .route("/ilp/btp", get(btp::handle_btp_upgrade))
        .route("/ilp/probe", post(handle_probe))
        .route("/ilp/identity", get(identity))
        .route("/ilp/routes/price", get(route_price))
        .route("/ilp/claim-state", post(claim_state::claim_state))
        .with_state(state)
}

/// The `ILP-Payment-Channel-Claim-Wrapped` header's JSON shape
/// (client-edge-spec.md §1.3): `base64(NIP-59-wrapped claim)`. `version` and
/// `timestamp` ride the wire but are not this ticket's concern -- carried
/// only so the shape round-trips; wrap/unwrap cares about the other two
/// fields alone.
#[derive(Deserialize)]
struct WrappedClaimEnvelope {
    #[serde(rename = "ephemeralPublicKey")]
    ephemeral_public_key: String,
    #[serde(rename = "encryptedPayload")]
    encrypted_payload: String,
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Wall-clock unix seconds, for [`ClientClaimGate::note_claim_time`] -- the
/// one place any handler in this crate reads the clock outside a test. Not
/// consulted by admission itself (`ingest`/`admit` take no time input at
/// all), only by carriers noting a claim's acceptance *after* it has
/// already happened.
pub(crate) fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// This connector's own identity (ADR 0018, ADR 0022): the uncompressed
/// secp256k1 public key a sender must seal a packet's payload to before it
/// can address this connector, plus the key id identifying it. Unlike the
/// operator surface's own bearer-gated `GET /identity` (issue #420, a
/// different audience per ADR 0022) -- mounted at `/ilp/identity` so the
/// two cannot collide when both routers merge onto one port -- this one is
/// unauthenticated -- an unaffiliated sender who has never registered with this connector's
/// operator still needs this key before it can form a packet at all, and
/// answering it decides nothing and reaches nobody who did not ask.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct ClientEdgeIdentity {
    #[serde(rename = "keyId")]
    key_id: String,
    #[serde(rename = "publicKey")]
    public_key: String,
}

async fn identity(State(state): State<Arc<ClientEdgeState>>) -> Response {
    match state.signer.public_key() {
        Ok(public_key) => Json(ClientEdgeIdentity {
            key_id: state.signer.key_id(),
            public_key: format!("0x{}", hex_encode(&public_key)),
        })
        .into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct RoutePriceQuery {
    destination: String,
}

/// What a given destination would cost to deliver to, per ADR 0022's
/// "a sender can ask what a route of its costs" -- reuses
/// [`Connector::app_route_price`], the same longest-prefix lookup the
/// x402 greeting and the claim gate's value binding already use, so this
/// answers with exactly the price a real request to `destination` would be
/// charged, never a second source of truth.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct RoutePriceView {
    destination: String,
    price: u64,
}

async fn route_price(
    State(state): State<Arc<ClientEdgeState>>,
    Query(query): Query<RoutePriceQuery>,
) -> Response {
    match state.connector.app_route_price(&query.destination) {
        Some(price) => Json(RoutePriceView {
            destination: query.destination,
            price,
        })
        .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            format!(
                "no locally-terminated route matches '{}'",
                query.destination
            ),
        )
            .into_response(),
    }
}

/// The x402 v2 payment-required greeting (client-edge-spec.md §1.4): the
/// terms of the one payment method this connector's client edge actually
/// understands -- a TOON payment channel claim, over this same `/ilp`
/// endpoint. `accepts` is a list (ADR 0022's fourth acceptance criterion)
/// so a later method can be offered alongside this one without changing
/// the answer's shape; only one entry exists today because on-chain
/// settlement addresses (the `exact` x402 scheme's `asset`/`payTo`) are not
/// yet configured anywhere in this connector (issue #526 is answering
/// terms, not adding that config).
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct X402PaymentRequired {
    #[serde(rename = "x402Version")]
    x402_version: u32,
    resource: X402Resource,
    accepts: Vec<X402PaymentOption>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct X402Resource {
    url: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct X402PaymentOption {
    scheme: String,
    network: String,
    amount: String,
    #[serde(rename = "payTo")]
    pay_to: String,
    #[serde(rename = "maxTimeoutSeconds")]
    max_timeout_seconds: u64,
    #[serde(rename = "httpEndpoint")]
    http_endpoint: String,
    extra: X402ChannelExtra,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct X402ChannelExtra {
    #[serde(rename = "ilpAddress")]
    ilp_address: String,
    endpoint: String,
    price: String,
    /// The channel-opening facts (issue #617), present exactly when this
    /// node has a settlement backend. `None` (and absent on the wire) on a
    /// settlement-less node -- the terms shape is otherwise unchanged, so
    /// a parser written before this field existed is unaffected.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    settlement: Option<X402SettlementTerms>,
    /// Every configured chain's channel-opening facts (issue #632), additive
    /// beside [`settlement`](Self::settlement): a node settling on N chains
    /// (epic #627) lists all N here, including the same EVM entry
    /// `settlement` already carries verbatim. Absent -- not an empty array
    /// -- on a node with no settlement backend at all, so the pre-#632
    /// shape (and the pre-#617 shape beneath it) stays byte-identical for a
    /// settlement-less node; a parser written before either field existed
    /// is unaffected either way.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    settlements: Vec<X402ChainSettlementTerms>,
    /// Present, and self-diagnosing, exactly when this greeting answers a
    /// request that arrived over a transport its route's policy does not
    /// accept (issue #701, toon-meta#262 decision 11): `"http"` or `"btp"`,
    /// naming the transport the route actually requires. Absent -- not
    /// `null` -- on every other greeting, so the pre-#701 shape is
    /// unchanged for a route with no transport restriction.
    #[serde(
        rename = "requiredTransport",
        skip_serializing_if = "Option::is_none",
        default
    )]
    required_transport: Option<String>,
    /// The session lease backstop TTL this node's client session registry
    /// actually enforces (issue #722, toon-meta#262 decision 12's
    /// cross-plane invariant), in milliseconds -- always present, unlike
    /// `settlement`/`settlements`/`requiredTransport`, since every node has
    /// a session registry regardless of settlement backend. Always the same
    /// value [`crate::session_registry::SESSION_LEASE_BACKSTOP_TTL`]
    /// enforces, never a second literal typed nearby: a client (buzz#84's
    /// relay-side freshness window among them) reads this instead of
    /// hardcoding a guessed millisecond count.
    #[serde(rename = "sessionLeaseTtlMs")]
    session_lease_ttl_ms: u64,
}

/// What an unaffiliated buyer needs to OPEN a channel with this node,
/// carried in the x402 greeting's `extra` (issue #617). This is ADR 0022's
/// "answers when asked" applied to channel establishment: the TypeScript
/// fleet distributes these same facts in a kind:10032 announce, which this
/// fleet will never make -- the greeting is the ask that replaces it.
///
/// Every field is a fact the node already proved at startup:
/// `EvmSettlementBackend::connect` resolved `token_network` through the
/// registry and refused to boot on a `decimals` disagreement, so nothing
/// here can drift from the deployment without the node failing to start.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct X402SettlementTerms {
    /// `evm:<chainId>`, the chain the backend read at connect time.
    pub chain: String,
    /// The on-chain counterparty a buyer opens a channel WITH -- the
    /// settlement backend's own signing address.
    #[serde(rename = "settlementAddress")]
    pub settlement_address: String,
    /// The stable operator-facing factory address (issue #576).
    #[serde(rename = "tokenNetworkRegistry")]
    pub token_network_registry: String,
    /// The resolved `TokenNetwork` -- the EIP-712 `verifyingContract` a
    /// claim on any of its channels is signed under.
    #[serde(rename = "tokenNetwork")]
    pub token_network: String,
    #[serde(rename = "tokenAddress")]
    pub token_address: String,
    /// The token's own reported scale -- informational (claims are already
    /// in base units), verified against the chain at startup (issue #564).
    pub decimals: u8,
}

/// One configured chain's entry in the x402 greeting's `extra.settlements`
/// list (issue #632, epic #627's per-chain expansion of the single EVM
/// [`X402SettlementTerms`] issue #617 shipped). Untagged: serde tries each
/// variant in declaration order and keeps the first one whose required
/// fields all deserialize, so as long as every variant has at least one
/// field the others lack -- `tokenNetworkRegistry` for EVM, `programId` for
/// Solana -- that structural mismatch alone disambiguates them; no explicit
/// tag is needed on the wire.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum X402ChainSettlementTerms {
    /// Exactly the same facts, in the same shape, the legacy `extra.settlement`
    /// object carries -- a two-chain node's `settlements` entry for its EVM
    /// leg is byte-identical to its legacy `settlement` object.
    Evm(X402SettlementTerms),
    /// See [`X402SolanaSettlementTerms`] for what each field means.
    Solana(X402SolanaSettlementTerms),
}

/// The Solana twin of [`X402SettlementTerms`] (issue #632): what an
/// unaffiliated buyer needs to open a channel against this node's deployed
/// `payment-channel` program instance. Every field is a fact
/// `SolanaSettlementBackend::connect` already proved at startup (issue
/// #630) -- the program is reachable, executable and proven to behave like
/// the deployed payment-channel program, and the configured `decimals`
/// agrees with the mint's own.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct X402SolanaSettlementTerms {
    /// Always `"solana"` -- unlike EVM, a Solana backend has no chain id to
    /// append: the program id already names exactly one deployed instance.
    pub chain: String,
    /// The on-chain counterparty a buyer opens a channel WITH -- the
    /// settlement backend's own signing pubkey, base58-encoded.
    #[serde(rename = "settlementAddress")]
    pub settlement_address: String,
    /// The deployed `payment-channel` program instance, base58-encoded.
    #[serde(rename = "programId")]
    pub program_id: String,
    /// The SPL mint every channel this backend opens settles in,
    /// base58-encoded.
    #[serde(rename = "tokenAddress")]
    pub token_address: String,
    /// The mint's own reported scale -- informational (claims are already
    /// in base units), verified against the chain at startup (issue #630).
    pub decimals: u8,
}

const X402_VERSION: u32 = 2;
const X402_MAX_TIMEOUT_SECONDS: u64 = 60;

/// Answer an unpaid request to `destination`, a route this connector
/// terminates and prices at `price`, with its terms instead of performing
/// the app's work (client-edge-spec.md §1.4, ADR 0022) -- this changes no
/// state and is only ever a reply to the request that asked. `settlement`
/// is the node's legacy EVM-shaped channel-opening facts (issue #617),
/// `settlements` is the additive per-chain list (issue #632); both are
/// included exactly when the node has the relevant backend(s).
fn payment_required(
    destination: &str,
    price: u64,
    settlement: Option<&X402SettlementTerms>,
    settlements: &[X402ChainSettlementTerms],
) -> Response {
    x402_response(destination, price, settlement, settlements, None)
}

/// Answer a request to `destination` that arrived over a transport its
/// route's policy does not accept (issue #701, toon-meta#262 decision 11)
/// with the same x402-shaped terms the unpaid-request greeting above uses,
/// rather than inventing a second self-description mechanism -- the client
/// learns which transport the route requires from `extra.requiredTransport`
/// (`required.name()`, e.g. `"btp"`) the same way it learns a route's price
/// from `extra.price`. This runs whether or not the request carries a valid
/// claim: paying over the wrong transport does not make the route
/// reachable that way, so `handle_ilp` checks transport before it checks
/// payment at all.
fn wrong_transport_required(
    destination: &str,
    price: u64,
    required: TransportPolicy,
    settlement: Option<&X402SettlementTerms>,
    settlements: &[X402ChainSettlementTerms],
) -> Response {
    x402_response(
        destination,
        price,
        settlement,
        settlements,
        Some(required.name()),
    )
}

fn x402_response(
    destination: &str,
    price: u64,
    settlement: Option<&X402SettlementTerms>,
    settlements: &[X402ChainSettlementTerms],
    required_transport: Option<&str>,
) -> Response {
    let body = x402_terms_body(
        destination,
        price,
        settlement,
        settlements,
        required_transport,
    );
    let header_value = BASE64.encode(&body);
    Response::builder()
        .status(StatusCode::PAYMENT_REQUIRED)
        .header(header::CONTENT_TYPE, "application/json")
        .header(PAYMENT_REQUIRED_HEADER, header_value)
        .body(Body::from(body))
        .expect("well-formed x402 response")
        .into_response()
}

/// The x402 v2 terms JSON itself (§1.4), shared by both carriages: the HTTP
/// greeting above serves it as a 402 body + `Payment-Required` header, and
/// the BTP greeting (§1.9, `btp` module) carries the same bytes as
/// `payment-required` protocolData on a REJECT -- factored so the two can
/// never drift. `required_transport` (issue #701) is `None` for an ordinary
/// unpaid-request greeting and `Some("http" | "btp")` when this same shape
/// is reused to tell a client it used the wrong transport entirely.
fn x402_terms_body(
    destination: &str,
    price: u64,
    settlement: Option<&X402SettlementTerms>,
    settlements: &[X402ChainSettlementTerms],
    required_transport: Option<&str>,
) -> Vec<u8> {
    let terms = X402PaymentRequired {
        x402_version: X402_VERSION,
        resource: X402Resource {
            url: destination.to_string(),
        },
        accepts: vec![X402PaymentOption {
            scheme: "toon-channel".to_string(),
            network: destination.to_string(),
            amount: price.to_string(),
            pay_to: destination.to_string(),
            max_timeout_seconds: X402_MAX_TIMEOUT_SECONDS,
            http_endpoint: "/ilp".to_string(),
            extra: X402ChannelExtra {
                ilp_address: destination.to_string(),
                endpoint: "/ilp".to_string(),
                price: price.to_string(),
                settlement: settlement.cloned(),
                settlements: settlements.to_vec(),
                required_transport: required_transport.map(str::to_string),
                session_lease_ttl_ms: crate::session_registry::SESSION_LEASE_BACKSTOP_TTL
                    .as_millis() as u64,
            },
        }],
    };
    serde_json::to_vec(&terms).expect("x402 terms always serialize")
}

/// Decode a claim header's raw (still base64-encoded) bytes into the
/// plaintext claim JSON, unwrapping first if `wrapped` is true.
fn decode_claim_header(
    header_value: &[u8],
    wrapped: bool,
    wrap_receiver_secret: Option<&[u8; 32]>,
) -> Result<String, ClaimIngestRejection> {
    let decoded = BASE64.decode(header_value).map_err(|error| {
        ClaimIngestRejection::Malformed(format!("claim header is not valid base64: {error}"))
    })?;

    if !wrapped {
        return String::from_utf8(decoded).map_err(|error| {
            ClaimIngestRejection::Malformed(format!("claim header is not valid UTF-8: {error}"))
        });
    }

    let Some(receiver_secret) = wrap_receiver_secret else {
        return Err(ClaimIngestRejection::WrapUnsupported);
    };

    let envelope: WrappedClaimEnvelope = serde_json::from_slice(&decoded).map_err(|error| {
        ClaimIngestRejection::Malformed(format!(
            "wrapped claim envelope is not valid JSON: {error}"
        ))
    })?;
    let ephemeral_public_key_bytes =
        hex_decode(&envelope.ephemeral_public_key).ok_or_else(|| {
            ClaimIngestRejection::Malformed(
                "wrapped claim's ephemeralPublicKey is not valid hex".to_string(),
            )
        })?;
    let ephemeral_public_key: PublicKeyBytes = ephemeral_public_key_bytes
        .as_slice()
        .try_into()
        .map_err(|_| {
            ClaimIngestRejection::Malformed(
                "wrapped claim's ephemeralPublicKey is not 65 bytes uncompressed".to_string(),
            )
        })?;
    let encrypted_payload = BASE64
        .decode(&envelope.encrypted_payload)
        .map_err(|error| {
            ClaimIngestRejection::Malformed(format!(
                "wrapped claim's encryptedPayload is not valid base64: {error}"
            ))
        })?;

    let wrapped_claim = WrappedClaim {
        ephemeral_public_key,
        encrypted_payload,
    };
    let rumor = unwrap_claim(&wrapped_claim, receiver_secret)
        .map_err(|error| ClaimIngestRejection::WrapFailed(error.to_string()))?;
    String::from_utf8(rumor).map_err(|error| {
        ClaimIngestRejection::Malformed(format!("unwrapped claim is not valid UTF-8: {error}"))
    })
}

/// Extract and fully validate whatever claim header `headers` carries, per
/// client-edge-spec.md §1.3, against `price` -- the matched route's price,
/// `0` for an unpriced or unmatched destination, since routing itself (not
/// this gate) is what refuses an unroutable one, with F02.
///
/// `Ok(None)` means no claim header was present at all -- reachable here
/// only when the destination is unpriced or unmatched, since `handle_ilp`
/// answers the x402 greeting instead of calling this at all for an unpaid
/// request to a priced route (issue #526) -- so the request proceeds
/// unchanged, exactly as it always has. `Ok(Some(channel_key))` means a
/// present claim validated cleanly, and names the channel it validated on:
/// the evidence, and the only evidence this connector ever gets, that an
/// unaffiliated sender holds a payment channel with it (issue #548). A
/// plaintext header takes precedence when both are present, since a client
/// presenting both is presenting the same claim twice, not two different
/// ones.
async fn extract_and_validate_claim(
    headers: &HeaderMap,
    price: u64,
    state: &ClientEdgeState,
) -> Result<Option<String>, ClaimIngestRejection> {
    let (header_value, wrapped) = if let Some(value) = headers.get(CLAIM_HEADER) {
        (value, false)
    } else if let Some(value) = headers.get(CLAIM_WRAPPED_HEADER) {
        (value, true)
    } else {
        return Ok(None);
    };

    let claim_json = decode_claim_header(
        header_value.as_bytes(),
        wrapped,
        state.wrap_receiver_secret.as_ref(),
    )?;
    let claim = state.claim_gate.ingest(&claim_json, price).await?;
    let channel_key = claim.channel_key();
    // Best-effort liveness bookkeeping for issue #693's claim-state
    // endpoint (`ClientClaimGate::note_claim_time`'s own doc): happens only
    // after `ingest` has already returned durable, never inside it.
    state.claim_gate.note_claim_time(&channel_key, now_unix());
    Ok(Some(channel_key))
}

/// Answer an ILP-level outcome the way client-edge-spec.md §1.1 and §1.6
/// specify: always `200`, the OER-encoded packet as the body, and -- on a
/// REJECT and only a REJECT -- the running cost total in
/// `TOON-Accumulated-Cost` (issue #548). Every REJECT this edge answers
/// with goes through here, so none can report an outcome without also
/// reporting what reaching it cost; a FULFILL carries no such header,
/// having been paid for rather than priced.
fn packet_response(response: PacketResponse) -> Response {
    match response {
        PacketResponse::Fulfill(fulfill) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, OCTET_STREAM)],
            fulfill.encode(),
        )
            .into_response(),
        PacketResponse::Reject(reject) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, OCTET_STREAM),
                (
                    header::HeaderName::from_static(ACCUMULATED_COST_HEADER),
                    reject.accumulated_cost.to_string().as_str(),
                ),
            ],
            reject.encode(),
        )
            .into_response(),
    }
}

/// A claim-ingest refusal, as an OER REJECT. `price` is the matched route's
/// price, and rides home as `accumulated_cost` on an underpayment (issue
/// #548): that refusal's whole subject is a figure the sender did not
/// cover, and disclosing it only inside a human-readable `message` -- the
/// one channel through which a price was ever disclosed before -- forces a
/// client to parse English, or to discover the price by underpaying first,
/// which is exactly what cost discovery exists to prevent. Every other
/// refusal here is decided before any route price is in play and reports
/// `0`: nothing was traversed and nothing terminated.
fn claim_rejected_response(rejection: ClaimIngestRejection, price: u64) -> Response {
    // Underpayment is a distinct ILP error (F03: Invalid Amount, issue
    // #522) from every other claim-ingest refusal above it (F01: Invalid
    // Packet) -- the claim is structurally and cryptographically fine, it
    // simply isn't enough value.
    //
    // `NotDurable` is a third code again (T00: Internal Error, issue
    // #605), and the only *temporary* one here: this connector could not
    // record the claim, the claim itself is fine, and a sender told F01
    // would conclude its perfectly good claim was invalid rather than
    // retry it.
    //
    // An undercollateralized claim (issue #646) is F03 too -- it is a
    // refusal about an amount, and a sender who parses codes rather than
    // English should see that much -- but it reports `accumulated_cost: 0`,
    // unlike an underpayment: the route's price *was* covered, so the
    // figure this claim failed against is the channel's on-chain deposit,
    // not a price, and #548's price disclosure is not what this refusal is
    // about. The deposit it must cover is in the message.
    //
    // A withheld channel lookup (issue #613) is T05: Rate Limited -- and a
    // *failed* one is T00, which it should have been all along. Both are
    // temporary, and that is the half that matters: neither says anything
    // is wrong with the claim. A sender told F01 concludes its claim is
    // invalid and stops, which is the right conclusion for a bad signature
    // and precisely the wrong one both here and for an RPC outage -- the
    // claim is fine, the connector is busy or broken, and the answer is
    // "try again". `ChannelLookupFailed` fell through to F01 before this
    // change, telling a paying client its claim was invalid because a third
    // party's endpoint blipped; correcting it here rather than leaving it
    // is the point of reasoning about this arm at all.
    //
    // The two are kept apart -- T05 rather than T00 for the shaper --
    // because this connector did not fail at anything when it shapes: it
    // declined to do free work right now, which is the one thing RFC-0027
    // has T05 for, and a sender parsing codes rather than English can tell
    // "retry, the node's endpoint hiccupped" from "back off, you are being
    // metered".
    packet_response(PacketResponse::Reject(claim_rejection_reject(
        rejection, price,
    )))
}

/// The refusal itself -- `RejectCode`, `accumulated_cost` and message -- for
/// a claim-ingest rejection, independent of carriage: `claim_rejected_response`
/// wraps it for HTTP, the `btp` module frames it for a websocket session
/// (§1.9), so the taxonomy the comment above reasons through stays
/// single-sourced.
fn claim_rejection_reject(rejection: ClaimIngestRejection, price: u64) -> Reject {
    let (code, accumulated_cost) = match rejection {
        ClaimIngestRejection::Underpayment { .. } => (RejectCode::f03_invalid_amount(), price),
        ClaimIngestRejection::Undercollateralized { .. } => (RejectCode::f03_invalid_amount(), 0),
        ClaimIngestRejection::NotDurable => (RejectCode::t00_internal_error(), 0),
        ClaimIngestRejection::ChannelLookupFailed(_) => (RejectCode::t00_internal_error(), 0),
        ClaimIngestRejection::LookupBudgetExhausted { .. } => (RejectCode::t05_rate_limited(), 0),
        _ => (RejectCode::f01_invalid_packet(), 0),
    };
    Reject {
        code,
        triggered_by: String::new(),
        message: rejection.message(),
        data: Vec::new(),
        accumulated_cost,
    }
}

async fn handle_ilp(
    State(state): State<Arc<ClientEdgeState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // **Role is decided before anything else happens** (peer-carriage-spec.md
    // §1.5): before a claim is decoded, before a watermark is consulted,
    // before a packet is even decoded -- a peer FLUSH is a POST with an
    // *empty* body (§3), which the client edge's own decode below would
    // refuse as malformed. A client-role request gets `None` back and every
    // line after this one runs exactly as it did before peering existed.
    if let Some(peers) = state.peers.as_ref() {
        if let Some(response) = peers.handle_http(&headers, &body).await {
            return response;
        }
    }

    let prepare = match Prepare::decode(&body) {
        Ok(prepare) => prepare,
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };

    // An unpaid request -- no claim header of either kind -- addressing a
    // route this connector terminates and prices is answered with that
    // route's terms instead of being routed at all (client-edge-spec.md
    // §1.4, ADR 0022): the app is never asked to do free work for an
    // anonymous, unpaying caller. A present claim header suppresses the
    // greeting unconditionally (its validation, including underpayment, is
    // §1.3's job below); an unpriced or unmatched destination is
    // unaffected and falls through unchanged, exactly as it always has.
    let has_claim_header =
        headers.contains_key(CLAIM_HEADER) || headers.contains_key(CLAIM_WRAPPED_HEADER);
    // No matching app route means nothing here is priced -- routing itself
    // (not this gate) is what refuses an unroutable destination, with F02.
    // One lookup serves both facts (issue #701): the price and the
    // transport policy come from the same matched route, so there is no
    // reason to walk the route table twice for one request.
    let app_route = state.connector.app_route(&prepare.destination);
    let price = app_route.map_or(0, |route| route.price);

    // Transport policy (issue #701, toon-meta#262 decision 11) is checked
    // before payment is considered at all: a route restricted to BTP is
    // unreachable over HTTP whether or not the request carries a valid
    // claim, so a paid request over the wrong transport is refused exactly
    // like an unpaid one. A destination matching no app route is
    // unaffected -- `None` here, same as an unmatched destination's price.
    if let Some(policy) = app_route.map(|route| route.transport_policy) {
        if !policy.accepts_http() {
            return wrong_transport_required(
                &prepare.destination,
                price,
                policy,
                state.settlement_terms.as_ref(),
                &state.settlements,
            );
        }
    }

    if !has_claim_header && price > 0 {
        return payment_required(
            &prepare.destination,
            price,
            state.settlement_terms.as_ref(),
            &state.settlements,
        );
    }

    // A claim header's validation failure rejects the packet before it is
    // routed at all (client-edge-spec.md §1.3) -- the app is never asked to
    // do work that was never validly paid for.
    match extract_and_validate_claim(&headers, price, &state).await {
        Err(rejection) => return claim_rejected_response(rejection, price),
        // A claim that cleared the gate is this connector's evidence that
        // the sender holds the channel it names (issue #548), which is what
        // makes that sender eligible to probe at `POST /ilp/probe` later.
        Ok(Some(channel_key)) => state.connector.recognize_channel(&channel_key),
        Ok(None) => {}
    }

    // client-edge-spec.md v1 carries no minimum-delivery field (§4 of
    // peer-wire-spec.md scopes it to the peer wire) -- a client-originated
    // packet declares no guarantee yet, so this hop enforces none, exactly
    // matching today's actual (unguaranteed) behavior.
    //
    // Issue #736: routing is `Connector::handle_prepare`'s three configured
    // sources first, then whatever client session `state.session_registry`
    // has bound to this destination -- see `session_route::route_prepare`.
    packet_response(session_route::route_prepare(&state, prepare, price).await)
}

/// `POST /ilp/probe` -- a probe's ingress (client-edge-spec.md §1.6, ADR
/// 0011): an ordinary PREPARE a sender expects to be rejected, sent to
/// learn what a path costs from the `TOON-Accumulated-Cost` the REJECT
/// comes back with. Body and response framing are `POST /ilp`'s exactly
/// (§1.1); what differs is the gate in front, and that nothing is charged.
///
/// Because a probe traverses this connector's network for free, it is
/// accepted only from a sender identified by a payment channel claim, and
/// only within a rate limit per that channel -- ADR 0011's two conditions,
/// enforced in [`Connector::handle_probe`]. Both denials, and a probe that
/// presents no usable claim at all, are `403`: the sender may be perfectly
/// well authenticated (§1.2's `401` is a different failure) and is simply
/// not authorized to probe. A `403` carries no OER body, per §1.1's rule
/// that a non-2xx status never does.
///
/// The claim here identifies rather than pays: it is validated in full,
/// against a price of `0`, so possession of the channel is proven and a
/// replayed claim is still refused, but no value need advance. A sender
/// probes by reissuing at the same cumulative amount with a fresh nonce.
async fn handle_probe(
    State(state): State<Arc<ClientEdgeState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let prepare = match Prepare::decode(&body) {
        Ok(prepare) => prepare,
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };

    let channel_key = match extract_and_validate_claim(&headers, 0, &state).await {
        Ok(Some(channel_key)) => channel_key,
        Ok(None) => {
            return (
                StatusCode::FORBIDDEN,
                "a probe must identify itself with a payment channel claim".to_string(),
            )
                .into_response();
        }
        Err(rejection) => return (StatusCode::FORBIDDEN, rejection.message()).into_response(),
    };

    match state.connector.handle_probe(&channel_key, prepare, 0).await {
        Ok(response) => packet_response(response),
        Err(ProbeDenied::NoOpenChannel) => (
            StatusCode::FORBIDDEN,
            format!("no payment channel this connector recognizes: '{channel_key}'"),
        )
            .into_response(),
        Err(ProbeDenied::RateLimited) => (
            StatusCode::FORBIDDEN,
            format!("probe rate limit exceeded for '{channel_key}'"),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use chrono::{TimeZone, Utc};
    use connector_config::StaticRoute;
    use connector_domain::{derive_condition, EnvelopeRequest, EnvelopeResponse, Fulfill, Reject};
    use connector_runtime::{
        AppOutcome, FakeAppClient, InMemoryJournal, InProcessPeerTransport, PeerRoute, TestClock,
    };
    use connector_signer::LocalSigner;
    use tower::ServiceExt;

    const FULFILLMENT: [u8; 32] = [7u8; 32];

    /// A claim gate over `channels`, journaling to a store that lives no
    /// longer than the test does. These tests are about the HTTP surface
    /// in front of the gate; that a watermark survives a restart is
    /// `claim_gate`'s own `durability` module, over a real file.
    fn test_gate(channels: ClientChannelRegistry) -> ClientClaimGate {
        ClientClaimGate::restore(channels, Arc::new(InMemoryJournal::new()))
            .expect("a fresh in-memory journal has nothing to replay")
    }

    /// A structured envelope's plain encoding (ADR 0018/issue #519) -- used
    /// directly only by tests whose `Prepare` never reaches
    /// `Connector::deliver_to_app` at all (a reject raised short of the
    /// termination neither inspects nor requires a sealed `data`). Any test
    /// that expects real app delivery must use [`sealed_envelope_request_data`]
    /// instead, sealed to whichever identity the terminating `Connector` is
    /// configured with -- per ADR 0018, `deliver_to_app` cannot open a
    /// plaintext envelope at all now that sealing is mandatory (issue #524).
    fn envelope_request_data(body: &[u8]) -> Vec<u8> {
        EnvelopeRequest {
            method: "POST".to_string(),
            target: "/".to_string(),
            headers: vec![],
            body: body.to_vec(),
        }
        .encode()
    }

    /// The gift wrap a real sender would produce (issue #524): seals a
    /// minimal `POST /` envelope carrying `body` to `receiver_public`.
    /// Returns the wire bytes for `Prepare.data` and the shared secret the
    /// wrap carries, which a caller also needs to open the sealed
    /// `Fulfill`/termination-`Reject` this `Prepare` produces.
    fn sealed_envelope_request_data(
        body: &[u8],
        receiver_public: &PublicKeyBytes,
    ) -> (Vec<u8>, [u8; 32]) {
        connector_signer::giftwrap::seal_request(&envelope_request_data(body), receiver_public)
            .expect("seal")
    }

    /// Open `data` (a `Fulfill.data`, or a termination `Reject.data`) with
    /// `shared_secret` and decode it as a response envelope.
    fn open_sealed_envelope(shared_secret: &[u8; 32], data: &[u8]) -> EnvelopeResponse {
        let opened = connector_signer::giftwrap::open_response(shared_secret, data)
            .expect("open sealed response");
        EnvelopeResponse::decode(&opened).expect("decode response envelope")
    }

    /// The `AppOutcome` a `FakeAppClient` produces for an app that answers
    /// `200` with `body`. The app supplies nothing toward fulfilment (issue
    /// #525): whether the packet fulfils is decided entirely by whether its
    /// execution condition matches the fulfilment its own sealed secret
    /// derives, never by anything in this response.
    fn answered(body: &[u8]) -> AppOutcome {
        answered_with_status(200, body)
    }

    fn answered_with_status(status: u16, body: &[u8]) -> AppOutcome {
        AppOutcome::Answered {
            response: EnvelopeResponse {
                status,
                headers: vec![],
                body: body.to_vec(),
            },
        }
    }

    /// The response envelope `Connector::deliver_to_app` seals into
    /// `Fulfill.data` for the same inputs `answered` above configures a
    /// `FakeAppClient` with. Compare against [`open_sealed_envelope`]'s
    /// result, since sealing makes the raw wire bytes non-deterministic per
    /// call.
    fn fulfill_envelope(body: &[u8]) -> EnvelopeResponse {
        fulfill_envelope_with_status(200, body)
    }

    fn fulfill_envelope_with_status(status: u16, body: &[u8]) -> EnvelopeResponse {
        EnvelopeResponse {
            status,
            headers: vec![],
            body: body.to_vec(),
        }
    }

    /// A fixed EIP-712 domain for this module's one peer-wire claim test
    /// (issue #575/#566) -- an arbitrary but consistent chain id and
    /// `TokenNetwork` address.
    fn test_channel_domain() -> connector_runtime::ChannelDomain {
        connector_runtime::ChannelDomain {
            chain_id: 84_532,
            token_network_address: [0x1E; 20],
        }
    }

    /// A valid on-chain `bytes32` peer-wire channel id for tests (issue
    /// #575's AC4).
    fn channel_a() -> String {
        format!("0x{:064x}", 1)
    }

    fn test_signer() -> Arc<dyn Signer> {
        Arc::new(LocalSigner::generate("test-signer"))
    }

    /// A `Prepare` never expected to reach a genuine fulfilment -- its
    /// `execution_condition` is a fixed placeholder unrelated to any
    /// sealed secret, so a test using this bare (rather than
    /// [`sealed_sample_prepare`]) must not expect a `Fulfill`.
    fn sample_prepare(destination: &str) -> Prepare {
        Prepare {
            amount: 0,
            // Comfortably after `test_clock()`'s instant (2030-01-01).
            expires_at: Utc.with_ymd_and_hms(2031, 1, 1, 0, 0, 0).unwrap(),
            execution_condition: derive_condition(&FULFILLMENT),
            destination: destination.to_string(),
            data: envelope_request_data(b"hello app"),
        }
    }

    /// As [`sample_prepare`], but with `data` sealed to `receiver_public`
    /// (issue #524) and `execution_condition` set to match the fulfilment
    /// this same sealed secret derives (ADR 0019, issue #525) -- for a test
    /// whose `Prepare` genuinely reaches `Connector::deliver_to_app` and
    /// expects it to fulfil. Returns the shared secret alongside, to open
    /// the sealed `Fulfill`/termination-`Reject` this produces.
    fn sealed_sample_prepare(
        destination: &str,
        receiver_public: &PublicKeyBytes,
    ) -> (Prepare, [u8; 32]) {
        let (data, shared_secret) = sealed_envelope_request_data(b"hello app", receiver_public);
        let condition = derive_condition(&connector_signer::giftwrap::derive_fulfillment(
            &shared_secret,
        ));
        (
            Prepare {
                data,
                execution_condition: condition,
                ..sample_prepare(destination)
            },
            shared_secret,
        )
    }

    fn sealed_sample_prepare_with_amount(
        destination: &str,
        amount: u64,
        receiver_public: &PublicKeyBytes,
    ) -> (Prepare, [u8; 32]) {
        let (prepare, shared_secret) = sealed_sample_prepare(destination, receiver_public);
        (Prepare { amount, ..prepare }, shared_secret)
    }

    fn test_clock() -> Arc<TestClock> {
        Arc::new(TestClock::new(
            Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
        ))
    }

    #[tokio::test]
    async fn a_client_sending_a_matching_packet_receives_the_apps_outcome() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(route.handler_url(), answered(b"app said yes"));
        let signer = test_signer();
        let connector = Arc::new(
            Connector::new(
                vec![route],
                vec![],
                app_client,
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_identity_signer(signer.clone()),
        );
        let (prepare, shared_secret) =
            sealed_sample_prepare("g.example.app", &signer.public_key().unwrap());
        let app = router(connector, signer);

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(prepare.encode()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            OCTET_STREAM
        );

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let fulfill = Fulfill::decode(&bytes).expect("decode fulfill");
        assert_eq!(
            open_sealed_envelope(&shared_secret, &fulfill.data),
            fulfill_envelope(b"app said yes")
        );
    }

    #[tokio::test]
    async fn a_packet_with_no_matching_route_is_rejected_with_a_specific_reason() {
        let app_client = Arc::new(FakeAppClient::new());
        let connector = Arc::new(Connector::new(
            vec![],
            vec![],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let app = router(connector, test_signer());

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(sample_prepare("g.nowhere").encode()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        // An ILP-level outcome, even a reject, is always HTTP 200 (client-edge-spec.md §1.1).
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let reject = Reject::decode(&bytes).expect("decode reject");
        assert_eq!(reject.code.as_str(), "F02");
        assert!(reject.message.contains("g.nowhere"));
    }

    #[tokio::test]
    async fn a_malformed_request_body_is_a_400() {
        let app_client = Arc::new(FakeAppClient::new());
        let connector = Arc::new(Connector::new(
            vec![],
            vec![],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let app = router(connector, test_signer());

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(vec![0xff, 0xff, 0xff, 0xff]))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    /// Issue #521's central rule (ADR 0020): "you pay for an answer, not
    /// the answer you wanted." A non-2xx response from the app is a real
    /// answer, still HTTP 200 at the client edge, riding home as a
    /// response envelope on a FULFILL -- not converted into a rejection.
    #[tokio::test]
    async fn a_non_2xx_response_from_the_app_still_returns_200_with_a_fulfill_body() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            answered_with_status(402, b"payment required"),
        );
        let signer = test_signer();
        let connector = Arc::new(
            Connector::new(
                vec![route],
                vec![],
                app_client,
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_identity_signer(signer.clone()),
        );
        let (prepare, shared_secret) =
            sealed_sample_prepare("g.example.app", &signer.public_key().unwrap());
        let app = router(connector, signer);

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(prepare.encode()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let fulfill = Fulfill::decode(&bytes).expect("decode fulfill");
        assert_eq!(
            open_sealed_envelope(&shared_secret, &fulfill.data),
            fulfill_envelope_with_status(402, b"payment required")
        );
    }

    /// Two connectors, driven only through the first one's router: a client
    /// posts a packet to the first connector, which has no app of its own
    /// for this destination and instead forwards it over an in-process peer
    /// transport to the second connector, which delivers it to its app.
    #[tokio::test]
    async fn a_client_packet_is_forwarded_to_a_second_connector_and_delivered_to_its_app() {
        let second_hop_route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let second_hop_app_client = Arc::new(FakeAppClient::new());
        second_hop_app_client.respond(
            second_hop_route.handler_url(),
            answered(b"delivered by the second connector"),
        );
        let second_hop_identity = test_signer();
        let second_hop = Arc::new(
            Connector::new(
                vec![second_hop_route],
                vec![],
                second_hop_app_client,
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_identity_signer(second_hop_identity.clone()),
        );
        let mut peer_transport = InProcessPeerTransport::new();
        peer_transport.add_peer("second-hop", second_hop);
        let first_hop = Arc::new(Connector::new(
            vec![],
            vec![PeerRoute::new("g.example.app", "second-hop", 0)],
            Arc::new(FakeAppClient::new()),
            Arc::new(peer_transport),
            test_clock(),
        ));
        // Sealed to the *second* hop's identity -- the connector that
        // actually terminates this route, not the one the client's router
        // request happens to land on first.
        let (prepare, shared_secret) =
            sealed_sample_prepare("g.example.app", &second_hop_identity.public_key().unwrap());
        let app = router(first_hop, test_signer());

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(prepare.encode()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let fulfill = Fulfill::decode(&bytes).expect("decode fulfill");
        assert_eq!(
            open_sealed_envelope(&shared_secret, &fulfill.data),
            fulfill_envelope(b"delivered by the second connector")
        );
    }

    /// The first connector's flat fee (ADR 0010) for its peering relation
    /// with the second connector is subtracted before forwarding, and the
    /// second connector -- reachable only through the first one's router,
    /// exactly like a real client -- observes the discounted amount.
    #[tokio::test]
    async fn a_client_packet_forwarded_to_a_peer_is_charged_that_relations_flat_fee() {
        use connector_signer::{LocalSigner, Signer};

        let second_hop_route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let second_hop_app_client = Arc::new(FakeAppClient::new());
        second_hop_app_client.respond(
            second_hop_route.handler_url(),
            answered(b"delivered by the second connector"),
        );
        let payer_signer = LocalSigner::generate("payer-claim-key");
        let payer_address =
            connector_signer::derive_evm_address(&payer_signer.public_key().unwrap());
        let second_hop_identity = test_signer();
        let second_hop = Arc::new(
            Connector::new(
                vec![second_hop_route],
                vec![],
                second_hop_app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_channel_verification_key(channel_a(), payer_address)
            .with_channel_domain(channel_a(), test_channel_domain())
            .unwrap()
            .with_identity_signer(second_hop_identity.clone()),
        );
        let mut peer_transport = InProcessPeerTransport::new();
        peer_transport.add_peer("second-hop", second_hop);
        peer_transport.set_peer_channel("second-hop", channel_a());
        let first_hop = Arc::new(
            Connector::new(
                vec![],
                vec![PeerRoute::new("g.example.app", "second-hop", 3)],
                Arc::new(FakeAppClient::new()),
                Arc::new(peer_transport),
                test_clock(),
            )
            .with_signer(Arc::new(payer_signer))
            .with_peer_claim_channel("second-hop", channel_a())
            .with_channel_domain(channel_a(), test_channel_domain())
            .unwrap(),
        );
        let (prepare, _shared_secret) = sealed_sample_prepare_with_amount(
            "g.example.app",
            50,
            &second_hop_identity.public_key().unwrap(),
        );
        let app = router(first_hop.clone(), test_signer());

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(prepare.encode()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        Fulfill::decode(&bytes).expect("decode fulfill");
        // The port never sees a `Prepare` (issue #521), so the forwarded
        // amount is asserted through the claim it armed rather than
        // through the app client -- 50 minus this peer relationship's
        // flat fee of 3.
        assert_eq!(first_hop.claims()[0].cumulative_amount, 47);
    }

    /// A packet forwarded to a second connector that has no route for it is
    /// rejected there, and that rejection reaches the original client
    /// unchanged through the first connector's router.
    #[tokio::test]
    async fn a_reject_with_no_route_at_the_second_hop_reaches_the_original_client() {
        let second_hop = Arc::new(Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let mut peer_transport = InProcessPeerTransport::new();
        peer_transport.add_peer("second-hop", second_hop);
        let first_hop = Arc::new(Connector::new(
            vec![],
            vec![PeerRoute::new("g.example.app", "second-hop", 0)],
            Arc::new(FakeAppClient::new()),
            Arc::new(peer_transport),
            test_clock(),
        ));
        let app = router(first_hop, test_signer());

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let reject = Reject::decode(&bytes).expect("decode reject");
        assert_eq!(reject.code.as_str(), "F02");
        assert!(reject.message.contains("g.example.app"));
    }

    /// Two separate connectors: a client posts to the first connector's
    /// router, which has no app of its own for this destination and
    /// forwards the packet across the [`PeerTransport`] port to the second
    /// connector, which delivers it to its app -- and the fulfillment
    /// travels back the same way.
    ///
    /// This used to run over the raw-TCP peer wire's `PeerWireServer`.
    /// ADR 0027 / issue #679 deleted that wire, so the hop is made over
    /// the in-process transport instead; what is under test here is the
    /// client edge handing a peer-routed packet to whatever transport is
    /// installed, which is carriage-independent. The statement that a
    /// *network* transport upholds the port's contract belongs to
    /// `peer_transport.rs`'s contract suite, which #676's carriages join.
    #[tokio::test]
    async fn a_client_packet_is_forwarded_over_the_peer_transport_to_a_second_connector() {
        let second_hop_route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let second_hop_app_client = Arc::new(FakeAppClient::new());
        second_hop_app_client.respond(
            second_hop_route.handler_url(),
            answered(b"delivered over the peer transport"),
        );
        let second_hop_identity = test_signer();
        let second_hop = Arc::new(
            Connector::new(
                vec![second_hop_route],
                vec![],
                second_hop_app_client,
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_identity_signer(second_hop_identity.clone()),
        );

        let mut peer_transport = InProcessPeerTransport::new();
        peer_transport.add_peer("second-hop", second_hop);
        let first_hop = Arc::new(Connector::new(
            vec![],
            vec![PeerRoute::new("g.example.app", "second-hop", 0)],
            Arc::new(FakeAppClient::new()),
            Arc::new(peer_transport),
            test_clock(),
        ));
        let (prepare, shared_secret) =
            sealed_sample_prepare("g.example.app", &second_hop_identity.public_key().unwrap());
        let app = router(first_hop, test_signer());

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(prepare.encode()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let fulfill = Fulfill::decode(&bytes).expect("decode fulfill");
        assert_eq!(
            open_sealed_envelope(&shared_secret, &fulfill.data),
            fulfill_envelope(b"delivered over the peer transport")
        );
    }

    /// A sender can ask this connector who it is and get back the key it
    /// would seal a packet to (ADR 0018, ADR 0022, issue #526) --
    /// unauthenticated, no request body, and answered from this connector's
    /// own signer with no state change.
    #[tokio::test]
    async fn a_sender_can_ask_this_connectors_identity_and_gets_its_public_key() {
        let connector = Arc::new(Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let signer = test_signer();
        let app = router(connector, signer.clone());

        let request = Request::builder()
            .method("GET")
            .uri("/ilp/identity")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let identity: ClientEdgeIdentity = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(identity.key_id, signer.key_id());
        assert_eq!(
            identity.public_key,
            format!("0x{}", hex_encode(&signer.public_key().unwrap()))
        );
    }

    /// A sender can ask what a given terminated route costs and gets that
    /// route's configured price back (ADR 0022, issue #526), reading the
    /// same value `app_route_price` -- and so the claim gate and the x402
    /// greeting -- would charge against a real request.
    #[tokio::test]
    async fn a_sender_can_ask_what_a_route_costs() {
        let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 42).unwrap();
        let connector = Arc::new(Connector::new(
            vec![route],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let app = router(connector, test_signer());

        let request = Request::builder()
            .method("GET")
            .uri("/ilp/routes/price?destination=g.example.app.sub")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let view: RoutePriceView = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(view.price, 42);
    }

    /// Asking about a destination that matches no locally-terminated route
    /// is a 404, not a fabricated price.
    #[tokio::test]
    async fn asking_the_price_of_an_unmatched_destination_is_a_404() {
        let connector = Arc::new(Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let app = router(connector, test_signer());

        let request = Request::builder()
            .method("GET")
            .uri("/ilp/routes/price?destination=g.nowhere")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    /// The heart of issue #526: an unpaid request to a route this connector
    /// terminates and prices is answered with its terms (x402 v2, §1.4)
    /// instead of ever reaching the app -- the free-gateway failure mode
    /// ADR 0022 exists to close.
    #[tokio::test]
    async fn an_unpaid_request_to_a_priced_route_is_answered_with_terms_not_performed() {
        let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 100).unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        // Deliberately no `app_client.respond(...)` registered: `deliveries()`
        // records a call the moment `AppClient::deliver` runs, regardless of
        // outcome, so an empty list below proves the app was never reached
        // at all -- not merely that it answered unfavorably.
        let connector = Arc::new(Connector::new(
            vec![route],
            vec![],
            app_client.clone(),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let app = router(connector, test_signer());

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
        let payment_required_header = response
            .headers()
            .get(PAYMENT_REQUIRED_HEADER)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let terms: X402PaymentRequired = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(terms.x402_version, 2);
        assert_eq!(terms.resource.url, "g.example.app");
        assert_eq!(terms.accepts.len(), 1, "terms are carried as a list");
        assert_eq!(terms.accepts[0].amount, "100");

        // The header carries the same body the greeting sends over the wire.
        let header_bytes = BASE64.decode(&payment_required_header).unwrap();
        assert_eq!(header_bytes, bytes.to_vec());

        assert!(
            app_client.deliveries().is_empty(),
            "the app must never be asked to do the work an unpaid request didn't pay for"
        );

        // A node with no settlement backend keeps the pre-#617 greeting
        // shape exactly: no `settlement` key at all, not a null one. Issue
        // #632 adds `settlements` beside it on the same terms: absent, not
        // an empty array, on a settlement-less node.
        let extra = serde_json::to_value(&terms.accepts[0].extra).unwrap();
        assert!(
            extra.get("settlement").is_none(),
            "a settlement-less node's greeting must not carry a settlement key: {extra}"
        );
        assert!(
            extra.get("settlements").is_none(),
            "a settlement-less node's greeting must not carry a settlements key: {extra}"
        );
    }

    /// Issue #722: the x402 greeting advertises the session lease backstop
    /// TTL the client session registry actually enforces, so a TS (or any
    /// other language) client can honour freshness <= lease without
    /// duplicating a Rust `pub const`. This pins the advertised value
    /// directly to `SESSION_LEASE_BACKSTOP_TTL` -- changing the constant
    /// changes what is advertised, provably, because both sides of this
    /// assertion read the same const.
    #[tokio::test]
    async fn the_x402_greeting_advertises_the_session_lease_ttl() {
        let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 100).unwrap();
        let connector = Arc::new(Connector::new(
            vec![route],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let app = router(connector, test_signer());

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let terms: X402PaymentRequired = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            terms.accepts[0].extra.session_lease_ttl_ms,
            crate::session_registry::SESSION_LEASE_BACKSTOP_TTL.as_millis() as u64,
            "the advertised lease must be exactly what the session registry enforces"
        );
    }

    /// Issue #701 (toon-meta#262 decision 11): a route restricted to BTP
    /// refuses an HTTP request the same way an unpaid request is refused --
    /// terms instead of the app's work -- except here `extra` names which
    /// transport the route actually requires; the route's price is
    /// irrelevant to why this request was refused.
    #[tokio::test]
    async fn an_http_request_to_a_btp_only_route_is_answered_with_the_required_transport() {
        let route = StaticRoute::new_priced_with_transport(
            "g.example.relay",
            "http://localhost:4000",
            1000,
            TransportPolicy::Btp,
        )
        .unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        let connector = Arc::new(Connector::new(
            vec![route],
            vec![],
            app_client.clone(),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let app = router(connector, test_signer());

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(sample_prepare("g.example.relay").encode()))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let terms: X402PaymentRequired = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            terms.accepts[0].extra.required_transport.as_deref(),
            Some("btp"),
            "the client should learn this route requires BTP"
        );

        assert!(
            app_client.deliveries().is_empty(),
            "a request over the wrong transport must never reach the app"
        );
    }

    /// The mirror case: a route with no transport restriction (the default)
    /// is unaffected -- its unpaid-request greeting carries no
    /// `requiredTransport` at all, exactly the pre-#701 shape.
    #[tokio::test]
    async fn a_route_accepting_both_transports_never_carries_a_required_transport() {
        let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 100).unwrap();
        let connector = Arc::new(Connector::new(
            vec![route],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let app = router(connector, test_signer());

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let terms: X402PaymentRequired = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(terms.accepts[0].extra.required_transport, None);
        let extra = serde_json::to_value(&terms.accepts[0].extra).unwrap();
        assert!(
            extra.get("requiredTransport").is_none(),
            "an unrestricted route's greeting must not carry a requiredTransport key: {extra}"
        );
    }

    /// Issue #617: a node WITH a settlement backend answers the greeting
    /// with its channel-opening facts -- the counterparty address, chain,
    /// registry, resolved `TokenNetwork`, token and scale -- so an
    /// unaffiliated buyer can open a channel by ASKING (ADR 0022) instead
    /// of needing an announce this connector never makes.
    #[tokio::test]
    async fn an_unpaid_request_to_a_settling_node_is_answered_with_channel_opening_facts() {
        let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 100).unwrap();
        let connector = Arc::new(Connector::new(
            vec![route],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let terms = X402SettlementTerms {
            chain: "evm:84532".to_string(),
            settlement_address: "0xf29fd62c4848b9573c9b90adbf61b664f386d9cf".to_string(),
            token_network_registry: "0xcc9079ade929b168b54145f6d25262b64fab9d5b".to_string(),
            token_network: "0x1e95493fef46707e034b4a1945f25a8c76a1823d".to_string(),
            token_address: "0x49bee1bca5d15fb0963117923403f9498119a9ce".to_string(),
            decimals: 6,
        };
        let app = router_with_gate_and_terms(
            connector,
            test_signer(),
            None,
            test_gate(ClientChannelRegistry::new()),
            Some(terms.clone()),
            vec![X402ChainSettlementTerms::Evm(terms.clone())],
        );

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);
        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let answered: X402PaymentRequired = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            answered.accepts[0].extra.settlement.as_ref(),
            Some(&terms),
            "the greeting must carry the node's channel-opening facts verbatim"
        );

        // Issue #632: an EVM-only node's additive `settlements` list is a
        // one-entry list, its entry byte-identical to the legacy object.
        assert_eq!(
            answered.accepts[0].extra.settlements,
            vec![X402ChainSettlementTerms::Evm(terms)],
            "an EVM-only node's settlements list must carry exactly one entry, matching `settlement` verbatim"
        );
    }

    /// Issue #632: a node settling on two chains carries BOTH chains'
    /// channel-opening facts in `extra.settlements`, while the legacy
    /// `extra.settlement` object stays exactly what it was before this
    /// issue -- the EVM entry alone, unaffected by the Solana leg's
    /// presence. This is the demoable slice's acceptance criterion: "a node
    /// with both [settlement.evm] and [settlement.solana] greets with both
    /// chains' facts; an EVM-only node greets with the legacy object
    /// unchanged plus a one-entry list."
    #[tokio::test]
    async fn a_two_chain_node_greets_with_both_chains_facts_and_an_unchanged_legacy_object() {
        let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 100).unwrap();
        let connector = Arc::new(Connector::new(
            vec![route],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let evm_terms = X402SettlementTerms {
            chain: "evm:84532".to_string(),
            settlement_address: "0xf29fd62c4848b9573c9b90adbf61b664f386d9cf".to_string(),
            token_network_registry: "0xcc9079ade929b168b54145f6d25262b64fab9d5b".to_string(),
            token_network: "0x1e95493fef46707e034b4a1945f25a8c76a1823d".to_string(),
            token_address: "0x49bee1bca5d15fb0963117923403f9498119a9ce".to_string(),
            decimals: 6,
        };
        let solana_terms = X402SolanaSettlementTerms {
            chain: "solana".to_string(),
            settlement_address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin".to_string(),
            program_id: "2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip".to_string(),
            token_address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string(),
            decimals: 6,
        };
        let app = router_with_gate_and_terms(
            connector,
            test_signer(),
            None,
            test_gate(ClientChannelRegistry::new()),
            Some(evm_terms.clone()),
            vec![
                X402ChainSettlementTerms::Evm(evm_terms.clone()),
                X402ChainSettlementTerms::Solana(solana_terms.clone()),
            ],
        );

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);
        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let answered: X402PaymentRequired = serde_json::from_slice(&bytes).unwrap();

        assert_eq!(
            answered.accepts[0].extra.settlement.as_ref(),
            Some(&evm_terms),
            "the legacy settlement object stays the EVM leg alone, unchanged by the Solana leg"
        );
        assert_eq!(
            answered.accepts[0].extra.settlements,
            vec![
                X402ChainSettlementTerms::Evm(evm_terms),
                X402ChainSettlementTerms::Solana(solana_terms),
            ],
            "a two-chain node's settlements list carries both chains' facts"
        );
    }

    /// A claim header suppresses the greeting even to a priced route --
    /// §1.3's own validation (freshness, value, eventually signature) is
    /// what judges a paid request, not the unpaid-answer path.
    #[tokio::test]
    async fn a_present_claim_header_suppresses_the_greeting() {
        let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 100).unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(route.handler_url(), answered(b"ok"));
        let signer = test_signer();
        let connector = Arc::new(
            Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_identity_signer(signer.clone()),
        );
        let (prepare, _shared_secret) =
            sealed_sample_prepare("g.example.app", &signer.public_key().unwrap());
        let app = router_with_gate(
            connector,
            signer,
            None,
            test_gate(claim_headers::test_channels()),
        );

        // A genuinely signed claim: since issue #506/#544 the gate's last
        // stage verifies the signature, so a placeholder one would be
        // refused here for a signature-shaped reason and this test would
        // no longer be observing what it names -- that a *present* claim
        // sends the request down §1.3's validation path rather than the
        // unpaid-greeting one.
        let claim_json = claim_headers::evm_claim_json(1, 100);
        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .header(CLAIM_HEADER, BASE64.encode(claim_json.as_bytes()))
            .body(Body::from(prepare.encode()))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        Fulfill::decode(&bytes).expect("a validly paid claim still reaches the app");
        assert_eq!(app_client.deliveries().len(), 1);
    }

    /// An unpaid request to an explicitly free (`price == 0`) route is
    /// unaffected -- it still reaches the app exactly as it always has,
    /// since there is nothing to charge and so nothing to answer with
    /// terms instead of.
    #[tokio::test]
    async fn an_unpaid_request_to_a_free_route_still_reaches_the_app() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(route.handler_url(), answered(b"free work"));
        let signer = test_signer();
        let connector = Arc::new(
            Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_identity_signer(signer.clone()),
        );
        let (prepare, _shared_secret) =
            sealed_sample_prepare("g.example.app", &signer.public_key().unwrap());
        let app = router(connector, signer);

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(prepare.encode()))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        Fulfill::decode(&bytes).expect("decode fulfill");
        assert_eq!(app_client.deliveries().len(), 1);
    }

    /// End-to-end claim ingest (issue #504, #506/#544): a claim presented in
    /// `ILP-Payment-Channel-Claim`(`-Wrapped`) is parsed, structurally
    /// validated, checked for freshness/watermark and cryptographically
    /// verified before the packet is routed, exercised at this crate's real
    /// HTTP seam rather than against `ClientClaimGate` directly.
    mod claim_headers {
        use super::*;
        use libsecp256k1::{Message, PublicKey, SecretKey};

        const EVM_CHAIN_ID: u64 = 8453;
        const EVM_TOKEN_NETWORK_ADDRESS: [u8; 20] = [0x42; 20];

        /// The one channel every claim below is presented on, recorded with
        /// [`evm_signer`]'s address as its counterparty (issue #558) -- a
        /// claim signed by anyone else, or naming any other channel, is
        /// refused however well-formed it is.
        pub(super) fn test_channels() -> ClientChannelRegistry {
            let (_secret, counterparty) = evm_signer();
            let mut channels = ClientChannelRegistry::new();
            channels
                .record_evm(
                    &"ab".repeat(32),
                    EvmChannel {
                        counterparty,
                        chain_id: EVM_CHAIN_ID,
                        token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
                        // Declared, so exempt from the collateral cap
                        // (issue #646) exactly as config records are.
                        deposit_floor: crate::DepositFloor::Unknown,
                    },
                )
                .expect("a 32-byte hex channel id");
            channels
        }

        /// A fixed, deterministic EVM keypair every genuine claim below is
        /// signed with, so each test's own signature verifies.
        fn evm_signer() -> (SecretKey, connector_signer::Address) {
            let secret = SecretKey::parse(&[9u8; 32]).unwrap();
            let public = PublicKey::from_secret_key(&secret);
            (
                secret,
                connector_signer::derive_evm_address(&public.serialize()),
            )
        }

        /// Sign `digest` exactly the way a real EVM wallet would (a 65-byte
        /// `r || s || v` signature, `v` in the conventional `{27, 28}` range).
        fn sign_evm(secret: &SecretKey, digest: &[u8; 32]) -> Vec<u8> {
            let message = Message::parse(digest);
            let (signature, recovery_id) = libsecp256k1::sign(&message, secret);
            let mut bytes = signature.serialize().to_vec();
            let recovery_byte: u8 = recovery_id.into();
            bytes.push(recovery_byte + 27);
            bytes
        }

        /// An EVM claim JSON carrying whatever `signature` hex string is
        /// given verbatim, genuine or not.
        fn evm_claim_json_with_signature(
            nonce: u64,
            transferred_amount: u64,
            signature_hex: &str,
        ) -> String {
            let (_secret, address) = evm_signer();
            evm_claim_json_with_signature_and_signer(
                nonce,
                transferred_amount,
                signature_hex,
                &address,
            )
        }

        /// As [`evm_claim_json_with_signature`], but declaring whatever
        /// `signer_address` it is given -- what a forger does (issue #558):
        /// sign with a key of one's own and name oneself the payer.
        fn evm_claim_json_with_signature_and_signer(
            nonce: u64,
            transferred_amount: u64,
            signature_hex: &str,
            signer_address: &connector_signer::Address,
        ) -> String {
            let address = signer_address;
            format!(
                r#"{{
                    "version": "1.0",
                    "blockchain": "evm",
                    "messageId": "msg-{nonce}",
                    "timestamp": "2026-02-02T12:00:00.000Z",
                    "senderId": "peer-bob",
                    "channelId": "0x{channel}",
                    "nonce": {nonce},
                    "transferredAmount": "{transferred_amount}",
                    "lockedAmount": "0",
                    "locksRoot": "0x{zeros}",
                    "signature": "{signature_hex}",
                    "signerAddress": "{address}",
                    "chainId": {EVM_CHAIN_ID},
                    "tokenNetworkAddress": "{token_network_address}"
                }}"#,
                channel = "ab".repeat(32),
                zeros = "0".repeat(64),
                address = connector_signer::to_hex(address),
                token_network_address = connector_signer::to_hex(&EVM_TOKEN_NETWORK_ADDRESS),
            )
        }

        /// A claim over the recorded channel, genuinely and correctly
        /// signed -- by a key that is not that channel's counterparty, and
        /// declaring itself the payer. The forger of issue #558.
        fn forged_evm_claim_json(nonce: u64, transferred_amount: u64) -> String {
            let secret = SecretKey::parse(&[0x5a; 32]).unwrap();
            let address = connector_signer::derive_evm_address(
                &PublicKey::from_secret_key(&secret).serialize(),
            );
            let channel = "ab".repeat(32);
            let mut channel_id = [0u8; 32];
            channel_id.copy_from_slice(&hex::decode(&channel).unwrap());
            let proof = connector_signer::EvmBalanceProof {
                channel_id,
                nonce,
                transferred_amount: u128::from(transferred_amount),
                locked_amount: 0,
                locks_root: [0u8; 32],
                chain_id: EVM_CHAIN_ID,
                token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
            };
            let signature = sign_evm(&secret, &connector_signer::evm_balance_proof_digest(&proof));
            evm_claim_json_with_signature_and_signer(
                nonce,
                transferred_amount,
                &format!("0x{}", hex_encode(&signature)),
                &address,
            )
        }

        /// An EVM claim JSON with a genuine EIP-712 signature over its own
        /// fields (issue #506/#544) -- every test using this helper
        /// exercises the real verification path, not a bypass.
        pub(super) fn evm_claim_json(nonce: u64, transferred_amount: u64) -> String {
            let channel = "ab".repeat(32);
            let mut channel_id = [0u8; 32];
            channel_id.copy_from_slice(&hex::decode(&channel).unwrap());
            let (secret, _address) = evm_signer();
            let proof = connector_signer::EvmBalanceProof {
                channel_id,
                nonce,
                transferred_amount: u128::from(transferred_amount),
                locked_amount: 0,
                locks_root: [0u8; 32],
                chain_id: EVM_CHAIN_ID,
                token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
            };
            let signature = sign_evm(&secret, &connector_signer::evm_balance_proof_digest(&proof));
            evm_claim_json_with_signature(
                nonce,
                transferred_amount,
                &format!("0x{}", hex_encode(&signature)),
            )
        }

        fn mina_claim_json() -> &'static str {
            r#"{
                "version": "1.0",
                "blockchain": "mina",
                "messageId": "claim-1",
                "timestamp": "2026-02-02T12:00:00.000Z",
                "senderId": "peer-dave",
                "zkAppAddress": "irrelevant",
                "tokenId": "1",
                "balanceCommitment": "abc",
                "nonce": 1,
                "proof": "AAAA",
                "salt": "salt"
            }"#
        }

        pub(super) fn request_with_claim_header(
            prepare: &Prepare,
            header_name: &str,
            claim_json: &str,
        ) -> Request<Body> {
            let encoded = BASE64.encode(claim_json.as_bytes());
            Request::builder()
                .method("POST")
                .uri("/ilp")
                .header(header_name, encoded)
                .body(Body::from(prepare.encode()))
                .unwrap()
        }

        #[tokio::test]
        async fn a_fresh_plaintext_claim_lets_the_packet_reach_the_app() {
            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"ok"));
            let signer = test_signer();
            let connector = Arc::new(
                Connector::new(
                    vec![route],
                    vec![],
                    app_client.clone(),
                    Arc::new(InProcessPeerTransport::new()),
                    test_clock(),
                )
                .with_identity_signer(signer.clone()),
            );
            let (prepare, _shared_secret) =
                sealed_sample_prepare("g.example.app", &signer.public_key().unwrap());
            let app = router_with_gate(connector, signer, None, test_gate(test_channels()));

            let request =
                request_with_claim_header(&prepare, CLAIM_HEADER, &evm_claim_json(1, 100));
            let response = app.oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            Fulfill::decode(&bytes).expect("decode fulfill");
            assert_eq!(app_client.deliveries().len(), 1);
        }

        #[tokio::test]
        async fn a_replayed_claim_nonce_rejects_before_reaching_the_app() {
            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"ok"));
            let signer = test_signer();
            let connector = Arc::new(
                Connector::new(
                    vec![route],
                    vec![],
                    app_client.clone(),
                    Arc::new(InProcessPeerTransport::new()),
                    test_clock(),
                )
                .with_identity_signer(signer.clone()),
            );
            let app = router_with_gate(connector, signer.clone(), None, test_gate(test_channels()));

            let (first_prepare, _shared_secret) =
                sealed_sample_prepare("g.example.app", &signer.public_key().unwrap());
            let first =
                request_with_claim_header(&first_prepare, CLAIM_HEADER, &evm_claim_json(5, 500));
            let response = app.clone().oneshot(first).await.unwrap();
            Fulfill::decode(&hyper::body::to_bytes(response.into_body()).await.unwrap())
                .expect("first claim accepted");

            // The replay is rejected on the claim nonce alone, before the
            // envelope would ever need to open -- plaintext is fine here.
            let replay = request_with_claim_header(
                &sample_prepare("g.example.app"),
                CLAIM_HEADER,
                &evm_claim_json(5, 999),
            );
            let response = app.oneshot(replay).await.unwrap();
            // An ILP-level outcome, even a reject, is always HTTP 200.
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let reject = Reject::decode(&bytes).expect("decode reject");
            assert_eq!(reject.code.as_str(), "F01");

            // The replay never reached the app: still exactly one delivery.
            assert_eq!(app_client.deliveries().len(), 1);
        }

        #[tokio::test]
        async fn a_malformed_claim_header_rejects_with_f01_before_reaching_the_app() {
            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"ok"));
            let connector = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            let app = router_with_gate(connector, test_signer(), None, test_gate(test_channels()));

            let request = request_with_claim_header(
                &sample_prepare("g.example.app"),
                CLAIM_HEADER,
                r#"{"version":"1.0","blockchain":"evm"}"#,
            );
            let response = app.oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let reject = Reject::decode(&bytes).expect("decode reject");
            assert_eq!(reject.code.as_str(), "F01");
            assert!(reject.message.contains("structurally invalid"));
            assert!(app_client.deliveries().is_empty());
        }

        #[tokio::test]
        async fn a_mina_claim_is_rejected_with_a_reason_distinguishable_from_malformed() {
            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            let connector = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            let app = router_with_gate(connector, test_signer(), None, test_gate(test_channels()));

            let request = request_with_claim_header(
                &sample_prepare("g.example.app"),
                CLAIM_HEADER,
                mina_claim_json(),
            );
            let response = app.oneshot(request).await.unwrap();
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let reject = Reject::decode(&bytes).expect("decode reject");
            assert_eq!(reject.code.as_str(), "F01");
            assert!(reject.message.contains("ADR 0002"));
            assert!(!reject.message.contains("structurally invalid"));
            assert!(app_client.deliveries().is_empty());
        }

        #[tokio::test]
        async fn a_wrapped_claim_is_unwrapped_and_lets_the_packet_reach_the_app() {
            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"ok"));
            let identity_signer = test_signer();
            let connector = Arc::new(
                Connector::new(
                    vec![route],
                    vec![],
                    app_client.clone(),
                    Arc::new(InProcessPeerTransport::new()),
                    test_clock(),
                )
                .with_identity_signer(identity_signer.clone()),
            );

            // The claim's own NIP-59 wrap/unwrap key -- unrelated to the
            // connector's gift-wrap identity above (ADR 0018): this pair
            // protects the *claim header's* privacy (issue #504's §1.3),
            // not the packet payload.
            let sender_secret = SecretKey::parse(&[1u8; 32]).unwrap();
            let receiver_secret_bytes = [2u8; 32];
            let receiver_secret = SecretKey::parse(&receiver_secret_bytes).unwrap();
            let receiver_public = PublicKey::from_secret_key(&receiver_secret);

            let claim_json = evm_claim_json(1, 100);
            let wrapped = connector_signer::wrap_claim(
                claim_json.as_bytes(),
                &sender_secret,
                &receiver_public.serialize(),
            )
            .expect("wrap");
            let envelope_json = format!(
                r#"{{"ephemeralPublicKey":"{}","encryptedPayload":"{}","timestamp":0,"version":"1.0"}}"#,
                hex_encode(&wrapped.ephemeral_public_key),
                BASE64.encode(&wrapped.encrypted_payload),
            );

            let (prepare, _shared_secret) =
                sealed_sample_prepare("g.example.app", &identity_signer.public_key().unwrap());
            let app = router_with_gate(
                connector,
                identity_signer,
                Some(receiver_secret_bytes),
                test_gate(test_channels()),
            );
            let request = request_with_claim_header(&prepare, CLAIM_WRAPPED_HEADER, &envelope_json);
            let response = app.oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            Fulfill::decode(&bytes).expect("decode fulfill");
            assert_eq!(app_client.deliveries().len(), 1);
        }

        #[tokio::test]
        async fn a_wrapped_claim_with_no_configured_receiver_key_is_refused() {
            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            let connector = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            // `router`, not `router_with_wrap_key`: no receiver key configured.
            let app = router(connector, test_signer());

            let envelope_json = r#"{"ephemeralPublicKey":"04","encryptedPayload":"AAAA","timestamp":0,"version":"1.0"}"#;
            let request = request_with_claim_header(
                &sample_prepare("g.example.app"),
                CLAIM_WRAPPED_HEADER,
                envelope_json,
            );
            let response = app.oneshot(request).await.unwrap();
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let reject = Reject::decode(&bytes).expect("decode reject");
            assert_eq!(reject.code.as_str(), "F01");
            assert!(reject.message.contains("not configured to unwrap"));
            assert!(app_client.deliveries().is_empty());
        }

        /// A claim advancing by at least a priced route's price is
        /// accepted and the packet is delivered (issue #522).
        #[tokio::test]
        async fn a_claim_covering_the_routes_price_is_accepted_and_delivered() {
            let route =
                StaticRoute::new_priced("g.example.app", "http://localhost:4000", 100).unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"ok"));
            let signer = test_signer();
            let connector = Arc::new(
                Connector::new(
                    vec![route],
                    vec![],
                    app_client.clone(),
                    Arc::new(InProcessPeerTransport::new()),
                    test_clock(),
                )
                .with_identity_signer(signer.clone()),
            );
            let (prepare, _shared_secret) =
                sealed_sample_prepare("g.example.app", &signer.public_key().unwrap());
            let app = router_with_gate(connector, signer, None, test_gate(test_channels()));

            let request =
                request_with_claim_header(&prepare, CLAIM_HEADER, &evm_claim_json(1, 100));
            let response = app.oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            Fulfill::decode(&bytes).expect("decode fulfill");
            assert_eq!(app_client.deliveries().len(), 1);
        }

        /// Issue #701: transport policy is checked before payment is
        /// considered at all -- a fully valid, correctly-priced claim over
        /// HTTP does not make a BTP-only route reachable that way. The
        /// request is refused with the same self-diagnosing terms an
        /// unpaid request gets, and the app is never asked to do the work.
        #[tokio::test]
        async fn a_valid_claim_to_a_btp_only_route_is_still_refused_with_wrong_transport_terms() {
            let route = StaticRoute::new_priced_with_transport(
                "g.example.relay",
                "http://localhost:4000",
                100,
                TransportPolicy::Btp,
            )
            .unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"ok"));
            let signer = test_signer();
            let connector = Arc::new(
                Connector::new(
                    vec![route],
                    vec![],
                    app_client.clone(),
                    Arc::new(InProcessPeerTransport::new()),
                    test_clock(),
                )
                .with_identity_signer(signer.clone()),
            );
            let (prepare, _shared_secret) =
                sealed_sample_prepare("g.example.relay", &signer.public_key().unwrap());
            let app = router_with_gate(connector, signer, None, test_gate(test_channels()));

            let request =
                request_with_claim_header(&prepare, CLAIM_HEADER, &evm_claim_json(1, 100));
            let response = app.oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);

            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let terms: X402PaymentRequired = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                terms.accepts[0].extra.required_transport.as_deref(),
                Some("btp")
            );

            assert!(
                app_client.deliveries().is_empty(),
                "a valid claim over the wrong transport must never reach the app"
            );
        }

        /// A claim advancing by less than a priced route's price is
        /// refused as underpayment (F03), distinguishably from a stale,
        /// malformed or unverifiable claim (all F01), and never reaches
        /// the app (issue #522).
        #[tokio::test]
        async fn a_claim_underpaying_the_routes_price_is_refused_as_underpayment() {
            let route =
                StaticRoute::new_priced("g.example.app", "http://localhost:4000", 100).unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"ok"));
            let connector = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            let app = router_with_gate(connector, test_signer(), None, test_gate(test_channels()));

            let request = request_with_claim_header(
                &sample_prepare("g.example.app"),
                CLAIM_HEADER,
                &evm_claim_json(1, 99),
            );
            let response = app.oneshot(request).await.unwrap();
            // An ILP-level outcome, even a reject, is always HTTP 200.
            assert_eq!(response.status(), StatusCode::OK);

            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let reject = Reject::decode(&bytes).expect("decode reject");
            assert_eq!(reject.code.as_str(), "F03");
            assert_ne!(reject.code.as_str(), "F01");
            assert!(app_client.deliveries().is_empty());
        }

        /// A claim's value is checked before this ingress would ever spend
        /// cryptographic work verifying its signature -- proven here by a
        /// claim whose signature is garbage, yet still refused for
        /// underpayment (F03) rather than as an unverifiable signature
        /// (which would also be F01, indistinguishable from this by code
        /// alone), since the value check runs unconditionally before
        /// verification is ever attempted (issue #522, #506/#544).
        #[tokio::test]
        async fn the_value_check_runs_before_any_cryptographic_work() {
            let route =
                StaticRoute::new_priced("g.example.app", "http://localhost:4000", 100).unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            let connector = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            let app = router_with_gate(connector, test_signer(), None, test_gate(test_channels()));

            let garbage_signature_claim =
                evm_claim_json_with_signature(1, 50, "0xnotarealsignatureatall");
            let request = request_with_claim_header(
                &sample_prepare("g.example.app"),
                CLAIM_HEADER,
                &garbage_signature_claim,
            );
            let response = app.oneshot(request).await.unwrap();
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let reject = Reject::decode(&bytes).expect("decode reject");
            assert_eq!(reject.code.as_str(), "F03");
            assert!(app_client.deliveries().is_empty());
        }

        /// A claim whose value binding passes but whose signature does not
        /// verify is refused before the packet reaches the app -- the
        /// gate's actual last stage (issue #506/#544).
        #[tokio::test]
        async fn a_claim_failing_signature_verification_never_reaches_the_app() {
            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            let connector = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            let app = router_with_gate(connector, test_signer(), None, test_gate(test_channels()));

            let unverifiable_claim = evm_claim_json_with_signature(1, 100, "0xabcd");
            let request = request_with_claim_header(
                &sample_prepare("g.example.app"),
                CLAIM_HEADER,
                &unverifiable_claim,
            );
            let response = app.oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let reject = Reject::decode(&bytes).expect("decode reject");
            assert_eq!(reject.code.as_str(), "F01");
            assert!(reject.message.contains("signature"));
            assert!(app_client.deliveries().is_empty());
        }

        /// The forger of issue #558, at this crate's real HTTP seam: a
        /// claim signed perfectly well with a key of the sender's own, over
        /// a channel this connector *does* have a record of, declaring that
        /// key as its signer. It never reaches the app, because the key is
        /// not the channel's counterparty.
        #[tokio::test]
        async fn a_claim_signed_by_a_key_that_is_not_the_channels_counterparty_never_reaches_the_app(
        ) {
            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"ok"));
            let connector = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            let app = router_with_gate(connector, test_signer(), None, test_gate(test_channels()));

            let request = request_with_claim_header(
                &sample_prepare("g.example.app"),
                CLAIM_HEADER,
                &forged_evm_claim_json(1, 100),
            );
            let response = app.oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let reject = Reject::decode(&bytes).expect("decode reject");
            assert_eq!(reject.code.as_str(), "F01");
            assert!(
                reject.message.contains("counterparty"),
                "the refusal names why it was refused: {}",
                reject.message
            );
            assert!(
                app_client.deliveries().is_empty(),
                "a forger must never buy the app's work"
            );
        }

        /// A claim naming a channel this connector has no record of is
        /// refused with its own reason, distinguishable from a bad
        /// signature -- and, since the registry is what says which channels
        /// exist, an edge mounted with no channels at all accepts nothing
        /// (issue #558's AC2 and AC8).
        #[tokio::test]
        async fn a_claim_on_an_unrecorded_channel_never_reaches_the_app() {
            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"ok"));
            let connector = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            // `router`, not `router_with_gate`: no channel recorded.
            let app = router(connector, test_signer());

            let request = request_with_claim_header(
                &sample_prepare("g.example.app"),
                CLAIM_HEADER,
                &evm_claim_json(1, 100),
            );
            let response = app.oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let reject = Reject::decode(&bytes).expect("decode reject");
            assert_eq!(reject.code.as_str(), "F01");
            assert!(
                reject.message.contains("no record of"),
                "an unknown channel is refused for being unknown, not for a bad signature: {}",
                reject.message
            );
            assert!(app_client.deliveries().is_empty());
        }

        /// Issues #556/#502, at the real HTTP seam: a buyer this operator
        /// has never heard of -- no `[[client_channels]]` entry, nothing
        /// declared for their channel at all -- pays and the write lands,
        /// because the connector resolves the channel's counterparty from
        /// the chain the channel was opened on.
        ///
        /// This is the test that fails on `origin/main`: there, the only
        /// possible record is a declared one, so this exact request is
        /// refused F01 "no record of" and the app is never asked to work.
        #[tokio::test]
        async fn a_claim_on_a_channel_only_the_chain_knows_about_reaches_the_app() {
            let route =
                StaticRoute::new_priced("g.example.app", "http://localhost:4000", 100).unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"ok"));
            let signer = test_signer();
            let connector = Arc::new(
                Connector::new(
                    vec![route],
                    vec![],
                    app_client.clone(),
                    Arc::new(InProcessPeerTransport::new()),
                    test_clock(),
                )
                .with_identity_signer(signer.clone()),
            );

            // Nothing declared. The source stands in for
            // `TokenNetwork.channels(id)`, which is what names the buyer
            // as this channel's counterparty.
            let (_secret, counterparty) = evm_signer();
            let mut channel_id = [0u8; 32];
            channel_id.copy_from_slice(&hex::decode("ab".repeat(32)).unwrap());
            let channels = ClientChannelRegistry::new().with_source(Arc::new(
                crate::channels::test_source::FakeChannelSource::knowing(vec![(
                    channel_id,
                    EvmChannel {
                        counterparty,
                        chain_id: EVM_CHAIN_ID,
                        token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
                        deposit_floor: crate::DepositFloor::AtLeast(1_000_000),
                    },
                )]),
            ));
            assert!(
                !channels.is_empty(),
                "a registry with a source can vouch for channels nobody wrote down"
            );

            let (prepare, _shared_secret) =
                sealed_sample_prepare("g.example.app", &signer.public_key().unwrap());
            let app = router_with_gate(connector, signer, None, test_gate(channels));
            let request =
                request_with_claim_header(&prepare, CLAIM_HEADER, &evm_claim_json(1, 100));
            let response = app.oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            Fulfill::decode(&bytes).expect(
                "an unaffiliated buyer's on-chain channel is payable without a config edit",
            );
            assert_eq!(app_client.deliveries().len(), 1);
        }

        /// A lookup this connector could not complete refuses the claim --
        /// it never degrades to believing what the claim says about its
        /// own signer -- and says which failure it was, so an operator can
        /// tell a broken RPC endpoint from a sender guessing channel ids.
        #[tokio::test]
        async fn a_claim_whose_channel_lookup_fails_never_reaches_the_app() {
            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"ok"));
            let connector = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            let channels = ClientChannelRegistry::new().with_source(Arc::new(
                crate::channels::test_source::FakeChannelSource::unreachable("connection refused"),
            ));
            let app = router_with_gate(connector, test_signer(), None, test_gate(channels));

            let request = request_with_claim_header(
                &sample_prepare("g.example.app"),
                CLAIM_HEADER,
                &evm_claim_json(1, 100),
            );
            let response = app.oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let reject = Reject::decode(&bytes).expect("decode reject");
            // T00, not F01 (issue #613's review): a failed lookup is this
            // connector's problem and not the claim's, so it must come back
            // as a *temporary* error. Told F01 a sender concludes its
            // perfectly good claim is invalid and stops, because a third
            // party's RPC endpoint blipped.
            assert_eq!(reject.code.as_str(), "T00");
            assert!(
                reject.message.contains("could not look up"),
                "an unreachable chain is reported as such, not as an unknown channel: {}",
                reject.message
            );
            assert!(app_client.deliveries().is_empty());
        }

        /// Issue #630's demoable slice, proven at this crate's own real
        /// HTTP seam -- the same one
        /// `a_fresh_plaintext_claim_lets_the_packet_reach_the_app` proves
        /// for EVM, above: a Solana channel declared only in
        /// [`ClientChannelRegistry`] (the `[[client_channels]]`-equivalent
        /// -- no chain resolution, no settlement backend, matching
        /// `ClientChannelRegistry::solana`'s own "declared records only"
        /// doc), a genuinely Ed25519-signed claim over it, verified,
        /// journaled and forwarded to the app.
        #[tokio::test]
        async fn a_declared_solana_client_channel_claim_reaches_the_app() {
            use base64::engine::general_purpose::STANDARD as BASE64;
            use base64::Engine;
            use ed25519_dalek::{Keypair as SolanaKeypair, Signer as Ed25519Signer};
            use rand::rngs::OsRng;

            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"ok"));
            let signer = test_signer();
            let connector = Arc::new(
                Connector::new(
                    vec![route],
                    vec![],
                    app_client.clone(),
                    Arc::new(InProcessPeerTransport::new()),
                    test_clock(),
                )
                .with_identity_signer(signer.clone()),
            );

            // The channel's counterparty must be a real Ed25519 identity
            // able to sign a genuine balance proof (issue #558) -- generated
            // here rather than a placeholder, since the claim below signs
            // with it for real.
            let counterparty_keypair = SolanaKeypair::generate(&mut OsRng);
            let channel_account = [0x42u8; 32];
            let channel_account_base58 = bs58::encode(channel_account).into_string();
            let counterparty_base58 =
                bs58::encode(counterparty_keypair.public.to_bytes()).into_string();

            // Declared, not resolved from chain: `[[client_channels]]`'s
            // own registration path (issue #630). The chain-resolved twin
            // of this test, for a channel nothing declared, is issue
            // #631's `a_solana_claim_on_a_channel_only_the_chain_knows_about_reaches_the_app`
            // below.
            let mut channels = ClientChannelRegistry::new();
            channels
                .record_solana(&channel_account_base58, &counterparty_base58)
                .expect("valid base58 32-byte accounts");

            let nonce = 1u64;
            let transferred_amount = 100u64;
            let message = connector_signer::solana_balance_proof_message(
                &channel_account,
                nonce,
                transferred_amount,
            );
            let signature = counterparty_keypair.sign(&message);
            let signature_base64 = BASE64.encode(signature.to_bytes());

            let claim_json = format!(
                r#"{{
                    "version": "1.0",
                    "blockchain": "solana",
                    "messageId": "msg-1",
                    "timestamp": "2026-02-02T12:00:00.000Z",
                    "senderId": "peer-bob",
                    "programId": "{counterparty_base58}",
                    "channelAccount": "{channel_account_base58}",
                    "nonce": {nonce},
                    "transferredAmount": "{transferred_amount}",
                    "signature": "{signature_base64}",
                    "signerPublicKey": "{counterparty_base58}"
                }}"#,
            );

            let (prepare, _shared_secret) =
                sealed_sample_prepare("g.example.app", &signer.public_key().unwrap());
            let app = router_with_gate(connector, signer, None, test_gate(channels));

            let request = request_with_claim_header(&prepare, CLAIM_HEADER, &claim_json);
            let response = app.oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            Fulfill::decode(&bytes).expect("decode fulfill");
            assert_eq!(app_client.deliveries().len(), 1);
        }

        /// The forger of issue #558, Solana-flavored: a claim genuinely
        /// signed, but by a key that is not the declared channel's
        /// counterparty, and declaring itself the payer anyway. Must be
        /// refused exactly as the equivalent EVM forgery is -- the claim's
        /// own `signerPublicKey` is never trusted, only the registry's
        /// declared counterparty is checked against.
        #[tokio::test]
        async fn a_solana_claim_forged_by_a_non_counterparty_key_is_refused() {
            use base64::engine::general_purpose::STANDARD as BASE64;
            use base64::Engine;
            use ed25519_dalek::{Keypair as SolanaKeypair, Signer as Ed25519Signer};
            use rand::rngs::OsRng;

            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"ok"));
            let signer = test_signer();
            let connector = Arc::new(
                Connector::new(
                    vec![route],
                    vec![],
                    app_client.clone(),
                    Arc::new(InProcessPeerTransport::new()),
                    test_clock(),
                )
                .with_identity_signer(signer.clone()),
            );

            let real_counterparty = SolanaKeypair::generate(&mut OsRng);
            let forger = SolanaKeypair::generate(&mut OsRng);
            let channel_account = [0x43u8; 32];
            let channel_account_base58 = bs58::encode(channel_account).into_string();
            let real_counterparty_base58 =
                bs58::encode(real_counterparty.public.to_bytes()).into_string();
            let forger_base58 = bs58::encode(forger.public.to_bytes()).into_string();

            let mut channels = ClientChannelRegistry::new();
            channels
                .record_solana(&channel_account_base58, &real_counterparty_base58)
                .expect("valid base58 32-byte accounts");

            let nonce = 1u64;
            let transferred_amount = 100u64;
            let message = connector_signer::solana_balance_proof_message(
                &channel_account,
                nonce,
                transferred_amount,
            );
            // Signed genuinely -- just by the wrong key.
            let signature = forger.sign(&message);
            let signature_base64 = BASE64.encode(signature.to_bytes());

            let claim_json = format!(
                r#"{{
                    "version": "1.0",
                    "blockchain": "solana",
                    "messageId": "msg-1",
                    "timestamp": "2026-02-02T12:00:00.000Z",
                    "senderId": "peer-bob",
                    "programId": "{forger_base58}",
                    "channelAccount": "{channel_account_base58}",
                    "nonce": {nonce},
                    "transferredAmount": "{transferred_amount}",
                    "signature": "{signature_base64}",
                    "signerPublicKey": "{forger_base58}"
                }}"#,
            );

            let (prepare, _shared_secret) =
                sealed_sample_prepare("g.example.app", &signer.public_key().unwrap());
            let app = router_with_gate(connector, signer, None, test_gate(channels));

            let request = request_with_claim_header(&prepare, CLAIM_HEADER, &claim_json);
            let response = app.oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let reject = Reject::decode(&bytes).expect("decode reject");
            assert_eq!(reject.code.as_str(), "F01");
            assert!(app_client.deliveries().is_empty());
        }

        /// Issue #631, the Solana twin of
        /// `a_claim_on_a_channel_only_the_chain_knows_about_reaches_the_app`
        /// above: a buyer this operator has never heard of -- no
        /// `[[client_channels]]` entry, nothing declared for their channel
        /// at all -- pays and the write lands, because the connector
        /// resolves the channel's counterparty from the deployed Solana
        /// payment-channel program the channel was opened on.
        #[tokio::test]
        async fn a_solana_claim_on_a_channel_only_the_chain_knows_about_reaches_the_app() {
            use base64::engine::general_purpose::STANDARD as BASE64;
            use base64::Engine;
            use ed25519_dalek::{Keypair as SolanaKeypair, Signer as Ed25519Signer};
            use rand::rngs::OsRng;

            let route =
                StaticRoute::new_priced("g.example.app", "http://localhost:4000", 100).unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"ok"));
            let signer = test_signer();
            let connector = Arc::new(
                Connector::new(
                    vec![route],
                    vec![],
                    app_client.clone(),
                    Arc::new(InProcessPeerTransport::new()),
                    test_clock(),
                )
                .with_identity_signer(signer.clone()),
            );

            // Nothing declared. The source stands in for
            // `SolanaSettlementBackend::channel_counterparty`, which is
            // what names the buyer as this channel's counterparty.
            let counterparty_keypair = SolanaKeypair::generate(&mut OsRng);
            let channel_account = [0x44u8; 32];
            let channel_account_base58 = bs58::encode(channel_account).into_string();
            let counterparty_base58 =
                bs58::encode(counterparty_keypair.public.to_bytes()).into_string();

            let channels = ClientChannelRegistry::new().with_solana_source(Arc::new(
                crate::channels::test_source::FakeSolanaChannelSource::knowing(vec![(
                    channel_account,
                    crate::SolanaChannel {
                        counterparty: counterparty_keypair.public.to_bytes(),
                        deposit_floor: crate::DepositFloor::AtLeast(1_000_000),
                    },
                )]),
            ));
            assert!(
                !channels.is_empty(),
                "a registry with a source can vouch for channels nobody wrote down"
            );

            let nonce = 1u64;
            let transferred_amount = 100u64;
            let message = connector_signer::solana_balance_proof_message(
                &channel_account,
                nonce,
                transferred_amount,
            );
            let signature = counterparty_keypair.sign(&message);
            let signature_base64 = BASE64.encode(signature.to_bytes());

            let claim_json = format!(
                r#"{{
                    "version": "1.0",
                    "blockchain": "solana",
                    "messageId": "msg-1",
                    "timestamp": "2026-02-02T12:00:00.000Z",
                    "senderId": "peer-bob",
                    "programId": "{counterparty_base58}",
                    "channelAccount": "{channel_account_base58}",
                    "nonce": {nonce},
                    "transferredAmount": "{transferred_amount}",
                    "signature": "{signature_base64}",
                    "signerPublicKey": "{counterparty_base58}"
                }}"#,
            );

            let (prepare, _shared_secret) =
                sealed_sample_prepare("g.example.app", &signer.public_key().unwrap());
            let app = router_with_gate(connector, signer, None, test_gate(channels));

            let request = request_with_claim_header(&prepare, CLAIM_HEADER, &claim_json);
            let response = app.oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            Fulfill::decode(&bytes).expect(
                "an unaffiliated Solana buyer's on-chain channel is payable without a config edit",
            );
            assert_eq!(app_client.deliveries().len(), 1);
        }

        /// The Solana twin of `a_claim_whose_channel_lookup_fails_never_reaches_the_app`:
        /// a lookup this connector could not complete refuses the claim
        /// rather than believing what it says about its own signer.
        #[tokio::test]
        async fn a_solana_claim_whose_channel_lookup_fails_never_reaches_the_app() {
            use base64::engine::general_purpose::STANDARD as BASE64;
            use base64::Engine;
            use ed25519_dalek::{Keypair as SolanaKeypair, Signer as Ed25519Signer};
            use rand::rngs::OsRng;

            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"ok"));
            let signer = test_signer();
            let connector = Arc::new(
                Connector::new(
                    vec![route],
                    vec![],
                    app_client.clone(),
                    Arc::new(InProcessPeerTransport::new()),
                    test_clock(),
                )
                .with_identity_signer(signer.clone()),
            );
            let channels = ClientChannelRegistry::new().with_solana_source(Arc::new(
                crate::channels::test_source::FakeSolanaChannelSource::unreachable(
                    "connection refused",
                ),
            ));
            let app = router_with_gate(connector, signer.clone(), None, test_gate(channels));

            let keypair = SolanaKeypair::generate(&mut OsRng);
            let channel_account = [0x45u8; 32];
            let channel_account_base58 = bs58::encode(channel_account).into_string();
            let signer_base58 = bs58::encode(keypair.public.to_bytes()).into_string();
            let message = connector_signer::solana_balance_proof_message(&channel_account, 1, 100);
            let signature_base64 = BASE64.encode(keypair.sign(&message).to_bytes());

            let claim_json = format!(
                r#"{{
                    "version": "1.0",
                    "blockchain": "solana",
                    "messageId": "msg-1",
                    "timestamp": "2026-02-02T12:00:00.000Z",
                    "senderId": "peer-bob",
                    "programId": "{signer_base58}",
                    "channelAccount": "{channel_account_base58}",
                    "nonce": 1,
                    "transferredAmount": "100",
                    "signature": "{signature_base64}",
                    "signerPublicKey": "{signer_base58}"
                }}"#,
            );

            let (prepare, _shared_secret) =
                sealed_sample_prepare("g.example.app", &signer.public_key().unwrap());
            let request = request_with_claim_header(&prepare, CLAIM_HEADER, &claim_json);
            let response = app.oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let reject = Reject::decode(&bytes).expect("decode reject");
            // T00, not F01 (issue #613's review): a failed lookup is this
            // connector's problem and not the claim's, so it must come back
            // as a *temporary* error. Told F01 a sender concludes its
            // perfectly good claim is invalid and stops, because a third
            // party's RPC endpoint blipped.
            assert_eq!(reject.code.as_str(), "T00");
            assert!(
                reject.message.contains("could not look up"),
                "an unreachable chain is reported as such, not as an unknown channel: {}",
                reject.message
            );
            assert!(app_client.deliveries().is_empty());
        }
    }

    /// Cost discovery at the client edge (issue #548,
    /// `client-edge-spec.md` §1.6, ADR 0011): the running cost total a
    /// REJECT reports, and `POST /ilp/probe`, the ingress a sender uses to
    /// raise one deliberately. `tests/accumulated_cost_header.rs` covers
    /// the header on a path with no claim in it at all; these cover the
    /// cases that need a real claim, and so need `claim_headers`'s signer.
    mod cost_discovery {
        use super::claim_headers::{evm_claim_json, request_with_claim_header, test_channels};
        use super::*;

        const PRICE: u64 = 100;

        fn cost_header(response: &Response) -> Option<u64> {
            response
                .headers()
                .get(ACCUMULATED_COST_HEADER)
                .map(|value| value.to_str().unwrap().parse::<u64>().unwrap())
        }

        fn probe_request(prepare: &Prepare, claim_json: Option<&str>) -> Request<Body> {
            let builder = Request::builder().method("POST").uri("/ilp/probe");
            let builder = match claim_json {
                Some(claim_json) => {
                    builder.header(CLAIM_HEADER, BASE64.encode(claim_json.as_bytes()))
                }
                None => builder,
            };
            builder
                .body(Body::from(prepare.encode()))
                .expect("well-formed probe request")
        }

        /// A router over one priced, terminating route whose app answers,
        /// plus the app client so a test can assert whether the app was
        /// ever asked to do anything.
        fn priced_route_router() -> (Router, Arc<FakeAppClient>, Arc<dyn Signer>) {
            let route =
                StaticRoute::new_priced("g.example.app", "http://localhost:4000", PRICE).unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"ok"));
            let signer = test_signer();
            let connector = Arc::new(
                Connector::new(
                    vec![route],
                    vec![],
                    app_client.clone(),
                    Arc::new(InProcessPeerTransport::new()),
                    test_clock(),
                )
                .with_identity_signer(signer.clone()),
            );
            // Since #558 a claim verifies against the counterparty this
            // connector records for the channel it names, so a router with
            // no channels recorded refuses every claim -- including the
            // paid write these tests set themselves up with. The recorded
            // channel is `claim_headers`' own, the one `evm_claim_json`
            // signs against.
            (
                router_with_gate(connector, signer.clone(), None, test_gate(test_channels())),
                app_client,
                signer,
            )
        }

        /// Before #548 a route's price was disclosed only inside an
        /// underpayment reject's human-readable `message` -- so a client
        /// learned a price by underpaying first, which is exactly what cost
        /// discovery exists to prevent. The figure now rides the header a
        /// client already reads for every other reject.
        #[tokio::test]
        async fn an_underpaying_claim_reports_the_routes_price_in_the_header() {
            let (app, app_client, _signer) = priced_route_router();

            let request = request_with_claim_header(
                &sample_prepare("g.example.app"),
                CLAIM_HEADER,
                &evm_claim_json(1, PRICE - 1),
            );
            let response = app.oneshot(request).await.unwrap();

            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(cost_header(&response), Some(PRICE));
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            assert_eq!(Reject::decode(&bytes).unwrap().code.as_str(), "F03");
            assert!(app_client.deliveries().is_empty());
        }

        /// Every other claim refusal is decided before any route price is
        /// in play: nothing was traversed and nothing terminated, so the
        /// figure is `0` -- present, and honestly zero.
        #[tokio::test]
        async fn a_malformed_claim_reports_zero_rather_than_the_routes_price() {
            let (app, _app_client, _signer) = priced_route_router();

            let request =
                request_with_claim_header(&sample_prepare("g.example.app"), CLAIM_HEADER, "{}");
            let response = app.oneshot(request).await.unwrap();

            assert_eq!(cost_header(&response), Some(0));
        }

        /// ADR 0011: probing traverses the network for free, so it is
        /// accepted only from a sender holding a channel this connector
        /// recognizes. A probe presenting nothing is not authorized, and
        /// says so with a status distinct from an ILP-level outcome.
        #[tokio::test]
        async fn a_probe_presenting_no_claim_is_forbidden() {
            let (app, _app_client, _signer) = priced_route_router();

            let response = app
                .oneshot(probe_request(&sample_prepare("g.example.app"), None))
                .await
                .unwrap();

            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }

        /// A claim that verifies proves the sender holds the channel, but
        /// this connector has never seen that channel before -- ADR 0011's
        /// first condition is not met and the packet is never forwarded.
        #[tokio::test]
        async fn a_probe_on_a_channel_this_connector_has_never_seen_is_forbidden() {
            let (app, app_client, _signer) = priced_route_router();

            let response = app
                .oneshot(probe_request(
                    &sample_prepare("g.example.app"),
                    Some(&evm_claim_json(1, PRICE)),
                ))
                .await
                .unwrap();

            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            assert!(app_client.deliveries().is_empty());
        }

        /// The gate is satisfiable by a deployed node (issue #548's last
        /// acceptance criterion): a claim clearing §1.3's gate at this edge
        /// is how a connector learns a sender is actually *using* a channel
        /// with it. Since issue #558 that node does hold prior
        /// configuration about the channel -- it must already record the
        /// counterparty whose signature it accepts there, or the claim
        /// could not verify at all -- but recording whose signature is
        /// accepted is not the same as having been paid, and it is the
        /// payment that this gate records. No chain indexes that either.
        /// Having paid once, the same sender may probe -- and what comes
        /// back is the route's price as one figure, with the app still only
        /// ever having been asked to do the work that was paid for.
        #[tokio::test]
        async fn a_probe_from_a_sender_that_has_paid_reports_the_price_without_delivering() {
            let (app, app_client, signer) = priced_route_router();
            let (paid, _shared_secret) =
                sealed_sample_prepare("g.example.app", &signer.public_key().unwrap());

            let paid_response = app
                .clone()
                .oneshot(request_with_claim_header(
                    &paid,
                    CLAIM_HEADER,
                    &evm_claim_json(1, PRICE),
                ))
                .await
                .unwrap();
            assert_eq!(paid_response.status(), StatusCode::OK);
            assert_eq!(app_client.deliveries().len(), 1);

            // A fresh nonce at the same cumulative amount: the claim
            // identifies, and advances no value at all.
            let probe_response = app
                .oneshot(probe_request(
                    &sample_prepare("g.example.app"),
                    Some(&evm_claim_json(2, PRICE)),
                ))
                .await
                .unwrap();

            assert_eq!(probe_response.status(), StatusCode::OK);
            assert_eq!(cost_header(&probe_response), Some(PRICE));
            let bytes = hyper::body::to_bytes(probe_response.into_body())
                .await
                .unwrap();
            Reject::decode(&bytes).expect("a probe is answered with a reject");
            // Still one: free traversal is all a probe buys.
            assert_eq!(app_client.deliveries().len(), 1);
        }

        /// Issue #548's fifth acceptance criterion, end to end: a sender
        /// that funds a packet from the figure a probe returned is not then
        /// rejected for underpaying it. The figure a probe reports and the
        /// figure the claim gate charges are the same route price read from
        /// the same lookup, so this holds by construction -- and this test
        /// is what keeps it holding.
        #[tokio::test]
        async fn funding_a_packet_from_the_figure_a_probe_returned_is_not_underpayment() {
            let (app, app_client, signer) = priced_route_router();
            let (paid, _shared_secret) =
                sealed_sample_prepare("g.example.app", &signer.public_key().unwrap());

            // Pay once, so this connector recognizes the channel.
            app.clone()
                .oneshot(request_with_claim_header(
                    &paid,
                    CLAIM_HEADER,
                    &evm_claim_json(1, PRICE),
                ))
                .await
                .unwrap();

            let probe_response = app
                .clone()
                .oneshot(probe_request(
                    &sample_prepare("g.example.app"),
                    Some(&evm_claim_json(2, PRICE)),
                ))
                .await
                .unwrap();
            let quoted = cost_header(&probe_response).expect("a probe reports a figure");

            // Fund exactly what the probe quoted, and nothing more.
            let (second, _shared_secret) =
                sealed_sample_prepare("g.example.app", &signer.public_key().unwrap());
            let response = app
                .oneshot(request_with_claim_header(
                    &second,
                    CLAIM_HEADER,
                    &evm_claim_json(3, PRICE + quoted),
                ))
                .await
                .unwrap();

            assert_eq!(response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            Fulfill::decode(&bytes).expect("a packet funded from the probe's figure fulfils");
            assert_eq!(app_client.deliveries().len(), 2);
        }
    }
}
