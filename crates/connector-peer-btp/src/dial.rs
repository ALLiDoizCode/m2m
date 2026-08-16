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
use connector_domain::x402::{GreetingError, X402PaymentRequired};
use connector_domain::{Fulfill, PacketResponse, Prepare, Reject};
use connector_peer_auth::{encode_raw, PresentedCredential};
use connector_runtime::{ClaimAckOutcome, Clock, PeerForward, PeerTransport, WireClaim};
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
    /// [`Self::set_solana_signer_public_key`], which
    /// `connector-cli::peer_transport::build_peer_transport` does from the
    /// `[settlement.solana]` key -- the same key `ClaimBook` signs a Solana
    /// peer claim with (issue #998) -- so this is `None` on exactly the
    /// nodes that have no such table. That mirrors
    /// `ClaimBook::solana_signer`'s own "unconfigured means no claim"
    /// contract at the transport's edge of it: a claim this connector never
    /// had a Solana identity to sign never had one to render either.
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

/// What a peer's RESPONSE frame actually said (issue #874).
///
/// [`PacketResponse`] alone cannot express it. A REJECT that carries the
/// x402 greeting is not the same event as a bare REJECT: it is the far side
/// quoting terms, and a caller that can satisfy them can turn it into a
/// FULFILL by paying. Flattening the two loses the only signal that says
/// so, which is why the negotiate-then-pay loop of #866 could not exist on
/// this path.
///
/// Every variant still carries the [`Reject`] verbatim, so relaying a
/// peer's answer unchanged (spec I5) stays available to a caller that has
/// nothing to do with the terms -- [`PeerAnswer::into_response`] is that
/// caller.
#[derive(Debug)]
pub enum PeerAnswer {
    /// The packet was delivered.
    Fulfill(Fulfill),
    /// The packet was refused, and no terms were quoted.
    Reject(Reject),
    /// The packet was refused **with terms** -- the far side's client edge
    /// answered a claimless or under-covered dial with the §1.4 greeting
    /// (`F06`, or `F02` when the route wants a different carriage). The
    /// reject rides along unchanged beside them, because a caller that
    /// cannot pay must still be able to relay the refusal it was given.
    PaymentRequired {
        reject: Reject,
        terms: Box<X402PaymentRequired>,
    },
    /// The packet was refused with a greeting that could not be read. A
    /// **distinct** outcome from [`PeerAnswer::Reject`] on purpose: terms
    /// were quoted, we could not tell what they were, and treating that as
    /// "no terms" would let a framing bug read as a free ride.
    MalformedGreeting {
        reject: Reject,
        error: GreetingError,
    },
}

impl PeerAnswer {
    /// The answer as the port's [`PacketResponse`], for a caller with no
    /// interest in the terms. Value-preserving in every arm: the reject a
    /// greeting rode on is the same reject that goes back.
    pub fn into_response(self) -> PacketResponse {
        match self {
            PeerAnswer::Fulfill(fulfill) => PacketResponse::Fulfill(fulfill),
            PeerAnswer::Reject(reject)
            | PeerAnswer::PaymentRequired { reject, .. }
            | PeerAnswer::MalformedGreeting { reject, .. } => PacketResponse::Reject(reject),
        }
    }
}

/// Read a peer's answer back off the RESPONSE frame: the packet's own
/// verdict from `ilpPacket`, a REJECT's running cost from the
/// `toon-accumulated-cost` entry the client edge already uses (§5.2), and
/// -- since issue #874 -- the x402 terms from the `payment-required` entry
/// the client edge greets a claimless request with (§1.9 step 3).
///
/// `None` means the frame carried no decodable ILP packet at all, which is
/// a framing failure rather than a verdict. It does **not** mean "no terms":
/// an unreadable greeting on an otherwise decodable REJECT is
/// [`PeerAnswer::MalformedGreeting`], never a silent `None` and never a
/// plain [`PeerAnswer::Reject`].
///
/// A FULFILL is never inspected for terms: the far side delivered the
/// packet, so whatever it might have quoted is moot.
pub fn decode_answer(frame: &BtpFrame) -> Option<PeerAnswer> {
    if let Ok(fulfill) = Fulfill::decode(&frame.ilp_packet) {
        return Some(PeerAnswer::Fulfill(fulfill));
    }
    let mut reject = Reject::decode(&frame.ilp_packet).ok()?;
    reject.accumulated_cost = fields::accumulated_cost(&frame.protocol_data);
    Some(match fields::payment_required(&frame.protocol_data) {
        None => PeerAnswer::Reject(reject),
        Some(Ok(terms)) => PeerAnswer::PaymentRequired {
            reject,
            terms: Box::new(terms),
        },
        Some(Err(error)) => PeerAnswer::MalformedGreeting { reject, error },
    })
}

