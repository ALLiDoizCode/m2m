//! **Accept**: an inbound peer HTTP request (`peer-carriage-spec.md` §1,
//! §3, §6, §7.2).
//!
//! # An interaction is one request (§1.1)
//!
//! That is the whole difference from [`connector_peer_btp::accept`]'s
//! session. There is no role to bind for a lifetime, no second `auth` frame
//! to refuse, and no pre-auth frame to keep from being reclassified --
//! because there is nothing to reclassify. What replaces all of it is one
//! sentence: **the credential MUST be presented on every request** (§1.4),
//! and "a request without it is a client request, whatever the previous
//! request from the same connection carried".
//!
//! What *is* the same, and is called rather than re-derived:
//!
//! * [`connector_peer_auth::decide_role`] owns §1.2's P1/P2 rule, and its
//!   [`RoleDecision`](connector_peer_auth::RoleDecision) carries the role and
//!   the `peer_auth_refused` event together, so the silent downgrade cannot
//!   ship without the loud event;
//! * **ambiguous credentials are refused, not resolved** -- more than one
//!   `Toon-Peer-Auth` header is a `400` with no ILP body, never first-wins,
//!   last-wins or a concatenation. This is the header-smuggling defence, and
//!   [`connector_peer_auth::present_base64`] counts before it parses;
//! * the claim, its verdict and the per-relation watermark ledger are
//!   `connector-peer-btp`'s ([`AcceptedClaims`]), because §2.5/I6 make them
//!   per **peering relation**, never per carriage -- a peering with two paths
//!   is still one relation, and a second ledger would be a double-spend
//!   surface.
//!
//! # This is not the client edge's `POST /ilp`, and must never become it
//!
//! The pipeline below the port is shared; **the admission is not**. ADR 0026
//! was written to dissolve exactly this blur, and the devnet incident §1.9
//! names -- `toon-sandbox` admitting an anonymous BTP session with
//! `success:true mode:"no-auth"` and then treating it as a quasi-peer -- is
//! what happens when the two audiences meet in one handler. Here a
//! client-role request reaches no peer handling at all: its claim is not
//! judged, no watermark moves, nothing is appended to the peer claim ledger,
//! and no `Toon-Claim-Ack` is emitted. Falling a client-role request
//! through to `connector-client-edge` instead of
//! answering it `F02` is the bring-up wiring of issue #678; what §1 requires
//! of *this* module is that role is decided by the credential and that a
//! client can never reach peer handling, and that holds either way.
//!
//! # The accept-only side (§6.4)
//!
//! On HTTP an accept-only side cannot originate, so it is structurally a
//! **payee**: it can never forward a packet to that peer, and it cannot
//! prompt a payer that has simply stopped sending the way a live BTP
//! session's liveness can. Before ADR 0031/ADR 0033 (issue #882) this was
//! bounded by a configured `ceiling`, the accept-only side's only real
//! bound (`ConfigError::AcceptOnlyPeerWithoutCeiling`); that requirement is
//! retired along with the credit window it protected, since every peer
//! PREPARE now carries its own covering claim regardless of which side can
//! originate.
//!
//! What this module still owns is §6.4's prompt: a payee that cannot
//! originate MAY ask a payer to flush, with [`FlushHints`]. It is a hint and
//! only a hint -- it creates no obligation, and a payer that ignores every
//! one of them is not in violation of the specification.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::sync::{Arc, RwLock};

use connector_btp::{
    ACCUMULATED_COST_HEADER, CLAIM_ACK_HEADER, FLUSH_REQUESTED_HEADER, PAYMENT_REQUIRED_HEADER,
};
use connector_domain::{Fulfill, PacketResponse, Prepare, Reject, RejectCode};
use connector_peer_auth::{
    claim_ack_to_emit, decide_role, present_base64, Capability, PeerAuthPolicy, PeerAuthRefusalLog,
    SessionRole, PEER_AUTH_HEADER,
};
use connector_peer_btp::claim_json::{self};
use connector_peer_btp::price_gate::{self, ClaimEnforcementPolicy, PaymentRequired};
use connector_peer_btp::{fields, AcceptedClaims};
use connector_runtime::{ClaimAckOutcome, Connector, WireClaim};

