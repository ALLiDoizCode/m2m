//! A bound on the chain lookups an anonymous sender can make this
//! connector perform for channels that do not resolve (issue #613).
//!
//! # The hole this closes
//!
//! Issue #611 is what makes ADR/issue #502's *"anonymity is a first-class
//! path"* real: a buyer who has opened a channel on chain pays without the
//! operator hand-editing a config file, because
//! [`crate::ClientChannelRegistry`] resolves the channel from the chain the
//! `[settlement]` section already names. That resolution costs one chain
//! read per **previously-unseen** channel id, and before this module
//! nothing bounded how many a sender could cause.
//!
//! So a sender naming a fresh nonexistent channel id on every request made
//! this connector issue one `eth_call` (or one Solana account read) per
//! request, indefinitely. Every one of those claims was refused -- nothing
//! was paid and nothing was delivered -- and that is exactly what made it
//! attractive: the sender spends a packet, this connector spends a unit of
//! its own metered settlement-RPC budget, and the exchange is free in one
//! direction only.
//!
//! # Why this is a budget and not a cache
//!
//! The obvious fix -- memoise "no such channel" for N seconds -- trades the
//! problem for a worse one, and #611 declined it deliberately. The buyer
//! this whole path exists for opens a channel and writes a second later, so
//! a negative TTL makes that buyer's *own* first attempt poison the next N
//! seconds of their own attempts. The feature would work for everybody
//! except its intended user. Nothing here memoises a negative answer: a
//! channel that did not exist a moment ago is asked about again, and the
//! only thing that changes is that the asking is metered.
//!
//! # What #654 already bounds, and why it cannot bound this
//!
//! [`crate::ChannelLivenessPolicy`] looks like it should already cover
//! this, and it does not. Every one of its protections --
//! `refresh_after`, `serve_stale_until`, `min_reattempt_interval`, and the
//! single-flight in-flight marker -- hangs off a *memo entry*, and
//! `ClientChannelRegistry::resolve_evm` only ever inserts one for a channel
//! the chain vouched for. A channel that does not resolve leaves no entry
//! behind (it is `memo.remove`d, never inserted), so the next lookup for it
//! finds nothing to apply an interval to and goes straight to the chain.
//! That is not an oversight in #654: an interval keyed by channel could not
//! bind this attack anyway, because the attack's whole shape is *a fresh
//! channel id every time*. `unresolvable_lookups_are_not_bounded_by_the_liveness_policy`
//! in `crate::channels` measures the gap rather than asserting it.
//!
//! # What identity this budgets against, and what that is worth
//!
//! A probe budgets per recognized channel
//! (`connector_runtime`'s `ProbeRateLimiter`, whose shape this follows).
//! An unresolvable lookup has no recognized channel -- that is what makes
//! it unresolvable -- so the identity has to come from somewhere else, and
//! the honest summary is that every candidate is weak. What was available
//! at this seam, and why the choice landed where it did:
//!
//! * **The transport source address is not available here at all.** Nothing
//!   in this crate's axum handlers takes a `ConnectInfo<SocketAddr>` and
//!   nothing plumbs a peer address onto the packet path. Adding that would
//!   not help either: on the deployed boxes the client edge sits behind
//!   nginx, so the peer address is the proxy's and every anonymous buyer in
//!   the world would share one bucket -- with the attacker in it. The
//!   remedy for *that* would be trusting a forwarded-for header, which this
//!   repo trusts nowhere, and which would be strictly worse than what is
//!   used below: an attacker-settable free-text field that needs no keypair
//!   even to look plausible.
//! * **The claim's own signer is read, and deliberately not verified.** For
//!   Solana a balance proof is signed over the channel account, nonce and
//!   amount alone, so it *could* be checked locally against the claim's
//!   `signerPublicKey`. For EVM it could not: the EIP-712 digest needs the
//!   channel's `chainId`/`tokenNetworkAddress`, which come from the
//!   resolution that has not happened yet, so the only check possible
//!   before the lookup is against the claim's *self-declared* domain --
//!   which proves nothing except that the sender can run one `ecrecover`.
//!   Requiring either would also swap one amplifier for another: an
//!   anonymous request would buy an elliptic-curve operation instead of a
//!   hashmap increment. So [`connector_domain::client_claim::ClientClaim::signer_key`]
//!   is a label for grouping and attribution, never a credential.
//!
//! **The residual weakness, stated plainly.** A keypair is free, so an
//! adaptive attacker declares a fresh signer on every request and the
//! per-signer allowance never binds them. That is why this type has a
//! second, node-wide ceiling, and the node-wide ceiling -- not the
//! per-signer one -- is the bound an attacker cannot route around. The
//! per-signer allowance buys two narrower things: a non-adaptive sender is
//! cut off early, and under contention one loud identity cannot take the
//! whole remaining window from many quiet ones.
//!
//! The node-wide ceiling's own cost is shared fate: while it is spent, a
//! *genuinely* new anonymous buyer's first resolution is refused too. The
//! blast radius is bounded to first resolutions and nothing else -- a
//! declared `[[client_channels]]` channel is never resolved, and an
//! already-resolved one is answered from the memo without consuming
//! anything here -- so nobody who is already paying is affected, and the
//! degradation is "onboarding is slowed and says so" rather than "the node
//! stops taking money".
//!
//! # Why the per-signer allowance only binds under contention
//!
//! Because the signer is read rather than authenticated, anyone can declare
//! anyone else's address. A per-signer allowance enforced unconditionally
//! would therefore be a cheap, targeted denial of service against a *known*
//! buyer: spend their allowance with a handful of nonsense channel ids, and
//! their genuine first write is refused. That is the same failure mode as
//! the negative cache this issue rejects -- the feature working for
//! everyone except its intended user -- reached by a different route, so it
//! is designed out rather than written down as a caveat.
//!
//! The per-signer bound is therefore enforced only once the node-wide
//! window is already **contended** (half spent). Below that nobody is ever
//! refused for their identity, so the targeted attack has nothing to aim
//! with; above it, capacity is genuinely scarce and somebody has to be
//! refused, and refusing the identity that has taken the most of the window
//! is the right somebody. An attacker who wants to lock a victim out must
//! first drive the node-wide window into contention, which is the loud,
//! metered, already-bounded thing.
//!
//! # What consumes it
//!
//! A reservation is taken **before** the chain is touched -- the point is
//! to prevent the read, not to notice it afterwards, and taking it under
//! the same lock that decides it is what makes a burst of simultaneous
//! requests bind rather than all pass the check at once.
//!
//! A reservation is **refunded** when the lookup resolves the channel, so a
//! busy legitimate node onboarding real buyers never throttles itself: only
//! lookups that came back with nothing, or that failed, leave a mark. A
//! failed lookup consumes deliberately -- the RPC was spent either way, and
//! a node whose endpoint is down must not keep paying for the discovery.
//! It stays distinguishable while it does: the refusals an outage produces
//! are `ChannelLookupFailed`, loudly and one per attempt, until the window
//! is spent, and only then does the refusal change to this one -- which
//! names itself as a budget rather than as a fact about anybody's channel.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How many unresolvable lookups one declared signer may cause per window
/// once the node-wide window is contended.
///
/// Ten: a legitimate buyer needs *one* resolution, and it is refunded when
/// it succeeds, so the only thing a well-behaved sender ever spends here is
/// the handful of attempts between opening a channel and the chain
/// reporting it. Ten leaves room for that and for a client that retries a
/// little too eagerly, and no room for walking an id space.
pub const DEFAULT_UNRESOLVABLE_LOOKUPS_PER_SIGNER: u32 = 10;

