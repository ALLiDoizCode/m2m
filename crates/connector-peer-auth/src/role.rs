//! The two roles, what each one grants, and how a session binds one.
//!
//! §1.7 states the containment as an enumeration "because 'peer trust' and
//! 'client trust' are otherwise undefined, and undefined trust is what
//! leaks". It is an enumeration here too, for the same reason: [`Capability`]
//! is a closed enum matched exhaustively by [`SessionRole::grants`], so
//! adding a capability without deciding which roles hold it does not
//! compile.

use std::fmt;

/// The role of one interaction — a BTP session from its websocket upgrade
/// to its close, or a single HTTP request (§1.1).
///
/// Two variants, and there will not be a third. §1.2 admits no `Unknown`,
/// no unroled state and no degraded peer: "if either fails, for any
/// reason, the interaction has role `client`". An `Unknown` variant would
/// be a state every downstream match has to handle, and the handling it
/// would get is the fallthrough §1.2 forbids.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum SessionRole {
    /// Everything that is not a proven peer, including an interaction that
    /// asserted a peer id and failed to prove it (§1.6). The default,
    /// because §1.5 starts every session here.
    #[default]
    Client,
    /// A proven peering: P1 and P2 both held.
    Peer {
        /// The **configured** peer id — the `[[peers]]` entry that was
        /// proven, not the string the interaction asserted. They are equal
        /// bytes, but taking it from config is what lets everything
        /// downstream treat it as an identifier rather than as input.
        peer_id: String,
    },
}

impl SessionRole {
    /// A proven peering with `peer_id`.
    #[must_use]
    pub fn peer(peer_id: impl Into<String>) -> Self {
        SessionRole::Peer {
            peer_id: peer_id.into(),
        }
    }

    /// Whether this is a proven peering.
    #[must_use]
    pub fn is_peer(&self) -> bool {
        matches!(self, SessionRole::Peer { .. })
    }

    /// Whether this is a client interaction.
    #[must_use]
    pub fn is_client(&self) -> bool {
        matches!(self, SessionRole::Client)
    }

    /// The proven peer id, or `None` for a client.
    #[must_use]
    pub fn peer_id(&self) -> Option<&str> {
        match self {
            SessionRole::Client => None,
            SessionRole::Peer { peer_id } => Some(peer_id),
        }
    }

    /// The name this role is metered and logged under (ADR 0014).
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            SessionRole::Client => "client",
            SessionRole::Peer { .. } => "peer",
        }
    }

    /// Whether this role holds `capability` — §1.7's enumeration, as one
    /// exhaustive match.
    #[must_use]
    pub fn grants(&self, capability: Capability) -> bool {
        match capability {
            // Peer grants, "and only these" (§1.7).
            Capability::AdvancePeerWatermark
            | Capability::AppendToPeerClaimLedger
            | Capability::HonourMinimumDelivery
            | Capability::EmitClaimAck
            | Capability::AcceptFlush
            | Capability::BeARouteNextHop
            | Capability::CountTowardPeeringExposure => self.is_peer(),

            // §1.7's "peer role does NOT grant". Held by neither role, so
            // a caller reaching for one has no role to reach it with.
            Capability::FreeCarriage
            | Capability::RouteNotInRoutingTable
            | Capability::OperatorSurface
            | Capability::ExemptionFromSealing
            | Capability::SetRoutePrice
            | Capability::OpenForwardedPayload => false,
        }
    }
}

