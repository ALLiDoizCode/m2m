//! Per-peering-relation claim exchange (ADR 0004, ADR 0005,
//! `docs/protocol/peer-wire-spec.md` §3, issue #423): signing and tracking
//! the claim this connector owes a peer on fulfilment, and verifying and
//! watermarking a claim a peer sends back. The nonce/watermark rule itself
//! lives in `connector_domain::validate_claim`; this module is the
//! in-memory bookkeeping and wire shape around it. Durable persistence of
//! this state (ADR 0005's journal) is issue #424's job -- [`ClaimBook`]
//! holds it only for the lifetime of the process, exactly like
//! `Connector`'s `leased_routes`.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use chrono::{DateTime, Duration, Utc};

use connector_domain::{advance_watermark, claim_digest, validate_claim, ClaimError, Watermark};
use connector_signer::{verify, PublicKeyBytes, Signature, Signer};

use crate::operator_view::ClaimView;

/// A claim as it travels the wire (peer-wire-spec.md §3.5): a channel
/// identifier, a nonce, a cumulative amount, and a signature over
/// [`connector_domain::claim_digest`] of the three. Distinct from
/// `connector_settlement::Claim` -- that is the on-chain redemption claim
/// (issue #425); this is the per-peering-relation claim exchanged before
/// any redemption happens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireClaim {
    pub channel_id: String,
    pub nonce: u64,
    pub cumulative_amount: u64,
    pub signature: Signature,
}

const SIGNATURE_LEN: usize = 65; // r(32) + s(32) + recovery_id(1)

impl WireClaim {
    /// Length-prefixed `channel_id` (so no two distinct tuples can ever
    /// collide on the same byte string) followed by `nonce`,
    /// `cumulative_amount` and the raw signature -- the peer wire's ad hoc
    /// encoding for fields RFC-0027 has no concept of, matching the
    /// precedent `network_peer_transport.rs` already sets for
    /// `minimumDelivery`.
    pub fn encode(&self) -> Vec<u8> {
        let channel_id_bytes = self.channel_id.as_bytes();
        let mut out = Vec::with_capacity(2 + channel_id_bytes.len() + 8 + 8 + SIGNATURE_LEN);
        out.extend_from_slice(&(channel_id_bytes.len() as u16).to_be_bytes());
        out.extend_from_slice(channel_id_bytes);
        out.extend_from_slice(&self.nonce.to_be_bytes());
        out.extend_from_slice(&self.cumulative_amount.to_be_bytes());
        out.extend_from_slice(&self.signature.r);
        out.extend_from_slice(&self.signature.s);
        out.push(self.signature.recovery_id);
        out
    }

    /// Decode one [`WireClaim`] from the front of `bytes`, returning it
    /// alongside how many bytes it consumed so a caller can decode
    /// whatever follows (a `WireClaim` never appears alone on the wire --
    /// it always rides a PREPARE or stands as the whole of a FLUSH).
    pub fn decode(bytes: &[u8]) -> Option<(WireClaim, usize)> {
        let channel_id_len = u16::from_be_bytes(bytes.get(0..2)?.try_into().ok()?) as usize;
        let mut offset = 2;
        let channel_id =
            String::from_utf8(bytes.get(offset..offset + channel_id_len)?.to_vec()).ok()?;
        offset += channel_id_len;
        let nonce = u64::from_be_bytes(bytes.get(offset..offset + 8)?.try_into().ok()?);
        offset += 8;
        let cumulative_amount = u64::from_be_bytes(bytes.get(offset..offset + 8)?.try_into().ok()?);
        offset += 8;
        let mut r = [0u8; 32];
        r.copy_from_slice(bytes.get(offset..offset + 32)?);
        offset += 32;
        let mut s = [0u8; 32];
        s.copy_from_slice(bytes.get(offset..offset + 32)?);
        offset += 32;
        let recovery_id = *bytes.get(offset)?;
        offset += 1;
        Some((
            WireClaim {
                channel_id,
                nonce,
                cumulative_amount,
                signature: Signature { r, s, recovery_id },
            },
            offset,
        ))
    }
}

/// Why a claim was rejected (peer-wire-spec.md §3.4's CLAIM_ACK reasons).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimRejectReason {
    SignatureInvalid,
    NonceNotAdvancing,
    AmountNotAdvancing,
    UnknownChannel,
}

