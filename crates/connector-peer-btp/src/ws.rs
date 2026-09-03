//! The websocket underneath a dialed peering: the one place in this crate
//! that touches a socket.
//!
//! Everything else here is provable without TLS, a listener or a port
//! number, because [`crate::dial::PeerDialer`] is a port. This module is
//! its production implementation over `tokio-tungstenite` -- the same 0.20
//! the client edge's own BTP integration test already speaks.
//!
//! # `wss://`, and `ws://` only where an operator has opted in
//!
//! A peering carries signed balance proofs (ADR 0004), so the scheme that
//! selects this carriage in any deployed config is `wss://`. `ws://` is
//! [`connector_config::ConfigError::PeerEndpointScheme`] at load unless
//! the node set `peer_allow_plaintext_endpoints` (issue #678's gap 3), in
//! which case it names the same carriage without TLS and reaches here --
//! `connect_async` speaks both, and everything above this line is identical
//! either way. `local/mixed-chain`'s `a-b` peering is that case, and since
//! issue #1155 it is how the shipped image is proven to carry a packet over
//! BTP at all; a node taking the opt-in logs a WARN naming every such
//! peering at startup, `ws://` and `http://` alike.
//!
//! # Symmetry, without inferring a role from having dialed (§2.3, §1.3)
//!
//! On BTP a session is symmetric once established: after auth **either**
//! side may originate a MESSAGE or a TRANSFER on the one session. So a
//! dialed session must be able to *serve* as well as ask, and it does --
//! inbound frames that are not answers to our own requests are handed to a
//! [`PeerSession`] over the same socket, sharing its correlation table so
//! one read loop serves both halves.
//!
//! That session starts, and stays, `client` until the far side presents its
//! own credential. **Having dialed a peer is not evidence that the peer on
//! the other end is a peer** -- §1.3 forbids inferring role from the
//! carriage, the endpoint or anything the interaction did earlier, and "we
//! are the ones who opened this socket" is exactly that kind of inference.
//! The credential decides, in the direction it is presented, or the role is
//! `client`.

use std::sync::Arc;

use async_trait::async_trait;
use connector_btp::{decode_frame, BtpSessionHandle, OutboundRequests};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

use crate::accept::{PeerCarriageState, PeerSession, REPLY_QUEUE_DEPTH};
use crate::dial::{DialError, PeerDialer};

/// Dials `wss://` peer endpoints over `tokio-tungstenite`.
pub struct TungsteniteDialer {
    /// The pipeline an inbound, peer-originated frame on a dialed session
    /// reaches (§2.3). `None` means this connector only ever asks on the
    /// sessions it dials: answers still correlate, and anything else the
    /// far side sends is dropped rather than served.
    inbound: Option<Arc<PeerCarriageState>>,
}

impl TungsteniteDialer {
    /// A dialer whose sessions ask and never serve.
    #[must_use]
    pub fn new() -> Self {
        TungsteniteDialer { inbound: None }
    }

    /// A dialer whose sessions are symmetric (§2.3): a MESSAGE or TRANSFER
    /// the far side originates reaches `state`'s pipeline, judged by the
    /// same rules an inbound session's frames are.
    #[must_use]
    pub fn serving(state: Arc<PeerCarriageState>) -> Self {
        TungsteniteDialer {
            inbound: Some(state),
        }
    }
}

impl Default for TungsteniteDialer {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl PeerDialer for TungsteniteDialer {
    async fn dial(&self, peer_id: &str, endpoint: &Url) -> Result<BtpSessionHandle, DialError> {
        let failed = |reason: String| DialError {
            peer_id: peer_id.to_string(),
            endpoint: endpoint.to_string(),
            reason,
        };
        let (socket, _) = tokio_tungstenite::connect_async(endpoint.as_str())
            .await
            .map_err(|error| failed(error.to_string()))?;
        let (mut sink, mut stream) = socket.split();

        // The one writer. Frames complete in whatever order their
        // downstream answers, and this channel is where those completions
        // serialize back into socket writes.
        let (replies, mut reply_rx) = mpsc::channel::<Vec<u8>>(REPLY_QUEUE_DEPTH);
        tokio::spawn(async move {
            while let Some(bytes) = reply_rx.recv().await {
                if sink.send(Message::Binary(bytes)).await.is_err() {
                    break;
                }
            }
        });

        let outbound = Arc::new(OutboundRequests::new());
        let handle = BtpSessionHandle::new(replies.clone(), Arc::clone(&outbound));

        match self.inbound.as_ref() {
            // Symmetric: one read loop, feeding the session that both
            // correlates our answers and serves the far side's requests.
            Some(state) => {
                let mut session =
                    PeerSession::with_outbound(Arc::clone(state), replies, Arc::clone(&outbound));
                tokio::spawn(async move {
                    while let Some(Ok(Message::Binary(bytes))) = stream.next().await {
                        if session.handle_frame(&bytes).await.is_err() {
                            break;
                        }
                    }
                });
            }
            // Ask-only: answers correlate, everything else is dropped --
            // byte-identical to what a session with nothing to serve would
            // do with it anyway.
            None => {
                tokio::spawn(async move {
                    while let Some(Ok(message)) = stream.next().await {
                        if let Message::Binary(bytes) = message {
                            if let Ok(frame) = decode_frame(&bytes) {
                                outbound.resolve(frame);
                            }
                        }
                    }
                });
            }
        }

        Ok(handle)
    }
}
