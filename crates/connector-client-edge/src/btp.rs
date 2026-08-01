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
//! layout, and this module's unit vectors for the bytes. Frames on one
//! session are processed strictly sequentially, in arrival order: the next
//! frame is not read until the previous frame's claim has been judged and
//! its packet routed, which is what makes in-order claims on one socket
//! unable to race each other into `NonceNotAdvancing`.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;

use connector_domain::{PacketResponse, Prepare, Reject, RejectCode};

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

/// One session: read a binary frame, answer it, repeat -- strictly in
/// order, which is the transport's contract (§1.9). Text frames are
/// ignored; ping/pong is the websocket layer's own concern; a transport
/// error or close ends the session. Claims judged here advance the same
/// watermarks HTTP requests advance, so a session outliving many requests
/// changes nothing about what any one claim must prove.
async fn btp_session(mut socket: WebSocket, state: Arc<ClientEdgeState>) {
    while let Some(received) = socket.recv().await {
        let frame_bytes = match received {
            Ok(Message::Binary(bytes)) => bytes,
            Ok(Message::Close(_)) => break,
            Ok(_) => continue,
            Err(_) => break,
        };
        if let Some(reply) = answer_frame(&frame_bytes, &state).await {
            if socket.send(Message::Binary(reply)).await.is_err() {
                break;
            }
        }
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

/// Answer one frame, or `None` where the contract answers nothing: a
/// non-MESSAGE frame, a standalone claim (fire-and-forget by the client's
/// own contract), a MESSAGE carrying neither auth nor claim nor packet,
/// and a frame too short to even name a requestId.
async fn answer_frame(frame_bytes: &[u8], state: &ClientEdgeState) -> Option<Vec<u8>> {
    let frame = match decode_frame(frame_bytes) {
        Ok(frame) => frame,
        Err(BtpDecodeError::TooShort) => return None,
        Err(BtpDecodeError::Malformed { request_id, reason }) => {
            return Some(encode_error(
                request_id,
                "F00",
                "NotAcceptedError",
                reason.as_bytes(),
            ));
        }
    };
    if frame.frame_type != BTP_MESSAGE {
        return None;
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
        return Some(encode_response(frame.request_id, &[], &[]));
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
                return Some(reject_response(
                    frame.request_id,
                    claim_rejection_reject(rejection, 0),
                    Vec::new(),
                ));
            }
        },
        None => None,
    };

    // A standalone claim (§1.9 step 4): ingested against price 0 --
    // identify-not-pay, exactly `handle_probe`'s semantics -- and answered
    // with nothing, per the client's `sendClaimMessage` contract. A refusal
    // here is logged, not framed: there is no response to carry it.
    if frame.ilp_packet.is_empty() {
        if let Some(json) = claim_json {
            match state.claim_gate.ingest(&json, 0).await {
                Ok(claim) => state.connector.recognize_channel(&claim.channel_key()),
                Err(rejection) => {
                    tracing::debug!(
                        rejection = %rejection.message(),
                        "standalone BTP claim refused"
                    );
                }
            }
        }
        return None;
    }

    let prepare = match Prepare::decode(&frame.ilp_packet) {
        Ok(prepare) => prepare,
        Err(error) => {
            // The HTTP carriage's 400 (§1.1): a transport-level answer, not
            // an ILP-level one, so an ERROR frame rather than a REJECT.
            return Some(encode_error(
                frame.request_id,
                "F00",
                "NotAcceptedError",
                error.to_string().as_bytes(),
            ));
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
        return Some(reject_response(
            frame.request_id,
            reject,
            vec![ProtocolData {
                name: PAYMENT_REQUIRED_PROTOCOL.to_string(),
                content_type: CONTENT_TYPE_TEXT,
                data: terms,
            }],
        ));
    }

    // §1.3, verbatim: the same gate, watermarks and refusal taxonomy as
    // `handle_ilp` -- a claim that cleared it makes the sender eligible to
    // probe, exactly as on HTTP (issue #548).
    if let Some(json) = claim_json {
        match state.claim_gate.ingest(&json, price).await {
            Ok(claim) => state.connector.recognize_channel(&claim.channel_key()),
            Err(rejection) => {
                return Some(reject_response(
                    frame.request_id,
                    claim_rejection_reject(rejection, price),
                    Vec::new(),
                ));
            }
        }
    }

    Some(match state.connector.handle_prepare(prepare, 0).await {
        PacketResponse::Fulfill(fulfill) => {
            encode_response(frame.request_id, &[], &fulfill.encode())
        }
        PacketResponse::Reject(reject) => reject_response(frame.request_id, reject, Vec::new()),
    })
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
