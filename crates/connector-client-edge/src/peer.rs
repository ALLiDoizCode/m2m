//! **The peer carriages, mounted on this node's own listeners** (issue
//! #678's gap 1, `docs/protocol/peer-carriage-spec.md` §1, §3.1).
//!
//! `connector-peer-btp` and `connector-peer-http` answer a frame and a
//! request respectively and open no port between them -- deliberately, so
//! that everything they decide is provable without a socket. This module is
//! the other half: it binds them to the sockets this crate already serves.
//!
//! # There is no second listener, and that is the design
//!
//! `docs/operators/btp-peer-transport-bringup.md` states it as the
//! replacement for the deleted `peer_wire_addr`: peer carriages *"ride this
//! node's own listeners, not a second socket"*. §1.3 is why -- role MUST NOT
//! be inferred from *"the carriage, the listener, the port, or the bind
//! address"* -- and §3.1 is what makes it cheap: a peer PREPARE is *"the
//! same OER encodings `POST /ilp` already carries"*. So peer traffic arrives
//! on the very `POST /ilp` and `GET /ilp/btp` a client uses, and what tells
//! the two apart is [`connector_peer_btp::role_gate::decide`] and nothing
//! else: the claim on the arrival, resolved against `[[peer_channels]]` and
//! verified against the counterparty key that row configures.
//!
//! # What this module does, in order
//!
//! 1. **Decides role from the arrival's own claim, before anything else
//!    happens** (§1.5) -- before a watermark is consulted, before a packet
//!    is routed, before a fee is taken.
//! 2. **Dispatches a peer-role interaction** into
//!    [`connector_peer_http::PeerHttpState::handle`] or
//!    [`connector_peer_btp::PeerSession`], which own everything downstream.
//! 3. **Leaves a client-role interaction exactly as it was.** Not refused,
//!    not annotated, not routed anywhere new: the client edge's own path,
//!    unchanged, which is §1.6's *"MUST NOT refuse it for the assertion
//!    alone"* and §1.7's *"ignored, not rejected"* in the only form a shared
//!    listener can take.
//!
//! # The two carriages are exposed independently
//!
//! A carriage this node's `peer_expose` does not name is simply not built
//! here, and an arrival on it takes the client path whatever claim it
//! carries. That is not role inference (§1.3): the role is still decided by
//! P2 and P3 alone, and what `expose` decides is *whether this node offers
//! peer handling on that wire at all* -- the same axis `peer_expose` has
//! always been (§2.1).

use std::sync::{Arc, Mutex};

use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};

use connector_btp::ProtocolData;
use connector_config::{PeerCarriage, PeerChannelConfig, PeerConfig, PeerExposure};
use connector_peer_auth::{PeerAuthPolicy, PeerAuthRefusal, PeerAuthRefusalLog};
use connector_peer_btp::{
    claim_json, role_gate, AcceptedClaims, ClaimEnforcementPolicy, PeerAcceptPolicy,
    PeerCarriageState,
};
use connector_peer_http::{FlushHints, Headers, PeerHttpPolicy, PeerHttpState, PeerRequest};
use connector_runtime::Connector;

/// What a peeked frame's claim says about a BTP session that is not yet a
/// peer session (§1.2, §1.5).
///
/// A verdict, not a decision the session inherits: the frame it was read
/// from is **not** consumed, and the session that takes over is handed that
/// same frame and decides its role from it again. Deciding twice over one
/// pure function is free, and the peer session re-decides on every frame
/// after it in any case -- role is a property of the frame.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BtpClaimVerdict {
    /// P2 and P3 both hold: hand this session, and this frame, to the peer
    /// carriage.
    Peer,
    /// The frame carries no claim, or one that proves no peering: the
    /// session is a client's and stays one, exactly as before this module
    /// existed.
    Client,
}

