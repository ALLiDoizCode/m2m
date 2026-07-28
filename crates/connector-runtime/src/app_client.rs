//! The port between this connector and the app behind a terminated route
//! (issue #521). The app is payment-oblivious: it is handed the request an
//! envelope describes over plain HTTP and returns its answer, knowing
//! nothing about packets, channels or claims. Per ADR 0020, an HTTP status
//! is envelope content, never a packet outcome -- so this port reports
//! either a complete answer (whatever its status) or the absence of one. It
//! never sees a [`connector_domain::Prepare`], a key or a claim: the
//! envelope is decoded above this boundary (`Connector::deliver_to_app`),
//! and this is a thin adapter that makes the request it is given and
//! reports what came back.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use url::Url;

use connector_domain::{EnvelopeRequest, EnvelopeResponse};

/// What delivering an [`EnvelopeRequest`] to an app produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppOutcome {
    /// The app answered -- any HTTP status. Per ADR 0020, "you pay for an
    /// answer, not the answer you wanted": a 404 is a real answer that
    /// consumed real work, so it is reported the same way a 200 is, and it
    /// is for the caller to decide what to do with it.
    Answered { response: EnvelopeResponse },
    /// The app could not be reached at all, or did not answer in time.
    Unreachable { message: String },
}

/// Header names meaningful only for one hop of a connection (RFC 7230
/// §6.1), never carried across a proxying boundary in either direction.
const HOP_BY_HOP_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

fn is_hop_by_hop_header(name: &str) -> bool {
    HOP_BY_HOP_HEADERS
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(name))
}

/// Delivers an [`EnvelopeRequest`] to the app behind a terminated route over
/// HTTP, and returns its answer as an [`AppOutcome`].
#[async_trait]
pub trait AppClient: Send + Sync {
    async fn deliver(&self, handler_url: &Url, request: &EnvelopeRequest) -> AppOutcome;
}

/// The production [`AppClient`]: makes exactly the request the envelope
/// describes -- `handler_url`'s origin with `request.target` as the path
/// (and query), `request.method`, `request.headers` minus hop-by-hop
/// headers, `request.body` -- and reports back the app's complete response,
/// whatever its status.
pub struct HttpAppClient {
    client: reqwest::Client,
}

impl HttpAppClient {
    pub fn new() -> HttpAppClient {
        HttpAppClient {
            client: reqwest::Client::new(),
        }
    }
}

impl Default for HttpAppClient {
    fn default() -> Self {
        HttpAppClient::new()
    }
}

#[async_trait]
impl AppClient for HttpAppClient {
    async fn deliver(&self, handler_url: &Url, request: &EnvelopeRequest) -> AppOutcome {
        let url = match handler_url.join(&request.target) {
            Ok(url) => url,
            Err(source) => {
                return AppOutcome::Unreachable {
                    message: format!("envelope target '{}' is invalid: {source}", request.target),
                };
            }
        };
        let method = match reqwest::Method::from_bytes(request.method.as_bytes()) {
            Ok(method) => method,
            Err(source) => {
                return AppOutcome::Unreachable {
                    message: format!("envelope method '{}' is invalid: {source}", request.method),
                };
            }
        };

        let mut builder = self.client.request(method, url);
        for (name, value) in &request.headers {
            // `host` and `content-length` are recomputed by `reqwest` from
            // the URL and the body it is given; carrying the envelope's own
            // values across would duplicate them on the wire rather than
            // describe this hop.
            if is_hop_by_hop_header(name)
                || name.eq_ignore_ascii_case("host")
                || name.eq_ignore_ascii_case("content-length")
            {
                continue;
            }
            builder = builder.header(name, value);
        }

        let response = builder.body(request.body.clone()).send().await;

        match response {
            Ok(response) => {
                let status = response.status().as_u16();
                let headers = response
                    .headers()
                    .iter()
                    .filter(|(name, _)| !is_hop_by_hop_header(name.as_str()))
                    .filter_map(|(name, value)| {
                        value
                            .to_str()
                            .ok()
                            .map(|value| (name.to_string(), value.to_string()))
                    })
                    .collect();
                let body = response
                    .bytes()
                    .await
                    .map(|bytes| bytes.to_vec())
                    .unwrap_or_default();
                AppOutcome::Answered {
                    response: EnvelopeResponse {
                        status,
                        headers,
                        body,
                    },
                }
            }
            Err(source) => AppOutcome::Unreachable {
                message: source.to_string(),
            },
        }
    }
}

