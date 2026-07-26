//! Operator router, mountable rather than a server. See ADR 0001, ADR 0008.
//!
//! This is the read-only half of the operator surface (issue #420) --
//! peers, routes, channels, claims, exposure and node identity, each behind
//! a bearer token and nothing else. ADR 0008's signed-write half (route
//! CRUD, channel lifecycle) is issue #421 and lives elsewhere; there is no
//! write path in this crate, so a holder of the bearer token cannot change
//! any state through it.
//!
//! Per ADR 0001, each handler below deserializes nothing beyond the bearer
//! token (a GET request has no body), calls exactly one [`Connector`]
//! method, and serializes the result as JSON.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use connector_runtime::{ChannelView, ClaimView, Connector, ExposureView, PeerView, RouteView};
use connector_signer::{derive_evm_address, to_hex, Signer, SignerError};

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
}

/// Mount the operator surface's read-only half at `connector`: `GET`
/// endpoints for peers, routes, channels, claims, exposure and node
/// identity, each requiring the bearer token `bearer_token` and nothing
/// more (ADR 0008).
pub fn router(
    connector: Arc<Connector>,
    signer: Arc<dyn Signer>,
    bearer_token: impl Into<String>,
) -> Router {
    let state = OperatorState {
        connector,
        signer,
        bearer_token: Arc::from(bearer_token.into()),
    };

    Router::new()
        .route("/peers", get(peers))
        .route("/routes", get(routes))
        .route("/channels", get(channels))
        .route("/claims", get(claims))
        .route("/exposure", get(exposure))
        .route("/identity", get(identity))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_bearer_token,
        ))
        .with_state(state)
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

async fn channels(State(state): State<OperatorState>) -> Json<Vec<ChannelView>> {
    Json(state.connector.channels())
}

async fn claims(State(state): State<OperatorState>) -> Json<Vec<ClaimView>> {
    Json(state.connector.claims())
}

async fn exposure(State(state): State<OperatorState>) -> Json<Vec<ExposureView>> {
    Json(state.connector.exposure())
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
        router(connector, signer, bearer_token.to_string())
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
    async fn peers_channels_claims_and_exposure_read_as_empty_lists() {
        let app = test_router(vec![], "correct-token");

        for path in ["/peers", "/channels", "/claims", "/exposure"] {
            let response = get(app.clone(), path, Some("correct-token")).await;
            assert_eq!(response.status(), StatusCode::OK, "path {path}");
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(body, serde_json::json!([]), "path {path}");
        }
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
        let app = router(connector, signer, "correct-token".to_string());

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
}