/// The peer carriages this node exposes, and the one role policy both read.
///
/// One value per node, built once from configuration and shared by every
/// interaction. The [`AcceptedClaims`] ledger inside is deliberately shared
/// between the two carriages (§2.5, I6): a peering relation has one set of
/// watermarks however many paths it has, and a ledger per carriage would be
/// a double-spend surface.
pub struct PeerCarriages {
    connector: Arc<Connector>,
    auth: Arc<PeerAuthPolicy>,
    /// `Some` when `peer_expose` names `http`.
    http: Option<Arc<PeerHttpState>>,
    /// `Some` when `peer_expose` names `btp`.
    btp: Option<Arc<PeerCarriageState>>,
    /// §1.6's loud half, rate limited. Held here rather than inside either
    /// carriage because this module is where the decision that produced the
    /// refusal is made -- a peer-role interaction never reaches it, so the
    /// carriages' own logs stay silent by construction.
    refusals: Mutex<PeerAuthRefusalLog>,
}

impl PeerCarriages {
    /// Build the carriages `expose` names over this node's configured
    /// peerings, or `None` when there is no peer handling to mount:
    /// `peer_expose = "neither"` (the default, and the NAT'd operator's
    /// case -- §2.1), or a node with no `[[peers]]` at all, on which every
    /// interaction is a client and nothing can be otherwise.
    #[must_use]
    pub fn from_config(
        connector: Arc<Connector>,
        peers: &[PeerConfig],
        peer_channels: &[PeerChannelConfig],
        expose: PeerExposure,
    ) -> Option<Arc<PeerCarriages>> {
        if expose.is_empty() || peers.is_empty() {
            return None;
        }
        let auth = Arc::new(PeerAuthPolicy::from_config(peers, peer_channels));
        // §2.5/I6: one ledger, both carriages.
        let accepted = Arc::new(AcceptedClaims::new());
        // Issue #883 (B6): one migration state per peering, both carriages
        // -- the same sharing reason `accepted` is shared, so a peering
        // reachable over both is not `observe` on one and `enforce` on the
        // other depending on which carriage a packet happened to arrive on.
        let enforcement = Arc::new(ClaimEnforcementPolicy::from_peers(peers));
        let http = expose.exposes(PeerCarriage::Http).then(|| {
            Arc::new(PeerHttpState::new(
                Arc::clone(&connector),
                Arc::clone(&auth),
                Arc::clone(&accepted),
                Arc::clone(&enforcement),
                Arc::new(FlushHints::new()),
                // The shared listener reading of §1.10: this node serves
                // clients on the same socket, so a failed credential is an
                // ordinary client and never a `401` -- which would make the
                // check an oracle for which peer ids are configured (§1.6).
                PeerHttpPolicy {
                    mandatory_auth: false,
                },
            ))
        });
        let btp = expose.exposes(PeerCarriage::Btp).then(|| {
            Arc::new(PeerCarriageState::new(
                Arc::clone(&connector),
                Arc::clone(&auth),
                accepted,
                enforcement,
                PeerAcceptPolicy {
                    mandatory_auth: false,
                    ..PeerAcceptPolicy::default()
                },
            ))
        });
        Some(Arc::new(PeerCarriages {
            connector,
            auth,
            http,
            btp,
            refusals: Mutex::new(PeerAuthRefusalLog::default()),
        }))
    }

    /// The inbound BTP peer pipeline, for a caller that needs to serve
    /// frames a peer originates on a session **this node dialed** (§2.3).
    /// `None` when `peer_expose` does not name `btp`.
    #[must_use]
    pub fn btp_state(&self) -> Option<Arc<PeerCarriageState>> {
        self.btp.clone()
    }

