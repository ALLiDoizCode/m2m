//! Reading **another** node's self-description (ADR 0050) so a peering can
//! be established from a URL (ADR 0058).
//!
//! `connector_domain::node` builds the document this node answers with;
//! this module is the other direction -- the one outbound request this
//! connector makes to a host an operator named, from inside an
//! authenticated write.
//!
//! # Why it is bounded, and how
//!
//! ADR 0058: *"That request must be bounded -- timeout, response size,
//! redirect policy -- and must never be made on the packet path."* The
//! host is chosen by whoever holds the operator's write key, and the reply
//! is whatever that host feels like sending, so every one of those three is
//! a refusal here rather than a default someone else picks:
//!
//! * **Timeout.** [`FETCH_TIMEOUT`] covers the whole exchange, not merely
//!   the connect: a host that accepts a connection and then dribbles one
//!   byte a minute is the shape a connect timeout alone does not catch.
//! * **Response size.** [`MAX_DOCUMENT_BYTES`] is enforced while the body
//!   streams, so an unbounded response is dropped as it arrives rather
//!   than after it has been buffered. A declared `Content-Length` past the
//!   cap is refused before a byte of body is read.
//! * **Redirects.** Not followed at all. The operator named a URL and this
//!   reads that URL; a `3xx` is [`SelfDescriptionError::Redirected`], which
//!   names the location so the operator can point the write at it
//!   themselves if that is what they meant. Following one would let the
//!   named host hand the peering to a different host -- and under ADR 0059
//!   that choice determines the channel address.
//!
//! # Trust-on-first-use
//!
//! Whatever the URL serves is who the peering is with. Nothing here checks
//! the document against anything the operator supplied, and nothing should:
//! ADR 0058 considered a `settlement_address` pin and rejected it. The
//! operator's vetting of the URL is the whole of the assurance, and
//! `allow_plaintext` exists only so a local topology can rehearse over
//! `http://` the way `[[peers]]` endpoints already can.

use std::time::Duration;

use async_trait::async_trait;
use thiserror::Error;
use url::Url;

use connector_domain::NodeSelfDescription;

/// The whole exchange's budget -- connect, headers and body together.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// The most body this will read. A self-description is a few hundred bytes
/// on a node with several chains and several routes; this is three orders
/// of magnitude of headroom and still a bound.
pub const MAX_DOCUMENT_BYTES: usize = 64 * 1024;

/// Why a self-description could not be read.
///
/// Every variant names something the *remote* did, and none of them
/// describes a peering's identity as pinned, verified or attested -- there
/// is no such check to fail (ADR 0058).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SelfDescriptionError {
    /// The URL is not `https://` on a node that has not opted into
    /// plaintext peer endpoints. Trust-on-first-use over TLS is the whole
    /// of the assurance ADR 0058 offers, and there is none at all without
    /// the TLS.
    #[error("a peer URL must be https (got '{0}'); set peer_allow_plaintext_endpoints to rehearse over http")]
    InsecureScheme(String),

    /// The host could not be reached, or the exchange ran past
    /// [`FETCH_TIMEOUT`].
    #[error("could not read the self-description at {url}: {reason}")]
    Unreachable { url: String, reason: String },

    /// The URL answered, but not with a document: any status that is not
    /// `2xx`, redirects excepted (they get their own variant).
    #[error("{url} answered {status} rather than a self-description")]
    Status { url: String, status: u16 },

    /// The URL redirected. Not followed: see this module's own header.
    #[error("{url} redirected to '{location}'; name the URL you mean in the request rather than one that redirects")]
    Redirected { url: String, location: String },

    /// The response body ran past [`MAX_DOCUMENT_BYTES`].
    #[error(
        "the self-description at {url} is larger than the {limit}-byte bound this connector reads"
    )]
    TooLarge { url: String, limit: usize },

    /// The bytes are not a self-description.
    #[error("{url} did not answer a self-description: {reason}")]
    Malformed { url: String, reason: String },
}

