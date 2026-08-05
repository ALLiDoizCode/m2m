//! **Dial**: reaching a peer at its `wss://` endpoint
//! (`peer-carriage-spec.md` §2, §3, §6), behind the
//! [`connector_runtime::PeerTransport`] port.
//!
//! Which carriage this connector dials a given peer on is decided
//! **solely by the scheme of that peer's configured `endpoint`** (§2.1):
//! `wss://` is this crate, `https://` is issue #728. A peer with no
//! endpoint is accept-only and never appears here -- it dials us
//! ([`crate::accept`]).
//!
//! [`BtpPeerTransport`] implements the port, so everything above it --
//! `Connector`'s peer forwarding, `ClaimBook`, fees, routing -- cannot tell
//! which carriage delivered a packet (spec I5). The port's own contract
//! suite is what holds that: this implementation joins it as an arm rather
//! than asserting anything of its own about `T01` or about relaying a
//! peer's answer unchanged.
//!
//! # What is a dial failure, and what it must never be
//!
//! Whether the remote actually exposes what we dial is **not** locally
//! detectable (§2.2), so it cannot be a load-time error. It surfaces as an
//! ordinary dial failure with the peer id and the attempted endpoint
//! named, and packets routed to that peer reject **`T01`** -- never `T00`,
//! and never a silent drop.
//!
//! # Byte-identical retransmission (§6.3)
//!
//! A payer whose claim went unacknowledged must retransmit the latest
//! pending claim, **byte-identical if nothing has changed**, because a
//! payee is required to answer such a retransmission `accepted` rather
//! than `nonce_not_advancing`. The claim JSON of §4 carries a `timestamp`,
//! so re-rendering it with a fresh `now` would make every retransmission a
//! *different* claim at the same nonce -- which §6.3 says a payee MUST
//! refuse. This transport therefore caches the exact string it emitted for
//! a `(channel, nonce, cumulative, signature)` and reuses it until that
//! claim is acknowledged or superseded.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use connector_btp::{
    BtpFrame, BtpSessionHandle, OriginateError, ProtocolData, AUTH_PROTOCOL, BTP_ERROR,
    CONTENT_TYPE_TEXT,
};
use connector_config::{PeerCarriage, PeerChannelConfig, PeerConfig};
use connector_domain::{Fulfill, PacketResponse, Prepare, Reject, RejectCode};
use connector_peer_auth::{encode_raw, PresentedCredential};
use connector_runtime::{ClaimAckOutcome, Clock, PeerTransport, WireClaim};
use url::Url;

use crate::claim_json::{self, PeerClaimDomain};
use crate::{ack, fields};

/// Why a peer could not be reached. Carries the peer id and the endpoint
/// that was attempted, because §2.2 requires a dial failure name both
/// rather than becoming a runtime mystery.
#[derive(Debug, PartialEq, Eq)]
pub struct DialError {
    pub peer_id: String,
    pub endpoint: String,
    pub reason: String,
}

impl std::fmt::Display for DialError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "could not dial peer '{}' at {}: {}",
            self.peer_id, self.endpoint, self.reason
        )
    }
}

/// Establishes the websocket underneath a dialed peering.
///
/// A port of its own so the carriage's *behaviour* -- the frames, the
/// timeouts, the ack handling, the retransmission cache -- is provable
/// without TLS, a listener or a port number, and so the socket library is
/// swappable without touching any of it. The implementation returns the
/// [`BtpSessionHandle`] the session's read loop resolves answers through;
/// it owns the pump in both directions and nothing above it reads a socket.
#[async_trait]
pub trait PeerDialer: Send + Sync {
    async fn dial(&self, peer_id: &str, endpoint: &Url) -> Result<BtpSessionHandle, DialError>;
}

