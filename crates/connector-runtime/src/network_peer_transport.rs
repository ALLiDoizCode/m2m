//! The peer wire's network implementation of [`PeerTransport`]
//! (`docs/protocol/peer-wire-spec.md` §1.1: "the production implementation
//! is TLS over TCP"). This ticket implements plain TCP -- the framing and
//! reconnection behavior the port and its contract suite require -- and
//! leaves TLS/identity verification to whichever ticket first needs a peer
//! wire exposed outside a trusted network (peer addressing is still
//! constructed directly in tests, matching the scoping precedent set by
//! issue #415 for peer routes; config-file representation is deferred).
//!
//! [`NetworkPeerTransport`] is the dialing side: one persistent TCP
//! connection per configured peer, redialed lazily. [`PeerWireServer`] is
//! the accepting side: it answers every inbound PREPARE frame by calling
//! [`Connector::handle_peer_prepare`] and every FLUSH frame by calling
//! [`Connector::handle_peer_claim`] (issue #423) -- the same methods a
//! direct client request or an in-process peer link reaches, so a peer's
//! frame is judged exactly like one arriving any other way; the packet
//! plane itself never constructs or touches a socket.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use connector_domain::{Fulfill, PacketResponse, Prepare, Reject};

use crate::claim::{ClaimAckOutcome, WireClaim};
use crate::connector::Connector;
use crate::peer_transport::{peer_unreachable, PeerTransport};
use crate::peer_wire::{
    read_frame, write_frame, Frame, CORRELATION_ID_LEN, FRAME_TYPE_CLAIM_ACK, FRAME_TYPE_FLUSH,
    FRAME_TYPE_FULFILL, FRAME_TYPE_PREPARE, FRAME_TYPE_REJECT,
};

/// A dialed connection to one peer, redialed lazily on first use and again
/// on any failure -- this is the "no operator action" reconnection the
/// issue's acceptance criteria requires: a dropped connection is repaired
/// by the next [`PeerConnection::forward`] call, not by an operator
/// restarting anything.
///
/// The mutex serializes every forward over this connection, matching
/// [`crate::peer_transport::InProcessPeerTransport`]'s own link, which
/// answers every request through one spawned task in the order received --
/// so both implementations uphold the same "one peer, requests answered in
/// turn" behavior the contract suite in [`crate::peer_transport`] tests.
struct PeerConnection {
    peer_id: String,
    addr: SocketAddr,
    stream: Mutex<Option<TcpStream>>,
    next_correlation_id: AtomicU64,
}

impl PeerConnection {
    fn new(peer_id: String, addr: SocketAddr) -> PeerConnection {
        PeerConnection {
            peer_id,
            addr,
            stream: Mutex::new(None),
            next_correlation_id: AtomicU64::new(1),
        }
    }

    fn next_correlation_id(&self) -> [u8; CORRELATION_ID_LEN] {
        let counter = self.next_correlation_id.fetch_add(1, Ordering::Relaxed);
        let mut correlation_id = [0u8; CORRELATION_ID_LEN];
        correlation_id[8..].copy_from_slice(&counter.to_be_bytes());
        correlation_id
    }

    /// Send `frame`, read back whatever frame answers it, and hand it to
    /// `decode` -- dialing lazily and redialing once more if the write,
    /// the read, or `decode` itself fails, the "at most twice" retry both
    /// [`PeerConnection::forward`] and [`PeerConnection::flush`] need,
    /// factored out so the two frame kinds share exactly one reconnection
    /// policy. `decode` is where each caller checks whatever makes a
    /// response its own -- a PREPARE answer's correlation id, a FLUSH
    /// answer's frame type -- since a response that fails that check is
    /// exactly as unusable as one the socket never delivered at all, and
    /// must retry the same way.
    async fn send_frame_and_decode<T>(
        &self,
        frame: &Frame,
        decode: impl Fn(&Frame) -> Option<T>,
    ) -> Option<T> {
        let mut guard = self.stream.lock().await;
        for _ in 0..2 {
            if guard.is_none() {
                match TcpStream::connect(self.addr).await {
                    Ok(stream) => *guard = Some(stream),
                    Err(_) => return None,
                }
            }
            let stream = guard.as_mut().expect("connected above");
            if write_frame(stream, frame).await.is_ok() {
                if let Ok(response) = read_frame(stream).await {
                    if let Some(decoded) = decode(&response) {
                        return Some(decoded);
                    }
                }
            }
            *guard = None;
        }
        None
    }

