//! **Accept**: an inbound peer BTP session, from its websocket upgrade to
//! its close (`peer-carriage-spec.md` §1, §3, §6, §7.1).
//!
//! This module owns the session-lifetime rules
//! [`connector_peer_auth`] deliberately cannot, because that crate can see
//! one credential and no session:
//!
//! * **Role is bound once, at auth, and is immutable for the session's
//!   lifetime** (§1.5). A session starts `client` -- that is
//!   [`SessionRole`]'s `Default`, not a third state -- and becomes `peer`
//!   only when an `auth` entry satisfying P1 and P2 is evaluated.
//! * **A second `auth` entry on an already-bound session is an ERROR, not
//!   an escalation.** `F00 NotAcceptedError`, role unchanged. That is the
//!   escalation path §1.5 closes, and [`SessionRoleBinding::bind`]
//!   refusing a second bind is what makes forgetting it a compile-visible
//!   `Result` rather than a silent re-evaluation.
//! * **Frames processed before the role is bound are client frames and are
//!   never retroactively reclassified.** A claim ingested as a client claim
//!   stays a client claim.
//! * **Ambiguous credentials are refused, not resolved** -- more than one
//!   `auth` entry on one frame is an ERROR, never first-wins or last-wins.
//!   [`connector_peer_auth::present_raw`] counts before it parses.
//!
//! # Ordering (§7.1)
//!
//! Deliberately the client edge's shape, reusing its mechanism rather than
//! a peer-specific one: the session task runs everything order-sensitive
//! **inline** -- decoding, the role decision, and above all claim
//! admission -- so claims on one session are judged strictly sequentially
//! in arrival order and cannot race each other into `nonce_not_advancing`.
//! Only the post-admission tail (the ceiling check, routing, the
//! downstream round trip, writing the RESPONSE) overlaps, bounded by the
//! same per-session in-flight window `btp_session_window` sets. Losing that
//! is the measured ~125--150 events/s admission wall.
//!
//! Consequently RESPONSEs may leave in a different order than the MESSAGEs
//! that provoked them; `requestId` is the correlation, and a peer must not
//! infer which claim an ack answers from position (§7.1).
//!
//! # The client-role path is inert, on purpose
//!
//! §1.9's named regression is testable as: a client-role interaction moves
//! no peer watermark, appends nothing to the peer claim ledger, changes no
//! peer-relation exposure, and gets no `claim-ack`. Here a client-role
//! session reaches none of the peer pipeline at all -- its packets are
//! answered `F02` and its claims are not judged. Composing this carriage
//! onto the *shared* client listener, so that a client-role session falls
//! through to `connector-client-edge` instead, is the bring-up wiring of
//! issue #678; what §1 requires of this crate is that role is decided by
//! the credential and that a client can never reach peer handling, and
//! that holds either way.

use std::collections::HashMap;
use std::num::NonZeroU32;
use std::sync::{Arc, Mutex, RwLock};

use connector_btp::{
    decode_frame, encode_error, encode_response, reply, BtpDecodeError, BtpSessionHandle,
    OutboundRequests, ProtocolData, SessionGone, AUTH_PROTOCOL, BTP_ERROR, BTP_MESSAGE,
    BTP_RESPONSE, BTP_TRANSFER,
};
use connector_domain::{validate_price, Fulfill, PacketResponse, Prepare, Reject, RejectCode};
use connector_peer_auth::{
    claim_ack_to_emit, decide_role, present_raw, PeerAuthPolicy, PeerAuthRefusalLog, SessionRole,
    SessionRoleBinding, PEER_AUTH_PROTOCOL_ENTRY,
};
use connector_runtime::{ClaimAckOutcome, ClientRouteKind, Connector, WireClaim};
use tokio::sync::mpsc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::{ack, claim_json, fields};

