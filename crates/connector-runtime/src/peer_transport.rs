//! The peer transport port: forwards a [`Prepare`] to another connector for
//! the next hop. See `docs/protocol/peer-wire-spec.md` §1.1 -- production
//! peering is one persistent duplex stream per relation; [`InProcessPeerTransport`]
//! here is the in-process stand-in that spec calls out for composing
//! multi-connector tests without a socket. [`crate::NetworkPeerTransport`]
//! (issue #416) is the network implementation of the same port; both are
//! held to the contract suite in this module's `tests::contract`.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::{mpsc, oneshot};

use connector_domain::{PacketResponse, Prepare, Reject, RejectCode};

use crate::connector::Connector;

/// Forwards a [`Prepare`] to the connector reachable at `peer_id` and
/// returns whatever [`PacketResponse`] it produces, unchanged -- a reject
/// originated at the far end reaches the caller exactly as that peer sent
/// it. `minimum_delivery` is the amount the original sender declared must
/// reach the destination (ADR 0010) -- carried alongside `prepare` rather
/// than inside it, and passed to the peer unchanged so every hop enforces
/// it against the same figure.
#[async_trait]
pub trait PeerTransport: Send + Sync {
    async fn forward(
        &self,
        peer_id: &str,
        prepare: Prepare,
        minimum_delivery: u64,
    ) -> PacketResponse;
}

pub(crate) fn peer_unreachable(peer_id: &str) -> PacketResponse {
    PacketResponse::Reject(Reject {
        code: RejectCode::t01_peer_unreachable(),
        triggered_by: String::new(),
        message: format!("peer '{peer_id}' unreachable"),
        data: Vec::new(),
    })
}

/// One forwarded [`Prepare`] handed to a peer's owning task, paired with
/// where to send the answer.
struct PeerRequest {
    prepare: Prepare,
    minimum_delivery: u64,
    respond_to: oneshot::Sender<PacketResponse>,
}

/// A handle to a peer [`Connector`], reachable only by message -- the
/// in-process stand-in for the peer wire's persistent duplex stream. The
/// `Connector` behind a `PeerLink` is owned exclusively by the task spawned
/// in [`PeerLink::connect`]; nothing outside that task ever touches it
/// directly, so there is no lock on this path, on either side of it.
#[derive(Clone)]
struct PeerLink {
    sender: mpsc::Sender<PeerRequest>,
}

impl PeerLink {
    /// Spawn the task that owns `connector` for the lifetime of this link,
    /// answering every forwarded [`Prepare`] by calling
    /// [`Connector::handle_prepare`] -- the same method a direct client
    /// request reaches, so a peer's packet is routed and delivered exactly
    /// like one that arrived over its own client edge.
    fn connect(connector: Arc<Connector>) -> PeerLink {
        let (sender, mut receiver) = mpsc::channel::<PeerRequest>(64);
        tokio::spawn(async move {
            while let Some(PeerRequest {
                prepare,
                minimum_delivery,
                respond_to,
            }) = receiver.recv().await
            {
                let response = connector.handle_prepare(prepare, minimum_delivery).await;
                let _ = respond_to.send(response);
            }
        });
        PeerLink { sender }
    }

