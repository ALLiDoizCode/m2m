//! The peer wire's network implementation of [`PeerTransport`]
//! (`docs/protocol/peer-wire-spec.md` §1.1: "the production implementation
//! is TLS over TCP"). This ticket implements plain TCP -- the framing and
//! reconnection behavior the port and its contract suite require -- and
//! leaves TLS/identity verification to whichever ticket first needs a peer
//! wire exposed outside a trusted network (peer addressing is still
//! constructed directly in tests, matching the scoping precedent set by
//! issue #415 for peer routes; config-file representation is deferred).
//!
//! [`NetworkPeerTransport`] is the dialing side: one persistent TCP
//! connection per configured peer, redialed lazily. [`PeerWireServer`] is
//! the accepting side: it answers every inbound PREPARE frame by calling
//! [`Connector::handle_prepare`], the same method a direct client request or
//! an in-process peer link reaches -- the packet plane itself never
//! constructs or touches a socket.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use connector_domain::{Fulfill, PacketResponse, Prepare, Reject};

use crate::connector::Connector;
use crate::peer_transport::{peer_unreachable, PeerTransport};
use crate::peer_wire::{
    read_frame, write_frame, Frame, CORRELATION_ID_LEN, FRAME_TYPE_FULFILL, FRAME_TYPE_PREPARE,
    FRAME_TYPE_REJECT,
};

/// A dialed connection to one peer, redialed lazily on first use and again
/// on any failure -- this is the "no operator action" reconnection the
/// issue's acceptance criteria requires: a dropped connection is repaired
/// by the next [`PeerConnection::forward`] call, not by an operator
/// restarting anything.
///
/// The mutex serializes every forward over this connection, matching
/// [`crate::peer_transport::InProcessPeerTransport`]'s own link, which
/// answers every request through one spawned task in the order received --
/// so both implementations uphold the same "one peer, requests answered in
/// turn" behavior the contract suite in [`crate::peer_transport`] tests.
struct PeerConnection {
    peer_id: String,
    addr: SocketAddr,
    stream: Mutex<Option<TcpStream>>,
    next_correlation_id: AtomicU64,
}

impl PeerConnection {
    fn new(peer_id: String, addr: SocketAddr) -> PeerConnection {
        PeerConnection {
            peer_id,
            addr,
            stream: Mutex::new(None),
            next_correlation_id: AtomicU64::new(1),
        }
    }

    fn next_frame(&self, prepare: &Prepare) -> Frame {
        let counter = self.next_correlation_id.fetch_add(1, Ordering::Relaxed);
        let mut correlation_id = [0u8; CORRELATION_ID_LEN];
        correlation_id[8..].copy_from_slice(&counter.to_be_bytes());
        Frame {
            frame_type: FRAME_TYPE_PREPARE,
            correlation_id,
            payload: prepare.encode(),
        }
    }

    async fn forward(&self, prepare: Prepare) -> PacketResponse {
        let frame = self.next_frame(&prepare);
        let mut guard = self.stream.lock().await;

        // Attempt at most twice: once against whatever connection is
        // already held (possibly none), and once more against a freshly
        // dialed connection if the first attempt failed for any reason.
        for _ in 0..2 {
            if guard.is_none() {
                match TcpStream::connect(self.addr).await {
                    Ok(stream) => *guard = Some(stream),
                    Err(_) => return peer_unreachable(&self.peer_id),
                }
            }

            let stream = guard.as_mut().expect("connected above");
            if let Some(response) = send_and_receive(stream, &frame).await {
                return response;
            }
            *guard = None;
        }

        peer_unreachable(&self.peer_id)
    }
}

async fn send_and_receive(stream: &mut TcpStream, frame: &Frame) -> Option<PacketResponse> {
    write_frame(stream, frame).await.ok()?;
    let response = read_frame(stream).await.ok()?;
    if response.correlation_id != frame.correlation_id {
        return None;
    }
    match response.frame_type {
        FRAME_TYPE_FULFILL => Fulfill::decode(&response.payload)
            .ok()
            .map(PacketResponse::Fulfill),
        FRAME_TYPE_REJECT => Reject::decode(&response.payload)
            .ok()
            .map(PacketResponse::Reject),
        _ => None,
    }
}

