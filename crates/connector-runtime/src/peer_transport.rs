//! The peer transport port: forwards a [`Prepare`] to another connector for
//! the next hop, optionally carrying a claim (issue #423), and flushes a
//! claim on its own when nothing else is going out (peer-wire-spec.md
//! §3.3). See `docs/protocol/peer-wire-spec.md` §1.1 -- production peering
//! is one persistent duplex stream per relation; [`InProcessPeerTransport`]
//! here is the in-process stand-in that spec calls out for composing
//! multi-connector tests without a socket. [`crate::NetworkPeerTransport`]
//! (issue #416) is the network implementation of the same port; both are
//! held to the contract suite in this module's `tests::contract`.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::{mpsc, oneshot};

use connector_domain::{PacketResponse, Prepare, Reject, RejectCode};

use crate::claim::{ClaimAckOutcome, WireClaim};
use crate::connector::Connector;

/// Forwards a [`Prepare`] to the connector reachable at `peer_id` and
/// returns whatever [`PacketResponse`] it produces, unchanged -- a reject
/// originated at the far end reaches the caller exactly as that peer sent
/// it. `minimum_delivery` is the amount the original sender declared must
/// reach the destination (ADR 0010) -- carried alongside `prepare` rather
/// than inside it, and passed to the peer unchanged so every hop enforces
/// it against the same figure. `claim` piggybacks whatever this connector
/// currently owes `peer_id` (peer-wire-spec.md §3.2); the returned
/// [`ClaimAckOutcome`] is [`ClaimAckOutcome::NotSent`] when `claim` was
/// `None`, or when the peer could not be reached to answer at all.
///
/// The trailing `bool` is whether this peer was actually reached -- `true`
/// for any real answer (fulfil or reject) the peer itself decided on,
/// `false` when this transport could not deliver the PREPARE at all, in
/// which case the accompanying [`PacketResponse`] is this transport's own
/// synthesized `T01` (see [`peer_unreachable`]). The caller (issue #426,
/// ADR 0011) needs this to decide whether its own fee belongs on an
/// outgoing REJECT: only a hop that actually forwarded earns one
/// (peer-wire-spec.md §5.2).
#[async_trait]
pub trait PeerTransport: Send + Sync {
    async fn forward(
        &self,
        peer_id: &str,
        prepare: Prepare,
        minimum_delivery: u64,
        claim: Option<WireClaim>,
    ) -> (PacketResponse, ClaimAckOutcome, bool);

    /// Send `claim` with no packet to ride -- the flush mechanism
    /// (peer-wire-spec.md §3.3) that covers the case traffic to `peer_id`
    /// has stopped. Returns [`ClaimAckOutcome::NotSent`] if `peer_id`
    /// could not be reached.
    async fn flush(&self, peer_id: &str, claim: WireClaim) -> ClaimAckOutcome;
}

pub(crate) fn peer_unreachable(peer_id: &str) -> PacketResponse {
    PacketResponse::Reject(Reject {
        code: RejectCode::t01_peer_unreachable(),
        triggered_by: String::new(),
        message: format!("peer '{peer_id}' unreachable"),
        data: Vec::new(),
        accumulated_cost: 0,
    })
}

/// One message handed to a peer's owning task: either a [`Prepare`] to
/// forward (optionally carrying a claim), or a claim to flush on its own.
/// Both travel the same channel so the two ways a frame reaches a peer stay
/// ordered relative to each other, exactly as they would interleaved on one
/// real duplex stream.
enum PeerMessage {
    Prepare {
        prepare: Prepare,
        minimum_delivery: u64,
        claim: Option<WireClaim>,
        respond_to: oneshot::Sender<(PacketResponse, ClaimAckOutcome)>,
    },
    Flush {
        claim: WireClaim,
        respond_to: oneshot::Sender<ClaimAckOutcome>,
    },
}

/// A handle to a peer [`Connector`], reachable only by message -- the
/// in-process stand-in for the peer wire's persistent duplex stream. The
/// `Connector` behind a `PeerLink` is owned exclusively by the task spawned
/// in [`PeerLink::connect`]; nothing outside that task ever touches it
/// directly, so there is no lock on this path, on either side of it.
#[derive(Clone)]
struct PeerLink {
    sender: mpsc::Sender<PeerMessage>,
    /// The channel this link's counterparty is known to identify itself by
    /// (issue #424) -- shared with the spawned task so
    /// [`InProcessPeerTransport::set_peer_channel`] can configure it up
    /// front, before any traffic, standing in for the identity a real
    /// handshake would establish (#416, not yet built). Also updated by the
    /// task itself the moment any claim or flush on this link names a
    /// channel, so a link nobody pre-configured still learns its
    /// counterparty's channel rather than never checking a ceiling at all.
    known_channel_id: Arc<std::sync::RwLock<Option<String>>>,
}

