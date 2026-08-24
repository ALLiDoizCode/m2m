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
//! the two apart is [`connector_peer_auth::decide_role`] and nothing else.
//!
//! # What this module does, in order
//!
//! 1. **Decides role, before anything else happens** (§1.5) -- before a
//!    claim is decoded, before a watermark is consulted, before a packet is
//!    routed.
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
//! here, and an interaction arriving on it takes the client path whatever
//! credential it presents. That is not role inference (§1.3): the role is
//! still decided by P1 and P2 alone, and what `expose` decides is *whether
//! this node offers peer handling on that wire at all* -- the same axis
//! `peer_expose` has always been (§2.1).

use std::sync::{Arc, Mutex};

use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};

use connector_btp::ProtocolData;
use connector_config::{PeerCarriage, PeerChannelConfig, PeerConfig, PeerExposure};
use connector_peer_auth::{
    decide_role, present_base64, present_raw, PeerAuthPolicy, PeerAuthRefusal, PeerAuthRefusalLog,
    PEER_AUTH_HEADER, PEER_AUTH_PROTOCOL_ENTRY,
};
use connector_peer_btp::{
    AcceptedClaims, ClaimEnforcementPolicy, PeerAcceptPolicy, PeerCarriageState,
};
use connector_peer_http::{FlushHints, Headers, PeerHttpPolicy, PeerHttpState, PeerRequest};
use connector_runtime::Connector;

/// What a peeked `auth` entry says about a BTP session that is not yet a
/// peer session (§1.2, §1.5).
///
/// A verdict, not a binding: the frame it was read from is **not**
/// consumed, and the session that becomes a peer session is handed that
/// same frame to bind its own role from. Deciding twice over one pure
/// function is free; binding twice would not be, which is why the binding
/// happens in exactly one place ([`connector_peer_btp::PeerSession`]).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BtpAuthVerdict {
    /// P1 and P2 both hold: hand this session, and this frame, to the peer
    /// carriage.
    Peer,
    /// The credential proves nothing (or there is none): the session is a
    /// client and stays one, exactly as before this module existed.
    Client,
    /// More than one `auth` entry on one frame (§1.5): refused, not
    /// resolved -- never the first, never the last, never a concatenation.
    Ambiguous,
}

/// The peer carriages this node exposes, and the one role policy both read.
///
/// One value per node, built once from configuration and shared by every
/// interaction. The [`AcceptedClaims`] ledger inside is deliberately shared
/// between the two carriages (§2.5, I6): a peering relation has one set of
/// watermarks however many paths it has, and a ledger per carriage would be
/// a double-spend surface.
pub struct PeerCarriages {
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
        let auth = Arc::new(PeerAuthPolicy::new(
            peers.iter().map(|peer| (peer.id(), peer.credential())),
            peer_channels.iter().map(PeerChannelConfig::peer_id),
        ));
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
                connector,
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
        // request is a client's and the credential is never read.
        let http = self.http.as_ref()?;

        // §1.5's header-smuggling defence, counted before anything is
        // parsed: refused, not resolved.
        let presented = match present_base64(
            headers
                .get_all(PEER_AUTH_HEADER)
                .into_iter()
                .map(axum::http::HeaderValue::as_bytes),
        ) {
            Ok(presented) => presented,
            Err(_) => return Some(StatusCode::BAD_REQUEST.into_response()),
        };

        let (role, refusal) = decide_role(presented.as_ref(), &self.auth).into_parts();
        self.log_refusal(refusal.as_ref());
        if !role.is_peer() {
            return None;
        }

