//! Client-edge router, mountable rather than a server. See ADR 0001, ADR
//! 0003, and `docs/protocol/client-edge-spec.md` -- this implements §1.1
//! (transport and framing: `POST /ilp`, OER-encoded PREPARE in, OER-encoded
//! FULFILL/REJECT out, always HTTP 200 for an ILP-level outcome). Identity
//! (§1.2), payment claims (§1.3) and the x402 greeting (§1.4) are
//! unimplemented until claim validation lands (issue #423) -- every request
//! today is treated as an unauthenticated, unpriced delivery attempt.
//!
//! Per ADR 0001, this handler deserializes, calls exactly one method on
//! [`Connector`], and serializes; the `match` below is that serialization
//! step, not a routing or delivery decision -- those live entirely in
//! [`Connector::handle_prepare`].

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;

use connector_domain::{PacketResponse, Prepare};
use connector_runtime::Connector;

const OCTET_STREAM: &str = "application/octet-stream";

/// Mount the client edge at `connector`: `POST /ilp` per
/// `docs/protocol/client-edge-spec.md` §1.1.
pub fn router(connector: Arc<Connector>) -> Router {
    Router::new()
        .route("/ilp", post(handle_ilp))
        .with_state(connector)
}

async fn handle_ilp(State(connector): State<Arc<Connector>>, body: Bytes) -> Response {
    let prepare = match Prepare::decode(&body) {
        Ok(prepare) => prepare,
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };

    let encoded = match connector.handle_prepare(prepare).await {
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
    use connector_domain::{Fulfill, Reject};
    use connector_runtime::{AppOutcome, FakeAppClient, TestClock};
    use tower::ServiceExt;

    fn sample_prepare(destination: &str) -> Prepare {
        Prepare {
            amount: 0,
            expires_at: Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
            execution_condition: [0u8; 32],
            destination: destination.to_string(),
            data: b"hello app".to_vec(),
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
            },
        );
        let connector = Arc::new(Connector::new(vec![route], app_client, test_clock()));
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
        let connector = Arc::new(Connector::new(vec![], app_client, test_clock()));
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
        let connector = Arc::new(Connector::new(vec![], app_client, test_clock()));
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
        let connector = Arc::new(Connector::new(vec![route], app_client, test_clock()));
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
}