/// A real in-memory [`AppClient`]: no socket, no process, but genuinely
/// upholds the port's contract (ADR 0007) -- callers configure the outcome
/// each `handler_url` produces, and every delivery is recorded so a test can
/// assert on exactly what was sent, including the absence of a header the
/// port must not add.
#[derive(Default)]
pub struct FakeAppClient {
    responses: Mutex<HashMap<String, AppOutcome>>,
    deliveries: Mutex<Vec<Delivery>>,
}

/// One recorded call into a [`FakeAppClient`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delivery {
    pub handler_url: Url,
    pub request: EnvelopeRequest,
}

impl FakeAppClient {
    pub fn new() -> FakeAppClient {
        FakeAppClient::default()
    }

    /// Configure the outcome a future delivery to `handler_url` produces.
    pub fn respond(&self, handler_url: &Url, outcome: AppOutcome) {
        self.responses
            .lock()
            .expect("responses lock")
            .insert(handler_url.to_string(), outcome);
    }

    /// Every delivery this fake has received, in order.
    pub fn deliveries(&self) -> Vec<Delivery> {
        self.deliveries.lock().expect("deliveries lock").clone()
    }
}

#[async_trait]
impl AppClient for FakeAppClient {
    async fn deliver(&self, handler_url: &Url, request: &EnvelopeRequest) -> AppOutcome {
        self.deliveries
            .lock()
            .expect("deliveries lock")
            .push(Delivery {
                handler_url: handler_url.clone(),
                request: request.clone(),
            });

        self.responses
            .lock()
            .expect("responses lock")
            .get(handler_url.as_str())
            .cloned()
            .unwrap_or(AppOutcome::Unreachable {
                message: format!("no fake response configured for {handler_url}"),
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: &str, target: &str, body: &[u8]) -> EnvelopeRequest {
        EnvelopeRequest {
            method: method.to_string(),
            target: target.to_string(),
            headers: vec![],
            body: body.to_vec(),
        }
    }

    #[tokio::test]
    async fn fake_app_client_returns_the_configured_outcome() {
        let fake = FakeAppClient::new();
        let handler_url = Url::parse("http://localhost:4000").unwrap();
        fake.respond(
            &handler_url,
            AppOutcome::Answered {
                response: EnvelopeResponse {
                    status: 200,
                    headers: vec![],
                    body: b"ok".to_vec(),
                },
            },
        );

        let outcome = fake
            .deliver(&handler_url, &request("POST", "/orders", b"hello"))
            .await;

        assert_eq!(
            outcome,
            AppOutcome::Answered {
                response: EnvelopeResponse {
                    status: 200,
                    headers: vec![],
                    body: b"ok".to_vec(),
                },
            }
        );
    }

    #[tokio::test]
    async fn fake_app_client_records_every_delivery() {
        let fake = FakeAppClient::new();
        let handler_url = Url::parse("http://localhost:4000").unwrap();
        let sent = request("POST", "/orders", b"hello");

        fake.deliver(&handler_url, &sent).await;

        let deliveries = fake.deliveries();
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].handler_url, handler_url);
        assert_eq!(deliveries[0].request, sent);
    }

    #[tokio::test]
    async fn fake_app_client_defaults_to_unreachable_when_unconfigured() {
        let fake = FakeAppClient::new();
        let handler_url = Url::parse("http://localhost:4000").unwrap();

        let outcome = fake.deliver(&handler_url, &request("GET", "/", b"")).await;

        assert!(matches!(outcome, AppOutcome::Unreachable { .. }));
    }

    /// Contract suite (ADR 0007): both [`AppClient`] implementations honor
    /// the same statement -- the request the envelope describes is exactly
    /// the request made, and the app's complete answer comes back
    /// regardless of its status.
    mod contract {
        use super::*;
        use hyper::service::{make_service_fn, service_fn};
        use hyper::{Body, Request, Response, Server};
        use std::convert::Infallible;
        use std::net::SocketAddr;
        use std::sync::{Arc, Mutex};

