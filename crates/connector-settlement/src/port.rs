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

/// Whether a channel can still be funded and redeemed against, or has been
/// closed for good.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelStatus {
    Open,
    Closed,
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
/// this claim, not an increment over the last one. `signature` is whatever
/// proof a backend's chain requires that the channel's counterparty
/// actually signed it -- opaque bytes here since the signature scheme is
/// chain-specific (recoverable ECDSA for EVM, ed25519 for Solana) and this
/// port does not verify it; only the on-chain (or in-memory) settlement
/// logic that a real backend enforces does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub cumulative_amount: u128,
    pub signature: Vec<u8>,
}

/// Errors a [`SettlementBackend`] implementation reports. Every variant is
/// something the port itself defines the meaning of -- not a chain-specific
/// failure (a reverted transaction, an RPC timeout) that only a concrete
/// implementation like `connector-settlement-evm` would ever produce.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SettlementError {
    #[error("channel '{0}' not found")]
    ChannelNotFound(ChannelId),

    #[error("channel '{0}' is already closed")]
    ChannelClosed(ChannelId),

    #[error("claim of {requested} exceeds the channel's funded balance of {deposited}")]
    InsufficientChannelBalance { requested: u128, deposited: u128 },

    #[error(
        "claim of {claimed} does not supersede the channel's already-redeemed {already_redeemed}"
    )]
    StaleClaim {
        claimed: u128,
        already_redeemed: u128,
    },
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

    /// Close `channel`. No further funding or redemption is possible
    /// against it afterward. Returns the channel's final state.
    async fn close(&self, channel: &ChannelId) -> Result<ChannelState, SettlementError>;

    /// The current state of `channel`, as last recorded by this backend.
    async fn channel_state(&self, channel: &ChannelId) -> Result<ChannelState, SettlementError>;
}