    /// Answer one `POST /ilp` if -- and only if -- it is a peer
    /// interaction.
    ///
    /// `None` means "this is a client request": the caller runs its own
    /// path, unchanged and unaware. `Some` is either the peer carriage's
    /// answer or §1.5's `400` for an ambiguous credential.
    pub async fn handle_http(&self, headers: &HeaderMap, body: &[u8]) -> Option<Response> {
        // A carriage this node does not expose is not peer handling that
        // failed -- it is peer handling that is not offered here, so the
        // request is a client's and its claim is never read as a peering's.
        let http = self.http.as_ref()?;

        let request = PeerRequest {
            headers: peer_headers(headers),
            body: body.to_vec(),
        };
        // §1.2: the claim on this request, resolved and verified. The peer
        // handler decides again from the same claim -- the decision is a
        // pure function of it, so deciding twice costs nothing and lets
        // that handler stand alone on its own listener (§1.10).
        let claim = connector_peer_http::claim_on(&request);
        let (role, refusal) =
            role_gate::decide(&self.connector, &self.auth, claim.as_ref()).into_parts();
        self.log_refusal(refusal.as_ref());
        if !role.is_peer() {
            return None;
        }

        Some(into_axum(http.handle(request).await))
    }

    /// What a BTP frame's claim means for a session that is still a client
    /// (§1.2, §1.5). The frame is peeked, never consumed: see
    /// [`BtpClaimVerdict`].
    pub(crate) fn btp_claim_verdict(&self, protocol_data: &[ProtocolData]) -> BtpClaimVerdict {
        if self.btp.is_none() {
            return BtpClaimVerdict::Client;
        }
        let claim = claim_json::from_protocol_data(protocol_data)
            .and_then(|raw| claim_json::parse(raw).ok());
        let (role, refusal) =
            role_gate::decide(&self.connector, &self.auth, claim.as_ref()).into_parts();
        self.log_refusal(refusal.as_ref());
        if role.is_peer() {
            BtpClaimVerdict::Peer
        } else {
            BtpClaimVerdict::Client
        }
    }

    /// §1.6: a claim naming a configured peer channel that fails P2 or P3
    /// is an *assertion*. The arrival is a client's and is **not** refused
    /// for the assertion alone -- but a silent downgrade would present to
    /// an operator as "peering configured, nothing peers, no error
    /// anywhere", so the rate-limited event is what stops that.
    fn log_refusal(&self, refusal: Option<&PeerAuthRefusal>) {
        let Some(refusal) = refusal else {
            return;
        };
        let report = self
            .refusals
            .lock()
            .expect("peer auth refusal log poisoned")
            .observe(refusal, crate::now_unix().saturating_mul(1_000));
        if let Some(report) = report {
            tracing::warn!(
                event = report.event,
                peer_id = %report.peer_id,
                unmet = report.unmet.name(),
                suppressed = report.suppressed,
                "a peer channel's claim did not verify; the arrival is a client's"
            );
        }
    }
}

/// An axum [`HeaderMap`] as the carriage's own [`Headers`], multiplicity
/// intact -- §1.5 refuses a second `Toon-Peer-Auth` rather than resolving
/// it, and §6.4 lets `Toon-Flush-Requested` appear once per channel, so a
/// map keyed by name would answer the first question wrong.
///
/// A header whose bytes are not text is dropped rather than refused: §3
/// requires anything it does not name be ignored on receipt, and every
/// header it *does* name is ASCII.
fn peer_headers(headers: &HeaderMap) -> Headers {
    let mut out = Headers::new();
    for (name, value) in headers {
        if let Ok(value) = value.to_str() {
            out.push(name.as_str(), value);
        }
    }
    out
}