    async fn forward(
        &self,
        prepare: Prepare,
        minimum_delivery: u64,
        claim: Option<WireClaim>,
    ) -> (PacketResponse, ClaimAckOutcome, bool) {
        let frame = Frame {
            frame_type: FRAME_TYPE_PREPARE,
            correlation_id: self.next_correlation_id(),
            payload: encode_prepare_frame_payload(&prepare, minimum_delivery, claim.as_ref()),
        };
        let correlation_id = frame.correlation_id;
        let response = self
            .send_frame_and_decode(&frame, |response| {
                (response.correlation_id == correlation_id)
                    .then(|| decode_response(response))
                    .flatten()
            })
            .await;
        match response {
            Some((response, ack)) => (response, ack, true),
            None => (
                peer_unreachable(&self.peer_id),
                ClaimAckOutcome::NotSent,
                false,
            ),
        }
    }

    async fn flush(&self, claim: WireClaim) -> ClaimAckOutcome {
        let frame = Frame {
            frame_type: FRAME_TYPE_FLUSH,
            // No correlationId meaning: absent (all-zero) on a frame not
            // answering a specific PREPARE (peer-wire-spec.md §1.2).
            correlation_id: [0u8; CORRELATION_ID_LEN],
            payload: claim.encode(),
        };
        let ack = self
            .send_frame_and_decode(&frame, |response| {
                (response.frame_type == FRAME_TYPE_CLAIM_ACK)
                    .then(|| ClaimAckOutcome::decode(&response.payload))
                    .flatten()
            })
            .await;
        ack.unwrap_or(ClaimAckOutcome::NotSent)
    }
}

/// `minimumDelivery` (peer-wire-spec.md §4) is a PREPARE-frame field
/// declared once by the original sender and passed unchanged hop to hop --
/// not a `Prepare` field itself, since `connector-domain` (RFC-0027) has no
/// such concept. A claim (§3.2, issue #423) rides the same way. Both the
/// encoded `Prepare` and, if present, the trailing claim are length-framed:
/// `Prepare::decode`/`WireClaim::decode` reject trailing bytes, so a fixed
/// suffix cannot follow either without saying how long it is first.
fn encode_prepare_frame_payload(
    prepare: &Prepare,
    minimum_delivery: u64,
    claim: Option<&WireClaim>,
) -> Vec<u8> {
    let prepare_bytes = prepare.encode();
    let mut payload = Vec::new();
    payload.extend_from_slice(&(prepare_bytes.len() as u32).to_be_bytes());
    payload.extend_from_slice(&prepare_bytes);
    payload.extend_from_slice(&minimum_delivery.to_be_bytes());
    match claim {
        Some(claim) => {
            payload.push(1);
            payload.extend_from_slice(&claim.encode());
        }
        None => payload.push(0),
    }
    payload
}

fn decode_prepare_frame_payload(payload: &[u8]) -> Option<(Prepare, u64, Option<WireClaim>)> {
    let prepare_len = u32::from_be_bytes(payload.get(0..4)?.try_into().ok()?) as usize;
    let mut offset = 4;
    let prepare = Prepare::decode(payload.get(offset..offset + prepare_len)?).ok()?;
    offset += prepare_len;

    let minimum_delivery = u64::from_be_bytes(payload.get(offset..offset + 8)?.try_into().ok()?);
    offset += 8;

    let has_claim = *payload.get(offset)?;
    offset += 1;
    let claim = if has_claim == 1 {
        let (claim, consumed) = WireClaim::decode(payload.get(offset..)?)?;
        offset += consumed;
        Some(claim)
    } else {
        None
    };

    if offset != payload.len() {
        return None;
    }
    Some((prepare, minimum_delivery, claim))
}

