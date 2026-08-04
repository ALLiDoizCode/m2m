//! The client BTP websocket carriage (client-edge-spec.md §1.9, ADR 0026):
//! one persistent, ordered websocket session carrying BTP-framed ILP packets
//! and claims through exactly the pipeline `handle_ilp` runs per request --
//! the same `ClientClaimGate` instance, the same watermarks and journal, the
//! same refusal taxonomy (`claim_rejection_reject`), the same
//! `Connector::handle_prepare`.
//!
//! This module is the client edge's *policy* on a BTP session. The frame
//! grammar itself is not here: it lives in [`connector_btp`], transport- and
//! role-neutral, so the peer carriage of ADR 0027 (issue #676) can speak the
//! same bytes without reaching any of the client-edge types below (issue
//! #713). The deployed `@toon-protocol/client` dialect and RFC-0023's full
//! symmetric grammar are one codec there, not two -- see that crate's own
//! header. What distinguishes this carriage is only what it *does* with a
//! decoded frame: it answers, and originates nothing. Every inbound MESSAGE
//! path a deployed client exercises is unchanged byte for byte.
//!
//! **Ordering** (issue #688): *claims* on one session are judged strictly
//! sequentially, in arrival order -- the session task itself runs every
//! frame's decoding, greeting and claim admission before touching the next
//! frame, which is what makes in-order claims on one socket unable to race
//! each other into `NonceNotAdvancing`, and it is the one ordering the
//! carriage exists to provide. What is *not* serialized any more is the
//! judged frame's remaining work -- waiting out the journal group commit's
//! fsync (issue #686), the downstream delivery, sending the RESPONSE --
//! which proceeds under a bounded per-session in-flight window
//! (`btp_session_window`, default [`crate::DEFAULT_BTP_SESSION_WINDOW`]).
//! Lockstep frame processing made every paid write cost a full downstream
//! round-trip of session capacity, the measured ~125-150 events/s
//! per-session admission wall. Responses therefore complete in whatever
//! order their downstream answers; that is the dialect's own contract --
//! `requestId` correlates a RESPONSE to its MESSAGE, and the deployed
//! client resolves binary frames through its `pendingRequests` map by
//! exactly that id, never by arrival order.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use connector_btp::{
    decode_frame, encode_error, encode_response, reply, BtpDecodeError, BtpSessionHandle,
    OutboundRequests, ProtocolData, SessionGone, ACCUMULATED_COST_PROTOCOL, AUTH_PROTOCOL,
    BTP_ERROR, BTP_MESSAGE, BTP_RESPONSE, BTP_TRANSFER, CLAIM_PROTOCOL, CONTENT_TYPE_TEXT,
    PAYMENT_REQUIRED_PROTOCOL, PAYOUT_CLAIM_PROTOCOL,
};
use connector_domain::client_claim::ClientClaim;
use connector_domain::{PacketResponse, Prepare, Reject, RejectCode};

use crate::claim_gate::DurabilityTicket;
use crate::peer::BtpAuthVerdict;
use crate::{claim_rejection_reject, x402_terms_body, ClaimIngestRejection, ClientEdgeState};

/// `GET /ilp/btp` -- the upgrade. The `btp` subprotocol is selected when
/// the client offers it; an upgrade offering none is accepted identically
/// (the deployed `IsomorphicBtpClient` offers none). Nothing about the
/// session is trusted from the handshake -- authorization to write comes
/// from each frame's claim, exactly as on HTTP.
pub(crate) async fn handle_btp_upgrade(
    State(state): State<Arc<ClientEdgeState>>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.protocols(["btp"])
        .on_upgrade(move |socket| btp_session(socket, state))
}

/// How many completed replies may queue for the socket's writer task
/// before a finishing frame waits its turn -- burst smoothing between the
/// out-of-order completions and the one socket, not admission control
/// (that is the in-flight window's job).
const REPLY_QUEUE_DEPTH: usize = 32;

