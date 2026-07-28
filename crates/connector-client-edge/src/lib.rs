//! Client-edge router, mountable rather than a server. See ADR 0001, ADR
//! 0003, and `docs/protocol/client-edge-spec.md` -- this implements §1.1
//! (transport and framing: `POST /ilp`, OER-encoded PREPARE in, OER-encoded
//! FULFILL/REJECT out, always HTTP 200 for an ILP-level outcome) and, as of
//! issues #504, #522 and #506/#544, all four steps of §1.3 (payment
//! claims): a present claim is parsed, structurally validated, checked for
//! freshness/watermark, checked to advance value by at least the
//! destination's matched app route's price, and cryptographically
//! verified (`ClientClaimGate` -- see its own doc comment for what
//! "verified" means absent a channel-counterparty registry, issue #542) --
//! all before the packet is routed. Identity (§1.2) and the x402 greeting
//! (§1.4) remain unimplemented; a request presenting no claim header at all
//! still passes through unchanged, exactly as it always has, and
//! pay-to-write is absolute for one that is present -- there is no
//! configuration, flag or build profile that disables any of §1.3's checks.
//!
//! Per ADR 0001, this handler deserializes, calls exactly one method on
//! [`Connector`], and serializes; the `match` below is that serialization
//! step, not a routing or delivery decision -- those live entirely in
//! [`Connector::handle_prepare`].

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Deserialize;

use connector_domain::{PacketResponse, Prepare, Reject, RejectCode};
use connector_runtime::Connector;
use connector_signer::nip59::{unwrap_claim, WrappedClaim};
use connector_signer::PublicKeyBytes;

mod claim_gate;
pub use claim_gate::{ClaimIngestRejection, ClientClaimGate};

const OCTET_STREAM: &str = "application/octet-stream";
const CLAIM_HEADER: &str = "ilp-payment-channel-claim";
const CLAIM_WRAPPED_HEADER: &str = "ilp-payment-channel-claim-wrapped";

struct ClientEdgeState {
    connector: Arc<Connector>,
    claim_gate: ClientClaimGate,
    /// This connector's own NIP-59 receiver key, used to unwrap a
    /// privacy-wrapped claim (client-edge-spec.md §1.3). `None` means this
    /// instance is not configured to receive wrapped claims -- one is
    /// refused with [`ClaimIngestRejection::WrapUnsupported`] rather than
    /// silently accepted unwrapped or left to panic.
    wrap_receiver_secret: Option<[u8; 32]>,
}

/// Mount the client edge at `connector`: `POST /ilp` per
/// `docs/protocol/client-edge-spec.md` §1.1, with no configured NIP-59
/// receiver key -- a privacy-wrapped claim is refused rather than accepted.
/// Use [`router_with_wrap_key`] to accept wrapped claims.
pub fn router(connector: Arc<Connector>) -> Router {
    router_with_wrap_key(connector, None)
}

/// As [`router`], but able to unwrap a privacy-wrapped claim
/// (client-edge-spec.md §1.3) using `wrap_receiver_secret` as this
/// connector's own NIP-59 receiver key.
pub fn router_with_wrap_key(
    connector: Arc<Connector>,
    wrap_receiver_secret: Option<[u8; 32]>,
) -> Router {
    let state = Arc::new(ClientEdgeState {
        connector,
        claim_gate: ClientClaimGate::new(),
        wrap_receiver_secret,
    });
    Router::new()
        .route("/ilp", post(handle_ilp))
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
/// client-edge-spec.md §1.3. `Ok(())` covers both "no claim header was
/// present at all" -- out of this ticket's scope (the x402 greeting/value
/// binding that would refuse an unpaid request), so the request proceeds
/// unchanged, exactly as it always has -- and "a present claim validated
/// cleanly"; the caller doesn't need to tell those apart. A plaintext
/// header takes precedence when both are present, since a client presenting
/// both is presenting the same claim twice, not two different ones.
fn extract_and_validate_claim(
    headers: &HeaderMap,
    destination: &str,
    state: &ClientEdgeState,
) -> Result<(), ClaimIngestRejection> {
    let (header_value, wrapped) = if let Some(value) = headers.get(CLAIM_HEADER) {
        (value, false)
    } else if let Some(value) = headers.get(CLAIM_WRAPPED_HEADER) {
        (value, true)
    } else {
        return Ok(());
    };

    let claim_json = decode_claim_header(
        header_value.as_bytes(),
        wrapped,
        state.wrap_receiver_secret.as_ref(),
    )?;
    // No matching app route means nothing here is priced -- routing itself
    // (not this gate) is what refuses an unroutable destination, with F02.
    let price = state.connector.app_route_price(destination).unwrap_or(0);
    state.claim_gate.ingest(&claim_json, price)?;
    Ok(())
}

fn claim_rejected_response(rejection: ClaimIngestRejection) -> Response {
    // Underpayment is a distinct ILP error (F03: Invalid Amount, issue
    // #522) from every other claim-ingest refusal above it (F01: Invalid
    // Packet) -- the claim is structurally and cryptographically fine, it
    // simply isn't enough value.
    let code = match rejection {
        ClaimIngestRejection::Underpayment { .. } => RejectCode::f03_invalid_amount(),
        _ => RejectCode::f01_invalid_packet(),
    };
    let reject = Reject {
        code,
        triggered_by: String::new(),
        message: rejection.message(),
        data: Vec::new(),
        accumulated_cost: 0,
    };
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, OCTET_STREAM)],
        reject.encode(),
    )
        .into_response()
}

