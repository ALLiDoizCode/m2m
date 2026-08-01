//! The client BTP websocket carriage, end-to-end (client-edge-spec.md §1.9,
//! ADR 0026): a real websocket session against a served router, since
//! `tower::oneshot` cannot carry an upgrade and none of these assertions can
//! be satisfied by anything short of the frames a real client sends and
//! receives. The client half here is written against §1.9's grammar
//! independently of the server's own codec -- the `@toon-protocol/client`
//! dialect, mirrored byte-for-byte -- so these tests hold the server to the
//! wire, not to itself.

use std::net::SocketAddr;
use std::sync::Arc;

use chrono::{TimeZone, Utc};
use connector_client_edge::{ClientChannelRegistry, ClientClaimGate, DepositFloor, EvmChannel};
use connector_config::StaticRoute;
use connector_domain::{
    derive_condition, EnvelopeRequest, EnvelopeResponse, Fulfill, Prepare, Reject,
};
use connector_runtime::{
    AppOutcome, Connector, FakeAppClient, InMemoryJournal, InProcessPeerTransport, TestClock,
};
use connector_signer::{
    derive_evm_address, evm_balance_proof_digest, to_hex, EvmBalanceProof, LocalSigner,
    PublicKeyBytes, Signer,
};
use futures_util::{SinkExt, StreamExt};
use libsecp256k1::{Message as SecpMessage, PublicKey, SecretKey};
use tokio_tungstenite::tungstenite::Message as WsMessage;

const PRICE: u64 = 100;
const EVM_CHAIN_ID: u64 = 8453;
const EVM_TOKEN_NETWORK_ADDRESS: [u8; 20] = [0x42; 20];

// ─── client-side §1.9 frame grammar, written independently of the server ───

const BTP_RESPONSE: u8 = 1;
const BTP_ERROR: u8 = 2;
const BTP_MESSAGE: u8 = 6;

/// Serialize a MESSAGE the way `@toon-protocol/client`'s
/// `serializeBtpMessage` does.
fn btp_message(request_id: u32, protocol_data: &[(&str, &[u8])], ilp_packet: &[u8]) -> Vec<u8> {
    let mut out = vec![BTP_MESSAGE];
    out.extend_from_slice(&request_id.to_be_bytes());
    out.push(protocol_data.len() as u8);
    for (name, data) in protocol_data {
        out.push(name.len() as u8);
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&1u16.to_be_bytes()); // contentType, as the client sends
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(data);
    }
    out.extend_from_slice(&(ilp_packet.len() as u32).to_be_bytes());
    out.extend_from_slice(ilp_packet);
    out
}

/// A parsed server answer: `(type, requestId, protocolData, ilpPacket)`,
/// parsed the way the client's `parseBtpMessage` parses it.
struct Answer {
    frame_type: u8,
    request_id: u32,
    protocol_data: Vec<(String, Vec<u8>)>,
    ilp_packet: Vec<u8>,
}

fn parse_answer(buf: &[u8]) -> Answer {
    assert!(buf.len() >= 5, "answer shorter than a frame header");
    let frame_type = buf[0];
    let request_id = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]);
    if frame_type == BTP_ERROR {
        // code / name / triggeredAt as 1-byte-length strings, then u32 data.
        let mut pos = 5;
        let mut fields = Vec::new();
        for _ in 0..3 {
            let len = usize::from(buf[pos]);
            pos += 1;
            fields.push(String::from_utf8(buf[pos..pos + len].to_vec()).unwrap());
            pos += len;
        }
        let data_len = u32::from_be_bytes([buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]]);
        pos += 4;
        let data = buf[pos..pos + data_len as usize].to_vec();
        return Answer {
            frame_type,
            request_id,
            protocol_data: vec![
                ("code".to_string(), fields[0].clone().into_bytes()),
                ("name".to_string(), fields[1].clone().into_bytes()),
            ],
            ilp_packet: data,
        };
    }
    let mut pos = 5;
    let count = usize::from(buf[pos]);
    pos += 1;
    let mut protocol_data = Vec::new();
    for _ in 0..count {
        let name_len = usize::from(buf[pos]);
        pos += 1;
        let name = String::from_utf8(buf[pos..pos + name_len].to_vec()).unwrap();
        pos += name_len;
        pos += 2; // contentType
        let data_len =
            u32::from_be_bytes([buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]]) as usize;
        pos += 4;
        let data = buf[pos..pos + data_len].to_vec();
        pos += data_len;
        protocol_data.push((name, data));
    }
    let ilp_len = u32::from_be_bytes([buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]]) as usize;
    pos += 4;
    Answer {
        frame_type,
        request_id,
        protocol_data: protocol_data.clone(),
        ilp_packet: buf[pos..pos + ilp_len].to_vec(),
    }
}

