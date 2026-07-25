use thiserror::Error;

/// Errors raised by a [`crate::Signer`] implementation.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SignerError {
    #[error("key not found: {0}")]
    KeyNotFound(String),

    #[error("invalid key material")]
    InvalidKey,

    #[error("signing operation failed: {0}")]
    SigningFailed(String),

    #[error("key rotation failed: {0}")]
    RotationFailed(String),
}

/// Errors raised by a [`crate::Treasury`] or its [`crate::ChainClient`] port.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum TreasuryError {
    #[error(transparent)]
    Signer(#[from] SignerError),

    #[error("chain client rejected the request: {0}")]
    ChainRejected(String),

    #[error("insufficient balance: have {have}, need {need}")]
    InsufficientBalance { have: u128, need: u128 },
}