/// One session (issue #688): the session task reads frames and runs
/// everything order-sensitive inline -- decoding, the greeting, and above
/// all **claim admission**, so one socket's claims are judged strictly in
/// arrival order, the carriage's contract (§1.9). Everything a frame owes
/// *after* its claim is judged -- the group-commit durability wait, the
/// downstream delivery, the RESPONSE -- runs in a task under the
/// per-session in-flight window, so a session's throughput is bounded by
/// `window / downstream-latency` instead of `1 / downstream-latency`. The
/// window doubles as backpressure: when it is full, the session task
/// blocks before reading further frames, exactly the lockstep behavior,
/// degraded to gracefully rather than defaulted to.
///
/// Text frames are ignored; ping/pong is the websocket layer's own
/// concern; a transport error or close ends the session. Claims judged
/// here advance the same watermarks HTTP requests advance, so a session
/// outliving many requests changes nothing about what any one claim must
/// prove. A frame task that outlives the session finishes its durability
/// wait and delivery normally -- the claim was accepted -- and its reply
/// simply has nowhere to go.
async fn btp_session(socket: WebSocket, state: Arc<ClientEdgeState>) {
    let (sink, mut stream) = socket.split();
    // The one writer: frame tasks complete in whatever order their
    // downstream answers, and this channel is where those completions
    // serialize back into socket writes.
    let (replies, mut reply_rx) = mpsc::channel::<Vec<u8>>(REPLY_QUEUE_DEPTH);
    let writer = tokio::spawn(async move {
        let mut sink = sink;
        while let Some(bytes) = reply_rx.recv().await {
            if sink.send(Message::Binary(bytes)).await.is_err() {
                break;
            }
        }
    });
    let window = Arc::new(Semaphore::new(state.btp_session_window.get() as usize));
    // This session's outbound requestId space and RESPONSE/ERROR
    // correlation table (issue #697). Always live, whether or not anything
    // ever originates a request on it -- with nothing pending, every
    // inbound RESPONSE/ERROR still resolves to nothing, exactly as before
    // this table existed.
    let outbound = Arc::new(OutboundRequests::new());
    // This session's binding in the client session registry (issue #698),
    // if auth has named one: the address it registered as and the fencing
    // generation that bind returned. `None` until an auth frame with a
    // usable `peerId` arrives, and for the lifetime of a session that
    // never sends one -- unbound, exactly as every session behaved before
    // this registry existed.
    let mut binding: Option<(String, u64)> = None;
    // ADR 0027 / issue #678: this socket serves two audiences. A session
    // starts `client` -- `SessionRole`'s own default, not a third state --
    // and becomes a peer session only when an `auth` entry proving §1.2's
    // P1 *and* P2 arrives. Once it does, every remaining frame is the peer
    // carriage's; frames processed before that stay client frames and are
    // never retroactively reclassified (§1.5).
    let mut peer_session: Option<connector_peer_btp::PeerSession> = None;
    while let Some(received) = stream.next().await {
        let frame_bytes = match received {
            Ok(Message::Binary(bytes)) => bytes,
            Ok(Message::Close(_)) => break,
            Ok(_) => continue,
            Err(_) => break,
        };
        if let Some(session) = peer_session.as_mut() {
            match session.handle_frame(&frame_bytes).await {
                Ok(None) => continue,
                // The peer carriage ended the session deliberately, or the
                // socket's send half is gone.
                Ok(Some(_)) | Err(_) => break,
            }
        }
        match peer_handover(&frame_bytes, &state) {
            // Not consumed: the same frame is handed to the peer session,
            // which binds its own role from it and answers it (§1.5 --
            // role is bound in exactly one place).
            Some(BtpAuthVerdict::Peer) => {
                let peer_state = state
                    .peers
                    .as_ref()
                    .and_then(|peers| peers.btp_state())
                    .expect("a Peer verdict is only reachable with a BTP carriage mounted");
                let mut session = connector_peer_btp::PeerSession::with_outbound(
                    peer_state,
                    replies.clone(),
                    Arc::clone(&outbound),
                );
                match session.handle_frame(&frame_bytes).await {
                    Ok(None) => {}
                    Ok(Some(_)) | Err(_) => break,
                }
                peer_session = Some(session);
                continue;
            }
            // §1.5's credential-smuggling defence: more than one `auth`
            // entry on one frame is refused, not resolved. ERROR stays
            // reserved for a frame this connector will not act on (§6.2).
            Some(BtpAuthVerdict::Ambiguous) => {
                let frame = decode_frame(&frame_bytes).expect("peeked frames already decoded");
                if reply(
                    &replies,
                    encode_error(
                        frame.request_id,
                        "F00",
                        "NotAcceptedError",
                        b"more than one auth entry on one frame",
                    ),
                )
                .await
                .is_err()
                {
                    break;
                }
                continue;
            }
            Some(BtpAuthVerdict::Client) | None => {}
        }
        if handle_frame(
            &frame_bytes,
            &state,
            &window,
            &replies,
            &outbound,
            &mut binding,
        )
        .await
        .is_err()
        {
            // The socket's send half is gone; nothing further this session
            // reads could ever be answered.
            break;
        }
    }
    // Clear this session's own binding, fenced against a reconnect that
    // has already superseded it (issue #698's "may never say take over"):
    // `unbind` is a no-op if `binding`'s generation is no longer current.
    if let Some((address, generation)) = binding {
        state.session_registry.unbind(&address, generation);
    }
    drop(replies);
    let _ = writer.await;
}