/// One peering relation, as the dial side needs it.
///
/// Per **relation**, never per connection (§2.5): the timeouts, the
/// credential and the claim domains all belong to the relation, and
/// splitting them per connection is a double-spend surface.
#[derive(Debug, Clone)]
pub struct PeerRelation {
    peer_id: String,
    endpoint: Url,
    credential: PresentedCredential,
    /// Canonical EVM channel id → the EIP-712 domain its claims are signed
    /// under, from that peering's EVM-shaped `[[peer_channels]]` rows.
    domains: HashMap<String, PeerClaimDomain>,
    /// Solana channel account → the program id its claims render under
    /// (issue #759), from that peering's Solana-shaped `[[peer_channels]]`
    /// rows. Never canonicalized the way an EVM channel id is --
    /// `claim_json::canonical_evm_channel_id` is a no-op on a base58
    /// account (it only rewrites 66-char `0x`-hex), so a Solana claim's
    /// `channel_id` is used as the lookup key verbatim.
    solana_program_ids: HashMap<String, String>,
    peer_answer_timeout: Duration,
    claim_ack_timeout: Duration,
}

impl PeerRelation {
    /// The relation for `peer`, or `None` when this connector does not
    /// dial it over BTP -- an accept-only peering (no endpoint) or one
    /// whose endpoint's scheme selects the HTTP carriage (§2.1).
    #[must_use]
    pub fn from_config(peer: &PeerConfig, channels: &[PeerChannelConfig]) -> Option<PeerRelation> {
        if peer.dial() != Some(PeerCarriage::Btp) {
            return None;
        }
        let endpoint = peer.endpoint()?.clone();
        let mine = channels
            .iter()
            .filter(|channel| channel.peer_id() == peer.id());
        let domains = mine
            .clone()
            .filter_map(|channel| match channel {
                PeerChannelConfig::Evm(evm) => Some((
                    claim_json::canonical_evm_channel_id(evm.channel_id()),
                    PeerClaimDomain {
                        chain_id: evm.chain_id(),
                        token_network: evm.token_network(),
                    },
                )),
                PeerChannelConfig::Solana(_) => None,
            })
            .collect();
        let solana_program_ids = mine
            .filter_map(|channel| match channel {
                PeerChannelConfig::Solana(solana) => Some((
                    solana.channel_account().to_string(),
                    solana.program_id().to_string(),
                )),
                PeerChannelConfig::Evm(_) => None,
            })
            .collect();
        Some(PeerRelation {
            peer_id: peer.id().to_string(),
            endpoint,
            credential: PresentedCredential::new(peer.id(), peer.credential().secret()),
            domains,
            solana_program_ids,
            peer_answer_timeout: Duration::from_millis(peer.peer_answer_timeout_ms()),
            claim_ack_timeout: Duration::from_millis(peer.claim_ack_timeout_ms()),
        })
    }

    /// A relation assembled by hand -- for a caller that holds no
    /// `Config`, and for tests.
    #[must_use]
    pub fn new(
        peer_id: impl Into<String>,
        endpoint: Url,
        credential: PresentedCredential,
        domains: HashMap<String, PeerClaimDomain>,
        solana_program_ids: HashMap<String, String>,
        peer_answer_timeout: Duration,
        claim_ack_timeout: Duration,
    ) -> PeerRelation {
        PeerRelation {
            peer_id: peer_id.into(),
            endpoint,
            credential,
            solana_program_ids,
            domains,
            peer_answer_timeout,
            claim_ack_timeout,
        }
    }
}

/// What a relation's claim exchange remembers between frames.
#[derive(Default)]
struct Pending {
    /// Canonical channel id → the claim last emitted on it and the exact
    /// JSON string it went out as (§6.3's byte-identical retransmission).
    emitted: HashMap<String, (WireClaim, String)>,
}

struct RelationState {
    relation: PeerRelation,
    /// The dialed session, established lazily and re-established after a
    /// failure. A `tokio::sync::Mutex` because establishing one is an
    /// `await`, and holding it across that await is exactly what stops
    /// eight concurrent forwards opening eight sessions to one peer.
    session: tokio::sync::Mutex<Option<BtpSessionHandle>>,
    pending: Mutex<Pending>,
}