/// The network [`PeerTransport`]: every peer is reached over a real TCP
/// connection to a configured address rather than an in-process channel.
#[derive(Default)]
pub struct NetworkPeerTransport {
    peers: HashMap<String, PeerConnection>,
}

impl NetworkPeerTransport {
    pub fn new() -> NetworkPeerTransport {
        NetworkPeerTransport::default()
    }

    /// Register `addr` as reachable under `peer_id`. No connection is
    /// opened until the first [`PeerTransport::forward`] call for it.
    pub fn add_peer(&mut self, peer_id: impl Into<String>, addr: SocketAddr) {
        let peer_id = peer_id.into();
        self.peers
            .insert(peer_id.clone(), PeerConnection::new(peer_id, addr));
    }
}

#[async_trait]
impl PeerTransport for NetworkPeerTransport {
    async fn forward(&self, peer_id: &str, prepare: Prepare) -> PacketResponse {
        match self.peers.get(peer_id) {
            Some(connection) => connection.forward(prepare).await,
            None => peer_unreachable(peer_id),
        }
    }
}

/// The accepting side of the peer wire: binds a TCP listener and answers
/// every inbound PREPARE frame, on any connection, by routing it through
/// `connector` -- the same [`Connector::handle_prepare`] a client's own
/// request reaches.
pub struct PeerWireServer {
    local_addr: SocketAddr,
    handles: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

impl PeerWireServer {
    pub async fn bind(
        addr: SocketAddr,
        connector: Arc<Connector>,
    ) -> std::io::Result<PeerWireServer> {
        let listener = TcpListener::bind(addr).await?;
        let local_addr = listener.local_addr()?;

        let handles: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));
        let handles_for_accept_loop = handles.clone();
        let accept_task = tokio::spawn(async move {
            loop {
                let (stream, _) = match listener.accept().await {
                    Ok(accepted) => accepted,
                    Err(_) => return,
                };
                let connector = connector.clone();
                let handle = tokio::spawn(serve_connection(stream, connector));
                handles_for_accept_loop.lock().await.push(handle);
            }
        });
        handles.lock().await.push(accept_task);

