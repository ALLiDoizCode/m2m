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

use std::collections::BTreeMap;

use connector_config::{ClaimEnforcement, PeerConfig};
use connector_domain::x402::GreetingTerms;
use connector_domain::{validate_price, Reject, RejectCode, Watermark};
use connector_runtime::{ClaimAckOutcome, ClientRouteKind, Connector, WireClaim};

/// Which peerings are in [`ClaimEnforcement::Observe`], the rest reading as
/// [`ClaimEnforcement::Enforce`] -- including an id neither carriage's role
/// decision could actually hand this function, since a policy built from
/// every configured peer has an entry for every peer id `payment_required`
/// can ever be called with.
///
/// Deliberately as narrow as [`connector_peer_auth::PeerAuthPolicy`]: this
/// is not the role decision and holds nothing that is (`peer.rs`'s own
/// narrowness note) -- one fact per peer, read only by [`payment_required`],
/// built once from configuration and shared by every interaction.
#[derive(Debug, Clone, Default)]
pub struct ClaimEnforcementPolicy {
    by_peer: BTreeMap<String, ClaimEnforcement>,
}

impl ClaimEnforcementPolicy {
    /// A policy over every configured peering's own [`ClaimEnforcement`].
    #[must_use]
    pub fn from_peers(peers: &[PeerConfig]) -> Self {
        ClaimEnforcementPolicy {
            by_peer: peers
                .iter()
                .map(|peer| (peer.id().to_string(), peer.claim_enforcement()))
                .collect(),
        }
    }

    /// A policy over explicit `(peer id, mode)` pairs, for a caller that has
    /// no [`PeerConfig`] to build from -- a test standing up a policy
    /// [`connector_config::Config::load`]'s validation would not otherwise
    /// let it construct directly.
    #[must_use]
    pub fn new<'a>(entries: impl IntoIterator<Item = (&'a str, ClaimEnforcement)>) -> Self {
        ClaimEnforcementPolicy {
            by_peer: entries
                .into_iter()
                .map(|(id, mode)| (id.to_string(), mode))
                .collect(),
        }
    }

    /// `peer_id`'s configured enforcement, or [`ClaimEnforcement::Enforce`]
    /// for an id this policy has no entry for -- the safe default holds even
    /// if this is ever asked about a peer id no `[[peers]]` row named.
    #[must_use]
    pub fn mode(&self, peer_id: &str) -> ClaimEnforcement {
        self.by_peer
            .get(peer_id)
            .copied()
            .unwrap_or(ClaimEnforcement::Enforce)
    }
}

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
/// this connector would not accept". Admitting an uncovered packet under
/// [`ClaimEnforcement::Observe`] is logged the same way, at the same level,
/// so an operator grepping for shortfalls sees every one whether or not this
/// peering has been flipped to enforce (issue #883, child B6).
#[must_use]
pub fn payment_required(
    connector: &Connector,
    peer_id: &str,
    destination: &str,
    ack: ClaimAckOutcome,
    claim: Option<&WireClaim>,
    prior_watermark: Option<Watermark>,
    enforcement: ClaimEnforcement,
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
    let shortfall = price.saturating_sub(advanced);

    if enforcement == ClaimEnforcement::Observe {
        // Migration-only (issue #883): the packet is admitted exactly as it
        // was before issue #880, but logged so an operator can confirm
        // real admissions before flipping this peering to enforce.
        tracing::warn!(
            peer_id,
            destination,
            price,
            advanced,
            shortfall,
            claim_ack = ?ack,
            "peer PREPARE admitted without a covering claim (claim_enforcement = observe; \
             issue #883 -- this peering is not yet enforcing)"
        );
        return None;
    }

    tracing::warn!(
        peer_id,
        destination,
        price,
        advanced,
        shortfall,
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