/// Whether this frame's `auth` entry hands the rest of the session to the
/// peer carriage (`peer-carriage-spec.md` §1.2, §1.5, issue #678).
///
/// `None` for every frame that is not a MESSAGE carrying an `auth` entry,
/// and for every node that mounts no BTP peer carriage -- which is the
/// whole of what this costs a client session: one `iter().any()` over a
/// frame's protocolData, on the frames that carry a credential.
///
/// The frame is **peeked, not consumed**. §1.3 forbids inferring role from
/// the listener, and this function inspects nothing but the credential and
/// the configured policy; the binding itself happens once, inside
/// [`connector_peer_btp::PeerSession`], from this very frame.
fn peer_handover(frame_bytes: &[u8], state: &Arc<ClientEdgeState>) -> Option<BtpAuthVerdict> {
    let peers = state.peers.as_ref()?;
    let frame = decode_frame(frame_bytes).ok()?;
    if frame.frame_type != BTP_MESSAGE {
        return None;
    }
    if !frame
        .protocol_data
        .iter()
        .any(|entry| entry.name == AUTH_PROTOCOL)
    {
        return None;
    }
    Some(peers.btp_auth_verdict(&frame.protocol_data))
}

/// A slot in the session's in-flight window, holding the read loop back
/// once `btp_session_window` frames are past admission and not yet
/// answered.
async fn window_slot(window: &Arc<Semaphore>) -> OwnedSemaphorePermit {
    Arc::clone(window)
        .acquire_owned()
        .await
        .expect("the session window semaphore is never closed")
}

/// A claim's batch just cleared durability: mark its channel recognized,
/// making the sender eligible to probe (issue #548), and note the
/// claim-state endpoint's liveness timestamp (issue #693), same as
/// `handle_ilp`'s HTTP carriage. Shared by both places a BTP claim can
/// finish durable -- a standalone claim message and a claim riding a
/// packet -- so the two stay in lockstep.
fn record_accepted_claim(state: &ClientEdgeState, claim: &ClientClaim) {
    let channel_key = claim.channel_key();
    state.connector.recognize_channel(&channel_key);
    state
        .claim_gate
        .note_claim_time(&channel_key, crate::now_unix());
}

/// Best-effort extraction of an auth frame's declared identity (issue
/// #698): the same `{"peerId": ..., "secret": ...}` shape the client
/// already sends (`auth_frame_vector` in this module's own tests), used
/// only as the session registry's bind key -- never as authorization,
/// which still comes solely from each frame's claim, exactly as the doc
/// comment on the auth branch above says. `None` for anything that does
/// not parse as JSON, carries no `peerId`, or declares an empty one; a
/// session with no usable declared identity is simply never bound.
fn auth_peer_id(auth_data: &[u8]) -> Option<String> {
    let json: serde_json::Value = serde_json::from_slice(auth_data).ok()?;
    let peer_id = json.get("peerId")?.as_str()?;
    if peer_id.is_empty() {
        None
    } else {
        Some(peer_id.to_string())
    }
}