impl PeerLink {
    /// Spawn the task that owns `connector` for the lifetime of this link,
    /// answering every forwarded [`Prepare`] by calling
    /// [`Connector::handle_peer_prepare`] and every flush by calling
    /// [`Connector::handle_peer_claim`] -- the same claim-acceptance path a
    /// claim piggybacked on a PREPARE reaches, so a flushed claim is judged
    /// identically.
    fn connect(connector: Arc<Connector>) -> PeerLink {
        let (sender, mut receiver) = mpsc::channel::<PeerMessage>(64);
        let known_channel_id = Arc::new(std::sync::RwLock::new(None));
        let known_channel_id_for_task = known_channel_id.clone();
        tokio::spawn(async move {
            while let Some(message) = receiver.recv().await {
                match message {
                    PeerMessage::Prepare {
                        prepare,
                        minimum_delivery,
                        claim,
                        respond_to,
                    } => {
                        if let Some(claim) = claim.as_ref() {
                            *known_channel_id_for_task
                                .write()
                                .expect("known channel id lock poisoned") =
                                Some(claim.channel_id.clone());
                        }
                        let channel_id = known_channel_id_for_task
                            .read()
                            .expect("known channel id lock poisoned")
                            .clone();
                        let result = connector
                            .handle_peer_prepare(prepare, minimum_delivery, claim, channel_id)
                            .await;
                        let _ = respond_to.send(result);
                    }
                    PeerMessage::Flush { claim, respond_to } => {
                        *known_channel_id_for_task
                            .write()
                            .expect("known channel id lock poisoned") =
                            Some(claim.channel_id.clone());
                        let ack = connector.handle_peer_claim(claim);
                        let _ = respond_to.send(ack);
                    }
                }
            }
        });
        PeerLink {
            sender,
            known_channel_id,
        }
    }

    /// Configure the channel this link's counterparty identifies itself by,
    /// ahead of any traffic (issue #424) -- standing in for what a real
    /// peer-wire handshake would establish (#416).
    fn set_known_channel(&self, channel_id: impl Into<String>) {
        *self
            .known_channel_id
            .write()
            .expect("known channel id lock poisoned") = Some(channel_id.into());
    }

    async fn forward(
        &self,
        peer_id: &str,
        prepare: Prepare,
        minimum_delivery: u64,
        claim: Option<WireClaim>,
    ) -> (PacketResponse, ClaimAckOutcome, bool) {
        let (respond_to, receiver) = oneshot::channel();
        if self
            .sender
            .send(PeerMessage::Prepare {
                prepare,
                minimum_delivery,
                claim,
                respond_to,
            })
            .await
            .is_err()
        {
            return (peer_unreachable(peer_id), ClaimAckOutcome::NotSent, false);
        }
        match receiver.await {
            Ok((response, ack)) => (response, ack, true),
            Err(_) => (peer_unreachable(peer_id), ClaimAckOutcome::NotSent, false),
        }
    }

    async fn flush(&self, claim: WireClaim) -> ClaimAckOutcome {
        let (respond_to, receiver) = oneshot::channel();
        if self
            .sender
            .send(PeerMessage::Flush { claim, respond_to })
            .await
            .is_err()
        {
            return ClaimAckOutcome::NotSent;
        }
        receiver.await.unwrap_or(ClaimAckOutcome::NotSent)
    }
}

/// The in-process [`PeerTransport`]: every peer is another [`Connector`] in
/// this process, reached through a [`PeerLink`] rather than a socket. Peers
/// are registered once via [`InProcessPeerTransport::add_peer`] before the
/// transport is shared; the peer map itself is never mutated after that, so
/// reading it on the packet path takes no lock.
#[derive(Default)]
pub struct InProcessPeerTransport {
    peers: HashMap<String, PeerLink>,
}

impl InProcessPeerTransport {
    pub fn new() -> InProcessPeerTransport {
        InProcessPeerTransport::default()
    }