use crate::headers::{self, PeerRequest, PeerResponse};

/// How this connector accepts peer requests.
#[derive(Debug, Clone, Copy, Default)]
pub struct PeerHttpPolicy {
    /// §1.10's bounded escape hatch: a **dedicated peer listener with
    /// mandatory authentication**. Role is *still* decided by P1 and P2 --
    /// the listener is defence in depth and MUST NOT become the decider, so
    /// §1.3 holds in full either way. What changes is only what happens to a
    /// request that fails: on a dedicated listener it is refused outright
    /// (`401`) rather than downgraded to client, and that is safe *only*
    /// because such a listener serves no clients -- there is no client to
    /// downgrade to and no oracle to leak.
    ///
    /// `false` (the default) is the shared-listener reading: a failed
    /// credential is an ordinary client, per §1.6's "MUST NOT refuse it for
    /// the assertion alone".
    pub mandatory_auth: bool,
}

/// §6.4's flush prompt, from the side that cannot originate.
///
/// A payee that cannot dial has no way to prompt a payer that has simply
/// stopped sending, and unlike BTP it has no live session to read liveness
/// from. `Toon-Flush-Requested` is the one thing it can do about that, and
/// the specification is emphatic about how little it means: it creates no
/// obligation, and a payer that ignores it is conforming.
///
/// A hint is *drained* when it is emitted. Repeating it on every response
/// until the claim arrived would name a channel many times in one exchange
/// for no gain; whoever knows a claim is still owed re-requests it.
#[derive(Debug, Default)]
pub struct FlushHints {
    by_peer: RwLock<HashMap<String, HashSet<String>>>,
}

impl FlushHints {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Ask `peer_id` to flush its pending claim on `channel_id`, on the next
    /// response this connector sends it.
    pub fn request(&self, peer_id: &str, channel_id: &str) {
        self.by_peer
            .write()
            .expect("flush hints lock poisoned")
            .entry(peer_id.to_string())
            .or_default()
            .insert(claim_json::canonical_evm_channel_id(channel_id));
    }

    /// The channels to name on a response to `peer_id`, in a stable order,
    /// removing them: **a payee SHOULD NOT name the same channel more than
    /// once in one response** (§6.4).
    #[must_use]
    pub fn take(&self, peer_id: &str) -> Vec<String> {
        let mut by_peer = self.by_peer.write().expect("flush hints lock poisoned");
        let Some(channels) = by_peer.remove(peer_id) else {
            return Vec::new();
        };
        let mut channels: Vec<String> = channels.into_iter().collect();
        channels.sort();
        channels
    }
}

/// Everything an inbound peer request needs: the one pipeline below the
/// port, the role policy, the per-relation ledger, the rate-limited
/// `peer_auth_refused` log, and §6.4's prompt.
pub struct PeerHttpState {
    connector: Arc<Connector>,
    auth: Arc<PeerAuthPolicy>,
    accepted: Arc<AcceptedClaims>,
    enforcement: Arc<ClaimEnforcementPolicy>,
    hints: Arc<FlushHints>,
    refusals: Mutex<PeerAuthRefusalLog>,
    policy: PeerHttpPolicy,
}

impl PeerHttpState {
    /// `accepted` is deliberately shared with whatever other carriage serves
    /// the same peerings (§2.5, I6): one peering relation has one set of
    /// watermarks however many paths it has, and giving each carriage its own
    /// would let one claim advance two independent watermarks. `enforcement`
    /// (issue #883, child B6) is shared for the same reason `auth` is: one
    /// peering has one migration state, whichever carriage it rides.
    #[must_use]
    pub fn new(
        connector: Arc<Connector>,
        auth: Arc<PeerAuthPolicy>,
        accepted: Arc<AcceptedClaims>,
        enforcement: Arc<ClaimEnforcementPolicy>,
        hints: Arc<FlushHints>,
        policy: PeerHttpPolicy,
    ) -> Self {
        PeerHttpState {
            connector,
            auth,
            accepted,
            enforcement,
            hints,
            refusals: Mutex::new(PeerAuthRefusalLog::default()),
            policy,
        }
    }

