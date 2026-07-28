//! Client-edge router, mountable rather than a server. See ADR 0001, ADR
//! 0003, and `docs/protocol/client-edge-spec.md` -- this implements §1.1
//! (transport and framing: `POST /ilp`, OER-encoded PREPARE in, OER-encoded
//! FULFILL/REJECT out, always HTTP 200 for an ILP-level outcome), all four
//! steps of §1.3 (payment claims, issues #504, #522 and #506/#544): a
//! present claim is parsed, structurally validated, checked for
//! freshness/watermark, checked to advance value by at least the
//! destination's matched app route's price, and -- last -- cryptographically
//! verified (`ClientClaimGate` -- see its own doc comment for what
//! "verified" means absent a channel-counterparty registry, issue #542),
//! all before the packet is routed; and, as of issue #526, §1.4 (the x402
//! greeting) and the answering half of identity: `GET /ilp/identity`
//! reports the public key a sender seals a packet to (ADR 0018), and an
//! unpaid request to a route this connector terminates and prices is
//! answered with that route's terms (ADR 0020, ADR 0022) instead of being
//! routed at all. `GET /ilp/routes/price` answers what a given destination
//! would cost. Both live under `/ilp` (matching §3.2's `GET /ilp/versions`
//! precedent for an unauthenticated, client-edge-facing answer) rather than
//! at the bare path, since the operator surface already owns a bearer-gated
//! `GET /identity` of its own (issue #420) and the two routers are merged
//! onto one port whenever the operator surface is enabled. None of this
//! pushes anything into a network unprompted (ADR 0022) -- each is a reply
//! to a request that reached this connector's own client edge, and changes
//! no state. A request presenting no claim header and addressing an
//! unpriced (or unmatched) destination still passes through unchanged,
//! exactly as it always has, and pay-to-write is absolute for a priced
//! route -- there is no configuration, flag or build profile that disables
//! any of §1.3's checks. Identity (§1.2, beyond the key answer) remains
//! unimplemented.
//!
//! Per ADR 0001, `handle_ilp` deserializes, calls exactly one method on
//! [`Connector`], and serializes; the `match` below is that serialization
//! step, not a routing or delivery decision -- those live entirely in
//! [`Connector::handle_prepare`]. `identity` and `route_price` answer
//! directly from this connector's own configuration and never touch
//! [`Connector::handle_prepare`] at all.

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};

use connector_domain::{PacketResponse, Prepare, Reject, RejectCode};
use connector_runtime::Connector;
use connector_signer::nip59::{unwrap_claim, WrappedClaim};
use connector_signer::{PublicKeyBytes, Signer};

mod claim_gate;
pub use claim_gate::{ClaimIngestRejection, ClientClaimGate};

const OCTET_STREAM: &str = "application/octet-stream";
const CLAIM_HEADER: &str = "ilp-payment-channel-claim";
const CLAIM_WRAPPED_HEADER: &str = "ilp-payment-channel-claim-wrapped";
const PAYMENT_REQUIRED_HEADER: &str = "payment-required";

struct ClientEdgeState {
    connector: Arc<Connector>,
    signer: Arc<dyn Signer>,
    claim_gate: ClientClaimGate,
    /// This connector's own NIP-59 receiver key, used to unwrap a
    /// privacy-wrapped claim (client-edge-spec.md §1.3). `None` means this
    /// instance is not configured to receive wrapped claims -- one is
    /// refused with [`ClaimIngestRejection::WrapUnsupported`] rather than
    /// silently accepted unwrapped or left to panic.
    wrap_receiver_secret: Option<[u8; 32]>,
}

/// Mount the client edge at `connector`, signing/answering identity with
/// `signer`: `POST /ilp` per `docs/protocol/client-edge-spec.md` §1.1, plus
/// `GET /ilp/identity` and `GET /ilp/routes/price` (§1.2/§1.4, issue #526),
/// with no configured NIP-59 receiver key -- a privacy-wrapped claim is
/// refused rather than accepted. Use [`router_with_wrap_key`] to accept
/// wrapped claims.
pub fn router(connector: Arc<Connector>, signer: Arc<dyn Signer>) -> Router {
    router_with_wrap_key(connector, signer, None)
}

