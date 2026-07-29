//! The port between this connector and the app behind a terminated route
//! (issue #521). The app is payment-oblivious: it is handed the request an
//! envelope describes over plain HTTP and returns its answer, knowing
//! nothing about packets, channels or claims. Per ADR 0020, an HTTP status
//! is envelope content, never a packet outcome -- so this port reports
//! either a complete answer (whatever its status) or the absence of one. It
//! never sees a [`connector_domain::Prepare`], a key or a claim: the
//! envelope is decoded above this boundary (`Connector::deliver_to_app`),
//! and this is a thin adapter that makes the request it is given -- with
//! its target confined beneath the route's own handler path (issue #596,
//! ADR 0025) -- and reports what came back.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use percent_encoding::percent_decode_str;
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
    /// Issue #596: `request.target` attempted to escape the route's
    /// configured handler path -- an absolute path, a `..` segment, a
    /// scheme, an authority, or a percent-encoded equivalent of any of
    /// those. Refused before any request was made, so the app was never
    /// reached and (per [`crate::connector::Connector`]'s pricing) the
    /// payer is not charged for it.
    Refused { message: String },
}

/// Resolve `target` strictly beneath `handler_url`'s own path (ADR 0025,
/// issue #596): the route's configured handler path is authoritative, and
/// an envelope's target can only ever address something nested under it.
/// Unlike RFC 3986 reference resolution (`Url::join`), which lets an
/// absolute path, a scheme or an authority in `target` *replace* the base
/// entirely, `target` is appended after `handler_url`'s own path -- it can
/// never replace any part of it.
///
/// `""` and `"/"` both mean "the handler's own path, nothing appended"
/// (the common case a client uses when it has exactly one endpoint). Any
/// other value beginning with `/` is an absolute-path escape attempt and is
/// refused, as is a scheme (`http:`, `javascript:`, ...), a `..` or `.`
/// path segment, a backslash, or a percent-encoded form of any of those --
/// checked against the fully percent-decoded form, so an encoded equivalent
/// (`%2e%2e`, `%2Fadmin`, `%5c`, `%68ttp%3a...`) cannot smuggle past a check
/// for the literal characters.
///
/// Shared by [`HttpAppClient`] and [`FakeAppClient`] so both implementations
/// of this port enforce the identical rule (ADR 0007: a fake must genuinely
/// uphold the contract it stands in for).
fn resolve_target_under_handler(handler_url: &Url, target: &str) -> Result<Url, String> {
    let (path_part, query_part) = match target.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (target, None),
    };

    let sub_path = match path_part {
        "" | "/" => "",
        other if other.starts_with('/') => {
            return Err(format!(
                "envelope target '{target}' is an absolute path -- it must be relative to the \
                 route's handler path, never in place of it"
            ));
        }
        other => other,
    };

    if !sub_path.is_empty() && path_attempts_to_escape(sub_path) {
        return Err(format!(
            "envelope target '{target}' attempts to escape the route's handler path"
        ));
    }

    let mut resolved = handler_url.clone();
    if !sub_path.is_empty() {
        let base = resolved.path().trim_end_matches('/').to_string();
        resolved.set_path(&format!("{base}/{sub_path}"));
    }
    resolved.set_query(query_part);
    Ok(resolved)
}

/// Whether `sub_path` (a target's path portion, already known not to start
/// with `/`) contains a scheme, a `..`/`.` segment, a backslash, or a
/// percent-encoded form of any of those -- checked against the fully
/// percent-decoded form, since a single decode pass reveals an encoded `/`,
/// `\` or `..` without needing to special-case where in the string it
/// appears, and a scheme prefix survives decoding unchanged (a `scheme ":"`
/// is plain ASCII with no `%` of its own, so decoding a string that already
/// looks like one is a no-op).
///
/// A backslash is refused outright rather than merely treated as another
/// separator. RFC 3986 gives `\` no meaning in a path, but the WHATWG URL
/// parser this crate implements treats it as a path separator for a special
/// scheme (`http`/`https`) *and* removes dot segments while doing so -- so
/// `..\admin` under a handler at `/write` normalizes all the way out to
/// `/admin`, escaping the route's path exactly as `../admin` would while
/// slipping past a check that only splits on `/`. Since there is no faithful
/// reading of a backslash to preserve -- the target delivered would never be
/// the target the sender wrote -- the whole class is refused.
fn path_attempts_to_escape(sub_path: &str) -> bool {
    let decoded = percent_decode_str(sub_path).decode_utf8_lossy();
    if decoded.starts_with('/') || decoded.contains('\\') || looks_like_a_scheme(&decoded) {
        return true;
    }
    decoded
        .split('/')
        .any(|segment| segment == "." || segment == "..")
}

