//! The one place this crate touches a socket: a [`PeerHttpClient`] over
//! `reqwest`.
//!
//! Everything the carriage *decides* -- which headers ride, what an absent
//! ack means, when a claim may be retransmitted, §7.2's in-flight rule --
//! is above this file and provable without it. What is here is TLS, a
//! connection pool and a byte copy.

use async_trait::async_trait;
use url::Url;

use crate::dial::{HttpDialError, PeerHttpClient};
use crate::headers::{Headers, PeerRequest, PeerResponse};

/// The content type an OER ILP packet rides under, the same one the client
/// edge's `POST /ilp` uses (`client-edge-spec.md` §1.1). A FLUSH's body is
/// empty and carries it too: the shape is "a POST with an empty ILP body",
/// not a differently typed request.
const OCTET_STREAM: &str = "application/octet-stream";

/// A [`PeerHttpClient`] backed by `reqwest`, rustls only.
pub struct ReqwestPeerClient {
    client: reqwest::Client,
}

impl ReqwestPeerClient {
    /// A client over `client`, so a caller that already tunes timeouts,
    /// pools or roots keeps them. The carriage's own deadlines
    /// (`peerAnswerTimeoutMs`, `claimAckTimeoutMs` -- §6.3) are applied
    /// above this, per peering relation, and are not this client's.
    #[must_use]
    pub fn new(client: reqwest::Client) -> Self {
        ReqwestPeerClient { client }
    }
}

impl Default for ReqwestPeerClient {
    fn default() -> Self {
        ReqwestPeerClient::new(reqwest::Client::new())
    }
}

#[async_trait]
impl PeerHttpClient for ReqwestPeerClient {
    async fn post(
        &self,
        endpoint: &Url,
        request: PeerRequest,
    ) -> Result<PeerResponse, HttpDialError> {
        let failure = |reason: String| HttpDialError {
            peer_id: String::new(),
            endpoint: endpoint.to_string(),
            reason,
        };

        let mut outbound = self
            .client
            .post(endpoint.clone())
            .header("content-type", OCTET_STREAM)
            .body(request.body);
        for (name, value) in request.headers.iter() {
            outbound = outbound.header(name, value);
        }

        let response = outbound
            .send()
            .await
            .map_err(|error| failure(error.to_string()))?;
        let status = response.status().as_u16();
        let mut headers = Headers::new();
        for (name, value) in response.headers() {
            // A header whose bytes are not text is not one §3 names, and §3
            // requires anything this document does not name be ignored on
            // receipt rather than refused -- so the carriage stays additively
            // extensible.
            if let Ok(value) = value.to_str() {
                headers.push(name.as_str(), value);
            }
        }
        let body = response
            .bytes()
            .await
            .map_err(|error| failure(error.to_string()))?
            .to_vec();

        Ok(PeerResponse {
            status,
            headers,
            body,
        })
    }
}