/// A REJECT as a RESPONSE frame: the OER body as the ILP packet, the
/// running cost total as `toon-accumulated-cost` protocolData (§1.6's
/// header, carried the only way a frame can), plus whatever `extra`
/// entries the refusal itself owes (the F06 greeting's terms).
fn reject_response(request_id: u32, reject: Reject, extra: Vec<ProtocolData>) -> Vec<u8> {
    let mut protocol_data = vec![ProtocolData {
        name: ACCUMULATED_COST_PROTOCOL.to_string(),
        content_type: CONTENT_TYPE_TEXT,
        data: reject.accumulated_cost.to_string().into_bytes(),
    }];
    protocol_data.extend(extra);
    encode_response(request_id, &protocol_data, &reject.encode())
}

/// The protocolData entry a payout TRANSFER carries (issue #699): the
/// signed cumulative claim this connector owes the client on that channel,
/// as JSON -- `channelId`/`nonce`/`cumulativeAmount` matching
/// `WireClaim`'s own fields, `signature` hex-encoded the same way
/// `ClientClaimGate`'s inbound claim JSON already expects one
/// (`0x`-prefixed 65-byte `r‖s‖recoveryId`). JSON rather than
/// [`connector_runtime::WireClaim::encode`]'s peer-wire binary shape,
/// matching every other protocolData entry this dialect ever carries -- the
/// auth secret, the inbound claim, the x402 terms, the accumulated-cost
/// total -- all of which are raw UTF-8 text, never a second binary
/// sub-format riding inside the frame's own binary envelope.
///
/// There is no `signerAddress` field: unlike a client's self-declared one
/// (never trusted -- see `ClientClaimGate`'s own doc), this claim's signer
/// is the channel's own recorded counterparty from the client's point of
/// view, implicit in which channel the TRANSFER arrived on, exactly as a
/// peer-wire `WireClaim` carries no signer field either.
///
/// This is the mapping of a *claim* onto the grammar, so it stays with the
/// client edge rather than moving into [`connector_btp`] with the codec
/// (issue #713): the codec owns the entry's name and the bytes that carry
/// it, and deliberately cannot see a claim type.
///
/// `#[allow(dead_code)]`: no production caller until the session-registry
/// ticket (`toon-meta#262`) exists; proven by this module's own tests
/// against the real production types in the meantime.
#[allow(dead_code)]
pub(crate) fn payout_claim_protocol_data(claim: &connector_runtime::WireClaim) -> ProtocolData {
    let json = serde_json::json!({
        "channelId": claim.channel_id,
        "nonce": claim.nonce,
        "cumulativeAmount": claim.cumulative_amount,
        "signature": format!("0x{}", hex::encode(claim.signature.to_bytes())),
    });
    ProtocolData {
        name: PAYOUT_CLAIM_PROTOCOL.to_string(),
        content_type: CONTENT_TYPE_TEXT,
        data: serde_json::to_vec(&json).expect("a json! object always serializes"),
    }
}

