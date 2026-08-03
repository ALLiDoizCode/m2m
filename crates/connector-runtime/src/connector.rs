//! `pub struct Connector` -- the packet plane. See ADR 0001.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, RwLock};

use arc_swap::ArcSwap;
use chrono::{DateTime, Duration, Utc};
use connector_config::{SettlementChain, StaticRoute, TransportPolicy};
use connector_domain::{
    amount_after_fee, condition_is_present, fulfillment_matches_condition, is_expired,
    is_valid_ilp_address, select_route, EnvelopeRequest, Fulfill, PacketResponse, Prepare,
    ProjectionDivergence, Reject, RejectCode,
};
use connector_settlement::{ChannelId, Claim, SettlementBackend, SettlementError};
use connector_signer::giftwrap::{derive_fulfillment, open_request, seal_response};
use connector_signer::{Address, Signer};
use thiserror::Error;
use tracing::Instrument;

use crate::app_client::{AppClient, AppOutcome};
use crate::claim::{ChannelDomain, ClaimAckOutcome, ClaimBook, InvalidChannelId, WireClaim};
use crate::clock::Clock;
use crate::journal::{Journal, JournalError};
use crate::metrics::Metrics;
use crate::operator_view::{
    ChannelView, ClaimView, ExposureView, LeasedRouteView, PeerView, RouteView,
};
use crate::peer_transport::PeerTransport;
use crate::route::{LeasedRoute, PeerRoute};

/// A reject this connector originates before a gift wrap's shared secret
/// could be recovered -- no identity key configured, or the wrap itself
/// could not be opened. Necessarily plaintext (ADR 0018: "a reject raised
/// short of the termination is necessarily plaintext... shares no secret
/// with the sender and cannot seal anything"), with empty `data` so a
/// sender can tell it apart from a sealed one
/// (`connector_signer::giftwrap::looks_like_sealed_response`).
fn unsealed_termination_reject(message: &str) -> Reject {
    Reject {
        code: RejectCode::f01_invalid_packet(),
        triggered_by: String::new(),
        message: message.to_string(),
        data: Vec::new(),
        accumulated_cost: 0,
    }
}

/// What can go wrong creating or renewing a leased route (issue #427).
#[derive(Debug, Error, PartialEq, Eq)]
pub enum LeaseRouteError {
    #[error("invalid ILP address: '{0}'")]
    InvalidPrefix(String),
}

/// What can go wrong driving a payment channel's lifecycle through
/// [`Connector::open_channel`]/[`Connector::fund_channel`]/
/// [`Connector::close_channel`] (issue #459). [`Settlement`] carries
/// through whatever the configured [`SettlementBackend`] itself reported;
/// [`NoSettlementBackend`] is this crate's own -- a channel operation
/// reaching a node with none configured (ADR 0009: a node that never names
/// one in its config simply never gets a working channel surface, rather
/// than a panic).
///
/// [`Settlement`]: ChannelOperationError::Settlement
/// [`NoSettlementBackend`]: ChannelOperationError::NoSettlementBackend
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ChannelOperationError {
    #[error("no settlement backend is configured for this node")]
    NoSettlementBackend,
    /// This node settles on at least one chain, just not the one this
    /// operation needs: the channel id (or the caller's explicit `chain`)
    /// named a chain no `[settlement.<chain>]` table configured a backend
    /// for. Distinct from [`NoSettlementBackend`] so a both-surfaces
    /// operator error names the actual gap ("no solana backend") rather
    /// than denying the backends the node does have.
    ///
    /// [`NoSettlementBackend`]: ChannelOperationError::NoSettlementBackend
    #[error("no {0} settlement backend is configured for this node")]
    NoSettlementBackendForChain(SettlementChain),
    /// [`Connector::open_channel`] was called without naming a chain on a
    /// node that settles on more than one, where "the configured backend"
    /// denotes nothing (issue #630's review: a node with both
    /// `[settlement.evm]` and `[settlement.solana]` must not silently
    /// pick one).
    #[error("this node settles on more than one chain -- name which chain to open the channel on")]
    AmbiguousSettlementChain,
    /// [`Connector::redeem_latest_claim`] or [`Connector::cooperative_close`]
    /// was asked to redeem a channel this node has never accepted an
    /// inbound claim on (issue #425) -- distinct from
    /// [`SettlementError::StaleClaim`], which means a claim exists but the
    /// chain has already redeemed at least that much.
    #[error("no claim has been accepted on this channel to redeem")]
    NoClaimToRedeem,
    #[error(transparent)]
    Settlement(#[from] SettlementError),
}

/// Why [`Connector::handle_probe`] declined to route a packet at all,
/// before ever calling [`Connector::handle_prepare`] (issue #426, ADR
/// 0011's consequence: "a probe traverses the network and pays nothing").
/// Neither variant is a [`PacketResponse`] -- a denial here means this
/// packet was never treated as an ILP-level exchange to begin with,
/// matching how the client edge is specified to answer it with a bare
/// `403` rather than an OER REJECT body (`docs/protocol/client-edge-spec.md`
/// §1.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeDenied {
    /// `channel_id` holds no payment channel this connector recognizes.
    NoOpenChannel,
    /// `channel_id` has exceeded its configured probe rate limit.
    RateLimited,
}

/// A fixed-window rate limiter for probe traffic, keyed by sender identity
/// (issue #426, ADR 0011's consequence: "a probe traverses the network and
/// pays nothing ... so it is ... rate-limited per that identity"). Counted
/// against this connector's own injected [`Clock`] rather than wall time, so
/// tests control it deterministically instead of racing real elapsed time.
struct ProbeRateLimiter {
    max_per_window: u32,
    window: Duration,
    /// A plain [`Mutex`] rather than [`RwLock`] like `known_channels`
    /// below -- every access here mutates (recording an attempt), so
    /// there is no read-only path to give a reader/writer lock any
    /// advantage over mutual exclusion.
    windows: Mutex<HashMap<String, (DateTime<Utc>, u32)>>,
}

impl ProbeRateLimiter {
    fn new(max_per_window: u32, window: Duration) -> ProbeRateLimiter {
        ProbeRateLimiter {
            max_per_window,
            window,
            windows: Mutex::new(HashMap::new()),
        }
    }

    /// Record one probe attempt from `identity` at `now`, returning whether
    /// it is allowed. A window starts on an identity's first attempt (or
    /// its first attempt after its previous window elapsed) and admits up
    /// to `max_per_window` attempts before refusing the rest until the next
    /// window starts.
    fn allow(&self, identity: &str, now: DateTime<Utc>) -> bool {
        let mut windows = self
            .windows
            .lock()
            .expect("probe rate limiter lock poisoned");
        match windows.get_mut(identity) {
            Some((started_at, count)) if now < *started_at + self.window => {
                if *count >= self.max_per_window {
                    false
                } else {
                    *count += 1;
                    true
                }
            }
            _ => {
                windows.insert(identity.to_string(), (now, 1));
                true
            }
        }
    }
}

/// Which kind of routing-table entry matched a packet's destination, and
/// where in its own table -- resolved by [`Connector::handle_prepare`]
/// before dispatch, so priority among same-length matches (issue #427: a
/// static route always outranks a leased route) is decided in exactly one
/// place.
enum RouteTarget {
    App(usize),
    Peer(usize),
    /// Indexes into the caller's own filtered `Vec` of currently-active
    /// leased routes, not `Connector::leased_routes` directly -- see
    /// [`Connector::leased_routes_snapshot`].
    Leased(usize),
}

impl RouteTarget {
    /// Break a tie in matched prefix length: a static route always
    /// outranks a leased route for the same prefix (issue #427) -- an
    /// operator's explicit configuration cannot be overridden by an
    /// automated controller. Peer routes from configuration fall in
    /// between: also static, but forwarding rather than terminating.
    fn priority(&self) -> u8 {
        match self {
            RouteTarget::Leased(_) => 0,
            RouteTarget::Peer(_) => 1,
            RouteTarget::App(_) => 2,
        }
    }
}

/// Hex-encode a packet's execution condition for use as a log correlation
/// id. The condition is invariant across every hop a packet passes through
/// (forwarding only ever changes `amount`, per [`Connector::forward_to_peer`]),
/// so independent connectors logging this same value for the same packet
/// can have their structured logs correlated across the hop boundary with
/// no wire change and no new field -- ADR 0014.
fn correlation_id(execution_condition: &[u8; 32]) -> String {
    execution_condition
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// An app route's price and transport policy together, as
/// [`Connector::app_route`] returns them from a single route lookup (issue
/// #701).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppRouteFacts {
    pub price: u64,
    pub transport_policy: TransportPolicy,
}

/// The connector's packet plane: a fixed set of terminated routes and peer
/// routes, an [`AppClient`] port for delivering to the apps behind
/// terminated routes, a [`PeerTransport`] port for forwarding to the next
/// hop on peer routes, and a [`Clock`] port rather than wall time.
///
/// A router (`connector-client-edge`) deserializes a request into a
/// [`Prepare`], calls exactly one method here -- [`Connector::handle_prepare`]
/// -- and serializes the result. Every routing and delivery decision is made
/// in that one method; the router makes none.
pub struct Connector {
    routes: Vec<StaticRoute>,
    peer_routes: Vec<PeerRoute>,
    /// Routes pushed at runtime over the operator surface with a time
    /// limit (ADR 0006, issue #427), keyed by prefix so pushing the same
    /// prefix again renews it rather than adding a duplicate entry. Lives
    /// only in memory: unlike `routes` and `peer_routes`, nothing here is
    /// loaded from configuration, so none of it survives a restart.
    ///
    /// Held as an atomically-swapped immutable snapshot rather than a
    /// `RwLock<HashMap<..>>` (ADR 0015, issue #452): the packet path reads
    /// the current map with a single lock-free `Arc` clone, never a lock
    /// and never a copy of every leased route, so hot-path cost does not
    /// scale with how many leases happen to be active. A write (lease
    /// creation or renewal) publishes a whole new map rather than mutating
    /// this one in place -- the rare, administrative side is where the
    /// O(n) copy belongs, not the per-packet side.
    leased_routes: ArcSwap<HashMap<String, LeasedRoute>>,
    app_client: Arc<dyn AppClient>,
    peer_transport: Arc<dyn PeerTransport>,
    clock: Arc<dyn Clock>,
    metrics: Arc<Metrics>,
    /// The real chains' settlement backends (issue #459), keyed by the
    /// chain each one settles on (issue #630: a node with both
    /// `[settlement.evm]` and `[settlement.solana]` holds *both* -- a
    /// single slot would leave whichever attached first silently
    /// unreachable while the node kept accepting its claims). At most one
    /// backend per chain, in attachment (= config) order; empty on a node
    /// that configured none, where channel operations fail with
    /// [`ChannelOperationError::NoSettlementBackend`] rather than being
    /// unreachable, matching how `leased_routes` degrades to "just empty"
    /// rather than a distinct construction path.
    settlements: Vec<(SettlementChain, Arc<dyn SettlementBackend>)>,
    /// Every channel this node has itself opened, in the order opened,
    /// each remembering the chain it was opened on.
    /// `SettlementBackend` has no "list every channel" method (a real
    /// chain has no such index either) -- this is the one thing
    /// `Connector` itself has to remember so `channels()` knows which ids
    /// to ask which backend to report on.
    known_channels: RwLock<Vec<(SettlementChain, ChannelId)>>,
    /// Claims owed to and received from every peering relation (ADR 0004,
    /// ADR 0005, issue #423): signing an outbound claim on fulfilment,
    /// verifying and watermarking an inbound one. Empty and signer-less
    /// until configured via [`Connector::with_signer`],
    /// [`Connector::with_peer_claim_channel`] and
    /// [`Connector::with_channel_verification_key`] -- a node with none of
    /// those simply never emits or accepts a claim, matching how
    /// `settlement` degrades to `None`.
    claims: ClaimBook,
    /// This connector's own identity key (ADR 0018, ADR 0022), used to open
    /// a gift wrap sealed to it (issue #524) -- distinct from `claims`'s
    /// signer, which signs outbound claims to a peer rather than performing
    /// key agreement. `None` on a node that hasn't configured one, in which
    /// case every packet routed to an app route is refused: per ADR 0018
    /// every packet's `data` is a gift wrap, so a node that cannot open one
    /// cannot terminate any app route at all, matching how `settlement`
    /// degrades to "every channel operation refuses" rather than "channel
    /// operations silently no-op".
    identity_signer: Option<Arc<dyn Signer>>,
    /// Gates [`Connector::handle_probe`] (issue #426, ADR 0011): a fixed
    /// window of probe attempts admitted per sender identity. Defaults to
    /// [`DEFAULT_PROBE_LIMIT`] per [`default_probe_window`], overridable via
    /// [`Connector::with_probe_rate_limit`] -- unlike `settlement`/`claims`
    /// above, this fails *closed* rather than open: probing pays nothing,
    /// so a node that never configures a limit still gets one rather than
    /// unbounded free traversal.
    probe_rate_limiter: ProbeRateLimiter,
    /// Payment channels this connector has seen a valid claim on at its own
    /// client edge (issue #548), and therefore recognizes as belonging to a
    /// sender that holds a channel with it -- the other half of
    /// [`Connector::handle_probe`]'s first gate, beside `claims`'s
    /// configured peer-wire verification keys. Without this the gate is
    /// unsatisfiable on a deployed node: nothing in a node's configuration
    /// supplies a client's channel id, and a gate no node can pass is not a
    /// gate (ADR 0011's "accepted only from a sender that already holds an
    /// open payment channel with this connector"). Populated by
    /// [`Connector::recognize_channel`], which the client edge calls when a
    /// claim clears its gate.
    recognized_channels: RwLock<HashSet<String>>,
}

/// [`Connector`]'s default probe rate limit absent
/// [`Connector::with_probe_rate_limit`] -- a deliberately conservative
/// figure (issue #426): probing costs a sender nothing, so the safe default
/// is a small allowance rather than none at all.
const DEFAULT_PROBE_LIMIT: u32 = 60;

/// [`Connector`]'s default probe rate limit window, paired with
/// [`DEFAULT_PROBE_LIMIT`].
fn default_probe_window() -> Duration {
    Duration::seconds(60)
}

impl Connector {
    pub fn new(
        routes: Vec<StaticRoute>,
        peer_routes: Vec<PeerRoute>,
        app_client: Arc<dyn AppClient>,
        peer_transport: Arc<dyn PeerTransport>,
        clock: Arc<dyn Clock>,
    ) -> Connector {
        Connector {
            routes,
            peer_routes,
            leased_routes: ArcSwap::from_pointee(HashMap::new()),
            app_client,
            peer_transport,
            clock,
            metrics: Arc::new(Metrics::new()),
            settlements: Vec::new(),
            known_channels: RwLock::new(Vec::new()),
            claims: ClaimBook::new(None, HashMap::new(), HashMap::new()),
            identity_signer: None,
            probe_rate_limiter: ProbeRateLimiter::new(DEFAULT_PROBE_LIMIT, default_probe_window()),
            recognized_channels: RwLock::new(HashSet::new()),
        }
    }

    /// Configure this node's own identity key (issue #524), used to open a
    /// gift wrap sealed to it -- the same identity `connector-client-edge`
    /// reports at `GET /ilp/identity` (ADR 0022). Without one configured, a
    /// packet routed to an app route is refused rather than delivered,
    /// since there is nothing to open it with.
    pub fn with_identity_signer(mut self, signer: Arc<dyn Signer>) -> Self {
        self.identity_signer = Some(signer);
        self
    }

    /// Override the default probe rate limit (issue #426, ADR 0011): up to
    /// `max_per_window` probe attempts per sender identity within `window`,
    /// checked against this connector's own injected clock.
    pub fn with_probe_rate_limit(mut self, max_per_window: u32, window: Duration) -> Self {
        self.probe_rate_limiter = ProbeRateLimiter::new(max_per_window, window);
        self
    }

    /// Configure this node's own signer (issue #423), used to sign every
    /// outbound claim. Without one configured, a fulfilled packet still
    /// forwards and fulfils normally -- it simply never emits a claim,
    /// matching how a node with no settlement backend never gets a working
    /// channel surface.
    pub fn with_signer(mut self, signer: Arc<dyn Signer>) -> Self {
        self.claims.set_signer(signer);
        self
    }

    /// Configure the channel this node claims against when it owes
    /// `peer_id` for value it forwarded and `peer_id` fulfilled (issue
    /// #423, peer-wire-spec.md §3.5).
    pub fn with_peer_claim_channel(
        mut self,
        peer_id: impl Into<String>,
        channel_id: impl Into<String>,
    ) -> Self {
        self.claims.set_outbound_channel(peer_id, channel_id);
        self
    }

    /// Configure the EVM address whose signature this node accepts on an
    /// inbound claim for `channel_id` (issue #423, peer-wire-spec.md §1.1's
    /// "a configured peer id and verification key"; issue #575: this is now
    /// the channel's counterparty *address*, recovered from an EIP-712
    /// `BalanceProof` signature, not a raw public key checked against a
    /// connector-internal digest). Pair with
    /// [`Connector::with_channel_domain`] for the same `channel_id` -- a
    /// claim naming a channel with no domain configured is refused
    /// regardless of this.
    pub fn with_channel_verification_key(
        mut self,
        channel_id: impl Into<String>,
        counterparty: Address,
    ) -> Self {
        self.claims.set_verification_key(channel_id, counterparty);
        self
    }

    /// Configure `channel_id`'s EIP-712 signing domain -- the chain it is
    /// deployed on and the `TokenNetwork` contract that verifies a claim's
    /// signature on redemption (issue #575/#566). Required, alongside
    /// [`Connector::with_peer_claim_channel`] or
    /// [`Connector::with_channel_verification_key`], before this channel
    /// can sign or accept a claim -- see [`ClaimBook::set_channel_domain`].
    /// `channel_id` must already be the channel's on-chain `bytes32`, refused
    /// otherwise rather than hashed or truncated into shape.
    pub fn with_channel_domain(
        mut self,
        channel_id: impl Into<String>,
        domain: ChannelDomain,
    ) -> Result<Self, InvalidChannelId> {
        self.claims.set_channel_domain(channel_id, domain)?;
        Ok(self)
    }

    /// Configure the settlement backend a node's channel-lifecycle writes
    /// (issue #459) are driven against on `chain` -- callable once per
    /// chain (issue #630), so a node with both `[settlement.evm]` and
    /// `[settlement.solana]` holds both backends rather than whichever
    /// attached last. Attaching a second backend for the same chain
    /// replaces the first, matching how config load already refuses two
    /// tables for one chain. A builder rather than a [`Connector::new`]
    /// parameter deliberately -- most of this crate's own tests, and every
    /// other crate constructing a bare `Connector` today, have no
    /// settlement backend at all and shouldn't need to thread one through
    /// just to keep compiling.
    pub fn with_settlement(
        mut self,
        chain: SettlementChain,
        settlement: Arc<dyn SettlementBackend>,
    ) -> Self {
        match self
            .settlements
            .iter_mut()
            .find(|(existing, _)| *existing == chain)
        {
            Some((_, slot)) => *slot = settlement,
            None => self.settlements.push((chain, settlement)),
        }
        self
    }