/// As [`router`], but able to unwrap a privacy-wrapped claim
/// (client-edge-spec.md §1.3) using `wrap_receiver_secret` as this
/// connector's own NIP-59 receiver key.
pub fn router_with_wrap_key(
    connector: Arc<Connector>,
    signer: Arc<dyn Signer>,
    wrap_receiver_secret: Option<[u8; 32]>,
) -> Router {
    let state = Arc::new(ClientEdgeState {
        connector,
        signer,
        claim_gate: ClientClaimGate::new(),
        wrap_receiver_secret,
    });
    Router::new()
        .route("/ilp", post(handle_ilp))
        .route("/ilp/identity", get(identity))
        .route("/ilp/routes/price", get(route_price))
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

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// This connector's own identity (ADR 0018, ADR 0022): the uncompressed
/// secp256k1 public key a sender must seal a packet's payload to before it
/// can address this connector, plus the key id identifying it. Unlike the
/// operator surface's own bearer-gated `GET /identity` (issue #420, a
/// different audience per ADR 0022) -- mounted at `/ilp/identity` so the
/// two cannot collide when both routers merge onto one port -- this one is
/// unauthenticated -- an unaffiliated sender who has never registered with this connector's
/// operator still needs this key before it can form a packet at all, and
/// answering it decides nothing and reaches nobody who did not ask.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct ClientEdgeIdentity {
    #[serde(rename = "keyId")]
    key_id: String,
    #[serde(rename = "publicKey")]
    public_key: String,
}

async fn identity(State(state): State<Arc<ClientEdgeState>>) -> Response {
    match state.signer.public_key() {
        Ok(public_key) => Json(ClientEdgeIdentity {
            key_id: state.signer.key_id(),
            public_key: format!("0x{}", hex_encode(&public_key)),
        })
        .into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct RoutePriceQuery {
    destination: String,
}

/// What a given destination would cost to deliver to, per ADR 0022's
/// "a sender can ask what a route of its costs" -- reuses
/// [`Connector::app_route_price`], the same longest-prefix lookup the
/// x402 greeting and the claim gate's value binding already use, so this
/// answers with exactly the price a real request to `destination` would be
/// charged, never a second source of truth.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct RoutePriceView {
    destination: String,
    price: u64,
}

async fn route_price(
    State(state): State<Arc<ClientEdgeState>>,
    Query(query): Query<RoutePriceQuery>,
) -> Response {
    match state.connector.app_route_price(&query.destination) {
        Some(price) => Json(RoutePriceView {
            destination: query.destination,
            price,
        })
        .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            format!(
                "no locally-terminated route matches '{}'",
                query.destination
            ),
        )
            .into_response(),
    }
}

