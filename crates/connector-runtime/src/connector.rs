//! `pub struct Connector` -- the packet plane. See ADR 0001.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use chrono::Duration;
use connector_config::StaticRoute;
use connector_domain::{
    amount_after_fee, condition_is_present, fulfillment_matches_condition, is_expired,
    is_valid_ilp_address, select_route, Fulfill, PacketResponse, Prepare, Reject, RejectCode,
};
use connector_settlement::{ChannelId, Claim, SettlementBackend, SettlementError};
use connector_signer::{PublicKeyBytes, Signer};
use thiserror::Error;
use tracing::Instrument;

use crate::app_client::{AppClient, AppOutcome};
use crate::claim::{ClaimAckOutcome, ClaimBook, WireClaim};
use crate::clock::Clock;
use crate::metrics::Metrics;
use crate::operator_view::{
    ChannelView, ClaimView, ExposureView, LeasedRouteView, PeerView, RouteView,
};
use crate::peer_transport::PeerTransport;
use crate::route::{LeasedRoute, PeerRoute};

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
    #[error(transparent)]
    Settlement(#[from] SettlementError),
}

/// Which kind of routing-table entry matched a packet's destination, and
/// where in its own table -- resolved by [`Connector::handle_prepare`]
/// before dispatch, so priority among same-length matches (issue #427: a
/// static route always outranks a leased route) is decided in exactly one
/// place.
enum RouteTarget {
    App(usize),
    Peer(usize),
    /// Indexes into the caller's snapshot of currently-active leased
    /// routes, not `Connector::leased_routes` directly -- see
    /// [`Connector::active_leased_peer_routes`].
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
    leased_routes: RwLock<HashMap<String, LeasedRoute>>,
    app_client: Arc<dyn AppClient>,
    peer_transport: Arc<dyn PeerTransport>,
    clock: Arc<dyn Clock>,
    metrics: Arc<Metrics>,
    /// A real chain's settlement backend (issue #459), or `None` on a node
    /// that hasn't configured one -- channel operations fail with
    /// [`ChannelOperationError::NoSettlementBackend`] rather than being
    /// unreachable, matching how `leased_routes` degrades to "just empty"
    /// rather than a distinct construction path.
    settlement: Option<Arc<dyn SettlementBackend>>,
    /// Every channel id this node has itself opened, in the order opened.
    /// `SettlementBackend` has no "list every channel" method (a real
    /// chain has no such index either) -- this is the one thing
    /// `Connector` itself has to remember so `channels()` knows which ids
    /// to ask the backend to report on.
    known_channels: RwLock<Vec<ChannelId>>,
    /// Claims owed to and received from every peering relation (ADR 0004,
    /// ADR 0005, issue #423): signing an outbound claim on fulfilment,
    /// verifying and watermarking an inbound one. Empty and signer-less
    /// until configured via [`Connector::with_signer`],
    /// [`Connector::with_peer_claim_channel`] and
    /// [`Connector::with_channel_verification_key`] -- a node with none of
    /// those simply never emits or accepts a claim, matching how
    /// `settlement` degrades to `None`.
    claims: ClaimBook,
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
            leased_routes: RwLock::new(HashMap::new()),
            app_client,
            peer_transport,
            clock,
            metrics: Arc::new(Metrics::new()),
            settlement: None,
            known_channels: RwLock::new(Vec::new()),
            claims: ClaimBook::new(None, HashMap::new(), HashMap::new()),
        }
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

    /// Configure the public key whose signature this node accepts on an
    /// inbound claim for `channel_id` (issue #423, peer-wire-spec.md §1.1's
    /// "a configured peer id and verification key").
    pub fn with_channel_verification_key(
        mut self,
        channel_id: impl Into<String>,
        key: PublicKeyBytes,
    ) -> Self {
        self.claims.set_verification_key(channel_id, key);
        self
    }

    /// Configure the settlement backend a node's channel-lifecycle writes
    /// (issue #459) are driven against. A builder rather than a
    /// [`Connector::new`] parameter deliberately -- most of this crate's
    /// own tests, and every other crate constructing a bare `Connector`
    /// today, have no settlement backend at all and shouldn't need to
    /// thread one through just to keep compiling.
    pub fn with_settlement(mut self, settlement: Arc<dyn SettlementBackend>) -> Self {
        self.settlement = Some(settlement);
        self
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
        self.leased_routes
            .write()
            .expect("leased routes lock poisoned")
            .insert(prefix, route);
        Ok(view)
    }

    /// Leased routes not yet lapsed as of the injected clock. A lapsed
    /// route is filtered out here immediately -- it disappears from this
    /// list the moment it disappears from routing, with no sweep delay in
    /// between (issue #427).
    fn active_leased_routes(&self) -> Vec<LeasedRoute> {
        let now = self.clock.now();
        self.leased_routes
            .read()
            .expect("leased routes lock poisoned")
            .values()
            .filter(|route| !is_expired(route.expires_at(), now))
            .cloned()
            .collect()
    }

    /// Leased routes not yet lapsed as of the injected clock, for the
    /// operator surface's read-only inspection interface.
    pub fn leased_routes(&self) -> Vec<LeasedRouteView> {
        self.active_leased_routes()
            .iter()
            .map(leased_route_view)
            .collect()
    }

    /// A snapshot of currently-active leased routes (issue #427),
    /// converted to [`PeerRoute`] so routing and forwarding can treat them
    /// exactly like a peer route from configuration once expiry has
    /// already been decided.
    fn active_leased_peer_routes(&self) -> Vec<PeerRoute> {
        self.active_leased_routes()
            .iter()
            .map(|route| PeerRoute::new(route.prefix(), route.peer_id(), route.fee()))
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
            });
        }
        if is_expired(prepare.expires_at, self.clock.now()) {
            return Some(Reject {
                code: RejectCode::r00_transfer_timed_out(),
                triggered_by: String::new(),
                message: "prepare has expired".to_string(),
                data: Vec::new(),
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
    /// watermarks whatever claim it carries (peer-wire-spec.md §3.2). The
    /// two outcomes are independent -- a rejected claim does not reject the
    /// PREPARE it rode in on (§3.4), and this method decides neither from
    /// the other.
    pub async fn handle_peer_prepare(
        &self,
        prepare: Prepare,
        minimum_delivery: u64,
        claim: Option<WireClaim>,
    ) -> (PacketResponse, ClaimAckOutcome) {
        let ack = claim.map_or(ClaimAckOutcome::NotSent, |claim| {
            self.handle_peer_claim(claim)
        });
        let response = self.handle_prepare(prepare, minimum_delivery).await;
        (response, ack)
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
        tracing::info!("packet received");

        if let Some(reject) = self.reject_ineligible(&prepare) {
            return self.finish(PacketResponse::Reject(reject));
        }

        let leased_routes = self.active_leased_peer_routes();

        let app_prefixes: Vec<&str> = self.routes.iter().map(StaticRoute::prefix).collect();
        let peer_prefixes: Vec<&str> = self.peer_routes.iter().map(PeerRoute::prefix).collect();
        let leased_prefixes: Vec<&str> = leased_routes.iter().map(PeerRoute::prefix).collect();

        let app_match = select_route(&prepare.destination, &app_prefixes)
            .map(|index| (self.routes[index].prefix().len(), RouteTarget::App(index)));
        let peer_match = select_route(&prepare.destination, &peer_prefixes).map(|index| {
            (
                self.peer_routes[index].prefix().len(),
                RouteTarget::Peer(index),
            )
        });
        let leased_match = select_route(&prepare.destination, &leased_prefixes).map(|index| {
            (
                leased_routes[index].prefix().len(),
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
            }));
        };

        let peer_route = match target {
            RouteTarget::App(index) => {
                tracing::info!(handler_url = %self.routes[index].handler_url(), "routed to app");
                let response = self.deliver_to_app(&self.routes[index], prepare).await;
                return self.finish(response);
            }
            RouteTarget::Peer(index) => &self.peer_routes[index],
            RouteTarget::Leased(index) => &leased_routes[index],
        };
        tracing::info!(peer_id = %peer_route.peer_id(), "routed to peer");
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
                tracing::info!("packet fulfilled");
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
            });
        };

        let outgoing = Prepare {
            amount: forwarded_amount,
            ..prepare
        };
        let peer_id = peer_route.peer_id();
        let pending_claim = self.claims.pending_claim(peer_id);
        let (response, ack) = self
            .peer_transport
            .forward(peer_id, outgoing, minimum_delivery, pending_claim.clone())
            .await;
        if let Some(claim) = pending_claim {
            self.claims.acknowledge_outbound(peer_id, claim.nonce, ack);
        }

        match response {
            PacketResponse::Fulfill(fulfill) => {
                let outcome = Self::accept_if_fulfilled(&condition, Some(fulfill));
                if matches!(outcome, PacketResponse::Fulfill(_)) {
                    self.claims
                        .record_fulfillment(peer_id, forwarded_amount, self.clock.now());
                }
                outcome
            }
            reject @ PacketResponse::Reject(_) => reject,
        }
    }

    async fn deliver_to_app(&self, route: &StaticRoute, prepare: Prepare) -> PacketResponse {
        let received_at = self.clock.now();
        let condition = prepare.execution_condition;
        let outcome = self
            .app_client
            .deliver(route.handler_url(), &prepare, received_at)
            .await;

        match outcome {
            AppOutcome::Delivered { data, fulfillment } => Self::accept_if_fulfilled(
                &condition,
                fulfillment.map(|fulfillment| Fulfill { fulfillment, data }),
            ),
            AppOutcome::Declined { status, body } => PacketResponse::Reject(Reject {
                code: RejectCode::f99_application_error(),
                triggered_by: String::new(),
                message: format!("app declined the delivery with HTTP {status}"),
                data: body,
            }),
            AppOutcome::Unreachable { message } => PacketResponse::Reject(Reject {
                code: RejectCode::t01_peer_unreachable(),
                triggered_by: String::new(),
                message,
                data: Vec::new(),
            }),
        }
    }

    /// This node's static routes, for the operator surface's read-only
    /// inspection interface (issue #420).
    pub fn routes(&self) -> Vec<RouteView> {
        self.routes
            .iter()
            .map(|route| RouteView {
                prefix: route.prefix().to_string(),
                handler_url: route.handler_url().to_string(),
            })
            .collect()
    }

    /// This node's peers. Always empty: no peer wire exists yet (#416).
    pub fn peers(&self) -> Vec<PeerView> {
        Vec::new()
    }

    /// This node's payment channels (issue #459) -- every channel this
    /// node has itself opened, each reported fresh from the configured
    /// settlement backend. Empty on a node with no settlement backend
    /// configured, or with no channels opened yet, exactly like every
    /// other still-unpopulated operator view above.
    pub async fn channels(&self) -> Vec<ChannelView> {
        let Some(settlement) = &self.settlement else {
            return Vec::new();
        };
        let ids = self
            .known_channels
            .read()
            .expect("known channels lock poisoned")
            .clone();
        let mut views = Vec::with_capacity(ids.len());
        for id in ids {
            if let Ok(state) = settlement.channel_state(&id).await {
                views.push(ChannelView::from(state));
            }
        }
        views
    }

    /// The configured settlement backend, or
    /// [`ChannelOperationError::NoSettlementBackend`] on a node that hasn't
    /// set one -- every channel operation below checks this first.
    fn settlement(&self) -> Result<&Arc<dyn SettlementBackend>, ChannelOperationError> {
        self.settlement
            .as_ref()
            .ok_or(ChannelOperationError::NoSettlementBackend)
    }

    /// Open a new channel to `counterparty` (issue #459), remembering its
    /// id so a future [`Connector::channels`] call reports on it. The
    /// counterparty and settlement-timeout semantics are exactly the
    /// configured [`SettlementBackend`]'s own -- this method adds nothing
    /// beyond bookkeeping.
    pub async fn open_channel(
        &self,
        counterparty: Vec<u8>,
        settlement_timeout: Duration,
    ) -> Result<ChannelView, ChannelOperationError> {
        let settlement = self.settlement()?;
        let id = settlement.open(counterparty, settlement_timeout).await?;
        self.known_channels
            .write()
            .expect("known channels lock poisoned")
            .push(id.clone());
        let state = settlement.channel_state(&id).await?;
        Ok(ChannelView::from(state))
    }

    /// Deposit `amount` into `channel_id` (issue #459).
    pub async fn fund_channel(
        &self,
        channel_id: &str,
        amount: u128,
    ) -> Result<ChannelView, ChannelOperationError> {
        let state = self
            .settlement()?
            .fund(&ChannelId(channel_id.to_string()), amount)
            .await?;
        Ok(ChannelView::from(state))
    }

    /// Redeem `claim` against `channel_id` (issue #459).
    pub async fn redeem_channel(
        &self,
        channel_id: &str,
        claim: Claim,
    ) -> Result<ChannelView, ChannelOperationError> {
        let state = self
            .settlement()?
            .redeem(&ChannelId(channel_id.to_string()), claim)
            .await?;
        Ok(ChannelView::from(state))
    }

    /// Close `channel_id` (issue #459): no further funding or redemption is
    /// possible against it afterward.
    pub async fn close_channel(
        &self,
        channel_id: &str,
    ) -> Result<ChannelView, ChannelOperationError> {
        let state = self
            .settlement()?
            .close(&ChannelId(channel_id.to_string()))
            .await?;
        Ok(ChannelView::from(state))
    }

    /// Claims exchanged with peers (issue #423), for the operator surface's
    /// read-only inspection interface.
    pub fn claims(&self) -> Vec<ClaimView> {
        self.claims.views()
    }

    /// Per-peer exposure. Always empty: no exposure projection exists yet
    /// (#424).
    pub fn exposure(&self) -> Vec<ExposureView> {
        Vec::new()
    }

    /// Accept `candidate` as a genuine [`Fulfill`] only if its fulfillment
    /// verifies against `condition` (RFC-0022) -- the one check that
    /// prevents an intermediate hop (relaying a peer's answer) or a
    /// terminating one (relaying an app's) from producing a valid
    /// fulfilment without the destination's actual participation (issue
    /// #417). Anything else -- no candidate, or one that fails to verify --
    /// is a REJECT, never a fulfilment this connector invents itself.
    fn accept_if_fulfilled(condition: &[u8; 32], candidate: Option<Fulfill>) -> PacketResponse {
        match candidate {
            Some(fulfill) if fulfillment_matches_condition(condition, &fulfill.fulfillment) => {
                PacketResponse::Fulfill(fulfill)
            }
            _ => PacketResponse::Reject(Reject {
                code: RejectCode::f99_application_error(),
                triggered_by: String::new(),
                message: "fulfillment does not match execution condition".to_string(),
                data: Vec::new(),
            }),
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
    use async_trait::async_trait;
    use chrono::{Duration, TimeZone, Utc};
    use connector_domain::derive_condition;

    /// A fixed, non-zero preimage and the condition it derives -- used
    /// throughout so a `Delivered` outcome's fulfillment genuinely verifies
    /// against the packet's execution condition rather than the old
    /// hardcoded-zero stand-in (issue #417).
    const FULFILLMENT: [u8; 32] = [7u8; 32];

    fn condition() -> [u8; 32] {
        derive_condition(&FULFILLMENT)
    }

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
        Prepare {
            amount: 0,
            expires_at,
            execution_condition: condition(),
            destination: destination.to_string(),
            data: data.to_vec(),
        }
    }

    fn prepare_with_amount(destination: &str, amount: u64) -> Prepare {
        Prepare {
            amount,
            ..prepare(destination, b"hello")
        }
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
    }

    #[tokio::test]
    async fn delivers_a_packet_matching_a_terminated_route() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            AppOutcome::Delivered {
                data: b"app said yes".to_vec(),
                fulfillment: Some(FULFILLMENT),
            },
        );
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client.clone(), clock);

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello app"), 0)
            .await;

        assert_eq!(
            response,
            PacketResponse::Fulfill(Fulfill {
                fulfillment: FULFILLMENT,
                data: b"app said yes".to_vec(),
            })
        );

        let deliveries = app_client.deliveries();
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].data, b"hello app");
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
        app_client.respond(
            route.handler_url(),
            AppOutcome::Delivered {
                data: b"still on time".to_vec(),
                fulfillment: Some(FULFILLMENT),
            },
        );
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

    #[tokio::test]
    async fn an_app_that_supplies_no_fulfillment_is_rejected_rather_than_fulfilled() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            AppOutcome::Delivered {
                data: b"app said yes".to_vec(),
                fulfillment: None,
            },
        );
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client, clock);

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "F99");
                assert!(reject.message.contains("execution condition"));
            }
            other => panic!("expected a reject, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_app_that_supplies_a_mismatching_fulfillment_is_rejected_rather_than_fulfilled() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            AppOutcome::Delivered {
                data: b"app said yes".to_vec(),
                fulfillment: Some([9u8; 32]), // does not hash to `condition()`
            },
        );
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client, clock);

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        match response {
            PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "F99"),
            other => panic!("expected a reject, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_declining_app_produces_an_application_error_reject() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            AppOutcome::Declined {
                status: 402,
                body: b"insufficient funds".to_vec(),
            },
        );
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client, clock);

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "F99");
                assert_eq!(reject.data, b"insufficient funds");
            }
            other => panic!("expected a reject, got {other:?}"),
        }
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

    #[tokio::test]
    async fn uses_the_injected_clock_rather_than_wall_time() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            AppOutcome::Delivered {
                data: vec![],
                fulfillment: Some(FULFILLMENT),
            },
        );
        let far_future = Utc.with_ymd_and_hms(2099, 1, 1, 0, 0, 0).unwrap();
        let clock = Arc::new(TestClock::new(far_future));
        let connector = connector_with(vec![route], app_client.clone(), clock);
        let far_expiring = Utc.with_ymd_and_hms(2100, 1, 1, 0, 0, 0).unwrap();

        connector
            .handle_prepare(
                prepare_expiring_at("g.example.app", b"hello", far_expiring),
                0,
            )
            .await;

        let deliveries = app_client.deliveries();
        assert_eq!(deliveries[0].received_at, far_future);
    }

    #[tokio::test]
    async fn selects_the_most_specific_route_when_several_match() {
        let general = StaticRoute::new("g.example", "http://localhost:4000").unwrap();
        let specific = StaticRoute::new("g.example.app", "http://localhost:5000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            specific.handler_url(),
            AppOutcome::Delivered {
                data: vec![],
                fulfillment: Some(FULFILLMENT),
            },
        );
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
            AppOutcome::Delivered {
                data: b"delivered by the second hop".to_vec(),
                fulfillment: Some(FULFILLMENT),
            },
        );
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
            vec![PeerRoute::new("g.example.app", "second-hop", 0)],
            Arc::new(FakeAppClient::new()),
            Arc::new(peer_transport),
            test_clock(),
        );

        let response = first_hop
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        assert_eq!(
            response,
            PacketResponse::Fulfill(Fulfill {
                fulfillment: FULFILLMENT,
                data: b"delivered by the second hop".to_vec(),
            })
        );
        assert_eq!(second_hop_app_client.deliveries().len(), 1);
    }

    #[tokio::test]
    async fn forwarding_to_a_peer_subtracts_that_relations_flat_fee() {
        let second_hop_route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let second_hop_app_client = Arc::new(FakeAppClient::new());
        second_hop_app_client.respond(
            second_hop_route.handler_url(),
            AppOutcome::Delivered {
                data: b"delivered by the second hop".to_vec(),
                fulfillment: Some(FULFILLMENT),
            },
        );
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
            vec![PeerRoute::new("g.example.app", "second-hop", 7)],
            Arc::new(FakeAppClient::new()),
            Arc::new(peer_transport),
            test_clock(),
        );

        let response = first_hop
            .handle_prepare(prepare_with_amount("g.example.app", 100), 0)
            .await;

        assert!(matches!(response, PacketResponse::Fulfill(_)));
        let deliveries = second_hop_app_client.deliveries();
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].amount, 93);
    }

    #[tokio::test]
    async fn a_hop_that_cannot_meet_the_minimum_delivery_after_its_fee_rejects_without_forwarding()
    {
        let second_hop_route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let second_hop_app_client = Arc::new(FakeAppClient::new());
        second_hop_app_client.respond(
            second_hop_route.handler_url(),
            AppOutcome::Delivered {
                data: vec![],
                fulfillment: None,
            },
        );
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
        app_client.respond(
            terminated_route.handler_url(),
            AppOutcome::Delivered {
                data: b"handled locally".to_vec(),
                fulfillment: Some(FULFILLMENT),
            },
        );
        let connector = Connector::new(
            vec![terminated_route],
            vec![peer_route],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        );

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        assert_eq!(
            response,
            PacketResponse::Fulfill(Fulfill {
                fulfillment: FULFILLMENT,
                data: b"handled locally".to_vec(),
            })
        );
    }

    #[tokio::test]
    async fn a_peer_route_wins_over_a_shorter_terminated_route() {
        let terminated_route = StaticRoute::new("g.example", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        let second_hop_route = StaticRoute::new("g.example.app", "http://localhost:5000").unwrap();
        let second_hop_app_client = Arc::new(FakeAppClient::new());
        second_hop_app_client.respond(
            second_hop_route.handler_url(),
            AppOutcome::Delivered {
                data: b"handled by the second hop".to_vec(),
                fulfillment: Some(FULFILLMENT),
            },
        );
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
            vec![terminated_route],
            vec![PeerRoute::new("g.example.app", "second-hop", 0)],
            app_client,
            Arc::new(peer_transport),
            test_clock(),
        );

        let response = first_hop
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        assert_eq!(
            response,
            PacketResponse::Fulfill(Fulfill {
                fulfillment: FULFILLMENT,
                data: b"handled by the second hop".to_vec(),
            })
        );
        assert_eq!(second_hop_app_client.deliveries().len(), 1);
    }

    #[test]
    fn routes_reports_every_configured_static_route() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client, clock);

        let routes = connector.routes();

        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].prefix, "g.example.app");
        assert_eq!(routes[0].handler_url, "http://localhost:4000/");
    }

    #[tokio::test]
    async fn handle_prepare_records_a_fulfill_in_metrics() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            AppOutcome::Delivered {
                data: vec![],
                fulfillment: Some(FULFILLMENT),
            },
        );
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
        second_hop_app_client.respond(
            second_hop_route.handler_url(),
            AppOutcome::Delivered {
                data: vec![],
                fulfillment: Some(FULFILLMENT),
            },
        );
        let second_hop = Arc::new(Connector::new(
            vec![second_hop_route],
            vec![],
            second_hop_app_client,
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
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
            AppOutcome::Delivered {
                data: b"delivered by the second hop".to_vec(),
                fulfillment: Some(FULFILLMENT),
            },
        );
        let second_hop = Arc::new(Connector::new(
            vec![second_hop_route],
            vec![],
            second_hop_app_client.clone(),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
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

        let response = first_hop
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        assert_eq!(
            response,
            PacketResponse::Fulfill(Fulfill {
                fulfillment: FULFILLMENT,
                data: b"delivered by the second hop".to_vec(),
            })
        );
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
        app_client.respond(
            route.handler_url(),
            AppOutcome::Delivered {
                data: b"handled locally".to_vec(),
                fulfillment: Some(FULFILLMENT),
            },
        );
        let clock = test_clock();
        let connector = Connector::new(
            vec![route],
            vec![],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            clock,
        );
        connector
            .upsert_leased_route("g.example.app", "second-hop", 0, Duration::seconds(60))
            .unwrap();

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        assert_eq!(
            response,
            PacketResponse::Fulfill(Fulfill {
                fulfillment: FULFILLMENT,
                data: b"handled locally".to_vec(),
            })
        );
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
    async fn peers_and_exposure_are_empty_until_their_tickets_land_and_channels_and_claims_are_empty_with_nothing_configured(
    ) {
        let app_client = Arc::new(FakeAppClient::new());
        let clock = test_clock();
        let connector = connector_with(vec![], app_client, clock);

        assert!(connector.peers().is_empty());
        assert!(connector.channels().await.is_empty());
        // No signer or peer claim channel configured, and no traffic sent:
        // nothing to report. `claims()` reporting real state once claims
        // exist is covered by the `emits_...`/`records_...` tests below.
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
        ) -> (PacketResponse, ClaimAckOutcome) {
            (self.0.clone(), ClaimAckOutcome::NotSent)
        }

        async fn flush(&self, _peer_id: &str, _claim: WireClaim) -> ClaimAckOutcome {
            ClaimAckOutcome::NotSent
        }
    }

    #[tokio::test]
    async fn a_fulfillment_from_a_peer_that_does_not_match_the_execution_condition_is_rejected() {
        let bogus_fulfillment = [9u8; 32]; // does not hash to `condition()`
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
            second_hop_app_client.respond(
                &handler_url,
                AppOutcome::Delivered {
                    data: vec![],
                    fulfillment: Some(FULFILLMENT),
                },
            );
            let payer_signer = LocalSigner::generate("payer-claim-key");
            let second_hop = Arc::new(
                Connector::new(
                    vec![second_hop_route],
                    vec![],
                    second_hop_app_client.clone(),
                    Arc::new(InProcessPeerTransport::new()),
                    test_clock(),
                )
                .with_channel_verification_key("channel-a", payer_signer.public_key().unwrap()),
            );
            let mut peer_transport = InProcessPeerTransport::new();
            peer_transport.add_peer("second-hop", second_hop.clone());
            let first_hop = Connector::new(
                vec![],
                vec![PeerRoute::new("g.example.app", "second-hop", 0)],
                Arc::new(FakeAppClient::new()),
                Arc::new(peer_transport),
                test_clock(),
            )
            .with_signer(Arc::new(payer_signer))
            .with_peer_claim_channel("second-hop", "channel-a");
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
            assert_eq!(peer_claims[0].channel_id, "channel-a");
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
            app_client.respond(
                &handler_url,
                AppOutcome::Declined {
                    status: 402,
                    body: vec![],
                },
            );

            let response = first_hop
                .handle_prepare(prepare_with_amount("g.example.app", 100), 0)
                .await;

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
}