    /// Configure `channel_id`'s exposure ceiling (ADR 0005,
    /// peer-wire-spec.md §5.3, issue #424): a PREPARE arriving over that
    /// channel is rejected (`T04_INSUFFICIENT_LIQUIDITY`) once this
    /// connector's exposure to it exceeds `ceiling`, until a covering claim
    /// is accepted.
    pub fn with_channel_ceiling(mut self, channel_id: impl Into<String>, ceiling: u64) -> Self {
        self.claims.set_ceiling(channel_id, ceiling);
        self
    }

    /// Configure the durable journal this node's claim and exposure state
    /// is persisted to and rebuilt from (ADR 0005, issue #424). Call this
    /// *last* in the builder chain -- rebuild uses whatever signer is
    /// already configured to re-arm any outbound claim left unacknowledged
    /// (see `ClaimBook::rebuild_from`'s own doc for why that is always
    /// safe). Returns whatever divergences the rebuild found between the
    /// projection and the claims it derives from (issue #424's own
    /// acceptance criteria: "reports divergence rather than absorbing
    /// it") -- already logged via `tracing::error!` regardless of whether
    /// a caller inspects the return value.
    pub fn with_journal(
        mut self,
        journal: Arc<dyn Journal>,
    ) -> Result<(Self, Vec<ProjectionDivergence>), JournalError> {
        let divergences = self.claims.set_journal(journal)?;
        Ok((self, divergences))
    }

    /// Create or renew a leased route (ADR 0006, issue #427): a controller
    /// outside this connector pushes a route to a peer with a time limit,
    /// keyed by `prefix`. Calling this again for a prefix already leased
    /// renews it -- `expires_at` is always computed as `ttl` from this
    /// node's own injected clock, never from the caller, so a controller
    /// cannot claim a longer lease than this node's clock allows.
    pub fn upsert_leased_route(
        &self,
        prefix: impl Into<String>,
        peer_id: impl Into<String>,
        fee: u64,
        ttl: Duration,
    ) -> Result<LeasedRouteView, LeaseRouteError> {
        let prefix = prefix.into();
        if !is_valid_ilp_address(&prefix) {
            return Err(LeaseRouteError::InvalidPrefix(prefix));
        }
        let expires_at = self.clock.now() + ttl;
        let route = LeasedRoute::new(prefix.clone(), peer_id.into(), fee, expires_at);
        let view = leased_route_view(&route);
        self.leased_routes.rcu(|current| {
            let mut next = (**current).clone();
            next.insert(prefix.clone(), route.clone());
            next
        });
        Ok(view)
    }

    /// The current leased-route map, snapshotted as of this call (issue
    /// #452): `ArcSwap::load_full` is a single atomic `Arc`
    /// clone -- no lock and no copy of the routes themselves -- and a
    /// concurrent `upsert_leased_route` publishes an entirely new map
    /// rather than mutating the one this snapshot points at, so the
    /// snapshot stays valid for as long as its caller holds it.
    fn leased_routes_snapshot(&self) -> Arc<HashMap<String, LeasedRoute>> {
        self.leased_routes.load_full()
    }

    /// Leased routes not yet lapsed as of the injected clock, for the
    /// operator surface's read-only inspection interface. Expiry is
    /// filtered fresh on every call -- a lapsed route disappears from this
    /// list the moment it disappears from routing, with no sweep delay in
    /// between (issue #427).
    pub fn leased_routes(&self) -> Vec<LeasedRouteView> {
        let now = self.clock.now();
        self.leased_routes_snapshot()
            .values()
            .filter(|route| !is_expired(route.expires_at(), now))
            .map(leased_route_view)
            .collect()
    }

    /// This connector's own metrics (ADR 0014), for the operator surface's
    /// `GET /metrics` (bearer-token gated, same as any other read).
    pub fn metrics(&self) -> Arc<Metrics> {
        self.metrics.clone()
    }

    /// Reject `prepare` outright if it isn't even eligible for routing --
    /// missing/all-zero execution condition (issue #417, no zero-condition
    /// path exists anywhere) or already past its expiry as of the injected
    /// clock, checked before any route is selected or any app/peer is
    /// touched, so an invalid or expired packet never reaches either.
    fn reject_ineligible(&self, prepare: &Prepare) -> Option<Reject> {
        if !condition_is_present(&prepare.execution_condition) {
            return Some(Reject {
                code: RejectCode::f01_invalid_packet(),
                triggered_by: String::new(),
                message: "prepare carries no execution condition".to_string(),
                data: Vec::new(),
                accumulated_cost: 0,
            });
        }
        if is_expired(prepare.expires_at, self.clock.now()) {
            return Some(Reject {
                code: RejectCode::r00_transfer_timed_out(),
                triggered_by: String::new(),
                message: "prepare has expired".to_string(),
                data: Vec::new(),
                accumulated_cost: 0,
            });
        }
        None
    }

    /// Reject `prepare` outright if it fails [`Self::reject_ineligible`];
    /// otherwise route it by longest-prefix match over terminated routes and
    /// peer routes together, then either deliver it to the matching app or
    /// forward it to the matching peer -- and translate whatever comes back
    /// into the ILP-level response a client receives.
    ///
    /// `minimum_delivery` is the amount the original sender declared must
    /// reach the destination (ADR 0010). Forwarding to a peer subtracts
    /// that peering relation's flat fee from `prepare.amount`; if the
    /// result would fall below `minimum_delivery`, this hop rejects
    /// (`R01_INSUFFICIENT_SOURCE_AMOUNT`) instead of forwarding a smaller
    /// amount than declared. Delivering to this connector's own app takes
    /// no fee -- a fee is earned per peering relation, not for terminating
    /// traffic at your own destination.
    pub async fn handle_prepare(&self, prepare: Prepare, minimum_delivery: u64) -> PacketResponse {
        let span = tracing::info_span!(
            "packet",
            correlation_id = %correlation_id(&prepare.execution_condition),
            destination = %prepare.destination,
        );
        self.handle_prepare_traced(prepare, minimum_delivery)
            .instrument(span)
            .await
    }

    /// The peer wire's entry point (issue #423): accepts an inbound PREPARE
    /// exactly like [`Connector::handle_prepare`], but also verifies and
    /// watermarks whatever claim it carries (peer-wire-spec.md §3.2), and
    /// enforces this channel's exposure ceiling (§5.3, issue #424) before
    /// forwarding.
    ///
    /// The claim outcome and the PREPARE outcome are independent -- a
    /// rejected claim does not reject the PREPARE it rode in on (§3.4), and
    /// this method decides neither from the other. `channel_id` identifies
    /// which inbound peering relation this PREPARE belongs to -- the peer
    /// wire has no identity handshake yet (#416), so a caller supplies
    /// whatever channel it last learned for this connection (typically from
    /// an accompanying claim, cached across calls that carry none); `None`
    /// when no channel has been established yet, in which case no ceiling
    /// can be checked and no exposure is recorded for this call, matching
    /// how a peer with no configured channel never gets a claim emitted
    /// either.
    pub async fn handle_peer_prepare(
        &self,
        prepare: Prepare,
        minimum_delivery: u64,
        claim: Option<WireClaim>,
        channel_id: Option<String>,
    ) -> (PacketResponse, ClaimAckOutcome) {
        let ack = claim.map_or(ClaimAckOutcome::NotSent, |claim| {
            self.handle_peer_claim(claim)
        });

        if let Some(channel_id) = channel_id.as_deref() {
            if self.claims.is_over_ceiling(channel_id) {
                let reject = PacketResponse::Reject(Reject {
                    code: RejectCode::t04_insufficient_liquidity(),
                    triggered_by: String::new(),
                    message: format!("exposure ceiling exceeded for channel '{channel_id}'"),
                    data: Vec::new(),
                    accumulated_cost: 0,
                });
                return (self.finish(reject), ack);
            }
        }

        let amount = prepare.amount;
        let response = self.handle_prepare(prepare, minimum_delivery).await;
        if let (PacketResponse::Fulfill(_), Some(channel_id)) = (&response, channel_id.as_deref()) {
            self.claims.record_inbound_delivery(channel_id, amount);
        }
        (response, ack)
    }

    /// Record that `channel_id` names a payment channel this connector
    /// recognizes (issue #548) -- the client edge calls this the moment a
    /// claim on that channel clears its own gate (structure, freshness,
    /// value, and signature against the counterparty recorded for that
    /// channel, issue #558), which is the only evidence a connector ever
    /// gets that a sender is actually *using* a channel with it. Since
    /// #558 a connector does hold prior configuration about such a channel
    /// -- it must already record whose signature it accepts there, or no
    /// claim on it could verify -- but that says only which key may spend,
    /// never that anyone has; and no chain offers an index of who has (the
    /// same reason `known_channels` exists).
    ///
    /// Idempotent, and deliberately not undone -- a channel that has closed
    /// simply retains a probe allowance it can no longer pay with, which
    /// costs nothing beyond the rate limit that gates it anyway.
    pub fn recognize_channel(&self, channel_id: &str) {
        let mut recognized = self
            .recognized_channels
            .write()
            .expect("recognized channels lock poisoned");
        if !recognized.contains(channel_id) {
            recognized.insert(channel_id.to_string());
        }
    }

    /// Whether `channel_id` is a channel this connector recognizes: either
    /// a peer-wire channel whose verification key its operator configured
    /// ([`Connector::with_channel_verification_key`]), or a client channel
    /// [`Connector::recognize_channel`] recorded when a claim on it
    /// verified at this connector's client edge.
    pub fn recognizes_channel(&self, channel_id: &str) -> bool {
        self.claims.has_verification_key(channel_id)
            || self
                .recognized_channels
                .read()
                .expect("recognized channels lock poisoned")
                .contains(channel_id)
    }

    /// Entry point for a probe -- an ordinary packet a sender expects to be
    /// rejected, sent purely to learn a path's cost via the
    /// `accumulated_cost` every [`connector_domain::Reject`] now carries
    /// (issue #426, ADR 0011). Probes are not a distinct packet type and
    /// fee accumulation is not a special mode for them (ADR 0011): past the
    /// gates below this is [`Connector::handle_prepare`], routed by the
    /// ordinary routing table, and whatever comes back is reported exactly
    /// as it would be for traffic that never called this method at all.
    ///
    /// Unlike [`Connector::handle_prepare`]/[`Connector::handle_peer_prepare`],
    /// a probe is gated *before* routing is attempted: probing traverses
    /// this connector's network for free, so it is accepted only from
    /// `channel_id` identifying a payment channel this connector already
    /// recognizes (`ProbeDenied::NoOpenChannel` otherwise -- see
    /// [`Connector::recognizes_channel`] for what makes that satisfiable on
    /// a deployed node), and even then only within a rate limit per that
    /// identity (`ProbeDenied::RateLimited` otherwise) -- peer-wire-spec.md
    /// §5.2's consequences, `docs/protocol/client-edge-spec.md` §1.6.
    /// Neither denial reaches [`Connector::handle_prepare`]: the packet is
    /// never forwarded.
    ///
    /// A probe is never *delivered* to a locally terminated route (issue
    /// #548). Free traversal is the whole of what ADR 0011 grants a probe;
    /// it does not also buy the work behind a priced route, which is what
    /// delivering here would hand over -- a sender able to seal a valid
    /// envelope would get the app's answer for nothing, the one thing ADR
    /// 0020's "an unpaid request to a priced route is answered with its
    /// terms" exists to prevent. A destination that terminates here is
    /// therefore answered with that route's price as `accumulated_cost`,
    /// which is exactly the figure a real request would be charged and, for
    /// a local termination, the whole path cost: no hop was traversed to
    /// reach it.
    pub async fn handle_probe(
        &self,
        channel_id: &str,
        prepare: Prepare,
        minimum_delivery: u64,
    ) -> Result<PacketResponse, ProbeDenied> {
        if !self.recognizes_channel(channel_id) {
            return Err(ProbeDenied::NoOpenChannel);
        }
        if !self.probe_rate_limiter.allow(channel_id, self.clock.now()) {
            return Err(ProbeDenied::RateLimited);
        }
        if let Some(price) = self.app_route_price(&prepare.destination) {
            return Ok(PacketResponse::Reject(Reject {
                code: RejectCode::f03_invalid_amount(),
                triggered_by: String::new(),
                message: format!(
                    "probe: '{}' terminates at this connector and costs {price}",
                    prepare.destination
                ),
                data: Vec::new(),
                accumulated_cost: price,
            }));
        }
        Ok(self.handle_prepare(prepare, minimum_delivery).await)
    }

    /// Verify and, if valid, accept a claim received over the peer wire --
    /// whether it rode a PREPARE or a FLUSH -- advancing its channel's
    /// watermark (issue #423, peer-wire-spec.md §3.4).
    pub fn handle_peer_claim(&self, claim: WireClaim) -> ClaimAckOutcome {
        self.claims.accept_inbound(&claim)
    }

    /// Send a FLUSH frame (peer-wire-spec.md §3.3) for every peer whose
    /// claim has waited at least `flush_interval` since it armed, as of
    /// this connector's injected clock -- the mechanism that bounds
    /// trailing exposure once traffic to a peer stops rather than leaving a
    /// claim to ride a PREPARE that may never come. Checked fresh against
    /// the clock on every call, like leased-route expiry, rather than
    /// driven by its own timer: a caller (production: a periodic task;
    /// tests: a direct call after advancing the clock) decides when to
    /// sweep.
    pub async fn sweep_flush(&self, flush_interval: Duration) {
        for (peer_id, claim) in self.claims.due_for_flush(self.clock.now(), flush_interval) {
            let nonce = claim.nonce;
            let ack = self.peer_transport.flush(&peer_id, claim).await;
            self.claims.acknowledge_outbound(&peer_id, nonce, ack);
        }
    }

    async fn handle_prepare_traced(
        &self,
        prepare: Prepare,
        minimum_delivery: u64,
    ) -> PacketResponse {
        // Per-packet lines are debug, not info (issue #690): at huddle rates
        // (hundreds of packets/s) every INFO here becomes per-event disk I/O
        // through docker's json-file log driver -- the same disease as
        // relay#87's per-write console.log. The default `info` filter keeps
        // the hot path silent; RUST_LOG=connector_runtime=debug restores the
        // per-packet trace without a config change on the boxes.
        tracing::debug!("packet received");

        if let Some(reject) = self.reject_ineligible(&prepare) {
            return self.finish(PacketResponse::Reject(reject));
        }

        // Issue #452: `leased_routes_snapshot` is one lock-free `Arc`
        // clone. Every active route below is a reference borrowed
        // straight out of that snapshot -- expiry is still checked fresh
        // against the clock so a lapsed lease stops being selected
        // immediately, matching #427's guarantee, but nothing here
        // allocates a copy of the routes themselves.
        let leased_routes = self.leased_routes_snapshot();
        let now = self.clock.now();
        let active_leased: Vec<&LeasedRoute> = leased_routes
            .values()
            .filter(|route| !is_expired(route.expires_at(), now))
            .collect();

        let peer_prefixes: Vec<&str> = self.peer_routes.iter().map(PeerRoute::prefix).collect();
        let leased_prefixes: Vec<&str> = active_leased.iter().map(|route| route.prefix()).collect();

        let app_match = self
            .select_app_route(&prepare.destination)
            .map(|index| (self.routes[index].prefix().len(), RouteTarget::App(index)));
        let peer_match = select_route(&prepare.destination, &peer_prefixes).map(|index| {
            (
                self.peer_routes[index].prefix().len(),
                RouteTarget::Peer(index),
            )
        });
        let leased_match = select_route(&prepare.destination, &leased_prefixes).map(|index| {
            (
                active_leased[index].prefix().len(),
                RouteTarget::Leased(index),
            )
        });

        let Some((_, target)) = [app_match, peer_match, leased_match]
            .into_iter()
            .flatten()
            .max_by_key(|(len, target)| (*len, target.priority()))
        else {
            return self.finish(PacketResponse::Reject(Reject {
                code: RejectCode::f02_unreachable(),
                triggered_by: String::new(),
                message: format!("no route to destination '{}'", prepare.destination),
                data: Vec::new(),
                accumulated_cost: 0,
            }));
        };

        let peer_route = match target {
            RouteTarget::App(index) => {
                tracing::debug!(handler_url = %self.routes[index].handler_url(), "routed to app");
                let response = self.deliver_to_app(&self.routes[index], prepare).await;
                return self.finish(response);
            }
            RouteTarget::Peer(index) => &self.peer_routes[index],
            RouteTarget::Leased(index) => active_leased[index].as_peer_route(),
        };
        tracing::debug!(peer_id = %peer_route.peer_id(), "routed to peer");
        let response = self
            .forward_via_peer_route(peer_route, prepare, minimum_delivery)
            .await;
        if matches!(response, PacketResponse::Fulfill(_)) {
            self.metrics.record_fee_earned(peer_route.fee());
        }
        self.finish(response)
    }

    /// Record the packet's final outcome -- metrics and a log line -- and
    /// pass it through unchanged. The single choke point every return path
    /// in [`Self::handle_prepare_traced`] goes through, so no outcome can be
    /// reported without also being counted.
    fn finish(&self, response: PacketResponse) -> PacketResponse {
        match &response {
            PacketResponse::Fulfill(_) => {
                self.metrics.record_fulfill();
                // debug, not info: fulfilment is the per-packet common case
                // (issue #690). Rejects below stay at info -- they are the
                // per-error path and keep the `packet` span's correlation
                // fields for diagnosis.
                tracing::debug!("packet fulfilled");
            }
            PacketResponse::Reject(reject) => {
                self.metrics.record_reject(reject.code.as_str());
                tracing::info!(code = %reject.code.as_str(), message = %reject.message, "packet rejected");
            }
        }
        response
    }

