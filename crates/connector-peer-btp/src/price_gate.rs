//! **The price-coverage gate** (`peer-carriage-spec.md` §3.1, issue #880,
//! owner decision #868): a peer PREPARE to a route this connector both
//! terminates and prices MUST carry a claim that covers that price, or it is
//! refused with the client edge's own x402 greeting.
//!
//! # Why the decision lives here rather than in each carriage
//!
//! §0.1's one-pipeline invariant: a peer PREPARE that arrived over HTTP and
//! one that arrived over BTP are the same packet, and a rule that admits a
//! packet on one carriage and refuses it on the other is a hole rather than
//! a difference. The two carriages differ only in how the refusal is
//! *shaped* -- protocolData on a RESPONSE (BTP) or a response header (HTTP)
//! -- so that is all each of them keeps. It sits in this crate for the same
//! reason [`crate::claim_json`], [`crate::ack`] and
//! [`crate::AcceptedClaims`] do: `connector-peer-http` depends on this
//! crate, and the peering semantics are not BTP's.
//!
//! # What it is scoped to, and why that is not narrower than the rule
//!
//! A **`Terminated`** route's own `price`, exactly like the pre-existing
//! `F03` amount check `Connector::handle_peer_prepare` still runs after it
//! (ADR 0029). A `Forwarded` route is priced by the peering's own bilateral
//! fee (`peer-wire-spec.md` §4), which is a configured agreement rather
//! than something a greeting quotes, and a route deliberately priced at `0`
//! (ADR 0020) is free on the peer path exactly as it is on the client edge.

use connector_domain::x402::GreetingTerms;
use connector_domain::{validate_price, Reject, RejectCode, Watermark};
use connector_runtime::{ClaimAckOutcome, ClientRouteKind, Connector, WireClaim};

/// The refusal an uncovered peer PREPARE gets: an `F06` REJECT plus the
/// x402 terms that ride it. Built once here so the two carriages cannot
/// disagree about the reject code, the message or the greeting's bytes --
/// only about which field of their own wire carries [`Self::terms`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaymentRequired {
    /// The packet's own answer (§6.2): independent of the claim's verdict,
    /// which still rides the same response.
    pub reject: Reject,
    /// [`connector_domain::x402::terms_body`]'s bytes -- **the** emitter
    /// every carriage shares, never a second wire shape.
    pub terms: Vec<u8>,
}

/// Judge one peer PREPARE's price coverage: `None` when it is admitted
/// exactly as it was before issue #880, `Some` when it must be refused.
///
/// `claim` and `prior_watermark` are what this PREPARE rode in on:
/// `prior_watermark` MUST be read *before* the claim was judged (and so
/// possibly recorded), so coverage is the claim's own advance rather than
/// the zero advance past the watermark it just became.
///
/// Coverage requires the claim book's own verdict to be
/// [`ClaimAckOutcome::Accepted`], not merely that a claim decoded: a forged
/// signature or a replayed nonce still decodes and can still declare any
/// `cumulative_amount` it likes, so judging off that declared amount would
/// let an unlimited-value, never-verified claim buy service.
///
/// Refusing is logged rather than silent (Pattern 34): the peer, the
/// destination, the price, the shortfall, and the claim's own verdict --
/// which is what distinguishes "paid too little" from "paid with a claim
/// this connector would not accept".
#[must_use]
pub fn payment_required(
    connector: &Connector,
    peer_id: &str,
    destination: &str,
    ack: ClaimAckOutcome,
    claim: Option<&WireClaim>,
    prior_watermark: Option<Watermark>,
) -> Option<PaymentRequired> {
    let price = connector
        .client_route(destination)
        .filter(|route| route.kind == ClientRouteKind::Terminated)
        .map_or(0, |route| route.price);
    if price == 0 {
        return None;
    }

    let covers = ack == ClaimAckOutcome::Accepted
        && claim.is_some_and(|claim| {
            validate_price(prior_watermark, claim.cumulative_amount, price).is_ok()
        });
    if covers {
        return None;
    }

    // A claim the book did not accept advances nothing, whatever it
    // declares -- reporting its declared amount would read as "nearly paid"
    // for a forged or replayed claim that bought nothing at all.
    let advanced = match claim {
        Some(claim) if ack == ClaimAckOutcome::Accepted => claim
            .cumulative_amount
            .saturating_sub(prior_watermark.map_or(0, |watermark| watermark.cumulative_amount)),
        _ => 0,
    };
    tracing::warn!(
        peer_id,
        destination,
        price,
        advanced,
        shortfall = price.saturating_sub(advanced),
        claim_ack = ?ack,
        "peer PREPARE refused: no claim covers this packet's price"
    );
    Some(PaymentRequired {
        reject: Reject {
            code: RejectCode::f06_unexpected_payment(),
            triggered_by: String::new(),
            message: "no payment channel claim covers this packet's price".to_string(),
            data: Vec::new(),
            accumulated_cost: 0,
        },
        // A peering has no bootstrap identity to advertise and no client
        // session to lease: the peer already knows this node, and what it
        // needs quoted is the price alone.
        terms: connector_domain::x402::terms_body(&GreetingTerms {
            destination,
            price,
            ..Default::default()
        }),
    })
}
