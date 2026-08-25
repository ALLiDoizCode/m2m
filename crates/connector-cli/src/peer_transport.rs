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
use connector_domain::Prepare;
use connector_peer_btp::{BtpPeerTransport, TungsteniteDialer};
use connector_peer_http::{HttpPeerTransport, ReqwestPeerClient};
use connector_runtime::{
    ClaimAckOutcome, Clock, InProcessPeerTransport, PeerForward, PeerTransport, WireClaim,
};

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
/// `signerAddress` of every EVM claim it emits (§4). `signer_solana_public_key`
/// is the Solana counterpart (issue #732/#998) -- the raw ed25519 public key
/// rendered as `senderId`/`signerPublicKey` on a Solana claim -- `None` for a
/// node with no `[settlement.solana]` table, exactly mirroring how
/// `signer_address` is all-zero and unused on a node with no
/// `[settlement.evm]` table, which never produces an EVM claim to render
/// either. Without it, a dial side that DID sign a Solana claim
/// (`ClaimBook::record_fulfillment`, once a `[[peer_channels]]` Solana row is
/// wired) would panic trying to render one -- see `claim_json::encode`'s own
/// doc. `clock` is the one the rest of the node reads, so a claim's
/// `timestamp` and a fulfilment's agree.
///
/// A node with no dialable peering gets a bare [`InProcessPeerTransport`],
/// which is what it held before this function existed: a peer-routed packet
/// is answered `T01 peer unreachable`.
pub(crate) fn build_peer_transport(
    config: &Config,
    signer_address: [u8; 20],
    signer_solana_public_key: Option<[u8; 32]>,
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
        if let Some(public_key) = signer_solana_public_key {
            transport.set_solana_signer_public_key(public_key);
        }
        transport.add_peers_from_config(config.peers(), config.peer_channels());
        transport
    });
    let http = dials(PeerCarriage::Http).then(|| {
        let mut transport = HttpPeerTransport::new(
            Arc::new(ReqwestPeerClient::default()),
            signer_address,
            clock,
        );
        if let Some(public_key) = signer_solana_public_key {
            transport.set_solana_signer_public_key(public_key);
        }
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
        claim: Option<WireClaim>,
    ) -> PeerForward {
        match self.transport_for(peer_id) {
            Some(transport) => transport.forward(peer_id, prepare, claim).await,
            None => self.unreachable.forward(peer_id, prepare, claim).await,
        }
    }

    async fn flush(&self, peer_id: &str, claim: WireClaim) -> ClaimAckOutcome {
        match self.transport_for(peer_id) {
            Some(transport) => transport.flush(peer_id, claim).await,
            None => self.unreachable.flush(peer_id, claim).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    use chrono::{TimeZone, Utc};
    use connector_domain::{PacketResponse, RejectCode};
    use connector_runtime::SystemClock;

    /// A config with `top` (top-level keys, which TOML requires before any
    /// table) and `peers` spliced in, loaded through the real loader --
    /// `PeerConfig` is constructible no other way, and a hand-built one
    /// would be a shape a node can never hold.
    fn config(top: &str, peers: &str) -> (Config, tempfile::TempDir, tempfile::NamedTempFile) {
        let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
        key_file.write_all(&[7u8; 32]).expect("write key file");
        let state_dir = tempfile::tempdir().expect("temp state dir");
        let mut config_file = tempfile::NamedTempFile::new().expect("temp config file");
        write!(
            config_file,
            r#"
client_edge_addr = "127.0.0.1:0"
state_dir = "{state_dir}"
peer_allow_plaintext_endpoints = true
{top}

[signer]
key_file = "{key_file}"

# An EVM `[[peer_channels]]` row needs `[settlement.evm]` (issue #1138):
# that table is where this node's EVM address comes from, and a peer claim
# is redeemed by the channel's on-chain participant.
[settlement.evm]
rpc_url = "http://127.0.0.1:8545"
contract_address = "0x1234567890123456789012345678901234567890"
token_address = "0x49beE1Bca5d15Fb0963117923403F9498119a9Ce"
decimals = 6

[settlement.evm.key]
key_file = "{key_file}"
{peers}
"#,
            state_dir = state_dir.path().display(),
            key_file = key_file.path().display(),
        )
        .expect("write config file");
        let config = Config::load(config_file.path()).expect("load the peering config");
        (config, state_dir, key_file)
    }

    /// One peering, with a `channel_id` derived from `tag` so two peerings
    /// in one config do not collide (`PeerChannelDuplicate`).
    fn peer_block(id: &str, endpoint: &str, tag: &str) -> String {
        format!(
            r#"
[[peers]]
id = "{id}"
endpoint = "{endpoint}"

[peers.credential]
secret = "a-real-peering-secret"

[[peer_channels]]
peer_id = "{id}"
channel_id = "0x{channel}"
counterparty_key = "0x00000000000000000000000000000000000000aa"
chain_id = 31337
token_network = "0x00000000000000000000000000000000000000bb"
"#,
            channel = tag.repeat(64),
        )
    }

    fn prepare(destination: &str) -> Prepare {
        Prepare {
            amount: 100,
            expires_at: Utc.with_ymd_and_hms(2031, 1, 1, 0, 0, 0).unwrap(),
            execution_condition: [0u8; 32],
            destination: destination.to_string(),
            data: Vec::new(),
        }
    }

    fn t01(response: &PacketResponse) -> bool {
        matches!(response, PacketResponse::Reject(reject)
            if reject.code.as_str() == RejectCode::t01_peer_unreachable().as_str())
    }

    /// §2.1: the carriage is the endpoint's scheme, so a `[[peers]]` table
    /// naming both is one transport over two -- dispatched by peer id, with
    /// nothing above the port able to tell which answered.
    #[tokio::test]
    async fn a_config_naming_both_schemes_builds_both_carriages() {
        let (config, _state, _key) = config(
            "",
            &format!(
                "{}{}",
                peer_block("over-btp", "ws://127.0.0.1:1/ilp/btp", "a"),
                peer_block("over-http", "http://127.0.0.1:1/ilp", "b"),
            ),
        );

        let transport = build_peer_transport(&config, [0u8; 20], None, Arc::new(SystemClock));

        // Nothing is listening on port 1, so both answer §2.2's `T01` --
        // the point being that each was *dialed*, on its own carriage,
        // rather than falling through to the unmapped path.
        for peer_id in ["over-btp", "over-http"] {
            let PeerForward {
                response,
                ack,
                reached_peer: reached,
                ..
            } = transport
                .forward(peer_id, prepare("g.example.app"), None)
                .await;
            assert!(t01(&response), "{peer_id}: {response:?}");
            assert_eq!(ack, ClaimAckOutcome::NotSent);
            assert!(!reached, "{peer_id} was never actually reached");
        }
    }

    /// §2.2: a peer id this connector cannot dial rejects **`T01` with the
    /// peer named, never `T00` and never a silent drop** -- the behaviour a
    /// node with no carriage at all has always had, kept for a node that
    /// has one and simply does not dial *this* peer.
    #[tokio::test]
    async fn a_peer_this_connector_never_dials_is_still_answered_t01() {
        let (config, _state, _key) =
            config("", &peer_block("dialed", "ws://127.0.0.1:1/ilp/btp", "a"));
        let transport = build_peer_transport(&config, [0u8; 20], None, Arc::new(SystemClock));

        let PeerForward {
            response,
            reached_peer: reached,
            ..
        } = transport
            .forward("never-configured", prepare("g.example.app"), None)
            .await;

        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "T01");
                assert!(
                    reject.message.contains("never-configured"),
                    "a dial failure names the peer: {}",
                    reject.message
                );
            }
            other => panic!("expected a T01 reject, got {other:?}"),
        }
        assert!(!reached);
    }

    /// A node with only accept-only peerings dials nothing, and holds
    /// exactly what it held before this module existed.
    #[tokio::test]
    async fn a_node_with_nothing_to_dial_answers_t01_from_an_empty_transport() {
        let (config, _state, _key) = config(
            r#"peer_expose = "btp""#,
            r#"
[[peers]]
id = "dials-in"

[peers.credential]
secret = "a-real-peering-secret"

[[peer_channels]]
peer_id = "dials-in"
channel_id = "0xaaaabbbbccccddddeeeeffff00001111aaaabbbbccccddddeeeeffff00001111"
counterparty_key = "0x00000000000000000000000000000000000000aa"
chain_id = 31337
token_network = "0x00000000000000000000000000000000000000bb"
"#,
        );

        let transport = build_peer_transport(&config, [0u8; 20], None, Arc::new(SystemClock));

        let PeerForward {
            response,
            reached_peer: reached,
            ..
        } = transport
            .forward("dials-in", prepare("g.example.app"), None)
            .await;

        assert!(t01(&response), "{response:?}");
        assert!(!reached);
    }
}