    /// Forward `prepare` to `peer_route`'s peer, piggybacking whatever
    /// claim this connector currently owes it (issue #423, peer-wire-spec.md
    /// §3.2), and -- only once the answer is a genuine fulfilment, verified
    /// against `prepare`'s own execution condition -- record a fresh claim
    /// for the value now owed (ADR 0004: value moves on fulfilment, never
    /// on a forward that merely returned a fulfillment-shaped answer).
    async fn forward_via_peer_route(
        &self,
        peer_route: &PeerRoute,
        prepare: Prepare,
        minimum_delivery: u64,
    ) -> PacketResponse {
        let condition = prepare.execution_condition;
        let Some(forwarded_amount) =
            amount_after_fee(prepare.amount, peer_route.fee(), minimum_delivery)
        else {
            return PacketResponse::Reject(Reject {
                code: RejectCode::r01_insufficient_source_amount(),
                triggered_by: String::new(),
                message: format!(
                    "cannot meet minimum delivery {minimum_delivery} after this hop's fee for peer '{}'",
                    peer_route.peer_id()
                ),
                data: Vec::new(),
                accumulated_cost: 0,
            });
        };

        let outgoing = Prepare {
            amount: forwarded_amount,
            ..prepare
        };
        let peer_id = peer_route.peer_id();
        let pending_claim = self.claims.pending_claim(peer_id);
        let (response, ack, reached_peer) = self
            .peer_transport
            .forward(peer_id, outgoing, minimum_delivery, pending_claim.clone())
            .await;
        if let Some(claim) = pending_claim {
            self.claims.acknowledge_outbound(peer_id, claim.nonce, ack);
        }

        match response {
            PacketResponse::Fulfill(fulfill) => {
                let outcome = Self::accept_if_fulfilled(&condition, fulfill, 0);
                if matches!(outcome, PacketResponse::Fulfill(_)) {
                    self.claims
                        .record_fulfillment(peer_id, forwarded_amount, self.clock.now());
                }
                outcome
            }
            // ADR 0011, peer-wire-spec.md §5.2: this hop's own fee is added
            // only once it has genuinely reached `peer_id` and relays a
            // reject that peer itself decided on -- never on a reject this
            // transport synthesized locally (`reached_peer` false) because
            // the packet never actually traversed this hop in that case.
            PacketResponse::Reject(mut reject) => {
                if reached_peer {
                    reject.accumulated_cost += peer_route.fee();
                }
                PacketResponse::Reject(reject)
            }
        }
    }

    /// Issue #545: a reject this connector originates because the packet
    /// reached its termination -- an envelope that failed to decode below,
    /// or [`Self::accept_if_fulfilled`] rejecting a fulfilment that does not
    /// match the sender's execution condition -- sets `accumulated_cost` to
    /// this route's price, the same way [`Self::forward_via_peer_route`]
    /// adds a forwarding hop's fee to a relayed reject. `AppOutcome::Unreachable`
    /// does not: the app was never actually reached to do the priced work,
    /// matching how a forwarding hop that cannot reach its own peer adds
    /// nothing either. Neither does `AppOutcome::Refused` (issue #596): a
    /// target that attempts to escape the route's handler path is refused
    /// before any request is made, so like `Unreachable`, the app never did
    /// any priced work and the payer is not charged for the attempt.
    ///
    /// Per ADR 0018/issue #524, `prepare.data` is a gift wrap sealed to this
    /// connector's own identity key: opened here, above the [`AppClient`]
    /// boundary, so the port itself never sees a [`Prepare`], a key, or a
    /// secret (issue #521's boundary, extended by #524). Every return path
    /// past a successful open carries the request's own shared secret back
    /// through [`Self::seal_termination_response`] -- a FULFILL and a
    /// REJECT raised at the termination are both sealed with it (ADR 0018);
    /// only the three failures below, which happen before any secret is
    /// recovered, stay plaintext.
    async fn deliver_to_app(&self, route: &StaticRoute, prepare: Prepare) -> PacketResponse {
        let condition = prepare.execution_condition;

        let Some(identity_signer) = self.identity_signer.as_ref() else {
            return PacketResponse::Reject(unsealed_termination_reject(
                "no identity key configured to open a sealed payload",
            ));
        };

        let (envelope_bytes, shared_secret) =
            match open_request(&prepare.data, identity_signer.as_ref()) {
                Ok(opened) => opened,
                Err(error) => {
                    return PacketResponse::Reject(unsealed_termination_reject(&format!(
                        "gift wrap could not be opened: {error}"
                    )));
                }
            };

        let inner = self
            .deliver_opened_envelope(route, &condition, &shared_secret, &envelope_bytes)
            .await;
        Self::seal_termination_response(inner, &shared_secret)
    }

    /// The part of [`Self::deliver_to_app`] that runs once the gift wrap has
    /// been opened: decode the envelope it carried and, if that succeeds,
    /// make the request it describes. Split out so the caller can seal
    /// every return path uniformly with the one shared secret the wrap
    /// carried, including this method's own envelope-decode failure.
    async fn deliver_opened_envelope(
        &self,
        route: &StaticRoute,
        condition: &[u8; 32],
        shared_secret: &[u8; 32],
        envelope_bytes: &[u8],
    ) -> PacketResponse {
        let request = match EnvelopeRequest::decode(envelope_bytes) {
            Ok(request) => request,
            Err(error) => {
                return PacketResponse::Reject(Reject {
                    code: RejectCode::f01_invalid_packet(),
                    triggered_by: String::new(),
                    message: format!("envelope did not decode: {error}"),
                    data: Vec::new(),
                    accumulated_cost: route.price(),
                });
            }
        };

        match self.app_client.deliver(route.handler_url(), &request).await {
            // ADR 0020: an HTTP status is envelope content, never a packet
            // outcome, so any complete answer -- whatever its status --
            // rides home as a response envelope on a FULFILL. ADR
            // 0019/issue #525: the app supplies nothing toward the
            // fulfilment itself -- it is derived from this request's own
            // shared secret, the same secret every other return path here
            // seals its response with, so only a sender who sealed to this
            // connector's identity can ever have minted a condition it
            // matches.
            AppOutcome::Answered { response } => Self::accept_if_fulfilled(
                condition,
                Fulfill {
                    fulfillment: derive_fulfillment(shared_secret),
                    data: response.encode(),
                },
                route.price(),
            ),
            AppOutcome::Unreachable { message } => PacketResponse::Reject(Reject {
                code: RejectCode::t01_peer_unreachable(),
                triggered_by: String::new(),
                message,
                data: Vec::new(),
                accumulated_cost: 0,
            }),
            // Issue #596: distinguishable from both an undecodable envelope
            // (F01, above) and an app's own answer -- including a 404,
            // which arrives as `Answered` and rides home on a FULFILL, not
            // a reject at all -- so a sender can tell "your envelope named
            // somewhere this route's handler does not expose" apart from
            // either.
            AppOutcome::Refused { message } => PacketResponse::Reject(Reject {
                code: RejectCode::f00_bad_request(),
                triggered_by: String::new(),
                message,
                data: Vec::new(),
                accumulated_cost: 0,
            }),
        }
    }

    /// Seal `response`'s `data` with `shared_secret` (ADR 0018: "a FULFILL,
    /// and a REJECT raised at the termination, are sealed back with the
    /// same shared secret"). Applied uniformly to every outcome
    /// [`Self::deliver_opened_envelope`] can produce -- a genuine fulfilment,
    /// a fulfilment that failed to verify, an unreachable app, or a
    /// malformed envelope -- since all four happen at the termination, with
    /// the secret already in hand.
    fn seal_termination_response(
        response: PacketResponse,
        shared_secret: &[u8; 32],
    ) -> PacketResponse {
        match response {
            PacketResponse::Fulfill(fulfill) => PacketResponse::Fulfill(Fulfill {
                data: seal_response(shared_secret, &fulfill.data),
                ..fulfill
            }),
            PacketResponse::Reject(reject) => PacketResponse::Reject(Reject {
                data: seal_response(shared_secret, &reject.data),
                ..reject
            }),
        }
    }

    /// The index into `self.routes` that `destination` longest-prefix
    /// matches against, if any -- the one place app-route selection lives,
    /// shared by [`Self::handle_prepare_traced`] and [`Self::app_route_price`]
    /// so the client edge's claim gate (issue #522) asks here rather than
    /// keeping a second copy of this selection.
    fn select_app_route(&self, destination: &str) -> Option<usize> {
        let app_prefixes: Vec<&str> = self.routes.iter().map(StaticRoute::prefix).collect();
        select_route(destination, &app_prefixes)
    }

    /// The price of the app route `destination` would resolve to, or
    /// `None` if no app route matches it.
    pub fn app_route_price(&self, destination: &str) -> Option<u64> {
        self.select_app_route(destination)
            .map(|index| self.routes[index].price())
    }

    /// The transport policy of the app route `destination` would resolve
    /// to, or `None` if no app route matches it.
    pub fn app_route_transport_policy(&self, destination: &str) -> Option<TransportPolicy> {
        self.select_app_route(destination)
            .map(|index| self.routes[index].transport_policy())
    }

    /// Price and transport policy together, from one `select_app_route`
    /// lookup, or `None` if no app route matches `destination` -- the client
    /// edge's two carriages need both facts per request (issue #701) and
    /// would otherwise pay the prefix scan twice, once per accessor above.
    pub fn app_route(&self, destination: &str) -> Option<AppRouteFacts> {
        self.select_app_route(destination)
            .map(|index| AppRouteFacts {
                price: self.routes[index].price(),
                transport_policy: self.routes[index].transport_policy(),
            })
    }

    /// This node's static routes, for the operator surface's read-only
    /// inspection interface (issue #420).
    pub fn routes(&self) -> Vec<RouteView> {
        self.routes
            .iter()
            .map(|route| RouteView {
                prefix: route.prefix().to_string(),
                handler_url: route.handler_url().to_string(),
                price: route.price(),
            })
            .collect()
    }

    /// This node's peers. Always empty: no peer wire exists yet (#416).
    pub fn peers(&self) -> Vec<PeerView> {
        Vec::new()
    }

    /// This node's payment channels (issue #459) -- every channel this
    /// node has itself opened, each reported fresh from the settlement
    /// backend that opened it (issue #630: on a node settling on more
    /// than one chain, each channel is asked about on its own chain, not
    /// whichever backend attached last). Empty on a node with no
    /// settlement backend configured, or with no channels opened yet,
    /// exactly like every other still-unpopulated operator view above.
    pub async fn channels(&self) -> Vec<ChannelView> {
        let known = self
            .known_channels
            .read()
            .expect("known channels lock poisoned")
            .clone();
        let mut views = Vec::with_capacity(known.len());
        for (chain, id) in known {
            // A known channel was opened through `chain`'s backend, so the
            // lookup cannot fail while `with_settlement` is construction-only.
            let Ok(settlement) = self.settlement_on(chain) else {
                continue;
            };
            if let Ok(state) = settlement.channel_state(&id).await {
                views.push(ChannelView::from(state));
            }
        }
        views
    }

    /// The settlement backend configured for `chain`.
    /// [`ChannelOperationError::NoSettlementBackend`] on a node with no
    /// backend at all; [`ChannelOperationError::NoSettlementBackendForChain`]
    /// on a node that settles, just not there -- so the refusal names the
    /// actual gap.
    fn settlement_on(
        &self,
        chain: SettlementChain,
    ) -> Result<&Arc<dyn SettlementBackend>, ChannelOperationError> {
        if self.settlements.is_empty() {
            return Err(ChannelOperationError::NoSettlementBackend);
        }
        self.settlements
            .iter()
            .find(|(configured, _)| *configured == chain)
            .map(|(_, settlement)| settlement)
            .ok_or(ChannelOperationError::NoSettlementBackendForChain(chain))
    }

    /// Which chain's namespace `channel_id` belongs to, decided by the
    /// id's own shape: an EVM channel id is the `TokenNetwork`'s `bytes32`
    /// as (`0x`-optional) 64-character hex, a Solana one is a channel
    /// PDA's base58 32-byte account address -- the same two namespaces the
    /// client edge's `ClientChannelRegistry` already keeps separate ("a
    /// `channelId` and a `channelAccount` are different kinds of thing and
    /// can never satisfy each other"), and provably disjoint: 64 base58
    /// characters decode to ~47 bytes, never 32, and a 32-byte account is
    /// at most 44 base58 characters, never 64. `None` for an id in
    /// neither namespace.
    fn channel_id_chain(channel_id: &str) -> Option<SettlementChain> {
        let hex = channel_id.strip_prefix("0x").unwrap_or(channel_id);
        if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Some(SettlementChain::Evm);
        }
        if bs58::decode(channel_id)
            .into_vec()
            .is_ok_and(|bytes| bytes.len() == 32)
        {
            return Some(SettlementChain::Solana);
        }
        None
    }

    /// The settlement backend `channel_id`'s own chain names (issue #630)
    /// -- how every per-channel operation below picks a backend. A node
    /// with a single backend routes every id to it, keeping the port's
    /// "ids are opaque" promise where there is nothing to disambiguate (and
    /// keeping non-chain-shaped ids, like the in-memory backend's counters,
    /// working); only a node settling on several chains reads the id's
    /// namespace ([`Self::channel_id_chain`]). An id in no known namespace
    /// is [`SettlementError::ChannelNotFound`], exactly as each backend
    /// already answers for a malformed id ("a malformed id and one nothing
    /// was ever opened at mean the same thing").
    fn settlement_for_channel(
        &self,
        channel_id: &str,
    ) -> Result<&Arc<dyn SettlementBackend>, ChannelOperationError> {
        match self.settlements.as_slice() {
            [] => Err(ChannelOperationError::NoSettlementBackend),
            [(_, settlement)] => Ok(settlement),
            _ => {
                let chain = Self::channel_id_chain(channel_id).ok_or_else(|| {
                    ChannelOperationError::Settlement(SettlementError::ChannelNotFound(ChannelId(
                        channel_id.to_string(),
                    )))
                })?;
                self.settlement_on(chain)
            }
        }
    }

    /// Open a new channel to `counterparty` on `chain` (issue #459),
    /// remembering its id -- and the chain it lives on -- so a future
    /// [`Connector::channels`] call reports on it from the right backend.
    /// `None` means "the configured backend" and is accepted exactly when
    /// that denotes something: a node with several backends refuses with
    /// [`ChannelOperationError::AmbiguousSettlementChain`] rather than
    /// silently picking one (issue #630). The counterparty and
    /// settlement-timeout semantics are exactly the chosen
    /// [`SettlementBackend`]'s own -- this method adds nothing beyond
    /// bookkeeping.
    pub async fn open_channel(
        &self,
        chain: Option<SettlementChain>,
        counterparty: Vec<u8>,
        settlement_timeout: Duration,
    ) -> Result<ChannelView, ChannelOperationError> {
        let (chain, settlement) = match chain {
            Some(chain) => (chain, self.settlement_on(chain)?),
            None => match self.settlements.as_slice() {
                [] => return Err(ChannelOperationError::NoSettlementBackend),
                [(chain, settlement)] => (*chain, settlement),
                _ => return Err(ChannelOperationError::AmbiguousSettlementChain),
            },
        };
        let id = settlement.open(counterparty, settlement_timeout).await?;
        self.known_channels
            .write()
            .expect("known channels lock poisoned")
            .push((chain, id.clone()));
        let state = settlement.channel_state(&id).await?;
        Ok(ChannelView::from(state))
    }

    /// Deposit `amount` into `channel_id` (issue #459), on whichever chain
    /// the id itself names ([`Self::settlement_for_channel`]).
    pub async fn fund_channel(
        &self,
        channel_id: &str,
        amount: u128,
    ) -> Result<ChannelView, ChannelOperationError> {
        let state = self
            .settlement_for_channel(channel_id)?
            .fund(&ChannelId(channel_id.to_string()), amount)
            .await?;
        Ok(ChannelView::from(state))
    }

    /// Redeem `claim` against `channel_id` (issue #459), on whichever chain
    /// the id itself names ([`Self::settlement_for_channel`]).
    pub async fn redeem_channel(
        &self,
        channel_id: &str,
        claim: Claim,
    ) -> Result<ChannelView, ChannelOperationError> {
        let state = self
            .settlement_for_channel(channel_id)?
            .redeem(&ChannelId(channel_id.to_string()), claim)
            .await?;
        Ok(ChannelView::from(state))
    }

    /// Close `channel_id` (issue #459), on whichever chain the id itself
    /// names ([`Self::settlement_for_channel`]): no further funding or
    /// redemption is possible against it afterward.
    pub async fn close_channel(
        &self,
        channel_id: &str,
    ) -> Result<ChannelView, ChannelOperationError> {
        let state = self
            .settlement_for_channel(channel_id)?
            .close(&ChannelId(channel_id.to_string()))
            .await?;
        Ok(ChannelView::from(state))
    }

    /// Redeem the latest claim this node has accepted on `channel_id`
    /// (issue #425, story 36): looks up the highest-nonce claim this node
    /// has ever verified and accepted from that channel's counterparty --
    /// never a superseded one, since `ClaimBook` only ever retains the
    /// latest -- and submits exactly that one claim to the configured
    /// settlement backend. [`ChannelOperationError::NoClaimToRedeem`] if
    /// this channel has never had a claim accepted on it; a claim already
    /// fully redeemed reports [`SettlementError::StaleClaim`] through the
    /// backend rather than being treated as success here, so a failed
    /// submission never silently reports a stale channel state as if the
    /// redemption happened (leaving the channel's actual on-chain state
    /// the one place a caller need look to retry).
    pub async fn redeem_latest_claim(
        &self,
        channel_id: &str,
    ) -> Result<ChannelView, ChannelOperationError> {
        let claim = self
            .claims
            .latest_inbound_claim(channel_id)
            .ok_or(ChannelOperationError::NoClaimToRedeem)?;
        let state = self
            .settlement_for_channel(channel_id)?
            .redeem(&ChannelId(channel_id.to_string()), claim)
            .await?;
        Ok(ChannelView::from(state))
    }

    /// Cooperatively close `channel_id` (issue #425, story 37): redeem
    /// whatever claim this node last accepted on it, then close -- one
    /// operator-driven action rather than two, and no dispute window to
    /// wait out, since this port's own `close` is already terminal the
    /// instant it is called (`connector_settlement::SettlementBackend::close`'s
    /// own docs). A channel with no claim ever accepted closes directly,
    /// exactly like [`Connector::close_channel`]. A claim already fully
    /// redeemed (`SettlementError::StaleClaim`, or `StaleNonce` -- issue
    /// #573 -- for the same already-redeemed claim) is not a reason to
    /// refuse closing -- there is nothing left to collect -- but any other
    /// redemption failure stops here without closing, so a reverted or
    /// failed settlement transaction leaves the channel open and the claim
    /// still redeemable rather than closing over an unclaimed balance.
    pub async fn cooperative_close(
        &self,
        channel_id: &str,
    ) -> Result<ChannelView, ChannelOperationError> {
        let settlement = self.settlement_for_channel(channel_id)?;
        let id = ChannelId(channel_id.to_string());
        if let Some(claim) = self.claims.latest_inbound_claim(channel_id) {
            match settlement.redeem(&id, claim).await {
                Ok(_)
                | Err(SettlementError::StaleClaim { .. })
                | Err(SettlementError::StaleNonce { .. }) => {}
                Err(error) => return Err(error.into()),
            }
        }
        let state = settlement.close(&id).await?;
        Ok(ChannelView::from(state))
    }

    /// Claims exchanged with peers (issue #423), for the operator surface's
    /// read-only inspection interface.
    pub fn claims(&self) -> Vec<ClaimView> {
        self.claims.views()
    }

    /// Per-channel exposure (issue #424), for the operator surface's
    /// read-only inspection interface.
    pub fn exposure(&self) -> Vec<ExposureView> {
        self.claims.exposure_views()
    }

    /// Accept `candidate` as a genuine [`Fulfill`] only if its fulfillment
    /// verifies against `condition` (RFC-0022) -- the one check that
    /// prevents an intermediate hop (relaying a peer's answer) or a
    /// terminating one (relaying an app's) from producing a valid
    /// fulfilment without the destination's actual participation (issue
    /// #417). A candidate that fails to verify is a REJECT, never a
    /// fulfilment this connector invents itself.
    /// `price_on_reject` is what a mismatch reject's `accumulated_cost`
    /// carries: `0` from [`Self::forward_via_peer_route`], where this is
    /// checking a peer's own relayed fulfilment rather than anything this
    /// connector terminated; a terminated route's [`StaticRoute::price`]
    /// from [`Self::deliver_opened_envelope`], where reaching this check at
    /// all means the packet reached this connector's own termination
    /// (issue #545).
    fn accept_if_fulfilled(
        condition: &[u8; 32],
        candidate: Fulfill,
        price_on_reject: u64,
    ) -> PacketResponse {
        if fulfillment_matches_condition(condition, &candidate.fulfillment) {
            PacketResponse::Fulfill(candidate)
        } else {
            PacketResponse::Reject(Reject {
                code: RejectCode::f99_application_error(),
                triggered_by: String::new(),
                message: "fulfillment does not match execution condition".to_string(),
                data: Vec::new(),
                accumulated_cost: price_on_reject,
            })
        }
    }
}

