//! ILPv4 packet types (RFC-0027) and their OER wire encoding (RFC-0030).
//!
//! Ported byte-for-byte from `packages/shared/src/types/ilp.ts` and
//! `packages/shared/src/encoding/oer.ts` so a real ILPv4-over-HTTP client
//! (RFC-0035) can address this connector's client edge and a Rust connector
//! agrees on the wire with the existing TypeScript one.

use chrono::{DateTime, Utc};

use crate::address::is_valid_ilp_address;
use crate::error::PacketError;
use crate::oer::{
    decode_fixed_octet_string, decode_generalized_time, decode_var_octet_string,
    encode_generalized_time, encode_var_octet_string,
};

const TYPE_PREPARE: u8 = 12;
const TYPE_FULFILL: u8 = 13;
const TYPE_REJECT: u8 = 14;

/// An ILP PREPARE packet (RFC-0027 Section 3.1): a conditional payment
/// addressed to `destination`, carrying an opaque application payload.
///
/// `execution_condition` is all-zero when the sender attached none --
/// RFC-0027's wire format has no separate "absent" representation, so zero
/// is the absent value on the wire and in this struct alike.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prepare {
    pub amount: u64,
    pub expires_at: DateTime<Utc>,
    pub execution_condition: [u8; 32],
    pub destination: String,
    pub data: Vec<u8>,
}

impl Prepare {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(TYPE_PREPARE);
        out.extend(crate::oer::encode_var_uint(self.amount));
        out.extend(encode_generalized_time(self.expires_at));
        out.extend_from_slice(&self.execution_condition);
        out.extend(encode_var_octet_string(self.destination.as_bytes()));
        out.extend(encode_var_octet_string(&self.data));
        out
    }

    pub fn decode(buf: &[u8]) -> Result<Prepare, PacketError> {
        let mut offset = 0;
        let type_byte = *buf.first().ok_or(PacketError::BufferUnderflow)?;
        if type_byte != TYPE_PREPARE {
            return Err(PacketError::InvalidType);
        }
        offset += 1;

        let (amount, n) = crate::oer::decode_var_uint(buf, offset)?;
        offset += n;

        let (expires_at, n) = decode_generalized_time(buf, offset)?;
        offset += n;

        let (execution_condition, n) = decode_fixed_octet_string(buf, offset, 32)?;
        offset += n;

        let (destination_bytes, n) = decode_var_octet_string(buf, offset)?;
        offset += n;
        let destination = String::from_utf8(destination_bytes)
            .map_err(|_| PacketError::InvalidAddress(String::new()))?;
        if !is_valid_ilp_address(&destination) {
            return Err(PacketError::InvalidAddress(destination));
        }

        let (data, n) = decode_var_octet_string(buf, offset)?;
        offset += n;

        if offset != buf.len() {
            return Err(PacketError::TrailingBytes);
        }

        Ok(Prepare {
            amount,
            expires_at,
            execution_condition,
            destination,
            data,
        })
    }
}

/// An ILP FULFILL packet (RFC-0027 Section 3.2): proof that a PREPARE was
/// honored, carrying an optional return payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fulfill {
    pub fulfillment: [u8; 32],
    pub data: Vec<u8>,
}

impl Fulfill {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(TYPE_FULFILL);
        out.extend_from_slice(&self.fulfillment);
        out.extend(encode_var_octet_string(&self.data));
        out
    }

    pub fn decode(buf: &[u8]) -> Result<Fulfill, PacketError> {
        let mut offset = 0;
        let type_byte = *buf.first().ok_or(PacketError::BufferUnderflow)?;
        if type_byte != TYPE_FULFILL {
            return Err(PacketError::InvalidType);
        }
        offset += 1;

        let (fulfillment, n) = decode_fixed_octet_string(buf, offset, 32)?;
        offset += n;

        let (data, n) = decode_var_octet_string(buf, offset)?;
        offset += n;

        if offset != buf.len() {
            return Err(PacketError::TrailingBytes);
        }

        Ok(Fulfill { fulfillment, data })
    }
}

/// A three-character ILP error code (RFC-0027 Section 3.3): `F`-prefixed
/// (final), `T`-prefixed (temporary) or `R`-prefixed (relative).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RejectCode(String);

impl RejectCode {
    /// F00: Bad Request -- generic final error.
    pub fn f00_bad_request() -> RejectCode {
        RejectCode("F00".to_string())
    }

    /// F02: Unreachable -- no route to the destination.
    pub fn f02_unreachable() -> RejectCode {
        RejectCode("F02".to_string())
    }

    /// F99: Application Error -- the terminating app declined the delivery.
    pub fn f99_application_error() -> RejectCode {
        RejectCode("F99".to_string())
    }

    /// T01: Peer Unreachable -- the app could not be reached over HTTP.
    pub fn t01_peer_unreachable() -> RejectCode {
        RejectCode("T01".to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn parse(code: &[u8]) -> Result<RejectCode, PacketError> {
        let text = std::str::from_utf8(code).map_err(|_| {
            PacketError::InvalidErrorCode(String::from_utf8_lossy(code).into_owned())
        })?;
        if text.len() != 3 || !text.is_ascii() {
            return Err(PacketError::InvalidErrorCode(text.to_string()));
        }
        Ok(RejectCode(text.to_string()))
    }
}

/// An ILP REJECT packet (RFC-0027 Section 3.3): a PREPARE was not honored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reject {
    pub code: RejectCode,
    pub triggered_by: String,
    pub message: String,
    pub data: Vec<u8>,
}

impl Reject {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(TYPE_REJECT);
        out.extend_from_slice(self.code.as_str().as_bytes());
        out.extend(encode_var_octet_string(self.triggered_by.as_bytes()));
        out.extend(encode_var_octet_string(self.message.as_bytes()));
        out.extend(encode_var_octet_string(&self.data));
        out
    }

