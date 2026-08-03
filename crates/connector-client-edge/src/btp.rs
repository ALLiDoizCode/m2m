//! The client BTP websocket carriage (client-edge-spec.md §1.9, ADR 0026):
//! one persistent, ordered websocket session carrying BTP-framed ILP packets
//! and claims through exactly the pipeline `handle_ilp` runs per request --
//! the same `ClientClaimGate` instance, the same watermarks and journal, the
//! same refusal taxonomy (`claim_rejection_reject`), the same
//! `Connector::handle_prepare`. Peers never enter here: connector↔connector
//! traffic is the raw-TCP peer wire, so every session this module serves is
//! a client session by construction.
//!
//! The frame grammar is the deployed `@toon-protocol/client` dialect
//! (`btp/protocol.ts`), NOT RFC-23's full grammar -- see §1.9 for the
//! layout, and this module's unit vectors for the bytes.
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

use connector_domain::client_claim::ClientClaim;
use connector_domain::{PacketResponse, Prepare, Reject, RejectCode};

use crate::claim_gate::DurabilityTicket;
use crate::{claim_rejection_reject, x402_terms_body, ClaimIngestRejection, ClientEdgeState};

/// BTP frame types (client `btp/protocol.ts` `BTPMessageType`). The server
/// receives MESSAGE and answers RESPONSE or ERROR; it never originates a
/// requestId.
const BTP_RESPONSE: u8 = 1;
const BTP_ERROR: u8 = 2;
const BTP_MESSAGE: u8 = 6;

/// protocolData entry names (client `BtpRuntimeClient.ts` /
/// `IsomorphicBtpClient.ts`). The claim is raw UTF-8 claim JSON -- no
/// base64 layer; that is an HTTP-header artifact (§1.3 vs §1.9).
const AUTH_PROTOCOL: &str = "auth";
const CLAIM_PROTOCOL: &str = "payment-channel-claim";
/// BTP analogues of the HTTP `Payment-Required` / `TOON-Accumulated-Cost`
/// headers (§1.4, §1.6): the same bytes, riding as protocolData on a REJECT
/// RESPONSE since a websocket frame has no headers.
const PAYMENT_REQUIRED_PROTOCOL: &str = "payment-required";
const ACCUMULATED_COST_PROTOCOL: &str = "toon-accumulated-cost";

/// The contentType the client itself uses for its JSON claim entry (its
/// parser never reads the field back). Emitted on every server entry for
/// consistency rather than meaning.
const CONTENT_TYPE_TEXT: u16 = 1;

/// One decoded protocolData entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProtocolData {
    pub(crate) name: String,
    pub(crate) content_type: u16,
    pub(crate) data: Vec<u8>,
}

/// A decoded MESSAGE/RESPONSE body: the protocolData list plus the ILP
/// packet riding beside it (empty = none; the dialect writes a zero length
/// rather than omitting the field).
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct BtpFrame {
    pub(crate) frame_type: u8,
    pub(crate) request_id: u32,
    pub(crate) protocol_data: Vec<ProtocolData>,
    pub(crate) ilp_packet: Vec<u8>,
}

