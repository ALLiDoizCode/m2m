//! On-chain channel errors -- the Solana-side twin of
//! `SettlementChannel.sol`'s custom errors, carried as `ProgramError::Custom`
//! codes since Solana instructions have no revert-reason string. The client
//! (`connector-settlement-solana`) pre-flights every one of these
//! client-side before submitting a transaction (mirroring
//! `connector-settlement-evm`'s "pre-flight, then submit" pattern), so in
//! practice these only fire if the chain's state moved between the client's
//! read and its submission -- but the program enforces them independently
//! either way, the same as the Solidity contract does.

use solana_program::program_error::ProgramError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum ChannelError {
    ChannelAlreadyClosed = 0,
    StaleClaim = 1,
    InsufficientChannelBalance = 2,
    WrongPayoutAccount = 3,
    CounterpartyTooLong = 4,
    ChannelAlreadyInitialized = 5,
    /// The channel is `Settled` and the attempted operation requires it
    /// not be (issue #574). Distinct from `ChannelAlreadyClosed`, which
    /// still permits `Redeem`: nothing is possible against a settled
    /// channel.
    ChannelAlreadySettled = 6,
    /// `Settle` was called before its channel's challenge period --
    /// `settlement_timeout`, counted from `Close` -- has elapsed, or
    /// before `Close` was ever called at all (issue #574).
    SettlementNotYetDue = 7,
}

impl From<ChannelError> for ProgramError {
    fn from(error: ChannelError) -> Self {
        ProgramError::Custom(error as u32)
    }
}