/// The carriage's answer, as axum sees it. **The status is the carriage's**
/// (§6.2): `200` regardless of a claim's verdict, and `4xx` only where
/// there is no ILP answer at all.
fn into_axum(response: connector_peer_http::PeerResponse) -> Response {
    let status = StatusCode::from_u16(response.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut out = Response::builder().status(status);
    if response.status == 200 {
        out = out.header(axum::http::header::CONTENT_TYPE, crate::OCTET_STREAM);
    }
    for (name, value) in response.headers.iter() {
        out = out.header(name, value);
    }
    out.body(axum::body::Body::from(response.body))
        .expect("a peer response's headers are carriage-generated ASCII")
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use connector_runtime::{
        ChannelDomain, ClaimSignature, FakeAppClient, InProcessPeerTransport, SystemClock,
        WireClaim,
    };
    use connector_signer::{
        derive_evm_address, evm_balance_proof_digest, EvmBalanceProof, LocalSigner, Signer,
    };

    const PEER_ID: &str = "store";
    const CHAIN_ID: u64 = 31_337;
    const TOKEN_NETWORK: [u8; 20] = [0xbb; 20];

    /// The channel `[[peer_channels]]` binds, in both spellings the fixture
    /// needs: the on-chain bytes a balance proof is signed over, and the
    /// `0x` hex a claim names it by.
    fn channel_bytes() -> [u8; 32] {
        [0x11; 32]
    }

    fn channel_id() -> String {
        format!("0x{}", hex::encode(channel_bytes()))
    }

    /// A connector that holds the peering's channel exactly as
    /// `connector-cli` wires one from `[[peer_channels]]`: the counterparty
    /// key its claims are verified against, and the EIP-712 domain they are
    /// signed under. Without both, every claim is `unknown_channel` and no
    /// interaction could ever take the peer role.
    fn connector_holding(counterparty: [u8; 20]) -> Arc<Connector> {
        Arc::new(
            Connector::new(
                Vec::new(),
                Vec::new(),
                Arc::new(FakeAppClient::new()),
                Arc::new(InProcessPeerTransport::new()),
                Arc::new(SystemClock),
            )
            .with_channel_verification_key(channel_id(), counterparty)
            .with_channel_domain(
                channel_id(),
                ChannelDomain {
                    chain_id: CHAIN_ID,
                    token_network_address: TOKEN_NETWORK,
                },
            )
            .expect("a bytes32 channel id"),
        )
    }

    /// A claim on that channel signed by `signer`, exactly as `ClaimBook`
    /// signs one: ADR 0024's EIP-712 `BalanceProof` digest, with
    /// `lockedAmount`/`locksRoot` as zeros.
    fn sign_claim(signer: &dyn Signer, nonce: u64, cumulative_amount: u64) -> WireClaim {
        let proof = EvmBalanceProof {
            channel_id: channel_bytes(),
            nonce,
            transferred_amount: u128::from(cumulative_amount),
            locked_amount: 0,
            locks_root: [0u8; 32],
            chain_id: CHAIN_ID,
            token_network_address: TOKEN_NETWORK,
        };
        WireClaim {
            channel_id: channel_id(),
            nonce,
            cumulative_amount,
            signature: ClaimSignature::Evm(
                signer
                    .sign(&evm_balance_proof_digest(&proof))
                    .expect("sign"),
            ),
        }
    }

    /// That claim as the §4 JSON both carriages carry, in the two encodings
    /// §1.9 pins: raw on BTP, `base64` in the HTTP header.
    fn claim_json(claim: &WireClaim, signer: &dyn Signer) -> String {
        claim_json::encode(
            claim,
            &derive_evm_address(&signer.public_key().unwrap()),
            None,
            None,
            Some(connector_peer_btp::PeerClaimDomain {
                chain_id: CHAIN_ID,
                token_network: TOKEN_NETWORK,
            }),
            "message-1",
            "2030-01-01T00:00:00.000Z",
        )
    }

    /// A real loaded [`connector_config::Config`] carrying one correctly
    /// bound peering, rather than hand-built values: `PeerConfig` and
    /// `PeerChannelConfig` are constructible only by config load precisely
    /// so a value that exists is one the loader would produce, and a test
    /// that forged one would be testing a shape a node can never hold.
    ///
    /// `counterparty` is written into the `[[peer_channels]]` row, so the
    /// key the config binds and the key a fixture signs with are one fact
    /// rather than two that have to agree.
    fn peering(counterparty: [u8; 20]) -> connector_config::Config {
        let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
        std::io::Write::write_all(&mut key_file, &[7u8; 32]).expect("write key file");
        let state_dir = tempfile::tempdir().expect("temp state dir");
        let mut config_file = tempfile::NamedTempFile::new().expect("temp config file");
        std::io::Write::write_all(
            &mut config_file,
            format!(
                r#"
client_edge_addr = "127.0.0.1:0"
state_dir = "{state_dir}"

[signer]
key_file = "{key_file}"

[[peers]]
id = "{PEER_ID}"
endpoint = "wss://peer.example:443/ilp/btp"

[[peer_channels]]
peer_id = "{PEER_ID}"
channel_id = "{channel}"
counterparty_key = "0x{counterparty}"
chain_id = {CHAIN_ID}
token_network = "0x{token_network}"

# An EVM `[[peer_channels]]` row needs `[settlement.evm]` (issue #1138):
# a peer claim is redeemed by the channel's on-chain participant, and that
# address is this table's key.
[settlement.evm]
rpc_url = "http://127.0.0.1:8545"
contract_address = "0x1234567890123456789012345678901234567890"
token_address = "0x49beE1Bca5d15Fb0963117923403F9498119a9Ce"
decimals = 6

[settlement.evm.key]
key_file = "{key_file}"
"#,
                state_dir = state_dir.path().display(),
                key_file = key_file.path().display(),
                channel = channel_id(),
                counterparty = hex::encode(counterparty),
                token_network = hex::encode(TOKEN_NETWORK),
            )
            .as_bytes(),
        )
        .expect("write config file");
        connector_config::Config::load(config_file.path()).expect("load the peering config")
    }

    /// The carriages `expose` names, over a peering whose counterparty is
    /// `payer` -- so a claim `payer` signs is the one thing that can take
    /// the peer role here.
    fn carriages(expose: PeerExposure, payer: &dyn Signer) -> Option<Arc<PeerCarriages>> {
        let counterparty = derive_evm_address(&payer.public_key().unwrap());
        let config = peering(counterparty);
        PeerCarriages::from_config(
            connector_holding(counterparty),
            config.peers(),
            config.peer_channels(),
            expose,
        )
    }

    fn claim_headers(json: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            connector_btp::CLAIM_HEADER,
            connector_peer_http::headers::claim_header_value(json)
                .parse()
                .expect("header value"),
        );
        headers
    }

    fn claim_entry(json: &str) -> ProtocolData {
        ProtocolData {
            name: connector_btp::CLAIM_PROTOCOL.to_string(),
            content_type: connector_btp::CONTENT_TYPE_TEXT,
            data: json.as_bytes().to_vec(),
        }
    }

    /// §2.1: `peer_expose = "neither"` -- the default, and the NAT'd
    /// operator -- mounts no peer handling at all, so every interaction on
    /// this node's listeners is a client's.
    #[test]
    fn a_node_that_exposes_nothing_mounts_no_peer_carriage() {
        let payer = LocalSigner::generate("payer");
        assert!(carriages(PeerExposure::Neither, &payer).is_none());
    }

    /// Expose and dial are separate axes (§2.1), and so is each carriage
    /// from the other: a node exposing only BTP offers no peer handling on
    /// `POST /ilp`, whatever claim a request carries.
    #[tokio::test]
    async fn a_carriage_this_node_does_not_expose_never_reads_a_claim_as_a_peerings() {
        let payer = LocalSigner::generate("payer");
        let carriages = carriages(PeerExposure::Btp, &payer).expect("btp is exposed");
        let proven = claim_json(&sign_claim(&payer, 1, 500), &payer);

        assert!(carriages
            .handle_http(&claim_headers(&proven), b"")
            .await
            .is_none());
    }

    /// §1.4, ADR 0060: a `Toon-Peer-Auth` header is **ignored**, never
    /// refused. A request still setting one is read exactly as one that does
    /// not -- the claim decides, and only the claim -- which is what lets the
    /// two ends of a peering be upgraded in either order.
    #[tokio::test]
    async fn a_lingering_peer_auth_header_is_ignored_and_decides_nothing() {
        let payer = LocalSigner::generate("payer");
        let carriages = carriages(PeerExposure::Http, &payer).expect("http is exposed");
        let proven = claim_json(&sign_claim(&payer, 1, 500), &payer);
        let stale = "eyJwZWVySWQiOiJzdG9yZSIsInNlY3JldCI6ImFueXRoaW5nIn0=";

        let mut with_claim = claim_headers(&proven);
        with_claim.insert("toon-peer-auth", stale.parse().expect("header value"));
        let mut without_claim = HeaderMap::new();
        without_claim.insert("toon-peer-auth", stale.parse().expect("header value"));

        assert!(
            carriages.handle_http(&with_claim, b"").await.is_some(),
            "the header changes nothing about a request whose claim proves the peering"
        );
        assert!(
            carriages.handle_http(&without_claim, b"").await.is_none(),
            "and nothing about one whose claim does not: it is a client request"
        );
    }

    /// §1.9's shape, at this seam: a claim that proves no peering is a
    /// client request, and a client request is one this module declines to
    /// answer at all -- so it reaches the client edge's own path and no peer
    /// handling whatsoever.
    #[tokio::test]
    async fn a_claim_that_proves_no_peering_falls_through_to_the_client_path() {
        let payer = LocalSigner::generate("payer");
        let carriages = carriages(PeerExposure::Both, &payer).expect("http is exposed");

        for (case, json) in refused_claims(&payer) {
            assert!(
                carriages
                    .handle_http(&claim_headers(&json), b"")
                    .await
                    .is_none(),
                "{case} must be a client request"
            );
        }
        assert!(carriages
            .handle_http(&HeaderMap::new(), b"")
            .await
            .is_none());
    }

    /// The BTP twin: the same shapes §1.9 enumerates, peeked off a frame
    /// rather than a header set. §9 makes a difference between the carriages
    /// a defect, so both are asserted or neither is.
    #[test]
    fn the_btp_verdict_admits_only_a_frame_whose_claim_proves_p2_and_p3() {
        let payer = LocalSigner::generate("payer");
        let carriages = carriages(PeerExposure::Both, &payer).expect("btp is exposed");
        let proven = claim_entry(&claim_json(&sign_claim(&payer, 1, 500), &payer));

        assert_eq!(
            carriages.btp_claim_verdict(std::slice::from_ref(&proven)),
            BtpClaimVerdict::Peer
        );
        assert_eq!(carriages.btp_claim_verdict(&[]), BtpClaimVerdict::Client);
        for (case, json) in refused_claims(&payer) {
            assert_eq!(
                carriages.btp_claim_verdict(&[claim_entry(&json)]),
                BtpClaimVerdict::Client,
                "{case} must leave the frame a client frame"
            );
        }
    }

    /// §1.9's wire-presentable cases, shared so the two carriages cannot
    /// drift in *which* shapes they refuse -- the drift §9 warns about.
    fn refused_claims(payer: &dyn Signer) -> Vec<(&'static str, String)> {
        let stranger = LocalSigner::generate("stranger");
        vec![
            (
                "a claim whose signature does not recover to the row's key",
                claim_json(&sign_claim(&stranger, 1, 500), &stranger),
            ),
            (
                "a claim on a channel no [[peer_channels]] row binds",
                claim_json(
                    &WireClaim {
                        channel_id: format!("0x{:064x}", 99),
                        ..sign_claim(payer, 1, 500)
                    },
                    payer,
                ),
            ),
            (
                "a claim header that is not a claim",
                "not a claim".to_string(),
            ),
        ]
    }
}