/// A FULFILL/REJECT response frame's payload: the length-framed packet,
/// [`Reject`]'s `accumulated_cost` (ADR 0011, peer-wire-spec.md §5.2 -- `0`
/// and unused on a FULFILL), then whatever [`ClaimAckOutcome`] answers the
/// claim the PREPARE it responds to was carrying, if any. `accumulated_cost`
/// rides here rather than inside the packet bytes themselves because
/// [`Reject::encode`] is RFC-0027's own wire format and has no such field
/// (see that struct's doc) -- this is the frame level the spec means by
/// "beside the packet".
fn encode_response_frame_payload(
    packet_bytes: Vec<u8>,
    accumulated_cost: u64,
    ack: ClaimAckOutcome,
) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&(packet_bytes.len() as u32).to_be_bytes());
    payload.extend_from_slice(&packet_bytes);
    payload.extend_from_slice(&accumulated_cost.to_be_bytes());
    match ack {
        ClaimAckOutcome::NotSent => payload.push(0),
        acknowledged => {
            payload.push(1);
            payload.extend_from_slice(&acknowledged.encode());
        }
    }
    payload
}

fn decode_response_frame_payload(payload: &[u8]) -> Option<(Vec<u8>, u64, ClaimAckOutcome)> {
    let packet_len = u32::from_be_bytes(payload.get(0..4)?.try_into().ok()?) as usize;
    let mut offset = 4;
    let packet_bytes = payload.get(offset..offset + packet_len)?.to_vec();
    offset += packet_len;

    let accumulated_cost = u64::from_be_bytes(payload.get(offset..offset + 8)?.try_into().ok()?);
    offset += 8;

    let has_ack = *payload.get(offset)?;
    offset += 1;
    let ack = if has_ack == 1 {
        ClaimAckOutcome::decode(payload.get(offset..)?)?
    } else {
        ClaimAckOutcome::NotSent
    };

    Some((packet_bytes, accumulated_cost, ack))
}

/// Interpret a FULFILL/REJECT frame answering a forwarded PREPARE. Pure
/// decoding, split out from the I/O in
/// [`PeerConnection::send_frame_and_decode`] so its retry loop and
/// [`PeerConnection::forward`] share one implementation.
fn decode_response(response: &Frame) -> Option<(PacketResponse, ClaimAckOutcome)> {
    let (packet_bytes, accumulated_cost, ack) = decode_response_frame_payload(&response.payload)?;
    match response.frame_type {
        FRAME_TYPE_FULFILL => Fulfill::decode(&packet_bytes)
            .ok()
            .map(|fulfill| (PacketResponse::Fulfill(fulfill), ack)),
        FRAME_TYPE_REJECT => Reject::decode(&packet_bytes).ok().map(|mut reject| {
            reject.accumulated_cost = accumulated_cost;
            (PacketResponse::Reject(reject), ack)
        }),
        _ => None,
    }
}

/// The network [`PeerTransport`]: every peer is reached over a real TCP
/// connection to a configured address rather than an in-process channel.
#[derive(Default)]
pub struct NetworkPeerTransport {
    peers: HashMap<String, PeerConnection>,
}

impl NetworkPeerTransport {
    pub fn new() -> NetworkPeerTransport {
        NetworkPeerTransport::default()
    }

    /// Register `addr` as reachable under `peer_id`. No connection is
    /// opened until the first [`PeerTransport::forward`] call for it.
    pub fn add_peer(&mut self, peer_id: impl Into<String>, addr: SocketAddr) {
        let peer_id = peer_id.into();
        self.peers
            .insert(peer_id.clone(), PeerConnection::new(peer_id, addr));
    }
}

#[async_trait]
impl PeerTransport for NetworkPeerTransport {
    async fn forward(
        &self,
        peer_id: &str,
        prepare: Prepare,
        minimum_delivery: u64,
        claim: Option<WireClaim>,
    ) -> (PacketResponse, ClaimAckOutcome, bool) {
        match self.peers.get(peer_id) {
            Some(connection) => connection.forward(prepare, minimum_delivery, claim).await,
            None => (peer_unreachable(peer_id), ClaimAckOutcome::NotSent, false),
        }
    }