fn leased_route_view(route: &LeasedRoute) -> LeasedRouteView {
    LeasedRouteView {
        prefix: route.prefix().to_string(),
        peer_id: route.peer_id().to_string(),
        fee: route.fee(),
        expires_at: route.expires_at(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_client::FakeAppClient;
    use crate::clock::TestClock;
    use crate::peer_transport::{InProcessPeerTransport, PeerTransport};
    use crate::test_support::{
        answered, answered_with_status, expected_fulfillment, fulfill_envelope,
        fulfill_envelope_with_status, identity_signer, matching_condition, open_sealed_envelope,
        sealed_envelope_request_data, sealed_envelope_request_data_with_target, sign_wire_claim,
        test_channel_domain, test_channel_id, with_test_channel,
    };
    use async_trait::async_trait;
    use chrono::{Duration, TimeZone, Utc};
    use connector_signer::derive_evm_address;

    /// Seals `data` and sets `execution_condition` to match the fulfilment
    /// its own (discarded) shared secret derives (ADR 0019, issue #525) --
    /// what a genuine sender does before ever transmitting a packet, so a
    /// plain `prepare()` call is, by construction, one that fulfils if it
    /// reaches an app that answers at all. A test that also needs the
    /// secret back (to open the sealed response, or assert the exact
    /// fulfilment) uses [`sealed_prepare`] instead.
    fn prepare(destination: &str, data: &[u8]) -> Prepare {
        // Comfortably after `test_clock()`'s instant, so tests that don't
        // care about expiry aren't incidentally right at the boundary.
        prepare_expiring_at(
            destination,
            data,
            Utc.with_ymd_and_hms(2031, 1, 1, 0, 0, 0).unwrap(),
        )
    }

    fn prepare_expiring_at(
        destination: &str,
        data: &[u8],
        expires_at: chrono::DateTime<Utc>,
    ) -> Prepare {
        let (data, shared_secret) = sealed_envelope_request_data(data);
        Prepare {
            amount: 0,
            expires_at,
            execution_condition: matching_condition(&shared_secret),
            destination: destination.to_string(),
            data,
        }
    }

    fn prepare_with_amount(destination: &str, amount: u64) -> Prepare {
        Prepare {
            amount,
            ..prepare(destination, b"hello")
        }
    }

    /// `prepare("g.example.app", ..)` with `data` overwritten by an
    /// already-sealed `data` -- every termination test in this module
    /// addresses `"g.example.app"` and only cares that `data` itself is
    /// shaped correctly, since `prepare()`'s own plaintext `data` never
    /// survives past this override. Because the substituted `data` carries
    /// its own, different shared secret than the one `prepare()` derived
    /// its `execution_condition` from, this deliberately produces a
    /// condition that does *not* match the fulfilment `data`'s own secret
    /// derives -- the shape a test wants when it needs a packet that opens
    /// and reaches the app, but should not fulfil (ADR 0019, issue #525).
    fn prepare_with_data(data: Vec<u8>) -> Prepare {
        Prepare {
            data,
            ..prepare("g.example.app", b"unused")
        }
    }

    /// A `Prepare` sealed to [`identity_signer`]'s identity and carrying
    /// `body` (issue #524), with `execution_condition` set to match the
    /// fulfilment this same sealed secret derives (ADR 0019, issue #525) --
    /// the common case for a test that drives `Connector::handle_prepare`
    /// directly rather than through the HTTP router and expects the packet
    /// to genuinely fulfil. Returns the shared secret alongside, to open
    /// the sealed `Fulfill`/termination-`Reject` this produces, or to
    /// compute the expected fulfilment via `expected_fulfillment`.
    fn sealed_prepare(body: &[u8]) -> (Prepare, [u8; 32]) {
        let (data, shared_secret) = sealed_envelope_request_data(body);
        let prepare = Prepare {
            data,
            execution_condition: matching_condition(&shared_secret),
            ..prepare("g.example.app", b"unused")
        };
        (prepare, shared_secret)
    }

    fn test_clock() -> Arc<TestClock> {
        Arc::new(TestClock::new(
            Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
        ))
    }

    fn connector_with(
        routes: Vec<StaticRoute>,
        app_client: Arc<FakeAppClient>,
        clock: Arc<TestClock>,
    ) -> Connector {
        Connector::new(
            routes,
            vec![],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            clock,
        )
        .with_identity_signer(identity_signer())
    }

    #[tokio::test]
    async fn delivers_a_packet_matching_a_terminated_route() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(route.handler_url(), answered(b"app said yes"));
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client.clone(), clock);
        let (sealed, shared_secret) = sealed_prepare(b"hello app");

        let response = connector.handle_prepare(sealed, 0).await;

        match response {
            PacketResponse::Fulfill(fulfill) => {
                assert_eq!(fulfill.fulfillment, expected_fulfillment(&shared_secret));
                assert_eq!(
                    open_sealed_envelope(&shared_secret, &fulfill.data),
                    fulfill_envelope(b"app said yes")
                );
            }
            other => panic!("expected a fulfill, got {other:?}"),
        }

        let deliveries = app_client.deliveries();
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].request.body, b"hello app");
    }

    #[tokio::test]
    async fn rejects_a_packet_with_no_matching_route() {
        let app_client = Arc::new(FakeAppClient::new());
        let clock = test_clock();
        let connector = connector_with(vec![], app_client.clone(), clock);

        let response = connector
            .handle_prepare(prepare("g.nowhere", b"hello"), 0)
            .await;

        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "F02");
                assert!(reject.message.contains("g.nowhere"));
            }
            other => panic!("expected a reject, got {other:?}"),
        }
        assert!(app_client.deliveries().is_empty());
    }

    #[tokio::test]
    async fn rejects_a_packet_with_no_execution_condition() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client.clone(), clock);

        let mut without_condition = prepare("g.example.app", b"hello");
        without_condition.execution_condition = [0u8; 32];
        let response = connector.handle_prepare(without_condition, 0).await;

        match response {
            PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "F01"),
            other => panic!("expected a reject, got {other:?}"),
        }
        assert!(app_client.deliveries().is_empty());
    }

    #[tokio::test]
    async fn rejects_a_packet_that_has_already_expired_and_never_delivers_it() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        let now = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();
        let clock = Arc::new(TestClock::new(now));
        let connector = connector_with(vec![route], app_client.clone(), clock);
        let already_expired =
            prepare_expiring_at("g.example.app", b"hello", now - Duration::seconds(1));

        let response = connector.handle_prepare(already_expired, 0).await;

        match response {
            PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "R00"),
            other => panic!("expected a reject, got {other:?}"),
        }
        // The in-flight record is released rather than handed to the app:
        // an expired packet never reaches delivery.
        assert!(app_client.deliveries().is_empty());
    }

    #[tokio::test]
    async fn a_packet_expires_only_once_the_injected_clock_advances_past_it() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(route.handler_url(), answered(b"still on time"));
        let start = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();
        let clock = Arc::new(TestClock::new(start));
        let connector = connector_with(vec![route], app_client.clone(), clock.clone());
        let expires_at = start + Duration::seconds(30);

        let response = connector
            .handle_prepare(
                prepare_expiring_at("g.example.app", b"hello", expires_at),
                0,
            )
            .await;
        assert!(matches!(response, PacketResponse::Fulfill(_)));

        clock.advance(Duration::seconds(30));
        let response = connector
            .handle_prepare(
                prepare_expiring_at("g.example.app", b"hello", expires_at),
                0,
            )
            .await;
        match response {
            PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "R00"),
            other => panic!("expected a reject once the clock reaches expiry, got {other:?}"),
        }
    }

    /// ADR 0019/issue #525: the app supplies nothing toward fulfilment --
    /// the fulfilment is derived from the packet's own sealed secret, so
    /// what decides a `Fulfill` vs a `Reject` is entirely whether the
    /// sender minted `execution_condition` from that same secret.
    /// `prepare_with_data` deliberately builds a genuinely-sealed, genuinely
    /// deliverable packet whose condition was *not* derived from its own
    /// secret (the mismatch [`Self::accept_if_fulfilled`] exists to catch),
    /// checked the same way every hop checks a fulfilment.
    #[tokio::test]
    async fn a_condition_not_derived_from_its_own_sealed_secret_is_rejected_even_though_the_app_answered(
    ) {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(route.handler_url(), answered(b"app said yes"));
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client.clone(), clock);
        let (data, _shared_secret) = sealed_envelope_request_data(b"hello");

        let response = connector.handle_prepare(prepare_with_data(data), 0).await;

        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "F99");
                assert!(reject.message.contains("execution condition"));
            }
            other => panic!("expected a reject, got {other:?}"),
        }
        // The app was genuinely reached -- this is not a delivery failure,
        // only a fulfilment one.
        assert_eq!(app_client.deliveries().len(), 1);
    }

    /// Issue #521's central rule (ADR 0020): "you pay for an answer, not
    /// the answer you wanted." A 404 is a real answer that consumed real
    /// work, so it fulfils exactly like a 200 does -- rejecting on a
    /// non-2xx would make app errors free.
    #[tokio::test]
    async fn a_non_2xx_response_from_the_app_still_fulfils() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            answered_with_status(402, b"insufficient funds"),
        );
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client, clock);
        let (sealed, shared_secret) = sealed_prepare(b"hello");

        let response = connector.handle_prepare(sealed, 0).await;

        match response {
            PacketResponse::Fulfill(fulfill) => {
                assert_eq!(fulfill.fulfillment, expected_fulfillment(&shared_secret));
                assert_eq!(
                    open_sealed_envelope(&shared_secret, &fulfill.data),
                    fulfill_envelope_with_status(402, b"insufficient funds")
                );
            }
            other => panic!("expected a fulfill, got {other:?}"),
        }
    }

    /// The other half of the same rule stated negatively: a non-2xx
    /// response is not itself what causes a reject -- a mismatched
    /// condition (issue #525) still does, exactly as it would for a 200.
    #[tokio::test]
    async fn a_non_2xx_response_still_rejects_for_a_mismatched_condition() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            answered_with_status(402, b"insufficient funds"),
        );
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client.clone(), clock);
        let (data, _shared_secret) = sealed_envelope_request_data(b"hello");

        let response = connector.handle_prepare(prepare_with_data(data), 0).await;

        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "F99");
                assert!(reject.message.contains("execution condition"));
            }
            other => panic!("expected a reject, got {other:?}"),
        }
        assert_eq!(app_client.deliveries().len(), 1);
    }

    #[tokio::test]
    async fn an_unreachable_app_produces_a_peer_unreachable_reject() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        // No FakeAppClient::respond call: the fake defaults to Unreachable.
        let app_client = Arc::new(FakeAppClient::new());
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client, clock);

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        match response {
            PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "T01"),
            other => panic!("expected a reject, got {other:?}"),
        }
    }

    // `uses_the_injected_clock_rather_than_wall_time`, which lived here,
    // asserted that a `received_at` timestamp derived from the injected
    // clock reached the app client. Issue #521 removes that timestamp
    // entirely: the connector now makes exactly the request the envelope
    // describes (AC1), with no header of its own added, so there is
    // nothing left for this test to observe. The injected clock's effect
    // on expiry is unchanged and still covered by
    // `a_packet_expires_only_once_the_injected_clock_advances_past_it`.

    #[tokio::test]
    async fn selects_the_most_specific_route_when_several_match() {
        let general = StaticRoute::new("g.example", "http://localhost:4000").unwrap();
        let specific = StaticRoute::new("g.example.app", "http://localhost:5000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(specific.handler_url(), answered(b""));
        let clock = test_clock();
        let connector = connector_with(vec![general, specific.clone()], app_client.clone(), clock);

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        assert!(matches!(response, PacketResponse::Fulfill(_)));
        assert_eq!(
            app_client.deliveries()[0].handler_url,
            *specific.handler_url()
        );
    }

    #[tokio::test]
    async fn forwards_a_packet_matching_a_peer_route_to_the_next_hop() {
        let second_hop_route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let second_hop_app_client = Arc::new(FakeAppClient::new());
        second_hop_app_client.respond(
            second_hop_route.handler_url(),
            answered(b"delivered by the second hop"),
        );
        let second_hop = Arc::new(
            Connector::new(
                vec![second_hop_route],
                vec![],
                second_hop_app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_identity_signer(identity_signer()),
        );
        let mut peer_transport = InProcessPeerTransport::new();
        peer_transport.add_peer("second-hop", second_hop);
        let first_hop = Connector::new(
            vec![],
            vec![PeerRoute::new("g.example.app", "second-hop", 0)],
            Arc::new(FakeAppClient::new()),
            Arc::new(peer_transport),
            test_clock(),
        );
        let (sealed, shared_secret) = sealed_prepare(b"hello");

        let response = first_hop.handle_prepare(sealed, 0).await;

        match response {
            PacketResponse::Fulfill(fulfill) => {
                assert_eq!(fulfill.fulfillment, expected_fulfillment(&shared_secret));
                assert_eq!(
                    open_sealed_envelope(&shared_secret, &fulfill.data),
                    fulfill_envelope(b"delivered by the second hop")
                );
            }
            other => panic!("expected a fulfill, got {other:?}"),
        }
        assert_eq!(second_hop_app_client.deliveries().len(), 1);
    }

    #[tokio::test]
    async fn forwarding_to_a_peer_subtracts_that_relations_flat_fee() {
        use connector_signer::{LocalSigner, Signer};

        let second_hop_route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let second_hop_app_client = Arc::new(FakeAppClient::new());
        second_hop_app_client.respond(
            second_hop_route.handler_url(),
            answered(b"delivered by the second hop"),
        );
        let payer_signer = LocalSigner::generate("payer-claim-key");
        let payer_address = derive_evm_address(&payer_signer.public_key().unwrap());
        let second_hop = Arc::new(with_test_channel(
            Connector::new(
                vec![second_hop_route],
                vec![],
                second_hop_app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_identity_signer(identity_signer()),
            1,
            payer_address,
        ));
        let mut peer_transport = InProcessPeerTransport::new();
        peer_transport.add_peer("second-hop", second_hop);
        peer_transport.set_peer_channel("second-hop", test_channel_id(1));
        let first_hop = Connector::new(
            vec![],
            vec![PeerRoute::new("g.example.app", "second-hop", 7)],
            Arc::new(FakeAppClient::new()),
            Arc::new(peer_transport),
            test_clock(),
        )
        .with_signer(Arc::new(payer_signer))
        .with_peer_claim_channel("second-hop", test_channel_id(1))
        .with_channel_domain(test_channel_id(1), test_channel_domain())
        .unwrap();

        let response = first_hop
            .handle_prepare(prepare_with_amount("g.example.app", 100), 0)
            .await;

        assert!(matches!(response, PacketResponse::Fulfill(_)));
        // The port never sees a `Prepare` (issue #521), so the forwarded
        // amount is asserted through the claim it armed rather than
        // through the app client -- 100 minus this peer relationship's
        // flat fee of 7.
        assert_eq!(second_hop_app_client.deliveries().len(), 1);
        assert_eq!(first_hop.claims()[0].cumulative_amount, 93);
    }

    #[tokio::test]
    async fn a_hop_that_cannot_meet_the_minimum_delivery_after_its_fee_rejects_without_forwarding()
    {
        let second_hop_route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let second_hop_app_client = Arc::new(FakeAppClient::new());
        second_hop_app_client.respond(second_hop_route.handler_url(), answered(b""));
        let second_hop = Arc::new(Connector::new(
            vec![second_hop_route],
            vec![],
            second_hop_app_client.clone(),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let mut peer_transport = InProcessPeerTransport::new();
        peer_transport.add_peer("second-hop", second_hop);
        let first_hop = Connector::new(
            vec![],
            vec![PeerRoute::new("g.example.app", "second-hop", 10)],
            Arc::new(FakeAppClient::new()),
            Arc::new(peer_transport),
            test_clock(),
        );

        // amount 100, fee 10 -> would forward 90, but the sender declared
        // a minimum delivery of 95: this hop must reject rather than
        // forward the smaller amount.
        let response = first_hop
            .handle_prepare(prepare_with_amount("g.example.app", 100), 95)
            .await;

        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "R01");
                assert!(reject.message.contains("95"));
            }
            other => panic!("expected a reject, got {other:?}"),
        }
        // Never forwarded a smaller amount hoping the far end would cope.
        assert!(second_hop_app_client.deliveries().is_empty());
    }

    #[tokio::test]
    async fn a_reject_from_the_next_hop_is_relayed_to_the_original_caller() {
        let second_hop = Arc::new(Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let mut peer_transport = InProcessPeerTransport::new();
        peer_transport.add_peer("second-hop", second_hop);
        let first_hop = Connector::new(
            vec![],
            vec![PeerRoute::new("g.example.app", "second-hop", 0)],
            Arc::new(FakeAppClient::new()),
            Arc::new(peer_transport),
            test_clock(),
        );

        let response = first_hop
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "F02");
                assert!(reject.message.contains("g.example.app"));
            }
            other => panic!("expected a reject, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_terminated_route_wins_over_a_shorter_peer_route() {
        let peer_route = PeerRoute::new("g.example", "second-hop", 0);
        let terminated_route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(terminated_route.handler_url(), answered(b"handled locally"));
        let connector = Connector::new(
            vec![terminated_route],
            vec![peer_route],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        )
        .with_identity_signer(identity_signer());
        let (sealed, shared_secret) = sealed_prepare(b"hello");

        let response = connector.handle_prepare(sealed, 0).await;

        match response {
            PacketResponse::Fulfill(fulfill) => {
                assert_eq!(fulfill.fulfillment, expected_fulfillment(&shared_secret));
                assert_eq!(
                    open_sealed_envelope(&shared_secret, &fulfill.data),
                    fulfill_envelope(b"handled locally")
                );
            }
            other => panic!("expected a fulfill, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_peer_route_wins_over_a_shorter_terminated_route() {
        let terminated_route = StaticRoute::new("g.example", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        let second_hop_route = StaticRoute::new("g.example.app", "http://localhost:5000").unwrap();
        let second_hop_app_client = Arc::new(FakeAppClient::new());
        second_hop_app_client.respond(
            second_hop_route.handler_url(),
            answered(b"handled by the second hop"),
        );
        let second_hop = Arc::new(
            Connector::new(
                vec![second_hop_route],
                vec![],
                second_hop_app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_identity_signer(identity_signer()),
        );
        let mut peer_transport = InProcessPeerTransport::new();
        peer_transport.add_peer("second-hop", second_hop);
        let first_hop = Connector::new(
            vec![terminated_route],
            vec![PeerRoute::new("g.example.app", "second-hop", 0)],
            app_client,
            Arc::new(peer_transport),
            test_clock(),
        );
        let (sealed, shared_secret) = sealed_prepare(b"hello");

        let response = first_hop.handle_prepare(sealed, 0).await;

        match response {
            PacketResponse::Fulfill(fulfill) => {
                assert_eq!(fulfill.fulfillment, expected_fulfillment(&shared_secret));
                assert_eq!(
                    open_sealed_envelope(&shared_secret, &fulfill.data),
                    fulfill_envelope(b"handled by the second hop")
                );
            }
            other => panic!("expected a fulfill, got {other:?}"),
        }
        assert_eq!(second_hop_app_client.deliveries().len(), 1);
    }

    #[test]
    fn routes_reports_every_configured_static_route() {
        let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 25).unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client, clock);

        let routes = connector.routes();

        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].prefix, "g.example.app");
        assert_eq!(routes[0].handler_url, "http://localhost:4000/");
        assert_eq!(routes[0].price, 25);
    }

    #[test]
    fn app_route_price_reports_the_matched_routes_price() {
        let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 25).unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client, clock);

        assert_eq!(connector.app_route_price("g.example.app"), Some(25));
        assert_eq!(connector.app_route_price("g.example.app.sub"), Some(25));
        assert_eq!(connector.app_route_price("g.nowhere"), None);
    }

    /// Issue #701: the client edge's two carriages ask
    /// `app_route_transport_policy` the same way they already ask
    /// `app_route_price`, so it needs the same longest-prefix matching and
    /// the same `None`-for-unmatched behavior.
    #[test]
    fn app_route_transport_policy_reports_the_matched_routes_policy() {
        let route = StaticRoute::new_priced_with_transport(
            "g.example.relay",
            "http://localhost:4000",
            25,
            TransportPolicy::Btp,
        )
        .unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client, clock);

        assert_eq!(
            connector.app_route_transport_policy("g.example.relay"),
            Some(TransportPolicy::Btp)
        );
        assert_eq!(
            connector.app_route_transport_policy("g.example.relay.sub"),
            Some(TransportPolicy::Btp)
        );
        assert_eq!(connector.app_route_transport_policy("g.nowhere"), None);
    }

    /// A route that never set `transport` reports the default -- both
    /// transports accepted -- through the same accessor.
    #[test]
    fn app_route_transport_policy_defaults_to_both() {
        let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 25).unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client, clock);

        assert_eq!(
            connector.app_route_transport_policy("g.example.app"),
            Some(TransportPolicy::Both)
        );
    }

    #[tokio::test]
    async fn handle_prepare_records_a_fulfill_in_metrics() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(route.handler_url(), answered(b""));
        let connector = connector_with(vec![route], app_client, test_clock());

        connector
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        let metrics = connector.metrics().encode();
        assert!(metrics.contains(r#"toon_packets_total{outcome="fulfill"} 1"#));
    }

    #[tokio::test]
    async fn handle_prepare_records_a_reject_by_code_in_metrics() {
        let app_client = Arc::new(FakeAppClient::new());
        let connector = connector_with(vec![], app_client, test_clock());

        connector
            .handle_prepare(prepare("g.nowhere", b"hello"), 0)
            .await;

        let metrics = connector.metrics().encode();
        assert!(metrics.contains(r#"toon_packets_total{outcome="reject"} 1"#));
        assert!(metrics.contains(r#"toon_packets_rejected_total{code="F02"} 1"#));
    }

    #[tokio::test]
    async fn forwarding_to_a_peer_records_the_earned_fee_only_on_fulfilment() {
        let second_hop_route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let second_hop_app_client = Arc::new(FakeAppClient::new());
        second_hop_app_client.respond(second_hop_route.handler_url(), answered(b""));
        let second_hop = Arc::new(
            Connector::new(
                vec![second_hop_route],
                vec![],
                second_hop_app_client,
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_identity_signer(identity_signer()),
        );
        let mut peer_transport = InProcessPeerTransport::new();
        peer_transport.add_peer("second-hop", second_hop);
        let first_hop = Connector::new(
            vec![],
            vec![PeerRoute::new("g.example.app", "second-hop", 7)],
            Arc::new(FakeAppClient::new()),
            Arc::new(peer_transport),
            test_clock(),
        );

        first_hop
            .handle_prepare(prepare_with_amount("g.example.app", 100), 0)
            .await;

        let metrics = first_hop.metrics().encode();
        assert!(metrics.contains("toon_fees_earned_total 7"));
    }

    /// Issue #427: a controller outside this connector pushes a route to a
    /// peer with a time limit, and it forwards exactly like a
    /// configuration-sourced peer route until that limit is reached.
    #[tokio::test]
    async fn a_leased_route_forwards_to_its_peer_before_it_lapses() {
        let second_hop_route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let second_hop_app_client = Arc::new(FakeAppClient::new());
        second_hop_app_client.respond(
            second_hop_route.handler_url(),
            answered(b"delivered by the second hop"),
        );
        let second_hop = Arc::new(
            Connector::new(
                vec![second_hop_route],
                vec![],
                second_hop_app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_identity_signer(identity_signer()),
        );
        let mut peer_transport = InProcessPeerTransport::new();
        peer_transport.add_peer("second-hop", second_hop);
        let clock = test_clock();
        let first_hop = Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(peer_transport),
            clock.clone(),
        );
        first_hop
            .upsert_leased_route("g.example.app", "second-hop", 0, Duration::seconds(60))
            .unwrap();
        let (sealed, shared_secret) = sealed_prepare(b"hello");

        let response = first_hop.handle_prepare(sealed, 0).await;

        match response {
            PacketResponse::Fulfill(fulfill) => {
                assert_eq!(fulfill.fulfillment, expected_fulfillment(&shared_secret));
                assert_eq!(
                    open_sealed_envelope(&shared_secret, &fulfill.data),
                    fulfill_envelope(b"delivered by the second hop")
                );
            }
            other => panic!("expected a fulfill, got {other:?}"),
        }
        assert_eq!(second_hop_app_client.deliveries().len(), 1);
    }

    /// AC: "A lapsed route stops being selected immediately, with no sweep
    /// delay observable to a sender" -- there is no background task here;
    /// expiry is decided fresh on every call against the injected clock.
    #[tokio::test]
    async fn a_lapsed_leased_route_stops_being_selected_immediately() {
        let clock = test_clock();
        let first_hop = Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            clock.clone(),
        );
        first_hop
            .upsert_leased_route("g.example.app", "second-hop", 0, Duration::seconds(60))
            .unwrap();

        // Still active a moment before its limit.
        clock.advance(Duration::seconds(59));
        let response = first_hop
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;
        match response {
            PacketResponse::Reject(reject) => {
                // second-hop is unregistered on this transport, so a
                // successful *selection* still surfaces as a peer-transport
                // reject rather than F02 (no route) -- proving the route
                // was matched at all, not skipped.
                assert_ne!(reject.code.as_str(), "F02");
            }
            other => panic!("expected some reject, got {other:?}"),
        }

        // One second later, the lease has lapsed -- selected no longer.
        clock.advance(Duration::seconds(1));
        let response = first_hop
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;
        match response {
            PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "F02"),
            other => panic!("expected a reject once the lease lapses, got {other:?}"),
        }
    }

    /// AC: "A leased route lapses unless renewed before its limit expires"
    /// / "A controller that stops renewing causes routes to lapse rather
    /// than persist" -- renewing before the original limit extends it past
    /// where it would otherwise have lapsed.
    #[tokio::test]
    async fn renewing_a_leased_route_before_it_lapses_keeps_it_active() {
        let clock = test_clock();
        let first_hop = Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            clock.clone(),
        );
        first_hop
            .upsert_leased_route("g.example.app", "second-hop", 0, Duration::seconds(60))
            .unwrap();

        clock.advance(Duration::seconds(30));
        first_hop
            .upsert_leased_route("g.example.app", "second-hop", 0, Duration::seconds(60))
            .unwrap();

        // Past the *original* lease's limit (60s from the start), but well
        // within the renewed one (60s from the 30s renewal).
        clock.advance(Duration::seconds(40));
        let response = first_hop
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;
        match response {
            PacketResponse::Reject(reject) => assert_ne!(reject.code.as_str(), "F02"),
            other => panic!("expected some reject, got {other:?}"),
        }
    }

    /// AC: "A static route always outranks a leased route for the same
    /// prefix" -- an operator's explicit configuration cannot be
    /// overridden by an automated controller.
    #[tokio::test]
    async fn a_static_route_always_outranks_a_leased_route_for_the_same_prefix() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(route.handler_url(), answered(b"handled locally"));
        let clock = test_clock();
        let connector = Connector::new(
            vec![route],
            vec![],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            clock,
        )
        .with_identity_signer(identity_signer());
        connector
            .upsert_leased_route("g.example.app", "second-hop", 0, Duration::seconds(60))
            .unwrap();
        let (sealed, shared_secret) = sealed_prepare(b"hello");

        let response = connector.handle_prepare(sealed, 0).await;

        match response {
            PacketResponse::Fulfill(fulfill) => {
                assert_eq!(fulfill.fulfillment, expected_fulfillment(&shared_secret));
                assert_eq!(
                    open_sealed_envelope(&shared_secret, &fulfill.data),
                    fulfill_envelope(b"handled locally")
                );
            }
            other => panic!("expected a fulfill, got {other:?}"),
        }
    }

    /// AC: "Static routes survive a restart; leased routes do not" -- a
    /// leased route lives only in the `Connector` instance it was pushed
    /// to, never in configuration, so a freshly constructed instance
    /// (standing in for "after a restart") never has it.
    #[test]
    fn leased_routes_do_not_survive_a_restart() {
        let clock = test_clock();
        let before_restart = Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            clock.clone(),
        );
        before_restart
            .upsert_leased_route("g.example.app", "second-hop", 0, Duration::seconds(60))
            .unwrap();
        assert_eq!(before_restart.leased_routes().len(), 1);

        let after_restart = Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            clock,
        );
        assert!(after_restart.leased_routes().is_empty());
    }

    #[test]
    fn leased_routes_reports_only_currently_active_leases() {
        let clock = test_clock();
        let connector = Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            clock.clone(),
        );
        connector
            .upsert_leased_route("g.example.app", "second-hop", 3, Duration::seconds(60))
            .unwrap();

        let leases = connector.leased_routes();
        assert_eq!(leases.len(), 1);
        assert_eq!(leases[0].prefix, "g.example.app");
        assert_eq!(leases[0].peer_id, "second-hop");
        assert_eq!(leases[0].fee, 3);

        clock.advance(Duration::seconds(60));
        assert!(connector.leased_routes().is_empty());
    }

    #[test]
    fn upsert_leased_route_rejects_an_invalid_prefix() {
        let clock = test_clock();
        let connector = Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            clock,
        );

        let result =
            connector.upsert_leased_route("g..app", "second-hop", 0, Duration::seconds(60));

        assert!(matches!(result, Err(LeaseRouteError::InvalidPrefix(_))));
        assert!(connector.leased_routes().is_empty());
    }

    #[tokio::test]
    async fn peers_are_empty_until_416_lands_and_channels_claims_and_exposure_are_empty_with_nothing_configured(
    ) {
        let app_client = Arc::new(FakeAppClient::new());
        let clock = test_clock();
        let connector = connector_with(vec![], app_client, clock);

        // `peers()` is always empty: the peer wire has no identity
        // handshake yet (#416).
        assert!(connector.peers().is_empty());
        assert!(connector.channels().await.is_empty());
        // No signer, peer claim channel or ceiling configured, and no
        // traffic sent: nothing to report. `claims()`/`exposure()`
        // reporting real state once claims/exposure exist is covered by
        // the `emits_...`/`records_...`/`exposure`-suffixed tests below.
        assert!(connector.claims().is_empty());
        assert!(connector.exposure().is_empty());
    }

    /// A peer that answers with a fulfillment not matching the packet's
    /// execution condition cannot get its answer relayed as-is: an
    /// intermediate hop must verify a downstream fulfilment rather than
    /// trust it, per issue #417's "cannot produce a valid fulfilment
    /// without the destination's participation."
    struct FixedResponsePeerTransport(PacketResponse);

    #[async_trait]
    impl PeerTransport for FixedResponsePeerTransport {
        async fn forward(
            &self,
            _peer_id: &str,
            _prepare: Prepare,
            _minimum_delivery: u64,
            _claim: Option<WireClaim>,
        ) -> (PacketResponse, ClaimAckOutcome, bool) {
            (self.0.clone(), ClaimAckOutcome::NotSent, true)
        }

        async fn flush(&self, _peer_id: &str, _claim: WireClaim) -> ClaimAckOutcome {
            ClaimAckOutcome::NotSent
        }
    }

    #[tokio::test]
    async fn a_fulfillment_from_a_peer_that_does_not_match_the_execution_condition_is_rejected() {
        let bogus_fulfillment = [9u8; 32]; // does not hash to `prepare()`'s own condition
        let peer_transport = FixedResponsePeerTransport(PacketResponse::Fulfill(Fulfill {
            fulfillment: bogus_fulfillment,
            data: b"claimed delivery".to_vec(),
        }));
        let connector = Connector::new(
            vec![],
            vec![PeerRoute::new("g.example.app", "second-hop", 0)],
            Arc::new(FakeAppClient::new()),
            Arc::new(peer_transport),
            test_clock(),
        );

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        match response {
            PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "F99"),
            other => panic!("expected a reject, got {other:?}"),
        }
    }

    /// Issue #423's acceptance criteria, exercised end to end through
    /// `handle_prepare` over an in-process peer transport rather than at
    /// the `ClaimBook` unit level: a fulfilled forward arms a claim; it
    /// rides the *next* packet to that peer, where it is verified and
    /// advances the watermark; and each fulfilment produces its own claim
    /// rather than a batch.
    mod claim_exchange {
        use super::*;
        use crate::operator_view::ClaimDirection;
        use connector_signer::{LocalSigner, Signer};

        fn two_hop_setup() -> (Connector, Arc<Connector>, Arc<FakeAppClient>, url::Url) {
            let second_hop_route =
                StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let handler_url = second_hop_route.handler_url().clone();
            let second_hop_app_client = Arc::new(FakeAppClient::new());
            second_hop_app_client.respond(&handler_url, answered(b""));
            let payer_signer = LocalSigner::generate("payer-claim-key");
            let payer_address = derive_evm_address(&payer_signer.public_key().unwrap());
            let second_hop = Arc::new(with_test_channel(
                Connector::new(
                    vec![second_hop_route],
                    vec![],
                    second_hop_app_client.clone(),
                    Arc::new(InProcessPeerTransport::new()),
                    test_clock(),
                )
                .with_identity_signer(identity_signer()),
                1,
                payer_address,
            ));
            let mut peer_transport = InProcessPeerTransport::new();
            peer_transport.add_peer("second-hop", second_hop.clone());
            // Standing in for the identity a real peer-wire handshake would
            // establish (#416, not yet built): without this, the link only
            // learns the channel once a claim first rides a frame, so the
            // very first delivery would go unrecorded (issue #424).
            peer_transport.set_peer_channel("second-hop", test_channel_id(1));
            let first_hop = Connector::new(
                vec![],
                vec![PeerRoute::new("g.example.app", "second-hop", 0)],
                Arc::new(FakeAppClient::new()),
                Arc::new(peer_transport),
                test_clock(),
            )
            .with_signer(Arc::new(payer_signer))
            .with_peer_claim_channel("second-hop", test_channel_id(1))
            .with_channel_domain(test_channel_id(1), test_channel_domain())
            .unwrap();
            (first_hop, second_hop, second_hop_app_client, handler_url)
        }

        #[tokio::test]
        async fn a_fulfilled_forward_arms_a_claim_and_the_next_fulfilled_forward_carries_it_to_the_peer(
        ) {
            let (first_hop, second_hop, _app, _handler_url) = two_hop_setup();

            let first = first_hop
                .handle_prepare(prepare_with_amount("g.example.app", 100), 0)
                .await;
            assert!(matches!(first, PacketResponse::Fulfill(_)));

            // Armed by the first fulfilment, but not yet sent anywhere --
            // nothing has gone out to the peer since it armed.
            let claims = first_hop.claims();
            assert_eq!(claims.len(), 1);
            assert_eq!(claims[0].peer_id, Some("second-hop".to_string()));
            assert_eq!(claims[0].direction, ClaimDirection::Outbound);
            assert_eq!(claims[0].nonce, 1);
            assert_eq!(claims[0].cumulative_amount, 100);
            assert!(claims[0].pending);
            assert!(second_hop.claims().is_empty());

            let second = first_hop
                .handle_prepare(prepare_with_amount("g.example.app", 50), 0)
                .await;
            assert!(matches!(second, PacketResponse::Fulfill(_)));

            // The second forward carried the first claim to the peer, who
            // verified it and advanced its watermark -- and the second
            // fulfilment armed its own fresh claim behind it.
            let peer_claims = second_hop.claims();
            assert_eq!(peer_claims.len(), 1);
            assert_eq!(peer_claims[0].peer_id, None);
            assert_eq!(peer_claims[0].direction, ClaimDirection::Inbound);
            assert_eq!(peer_claims[0].channel_id, test_channel_id(1));
            assert_eq!(peer_claims[0].nonce, 1);
            assert_eq!(peer_claims[0].cumulative_amount, 100);

            let claims = first_hop.claims();
            assert_eq!(claims.len(), 1);
            assert_eq!(claims[0].nonce, 2);
            assert_eq!(claims[0].cumulative_amount, 150);
            assert!(claims[0].pending);
        }

        #[tokio::test]
        async fn no_claim_is_emitted_for_a_rejected_packet() {
            let (first_hop, _second_hop, app_client, handler_url) = two_hop_setup();
            // A non-2xx response still answers -- what actually rejects
            // this packet is a condition that was not derived from its own
            // sealed secret (issue #525), not the app's status.
            app_client.respond(&handler_url, answered_with_status(402, b""));
            let (data, _shared_secret) = sealed_envelope_request_data(b"hello");
            let mismatched = Prepare {
                amount: 100,
                ..prepare_with_data(data)
            };

            let response = first_hop.handle_prepare(mismatched, 0).await;

            assert!(matches!(response, PacketResponse::Reject(_)));
            assert!(first_hop.claims().is_empty());
        }

        #[tokio::test]
        async fn no_claim_is_emitted_for_an_already_expired_packet() {
            let (first_hop, _second_hop, _app, _handler_url) = two_hop_setup();
            let already_expired = prepare_expiring_at(
                "g.example.app",
                b"hello",
                Utc.with_ymd_and_hms(2029, 1, 1, 0, 0, 0).unwrap(),
            );

            let response = first_hop.handle_prepare(already_expired, 0).await;

            match response {
                PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "R00"),
                other => panic!("expected a reject, got {other:?}"),
            }
            assert!(first_hop.claims().is_empty());
        }

        /// Peer-wire-spec.md §3.3: a flush sends a claim that would
        /// otherwise have waited to ride the next packet -- the mechanism
        /// that covers traffic stopping.
        #[tokio::test]
        async fn sweep_flush_sends_a_claim_that_has_no_packet_to_ride() {
            let (first_hop, second_hop, _app, _handler_url) = two_hop_setup();
            first_hop
                .handle_prepare(prepare_with_amount("g.example.app", 100), 0)
                .await;
            assert!(first_hop.claims()[0].pending);
            assert!(second_hop.claims().is_empty());

            first_hop.sweep_flush(Duration::seconds(0)).await;

            assert!(second_hop.claims()[0].nonce == 1);
            assert_eq!(second_hop.claims()[0].cumulative_amount, 100);
            // Acknowledged by the flush: no longer pending.
            assert!(!first_hop.claims()[0].pending);
        }

        #[tokio::test]
        async fn sweep_flush_does_nothing_before_the_flush_interval_elapses() {
            let (first_hop, second_hop, _app, _handler_url) = two_hop_setup();
            first_hop
                .handle_prepare(prepare_with_amount("g.example.app", 100), 0)
                .await;

            first_hop.sweep_flush(Duration::seconds(60)).await;

            assert!(second_hop.claims().is_empty());
            assert!(first_hop.claims()[0].pending);
        }
    }

    /// Issue #424, peer-wire-spec.md §5.3: a peer whose exposure exceeds
    /// its configured ceiling stops being forwarded for.
    mod exposure_and_ceiling {
        use super::*;
        use connector_signer::LocalSigner;

        /// Exactly `claim_exchange::two_hop_setup`, but `second_hop`
        /// enforces a ceiling of `ceiling` on the channel `first_hop`
        /// claims against when it owes `second_hop` -- so `second_hop`'s
        /// own exposure to `first_hop` is what gets bounded. Also returns
        /// the payer's own signer, so a test can sign a claim on that
        /// channel directly without going through `first_hop`.
        fn two_hop_setup_with_ceiling(
            ceiling: u64,
        ) -> (
            Connector,
            Arc<Connector>,
            Arc<FakeAppClient>,
            Arc<LocalSigner>,
        ) {
            let second_hop_route =
                StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let handler_url = second_hop_route.handler_url().clone();
            let second_hop_app_client = Arc::new(FakeAppClient::new());
            second_hop_app_client.respond(&handler_url, answered(b""));
            let payer_signer = Arc::new(LocalSigner::generate("payer-claim-key"));
            let payer_address = derive_evm_address(&payer_signer.public_key().unwrap());
            let second_hop = Arc::new(with_test_channel(
                Connector::new(
                    vec![second_hop_route],
                    vec![],
                    second_hop_app_client.clone(),
                    Arc::new(InProcessPeerTransport::new()),
                    test_clock(),
                )
                .with_channel_ceiling(test_channel_id(1), ceiling)
                .with_identity_signer(identity_signer()),
                1,
                payer_address,
            ));
            let mut peer_transport = InProcessPeerTransport::new();
            peer_transport.add_peer("second-hop", second_hop.clone());
            peer_transport.set_peer_channel("second-hop", test_channel_id(1));
            let first_hop = Connector::new(
                vec![],
                vec![PeerRoute::new("g.example.app", "second-hop", 0)],
                Arc::new(FakeAppClient::new()),
                Arc::new(peer_transport),
                test_clock(),
            )
            .with_signer(payer_signer.clone())
            .with_peer_claim_channel("second-hop", test_channel_id(1))
            .with_channel_domain(test_channel_id(1), test_channel_domain())
            .unwrap();
            (first_hop, second_hop, second_hop_app_client, payer_signer)
        }

        #[tokio::test]
        async fn deliveries_within_the_ceiling_are_forwarded_and_recorded_as_exposure() {
            let (first_hop, second_hop, _app, _payer_signer) = two_hop_setup_with_ceiling(100);

            let response = first_hop
                .handle_prepare(prepare_with_amount("g.example.app", 60), 0)
                .await;

            assert!(matches!(response, PacketResponse::Fulfill(_)));
            let exposure = second_hop.exposure();
            assert_eq!(exposure.len(), 1);
            assert_eq!(exposure[0].channel_id, test_channel_id(1));
            assert_eq!(exposure[0].exposure, 60);
            assert_eq!(exposure[0].ceiling, Some(100));
            assert!(!exposure[0].over_ceiling);
        }

        /// The full two-hop path naturally piggybacks each fulfilment's own
        /// claim on the very next PREPARE (peer-wire-spec.md §3.2), which
        /// keeps steady-state exposure at roughly one packet -- exactly
        /// `CONTEXT.md`'s "Exposure" definition, and exactly why the
        /// ceiling matters only once a payer "has fulfilled packets and
        /// stopped claiming". These two tests drive `second_hop` directly
        /// through [`Connector::handle_peer_prepare`], simulating that
        /// exact scenario -- fulfilments with no claim ever riding -- which
        /// the full piggyback path in `two_hop_setup_with_ceiling` cannot
        /// produce on its own.
        #[tokio::test]
        async fn a_peer_whose_exposure_exceeds_its_ceiling_stops_being_forwarded_for() {
            let (_first_hop, second_hop, app, _payer_signer) = two_hop_setup_with_ceiling(100);

            let first = second_hop
                .handle_peer_prepare(
                    prepare_with_amount("g.example.app", 60),
                    0,
                    None,
                    Some(test_channel_id(1)),
                )
                .await
                .0;
            assert!(matches!(first, PacketResponse::Fulfill(_)));

            let second = second_hop
                .handle_peer_prepare(
                    prepare_with_amount("g.example.app", 60),
                    0,
                    None,
                    Some(test_channel_id(1)),
                )
                .await
                .0;
            assert!(matches!(second, PacketResponse::Fulfill(_)));
            // Exposure is now 120, over the configured ceiling of 100 --
            // neither delivery carried a claim to cover the other.
            assert!(second_hop.exposure()[0].over_ceiling);
            assert_eq!(second_hop.exposure()[0].exposure, 120);

            // A third PREPARE over the same channel is refused before it
            // ever reaches second_hop's own app -- not merely answered
            // with a reject after being routed.
            let third = second_hop
                .handle_peer_prepare(
                    prepare_with_amount("g.example.app", 1),
                    0,
                    None,
                    Some(test_channel_id(1)),
                )
                .await
                .0;
            match third {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "T04");
                }
                other => panic!("expected a T04 reject, got {other:?}"),
            }
            assert_eq!(app.deliveries().len(), 2);
            // The ceiling reject did not itself change exposure.
            assert_eq!(second_hop.exposure()[0].exposure, 120);
        }

        #[tokio::test]
        async fn an_accepted_claim_covering_the_exposure_lets_forwarding_resume() {
            let (_first_hop, second_hop, app, payer_signer) = two_hop_setup_with_ceiling(100);
            for amount in [60u64, 60u64] {
                let response = second_hop
                    .handle_peer_prepare(
                        prepare_with_amount("g.example.app", amount),
                        0,
                        None,
                        Some(test_channel_id(1)),
                    )
                    .await
                    .0;
                assert!(matches!(response, PacketResponse::Fulfill(_)));
            }
            let blocked = second_hop
                .handle_peer_prepare(
                    prepare_with_amount("g.example.app", 1),
                    0,
                    None,
                    Some(test_channel_id(1)),
                )
                .await
                .0;
            assert!(matches!(blocked, PacketResponse::Reject(_)));

            // A claim covering the full 120 delivered so far, signed by the
            // channel's own registered key, is accepted and lifts the
            // ceiling.
            let claim = sign_wire_claim(payer_signer.as_ref(), 1, 1, 120);
            let ack = second_hop.handle_peer_claim(claim);
            assert_eq!(ack, ClaimAckOutcome::Accepted);
            assert!(!second_hop.exposure()[0].over_ceiling);

            let resumed = second_hop
                .handle_peer_prepare(
                    prepare_with_amount("g.example.app", 1),
                    0,
                    None,
                    Some(test_channel_id(1)),
                )
                .await
                .0;

            assert!(matches!(resumed, PacketResponse::Fulfill(_)));
            assert_eq!(app.deliveries().len(), 3);
        }
    }

    /// Issue #424's own acceptance criterion: a node killed mid-traffic
    /// recovers its money state by replay, with no manual repair --
    /// exercised through `Connector::with_journal`, the public entry point
    /// a real binary would use, rather than `ClaimBook` directly (already
    /// covered in depth by `claim::tests::journal_recovery`).
    mod journal_recovery {
        use super::*;
        use crate::journal::FileJournal;
        use connector_signer::LocalSigner;

        #[tokio::test]
        async fn a_connector_rebuilt_against_the_same_journal_keeps_its_exposure_and_ceiling() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("journal.log");
            let payer_signer = Arc::new(LocalSigner::generate("payer-claim-key"));
            let payer_address = derive_evm_address(&payer_signer.public_key().unwrap());

            let build = |path: &std::path::Path| {
                let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
                let app_client = Arc::new(FakeAppClient::new());
                app_client.respond(route.handler_url(), answered(b""));
                let connector = with_test_channel(
                    Connector::new(
                        vec![route],
                        vec![],
                        app_client,
                        Arc::new(InProcessPeerTransport::new()),
                        test_clock(),
                    )
                    .with_channel_ceiling(test_channel_id(1), 100)
                    .with_identity_signer(identity_signer()),
                    1,
                    payer_address,
                );
                connector
                    .with_journal(Arc::new(FileJournal::open(path).unwrap()))
                    .unwrap()
            };

            {
                let (connector, divergences) = build(&path);
                assert!(divergences.is_empty());
                let response = connector
                    .handle_peer_prepare(
                        prepare_with_amount("g.example.app", 60),
                        0,
                        None,
                        Some(test_channel_id(1)),
                    )
                    .await
                    .0;
                assert!(matches!(response, PacketResponse::Fulfill(_)));
            }

            // A fresh `Connector`, built the same way against the same
            // journal path -- standing in for this node restarting. The
            // recovered exposure (60) is the very thing that would have
            // been lost -- with no journal, a restarted node would start
            // back at zero and let this same peer run up its debt all
            // over again before ever tripping the ceiling.
            let (restarted, divergences) = build(&path);
            assert!(divergences.is_empty());
            assert_eq!(restarted.exposure()[0].exposure, 60);
            assert!(!restarted.exposure()[0].over_ceiling);

            // 60 (recovered) + 45 = 105, still under the ceiling at the
            // moment this PREPARE is checked, so it is forwarded --
            // pushing exposure over 100.
            let pushes_over = restarted
                .handle_peer_prepare(
                    prepare_with_amount("g.example.app", 45),
                    0,
                    None,
                    Some(test_channel_id(1)),
                )
                .await
                .0;
            assert!(matches!(pushes_over, PacketResponse::Fulfill(_)));
            assert!(restarted.exposure()[0].over_ceiling);

            // The next PREPARE is checked against the now-over-ceiling
            // exposure and refused.
            let over = restarted
                .handle_peer_prepare(
                    prepare_with_amount("g.example.app", 1),
                    0,
                    None,
                    Some(test_channel_id(1)),
                )
                .await
                .0;
            match over {
                PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "T04"),
                other => panic!("expected a T04 reject, got {other:?}"),
            }
        }
    }

    /// Redeeming the latest claim and cooperative close (issue #425), all
    /// against `connector_settlement::InMemorySettlementBackend` -- the
    /// fake this workspace's own tests use for anything not specific to a
    /// real chain (ADR 0007). The real-chain requirement itself lives in
    /// `connector-operator`'s operator-surface test and
    /// `connector-settlement-evm`'s own integration tests.
    /// Issue #630's review finding: a node settling on more than one chain
    /// holds every configured backend, and each operator channel op reaches
    /// the backend its chain (or its channel id's namespace) names -- never
    /// whichever backend happened to attach last. Driven with a
    /// chain-tagged fake (ADR 0007) whose every answer names which slot it
    /// was registered under, so a misroute is a failed string assertion
    /// rather than an invisible wrong-chain transaction; the same routing
    /// against real chains is `connector-cli`'s
    /// `a_both_chains_config_attaches_and_routes_both_backends`.
    mod settlement_routing {
        use super::*;
        use connector_settlement::{ChannelState, InMemorySettlementBackend};

        /// A valid base58 32-byte account address -- the Solana channel-id
        /// namespace's shape.
        const SOLANA_CHANNEL: &str = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
        /// A valid `0x`-prefixed 64-hex-character `bytes32` -- the EVM
        /// channel-id namespace's shape.
        const EVM_CHANNEL: &str =
            "0xabababababababababababababababababababababababababababababababab";

        /// Answers every port method with an error naming the chain slot
        /// it was registered under, so a test can assert exactly which
        /// backend an operation reached.
        struct TaggedBackend(&'static str);

        #[async_trait]
        impl SettlementBackend for TaggedBackend {
            async fn open(
                &self,
                _counterparty: Vec<u8>,
                _settlement_timeout: Duration,
            ) -> Result<ChannelId, SettlementError> {
                Err(SettlementError::Backend(format!("{}: open", self.0)))
            }

            async fn fund(
                &self,
                _channel: &ChannelId,
                _amount: u128,
            ) -> Result<ChannelState, SettlementError> {
                Err(SettlementError::Backend(format!("{}: fund", self.0)))
            }

            async fn redeem(
                &self,
                _channel: &ChannelId,
                _claim: Claim,
            ) -> Result<ChannelState, SettlementError> {
                Err(SettlementError::Backend(format!("{}: redeem", self.0)))
            }

            async fn close(&self, _channel: &ChannelId) -> Result<ChannelState, SettlementError> {
                Err(SettlementError::Backend(format!("{}: close", self.0)))
            }

            async fn settle(&self, _channel: &ChannelId) -> Result<ChannelState, SettlementError> {
                Err(SettlementError::Backend(format!("{}: settle", self.0)))
            }

            async fn channel_state(
                &self,
                _channel: &ChannelId,
            ) -> Result<ChannelState, SettlementError> {
                Err(SettlementError::Backend(format!(
                    "{}: channel_state",
                    self.0
                )))
            }
        }

        fn bare_connector() -> Connector {
            Connector::new(
                vec![],
                vec![],
                Arc::new(FakeAppClient::new()),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
        }

        fn both_chains_connector() -> Connector {
            bare_connector()
                .with_settlement(SettlementChain::Evm, Arc::new(TaggedBackend("evm")))
                .with_settlement(SettlementChain::Solana, Arc::new(TaggedBackend("solana")))
        }

        fn backend_reached(result: Result<ChannelView, ChannelOperationError>) -> String {
            match result {
                Err(ChannelOperationError::Settlement(SettlementError::Backend(tag))) => tag,
                other => panic!("expected the tagged backend's own answer, got {other:?}"),
            }
        }

        /// The regression test for the last-one-wins slot: with EVM
        /// attached first and Solana second (config resolution order), an
        /// op on an EVM-namespace channel id must still reach the EVM
        /// backend -- and the Solana twin its own.
        #[tokio::test]
        async fn a_channel_op_on_a_both_chains_node_reaches_the_ids_own_backend() {
            let connector = both_chains_connector();

            assert_eq!(
                backend_reached(connector.fund_channel(EVM_CHANNEL, 5).await),
                "evm: fund"
            );
            assert_eq!(
                backend_reached(connector.close_channel(SOLANA_CHANNEL).await),
                "solana: close"
            );
            // A bare (un-`0x`-prefixed) hex id is the same EVM namespace,
            // exactly as `EvmSettlementBackend::parse_channel_id` accepts.
            assert_eq!(
                backend_reached(
                    connector
                        .fund_channel(EVM_CHANNEL.trim_start_matches("0x"), 5)
                        .await
                ),
                "evm: fund"
            );
        }

        /// Opening names its chain explicitly; on a node with several
        /// backends, declining to name one is refused rather than
        /// silently resolved to whichever backend attached last.
        #[tokio::test]
        async fn opening_routes_by_the_named_chain_and_refuses_ambiguity() {
            let connector = both_chains_connector();

            assert_eq!(
                backend_reached(
                    connector
                        .open_channel(
                            Some(SettlementChain::Solana),
                            b"peer".to_vec(),
                            Duration::seconds(60)
                        )
                        .await
                ),
                "solana: open"
            );
            assert!(matches!(
                connector
                    .open_channel(None, b"peer".to_vec(), Duration::seconds(60))
                    .await,
                Err(ChannelOperationError::AmbiguousSettlementChain)
            ));
        }

        /// A single-backend node keeps the port's "ids are opaque"
        /// promise: every id -- including one shaped like nothing any real
        /// chain assigns, e.g. the in-memory backend's decimal counters --
        /// routes to the one backend there is, and an unnamed chain on
        /// `open_channel` denotes it unambiguously.
        #[tokio::test]
        async fn a_single_backend_node_routes_every_id_to_it() {
            let connector = bare_connector()
                .with_settlement(SettlementChain::Evm, Arc::new(TaggedBackend("evm")));

            assert_eq!(
                backend_reached(connector.fund_channel("7", 5).await),
                "evm: fund"
            );
            assert_eq!(
                backend_reached(connector.fund_channel(SOLANA_CHANNEL, 5).await),
                "evm: fund"
            );
            assert_eq!(
                backend_reached(
                    connector
                        .open_channel(None, b"peer".to_vec(), Duration::seconds(60))
                        .await
                ),
                "evm: open"
            );
        }

        /// A chain this node holds no backend for is refused naming the
        /// actual gap -- "no solana settlement backend", not "no
        /// settlement backend is configured for this node".
        #[tokio::test]
        async fn a_chain_with_no_backend_is_refused_naming_the_gap() {
            let connector = bare_connector()
                .with_settlement(SettlementChain::Evm, Arc::new(TaggedBackend("evm")));

            let result = connector
                .open_channel(
                    Some(SettlementChain::Solana),
                    b"peer".to_vec(),
                    Duration::seconds(60),
                )
                .await;
            assert!(matches!(
                result,
                Err(ChannelOperationError::NoSettlementBackendForChain(
                    SettlementChain::Solana
                ))
            ));
        }

        /// An id in no known namespace, on a node where the namespace is
        /// what routes, is "no channel to operate on" -- the same answer
        /// every backend already gives a malformed id.
        #[tokio::test]
        async fn an_id_in_no_namespace_is_not_found_on_a_both_chains_node() {
            let connector = both_chains_connector();

            let result = connector.fund_channel("not-any-chains-shape", 5).await;
            assert!(matches!(
                result,
                Err(ChannelOperationError::Settlement(
                    SettlementError::ChannelNotFound(_)
                ))
            ));
        }

        /// `channels()` reports each opened channel from the backend that
        /// opened it: two in-memory backends both assign the id "0", so a
        /// misrouted report would answer with the other chain's
        /// counterparty.
        #[tokio::test]
        async fn channels_reports_each_channel_from_its_own_chains_backend() {
            let connector = bare_connector()
                .with_settlement(
                    SettlementChain::Evm,
                    Arc::new(InMemorySettlementBackend::new()),
                )
                .with_settlement(
                    SettlementChain::Solana,
                    Arc::new(InMemorySettlementBackend::new()),
                );

            connector
                .open_channel(
                    Some(SettlementChain::Evm),
                    b"evm-peer".to_vec(),
                    Duration::seconds(60),
                )
                .await
                .expect("open on the EVM backend");
            connector
                .open_channel(
                    Some(SettlementChain::Solana),
                    b"sol-peer".to_vec(),
                    Duration::seconds(60),
                )
                .await
                .expect("open on the Solana backend");

            let views = connector.channels().await;
            let counterparties: Vec<&str> = views
                .iter()
                .map(|view| view.counterparty.as_str())
                .collect();
            assert_eq!(views.len(), 2);
            assert!(
                counterparties.contains(&to_hex(b"evm-peer").as_str())
                    && counterparties.contains(&to_hex(b"sol-peer").as_str()),
                "each channel must be reported by the backend that opened it: {counterparties:?}"
            );
        }

        /// `0x`-prefixed lowercase hex -- [`ChannelView`]'s own
        /// counterparty encoding.
        fn to_hex(bytes: &[u8]) -> String {
            let mut hex = String::from("0x");
            for byte in bytes {
                hex.push_str(&format!("{byte:02x}"));
            }
            hex
        }
    }

    mod redemption {
        use super::*;
        use connector_settlement::{ChannelStatus, InMemorySettlementBackend};
        use connector_signer::LocalSigner;

        fn connector_with_settlement(
            settlement: Arc<InMemorySettlementBackend>,
            peer_signer: &LocalSigner,
            channel_id: &str,
        ) -> Connector {
            Connector::new(
                vec![],
                vec![],
                Arc::new(FakeAppClient::new()),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_settlement(SettlementChain::Evm, settlement)
            .with_channel_verification_key(
                channel_id,
                derive_evm_address(&peer_signer.public_key().unwrap()),
            )
            .with_channel_domain(channel_id, test_channel_domain())
            .unwrap()
        }

        /// `channel_id` here is `InMemorySettlementBackend::open`'s own
        /// generated id -- a plain decimal counter (issue #575), which
        /// `crate::claim::parse_channel_id` accepts as the same on-chain
        /// value that decimal numeral names.
        fn sign_claim(
            signer: &LocalSigner,
            channel_id: &str,
            nonce: u64,
            cumulative_amount: u64,
        ) -> WireClaim {
            let on_chain_id = crate::claim::parse_channel_id(channel_id).unwrap();
            let proof = crate::claim::evm_proof(
                on_chain_id,
                test_channel_domain(),
                nonce,
                cumulative_amount,
            );
            WireClaim {
                channel_id: channel_id.to_string(),
                nonce,
                cumulative_amount,
                signature: signer
                    .sign(&connector_signer::evm_balance_proof_digest(&proof))
                    .unwrap(),
            }
        }

        #[tokio::test]
        async fn redeeming_with_no_claim_ever_accepted_is_refused() {
            let settlement = Arc::new(InMemorySettlementBackend::new());
            let channel_id = settlement
                .open(b"peer".to_vec(), Duration::seconds(3600))
                .await
                .unwrap();
            let peer_signer = LocalSigner::generate("peer-key");
            let connector = connector_with_settlement(settlement, &peer_signer, &channel_id.0);

            let result = connector.redeem_latest_claim(&channel_id.0).await;

            assert_eq!(result, Err(ChannelOperationError::NoClaimToRedeem));
        }

        #[tokio::test]
        async fn redeeming_submits_only_the_highest_nonce_claim_ever_accepted() {
            let settlement = Arc::new(InMemorySettlementBackend::new());
            let channel_id = settlement
                .open(b"peer".to_vec(), Duration::seconds(3600))
                .await
                .unwrap();
            settlement.fund(&channel_id, 1_000).await.unwrap();
            let peer_signer = LocalSigner::generate("peer-key");
            let connector =
                connector_with_settlement(settlement.clone(), &peer_signer, &channel_id.0);

            assert_eq!(
                connector.handle_peer_claim(sign_claim(&peer_signer, &channel_id.0, 1, 100)),
                ClaimAckOutcome::Accepted
            );
            assert_eq!(
                connector.handle_peer_claim(sign_claim(&peer_signer, &channel_id.0, 2, 400)),
                ClaimAckOutcome::Accepted
            );

            let view = connector.redeem_latest_claim(&channel_id.0).await.unwrap();

            // Never the superseded 100 -- only ever the latest.
            assert_eq!(view.redeemed, 400);
        }

        #[tokio::test]
        async fn a_redemption_the_backend_refuses_leaves_the_channel_untouched() {
            let settlement = Arc::new(InMemorySettlementBackend::new());
            let channel_id = settlement
                .open(b"peer".to_vec(), Duration::seconds(3600))
                .await
                .unwrap();
            settlement.fund(&channel_id, 100).await.unwrap();
            let peer_signer = LocalSigner::generate("peer-key");
            let connector =
                connector_with_settlement(settlement.clone(), &peer_signer, &channel_id.0);
            connector.handle_peer_claim(sign_claim(&peer_signer, &channel_id.0, 1, 500));

            let result = connector.redeem_latest_claim(&channel_id.0).await;

            assert_eq!(
                result,
                Err(ChannelOperationError::Settlement(
                    SettlementError::InsufficientChannelBalance {
                        requested: 500,
                        deposited: 100,
                    }
                ))
            );
            // Recoverable: a refused redemption never touches the channel's
            // real state, so there is nothing to roll back before retrying.
            let state = settlement.channel_state(&channel_id).await.unwrap();
            assert_eq!(state.redeemed, 0);
        }

        #[tokio::test]
        async fn cooperative_close_with_no_claim_ever_accepted_just_closes() {
            let settlement = Arc::new(InMemorySettlementBackend::new());
            let channel_id = settlement
                .open(b"peer".to_vec(), Duration::seconds(3600))
                .await
                .unwrap();
            let peer_signer = LocalSigner::generate("peer-key");
            let connector = connector_with_settlement(settlement, &peer_signer, &channel_id.0);

            let view = connector.cooperative_close(&channel_id.0).await.unwrap();

            assert_eq!(view.status, crate::operator_view::ChannelViewStatus::Closed);
        }

        #[tokio::test]
        async fn cooperative_close_redeems_the_latest_claim_before_closing() {
            let settlement = Arc::new(InMemorySettlementBackend::new());
            let channel_id = settlement
                .open(b"peer".to_vec(), Duration::seconds(3600))
                .await
                .unwrap();
            settlement.fund(&channel_id, 1_000).await.unwrap();
            let peer_signer = LocalSigner::generate("peer-key");
            let connector =
                connector_with_settlement(settlement.clone(), &peer_signer, &channel_id.0);
            connector.handle_peer_claim(sign_claim(&peer_signer, &channel_id.0, 1, 700));

            let view = connector.cooperative_close(&channel_id.0).await.unwrap();

            assert_eq!(view.redeemed, 700);
            assert_eq!(view.status, crate::operator_view::ChannelViewStatus::Closed);
        }

        #[tokio::test]
        async fn cooperative_close_still_closes_when_the_claim_was_already_redeemed() {
            let settlement = Arc::new(InMemorySettlementBackend::new());
            let channel_id = settlement
                .open(b"peer".to_vec(), Duration::seconds(3600))
                .await
                .unwrap();
            settlement.fund(&channel_id, 1_000).await.unwrap();
            let peer_signer = LocalSigner::generate("peer-key");
            let connector =
                connector_with_settlement(settlement.clone(), &peer_signer, &channel_id.0);
            connector.handle_peer_claim(sign_claim(&peer_signer, &channel_id.0, 1, 700));
            connector.redeem_latest_claim(&channel_id.0).await.unwrap();

            // The same claim is now stale on chain -- cooperative close
            // does not treat that as a reason to refuse closing.
            let view = connector.cooperative_close(&channel_id.0).await.unwrap();

            assert_eq!(view.status, crate::operator_view::ChannelViewStatus::Closed);
        }

        #[tokio::test]
        async fn a_cooperative_close_whose_redemption_fails_leaves_the_channel_open() {
            let settlement = Arc::new(InMemorySettlementBackend::new());
            let channel_id = settlement
                .open(b"peer".to_vec(), Duration::seconds(3600))
                .await
                .unwrap();
            settlement.fund(&channel_id, 100).await.unwrap();
            let peer_signer = LocalSigner::generate("peer-key");
            let connector =
                connector_with_settlement(settlement.clone(), &peer_signer, &channel_id.0);
            connector.handle_peer_claim(sign_claim(&peer_signer, &channel_id.0, 1, 500));

            let result = connector.cooperative_close(&channel_id.0).await;

            assert_eq!(
                result,
                Err(ChannelOperationError::Settlement(
                    SettlementError::InsufficientChannelBalance {
                        requested: 500,
                        deposited: 100,
                    }
                ))
            );
            let state = settlement.channel_state(&channel_id).await.unwrap();
            assert_eq!(state.status, ChannelStatus::Open);
        }
    }

    /// Issue #426, ADR 0011: every REJECT carries the running total of the
    /// fees of the hops it actually passed through, whatever reason it was
    /// rejected for.
    mod fee_accumulation {
        use super::*;

        /// Builds a chain hop_0 -> hop_1 -> ... -> hop_{fees.len()}, where
        /// hop_{fees.len()} has no route at all (rejects `F02`) and
        /// `fees[i]` is what hop_i charges forwarding to hop_{i+1}. Returns
        /// hop_0, the entry point, already wired to the rest of the chain
        /// via in-process peer transports.
        fn chain_of(fees: &[u64]) -> Connector {
            let terminal = Arc::new(Connector::new(
                vec![],
                vec![],
                Arc::new(FakeAppClient::new()),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));

            let mut downstream = terminal;
            for &fee in fees.iter().skip(1).rev() {
                let mut transport = InProcessPeerTransport::new();
                transport.add_peer("next", downstream);
                downstream = Arc::new(Connector::new(
                    vec![],
                    vec![PeerRoute::new("g.example.app", "next", fee)],
                    Arc::new(FakeAppClient::new()),
                    Arc::new(transport),
                    test_clock(),
                ));
            }

            let mut entry_transport = InProcessPeerTransport::new();
            entry_transport.add_peer("next", downstream);
            Connector::new(
                vec![],
                vec![PeerRoute::new("g.example.app", "next", fees[0])],
                Arc::new(FakeAppClient::new()),
                Arc::new(entry_transport),
                test_clock(),
            )
        }

        #[tokio::test]
        async fn a_self_originated_reject_carries_zero_accumulated_cost() {
            let connector = connector_with(vec![], Arc::new(FakeAppClient::new()), test_clock());

            let response = connector
                .handle_prepare(prepare("g.nowhere", b"hello"), 0)
                .await;

            match response {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "F02");
                    assert_eq!(reject.accumulated_cost, 0);
                }
                other => panic!("expected a reject, got {other:?}"),
            }
        }

        #[tokio::test]
        async fn a_relayed_reject_gains_the_relaying_hops_fee() {
            let entry = chain_of(&[7]);

            let response = entry
                .handle_prepare(prepare_with_amount("g.example.app", 100), 0)
                .await;

            match response {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "F02");
                    assert_eq!(reject.accumulated_cost, 7);
                }
                other => panic!("expected a reject, got {other:?}"),
            }
        }

        #[tokio::test]
        async fn accumulated_cost_sums_across_every_successfully_forwarding_hop() {
            let entry = chain_of(&[7, 3, 11]);

            let response = entry
                .handle_prepare(prepare_with_amount("g.example.app", 1_000), 0)
                .await;

            match response {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "F02");
                    assert_eq!(reject.accumulated_cost, 21);
                }
                other => panic!("expected a reject, got {other:?}"),
            }
        }

        /// The hop that cannot reach its own next hop never actually
        /// forwarded the packet, so its own fee is never added -- only the
        /// hops before it, which genuinely reached their peer, add theirs
        /// (peer-wire-spec.md §5.2: fee is added only when relaying a
        /// REJECT "received from its own next hop").
        #[tokio::test]
        async fn a_hop_that_cannot_reach_its_peer_does_not_add_its_own_fee() {
            // hop-0 (fee 7) -> hop-1 (fee 3), but hop-1's own peer route
            // names a peer its transport never registered -- hop-1 cannot
            // reach it at all.
            let hop1 = Arc::new(Connector::new(
                vec![],
                vec![PeerRoute::new("g.example.app", "unregistered", 3)],
                Arc::new(FakeAppClient::new()),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            let mut hop0_transport = InProcessPeerTransport::new();
            hop0_transport.add_peer("hop-1", hop1);
            let hop0 = Connector::new(
                vec![],
                vec![PeerRoute::new("g.example.app", "hop-1", 7)],
                Arc::new(FakeAppClient::new()),
                Arc::new(hop0_transport),
                test_clock(),
            );

            let response = hop0
                .handle_prepare(prepare_with_amount("g.example.app", 1_000), 0)
                .await;

            match response {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "T01");
                    // hop-0 reached hop-1 (adds its fee, 7); hop-1 never
                    // reached "unregistered" (adds nothing).
                    assert_eq!(reject.accumulated_cost, 7);
                }
                other => panic!("expected a reject, got {other:?}"),
            }
        }

        proptest::proptest! {
            /// Issue #426's own acceptance criterion: for any chain of hops
            /// that all successfully forward before the packet is finally
            /// rejected (no route at the far end), the accumulated cost
            /// reported to the original sender equals the sum of the fees
            /// of the hops actually traversed.
            #[test]
            fn accumulated_cost_equals_the_sum_of_the_fees_of_the_hops_traversed(
                fees in proptest::collection::vec(0u64..1_000, 1..6)
            ) {
                let rt = tokio::runtime::Runtime::new().unwrap();
                rt.block_on(async {
                    let entry = chain_of(&fees);

                    let response = entry
                        .handle_prepare(prepare_with_amount("g.example.app", 1_000_000), 0)
                        .await;

                    match response {
                        PacketResponse::Reject(reject) => {
                            proptest::prop_assert_eq!(reject.code.as_str(), "F02");
                            proptest::prop_assert_eq!(reject.accumulated_cost, fees.iter().sum::<u64>());
                        }
                        other => return Err(proptest::test_runner::TestCaseError::fail(format!("expected a reject, got {other:?}"))),
                    }
                    Ok(())
                })?;
            }
        }
    }

    /// Issue #524's own acceptance criteria, exercised end to end through
    /// [`Connector::handle_prepare`] rather than only at
    /// `connector_signer::giftwrap`'s own unit level -- "demonstrated, not
    /// asserted" (the issue's own words for the forwarding-hop criterion).
    mod sealing {
        use super::*;
        use connector_signer::giftwrap::{looks_like_sealed_response, seal_request};
        use connector_signer::LocalSigner;

        /// AC1/AC3: a sender seals to the terminating connector's identity,
        /// and only that connector can open it -- a connector configured
        /// with a *different* identity cannot terminate a wrap addressed
        /// elsewhere, the same as any other hop that never held the right
        /// key. Distinguishes this from a merely-malformed envelope: the
        /// message names the wrap, not the envelope.
        #[tokio::test]
        async fn a_connector_with_a_different_identity_cannot_open_a_wrap_sealed_to_another_identity(
        ) {
            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"should never be reached"));
            let wrong_identity = Arc::new(LocalSigner::generate("not-the-intended-recipient"));
            let connector = Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_identity_signer(wrong_identity);
            // Sealed to `identity_signer()`, not `wrong_identity` above.
            let (sealed, _shared_secret) = sealed_prepare(b"hello");

            let response = connector.handle_prepare(sealed, 0).await;

            match response {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "F01");
                    assert!(reject.message.contains("gift wrap could not be opened"));
                    // Never reached: the wrap never opened, so there was
                    // nothing to deliver.
                }
                other => panic!("expected a reject, got {other:?}"),
            }
            assert!(app_client.deliveries().is_empty());
        }

        /// AC7: a wrap that cannot be opened at all rejects with a
        /// different message than one that opens cleanly but decodes to a
        /// malformed envelope -- two different Rust error types
        /// (`GiftWrapError` vs `EnvelopeError`) surfacing as two
        /// distinguishable reasons, not the same generic failure.
        #[tokio::test]
        async fn an_unopenable_wrap_is_distinguishable_from_one_that_opens_to_a_malformed_envelope()
        {
            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            let connector = connector_with(vec![route], app_client, test_clock());

            // Garbage bytes: not shaped like a gift wrap at all, so it never
            // opens.
            let unopenable = connector
                .handle_prepare(prepare_with_data(vec![0xff; 40]), 0)
                .await;
            match unopenable {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "F01");
                    assert!(reject.message.contains("gift wrap could not be opened"));
                }
                other => panic!("expected a reject, got {other:?}"),
            }

            // A wrap that opens cleanly (sealed to the right identity) but
            // whose plaintext, once decrypted, is not a valid envelope.
            let (malformed_envelope, _shared_secret) = seal_request(
                b"not a valid encoded envelope",
                &identity_signer().public_key().unwrap(),
            )
            .unwrap();
            let malformed = connector
                .handle_prepare(prepare_with_data(malformed_envelope), 0)
                .await;
            match malformed {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "F01");
                    assert!(reject.message.contains("envelope did not decode"));
                }
                other => panic!("expected a reject, got {other:?}"),
            }
        }

        /// AC2: not only a FULFILL, but a REJECT raised at the
        /// termination -- here, the condition was not derived from its own
        /// sealed secret (issue #525) -- is sealed back with the request's
        /// own shared secret: it opens under that secret (proving only the
        /// intended sender, who holds it, could ever read it) and fails to
        /// open under any other. `reject.message` -- the human-readable
        /// reason -- rides unencrypted alongside, same as every other
        /// reject in this file; only `data` is sealed.
        #[tokio::test]
        async fn a_reject_raised_at_the_termination_is_sealed_with_the_requests_shared_secret() {
            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"app said yes"));
            let connector = connector_with(vec![route], app_client, test_clock());
            let (data, shared_secret) = sealed_envelope_request_data(b"hello");

            let response = connector.handle_prepare(prepare_with_data(data), 0).await;

            match response {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "F99");
                    assert_eq!(
                        reject.message,
                        "fulfillment does not match execution condition"
                    );
                    assert!(looks_like_sealed_response(&reject.data));
                    connector_signer::giftwrap::open_response(&shared_secret, &reject.data).expect(
                        "a reject raised at the termination opens with the request's own secret",
                    );
                    assert!(
                        connector_signer::giftwrap::open_response(&[0xffu8; 32], &reject.data)
                            .is_err()
                    );
                }
                other => panic!("expected a reject, got {other:?}"),
            }
        }

        /// AC4: a reject raised short of the termination -- here, no route
        /// at all -- carries no secret to seal with and is necessarily
        /// plaintext, and a sender can tell the two apart without needing
        /// to already know whether a secret exists: an unsealed reject's
        /// `data` is simply empty, never shaped like a sealed one.
        #[tokio::test]
        async fn a_reject_raised_short_of_the_termination_is_plaintext_and_distinguishable() {
            let connector = connector_with(vec![], Arc::new(FakeAppClient::new()), test_clock());

            let response = connector
                .handle_prepare(prepare("g.nowhere", b"hello"), 0)
                .await;

            match response {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "F02");
                    assert!(reject.data.is_empty());
                    assert!(!looks_like_sealed_response(&reject.data));
                }
                other => panic!("expected a reject, got {other:?}"),
            }
        }

        /// AC5: `accumulated_cost` -- read directly off the struct, never
        /// through `data` -- is untouched by sealing in either direction.
        /// A termination reject (sealed `data`) and a hop reject (plaintext
        /// `data`) both carry it the same way.
        #[tokio::test]
        async fn accumulated_cost_stays_outside_the_seal_on_a_termination_reject() {
            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b""));
            let connector = connector_with(vec![route], app_client, test_clock());
            let (data, _shared_secret) = sealed_envelope_request_data(b"hello");

            let response = connector.handle_prepare(prepare_with_data(data), 0).await;

            match response {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "F99");
                    // This route is unpriced (`StaticRoute::new` defaults to
                    // 0, issue #545) -- the point here is that the field is
                    // readable and meaningful independent of whatever `data`
                    // carries, not that it is always zero; a priced route's
                    // own value is covered by
                    // `termination_pricing::a_mismatched_fulfillment_reject_carries_the_routes_price`.
                    assert_eq!(reject.accumulated_cost, 0);
                    assert!(looks_like_sealed_response(&reject.data));
                }
                other => panic!("expected a reject, got {other:?}"),
            }
        }
    }

    /// Issue #545: `accumulated_cost` on a reject this connector originates
    /// at a termination -- rather than relays from a peer -- carries that
    /// route's price, wiring up what #523 renamed but never connected.
    mod termination_pricing {
        use super::*;

        /// AC1/AC2: the packet reached the termination (the wrap opened and
        /// the envelope decoded) but the fulfilment derived from its own
        /// shared secret does not match the sender's execution condition --
        /// [`Connector::accept_if_fulfilled`]'s mismatch branch, reached via
        /// `deliver_opened_envelope`'s `AppOutcome::Answered` arm. The
        /// reject this connector originates carries the route's price, the
        /// same way a relayed reject carries a forwarding hop's fee.
        #[tokio::test]
        async fn a_mismatched_fulfillment_reject_carries_the_routes_price() {
            let route =
                StaticRoute::new_priced("g.example.app", "http://localhost:4000", 25).unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"irrelevant"));
            let connector = connector_with(vec![route], app_client, test_clock());
            let (data, _shared_secret) = sealed_envelope_request_data(b"hello");

            let response = connector.handle_prepare(prepare_with_data(data), 0).await;

            match response {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "F99");
                    assert_eq!(reject.accumulated_cost, 25);
                }
                other => panic!("expected a reject, got {other:?}"),
            }
        }

        /// The wrap opened cleanly -- proving it was genuinely addressed and
        /// correctly encrypted to this connector's identity, i.e. the packet
        /// reached the termination -- but the plaintext inside is not a
        /// valid envelope. Still priced, unlike the wrap-couldn't-open case
        /// in `a_wrap_that_cannot_be_opened_still_carries_zero_on_a_priced_route`
        /// below.
        #[tokio::test]
        async fn an_undecodable_envelope_reject_carries_the_routes_price() {
            let route =
                StaticRoute::new_priced("g.example.app", "http://localhost:4000", 25).unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            let connector = connector_with(vec![route], app_client, test_clock());
            let (malformed_envelope, _shared_secret) = connector_signer::giftwrap::seal_request(
                b"not a valid encoded envelope",
                &identity_signer().public_key().unwrap(),
            )
            .unwrap();

            let response = connector
                .handle_prepare(prepare_with_data(malformed_envelope), 0)
                .await;

            match response {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "F01");
                    assert!(reject.message.contains("envelope did not decode"));
                    assert_eq!(reject.accumulated_cost, 25);
                }
                other => panic!("expected a reject, got {other:?}"),
            }
        }

        /// The wrap never opens at all -- unlike the case above, this never
        /// proves the packet was even addressed to this connector, so the
        /// packet never reaches the termination and the reject stays
        /// unpriced, exactly like `AppOutcome::Unreachable` below.
        #[tokio::test]
        async fn a_wrap_that_cannot_be_opened_still_carries_zero_on_a_priced_route() {
            let route =
                StaticRoute::new_priced("g.example.app", "http://localhost:4000", 25).unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            let connector = connector_with(vec![route], app_client, test_clock());

            // Garbage bytes: not shaped like a gift wrap at all, so it never
            // opens.
            let response = connector
                .handle_prepare(prepare_with_data(vec![0xff; 40]), 0)
                .await;

            match response {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "F01");
                    assert!(reject.message.contains("gift wrap could not be opened"));
                    assert_eq!(reject.accumulated_cost, 0);
                }
                other => panic!("expected a reject, got {other:?}"),
            }
        }

        /// AC3: `AppOutcome::Unreachable` never carries a price, even on a
        /// priced route -- the app was never actually reached to do the
        /// priced work, mirroring a forwarding hop that cannot reach its
        /// own peer.
        #[tokio::test]
        async fn an_unreachable_app_reject_still_carries_zero_on_a_priced_route() {
            let route =
                StaticRoute::new_priced("g.example.app", "http://localhost:4000", 25).unwrap();
            // No `.respond()` registered: `FakeAppClient` defaults to
            // `AppOutcome::Unreachable`.
            let app_client = Arc::new(FakeAppClient::new());
            let connector = connector_with(vec![route], app_client, test_clock());
            let (sealed, _shared_secret) = sealed_prepare(b"hello");

            let response = connector.handle_prepare(sealed, 0).await;

            match response {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "T01");
                    assert_eq!(reject.accumulated_cost, 0);
                }
                other => panic!("expected a reject, got {other:?}"),
            }
        }

        /// Issue #596: an envelope whose target attempts to escape the
        /// route's configured handler path is refused with a code distinct
        /// from both F01 (the envelope itself failed to decode) and F99 (a
        /// mismatched fulfilment) -- and, like `AppOutcome::Unreachable`,
        /// carries no price, since the app was never reached to do any of
        /// the priced work.
        #[tokio::test]
        async fn an_escaping_target_reject_is_distinguishable_and_carries_zero() {
            let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000/write", 25)
                .unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            let connector = connector_with(vec![route], app_client, test_clock());
            let (data, _shared_secret) =
                sealed_envelope_request_data_with_target("/admin", b"hello");

            let response = connector.handle_prepare(prepare_with_data(data), 0).await;

            match response {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "F00");
                    assert_eq!(reject.accumulated_cost, 0);
                }
                other => panic!("expected a reject, got {other:?}"),
            }
        }

        /// AC4: a probe behind one forwarding hop, terminating at a priced
        /// route, reports the hop's fee plus the route's price as a single
        /// figure -- exercised end to end through two real `Connector`s
        /// joined by an in-process peer transport, not only at the
        /// termination itself.
        #[tokio::test]
        async fn a_relayed_reject_sums_the_hops_fee_and_the_terminated_routes_price() {
            let second_hop_route =
                StaticRoute::new_priced("g.example.app", "http://localhost:4000", 25).unwrap();
            let second_hop_app_client = Arc::new(FakeAppClient::new());
            second_hop_app_client.respond(second_hop_route.handler_url(), answered(b"irrelevant"));
            let second_hop = Arc::new(
                Connector::new(
                    vec![second_hop_route],
                    vec![],
                    second_hop_app_client,
                    Arc::new(InProcessPeerTransport::new()),
                    test_clock(),
                )
                .with_identity_signer(identity_signer()),
            );
            let mut peer_transport = InProcessPeerTransport::new();
            peer_transport.add_peer("second-hop", second_hop);
            let first_hop = Connector::new(
                vec![],
                vec![PeerRoute::new("g.example.app", "second-hop", 7)],
                Arc::new(FakeAppClient::new()),
                Arc::new(peer_transport),
                test_clock(),
            );
            let (mismatched_data, _shared_secret) = sealed_envelope_request_data(b"hello");
            let packet = Prepare {
                amount: 100,
                ..prepare_with_data(mismatched_data)
            };

            let response = first_hop.handle_prepare(packet, 0).await;

            match response {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "F99");
                    assert_eq!(reject.accumulated_cost, 7 + 25);
                }
                other => panic!("expected a reject, got {other:?}"),
            }
        }
    }

    /// Issue #548, ADR 0011: `Connector::handle_probe`'s two gates, and
    /// what a probe past them is and is not allowed to reach.
    mod probing {
        use super::*;

        const CHANNEL: &str = "evm:0xchannel";

        /// The gate that made `handle_probe` unreachable in practice:
        /// nothing in a node's configuration names an unaffiliated client's
        /// channel, so before #548 the only way to satisfy it was a
        /// peer-wire verification key -- and a gate no deployed node can
        /// pass is not a gate. A channel a claim has been seen on at this
        /// connector's own client edge now satisfies it.
        #[tokio::test]
        async fn a_probe_on_an_unrecognized_channel_is_denied_and_one_on_a_recognized_channel_is_not(
        ) {
            let connector = connector_with(vec![], Arc::new(FakeAppClient::new()), test_clock());

            let denied = connector
                .handle_probe(CHANNEL, prepare("g.somewhere.else", b"hello"), 0)
                .await;
            assert_eq!(denied, Err(ProbeDenied::NoOpenChannel));

            connector.recognize_channel(CHANNEL);
            let admitted = connector
                .handle_probe(CHANNEL, prepare("g.somewhere.else", b"hello"), 0)
                .await;
            assert!(matches!(admitted, Ok(PacketResponse::Reject(_))));
        }

        /// ADR 0011: probing traverses the network for free, so it is
        /// rate-limited per the identity that holds the channel.
        #[tokio::test]
        async fn a_recognized_channel_is_still_rate_limited() {
            let connector = connector_with(vec![], Arc::new(FakeAppClient::new()), test_clock())
                .with_probe_rate_limit(1, Duration::seconds(60));
            connector.recognize_channel(CHANNEL);

            let first = connector
                .handle_probe(CHANNEL, prepare("g.somewhere.else", b"hello"), 0)
                .await;
            assert!(first.is_ok());

            let second = connector
                .handle_probe(CHANNEL, prepare("g.somewhere.else", b"hello"), 0)
                .await;
            assert_eq!(second, Err(ProbeDenied::RateLimited));
        }

        /// A probe to a route this connector terminates reports that
        /// route's price as one figure -- the whole path cost, since no hop
        /// was traversed to reach it -- and the app behind it is never
        /// asked to do the work. Free traversal is all ADR 0011 grants a
        /// probe; it does not also buy what ADR 0020 prices.
        #[tokio::test]
        async fn a_probe_to_a_priced_local_route_reports_the_price_without_delivering() {
            let route =
                StaticRoute::new_priced("g.example.app", "http://localhost:4000", 25).unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(
                route.handler_url(),
                answered(b"work the app should never do"),
            );
            let connector = connector_with(vec![route], app_client.clone(), test_clock());
            connector.recognize_channel(CHANNEL);
            let (probe, _shared_secret) = sealed_prepare(b"hello");

            let response = connector.handle_probe(CHANNEL, probe, 0).await;

            match response {
                Ok(PacketResponse::Reject(reject)) => {
                    assert_eq!(reject.accumulated_cost, 25);
                }
                other => panic!("expected a priced reject, got {other:?}"),
            }
            assert_eq!(app_client.deliveries().len(), 0);
        }

        /// The same packet sent through the ordinary entry point still
        /// fulfils and still reaches the app: the rule above belongs to the
        /// probe ingress, not to routing, so ADR 0011's "probes are not a
        /// distinct packet type" holds for everything past the gate that a
        /// probe does traverse.
        #[tokio::test]
        async fn the_same_packet_through_handle_prepare_still_reaches_the_app() {
            let route =
                StaticRoute::new_priced("g.example.app", "http://localhost:4000", 25).unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"work the app does do"));
            let connector = connector_with(vec![route], app_client.clone(), test_clock());
            let (packet, _shared_secret) = sealed_prepare(b"hello");

            let response = connector.handle_prepare(packet, 0).await;

            assert!(matches!(response, PacketResponse::Fulfill(_)));
            assert_eq!(app_client.deliveries().len(), 1);
        }

        /// A destination beyond this connector is routed by the ordinary
        /// routing table (ADR 0011), so a probe's reject sums the fees of
        /// the hops it actually reached.
        #[tokio::test]
        async fn a_probe_beyond_this_connector_accumulates_the_hops_it_traversed() {
            let connector = Connector::new(
                vec![],
                vec![PeerRoute::new("g.example", "unreachable-peer", 7)],
                Arc::new(FakeAppClient::new()),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            );
            connector.recognize_channel(CHANNEL);

            let response = connector
                .handle_probe(CHANNEL, prepare("g.example.remote", b"hello"), 0)
                .await;

            match response {
                Ok(PacketResponse::Reject(reject)) => {
                    // The peer was never reached, so this hop adds nothing
                    // -- the figure is honest about what was traversed.
                    assert_eq!(reject.accumulated_cost, 0);
                }
                other => panic!("expected a reject, got {other:?}"),
            }
        }
    }

    /// Issue #452: before/after evidence for the leased-route lookup on
    /// the hot path. Not run by the normal gate -- `#[ignore]`d and meant
    /// to be run by hand, in release mode, so timing reflects real
    /// optimized-build cost rather than debug-build noise:
    ///
    /// ```text
    /// cargo test --release -p connector-runtime -- --ignored --nocapture bench_leased_route_lookup
    /// ```
    mod perf {
        use super::*;
        use std::time::Instant;

        /// A `Connector` whose leased-route table has `active_lease_count`
        /// active leases plus one that actually matches the packet this
        /// benchmark sends -- exercising exactly the per-packet cost this
        /// issue is about (`handle_prepare` walking every active leased
        /// route) regardless of how many of them happen to be irrelevant to
        /// the packet being routed.
        fn connector_with_leased_routes(active_lease_count: usize) -> Connector {
            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"delivered"));
            let connector = Connector::new(
                vec![route],
                vec![],
                app_client,
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_identity_signer(identity_signer());
            for i in 0..active_lease_count {
                connector
                    .upsert_leased_route(
                        format!("g.other-{i}.app"),
                        "unused-peer",
                        0,
                        Duration::seconds(60),
                    )
                    .unwrap();
            }
            connector
        }

        /// Not a correctness assertion -- prints per-packet latency for a
        /// growing number of concurrently-active leased routes so a
        /// before/after comparison (checked out against this commit's
        /// parent, then against this commit) shows whether the fix removed
        /// the per-packet scaling this issue describes: the pre-fix path
        /// clones every active leased route (plus a second clone into
        /// `PeerRoute`) into a freshly allocated `Vec` on every single
        /// call, so its cost grows with the lease count; the post-fix path
        /// loads an `Arc`-swapped snapshot with no lock and no clone of the
        /// route data, so it should stay flat.
        #[test]
        #[ignore = "run manually for a before/after measurement, see module doc"]
        fn bench_leased_route_lookup() {
            let rt = tokio::runtime::Runtime::new().unwrap();
            const ITERATIONS: usize = 20_000;
            for &active_lease_count in &[0usize, 100, 1_000, 10_000] {
                let connector = connector_with_leased_routes(active_lease_count);
                let started = Instant::now();
                rt.block_on(async {
                    for _ in 0..ITERATIONS {
                        let response = connector
                            .handle_prepare(prepare("g.example.app", b"hello"), 0)
                            .await;
                        assert!(matches!(response, PacketResponse::Fulfill(_)));
                    }
                });
                let elapsed = started.elapsed();
                println!(
                    "active_lease_count={active_lease_count:>6}  total={elapsed:?}  per_packet={:?}",
                    elapsed / ITERATIONS as u32
                );
            }
        }
    }
}