/// How many unresolvable lookups this connector will perform in total per
/// window, whoever asks.
///
/// Sixty, i.e. one a second sustained. This is the number that actually
/// bounds the attack, because it is the only one a sender cannot get around
/// by declaring a different signer, so it is set against what a settlement
/// endpoint can absorb rather than against what any one client might want:
/// a metered endpoint priced per request should not be spending more than
/// this on channels that turn out not to exist. Successful resolutions are
/// refunded and do not count against it, so it is not a cap on how many
/// real buyers a node may onboard.
pub const DEFAULT_UNRESOLVABLE_LOOKUPS_TOTAL: u32 = 60;

/// The window both allowances are counted over -- a minute, matching
/// `connector_runtime`'s probe rate limiter, since both are answering the
/// same question about the same kind of caller.
pub const DEFAULT_UNRESOLVABLE_LOOKUP_WINDOW: Duration = Duration::from_secs(60);

/// How many unresolvable channel lookups this connector will perform per
/// window, per declared signer and in total (issue #613).
///
/// A fixed window rather than a token bucket, deliberately: this is the
/// same shape `connector_runtime`'s `ProbeRateLimiter` already uses for the
/// structurally identical problem on the probe path -- free work an
/// anonymous caller can ask for, bounded per identity rather than refused
/// outright -- and an operator who has reasoned about one should not have
/// to re-reason about the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnresolvableLookupBudgetPolicy {
    /// Per declared signer, enforced only while the node-wide window is
    /// contended -- see this module's own doc for why that condition is
    /// load-bearing rather than a softening.
    pub per_signer: u32,
    /// Node-wide, enforced always. The bound an attacker cannot route
    /// around by declaring a different signer.
    pub total: u32,
    /// What both allowances are counted over.
    pub window: Duration,
}