impl fmt::Display for SessionRole {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// §1.7's containment enumeration, spelled as values so it can be asserted
/// rather than remembered.
///
/// Two kinds of entry live here. The first seven are the peer role's
/// grants: things a peer interaction may do and a client interaction MUST
/// be refused **even when it presents bytes that look like them**. The
/// last six are §1.7's "peer role does NOT grant" list — held by *neither*
/// role, recorded here because "peer trust" left undefined is exactly the
/// undefined trust that leaks, and because a reader looking for the limits
/// of a peering should find them beside its powers.
///
/// One §1.7 line is deliberately absent: `accumulatedCost` relayed with
/// this hop's own fee added. It is a peer grant in §1.7's list, but it is
/// not role-*discriminating* — a client interaction accumulates cost on a
/// reject too (ADR 0011), so a `Capability` returning `false` for a client
/// would assert something untrue. It is named in §1.7 because a peer hop
/// adds its own fee to a figure it received, not because the field is
/// refused to a client.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Capability {
    /// Advance a `[[peer_channels]]` watermark. Peer only: peer and client
    /// watermarks are separate records in separate namespaces (§1.8), and
    /// a claim judged in one may never advance the other. A client
    /// interaction presenting a claim that names a `[[peer_channels]]`
    /// channel is still a client — §1.3 forbids inferring role from "a
    /// claim naming a channel that happens to be in `[[peer_channels]]`" —
    /// and `ChannelInBothNamespaces` keeps the two from ever describing
    /// the same money.
    AdvancePeerWatermark,
    /// Append to the peer claim ledger.
    AppendToPeerClaimLedger,
    /// Honour a declared `minimumDelivery` as a sender declaration (§5,
    /// `peer-semantics-spec.md` §4). A client's is **ignored** — not rejected
    /// and not applied. Use [`honoured_minimum_delivery`] rather than
    /// reading this directly, so the ignoring is done by a function
    /// instead of remembered.
    HonourMinimumDelivery,
    /// Emit a `claim-ack` / `Toon-Claim-Ack` on a response. A connector
    /// MUST NOT emit one on a client interaction. See
    /// [`claim_ack_to_emit`].
    EmitClaimAck,
    /// Accept a FLUSH (§6).
    AcceptFlush,
    /// Be a route's next hop: this peering relation may appear in the
    /// routing table as somewhere to forward to. Not the same as having
    /// one's packets forwarded, which a client's are — the discriminating
    /// half is being a *destination* the table can name.
    BeARouteNextHop,
    /// Be eligible for §6.4's flush prompt (`Toon-Flush-Requested`). A
    /// client interaction is never treated as a peering relation for flush
    /// purposes. Named for the credit-window exposure/ceiling accounting
    /// this capability originally gated too; that machinery is retired
    /// (ADR 0031, ADR 0033, issue #882) and this is now the flush prompt's
    /// own gate.
    CountTowardPeeringExposure,

    /// Carriage without paying for it. Granted to neither role: a peering
    /// is not a discount.
    FreeCarriage,
    /// A route the routing table does not have. Neither role conjures one.
    RouteNotInRoutingTable,
    /// Any operator or admin surface (ADR 0008). A peering is a money
    /// relationship, not an administrative one.
    OperatorSurface,
    /// Exemption from sealing (§8). A peer's packets are sealed to the
    /// terminating connector exactly as a client's are (ADR 0018).
    ExemptionFromSealing,
    /// A say in this connector's fees or a route's price (ADR 0020).
    SetRoutePrice,
    /// Opening the payload of a packet it forwards (ADR 0016).
    OpenForwardedPayload,
}

impl Capability {
    /// Every capability, so a test can assert the whole table rather than
    /// the rows someone remembered to write.
    pub const ALL: &'static [Capability] = &[
        Capability::AdvancePeerWatermark,
        Capability::AppendToPeerClaimLedger,
        Capability::HonourMinimumDelivery,
        Capability::EmitClaimAck,
        Capability::AcceptFlush,
        Capability::BeARouteNextHop,
        Capability::CountTowardPeeringExposure,
        Capability::FreeCarriage,
        Capability::RouteNotInRoutingTable,
        Capability::OperatorSurface,
        Capability::ExemptionFromSealing,
        Capability::SetRoutePrice,
        Capability::OpenForwardedPayload,
    ];
}

/// The minimum delivery this interaction's declaration actually buys.
///
/// `Some(declared)` for a peer, `None` for a client — whatever the client
/// declared, and whatever type carries it. §1.7: a client interaction's
/// minimum-delivery field MUST be **ignored**, not rejected and not
/// applied. §12.5 records why ignoring was chosen over refusing: a client
/// SDK that sets an unrecognised header must not be broken by a peer
/// feature, and no error message may disclose the peer surface.
///
/// Generic over the value so the carriages can carry minimum delivery in
/// whatever type they already have, and so this function cannot grow an
/// opinion about the wire.
#[must_use]
pub fn honoured_minimum_delivery<T>(role: &SessionRole, declared: Option<T>) -> Option<T> {
    if role.grants(Capability::HonourMinimumDelivery) {
        declared
    } else {
        None
    }
}