    async fn forward(
        &self,
        peer_id: &str,
        prepare: Prepare,
        minimum_delivery: u64,
    ) -> PacketResponse {
        let (respond_to, receiver) = oneshot::channel();
        if self
            .sender
            .send(PeerRequest {
                prepare,
                minimum_delivery,
                respond_to,
            })
            .await
            .is_err()
        {
            return peer_unreachable(peer_id);
        }
        receiver.await.unwrap_or_else(|_| peer_unreachable(peer_id))
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
}

#[async_trait]
impl PeerTransport for InProcessPeerTransport {
    async fn forward(
        &self,
        peer_id: &str,
        prepare: Prepare,
        minimum_delivery: u64,
    ) -> PacketResponse {
        match self.peers.get(peer_id) {
            Some(link) => link.forward(peer_id, prepare, minimum_delivery).await,
            None => peer_unreachable(peer_id),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_client::{AppOutcome, FakeAppClient};
    use crate::clock::TestClock;
    use chrono::{TimeZone, Utc};
    use connector_config::StaticRoute;
    use connector_domain::derive_condition;

    const FULFILLMENT: [u8; 32] = [7u8; 32];

    fn prepare(destination: &str) -> Prepare {
        Prepare {
            amount: 0,
            // Comfortably after `test_clock()`'s instant (2030-01-01).
            expires_at: Utc.with_ymd_and_hms(2031, 1, 1, 0, 0, 0).unwrap(),
            execution_condition: derive_condition(&FULFILLMENT),
            destination: destination.to_string(),
            data: b"hello".to_vec(),
        }
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
            AppOutcome::Delivered {
                data: b"delivered by the peer".to_vec(),
                fulfillment: Some(FULFILLMENT),
            },
        );
        let peer = Arc::new(Connector::new(
            vec![route],
            vec![],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let mut transport = InProcessPeerTransport::new();
        transport.add_peer("peer-b", peer);

        let response = transport
            .forward("peer-b", prepare("g.example.app"), 0)
            .await;

        assert_eq!(
            response,
            PacketResponse::Fulfill(connector_domain::Fulfill {
                fulfillment: FULFILLMENT,
                data: b"delivered by the peer".to_vec(),
            })
        );
    }

    #[tokio::test]
    async fn returns_peer_unreachable_for_an_unregistered_peer_id() {
        let transport = InProcessPeerTransport::new();

        let response = transport
            .forward("nowhere", prepare("g.example.app"), 0)
            .await;

        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "T01");
                assert!(reject.message.contains("nowhere"));
            }
            other => panic!("expected a reject, got {other:?}"),
        }
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

        let response = transport
            .forward("peer-b", prepare("g.nowhere-on-peer-b"), 0)
            .await;

        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "F02");
                assert!(reject.message.contains("g.nowhere-on-peer-b"));
            }
            other => panic!("expected a reject, got {other:?}"),
        }
    }

    /// Establishes that a peer link is owned by exactly one spawned task
    /// rather than shared behind a lock: several concurrent forwards over
    /// the same link are all answered correctly, which would only be
    /// possible if the owning task serialized them itself.
    #[tokio::test]
    async fn a_single_peer_link_answers_several_concurrent_forwards() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            AppOutcome::Delivered {
                data: b"ok".to_vec(),
                fulfillment: Some(FULFILLMENT),
            },
        );
        let peer = Arc::new(Connector::new(
            vec![route],
            vec![],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let mut transport = InProcessPeerTransport::new();
        transport.add_peer("peer-b", peer);
        let transport = Arc::new(transport);

        let mut handles = Vec::new();
        for _ in 0..8 {
            let transport = transport.clone();
            handles.push(tokio::spawn(async move {
                transport
                    .forward("peer-b", prepare("g.example.app"), 0)
                    .await
            }));
        }

        for handle in handles {
            let response = handle.await.expect("task");
            assert!(matches!(response, PacketResponse::Fulfill(_)));
        }
    }

    /// Contract suite (ADR 0007): [`InProcessPeerTransport`] and
    /// [`crate::NetworkPeerTransport`] uphold the same statement about the
    /// [`PeerTransport`] port -- a registered peer's response comes back
    /// unchanged (fulfill or reject), and an unregistered peer id produces a
    /// `T01` reject -- so nothing above this port can tell which
    /// implementation is in use.
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
                AppOutcome::Delivered {
                    data: b"delivered by the peer".to_vec(),
                },
            );
            let deliverer = Arc::new(Connector::new(
                vec![route],
                vec![],
                app_client,
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));
            let rejecter = Arc::new(Connector::new(
                vec![],
                vec![],
                Arc::new(FakeAppClient::new()),
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            ));

            let transport = build(vec![("peer-b", deliverer), ("peer-c", rejecter)]).await;

            let response = transport.forward("peer-b", prepare("g.example.app")).await;
            assert_eq!(
                response,
                PacketResponse::Fulfill(connector_domain::Fulfill {
                    fulfillment: [0u8; 32],
                    data: b"delivered by the peer".to_vec(),
                })
            );

            let response = transport
                .forward("peer-c", prepare("g.nowhere-on-peer-c"))
                .await;
            match response {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "F02");
                    assert!(reject.message.contains("g.nowhere-on-peer-c"));
                }
                other => panic!("expected a reject, got {other:?}"),
            }

            let response = transport.forward("nowhere", prepare("g.example.app")).await;
            match response {
                PacketResponse::Reject(reject) => {
                    assert_eq!(reject.code.as_str(), "T01");
                    assert!(reject.message.contains("nowhere"));
                }
                other => panic!("expected a reject, got {other:?}"),
            }
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
