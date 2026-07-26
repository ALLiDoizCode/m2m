//! Operator router, mountable rather than a server. See ADR 0001, ADR 0008.
//!
//! ADR 0008 splits the operator surface into a read half and a write
//! half. The read half (issue #420) is `GET` endpoints -- peers, routes,
//! channels, claims, exposure, node identity, this crate's own write
//! audit log, and the metrics surface (`GET /metrics`, ADR 0014) -- gated
//! by a bearer token and nothing else.
//!
//! This crate also carries the write half's authentication mechanism
//! (issue #421): [`rfc9421`] verifies an RFC 9421 signature from a key on
//! an operator write allowlist, with the body bound by RFC 9530
//! Content-Digest, and [`write_auth::WriteAuth`] adds replay rejection and
//! retains every accepted signature as its write's audit record (ADR
//! 0012), exposed for inspection at `GET /audit-log`.
//!
//! `POST /packets` -- originating a packet outward -- and
//! `POST /routes/leased` -- creating or renewing a leased route (issue
//! #427; channel lifecycle, ADR 0008's third write, is issue #422 and
//! doesn't land here) -- are this crate's write endpoints. Both call
//! [`write_auth::authenticate_write`] first and nothing else in this
//! crate accepts a body, so a write cannot reach [`Connector`] without a
//! valid, allowlisted, unexpired, non-replayed signature. Bearer tokens
//! gate reads and reads only; no shared secret is ever sufficient to move
//! value.
//!
//! Per ADR 0001, each read handler below deserializes nothing beyond the
//! bearer token (a GET request has no body) and calls exactly one
//! [`Connector`] method. Every read serializes its result as JSON except
//! `GET /metrics`, which is Prometheus text exposition format (ADR 0014)
//! -- the one format Prometheus itself can scrape.

mod rfc9421;
mod write_auth;

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, Method, Request, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use connector_domain::{PacketResponse, Prepare};
use connector_runtime::{
    ChannelView, ClaimView, Connector, ExposureView, LeaseRouteError, LeasedRouteView, PeerView,
    RouteView,
};
use connector_signer::{derive_evm_address, to_hex, Signer, SignerError};
use write_auth::{authenticate_write, AuditRecord, WriteAuth};

const OCTET_STREAM: &str = "application/octet-stream";

/// This node's own identity: the active signing key and the address
/// derived from it (ADR 0012's signer, read rather than exercised).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeIdentity {
    pub key_id: String,
    pub address: String,
}

#[derive(Clone)]
struct OperatorState {
    connector: Arc<Connector>,
    signer: Arc<dyn Signer>,
    bearer_token: Arc<str>,
    write_auth: Arc<WriteAuth>,
}

/// Mount the operator surface's read-only half at `connector`: `GET`
/// endpoints for peers, routes, channels, claims, exposure, node identity
/// and the write audit log, each requiring the bearer token
/// `bearer_token` and nothing more (ADR 0008). `write_keys` is the
/// allowlist of ed25519 public keys permitted to sign a write once a
/// write endpoint lands (issue #421); removing a key from this list and
/// restarting revokes it, with no other change.
pub fn router(
    connector: Arc<Connector>,
    signer: Arc<dyn Signer>,
    bearer_token: impl Into<String>,
    write_keys: Vec<[u8; 32]>,
) -> Router {
    let state = OperatorState {
        connector,
        signer,
        bearer_token: Arc::from(bearer_token.into()),
        write_auth: Arc::new(WriteAuth::new(write_keys)),
    };

    // Reads: gated by the bearer token and nothing else. Writes: gated by
    // an RFC 9421 signature and nothing else (ADR 0008) -- `route_layer`
    // only wraps the routes already added to `reads` when it is called,
    // so `writes`, merged in afterward, is never behind the bearer token.
    let reads = Router::new()
        .route("/peers", get(peers))
        .route("/routes", get(routes))
        .route("/routes/leased", get(leased_routes))
        .route("/channels", get(channels))
        .route("/claims", get(claims))
        .route("/exposure", get(exposure))
        .route("/identity", get(identity))
        .route("/audit-log", get(audit_log))
        .route("/metrics", get(metrics))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_bearer_token,
        ));

    let writes = Router::new()
        .route("/packets", post(originate_packet))
        .route("/routes/leased", post(create_leased_route));

    reads.merge(writes).with_state(state)
}