/// Reads the document at a URL. A port, so the bounded HTTP client below
/// is not the only thing a peering write can be exercised against.
#[async_trait]
pub trait SelfDescriptionSource: Send + Sync {
    async fn fetch(&self, url: &Url) -> Result<NodeSelfDescription, SelfDescriptionError>;
}

/// The production [`SelfDescriptionSource`]: one bounded `GET`, no
/// redirects followed, no retry.
///
/// **No retry, deliberately.** `POST /peers` is safely retryable by the
/// operator (ADR 0059 makes the channel derivation idempotent), so a
/// failed fetch is a refusal the operator sees and repeats, not a loop
/// this connector runs on a host it was pointed at.
pub struct BoundedHttpSelfDescription {
    client: reqwest::Client,
    allow_plaintext: bool,
}

impl BoundedHttpSelfDescription {
    /// `allow_plaintext` is the node's own `peer_allow_plaintext_endpoints`
    /// -- the same opt-in a `ws://`/`http://` peer endpoint already needs,
    /// and for the same reason.
    #[must_use]
    pub fn new(allow_plaintext: bool) -> BoundedHttpSelfDescription {
        let client = reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("a reqwest client with a timeout and no redirect policy always builds");
        BoundedHttpSelfDescription {
            client,
            allow_plaintext,
        }
    }
}

#[async_trait]
impl SelfDescriptionSource for BoundedHttpSelfDescription {
    async fn fetch(&self, url: &Url) -> Result<NodeSelfDescription, SelfDescriptionError> {
        let readable = match url.scheme() {
            "https" => true,
            "http" => self.allow_plaintext,
            _ => false,
        };
        if !readable {
            return Err(SelfDescriptionError::InsecureScheme(url.to_string()));
        }

        let response = self
            .client
            .get(url.clone())
            .send()
            .await
            .map_err(|source| SelfDescriptionError::Unreachable {
                url: url.to_string(),
                reason: source.to_string(),
            })?;

        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("(no Location header)")
                .to_string();
            return Err(SelfDescriptionError::Redirected {
                url: url.to_string(),
                location,
            });
        }
        if !status.is_success() {
            return Err(SelfDescriptionError::Status {
                url: url.to_string(),
                status: status.as_u16(),
            });
        }

        // A declared length past the cap is refused before any body is
        // read; an undeclared or lying one is caught by the streaming
        // bound below.
        if response
            .content_length()
            .is_some_and(|declared| declared > MAX_DOCUMENT_BYTES as u64)
        {
            return Err(SelfDescriptionError::TooLarge {
                url: url.to_string(),
                limit: MAX_DOCUMENT_BYTES,
            });
        }

        let mut response = response;
        let mut body: Vec<u8> = Vec::new();
        loop {
            let chunk =
                response
                    .chunk()
                    .await
                    .map_err(|source| SelfDescriptionError::Unreachable {
                        url: url.to_string(),
                        reason: source.to_string(),
                    })?;
            let Some(chunk) = chunk else { break };
            if body.len() + chunk.len() > MAX_DOCUMENT_BYTES {
                return Err(SelfDescriptionError::TooLarge {
                    url: url.to_string(),
                    limit: MAX_DOCUMENT_BYTES,
                });
            }
            body.extend_from_slice(&chunk);
        }

        serde_json::from_slice(&body).map_err(|source| SelfDescriptionError::Malformed {
            url: url.to_string(),
            reason: source.to_string(),
        })
    }
}

/// A [`SelfDescriptionSource`] that reaches no network at all: every URL is
/// [`SelfDescriptionError::Unreachable`].
///
/// The default a [`crate::Connector`] holds until one is configured, and
/// what a node with no outbound reachability behaves as. It is a whole
/// implementation of the port rather than a stub that records calls: "this
/// node cannot reach that host" is a real answer, and a peering write is
/// refused by name on it instead of hanging.
pub struct UnreachableSelfDescription;