/// The claim acknowledgement this interaction's response may carry.
///
/// `None` for a client, always: §1.7 forbids a `claim-ack` /
/// `Toon-Claim-Ack` on a client response. Routing the ack through this
/// function makes "a client response never carries a claim-ack" a thing
/// the code does rather than a thing the code remembers.
#[must_use]
pub fn claim_ack_to_emit<T>(role: &SessionRole, acknowledgement: Option<T>) -> Option<T> {
    if role.grants(Capability::EmitClaimAck) {
        acknowledgement
    } else {
        None
    }
}

/// A second role decision arrived on a session whose role is already bound.
///
/// §1.5: it MUST NOT be evaluated, the role MUST be left unchanged, and
/// the frame MUST be answered with a BTP ERROR (`code F00`, `name
/// NotAcceptedError`). Re-authentication mid-session is the escalation
/// path that closes.
///
/// The BTP code and name are named in this doc comment and nowhere in this
/// crate's types: they are the carriage's vocabulary, and a crate that
/// spelled them would be a crate that knows what a frame is.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error(
    "role is already bound for this session and MUST NOT be re-evaluated \
     (peer-carriage-spec.md §1.5)"
)]
pub struct RoleAlreadyBound;

/// A session's role over its lifetime (§1.5), for the carriage that owns
/// the session.
///
/// It starts `client` and binds **once**. Three of §1.5's rules fall out
/// of the shape rather than out of discipline:
///
/// * *Role is bound once and immutable for the session's lifetime* —
///   [`SessionRoleBinding::bind`] returns [`RoleAlreadyBound`] on a second
///   call and leaves the role untouched. There is no setter and no way to
///   unbind.
/// * *A second `auth` on a bound session MUST NOT be evaluated* — the
///   carriage calls `bind` before it calls [`crate::decide_role`], or
///   discards the decision on the error; either way the role does not
///   move.
/// * *Frames processed before the role is bound are client frames and are
///   never retroactively reclassified* — a binding has no history to
///   rewrite. It answers what the role is **now**, and a claim already
///   ingested as a client claim was ingested against the value this
///   returned then.
///
/// An HTTP carriage has no session and needs none of this: it decides per
/// request (§1.4), because HTTP has no session for a role to outlive.
#[derive(Debug, Clone, Default)]
pub struct SessionRoleBinding {
    role: SessionRole,
    bound: bool,
}

impl SessionRoleBinding {
    /// A fresh session: `client`, unbound. Every session starts here,
    /// including one that is about to prove a peering — §1.5's "a session
    /// starts as `client`".
    #[must_use]
    pub fn new() -> Self {
        SessionRoleBinding::default()
    }

    /// This session's role right now.
    #[must_use]
    pub fn role(&self) -> &SessionRole {
        &self.role
    }

    /// Whether a role decision has already been evaluated for this
    /// session. A carriage checks this to answer a second credential with
    /// an ERROR *without* evaluating it.
    #[must_use]
    pub fn is_bound(&self) -> bool {
        self.bound
    }