/// How many completed replies may queue for the socket's writer before a
/// finishing frame waits its turn -- burst smoothing between out-of-order
/// completions and the one socket, not admission control (that is the
/// in-flight window's job). The client edge's own figure, for the same
/// reason.
pub const REPLY_QUEUE_DEPTH: usize = 32;

/// The per-session concurrency bound (§7.1), matching the client edge's
/// `btp_session_window` default.
pub const DEFAULT_PEER_SESSION_WINDOW: u32 = 16;

/// How this connector accepts peer sessions.
#[derive(Debug, Clone, Copy)]
pub struct PeerAcceptPolicy {
    /// §1.10's bounded escape hatch: a **dedicated peer listener with
    /// mandatory authentication**. Role is *still* decided by P1 and P2 --
    /// the listener is defence in depth and MUST NOT become the decider,
    /// so §1.3 holds in full either way. What changes is only what happens
    /// to an interaction that fails: on a dedicated listener it is refused
    /// outright (ERROR, then close) rather than downgraded to client, and
    /// that is safe *only* because such a listener serves no clients --
    /// there is no client to downgrade to and no oracle to leak.
    ///
    /// `false` (the default) is the shared-listener reading: a failed
    /// credential is an ordinary client, per §1.6's "MUST NOT refuse it for
    /// the assertion alone".
    pub mandatory_auth: bool,
    /// How many frames may be past admission and not yet answered (§7.1).
    pub session_window: NonZeroU32,
}

impl Default for PeerAcceptPolicy {
    fn default() -> Self {
        PeerAcceptPolicy {
            mandatory_auth: false,
            session_window: NonZeroU32::new(DEFAULT_PEER_SESSION_WINDOW)
                .expect("the default window is non-zero"),
        }
    }
}

/// What a peering relation remembers between frames, and **across
/// connections** (§2.5): the claim currently at each channel's watermark,
/// and the channel this relation is known to identify itself by.
///
/// Per *relation*, never per carriage and never per connection -- that is
/// §2.5's rule, and maintaining it per-connection would be a double-spend
/// surface, since the same claim would advance two independent watermarks.
/// One of these is shared by every session from every peer.
///
/// # The idempotent re-ack (§6.3)
///
/// A lost ack and a lost claim are indistinguishable at the payer, so a
/// payer that was not acknowledged retransmits its latest pending claim --
/// byte-identical, if nothing has changed. A payee that answered such a
/// retransmission `nonce_not_advancing` would wedge the peering
/// permanently: the payer's only honest retransmission would be refused
/// forever, and minting a higher nonce for the same cumulative is
/// explicitly forbidden.
///
/// So: a claim whose `(channel, nonce, cumulative, signature)` is
/// byte-identical to the one already at the watermark is answered
/// `accepted`, and **nothing is advanced or recorded** -- there is nothing
/// to advance, the exposure covered is identical. A claim at the same
/// nonce differing in *any* other field is a different claim and is
/// refused `nonce_not_advancing`, exactly as §3.2's strictly-advancing rule
/// requires.
///
/// This record is in-memory and per-process. A restart loses it, and the
/// first retransmission after one is refused `nonce_not_advancing` until
/// the payer's next fulfilment produces a genuinely newer claim --
/// recovering it belongs with the claim journal's own durability (ADR
/// 0005), not with a carriage.
#[derive(Debug, Default)]
pub struct AcceptedClaims {
    /// `(peer id, canonical channel id)` → the claim at that watermark.
    at_watermark: RwLock<HashMap<(String, String), WireClaim>>,
    /// Peer id → the channel that peering last identified itself by, so a
    /// packet arriving with no claim is still checked against the
    /// relation's ceiling rather than not checked at all.
    known_channel: RwLock<HashMap<String, String>>,
}

impl AcceptedClaims {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether `claim` is byte-identical to the one already at this
    /// relation's watermark for that channel (§6.3).
    #[must_use]
    pub fn is_at_watermark(&self, peer_id: &str, claim: &WireClaim) -> bool {
        self.at_watermark
            .read()
            .expect("accepted claims lock poisoned")
            .get(&(peer_id.to_string(), claim.channel_id.clone()))
            == Some(claim)
    }