async fn handle_ilp(
    State(state): State<Arc<ClientEdgeState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let prepare = match Prepare::decode(&body) {
        Ok(prepare) => prepare,
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };

    // A claim header's validation failure rejects the packet before it is
    // routed at all (client-edge-spec.md §1.3) -- the app is never asked to
    // do work that was never validly paid for.
    if let Err(rejection) = extract_and_validate_claim(&headers, &prepare.destination, &state) {
        return claim_rejected_response(rejection);
    }

    // client-edge-spec.md v1 carries no minimum-delivery field (§4 of
    // peer-wire-spec.md scopes it to the peer wire) -- a client-originated
    // packet declares no guarantee yet, so this hop enforces none, exactly
    // matching today's actual (unguaranteed) behavior.
    let encoded = match state.connector.handle_prepare(prepare, 0).await {
        PacketResponse::Fulfill(fulfill) => fulfill.encode(),
        PacketResponse::Reject(reject) => reject.encode(),
    };

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, OCTET_STREAM)],
        encoded,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use chrono::{TimeZone, Utc};
    use connector_config::StaticRoute;
    use connector_domain::{derive_condition, Fulfill, Reject};
    use connector_runtime::{
        AppOutcome, FakeAppClient, InProcessPeerTransport, NetworkPeerTransport, PeerRoute,
        PeerWireServer, TestClock,
    };
    use tower::ServiceExt;

    const FULFILLMENT: [u8; 32] = [7u8; 32];

    fn sample_prepare(destination: &str) -> Prepare {
        Prepare {
            amount: 0,
            // Comfortably after `test_clock()`'s instant (2030-01-01).
            expires_at: Utc.with_ymd_and_hms(2031, 1, 1, 0, 0, 0).unwrap(),
            execution_condition: derive_condition(&FULFILLMENT),
            destination: destination.to_string(),
            data: b"hello app".to_vec(),
        }
    }

    fn sample_prepare_with_amount(destination: &str, amount: u64) -> Prepare {
        Prepare {
            amount,
            ..sample_prepare(destination)
        }
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
        app_client.respond(
            route.handler_url(),
            AppOutcome::Delivered {
                data: b"app said yes".to_vec(),
                fulfillment: Some(FULFILLMENT),
            },
        );
        let connector = Arc::new(Connector::new(
            vec![route],
            vec![],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let app = router(connector);

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            OCTET_STREAM
        );

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let fulfill = Fulfill::decode(&bytes).expect("decode fulfill");
        assert_eq!(fulfill.data, b"app said yes");
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
        let app = router(connector);

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
        let app = router(connector);

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(vec![0xff, 0xff, 0xff, 0xff]))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn a_declining_app_still_returns_200_with_a_reject_body() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            AppOutcome::Declined {
                status: 402,
                body: b"payment required".to_vec(),
            },
        );
        let connector = Arc::new(Connector::new(
            vec![route],
            vec![],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let app = router(connector);

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let reject = Reject::decode(&bytes).expect("decode reject");
        assert_eq!(reject.code.as_str(), "F99");
        assert_eq!(reject.data, b"payment required");
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
            AppOutcome::Delivered {
                data: b"delivered by the second connector".to_vec(),
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
        let first_hop = Arc::new(Connector::new(
            vec![],
            vec![PeerRoute::new("g.example.app", "second-hop", 0)],
            Arc::new(FakeAppClient::new()),
            Arc::new(peer_transport),
            test_clock(),
        ));
        let app = router(first_hop);

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let fulfill = Fulfill::decode(&bytes).expect("decode fulfill");
        assert_eq!(fulfill.data, b"delivered by the second connector");
    }

    /// The first connector's flat fee (ADR 0010) for its peering relation
    /// with the second connector is subtracted before forwarding, and the
    /// second connector -- reachable only through the first one's router,
    /// exactly like a real client -- observes the discounted amount.
    #[tokio::test]
    async fn a_client_packet_forwarded_to_a_peer_is_charged_that_relations_flat_fee() {
        let second_hop_route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let second_hop_app_client = Arc::new(FakeAppClient::new());
        second_hop_app_client.respond(
            second_hop_route.handler_url(),
            AppOutcome::Delivered {
                data: b"delivered by the second connector".to_vec(),
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
        let first_hop = Arc::new(Connector::new(
            vec![],
            vec![PeerRoute::new("g.example.app", "second-hop", 3)],
            Arc::new(FakeAppClient::new()),
            Arc::new(peer_transport),
            test_clock(),
        ));
        let app = router(first_hop);

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(
                sample_prepare_with_amount("g.example.app", 50).encode(),
            ))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        Fulfill::decode(&bytes).expect("decode fulfill");
        assert_eq!(second_hop_app_client.deliveries()[0].amount, 47);
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
        let app = router(first_hop);

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

    /// Two separate connectors, forwarding over the peer wire's network
    /// implementation (issue #416) rather than the in-process stand-in: a
    /// client posts to the first connector's router, which has no app of
    /// its own for this destination and forwards the packet over a real
    /// TCP connection to the second connector's [`PeerWireServer`], which
    /// delivers it to its app and the fulfillment travels back the same
    /// way.
    #[tokio::test]
    async fn a_client_packet_is_forwarded_over_the_network_transport_to_a_second_connector() {
        let second_hop_route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let second_hop_app_client = Arc::new(FakeAppClient::new());
        second_hop_app_client.respond(
            second_hop_route.handler_url(),
            AppOutcome::Delivered {
                data: b"delivered over the network transport".to_vec(),
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
        let server = PeerWireServer::bind("127.0.0.1:0".parse().unwrap(), second_hop)
            .await
            .unwrap();

        let mut peer_transport = NetworkPeerTransport::new();
        peer_transport.add_peer("second-hop", server.local_addr());
        let first_hop = Arc::new(Connector::new(
            vec![],
            vec![PeerRoute::new("g.example.app", "second-hop", 0)],
            Arc::new(FakeAppClient::new()),
            Arc::new(peer_transport),
            test_clock(),
        ));
        let app = router(first_hop);

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let fulfill = Fulfill::decode(&bytes).expect("decode fulfill");
        assert_eq!(fulfill.data, b"delivered over the network transport");
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
                address = connector_signer::to_hex(&address),
                token_network_address = connector_signer::to_hex(&EVM_TOKEN_NETWORK_ADDRESS),
            )
        }

        /// An EVM claim JSON with a genuine EIP-712 signature over its own
        /// fields (issue #506/#544) -- every test using this helper
        /// exercises the real verification path, not a bypass.
        fn evm_claim_json(nonce: u64, transferred_amount: u64) -> String {
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

        fn request_with_claim_header(
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

        fn hex_encode(bytes: &[u8]) -> String {
            bytes.iter().map(|b| format!("{b:02x}")).collect()
        }

        #[tokio::test]
        async fn a_fresh_plaintext_claim_lets_the_packet_reach_the_app() {
            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(
                route.handler_url(),
                AppOutcome::Delivered {
                    data: b"ok".to_vec(),
                    fulfillment: Some(FULFILLMENT),
                },
            );
            let connector = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            let app = router(connector);

            let request = request_with_claim_header(
                &sample_prepare("g.example.app"),
                CLAIM_HEADER,
                &evm_claim_json(1, 100),
            );
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
            app_client.respond(
                route.handler_url(),
                AppOutcome::Delivered {
                    data: b"ok".to_vec(),
                    fulfillment: Some(FULFILLMENT),
                },
            );
            let connector = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            let app = router(connector);

            let first = request_with_claim_header(
                &sample_prepare("g.example.app"),
                CLAIM_HEADER,
                &evm_claim_json(5, 500),
            );
            let response = app.clone().oneshot(first).await.unwrap();
            Fulfill::decode(&hyper::body::to_bytes(response.into_body()).await.unwrap())
                .expect("first claim accepted");

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
            app_client.respond(
                route.handler_url(),
                AppOutcome::Delivered {
                    data: b"ok".to_vec(),
                    fulfillment: Some(FULFILLMENT),
                },
            );
            let connector = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            let app = router(connector);

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
            let app = router(connector);

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
            app_client.respond(
                route.handler_url(),
                AppOutcome::Delivered {
                    data: b"ok".to_vec(),
                    fulfillment: Some(FULFILLMENT),
                },
            );
            let connector = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));

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

            let app = router_with_wrap_key(connector, Some(receiver_secret_bytes));
            let request = request_with_claim_header(
                &sample_prepare("g.example.app"),
                CLAIM_WRAPPED_HEADER,
                &envelope_json,
            );
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
            let app = router(connector);

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
            app_client.respond(
                route.handler_url(),
                AppOutcome::Delivered {
                    data: b"ok".to_vec(),
                    fulfillment: Some(FULFILLMENT),
                },
            );
            let connector = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            let app = router(connector);

            let request = request_with_claim_header(
                &sample_prepare("g.example.app"),
                CLAIM_HEADER,
                &evm_claim_json(1, 100),
            );
            let response = app.oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            Fulfill::decode(&bytes).expect("decode fulfill");
            assert_eq!(app_client.deliveries().len(), 1);
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
            app_client.respond(
                route.handler_url(),
                AppOutcome::Delivered {
                    data: b"ok".to_vec(),
                    fulfillment: Some(FULFILLMENT),
                },
            );
            let connector = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            let app = router(connector);

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
            let app = router(connector);

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
            let app = router(connector);

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
    }
}
