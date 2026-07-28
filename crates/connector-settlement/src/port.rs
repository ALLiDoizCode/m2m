use async_trait::async_trait;
use chrono::Duration;
use thiserror::Error;

/// A payment channel's identifier, opaque to everything above this port --
/// assigned by whichever backend opened the channel (a contract address
/// plus a nonce for EVM, a PDA for Solana, an in-process counter for
/// [`crate::InMemorySettlementBackend`]).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ChannelId(pub String);

impl std::fmt::Display for ChannelId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Whether a channel can still be funded, is running its challenge period,
/// or is permanently done.
///
/// `Closed` and `Settled` are deliberately distinct (issue #574): closing a
/// channel starts a challenge period (`settlement_timeout`, given to
/// [`SettlementBackend::open`]) during which [`SettlementBackend::redeem`]
/// still works -- refusing to redeem in that window hands the whole
/// outstanding balance back to whichever party closed the channel, which
/// `TokenNetwork.claimFromChannel` deliberately does not do
/// (`packages/contracts/src/TokenNetwork.sol:262-263`, `:273`). Only
/// `Settled`, reached by a successful [`SettlementBackend::settle`] once
/// that timeout has elapsed, is terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelStatus {
    Open,
    /// Closed: its challenge period is running (or, once the timeout has
    /// elapsed, is simply unclaimed). `fund` and a second `close` are
    /// refused, but `redeem` still succeeds.
    Closed,
    /// Settled: `settle` has run to completion. Terminal -- no further
    /// `fund` or `redeem` is possible.
    Settled,
}

/// A snapshot of a channel's state, as any [`SettlementBackend`] must be
/// able to report it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelState {
    pub id: ChannelId,
    pub counterparty: Vec<u8>,
    pub status: ChannelStatus,
    /// Total ever deposited into the channel, across every [`SettlementBackend::fund`] call.
    pub deposited: u128,
    /// The highest cumulative amount honored by [`SettlementBackend::redeem`] so far.
    pub redeemed: u128,
}

/// A cumulative, superseding claim to a channel's funds (ADR 0004, ADR
/// 0005): `cumulative_amount` is the total ever owed to the redeemer as of
/// this claim, not an increment over the last one. `nonce` is the
/// strictly-increasing counter inside the signed material every chain this
/// port settles on hashes and enforces (`TokenNetwork.claimFromChannel`'s
/// `balanceProof.nonce > counterpartyState.nonce`, the deployed Solana
/// program's per-participant nonce ratchet, issue #573) -- carried through
/// unchanged from `connector_runtime::WireClaim`, whose own `nonce` is also
/// `u64` (a value signed at one width and hashed at another does not
/// recover, so this port settles on the wire's own width rather than
/// widening it the way `cumulative_amount` already widens to a chain's
/// `uint256`). `signature` is whatever proof a backend's chain requires
/// that the channel's counterparty actually signed it -- opaque bytes here
/// since the signature scheme is chain-specific (recoverable ECDSA for EVM,
/// ed25519 for Solana) and this port does not verify it; only the on-chain
/// (or in-memory) settlement logic that a real backend enforces does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub nonce: u64,
    pub cumulative_amount: u128,
    pub signature: Vec<u8>,
}

/// Errors a [`SettlementBackend`] implementation reports. Every variant but
/// [`Backend`] is one the port itself defines the meaning of; [`Backend`]
/// is the one variant a real, chain-backed implementation like
/// `connector-settlement-evm` (issue #459) needs and the in-memory stand-in
/// does not: an I/O-level failure (a reverted transaction the backend's own
/// pre-flight checks did not anticipate, an RPC timeout, a dropped
/// transaction) that is specific to *how* a backend talks to its chain
/// rather than to the port's own channel-lifecycle rules above.
///
/// [`Backend`]: SettlementError::Backend
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SettlementError {
    #[error("channel '{0}' not found")]
    ChannelNotFound(ChannelId),

    /// The channel is `Closed` (its challenge period is running, or has
    /// elapsed but [`SettlementBackend::settle`] has not yet been called)
    /// and the attempted operation requires it still be `Open` -- `fund`,
    /// or a second `close`. Does *not* cover [`SettlementBackend::redeem`],
    /// which still succeeds against a `Closed` channel (issue #574) --
    /// see [`ChannelSettled`] for the error `redeem` does return once the
    /// channel is actually settled.
    ///
    /// [`ChannelSettled`]: SettlementError::ChannelSettled
    #[error("channel '{0}' is already closed")]
    ChannelClosed(ChannelId),

    /// The channel is `Settled` -- [`SettlementBackend::settle`] has run to
    /// completion -- and the attempted operation (`fund`, `redeem`,
    /// `close`, or a second `settle`) requires it not be. Distinct from
    /// [`ChannelClosed`], which still permits `redeem`: nothing is possible
    /// against a settled channel (issue #574).
    ///
    /// [`ChannelClosed`]: SettlementError::ChannelClosed
    #[error("channel '{0}' is already settled")]
    ChannelSettled(ChannelId),

    /// [`SettlementBackend::settle`] was called before its channel's
    /// challenge period -- `settlement_timeout`, given to
    /// [`SettlementBackend::open`], counted from [`SettlementBackend::close`]
    /// -- has elapsed (or before `close` was ever called at all). Named
    /// distinctly rather than folded into [`SettlementError::Backend`], so a
    /// caller can tell "try again once the window has passed" apart from a
    /// genuine I/O failure (issue #574).
    #[error("channel '{0}' is not yet due for settlement")]
    SettlementNotYetDue(ChannelId),

    #[error("claim of {requested} exceeds the channel's funded balance of {deposited}")]
    InsufficientChannelBalance { requested: u128, deposited: u128 },

    #[error(
        "claim of {claimed} does not supersede the channel's already-redeemed {already_redeemed}"
    )]
    StaleClaim {
        claimed: u128,
        already_redeemed: u128,
    },

    /// A claim's `nonce` did not strictly exceed the highest one already
    /// redeemed on this channel -- distinct from [`StaleClaim`], which is
    /// about `cumulative_amount`, because the two can diverge: a claim can
    /// name a higher amount than has ever been redeemed while still
    /// carrying a nonce that does not advance (a stale or replayed claim
    /// resent alongside a since-fabricated amount). Real chains enforce
    /// nonce ordering directly (see [`Claim::nonce`]'s own doc); today only
    /// [`crate::InMemorySettlementBackend`] enforces it here too --
    /// `connector-settlement-evm` and `connector-settlement-solana` settle
    /// through contracts with no nonce field of their own yet (issue #566's
    /// retarget), so neither backend can enforce this rule client-side
    /// until that lands.
    ///
    /// [`StaleClaim`]: SettlementError::StaleClaim
    #[error(
        "claim nonce {claimed} does not exceed the channel's already-redeemed nonce {already_redeemed}"
    )]
    StaleNonce { claimed: u64, already_redeemed: u64 },

    #[error("settlement backend error: {0}")]
    Backend(String),
}