    /// Register `connector` as reachable under `peer_id`, spawning the task
    /// that owns it for the lifetime of this transport.
    pub fn add_peer(&mut self, peer_id: impl Into<String>, connector: Arc<Connector>) {
        self.peers
            .insert(peer_id.into(), PeerLink::connect(connector));
    }

    /// Configure the channel `peer_id`'s link identifies itself by, ahead
    /// of any traffic (issue #424, peer-wire-spec.md §5.3): without this,
    /// the link only learns its counterparty's channel once a claim
    /// happens to ride a frame over it (see `PeerLink::connect`'s own
    /// doc), so the very first delivery before that point cannot be
    /// checked against a ceiling or recorded as exposure. Configuring it
    /// up front (what a real peer-wire handshake -- #416, not yet built --
    /// would establish) closes that gap. Does nothing for a `peer_id` not
    /// yet registered via [`InProcessPeerTransport::add_peer`].
    pub fn set_peer_channel(&mut self, peer_id: &str, channel_id: impl Into<String>) {
        if let Some(link) = self.peers.get(peer_id) {
            link.set_known_channel(channel_id);
        }
    }
}

#[async_trait]
impl PeerTransport for InProcessPeerTransport {
    async fn forward(
        &self,
        peer_id: &str,
        prepare: Prepare,
        minimum_delivery: u64,
        claim: Option<WireClaim>,
    ) -> (PacketResponse, ClaimAckOutcome, bool) {
        match self.peers.get(peer_id) {
            Some(link) => {
                link.forward(peer_id, prepare, minimum_delivery, claim)
                    .await
            }
            None => (peer_unreachable(peer_id), ClaimAckOutcome::NotSent, false),
        }
    }