    async fn flush(&self, peer_id: &str, claim: WireClaim) -> ClaimAckOutcome {
        match self.peers.get(peer_id) {
            Some(connection) => connection.flush(claim).await,
            None => ClaimAckOutcome::NotSent,
        }
    }
}

/// The accepting side of the peer wire: binds a TCP listener and answers
/// every inbound PREPARE or FLUSH frame, on any connection, by routing it
/// through `connector` -- the same [`Connector::handle_peer_prepare`] /
/// [`Connector::handle_peer_claim`] a client's own request or an in-process
/// peer link reaches.
pub struct PeerWireServer {
    local_addr: SocketAddr,
    handles: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

impl PeerWireServer {
    pub async fn bind(
        addr: SocketAddr,
        connector: Arc<Connector>,
    ) -> std::io::Result<PeerWireServer> {
        Self::bind_with_channel(addr, connector, None).await
    }

    /// Bind exactly like [`PeerWireServer::bind`], but with `channel_id`
    /// pre-configured as every connection's known channel from its first
    /// frame on (issue #424, peer-wire-spec.md §5.3) -- standing in for
    /// the identity a real peer-wire handshake would establish (#416, not
    /// yet built). Without this, a connection only learns its
    /// counterparty's channel once a claim happens to ride a frame over it
    /// (`serve_connection`'s own doc), so the very first delivery cannot be
    /// checked against a ceiling or recorded as exposure. Appropriate when
    /// this listener serves exactly one peering relation, matching how
    /// every caller in this workspace uses it today.
    pub async fn bind_with_channel(
        addr: SocketAddr,
        connector: Arc<Connector>,
        channel_id: Option<String>,
    ) -> std::io::Result<PeerWireServer> {
        let listener = TcpListener::bind(addr).await?;
        let local_addr = listener.local_addr()?;

        let handles: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));
        let handles_for_accept_loop = handles.clone();
        let accept_task = tokio::spawn(async move {
            loop {
                let (stream, _) = match listener.accept().await {
                    Ok(accepted) => accepted,
                    Err(_) => return,
                };
                let connector = connector.clone();
                let channel_id = channel_id.clone();
                let handle = tokio::spawn(serve_connection(stream, connector, channel_id));
                handles_for_accept_loop.lock().await.push(handle);
            }
        });
        handles.lock().await.push(accept_task);