/// Why a frame did not decode. `TooShort` means not even the 5-byte
/// `type + requestId` prefix was readable, so there is no id to answer an
/// ERROR to; `Malformed` carries the id so the answer can correlate.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BtpDecodeError {
    TooShort,
    Malformed { request_id: u32, reason: String },
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
    request_id: u32,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize, what: &str) -> Result<&'a [u8], BtpDecodeError> {
        let end = self.pos.checked_add(n).filter(|end| *end <= self.buf.len());
        let Some(end) = end else {
            return Err(BtpDecodeError::Malformed {
                request_id: self.request_id,
                reason: format!("frame truncated reading {what}"),
            });
        };
        let slice = &self.buf[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn u8(&mut self, what: &str) -> Result<u8, BtpDecodeError> {
        Ok(self.take(1, what)?[0])
    }

    fn u16(&mut self, what: &str) -> Result<u16, BtpDecodeError> {
        let bytes = self.take(2, what)?;
        Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
    }

    fn u32(&mut self, what: &str) -> Result<u32, BtpDecodeError> {
        let bytes = self.take(4, what)?;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn remaining(&self) -> usize {
        self.buf.len() - self.pos
    }
}

/// Decode one frame. Only MESSAGE/RESPONSE bodies are given structure --
/// an ERROR frame from a client answers nothing and is skipped by the
/// session loop on its type alone, so its body is preserved undecoded in
/// `ilp_packet`-less form (empty protocolData, raw bytes discarded).
/// Trailing bytes beyond the declared ILP length are ignored, exactly as
/// the client's own parser ignores them.
pub(crate) fn decode_frame(buf: &[u8]) -> Result<BtpFrame, BtpDecodeError> {
    if buf.len() < 5 {
        return Err(BtpDecodeError::TooShort);
    }
    let frame_type = buf[0];
    let request_id = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]);
    if frame_type == BTP_ERROR {
        return Ok(BtpFrame {
            frame_type,
            request_id,
            protocol_data: Vec::new(),
            ilp_packet: Vec::new(),
        });
    }
    let mut reader = Reader {
        buf,
        pos: 5,
        request_id,
    };
    let count = reader.u8("protocolData count")?;
    let mut protocol_data = Vec::with_capacity(usize::from(count));
    for _ in 0..count {
        let name_len = reader.u8("protocolData name length")?;
        let name_bytes = reader.take(usize::from(name_len), "protocolData name")?;
        let name =
            String::from_utf8(name_bytes.to_vec()).map_err(|_| BtpDecodeError::Malformed {
                request_id,
                reason: "protocolData name is not valid UTF-8".to_string(),
            })?;
        let content_type = reader.u16("protocolData contentType")?;
        let data_len = reader.u32("protocolData length")?;
        let data = reader
            .take(data_len as usize, "protocolData bytes")?
            .to_vec();
        protocol_data.push(ProtocolData {
            name,
            content_type,
            data,
        });
    }
    // The dialect always writes the trailing ILP length, but the client's
    // own parser tolerates its absence -- mirror that tolerance.
    let ilp_packet = if reader.remaining() >= 4 {
        let ilp_len = reader.u32("ILP packet length")?;
        reader.take(ilp_len as usize, "ILP packet bytes")?.to_vec()
    } else {
        Vec::new()
    };
    Ok(BtpFrame {
        frame_type,
        request_id,
        protocol_data,
        ilp_packet,
    })
}

/// Encode a RESPONSE frame answering `request_id`, carrying `protocol_data`
/// and `ilp_packet` (empty = none; the length field is always written, as
/// the client serializer does).
pub(crate) fn encode_response(
    request_id: u32,
    protocol_data: &[ProtocolData],
    ilp_packet: &[u8],
) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(BTP_RESPONSE);
    out.extend_from_slice(&request_id.to_be_bytes());
    out.push(protocol_data.len() as u8);
    for pd in protocol_data {
        let name = pd.name.as_bytes();
        out.push(name.len() as u8);
        out.extend_from_slice(name);
        out.extend_from_slice(&pd.content_type.to_be_bytes());
        out.extend_from_slice(&(pd.data.len() as u32).to_be_bytes());
        out.extend_from_slice(&pd.data);
    }
    out.extend_from_slice(&(ilp_packet.len() as u32).to_be_bytes());
    out.extend_from_slice(ilp_packet);
    out
}