    /// Bind this session's role to a decided one.
    ///
    /// Succeeds exactly once. A second call is [`RoleAlreadyBound`] and
    /// changes nothing — including when the second decision is the same
    /// one, and including when it would *downgrade*, because a rule that
    /// permitted the harmless direction would need to decide which
    /// direction is harmless.
    pub fn bind(&mut self, role: SessionRole) -> Result<&SessionRole, RoleAlreadyBound> {
        if self.bound {
            return Err(RoleAlreadyBound);
        }
        self.role = role;
        self.bound = true;
        Ok(&self.role)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_peer_holds_every_peer_grant_and_a_client_holds_none_of_them() {
        let peer = SessionRole::peer("store-box");
        let client = SessionRole::Client;

        for capability in [
            Capability::AdvancePeerWatermark,
            Capability::AppendToPeerClaimLedger,
            Capability::HonourMinimumDelivery,
            Capability::EmitClaimAck,
            Capability::AcceptFlush,
            Capability::BeARouteNextHop,
            Capability::CountTowardPeeringExposure,
        ] {
            assert!(peer.grants(capability), "peer should grant {capability:?}");
            assert!(
                !client.grants(capability),
                "client must be refused {capability:?} (peer-carriage-spec.md §1.7)"
            );
        }
    }

    #[test]
    fn the_capabilities_no_role_grants_are_granted_to_no_role() {
        let peer = SessionRole::peer("store-box");
        let client = SessionRole::Client;

        for capability in [
            Capability::FreeCarriage,
            Capability::RouteNotInRoutingTable,
            Capability::OperatorSurface,
            Capability::ExemptionFromSealing,
            Capability::SetRoutePrice,
            Capability::OpenForwardedPayload,
        ] {
            assert!(
                !peer.grants(capability),
                "peer role does NOT grant {capability:?} (peer-carriage-spec.md §1.7)"
            );
            assert!(!client.grants(capability));
        }
    }

    /// The table has to cover every capability, or a capability added
    /// without a decision would be untested rather than undecided.
    #[test]
    fn every_capability_is_covered_by_the_two_tables_above() {
        let covered = [
            Capability::AdvancePeerWatermark,
            Capability::AppendToPeerClaimLedger,
            Capability::HonourMinimumDelivery,
            Capability::EmitClaimAck,
            Capability::AcceptFlush,
            Capability::BeARouteNextHop,
            Capability::CountTowardPeeringExposure,
            Capability::FreeCarriage,
            Capability::RouteNotInRoutingTable,
            Capability::OperatorSurface,
            Capability::ExemptionFromSealing,
            Capability::SetRoutePrice,
            Capability::OpenForwardedPayload,
        ];

        assert_eq!(covered.len(), Capability::ALL.len());
        for capability in Capability::ALL {
            assert!(covered.contains(capability), "uncovered: {capability:?}");
        }
    }

    /// §1.7: ignored, not rejected and not applied.
    #[test]
    fn a_clients_minimum_delivery_is_ignored_and_a_peers_is_honoured() {
        assert_eq!(
            honoured_minimum_delivery(&SessionRole::Client, Some(42_u64)),
            None
        );
        assert_eq!(
            honoured_minimum_delivery(&SessionRole::peer("store-box"), Some(42_u64)),
            Some(42)
        );
        assert_eq!(
            honoured_minimum_delivery::<u64>(&SessionRole::peer("store-box"), None),
            None
        );
    }

    #[test]
    fn a_client_response_never_carries_a_claim_ack() {
        assert_eq!(
            claim_ack_to_emit(&SessionRole::Client, Some("accepted")),
            None
        );
        assert_eq!(
            claim_ack_to_emit(&SessionRole::peer("store-box"), Some("accepted")),
            Some("accepted")
        );
    }

    #[test]
    fn a_session_starts_as_a_client_and_unbound() {
        let binding = SessionRoleBinding::new();

        assert_eq!(binding.role(), &SessionRole::Client);
        assert!(!binding.is_bound());
    }

    #[test]
    fn a_role_binds_once() {
        let mut binding = SessionRoleBinding::new();

        assert_eq!(
            binding
                .bind(SessionRole::peer("store-box"))
                .expect("first bind"),
            &SessionRole::peer("store-box")
        );
        assert!(binding.is_bound());
    }

    /// §1.5's anti-escalation rule, in the direction that matters: a
    /// second credential on a bound client session cannot promote it.
    #[test]
    fn a_second_bind_is_an_error_not_an_escalation() {
        let mut binding = SessionRoleBinding::new();
        binding.bind(SessionRole::Client).expect("first bind");

        assert_eq!(
            binding.bind(SessionRole::peer("store-box")),
            Err(RoleAlreadyBound)
        );
        assert_eq!(binding.role(), &SessionRole::Client);
    }

    /// And in the other direction too. A rule that allowed the "harmless"
    /// direction would have to decide which direction is harmless.
    #[test]
    fn a_second_bind_cannot_downgrade_either() {
        let mut binding = SessionRoleBinding::new();
        binding
            .bind(SessionRole::peer("store-box"))
            .expect("first bind");

        assert_eq!(binding.bind(SessionRole::Client), Err(RoleAlreadyBound));
        assert_eq!(binding.role(), &SessionRole::peer("store-box"));
    }

    #[test]
    fn a_role_names_itself_for_metrics_and_logs() {
        assert_eq!(SessionRole::Client.name(), "client");
        assert_eq!(SessionRole::peer("store-box").name(), "peer");
        assert_eq!(SessionRole::peer("store-box").peer_id(), Some("store-box"));
        assert_eq!(SessionRole::Client.peer_id(), None);
        assert!(SessionRole::Client.is_client());
        assert!(!SessionRole::Client.is_peer());
    }
}