        Ok(PeerWireServer {
            local_addr,
            handles,
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Stop accepting new connections and close every connection already
    /// open, simulating this peer becoming unreachable -- used by tests;
    /// production shutdown has no caller yet (connector-bin has no live
    /// runtime to shut down until issue #429).
    pub async fn shutdown(self) {
        for handle in self.handles.lock().await.drain(..) {
            handle.abort();
        }
    }
}

async fn serve_connection(
    mut stream: TcpStream,
    connector: Arc<Connector>,
    mut known_channel_id: Option<String>,
) {
    // `known_channel_id` starts however `PeerWireServer::bind_with_channel`
    // configured it (issue #424) and otherwise updates as this connection's
    // counterparty identifies itself, exactly like `PeerLink::connect`'s
    // identical cache in `peer_transport.rs`: the peer wire has no identity
    // handshake yet (#416), so once a claim on this connection names a
    // channel, every later PREPARE over it is charged against that same
    // channel, even ones carrying no claim of their own.
    loop {
        let frame = match read_frame(&mut stream).await {
            Ok(frame) => frame,
            Err(_) => return,
        };

        match frame.frame_type {
            FRAME_TYPE_PREPARE => {
                let Some((prepare, minimum_delivery, claim)) =
                    decode_prepare_frame_payload(&frame.payload)
                else {
                    return;
                };

                if let Some(claim) = claim.as_ref() {
                    known_channel_id = Some(claim.channel_id.clone());
                }
                let (response, ack) = connector
                    .handle_peer_prepare(prepare, minimum_delivery, claim, known_channel_id.clone())
                    .await;
                let (packet_bytes, accumulated_cost, response_frame_type) = match response {
                    PacketResponse::Fulfill(fulfill) => (fulfill.encode(), 0, FRAME_TYPE_FULFILL),
                    PacketResponse::Reject(reject) => {
                        (reject.encode(), reject.accumulated_cost, FRAME_TYPE_REJECT)
                    }
                };
                let response_frame = Frame {
                    frame_type: response_frame_type,
                    correlation_id: frame.correlation_id,
                    payload: encode_response_frame_payload(packet_bytes, accumulated_cost, ack),
                };

                if write_frame(&mut stream, &response_frame).await.is_err() {
                    return;
                }
            }
            FRAME_TYPE_FLUSH => {
                let Some((claim, _)) = WireClaim::decode(&frame.payload) else {
                    return;
                };
                known_channel_id = Some(claim.channel_id.clone());
                let ack = connector.handle_peer_claim(claim);
                let response_frame = Frame {
                    frame_type: FRAME_TYPE_CLAIM_ACK,
                    correlation_id: frame.correlation_id,
                    payload: ack.encode(),
                };
                if write_frame(&mut stream, &response_frame).await.is_err() {
                    return;
                }
            }
            // An unrecognized frame type is a version mismatch, not a
            // packet to route around (§1.3) -- close the stream rather
            // than guess.
            _ => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_client::FakeAppClient;
    use crate::clock::TestClock;
    use crate::peer_transport::InProcessPeerTransport;
    use crate::test_support::{
        answered, expected_fulfillment, fulfill_envelope, identity_signer, matching_condition,
        open_sealed_envelope, sealed_envelope_request_data, sign_wire_claim, with_test_channel,
    };
    use chrono::{TimeZone, Utc};
    use connector_config::StaticRoute;
    use connector_signer::{LocalSigner, Signer};

    /// A fixed value used only as opaque wire bytes in this module's raw
    /// frame-level fixtures below (`NetworkPeerTransport`'s reconnect and
    /// stale-frame tests) -- unrelated to condition matching, since those
    /// exercise transport-level framing rather than `Connector::deliver_to_app`.
    const FULFILLMENT: [u8; 32] = [7u8; 32];

    /// Seals a fixed body and sets `execution_condition` to match the
    /// fulfilment its own (discarded) shared secret derives (ADR 0019,
    /// issue #525) -- what a genuine sender does before ever transmitting a
    /// packet, so this is, by construction, one that fulfils if it reaches
    /// an app that answers at all. A test that also needs the secret back
    /// uses [`sealed_prepare`] instead.
    fn prepare(destination: &str) -> Prepare {
        let (data, shared_secret) = sealed_envelope_request_data(b"hello");
        Prepare {
            amount: 0,
            // Comfortably after `test_clock()`'s instant (2030-01-01).
            expires_at: Utc.with_ymd_and_hms(2031, 1, 1, 0, 0, 0).unwrap(),
            execution_condition: matching_condition(&shared_secret),
            destination: destination.to_string(),
            data,
        }
    }

    /// A `Prepare` addressed to `"g.example.app"`, sealed to
    /// [`identity_signer`]'s identity and carrying `body` (issue #524),
    /// with `execution_condition` set to match the fulfilment this same
    /// sealed secret derives (ADR 0019, issue #525). Returns the shared
    /// secret alongside, to open the sealed `Fulfill`/termination-`Reject`
    /// this produces, or to compute the expected fulfilment via
    /// `expected_fulfillment`.
    fn sealed_prepare(body: &[u8]) -> (Prepare, [u8; 32]) {
        let (data, shared_secret) = sealed_envelope_request_data(body);
        (
            Prepare {
                data,
                execution_condition: matching_condition(&shared_secret),
                ..prepare("g.example.app")
            },
            shared_secret,
        )
    }

    fn test_clock() -> Arc<TestClock> {
        Arc::new(TestClock::new(
            Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
        ))
    }

    fn localhost() -> SocketAddr {
        "127.0.0.1:0".parse().unwrap()
    }

    fn sample_claim() -> WireClaim {
        let signer = LocalSigner::generate("k");
        sign_wire_claim(&signer, 1, 3, 300)
    }

    #[test]
    fn a_prepare_frame_payload_round_trips_with_no_claim() {
        let original = prepare("g.example.app");

        let payload = encode_prepare_frame_payload(&original, 42, None);
        let (decoded, minimum_delivery, claim) = decode_prepare_frame_payload(&payload).unwrap();

        assert_eq!(decoded, original);
        assert_eq!(minimum_delivery, 42);
        assert_eq!(claim, None);
    }

    #[test]
    fn a_prepare_frame_payload_round_trips_with_a_piggybacked_claim() {
        let original = prepare("g.example.app");
        let claim = sample_claim();

        let payload = encode_prepare_frame_payload(&original, 42, Some(&claim));
        let (decoded, minimum_delivery, decoded_claim) =
            decode_prepare_frame_payload(&payload).unwrap();

        assert_eq!(decoded, original);
        assert_eq!(minimum_delivery, 42);
        assert_eq!(decoded_claim, Some(claim));
    }

    #[test]
    fn decoding_a_truncated_prepare_frame_payload_fails() {
        assert!(decode_prepare_frame_payload(&[0u8; 3]).is_none());
    }

    #[test]
    fn a_response_frame_payload_round_trips_with_every_ack_outcome() {
        for ack in [
            ClaimAckOutcome::NotSent,
            ClaimAckOutcome::Accepted,
            ClaimAckOutcome::Rejected(crate::claim::ClaimRejectReason::SignatureInvalid),
        ] {
            let packet_bytes = Fulfill {
                fulfillment: FULFILLMENT,
                data: b"hi".to_vec(),
            }
            .encode();
            let payload = encode_response_frame_payload(packet_bytes.clone(), 0, ack);
            let (decoded_bytes, decoded_fee, decoded_ack) =
                decode_response_frame_payload(&payload).unwrap();
            assert_eq!(decoded_bytes, packet_bytes);
            assert_eq!(decoded_fee, 0);
            assert_eq!(decoded_ack, ack);
        }
    }

    /// ADR 0011 / peer-wire-spec.md §5.2: `accumulated_cost` rides this
    /// frame payload beside the packet bytes, independently of `ack`.
    #[test]
    fn a_response_frame_payload_round_trips_a_nonzero_accumulated_cost() {
        let packet_bytes = Reject {
            code: connector_domain::RejectCode::f02_unreachable(),
            triggered_by: String::new(),
            message: "no route".to_string(),
            data: vec![],
            accumulated_cost: 0,
        }
        .encode();

        let payload =
            encode_response_frame_payload(packet_bytes.clone(), 17, ClaimAckOutcome::NotSent);
        let (decoded_bytes, decoded_fee, decoded_ack) =
            decode_response_frame_payload(&payload).unwrap();

        assert_eq!(decoded_bytes, packet_bytes);
        assert_eq!(decoded_fee, 17);
        assert_eq!(decoded_ack, ClaimAckOutcome::NotSent);
    }

    #[tokio::test]
    async fn forwards_over_a_real_tcp_connection_and_returns_the_peers_response() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(route.handler_url(), answered(b"delivered by the peer"));
        let peer = Arc::new(
            Connector::new(
                vec![route],
                vec![],
                app_client,
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_identity_signer(identity_signer()),
        );
        let server = PeerWireServer::bind(localhost(), peer).await.unwrap();

        let mut transport = NetworkPeerTransport::new();
        transport.add_peer("peer-b", server.local_addr());
        let (sealed, shared_secret) = sealed_prepare(b"hello");

        let (response, ack, reached) = transport.forward("peer-b", sealed, 0, None).await;

        match response {
            PacketResponse::Fulfill(fulfill) => {
                assert_eq!(fulfill.fulfillment, expected_fulfillment(&shared_secret));
                assert_eq!(
                    open_sealed_envelope(&shared_secret, &fulfill.data),
                    fulfill_envelope(b"delivered by the peer")
                );
            }
            other => panic!("expected a fulfill, got {other:?}"),
        }
        assert_eq!(ack, ClaimAckOutcome::NotSent);
        assert!(reached);
    }

    #[tokio::test]
    async fn a_piggybacked_claim_is_verified_by_the_accepting_peer_over_tcp() {
        let signer = LocalSigner::generate("claim-key");
        let counterparty = connector_signer::derive_evm_address(&signer.public_key().unwrap());
        let peer = Arc::new(with_test_channel(
            Connector::new(
                vec![],
                vec![],
                Arc::new(FakeAppClient::new()),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ),
            1,
            counterparty,
        ));
        let server = PeerWireServer::bind(localhost(), peer).await.unwrap();

        let mut transport = NetworkPeerTransport::new();
        transport.add_peer("peer-b", server.local_addr());

        let claim = sign_wire_claim(&signer, 1, 1, 50);

        let (response, ack, _reached) = transport
            .forward("peer-b", prepare("g.nowhere"), 0, Some(claim))
            .await;

        // The claim is judged independently of the packet: this PREPARE
        // has no route and is rejected, but the claim it carried is still
        // accepted.
        assert!(matches!(response, PacketResponse::Reject(_)));
        assert_eq!(ack, ClaimAckOutcome::Accepted);
    }

    #[tokio::test]
    async fn a_flush_carries_a_claim_alone_and_gets_a_claim_ack_back() {
        let signer = LocalSigner::generate("claim-key");
        let counterparty = connector_signer::derive_evm_address(&signer.public_key().unwrap());
        let peer = Arc::new(with_test_channel(
            Connector::new(
                vec![],
                vec![],
                Arc::new(FakeAppClient::new()),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ),
            1,
            counterparty,
        ));
        let server = PeerWireServer::bind(localhost(), peer).await.unwrap();

        let mut transport = NetworkPeerTransport::new();
        transport.add_peer("peer-b", server.local_addr());

        let claim = sign_wire_claim(&signer, 1, 1, 50);

        let ack = transport.flush("peer-b", claim).await;

        assert_eq!(ack, ClaimAckOutcome::Accepted);
    }

    #[tokio::test]
    async fn returns_peer_unreachable_for_an_unregistered_peer_id() {
        let transport = NetworkPeerTransport::new();

        let (response, ack, reached) = transport
            .forward("nowhere", prepare("g.example.app"), 0, None)
            .await;

        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "T01");
                assert!(reject.message.contains("nowhere"));
            }
            other => panic!("expected a reject, got {other:?}"),
        }
        assert_eq!(ack, ClaimAckOutcome::NotSent);
        assert!(!reached);
    }

    #[tokio::test]
    async fn returns_peer_unreachable_when_nothing_is_listening_at_the_configured_address() {
        let mut transport = NetworkPeerTransport::new();
        // Port 0 never accepts a connection, so dialing fails fast.
        transport.add_peer("peer-b", "127.0.0.1:0".parse().unwrap());

        let (response, _ack, reached) = transport
            .forward("peer-b", prepare("g.example.app"), 0, None)
            .await;

        match response {
            PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "T01"),
            other => panic!("expected a reject, got {other:?}"),
        }
        assert!(!reached);
    }