fn pd<'a>(answer: &'a Answer, name: &str) -> Option<&'a [u8]> {
    answer
        .protocol_data
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, d)| d.as_slice())
}

// ─── server + wallet fixtures (the shapes `claim_gate`'s own tests use) ───

fn evm_signer() -> (SecretKey, connector_signer::Address) {
    let secret = SecretKey::parse(&[9u8; 32]).unwrap();
    let public = PublicKey::from_secret_key(&secret);
    (secret, derive_evm_address(&public.serialize()))
}

fn channel_hex() -> String {
    "ab".repeat(32)
}

/// An EVM claim JSON with a genuine EIP-712 signature over its own fields,
/// exactly the JSON `JSON.stringify(claim)` produces client-side -- raw,
/// not base64: §1.9's protocolData carriage.
fn evm_claim_json(nonce: u64, transferred_amount: u64) -> String {
    let (secret, address) = evm_signer();
    let mut channel_id = [0u8; 32];
    hex::decode_to_slice(channel_hex(), &mut channel_id).unwrap();
    let proof = EvmBalanceProof {
        channel_id,
        nonce,
        transferred_amount: u128::from(transferred_amount),
        locked_amount: 0,
        locks_root: [0u8; 32],
        chain_id: EVM_CHAIN_ID,
        token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
    };
    let digest = evm_balance_proof_digest(&proof);
    let (signature, recovery_id) = libsecp256k1::sign(&SecpMessage::parse(&digest), &secret);
    let mut sig_bytes = signature.serialize().to_vec();
    let recovery_byte: u8 = recovery_id.into();
    sig_bytes.push(recovery_byte + 27);
    format!(
        r#"{{"version":"1.0","blockchain":"evm","messageId":"msg-{nonce}","timestamp":"2026-02-02T12:00:00.000Z","senderId":"btp-test","channelId":"0x{channel}","nonce":{nonce},"transferredAmount":"{transferred_amount}","lockedAmount":"0","locksRoot":"0x{zeros}","signature":"0x{signature}","signerAddress":"{address}","chainId":{EVM_CHAIN_ID},"tokenNetworkAddress":"{token_network}"}}"#,
        channel = channel_hex(),
        zeros = "0".repeat(64),
        signature = hex::encode(&sig_bytes),
        address = to_hex(&address),
        token_network = to_hex(&EVM_TOKEN_NETWORK_ADDRESS),
    )
}

fn test_channels() -> ClientChannelRegistry {
    let (_secret, counterparty) = evm_signer();
    let mut channels = ClientChannelRegistry::new();
    channels
        .record_evm(
            &channel_hex(),
            EvmChannel {
                counterparty,
                chain_id: EVM_CHAIN_ID,
                token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
                deposit_floor: DepositFloor::Unknown,
            },
        )
        .expect("a 32-byte hex channel id");
    channels
}

fn test_clock() -> Arc<TestClock> {
    Arc::new(TestClock::new(
        Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
    ))
}

/// A PREPARE whose `data` is sealed to `receiver_public` (ADR 0018) and
/// whose condition matches the fulfilment that seal derives (ADR 0019) --
/// a packet the termination genuinely fulfils.
fn sealed_prepare(destination: &str, receiver_public: &PublicKeyBytes) -> Prepare {
    let envelope = EnvelopeRequest {
        method: "POST".to_string(),
        target: "/".to_string(),
        headers: vec![],
        body: b"hello app over btp".to_vec(),
    }
    .encode();
    let (data, shared_secret) =
        connector_signer::giftwrap::seal_request(&envelope, receiver_public).expect("seal");
    Prepare {
        amount: PRICE,
        expires_at: Utc.with_ymd_and_hms(2031, 1, 1, 0, 0, 0).unwrap(),
        execution_condition: derive_condition(&connector_signer::giftwrap::derive_fulfillment(
            &shared_secret,
        )),
        destination: destination.to_string(),
        data,
    }
}

/// Serve a priced-route edge on an ephemeral port; returns the address and
/// the signer whose key prepares must seal to.
async fn serve_edge() -> (SocketAddr, Arc<dyn Signer>) {
    let route = StaticRoute::new_priced("g.test.app", "http://localhost:4000", PRICE).unwrap();
    let app_client = Arc::new(FakeAppClient::new());
    app_client.respond(
        route.handler_url(),
        AppOutcome::Answered {
            response: EnvelopeResponse {
                status: 200,
                headers: vec![],
                body: b"app said yes".to_vec(),
            },
        },
    );
    let signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("btp-session-test"));
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
    let gate = ClientClaimGate::restore(test_channels(), Arc::new(InMemoryJournal::new()))
        .expect("a fresh in-memory journal has nothing to replay");
    let app = connector_client_edge::router_with_gate(connector, signer.clone(), None, gate);
    let server = axum::Server::bind(&"127.0.0.1:0".parse().unwrap()).serve(app.into_make_service());
    let addr = server.local_addr();
    tokio::spawn(server);
    (addr, signer)
}

