//! The decision itself (§1.2), and the operator event a failed assertion
//! owes (§1.6).

use std::collections::BTreeMap;

use crate::credential::PresentedCredential;
use crate::policy::PeerAuthPolicy;
use crate::role::SessionRole;

/// The name of the operator-visible event §1.6 requires, declared once so
/// a log line, a metric label and a test cannot each spell it differently.
pub const PEER_AUTH_REFUSED_EVENT: &str = "peer_auth_refused";

/// Which of §1.2's two requirements an assertion failed to meet.
///
/// Carried on the operator event because the two have completely different
/// fixes — a mistyped secret and a missing `[[peer_channels]]` row look
/// identical from the outside, and "peering configured, nothing peers, no
/// error anywhere" is the symptom §1.6 exists to prevent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum UnmetRequirement {
    /// **P1** — the presented secret did not match the configured one.
    /// Most often a mistyped or stale shared secret; the constant-time
    /// compare and the empty-configured-secret rule both live in
    /// [`connector_config::PeerCredential::matches`], so both failures
    /// arrive here.
    ProvenCredential,
    /// **P2** — the credential was proven, but the peering has no
    /// `[[peer_channels]]` entry, so there is nothing for its claims to be
    /// judged against. `Config::load` refuses this shape outright
    /// ([`connector_config::ConfigError::PeerChannelUnbound`]); reaching
    /// it at runtime means a policy was built from something other than a
    /// loaded config.
    ChannelBinding,
}

impl UnmetRequirement {
    /// The requirement's name in §1.2, for the operator event.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            UnmetRequirement::ProvenCredential => "P1",
            UnmetRequirement::ChannelBinding => "P2",
        }
    }
}

/// An interaction asserted a configured peer id and did not prove it
/// (§1.6).
///
/// This is not a refusal *on the wire*. §1.6 forbids that: refusing would
/// make the credential check an oracle for which peer ids this connector
/// has configured. The interaction is admitted, as a client, and this
/// value is what an operator sees instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerAuthRefusal {
    peer_id: String,
    unmet: UnmetRequirement,
}

impl PeerAuthRefusal {
    /// The **configured** peer id that was asserted.
    ///
    /// It comes from `[[peers]]`, never from the interaction — the two are
    /// equal bytes when a refusal exists at all, and taking config's copy
    /// is what keeps an attacker-chosen string out of the log line. An
    /// unconfigured peer id produces no refusal to carry one (see
    /// [`decide_role`]).
    #[must_use]
    pub fn peer_id(&self) -> &str {
        &self.peer_id
    }

    /// Which of P1/P2 failed.
    #[must_use]
    pub fn unmet(&self) -> UnmetRequirement {
        self.unmet
    }
}

/// The verdict: a role, and the operator event it owes.
///
/// The two travel together because §1.6 requires both halves of the same
/// outcome — the downgrade *and* the event. Returning only a role would
/// let a carriage implement the silent half and forget the loud one, which
/// is the failure §1.6 describes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleDecision {
    role: SessionRole,
    refusal: Option<PeerAuthRefusal>,
}

impl RoleDecision {
    /// The decided role. Never `Peer` when [`RoleDecision::refusal`] is
    /// `Some` — a refusal *is* the downgrade.
    #[must_use]
    pub fn role(&self) -> &SessionRole {
        &self.role
    }

    /// The `peer_auth_refused` event this decision owes an operator, if
    /// any. Feed it to a [`PeerAuthRefusalLog`] rather than emitting it
    /// directly: §1.6 requires the event be rate-limited.
    #[must_use]
    pub fn refusal(&self) -> Option<&PeerAuthRefusal> {
        self.refusal.as_ref()
    }

    /// Split the verdict, for a carriage that binds the role and reports
    /// the event on different paths.
    #[must_use]
    pub fn into_parts(self) -> (SessionRole, Option<PeerAuthRefusal>) {
        (self.role, self.refusal)
    }

    fn client() -> Self {
        RoleDecision {
            role: SessionRole::Client,
            refusal: None,
        }
    }

    fn refused(peer_id: &str, unmet: UnmetRequirement) -> Self {
        RoleDecision {
            role: SessionRole::Client,
            refusal: Some(PeerAuthRefusal {
                peer_id: peer_id.to_string(),
                unmet,
            }),
        }
    }