    #[tokio::test]
    async fn a_reject_originated_by_the_peer_is_relayed_unchanged() {
        let peer = Arc::new(Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let server = PeerWireServer::bind(localhost(), peer).await.unwrap();

        let mut transport = NetworkPeerTransport::new();
        transport.add_peer("peer-b", server.local_addr());

        let (response, _ack, reached) = transport
            .forward("peer-b", prepare("g.nowhere-on-peer-b"), 0, None)
            .await;

        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "F02");
                assert!(reject.message.contains("g.nowhere-on-peer-b"));
            }
            other => panic!("expected a reject, got {other:?}"),
        }
        assert!(reached);
    }

    /// Acceptance criterion: a peer that becomes unreachable is detected,
    /// and reconnection is attempted without operator action -- forwarding
    /// resumes as soon as the peer is reachable again, with no call other
    /// than `forward` itself.
    #[tokio::test]
    async fn reconnects_to_a_peer_that_becomes_reachable_again_without_operator_action() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(route.handler_url(), answered(b"first"));
        let peer = Arc::new(
            Connector::new(
                vec![route.clone()],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_identity_signer(identity_signer()),
        );
        let server = PeerWireServer::bind(localhost(), peer.clone())
            .await
            .unwrap();
        let addr = server.local_addr();

        let mut transport = NetworkPeerTransport::new();
        transport.add_peer("peer-b", addr);
        let (sealed, first_secret) = sealed_prepare(b"hello");

        let (first, _, _) = transport.forward("peer-b", sealed, 0, None).await;
        match first {
            PacketResponse::Fulfill(fulfill) => {
                assert_eq!(fulfill.fulfillment, expected_fulfillment(&first_secret));
                assert_eq!(
                    open_sealed_envelope(&first_secret, &fulfill.data),
                    fulfill_envelope(b"first")
                );
            }
            other => panic!("expected a fulfill, got {other:?}"),
        }

        server.shutdown().await;

        let (while_down, _, _) = transport
            .forward("peer-b", prepare("g.example.app"), 0, None)
            .await;
        match while_down {
            PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "T01"),
            other => panic!("expected a reject while the peer is down, got {other:?}"),
        }

        app_client.respond(route.handler_url(), answered(b"second"));
        let _server_again = PeerWireServer::bind(addr, peer).await.unwrap();
        let (sealed, second_secret) = sealed_prepare(b"hello");

        let (after_recovery, _, _) = transport.forward("peer-b", sealed, 0, None).await;
        match after_recovery {
            PacketResponse::Fulfill(fulfill) => {
                assert_eq!(fulfill.fulfillment, expected_fulfillment(&second_secret));
                assert_eq!(
                    open_sealed_envelope(&second_secret, &fulfill.data),
                    fulfill_envelope(b"second")
                );
            }
            other => panic!("expected a fulfill, got {other:?}"),
        }
    }

    /// A response frame that does not answer this request at all -- a
    /// stale reply left over from some earlier, abandoned exchange, still
    /// sitting in the stream -- must be treated exactly like the socket
    /// failing outright: reconnect and retry, not surface it as the
    /// answer.
    #[tokio::test]
    async fn a_response_with_the_wrong_correlation_id_triggers_a_reconnect_and_retry() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            read_frame(&mut first).await.unwrap();
            let stale_bytes = Fulfill {
                fulfillment: FULFILLMENT,
                data: b"stale".to_vec(),
            }
            .encode();
            write_frame(
                &mut first,
                &Frame {
                    frame_type: FRAME_TYPE_FULFILL,
                    correlation_id: [0xffu8; CORRELATION_ID_LEN],
                    payload: encode_response_frame_payload(
                        stale_bytes,
                        0,
                        ClaimAckOutcome::NotSent,
                    ),
                },
            )
            .await
            .unwrap();
            drop(first);

            let (mut second, _) = listener.accept().await.unwrap();
            let request = read_frame(&mut second).await.unwrap();
            let fresh_bytes = Fulfill {
                fulfillment: FULFILLMENT,
                data: b"fresh".to_vec(),
            }
            .encode();
            write_frame(
                &mut second,
                &Frame {
                    frame_type: FRAME_TYPE_FULFILL,
                    correlation_id: request.correlation_id,
                    payload: encode_response_frame_payload(
                        fresh_bytes,
                        0,
                        ClaimAckOutcome::NotSent,
                    ),
                },
            )
            .await
            .unwrap();
        });

        let mut transport = NetworkPeerTransport::new();
        transport.add_peer("peer-b", addr);

        let (response, ack, reached) = transport
            .forward("peer-b", prepare("g.example.app"), 0, None)
            .await;

        assert_eq!(
            response,
            PacketResponse::Fulfill(Fulfill {
                fulfillment: FULFILLMENT,
                data: b"fresh".to_vec(),
            })
        );
        assert_eq!(ack, ClaimAckOutcome::NotSent);
        assert!(reached);
    }
}