        /// What a spawned test app observed about the one request it
        /// received.
        #[derive(Debug, Clone, Default)]
        struct ObservedRequest {
            method: String,
            path: String,
            headers: Vec<(String, String)>,
            body: Vec<u8>,
        }

        /// Spawn a real HTTP server that records the one request it
        /// receives and always answers with `status`/`response_headers`/
        /// `response_body`.
        async fn spawn_test_app(
            status: u16,
            response_headers: Vec<(&'static str, &'static str)>,
            response_body: &'static [u8],
        ) -> (Url, Arc<Mutex<Option<ObservedRequest>>>) {
            let observed: Arc<Mutex<Option<ObservedRequest>>> = Arc::new(Mutex::new(None));
            let observed_for_service = observed.clone();

            let make_svc = make_service_fn(move |_conn| {
                let observed = observed_for_service.clone();
                let response_headers = response_headers.clone();
                async move {
                    Ok::<_, Infallible>(service_fn(move |req: Request<Body>| {
                        let observed = observed.clone();
                        let response_headers = response_headers.clone();
                        async move {
                            let method = req.method().to_string();
                            let path = req
                                .uri()
                                .path_and_query()
                                .map(|path_and_query| path_and_query.to_string())
                                .unwrap_or_default();
                            let headers = req
                                .headers()
                                .iter()
                                .map(|(name, value)| {
                                    (
                                        name.to_string(),
                                        value.to_str().unwrap_or_default().to_string(),
                                    )
                                })
                                .collect();
                            let body = hyper::body::to_bytes(req.into_body())
                                .await
                                .unwrap()
                                .to_vec();
                            *observed.lock().unwrap() = Some(ObservedRequest {
                                method,
                                path,
                                headers,
                                body,
                            });

                            let mut builder = Response::builder().status(status);
                            for (name, value) in &response_headers {
                                builder = builder.header(*name, *value);
                            }
                            Ok::<_, Infallible>(builder.body(Body::from(response_body)).unwrap())
                        }
                    }))
                }
            });

            let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
            let server = Server::bind(&addr).serve(make_svc);
            let bound_addr = server.local_addr();
            tokio::spawn(server);

            (
                Url::parse(&format!("http://{bound_addr}")).unwrap(),
                observed,
            )
        }

        /// `accepting`/`declining` are handler URLs the caller has already
        /// wired up to answer `200`/`404` -- a real spawned server for the
        /// HTTP case, a fake's configured response for the in-memory case.
        /// Only status and body are asserted: a real HTTP/1.1 server adds
        /// incidental headers of its own (`content-length`, `date`) a fake
        /// never does, so those are not part of what both implementations
        /// share -- the header-handling rules themselves (hop-by-hop
        /// stripping, verbatim relay of an ordinary header) are each
        /// covered by their own HTTP-specific test below.
        async fn assert_upholds_the_contract(
            client: &dyn AppClient,
            accepting: Url,
            declining: Url,
        ) {
            match client
                .deliver(&accepting, &request("POST", "/orders", b"payload"))
                .await
            {
                AppOutcome::Answered { response } => {
                    assert_eq!(response.status, 200);
                    assert_eq!(response.body, b"accepted");
                }
                other => panic!("expected an answer, got {other:?}"),
            }

            // ADR 0020's central rule: a non-2xx status is a real answer,
            // not converted into anything resembling a failure.
            match client
                .deliver(&declining, &request("GET", "/missing", b""))
                .await
            {
                AppOutcome::Answered { response } => {
                    assert_eq!(response.status, 404);
                    assert_eq!(response.body, b"not found");
                }
                other => panic!("expected an answer, got {other:?}"),
            }
        }

        #[tokio::test]
        async fn http_app_client_upholds_the_contract() {
            let (accepting, _observed) = spawn_test_app(200, vec![], b"accepted").await;
            let (declining, _observed) = spawn_test_app(404, vec![], b"not found").await;
            assert_upholds_the_contract(&HttpAppClient::new(), accepting, declining).await;
        }