/// The BTP peer carriage's dial side: one [`PeerTransport`] over however
/// many `wss://` peerings this connector dials.
pub struct BtpPeerTransport {
    dialer: Arc<dyn PeerDialer>,
    /// This connector's own EVM address -- the `senderId`/`signerAddress`
    /// of every claim it emits (§4). One per node, because a claim's
    /// signer is `ClaimBook`'s signer.
    signer_address: [u8; 20],
    /// This connector's own ed25519 public key -- the Solana counterpart
    /// of `signer_address` (issue #742), rendered as `senderId`/
    /// `signerPublicKey` on a claim `ClaimBook` signed through its
    /// `solana_signer`. `None` until something configures one with
    /// [`Self::set_solana_signer_public_key`]; no `[[peer_channels]]` row
    /// carries a Solana identity yet, so today that is always -- this
    /// mirrors `ClaimBook::solana_signer`'s own "unconfigured means no
    /// claim" contract at the transport's edge of it: a claim this
    /// connector never had a Solana identity to sign never had one to
    /// render either.
    solana_signer_public_key: Option<[u8; 32]>,
    clock: Arc<dyn Clock>,
    relations: HashMap<String, RelationState>,
}

impl BtpPeerTransport {
    #[must_use]
    pub fn new(
        dialer: Arc<dyn PeerDialer>,
        signer_address: [u8; 20],
        clock: Arc<dyn Clock>,
    ) -> Self {
        BtpPeerTransport {
            dialer,
            signer_address,
            solana_signer_public_key: None,
            clock,
            relations: HashMap::new(),
        }
    }

    /// Configure this connector's own ed25519 identity for rendering an
    /// outbound Solana peer claim (issue #742) -- the Solana counterpart
    /// of the `signer_address` [`Self::new`] takes for EVM. Call before any
    /// packet reaches this transport; nothing here re-renders a claim
    /// already cached in [`Pending`].
    pub fn set_solana_signer_public_key(&mut self, public_key: [u8; 32]) {
        self.solana_signer_public_key = Some(public_key);
    }

    /// Register a peering this connector dials over BTP. Relations are
    /// added before the transport is shared; the map itself is never
    /// mutated afterwards, so reading it on the packet path takes no lock.
    pub fn add_peer(&mut self, relation: PeerRelation) {
        self.relations.insert(
            relation.peer_id.clone(),
            RelationState {
                relation,
                session: tokio::sync::Mutex::new(None),
                pending: Mutex::new(Pending::default()),
            },
        );
    }

    /// Every `wss://` peering in a loaded config, with its channels.
    pub fn add_peers_from_config(&mut self, peers: &[PeerConfig], channels: &[PeerChannelConfig]) {
        for peer in peers {
            if let Some(relation) = PeerRelation::from_config(peer, channels) {
                self.add_peer(relation);
            }
        }
    }

    /// The session for `peer_id`, dialing and authenticating one if there
    /// is none.
    async fn session(&self, state: &RelationState) -> Result<BtpSessionHandle, DialError> {
        let mut slot = state.session.lock().await;
        if let Some(handle) = slot.as_ref() {
            return Ok(handle.clone());
        }
        let handle = self
            .dialer
            .dial(&state.relation.peer_id, &state.relation.endpoint)
            .await?;

        // §1.4: the credential rides the session's first MESSAGE as the
        // `auth` protocolData entry, raw UTF-8 JSON -- the same entry, in
        // the same shape, a client already sends. What differs is only
        // that the far side *evaluates* P1 and P2 against it.
        let auth = ProtocolData {
            name: AUTH_PROTOCOL.to_string(),
            content_type: CONTENT_TYPE_TEXT,
            data: encode_raw(&state.relation.credential),
        };
        let answered = tokio::time::timeout(
            state.relation.peer_answer_timeout,
            handle.send_message(&[auth], &[]),
        )
        .await;
        match answered {
            Ok(Ok(frame)) if frame.frame_type != BTP_ERROR => {
                *slot = Some(handle.clone());
                Ok(handle)
            }
            other => Err(DialError {
                peer_id: state.relation.peer_id.clone(),
                endpoint: state.relation.endpoint.to_string(),
                reason: match other {
                    Ok(Ok(_)) => "the peer refused our credential".to_string(),
                    Ok(Err(OriginateError::SessionGone)) => "the session closed".to_string(),
                    Ok(Err(OriginateError::Timeout)) | Err(_) => {
                        "the peer did not answer the auth frame".to_string()
                    }
                },
            }),
        }
    }