impl Default for UnresolvableLookupBudgetPolicy {
    fn default() -> UnresolvableLookupBudgetPolicy {
        UnresolvableLookupBudgetPolicy {
            per_signer: DEFAULT_UNRESOLVABLE_LOOKUPS_PER_SIGNER,
            total: DEFAULT_UNRESOLVABLE_LOOKUPS_TOTAL,
            window: DEFAULT_UNRESOLVABLE_LOOKUP_WINDOW,
        }
    }
}

impl UnresolvableLookupBudgetPolicy {
    /// The node-wide spend past which the per-signer allowance starts to
    /// bind: half the window. Derived rather than configured because it is
    /// not an independent trade -- it exists to make the per-signer
    /// allowance unaimable while capacity is plentiful, and "plentiful"
    /// only means anything relative to [`Self::total`].
    fn contended_above(&self) -> u32 {
        self.total / 2
    }
}

/// Which of [`UnresolvableLookupBudgetPolicy`]'s two allowances refused a
/// lookup. Kept apart because they lead an operator to different actions:
/// [`LookupBudgetBound::Signer`] names a sender to look at, while
/// [`LookupBudgetBound::Node`] says the window is spent regardless of who
/// spent it -- which, given a sender can declare any signer they like, is
/// what a distributed walk of the id space looks like from here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LookupBudgetBound {
    /// The declared signer has taken [`UnresolvableLookupBudgetPolicy::per_signer`]
    /// of a window that is already contended.
    Signer,
    /// [`UnresolvableLookupBudgetPolicy::total`] is spent for this window.
    Node,
}

impl LookupBudgetBound {
    /// The structured-log field value for this bound, so a `bound=node`
    /// line and a `bound=signer` line can be counted apart without parsing
    /// English.
    pub fn as_str(&self) -> &'static str {
        match self {
            LookupBudgetBound::Signer => "signer",
            LookupBudgetBound::Node => "node",
        }
    }
}

/// This connector declined to look a channel up, because doing so would
/// exceed the budget it keeps on lookups for channels that do not resolve
/// (issue #613).
///
/// Deliberately **not** a `crate::ChannelLookupFailed` and deliberately not
/// an unknown channel. All three refuse the claim; all three mean something
/// different, and an operator reading a log has to be able to tell them
/// apart because they lead to three different actions -- fix your endpoint,
/// nothing (a sender named a channel that is not there), and look at who is
/// spending your window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LookupBudgetExhausted {
    /// Which allowance was hit.
    pub bound: LookupBudgetBound,
    /// The allowance that was hit, so a refusal can quote a number rather
    /// than a policy name the sender cannot see.
    pub allowance: u32,
    /// The window it is counted over, so a sender is told how long to wait
    /// rather than left to guess.
    pub window: Duration,
}

impl std::fmt::Display for LookupBudgetExhausted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.bound {
            LookupBudgetBound::Signer => write!(
                f,
                "this signer has already caused {} lookups for channels that did not resolve \
                 within {} s, and this node's budget for them is contended",
                self.allowance,
                self.window.as_secs()
            ),
            LookupBudgetBound::Node => write!(
                f,
                "this node has already performed its whole allowance of {} lookups for channels \
                 that did not resolve within {} s",
                self.allowance,
                self.window.as_secs()
            ),
        }
    }
}

impl std::error::Error for LookupBudgetExhausted {}