        #[tokio::test]
        async fn fake_app_client_upholds_the_contract() {
            let fake = FakeAppClient::new();
            let accepting = Url::parse("http://fake-accepting").unwrap();
            let declining = Url::parse("http://fake-declining").unwrap();
            fake.respond(
                &accepting,
                AppOutcome::Answered {
                    response: EnvelopeResponse {
                        status: 200,
                        headers: vec![],
                        body: b"accepted".to_vec(),
                    },
                },
            );
            fake.respond(
                &declining,
                AppOutcome::Answered {
                    response: EnvelopeResponse {
                        status: 404,
                        headers: vec![],
                        body: b"not found".to_vec(),
                    },
                },
            );

            assert_upholds_the_contract(&fake, accepting, declining).await;
        }

        #[tokio::test]
        async fn http_app_client_reports_a_connection_failure_as_unreachable() {
            // Port 0 never accepts a connection, so this fails fast without a timeout.
            let unroutable = Url::parse("http://127.0.0.1:0").unwrap();

            let outcome = HttpAppClient::new()
                .deliver(&unroutable, &request("GET", "/", b""))
                .await;

            assert!(matches!(outcome, AppOutcome::Unreachable { .. }));
        }

        /// AC1: a packet whose envelope names a method and a target causes
        /// exactly that request to the app's handler.
        #[tokio::test]
        async fn http_app_client_makes_exactly_the_request_the_envelope_describes() {
            let (url, observed) = spawn_test_app(200, vec![], b"ok").await;

            HttpAppClient::new()
                .deliver(
                    &url,
                    &EnvelopeRequest {
                        method: "PUT".to_string(),
                        target: "/orders/42".to_string(),
                        headers: vec![("x-request-id".to_string(), "abc-123".to_string())],
                        body: b"payload".to_vec(),
                    },
                )
                .await;

            let observed = observed.lock().unwrap().clone().expect("app was called");
            assert_eq!(observed.method, "PUT");
            assert_eq!(observed.path, "/orders/42");
            assert_eq!(observed.body, b"payload");
            assert!(observed.headers.iter().any(|(name, value)| {
                name.eq_ignore_ascii_case("x-request-id") && value == "abc-123"
            }));
        }

        /// AC7: hop-by-hop headers do not cross the connector, in either
        /// direction.
        #[tokio::test]
        async fn hop_by_hop_headers_do_not_cross_the_connector_in_either_direction() {
            let (url, observed) = spawn_test_app(
                200,
                vec![("connection", "keep-alive"), ("x-app-header", "present")],
                b"ok",
            )
            .await;

            let outcome = HttpAppClient::new()
                .deliver(
                    &url,
                    &EnvelopeRequest {
                        method: "GET".to_string(),
                        target: "/".to_string(),
                        headers: vec![
                            ("connection".to_string(), "close".to_string()),
                            ("x-client-header".to_string(), "present".to_string()),
                        ],
                        body: vec![],
                    },
                )
                .await;

            let observed = observed.lock().unwrap().clone().expect("app was called");
            assert!(!observed
                .headers
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case("connection")));
            assert!(observed
                .headers
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case("x-client-header")));

            match outcome {
                AppOutcome::Answered { response } => {
                    assert!(!response
                        .headers
                        .iter()
                        .any(|(name, _)| name.eq_ignore_ascii_case("connection")));
                    assert!(response
                        .headers
                        .iter()
                        .any(|(name, _)| name.eq_ignore_ascii_case("x-app-header")));
                }
                other => panic!("expected an answer, got {other:?}"),
            }
        }

        /// The port does no special-casing of any particular header name --
        /// including one that used to carry a legacy fulfillment signal
        /// (issue #417's `TOON-Fulfillment`, retired by #525: the
        /// fulfilment is derived from the packet's own sealed secret now,
        /// not read off any header). It is just another header the app
        /// happened to send.
        #[tokio::test]
        async fn an_ordinary_response_header_is_relayed_verbatim() {
            let (url, _observed) = spawn_test_app(
                200,
                vec![(
                    "toon-fulfillment",
                    "0707070707070707070707070707070707070707070707070707070707070707",
                )],
                b"ok",
            )
            .await;

            let outcome = HttpAppClient::new()
                .deliver(&url, &request("GET", "/", b""))
                .await;

            match outcome {
                AppOutcome::Answered { response } => {
                    assert!(response.headers.iter().any(|(name, value)| {
                        name.eq_ignore_ascii_case("toon-fulfillment")
                            && value
                                == "0707070707070707070707070707070707070707070707070707070707070707"
                    }));
                }
                other => panic!("expected an answer, got {other:?}"),
            }
        }
    }
}