    /// Record `claim` as the one now at this relation's watermark.
    pub fn record(&self, peer_id: &str, claim: &WireClaim) {
        self.at_watermark
            .write()
            .expect("accepted claims lock poisoned")
            .insert(
                (peer_id.to_string(), claim.channel_id.clone()),
                claim.clone(),
            );
    }

    /// This relation's watermark for `channel_id` (domain
    /// [`connector_domain::Watermark`]), `None` if no claim has ever been
    /// recorded for it -- the same "nothing to advance past" case
    /// [`connector_domain::validate_price`] already treats as watermark
    /// zero. Read *before* [`Self::record`] to get the watermark a fresh
    /// claim must advance past, not the one it just became (issue #880).
    #[must_use]
    pub fn watermark(
        &self,
        peer_id: &str,
        channel_id: &str,
    ) -> Option<connector_domain::Watermark> {
        self.at_watermark
            .read()
            .expect("accepted claims lock poisoned")
            .get(&(peer_id.to_string(), channel_id.to_string()))
            .map(|claim| connector_domain::Watermark {
                nonce: claim.nonce,
                cumulative_amount: claim.cumulative_amount,
            })
    }

    /// Note the channel this peering identifies itself by.
    pub fn note_channel(&self, peer_id: &str, channel_id: &str) {
        self.known_channel
            .write()
            .expect("known channel lock poisoned")
            .insert(peer_id.to_string(), channel_id.to_string());
    }

    /// The channel a peering's exposure and ceiling are accounted against.
    #[must_use]
    pub fn channel_for(&self, peer_id: &str) -> Option<String> {
        self.known_channel
            .read()
            .expect("known channel lock poisoned")
            .get(peer_id)
            .cloned()
    }
}

/// Everything a peer session needs that outlives it: the one pipeline
/// below the port, the role policy, the per-relation ledger, and the
/// rate-limited `peer_auth_refused` log.
pub struct PeerCarriageState {
    connector: Arc<Connector>,
    auth: Arc<PeerAuthPolicy>,
    accepted: Arc<AcceptedClaims>,
    refusals: Mutex<PeerAuthRefusalLog>,
    policy: PeerAcceptPolicy,
}

impl PeerCarriageState {
    #[must_use]
    pub fn new(
        connector: Arc<Connector>,
        auth: Arc<PeerAuthPolicy>,
        accepted: Arc<AcceptedClaims>,
        policy: PeerAcceptPolicy,
    ) -> Self {
        PeerCarriageState {
            connector,
            auth,
            accepted,
            refusals: Mutex::new(PeerAuthRefusalLog::default()),
            policy,
        }
    }
}

/// One inbound peer session: its role binding, its outbound `requestId`
/// space (§2.3 -- after auth either side may originate on the one session),
/// and its in-flight window.
pub struct PeerSession {
    state: Arc<PeerCarriageState>,
    binding: SessionRoleBinding,
    outbound: Arc<OutboundRequests>,
    replies: mpsc::Sender<Vec<u8>>,
    window: Arc<Semaphore>,
}

/// Why a session ended.
#[derive(Debug, PartialEq, Eq)]
pub enum SessionEnd {
    /// The peer closed, or the frame source ran dry.
    Closed,
    /// The socket's send half is gone; nothing further could be answered.
    Gone,
    /// §1.10: a dedicated peer listener refused an interaction that failed
    /// P1 or P2, and closed.
    Refused,
}

impl PeerSession {
    #[must_use]
    pub fn new(state: Arc<PeerCarriageState>, replies: mpsc::Sender<Vec<u8>>) -> Self {
        Self::with_outbound(state, replies, Arc::new(OutboundRequests::new()))
    }