    /// §6.4: ask `peer_id` to flush `channel_id` on the next response.
    pub fn request_flush(&self, peer_id: &str, channel_id: &str) {
        self.hints.request(peer_id, channel_id);
    }

    /// Answer one peer request.
    ///
    /// **Role is decided before anything else happens** (§1.5): before a
    /// claim is decoded, before a watermark is consulted, before a packet is
    /// routed, and before any fee or journal accounting.
    pub async fn handle(&self, request: PeerRequest) -> PeerResponse {
        // §1.5's header-smuggling defence. Refused, not resolved: never the
        // first, never the last, never a concatenation, and counted before
        // anything is parsed so a second undecodable header cannot be
        // discarded to leave one unambiguous credential standing.
        let presented = match present_base64(
            request
                .headers
                .get_all(PEER_AUTH_HEADER)
                .into_iter()
                .map(str::as_bytes),
        ) {
            Ok(presented) => presented,
            // `400`, with no ILP body (§1.5).
            Err(_) => return PeerResponse::refused(400),
        };

        let (role, refusal) = decide_role(presented.as_ref(), &self.auth).into_parts();

        // §1.6: the loud half. A credential naming a configured peer that
        // fails P1 or P2 is an *assertion*; the request is a client and is
        // not refused for the assertion alone -- refusing would make the
        // check an oracle for which peer ids this connector has configured --
        // but a silent downgrade would present to an operator as "peering
        // configured, nothing peers, no error anywhere". The rate-limited
        // event is what stops that.
        if let Some(refusal) = refusal {
            let report = self
                .refusals
                .lock()
                .expect("peer auth refusal log poisoned")
                .observe(&refusal, now_ms());
            if let Some(report) = report {
                tracing::warn!(
                    event = report.event,
                    peer_id = %report.peer_id,
                    unmet = report.unmet.name(),
                    suppressed = report.suppressed,
                    "peer credential asserted but not proven; the interaction is a client"
                );
            }
        }

        // §1.10: on a dedicated peer listener a failure is refused outright
        // rather than downgraded, because such a listener serves no clients.
        if self.policy.mandatory_auth && !role.is_peer() {
            return PeerResponse::refused(401);
        }

        // Decoded once, here, for the price-coverage check further down --
        // and only for a peer, since §1.5 does not read a client's claim at
        // all. Its watermark is read *before* `judge_claim` below may record
        // this very claim, so that check judges the claim's own advance past
        // the watermark it rode in on, not the one it just became (issue
        // #880).
        let claim = role.peer_id().and_then(|_| claim_on(&request));
        let prior_watermark = role
            .peer_id()
            .zip(claim.as_ref())
            .and_then(|(peer_id, claim)| self.accepted.watermark(peer_id, &claim.channel_id));

        let ack = self.judge_claim(&role, &request);

        // FLUSH (§3): a POST with an **empty ILP body** plus the claim
        // header. The ack rides the response that already answers it -- HTTP
        // always answers, which is what bounds the ack structurally (§6.3).
        if request.body.is_empty() {
            return self.finish(&role, PeerResponse::ok(Vec::new()), ack);
        }

        let Some(peer_id) = role.peer_id().map(str::to_string) else {
            // A client-role packet reaches no peer handling at all: no
            // watermark, no ledger, no ack (§1.7, §1.9).
            return self.finish(
                &role,
                packet_response(PacketResponse::Reject(Reject {
                    code: RejectCode::f02_unreachable(),
                    triggered_by: String::new(),
                    message: "no peer route for this interaction".to_string(),
                    data: Vec::new(),
                    accumulated_cost: 0,
                })),
                ClaimAckOutcome::NotSent,
            );
        };

        let prepare = match Prepare::decode(&request.body) {
            Ok(prepare) => prepare,
            // §6.2: `4xx` is for a request there is no ILP answer to, which
            // an undecodable packet is. It is not a claim verdict and never
            // becomes one.
            Err(error) => {
                tracing::warn!(peer_id, %error, "peer POSTed an undecodable ILP packet");
                return PeerResponse::refused(400);
            }
        };

        let minimum_delivery = match headers::minimum_delivery(&role, &request.headers) {
            Ok(minimum_delivery) => minimum_delivery,
            // §5.1: never silently zero. The claim's verdict rides this
            // REJECT anyway -- the two answers are independent (§6.2).
            Err(error) => {
                return self.finish(
                    &role,
                    packet_response(PacketResponse::Reject(
                        fields::malformed_minimum_delivery_reject(&error),
                    )),
                    ack,
                )
            }
        };

        // Issue #880 (owner decision #868): a peer PREPARE to a route this
        // connector terminates and prices carries a covering claim, or it
        // is refused with the client edge's own x402 greeting. The decision
        // is `connector_peer_btp::price_gate`'s, shared with the BTP
        // carriage so §0.1's one pipeline cannot admit over one carriage
        // what it refuses over the other; what is this carriage's is only
        // the response the refusal is shaped into.
        if let Some(refusal) = price_gate::payment_required(
            &self.connector,
            &peer_id,
            &prepare.destination,
            ack,
            claim.as_ref(),
            prior_watermark,
            self.enforcement.mode(&peer_id),
        ) {
            return self.finish(&role, payment_required_response(refusal), ack);
        }

        // The one pipeline below the port (§0.1): a peer PREPARE that
        // arrived over HTTP is indistinguishable here from one that arrived
        // over BTP. `handle_peer_prepare` is handed no claim -- this
        // request's was judged above, before anything was routed.
        let (response, _) = self
            .connector
            .handle_peer_prepare(prepare, minimum_delivery, None)
            .await;
        self.finish(&role, packet_response(response), ack)
    }