        Ok(PeerWireServer {
            local_addr,
            handles,
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Stop accepting new connections and close every connection already
    /// open, simulating this peer becoming unreachable -- used by tests;
    /// production shutdown has no caller yet (connector-bin has no live
    /// runtime to shut down until issue #429).
    pub async fn shutdown(self) {
        for handle in self.handles.lock().await.drain(..) {
            handle.abort();
        }
    }
}

async fn serve_connection(mut stream: TcpStream, connector: Arc<Connector>) {
    loop {
        let frame = match read_frame(&mut stream).await {
            Ok(frame) => frame,
            Err(_) => return,
        };

        // An unrecognized frame type is a version mismatch, not a packet to
        // route around (§1.3) -- close the stream rather than guess.
        if frame.frame_type != FRAME_TYPE_PREPARE {
            return;
        }

        let Ok(prepare) = Prepare::decode(&frame.payload) else {
            return;
        };

        let response_frame = match connector.handle_prepare(prepare).await {
            PacketResponse::Fulfill(fulfill) => Frame {
                frame_type: FRAME_TYPE_FULFILL,
                correlation_id: frame.correlation_id,
                payload: fulfill.encode(),
            },
            PacketResponse::Reject(reject) => Frame {
                frame_type: FRAME_TYPE_REJECT,
                correlation_id: frame.correlation_id,
                payload: reject.encode(),
            },
        };

        if write_frame(&mut stream, &response_frame).await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_client::{AppOutcome, FakeAppClient};
    use crate::clock::TestClock;
    use crate::peer_transport::InProcessPeerTransport;
    use chrono::{TimeZone, Utc};
    use connector_config::StaticRoute;

    fn prepare(destination: &str) -> Prepare {
        Prepare {
            amount: 0,
            expires_at: Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
            execution_condition: [0u8; 32],
            destination: destination.to_string(),
            data: b"hello".to_vec(),
        }
    }

    fn test_clock() -> Arc<TestClock> {
        Arc::new(TestClock::new(
            Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
        ))
    }

    fn localhost() -> SocketAddr {
        "127.0.0.1:0".parse().unwrap()
    }

    #[tokio::test]
    async fn forwards_over_a_real_tcp_connection_and_returns_the_peers_response() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            AppOutcome::Delivered {
                data: b"delivered by the peer".to_vec(),
            },
        );
        let peer = Arc::new(Connector::new(
            vec![route],
            vec![],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let server = PeerWireServer::bind(localhost(), peer).await.unwrap();

        let mut transport = NetworkPeerTransport::new();
        transport.add_peer("peer-b", server.local_addr());

        let response = transport.forward("peer-b", prepare("g.example.app")).await;

        assert_eq!(
            response,
            PacketResponse::Fulfill(Fulfill {
                fulfillment: [0u8; 32],
                data: b"delivered by the peer".to_vec(),
            })
        );
    }

    #[tokio::test]
    async fn returns_peer_unreachable_for_an_unregistered_peer_id() {
        let transport = NetworkPeerTransport::new();

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
    async fn returns_peer_unreachable_when_nothing_is_listening_at_the_configured_address() {
        let mut transport = NetworkPeerTransport::new();
        // Port 0 never accepts a connection, so dialing fails fast.
        transport.add_peer("peer-b", "127.0.0.1:0".parse().unwrap());

        let response = transport.forward("peer-b", prepare("g.example.app")).await;

        match response {
            PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "T01"),
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
        let server = PeerWireServer::bind(localhost(), peer).await.unwrap();

        let mut transport = NetworkPeerTransport::new();
        transport.add_peer("peer-b", server.local_addr());

        let response = transport
            .forward("peer-b", prepare("g.nowhere-on-peer-b"))
            .await;

        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "F02");
                assert!(reject.message.contains("g.nowhere-on-peer-b"));
            }
            other => panic!("expected a reject, got {other:?}"),
        }
    }

    /// Acceptance criterion: a peer that becomes unreachable is detected,
    /// and reconnection is attempted without operator action -- forwarding
    /// resumes as soon as the peer is reachable again, with no call other
    /// than `forward` itself.
    #[tokio::test]
    async fn reconnects_to_a_peer_that_becomes_reachable_again_without_operator_action() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            AppOutcome::Delivered {
                data: b"first".to_vec(),
            },
        );
        let peer = Arc::new(Connector::new(
            vec![route.clone()],
            vec![],
            app_client.clone(),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let server = PeerWireServer::bind(localhost(), peer.clone())
            .await
            .unwrap();
        let addr = server.local_addr();

        let mut transport = NetworkPeerTransport::new();
        transport.add_peer("peer-b", addr);

        let first = transport.forward("peer-b", prepare("g.example.app")).await;
        assert_eq!(
            first,
            PacketResponse::Fulfill(Fulfill {
                fulfillment: [0u8; 32],
                data: b"first".to_vec(),
            })
        );

        server.shutdown().await;

        let while_down = transport.forward("peer-b", prepare("g.example.app")).await;
        match while_down {
            PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "T01"),
            other => panic!("expected a reject while the peer is down, got {other:?}"),
        }

        app_client.respond(
            route.handler_url(),
            AppOutcome::Delivered {
                data: b"second".to_vec(),
            },
        );
        let _server_again = PeerWireServer::bind(addr, peer).await.unwrap();

        let after_recovery = transport.forward("peer-b", prepare("g.example.app")).await;
        assert_eq!(
            after_recovery,
            PacketResponse::Fulfill(Fulfill {
                fulfillment: [0u8; 32],
                data: b"second".to_vec(),
            })
        );
    }
}