/// The x402 v2 payment-required greeting (client-edge-spec.md §1.4): the
/// terms of the one payment method this connector's client edge actually
/// understands -- a TOON payment channel claim, over this same `/ilp`
/// endpoint. `accepts` is a list (ADR 0022's fourth acceptance criterion)
/// so a later method can be offered alongside this one without changing
/// the answer's shape; only one entry exists today because on-chain
/// settlement addresses (the `exact` x402 scheme's `asset`/`payTo`) are not
/// yet configured anywhere in this connector (issue #526 is answering
/// terms, not adding that config).
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct X402PaymentRequired {
    #[serde(rename = "x402Version")]
    x402_version: u32,
    resource: X402Resource,
    accepts: Vec<X402PaymentOption>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct X402Resource {
    url: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct X402PaymentOption {
    scheme: String,
    network: String,
    amount: String,
    #[serde(rename = "payTo")]
    pay_to: String,
    #[serde(rename = "maxTimeoutSeconds")]
    max_timeout_seconds: u64,
    #[serde(rename = "httpEndpoint")]
    http_endpoint: String,
    extra: X402ChannelExtra,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct X402ChannelExtra {
    #[serde(rename = "ilpAddress")]
    ilp_address: String,
    endpoint: String,
    price: String,
}

const X402_VERSION: u32 = 2;
const X402_MAX_TIMEOUT_SECONDS: u64 = 60;

/// Answer an unpaid request to `destination`, a route this connector
/// terminates and prices at `price`, with its terms instead of performing
/// the app's work (client-edge-spec.md §1.4, ADR 0022) -- this changes no
/// state and is only ever a reply to the request that asked.
fn payment_required(destination: &str, price: u64) -> Response {
    let terms = X402PaymentRequired {
        x402_version: X402_VERSION,
        resource: X402Resource {
            url: destination.to_string(),
        },
        accepts: vec![X402PaymentOption {
            scheme: "toon-channel".to_string(),
            network: destination.to_string(),
            amount: price.to_string(),
            pay_to: destination.to_string(),
            max_timeout_seconds: X402_MAX_TIMEOUT_SECONDS,
            http_endpoint: "/ilp".to_string(),
            extra: X402ChannelExtra {
                ilp_address: destination.to_string(),
                endpoint: "/ilp".to_string(),
                price: price.to_string(),
            },
        }],
    };
    let body = serde_json::to_vec(&terms).expect("x402 terms always serialize");
    let header_value = BASE64.encode(&body);
    Response::builder()
        .status(StatusCode::PAYMENT_REQUIRED)
        .header(header::CONTENT_TYPE, "application/json")
        .header(PAYMENT_REQUIRED_HEADER, header_value)
        .body(Body::from(body))
        .expect("well-formed x402 response")
        .into_response()
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
/// present at all" -- reachable here only when `destination` is unpriced or
/// unmatched, since `handle_ilp` answers the x402 greeting instead of
/// calling this at all for an unpaid request to a priced route (issue
/// #526) -- so the request proceeds unchanged, exactly as it always has --
/// and "a present claim validated cleanly"; the caller doesn't need to tell
/// those apart. A plaintext header takes precedence when both are present,
/// since a client presenting both is presenting the same claim twice, not
/// two different ones.
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

    // An unpaid request -- no claim header of either kind -- addressing a
    // route this connector terminates and prices is answered with that
    // route's terms instead of being routed at all (client-edge-spec.md
    // §1.4, ADR 0022): the app is never asked to do free work for an
    // anonymous, unpaying caller. A present claim header suppresses the
    // greeting unconditionally (its validation, including underpayment, is
    // §1.3's job below); an unpriced or unmatched destination is
    // unaffected and falls through unchanged, exactly as it always has.
    let has_claim_header =
        headers.contains_key(CLAIM_HEADER) || headers.contains_key(CLAIM_WRAPPED_HEADER);
    if !has_claim_header {
        let price = state
            .connector
            .app_route_price(&prepare.destination)
            .unwrap_or(0);
        if price > 0 {
            return payment_required(&prepare.destination, price);
        }
    }

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
    use axum::http::Request;
    use chrono::{TimeZone, Utc};
    use connector_config::StaticRoute;
    use connector_domain::{derive_condition, EnvelopeRequest, EnvelopeResponse, Fulfill, Reject};
    use connector_runtime::{
        AppOutcome, FakeAppClient, InProcessPeerTransport, NetworkPeerTransport, PeerRoute,
        PeerWireServer, TestClock,
    };
    use connector_signer::LocalSigner;
    use tower::ServiceExt;

    const FULFILLMENT: [u8; 32] = [7u8; 32];

    /// What a `Prepare`'s `data` carries per ADR 0018/issue #519 -- a
    /// structured envelope, still plaintext at this point (sealing is
    /// issue #524).
    fn envelope_request_data(body: &[u8]) -> Vec<u8> {
        EnvelopeRequest {
            method: "POST".to_string(),
            target: "/".to_string(),
            headers: vec![],
            body: body.to_vec(),
        }
        .encode()
    }

    /// The `AppOutcome` a `FakeAppClient` produces for an app that answers
    /// `200` with `body`, optionally claiming `fulfillment` via the
    /// `TOON-Fulfillment` response header (issue #417, until #525 derives
    /// it instead).
    fn answered(body: &[u8], fulfillment: Option<[u8; 32]>) -> AppOutcome {
        answered_with_status(200, body, fulfillment)
    }

    fn answered_with_status(status: u16, body: &[u8], fulfillment: Option<[u8; 32]>) -> AppOutcome {
        let headers = fulfillment
            .map(|fulfillment| {
                vec![(
                    "TOON-Fulfillment".to_string(),
                    fulfillment
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect(),
                )]
            })
            .unwrap_or_default();
        AppOutcome::Answered {
            response: EnvelopeResponse {
                status,
                headers,
                body: body.to_vec(),
            },
        }
    }

    /// The exact `Fulfill.data` bytes for the same inputs `answered` above
    /// configures a `FakeAppClient` with -- a response envelope, with
    /// `TOON-Fulfillment` stripped before it reaches the client (issue
    /// #521).
    fn fulfill_data(body: &[u8]) -> Vec<u8> {
        fulfill_data_with_status(200, body)
    }

    fn fulfill_data_with_status(status: u16, body: &[u8]) -> Vec<u8> {
        EnvelopeResponse {
            status,
            headers: vec![],
            body: body.to_vec(),
        }
        .encode()
    }

    fn test_signer() -> Arc<dyn Signer> {
        Arc::new(LocalSigner::generate("test-signer"))
    }

    fn sample_prepare(destination: &str) -> Prepare {
        Prepare {
            amount: 0,
            // Comfortably after `test_clock()`'s instant (2030-01-01).
            expires_at: Utc.with_ymd_and_hms(2031, 1, 1, 0, 0, 0).unwrap(),
            execution_condition: derive_condition(&FULFILLMENT),
            destination: destination.to_string(),
            data: envelope_request_data(b"hello app"),
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
            answered(b"app said yes", Some(FULFILLMENT)),
        );
        let connector = Arc::new(Connector::new(
            vec![route],
            vec![],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let app = router(connector, test_signer());

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
        assert_eq!(fulfill.data, fulfill_data(b"app said yes"));
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
        let app = router(connector, test_signer());

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
        let app = router(connector, test_signer());

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(vec![0xff, 0xff, 0xff, 0xff]))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    /// Issue #521's central rule (ADR 0020): "you pay for an answer, not
    /// the answer you wanted." A non-2xx response from the app is a real
    /// answer, still HTTP 200 at the client edge, riding home as a
    /// response envelope on a FULFILL -- not converted into a rejection.
    #[tokio::test]
    async fn a_non_2xx_response_from_the_app_still_returns_200_with_a_fulfill_body() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            answered_with_status(402, b"payment required", Some(FULFILLMENT)),
        );
        let connector = Arc::new(Connector::new(
            vec![route],
            vec![],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let app = router(connector, test_signer());

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let fulfill = Fulfill::decode(&bytes).expect("decode fulfill");
        assert_eq!(
            fulfill.data,
            fulfill_data_with_status(402, b"payment required")
        );
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
            answered(b"delivered by the second connector", Some(FULFILLMENT)),
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
        let app = router(first_hop, test_signer());

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let fulfill = Fulfill::decode(&bytes).expect("decode fulfill");
        assert_eq!(
            fulfill.data,
            fulfill_data(b"delivered by the second connector")
        );
    }

    /// The first connector's flat fee (ADR 0010) for its peering relation
    /// with the second connector is subtracted before forwarding, and the
    /// second connector -- reachable only through the first one's router,
    /// exactly like a real client -- observes the discounted amount.
    #[tokio::test]
    async fn a_client_packet_forwarded_to_a_peer_is_charged_that_relations_flat_fee() {
        use connector_signer::{LocalSigner, Signer};

        let second_hop_route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let second_hop_app_client = Arc::new(FakeAppClient::new());
        second_hop_app_client.respond(
            second_hop_route.handler_url(),
            answered(b"delivered by the second connector", Some(FULFILLMENT)),
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
        peer_transport.add_peer("second-hop", second_hop);
        peer_transport.set_peer_channel("second-hop", "channel-a");
        let first_hop = Arc::new(
            Connector::new(
                vec![],
                vec![PeerRoute::new("g.example.app", "second-hop", 3)],
                Arc::new(FakeAppClient::new()),
                Arc::new(peer_transport),
                test_clock(),
            )
            .with_signer(Arc::new(payer_signer))
            .with_peer_claim_channel("second-hop", "channel-a"),
        );
        let app = router(first_hop.clone(), test_signer());

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
        // The port never sees a `Prepare` (issue #521), so the forwarded
        // amount is asserted through the claim it armed rather than
        // through the app client -- 50 minus this peer relationship's
        // flat fee of 3.
        assert_eq!(first_hop.claims()[0].cumulative_amount, 47);
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
        let app = router(first_hop, test_signer());

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
            answered(b"delivered over the network transport", Some(FULFILLMENT)),
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
        let app = router(first_hop, test_signer());

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let fulfill = Fulfill::decode(&bytes).expect("decode fulfill");
        assert_eq!(
            fulfill.data,
            fulfill_data(b"delivered over the network transport")
        );
    }

    /// A sender can ask this connector who it is and get back the key it
    /// would seal a packet to (ADR 0018, ADR 0022, issue #526) --
    /// unauthenticated, no request body, and answered from this connector's
    /// own signer with no state change.
    #[tokio::test]
    async fn a_sender_can_ask_this_connectors_identity_and_gets_its_public_key() {
        let connector = Arc::new(Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let signer = test_signer();
        let app = router(connector, signer.clone());

        let request = Request::builder()
            .method("GET")
            .uri("/ilp/identity")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let identity: ClientEdgeIdentity = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(identity.key_id, signer.key_id());
        assert_eq!(
            identity.public_key,
            format!("0x{}", hex_encode(&signer.public_key().unwrap()))
        );
    }

    /// A sender can ask what a given terminated route costs and gets that
    /// route's configured price back (ADR 0022, issue #526), reading the
    /// same value `app_route_price` -- and so the claim gate and the x402
    /// greeting -- would charge against a real request.
    #[tokio::test]
    async fn a_sender_can_ask_what_a_route_costs() {
        let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 42).unwrap();
        let connector = Arc::new(Connector::new(
            vec![route],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let app = router(connector, test_signer());

        let request = Request::builder()
            .method("GET")
            .uri("/ilp/routes/price?destination=g.example.app.sub")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let view: RoutePriceView = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(view.price, 42);
    }

    /// Asking about a destination that matches no locally-terminated route
    /// is a 404, not a fabricated price.
    #[tokio::test]
    async fn asking_the_price_of_an_unmatched_destination_is_a_404() {
        let connector = Arc::new(Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let app = router(connector, test_signer());

        let request = Request::builder()
            .method("GET")
            .uri("/ilp/routes/price?destination=g.nowhere")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    /// The heart of issue #526: an unpaid request to a route this connector
    /// terminates and prices is answered with its terms (x402 v2, §1.4)
    /// instead of ever reaching the app -- the free-gateway failure mode
    /// ADR 0022 exists to close.
    #[tokio::test]
    async fn an_unpaid_request_to_a_priced_route_is_answered_with_terms_not_performed() {
        let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 100).unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        // Deliberately no `app_client.respond(...)` registered: `deliveries()`
        // records a call the moment `AppClient::deliver` runs, regardless of
        // outcome, so an empty list below proves the app was never reached
        // at all -- not merely that it answered unfavorably.
        let connector = Arc::new(Connector::new(
            vec![route],
            vec![],
            app_client.clone(),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let app = router(connector, test_signer());

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
        let payment_required_header = response
            .headers()
            .get(PAYMENT_REQUIRED_HEADER)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let terms: X402PaymentRequired = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(terms.x402_version, 2);
        assert_eq!(terms.resource.url, "g.example.app");
        assert_eq!(terms.accepts.len(), 1, "terms are carried as a list");
        assert_eq!(terms.accepts[0].amount, "100");

        // The header carries the same body the greeting sends over the wire.
        let header_bytes = BASE64.decode(&payment_required_header).unwrap();
        assert_eq!(header_bytes, bytes.to_vec());

        assert!(
            app_client.deliveries().is_empty(),
            "the app must never be asked to do the work an unpaid request didn't pay for"
        );
    }

    /// A claim header suppresses the greeting even to a priced route --
    /// §1.3's own validation (freshness, value, eventually signature) is
    /// what judges a paid request, not the unpaid-answer path.
    #[tokio::test]
    async fn a_present_claim_header_suppresses_the_greeting() {
        let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 100).unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(route.handler_url(), answered(b"ok", Some(FULFILLMENT)));
        let connector = Arc::new(Connector::new(
            vec![route],
            vec![],
            app_client.clone(),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let app = router(connector, test_signer());

        // A genuinely signed claim: since issue #506/#544 the gate's last
        // stage verifies the signature, so a placeholder one would be
        // refused here for a signature-shaped reason and this test would
        // no longer be observing what it names -- that a *present* claim
        // sends the request down §1.3's validation path rather than the
        // unpaid-greeting one.
        let claim_json = claim_headers::evm_claim_json(1, 100);
        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .header(CLAIM_HEADER, BASE64.encode(claim_json.as_bytes()))
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        Fulfill::decode(&bytes).expect("a validly paid claim still reaches the app");
        assert_eq!(app_client.deliveries().len(), 1);
    }

    /// An unpaid request to an explicitly free (`price == 0`) route is
    /// unaffected -- it still reaches the app exactly as it always has,
    /// since there is nothing to charge and so nothing to answer with
    /// terms instead of.
    #[tokio::test]
    async fn an_unpaid_request_to_a_free_route_still_reaches_the_app() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            answered(b"free work", Some(FULFILLMENT)),
        );
        let connector = Arc::new(Connector::new(
            vec![route],
            vec![],
            app_client.clone(),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let app = router(connector, test_signer());

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        Fulfill::decode(&bytes).expect("decode fulfill");
        assert_eq!(app_client.deliveries().len(), 1);
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
        pub(super) fn evm_claim_json(nonce: u64, transferred_amount: u64) -> String {
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

        #[tokio::test]
        async fn a_fresh_plaintext_claim_lets_the_packet_reach_the_app() {
            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(route.handler_url(), answered(b"ok", Some(FULFILLMENT)));
            let connector = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            let app = router(connector, test_signer());

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
            app_client.respond(route.handler_url(), answered(b"ok", Some(FULFILLMENT)));
            let connector = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            let app = router(connector, test_signer());

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
            app_client.respond(route.handler_url(), answered(b"ok", Some(FULFILLMENT)));
            let connector = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            let app = router(connector, test_signer());

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
            let app = router(connector, test_signer());

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
            app_client.respond(route.handler_url(), answered(b"ok", Some(FULFILLMENT)));
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

            let app = router_with_wrap_key(connector, test_signer(), Some(receiver_secret_bytes));
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
            let app = router(connector, test_signer());

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
            app_client.respond(route.handler_url(), answered(b"ok", Some(FULFILLMENT)));
            let connector = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            let app = router(connector, test_signer());

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
            app_client.respond(route.handler_url(), answered(b"ok", Some(FULFILLMENT)));
            let connector = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client.clone(),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            let app = router(connector, test_signer());

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
            let app = router(connector, test_signer());

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
            let app = router(connector, test_signer());

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