    /// Forget the session after a failure, so the next packet dials a new
    /// one rather than writing into a socket nobody reads.
    async fn drop_session(&self, state: &RelationState) {
        *state.session.lock().await = None;
    }

    /// The claim entry for `claim`, reusing the exact bytes already
    /// emitted for it if this is a retransmission (§6.3).
    fn claim_entry(&self, state: &RelationState, claim: &WireClaim) -> ProtocolData {
        let channel_id = claim_json::canonical_evm_channel_id(&claim.channel_id);
        let mut pending = state.pending.lock().expect("pending claims lock poisoned");
        if let Some((emitted, json)) = pending.emitted.get(&channel_id) {
            if emitted == claim {
                return claim_json::protocol_data(json);
            }
        }
        // A channel with no `[[peer_channels]]` row here rides without a
        // domain: the fields are optional, and a *zero* domain would be a
        // structurally invalid claim the peer could not even read a verdict
        // out of. Omitted, the peer judges it against its own record and
        // answers `unknown_channel`, which is the right answer to a channel
        // neither end has bound.
        let domain = state.relation.domains.get(&channel_id).copied();
        // Unlike `domain`, a Solana channel with no matching row has no
        // "ride without it" fallback -- `programId` is a required wire
        // field (`encode`'s own doc), so a Solana claim reaching here for
        // an unconfigured channel is a caller bug `encode` panics on,
        // exactly as it does for a missing signing identity.
        let solana_program_id = state.relation.solana_program_ids.get(&channel_id);
        let json = claim_json::encode(
            claim,
            &self.signer_address,
            self.solana_signer_public_key.as_ref(),
            solana_program_id.map(String::as_str),
            domain,
            &format!("{channel_id}:{}", claim.nonce),
            &self
                .clock
                .now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string(),
        );
        let entry = claim_json::protocol_data(&json);
        pending.emitted.insert(channel_id, (claim.clone(), json));
        entry
    }

    /// An acknowledged claim is no longer pending, so the next claim on
    /// that channel is rendered fresh rather than retransmitted.
    fn claim_acknowledged(&self, state: &RelationState, claim: &WireClaim) {
        state
            .pending
            .lock()
            .expect("pending claims lock poisoned")
            .emitted
            .remove(&claim_json::canonical_evm_channel_id(&claim.channel_id));
    }
}

/// §2.2, §5.1 of `peer-wire-spec.md`: a peer this connector could not
/// reach rejects `T01`. Never `T00`, and never a silent drop.
fn peer_unreachable(peer_id: &str) -> PacketResponse {
    PacketResponse::Reject(Reject {
        code: RejectCode::t01_peer_unreachable(),
        triggered_by: String::new(),
        message: format!("peer '{peer_id}' unreachable"),
        data: Vec::new(),
        accumulated_cost: 0,
    })
}

/// Read a peer's answer back off the RESPONSE frame: the packet's own
/// verdict from `ilpPacket`, and a REJECT's running cost from the
/// `toon-accumulated-cost` entry the client edge already uses (§5.2).
fn decode_answer(frame: &BtpFrame) -> Option<PacketResponse> {
    if let Ok(fulfill) = Fulfill::decode(&frame.ilp_packet) {
        return Some(PacketResponse::Fulfill(fulfill));
    }
    let mut reject = Reject::decode(&frame.ilp_packet).ok()?;
    reject.accumulated_cost = fields::accumulated_cost(&frame.protocol_data);
    Some(PacketResponse::Reject(reject))
}