        let request = PeerRequest {
            headers: peer_headers(headers),
            body: body.to_vec(),
        };
        Some(into_axum(http.handle(request).await))
    }

    /// What a BTP `auth` frame means for a session that is still a client
    /// (§1.2, §1.5). The frame is peeked, never consumed: see
    /// [`BtpAuthVerdict`].
    pub(crate) fn btp_auth_verdict(&self, protocol_data: &[ProtocolData]) -> BtpAuthVerdict {
        if self.btp.is_none() {
            return BtpAuthVerdict::Client;
        }
        let entries: Vec<&[u8]> = protocol_data
            .iter()
            .filter(|entry| entry.name == PEER_AUTH_PROTOCOL_ENTRY)
            .map(|entry| entry.data.as_slice())
            .collect();
        if entries.is_empty() {
            return BtpAuthVerdict::Client;
        }
        let presented = match present_raw(entries) {
            Ok(presented) => presented,
            Err(_) => return BtpAuthVerdict::Ambiguous,
        };
        let (role, refusal) = decide_role(presented.as_ref(), &self.auth).into_parts();
        self.log_refusal(refusal.as_ref());
        if role.is_peer() {
            BtpAuthVerdict::Peer
        } else {
            BtpAuthVerdict::Client
        }
    }

    /// §1.6: a credential naming a configured peer that fails P1 or P2 is
    /// an *assertion*. The interaction is a client and is **not** refused
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
                "peer credential asserted but not proven; the interaction is a client"
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
    use connector_runtime::{FakeAppClient, InProcessPeerTransport, SystemClock};

    fn connector() -> Arc<Connector> {
        Arc::new(Connector::new(
            Vec::new(),
            Vec::new(),
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            Arc::new(SystemClock),
        ))
    }

    const PEER_ID: &str = "store";
    const PEER_SECRET: &str = "a-real-peering-secret";

    /// A real loaded [`connector_config::Config`] carrying one correctly
    /// bound peering, rather than hand-built values: `PeerConfig` and
    /// `PeerChannelConfig` are constructible only by config load precisely
    /// so a value that exists is one the loader would produce, and a test
    /// that forged one would be testing a shape a node can never hold.
    fn peering() -> connector_config::Config {
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

[peers.credential]
secret = "{PEER_SECRET}"

[[peer_channels]]
peer_id = "{PEER_ID}"
channel_id = "0x{channel}"
counterparty_key = "0x00000000000000000000000000000000000000aa"
chain_id = 31337
token_network = "0x00000000000000000000000000000000000000bb"

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
                channel = "11".repeat(32),
            )
            .as_bytes(),
        )
        .expect("write config file");
        connector_config::Config::load(config_file.path()).expect("load the peering config")
    }

    fn carriages(expose: PeerExposure) -> Option<Arc<PeerCarriages>> {
        let config = peering();
        PeerCarriages::from_config(connector(), config.peers(), config.peer_channels(), expose)
    }

    fn credential(peer_id: &str, secret: &str) -> String {
        connector_peer_auth::encode_base64(&connector_peer_auth::PresentedCredential::new(
            peer_id, secret,
        ))
    }

    /// §2.1: `peer_expose = "neither"` -- the default, and the NAT'd
    /// operator -- mounts no peer handling at all, so every interaction on
    /// this node's listeners is a client's.
    #[test]
    fn a_node_that_exposes_nothing_mounts_no_peer_carriage() {
        assert!(carriages(PeerExposure::Neither).is_none());
    }

    /// Expose and dial are separate axes (§2.1), and so is each carriage
    /// from the other: a node exposing only BTP offers no peer handling on
    /// `POST /ilp`.
    #[tokio::test]
    async fn a_carriage_this_node_does_not_expose_never_reads_a_credential() {
        let carriages = carriages(PeerExposure::Btp).expect("btp is exposed");
        let mut headers = HeaderMap::new();
        headers.insert(
            PEER_AUTH_HEADER,
            credential(PEER_ID, PEER_SECRET)
                .parse()
                .expect("header value"),
        );

        assert!(carriages.handle_http(&headers, b"").await.is_none());
    }

    /// §1.5: more than one credential on one request is refused, not
    /// resolved -- never the first, never the last, never a concatenation.
    #[tokio::test]
    async fn two_peer_auth_headers_are_a_400_with_no_ilp_body() {
        let carriages = carriages(PeerExposure::Http).expect("http is exposed");
        let value = credential(PEER_ID, PEER_SECRET);
        let mut headers = HeaderMap::new();
        headers.append(PEER_AUTH_HEADER, value.parse().expect("header value"));
        headers.append(PEER_AUTH_HEADER, value.parse().expect("header value"));

        let response = carriages
            .handle_http(&headers, b"")
            .await
            .expect("an ambiguous credential is answered here, not fallen through");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    /// §1.9's shape, at this seam: a credential that proves nothing is a
    /// client request, and a client request is one this module declines to
    /// answer at all -- so it reaches the client edge's own path and no
    /// peer handling whatsoever.
    #[tokio::test]
    async fn a_credential_that_proves_nothing_falls_through_to_the_client_path() {
        let carriages = carriages(PeerExposure::Both).expect("http is exposed");

        for (case, wrong) in refused_credentials() {
            let mut headers = HeaderMap::new();
            headers.insert(PEER_AUTH_HEADER, wrong.parse().expect("header value"));

            assert!(
                carriages.handle_http(&headers, b"").await.is_none(),
                "{case} must be a client request"
            );
        }
        assert!(carriages
            .handle_http(&HeaderMap::new(), b"")
            .await
            .is_none());
    }

    /// The BTP twin: the same shapes §1.9 enumerates, peeked off a frame
    /// rather than a header set. §9 makes a difference between the
    /// carriages a defect, so both are asserted or neither is.
    #[test]
    fn the_btp_verdict_admits_only_a_credential_that_proves_p1_and_p2() {
        let carriages = carriages(PeerExposure::Both).expect("btp is exposed");
        let entry = |peer_id: &str, secret: &str| ProtocolData {
            name: PEER_AUTH_PROTOCOL_ENTRY.to_string(),
            content_type: connector_btp::CONTENT_TYPE_TEXT,
            data: connector_peer_auth::encode_raw(&connector_peer_auth::PresentedCredential::new(
                peer_id, secret,
            )),
        };
        let proven = entry(PEER_ID, PEER_SECRET);

        assert_eq!(
            carriages.btp_auth_verdict(std::slice::from_ref(&proven)),
            BtpAuthVerdict::Peer
        );
        assert_eq!(carriages.btp_auth_verdict(&[]), BtpAuthVerdict::Client);
        assert_eq!(
            carriages.btp_auth_verdict(&[proven.clone(), proven]),
            BtpAuthVerdict::Ambiguous
        );
        for (case, peer_id, secret) in [
            ("an empty secret", PEER_ID, ""),
            ("a correct peer id with a wrong secret", PEER_ID, "nope"),
            ("an unconfigured peer id", "nobody", PEER_SECRET),
        ] {
            assert_eq!(
                carriages.btp_auth_verdict(&[entry(peer_id, secret)]),
                BtpAuthVerdict::Client,
                "{case} must leave the session a client"
            );
        }
    }

    /// §1.9's wire-presentable cases, shared so the two carriages cannot
    /// drift in *which* shapes they refuse -- the drift §9 warns about.
    fn refused_credentials() -> Vec<(&'static str, String)> {
        vec![
            ("an empty secret", credential(PEER_ID, "")),
            (
                "a correct peer id with a wrong secret",
                credential(PEER_ID, "not-the-secret"),
            ),
            (
                "a valid credential naming an unconfigured peer id",
                credential("nobody", PEER_SECRET),
            ),
        ]
    }
}