    /// A claim's verdict, or [`ClaimAckOutcome::NotSent`] when there was no
    /// claim to judge, it could not be read, or the request was a client's.
    fn judge_claim(&self, role: &SessionRole, request: &PeerRequest) -> ClaimAckOutcome {
        // §1.5: a client's claim is not judged here at all -- the peer
        // namespace is not reachable from a client interaction (§1.8), and
        // §1.3 forbids letting "a claim naming a channel that happens to be
        // in `[[peer_channels]]`" argue otherwise.
        let Some(peer_id) = role.peer_id() else {
            return ClaimAckOutcome::NotSent;
        };
        let Some(raw) = headers::claim_json(&request.headers) else {
            return ClaimAckOutcome::NotSent;
        };
        let raw = match raw {
            Ok(raw) => raw,
            Err(_) => {
                tracing::warn!(peer_id, "peer claim header is not base64; not acknowledged");
                return ClaimAckOutcome::NotSent;
            }
        };

        let claim = match claim_json::parse(&raw) {
            Ok(claim) => claim,
            // Not one of §6.1's four reasons -- those judge a claim this
            // connector could read. An undecodable one is *not acknowledged*
            // (§6.3): no header rides the response, the payer's claim stays
            // pending, and its retransmission is read the same way rather
            // than being recorded as a verdict that was never reached.
            Err(error) => {
                tracing::warn!(peer_id, %error, "peer claim could not be decoded; not acknowledged");
                return ClaimAckOutcome::NotSent;
            }
        };

        // §6.3's idempotent re-ack, checked **before** the claim reaches the
        // book: a byte-identical retransmission at the current watermark is
        // `accepted`, and nothing is advanced or recorded. A payee that
        // answered it `nonce_not_advancing` would wedge the peering
        // permanently, since the payer's only honest retransmission would be
        // refused forever and minting a higher nonce for the same cumulative
        // is explicitly forbidden.
        if self.accepted.is_at_watermark(peer_id, &claim) {
            return ClaimAckOutcome::Accepted;
        }

        let ack = self.connector.handle_peer_claim(claim.clone());
        if ack == ClaimAckOutcome::Accepted {
            self.accepted.record(peer_id, &claim);
        }
        ack
    }