/// One admitted unresolvable lookup, already counted against both
/// allowances.
///
/// Held by the caller across the chain read and handed back to
/// [`UnresolvableLookupBudget::refund`] if the channel resolved. There is
/// deliberately no `Drop` refund: dropping one is how a lookup that found
/// nothing, or failed, *keeps* its charge, and that is the common case
/// rather than an error path.
#[derive(Debug)]
#[must_use = "an admitted lookup is charged until it is refunded or dropped"]
pub(crate) struct LookupReservation {
    signer: String,
    /// When the charge was made, so a refund can tell whether the window it
    /// was charged to is still the current one. Without this, a lookup that
    /// straddled a window boundary would give the *next* window a free
    /// credit it never charged for.
    charged_at: Instant,
}

/// One allowance's fixed window: when it started and what has been spent
/// from it.
#[derive(Debug, Clone, Copy)]
struct Window {
    started_at: Instant,
    spent: u32,
}

impl Window {
    fn starting(now: Instant) -> Window {
        Window {
            started_at: now,
            spent: 0,
        }
    }

    /// Begin a new window if `window` has elapsed since this one started.
    fn roll(&mut self, now: Instant, window: Duration) {
        if now.saturating_duration_since(self.started_at) >= window {
            *self = Window::starting(now);
        }
    }

    /// Give back a charge made at `charged_at`, if that charge belongs to
    /// the window currently running.
    fn refund(&mut self, charged_at: Instant) {
        if self.started_at <= charged_at && self.spent > 0 {
            self.spent -= 1;
        }
    }
}

#[derive(Debug)]
struct BudgetState {
    node: Window,
    per_signer: HashMap<String, Window>,
}

/// How many unresolvable lookups this connector has performed in the
/// current window, per declared signer and in total (issue #613).
///
/// See this module's own doc for what is being defended, what the identity
/// is worth, and why the per-signer allowance binds only under contention.
#[derive(Debug)]
pub struct UnresolvableLookupBudget {
    policy: UnresolvableLookupBudgetPolicy,
    /// A plain [`Mutex`] rather than an `RwLock`, exactly as
    /// `connector_runtime`'s `ProbeRateLimiter` reasons: every access here
    /// mutates, so there is no read-only path for a reader/writer lock to
    /// be better at.
    state: Mutex<BudgetState>,
}

impl UnresolvableLookupBudget {
    pub fn new(policy: UnresolvableLookupBudgetPolicy) -> UnresolvableLookupBudget {
        let now = Instant::now();
        UnresolvableLookupBudget {
            policy,
            state: Mutex::new(BudgetState {
                node: Window::starting(now),
                per_signer: HashMap::new(),
            }),
        }
    }

    pub fn policy(&self) -> UnresolvableLookupBudgetPolicy {
        self.policy
    }

    /// Admit one lookup for a channel this connector has never resolved, or
    /// refuse it. Charged before the caller touches the chain, under the
    /// lock that decides it, so a burst arriving at once is bound by the
    /// same number a sequence is.
    pub(crate) fn reserve(&self, signer: &str) -> Result<LookupReservation, LookupBudgetExhausted> {
        self.reserve_at(signer, Instant::now())
    }

    fn reserve_at(
        &self,
        signer: &str,
        now: Instant,
    ) -> Result<LookupReservation, LookupBudgetExhausted> {
        let mut state = self.state.lock().expect("lookup budget lock poisoned");
        state.node.roll(now, self.policy.window);

        if state.node.spent >= self.policy.total {
            return Err(LookupBudgetExhausted {
                bound: LookupBudgetBound::Node,
                allowance: self.policy.total,
                window: self.policy.window,
            });
        }
        let contended = state.node.spent >= self.policy.contended_above();

        // Pruned here rather than on a timer: the key space is text a
        // sender chooses, so an attacker declaring a fresh signer per
        // request would otherwise grow this map without bound -- trading
        // the RPC-spend hole for a memory one. Only a charge inserts, and a
        // charge needs node-wide room, so at most `total` entries can be
        // live in one window and dropping the elapsed ones keeps the map
        // proportional to the allowance rather than to how long the process
        // has been running.
        if state.per_signer.len() > self.policy.total as usize {
            let window = self.policy.window;
            state
                .per_signer
                .retain(|_, seen| now.saturating_duration_since(seen.started_at) < window);
        }

        let seen = state
            .per_signer
            .entry(signer.to_string())
            .or_insert_with(|| Window::starting(now));
        seen.roll(now, self.policy.window);
        if contended && seen.spent >= self.policy.per_signer {
            return Err(LookupBudgetExhausted {
                bound: LookupBudgetBound::Signer,
                allowance: self.policy.per_signer,
                window: self.policy.window,
            });
        }

        seen.spent += 1;
        state.node.spent += 1;
        Ok(LookupReservation {
            signer: signer.to_string(),
            charged_at: now,
        })
    }