/// Encode an ERROR frame (§1.9 step 5): `code`/`name`/`triggeredAt` as
/// 1-byte-length-prefixed strings, then the diagnostic text as a
/// u32-length-prefixed trailer, per the client's `parseBtpMessage` ERROR
/// arm. `triggeredAt` is deliberately empty: this crate carries no clock,
/// and the client surfaces it only inside a human-readable message.
pub(crate) fn encode_error(request_id: u32, code: &str, name: &str, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(BTP_ERROR);
    out.extend_from_slice(&request_id.to_be_bytes());
    for field in [code, name, ""] {
        let bytes = field.as_bytes();
        out.push(bytes.len() as u8);
        out.extend_from_slice(bytes);
    }
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(data);
    out
}

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
    while let Some(received) = stream.next().await {
        let frame_bytes = match received {
            Ok(Message::Binary(bytes)) => bytes,
            Ok(Message::Close(_)) => break,
            Ok(_) => continue,
            Err(_) => break,
        };
        if handle_frame(&frame_bytes, &state, &window, &replies)
            .await
            .is_err()
        {
            // The socket's send half is gone; nothing further this session
            // reads could ever be answered.
            break;
        }
    }
    drop(replies);
    let _ = writer.await;
}

/// The session's send half is gone -- the writer task exited, so no reply
/// can ever be delivered again and the session loop should end.
struct SessionGone;