    fn peer(peer_id: &str) -> Self {
        RoleDecision {
            role: SessionRole::peer(peer_id),
            refusal: None,
        }
    }
}

/// **The decision** (§1.2): `peer` if and only if P1 and P2 both hold,
/// `client` otherwise.
///
/// ```text
/// (presented credential, configured peerings) -> role
/// ```
///
/// Those are the only two inputs, and that is the security property. There
/// is no third parameter for the carriage, the listener, the port, the
/// bind address, the source address, the TLS SNI name, a client
/// certificate, the `btp` subprotocol, an endpoint from `[[peers]]`, the
/// shape of what was sent, or anything this or another interaction did
/// earlier — §1.3's list, absent by construction rather than by
/// convention. A caller who wanted to weight one would have to change this
/// signature, and changing it is a reviewable act in a way that adding a
/// branch is not.
///
/// It is a free function rather than a method for the same reason: a
/// method on a session, a listener or a connection would have a `self`
/// with fields, and every one of those fields is something §1.3 forbids
/// consulting.
///
/// # Branches
///
/// | Presented | Outcome |
/// | --------- | ------- |
/// | nothing | `client`, no event — the ordinary client interaction |
/// | a peer id no `[[peers]]` entry configures | `client`, no event (see below) |
/// | a configured peer id, wrong or empty secret | `client` + `peer_auth_refused` (P1) |
/// | a configured peer id, right secret, no `[[peer_channels]]` row | `client` + `peer_auth_refused` (P2) |
/// | a configured peer id, right secret, at least one row | `peer` |
///
/// An **unconfigured** peer id produces no event, and that is §1.6 read
/// literally: an assertion is a credential that "names a configured peer
/// id" and fails. The reason it matters here is concrete rather than
/// pedantic — the BTP `auth` entry is shared with the client edge, where
/// `client-edge-spec.md` §1.9 has every ordinary client declare a `peerId`
/// of its own (issue #698 makes it the session registry's key). Emitting
/// on an unconfigured id would fire `peer_auth_refused` on essentially
/// every client session, which is both noise and a log-volume lever any
/// anonymous caller could pull. The cost is real and worth stating: a
/// genuine peer that mistypes its **peer id** rather than its secret
/// presents as an ordinary client with nothing logged. A mistyped secret
/// — the far likelier mistake, and the one §1.6 names — is loud.
#[must_use]
pub fn decide_role(
    presented: Option<&PresentedCredential>,
    policy: &PeerAuthPolicy,
) -> RoleDecision {
    // No credential: a client, and not an event. §1.4 -- "an unverifiable
    // or empty credential still admits a client session, exactly as
    // today, and can never admit a peer one".
    let Some(credential) = presented else {
        return RoleDecision::client();
    };

    let Some(entry) = policy.entry(credential.asserted_peer_id()) else {
        return RoleDecision::client();
    };

    // P1. The constant-time compare and the empty-configured-secret rule
    // are `PeerCredential::matches`'s, not reimplemented here: a second
    // comparison is a second place to forget that an empty secret matches
    // nothing, which is precisely the `no-auth` quasi-peer of §1.9.
    if !credential.proves(&entry.credential) {
        return RoleDecision::refused(&entry.id, UnmetRequirement::ProvenCredential);
    }

    // P2. Both requirements, never either -- a peering with a proven
    // secret and no channel binding has nothing for its claims to be
    // judged against, so admitting it as a peer would advance watermarks
    // in a namespace with no record behind them.
    if !entry.channel_bound {
        return RoleDecision::refused(&entry.id, UnmetRequirement::ChannelBinding);
    }

    // The peer id is config's, not the interaction's. They are equal bytes
    // here; taking config's is what makes everything downstream a
    // consumer of configuration rather than of input.
    RoleDecision::peer(&entry.id)
}

/// The event a [`PeerAuthRefusal`] becomes once rate limiting has had its
/// say.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerAuthRefusalReport {
    /// Always [`PEER_AUTH_REFUSED_EVENT`]; carried so a caller can emit
    /// the report without reaching for the constant separately.
    pub event: &'static str,
    /// The configured peer id that was asserted.
    pub peer_id: String,
    /// Which of P1/P2 failed.
    pub unmet: UnmetRequirement,
    /// How many identical refusals were suppressed since the last report
    /// for this peer id and requirement. A peering whose secret is wrong
    /// retries; the count is what keeps "still wrong, 4 000 times" from
    /// costing 4 000 log lines while still saying it is still wrong.
    pub suppressed: u64,
}

