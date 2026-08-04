//! **The dial side, built from configuration** (issue #678's gap 2,
//! `docs/protocol/peer-carriage-spec.md` §2).
//!
//! `BtpPeerTransport` and `HttpPeerTransport` each implement
//! [`PeerTransport`] over the peerings they dial, and each is deliberately
//! blind to the other. A `[[peers]]` table may hold both, though, so
//! something has to hand a packet to the right one -- and that something is
//! [`ConfiguredPeerTransport`], which is one more [`PeerTransport`] and
//! nothing else: it adds no policy, no fee, no ceiling and no claim
//! handling, because every one of those lives above this port (spec I5).
//!
//! # The carriage is the endpoint's scheme, and nothing else (§2.1)
//!
//! `wss://` is BTP, `https://` is ILP-over-HTTP, and -- for a node that
//! opted into `peer_allow_plaintext_endpoints` (issue #678 gap 3) -- `ws://`
//! and `http://` are the same two carriages without TLS. `Config::load` has
//! already decided which, so this module never re-derives it: each
//! carriage's own `PeerRelation::from_config` filters by
//! [`PeerConfig::dial`], and this map is built from the same answer.
//!
//! # A peer with no carriage still answers `T01`
//!
//! An accept-only peering (no `endpoint`) is one this connector never
//! dials: it dials in. A packet routed to one -- which config load already
//! refuses where it can see it (`PeerRouteUndeliverable`) -- must still be
//! **rejected `T01` with the peer named, never `T00` and never a silent
//! drop** (§2.2). That is exactly what an empty [`InProcessPeerTransport`]
//! answers, so it is what an unmapped peer id falls through to, rather than
//! this module minting a second copy of the same reject.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use connector_config::{Config, PeerCarriage};
use connector_domain::{PacketResponse, Prepare};
use connector_peer_btp::{BtpPeerTransport, TungsteniteDialer};
use connector_peer_http::{HttpPeerTransport, ReqwestPeerClient};
use connector_runtime::{ClaimAckOutcome, Clock, InProcessPeerTransport, PeerTransport, WireClaim};

/// One [`PeerTransport`] over however many carriages a node's `[[peers]]`
/// name, dispatching by peer id.
pub(crate) struct ConfiguredPeerTransport {
    btp: Option<BtpPeerTransport>,
    http: Option<HttpPeerTransport>,
    /// Peer id → the carriage its endpoint's scheme selected. A peer id
    /// absent from this map is one this connector cannot dial at all.
    carriage: HashMap<String, PeerCarriage>,
    /// Registered with no peers, so every unmapped peer id gets §2.2's
    /// `T01` from the one place that already produces it.
    unreachable: InProcessPeerTransport,
}

/// The transport a validated [`Config`] describes.
///
/// `signer_address` is this node's own EVM address -- the `senderId` /
/// `signerAddress` of every claim it emits (§4). `clock` is the one the
/// rest of the node reads, so a claim's `timestamp` and a fulfilment's
/// agree.
///
/// A node with no dialable peering gets a bare [`InProcessPeerTransport`],
/// which is what it held before this function existed: a peer-routed packet
/// is answered `T01 peer unreachable`.
pub(crate) fn build_peer_transport(
    config: &Config,
    signer_address: [u8; 20],
    clock: Arc<dyn Clock>,
) -> Arc<dyn PeerTransport> {
    let mut carriage = HashMap::new();
    for peer in config.peers() {
        if let Some(dial) = peer.dial() {
            carriage.insert(peer.id().to_string(), dial);
        }
    }
    if carriage.is_empty() {
        return Arc::new(InProcessPeerTransport::new());
    }

    let dials = |wanted: PeerCarriage| carriage.values().any(|dial| *dial == wanted);
    let btp = dials(PeerCarriage::Btp).then(|| {
        // Ask-only (`TungsteniteDialer::new`) rather than symmetric
        // (`::serving`): §2.3's inbound half of a *dialed* session needs a
        // `PeerCarriageState`, which needs the `Connector` this transport is
        // about to be handed to. Answers still correlate; what a dialed
        // session cannot yet do is serve a request the far side originates
        // on it, which no gate of issue #678 exercises -- the far side of a
        // `wss://` peering reaches this node on its own listener like
        // everybody else.
        let mut transport = BtpPeerTransport::new(
            Arc::new(TungsteniteDialer::new()),
            signer_address,
            Arc::clone(&clock),
        );
        transport.add_peers_from_config(config.peers(), config.peer_channels());
        transport
    });
    let http = dials(PeerCarriage::Http).then(|| {
        let mut transport = HttpPeerTransport::new(
            Arc::new(ReqwestPeerClient::default()),
            signer_address,
            clock,
        );
        transport.add_peers_from_config(config.peers(), config.peer_channels());
        transport
    });

    Arc::new(ConfiguredPeerTransport {
        btp,
        http,
        carriage,
        unreachable: InProcessPeerTransport::new(),
    })
}

impl ConfiguredPeerTransport {
    /// The carriage `peer_id` is dialed on, as a transport. `None` for a
    /// peer this connector does not dial.
    fn transport_for(&self, peer_id: &str) -> Option<&dyn PeerTransport> {
        match self.carriage.get(peer_id)? {
            PeerCarriage::Btp => self.btp.as_ref().map(|btp| btp as &dyn PeerTransport),
            PeerCarriage::Http => self.http.as_ref().map(|http| http as &dyn PeerTransport),
        }
    }
}

#[async_trait]
impl PeerTransport for ConfiguredPeerTransport {
    async fn forward(
        &self,
        peer_id: &str,
        prepare: Prepare,
        minimum_delivery: u64,
        claim: Option<WireClaim>,
    ) -> (PacketResponse, ClaimAckOutcome, bool) {
        match self.transport_for(peer_id) {
            Some(transport) => {
                transport
                    .forward(peer_id, prepare, minimum_delivery, claim)
                    .await
            }
            None => {
                self.unreachable
                    .forward(peer_id, prepare, minimum_delivery, claim)
                    .await
            }
        }
    }

    async fn flush(&self, peer_id: &str, claim: WireClaim) -> ClaimAckOutcome {
        match self.transport_for(peer_id) {
            Some(transport) => transport.flush(peer_id, claim).await,
            None => self.unreachable.flush(peer_id, claim).await,
        }
    }
}