    pub fn decode(buf: &[u8]) -> Result<Reject, PacketError> {
        let mut offset = 0;
        let type_byte = *buf.first().ok_or(PacketError::BufferUnderflow)?;
        if type_byte != TYPE_REJECT {
            return Err(PacketError::InvalidType);
        }
        offset += 1;

        let code_end = offset + 3;
        if code_end > buf.len() {
            return Err(PacketError::BufferUnderflow);
        }
        let code = RejectCode::parse(&buf[offset..code_end])?;
        offset = code_end;

        let (triggered_by_bytes, n) = decode_var_octet_string(buf, offset)?;
        offset += n;
        let triggered_by = String::from_utf8(triggered_by_bytes)
            .map_err(|_| PacketError::InvalidAddress(String::new()))?;
        if !triggered_by.is_empty() && !is_valid_ilp_address(&triggered_by) {
            return Err(PacketError::InvalidAddress(triggered_by));
        }

        let (message_bytes, n) = decode_var_octet_string(buf, offset)?;
        offset += n;
        let message = String::from_utf8(message_bytes).map_err(|_| PacketError::InvalidType)?;

        let (data, n) = decode_var_octet_string(buf, offset)?;
        offset += n;

        if offset != buf.len() {
            return Err(PacketError::TrailingBytes);
        }

        Ok(Reject {
            code,
            triggered_by,
            message,
            data,
        })
    }
}

/// The outcome of routing a [`Prepare`]: exactly one of the two ILP-level
/// results a PREPARE can produce.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PacketResponse {
    Fulfill(Fulfill),
    Reject(Reject),
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn sample_prepare() -> Prepare {
        Prepare {
            amount: 100,
            expires_at: Utc.with_ymd_and_hms(2030, 6, 15, 12, 0, 0).unwrap(),
            execution_condition: [0u8; 32],
            destination: "g.example.app".to_string(),
            data: b"hello app".to_vec(),
        }
    }

    #[test]
    fn prepare_round_trips() {
        let prepare = sample_prepare();
        let encoded = prepare.encode();
        assert_eq!(encoded[0], TYPE_PREPARE);
        let decoded = Prepare::decode(&encoded).expect("decode");
        assert_eq!(decoded, prepare);
    }

    #[test]
    fn prepare_decode_rejects_wrong_type_byte() {
        let mut encoded = sample_prepare().encode();
        encoded[0] = TYPE_FULFILL;
        assert!(matches!(
            Prepare::decode(&encoded),
            Err(PacketError::InvalidType)
        ));
    }

    #[test]
    fn prepare_decode_rejects_an_invalid_destination() {
        let mut prepare = sample_prepare();
        prepare.destination = "g..app".to_string();
        let encoded = prepare.encode();
        assert!(matches!(
            Prepare::decode(&encoded),
            Err(PacketError::InvalidAddress(_))
        ));
    }

    #[test]
    fn prepare_decode_rejects_truncated_input() {
        let encoded = sample_prepare().encode();
        assert!(matches!(
            Prepare::decode(&encoded[..encoded.len() - 1]),
            Err(PacketError::TrailingBytes) | Err(PacketError::BufferUnderflow)
        ));
    }

    #[test]
    fn prepare_decode_rejects_trailing_bytes() {
        let mut encoded = sample_prepare().encode();
        encoded.push(0xff);
        assert!(matches!(
            Prepare::decode(&encoded),
            Err(PacketError::TrailingBytes)
        ));
    }

    #[test]
    fn fulfill_round_trips() {
        let fulfill = Fulfill {
            fulfillment: [7u8; 32],
            data: b"ok".to_vec(),
        };
        let encoded = fulfill.encode();
        assert_eq!(encoded[0], TYPE_FULFILL);
        assert_eq!(Fulfill::decode(&encoded).expect("decode"), fulfill);
    }

    #[test]
    fn reject_round_trips() {
        let reject = Reject {
            code: RejectCode::f02_unreachable(),
            triggered_by: "g.connector".to_string(),
            message: "no route".to_string(),
            data: vec![],
        };
        let encoded = reject.encode();
        assert_eq!(encoded[0], TYPE_REJECT);
        assert_eq!(Reject::decode(&encoded).expect("decode"), reject);
    }

    #[test]
    fn reject_allows_an_empty_triggered_by() {
        let reject = Reject {
            code: RejectCode::f99_application_error(),
            triggered_by: String::new(),
            message: "declined".to_string(),
            data: vec![],
        };
        let encoded = reject.encode();
        assert_eq!(Reject::decode(&encoded).expect("decode"), reject);
    }

    #[test]
    fn reject_code_as_str_matches_the_constant() {
        assert_eq!(RejectCode::f02_unreachable().as_str(), "F02");
        assert_eq!(RejectCode::f99_application_error().as_str(), "F99");
        assert_eq!(RejectCode::t01_peer_unreachable().as_str(), "T01");
        assert_eq!(RejectCode::f00_bad_request().as_str(), "F00");
    }
}