impl ClaimRejectReason {
    fn to_wire(self) -> u8 {
        match self {
            ClaimRejectReason::SignatureInvalid => 0,
            ClaimRejectReason::NonceNotAdvancing => 1,
            ClaimRejectReason::AmountNotAdvancing => 2,
            ClaimRejectReason::UnknownChannel => 3,
        }
    }

    fn from_wire(byte: u8) -> Option<ClaimRejectReason> {
        match byte {
            0 => Some(ClaimRejectReason::SignatureInvalid),
            1 => Some(ClaimRejectReason::NonceNotAdvancing),
            2 => Some(ClaimRejectReason::AmountNotAdvancing),
            3 => Some(ClaimRejectReason::UnknownChannel),
            _ => None,
        }
    }
}

/// The outcome of sending a claim (peer-wire-spec.md §3.4): [`ClaimAckOutcome::NotSent`]
/// when no claim rode this frame at all, distinct from a claim that rode it
/// and was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimAckOutcome {
    NotSent,
    Accepted,
    Rejected(ClaimRejectReason),
}

impl ClaimAckOutcome {
    /// Encode the CLAIM_ACK answering a claim that was sent. Never called
    /// for [`ClaimAckOutcome::NotSent`] -- there is nothing to acknowledge,
    /// so no CLAIM_ACK frame is sent at all (the caller checks this first).
    pub fn encode(&self) -> Vec<u8> {
        match self {
            ClaimAckOutcome::Accepted => vec![0],
            ClaimAckOutcome::Rejected(reason) => vec![1, reason.to_wire()],
            ClaimAckOutcome::NotSent => vec![],
        }
    }

    pub fn decode(bytes: &[u8]) -> Option<ClaimAckOutcome> {
        match bytes.first()? {
            0 => Some(ClaimAckOutcome::Accepted),
            1 => Some(ClaimAckOutcome::Rejected(ClaimRejectReason::from_wire(
                *bytes.get(1)?,
            )?)),
            _ => None,
        }
    }
}

/// One peer's outbound claim ledger: what this connector owes it, signed
/// here and piggybacked on the next frame out.
#[derive(Default)]
struct OutboundLedger {
    channel_id: String,
    pending: Option<WireClaim>,
    pending_since: Option<DateTime<Utc>>,
    nonce: u64,
    cumulative_amount: u64,
}

/// This connector's claim state across every peering relation (ADR 0004,
/// ADR 0005). Signing requires a [`Signer`]; a node with none configured
/// simply never emits a claim, matching how a node with no settlement
/// backend never gets a working channel surface (`Connector::settlement`).
///
/// Outbound state (what this connector owes a peer) is keyed by `peer_id`,
/// since that is what routing decides. Inbound state (a peer's watermark
/// on a channel) is keyed by the claim's own `channel_id` instead of by
/// peer id: the peer wire has no identity handshake yet (peer-wire-spec.md
/// §1.1 leaves "a configured peer id and verification key" as
/// configuration, and `network_peer_transport.rs`'s accepting side does not
/// know which configured peer dialed it -- issue #416 deferred that). A
/// claim already carries its own `channel_id`, so verification and the
/// watermark it advances need nothing else to identify which channel it is
/// -- only which key is trusted to sign for that channel, configured via
/// [`ClaimBook::new`]'s `verification_keys`.
pub struct ClaimBook {
    signer: Option<Arc<dyn Signer>>,
    /// `peer_id` -> the channel this connector claims against when it owes
    /// that peer.
    outbound_channels: HashMap<String, String>,
    /// `channel_id` -> the public key whose signature this connector
    /// accepts on a claim for that channel.
    verification_keys: HashMap<String, PublicKeyBytes>,
    outbound: RwLock<HashMap<String, OutboundLedger>>,
    /// `channel_id` -> the highest nonce/amount accepted on it so far.
    inbound_watermarks: RwLock<HashMap<String, Watermark>>,
}

impl ClaimBook {
    pub fn new(
        signer: Option<Arc<dyn Signer>>,
        outbound_channels: HashMap<String, String>,
        verification_keys: HashMap<String, PublicKeyBytes>,
    ) -> ClaimBook {
        ClaimBook {
            signer,
            outbound_channels,
            verification_keys,
            outbound: RwLock::new(HashMap::new()),
            inbound_watermarks: RwLock::new(HashMap::new()),
        }
    }