/// Queue one reply frame for the writer task.
async fn reply(replies: &mpsc::Sender<Vec<u8>>, frame: Vec<u8>) -> Result<(), SessionGone> {
    replies.send(frame).await.map_err(|_| SessionGone)
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

/// Process one frame: everything order-sensitive inline (claims are judged
/// here, in arrival order), the rest handed to a windowed task (issue
/// #688). Nothing is queued where the contract answers nothing: a
/// non-MESSAGE frame, a standalone claim (fire-and-forget by the client's
/// own contract), a MESSAGE carrying neither auth nor claim nor packet,
/// and a frame too short to even name a requestId.
async fn handle_frame(
    frame_bytes: &[u8],
    state: &Arc<ClientEdgeState>,
    window: &Arc<Semaphore>,
    replies: &mpsc::Sender<Vec<u8>>,
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
    if frame.frame_type != BTP_MESSAGE {
        return Ok(());
    }

    // Auth (§1.9 step 1): acknowledged, not verified -- §1.2 is not
    // implemented on the HTTP carriage either, and an empty `secret` is the
    // documented permissionless mirror. Authorization to write comes from
    // the claim on each packet, never from the session.
    if frame
        .protocol_data
        .iter()
        .any(|pd| pd.name == AUTH_PROTOCOL)
    {
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

    let price = state
        .connector
        .app_route_price(&prepare.destination)
        .unwrap_or(0);

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

    /// §1.9's frame grammar, byte-for-byte: the exact bytes
    /// `@toon-protocol/client`'s `serializeBtpMessage` produces for its auth
    /// frame (`serializeBtpMessage({type: 6, requestId: 1, data:
    /// {protocolData: [{protocolName: 'auth', contentType: 0, data:
    /// utf8('{"peerId":"p","secret":""}')}], ilpPacket: new Uint8Array(0)}})`).
    /// These vectors pin the dialect; prose is not the thing to conform to
    /// (ADR 0021).
    fn auth_frame_vector() -> Vec<u8> {
        let auth_json = br#"{"peerId":"p","secret":""}"#;
        let mut frame = vec![
            6, // MESSAGE
            0, 0, 0, 1, // requestId 1
            1, // one protocolData entry
            4, // nameLen
        ];
        frame.extend_from_slice(b"auth");
        frame.extend_from_slice(&[0, 0]); // contentType 0
        frame.extend_from_slice(&(auth_json.len() as u32).to_be_bytes());
        frame.extend_from_slice(auth_json);
        frame.extend_from_slice(&[0, 0, 0, 0]); // ilpPacket length 0
        frame
    }

    #[test]
    fn the_clients_auth_frame_decodes_exactly() {
        let frame = decode_frame(&auth_frame_vector()).expect("the client's own bytes decode");
        assert_eq!(frame.frame_type, BTP_MESSAGE);
        assert_eq!(frame.request_id, 1);
        assert_eq!(frame.protocol_data.len(), 1);
        assert_eq!(frame.protocol_data[0].name, "auth");
        assert_eq!(frame.protocol_data[0].content_type, 0);
        assert_eq!(
            frame.protocol_data[0].data,
            br#"{"peerId":"p","secret":""}"#.to_vec()
        );
        assert!(frame.ilp_packet.is_empty());
    }

    #[test]
    fn a_message_carrying_claim_and_packet_decodes_both() {
        let claim = br#"{"version":"1.0"}"#;
        let ilp = [12u8, 0, 1, 2, 3];
        let mut frame = vec![6, 0, 0, 0, 42, 1];
        frame.push(CLAIM_PROTOCOL.len() as u8);
        frame.extend_from_slice(CLAIM_PROTOCOL.as_bytes());
        frame.extend_from_slice(&1u16.to_be_bytes());
        frame.extend_from_slice(&(claim.len() as u32).to_be_bytes());
        frame.extend_from_slice(claim);
        frame.extend_from_slice(&(ilp.len() as u32).to_be_bytes());
        frame.extend_from_slice(&ilp);

        let decoded = decode_frame(&frame).expect("decodes");
        assert_eq!(decoded.request_id, 42);
        assert_eq!(decoded.protocol_data[0].name, CLAIM_PROTOCOL);
        assert_eq!(decoded.protocol_data[0].data, claim.to_vec());
        assert_eq!(decoded.ilp_packet, ilp.to_vec());
    }

    #[test]
    fn an_encoded_response_is_the_dialects_bytes() {
        let encoded = encode_response(7, &[], b"\x0d\x01\x02");
        // type RESPONSE, requestId 7, no protocolData, ilpLen 3, packet.
        assert_eq!(
            encoded,
            vec![1, 0, 0, 0, 7, 0, 0, 0, 0, 3, 0x0d, 0x01, 0x02]
        );
    }

    #[test]
    fn a_response_round_trips_through_the_decoder() {
        let pd = vec![ProtocolData {
            name: ACCUMULATED_COST_PROTOCOL.to_string(),
            content_type: CONTENT_TYPE_TEXT,
            data: b"1000".to_vec(),
        }];
        let encoded = encode_response(9, &pd, b"reject-bytes");
        let decoded = decode_frame(&encoded).expect("round-trips");
        assert_eq!(decoded.frame_type, BTP_RESPONSE);
        assert_eq!(decoded.request_id, 9);
        assert_eq!(decoded.protocol_data, pd);
        assert_eq!(decoded.ilp_packet, b"reject-bytes".to_vec());
    }

    #[test]
    fn an_error_frame_matches_the_clients_error_parser_layout() {
        let encoded = encode_error(3, "F00", "NotAcceptedError", b"boom");
        // The client's parseBtpMessage ERROR arm: 1-byte-length-prefixed
        // code, name, triggeredAt (empty), then u32-length-prefixed data.
        let mut expected = vec![2, 0, 0, 0, 3];
        expected.push(3);
        expected.extend_from_slice(b"F00");
        expected.push(16);
        expected.extend_from_slice(b"NotAcceptedError");
        expected.push(0); // empty triggeredAt
        expected.extend_from_slice(&4u32.to_be_bytes());
        expected.extend_from_slice(b"boom");
        assert_eq!(encoded, expected);
    }

    #[test]
    fn a_truncated_frame_reports_malformed_with_its_request_id() {
        // Claims one protocolData entry, provides nothing after the count.
        let frame = [6u8, 0, 0, 0, 5, 1];
        assert_eq!(
            decode_frame(&frame),
            Err(BtpDecodeError::Malformed {
                request_id: 5,
                reason: "frame truncated reading protocolData name length".to_string(),
            })
        );
    }

    #[test]
    fn a_frame_shorter_than_its_header_is_too_short() {
        assert_eq!(decode_frame(&[6, 0, 0]), Err(BtpDecodeError::TooShort));
    }

    #[test]
    fn a_missing_trailing_ilp_length_is_tolerated_as_no_packet() {
        // The client's own parser treats an absent trailing length as no
        // packet; the server mirrors it.
        let frame = [6u8, 0, 0, 0, 8, 0];
        let decoded = decode_frame(&frame).expect("decodes");
        assert!(decoded.ilp_packet.is_empty());
        assert!(decoded.protocol_data.is_empty());
    }
}