async fn require_bearer_token<B>(
    State(state): State<OperatorState>,
    request: Request<B>,
    next: Next<B>,
) -> Response {
    let presented = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));

    match presented {
        Some(token) if token == state.bearer_token.as_ref() => next.run(request).await,
        _ => StatusCode::UNAUTHORIZED.into_response(),
    }
}

async fn peers(State(state): State<OperatorState>) -> Json<Vec<PeerView>> {
    Json(state.connector.peers())
}

async fn routes(State(state): State<OperatorState>) -> Json<Vec<RouteView>> {
    Json(state.connector.routes())
}

/// `GET /routes/leased`: every leased route (issue #427) not yet lapsed as
/// of this node's own clock -- the read side of the same table
/// `POST /routes/leased` writes to.
async fn leased_routes(State(state): State<OperatorState>) -> Json<Vec<LeasedRouteView>> {
    Json(state.connector.leased_routes())
}

async fn channels(State(state): State<OperatorState>) -> Json<Vec<ChannelView>> {
    Json(state.connector.channels())
}

async fn claims(State(state): State<OperatorState>) -> Json<Vec<ClaimView>> {
    Json(state.connector.claims())
}

async fn exposure(State(state): State<OperatorState>) -> Json<Vec<ExposureView>> {
    Json(state.connector.exposure())
}

async fn audit_log(State(state): State<OperatorState>) -> Json<Vec<AuditRecord>> {
    Json(state.write_auth.audit_log())
}

/// `GET /metrics`: the decided metrics surface (ADR 0014) -- packets,
/// rejects, fees, exposure and settlement -- in Prometheus text exposition
/// format. A read like any other on this surface: gated by the bearer
/// token and nothing else, per ADR 0008.
async fn metrics(State(state): State<OperatorState>) -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        state.connector.metrics().encode(),
    )
        .into_response()
}

