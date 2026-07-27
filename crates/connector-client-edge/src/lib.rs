//! Client-edge router, mountable rather than a server. See ADR 0001, ADR
//! 0003, and `docs/protocol/client-edge-spec.md` -- this implements §1.1
//! (transport and framing: `POST /ilp`, OER-encoded PREPARE in, OER-encoded
//! FULFILL/REJECT out, always HTTP 200 for an ILP-level outcome) and §1.2
//! (identity: a configured peer authenticating with a bearer secret, or an
//! anonymous sender given an ephemeral, claim-derived identity -- issue
//! #502). Payment claims (§1.3) and the x402 greeting (§1.4) remain
//! unimplemented until claim validation lands (issue #504) -- a request
//! that authenticates (or is anonymous) is still treated as an unpriced
//! delivery attempt.
//!
//! Per ADR 0001, this handler deserializes, resolves identity, calls
//! exactly one method on [`Connector`], and serializes; the `match` below
//! is that serialization step, not a routing or delivery decision -- those
//! live entirely in [`Connector::handle_prepare`].

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;

use connector_domain::{resolve_identity, ConfiguredIdentity, PacketResponse, Prepare};
use connector_runtime::Connector;

const OCTET_STREAM: &str = "application/octet-stream";

const ILP_PEER_ID_HEADER: &str = "ilp-peer-id";
const ILP_CLAIM_HEADER: &str = "ilp-payment-channel-claim";

#[derive(Clone)]
struct AppState {
    connector: Arc<Connector>,
    /// The client-edge identities this node authenticates (issue #502,
    /// `docs/protocol/client-edge-spec.md` §1.2). Empty means every
    /// presented `ILP-Peer-Id` fails to authenticate -- a node that
    /// configures no identities accepts only anonymous senders.
    identities: Arc<[ConfiguredIdentity]>,
}