    /// A session over an `outbound` table somebody else already holds --
    /// what a **dialed** session needs (§2.3): one socket, one read loop,
    /// and both halves of RFC-23's symmetric grammar on it. The dialing
    /// side reserves request ids through its [`BtpSessionHandle`] while
    /// this session resolves the answers and serves whatever the far side
    /// originates, and a second correlation table would mean answers
    /// resolving against the wrong one.
    #[must_use]
    pub fn with_outbound(
        state: Arc<PeerCarriageState>,
        replies: mpsc::Sender<Vec<u8>>,
        outbound: Arc<OutboundRequests>,
    ) -> Self {
        let window = Arc::new(Semaphore::new(state.policy.session_window.get() as usize));
        PeerSession {
            state,
            binding: SessionRoleBinding::new(),
            outbound,
            replies,
            window,
        }
    }

    /// The handle this session hands out for **originating** a MESSAGE or
    /// TRANSFER on it. §2.3: on BTP a session is symmetric once
    /// established, so the side that *accepted* it can originate too --
    /// which is the whole of the difference between the carriages, and why
    /// BTP has no `Toon-Flush-Requested` analogue and needs none (§6.4).
    #[must_use]
    pub fn handle(&self) -> BtpSessionHandle {
        BtpSessionHandle::new(self.replies.clone(), Arc::clone(&self.outbound))
    }

    /// This session's role. `client` until an `auth` entry proving P1 and
    /// P2 binds it, and immutable thereafter.
    #[must_use]
    pub fn role(&self) -> &SessionRole {
        self.binding.role()
    }

    /// Read frames until the peer closes or the socket dies.
    pub async fn run(mut self, mut frames: mpsc::Receiver<Vec<u8>>) -> SessionEnd {
        while let Some(bytes) = frames.recv().await {
            match self.handle_frame(&bytes).await {
                Ok(None) => {}
                Ok(Some(end)) => return end,
                Err(SessionGone) => return SessionEnd::Gone,
            }
        }
        SessionEnd::Closed
    }

    /// Process one frame. `Ok(None)` continues the session; `Ok(Some(_))`
    /// ends it deliberately.
    pub async fn handle_frame(
        &mut self,
        frame_bytes: &[u8],
    ) -> Result<Option<SessionEnd>, SessionGone> {
        let frame = match decode_frame(frame_bytes) {
            Ok(frame) => frame,
            // No readable `requestId`, so no ERROR can correlate.
            Err(BtpDecodeError::TooShort) => return Ok(None),
            Err(BtpDecodeError::Malformed { request_id, reason }) => {
                // ERROR stays reserved for undecodable frames (§6.2).
                self.send(encode_error(
                    request_id,
                    "F00",
                    "NotAcceptedError",
                    reason.as_bytes(),
                ))
                .await?;
                return Ok(None);
            }
        };

        // The answer to a request *this* side originated on this session
        // (§7.3): correlate and stop. One this connector never originated
        // resolves to nothing and is dropped, which is ordinary.
        if frame.frame_type == BTP_RESPONSE || frame.frame_type == BTP_ERROR {
            self.outbound.resolve(frame);
            return Ok(None);
        }

        let auth_entries: Vec<&[u8]> = frame
            .protocol_data
            .iter()
            .filter(|pd| pd.name == PEER_AUTH_PROTOCOL_ENTRY)
            .map(|pd| pd.data.as_slice())
            .collect();
        if !auth_entries.is_empty() {
            debug_assert_eq!(PEER_AUTH_PROTOCOL_ENTRY, AUTH_PROTOCOL);
            return self.handle_auth(frame.request_id, auth_entries).await;
        }

        match frame.frame_type {
            // FLUSH (§3): a TRANSFER whose `amount` is the claim's new
            // cumulative, carrying the claim and **no** `ilpPacket`.
            BTP_TRANSFER => {
                self.handle_flush(frame.request_id, frame.amount, &frame.protocol_data)
                    .await?;
                Ok(None)
            }
            BTP_MESSAGE => {
                self.handle_message(frame.request_id, &frame.protocol_data, &frame.ilp_packet)
                    .await?;
                Ok(None)
            }
            // A frame type this grammar does not have. Ignored rather than
            // errored: the carriage stays additively extensible (§3).
            _ => Ok(None),
        }
    }