/// Whether `s` begins with an RFC 3986 `scheme ":"` -- `ALPHA *( ALPHA /
/// DIGIT / "+" / "-" / "." ) ":"` -- which would let `target` name an
/// absolute URI rather than a path relative to the handler.
fn looks_like_a_scheme(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
            return false;
        }
    }
    false
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
/// describes -- `request.target` resolved strictly beneath `handler_url`'s
/// own path (never in place of it, see [`resolve_target_under_handler`]),
/// `request.method`, `request.headers` minus hop-by-hop headers,
/// `request.body` -- and reports back the app's complete response, whatever
/// its status.
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
        let url = match resolve_target_under_handler(handler_url, &request.target) {
            Ok(url) => url,
            Err(message) => return AppOutcome::Refused { message },
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
        // Same confinement rule as `HttpAppClient` (issue #596) -- a target
        // that escapes never reaches the app, so it is refused here before
        // the delivery is even recorded, exactly as it never fires a real
        // HTTP request in the production client.
        if let Err(message) = resolve_target_under_handler(handler_url, &request.target) {
            return AppOutcome::Refused { message };
        }

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

    /// Issue #596's core rule, exercised directly against the pure resolver
    /// rather than through a full delivery: a target resolves *beneath*
    /// the handler's own path, never in place of it, and any attempt to
    /// escape that path -- as an absolute path, a `..`/`.` segment, a
    /// scheme, an authority, or a percent-encoded equivalent of any of
    /// those -- is refused rather than resolved.
    mod resolve_target_under_handler_tests {
        use super::*;

        fn handler() -> Url {
            let mut url = Url::parse("http://relay:3100").unwrap();
            url.set_path("/write");
            url
        }

        #[test]
        fn empty_and_bare_slash_both_mean_the_handlers_own_path() {
            assert_eq!(
                resolve_target_under_handler(&handler(), "")
                    .unwrap()
                    .as_str(),
                "http://relay:3100/write"
            );
            assert_eq!(
                resolve_target_under_handler(&handler(), "/")
                    .unwrap()
                    .as_str(),
                "http://relay:3100/write"
            );
        }

        #[test]
        fn a_relative_target_nests_beneath_the_handlers_path() {
            let resolved = resolve_target_under_handler(&handler(), "orders/42").unwrap();
            assert_eq!(resolved.as_str(), "http://relay:3100/write/orders/42");
        }

        #[test]
        fn a_query_string_survives_resolution() {
            let resolved = resolve_target_under_handler(&handler(), "search?q=x").unwrap();
            assert_eq!(resolved.as_str(), "http://relay:3100/write/search?q=x");
        }

        /// The exact scenario the issue reports: a bare-origin-shaped
        /// absolute path (as `/` or `/admin`) must never displace the
        /// route's own configured `/write`.
        #[test]
        fn an_absolute_path_is_refused() {
            assert!(resolve_target_under_handler(&handler(), "/admin").is_err());
            assert!(resolve_target_under_handler(&handler(), "/health").is_err());
        }

        #[test]
        fn a_dot_dot_segment_is_refused() {
            assert!(resolve_target_under_handler(&handler(), "../health").is_err());
            assert!(resolve_target_under_handler(&handler(), "a/../../health").is_err());
            assert!(resolve_target_under_handler(&handler(), ".").is_err());
        }

        #[test]
        fn a_scheme_or_authority_is_refused() {
            assert!(resolve_target_under_handler(&handler(), "http://evil.example/x").is_err());
            assert!(resolve_target_under_handler(&handler(), "javascript:alert(1)").is_err());
            assert!(resolve_target_under_handler(&handler(), "//evil.example/x").is_err());
        }

        /// A backslash escape. RFC 3986 gives `\` no meaning in a path, but
        /// the WHATWG URL parser treats it as a separator for a special
        /// scheme and removes dot segments as it goes -- so before this was
        /// refused, `..\admin` against a handler at `/write` resolved all
        /// the way out to `http://relay:3100/admin`, escaping the route's
        /// path entirely while splitting only on `/` saw one harmless
        /// segment. The percent-encoded forms (`%2e%2e\`, `%5c`) are the
        /// same escape spelled to dodge a literal-character check.
        #[test]
        fn a_backslash_escape_is_refused() {
            for target in [
                r"..\admin",
                r"..\..\admin",
                r"a\..\..\admin",
                r"%2e%2e\admin",
                r"..%5cadmin",
                r"%2e%2e%5cadmin",
                r"\admin",
            ] {
                assert!(
                    resolve_target_under_handler(&handler(), target).is_err(),
                    "target {target:?} should be refused"
                );
            }
        }

        #[test]
        fn a_percent_encoded_escape_is_refused() {
            // %2e%2e is a percent-encoded "..".
            assert!(resolve_target_under_handler(&handler(), "%2e%2e/health").is_err());
            // %2F is a percent-encoded "/", smuggling an absolute path
            // inside what looks like a single segment.
            assert!(resolve_target_under_handler(&handler(), "%2Fadmin").is_err());
        }

        /// Two routes on the same origin at different prices (the cheap
        /// `/health` route and the expensive `/write` route from the
        /// issue) cannot be reached through one another: resolving a
        /// target against the cheap route's handler can only ever produce
        /// a URL nested under `/health`, never `/write`.
        #[test]
        fn a_cheap_routes_handler_can_never_resolve_into_a_different_routes_path() {
            let mut cheap = Url::parse("http://relay:3100").unwrap();
            cheap.set_path("/health");

            for target in [
                "/write",
                "../write",
                "%2e%2e/write",
                r"..\write",
                r"%2e%2e%5cwrite",
            ] {
                let result = resolve_target_under_handler(&cheap, target);
                assert!(result.is_err(), "target {target:?} should be refused");
            }
        }
    }

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
            .deliver(&handler_url, &request("POST", "orders", b"hello"))
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
        let sent = request("POST", "orders", b"hello");

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

    /// Issue #596: a `FakeAppClient` enforces the same target confinement
    /// as `HttpAppClient` (asserted for the real client below), and never
    /// records a delivery for a target it refused -- the app was never
    /// reached, so there is nothing to have recorded.
    #[tokio::test]
    async fn fake_app_client_refuses_an_escaping_target_without_recording_a_delivery() {
        let fake = FakeAppClient::new();
        let handler_url = Url::parse("http://localhost:4000/write").unwrap();
        fake.respond(
            &handler_url,
            answered_response(200, b"should never be reached"),
        );

        let outcome = fake
            .deliver(&handler_url, &request("GET", "/admin", b""))
            .await;

        assert!(matches!(outcome, AppOutcome::Refused { .. }));
        assert!(fake.deliveries().is_empty());
    }

    fn answered_response(status: u16, body: &[u8]) -> AppOutcome {
        AppOutcome::Answered {
            response: EnvelopeResponse {
                status,
                headers: vec![],
                body: body.to_vec(),
            },
        }
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
                .deliver(&accepting, &request("POST", "orders", b"payload"))
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
                .deliver(&declining, &request("GET", "missing", b""))
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
        /// exactly that request to the app's handler. Issue #596: the
        /// route's handler is configured with its own path (`/write`, not
        /// the bare origin), and a relative target nests beneath it rather
        /// than beside or in place of it.
        #[tokio::test]
        async fn http_app_client_makes_exactly_the_request_the_envelope_describes() {
            let (mut handler_url, observed) = spawn_test_app(200, vec![], b"ok").await;
            handler_url.set_path("/write");

            HttpAppClient::new()
                .deliver(
                    &handler_url,
                    &EnvelopeRequest {
                        method: "PUT".to_string(),
                        target: "orders/42".to_string(),
                        headers: vec![("x-request-id".to_string(), "abc-123".to_string())],
                        body: b"payload".to_vec(),
                    },
                )
                .await;

            let observed = observed.lock().unwrap().clone().expect("app was called");
            assert_eq!(observed.method, "PUT");
            assert_eq!(observed.path, "/write/orders/42");
            assert_eq!(observed.body, b"payload");
            assert!(observed.headers.iter().any(|(name, value)| {
                name.eq_ignore_ascii_case("x-request-id") && value == "abc-123"
            }));
        }

        /// Issue #596's central scenario, against a real spawned server: a
        /// route whose handler is priced for `/write` must never be
        /// reachable at a different, cheaper path on the same origin (here
        /// `/health`) just because a sender's envelope names it as the
        /// target. The refusal happens before any request reaches the
        /// server at all.
        #[tokio::test]
        async fn http_app_client_refuses_a_target_that_escapes_the_handler_path() {
            let (mut handler_url, observed) = spawn_test_app(200, vec![], b"ok").await;
            handler_url.set_path("/write");

            let outcome = HttpAppClient::new()
                .deliver(&handler_url, &request("GET", "/health", b""))
                .await;

            assert!(matches!(outcome, AppOutcome::Refused { .. }));
            assert!(
                observed.lock().unwrap().is_none(),
                "the app must never be reached for a refused target"
            );
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