    /// Give back a charge whose lookup resolved the channel after all.
    ///
    /// This is what keeps the budget off a legitimate node's back: an
    /// operator whose connector is onboarding real anonymous buyers as fast
    /// as they arrive spends nothing here, because every one of those
    /// lookups came back with a channel. Only lookups that found nothing --
    /// or that could not be completed -- leave a mark.
    pub(crate) fn refund(&self, reservation: LookupReservation) {
        let mut state = self.state.lock().expect("lookup budget lock poisoned");
        state.node.refund(reservation.charged_at);
        if let Some(seen) = state.per_signer.get_mut(&reservation.signer) {
            seen.refund(reservation.charged_at);
        }
    }

    /// What has been spent node-wide in the window currently running --
    /// for a log line or a test, never for a decision.
    pub(crate) fn spent(&self) -> u32 {
        self.state
            .lock()
            .expect("lookup budget lock poisoned")
            .node
            .spent
    }
}

impl Default for UnresolvableLookupBudget {
    fn default() -> UnresolvableLookupBudget {
        UnresolvableLookupBudget::new(UnresolvableLookupBudgetPolicy::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(per_signer: u32, total: u32) -> UnresolvableLookupBudgetPolicy {
        UnresolvableLookupBudgetPolicy {
            per_signer,
            total,
            window: Duration::from_secs(60),
        }
    }

    /// The node-wide ceiling is the one an attacker cannot route around, so
    /// it binds regardless of how many identities the charges arrive under.
    #[test]
    fn the_node_wide_allowance_binds_however_many_signers_ask() {
        let budget = UnresolvableLookupBudget::new(policy(1_000, 4));

        for attempt in 0..4 {
            assert!(
                budget.reserve(&format!("evm:0x{attempt:040x}")).is_ok(),
                "attempt {attempt} is inside the node-wide allowance"
            );
        }
        let refused = budget
            .reserve("evm:0xdeadbeef")
            .expect_err("the node-wide allowance is spent");
        assert_eq!(refused.bound, LookupBudgetBound::Node);
        assert_eq!(refused.allowance, 4);
    }

    /// Two senders do not share an allowance: one that has spent its own is
    /// refused while the other, which has spent nothing, still gets through.
    /// The node-wide window is deliberately left with room, so what is
    /// measured here is the per-signer split and not the ceiling above it.
    #[test]
    fn two_signers_have_independent_allowances() {
        let budget = UnresolvableLookupBudget::new(policy(2, 8));
        let loud = "evm:0x1111111111111111111111111111111111111111";
        let quiet = "evm:0x2222222222222222222222222222222222222222";

        // Four charges is half of eight, which is where the per-signer
        // allowance starts to bind.
        for _ in 0..4 {
            let _charged = budget.reserve(loud).expect("below contention");
        }
        let refused = budget
            .reserve(loud)
            .expect_err("this signer is over its share of a contended window");
        assert_eq!(refused.bound, LookupBudgetBound::Signer);
        assert_eq!(refused.allowance, 2);

        assert!(
            budget.reserve(quiet).is_ok(),
            "a second signer has its own allowance and has spent none of it"
        );
        assert!(budget.spent() < 8, "the node-wide window still has room");
    }

    /// The per-signer allowance is unaimable while capacity is plentiful:
    /// below contention nobody is refused for their identity, so an
    /// attacker cannot spend a known buyer's allowance out from under them
    /// without first driving the node-wide window into contention.
    #[test]
    fn a_signers_allowance_does_not_bind_while_the_window_is_uncontended() {
        let budget = UnresolvableLookupBudget::new(policy(1, 100));
        let victim = "evm:0x3333333333333333333333333333333333333333";

        for attempt in 0..40 {
            assert!(
                budget.reserve(victim).is_ok(),
                "charge {attempt} is admitted: a per-signer allowance of 1 does not bind an \
                 uncontended node"
            );
        }
    }

    /// A resolution that succeeded gives its charge back, so a node
    /// onboarding real buyers never throttles itself however many it
    /// onboards. An allowance of one, spent and refunded fifty times over.
    #[test]
    fn a_refunded_charge_costs_nothing() {
        let budget = UnresolvableLookupBudget::new(policy(1, 1));

        for attempt in 0..50 {
            let reservation = budget
                .reserve("evm:0x4444444444444444444444444444444444444444")
                .unwrap_or_else(|_| panic!("charge {attempt} is admitted"));
            budget.refund(reservation);
        }
        assert_eq!(budget.spent(), 0);
    }

    /// A refund whose window has already rolled must not credit the new
    /// window: a lookup that straddled a boundary would otherwise hand the
    /// next window a charge it never made, which over a long-running
    /// outage is an allowance that grows.
    #[test]
    fn a_refund_does_not_credit_a_window_it_was_not_charged_to() {
        let budget = UnresolvableLookupBudget::new(policy(10, 10));
        let signer = "evm:0x5555555555555555555555555555555555555555";
        let start = Instant::now();

        let straddling = budget
            .reserve_at(signer, start)
            .expect("charged to the first window");
        // A whole window later, so the next charge starts a fresh one.
        let next_window = start + Duration::from_secs(61);
        let _next = budget
            .reserve_at(signer, next_window)
            .expect("charged to the second window");
        assert_eq!(budget.spent(), 1);

        budget.refund(straddling);
        assert_eq!(
            budget.spent(),
            1,
            "the refund belongs to a window that has already closed"
        );
    }

    /// A window is a window: a sender cut off at its end is admitted again
    /// at the start of the next one, so this bounds a rate rather than
    /// banning anybody.
    #[test]
    fn a_new_window_admits_a_sender_the_old_one_refused() {
        let budget = UnresolvableLookupBudget::new(policy(10, 2));
        let signer = "evm:0x6666666666666666666666666666666666666666";
        let start = Instant::now();

        let _first = budget.reserve_at(signer, start).expect("first");
        let _second = budget.reserve_at(signer, start).expect("second");
        assert!(budget.reserve_at(signer, start).is_err());

        assert!(
            budget
                .reserve_at(signer, start + Duration::from_secs(61))
                .is_ok(),
            "the next window starts empty"
        );
    }

    /// The identity space is text a sender picks, so the map keyed by it
    /// must not be a second, quieter way to spend this node's resources.
    /// Elapsed entries are dropped, keeping the map proportional to the
    /// allowance rather than to how many distinct identities have ever
    /// asked.
    #[test]
    fn a_sybil_walk_does_not_grow_the_map_without_bound() {
        let budget = UnresolvableLookupBudget::new(policy(10, 4));
        let start = Instant::now();

        for window in 0..50u64 {
            // One whole window apart, so every previous entry has elapsed
            // by the time the next batch charges.
            let now = start + Duration::from_secs(61 * window);
            for attempt in 0..4 {
                let _ = budget.reserve_at(&format!("evm:0x{window:020x}{attempt:020x}"), now);
            }
        }

        let tracked = budget
            .state
            .lock()
            .expect("lookup budget lock poisoned")
            .per_signer
            .len();
        assert!(
            tracked <= 2 * 4 + 1,
            "200 distinct signers over 50 windows left {tracked} entries behind"
        );
    }

    /// The two refusals say which they are, in a message an operator reads
    /// rather than a code they have to look up.
    #[test]
    fn each_bound_says_which_one_it_is() {
        let node = LookupBudgetExhausted {
            bound: LookupBudgetBound::Node,
            allowance: 60,
            window: Duration::from_secs(60),
        };
        let signer = LookupBudgetExhausted {
            bound: LookupBudgetBound::Signer,
            allowance: 10,
            window: Duration::from_secs(60),
        };

        assert!(node.to_string().contains("this node has already performed"));
        assert!(signer
            .to_string()
            .contains("this signer has already caused"));
        assert_ne!(node.to_string(), signer.to_string());
        assert_eq!(LookupBudgetBound::Node.as_str(), "node");
        assert_eq!(LookupBudgetBound::Signer.as_str(), "signer");
    }
}
