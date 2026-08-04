//! Role-by-authentication: whether an interaction is a **peer** or a
//! **client**, decided from a presented credential and configuration alone
//! (`docs/protocol/peer-carriage-spec.md` §1, issue #726).
//!
//! ADR 0026 could prove role by construction — peers spoke a different
//! protocol on a different listener, so no client trust could leak onto a
//! peer session and no peer trust onto a client one. ADR 0027 spent that
//! proof: peers now ride the same two carriages clients do, and what
//! replaces the proof is this crate. Everything here is a stop-ship
//! invariant.
//!
//! # The rule (§1.2)
//!
//! An interaction has role `peer` **if and only if both** hold:
//!
//! * **P1** — it presented a credential naming a peer id that appears in
//!   `[[peers]]`, and the presented secret matched that peer's configured
//!   secret, compared in constant time. An empty configured secret matches
//!   nothing.
//! * **P2** — that peer has at least one `[[peer_channels]]` entry.
//!
//! If either fails, for any reason, the role is `client`. There is no
//! fallthrough, no degraded peer, no third state: [`SessionRole`] has two
//! variants and no `Unknown`.
//!
//! # Why the decision cannot see the transport (§1.3)
//!
//! §1.3 forbids inferring role from the carriage, the listener, the port,
//! the bind address, the source address, the TLS SNI name, a client
//! certificate, the `btp` subprotocol, an endpoint appearing in
//! `[[peers]]`, the shape of what was sent, or anything the interaction —
//! or another interaction from the same address — did earlier.
//!
//! That is enforced here structurally rather than by review, in three
//! layers:
//!
//! 1. **The signature.** [`decide_role`] takes exactly
//!    `(Option<&PresentedCredential>, &PeerAuthPolicy)` and returns a
//!    [`RoleDecision`]. A [`PresentedCredential`] holds a peer id and a
//!    secret and nothing else; a [`PeerAuthPolicy`] is built from
//!    configuration and nothing else. Neither type has a field a port
//!    number, a peer address or a carriage could be smuggled in, so a
//!    caller wanting to weight one has nowhere to put it.
//! 2. **The dependency graph.** This crate depends on `connector-config`
//!    and three encoding libraries. It depends on no async runtime, no
//!    HTTP or websocket stack, and no other connector crate — so it cannot
//!    name a socket, a request, a session or a frame even privately.
//!    [`tests::the_decision_crate_cannot_name_a_transport`] asserts that
//!    against the manifest, so a future dependency has to argue with a
//!    failing test.
//! 3. **No I/O and no clock.** Nothing here reads a socket, a file or the
//!    time. Every function is pure, which is what makes the whole surface
//!    testable without one (ADR 0007: fakes yes, mocks no) — the rate limit
//!    on the operator event takes `now_ms` as an argument rather than
//!    reading a clock.
//!
//! There is deliberately **no** "trusted network" or "loopback is a peer"
//! escape hatch. Every such shortcut is transport inference wearing a
//! different hat, and §1.3 does not have an exception for the convenient
//! ones. The one escape hatch ADR 0027 does name — a dedicated peer
//! listener (§1.10) — is defence in depth that changes *nothing* here: role
//! is still decided by P1 and P2, and the listener only changes what a
//! carriage does with a `client` verdict on it.
//!
//! # What this crate is not
//!
//! It is not a carriage. The BTP peer carriage (issue #727) and the
//! ILP-over-HTTP one (issue #728) own sessions, frames, headers, requests
//! and responses. They own the session-lifetime rules of §1.5 too — role
//! bound once, a second `auth` answered with an ERROR rather than
//! evaluated, pre-auth frames never retroactively reclassified — but the
//! shapes that make those easy to honour are here: [`SessionRoleBinding`]
//! refuses a second bind, and [`present_raw`] / [`present_base64`] refuse
//! an ambiguous credential rather than resolving one.
//!
//! # Layout
//!
//! | Module | What it holds |
//! | ------ | -------------- |
//! | [`credential`] | the one JSON shape and its two encodings, and the duplicate refusal |
//! | [`policy`] | the configured side: which peer ids have which secret, and which are channel-bound |
//! | [`decision`] | [`decide_role`], its verdict, and the `peer_auth_refused` operator event |
//! | [`role`] | the two roles, the containment enumeration, and the session binding |