/// `POST /packets`: an operator originates a packet outward, exactly as
/// the client edge does for an external caller -- decode a [`Prepare`],
/// call [`Connector::handle_prepare`] once, encode the outcome. The one
/// difference is what happens first: [`authenticate_write`] must accept
/// the request's RFC 9421 signature before any of that runs.
async fn originate_packet(
    State(state): State<OperatorState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = authenticate_write(
        &state.write_auth,
        method.as_str(),
        uri.path(),
        &headers,
        &body,
    ) {
        return (StatusCode::UNAUTHORIZED, error.to_string()).into_response();
    }

    let prepare = match Prepare::decode(&body) {
        Ok(prepare) => prepare,
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };

    // The operator is the original sender of a packet it originates
    // (ADR 0010) -- unlike the client edge, which has no wire field yet
    // to carry a sender-declared minimum (client-edge-spec.md v1) and so
    // passes 0, the operator already holds the full `Prepare` including
    // its declared `amount`. The only minimum that is actually "declared"
    // here, rather than an arbitrary placeholder, is that amount itself:
    // this hop authorized exactly `amount` to reach the destination, so
    // no further hop's fee may discount it below that.
    let minimum_delivery = prepare.amount;

    let encoded = match state
        .connector
        .handle_prepare(prepare, minimum_delivery)
        .await
    {
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

/// A `POST /routes/leased` request body: create or renew a leased route
/// (ADR 0006, issue #427) forwarding `prefix` to peer `peer_id`, charging
/// `fee` per packet, for `ttl_seconds` from this node's own clock. Posting
/// the same `prefix` again before it lapses renews it to a fresh
/// `ttl_seconds` from whenever the renewal is received -- that is the only
/// way a leased route stays alive, since nothing in the runtime extends
/// one on its own.
#[derive(Debug, Deserialize)]
struct CreateLeasedRouteRequest {
    prefix: String,
    peer_id: String,
    fee: u64,
    ttl_seconds: i64,
}

/// `POST /routes/leased`: a controller outside this connector pushes a
/// route to a peer with a time limit. Authenticated exactly like
/// `POST /packets` -- [`authenticate_write`] first, nothing else in this
/// handler accepts the request until that succeeds.
async fn create_leased_route(
    State(state): State<OperatorState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = authenticate_write(
        &state.write_auth,
        method.as_str(),
        uri.path(),
        &headers,
        &body,
    ) {
        return (StatusCode::UNAUTHORIZED, error.to_string()).into_response();
    }

    let request: CreateLeasedRouteRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };

    match state.connector.upsert_leased_route(
        request.prefix,
        request.peer_id,
        request.fee,
        chrono::Duration::seconds(request.ttl_seconds),
    ) {
        Ok(view) => Json(view).into_response(),
        Err(LeaseRouteError::InvalidPrefix(prefix)) => (
            StatusCode::BAD_REQUEST,
            format!("invalid ILP address: '{prefix}'"),
        )
            .into_response(),
    }
}

async fn identity(State(state): State<OperatorState>) -> Response {
    match node_identity(state.signer.as_ref()) {
        Ok(identity) => Json(identity).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}

fn node_identity(signer: &dyn Signer) -> Result<NodeIdentity, SignerError> {
    let public_key = signer.public_key()?;
    Ok(NodeIdentity {
        key_id: signer.key_id(),
        address: to_hex(&derive_evm_address(&public_key)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use connector_config::StaticRoute;
    use connector_runtime::{FakeAppClient, InProcessPeerTransport, TestClock};
    use connector_signer::LocalSigner;
    use tower::ServiceExt;

    fn test_router(routes: Vec<StaticRoute>, bearer_token: &str) -> Router {
        let app_client = Arc::new(FakeAppClient::new());
        let clock = Arc::new(TestClock::new(
            chrono::Utc::now(), // only used to satisfy the Connector constructor; unread here
        ));
        let connector = Arc::new(Connector::new(
            routes,
            vec![],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            clock,
        ));
        let signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("operator-test-key"));
        router(connector, signer, bearer_token.to_string(), vec![])
    }

    async fn get(app: Router, path: &str, bearer_token: Option<&str>) -> Response {
        let mut builder = Request::builder().method("GET").uri(path);
        if let Some(token) = bearer_token {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let request = builder.body(Body::empty()).unwrap();
        app.oneshot(request).await.unwrap()
    }

    #[tokio::test]
    async fn a_request_with_no_bearer_token_is_rejected() {
        let app = test_router(vec![], "correct-token");
        let response = get(app, "/routes", None).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_request_with_the_wrong_bearer_token_is_rejected() {
        let app = test_router(vec![], "correct-token");
        let response = get(app, "/routes", Some("wrong-token")).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn routes_reports_the_connectors_configured_static_routes() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app = test_router(vec![route], "correct-token");

        let response = get(app, "/routes", Some("correct-token")).await;
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let routes: Vec<RouteView> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].prefix, "g.example.app");
        assert_eq!(routes[0].handler_url, "http://localhost:4000/");
    }

    #[tokio::test]
    async fn peers_channels_claims_exposure_and_audit_log_read_as_empty_lists() {
        let app = test_router(vec![], "correct-token");

        for path in ["/peers", "/channels", "/claims", "/exposure", "/audit-log"] {
            let response = get(app.clone(), path, Some("correct-token")).await;
            assert_eq!(response.status(), StatusCode::OK, "path {path}");
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(body, serde_json::json!([]), "path {path}");
        }
    }

    #[tokio::test]
    async fn metrics_reports_prometheus_text_and_requires_the_bearer_token() {
        let app = test_router(vec![], "correct-token");

        let unauthenticated = get(app.clone(), "/metrics", None).await;
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

        let response = get(app, "/metrics", Some("correct-token")).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let body = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(body.contains("toon_fees_earned_total"));
    }

    #[tokio::test]
    async fn identity_reports_the_signers_key_id_and_derived_address() {
        let app_client = Arc::new(FakeAppClient::new());
        let clock = Arc::new(TestClock::new(chrono::Utc::now()));
        let connector = Arc::new(Connector::new(
            vec![],
            vec![],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            clock,
        ));
        let signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("operator-test-key"));
        let expected = node_identity(signer.as_ref()).unwrap();
        let app = router(connector, signer, "correct-token".to_string(), vec![]);

        let response = get(app, "/identity", Some("correct-token")).await;
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let identity: NodeIdentity = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(identity, expected);
    }

    #[tokio::test]
    async fn there_is_no_write_endpoint_to_change_state_through() {
        let app = test_router(vec![], "correct-token");

        let request = Request::builder()
            .method("POST")
            .uri("/routes")
            .header(header::AUTHORIZATION, "Bearer correct-token")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    /// The write-authentication mechanism (issue #421), exercised end to
    /// end over real HTTP against the actual production `router()` and
    /// its one write endpoint, `POST /packets`. Every AC is driven as an
    /// external caller, matching #420's precedent: no port bound, no
    /// privileged in-process access, just requests through
    /// `tower::ServiceExt::oneshot`.
    mod write_authentication {
        use super::*;
        use crate::rfc9421::{keyid_hex, sign_request};
        use connector_domain::{derive_condition, RejectCode};
        use ed25519_dalek::Keypair;
        use rand::rngs::OsRng;

        // An arbitrary preimage, used only to derive a well-formed,
        // non-all-zero execution condition -- `reject_ineligible` (issue
        // #417) rejects an all-zero condition before routing is ever
        // reached, so these tests need a real one to exercise routing at
        // all.
        const FULFILLMENT: [u8; 32] = [7u8; 32];

        fn keypair() -> Keypair {
            Keypair::generate(&mut OsRng)
        }

        fn sample_prepare() -> Prepare {
            Prepare {
                amount: 0,
                expires_at: chrono::Utc::now() + chrono::Duration::minutes(1),
                execution_condition: derive_condition(&FULFILLMENT),
                destination: "g.example.nowhere".to_string(),
                data: b"originated by the operator".to_vec(),
            }
        }

        /// Sign an OER-encoded write body bound for `/packets`, returning
        /// the three headers a caller presents.
        fn sign(keypair: &Keypair, body: &[u8], expires: u64) -> (String, String, String) {
            sign_request(keypair, "POST", "/packets", body, 1_000, Some(expires))
        }

        fn packets_request(
            body: Vec<u8>,
            signature_input: Option<&str>,
            signature: Option<&str>,
            content_digest: Option<&str>,
            bearer_token: Option<&str>,
        ) -> Request<Body> {
            let mut builder = Request::builder().method("POST").uri("/packets");
            if let Some(v) = signature_input {
                builder = builder.header("signature-input", v);
            }
            if let Some(v) = signature {
                builder = builder.header("signature", v);
            }
            if let Some(v) = content_digest {
                builder = builder.header("content-digest", v);
            }
            if let Some(token) = bearer_token {
                builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
            }
            builder.body(Body::from(body)).unwrap()
        }

        fn router_with_write_keys(write_keys: Vec<[u8; 32]>) -> Router {
            let app_client = Arc::new(FakeAppClient::new());
            let clock = Arc::new(TestClock::new(chrono::Utc::now()));
            let connector = Arc::new(Connector::new(
                vec![],
                vec![],
                app_client,
                Arc::new(InProcessPeerTransport::new()),
                clock,
            ));
            let signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("operator-test-key"));
            router(connector, signer, "correct-token".to_string(), write_keys)
        }

        #[tokio::test]
        async fn a_write_with_no_signature_at_all_is_rejected() {
            let app = router_with_write_keys(vec![]);
            let body = sample_prepare().encode();

            let response = app
                .oneshot(packets_request(body, None, None, None, None))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        #[tokio::test]
        async fn a_bearer_token_alone_does_not_authorize_a_write() {
            // Bearer tokens gate reads; they must never substitute for a
            // write's signature (ADR 0008).
            let app = router_with_write_keys(vec![]);
            let body = sample_prepare().encode();

            let response = app
                .oneshot(packets_request(
                    body,
                    None,
                    None,
                    None,
                    Some("correct-token"),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        #[tokio::test]
        async fn a_validly_signed_write_from_an_allowlisted_key_originates_the_packet() {
            let keypair = keypair();
            let app = router_with_write_keys(vec![keypair.public.to_bytes()]);
            let body = sample_prepare().encode();
            let (sig_input, sig, digest) = sign(&keypair, &body, 9_999_999_999);

            let response = app
                .oneshot(packets_request(
                    body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                    None,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            // No route matches -- the packet was genuinely originated
            // into the connector's packet plane, not short-circuited.
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let reject = connector_domain::Reject::decode(&bytes).expect("decode reject");
            assert_eq!(reject.code, RejectCode::f02_unreachable());
        }

        #[tokio::test]
        async fn a_signature_from_a_key_not_on_the_allowlist_is_rejected() {
            let signer = keypair();
            let app = router_with_write_keys(vec![]); // signer's key is not allowlisted
            let body = sample_prepare().encode();
            let (sig_input, sig, digest) = sign(&signer, &body, 9_999_999_999);

            let response = app
                .oneshot(packets_request(
                    body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                    None,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        #[tokio::test]
        async fn removing_a_key_from_the_allowlist_revokes_it_with_no_other_change() {
            let keypair = keypair();
            let body = sample_prepare().encode();
            let (sig_input, sig, digest) = sign(&keypair, &body, 9_999_999_999);

            let allowed = router_with_write_keys(vec![keypair.public.to_bytes()]);
            let response = allowed
                .oneshot(packets_request(
                    body.clone(),
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                    None,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            // Identical request, identical signature -- only the
            // configured allowlist changed.
            let revoked = router_with_write_keys(vec![]);
            let response = revoked
                .oneshot(packets_request(
                    body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                    None,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        #[tokio::test]
        async fn an_expired_signature_is_rejected() {
            let keypair = keypair();
            let app = router_with_write_keys(vec![keypair.public.to_bytes()]);
            let body = sample_prepare().encode();
            // Already expired relative to any wall-clock "now".
            let (sig_input, sig, digest) = sign(&keypair, &body, 1);

            let response = app
                .oneshot(packets_request(
                    body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                    None,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        #[tokio::test]
        async fn a_replayed_signature_is_rejected_the_second_time() {
            let keypair = keypair();
            let app = router_with_write_keys(vec![keypair.public.to_bytes()]);
            let body = sample_prepare().encode();
            let (sig_input, sig, digest) = sign(&keypair, &body, 9_999_999_999);

            let first = app
                .clone()
                .oneshot(packets_request(
                    body.clone(),
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                    None,
                ))
                .await
                .unwrap();
            assert_eq!(first.status(), StatusCode::OK);

            let replay = app
                .oneshot(packets_request(
                    body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                    None,
                ))
                .await
                .unwrap();
            assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
        }

        #[tokio::test]
        async fn a_captured_request_cannot_be_replayed_with_altered_contents() {
            let keypair = keypair();
            let app = router_with_write_keys(vec![keypair.public.to_bytes()]);
            let original = sample_prepare().encode();
            let (sig_input, sig, digest) = sign(&keypair, &original, 9_999_999_999);

            let mut tampered_prepare = sample_prepare();
            tampered_prepare.destination = "g.attacker.somewhere.else".to_string();
            let tampered = tampered_prepare.encode();

            let response = app
                .oneshot(packets_request(
                    tampered,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                    None,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        #[tokio::test]
        async fn every_accepted_write_is_retained_in_the_audit_log_and_read_back_over_the_operator_surface(
        ) {
            let keypair = keypair();
            let app = router_with_write_keys(vec![keypair.public.to_bytes()]);
            let body = sample_prepare().encode();
            let (sig_input, sig, digest) = sign(&keypair, &body, 9_999_999_999);

            let write_response = app
                .clone()
                .oneshot(packets_request(
                    body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                    None,
                ))
                .await
                .unwrap();
            assert_eq!(write_response.status(), StatusCode::OK);

            let audit_response = get(app, "/audit-log", Some("correct-token")).await;
            assert_eq!(audit_response.status(), StatusCode::OK);

            let bytes = hyper::body::to_bytes(audit_response.into_body())
                .await
                .unwrap();
            let log: Vec<serde_json::Value> = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(log.len(), 1);
            assert_eq!(log[0]["keyid"], keyid_hex(&keypair));
            assert_eq!(log[0]["path"], "/packets");
        }

        #[tokio::test]
        async fn a_read_route_still_requires_the_bearer_token_and_not_a_write_signature() {
            let app = router_with_write_keys(vec![]);
            let response = get(app, "/routes", None).await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        /// The minimum delivery an originated packet carries must be the
        /// packet's own declared `amount` (ADR 0010), not a placeholder
        /// zero -- otherwise a peer's fee could silently discount a
        /// payment the operator itself authorized in full. Routing this
        /// packet to a fee-charging peer must reject (R01) rather than
        /// forward a smaller amount than declared.
        #[tokio::test]
        async fn an_originated_packet_declares_its_own_amount_as_the_minimum_delivery() {
            use connector_runtime::PeerRoute;

            let keypair = keypair();
            let app_client = Arc::new(FakeAppClient::new());
            let clock = Arc::new(TestClock::new(chrono::Utc::now()));
            let connector = Arc::new(Connector::new(
                vec![],
                vec![PeerRoute::new("g.example", "peer-1", 5)],
                app_client,
                Arc::new(InProcessPeerTransport::new()),
                clock,
            ));
            let signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("operator-test-key"));
            let app = router(
                connector,
                signer,
                "correct-token".to_string(),
                vec![keypair.public.to_bytes()],
            );

            let mut prepare = sample_prepare();
            prepare.amount = 100;
            let body = prepare.encode();
            let (sig_input, sig, digest) = sign(&keypair, &body, 9_999_999_999);

            let response = app
                .oneshot(packets_request(
                    body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                    None,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let reject = connector_domain::Reject::decode(&bytes).expect("decode reject");
            assert_eq!(reject.code, RejectCode::r01_insufficient_source_amount());
        }
    }

    /// `POST /routes/leased` (issue #427): a controller outside this
    /// connector pushes a route to a peer with a time limit, driven end to
    /// end over real HTTP exactly like `POST /packets`'s write-auth suite
    /// above -- no signature, no write.
    mod leased_route_writes {
        use super::*;
        use crate::rfc9421::sign_request;
        use chrono::TimeZone;
        use ed25519_dalek::Keypair;
        use rand::rngs::OsRng;

        fn keypair() -> Keypair {
            Keypair::generate(&mut OsRng)
        }

        fn sign(keypair: &Keypair, body: &[u8], expires: u64) -> (String, String, String) {
            sign_request(
                keypair,
                "POST",
                "/routes/leased",
                body,
                1_000,
                Some(expires),
            )
        }

        fn leased_route_request(
            body: Vec<u8>,
            signature_input: Option<&str>,
            signature: Option<&str>,
            content_digest: Option<&str>,
        ) -> Request<Body> {
            let mut builder = Request::builder().method("POST").uri("/routes/leased");
            if let Some(v) = signature_input {
                builder = builder.header("signature-input", v);
            }
            if let Some(v) = signature {
                builder = builder.header("signature", v);
            }
            if let Some(v) = content_digest {
                builder = builder.header("content-digest", v);
            }
            builder.body(Body::from(body)).unwrap()
        }

        fn router_with(clock: Arc<TestClock>, write_keys: Vec<[u8; 32]>) -> Router {
            let app_client = Arc::new(FakeAppClient::new());
            let connector = Arc::new(Connector::new(
                vec![],
                vec![],
                app_client,
                Arc::new(InProcessPeerTransport::new()),
                clock,
            ));
            let signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("operator-test-key"));
            router(connector, signer, "correct-token".to_string(), write_keys)
        }

        #[tokio::test]
        async fn creating_a_leased_route_requires_a_valid_write_signature() {
            let clock = Arc::new(TestClock::new(chrono::Utc::now()));
            let app = router_with(clock, vec![]);
            let body = serde_json::to_vec(&serde_json::json!({
                "prefix": "g.example.leased",
                "peer_id": "peer-1",
                "fee": 0,
                "ttl_seconds": 60,
            }))
            .unwrap();

            let response = app
                .oneshot(leased_route_request(body, None, None, None))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        #[tokio::test]
        async fn a_validly_signed_write_creates_a_leased_route_visible_over_the_read_surface() {
            let start = chrono::Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();
            let clock = Arc::new(TestClock::new(start));
            let keypair = keypair();
            let app = router_with(clock, vec![keypair.public.to_bytes()]);
            let body = serde_json::to_vec(&serde_json::json!({
                "prefix": "g.example.leased",
                "peer_id": "peer-1",
                "fee": 3,
                "ttl_seconds": 60,
            }))
            .unwrap();
            let (sig_input, sig, digest) = sign(&keypair, &body, 9_999_999_999);

            let write_response = app
                .clone()
                .oneshot(leased_route_request(
                    body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                ))
                .await
                .unwrap();
            assert_eq!(write_response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(write_response.into_body())
                .await
                .unwrap();
            let created: LeasedRouteView = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(created.prefix, "g.example.leased");
            assert_eq!(created.peer_id, "peer-1");
            assert_eq!(created.fee, 3);
            assert_eq!(created.expires_at, start + chrono::Duration::seconds(60));

            let read_response = get(app, "/routes/leased", Some("correct-token")).await;
            assert_eq!(read_response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(read_response.into_body())
                .await
                .unwrap();
            let leases: Vec<LeasedRouteView> = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(leases, vec![created]);
        }

        #[tokio::test]
        async fn renewing_a_leased_route_extends_its_expiry_from_the_renewal_time() {
            let start = chrono::Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();
            let clock = Arc::new(TestClock::new(start));
            let keypair = keypair();
            let app = router_with(clock.clone(), vec![keypair.public.to_bytes()]);
            let body = serde_json::to_vec(&serde_json::json!({
                "prefix": "g.example.leased",
                "peer_id": "peer-1",
                "fee": 0,
                "ttl_seconds": 60,
            }))
            .unwrap();
            let (sig_input, sig, digest) = sign(&keypair, &body, 9_999_999_999);
            let response = app
                .clone()
                .oneshot(leased_route_request(
                    body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            clock.advance(chrono::Duration::seconds(30));
            // A different `ttl_seconds` than the original request, both to
            // avoid signing an identical body (which the replay cache
            // would reject) and to prove the renewed expiry is computed
            // from *this* request's ttl, not the original's.
            let renewal_body = serde_json::to_vec(&serde_json::json!({
                "prefix": "g.example.leased",
                "peer_id": "peer-1",
                "fee": 0,
                "ttl_seconds": 90,
            }))
            .unwrap();
            let (sig_input, sig, digest) = sign(&keypair, &renewal_body, 9_999_999_999);
            let response = app
                .oneshot(leased_route_request(
                    renewal_body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let renewed: LeasedRouteView = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                renewed.expires_at,
                start + chrono::Duration::seconds(30) + chrono::Duration::seconds(90)
            );
        }

        #[tokio::test]
        async fn an_invalid_prefix_is_rejected_with_bad_request() {
            let clock = Arc::new(TestClock::new(chrono::Utc::now()));
            let keypair = keypair();
            let app = router_with(clock, vec![keypair.public.to_bytes()]);
            let body = serde_json::to_vec(&serde_json::json!({
                "prefix": "g..leased",
                "peer_id": "peer-1",
                "fee": 0,
                "ttl_seconds": 60,
            }))
            .unwrap();
            let (sig_input, sig, digest) = sign(&keypair, &body, 9_999_999_999);

            let response = app
                .oneshot(leased_route_request(
                    body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }

        /// AC: "A route can be created over the operator surface with a
        /// time limit" -- proven end to end by creating one, then routing
        /// a packet that only matches it. `peer-1` is unregistered on this
        /// test's `InProcessPeerTransport`, so a successful *match*
        /// surfaces as T01 (peer unreachable) rather than F02 (no route)
        /// -- exactly the distinction issue #427's connector-level tests
        /// use to prove selection without standing up a second connector.
        #[tokio::test]
        async fn a_leased_route_created_over_the_operator_surface_is_used_for_routing() {
            use connector_domain::{derive_condition, RejectCode};

            let clock = Arc::new(TestClock::new(chrono::Utc::now()));
            let keypair = keypair();
            let app = router_with(clock, vec![keypair.public.to_bytes()]);
            let route_body = serde_json::to_vec(&serde_json::json!({
                "prefix": "g.example.leased",
                "peer_id": "peer-1",
                "fee": 0,
                "ttl_seconds": 60,
            }))
            .unwrap();
            let (sig_input, sig, digest) = sign(&keypair, &route_body, 9_999_999_999);
            let response = app
                .clone()
                .oneshot(leased_route_request(
                    route_body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            let prepare = Prepare {
                amount: 0,
                expires_at: chrono::Utc::now() + chrono::Duration::minutes(1),
                execution_condition: derive_condition(&[7u8; 32]),
                destination: "g.example.leased".to_string(),
                data: b"routed over a freshly created lease".to_vec(),
            };
            let packet_body = prepare.encode();
            let (sig_input, sig, digest) = sign_request(
                &keypair,
                "POST",
                "/packets",
                &packet_body,
                1_000,
                Some(9_999_999_999),
            );
            let mut packet_request = Request::builder().method("POST").uri("/packets");
            packet_request = packet_request
                .header("signature-input", &sig_input)
                .header("signature", &sig)
                .header("content-digest", &digest);
            let response = app
                .oneshot(packet_request.body(Body::from(packet_body)).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let reject = connector_domain::Reject::decode(&bytes).expect("decode reject");
            assert_eq!(reject.code, RejectCode::t01_peer_unreachable());
        }
    }
}
