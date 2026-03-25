// Payment Channel Program — Error Codes
//
// All error codes defined upfront for stable numbering across stories.
// Stories 33.2+ will use NonceNotMonotonic, TransferredAmountDecreased,
// InvalidSignature, and UnauthorizedSigner.

use solana_program::program_error::ProgramError;

/// Custom error codes for the payment channel program.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum PaymentChannelError {
    /// Attempted to initialize a channel that already exists (double-init).
    ChannelAlreadyExists = 0,
    /// Attempted deposit/close on a channel that is not in Opened state.
    ChannelNotOpened = 1,
    /// Attempted settle on a channel that is not in Closed state.
    ChannelNotClosed = 2,
    /// Attempted settle before the challenge period has elapsed.
    ChannelChallengeNotExpired = 3,
    /// Signer is not a participant in the channel.
    InvalidParticipant = 4,
    /// Deposit amount is zero.
    ZeroAmountDeposit = 5,
    /// Nonce is not strictly increasing (Story 33.2).
    NonceNotMonotonic = 6,
    /// Transferred amount decreased (Story 33.2).
    TransferredAmountDecreased = 7,
    /// Ed25519 signature verification failed (Story 33.2).
    InvalidSignature = 8,
    /// Signer not authorized for this operation (Story 33.2).
    UnauthorizedSigner = 9,
    /// Arithmetic overflow in balance calculation.
    ArithmeticOverflow = 10,
    /// Invalid PDA derivation — supplied account does not match expected PDA.
    InvalidPDA = 11,
    /// Invalid vault PDA derivation.
    InvalidVaultPDA = 12,
}

impl From<PaymentChannelError> for ProgramError {
    fn from(e: PaymentChannelError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