    fn outbound_mut(&self) -> std::sync::RwLockWriteGuard<'_, HashMap<String, OutboundLedger>> {
        self.outbound
            .write()
            .expect("outbound claims lock poisoned")
    }

    /// Configure this connector's own signer, used to sign every outbound
    /// claim. Takes `&mut self` -- called only while a `Connector` is still
    /// being built (`mut self` builder chain), before it is shared, exactly
    /// like `Connector::with_settlement`.
    pub fn set_signer(&mut self, signer: Arc<dyn Signer>) {
        self.signer = Some(signer);
    }

    /// Configure the channel this connector claims against when it owes
    /// `peer_id`.
    pub fn set_outbound_channel(
        &mut self,
        peer_id: impl Into<String>,
        channel_id: impl Into<String>,
    ) {
        self.outbound_channels
            .insert(peer_id.into(), channel_id.into());
    }

    /// Configure the public key whose signature this connector accepts on
    /// an inbound claim for `channel_id`.
    pub fn set_verification_key(&mut self, channel_id: impl Into<String>, key: PublicKeyBytes) {
        self.verification_keys.insert(channel_id.into(), key);
    }

    /// Record that a packet forwarded to `peer_id` fulfilled, owing it
    /// `amount` more (ADR 0004 -- value moves on fulfilment). Signs a fresh
    /// claim for the new cumulative total and arms it pending. Exactly one
    /// claim is produced per call -- never batched: a second fulfilment
    /// before the first claim has gone out simply supersedes it with a
    /// fresher nonce and a higher cumulative amount (peer-wire-spec.md
    /// §3.2). Does nothing for a peer with no configured channel or on a
    /// node with no signer configured.
    pub fn record_fulfillment(
        &self,
        peer_id: &str,
        amount: u64,
        now: DateTime<Utc>,
    ) -> Option<WireClaim> {
        let channel_id = self.outbound_channels.get(peer_id)?;
        let signer = self.signer.as_ref()?;
        let mut outbound = self.outbound_mut();
        let ledger = outbound
            .entry(peer_id.to_string())
            .or_insert_with(|| OutboundLedger {
                channel_id: channel_id.clone(),
                ..Default::default()
            });
        ledger.cumulative_amount += amount;
        ledger.nonce += 1;
        let digest = claim_digest(&ledger.channel_id, ledger.nonce, ledger.cumulative_amount);
        let signature = signer.sign(&digest).ok()?;
        let claim = WireClaim {
            channel_id: ledger.channel_id.clone(),
            nonce: ledger.nonce,
            cumulative_amount: ledger.cumulative_amount,
            signature,
        };
        ledger.pending = Some(claim.clone());
        ledger.pending_since = Some(now);
        Some(claim)
    }

    /// The claim owed to `peer_id`, if one is pending -- what the next
    /// frame out to that peer should carry (peer-wire-spec.md §3.2).
    pub fn pending_claim(&self, peer_id: &str) -> Option<WireClaim> {
        self.outbound
            .read()
            .expect("outbound claims lock poisoned")
            .get(peer_id)
            .and_then(|ledger| ledger.pending.clone())
    }

    /// Every peer whose pending claim has waited at least `flush_interval`
    /// since it armed, as of `now` -- what a flush sweep should send
    /// (peer-wire-spec.md §3.3). Checked fresh against the injected clock,
    /// like `Connector`'s leased-route expiry, rather than driven by a
    /// stored deadline.
    pub fn due_for_flush(
        &self,
        now: DateTime<Utc>,
        flush_interval: Duration,
    ) -> Vec<(String, WireClaim)> {
        self.outbound
            .read()
            .expect("outbound claims lock poisoned")
            .iter()
            .filter_map(|(peer_id, ledger)| {
                let since = ledger.pending_since?;
                let claim = ledger.pending.clone()?;
                if now - since >= flush_interval {
                    Some((peer_id.clone(), claim))
                } else {
                    None
                }
            })
            .collect()
    }

    /// Record the outcome of a claim of `nonce` sent to `peer_id`. On
    /// acceptance the pending mark clears -- but only if `nonce` still
    /// names the claim actually pending: a fresher fulfilment may already
    /// have superseded it while the acknowledgement was in flight, and
    /// acknowledging the stale nonce must not clear that newer claim
    /// (peer-wire-spec.md §3.2).
    pub fn acknowledge_outbound(&self, peer_id: &str, nonce: u64, outcome: ClaimAckOutcome) {
        if outcome != ClaimAckOutcome::Accepted {
            return;
        }
        let mut outbound = self.outbound_mut();
        if let Some(ledger) = outbound.get_mut(peer_id) {
            if ledger.pending.as_ref().map(|c| c.nonce) == Some(nonce) {
                ledger.pending = None;
                ledger.pending_since = None;
            }
        }
    }

    /// Verify and, if valid, accept an inbound `claim`, advancing the
    /// watermark on its `channel_id` (peer-wire-spec.md §3.4). Independent
    /// of whatever PREPARE the claim rode in on -- a rejected claim does
    /// not reject that PREPARE, and this method never looks at one.
    pub fn accept_inbound(&self, claim: &WireClaim) -> ClaimAckOutcome {
        let Some(verification_key) = self.verification_keys.get(&claim.channel_id) else {
            return ClaimAckOutcome::Rejected(ClaimRejectReason::UnknownChannel);
        };
        let digest = claim_digest(&claim.channel_id, claim.nonce, claim.cumulative_amount);
        if !verify(verification_key, &digest, &claim.signature) {
            return ClaimAckOutcome::Rejected(ClaimRejectReason::SignatureInvalid);
        }

        let mut watermarks = self
            .inbound_watermarks
            .write()
            .expect("inbound watermarks lock poisoned");
        let watermark = watermarks.get(&claim.channel_id).copied();
        match validate_claim(watermark, claim.nonce, claim.cumulative_amount) {
            Ok(()) => {
                watermarks.insert(
                    claim.channel_id.clone(),
                    advance_watermark(claim.nonce, claim.cumulative_amount),
                );
                ClaimAckOutcome::Accepted
            }
            Err(ClaimError::NonceNotAdvancing { .. }) => {
                ClaimAckOutcome::Rejected(ClaimRejectReason::NonceNotAdvancing)
            }
            Err(ClaimError::AmountNotAdvancing { .. }) => {
                ClaimAckOutcome::Rejected(ClaimRejectReason::AmountNotAdvancing)
            }
        }
    }

    /// Every peer's claim state, for the operator surface's read-only
    /// inspection interface (issue #420). `peer_id` is `None` on an inbound
    /// entry for the same reason `accept_inbound` needs none: the peer wire
    /// has no identity handshake yet, so only the channel is known.
    pub fn views(&self) -> Vec<ClaimView> {
        let mut views: Vec<ClaimView> = self
            .outbound
            .read()
            .expect("outbound claims lock poisoned")
            .iter()
            .filter(|(_, ledger)| ledger.nonce > 0)
            .map(|(peer_id, ledger)| ClaimView {
                peer_id: Some(peer_id.clone()),
                channel_id: ledger.channel_id.clone(),
                direction: crate::operator_view::ClaimDirection::Outbound,
                nonce: ledger.nonce,
                cumulative_amount: ledger.cumulative_amount,
                pending: ledger.pending.is_some(),
            })
            .collect();
        views.extend(
            self.inbound_watermarks
                .read()
                .expect("inbound watermarks lock poisoned")
                .iter()
                .map(|(channel_id, watermark)| ClaimView {
                    peer_id: None,
                    channel_id: channel_id.clone(),
                    direction: crate::operator_view::ClaimDirection::Inbound,
                    nonce: watermark.nonce,
                    cumulative_amount: watermark.cumulative_amount,
                    pending: false,
                }),
        );
        views
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use connector_signer::LocalSigner;

    fn now() -> DateTime<Utc> {
        "2030-01-01T00:00:00Z".parse().unwrap()
    }

    /// A book that can both sign outbound claims to `peer_id` on
    /// `channel_id`, and verify inbound claims on `channel_id` against
    /// `verification_key`.
    fn book_with_peer(
        peer_id: &str,
        channel_id: &str,
        verification_key: PublicKeyBytes,
    ) -> ClaimBook {
        let signer = Arc::new(LocalSigner::generate("claim-key"));
        let mut outbound_channels = HashMap::new();
        outbound_channels.insert(peer_id.to_string(), channel_id.to_string());
        let mut verification_keys = HashMap::new();
        verification_keys.insert(channel_id.to_string(), verification_key);
        ClaimBook::new(Some(signer), outbound_channels, verification_keys)
    }

    #[test]
    fn a_wire_claim_round_trips_through_encode_and_decode() {
        let claim = WireClaim {
            channel_id: "channel-a".to_string(),
            nonce: 7,
            cumulative_amount: 900,
            signature: Signature {
                r: [1u8; 32],
                s: [2u8; 32],
                recovery_id: 1,
            },
        };
        let mut bytes = claim.encode();
        bytes.extend_from_slice(b"trailing");

        let (decoded, consumed) = WireClaim::decode(&bytes).unwrap();
        assert_eq!(decoded, claim);
        assert_eq!(&bytes[consumed..], b"trailing");
    }

    #[test]
    fn a_claim_ack_round_trips_through_encode_and_decode() {
        for outcome in [
            ClaimAckOutcome::Accepted,
            ClaimAckOutcome::Rejected(ClaimRejectReason::SignatureInvalid),
            ClaimAckOutcome::Rejected(ClaimRejectReason::NonceNotAdvancing),
            ClaimAckOutcome::Rejected(ClaimRejectReason::AmountNotAdvancing),
            ClaimAckOutcome::Rejected(ClaimRejectReason::UnknownChannel),
        ] {
            let bytes = outcome.encode();
            assert_eq!(ClaimAckOutcome::decode(&bytes), Some(outcome));
        }
    }

    #[test]
    fn no_claim_is_recorded_without_a_signer() {
        let mut outbound_channels = HashMap::new();
        outbound_channels.insert("peer-b".to_string(), "channel-a".to_string());
        let book = ClaimBook::new(None, outbound_channels, HashMap::new());

        assert!(book.record_fulfillment("peer-b", 100, now()).is_none());
    }

    #[test]
    fn no_claim_is_recorded_for_an_unregistered_peer() {
        let book = ClaimBook::new(
            Some(Arc::new(LocalSigner::generate("k"))),
            HashMap::new(),
            HashMap::new(),
        );

        assert!(book.record_fulfillment("peer-b", 100, now()).is_none());
    }

    #[test]
    fn recording_a_fulfillment_arms_exactly_one_pending_claim_with_nonce_one() {
        let key = LocalSigner::generate("k").public_key().unwrap();
        let book = book_with_peer("peer-b", "channel-a", key);

        let claim = book.record_fulfillment("peer-b", 100, now()).unwrap();

        assert_eq!(claim.nonce, 1);
        assert_eq!(claim.cumulative_amount, 100);
        assert_eq!(book.pending_claim("peer-b"), Some(claim));
    }

    #[test]
    fn a_second_fulfillment_before_the_first_drains_supersedes_it_rather_than_batching() {
        let key = LocalSigner::generate("k").public_key().unwrap();
        let book = book_with_peer("peer-b", "channel-a", key);

        book.record_fulfillment("peer-b", 100, now()).unwrap();
        let second = book.record_fulfillment("peer-b", 50, now()).unwrap();

        // Exactly one pending claim, holding the latest cumulative state --
        // not two, and not the first one.
        assert_eq!(second.nonce, 2);
        assert_eq!(second.cumulative_amount, 150);
        assert_eq!(book.pending_claim("peer-b"), Some(second));
    }

    #[test]
    fn acknowledging_the_pending_nonce_clears_it() {
        let key = LocalSigner::generate("k").public_key().unwrap();
        let book = book_with_peer("peer-b", "channel-a", key);
        let claim = book.record_fulfillment("peer-b", 100, now()).unwrap();

        book.acknowledge_outbound("peer-b", claim.nonce, ClaimAckOutcome::Accepted);

        assert_eq!(book.pending_claim("peer-b"), None);
    }

    #[test]
    fn acknowledging_a_stale_nonce_does_not_clear_a_fresher_pending_claim() {
        let key = LocalSigner::generate("k").public_key().unwrap();
        let book = book_with_peer("peer-b", "channel-a", key);
        let first = book.record_fulfillment("peer-b", 100, now()).unwrap();
        let second = book.record_fulfillment("peer-b", 50, now()).unwrap();

        book.acknowledge_outbound("peer-b", first.nonce, ClaimAckOutcome::Accepted);

        assert_eq!(book.pending_claim("peer-b"), Some(second));
    }

    #[test]
    fn a_rejected_ack_leaves_the_claim_pending() {
        let key = LocalSigner::generate("k").public_key().unwrap();
        let book = book_with_peer("peer-b", "channel-a", key);
        let claim = book.record_fulfillment("peer-b", 100, now()).unwrap();

        book.acknowledge_outbound(
            "peer-b",
            claim.nonce,
            ClaimAckOutcome::Rejected(ClaimRejectReason::SignatureInvalid),
        );

        assert_eq!(book.pending_claim("peer-b"), Some(claim));
    }

    #[test]
    fn a_claim_not_yet_waiting_the_full_flush_interval_is_not_due() {
        let key = LocalSigner::generate("k").public_key().unwrap();
        let book = book_with_peer("peer-b", "channel-a", key);
        book.record_fulfillment("peer-b", 100, now()).unwrap();

        let due = book.due_for_flush(now() + Duration::seconds(5), Duration::seconds(10));

        assert!(due.is_empty());
    }

    #[test]
    fn a_claim_waiting_the_full_flush_interval_is_due() {
        let key = LocalSigner::generate("k").public_key().unwrap();
        let book = book_with_peer("peer-b", "channel-a", key);
        let claim = book.record_fulfillment("peer-b", 100, now()).unwrap();

        let due = book.due_for_flush(now() + Duration::seconds(10), Duration::seconds(10));

        assert_eq!(due, vec![("peer-b".to_string(), claim)]);
    }

    #[test]
    fn an_acknowledged_claim_is_never_due_for_flush() {
        let key = LocalSigner::generate("k").public_key().unwrap();
        let book = book_with_peer("peer-b", "channel-a", key);
        let claim = book.record_fulfillment("peer-b", 100, now()).unwrap();
        book.acknowledge_outbound("peer-b", claim.nonce, ClaimAckOutcome::Accepted);

        let due = book.due_for_flush(now() + Duration::days(1), Duration::seconds(10));

        assert!(due.is_empty());
    }

    #[test]
    fn a_genuinely_signed_claim_from_the_registered_peer_is_accepted() {
        let peer_signer = LocalSigner::generate("peer-key");
        let key = peer_signer.public_key().unwrap();
        let book = book_with_peer("peer-b", "channel-a", key);
        let digest = claim_digest("channel-a", 1, 100);
        let claim = WireClaim {
            channel_id: "channel-a".to_string(),
            nonce: 1,
            cumulative_amount: 100,
            signature: peer_signer.sign(&digest).unwrap(),
        };

        let outcome = book.accept_inbound(&claim);

        assert_eq!(outcome, ClaimAckOutcome::Accepted);
    }

    #[test]
    fn a_claim_signed_by_the_wrong_key_is_rejected() {
        let key = LocalSigner::generate("peer-key").public_key().unwrap();
        let book = book_with_peer("peer-b", "channel-a", key);
        let impostor = LocalSigner::generate("impostor-key");
        let digest = claim_digest("channel-a", 1, 100);
        let claim = WireClaim {
            channel_id: "channel-a".to_string(),
            nonce: 1,
            cumulative_amount: 100,
            signature: impostor.sign(&digest).unwrap(),
        };

        let outcome = book.accept_inbound(&claim);

        assert_eq!(
            outcome,
            ClaimAckOutcome::Rejected(ClaimRejectReason::SignatureInvalid)
        );
    }

    #[test]
    fn a_claim_from_an_unregistered_peer_is_rejected_as_unknown_channel() {
        let signer = LocalSigner::generate("k");
        let digest = claim_digest("channel-a", 1, 100);
        let claim = WireClaim {
            channel_id: "channel-a".to_string(),
            nonce: 1,
            cumulative_amount: 100,
            signature: signer.sign(&digest).unwrap(),
        };
        let book = ClaimBook::new(Some(Arc::new(signer)), HashMap::new(), HashMap::new());

        let outcome = book.accept_inbound(&claim);

        assert_eq!(
            outcome,
            ClaimAckOutcome::Rejected(ClaimRejectReason::UnknownChannel)
        );
    }

    #[test]
    fn a_second_claim_that_does_not_advance_the_nonce_is_rejected_and_the_watermark_holds() {
        let peer_signer = LocalSigner::generate("peer-key");
        let key = peer_signer.public_key().unwrap();
        let book = book_with_peer("peer-b", "channel-a", key);
        let sign = |nonce: u64, amount: u64| WireClaim {
            channel_id: "channel-a".to_string(),
            nonce,
            cumulative_amount: amount,
            signature: peer_signer
                .sign(&claim_digest("channel-a", nonce, amount))
                .unwrap(),
        };

        assert_eq!(
            book.accept_inbound(&sign(5, 500)),
            ClaimAckOutcome::Accepted
        );
        let replay = book.accept_inbound(&sign(5, 999));

        assert_eq!(
            replay,
            ClaimAckOutcome::Rejected(ClaimRejectReason::NonceNotAdvancing)
        );
        // A rejected claim never moves the watermark: the next genuinely
        // advancing claim is still judged against nonce 5 / amount 500.
        assert_eq!(
            book.accept_inbound(&sign(6, 500)),
            ClaimAckOutcome::Accepted
        );
    }
}
