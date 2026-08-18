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
//! # What it is scoped to
//!
//! **Every arrival this connector will act on**, which since ADR 0042 means
//! two rules rather than one, judged against two different figures:
//!
//! - A **`Terminated`** route's own `price` (ADR 0029, issue #880), exactly
//!   like the pre-existing `F03` amount check `Connector::handle_peer_prepare`
//!   still runs after it. Unchanged in every respect by ADR 0042.
//! - A **`Forwarded`** route's own **packet `amount`** (ADR 0042's item 3).
//!   Not a price and not the fee: on the send side
//!   `Connector::forward_via_peer_route` covers the next hop for
//!   `amount_after_fee(amount, fee, minimum_delivery)`, so the upstream peer
//!   must cover the amount arriving *here* and this connector keeps the
//!   difference -- which is exactly its flat fee (ADR 0010). A route's
//!   `price` is a client-edge fact (ADR 0028) and stays irrelevant on the
//!   peer path.
//!
//! A route deliberately priced at `0` (ADR 0020) is free on the peer path
//! exactly as it is on the client edge, and a zero-amount forward likewise
//! requires nothing.
//!
//! A destination this connector does not resolve to a configured route at
//! all -- no match, or a **leased** route, which `Connector::client_route`
//! excludes by construction (ADR 0028, ADR 0029's "leased routes are
//! unaffected") -- is not gated here and is left exactly as it was. ADR 0042
//! item 3 names the `ClientRouteKind::Terminated` filter as the gap, and the
//! lease path is not the gap it names.
//!
//! # Why the forwarded rule defaults to observing
//!
//! Because it is the one item ADR 0042 flags as breaking. Neither devnet box
//! covers a forward today, and each forwards to the other, so a gate that
//! enforced on arrival by default would stop forwarding across the fleet on
//! the first rollout. [`connector_config::ForwardedClaimEnforcement`] is a
//! **separate** per-peer setting from [`ClaimEnforcement`], defaulting the
//! opposite way, and an operator flips one peering at a time once its
//! counterparty's send half is live. The terminated rule's own default is
//! untouched.

use std::collections::BTreeMap;

use connector_config::{ClaimEnforcement, ForwardedClaimEnforcement, PeerConfig};
use connector_domain::x402::GreetingTerms;
use connector_domain::{validate_price, Prepare, Reject, RejectCode, Watermark};
use connector_runtime::{ClaimAckOutcome, ClientRouteKind, Connector, WireClaim};

/// One peering's two enforcement answers: what happens to an uncovered
/// arrival at a priced **termination** (ADR 0029) and what happens to an
/// uncovered arrival this connector would **forward** (ADR 0042).
///
/// Two fields rather than one because they default in opposite directions
/// and always have -- see [`ForwardedClaimEnforcement`] for why. [`Default`]
/// is therefore "the behaviour of a peering that configured neither":
/// terminated arrivals refused, forwarded arrivals admitted and logged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PeerClaimEnforcement {
    /// ADR 0029's rule (issue #880), defaulting to
    /// [`ClaimEnforcement::Enforce`].
    pub terminated: ClaimEnforcement,
    /// ADR 0042 item 3's rule, defaulting to
    /// [`ForwardedClaimEnforcement::Observe`].
    pub forwarded: ForwardedClaimEnforcement,
}

impl PeerClaimEnforcement {
    /// Every configured peering's pair, as [`PeerConfig`] resolved them.
    fn of(peer: &PeerConfig) -> Self {
        PeerClaimEnforcement {
            terminated: peer.claim_enforcement(),
            forwarded: peer.forwarded_claim_enforcement(),
        }
    }
}

/// Each peering's [`PeerClaimEnforcement`], the rest reading as
/// [`PeerClaimEnforcement::default`] -- including an id neither carriage's
/// role decision could actually hand this function, since a policy built
/// from every configured peer has an entry for every peer id
/// [`payment_required`] can ever be called with.
///
/// Deliberately as narrow as [`connector_peer_auth::PeerAuthPolicy`]: this
/// is not the role decision and holds nothing that is (`peer.rs`'s own
/// narrowness note) -- one fact per peer, read only by [`payment_required`],
/// built once from configuration and shared by every interaction.
#[derive(Debug, Clone, Default)]
pub struct ClaimEnforcementPolicy {
    by_peer: BTreeMap<String, PeerClaimEnforcement>,
}

