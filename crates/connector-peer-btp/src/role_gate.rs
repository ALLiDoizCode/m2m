//! **Role** (`peer-carriage-spec.md` §1.2), for both carriages.
//!
//! One function, called from three places — the BTP peer session, the
//! ILP-over-HTTP peer handler, and the client edge's front door where a
//! shared listener decides whether an arrival is peer handling's at all.
//! Shared for the same reason [`crate::price_gate::payment_required`] is:
//! §0.1's one pipeline must not admit over one carriage what it refuses
//! over the other, and a rule written twice is a rule that drifts.
//!
//! What lives here is only the **join**. §1.2's rule itself is
//! [`connector_peer_auth::decide_role`]'s, which sees a channel id and a
//! verification verdict and nothing else (§1.3); the counterparty key that
//! verdict comes from is [`connector_runtime::ClaimBook`]'s, populated from
//! `[[peer_channels]]`. This is the two-line bridge between them, and it
//! exists so neither side has to grow a dependency on the other.

use connector_peer_auth::{
    decide_role, ClaimVerification, PeerAuthPolicy, PresentedClaim, RoleDecision,
};
use connector_runtime::{ClaimRejectReason, Connector, WireClaim};

/// The role of one frame, from the claim that frame carries.
///
/// `claim` is `None` for a frame carrying none, which is a client frame:
/// under owner decision #868 a peer PREPARE with no covering claim is not
/// admitted at all, so there is no claimless peer frame for anything else
/// to carry the role on.
///
/// **Nothing is accepted, advanced or journaled here.** The claim is
/// verified against this node's own record of its channel and no more;
/// judging it — the watermark, the ledger, the ack — is
/// `Connector::handle_peer_claim`'s, downstream of the role, exactly as
/// §1.5 requires ("role MUST still be fixed before the packet is routed,
/// before a fee is taken … and before any watermark is advanced or anything
/// is journaled").
#[must_use]
pub fn decide(
    connector: &Connector,
    policy: &PeerAuthPolicy,
    claim: Option<&WireClaim>,
) -> RoleDecision {
    let presented = claim.map(|claim| {
        let verification = match connector.verify_peer_claim(claim) {
            Ok(()) => ClaimVerification::Verified,
            Err(ClaimRejectReason::UnknownChannel) => ClaimVerification::UnknownChannel,
            // `verify_signature` answers only those two, and a third would
            // be a signature this node could not vouch for either way --
            // which is `SignatureInvalid`'s meaning, not `Verified`'s.
            Err(_) => ClaimVerification::SignatureInvalid,
        };
        PresentedClaim::new(&claim.channel_id, verification)
    });
    decide_role(presented, policy)
}
