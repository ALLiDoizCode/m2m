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
    decode_fixed_octet_string, decode_generalized_time, decode_var_octet_string, decode_var_uint,
    encode_generalized_time, encode_var_octet_string, encode_var_uint,
};

const TYPE_PREPARE: u8 = 12;
const TYPE_FULFILL: u8 = 13;
const TYPE_REJECT: u8 = 14;

/// Check the packet type byte against `expected`, returning the number of
/// bytes consumed (always 1) so callers can fold it into their `offset`.
fn decode_type_byte(buf: &[u8], expected: u8) -> Result<usize, PacketError> {
    let type_byte = *buf.first().ok_or(PacketError::BufferUnderflow)?;
    if type_byte != expected {
        return Err(PacketError::InvalidType);
    }
    Ok(1)
}

/// An ILP PREPARE packet (RFC-0027 Section 3.1): a conditional payment
/// addressed to `destination`, carrying an opaque application payload.
///
/// `execution_condition` is all-zero exactly when the sender attached none --
/// RFC-0027's wire format has no separate "absent" representation, so zero
/// is the only way "no condition" can be expressed on the wire. That state
/// is invalid, not a legacy auto-fulfill path: see
/// [`crate::condition_is_present`] and issue #417.
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
        out.extend(encode_var_uint(self.amount));
        out.extend(encode_generalized_time(self.expires_at));
        out.extend_from_slice(&self.execution_condition);
        out.extend(encode_var_octet_string(self.destination.as_bytes()));
        out.extend(encode_var_octet_string(&self.data));
        out
    }

    pub fn decode(buf: &[u8]) -> Result<Prepare, PacketError> {
        let mut offset = decode_type_byte(buf, TYPE_PREPARE)?;

        let (amount, n) = decode_var_uint(buf, offset)?;
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
        let mut offset = decode_type_byte(buf, TYPE_FULFILL)?;

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
    /// F00: Bad Request -- generic final error. Used (issue #596) when a
    /// terminated envelope's `target` attempts to escape the route's
    /// configured handler path -- refused before the app is ever called,
    /// distinct from F01 (the envelope itself did not decode) and from an
    /// app's own answer, including a 404, which never produces a reject at
    /// all.
    pub fn f00_bad_request() -> RejectCode {
        RejectCode("F00".to_string())
    }

    /// F01: Invalid Packet -- malformed, or (per issue #417) a missing or
    /// all-zero execution condition.
    pub fn f01_invalid_packet() -> RejectCode {
        RejectCode("F01".to_string())
    }

    /// F02: Unreachable -- no route to the destination.
    pub fn f02_unreachable() -> RejectCode {
        RejectCode("F02".to_string())
    }

    /// F03: Invalid Amount -- a claim's value does not cover what it is
    /// paying for: a locally-terminated route's configured price (issue
    /// #522, `client-edge-spec.md` §1.3 step 3) or, later, a
    /// request-request-bound route's price (§1.5). Distinct from F01: the
    /// claim is structurally and cryptographically fine, it is simply not
    /// enough value.
    pub fn f03_invalid_amount() -> RejectCode {
        RejectCode("F03".to_string())
    }

    /// F06: Unexpected Payment -- a payment arrived without the claim that
    /// pays for it. The client edge's BTP carriage answers a claimless
    /// PREPARE to a priced route with this code plus the route's x402 terms
    /// as `payment-required` protocolData (client-edge-spec.md §1.9), since
    /// BTP cannot answer HTTP 402; the HTTP carriage answers 402 itself and
    /// never raises this code.
    pub fn f06_unexpected_payment() -> RejectCode {
        RejectCode("F06".to_string())
    }

    /// F99: Application Error -- the terminating app declined the delivery,
    /// or (per issue #417) supplied no fulfilment matching the execution
    /// condition it was handed.
    pub fn f99_application_error() -> RejectCode {
        RejectCode("F99".to_string())
    }

    /// R00: Transfer Timed Out -- the packet's expiry has already passed.
    pub fn r00_transfer_timed_out() -> RejectCode {
        RejectCode("R00".to_string())
    }

    /// R01: Insufficient Source Amount -- this hop cannot meet the
    /// packet's declared minimum delivery once its own flat fee is taken
    /// (ADR 0010, peer-semantics-pre-868.md §4-5.1).
    pub fn r01_insufficient_source_amount() -> RejectCode {
        RejectCode("R01".to_string())
    }

    /// T00: Internal Error -- this connector could not do its own part of
    /// the work, through no fault of the packet. Retryable, and
    /// deliberately temporary rather than final (issue #605): a claim this
    /// connector could not durably record is refused under this code, so a
    /// sender learns to retry rather than that its perfectly good claim was
    /// invalid.
    pub fn t00_internal_error() -> RejectCode {
        RejectCode("T00".to_string())
    }

    /// T01: Peer Unreachable -- the app could not be reached over HTTP.
    /// Also used (issue #698) when a client-edge destination has no live
    /// BTP session bound to it, or the session that would have carried the
    /// delivery ended or was superseded mid-flight: in every case the
    /// packet itself is fine and the only fact worth reporting is "there is
    /// currently no way to reach this peer," so the sender should retry
    /// rather than conclude anything about the packet.
    pub fn t01_peer_unreachable() -> RejectCode {
        RejectCode("T01".to_string())
    }

    /// T04: Insufficient Liquidity (RFC-0027). Used until issue #424
    /// (peer-semantics-pre-868.md §5.1/§5.3) for this connector's own exposure
    /// ceiling; that machinery is retired (ADR 0031, ADR 0033, issue #882)
    /// and nothing in this codebase emits `T04` any more. Kept for wire
    /// interop -- a standard ILPv4 code a counterparty may still send.
    pub fn t04_insufficient_liquidity() -> RejectCode {
        RejectCode("T04".to_string())
    }

    /// T05: Rate Limited -- this connector is deliberately withholding free
    /// work from the sender rather than failing at it (issue #613,
    /// RFC-0027's own gloss: "the connector is rate limiting the sender").
    /// Retryable, and the distinction from `T00` is the whole point: `T00`
    /// says this connector tried and could not, `T05` says it declined to
    /// try, and a sender told the first would retry immediately while a
    /// sender told the second should wait out a window.
    pub fn t05_rate_limited() -> RejectCode {
        RejectCode("T05".to_string())
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
///
/// `accumulated_cost` is the running total of what this packet's path has
/// charged so far: the fees of every hop it actually passed through, plus
/// the price of the route that terminates it, if it has reached one (ADR
/// 0011, issue #523, `peer-semantics-pre-868.md` §5.2) -- `0` when this connector
/// originated the reject itself before forwarding or terminating the
/// packet, since neither a fee nor a price applies to a hop the packet
/// never used. It is a single sum -- never a per-hop breakdown, and never
/// split between fees and price, since either would leak topology or
/// pricing a probe has no need to know.
/// Deliberately **not** part of this struct's OER wire encoding below: this
/// type is ported byte-for-byte from RFC-0027 so an existing ILPv4-over-HTTP
/// client can address this connector's client edge, and RFC-0027 has no such
/// field. `accumulated_cost` instead rides beside the packet -- at the peer
/// wire's frame level, or the client edge's `TOON-Accumulated-Cost` response
/// header (`docs/protocol/client-edge-spec.md` §1.6) -- never inside it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reject {
    pub code: RejectCode,
    pub triggered_by: String,
    pub message: String,
    pub data: Vec<u8>,
    pub accumulated_cost: u64,
}

impl Reject {
    /// Encodes exactly RFC-0027's REJECT fields -- `accumulated_cost` is
    /// deliberately absent, see the struct's own doc.
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
        let mut offset = decode_type_byte(buf, TYPE_REJECT)?;

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
            accumulated_cost: 0,
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

    /// Issue #546 tightens canonicality in the shared `oer.rs` primitives
    /// rather than only in the envelope's own decode path (see that issue's
    /// resolution note and `oer.rs::decode_var_uint`'s doc comment for why),
    /// so a PREPARE's `amount` -- a VarUInt, like everything #546 describes --
    /// is covered by the same fix without any change to this file.
    #[test]
    fn prepare_decode_rejects_a_non_canonical_amount_determinant() {
        let mut encoded = sample_prepare().encode();
        // `amount: 100` canonically encodes as the single byte 0x64
        // (100 <= 127). Splice in the long-form alias 0x81 0x64 instead.
        assert_eq!(encoded[1], 0x64);
        encoded.splice(1..2, [0x81, 0x64]);
        assert!(matches!(
            Prepare::decode(&encoded),
            Err(PacketError::NonCanonicalLength)
        ));
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
            accumulated_cost: 0,
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
            accumulated_cost: 0,
        };
        let encoded = reject.encode();
        assert_eq!(Reject::decode(&encoded).expect("decode"), reject);
    }

    /// ADR 0011 / peer-semantics-pre-868.md §5.2: `accumulated_cost` rides beside the
    /// packet (frame level / response header), never inside RFC-0027's own
    /// REJECT encoding -- so a nonzero value never survives an encode/decode
    /// round trip through this struct's wire format alone.
    #[test]
    fn accumulated_cost_does_not_ride_the_oer_wire_encoding() {
        let reject = Reject {
            code: RejectCode::f02_unreachable(),
            triggered_by: String::new(),
            message: "no route".to_string(),
            data: vec![],
            accumulated_cost: 42,
        };
        let encoded = reject.encode();
        let decoded = Reject::decode(&encoded).expect("decode");
        assert_eq!(decoded.accumulated_cost, 0);
        assert_eq!(decoded.code, reject.code);
        assert_eq!(decoded.message, reject.message);
    }

    #[test]
    fn reject_code_as_str_matches_the_constant() {
        assert_eq!(RejectCode::f02_unreachable().as_str(), "F02");
        assert_eq!(RejectCode::f99_application_error().as_str(), "F99");
        assert_eq!(RejectCode::t01_peer_unreachable().as_str(), "T01");
        assert_eq!(RejectCode::t04_insufficient_liquidity().as_str(), "T04");
        assert_eq!(RejectCode::t05_rate_limited().as_str(), "T05");
        assert_eq!(RejectCode::f00_bad_request().as_str(), "F00");
        assert_eq!(RejectCode::r01_insufficient_source_amount().as_str(), "R01");
        assert_eq!(RejectCode::f01_invalid_packet().as_str(), "F01");
        assert_eq!(RejectCode::r00_transfer_timed_out().as_str(), "R00");
        assert_eq!(RejectCode::f03_invalid_amount().as_str(), "F03");
    }
}