/// Process one frame: everything order-sensitive inline (claims are judged
/// here, in arrival order), the rest handed to a windowed task (issue
/// #688). Nothing is queued where the contract answers nothing: an
/// unrecognized frame type, a standalone claim (fire-and-forget by the
/// client's own contract), a MESSAGE carrying neither auth nor claim nor
/// packet, and a frame too short to even name a requestId.
///
/// `binding` is this session's own slot in the client session registry
/// (issue #698): `None` until an auth frame installs one, updated here on
/// auth and touched on every frame afterward so `btp_session`'s own
/// unbind-on-close has something to fence against.
async fn handle_frame(
    frame_bytes: &[u8],
    state: &Arc<ClientEdgeState>,
    window: &Arc<Semaphore>,
    replies: &mpsc::Sender<Vec<u8>>,
    outbound: &Arc<OutboundRequests>,
    binding: &mut Option<(String, u64)>,
) -> Result<(), SessionGone> {
    let frame = match decode_frame(frame_bytes) {
        Ok(frame) => frame,
        Err(BtpDecodeError::TooShort) => return Ok(()),
        Err(BtpDecodeError::Malformed { request_id, reason }) => {
            return reply(
                replies,
                encode_error(request_id, "F00", "NotAcceptedError", reason.as_bytes()),
            )
            .await;
        }
    };
    // A live session is still live (issue #698 AC5's backstop TTL clock),
    // whatever it just sent -- a no-op if `binding`'s generation has
    // already been superseded by a reconnect on another socket.
    if let Some((address, generation)) = binding.as_ref() {
        state
            .session_registry
            .touch(address, *generation, crate::now_unix());
    }
    // RESPONSE/ERROR answering a request *this connector* originated
    // (issue #697): correlate and stop, whether or not it matched --
    // ordinary inbound traffic that answers nothing the connector itself
    // sent (every RESPONSE/ERROR today, absent a caller of
    // `BtpSessionHandle`) leaves `resolve` a no-op and the frame silently
    // dropped, byte-identical to this session's pre-#697 behavior.
    if frame.frame_type == BTP_RESPONSE || frame.frame_type == BTP_ERROR {
        outbound.resolve(frame);
        return Ok(());
    }
    // TRANSFER (issue #697): acknowledged, not yet accounted -- RFC-23
    // requires a responder answer every request, and the settlement/netting
    // semantics this frame will eventually carry are the payout-ledger
    // ticket's job (toon-meta#262), not this foundation ticket's. An empty
    // RESPONSE is the same shape the `auth` ack below already uses for
    // "received, nothing more to say yet".
    if frame.frame_type == BTP_TRANSFER {
        return reply(replies, encode_response(frame.request_id, &[], &[])).await;
    }
    if frame.frame_type != BTP_MESSAGE {
        return Ok(());
    }

    // Auth (§1.9 step 1): acknowledged, not verified -- §1.2 is not
    // implemented on the HTTP carriage either, and an empty `secret` is the
    // documented permissionless mirror. Authorization to write comes from
    // the claim on each packet, never from the session.
    //
    // Issue #698: a declared, non-empty `peerId` doubles as this session's
    // key in the client session registry -- "the socket is the lease".
    // Binding is best-effort and never blocks the ack: a session with no
    // usable `peerId` (missing, empty, or the auth body not even JSON) is
    // simply never registered, unaffected otherwise, exactly as before
    // this registry existed. Re-auth on an already-bound session rebinds
    // under a fresh generation, which is the correct outcome even though
    // nothing sends a second auth today.
    if let Some(entry) = frame
        .protocol_data
        .iter()
        .find(|pd| pd.name == AUTH_PROTOCOL)
    {
        if let Some(address) = auth_peer_id(&entry.data) {
            let handle = BtpSessionHandle::new(replies.clone(), Arc::clone(outbound));
            let generation =
                state
                    .session_registry
                    .bind(address.clone(), handle, crate::now_unix());
            *binding = Some((address, generation));
        }
        return reply(replies, encode_response(frame.request_id, &[], &[])).await;
    }

    let claim_json = match frame
        .protocol_data
        .iter()
        .find(|pd| pd.name == CLAIM_PROTOCOL)
    {
        Some(pd) => match String::from_utf8(pd.data.clone()) {
            Ok(json) => Some(json),
            Err(error) => {
                let rejection = ClaimIngestRejection::Malformed(format!(
                    "claim protocolData is not valid UTF-8: {error}"
                ));
                return reply(
                    replies,
                    reject_response(
                        frame.request_id,
                        claim_rejection_reject(rejection, 0),
                        Vec::new(),
                    ),
                )
                .await;
            }
        },
        None => None,
    };

    // A standalone claim (§1.9 step 4): admitted against price 0 --
    // identify-not-pay, exactly `handle_probe`'s semantics -- and answered
    // with nothing, per the client's `sendClaimMessage` contract. A refusal
    // here is logged, not framed: there is no response to carry it. The
    // admission is inline (in claim order, like every claim); only the
    // durability wait rides a windowed task, and a claim whose batch fails
    // is likewise only logged.
    if frame.ilp_packet.is_empty() {
        if let Some(json) = claim_json {
            match state.claim_gate.admit(&json, 0).await {
                Ok((claim, durability)) => {
                    let permit = window_slot(window).await;
                    let state = Arc::clone(state);
                    tokio::spawn(async move {
                        let _slot = permit;
                        match durability.durable().await {
                            Ok(()) => record_accepted_claim(&state, &claim),
                            Err(rejection) => tracing::debug!(
                                rejection = %rejection.message(),
                                "standalone BTP claim accepted but not durably recorded"
                            ),
                        }
                    });
                }
                Err(rejection) => {
                    tracing::debug!(
                        rejection = %rejection.message(),
                        "standalone BTP claim refused"
                    );
                }
            }
        }
        return Ok(());
    }

    let prepare = match Prepare::decode(&frame.ilp_packet) {
        Ok(prepare) => prepare,
        Err(error) => {
            // The HTTP carriage's 400 (§1.1): a transport-level answer, not
            // an ILP-level one, so an ERROR frame rather than a REJECT.
            return reply(
                replies,
                encode_error(
                    frame.request_id,
                    "F00",
                    "NotAcceptedError",
                    error.to_string().as_bytes(),
                ),
            )
            .await;
        }
    };

    // One lookup serves both facts (issue #701): see `handle_ilp`'s mirror
    // of this on the HTTP carriage.
    let app_route = state.connector.app_route(&prepare.destination);
    let price = app_route.map_or(0, |route| route.price);

    // Transport policy (issue #701, toon-meta#262 decision 11), BTP-shaped:
    // checked before payment is considered at all, exactly like the HTTP
    // carriage's `handle_ilp` -- a route restricted to HTTP is unreachable
    // over this session whether or not the PREPARE carries a valid claim.
    // F02 (Unreachable) is the honest code from this carriage's own point
    // of view: there is no route to this destination reachable over BTP,
    // even though one exists over HTTP. The terms JSON rides the same
    // `payment-required` protocolData slot the §1.4 greeting below uses,
    // self-diagnosing via `extra.requiredTransport` rather than a second
    // mechanism.
    if let Some(policy) = app_route.map(|route| route.transport_policy) {
        if !policy.accepts_btp() {
            let terms = x402_terms_body(
                &prepare.destination,
                price,
                state.settlement_terms.as_ref(),
                &state.settlements,
                Some(policy.name()),
            );
            let reject = Reject {
                code: RejectCode::f02_unreachable(),
                triggered_by: String::new(),
                message: format!(
                    "route '{}' requires transport '{}'",
                    prepare.destination,
                    policy.name()
                ),
                data: Vec::new(),
                accumulated_cost: 0,
            };
            return reply(
                replies,
                reject_response(
                    frame.request_id,
                    reject,
                    vec![ProtocolData {
                        name: PAYMENT_REQUIRED_PROTOCOL.to_string(),
                        content_type: CONTENT_TYPE_TEXT,
                        data: terms,
                    }],
                ),
            )
            .await;
        }
    }

    // The §1.4 greeting, BTP-shaped (§1.9 step 3): BTP cannot answer HTTP
    // 402, so the same terms JSON rides as protocolData on an F06 REJECT.
    // A claimless PREPARE to an unpriced route falls through unchanged,
    // exactly as on HTTP.
    if claim_json.is_none() && price > 0 {
        let terms = x402_terms_body(
            &prepare.destination,
            price,
            state.settlement_terms.as_ref(),
            &state.settlements,
            None,
        );
        let reject = Reject {
            code: RejectCode::f06_unexpected_payment(),
            triggered_by: String::new(),
            message: "No payment channel claim attached".to_string(),
            data: Vec::new(),
            accumulated_cost: 0,
        };
        return reply(
            replies,
            reject_response(
                frame.request_id,
                reject,
                vec![ProtocolData {
                    name: PAYMENT_REQUIRED_PROTOCOL.to_string(),
                    content_type: CONTENT_TYPE_TEXT,
                    data: terms,
                }],
            ),
        )
        .await;
    }

    // §1.3, verbatim: the same gate, watermarks and refusal taxonomy as
    // `handle_ilp`. Admission -- the only order-sensitive step -- happens
    // here, inline; a refusal answers immediately, and an acceptance
    // carries its durability ticket into the windowed task below.
    let admitted = match claim_json {
        Some(json) => match state.claim_gate.admit(&json, price).await {
            Ok(accepted) => Some(accepted),
            Err(rejection) => {
                return reply(
                    replies,
                    reject_response(
                        frame.request_id,
                        claim_rejection_reject(rejection, price),
                        Vec::new(),
                    ),
                )
                .await;
            }
        },
        None => None,
    };

    let permit = window_slot(window).await;
    let task = finish_frame(
        Arc::clone(state),
        admitted,
        prepare,
        price,
        frame.request_id,
        replies.clone(),
    );
    tokio::spawn(async move {
        let _slot = permit;
        task.await;
    });
    Ok(())
}

