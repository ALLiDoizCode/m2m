use thiserror::Error;

/// Everything that can go wrong decoding an OER-encoded ILP packet
/// (RFC-0027 / RFC-0030).
#[derive(Debug, Error, PartialEq, Eq)]
pub enum PacketError {
    #[error("buffer underflow: packet is truncated")]
    BufferUnderflow,

    #[error("invalid packet type byte: expected 12 (PREPARE), 13 (FULFILL) or 14 (REJECT)")]
    InvalidType,

    #[error("invalid ASN.1 GeneralizedTime")]
    InvalidTime,

    #[error("invalid ILP address: '{0}'")]
    InvalidAddress(String),

    #[error("invalid ILP error code: must be exactly 3 characters, got '{0}'")]
    InvalidErrorCode(String),

    #[error("trailing bytes after a fully decoded packet")]
    TrailingBytes,
}