/// The rate limit §1.6 requires on `peer_auth_refused`.
///
/// One report per (peer id, unmet requirement) per window, carrying the
/// number suppressed since the last one. Rate limiting is *not* folded
/// into [`decide_role`]: a limiter has state and a notion of time, and the
/// decision must have neither. This owns both, and takes `now_ms` as an
/// argument rather than reading a clock — so its whole behaviour is
/// testable by advancing a `u64`, with no fake clock and no sleeping test
/// (ADR 0007).
///
/// Its key space is bounded by configuration: a refusal only ever names a
/// **configured** peer id, so an anonymous caller cannot grow this map by
/// asserting ids of its choosing.
#[derive(Debug, Clone)]
pub struct PeerAuthRefusalLog {
    window_ms: u64,
    windows: BTreeMap<(String, UnmetRequirement), Window>,
}

#[derive(Debug, Clone)]
struct Window {
    opened_at_ms: u64,
    suppressed: u64,
}

impl Default for PeerAuthRefusalLog {
    fn default() -> Self {
        PeerAuthRefusalLog::new(PeerAuthRefusalLog::DEFAULT_WINDOW_MS)
    }
}

impl PeerAuthRefusalLog {
    /// One report per minute per (peer id, requirement).
    ///
    /// Long enough that a peering retrying every second does not fill a
    /// log, short enough that an operator who fixes a secret sees the
    /// refusals stop while they are still watching.
    pub const DEFAULT_WINDOW_MS: u64 = 60_000;

    /// A log with an explicit window.
    #[must_use]
    pub fn new(window_ms: u64) -> Self {
        PeerAuthRefusalLog {
            window_ms,
            windows: BTreeMap::new(),
        }
    }