    async fn send(&self, frame: Vec<u8>) -> Result<(), SessionGone> {
        reply(&self.replies, frame).await
    }

    /// §1.4/§1.5: the credential, evaluated exactly once per session.
    async fn handle_auth(
        &mut self,
        request_id: u32,
        entries: Vec<&[u8]>,
    ) -> Result<Option<SessionEnd>, SessionGone> {
        // A session whose role is already bound does not re-evaluate.
        // Re-authentication mid-session is the escalation path §1.5
        // closes, and the answer is an ERROR with the role left alone.
        if self.binding.is_bound() {
            self.send(encode_error(
                request_id,
                "F00",
                "NotAcceptedError",
                b"role is already bound for this session; re-authentication is refused",
            ))
            .await?;
            return Ok(None);
        }

        // More than one `auth` entry on one frame: refused, not resolved.
        // Never the first, never the last, never a concatenation -- this
        // is the credential-smuggling defence, and its absence is how
        // "which credential did we check?" becomes unanswerable.
        let presented = match present_raw(entries) {
            Ok(presented) => presented,
            Err(_) => {
                self.send(encode_error(
                    request_id,
                    "F00",
                    "NotAcceptedError",
                    b"more than one auth entry on one frame",
                ))
                .await?;
                return Ok(None);
            }
        };

        let decision = decide_role(presented.as_ref(), &self.state.auth);
        let (role, refusal) = decision.into_parts();

        // §1.6: the loud half. A credential naming a configured peer that
        // fails P1 or P2 is an *assertion*; the interaction is a client and
        // is not refused for the assertion alone -- refusing would make the
        // check an oracle for which peer ids this connector has configured
        // -- but a silent downgrade would present to an operator as
        // "peering configured, nothing peers, no error anywhere". The
        // rate-limited event is what stops that.
        if let Some(refusal) = refusal {
            let report = self
                .state
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

        let is_peer = role.is_peer();
        // `bind` cannot fail here -- `is_bound` was checked above -- but it
        // is a `Result` so that forgetting the check is a compile-visible
        // omission rather than a silent second evaluation.
        if self.binding.bind(role).is_err() {
            return Ok(None);
        }

        // §1.10: on a dedicated peer listener a failure is refused
        // outright rather than downgraded, because such a listener serves
        // no clients -- there is no client to downgrade to and no oracle to
        // leak.
        if self.state.policy.mandatory_auth && !is_peer {
            self.send(encode_error(
                request_id,
                "F00",
                "NotAcceptedError",
                b"this listener serves peers only",
            ))
            .await?;
            return Ok(Some(SessionEnd::Refused));
        }

        // The same empty RESPONSE the client edge answers an `auth` frame
        // with: received, nothing more to say. The role decision is not
        // disclosed, on either outcome.
        self.send(encode_response(request_id, &[], &[])).await?;
        Ok(None)
    }

    /// FLUSH (§3.3, §3): a TRANSFER carrying the claim alone.
    async fn handle_flush(
        &mut self,
        request_id: u32,
        amount: Option<u64>,
        protocol_data: &[ProtocolData],
    ) -> Result<(), SessionGone> {
        let judged = self.judge_claim(protocol_data);
        if let (Some(amount), Some(claim)) =
            (amount, judged.as_ref().and_then(|j| j.claim.as_ref()))
        {
            if amount != claim.cumulative_amount {
                // §10.2 item 13 pins the equality. The claim is the truth
                // (ADR 0005) and is judged either way; a disagreeing
                // `amount` is a peer bug worth naming, not a second
                // opinion to reconcile.
                tracing::warn!(
                    transfer_amount = amount,
                    claim_cumulative = claim.cumulative_amount,
                    "peer FLUSH amount disagrees with its claim's cumulative"
                );
            }
        }
        let ack = judged.map_or(ClaimAckOutcome::NotSent, |judged| judged.ack);
        let entries: Vec<ProtocolData> = self.claim_ack_entry(ack).into_iter().collect();
        // §6.1: the ack rides the RESPONSE that already answers the
        // claim-bearing TRANSFER. RFC-0023 requires the responder answer
        // every request, which is exactly what bounds the ack structurally.
        self.send(encode_response(request_id, &entries, &[])).await
    }

    /// A MESSAGE: a PREPARE, or a claim standing alone on one.
    async fn handle_message(
        &mut self,
        request_id: u32,
        protocol_data: &[ProtocolData],
        ilp_packet: &[u8],
    ) -> Result<(), SessionGone> {
        // Peeked before `judge_claim` below may record this claim, so the
        // price-coverage check further down judges the claim's own advance
        // past the watermark it rode in on, not the one it just became
        // (issue #880).
        let prior_watermark = self.binding.role().peer_id().and_then(|peer_id| {
            let raw = claim_json::from_protocol_data(protocol_data)?;
            let claim = claim_json::parse(raw).ok()?;
            self.state.accepted.watermark(peer_id, &claim.channel_id)
        });

        // Claims are judged **inline, in arrival order** (§7.1) -- before
        // the packet is even decoded, and before anything is spawned.
        let judged = self.judge_claim(protocol_data);
        let ack = judged
            .as_ref()
            .map_or(ClaimAckOutcome::NotSent, |judged| judged.ack);

        if ilp_packet.is_empty() {
            let entries: Vec<ProtocolData> = self.claim_ack_entry(ack).into_iter().collect();
            return self.send(encode_response(request_id, &entries, &[])).await;
        }

        let Some(peer_id) = self.binding.role().peer_id().map(str::to_string) else {
            // A client-role packet reaches no peer handling at all: no
            // watermark, no ledger, no exposure, no ack (§1.7, §1.9).
            return self
                .send(self.reject_response(
                    request_id,
                    Reject {
                        code: RejectCode::f02_unreachable(),
                        triggered_by: String::new(),
                        message: "no peer route for this interaction".to_string(),
                        data: Vec::new(),
                        accumulated_cost: 0,
                    },
                    ClaimAckOutcome::NotSent,
                ))
                .await;
        };

        let prepare = match Prepare::decode(ilp_packet) {
            Ok(prepare) => prepare,
            Err(error) => {
                // The HTTP carriage's 400: a transport-level answer, not
                // an ILP-level one, so an ERROR rather than a REJECT.
                return self
                    .send(encode_error(
                        request_id,
                        "F00",
                        "NotAcceptedError",
                        error.to_string().as_bytes(),
                    ))
                    .await;
            }
        };

        let minimum_delivery = match fields::minimum_delivery(self.binding.role(), protocol_data) {
            Ok(minimum_delivery) => minimum_delivery,
            Err(error) => {
                // §5.1: never silently zero. The claim's verdict rides
                // this REJECT anyway -- the two answers are independent
                // (§6.2).
                return self
                    .send(self.reject_response(
                        request_id,
                        fields::malformed_minimum_delivery_reject(&error),
                        ack,
                    ))
                    .await;
            }
        };

        // Issue #880 (owner decision #868): a peer PREPARE to a route this
        // connector terminates and prices MUST carry a claim that covers
        // that price, or it is refused with the client edge's own x402
        // greeting (`peer-carriage-spec.md` §3.1, corrected by this issue).
        // Scoped to a terminated route's own price exactly like the
        // existing amount check `handle_peer_prepare` still runs below this
        // one: a `Forwarded` route is priced by the peering's own bilateral
        // fee (`peer-wire-spec.md` §4), not by this gate (§3.1).
        let price = self
            .state
            .connector
            .client_route(&prepare.destination)
            .filter(|route| route.kind == ClientRouteKind::Terminated)
            .map_or(0, |route| route.price);
        if price > 0 {
            let claim = judged.as_ref().and_then(|judged| judged.claim.as_ref());
            // §880's correction: coverage requires the claim book's own
            // verdict to be `Accepted`, not merely that the claim decoded.
            // A forged signature or a replayed nonce still *decodes* and can
            // still declare any `cumulative_amount` it likes -- judging
            // coverage off that declared amount rather than the verdict lets
            // an unlimited-value, never-verified claim buy service.
            let covers = ack == ClaimAckOutcome::Accepted
                && claim.is_some_and(|claim| {
                    validate_price(prior_watermark, claim.cumulative_amount, price).is_ok()
                });
            if !covers {
                let advanced = claim.map_or(0, |claim| {
                    claim
                        .cumulative_amount
                        .saturating_sub(prior_watermark.map_or(0, |w| w.cumulative_amount))
                });
                tracing::warn!(
                    peer_id,
                    destination = %prepare.destination,
                    price,
                    advanced,
                    "peer PREPARE refused: no claim covers this packet's price"
                );
                return self
                    .send(self.payment_required_response(
                        request_id,
                        &prepare.destination,
                        price,
                        ack,
                    ))
                    .await;
            }
        }

        let channel_id = self.state.accepted.channel_for(&peer_id);
        let permit = window_slot(&self.window).await;
        let state = Arc::clone(&self.state);
        let replies = self.replies.clone();
        let role = self.binding.role().clone();
        tokio::spawn(async move {
            let _slot = permit;
            // Everything past admission, overlapping up to the window
            // (§7.1): the ceiling check, routing, the downstream round
            // trip. `handle_peer_prepare` is handed no claim -- this
            // frame's was judged inline above, in order -- so what it adds
            // here is exposure accounting and the packet itself.
            let (response, _) = state
                .connector
                .handle_peer_prepare(prepare, minimum_delivery, None, channel_id)
                .await;
            let frame = encode_packet_response(&role, request_id, response, ack);
            let _ = reply(&replies, frame).await;
        });
        Ok(())
    }

    /// A claim's verdict, and the claim itself when it was decodable.
    fn judge_claim(&self, protocol_data: &[ProtocolData]) -> Option<Judged> {
        // §1.5: role is decided before a claim is decoded, before a
        // watermark is consulted, before anything is routed. A client's
        // claim is not judged here at all -- the peer namespace is not
        // reachable from a client interaction (§1.8).
        let peer_id = self.binding.role().peer_id()?;
        let raw = claim_json::from_protocol_data(protocol_data)?;

        let claim = match claim_json::parse(raw) {
            Ok(claim) => claim,
            Err(error) => {
                // Not one of §6.1's four reasons -- those judge a claim
                // this connector could read. An undecodable one is *not
                // acknowledged* (§6.3): no entry rides the response, the
                // payer's claim stays pending, and its retransmission will
                // be read the same way rather than being recorded as a
                // verdict that was never reached.
                tracing::warn!(
                    peer_id,
                    %error,
                    "peer claim could not be decoded; not acknowledged"
                );
                return Some(Judged {
                    ack: ClaimAckOutcome::NotSent,
                    claim: None,
                });
            }
        };

        self.state.accepted.note_channel(peer_id, &claim.channel_id);

        // §6.3's idempotent re-ack, checked **before** the claim reaches
        // the book: a byte-identical retransmission at the current
        // watermark is `accepted`, and nothing is advanced or recorded.
        if self.state.accepted.is_at_watermark(peer_id, &claim) {
            return Some(Judged {
                ack: ClaimAckOutcome::Accepted,
                claim: Some(claim),
            });
        }

        let ack = self.state.connector.handle_peer_claim(claim.clone());
        if ack == ClaimAckOutcome::Accepted {
            self.state.accepted.record(peer_id, &claim);
        }
        Some(Judged {
            ack,
            claim: Some(claim),
        })
    }

    /// §1.7: a connector MUST NOT emit a `claim-ack` on a client
    /// interaction, and §6.2 forbids one on a response answering a frame
    /// that carried no claim. Both are one call.
    fn claim_ack_entry(&self, ack: ClaimAckOutcome) -> Option<ProtocolData> {
        claim_ack_to_emit(self.binding.role(), ack::protocol_data(ack))
    }

    fn reject_response(&self, request_id: u32, reject: Reject, ack: ClaimAckOutcome) -> Vec<u8> {
        encode_packet_response(
            self.binding.role(),
            request_id,
            PacketResponse::Reject(reject),
            ack,
        )
    }

    /// Issue #880: the same x402 greeting the client edge answers an
    /// unpaid or under-covering request with
    /// ([`connector_domain::x402::terms_body`], the one emitter every
    /// carriage shares), `F06`-shaped exactly like the client edge's own
    /// BTP carriage answers a claimless request (`connector-client-edge`'s
    /// `btp` module) since BTP cannot answer HTTP `402`. The claim ack
    /// still rides this same RESPONSE (§6.1) -- the packet's own refusal
    /// and the claim's verdict are independent (§6.2).
    fn payment_required_response(
        &self,
        request_id: u32,
        destination: &str,
        price: u64,
        ack: ClaimAckOutcome,
    ) -> Vec<u8> {
        let terms =
            connector_domain::x402::terms_body(destination, price, None, &[], &[], None, None, 0);
        let reject = Reject {
            code: RejectCode::f06_unexpected_payment(),
            triggered_by: String::new(),
            message: "no payment channel claim covers this packet's price".to_string(),
            data: Vec::new(),
            accumulated_cost: 0,
        };
        let mut entries = vec![
            fields::accumulated_cost_protocol_data(reject.accumulated_cost),
            fields::payment_required_protocol_data(terms),
        ];
        entries.extend(self.claim_ack_entry(ack));
        encode_response(request_id, &entries, &reject.encode())
    }
}

struct Judged {
    ack: ClaimAckOutcome,
    claim: Option<WireClaim>,
}

/// The RESPONSE answering a PREPARE: **two independent answers on one
/// frame** (§6.2). `ilpPacket` answers the packet; the `claim-ack` entry
/// answers the claim. A rejected claim never becomes an ERROR frame and
/// never changes the packet's own outcome, its `accumulatedCost` or its fee
/// accounting -- and a fulfilled packet can carry a `rejected` ack, which is
/// the property whose loss would silently destroy ADR 0024's semantics.
fn encode_packet_response(
    role: &SessionRole,
    request_id: u32,
    response: PacketResponse,
    ack: ClaimAckOutcome,
) -> Vec<u8> {
    let ack_entry = claim_ack_to_emit(role, ack::protocol_data(ack));
    match response {
        PacketResponse::Fulfill(fulfill) => {
            // §5.2: `toon-accumulated-cost` rides **only** a REJECT. It is
            // never emitted beside a FULFILL.
            let entries: Vec<ProtocolData> = ack_entry.into_iter().collect();
            encode_response(request_id, &entries, &Fulfill::encode(&fulfill))
        }
        PacketResponse::Reject(reject) => {
            // §5.2: always emitted on a REJECT, even at zero, so "absent"
            // never has to carry meaning in the direction that matters.
            let mut entries = vec![fields::accumulated_cost_protocol_data(
                reject.accumulated_cost,
            )];
            entries.extend(ack_entry);
            encode_response(request_id, &entries, &reject.encode())
        }
    }
}

async fn window_slot(window: &Arc<Semaphore>) -> OwnedSemaphorePermit {
    Arc::clone(window)
        .acquire_owned()
        .await
        .expect("the session window semaphore is never closed")
}

/// A monotonic-enough millisecond reading for the refusal log's rate
/// limit. Wall clock is fine: the log's own contract says a reading that
/// goes backwards closes the window early rather than suppressing forever.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