    /// The §3 fields that ride *every* answer: the claim ack (§6.1) and the
    /// flush prompt (§6.4), both gated on role.
    fn finish(
        &self,
        role: &SessionRole,
        mut response: PeerResponse,
        ack: ClaimAckOutcome,
    ) -> PeerResponse {
        // §1.7: a connector MUST NOT emit a `Toon-Claim-Ack` on a client
        // interaction, and §6.2 forbids one on a response answering a
        // request that carried no claim. Both are this one call.
        if let Some(value) = claim_ack_to_emit(role, headers::claim_ack_header_value(ack)) {
            response.headers.push(CLAIM_ACK_HEADER, value);
        }
        // §6.4: never on a response to a client interaction -- a client is
        // never treated as a peering relation for flush purposes (§1.7).
        if let Some(peer_id) = role
            .grants(Capability::CountTowardPeeringExposure)
            .then(|| role.peer_id())
            .flatten()
        {
            for channel_id in self.hints.take(peer_id) {
                response.headers.push(FLUSH_REQUESTED_HEADER, channel_id);
            }
        }
        response
    }
}

/// The answer to a PREPARE: **the body answers the packet, the header
/// answers the claim, and the status is `200` regardless of the claim's
/// verdict** (§6.2). A rejected claim never becomes a non-`200`, and never
/// changes the packet's own outcome, its `accumulatedCost` or its fee
/// accounting -- and a fulfilled packet can carry a `rejected` ack, which is
/// the property whose loss would silently destroy ADR 0024's semantics.
fn packet_response(response: PacketResponse) -> PeerResponse {
    match response {
        PacketResponse::Fulfill(fulfill) => {
            // §5.2: `Toon-Accumulated-Cost` rides **only** a REJECT. It is
            // never emitted beside a FULFILL.
            PeerResponse::ok(Fulfill::encode(&fulfill))
        }
        PacketResponse::Reject(reject) => {
            let mut response = PeerResponse::ok(reject.encode());
            // §5.2: always emitted on a REJECT, even at zero, so "absent"
            // never has to carry meaning in the direction that matters.
            response
                .headers
                .push(ACCUMULATED_COST_HEADER, reject.accumulated_cost.to_string());
            response
        }
    }
}

/// [`price_gate::payment_required`]'s refusal, HTTP-shaped: the greeting
/// rides a header rather than the client edge's own real `402`, because
/// this carriage keeps status `200` regardless of the packet's verdict,
/// unchanged by this issue (§6.2). The REJECT itself is shaped by
/// [`packet_response`], so §5.2's accumulated cost is not spelled twice.
fn payment_required_response(refusal: PaymentRequired) -> PeerResponse {
    let mut response = packet_response(PacketResponse::Reject(refusal.reject));
    response.headers.push(
        PAYMENT_REQUIRED_HEADER,
        headers::payment_required_header_value(&refusal.terms),
    );
    response
}

/// A monotonic-enough millisecond reading for the refusal log's rate limit.
/// Wall clock is fine: the log's own contract says a reading that goes
/// backwards closes the window early rather than suppressing forever.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The claim a peer request carries, decoded -- exposed so a caller that
/// wants to know what a request *would* be judged on does not have to
/// re-derive the header layer. Judging it is [`PeerHttpState::handle`]'s.
#[must_use]
pub fn claim_on(request: &PeerRequest) -> Option<WireClaim> {
    match headers::claim_json(&request.headers)? {
        Ok(raw) => claim_json::parse(&raw).ok(),
        Err(_) => None,
    }
}