/// A judged frame's remaining, order-insensitive work (issue #688), run
/// under one in-flight-window slot: wait for the claim's batch fsync
/// (durable-before-service, exactly `ingest`'s own contract -- the
/// downstream is never asked to do work whose payment a restart could
/// forget), then route the packet and queue the RESPONSE. A claim whose
/// batch could not be made durable answers the same `NotDurable` REJECT
/// the HTTP carriage sends, and its packet is never routed.
async fn finish_frame(
    state: Arc<ClientEdgeState>,
    admitted: Option<(ClientClaim, DurabilityTicket)>,
    prepare: Prepare,
    price: u64,
    request_id: u32,
    replies: mpsc::Sender<Vec<u8>>,
) {
    if let Some((claim, durability)) = admitted {
        match durability.durable().await {
            // A claim that cleared the gate makes the sender eligible to
            // probe and notes the claim-state endpoint's liveness
            // timestamp -- see `record_accepted_claim`.
            Ok(()) => record_accepted_claim(&state, &claim),
            Err(rejection) => {
                let _ = reply(
                    &replies,
                    reject_response(
                        request_id,
                        claim_rejection_reject(rejection, price),
                        Vec::new(),
                    ),
                )
                .await;
                return;
            }
        }
    }

    let response = match state.connector.handle_prepare(prepare, 0).await {
        PacketResponse::Fulfill(fulfill) => encode_response(request_id, &[], &fulfill.encode()),
        PacketResponse::Reject(reject) => reject_response(request_id, reject, Vec::new()),
    };
    let _ = reply(&replies, response).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use connector_btp::{decode_frame, BtpFrame, BtpSessionHandle};

    /// Issue #699: a payout claim rides a TRANSFER's protocolData as JSON,
    /// matching every other entry this dialect carries (all UTF-8 text,
    /// never a second binary sub-format) rather than
    /// [`connector_runtime::WireClaim::encode`]'s peer-wire bytes.
    #[test]
    fn payout_claim_protocol_data_encodes_the_wire_claims_fields_as_json() {
        let claim = connector_runtime::WireClaim {
            channel_id: format!("0x{:064x}", 1),
            nonce: 3,
            cumulative_amount: 750,
            signature: connector_runtime::ClaimSignature::Evm(connector_signer::Signature {
                r: [0x11; 32],
                s: [0x22; 32],
                recovery_id: 1,
            }),
        };

        let pd = payout_claim_protocol_data(&claim);

        assert_eq!(pd.name, PAYOUT_CLAIM_PROTOCOL);
        assert_eq!(pd.content_type, CONTENT_TYPE_TEXT);
        let json: serde_json::Value = serde_json::from_slice(&pd.data).expect("valid JSON");
        assert_eq!(json["channelId"], claim.channel_id);
        assert_eq!(json["nonce"], 3);
        assert_eq!(json["cumulativeAmount"], 750);
        assert_eq!(
            json["signature"],
            format!("0x{}", hex::encode(claim.signature.to_bytes()))
        );
    }

    /// Issue #699 end-to-end through the real production types: a
    /// [`crate::outbound_ledger::ClientPayoutLedger`] signs a payout claim,
    /// [`payout_claim_protocol_data`] carries it as a TRANSFER's
    /// protocolData over [`BtpSessionHandle::send_transfer`], and a
    /// stand-in client -- reading off the same wire `btp_session`'s writer
    /// task would write to -- decodes the frame, parses the JSON claim
    /// back out, and verifies its signature against the connector's own
    /// public key. Nothing here is a fake shortcut: the ledger, the frame
    /// codec and the origination path are exactly what a real session
    /// would run once a caller (the session-registry ticket, `toon-meta#262`)
    /// decides when to push a payout.
    #[tokio::test]
    async fn a_signed_payout_claim_is_delivered_over_transfer_and_verifies() {
        use crate::outbound_ledger::ClientPayoutLedger;
        use connector_runtime::ChannelDomain;
        use connector_signer::{
            derive_evm_address, verify_evm_balance_proof, EvmBalanceProof, LocalSigner, Signer,
        };

        let signer = Arc::new(LocalSigner::generate("payout-key"));
        let connector_address = derive_evm_address(&signer.public_key().unwrap());
        let domain = ChannelDomain {
            chain_id: 84_532,
            token_network_address: [0x33; 20],
        };
        let channel_id = format!("0x{:064x}", 7);

        let mut ledger = ClientPayoutLedger::new();
        ledger.set_signer(signer);
        ledger
            .set_channel_domain(channel_id.clone(), domain)
            .expect("valid channel id");
        let claim = ledger
            .record_payout(&channel_id, 42_000, "2030-01-01T00:00:00Z".parse().unwrap())
            .expect("signer and domain configured");

        let (replies, mut reply_rx) = mpsc::channel::<Vec<u8>>(1);
        let outbound = Arc::new(OutboundRequests::new());
        let handle = BtpSessionHandle::new(replies, Arc::clone(&outbound));

        let expected_channel_id = channel_id.clone();
        let peer = tokio::spawn(async move {
            let sent = reply_rx.recv().await.expect("the TRANSFER was written");
            let decoded = decode_frame(&sent).expect("the connector's own encoder");
            assert_eq!(decoded.frame_type, BTP_TRANSFER);
            assert_eq!(decoded.amount, Some(42_000));

            let pd = decoded
                .protocol_data
                .iter()
                .find(|pd| pd.name == PAYOUT_CLAIM_PROTOCOL)
                .expect("the payout claim rode the TRANSFER");
            let json: serde_json::Value = serde_json::from_slice(&pd.data).expect("valid JSON");
            assert_eq!(json["channelId"], expected_channel_id);
            assert_eq!(json["nonce"], 1);
            assert_eq!(json["cumulativeAmount"], 42_000);
            let signature_hex = json["signature"].as_str().unwrap();
            let signature_bytes = hex::decode(signature_hex.strip_prefix("0x").unwrap()).unwrap();

            let mut on_chain_id = [0u8; 32];
            on_chain_id[31] = 7;
            let proof = EvmBalanceProof {
                channel_id: on_chain_id,
                nonce: json["nonce"].as_u64().unwrap(),
                transferred_amount: u128::from(json["cumulativeAmount"].as_u64().unwrap()),
                locked_amount: 0,
                locks_root: [0u8; 32],
                chain_id: domain.chain_id,
                token_network_address: domain.token_network_address,
            };
            assert!(verify_evm_balance_proof(
                &proof,
                &signature_bytes,
                &connector_address
            ));

            outbound.resolve(BtpFrame {
                frame_type: BTP_RESPONSE,
                request_id: decoded.request_id,
                amount: None,
                protocol_data: Vec::new(),
                ilp_packet: Vec::new(),
            });
        });

        handle
            .send_transfer(42_000, &[payout_claim_protocol_data(&claim)])
            .await
            .expect("the peer answered before the timeout");
        peer.await.expect("the peer task");
    }
}
