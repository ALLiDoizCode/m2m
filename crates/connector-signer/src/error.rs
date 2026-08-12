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