    async fn flush(&self, peer_id: &str, claim: WireClaim) -> ClaimAckOutcome {
        match self.peers.get(peer_id) {
            Some(link) => link.flush(claim).await,
            None => ClaimAckOutcome::NotSent,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_client::FakeAppClient;
    use crate::clock::TestClock;
    use crate::test_support::{
        answered, envelope_request_data, fulfill_envelope, identity_signer, open_sealed_envelope,
        sealed_envelope_request_data,
    };
    use chrono::{TimeZone, Utc};
    use connector_config::StaticRoute;
    use connector_domain::{claim_digest, derive_condition};
    use connector_signer::{LocalSigner, Signer};

    const FULFILLMENT: [u8; 32] = [7u8; 32];

    fn prepare(destination: &str) -> Prepare {
        Prepare {
            amount: 0,
            // Comfortably after `test_clock()`'s instant (2030-01-01).
            expires_at: Utc.with_ymd_and_hms(2031, 1, 1, 0, 0, 0).unwrap(),
            execution_condition: derive_condition(&FULFILLMENT),
            destination: destination.to_string(),
            data: envelope_request_data(b"hello"),
        }
    }

    /// A `Prepare` addressed to `"g.example.app"`, sealed to
    /// [`identity_signer`]'s identity and carrying `body` (issue #524).
    /// Returns the shared secret alongside, to open the sealed
    /// `Fulfill`/termination-`Reject` this produces.
    fn sealed_prepare(body: &[u8]) -> (Prepare, [u8; 32]) {
        let (data, shared_secret) = sealed_envelope_request_data(body);
        (
            Prepare {
                data,
                ..prepare("g.example.app")
            },
            shared_secret,
        )
    }

    fn test_clock() -> Arc<TestClock> {
        Arc::new(TestClock::new(
            Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
        ))
    }

    #[tokio::test]
    async fn forwards_to_the_registered_peer_and_returns_its_response() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            answered(b"delivered by the peer", Some(FULFILLMENT)),
        );
        let peer = Arc::new(
            Connector::new(
                vec![route],
                vec![],
                app_client,
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_identity_signer(identity_signer()),
        );
        let mut transport = InProcessPeerTransport::new();
        transport.add_peer("peer-b", peer);
        let (sealed, shared_secret) = sealed_prepare(b"hello");

        let (response, ack, reached) = transport.forward("peer-b", sealed, 0, None).await;

        match response {
            PacketResponse::Fulfill(fulfill) => {
                assert_eq!(fulfill.fulfillment, FULFILLMENT);
                assert_eq!(
                    open_sealed_envelope(&shared_secret, &fulfill.data),
                    fulfill_envelope(b"delivered by the peer")
                );
            }
            other => panic!("expected a fulfill, got {other:?}"),
        }
        assert_eq!(ack, ClaimAckOutcome::NotSent);
        assert!(reached);
    }

    #[tokio::test]
    async fn returns_peer_unreachable_for_an_unregistered_peer_id() {
        let transport = InProcessPeerTransport::new();

        let (response, ack, reached) = transport
            .forward("nowhere", prepare("g.example.app"), 0, None)
            .await;

        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "T01");
                assert!(reject.message.contains("nowhere"));
            }
            other => panic!("expected a reject, got {other:?}"),
        }
        assert_eq!(ack, ClaimAckOutcome::NotSent);
        // Never reached: nothing forwarded, so no fee ever belongs to this
        // hop (ADR 0011, peer-wire-spec.md §5.2).
        assert!(!reached);
    }

    #[tokio::test]
    async fn a_reject_originated_by_the_peer_is_relayed_unchanged() {
        let peer = Arc::new(Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let mut transport = InProcessPeerTransport::new();
        transport.add_peer("peer-b", peer);

        let (response, _ack, reached) = transport
            .forward("peer-b", prepare("g.nowhere-on-peer-b"), 0, None)
            .await;

        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "F02");
                assert!(reject.message.contains("g.nowhere-on-peer-b"));
            }
            other => panic!("expected a reject, got {other:?}"),
        }
        // The peer *was* reached -- it answered with its own reject.
        assert!(reached);
    }

    /// Issue #423: a claim piggybacked on a forwarded PREPARE is verified
    /// by the accepting peer independently of the packet itself.
    #[tokio::test]
    async fn a_piggybacked_claim_is_verified_and_acknowledged() {
        let signer = LocalSigner::generate("claim-key");
        let peer = Arc::new(
            Connector::new(
                vec![],
                vec![],
                Arc::new(FakeAppClient::new()),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_channel_verification_key("channel-a", signer.public_key().unwrap()),
        );
        let mut transport = InProcessPeerTransport::new();
        transport.add_peer("peer-b", peer);
        let digest = claim_digest("channel-a", 1, 50);
        let claim = WireClaim {
            channel_id: "channel-a".to_string(),
            nonce: 1,
            cumulative_amount: 50,
            signature: signer.sign(&digest).unwrap(),
        };

        let (response, ack, _reached) = transport
            .forward("peer-b", prepare("g.nowhere"), 0, Some(claim))
            .await;

        // The claim is judged independently of the packet: no route exists
        // for this PREPARE, but the claim it carried is still accepted.
        match response {
            PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "F02"),
            other => panic!("expected a reject, got {other:?}"),
        }
        assert_eq!(ack, ClaimAckOutcome::Accepted);
    }

    #[tokio::test]
    async fn flushing_a_claim_to_an_unregistered_peer_reports_not_sent() {
        let transport = InProcessPeerTransport::new();
        let claim = WireClaim {
            channel_id: "channel-a".to_string(),
            nonce: 1,
            cumulative_amount: 50,
            signature: connector_signer::Signature {
                r: [0u8; 32],
                s: [0u8; 32],
                recovery_id: 0,
            },
        };

        let ack = transport.flush("nowhere", claim).await;

        assert_eq!(ack, ClaimAckOutcome::NotSent);
    }

    /// Establishes that a peer link is owned by exactly one spawned task
    /// rather than shared behind a lock: several concurrent forwards over
    /// the same link are all answered correctly, which would only be
    /// possible if the owning task serialized them itself.
    #[tokio::test]
    async fn a_single_peer_link_answers_several_concurrent_forwards() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(route.handler_url(), answered(b"ok", Some(FULFILLMENT)));
        let peer = Arc::new(
            Connector::new(
                vec![route],
                vec![],
                app_client,
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_identity_signer(identity_signer()),
        );
        let mut transport = InProcessPeerTransport::new();
        transport.add_peer("peer-b", peer);
        let transport = Arc::new(transport);

        let mut handles = Vec::new();
        for _ in 0..8 {
            let transport = transport.clone();
            handles.push(tokio::spawn(async move {
                transport
                    .forward("peer-b", prepare("g.example.app"), 0, None)
                    .await
            }));
        }

        for handle in handles {
            let (response, _ack, _reached) = handle.await.expect("task");
            assert!(matches!(response, PacketResponse::Fulfill(_)));
        }
    }

    /// Contract suite (ADR 0007): [`InProcessPeerTransport`] and
    /// [`crate::NetworkPeerTransport`] uphold the same statement about the
    /// [`PeerTransport`] port -- a registered peer's response comes back
    /// unchanged (fulfill or reject), and an unregistered peer id produces a
    /// `T01` reject -- so nothing above this port can tell which
    /// implementation is in use. Issue #426: both also agree on the
    /// `reached` signal -- `true` for any registered peer's own answer,
    /// `false` only when this transport never delivered the PREPARE at all.
    mod contract {
        use super::*;
        use crate::network_peer_transport::{NetworkPeerTransport, PeerWireServer};
        use std::future::Future;

        /// `deliverer` fulfills any destination under `g.example.app`;
        /// `rejecter` has no routes at all, so it produces the same F02 a
        /// direct client would get. Both are registered with `build`, which
        /// wires each implementation up its own way (a direct `Arc<Connector>`
        /// for the in-process case, a bound [`PeerWireServer`] for the
        /// network case) and returns a transport that can reach both.
        async fn assert_upholds_the_contract<F, Fut>(build: F)
        where
            F: FnOnce(Vec<(&'static str, Arc<Connector>)>) -> Fut,
            Fut: Future<Output = Arc<dyn PeerTransport>>,
        {
            let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
            let app_client = Arc::new(FakeAppClient::new());
            app_client.respond(
                route.handler_url(),
                answered(b"delivered by the peer", Some(FULFILLMENT)),
            );
            let deliverer = Arc::new(
                Connector::new(
                    vec![route],
                    vec![],
                    app_client,
                    Arc::new(InProcessPeerTransport::new()),
                    test_clock(),
                )
                .with_identity_signer(identity_signer()),
            );
            let rejecter = Arc::new(Connector::new(
                vec![],
                vec![],
                Arc::new(FakeAppClient::new()),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));

            let transport = build(vec![("peer-b", deliverer), ("peer-c", rejecter)]).await;
            let (sealed, shared_secret) = sealed_prepare(b"hello");

            let (response, _ack, reached) = transport.forward("peer-b", sealed, 0, None).await;
            match response {
                PacketResponse::Fulfill(fulfill) => {
                    assert_eq!(fulfill.fulfillment, FULFILLMENT);
                    assert_eq!(
                        open_sealed_envelope(&shared_secret, &fulfill.data),
                        fulfill_envelope(b"delivered by the peer")
                    );
                }
                other => panic!("expected a fulfill, got {other:?}"),
            }
            assert!(reached);

            let (response, _ack, reached) = transport
                .forward("peer-c", prepare("g.nowhere-on-peer-c"), 0, None)
                .await;
            match response {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "F02");
                    assert!(reject.message.contains("g.nowhere-on-peer-c"));
                }
                other => panic!("expected a reject, got {other:?}"),
            }
            assert!(reached);

            let (response, _ack, reached) = transport
                .forward("nowhere", prepare("g.example.app"), 0, None)
                .await;
            match response {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "T01");
                    assert!(reject.message.contains("nowhere"));
                }
                other => panic!("expected a reject, got {other:?}"),
            }
            assert!(!reached);
        }

        #[tokio::test]
        async fn in_process_peer_transport_upholds_the_contract() {
            assert_upholds_the_contract(|peers| async move {
                let mut transport = InProcessPeerTransport::new();
                for (peer_id, connector) in peers {
                    transport.add_peer(peer_id, connector);
                }
                Arc::new(transport) as Arc<dyn PeerTransport>
            })
            .await;
        }

        #[tokio::test]
        async fn network_peer_transport_upholds_the_contract() {
            assert_upholds_the_contract(|peers| async move {
                let mut transport = NetworkPeerTransport::new();
                for (peer_id, connector) in peers {
                    let server = PeerWireServer::bind("127.0.0.1:0".parse().unwrap(), connector)
                        .await
                        .unwrap();
                    transport.add_peer(peer_id, server.local_addr());
                    // Detach: the accept loop and per-connection tasks are
                    // independent tokio tasks that keep running for the
                    // test's duration even once `server` is dropped here.
                    drop(server);
                }
                Arc::new(transport) as Arc<dyn PeerTransport>
            })
            .await;
        }
    }
}