/// The settlement backend port (ADR 0002, ADR 0006): what opening, funding,
/// closing and redeeming a payment channel mean, independent of any chain.
/// `connector-settlement-evm` and `connector-settlement-solana` each hold a
/// real implementation to the contract suite in [`crate::contract`] (issue
/// #459 and its Solana counterpart, ADR 0007);
/// [`crate::InMemorySettlementBackend`] is the first implementation to pass
/// it, and stands in for a real chain in this workspace's own tests until
/// one is wired into `connector-runtime`.
///
/// Every method is asynchronous and fallible because a real implementation
/// talks to a chain over RPC -- opening a channel, for instance, is a
/// submitted transaction awaiting confirmation, not a local computation --
/// matching the precedent `connector-runtime`'s `PeerTransport` port
/// already sets for I/O-bound ports in this workspace.
#[async_trait]
pub trait SettlementBackend: Send + Sync {
    /// Open a new channel to `counterparty`, with `settlement_timeout` as
    /// the withdrawal-safety window a real chain enforces once [`close`]
    /// is called on it. Returns the backend-assigned id of the new
    /// channel, open and unfunded.
    ///
    /// [`close`]: SettlementBackend::close
    async fn open(
        &self,
        counterparty: Vec<u8>,
        settlement_timeout: Duration,
    ) -> Result<ChannelId, SettlementError>;

    /// Deposit `amount` into `channel`, increasing what can be redeemed
    /// against it. Returns the channel's state after the deposit.
    async fn fund(
        &self,
        channel: &ChannelId,
        amount: u128,
    ) -> Result<ChannelState, SettlementError>;

    /// Redeem `claim` against `channel`: the redeemer's honored total
    /// becomes `claim.cumulative_amount`, and no more (ADR 0005) -- a claim
    /// that does not supersede the last one redeemed, or exceeds the
    /// channel's funded balance, is rejected rather than silently
    /// truncated or ignored. Returns the channel's state after redemption.
    async fn redeem(
        &self,
        channel: &ChannelId,
        claim: Claim,
    ) -> Result<ChannelState, SettlementError>;

    /// Close `channel`, starting its challenge period (issue #574): no
    /// further funding is possible against it afterward, and it cannot be
    /// closed a second time, but [`redeem`](SettlementBackend::redeem)
    /// still works until [`settle`](SettlementBackend::settle) actually
    /// runs. Returns the channel's state immediately after closing.
    async fn close(&self, channel: &ChannelId) -> Result<ChannelState, SettlementError>;

    /// Settle `channel` once its challenge period -- `settlement_timeout`,
    /// given to [`open`](SettlementBackend::open), counted from
    /// [`close`](SettlementBackend::close) -- has elapsed: pays out its
    /// final remainder and marks it permanently done, after which no
    /// further funding or redemption is possible. Returns
    /// [`SettlementError::SettlementNotYetDue`], not
    /// [`SettlementError::Backend`], if the timeout has not yet elapsed (or
    /// `close` has not yet been called at all).
    ///
    /// Permissionless (issue #574): any caller may invoke this once the
    /// timeout has passed, not only a channel's own participants -- this is
    /// what stops a counterparty stranding a channel's deposit by refusing
    /// to ever settle it, matching `TokenNetwork.settleChannel`'s own
    /// design (`packages/contracts/src/TokenNetwork.sol:366-374`, "Anyone
    /// can call after the grace period"). No implementation of this port
    /// should gate `settle` on the caller being a channel participant.
    async fn settle(&self, channel: &ChannelId) -> Result<ChannelState, SettlementError>;

    /// The current state of `channel`, as last recorded by this backend.
    async fn channel_state(&self, channel: &ChannelId) -> Result<ChannelState, SettlementError>;
}