#[async_trait]
impl PeerTransport for BtpPeerTransport {
    async fn forward(
        &self,
        peer_id: &str,
        prepare: Prepare,
        minimum_delivery: u64,
        claim: Option<WireClaim>,
    ) -> PeerForward {
        let Some(state) = self.relations.get(peer_id) else {
            return PeerForward::unreachable(peer_id);
        };
        let handle = match self.session(state).await {
            Ok(handle) => handle,
            Err(error) => {
                tracing::warn!(%error, "peer dial failed");
                return PeerForward::unreachable(peer_id);
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
                return PeerForward::unreachable(peer_id);
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
            return PeerForward::unreachable(peer_id);
        }

        let ack = self.read_ack(state, claim.as_ref(), &frame);
        match decode_answer(&frame) {
            // The terms are read and REPORTED here, not acted on: turning a
            // quote into a payment is the forwarding path's decision to make
            // (issue #875), not a carriage's. What issue #874 changed is
            // that the terms are no longer thrown away before anything can
            // decide; what #875 changes is that the port now has somewhere
            // to put them (`PeerForward::payment_required`).
            Some(PeerAnswer::PaymentRequired { reject, terms }) => {
                tracing::info!(
                    peer_id,
                    code = reject.code.as_str(),
                    price = terms.price().unwrap_or_default(),
                    pay_to = terms.pay_to().unwrap_or_default(),
                    required_transport = terms.required_transport().unwrap_or_default(),
                    "peer refused a forwarded PREPARE with x402 terms"
                );
                PeerForward::quoted(PacketResponse::Reject(reject), ack, *terms)
            }
            // An unreadable greeting is reported as a plain refusal with NO
            // terms, which is not a free ride: the packet is still refused,
            // and the forwarding path is simply given nothing it could pay
            // against. Guessing at a greeting we could not read would be the
            // only worse answer.
            Some(PeerAnswer::MalformedGreeting { reject, error }) => {
                tracing::warn!(
                    peer_id,
                    code = reject.code.as_str(),
                    %error,
                    "peer refused a forwarded PREPARE with an unreadable x402 greeting"
                );
                PeerForward::answered(PacketResponse::Reject(reject), ack)
            }
            Some(answer) => PeerForward::answered(answer.into_response(), ack),
            None => {
                tracing::warn!(peer_id, "peer answer carried no decodable ILP packet");
                PeerForward::undecodable(peer_id, ack)
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

#[cfg(test)]
mod tests {
    use super::*;
    use connector_btp::{BTP_RESPONSE, PAYMENT_REQUIRED_PROTOCOL};
    use connector_domain::RejectCode;

    /// The bytes the client edge's §1.9 greeting carries, in miniature.
    /// `crates/connector-client-edge/tests/btp_session.rs`'s
    /// `a_dialing_peer_reads_the_terms_off_the_greeting_the_edge_emits`
    /// runs this same reader over what the real emitter actually writes, so
    /// this stays a fixture rather than a second definition of the shape.
    const TERMS: &[u8] = br#"{"x402Version":2,"resource":{"url":"g.toon.relay"},
        "accepts":[{"amount":"2000","payTo":"g.toon.relay"}]}"#;

    fn response(ilp_packet: Vec<u8>, protocol_data: Vec<ProtocolData>) -> BtpFrame {
        BtpFrame {
            frame_type: BTP_RESPONSE,
            request_id: 7,
            amount: None,
            protocol_data,
            ilp_packet,
        }
    }

    fn entry(name: &str, data: &[u8]) -> ProtocolData {
        ProtocolData {
            name: name.to_string(),
            content_type: CONTENT_TYPE_TEXT,
            data: data.to_vec(),
        }
    }

    fn refusal() -> Reject {
        Reject {
            code: RejectCode::f06_unexpected_payment(),
            triggered_by: String::new(),
            message: "No payment channel claim attached".to_string(),
            data: Vec::new(),
            accumulated_cost: 0,
        }
    }

    #[test]
    fn a_fulfill_is_read_as_delivery_and_never_searched_for_terms() {
        let fulfill = Fulfill {
            fulfillment: [3u8; 32],
            data: b"sealed".to_vec(),
        };
        let frame = response(
            fulfill.encode(),
            vec![entry(PAYMENT_REQUIRED_PROTOCOL, TERMS)],
        );

        assert!(matches!(
            decode_answer(&frame),
            Some(PeerAnswer::Fulfill(_))
        ));
    }

    #[test]
    fn a_bare_reject_quotes_no_terms_and_still_carries_its_running_cost() {
        let frame = response(
            refusal().encode(),
            vec![fields::accumulated_cost_protocol_data(41)],
        );

        let Some(PeerAnswer::Reject(reject)) = decode_answer(&frame) else {
            panic!("a reject with no greeting is a plain reject");
        };
        assert_eq!(reject.accumulated_cost, 41);
    }

    /// Issue #874's first acceptance: a claimless dial learns what it owes.
    #[test]
    fn a_greeted_reject_yields_the_terms_beside_the_refusal() {
        let frame = response(
            refusal().encode(),
            vec![
                entry(PAYMENT_REQUIRED_PROTOCOL, TERMS),
                fields::accumulated_cost_protocol_data(41),
            ],
        );

        let Some(PeerAnswer::PaymentRequired { reject, terms }) = decode_answer(&frame) else {
            panic!("a greeted reject carries its terms");
        };
        assert_eq!(reject.code.as_str(), "F06");
        assert_eq!(reject.accumulated_cost, 41);
        assert_eq!(terms.price(), Some(2000));
        assert_eq!(terms.pay_to(), Some("g.toon.relay"));
    }

    /// Issue #874's second: garbage in the greeting slot is its own
    /// outcome. A caller that sees `Reject` may conclude nothing was
    /// asked for, so an unreadable greeting must never reach it as one.
    #[test]
    fn an_unreadable_greeting_is_distinct_from_a_reject_that_quoted_nothing() {
        let frame = response(
            refusal().encode(),
            vec![entry(PAYMENT_REQUIRED_PROTOCOL, b"{ truncated")],
        );

        let Some(PeerAnswer::MalformedGreeting { reject, error }) = decode_answer(&frame) else {
            panic!("an unreadable greeting is neither terms nor a bare reject");
        };
        assert_eq!(reject.code.as_str(), "F06");
        assert!(matches!(error, GreetingError::NotJson(_)), "{error:?}");
    }

    /// Spec I5: whatever this reads, the peer's own refusal is what goes
    /// back up -- reading terms adds an outcome, it does not rewrite one.
    #[test]
    fn every_arm_relays_the_peers_own_answer_unchanged() {
        for protocol_data in [
            vec![],
            vec![entry(PAYMENT_REQUIRED_PROTOCOL, TERMS)],
            vec![entry(PAYMENT_REQUIRED_PROTOCOL, b"rubbish")],
        ] {
            let frame = response(refusal().encode(), protocol_data);
            let PacketResponse::Reject(relayed) =
                decode_answer(&frame).expect("decodable").into_response()
            else {
                panic!("a reject stays a reject");
            };
            assert_eq!(relayed.code.as_str(), refusal().code.as_str());
            assert_eq!(relayed.message, refusal().message);
        }
    }

    #[test]
    fn a_frame_with_no_ilp_packet_at_all_is_no_answer() {
        let frame = response(Vec::new(), vec![entry(PAYMENT_REQUIRED_PROTOCOL, TERMS)]);

        assert!(decode_answer(&frame).is_none());
    }
}