pub mod credential;
pub mod decision;
pub mod policy;
pub mod role;

pub use credential::{
    decode_base64, decode_raw, encode_base64, encode_raw, present_base64, present_raw,
    AmbiguousCredential, CarriageNames, CredentialDecodeError, PresentedCredential,
    PEER_AUTH_HEADER, PEER_AUTH_NAMES, PEER_AUTH_PROTOCOL_ENTRY,
};
pub use decision::{
    decide_role, PeerAuthRefusal, PeerAuthRefusalLog, PeerAuthRefusalReport, RoleDecision,
    UnmetRequirement, PEER_AUTH_REFUSED_EVENT,
};
pub use policy::PeerAuthPolicy;
pub use role::{
    claim_ack_to_emit, honoured_minimum_delivery, Capability, RoleAlreadyBound, SessionRole,
    SessionRoleBinding,
};

#[cfg(test)]
mod tests {
    /// Crates whose presence in this crate's `[dependencies]` would mean
    /// the role decision *could* see something §1.3 forbids it from
    /// weighing. The list is the transports and runtimes this workspace
    /// actually uses, plus the two connector crates that own a wire.
    ///
    /// This is the mechanical half of the property; the other half is
    /// [`crate::decide_role`]'s signature, which has nowhere to put a
    /// transport fact even if one were reachable.
    const TRANSPORT_CRATES: &[&str] = &[
        "tokio",
        "axum",
        "hyper",
        "reqwest",
        "tungstenite",
        "tower",
        "h2",
        "rustls",
        "socket2",
        "mio",
        "connector-btp",
        "connector-client-edge",
        "connector-runtime",
        "connector-operator",
    ];

    /// The `[dependencies]` section only: `[dev-dependencies]` may name
    /// `connector-btp`, because the test that keeps [`PEER_AUTH_NAMES`]
    /// from forking needs the frame grammar's own constant and a
    /// dev-dependency is not linkable into anything this crate ships.
    ///
    /// [`PEER_AUTH_NAMES`]: crate::PEER_AUTH_NAMES
    fn declared_dependencies() -> String {
        let manifest = include_str!("../Cargo.toml");
        let mut inside = false;
        let mut collected = String::new();
        for line in manifest.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('[') {
                inside = trimmed == "[dependencies]";
                continue;
            }
            // Comments are prose about the dependencies, not dependencies;
            // this test would otherwise forbid explaining itself.
            if inside && !trimmed.starts_with('#') {
                collected.push_str(trimmed);
                collected.push('\n');
            }
        }
        collected
    }

    #[test]
    fn the_decision_crate_cannot_name_a_transport() {
        let dependencies = declared_dependencies();

        for forbidden in super::tests::TRANSPORT_CRATES {
            assert!(
                !dependencies.contains(forbidden),
                "connector-peer-auth grew a dependency on `{forbidden}`. Role is decided by \
                 the credential and the config, never by the transport \
                 (peer-carriage-spec.md §1.3): a crate that can name a socket, a session or a \
                 frame is a crate where someone can weight one. Dependencies were:\n\
                 {dependencies}"
            );
        }
    }

    /// Guards the guard: a manifest whose `[dependencies]` section this
    /// parser fails to find would pass the assertion above vacuously.
    #[test]
    fn the_transport_guard_reads_a_non_empty_dependency_section() {
        let dependencies = declared_dependencies();

        assert!(
            dependencies.contains("connector-config"),
            "the dependency-section parser found nothing, so the transport guard proves \
             nothing; got:\n{dependencies}"
        );
    }
}