impl ClaimEnforcementPolicy {
    /// A policy over every configured peering's own two settings.
    #[must_use]
    pub fn from_peers(peers: &[PeerConfig]) -> Self {
        ClaimEnforcementPolicy {
            by_peer: peers
                .iter()
                .map(|peer| (peer.id().to_string(), PeerClaimEnforcement::of(peer)))
                .collect(),
        }
    }

    /// A policy over explicit `(peer id, terminated mode)` pairs, for a
    /// caller that has no [`PeerConfig`] to build from -- a test standing up
    /// a policy [`connector_config::Config::load`]'s validation would not
    /// otherwise let it construct directly. Each named peering's forwarded
    /// mode is the default, exactly as an unwritten field resolves.
    #[must_use]
    pub fn new<'a>(entries: impl IntoIterator<Item = (&'a str, ClaimEnforcement)>) -> Self {
        ClaimEnforcementPolicy::of(entries.into_iter().map(|(id, terminated)| {
            (
                id,
                PeerClaimEnforcement {
                    terminated,
                    ..PeerClaimEnforcement::default()
                },
            )
        }))
    }

    /// [`Self::new`], for a caller that wants to set both of a peering's
    /// modes rather than only the terminated one.
    #[must_use]
    pub fn of<'a>(entries: impl IntoIterator<Item = (&'a str, PeerClaimEnforcement)>) -> Self {
        ClaimEnforcementPolicy {
            by_peer: entries
                .into_iter()
                .map(|(id, modes)| (id.to_string(), modes))
                .collect(),
        }
    }

    /// `peer_id`'s configured enforcement, or [`PeerClaimEnforcement::default`]
    /// for an id this policy has no entry for -- each rule's own safe default
    /// holds even if this is ever asked about a peer id no `[[peers]]` row
    /// named.
    #[must_use]
    pub fn mode(&self, peer_id: &str) -> PeerClaimEnforcement {
        self.by_peer.get(peer_id).copied().unwrap_or_default()
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

/// Judge one peer PREPARE's coverage: `None` when it is admitted, `Some`
/// when it must be refused.
///
/// **What must be covered depends on where the packet is going**, and the
/// two figures are not the same kind of thing:
///
/// - a `Terminated` route: that route's own `price` (ADR 0029);
/// - a `Forwarded` route: this PREPARE's own `amount` (ADR 0042), because
///   `Connector::forward_via_peer_route` will cover the next hop for the
///   post-fee remainder of exactly that figure. The difference this
///   connector keeps is its fee, and no third number is involved.
///
/// `claim` and `prior_watermark` are what this PREPARE rode in on:
/// `prior_watermark` MUST be read *before* the claim was judged (and so
/// possibly recorded), so coverage is the claim's own advance rather than
/// the zero advance past the watermark it just became. Both rules measure
/// that advance the same way, through [`validate_price`].
///
/// Coverage requires the claim book's own verdict to be
/// [`ClaimAckOutcome::Accepted`], not merely that a claim decoded: a forged
/// signature or a replayed nonce still decodes and can still declare any
/// `cumulative_amount` it likes, so judging off that declared amount would
/// let an unlimited-value, never-verified claim buy service.
///
/// Refusing is logged rather than silent (Pattern 34): the peer, the
/// destination, what was required, the shortfall, and the claim's own
/// verdict -- which is what distinguishes "paid too little" from "paid with
/// a claim this connector would not accept". Admitting an uncovered packet
/// under [`ClaimEnforcement::Observe`] or
/// [`ForwardedClaimEnforcement::Observe`] is logged the same way, at the
/// same level, so an operator grepping for shortfalls sees every one whether
/// or not this peering has been flipped to enforce (issue #883, child B6).
/// The two rules keep **separate** message text, because each rollout is
/// watched separately and `docs/operators/claim-policy-rollout.md` greps the
/// terminated one by name.
#[must_use]
pub fn payment_required(
    connector: &Connector,
    peer_id: &str,
    prepare: &Prepare,
    ack: ClaimAckOutcome,
    claim: Option<&WireClaim>,
    prior_watermark: Option<Watermark>,
    enforcement: PeerClaimEnforcement,
) -> Option<PaymentRequired> {
    // Both rules are answered from the PREPARE already in hand (ADR 0029),
    // never from the claim exchange: the destination decides *which* figure
    // must be covered, and for a forward the packet's own `amount` IS that
    // figure.
    let destination = prepare.destination.as_str();
    // A destination that resolves to no configured route -- unmatched, or
    // leased -- is not this gate's business and never has been.
    let route = connector.client_route(destination)?;
    let (required, enforcing) = match route.kind {
        ClientRouteKind::Terminated => (
            route.price,
            enforcement.terminated == ClaimEnforcement::Enforce,
        ),
        ClientRouteKind::Forwarded => (
            prepare.amount,
            enforcement.forwarded == ForwardedClaimEnforcement::Enforce,
        ),
    };
    if required == 0 {
        return None;
    }

    let covers = ack == ClaimAckOutcome::Accepted
        && claim.is_some_and(|claim| {
            validate_price(prior_watermark, claim.cumulative_amount, required).is_ok()
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
    let shortfall = required.saturating_sub(advanced);

    if !enforcing {
        // Migration-only: the packet is admitted exactly as it was before
        // this peering's rule started applying, but logged so an operator
        // can confirm real admissions before flipping it to enforce.
        match route.kind {
            // Issue #883. The runbook greps this line's text by name --
            // `docs/operators/claim-policy-rollout.md`, Order step 4 -- so
            // it says `price` and reads verbatim as it did.
            ClientRouteKind::Terminated => tracing::warn!(
                peer_id,
                destination,
                price = required,
                advanced,
                shortfall,
                claim_ack = ?ack,
                "peer PREPARE admitted without a covering claim (claim_enforcement = observe; \
                 issue #883 -- this peering is not yet enforcing)"
            ),
            ClientRouteKind::Forwarded => tracing::warn!(
                peer_id,
                destination,
                amount = required,
                advanced,
                shortfall,
                claim_ack = ?ack,
                "peer PREPARE admitted without a covering claim \
                 (forwarded_claim_enforcement = observe; ADR 0042 -- this peering is not yet \
                 enforcing on forwarded arrivals)"
            ),
        }
        return None;
    }

    match route.kind {
        ClientRouteKind::Terminated => tracing::warn!(
            peer_id,
            destination,
            price = required,
            advanced,
            shortfall,
            claim_ack = ?ack,
            "peer PREPARE refused: no claim covers this packet's price"
        ),
        ClientRouteKind::Forwarded => tracing::warn!(
            peer_id,
            destination,
            amount = required,
            advanced,
            shortfall,
            claim_ack = ?ack,
            "peer PREPARE refused: no claim covers this packet's amount"
        ),
    }
    Some(PaymentRequired {
        reject: Reject {
            code: RejectCode::f06_unexpected_payment(),
            triggered_by: String::new(),
            message: match route.kind {
                ClientRouteKind::Terminated => {
                    "no payment channel claim covers this packet's price".to_string()
                }
                ClientRouteKind::Forwarded => {
                    "no payment channel claim covers this packet's amount".to_string()
                }
            },
            data: Vec::new(),
            accumulated_cost: 0,
        },
        // A peering has no bootstrap identity to advertise and no client
        // session to lease: the peer already knows this node, and what it
        // needs quoted is the figure alone -- the route's price where this
        // node terminates, the packet's own amount where it forwards.
        terms: connector_domain::x402::terms_body(&GreetingTerms {
            destination,
            price: required,
            ..Default::default()
        }),
    })
}