#[async_trait]
impl SelfDescriptionSource for UnreachableSelfDescription {
    async fn fetch(&self, url: &Url) -> Result<NodeSelfDescription, SelfDescriptionError> {
        Err(SelfDescriptionError::Unreachable {
            url: url.to_string(),
            reason: "this connector has no self-description source configured".to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::convert::Infallible;
    use std::net::SocketAddr;

    use axum::body::Body;
    use axum::http::{header, StatusCode};
    use axum::response::{IntoResponse, Response};
    use axum::routing::get;
    use axum::Router;
    use connector_domain::{EdgeIdentity, NodeFacts};

    /// A real HTTP server on a real socket, answering whatever `router`
    /// builds. Not a mock: the bounds under test are properties of an
    /// actual exchange -- a status, a `Location` header, a body that never
    /// ends -- and none of them exists in a fake that hands back a value.
    fn serve(router: Router) -> SocketAddr {
        let server = axum::Server::bind(&"127.0.0.1:0".parse().expect("loopback"))
            .serve(router.into_make_service());
        let addr = server.local_addr();
        tokio::spawn(async move {
            let _ = server.await;
        });
        addr
    }

    fn document() -> NodeSelfDescription {
        NodeSelfDescription::describe(
            &NodeFacts {
                ilp_addresses: vec!["g.example.peer".to_string()],
                http_endpoint: Some("https://peer.example/ilp".to_string()),
                btp_endpoint: None,
                peer_carriages: vec!["http".to_string()],
                settlements: Vec::new(),
            },
            Some(EdgeIdentity {
                key_id: "key-1".to_string(),
                public_key: "0x04ab".to_string(),
            }),
            Vec::new(),
            None,
        )
    }

    fn url(addr: SocketAddr, path: &str) -> Url {
        Url::parse(&format!("http://{addr}{path}")).expect("url")
    }

    #[tokio::test]
    async fn a_served_document_reads_back_as_the_document_that_was_served() {
        let served = document();
        let answered = served.clone();
        let router = Router::new().route(
            "/ilp",
            get(move || {
                let answered = answered.clone();
                async move { axum::Json(answered) }
            }),
        );
        let addr = serve(router);

        let fetched = BoundedHttpSelfDescription::new(true)
            .fetch(&url(addr, "/ilp"))
            .await
            .expect("the document reads back");

        assert_eq!(fetched, served);
    }

    /// The URL an operator names is the URL that is read. Following a
    /// redirect would let the named host choose a different counterparty,
    /// and under ADR 0059 the counterparty determines the channel address
    /// -- a party this node would then fund.
    #[tokio::test]
    async fn a_redirect_is_refused_by_name_rather_than_followed() {
        let router = Router::new().route(
            "/ilp",
            get(|| async {
                Response::builder()
                    .status(StatusCode::FOUND)
                    .header(header::LOCATION, "http://elsewhere.invalid/ilp")
                    .body(Body::empty())
                    .expect("redirect response")
                    .into_response()
            }),
        );
        let addr = serve(router);

        let error = BoundedHttpSelfDescription::new(true)
            .fetch(&url(addr, "/ilp"))
            .await
            .expect_err("a redirect is not followed");

        match error {
            SelfDescriptionError::Redirected { location, .. } => {
                assert_eq!(location, "http://elsewhere.invalid/ilp");
            }
            other => panic!("expected a named redirect refusal, got {other:?}"),
        }
    }

    /// A body past the bound is refused **while it streams**, so nothing
    /// unbounded is ever buffered. The server here never stops sending and
    /// declares no length, which is the shape a `Content-Length` check
    /// alone does not catch.
    #[tokio::test]
    async fn an_endless_body_is_refused_at_the_bound_rather_than_buffered() {
        let router = Router::new().route(
            "/ilp",
            get(|| async {
                let stream =
                    futures_util::stream::repeat_with(|| Ok::<_, Infallible>(vec![b'x'; 8 * 1024]));
                Response::builder()
                    .status(StatusCode::OK)
                    .body(Body::wrap_stream(stream))
                    .expect("streaming response")
                    .into_response()
            }),
        );
        let addr = serve(router);

        let error = BoundedHttpSelfDescription::new(true)
            .fetch(&url(addr, "/ilp"))
            .await
            .expect_err("an endless body is refused");

        assert!(
            matches!(
                error,
                SelfDescriptionError::TooLarge {
                    limit: MAX_DOCUMENT_BYTES,
                    ..
                }
            ),
            "expected the size bound to fire, got {error:?}"
        );
    }

    /// A declared length past the bound costs no body read at all.
    #[tokio::test]
    async fn a_declared_length_past_the_bound_is_refused_before_the_body() {
        let router = Router::new().route(
            "/ilp",
            get(|| async {
                Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_LENGTH, (MAX_DOCUMENT_BYTES + 1).to_string())
                    .body(Body::from(vec![b'x'; MAX_DOCUMENT_BYTES + 1]))
                    .expect("oversized response")
                    .into_response()
            }),
        );
        let addr = serve(router);

        let error = BoundedHttpSelfDescription::new(true)
            .fetch(&url(addr, "/ilp"))
            .await
            .expect_err("a declared oversize is refused");

        assert!(matches!(error, SelfDescriptionError::TooLarge { .. }));
    }

    #[tokio::test]
    async fn a_non_document_answer_is_refused_by_its_status() {
        let router = Router::new().route(
            "/ilp",
            get(|| async { (StatusCode::NOT_FOUND, "no such node") }),
        );
        let addr = serve(router);

        let error = BoundedHttpSelfDescription::new(true)
            .fetch(&url(addr, "/ilp"))
            .await
            .expect_err("a 404 is not a document");

        assert!(matches!(
            error,
            SelfDescriptionError::Status { status: 404, .. }
        ));
    }

    #[tokio::test]
    async fn a_body_that_is_not_a_self_description_is_refused_as_malformed() {
        let router = Router::new().route("/ilp", get(|| async { "not json at all" }));
        let addr = serve(router);

        let error = BoundedHttpSelfDescription::new(true)
            .fetch(&url(addr, "/ilp"))
            .await
            .expect_err("prose is not a document");

        assert!(matches!(error, SelfDescriptionError::Malformed { .. }));
    }

    /// Trust-on-first-use is *over TLS*; a node that has not opted into
    /// plaintext peer endpoints refuses `http://` before any request is
    /// made.
    #[tokio::test]
    async fn plaintext_is_refused_unless_the_node_opted_in() {
        let url = Url::parse("http://peer.example/ilp").expect("url");

        let error = BoundedHttpSelfDescription::new(false)
            .fetch(&url)
            .await
            .expect_err("http is refused by default");

        assert!(matches!(error, SelfDescriptionError::InsecureScheme(_)));
    }

    /// A URL that is neither http nor https is refused whatever the
    /// opt-in says -- `file://` in particular, which would otherwise read
    /// the node's own disk from an operator write.
    #[tokio::test]
    async fn a_non_http_scheme_is_refused_even_with_plaintext_allowed() {
        let url = Url::parse("file:///etc/passwd").expect("url");

        let error = BoundedHttpSelfDescription::new(true)
            .fetch(&url)
            .await
            .expect_err("file:// is not a peer URL");

        assert!(matches!(error, SelfDescriptionError::InsecureScheme(_)));
    }

    #[tokio::test]
    async fn the_unreachable_source_refuses_by_name_rather_than_hanging() {
        let error = UnreachableSelfDescription
            .fetch(&Url::parse("https://peer.example/ilp").expect("url"))
            .await
            .expect_err("no source configured");

        assert!(matches!(error, SelfDescriptionError::Unreachable { .. }));
    }
}