    /// Record a refusal, and say whether it should be reported now.
    ///
    /// The first refusal for a (peer id, requirement) always reports:
    /// suppressing the first one would recreate the silence §1.6 exists to
    /// break. Subsequent ones inside the window are counted and returned
    /// on the next report.
    ///
    /// `now_ms` is any monotonic millisecond reading the caller already
    /// has. A reading that goes backwards (it should not, but a caller can
    /// pass anything) closes the window early rather than suppressing
    /// forever, because failing loud is the right direction for this
    /// event.
    pub fn observe(
        &mut self,
        refusal: &PeerAuthRefusal,
        now_ms: u64,
    ) -> Option<PeerAuthRefusalReport> {
        let key = (refusal.peer_id().to_string(), refusal.unmet());
        let report = |suppressed| {
            Some(PeerAuthRefusalReport {
                event: PEER_AUTH_REFUSED_EVENT,
                peer_id: refusal.peer_id().to_string(),
                unmet: refusal.unmet(),
                suppressed,
            })
        };

        match self.windows.get_mut(&key) {
            None => {
                self.windows.insert(
                    key,
                    Window {
                        opened_at_ms: now_ms,
                        suppressed: 0,
                    },
                );
                report(0)
            }
            Some(window) => {
                let elapsed = now_ms.saturating_sub(window.opened_at_ms);
                if elapsed >= self.window_ms || now_ms < window.opened_at_ms {
                    let suppressed = window.suppressed;
                    window.opened_at_ms = now_ms;
                    window.suppressed = 0;
                    report(suppressed)
                } else {
                    window.suppressed = window.suppressed.saturating_add(1);
                    None
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use connector_config::PeerCredential;

    const SECRET: &str = "shared-secret";

    /// A connector with one fully configured peering: a credential and a
    /// `[[peer_channels]]` row. The only shape that can produce a `peer`.
    fn policy_with_a_bound_peer() -> PeerAuthPolicy {
        let credential = PeerCredential::new(SECRET);
        PeerAuthPolicy::new(vec![("store-box", &credential)], vec!["store-box"])
    }

    #[test]
    fn a_proven_credential_with_a_channel_binding_is_a_peer() {
        let policy = policy_with_a_bound_peer();
        let presented = PresentedCredential::new("store-box", SECRET);

        let decision = decide_role(Some(&presented), &policy);

        assert_eq!(decision.role(), &SessionRole::peer("store-box"));
        assert_eq!(decision.refusal(), None);
    }

    // ---------------------------------------------------------------
    // §1.9, the named regression. `toon-sandbox` admitted an anonymous
    // BTP session with `btp_auth … success:true mode:"no-auth"` and then
    // treated it as a quasi-peer. Each case below is one of the five the
    // spec names, asserted at the decision. The carriages owe the same
    // five end-to-end, over their own frames (issues #727 and #728).
    // ---------------------------------------------------------------

    /// §1.9(1): no credential at all — the anonymous session itself.
    #[test]
    fn named_regression_no_credential_is_a_client() {
        let decision = decide_role(None, &policy_with_a_bound_peer());

        assert_eq!(decision.role(), &SessionRole::Client);
        assert_eq!(decision.refusal(), None);
    }

    /// §1.9(2): an empty presented secret. It fails against a configured
    /// secret because it is wrong, and it would fail against an empty
    /// configured one too — see
    /// [`an_empty_configured_secret_matches_nothing`].
    #[test]
    fn named_regression_an_empty_presented_secret_is_a_client() {
        let decision = decide_role(
            Some(&PresentedCredential::new("store-box", "")),
            &policy_with_a_bound_peer(),
        );

        assert_eq!(decision.role(), &SessionRole::Client);
        assert_eq!(
            decision.refusal().map(PeerAuthRefusal::unmet),
            Some(UnmetRequirement::ProvenCredential)
        );
    }

    /// §1.9(3): a correct peer id with a wrong secret.
    #[test]
    fn named_regression_a_wrong_secret_is_a_client() {
        let decision = decide_role(
            Some(&PresentedCredential::new("store-box", "not-the-secret")),
            &policy_with_a_bound_peer(),
        );

        assert_eq!(decision.role(), &SessionRole::Client);
        assert_eq!(
            decision.refusal().map(PeerAuthRefusal::unmet),
            Some(UnmetRequirement::ProvenCredential)
        );
    }

    /// §1.9(4): P2 alone failing — everything right except the
    /// `[[peer_channels]]` row.
    #[test]
    fn named_regression_a_proven_credential_without_a_channel_binding_is_a_client() {
        let credential = PeerCredential::new(SECRET);
        let policy = PeerAuthPolicy::new(vec![("store-box", &credential)], Vec::<&str>::new());

        let decision = decide_role(
            Some(&PresentedCredential::new("store-box", SECRET)),
            &policy,
        );

        assert_eq!(decision.role(), &SessionRole::Client);
        assert_eq!(
            decision.refusal().map(PeerAuthRefusal::unmet),
            Some(UnmetRequirement::ChannelBinding)
        );
    }

    /// §1.9(5): a syntactically valid credential naming an unconfigured
    /// peer id. Client, and silent — this is the shape every ordinary
    /// client's `auth` entry already has (`client-edge-spec.md` §1.9,
    /// issue #698).
    #[test]
    fn named_regression_an_unconfigured_peer_id_is_a_client() {
        let decision = decide_role(
            Some(&PresentedCredential::new("g.proxy.client.abc", SECRET)),
            &policy_with_a_bound_peer(),
        );

        assert_eq!(decision.role(), &SessionRole::Client);
        assert_eq!(
            decision.refusal(),
            None,
            "an unconfigured peer id must not fire peer_auth_refused: every client session \
             declares a peerId of its own, so emitting here is both noise and a log-volume \
             lever an anonymous caller can pull"
        );
    }

    /// The other half of §1.9(4)'s shape: a channel binding with no
    /// peering to bind. There is no credential to prove, so there is no
    /// role to take.
    #[test]
    fn a_channel_binding_without_a_credential_is_a_client() {
        let policy = PeerAuthPolicy::new(Vec::<(&str, &PeerCredential)>::new(), vec!["store-box"]);

        let decision = decide_role(
            Some(&PresentedCredential::new("store-box", SECRET)),
            &policy,
        );

        assert_eq!(decision.role(), &SessionRole::Client);
        assert_eq!(decision.refusal(), None);
    }

    /// The `no-auth` regression at its sharpest: a peering whose
    /// configured secret is empty admits **nobody** as a peer, including a
    /// caller presenting the empty secret back. `Config::load` refuses
    /// this shape ([`connector_config::ConfigError::PeerCredentialMissing`]);
    /// the decision refuses it again, because the config refusal is not
    /// the lock that holds if a policy is built some other way.
    #[test]
    fn an_empty_configured_secret_matches_nothing() {
        let empty = PeerCredential::new("");
        let policy = PeerAuthPolicy::new(vec![("store-box", &empty)], vec!["store-box"]);

        for presented in ["", "anything", SECRET] {
            let decision = decide_role(
                Some(&PresentedCredential::new("store-box", presented)),
                &policy,
            );

            assert_eq!(
                decision.role(),
                &SessionRole::Client,
                "an empty configured secret matched {presented:?}"
            );
            assert_eq!(
                decision.refusal().map(PeerAuthRefusal::unmet),
                Some(UnmetRequirement::ProvenCredential)
            );
        }
    }

    /// A connector that configures no peerings at all — the fleet's
    /// ordinary shape today. Nothing can be a peer, whatever it presents.
    #[test]
    fn an_empty_policy_admits_no_peer() {
        let policy = PeerAuthPolicy::default();

        let decision = decide_role(
            Some(&PresentedCredential::new("store-box", SECRET)),
            &policy,
        );

        assert_eq!(decision.role(), &SessionRole::Client);
        assert_eq!(decision.refusal(), None);
    }

    /// The structural invariant behind §1.6: a refusal *is* a downgrade.
    /// No branch may return one beside a `peer` role.
    #[test]
    fn a_refusal_never_accompanies_a_peer_role() {
        let bound = PeerCredential::new(SECRET);
        let unbound = PeerCredential::new(SECRET);
        let empty = PeerCredential::new("");
        let policy = PeerAuthPolicy::new(
            vec![
                ("bound-box", &bound),
                ("unbound-box", &unbound),
                ("empty-box", &empty),
            ],
            vec!["bound-box", "empty-box"],
        );

        for (peer_id, secret) in [
            ("bound-box", SECRET),
            ("bound-box", "wrong"),
            ("bound-box", ""),
            ("unbound-box", SECRET),
            ("unbound-box", "wrong"),
            ("empty-box", ""),
            ("empty-box", SECRET),
            ("ghost-box", SECRET),
        ] {
            let decision = decide_role(Some(&PresentedCredential::new(peer_id, secret)), &policy);

            if decision.refusal().is_some() {
                assert_eq!(
                    decision.role(),
                    &SessionRole::Client,
                    "{peer_id}/{secret}: a refusal must accompany a downgrade"
                );
            }
        }
    }

    /// The same inputs always give the same verdict. The decision reads no
    /// clock, no socket and no counter, so there is nothing for a second
    /// call to differ on — and a future branch that reached for one would
    /// have to break this.
    #[test]
    fn the_decision_is_a_pure_function_of_its_two_arguments() {
        let policy = policy_with_a_bound_peer();
        let presented = PresentedCredential::new("store-box", "wrong");

        let first = decide_role(Some(&presented), &policy);
        let second = decide_role(Some(&presented), &policy);

        assert_eq!(first, second);
    }

    /// §1.3, as far as the type system can put it: the only things a
    /// credential carries are a peer id and a secret, so two interactions
    /// differing in *anything else* -- carriage, port, source address,
    /// SNI, client certificate, subprotocol, history -- are the same
    /// input and get the same answer, because there is no way to express
    /// the difference.
    #[test]
    fn a_credential_carries_nothing_a_carriage_could_weight() {
        let policy = policy_with_a_bound_peer();

        // Both encodings, which is as close as this crate comes to two
        // carriages, decode to the same value and decide the same way.
        let raw = crate::decode_raw(&crate::encode_raw(&PresentedCredential::new(
            "store-box",
            SECRET,
        )))
        .expect("raw");
        let based = crate::decode_base64(
            crate::encode_base64(&PresentedCredential::new("store-box", SECRET)).as_bytes(),
        )
        .expect("base64");

        assert_eq!(
            decide_role(Some(&raw), &policy),
            decide_role(Some(&based), &policy)
        );
    }

    #[test]
    fn a_requirement_names_itself_as_the_spec_does() {
        assert_eq!(UnmetRequirement::ProvenCredential.name(), "P1");
        assert_eq!(UnmetRequirement::ChannelBinding.name(), "P2");
        assert_eq!(PEER_AUTH_REFUSED_EVENT, "peer_auth_refused");
    }

    #[test]
    fn the_refused_peer_id_is_the_configured_one() {
        let decision = decide_role(
            Some(&PresentedCredential::new("store-box", "wrong")),
            &policy_with_a_bound_peer(),
        );

        assert_eq!(
            decision.refusal().map(PeerAuthRefusal::peer_id),
            Some("store-box")
        );
    }

    #[test]
    fn a_decision_can_be_split_into_its_role_and_its_event() {
        let (role, refusal) = decide_role(
            Some(&PresentedCredential::new("store-box", "wrong")),
            &policy_with_a_bound_peer(),
        )
        .into_parts();

        assert_eq!(role, SessionRole::Client);
        assert_eq!(
            refusal.map(|r| r.unmet()),
            Some(UnmetRequirement::ProvenCredential)
        );
    }

    // ---------------------------------------------------------------
    // The rate limit (§1.6).
    // ---------------------------------------------------------------

    fn refusal(peer_id: &str, unmet: UnmetRequirement) -> PeerAuthRefusal {
        PeerAuthRefusal {
            peer_id: peer_id.to_string(),
            unmet,
        }
    }

    #[test]
    fn the_first_refusal_always_reports() {
        let mut log = PeerAuthRefusalLog::default();

        let report = log
            .observe(&refusal("store-box", UnmetRequirement::ProvenCredential), 0)
            .expect("first refusal reports");

        assert_eq!(report.event, PEER_AUTH_REFUSED_EVENT);
        assert_eq!(report.peer_id, "store-box");
        assert_eq!(report.unmet, UnmetRequirement::ProvenCredential);
        assert_eq!(report.suppressed, 0);
    }

    #[test]
    fn refusals_inside_the_window_are_counted_and_reported_on_the_next_one() {
        let mut log = PeerAuthRefusalLog::new(60_000);
        let refusal = refusal("store-box", UnmetRequirement::ProvenCredential);

        assert!(log.observe(&refusal, 0).is_some());
        for tick in 1..=5 {
            assert!(log.observe(&refusal, tick * 1_000).is_none());
        }

        let report = log
            .observe(&refusal, 60_000)
            .expect("the window has closed");

        assert_eq!(report.suppressed, 5);
    }

    /// Two different mistakes on two different peerings are two different
    /// operator problems, and one must not silence the other.
    #[test]
    fn the_window_is_per_peer_and_per_requirement() {
        let mut log = PeerAuthRefusalLog::new(60_000);

        assert!(log
            .observe(&refusal("store-box", UnmetRequirement::ProvenCredential), 0)
            .is_some());
        assert!(log
            .observe(&refusal("store-box", UnmetRequirement::ChannelBinding), 0)
            .is_some());
        assert!(log
            .observe(&refusal("relay-box", UnmetRequirement::ProvenCredential), 0)
            .is_some());
    }

    /// A reading that goes backwards must not suppress forever. Failing
    /// loud is the right direction for an event whose whole purpose is to
    /// break a silence.
    #[test]
    fn a_clock_that_goes_backwards_reopens_the_window() {
        let mut log = PeerAuthRefusalLog::new(60_000);
        let refusal = refusal("store-box", UnmetRequirement::ProvenCredential);

        assert!(log.observe(&refusal, 10_000).is_some());
        assert!(log.observe(&refusal, 10_001).is_none());
        assert!(log.observe(&refusal, 5_000).is_some());
    }

    /// End to end: a mistyped secret downgrades silently on the wire and
    /// loudly to the operator. This is the pairing §1.6 asks for, and the
    /// reason the two halves live in one returned value.
    #[test]
    fn an_asserted_role_downgrades_silently_and_reports_loudly() {
        let policy = policy_with_a_bound_peer();
        let mut log = PeerAuthRefusalLog::default();

        let decision = decide_role(
            Some(&PresentedCredential::new("store-box", "mistyped")),
            &policy,
        );
        let report = decision
            .refusal()
            .and_then(|refusal| log.observe(refusal, 0));

        assert_eq!(
            decision.role(),
            &SessionRole::Client,
            "refusing on the wire would make the check a peer-id oracle (§1.6)"
        );
        assert_eq!(
            report.map(|report| (report.event, report.unmet.name())),
            Some((PEER_AUTH_REFUSED_EVENT, "P1")),
            "a mistyped secret must not present as 'peering configured, nothing peers, no \
             error anywhere' (§1.6)"
        );
    }
}