type Session =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(addr: SocketAddr) -> Session {
    let (session, _response) = tokio_tungstenite::connect_async(format!("ws://{addr}/ilp/btp"))
        .await
        .expect("the upgrade succeeds");
    session
}

async fn next_answer(session: &mut Session) -> Answer {
    loop {
        let message = session
            .next()
            .await
            .expect("the session stays open")
            .expect("a websocket frame");
        if let WsMessage::Binary(bytes) = message {
            return parse_answer(&bytes);
        }
    }
}

async fn send(session: &mut Session, frame: Vec<u8>) {
    session
        .send(WsMessage::Binary(frame))
        .await
        .expect("the frame sends");
}

// ─── the tests ───

/// §1.9 steps 1 and 2, and the ordering contract in one session: auth is
/// acknowledged, and five paid writes pipelined back-to-back -- their claims
/// sent in nonce order on the one socket, none waiting for the previous
/// response -- all fulfil. On the HTTP carriage this exact traffic can race
/// itself into `NonceNotAdvancing`; the ordered session is the fix, and
/// this assertion is the transport's reason to exist.
#[tokio::test(flavor = "multi_thread")]
async fn an_authenticated_session_pipelines_paid_writes_in_claim_order() {
    let (addr, signer) = serve_edge().await;
    let mut session = connect(addr).await;

    send(
        &mut session,
        btp_message(1, &[("auth", br#"{"peerId":"p","secret":""}"#)], &[]),
    )
    .await;
    let auth = next_answer(&mut session).await;
    assert_eq!(auth.frame_type, BTP_RESPONSE);
    assert_eq!(auth.request_id, 1);

    let receiver = signer.public_key().unwrap();
    // All five frames written before any response is read.
    for nonce in 1..=5u64 {
        let claim = evm_claim_json(nonce, nonce * PRICE);
        let prepare = sealed_prepare("g.test.app", &receiver);
        send(
            &mut session,
            btp_message(
                10 + nonce as u32,
                &[("payment-channel-claim", claim.as_bytes())],
                &prepare.encode(),
            ),
        )
        .await;
    }
    for nonce in 1..=5u64 {
        let answer = next_answer(&mut session).await;
        assert_eq!(answer.frame_type, BTP_RESPONSE);
        assert_eq!(
            answer.request_id,
            10 + nonce as u32,
            "responses come back in the strict order the frames went in"
        );
        let fulfill = Fulfill::decode(&answer.ilp_packet).unwrap_or_else(|_| {
            let reject = Reject::decode(&answer.ilp_packet).expect("an OER packet");
            panic!(
                "write {nonce} was refused {} {:?} instead of fulfilling",
                reject.code.as_str(),
                reject.message
            );
        });
        assert!(!fulfill.data.is_empty(), "a sealed answer rides home");
    }
}

/// §1.9 step 3: the x402 greeting, BTP-shaped -- an F06 REJECT whose
/// `payment-required` protocolData is the same terms JSON the HTTP 402
/// serves, with the running cost total riding as `toon-accumulated-cost`.
#[tokio::test(flavor = "multi_thread")]
async fn a_claimless_prepare_to_a_priced_route_is_refused_with_the_terms() {
    let (addr, signer) = serve_edge().await;
    let mut session = connect(addr).await;

    let prepare = sealed_prepare("g.test.app", &signer.public_key().unwrap());
    send(&mut session, btp_message(2, &[], &prepare.encode())).await;

    let answer = next_answer(&mut session).await;
    assert_eq!(answer.frame_type, BTP_RESPONSE);
    assert_eq!(answer.request_id, 2);
    let reject = Reject::decode(&answer.ilp_packet).expect("an OER REJECT");
    assert_eq!(reject.code.as_str(), "F06");
    assert_eq!(reject.message, "No payment channel claim attached");
    assert_eq!(pd(&answer, "toon-accumulated-cost"), Some(b"0".as_slice()));
    let terms: serde_json::Value =
        serde_json::from_slice(pd(&answer, "payment-required").expect("the terms ride along"))
            .expect("the terms are the §1.4 JSON");
    assert_eq!(terms["x402Version"], 2);
    assert_eq!(terms["accepts"][0]["amount"], PRICE.to_string());
}

/// §1.3 over the new carriage: a non-advancing nonce is refused exactly as
/// HTTP refuses it (F01, the shared taxonomy) -- same gate, same watermark,
/// so the first claim's nonce is spent for both carriages at once.
#[tokio::test(flavor = "multi_thread")]
async fn a_replayed_claim_is_refused_with_the_http_taxonomy() {
    let (addr, signer) = serve_edge().await;
    let mut session = connect(addr).await;
    let receiver = signer.public_key().unwrap();

    let claim = evm_claim_json(1, PRICE);
    send(
        &mut session,
        btp_message(
            1,
            &[("payment-channel-claim", claim.as_bytes())],
            &sealed_prepare("g.test.app", &receiver).encode(),
        ),
    )
    .await;
    let first = next_answer(&mut session).await;
    Fulfill::decode(&first.ilp_packet).expect("the fresh claim pays");

    // The same claim again: structurally and cryptographically fine, its
    // nonce simply does not advance.
    send(
        &mut session,
        btp_message(
            2,
            &[("payment-channel-claim", claim.as_bytes())],
            &sealed_prepare("g.test.app", &receiver).encode(),
        ),
    )
    .await;
    let second = next_answer(&mut session).await;
    let reject = Reject::decode(&second.ilp_packet).expect("an OER REJECT");
    assert_eq!(reject.code.as_str(), "F01");
    assert_eq!(pd(&second, "toon-accumulated-cost"), Some(b"0".as_slice()));
}

/// §1.9 step 4: a standalone claim is ingested fire-and-forget -- no
/// response frame -- and genuinely advances the shared watermark: the auth
/// frame sent after it is answered first (nothing answered the claim), and
/// a following paid write must present nonce 2, not 1.
#[tokio::test(flavor = "multi_thread")]
async fn a_standalone_claim_registers_silently_and_advances_the_watermark() {
    let (addr, signer) = serve_edge().await;
    let mut session = connect(addr).await;

    let claim = evm_claim_json(1, PRICE);
    send(
        &mut session,
        btp_message(1, &[("payment-channel-claim", claim.as_bytes())], &[]),
    )
    .await;
    send(
        &mut session,
        btp_message(2, &[("auth", br#"{"peerId":"p","secret":""}"#)], &[]),
    )
    .await;
    let answer = next_answer(&mut session).await;
    assert_eq!(
        answer.request_id, 2,
        "the standalone claim is answered with nothing; the auth ack is the first frame back"
    );

    // Nonce 1 is spent: a packet claim reusing it is refused, and nonce 2
    // fulfils -- the fire-and-forget claim reached the same watermark.
    let receiver = signer.public_key().unwrap();
    let replay = evm_claim_json(1, PRICE);
    send(
        &mut session,
        btp_message(
            3,
            &[("payment-channel-claim", replay.as_bytes())],
            &sealed_prepare("g.test.app", &receiver).encode(),
        ),
    )
    .await;
    let refused = next_answer(&mut session).await;
    let reject = Reject::decode(&refused.ilp_packet).expect("an OER REJECT");
    assert_eq!(reject.code.as_str(), "F01");

    let fresh = evm_claim_json(2, 2 * PRICE);
    send(
        &mut session,
        btp_message(
            4,
            &[("payment-channel-claim", fresh.as_bytes())],
            &sealed_prepare("g.test.app", &receiver).encode(),
        ),
    )
    .await;
    let fulfilled = next_answer(&mut session).await;
    Fulfill::decode(&fulfilled.ilp_packet).expect("nonce 2 pays");
}

/// §1.9 step 5: an undecodable frame whose requestId was readable is
/// answered with an ERROR frame carrying the parse failure, and the session
/// survives to serve the next frame.
#[tokio::test(flavor = "multi_thread")]
async fn a_malformed_frame_is_answered_with_an_error_and_the_session_survives() {
    let (addr, _signer) = serve_edge().await;
    let mut session = connect(addr).await;

    // Claims one protocolData entry, provides nothing after the count.
    send(&mut session, vec![6, 0, 0, 0, 9, 1]).await;
    let error = next_answer(&mut session).await;
    assert_eq!(error.frame_type, BTP_ERROR);
    assert_eq!(error.request_id, 9);
    assert_eq!(pd(&error, "code"), Some(b"F00".as_slice()));

    send(
        &mut session,
        btp_message(10, &[("auth", br#"{"peerId":"p","secret":""}"#)], &[]),
    )
    .await;
    let auth = next_answer(&mut session).await;
    assert_eq!(auth.frame_type, BTP_RESPONSE);
    assert_eq!(auth.request_id, 10);
}