/// Mount the client edge at `connector`: `POST /ilp` per
/// `docs/protocol/client-edge-spec.md` §1.1-§1.2. `identities` is the set
/// of client-edge identities this node authenticates -- an empty slice is
/// a valid, anonymous-only configuration.
pub fn router(connector: Arc<Connector>, identities: Arc<[ConfiguredIdentity]>) -> Router {
    Router::new()
        .route("/ilp", post(handle_ilp))
        .with_state(AppState {
            connector,
            identities,
        })
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

/// Extract the bearer credential from `Authorization`, per
/// `docs/protocol/client-edge-spec.md` §1.2. An absent header, and a
/// present-but-empty bearer, are deliberately not distinguished --
/// [`connector_domain::resolve_identity`] treats both as an empty
/// credential (mirrors BTP's `secret: ''` auth frame).
fn extract_bearer(headers: &HeaderMap) -> String {
    let Some(value) = header_str(headers, header::AUTHORIZATION.as_str()) else {
        return String::new();
    };
    let trimmed = value.trim();
    match trimmed.split_once(char::is_whitespace) {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("bearer") => {
            rest.trim_start().to_string()
        }
        _ => trimmed.to_string(),
    }
}

/// Decode the `ILP-Payment-Channel-Claim` header's base64 payload, if
/// present. A present-but-undecodable header is treated as absent -- it
/// carries no more identity information than no header at all, and full
/// claim validation (which would reject it outright) is issue #504's
/// concern, not this one's.
fn decode_plaintext_claim(headers: &HeaderMap) -> Option<Vec<u8>> {
    let value = header_str(headers, ILP_CLAIM_HEADER)?;
    BASE64.decode(value).ok()
}

async fn handle_ilp(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let prepare = match Prepare::decode(&body) {
        Ok(prepare) => prepare,
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };

    let peer_id = header_str(&headers, ILP_PEER_ID_HEADER);
    let secret = extract_bearer(&headers);
    let plaintext_claim = decode_plaintext_claim(&headers);

    let sender = match resolve_identity(
        peer_id,
        &secret,
        plaintext_claim.as_deref(),
        &state.identities,
    ) {
        Ok(sender) => sender,
        Err(error) => {
            tracing::warn!(
                peer_id = %error.peer_id,
                "client edge request failed to authenticate"
            );
            return (StatusCode::UNAUTHORIZED, error.to_string()).into_response();
        }
    };

    // The resolved identity is not yet consumed by claim validation (issue
    // #504) or payer header injection (issue #505) -- both are blocked on
    // this resolution existing, not the other way round. Logging it here,
    // rather than discarding it, is what makes it "available to everything
    // downstream" in the interim: any request's payer is already visible
    // to structured-log consumers today, ahead of either ticket landing.
    tracing::info!(
        sender = %sender.id(),
        destination = %prepare.destination,
        "client edge request identified"
    );

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
    use connector_domain::{derive_condition, ConfiguredIdentity, Fulfill, Reject};
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
        let app = router(connector, Arc::new([]));

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
        let app = router(connector, Arc::new([]));

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
        let app = router(connector, Arc::new([]));

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(vec![0xff, 0xff, 0xff, 0xff]))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn a_configured_peer_presenting_its_identity_and_correct_secret_is_recognised() {
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
        let identities: Arc<[ConfiguredIdentity]> = Arc::new([ConfiguredIdentity {
            id: "buyer-a".to_string(),
            secret: "s3cr3t".to_string(),
        }]);
        let app = router(connector, identities);

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .header("ILP-Peer-Id", "buyer-a")
            .header("Authorization", "Bearer s3cr3t")
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let fulfill = Fulfill::decode(&bytes).expect("decode fulfill");
        assert_eq!(fulfill.data, b"app said yes");
    }

    #[tokio::test]
    async fn a_configured_identity_permitting_an_empty_secret_is_accepted_with_the_credential_absent(
    ) {
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
        let identities: Arc<[ConfiguredIdentity]> = Arc::new([ConfiguredIdentity {
            id: "buyer-a".to_string(),
            secret: String::new(),
        }]);
        let app = router(connector, identities);

        // ILP-Peer-Id present, no Authorization header at all.
        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .header("ILP-Peer-Id", "buyer-a")
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        Fulfill::decode(&bytes).expect("decode fulfill");
    }

    #[tokio::test]
    async fn a_presented_identity_that_fails_to_authenticate_is_refused_as_unauthorized() {
        let app_client = Arc::new(FakeAppClient::new());
        let connector = Arc::new(Connector::new(
            vec![],
            vec![],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let identities: Arc<[ConfiguredIdentity]> = Arc::new([ConfiguredIdentity {
            id: "buyer-a".to_string(),
            secret: "s3cr3t".to_string(),
        }]);
        let app = router(connector, identities);

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .header("ILP-Peer-Id", "buyer-a")
            .header("Authorization", "Bearer wrong-secret")
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn an_identity_naming_no_configured_peer_is_refused_as_unauthorized_not_anonymous() {
        let app_client = Arc::new(FakeAppClient::new());
        let connector = Arc::new(Connector::new(
            vec![],
            vec![],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let app = router(connector, Arc::new([]));

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .header("ILP-Peer-Id", "nobody-configured-this-id")
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    /// A request with no `ILP-Peer-Id` at all is anonymous and proceeds
    /// unauthenticated -- even when this node has configured identities,
    /// since anonymity is a distinct, first-class path rather than what
    /// happens when authentication is skipped.
    #[tokio::test]
    async fn a_request_with_no_identity_header_is_anonymous_and_still_succeeds() {
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
        let identities: Arc<[ConfiguredIdentity]> = Arc::new([ConfiguredIdentity {
            id: "buyer-a".to_string(),
            secret: "s3cr3t".to_string(),
        }]);
        let app = router(connector, identities);

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        Fulfill::decode(&bytes).expect("decode fulfill");
    }

    /// A request carrying only a wrapped claim (no `ILP-Peer-Id`, no
    /// plaintext `ILP-Payment-Channel-Claim`) is anonymous like any other
    /// unidentified request -- resolving it never attempts to unwrap the
    /// claim, per client-edge-spec.md §1.2.
    #[tokio::test]
    async fn a_request_with_only_a_wrapped_claim_is_anonymous_and_still_succeeds() {
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
        let app = router(connector, Arc::new([]));

        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .header(
                "ILP-Payment-Channel-Claim-Wrapped",
                "not-a-real-nip59-envelope",
            )
            .body(Body::from(sample_prepare("g.example.app").encode()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        Fulfill::decode(&bytes).expect("decode fulfill");
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
        let app = router(connector, Arc::new([]));

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
        let app = router(first_hop, Arc::new([]));

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
        let app = router(first_hop, Arc::new([]));

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
        let app = router(first_hop, Arc::new([]));

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
        let app = router(first_hop, Arc::new([]));

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
}