#[async_trait]
impl PeerTransport for BtpPeerTransport {
    async fn forward(
        &self,
        peer_id: &str,
        prepare: Prepare,
        minimum_delivery: u64,
        claim: Option<WireClaim>,
    ) -> (PacketResponse, ClaimAckOutcome, bool) {
        let Some(state) = self.relations.get(peer_id) else {
            return (peer_unreachable(peer_id), ClaimAckOutcome::NotSent, false);
        };
        let handle = match self.session(state).await {
            Ok(handle) => handle,
            Err(error) => {
                tracing::warn!(%error, "peer dial failed");
                return (peer_unreachable(peer_id), ClaimAckOutcome::NotSent, false);
            }
        };

        let mut entries = Vec::new();
        if let Some(claim) = claim.as_ref() {
            entries.push(self.claim_entry(state, claim));
        }
        // §5.1: the sender's declaration, re-emitted **unchanged** on this
        // outbound hop. It is the one carriage-layer field that propagates
        // rather than being re-derived (§8.3), and crossing carriages must
        // not alter it.
        entries.extend(fields::minimum_delivery_protocol_data(minimum_delivery));

        // §8.1: `data` rides byte-for-byte unchanged. `Prepare::encode` is
        // the same OER encoding every other carriage puts on a wire, and
        // nothing here re-wraps, pads or truncates a payload it holds no
        // key for.
        let answered = tokio::time::timeout(
            state.relation.peer_answer_timeout,
            handle.send_message(&entries, &prepare.encode()),
        )
        .await;

        let frame = match answered {
            Ok(Ok(frame)) => frame,
            _ => {
                self.drop_session(state).await;
                return (peer_unreachable(peer_id), ClaimAckOutcome::NotSent, false);
            }
        };
        // An ERROR means the peer could not decode our frame: there is no
        // ILP answer at all, so nothing was forwarded and no fee of ours
        // belongs on the reject that goes back (ADR 0011).
        if frame.frame_type == BTP_ERROR {
            tracing::warn!(
                peer_id,
                reason = %String::from_utf8_lossy(&frame.ilp_packet),
                "peer answered a forwarded PREPARE with a BTP ERROR"
            );
            return (peer_unreachable(peer_id), ClaimAckOutcome::NotSent, false);
        }

        let ack = self.read_ack(state, claim.as_ref(), &frame);
        match decode_answer(&frame) {
            Some(response) => (response, ack, true),
            None => {
                tracing::warn!(peer_id, "peer answer carried no decodable ILP packet");
                (peer_unreachable(peer_id), ack, false)
            }
        }
    }

    async fn flush(&self, peer_id: &str, claim: WireClaim) -> ClaimAckOutcome {
        let Some(state) = self.relations.get(peer_id) else {
            return ClaimAckOutcome::NotSent;
        };
        let handle = match self.session(state).await {
            Ok(handle) => handle,
            Err(error) => {
                tracing::warn!(%error, "peer dial failed");
                return ClaimAckOutcome::NotSent;
            }
        };

        // FLUSH (§3): a **TRANSFER (type 7)** whose `amount` is the
        // claim's new cumulative, carrying the claim in
        // `payment-channel-claim` and **no `ilpPacket`**.
        let entry = self.claim_entry(state, &claim);
        let answered = tokio::time::timeout(
            state.relation.claim_ack_timeout,
            handle.send_transfer(claim.cumulative_amount, &[entry]),
        )
        .await;

        let frame = match answered {
            Ok(Ok(frame)) => frame,
            // §6.3 on expiry: the claim is **not acknowledged**. The
            // peering is not torn down, no new claim is minted at a higher
            // nonce for the same cumulative, and the packet's value stays
            // in this connector's owed projection.
            _ => {
                self.drop_session(state).await;
                return ClaimAckOutcome::NotSent;
            }
        };
        if frame.frame_type == BTP_ERROR {
            return ClaimAckOutcome::NotSent;
        }
        self.read_ack(state, Some(&claim), &frame)
    }
}

impl BtpPeerTransport {
    /// §6.2/§6.3: the ack answers the claim, independently of whatever the
    /// `ilpPacket` said about the packet. **Absence and malformation both
    /// mean not acknowledged**, and an ack on a response answering a frame
    /// that carried no claim is ignored.
    fn read_ack(
        &self,
        state: &RelationState,
        claim: Option<&WireClaim>,
        frame: &BtpFrame,
    ) -> ClaimAckOutcome {
        let Some(claim) = claim else {
            return ClaimAckOutcome::NotSent;
        };
        let ack = ack::from_protocol_data(&frame.protocol_data).unwrap_or(ClaimAckOutcome::NotSent);
        if ack == ClaimAckOutcome::Accepted {
            self.claim_acknowledged(state, claim);
        }
        ack
    }
}
